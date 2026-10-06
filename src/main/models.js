'use strict';
/**
 * Gestionnaire de modèles Whisper : catalogue, téléchargement (reprise possible),
 * extraction, suppression. Source principale : Hugging Face (fichiers int8 directs),
 * secours : archives GitHub officielles de sherpa-onnx.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { once } = require('events');

const MB = 1024 * 1024;

// modèles retirés (trop de mots faux pour un gain de vitesse nul face à Parakeet) : supprimés du disque au démarrage
const RETIRED = ['tiny', 'base', 'small', 'medium'];

const CATALOG = [
  {
    id: 'parakeet', name: 'Parakeet v3 (NVIDIA)', engine: 'parakeet',
    tagline: 'Le plus rapide et très précis — 25 langues européennes. Les passages douteux sont revérifiés automatiquement par Whisper',
    size: 670 * MB, quality: 5, speed: 5, ram: '~1,5 Go', ramGB: 1.5, wer: { min: 1.6, max: 10.9, avg: 5.6 }, werNoCheck: { min: 1.6, max: 21.3, avg: 8.2 },
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt', 'joiner.int8.onnx'],
    hf: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', gh: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    // langues reconnues ; pas de traduction vers l'anglais
    langs: ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'],
    noTranslate: true,
  },
  { id: 'turbo', name: 'Large v3 Turbo', tagline: 'Le meilleur choix pour toutes les langues (99) : rapide et précis', size: 1036 * MB, quality: 4, speed: 3, ram: '~2,5 Go', ramGB: 2.5, wer: { min: 4.0, max: 15.4, avg: 8.1 } },
  { id: 'large-v3', name: 'Large v3', tagline: 'Le plus précis de tous, mais très lent (~10× plus lent que Turbo)', size: 1776 * MB, quality: 5, speed: 1, ram: '~4 Go', ramGB: 4, wer: { min: 0.8, max: 7.2, avg: 3.5 } },
];

const meta = (id) => CATALOG.find((m) => m.id === id) || {};
const filesFor = (id) => meta(id).files || [`${id}-encoder.int8.onnx`, `${id}-decoder.int8.onnx`, `${id}-tokens.txt`];
const hfUrl = (id, f) => `https://huggingface.co/${meta(id).hf || 'csukuangfj/sherpa-onnx-whisper-' + id}/resolve/main/${f}?download=true`;
const ghUrl = (id) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${meta(id).gh || 'sherpa-onnx-whisper-' + id}.tar.bz2`;

class ModelManager {
  /**
   * @param {string} root dossier des modèles
   * @param {(url:string, init?:object)=>Promise<Response>} fetchFn
   */
  constructor(root, fetchFn) {
    this.root = root;
    this.fetch = fetchFn;
    this.active = new Map(); // id -> AbortController
    fs.mkdirSync(root, { recursive: true });
  }

  dir(id) { return path.join(this.root, id); }

  paths(id) {
    const [e, d, t, j] = filesFor(id).map((f) => path.join(this.dir(id), f));
    return j ? { encoder: e, decoder: d, tokens: t, joiner: j } : { encoder: e, decoder: d, tokens: t };
  }

  isInstalled(id) {
    const p = this.paths(id);
    return fs.existsSync(path.join(this.dir(id), 'manifest.json')) &&
      [p.encoder, p.decoder, p.tokens, p.joiner].filter(Boolean).every((f) => fs.existsSync(f));
  }

  async diskSize(id) {
    let total = 0;
    try {
      for (const f of await fsp.readdir(this.dir(id))) {
        const st = await fsp.stat(path.join(this.dir(id), f));
        if (st.isFile()) total += st.size;
      }
    } catch { /* absent */ }
    return total;
  }

  async list() {
    const out = [];
    for (const m of CATALOG) {
      out.push({ ...m, installed: this.isInstalled(m.id), downloading: this.active.has(m.id), onDisk: await this.diskSize(m.id) });
    }
    return out;
  }

  cancel(id) {
    const c = this.active.get(id);
    if (c) c.abort();
  }

  async remove(id) {
    // identifiant vérifié : jamais de chemin arbitraire (« .. ») dans une suppression récursive
    if (!CATALOG.some((m) => m.id === id) && !RETIRED.includes(id)) throw new Error('Modèle inconnu : ' + id);
    this.cancel(id);
    // Windows : un fichier peut rester verrouillé un instant après l'arrêt du téléchargement → nouvelles tentatives
    await fsp.rm(this.dir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  /** Télécharge une URL vers dest avec reprise (.part). */
  async downloadFile(url, dest, signal, onBytes, retry = false) {
    const part = dest + '.part';
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch { /* nouveau */ }
    const headers = have ? { Range: `bytes=${have}-` } : {};
    const res = await this.fetch(url, { headers, signal, redirect: 'follow' });
    if (res.status === 416) {
      // .part déjà complet (arrêt juste avant le renommage) : on le garde au lieu de tout retélécharger
      const total = Number((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1] || 0);
      if (total && have === total) { onBytes(have, have); await fsp.rename(part, dest); return; }
      // plage refusée et .part incohérent → on repart de zéro une seule fois (pas de fichier tronqué accepté)
      await fsp.rm(part, { force: true });
      if (retry) throw new Error('Le serveur refuse la reprise du téléchargement.');
      return this.downloadFile(url, dest, signal, onBytes, true);
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} pour ${url}`), { status: res.status });
    let append = have > 0 && res.status === 206;
    if (!append) have = 0;
    const len = Number(res.headers.get('content-length') || 0);
    onBytes(have, have + len);
    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let writeErr = null;
    out.on('error', (e) => { writeErr = e; }); // disque plein, antivirus… : ne doit pas devenir une erreur non gérée
    let got = have;
    try {
      // Copie de chaque bloc : certains moteurs réutilisent la mémoire du flux réseau
      // entre deux blocs, ce qui corromprait l'écriture asynchrone sur disque.
      for await (const chunk of res.body) {
        if (signal && signal.aborted) throw Object.assign(new Error('Annulé'), { name: 'AbortError' });
        if (writeErr) throw writeErr;
        const b = Buffer.from(chunk);
        got += b.length;
        onBytes(got, have + len);
        if (!out.write(b)) await once(out, 'drain'); // once() échoue aussi si le flux émet 'error'
      }
      await new Promise((resolve, reject) => out.end((e) => (e || writeErr ? reject(e || writeErr) : resolve())));
    } catch (e) {
      out.destroy();
      throw e;
    }
    if (len && got !== have + len) throw new Error('Téléchargement incomplet, relancez pour reprendre.');
    await fsp.rename(part, dest);
  }

  async headSize(url, signal) {
    const res = await this.fetch(url, { method: 'HEAD', signal, redirect: 'follow' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return Number(res.headers.get('content-length') || 0);
  }

  /**
   * Installe un modèle. onProgress({phase, received, total, speed, source})
   */
  async install(id, onProgress) {
    if (!CATALOG.find((m) => m.id === id)) throw new Error('Modèle inconnu : ' + id);
    if (this.active.has(id)) throw new Error('Téléchargement déjà en cours');
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    const dir = this.dir(id);
    await fsp.mkdir(dir, { recursive: true });
    const files = filesFor(id);
    let lastT = Date.now(); let lastB = 0; let speed = 0;
    let lastSent = 0;
    const report = (phase, received, total, source) => {
      const now = Date.now();
      if (now - lastSent < 200 && received < total) return;
      lastSent = now;
      if (now - lastT > 1000) { speed = (received - lastB) / ((now - lastT) / 1000); lastT = now; lastB = received; }
      onProgress({ id, phase, received, total, speed: Math.max(0, speed), source });
    };
    try {
      let ok = false;
      // 1) Hugging Face : uniquement les fichiers int8 nécessaires
      try {
        const sizes = [];
        for (const f of files) sizes.push(await this.headSize(hfUrl(id, f), ctrl.signal));
        const total = sizes.reduce((a, b) => a + b, 0);
        let base = 0;
        for (let i = 0; i < files.length; i++) {
          const dest = path.join(dir, files[i]);
          if (fs.existsSync(dest) && (await fsp.stat(dest)).size === sizes[i]) { base += sizes[i]; continue; }
          await this.downloadFile(hfUrl(id, files[i]), dest, ctrl.signal, (got) => report('download', base + got, total, 'Hugging Face'));
          base += sizes[i];
        }
        ok = true;
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        onProgress({ id, phase: 'fallback', message: 'Hugging Face indisponible, bascule vers GitHub…' });
      }
      // 2) Secours : archive GitHub + extraction
      if (!ok) {
        const tarPath = path.join(dir, 'archive.tar.bz2');
        if (!fs.existsSync(tarPath)) {
          await this.downloadFile(ghUrl(id), tarPath, ctrl.signal, (got, total) => report('download', got, total, 'GitHub'));
        }
        try {
          await this.extract(tarPath, dir, ctrl.signal, (got, total) => report('extract', got, total, 'GitHub'));
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          // disque plein / fichier verrouillé : l'archive est bonne, on la garde (pas de nouveau téléchargement)
          if (/ENOSPC|EPERM|EBUSY|EACCES/.test(e.message)) throw new Error(/ENOSPC/.test(e.message) ? 'Disque plein : libérez de la place puis relancez (le téléchargement est conservé).' : 'Fichier verrouillé (antivirus ?) : relancez dans un instant (le téléchargement est conservé).');
          await fsp.rm(tarPath, { force: true });
          throw new Error('Archive corrompue (' + e.message + '). Relancez le téléchargement.');
        }
        await fsp.rm(tarPath, { force: true });
      }
      for (const f of files) if (!fs.existsSync(path.join(dir, f))) throw new Error('Fichier absent après installation : ' + f);
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, installedAt: new Date().toISOString() }, null, 2));
      onProgress({ id, phase: 'done' });
    } catch (e) {
      if (ctrl.signal.aborted) onProgress({ id, phase: 'cancelled' });
      else onProgress({ id, phase: 'error', message: e.message });
      throw e;
    } finally {
      this.active.delete(id);
    }
  }

  /** Extraction en flux d'une archive .tar.bz2 (thread séparé) — ne garde que les fichiers utiles. */
  extract(tarPath, dir, signal, onBytes) {
    const { Worker } = require('worker_threads');
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'extract-worker.js'), { workerData: { tarPath, dir } });
      const abort = () => { w.terminate(); reject(Object.assign(new Error('Annulé'), { name: 'AbortError' })); };
      if (signal) signal.addEventListener('abort', abort, { once: true });
      w.on('message', (m) => {
        if (m.type === 'progress') onBytes(m.read, m.total);
        else if (m.type === 'done') { signal && signal.removeEventListener('abort', abort); w.terminate(); resolve(); }
        else if (m.type === 'error') { signal && signal.removeEventListener('abort', abort); w.terminate(); reject(new Error('Extraction impossible : ' + m.message)); }
      });
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error('Extraction interrompue')); });
    });
  }
}

module.exports = { ModelManager, CATALOG, RETIRED };
