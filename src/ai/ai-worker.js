'use strict';
/**
 * Processus IA isolé : garde le modèle de langage en mémoire entre deux demandes
 * et peut être arrêté sans affecter le reste de l'application.
 */
const { LocalLLM, OpenAICompatible } = require('./providers');
const { translateSegments, summarize, summarizeMany, transform, cleanSegments, answerQuestion } = require('./tasks');

const port = process.parentPort;
const send = (m) => port.postMessage(m);

let llm = null;
const jobs = new Map(); // id -> AbortController

async function getLlm(cfg, emit) {
  const next = cfg.kind === 'openai' ? new OpenAICompatible(cfg) : new LocalLLM(cfg);
  if (llm && llm.key === next.key) return llm;
  if (llm) { emit({ type: 'status', message: 'Libération du modèle précédent…' }); await llm.dispose(); llm = null; }
  await next.load((message) => emit({ type: 'status', message }));
  if (next.info) send({ type: 'log', message: `modèle chargé : ${next.info}` });
  llm = next;
  return llm;
}

// Les tâches sont exécutées l'une après l'autre : un seul modèle en mémoire, jamais libéré en pleine génération.
let queue = Promise.resolve();
let unloadRequested = false;
port.on('message', ({ data: msg }) => {
  if (msg.type === 'cancel') { const c = jobs.get(msg.id); if (c) c.abort(); return; }
  if (msg.type === 'unload') {
    unloadRequested = true;
    queue = queue.then(async () => { if (unloadRequested && llm) { await llm.dispose(); llm = null; } unloadRequested = false; });
    return;
  }
  if (msg.type !== 'run') return;
  const ctrl = new AbortController();
  jobs.set(msg.id, ctrl); // enregistré tout de suite : une tâche en attente peut être annulée
  if (jobs.size > 1) send({ type: 'status', id: msg.id, message: 'En attente de la fin de l’autre tâche IA…' });
  queue = queue.then(() => runJob(msg, ctrl)).catch(() => {});
});

/**
 * Taille des parties envoyées au modèle : tout ce qui tient dans le contexte, réponse comprise
 * (≈ 2,6 caractères par jeton, valeur prudente pour le français). Un cours de 10 min passe en une seule fois
 * au lieu de 2 parties + une fusion : environ 3 fois moins d'appels au modèle.
 */
function chunkFor(engine) {
  const ctx = engine.ctxSize || 4096;
  return Math.max(3000, Math.min(40000, Math.floor((ctx - 3200) * 2.6))); // ~3 000 jetons gardés pour la réponse
}

async function runJob(msg, ctrl) {
  const { id, task, provider, payload } = msg;
  if (ctrl.signal.aborted) { jobs.delete(id); send({ type: 'cancelled', id }); return; }
  const emit = (ev) => send({ ...ev, id });
  const t0 = Date.now();
  // progression visible pendant que le modèle écrit (sinon l'analyse d'une partie semble figée)
  let label = ''; let lastStat = 0; let words = 0; let ticker = null; let jobTokens = 0;
  const emitP = emit;
  const emitWrap = (ev) => { if (ev.message && ev.type === 'progress') label = ev.message; emitP(ev); };
  try {
    const engine = await getLlm(provider, emitWrap);
    const tick = () => {
      lastStat = Date.now();
      const sec = Math.round((Date.now() - t0) / 1000);
      const el = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      emitP({ type: 'status', message: `${(label || 'Rédaction…').replace(/…$/, '')} — ${words ? words + ' mots écrits' : 'lecture du texte…'} (${el})` });
    };
    ticker = setInterval(() => { if (Date.now() - lastStat >= 2000) tick(); }, 1000);
    // jetons cumulés sur toute la tâche (plusieurs rédactions peuvent avancer en même temps)
    engine.onTokenStats = (n) => {
      jobTokens += n; words = Math.round(jobTokens * 0.75);
      if (Date.now() - lastStat >= 1000) tick();
    };
    engine.onLog = (message) => send({ type: 'log', message });
    engine.onCallStats = (st) => {
      send({ type: 'log', message: `${task} : lecture ${(st.promptMs / 1000).toFixed(1)} s, ${st.tokens} jetons en ${(st.genMs / 1000).toFixed(1)} s (${st.genMs ? (st.tokens / (st.genMs / 1000)).toFixed(1) : '—'} jetons/s)` });
    };
    const emit2 = emitWrap;
    let result;
    if (task === 'translate') {
      emit2({ type: 'status', message: 'Traduction en cours…' });
      let last = 0; const sent = new Set();
      result = await translateSegments(engine, payload.segments, payload.target, {
        signal: ctrl.signal,
        batchChars: engine.ctxSize >= 8000 ? 1400 : 700,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last < 300 && p.done < p.total) return;
          last = now;
          // seules les lignes nouvellement traduites sont transmises (pas tout le tableau à chaque fois)
          const updates = {};
          p.partial.forEach((t, i) => { if (t != null && !sent.has(i)) { sent.add(i); updates[i] = t; } });
          emit2({ type: 'progress', ratio: p.ratio, done: p.done, total: p.total, updates });
        },
      });
    } else if (task === 'summarize') {
      result = await summarize(engine, payload.segments, payload.lang, {
        signal: ctrl.signal,
        length: payload.length,
        title: payload.title,
        chunkChars: chunkFor(engine),
        onProgress: (p) => emit2({ type: 'progress', ratio: p.ratio, message: p.label }),
      });
    } else if (task === 'cleanup') {
      let last = 0;
      result = await cleanSegments(engine, payload.segments, {
        signal: ctrl.signal, ...payload.options,
        batchChars: engine.ctxSize >= 8000 ? 3000 : 1200, batchMax: engine.ctxSize >= 8000 ? 30 : 14,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last < 300 && p.done < p.total) return;
          last = now;
          emit2({ type: 'progress', ratio: p.ratio, done: p.done, total: p.total, message: `Nettoyage… ${p.done}/${p.total} segments` });
        },
      });
    } else if (task === 'summarizeMany') {
      result = await summarizeMany(engine, payload.parts, payload.lang, {
        signal: ctrl.signal, length: payload.length,
        chunkChars: chunkFor(engine),
        onProgress: (p) => emit2({ type: 'progress', ratio: p.ratio, message: p.label }),
      });
    } else if (task === 'transform') {
      let buf = ''; let last = 0;
      result = await transform(engine, payload.parts, payload.format, payload.lang, {
        signal: ctrl.signal, custom: payload.custom,
        chunkChars: chunkFor(engine),
        onProgress: (p) => emit2({ type: 'progress', ratio: p.ratio, message: p.label }),
        onToken: (t) => {
          buf += t;
          const now = Date.now();
          if (now - last > 150) { last = now; emit2({ type: 'progress', message: 'Rédaction…', text: buf }); }
        },
      });
    } else if (task === 'qa') {
      let buf = ''; let last = 0;
      emit2({ type: 'progress', ratio: 0.1, message: 'Lecture des passages…' });
      result = await answerQuestion(engine, payload.question, payload.passages, payload.lang, {
        signal: ctrl.signal, vocabulary: payload.vocabulary || [],
        maxChars: Math.max(3000, chunkFor(engine) - 1500),
        onToken: (t) => {
          buf += t;
          const now = Date.now();
          if (now - last > 120) { last = now; emit2({ type: 'progress', message: 'Rédaction de la réponse…', text: buf }); }
        },
      });
    } else if (task === 'aidetect') {
      if (typeof engine.predictability !== 'function') throw new Error('La mesure par le modèle nécessite un modèle IA local (pas un serveur LM Studio / Ollama). Les indices de style restent disponibles.');
      let calib = payload.calib || null;
      if (!calib) {
        // étalonnage : un texte écrit par le modèle lui-même sert de référence « IA » sur ce PC
        emit2({ type: 'progress', ratio: 0.05, message: 'Étalonnage du modèle (une seule fois)…' });
        const sample = await engine.complete({
          system: 'Tu es un assistant qui rédige des textes clairs et structurés.',
          user: 'Rédige un texte explicatif d’environ 250 mots, en français, sur l’importance du sommeil pour la santé, en trois paragraphes.',
          maxTokens: 450, temperature: 0.8, signal: ctrl.signal,
        });
        const paras = String(sample || '').split(/\n{2,}/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 15);
        if (!paras.length) throw new Error('Étalonnage impossible : le modèle n’a pas produit de texte.');
        const m = await engine.predictability(paras, { signal: ctrl.signal, maxTokens: 800 });
        calib = { top1: m.top1, gap: m.gap, burst: m.burst, tokens: m.tokens, at: new Date().toISOString() };
        send({ type: 'log', message: `aidetect : étalonnage top1 ${(m.top1 * 100).toFixed(0)} % · écart ${m.gap.toFixed(2)} sur ${m.tokens} jetons` });
      }
      emit2({ type: 'progress', ratio: 0.3, message: 'Mesure de la prévisibilité du texte…' });
      const measure = await engine.predictability(payload.paragraphs || [], {
        signal: ctrl.signal, maxTokens: 3000,
        onProgress: (r) => emit2({ type: 'progress', ratio: 0.3 + 0.7 * r, message: `Mesure de la prévisibilité du texte… ${Math.round(r * 100)} %` }),
      });
      send({ type: 'log', message: `aidetect : top1 ${(measure.top1 * 100).toFixed(0)} % · écart ${measure.gap.toFixed(2)} sur ${measure.tokens} jetons${measure.sampled ? ' (échantillon)' : ''}` });
      result = { measure, calib };
    } else throw new Error('Tâche inconnue');
    if (jobTokens) { const sec = (Date.now() - t0) / 1000; send({ type: 'log', message: `${task} terminé : ${jobTokens} jetons en ${sec.toFixed(1)} s (${(jobTokens / sec).toFixed(1)} jetons/s au total, ${engine.parallel || 1} en parallèle)` }); }
    emit({ type: 'done', result, elapsed: (Date.now() - t0) / 1000, backend: engine.backend || 'serveur', model: engine.model && engine.model.filename ? require('path').basename(engine.model.filename).replace(/\.gguf$/i, '') : (typeof engine.model === 'string' ? engine.model : require('path').basename(engine.modelPath || '').replace(/\.gguf$/i, '')) });
  } catch (e) {
    if (ctrl.signal.aborted || e.name === 'AbortError') emit({ type: 'cancelled' });
    else emit({ type: 'error', message: e && e.message ? e.message : String(e) });
    // moteur bloqué dans un calcul natif : on redémarre le processus IA (il sera relancé à la demande suivante)
    if (e && e.stalled) setTimeout(() => process.exit(3), 300);
  } finally {
    clearInterval(ticker);
    if (llm) { llm.onTokenStats = null; llm.onCallStats = null; llm.onLog = null; }
    jobs.delete(id);
  }
}

send({ type: 'ready' });
