'use strict';
/**
 * Modèles de langage (résumé & traduction) au format GGUF.
 * - Catalogue téléchargeable depuis Hugging Face (le nom exact du fichier est résolu via l'API,
 *   avec plusieurs dépôts de secours).
 * - Import d'un fichier .gguf existant (référencé, pas copié).
 * - Détection automatique des modèles déjà téléchargés par LM Studio.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { ModelManager } = require('./models');

const GB = 1024 * 1024 * 1024;

const LLM_CATALOG = [
  {
    id: 'qwen2.5-1.5b', name: 'Qwen 2.5 — 1.5B', tagline: 'Léger et rapide. Correct pour les résumés, traduction moyenne.',
    size: 1.1 * GB, quality: 2, speed: 5, ram: '~2 Go',
    sources: [
      { repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', pattern: /q4_k_m\.gguf$/i },
      { repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
  {
    id: 'qwen2.5-3b', name: 'Qwen 2.5 — 3B', tagline: 'Bon équilibre vitesse / qualité, excellent en français et en anglais.',
    size: 2.0 * GB, quality: 3, speed: 4, ram: '~3,5 Go',
    sources: [
      { repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF', pattern: /q4_k_m\.gguf$/i },
      { repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
  {
    id: 'gemma-3-4b', name: 'Gemma 3 — 4B', tagline: 'Très bon pour traduire (140 langues) et résumer. Remplacé par Gemma 4 — E4B, plus juste.',
    size: 2.5 * GB, quality: 4, speed: 3, ram: '~4,5 Go',
    sources: [
      { repo: 'unsloth/gemma-3-4b-it-GGUF', pattern: /gemma-3-4b-it-Q4_K_M\.gguf$/i },
      { repo: 'bartowski/google_gemma-3-4b-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
      { repo: 'lmstudio-community/gemma-3-4b-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
  {
    id: 'gemma-4-e4b', name: 'Gemma 4 — E4B', tagline: 'Recommandé : le meilleur multilingue (140 langues) à vitesse égale. Bien plus juste que Gemma 3 4B en français, résumés et fiches.',
    size: 4977171584, quality: 5, speed: 3, ram: '~6 Go', recommended: true,
    sources: [
      { repo: 'unsloth/gemma-4-E4B-it-GGUF', pattern: /gemma-4-E4B-it-Q4_K_M\.gguf$/i },
      { repo: 'lmstudio-community/gemma-4-E4B-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
      { repo: 'bartowski/google_gemma-4-E4B-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
  {
    id: 'gemma-4-12b', name: 'Gemma 4 — 12B', tagline: 'Qualité maximale, multilingue. Pour carte graphique de 12 Go ou plus (sinon lent).',
    size: 7121861440, quality: 5, speed: 1, ram: '~10 Go', vramMin: 11000,
    sources: [
      { repo: 'unsloth/gemma-4-12b-it-GGUF', pattern: /gemma-4-12b-it-Q4_K_M\.gguf$/i },
      { repo: 'lmstudio-community/gemma-4-12b-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
      { repo: 'bartowski/google_gemma-4-12b-it-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
  {
    id: 'qwen2.5-7b', name: 'Qwen 2.5 — 7B', tagline: 'Qualité maximale, nécessite un PC puissant (idéalement avec carte graphique).',
    size: 4.7 * GB, quality: 5, speed: 1, ram: '~7 Go',
    sources: [
      { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', pattern: /Qwen2\.5-7B-Instruct-Q4_K_M\.gguf$/i },
      { repo: 'lmstudio-community/Qwen2.5-7B-Instruct-GGUF', pattern: /Q4_K_M\.gguf$/i },
    ],
  },
];

class LlmModels {
  constructor(root, fetchFn, store) {
    this.root = root;
    this.fetch = fetchFn;
    this.store = store; // { get(): {customModels: [...]}, set(patch) }
    this.dl = new ModelManager(root, fetchFn);
    this.active = new Map();
    fs.mkdirSync(root, { recursive: true });
  }

  dir(id) { return path.join(this.root, id); }

  installedFile(id) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir(id), 'manifest.json'), 'utf8'));
      const f = path.join(this.dir(id), m.file);
      return fs.existsSync(f) ? f : null;
    } catch { return null; }
  }

  /** Modèles GGUF trouvés dans les dossiers de LM Studio. */
  /** Parcours asynchrone (ne bloque jamais l'interface) ; résultat gardé 30 s. */
  async scanLmStudio() {
    if (this._lms && Date.now() - this._lms.t < 30000) return this._lms.list;
    if (!this._lmsPending) this._lmsPending = this._scanLmStudio().finally(() => { this._lmsPending = null; });
    const list = await this._lmsPending;
    this._lms = { t: Date.now(), list };
    return list;
  }

  async _scanLmStudio() {
    const roots = [path.join(os.homedir(), '.lmstudio', 'models'), path.join(os.homedir(), '.cache', 'lm-studio', 'models')];
    const found = [];
    const walk = async (d, depth) => {
      if (depth > 4 || found.length > 100) return;
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (/\.gguf$/i.test(e.name) && !/mmproj|embed/i.test(e.name) && !/-0000[2-9]-of-/i.test(e.name)) {
          try { found.push({ path: p, size: (await fsp.stat(p)).size }); } catch { /* */ }
        }
      }
    };
    for (const r of roots) await walk(r, 0);
    return found.map((f) => ({ id: 'lms:' + f.path, name: path.basename(f.path).replace(/\.gguf$/i, ''), path: f.path, onDisk: f.size, origin: 'lmstudio' }));
  }

  async list() {
    const builtIn = LLM_CATALOG.map((m) => {
      const file = this.installedFile(m.id);
      let onDisk = 0;
      if (file) { try { onDisk = fs.statSync(file).size; } catch { /* */ } }
      const { sources, ...rest } = m;
      return { ...rest, origin: 'catalog', installed: !!file, path: file, onDisk, downloading: this.active.has(m.id) };
    });
    const custom = (this.store.get().customModels || [])
      .filter((c) => fs.existsSync(c.path))
      .map((c) => ({ ...c, origin: 'import', installed: true, onDisk: (() => { try { return fs.statSync(c.path).size; } catch { return 0; } })() }));
    const hidden = this.store.get().hiddenModels || [];
    const lms = (await this.scanLmStudio()).filter((l) => !custom.some((c) => c.path === l.path) && !hidden.includes(l.id)).map((l) => ({ ...l, installed: true }));
    return [...builtIn, ...custom, ...lms];
  }

  /** Recommandation selon la carte graphique : le 12B seulement s'il tient entièrement dans sa mémoire. */
  static withRecommendation(list, vramMB = 0) {
    const big = LLM_CATALOG.find((m) => m.vramMin && vramMB >= m.vramMin);
    const reco = big ? big.id : 'gemma-4-e4b';
    return list.map((m) => (m.origin === 'catalog' ? { ...m, recommended: m.id === reco } : m));
  }

  async resolvePath(id) {
    if (!id) return null;
    const m = (await this.list()).find((x) => x.id === id && x.installed);
    return m ? m.path : null;
  }

  async addCustom(filePath) {
    const st = this.store.get();
    const list = (st.customModels || []).filter((c) => c.path !== filePath);
    const entry = { id: 'custom:' + filePath, name: path.basename(filePath).replace(/\.gguf$/i, ''), path: filePath };
    list.push(entry);
    await this.store.set({ customModels: list });
    return entry;
  }

  async remove(id) {
    if (id.startsWith('custom:') || id.startsWith('lms:')) {
      // on retire seulement la référence : le fichier de l'utilisateur n'est jamais supprimé
      const st = this.store.get();
      const patch = { customModels: (st.customModels || []).filter((c) => c.id !== id) };
      if (id.startsWith('lms:')) patch.hiddenModels = [...new Set([...(st.hiddenModels || []), id])];
      await this.store.set(patch);
      return;
    }
    if (!LLM_CATALOG.some((m) => m.id === id)) throw new Error('Modèle inconnu : ' + id);
    this.cancel(id);
    await fsp.rm(this.dir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  cancel(id) { const c = this.active.get(id); if (c) c.abort(); }

  async resolveSource(m, signal) {
    const errors = [];
    for (const src of m.sources) {
      try {
        const res = await this.fetch(`https://huggingface.co/api/models/${src.repo}`, { signal });
        if (!res.ok) { errors.push(`${src.repo}: HTTP ${res.status}`); continue; }
        const j = await res.json();
        const files = (j.siblings || []).map((s) => s.rfilename).filter((f) => src.pattern.test(f) && !/-0000\d-of-/i.test(f));
        if (!files.length) { errors.push(`${src.repo}: fichier introuvable`); continue; }
        files.sort((a, b) => a.length - b.length);
        return { repo: src.repo, file: files[0], url: `https://huggingface.co/${src.repo}/resolve/main/${files[0].split('/').map(encodeURIComponent).join('/')}?download=true` };
      } catch (e) {
        if (signal && signal.aborted) throw e;
        errors.push(`${src.repo}: ${e.message}`);
      }
    }
    throw new Error('Aucune source disponible (' + errors.join(' ; ') + ')');
  }

  async install(id, onProgress) {
    const m = LLM_CATALOG.find((x) => x.id === id);
    if (!m) throw new Error('Modèle inconnu');
    if (this.active.has(id)) throw new Error('Téléchargement déjà en cours');
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    const dir = this.dir(id);
    await fsp.mkdir(dir, { recursive: true });
    let lastT = Date.now(), lastB = 0, speed = 0, lastSent = 0;
    try {
      onProgress({ id, phase: 'resolve' });
      const src = await this.resolveSource(m, ctrl.signal);
      const fileName = path.basename(src.file);
      const dest = path.join(dir, fileName);
      await this.dl.downloadFile(src.url, dest, ctrl.signal, (got, total) => {
        const now = Date.now();
        if (now - lastT > 1000) { speed = (got - lastB) / ((now - lastT) / 1000); lastT = now; lastB = got; }
        if (now - lastSent < 200 && got < total) return;
        lastSent = now;
        onProgress({ id, phase: 'download', received: got, total, speed, source: src.repo });
      });
      // contrôle : un fichier GGUF commence par la signature « GGUF »
      const fd = await fsp.open(dest, 'r');
      const head = Buffer.alloc(4);
      await fd.read(head, 0, 4, 0); await fd.close();
      if (head.toString('ascii') !== 'GGUF') { await fsp.rm(dest, { force: true }); throw new Error('Fichier téléchargé invalide'); }
      await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, file: fileName, repo: src.repo, installedAt: new Date().toISOString() }, null, 2));
      onProgress({ id, phase: 'done' });
    } catch (e) {
      onProgress({ id, phase: ctrl.signal.aborted ? 'cancelled' : 'error', message: e.message });
      throw e;
    } finally {
      this.active.delete(id);
    }
  }
}

module.exports = { LlmModels, LLM_CATALOG };
