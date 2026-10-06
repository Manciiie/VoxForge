'use strict';
/**
 * Transcription sur carte graphique (NVIDIA, CUDA 12) — uniquement si le PC le permet.
 *
 * 1) Détection : nvidia-smi (installé avec le pilote NVIDIA) → nom, mémoire vidéo, version du pilote.
 *    Pas de carte NVIDIA, moins de 4 Go de mémoire vidéo ou pilote trop ancien → fonction indisponible.
 * 2) Pack « accélération » téléchargé à la demande (~1,9 Go) : ONNX Runtime GPU (Microsoft) + bibliothèques
 *    CUDA / cuDNN (NVIDIA, via PyPI). Fichiers vérifiés (empreinte SHA-256) puis seules les DLL sont gardées.
 * 3) Test de vitesse par modèle : la carte graphique n'est utilisée que si elle va VRAIMENT plus vite
 *    que le processeur (sinon : repli automatique et définitif sur le processeur pour ce modèle).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Zip = require('./zip');

const PACK_VERSION = 'cuda12-ort1.28.2-1';
const FILES = [
  {
    name: 'onnxruntime-gpu.zip', label: 'ONNX Runtime GPU (Microsoft)',
    url: 'https://github.com/microsoft/onnxruntime/releases/download/v1.28.2/onnxruntime-win-x64-gpu_cuda12-1.28.2.zip',
    size: 454306028, sha256: '5b5ceb06e90405c7de9acdaf5aa06d288768e6a1e5dc54337281e09c03fc60f9',
    keep: (n) => /\/lib\/onnxruntime(_providers_cuda|_providers_shared)?\.dll$/i.test(n),
  },
  {
    name: 'cuda-runtime.whl', label: 'CUDA Runtime (NVIDIA)',
    url: 'https://files.pythonhosted.org/packages/59/df/e7c3a360be4f7b93cee39271b792669baeb3846c58a4df6dfcf187a7ffab/nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl',
    size: 3591604, sha256: '8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891', keep: (n) => /\/bin\/[^/]+\.dll$/i.test(n),
  },
  {
    name: 'cublas.whl', label: 'cuBLAS (NVIDIA)',
    url: 'https://files.pythonhosted.org/packages/20/e2/fc9a0e985249d873150276d5afb02e39a66817fedbf1a385724393e505ed/nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl',
    size: 553162896, sha256: '623f43027d40d44ceadf0043f002bd25cf353e8f13ce90b9a87057019f560661', keep: (n) => /\/bin\/[^/]+\.dll$/i.test(n),
  },
  {
    name: 'cufft.whl', label: 'cuFFT (NVIDIA)',
    url: 'https://files.pythonhosted.org/packages/20/ee/29955203338515b940bd4f60ffdbc073428f25ef9bfbce44c9a066aedc5c/nvidia_cufft_cu12-11.4.1.4-py3-none-win_amd64.whl',
    size: 200067309, sha256: '8e5bfaac795e93f80611f807d42844e8e27e340e0cde270dcb6c65386d795b80', keep: (n) => /\/bin\/[^/]+\.dll$/i.test(n),
  },
  {
    name: 'cudnn.whl', label: 'cuDNN (NVIDIA)',
    url: 'https://files.pythonhosted.org/packages/aa/38/f856579877f7c1c5066e61182e7de7bc27bf35a78c8d1b0fa592e6985bc4/nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl',
    size: 743068852, sha256: '06e9b0026f3bad97d2b58666330fabec04fe1672f776661ecb0ce0029c27f142', keep: (n) => /\/bin\/[^/]+\.dll$/i.test(n),
  },
];
const TOTAL = FILES.reduce((a, f) => a + f.size, 0);

/**
 * Versions « pleine précision » (float32) des modèles, pour la carte graphique.
 * Les versions compressées (int8) livrées pour le processeur ne vont PAS plus vite sur carte graphique
 * (leurs calculs int8 repassent par le processeur) : mesuré ×0,95. Ces versions-ci tournent entièrement sur la carte.
 * Les jetons (tokens.txt) sont repris du modèle déjà installé.
 */
const HF = (repo, f) => `https://huggingface.co/${repo}/resolve/main/${f}?download=true`;
const VARIANTS = {
  parakeet: {
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3',
    files: [
      { name: 'encoder.onnx', size: 41766257, sha256: '3eed7ce424bf8339ad09233533c687e2dbd07e74ccf5027b5e7344019ea373b0' },
      { name: 'encoder.weights', size: 2435420160, sha256: '3af3f51af5f2d01dbbf5af47d42c7962a2c205f11004254bb4f2b979862f39a8' },
      { name: 'decoder.onnx', size: 47233743, sha256: 'd593cdb0e571f5a457ec2219af9968cbf6b0e8198e8f7839b40a8754593bf68c' },
      { name: 'joiner.onnx', size: 25286330, sha256: 'b9b0bcf88ac571902e69a6536223ed2d94885e981b85045410f1403d53121a63' },
    ],
    paths: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' },
    vramGB: 3.5,
  },
  turbo: {
    repo: 'csukuangfj/sherpa-onnx-whisper-turbo',
    files: [
      { name: 'turbo-encoder.onnx', size: 735920, sha256: '1b960f278564fb8bbacd544d4f85f4dd6d8a64d3aa89543d8f2c4021c926f976' },
      { name: 'turbo-encoder.weights', size: 2600325120, sha256: '746f879ecf066450ab0cdecc05383380b85157270ff6c0a9fb7cfdd917036e12' },
      { name: 'turbo-decoder.onnx', size: 636209532, sha256: 'b24db5d90fa230c5eaa6b823d74862ced9e0d1dc3e01ec46601968e8db0e09ec' },
    ],
    paths: { encoder: 'turbo-encoder.onnx', decoder: 'turbo-decoder.onnx', tokens: 'turbo-tokens.txt' },
    vramGB: 4.5,
  },
};
const variantSize = (id) => (VARIANTS[id] ? VARIANTS[id].files.reduce((a, f) => a + f.size, 0) : 0);
const MIN_VRAM_MB = 3800;
const MIN_DRIVER = 528; // CUDA 12.x sous Windows

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(c);
  return h.digest('hex');
}

class Gpu {
  /**
   * @param {string} baseDir dossier où ranger le pack (à côté des modèles)
   * @param {(url:string, dest:string, signal:AbortSignal, onBytes:(n:number)=>void)=>Promise<void>} download
   * @param {string} addonDir dossier du moteur sherpa-onnx livré avec VoxForge (sherpa-onnx.node + DLL)
   */
  constructor(baseDir, download, addonDir, log = () => {}) {
    this.dir = path.join(baseDir, 'gpu-cuda12');
    this.download = download;
    this.addonDir = addonDir;
    this.log = log;
    this.info = null;
    this.ctrl = null;
    this.vctrl = new Map(); // téléchargements de versions carte graphique en cours
  }

  /** @returns {Promise<{ found:boolean, name?:string, vramMB?:number, driver?:string, ok:boolean, reason?:string, others?:string[] }>} */
  async detect(force = false) {
    if (this.info && !force) return this.info;
    // plusieurs demandes au démarrage (modèles, IA…) : une seule détection à la fois
    if (!this._detecting) this._detecting = this._detect().finally(() => { this._detecting = null; });
    return this._detecting;
  }

  async _detect() {
    let info = { found: false, ok: false };
    if (process.platform !== 'win32') { this.info = { ...info, reason: 'Disponible uniquement sous Windows.' }; return this.info; }
    const candidates = ['nvidia-smi', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'), 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
    let out = null;
    for (const c of candidates) { out = await run(c, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']); if (out) break; }
    if (out && out.trim()) {
      const best = out.trim().split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim()))
        .map(([name, mem, drv]) => ({ name, vramMB: +mem || 0, driver: drv || '' }))
        .sort((a, b) => b.vramMB - a.vramMB)[0];
      const drvMajor = parseInt(best.driver, 10) || 0;
      info = { found: true, ...best, ok: true };
      if (best.vramMB < MIN_VRAM_MB) info = { ...info, ok: false, reason: `Mémoire vidéo insuffisante (${(best.vramMB / 1024).toFixed(1).replace('.', ',')} Go, 4 Go nécessaires).` };
      else if (drvMajor && drvMajor < MIN_DRIVER) info = { ...info, ok: false, reason: `Pilote NVIDIA trop ancien (${best.driver}). Mettez-le à jour (version ${MIN_DRIVER} ou plus récente).` };
    } else {
      // pas de carte NVIDIA : on nomme quand même la carte présente, pour expliquer
      const ps = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], 10000);
      const others = (ps || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      info = { found: false, ok: false, others, reason: others.length ? `Carte graphique non compatible (${others.join(', ')}) : seule une carte NVIDIA (4 Go de mémoire vidéo ou plus) permet d’accélérer la transcription.` : 'Aucune carte graphique NVIDIA détectée.' };
    }
    this.info = info;
    return info;
  }

  installed() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf8')).version === PACK_VERSION && fs.existsSync(path.join(this.dir, 'sherpa-onnx.node')); } catch { return false; }
  }

  sizeInfo() { return { total: TOTAL }; }

  /** Téléchargement + vérification + extraction des DLL. onProgress({ phase, done, total, label }) */
  async install(onProgress = () => {}) {
    if (this.ctrl) throw new Error('Installation déjà en cours.');
    const info = await this.detect();
    if (!info.ok) throw new Error(info.reason || 'Carte graphique non compatible.');
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    const dl = path.join(this.dir, 'downloads');
    try {
      await fsp.mkdir(dl, { recursive: true });
      let done = 0;
      for (const f of FILES) {
        const dest = path.join(dl, f.name);
        let have = 0; try { have = (await fsp.stat(dest)).size; } catch { /* */ }
        if (have !== f.size) {
          const base = done;
          await this.download(f.url, dest, signal, (n) => { done = base + n; onProgress({ phase: 'download', done, total: TOTAL, label: f.label }); });
          const st = await fsp.stat(dest);
          if (st.size !== f.size) throw new Error(`Téléchargement incomplet : ${f.label}.`);
        }
        done = FILES.slice(0, FILES.indexOf(f) + 1).reduce((a, x) => a + x.size, 0);
        if (f.sha256) {
          onProgress({ phase: 'verify', done, total: TOTAL, label: f.label });
          if ((await sha256(dest)) !== f.sha256) { await fsp.rm(dest, { force: true }); throw new Error(`Fichier abîmé : ${f.label}. Relancez l’installation.`); }
        }
      }
      // extraction des seules DLL utiles
      let ex = 0;
      for (const f of FILES) {
        if (signal.aborted) throw Object.assign(new Error('Annulé'), { name: 'AbortError' });
        onProgress({ phase: 'extract', done: ex, total: FILES.length, label: f.label });
        await Zip.extract(path.join(dl, f.name), (e) => f.keep(e.name), this.dir);
        ex++;
      }
      // moteur sherpa-onnx de VoxForge, à côté de la version GPU d'ONNX Runtime
      for (const n of ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll']) {
        await fsp.copyFile(path.join(this.addonDir, n), path.join(this.dir, n));
      }
      const need = ['onnxruntime.dll', 'onnxruntime_providers_cuda.dll', 'onnxruntime_providers_shared.dll', 'cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll'];
      const miss = need.filter((n) => !fs.existsSync(path.join(this.dir, n)));
      if (miss.length) throw new Error('Pack incomplet : ' + miss.join(', '));
      await fsp.writeFile(path.join(this.dir, 'manifest.json'), JSON.stringify({ version: PACK_VERSION, installedAt: new Date().toISOString() }));
      await fsp.rm(dl, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      onProgress({ phase: 'done', done: TOTAL, total: TOTAL });
      return true;
    } finally { this.ctrl = null; }
  }

  cancel() { if (this.ctrl) this.ctrl.abort(); for (const c of this.vctrl.values()) c.abort(); }

  // ---------- versions « carte graphique » des modèles ----------
  variantDir(id) { return path.join(path.dirname(this.dir), `${id}-gpu`); }
  hasVariant(id) { return !!VARIANTS[id]; }
  variantInstalled(id) {
    const v = VARIANTS[id]; if (!v) return false;
    try { return JSON.parse(fs.readFileSync(path.join(this.variantDir(id), 'manifest.json'), 'utf8')).id === id && Object.values(v.paths).every((f) => fs.existsSync(path.join(this.variantDir(id), f))); } catch { return false; }
  }
  variantPaths(id) {
    const v = VARIANTS[id]; const d = this.variantDir(id);
    return Object.fromEntries(Object.entries(v.paths).map(([k, f]) => [k, path.join(d, f)]));
  }
  /** Téléchargement de la version carte graphique d'un modèle (tokens repris de `tokensFrom`). */
  async installVariant(id, tokensFrom, onProgress = () => {}) {
    const v = VARIANTS[id];
    if (!v) throw new Error('Pas de version carte graphique pour ce modèle.');
    if (this.vctrl.has(id)) throw new Error('Téléchargement déjà en cours.');
    if (!fs.existsSync(tokensFrom)) throw new Error('Installez d’abord le modèle normal (onglet Modèles).');
    const ctrl = new AbortController(); this.vctrl.set(id, ctrl);
    const dir = this.variantDir(id);
    const total = variantSize(id);
    try {
      await fsp.mkdir(dir, { recursive: true });
      let base = 0;
      for (const f of v.files) {
        const dest = path.join(dir, f.name);
        let have = 0; try { have = (await fsp.stat(dest)).size; } catch { /* */ }
        if (have !== f.size) {
          const b0 = base;
          await this.download(HF(v.repo, f.name), dest, ctrl.signal, (n) => onProgress({ id, phase: 'download', done: b0 + n, total }));
          if ((await fsp.stat(dest)).size !== f.size) throw new Error(`Téléchargement incomplet (${f.name}).`);
          onProgress({ id, phase: 'verify', done: b0 + f.size, total });
          if ((await sha256(dest)) !== f.sha256) { await fsp.rm(dest, { force: true }); throw new Error(`Fichier abîmé (${f.name}) : relancez le téléchargement.`); }
        }
        base += f.size;
      }
      await fsp.copyFile(tokensFrom, path.join(dir, v.paths.tokens));
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, variant: 'float32', installedAt: new Date().toISOString() }));
      onProgress({ id, phase: 'done', done: total, total });
      return true;
    } finally { this.vctrl.delete(id); }
  }
  async removeVariant(id) {
    const c = this.vctrl.get(id); if (c) c.abort();
    await fsp.rm(this.variantDir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  async remove() {
    this.cancel();
    await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const id of Object.keys(VARIANTS)) await this.removeVariant(id).catch(() => {});
  }
}

module.exports = { Gpu, PACK_VERSION, TOTAL, VARIANTS, variantSize };
