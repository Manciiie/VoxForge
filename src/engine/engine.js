'use strict';
/**
 * VoxForge — moteur de transcription.
 * Whisper (sherpa-onnx, 100 % local) + VAD Silero + décodage ffmpeg en flux.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Dict = require('../shared/dictionary');
const Vocab = require('../shared/vocabulary');
const Echoes = require('../shared/echoes');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

let sherpa = null;
function loadSherpa() {
  if (sherpa) return sherpa;
  // Accélération carte graphique : ce processus charge la version CUDA du moteur (pack installé à part).
  // Les DLL CUDA (cuBLAS, cuDNN…) sont cherchées dans ce même dossier.
  const gpuDir = process.env.VOX_GPU_DIR;
  if (gpuDir && fs.existsSync(path.join(gpuDir, 'sherpa-onnx.node'))) {
    process.env.PATH = gpuDir + path.delimiter + (process.env.PATH || '');
    const Module = require('module');
    const addonJs = require.resolve('sherpa-onnx-node/addon.js');
    const m = new Module(addonJs, module);
    m.filename = addonJs; m.loaded = true;
    m.exports = require(path.join(gpuDir, 'sherpa-onnx.node'));
    Module._cache[addonJs] = m;
  }
  sherpa = require('sherpa-onnx-node');
  return sherpa;
}

function parseClock(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

/** Nettoyage léger des sorties Whisper (hallucinations classiques sur silence/bruit). */
const HALLUCINATIONS = [
  /^\s*(\[|\()?\s*(music|musique|música|musik|applause|applaudissements|silence|bruit|noise|blank_audio)\s*(\]|\))?\s*\.?\s*$/i,
  /^\s*(sous-titr(es|age) (réalisés? )?(par|de) .*|subtitles by .*|amara\.org.*)$/i,
  /^\s*(merci d'avoir regardé|thanks for watching|thank you for watching)[.!]?\s*$/i,
  /^[\s.…,!?♪-]*$/,
];
function cleanText(t) {
  let s = (t || '').replace(/\s+/g, ' ').trim();
  // Boucles de répétition typiques de Whisper (« de la ville de la ville de la ville… »)
  // : toute séquence de 1 à 8 mots répétée 4 fois ou plus est ramenée à une seule occurrence.
  s = (s + ' ').replace(/((?:[^\s]+[\s,]+){1,8}?)\1{3,}/gu, '$1');
  // expression d'au moins 3 mots répétée 3 fois de suite (« le code prussien de 1794, » ×3) → une fois
  s = s.replace(/((?:[^\s]+[\s,]+){3,10}?)\1{2,}/gu, '$1');
  return s.replace(/\s+/g, ' ').trim();
}
function isHallucination(t) {
  return HALLUCINATIONS.some((r) => r.test(t));
}


function buildRecConfig(o) {
  const baseWhisper = {
    encoder: o.model.encoder,
    decoder: o.model.decoder,
    language: o.language || '',
    task: o.task === 'translate' ? 'translate' : 'transcribe',
    tailPaddings: 200, // 2 s de marge en fin de bloc (la valeur par défaut, 10 s, ralentit sans gain de précision)
  };
  // Parakeet (NVIDIA, transducteur) : encodeur + décodeur + « joiner », pas de choix de langue
  if (o.model.joiner) {
    return {
      transducer: true,
      baseWhisper,
      recConfig: {
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: o.model.encoder, decoder: o.model.decoder, joiner: o.model.joiner },
          tokens: o.model.tokens,
          modelType: 'nemo_transducer',
          numThreads: Math.max(1, o.threads | 0 || 4),
          provider: o.provider || 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
      },
    };
  }
  const recConfig = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: baseWhisper,
      tokens: o.model.tokens,
      numThreads: Math.max(1, o.threads | 0 || 4),
      provider: o.provider || 'cpu',
      debug: 0,
    },
  };
  return { recConfig, baseWhisper };
}

/**
 * Le chargement d'un modèle (jusqu'à 1,7 Go) prend plusieurs secondes : on garde
 * le dernier modèle en mémoire et on le réutilise pour les fichiers suivants de la file.
 * Seuls la langue et la tâche changent d'un fichier à l'autre (setConfig).
 */
let cached = null; // { key, recognizer }
let loading = null; // { key, promise } chargement en cours
async function createRecognizer(o) {
  const s = loadSherpa();
  for (const f of [o.model.encoder, o.model.decoder, o.model.tokens, o.vadModel]) {
    if (!fs.existsSync(f)) throw new Error(`Fichier manquant : ${f}`);
  }
  const { recConfig, baseWhisper, transducer } = buildRecConfig(o);
  const key = [o.model.encoder, recConfig.modelConfig.numThreads].join('|');
  const reconf = (r) => { if (!transducer) r.setConfig(recConfig); }; // seul Whisper change de langue / tâche
  if (cached && cached.key === key) {
    reconf(cached.recognizer);
    return { recognizer: cached.recognizer, recConfig, baseWhisper, transducer, reused: true };
  }
  // préchargement déjà en cours pour ce modèle : on attend le même chargement (jamais deux fois en mémoire)
  if (loading && loading.key === key) {
    const recognizer = await loading.promise;
    reconf(recognizer);
    return { recognizer, recConfig, baseWhisper, transducer, reused: true };
  }
  // un autre modèle est en cours de chargement : on attend la fin (jamais deux chargements en parallèle)
  if (loading && loading.key !== key) { try { await loading.promise; } catch { /* */ } return createRecognizer(o); }
  cached = null; // libère l'ancien modèle avant d'en charger un autre
  if (global.gc) global.gc();
  const promise = s.OfflineRecognizer.createAsync(recConfig);
  loading = { key, promise };
  try {
    const recognizer = await promise;
    cached = { key, recognizer };
    return { recognizer, recConfig, baseWhisper, transducer, reused: false };
  } finally {
    if (loading && loading.promise === promise) loading = null;
  }
}
function releaseRecognizer() { cached = null; checker = null; if (global.gc) global.gc(); }
/** Libère le modèle de vérification (jusqu'à 2,5 Go) — appelé après 1 min sans transcription. */
function releaseChecker() { langId = null; if (checker) { checker = null; if (global.gc) global.gc(); return true; } return false; }

function createVad(o, bufferSeconds = 60) {
  const s = loadSherpa();
  return new s.Vad({
    sileroVad: {
      model: o.vadModel,
      threshold: o.vadThreshold ?? 0.45,
      minSilenceDuration: o.live ? 0.6 : 0.4,
      minSpeechDuration: 0.25,
      maxSpeechDuration: o.live ? 15 : 24,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, bufferSeconds);
}

/**
 * Regroupement des morceaux de parole en blocs.
 * La VAD coupe à chaque pause de 0,4 s : Whisper recevait des bribes de 2-3 s, sans
 * contexte (mots perdus en début/fin, ponctuation approximative) et payait à chaque fois
 * la marge de fin. On assemble donc les morceaux en blocs d'environ 14 s, puis on redécoupe
 * le texte en phrases horodatées (recalées sur les pauses).
 * Mesuré sur une réunion de 5 min 27 s : modèle Base −16 % de temps et 16,8 → 12,5 % d'erreurs ;
 * modèle Small −18 % de temps et 15,7 → 9,8 % d'erreurs.
 */
const BLOCK_GAP = 0.3; // silence inséré entre deux morceaux (s)

function blockAudio(pieces) {
  const gap = Math.round(BLOCK_GAP * SAMPLE_RATE);
  const total = pieces.reduce((a, p) => a + p.samples.length, 0) + gap * (pieces.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  pieces.forEach((p, i) => { if (i) o += gap; out.set(p.samples, o); o += p.samples.length; });
  return out;
}

/** Découpe un texte en phrases (puis en propositions si une phrase est très longue). */
// abréviations courantes : « M. Dupont », « Dr. House », « etc. » ne terminent pas une phrase
const ABBR = /(?:^|[\s(])(?:\p{Lu}|M|Mme|Mlle|MM|Mr|Mrs|Ms|Dr|Pr|Prof|St|Ste|Sr|Jr|etc|cf|vs|env|av|apr|p|pp|n°|No|vol|art|chap|fig)$/u;
// fin de phrase : ponctuation suivie d'un espace puis d'une majuscule / d'un chiffre, ou fin du texte ;
// ponctuation asiatique : coupe directe (pas d'espace entre les phrases)
const SENT_END = /([.!?…]+["»”'’)\]]*)(?=\s+["«“¿¡(]?[\p{Lu}\p{N}]|\s*$)|([。！？]+[」』”）]*)/gu;
const isCjkEnd = (t) => /[　-鿿가-힯＀-￯]$/.test(t);

/** Découpe un texte en phrases (puis en propositions si une phrase est très longue). */
function splitSentences(text) {
  const raw = [];
  let start = 0; let m;
  SENT_END.lastIndex = 0;
  while ((m = SENT_END.exec(text))) {
    const end = m.index + m[0].length;
    if (m[1] && /^\.$/.test(m[1]) && ABBR.test(text.slice(start, m.index))) continue; // « M. », « etc. »
    raw.push(text.slice(start, end)); start = end;
  }
  if (start < text.length) raw.push(text.slice(start));
  const out = [];
  const pushLong = (t) => {
    if (t.length <= 160) { out.push(t); return; }
    // coupe à la virgule / point-virgule la plus proche du milieu
    const mid = t.length / 2; let best = -1, bd = Infinity;
    const re = /[,;:，；、]\s*/g; let mm;
    while ((mm = re.exec(t))) { const d = Math.abs(mm.index - mid); if (d < bd && mm.index > 30 && mm.index < t.length - 30) { bd = d; best = mm.index + mm[0].length; } }
    if (best < 0) { out.push(t); return; }
    pushLong(t.slice(0, best).trim()); pushLong(t.slice(best).trim());
  };
  for (const r of raw) { const t = r.trim(); if (t) pushLong(t); }
  // les fragments minuscules (« Oui. ») sont rattachés à la phrase précédente
  const merged = [];
  for (const t of out) {
    if (merged.length && (t.length < 4 || /^[.!?…,;:]+$/.test(t))) {
      const prev = merged[merged.length - 1];
      merged[merged.length - 1] = prev + (isCjkEnd(prev) ? '' : ' ') + t;
    } else merged.push(t);
  }
  return merged.length ? merged : [text];
}

/**
 * Répartit les phrases d'un bloc sur la durée de parole réelle des morceaux
 * (proportionnellement au nombre de caractères), en recalant les limites sur les pauses
 * détectées par la VAD quand elles sont proches.
 * @param {string} text
 * @param {{start:number, samples:Float32Array}[]} pieces  start en échantillons
 * @returns {{start:number, end:number, text:string}[]}  en secondes
 */
function timeSentences(text, pieces) {
  const sentences = splitSentences(text);
  const lens = pieces.map((p) => p.samples.length);
  const cum = []; let S = 0;
  for (const l of lens) { cum.push(S); S += l; }
  if (sentences.length <= 1 || S === 0) {
    const last = pieces[pieces.length - 1];
    return [{ start: pieces[0].start / SAMPLE_RATE, end: (last.start + last.samples.length) / SAMPLE_RATE, text }];
  }
  const weights = sentences.map((t) => Math.max(1, t.replace(/\s+/g, '').length));
  const W = weights.reduce((a, b) => a + b, 0);
  const pauses = cum.slice(1); // limites entre morceaux, en temps de parole
  const snap = 1.2 * SAMPLE_RATE;
  const bounds = [0];
  let acc = 0;
  for (let k = 0; k < sentences.length - 1; k++) {
    acc += weights[k];
    let b = (S * acc) / W;
    let best = null, bd = snap;
    const prevB = bounds[bounds.length - 1];
    // recalage sur une pause seulement s'il ne change pas la durée de la phrase de plus de moitié / du double
    for (const p of pauses) { const d = Math.abs(p - b); const len = p - prevB, want = b - prevB; if (d < bd && p > prevB && len >= 0.5 * want && len <= 2 * want) { bd = d; best = p; } }
    const raw = b;
    if (best != null) b = best;
    // chaque phrase garde au moins ~0,15 s de parole (pas de sous-titre de durée nulle)
    const minGap = Math.min(0.15 * SAMPLE_RATE, (S - prevB) / (sentences.length - k));
    if (b < prevB + minGap) b = Math.max(raw, prevB + minGap);
    bounds.push(Math.min(b, S));
  }
  bounds.push(S);
  const toReal = (pos, atEnd) => {
    for (let j = 0; j < pieces.length; j++) {
      const lim = cum[j] + lens[j];
      if (atEnd ? pos <= lim : pos < lim) return (pieces[j].start + Math.max(0, pos - cum[j])) / SAMPLE_RATE;
    }
    const last = pieces[pieces.length - 1];
    return (last.start + last.samples.length) / SAMPLE_RATE;
  };
  const lastP = pieces[pieces.length - 1];
  const blockEnd = (lastP.start + lastP.samples.length) / SAMPLE_RATE;
  const starts = sentences.map((_, k) => toReal(bounds[k], false));
  const out = [];
  for (let k = 0; k < sentences.length; k++) {
    const start = starts[k];
    const limit = k < sentences.length - 1 ? starts[k + 1] : blockEnd; // jamais de chevauchement ni de dépassement du bloc
    const end = Math.min(limit, Math.max(start + 0.2, toReal(bounds[k + 1], true)));
    out.push({ start, end: Math.max(end, Math.min(limit, start + 0.05)), text: sentences[k] });
  }
  return out;
}

async function decodeSamples(recognizer, samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  return recognizer.decodeAsync(stream);
}

/**
 * Transcription en direct (micro) : on reçoit des blocs Float32 à 16 kHz,
 * la VAD découpe les phrases et chaque phrase est transcrite dès qu'elle se termine.
 */
class LiveSession {
  constructor(o, emit) { this.o = { ...o, live: true }; this.emit = emit; this.pos = 0; this.leftover = new Float32Array(0); this.queue = Promise.resolve(); this.segments = []; this.closed = false; }
  async init() {
    const r = await createRecognizer(this.o);
    this.recognizer = r.recognizer;
    this.vad = createVad(this.o, 30);
    this.emit({ type: 'live-ready' });
    if (this.pending) { const p = this.pending; this.pending = null; for (const x of p) this.push(x); }
  }
  push(samples) {
    if (this.closed) return;
    if (!this.vad) { (this.pending = this.pending || []).push(samples); return; }
    if (this.pending) { const p = this.pending; this.pending = null; for (const x of p) this.push(x); }
    let data = samples;
    if (this.leftover.length) { data = new Float32Array(this.leftover.length + samples.length); data.set(this.leftover); data.set(samples, this.leftover.length); }
    let i = 0;
    for (; i + VAD_WINDOW <= data.length; i += VAD_WINDOW) {
      this.vad.acceptWaveform(data.subarray(i, i + VAD_WINDOW));
      this.pos += VAD_WINDOW;
    }
    this.leftover = data.slice(i);
    this.emit({ type: 'live-level', speaking: this.vad.isDetected(), position: this.pos / SAMPLE_RATE });
    this.drain();
  }
  drain() {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      this.queue = this.queue.then(() => this.decode(seg)).catch((e) => this.emit({ type: 'status', message: e.message }));
    }
  }
  async decode(seg) {
    const r = await decodeSamples(this.recognizer, seg.samples);
    let text = cleanText(r.text);
    if (this.o.dictionary && this.o.dictionary.length) text = Dict.apply(text, this.o.dictionary).text;
    if (this.o.vocabulary && this.o.vocabulary.length) text = Vocab.apply(text, this.o.vocabulary).text;
    if (!text || (this.o.filterHallucinations !== false && isHallucination(text))) return;
    const start = seg.start / SAMPLE_RATE;
    const item = { id: this.segments.length, start, end: start + seg.samples.length / SAMPLE_RATE, text, lang: (r.lang || '').replace(/[<>|]/g, '') || this.o.language || guessLang(text) };
    this.segments.push(item);
    this.emit({ type: 'segment', segment: item });
  }
  async stop() {
    this.closed = true;
    if (this.vad) { this.vad.flush(); this.drain(); }
    await this.queue;
    const votes = {};
    for (const sg of this.segments) if (sg.lang) votes[sg.lang] = (votes[sg.lang] || 0) + (sg.end - sg.start);
    const language = (Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || [''])[0];
    return { segments: this.segments, language, languages: votes, duration: this.pos / SAMPLE_RATE };
  }
}

/**
 * @param {object} o
 * @param {string} o.file          fichier audio/vidéo
 * @param {string} o.ffmpeg        chemin vers ffmpeg
 * @param {string} o.vadModel      chemin silero_vad.onnx
 * @param {{encoder:string,decoder:string,tokens:string}} o.model
 * @param {string} o.language      '' = détection auto
 * @param {'transcribe'|'translate'} o.task
 * @param {boolean} o.lockLanguage verrouille la langue après détection (audio monolingue)
 * @param {number} o.threads
 * @param {number} o.vadThreshold  0.2 … 0.8
 * @param {boolean} o.filterHallucinations
 * @param {(ev:object)=>void} emit
 * @param {()=>boolean} cancelled
 */
async function transcribe(o, emit, cancelled) {
  const t0 = Date.now();
  if (!fs.existsSync(o.file)) throw new Error(`Fichier introuvable : ${o.file}`);

  emit({ type: 'status', message: 'Chargement du modèle…' });
  const { recognizer, recConfig, baseWhisper, transducer } = await createRecognizer(o);
  const tCompute = Date.now(); // la vitesse mesurée (conseiller) exclut le chargement des modèles
  checkerLoadMs = 0;
  if (cancelled()) return { cancelled: true, segments: [] };
  const vad = createVad(o);

  emit({ type: 'status', message: 'Décodage de l’audio…' });

  let duration = 0;
  if (!fs.existsSync(o.ffmpeg) && /[\\/]/.test(o.ffmpeg)) throw new Error('Composant ffmpeg introuvable : réinstallez VoxForge.');
  const ff = spawn(o.ffmpeg, [
    '-hide_banner', '-nostdin', '-i', o.file,
    '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
  ], { windowsHide: true });

  let stderrTail = '';
  ff.stderr.on('data', (d) => {
    const txt = d.toString();
    stderrTail = (stderrTail + txt).slice(-4000);
    if (!duration) {
      const m = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(stderrTail); // la ligne peut être coupée entre deux blocs
      if (m) {
        duration = parseClock(m[1]) || 0;
        emit({ type: 'duration', duration });
      }
    }
  });
  const ffDone = new Promise((resolve) => ff.on('close', (code) => resolve(code)));
  let spawnError = null;
  ff.on('error', (e) => { spawnError = e; });

  const segments = [];
  const langVotes = {};
  let lockedLang = o.language || '';
  let processedSamples = 0;
  let leftover = new Float32Array(0);
  let byteRemainder = Buffer.alloc(0);

  // Audio multilingue : pas de regroupement. Whisper ne reconnaît qu'une langue par bloc
  // et ignorerait les passages dans une autre langue.
  const multi = !o.language && o.lockLanguage === false;
  const BLOCK_MAX = multi ? 0 : (o.blockSeconds || 14) * SAMPLE_RATE; // 14 s : meilleur compromis mesuré (précision + vitesse)
  const GAP_SAMPLES = Math.round(BLOCK_GAP * SAMPLE_RATE);
  let block = []; let blockLen = 0;
  let blocksVoted = 0; // verrouillage de la langue après ~30 s de parole ou 3 blocs
  let rechecked = 0;   // passages de Parakeet revérifiés par Whisper
  let recheckedSec = 0; // durée de parole revérifiée
  let vocabFixes = 0;  // corrections du vocabulaire du cours
  let pkBlocks = 0, pkDrift = 0; // passages de Parakeet / passages qui ont glissé vers l'anglais
  let pkLang = '';      // langue confirmée par Whisper (Parakeet en détection automatique)
  let useWhisper = '';  // langue non gérée par Parakeet : tout le fichier passe au modèle Whisper

  const decodeBlock = async (pieces) => {
    const speech = pieces.reduce((a, p) => a + p.samples.length, 0) / SAMPLE_RATE;
    const audio = pieces.length === 1 ? pieces[0].samples : blockAudio(pieces);
    let r;
    let text;
    // Parakeet en détection automatique : Whisper identifie la langue sur le 1er passage (à partir du son,
    // bien plus fiable qu'une estimation sur le texte). Langue non gérée par Parakeet → tout le fichier passe à Whisper.
    if (transducer && o.recheck && !o.language && !pkLang && !useWhisper) {
      try {
        // 1) identification légère (Whisper Medium, 80 bandes)
        let l2 = '';
        try { if (o.langId) l2 = identifyLanguage(o, audio.length > 30 * SAMPLE_RATE ? audio.subarray(0, 30 * SAMPLE_RATE) : audio); } catch { l2 = ''; }
        // 2) sinon (Turbo / Large v3, ou échec) : Whisper en détection automatique sur les 10 premières secondes
        if (!l2) {
          const chk = await getChecker(o, '');
          const r2 = await decodeSamples(chk, audio.subarray(0, Math.min(audio.length, 10 * SAMPLE_RATE)));
          l2 = (r2.lang || '').replace(/[<>|]/g, '');
        }
        if (l2 && o.parakeetLangs && !o.parakeetLangs.includes(l2)) {
          useWhisper = l2;
          emit({ type: 'status', message: `Langue détectée : ${l2} — non gérée par Parakeet, transcription avec Whisper.` });
          emit({ type: 'engine-switch', language: l2, model: o.recheckId });
        } else if (l2) pkLang = l2;
      } catch (e) { emit({ type: 'status', message: 'Identification de la langue impossible : ' + e.message }); }
    }
    if (cancelled()) return;
    if (!r && useWhisper) { r = await decodeSamples(await getChecker(o, useWhisper), audio); text = cleanText(r.text); }
    if (!r) { r = await decodeSamples(recognizer, audio); text = cleanText(r.text); }
    // identification impossible : on devine la langue sur le texte (sinon aucune vérification n'aurait lieu)
    if (transducer && !useWhisper && o.recheck && !o.language && !pkLang && text) { const g = guessLang(text); if (g && g !== 'en') pkLang = g; }
    // Parakeet : passage douteux (glissement de langue, ou mot peu sûr selon le réglage de précision)
    // → nouvelle transcription par Whisper, forcé dans la langue de l'enregistrement, puis fusion mot à mot
    if (transducer && !useWhisper && o.recheck && text && !cancelled()) {
      const docLang = o.language || pkLang;
      const words = o.confThreshold ? wordsWithConfidence(r) : null;
      const drift = docLang && isSuspicious(text, docLang, o.recheckMode || 'names');
      pkBlocks++; if (drift) pkDrift++;
      // Parakeet glisse vers l'anglais sur une grande partie de l'enregistrement : la suite passe directement
      // à Whisper (inutile de tout transcrire deux fois)
      if (!useWhisper && pkBlocks >= 4 && pkDrift / pkBlocks >= 0.4) {
        useWhisper = docLang;
        emit({ type: 'status', message: 'Parakeet est peu fiable sur cet enregistrement : la suite est transcrite par Whisper.' });
        emit({ type: 'engine-switch', language: docLang, model: o.recheckId, reason: 'drift' });
      }
      const doubtful = words ? lowConfidence(words, o.confThreshold).length > 0 : false;
      if (drift || doubtful) {
        try {
          const chk = await getChecker(o, docLang || '');
          if (cancelled()) return;
          if (drift || o.mergeMode === 'block') {
            // glissement de langue : la version de Parakeet est inutilisable → tout le passage par Whisper
            const r2 = await decodeSamples(chk, audio);
            const t2 = cleanText(r2.text);
            if (t2) text = drift || !words ? t2 : cleanText(mergeWords(words, t2, o.confThreshold));
            recheckedSec += speech;
          } else {
            // mots douteux : seules quelques secondes autour de chacun sont retranscrites
            const res = await recheckWindows(words, audio, chk, o.confThreshold, cancelled);
            text = cleanText(res.words.map((w) => w.text).join(' '));
            recheckedSec += res.seconds;
          }
          rechecked++;
        } catch (e) { emit({ type: 'status', message: 'Vérification impossible : ' + e.message }); }
      }
    }
    if (o.dictionary && o.dictionary.length) text = Dict.apply(text, o.dictionary).text;
    // vocabulaire du cours : noms propres et termes écrits « à l'oreille » (Saleï → Saleilles)
    if (o.vocabulary && o.vocabulary.length) { const v = Vocab.apply(text, o.vocabulary); text = v.text; vocabFixes += v.count; }
    const lang = useWhisper || (r.lang || '').replace(/[<>|]/g, '') || lockedLang || (transducer ? (o.language || pkLang || guessLang(text)) : '');
    if (!text) return;
    if (o.filterHallucinations !== false && isHallucination(text)) return;

    if (!o.language && lang && transducer) langVotes[lang] = (langVotes[lang] || 0) + Math.min(speech, 20);
    else if (!o.language && lang) {
      langVotes[lang] = (langVotes[lang] || 0) + Math.min(speech, 20);
      if (o.lockLanguage && !lockedLang) {
        const total = Object.values(langVotes).reduce((a, b) => a + b, 0);
        if (total >= 30 || ++blocksVoted >= 3) {
          lockedLang = Object.entries(langVotes).sort((a, b) => b[1] - a[1])[0][0];
          try {
            recognizer.setConfig({
              ...recConfig,
              modelConfig: { ...recConfig.modelConfig, whisper: { ...baseWhisper, language: lockedLang } },
            });
            emit({ type: 'language', language: lockedLang, locked: true });
          } catch (e) {
            emit({ type: 'status', message: 'Verrouillage de langue impossible : ' + e.message });
          }
        }
      }
    }
    for (const sg of timeSentences(text, pieces)) {
      if (o.filterHallucinations !== false && isHallucination(sg.text)) continue;
      const item = { id: segments.length, start: sg.start, end: sg.end, text: sg.text, lang: lang || '' };
      segments.push(item);
      emit({ type: 'segment', segment: item });
    }
  };
  const flushBlock = async () => {
    if (!block.length) return;
    const pieces = block; block = []; blockLen = 0;
    if (cancelled()) return;
    await decodeBlock(pieces);
  };

  const drainVad = async () => {
    while (!vad.isEmpty()) {
      if (cancelled()) return;
      const seg = vad.front(false);
      vad.pop();
      const piece = { start: seg.start, samples: seg.samples };
      if (block.length && blockLen + GAP_SAMPLES + piece.samples.length > BLOCK_MAX) await flushBlock();
      blockLen += (block.length ? GAP_SAMPLES : 0) + piece.samples.length;
      block.push(piece);
    }
  };

  let lastProgress = 0;
  const reportProgress = () => {
    const now = Date.now();
    if (now - lastProgress < 250) return;
    lastProgress = now;
    const pos = processedSamples / SAMPLE_RATE;
    emit({
      type: 'progress',
      position: pos,
      duration,
      ratio: duration ? Math.min(1, pos / duration) : 0,
      elapsed: (now - t0) / 1000,
    });
  };

  // Boucle de lecture avec contre-pression : on lit un bloc, on le traite, puis on lit le suivant.
  const reader = ff.stdout;
  reader.pause();
  const readChunk = () => new Promise((resolve) => {
    const onData = (buf) => { cleanup(); reader.pause(); resolve(buf); };
    const onEnd = () => { cleanup(); resolve(null); };
    const cleanup = () => { reader.off('data', onData); reader.off('end', onEnd); reader.off('close', onEnd); };
    if (reader.readableEnded) return resolve(null);
    reader.on('data', onData);
    reader.on('end', onEnd);
    reader.on('close', onEnd);
    reader.resume();
  });

  let finished = false;
  try {
    for (;;) {
      if (cancelled()) break;
      const buf = await readChunk();
      if (!buf) break;
      const all = byteRemainder.length ? Buffer.concat([byteRemainder, buf]) : buf;
      const usable = all.length - (all.length % 4);
      byteRemainder = all.subarray(usable);
      // copie alignée
      const ab = new ArrayBuffer(usable);
      new Uint8Array(ab).set(all.subarray(0, usable));
      const f = new Float32Array(ab);
      let data;
      if (leftover.length) {
        data = new Float32Array(leftover.length + f.length);
        data.set(leftover, 0); data.set(f, leftover.length);
      } else data = f;
      let i = 0;
      for (; i + VAD_WINDOW <= data.length; i += VAD_WINDOW) {
        vad.acceptWaveform(data.subarray(i, i + VAD_WINDOW));
        processedSamples += VAD_WINDOW;
        if (!vad.isEmpty()) await drainVad();
        if (cancelled()) break;
      }
      leftover = data.slice(i);
      reportProgress();
    }
    if (!cancelled()) {
      if (leftover.length) {
        const pad = new Float32Array(VAD_WINDOW);
        pad.set(leftover);
        vad.acceptWaveform(pad);
        processedSamples += leftover.length;
      }
      vad.flush();
      await drainVad();
      await flushBlock();
    }
    finished = !cancelled();
  } finally {
    if (!finished) {
      // Annulation ou erreur : on vide/ferme le flux puis on arrête ffmpeg,
      // sinon le processus reste bloqué en écriture et 'close' n'arrive jamais.
      try { reader.destroy(); } catch { /* */ }
      try { ff.kill(); } catch { /* */ }
    }
  }

  const code = await ffDone;
  if (cancelled()) return { cancelled: true, segments };
  if (spawnError) throw new Error('Impossible de démarrer ffmpeg : ' + spawnError.message);
  if (code !== 0 && processedSamples === 0) {
    if (/does not contain any stream|matches no streams/i.test(stderrTail)) throw new Error('Ce fichier ne contient aucune piste audio.');
    if (/Invalid data found|Error opening input|could not find codec|moov atom not found/i.test(stderrTail)) throw new Error('Format non reconnu ou fichier endommagé.');
    const last = stderrTail.trim().split(/\r?\n/).slice(-2).join(' ');
    throw new Error('Impossible de lire ce fichier : ' + last);
  }
  if (!duration) duration = processedSamples / SAMPLE_RATE;

  const detected = lockedLang ||
    (Object.entries(langVotes).sort((a, b) => b[1] - a[1])[0] || [''])[0];
  const elapsed = (Date.now() - t0) / 1000;
  emit({ type: 'progress', position: duration, duration, ratio: 1, elapsed });
  const computeElapsed = Math.max(0.001, (Date.now() - tCompute - checkerLoadMs) / 1000);
  // passages recopiés par erreur quelques mots plus loin (Whisper en fin de bloc)
  let echoes = [];
  if (o.removeEchoes !== false) {
    const r = Echoes.removeEchoes(segments);
    if (r.removed.length) { echoes = r.removed.map((x) => x.text); segments.length = 0; segments.push(...r.segments); }
  }
  return { segments, language: detected, languages: langVotes, duration, elapsed, computeElapsed, rechecked, recheckedSec, vocabFixes, echoes, engine: useWhisper ? 'whisper' : undefined };
}

/**
 * Langue d'un texte (Parakeet ne la donne pas) : mots les plus courants de chaque langue européenne.
 */
const STOPWORDS = {
  fr: 'le la les des est et un une que qui dans pour pas vous nous je il ce sur avec au du c qu l d m n s j a',
  en: 'the and is are to of in that it you we for with this was on be have not his her has had an by at from as or were also their which would',
  es: 'el la los las es y que de en un una por para con no se lo muy pero',
  de: 'der die das und ist nicht ich ein eine zu den mit sie es auf für wir',
  it: 'il la che di è e un una per non sono con del della mi ma anche',
  pt: 'o a os as que de e um uma para com não em do da se mais',
  nl: 'de het een en is van dat niet ik je we op te zijn met voor',
  pl: 'i w na nie się to jest że z do jak co ale tak',
  sv: 'och att det är en som på för med inte jag har av',
  ro: 'și în este de la cu nu pe că un o să mai',
  cs: 'je to se na že ale jak co by jsem jsou není tak už ten byl bylo',
  sk: 'je to sa na že ale ako čo by som sú nie tak už ten bol bolo',
  hr: 'je i u da se na za su ali kao što ne ovo nije bio sam smo',
  sl: 'je in da se na za so ali kot ne to sem smo bil bilo tudi',
  da: 'og det er en at til af på den jeg ikke med som vi har for',
  fi: 'ja on ei se että hän mutta kun niin myös olen ovat oli tämä',
  hu: 'a az és hogy nem is egy de van meg csak már mint ez volt',
};
const STOPSETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
function guessLang(text) {
  if (/[а-яё]/i.test(text)) return /[їєґі]/i.test(text) ? 'uk' : /[ыэё]/i.test(text) ? 'ru' : /[ъщ]/i.test(text) ? 'bg' : 'ru';
  if (/[α-ω]/i.test(text)) return 'el';
  // élisions séparées : « c'est » → « c », « est »
  const words = text.toLowerCase().replace(/['’]/g, ' ').match(/[\p{L}]+/gu) || [];
  let best = '', score = 0;
  for (const [k, set] of Object.entries(STOPSETS)) {
    let n = 0; for (const w of words) if (set.has(w)) n++;
    if (n > score) { score = n; best = k; }
  }
  return score >= 2 ? best : '';
}

// Mots anglais très courants qui n'existent pas (ou presque) dans les autres langues européennes
const EN_DRIFT = new Set('the and is are to of that it you we for with this was have not his her has had by from were also their which would will been they there what when who about into than them these'.split(' '));
/**
 * Passage « douteux » pour Parakeet : glissement vers l'anglais au milieu d'un texte dans une autre
 * langue (fréquent quand une phrase française contient des noms anglais), ou, en mode prudent,
 * noms propres au milieu d'une phrase accompagnés de mots anglais.
 */
// mots de EN_DRIFT qui sont aussi des mots courants dans ces langues (« was » en allemand, « is » en néerlandais…)
const NATIVE = {
  de: 'was will also her the', nl: 'is was we had of her have', da: 'for her have', sv: 'for her', no: 'for her',
  cs: 'to by', sk: 'to by', sl: 'to', hr: 'to', pl: 'to', ro: 'are', lb: 'was', mt: 'the',
};
const NATIVE_SETS = Object.fromEntries(Object.entries(NATIVE).map(([k, v]) => [k, new Set(v.split(' '))]));
// terminaisons -ing / -ed : significatives seulement pour les langues romanes
const ROMANCE = new Set(['fr', 'es', 'it', 'pt', 'ro', 'ca']);
// mots anglais sans équivalent écrit en français (un seul suffit : sur une vraie voix, Parakeet glisse
// souvent UN mot anglais par phrase : « in Europe », « It permet », « has two origines »)
const EN_STRONG = new Set('the and has have had that of at it its with was were his her which would their from this these those is are been will they what when who whose there where should could because however between about two three'.split(' '));
// mots anglais courants proches du français (Parakeet les écrit à l'anglaise)
const EN_LEXICON = new Set('professor system systems problem problems function functions movement movements result results necessity comparability government development research university country countries people different example'.split(' '));
function isSuspicious(text, lang, mode) {
  if (!lang || lang === 'en') return false;
  const native = NATIVE_SETS[lang];
  const romance = ROMANCE.has(lang);
  for (const sent of splitSentences(text)) {
    const raw = sent.replace(/['’]/g, ' ').match(/[\p{L}]+/gu) || [];
    let en = 0;
    raw.forEach((orig, k) => {
      const w = orig.toLowerCase();
      if (native && native.has(w)) return;
      if (EN_STRONG.has(w) || EN_LEXICON.has(w)) en++;
      // « in » : seulement devant un nom propre ou en début de phrase (« in Europe », « In Allemagne »)
      else if (w === 'in' && (k === 0 || /^\p{Lu}/u.test(raw[k + 1] || ''))) en++;
      // terminaison -ity : anglaise (le français écrit -ité)
      else if (romance && w.length > 5 && /ity$/.test(w)) en++;
    });
    if (en >= 1) return true;
  }
  return false;
}

/**
 * Mots de Parakeet avec leur confiance (probabilité la plus basse de leurs morceaux).
 * Un morceau commençant par une espace ouvre un nouveau mot ; la ponctuation reste collée au mot.
 */
function wordsWithConfidence(r) {
  const toks = r && r.tokens, lp = r && r.ys_log_probs;
  if (!Array.isArray(toks) || !lp || lp.length !== toks.length) return null;
  const ts = r.timestamps || [], du = r.durations || [];
  const words = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; const p = Math.exp(lp[i]);
    const st = +ts[i] || 0, en = st + (+du[i] || 0.08);
    if (!words.length || /^\s/.test(t)) words.push({ text: t.trim(), conf: p, start: st, end: en });
    else { const w = words[words.length - 1]; w.text += t; w.conf = Math.min(w.conf, p); w.end = Math.max(w.end, en); }
  }
  return words.filter((w) => w.text);
}
/** Mots « douteux » : contiennent des lettres et une confiance sous le seuil. */
const lowConfidence = (words, threshold) => (words || []).filter((w) => w.conf < threshold && /\p{L}/u.test(w.text));

const normWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
/**
 * Fusion mot à mot de deux transcriptions du même passage : là où elles diffèrent, on garde le mot
 * de Parakeet s'il était sûr de lui, sinon celui de Whisper.
 */
function mergeWords(pkWords, whText, keep = 0.9) {
  const A = pkWords.filter((w) => normWord(w.text));
  const B = whText.split(/\s+/).filter((w) => normWord(w));
  const n = A.length, m = B.length;
  if (!n) return whText; if (!m) return A.map((w) => w.text).join(' ');
  if (n * m > 400000) return whText;
  const a = A.map((w) => normWord(w.text)), b = B.map(normWord);
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  // alignement : liste d'opérations (dans l'ordre du texte)
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { ops.push({ k: a[i - 1] === b[j - 1] ? 'eq' : 'sub', p: A[i - 1], w: B[j - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || d[i][j] === d[i][j - 1] + 1)) { ops.push({ k: 'ins', w: B[j - 1] }); j--; }
    else { ops.push({ k: 'del', p: A[i - 1] }); i--; }
  }
  ops.reverse();
  // seuls les mots dont Parakeet doutait sont remplacés ; les mots en plus de Whisper ne sont pris
  // que s'ils touchent un mot douteux (zone d'incertitude)
  const doubt = (op) => op && op.p && op.p.conf < keep;
  const out = [];
  ops.forEach((op, x) => {
    if (op.k === 'eq') out.push(op.p.text);
    else if (op.k === 'sub') out.push(op.p.conf < keep ? op.w : op.p.text);
    else if (op.k === 'del') { if (op.p.conf >= keep) out.push(op.p.text); }
    else if (doubt(ops[x - 1]) || doubt(ops[x + 1])) out.push(op.w);
  });
  return out.join(' ');
}

/**
 * Revérification ciblée : seuls quelques secondes autour de chaque mot douteux sont retranscrites
 * par Whisper (avec 2 mots de contexte de chaque côté), puis fusionnées mot à mot.
 * @returns {{ words: object[], seconds: number }}
 */
async function recheckWindows(words, audio, chk, thr, cancelled) {
  const SR = SAMPLE_RATE; const dur = audio.length / SR;
  const bad = [];
  words.forEach((w, i) => { if (w.conf < thr && /\p{L}/u.test(w.text)) bad.push(i); });
  if (!bad.length) return { words, seconds: 0 };
  // fenêtres [a, b] (indices de mots), contexte de 2 mots, regroupées si elles se touchent
  const wins = [];
  for (const i of bad) {
    let a = Math.max(0, i - 2), b = Math.min(words.length - 1, i + 2);
    // au moins ~1,5 s de son : Whisper se trompe davantage sur des bribes trop courtes
    while (words[b].end - words[a].start < 1.5 && (a > 0 || b < words.length - 1)) { if (a > 0) a--; if (b < words.length - 1) b++; }
    const last = wins[wins.length - 1];
    if (last && a <= last.b + 1) last.b = Math.max(last.b, b); else wins.push({ a, b });
  }
  let seconds = 0;
  const out = []; let pos = 0;
  for (const win of wins) {
    if (cancelled && cancelled()) break;
    while (pos < win.a) out.push(words[pos++]);
    const t0 = Math.max(0, words[win.a].start - 0.25), t1 = Math.min(dur, words[win.b].end + 0.35);
    const span = words.slice(win.a, win.b + 1);
    let merged = null;
    try {
      const r2 = await decodeSamples(chk, audio.slice(Math.floor(t0 * SR), Math.ceil(t1 * SR)));
      const t2 = cleanText(r2.text);
      if (t2 && !isHallucination(t2)) merged = mergeWords(span, t2, thr);
    } catch { /* fenêtre ignorée : on garde Parakeet */ }
    seconds += t1 - t0;
    if (merged != null) for (const tx of merged.split(/\s+/).filter(Boolean)) out.push({ text: tx, conf: 1 });
    else out.push(...span);
    pos = win.b + 1;
  }
  while (pos < words.length) out.push(words[pos++]);
  return { words: out, seconds };
}

// Identification de la langue (Whisper, encodeur + 1 étape) : bien plus légère qu'une transcription
let langId = null; // { key, slid }
function identifyLanguage(o, samples) {
  const m = o.langId || o.recheck;
  if (!m) return '';
  const key = m.encoder;
  if (!langId || langId.key !== key) {
    langId = { key, slid: new (loadSherpa().SpokenLanguageIdentification)({ whisper: { encoder: m.encoder, decoder: m.decoder }, numThreads: Math.max(1, o.threads | 0 || 2), debug: 0, provider: 'cpu' }) };
  }
  const st = langId.slid.createStream();
  st.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  return String(langId.slid.compute(st) || '').replace(/[<>|]/g, '');
}

// Second moteur (Whisper) pour revérifier les passages douteux de Parakeet : chargé seulement si besoin
let checker = null; // { key, recognizer }
let checkerLoadMs = 0;
async function getChecker(o, lang) {
  const { recConfig } = buildRecConfig({ ...o, model: o.recheck, language: lang, task: 'transcribe', provider: o.checkerProvider || 'cpu' });
  const key = o.recheck.encoder + '|' + recConfig.modelConfig.numThreads + '|' + recConfig.modelConfig.provider;
  if (checker && checker.key === key) { checker.recognizer.setConfig(recConfig); return checker.recognizer; }
  checker = null;
  const t = Date.now();
  const recognizer = await loadSherpa().OfflineRecognizer.createAsync(recConfig);
  checkerLoadMs += Date.now() - t;
  checker = { key, recognizer };
  return recognizer;
}

/** Charge le modèle à l'avance (au démarrage de l'application) pour que la 1re transcription démarre aussitôt. */
async function preload(o) {
  const t = Date.now();
  const r = await createRecognizer(o);
  return { reused: r.reused, ms: Date.now() - t };
}

/**
 * Mesure de vitesse (comparaison processeur / carte graphique) : décode `seconds` s de bruit,
 * une première fois pour « chauffer » (initialisation CUDA), puis une fois chronométrée.
 * @returns {{ msPerSec: number, loadMs: number }}
 */
function benchmark(o, seconds = 20) {
  const s = loadSherpa();
  const t0 = Date.now();
  const { recConfig } = buildRecConfig(o);
  const rec = new s.OfflineRecognizer(recConfig);
  const loadMs = Date.now() - t0;
  const n = seconds * SAMPLE_RATE;
  const audio = new Float32Array(n);
  let x = 0;
  for (let i = 0; i < n; i++) { x = 0.98 * x + (Math.random() - 0.5) * 0.02; audio[i] = x + Math.sin(i / 37) * 0.01; }
  const run = () => {
    // blocs de 14 s, comme une vraie transcription
    for (let off = 0; off < n; off += 14 * SAMPLE_RATE) {
      const st = rec.createStream();
      st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: audio.subarray(off, Math.min(n, off + 14 * SAMPLE_RATE)) });
      rec.decode(st);
    }
  };
  run();
  // deux mesures, la meilleure est gardée (une tâche de fond passagère ne fausse pas le résultat)
  let best = Infinity;
  for (let k = 0; k < 2; k++) { const t1 = Date.now(); run(); best = Math.min(best, Date.now() - t1); }
  return { msPerSec: best / seconds, loadMs };
}

module.exports = { benchmark, wordsWithConfidence, mergeWords, releaseChecker, isSuspicious, guessLang, transcribe, preload, LiveSession, releaseRecognizer, cleanText, isHallucination, splitSentences, timeSentences, SAMPLE_RATE };
