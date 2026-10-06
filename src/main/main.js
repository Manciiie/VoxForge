'use strict';
const { app, BrowserWindow, dialog, shell, utilityProcess, net, session, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');
const { ModelManager, CATALOG, RETIRED } = require('./models');
const { importText, TEXT_EXT } = require('./textimport');
const { Knowledge } = require('./knowledge');
const { Gpu, VARIANTS, variantSize } = require('./gpu');
const Vocab = require('../shared/vocabulary');
const { LlmModels } = require('./llm-models');
const { canal, canalEvenement, definirJournal, R } = require('./ipc');
const { masquerSecrets, urlExterneAutorisee } = require('./securite');
const secrets = require('./secrets');

const MODE_TEST = process.env.FORGE_TEST_LANCEMENT === '1'; // scripts/verifier-lancement.js et piloter.js

app.setAppUserModelId('com.voxforge.app');
if (process.env.VOX_USERDATA) app.setPath('userData', process.env.VOX_USERDATA);

// ---------- Journal de démarrage (diagnostic) ----------
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
} catch { /* journal facultatif */ }
const secretsConnus = new Set();
const declarerSecret = (v) => { if (v && String(v).length >= 4) secretsConnus.add(String(v)); };
function log(...a) {
  // les secrets (clé d'API…) ne sont jamais écrits en clair dans le journal
  const texte = masquerSecrets(a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' '), [...secretsConnus]);
  const line = `[${new Date().toISOString()}] ${texte}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* */ }
  if (!app.isPackaged) process.stdout.write(line);
}
log('=== Démarrage VoxForge', app.getVersion(), process.platform, os.release(), 'electron', process.versions.electron);
definirJournal({ avertissement: (...m) => log('AVERT', ...m) });

let fatalShown = false;
process.on('uncaughtException', (e) => {
  log('ERREUR non gérée', e);
  if (MODE_TEST) { console.error('FORGE_ERREUR', e); app.exit(1); return; }
  if (!fatalShown) {
    fatalShown = true;
    try { dialog.showErrorBox('VoxForge — erreur', `${e && e.message}\n\nDétails enregistrés dans :\n${LOG_FILE}`); } catch { /* */ }
  }
});
process.on('unhandledRejection', (e) => log('Promesse rejetée', e));

// ---------- Durcissement de toute page créée par l'application ----------
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => { if (url !== contents.getURL()) ev.preventDefault(); });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { if (urlExterneAutorisee(url)) shell.openExternal(url); return { action: 'deny' }; });
});

// Utilisé par scripts/verifier-lancement.js : l'app signale qu'elle a démarré sans erreur console, puis se ferme.
function brancherTestLancement(f) {
  const erreurs = [];
  f.webContents.on('console-message', (ev, ancienNiveau, ancienMessage) => {
    const niveau = ev && ev.level !== undefined ? ev.level : ancienNiveau;
    if (niveau === 'error' || niveau === 3) erreurs.push(ev && ev.message !== undefined ? ev.message : ancienMessage);
  });
  f.webContents.on('did-fail-load', (_e, code, desc) => { console.error('FORGE_ERREUR chargement', code, desc); app.exit(1); });
  f.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const ok = await f.webContents.executeJavaScript('window.__forgePret === true').catch(() => false);
      if (!ok) erreurs.push('L’interface n’a pas signalé window.__forgePret = true');
      if (erreurs.length) { console.error('FORGE_ERREUR', JSON.stringify(erreurs)); app.exit(1); } else { console.log('FORGE_PRET'); app.exit(0); }
    }, 2500);
  });
}

// ---------- Mode sans échec ----------
// Si le lancement précédent n'a jamais affiché de fenêtre (pilote graphique défaillant…),
// on démarre sans accélération matérielle.
const STATE_FILE = path.join(app.getPath('userData'), 'launch-state.json');
let launchState = {};
try { launchState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* premier lancement */ }
const SAFE_MODE = process.argv.includes('--safe-mode') || launchState.forceSafe || (launchState.pending && launchState.attempts >= 1);
if (SAFE_MODE) {
  app.disableHardwareAcceleration();
  log('Mode sans échec : accélération graphique désactivée', launchState);
}
// le mode sans échec « forcé » (après des plantages graphiques) est conservé d'un lancement à l'autre
function writeState(st) { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ forceSafe: !!launchState.forceSafe, ...st })); } catch { /* */ } }

// ---------- Instance unique ----------
const HEARTBEAT = path.join(app.getPath('userData'), 'heartbeat');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('Une autre instance détient le verrou');
  app.whenReady().then(async () => {
    // L'instance existante écrit un « battement » toutes les 2 s : { t, started, shown }.
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch { /* */ }
    const now = Date.now();
    const alive = hb && now - hb.t < 6000;
    // vivante et affichée → elle passe au premier plan ; vivante et en cours de démarrage → on la laisse finir
    if (alive && (hb.shown || now - hb.started < 25000)) { app.quit(); return; }
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'VoxForge',
      message: 'VoxForge semble déjà lancé mais ne répond pas.',
      detail: 'Une ancienne instance est restée bloquée en arrière-plan. Voulez-vous la fermer et relancer VoxForge ?',
      buttons: ['Fermer et relancer', 'Annuler'], defaultId: 0, cancelId: 1,
    });
    if (r.response === 0) {
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(path.join(app.getPath('userData'), 'instance.pid'), 'utf8'), 10); } catch { /* */ }
      log('Fermeture de l’instance bloquée', pid);
      if (pid && pid !== process.pid) {
        if (process.platform === 'win32') {
          try { require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { log('taskkill', e.message); }
        } else { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
      }
      writeState({ pending: false, attempts: 0 });
      setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
    } else app.quit();
  });
} else {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'instance.pid'), String(process.pid)); } catch { /* */ }
  const hbState = { started: Date.now(), shown: false };
  const beat = () => { try { fs.writeFileSync(HEARTBEAT, JSON.stringify({ ...hbState, t: Date.now() })); } catch { /* */ } };
  beat(); setInterval(beat, 2000).unref();
  global.__voxMarkShown = () => { hbState.shown = true; beat(); };
  writeState({ pending: true, attempts: (launchState.pending ? (launchState.attempts || 0) + 1 : 0), safe: SAFE_MODE });
}

const isDev = !app.isPackaged;
const ROOT = path.join(__dirname, '..', '..');
const RES = isDev ? path.join(ROOT, 'resources') : process.resourcesPath;
const USER = app.getPath('userData');
const HISTORY_DIR = path.join(USER, 'history');
const RECORD_DIR = path.join(USER, 'recordings');
const PREVIEW_DIR = path.join(os.tmpdir(), 'voxforge-preview');
const SETTINGS_FILE = path.join(USER, 'settings.json');
if (gotLock) try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch { /* fichiers temporaires en cours d'utilisation */ }
for (const d of [HISTORY_DIR, RECORD_DIR, PREVIEW_DIR]) fs.mkdirSync(d, { recursive: true });

function ffmpegPath() {
  const exe = path.join(RES, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(exe) && (process.platform === 'win32' || !exe.endsWith('.exe'))) return exe;
  return 'ffmpeg'; // développement Linux/macOS : ffmpeg du système
}
const VAD_MODEL = path.join(RES, 'silero_vad.onnx');

// ---------- Paramètres ----------
function defaultThreads() {
  const logical = os.cpus().length || 4;
  const physical = logical >= 8 ? Math.floor(logical / 2) : Math.max(1, logical - 1);
  return Math.max(1, Math.min(8, physical));
}
const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#7c5cff',
  model: '',
  language: '',
  task: 'transcribe',
  multilingual: false,
  // ONNX Runtime est plus rapide sur les cœurs physiques : l'hyperthreading ralentit le calcul.
  threads: defaultThreads(),
  vadThreshold: 0.45,
  filterHallucinations: true,
  exportFormat: 'txt',
  modelsDir: path.join(USER, 'models'),
  autoSave: true,
  ai: {},
  library: { folders: [] },     // dossiers de l'historique : [{ id, name, color }]
  queueProject: '',             // projet auquel ajouter automatiquement les nouvelles transcriptions
  dictionary: [],               // dictionnaire personnalisé : [{ from, to, whole, caseSensitive, enabled }]
  preload: true,                // charge le modèle en mémoire dès l'ouverture
  parakeetCheck: true,          // Parakeet : passages douteux revérifiés par un modèle Whisper installé
  perf: {},                     // vitesse mesurée sur ce PC : { [modèle]: { rtf, threads, n } }
  vocabulary: [],               // vocabulaire du cours (tous les enregistrements) : noms propres, termes techniques
  vocabPacks: [],               // listes prêtes à l'emploi activées (ex. 'droit')
  removeEchoes: true,           // supprime les passages recopiés par erreur (Whisper en fin de bloc)
  gpu: { use: 'auto' },         // transcription sur carte graphique : 'auto' (si le pack est installé et plus rapide) ou 'off'
  verifierMajAuDemarrage: true, // mises à jour : recherche au démarrage (jamais installée sans accord)
  versionIgnoree: null,
};
const DEFAULT_AI = {
  provider: 'local',            // 'local' (modèle GGUF intégré) ou 'openai' (LM Studio, Ollama, API…)
  localModel: '',
  gpu: 'auto',                  // 'auto' (carte graphique si possible) ou 'off'
  parallel: 'auto',             // plusieurs rédactions simultanées sur carte graphique ('auto' ou 'off')
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  remoteModel: '',
  translateTarget: 'en',
  summaryLang: 'fr',
  summaryLength: 'medium',
  customModels: [],
  detectCalib: {},             // étalonnage de la détection d'origine IA, par modèle
};
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) {
  if (fs.existsSync(SETTINGS_FILE)) { // fichier abîmé : on le garde de côté plutôt que de l'écraser
    log('settings.json illisible, sauvegardé en settings.broken.json', e.message);
    try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE.replace(/\.json$/, '.broken.json')); } catch { /* */ }
  }
}
// ---------- Écritures de fichiers JSON : atomiques et sérialisées par fichier ----------
const fileLocks = new Map();
/** Exécute fn() seul pour ce fichier (les opérations lire-modifier-écrire ne se marchent plus dessus). */
function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  fileLocks.set(file, tail);
  tail.then(() => { if (fileLocks.get(file) === tail) fileLocks.delete(file); });
  return run;
}
/** Écriture atomique : fichier temporaire unique puis renommage (jamais de JSON à moitié écrit). */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  try { await fsp.rename(tmp, file); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
}
const saveSettings = () => withFileLock(SETTINGS_FILE, () => writeJsonAtomic(SETTINGS_FILE, settings)).catch((e) => log('Paramètres non enregistrés', e));

settings.ai = { ...DEFAULT_AI, ...(settings.ai || {}) };
let models;
try { models = new ModelManager(settings.modelsDir, (u, init) => net.fetch(u, init)); } catch (e) {
  // dossier des modèles sur un disque débranché / renommé : on démarre quand même avec le dossier par défaut
  log('Dossier des modèles inaccessible :', settings.modelsDir, e.message);
  global.__voxModelsDirError = settings.modelsDir;
  models = new ModelManager(path.join(USER, 'models'), (u, init) => net.fetch(u, init));
}
// Modèles retirés (Tiny, Base, Small, Medium : plus lents ou moins précis que Parakeet / Turbo) :
// on bascule sur le meilleur modèle installé et on supprime leurs fichiers téléchargés par VoxForge
(function retireModels() {
  for (const id of RETIRED) {
    try {
      const dir = path.join(models.root, id);
      let changed = false;
      if (settings.model === id) {
        settings.model = ['parakeet', 'turbo', 'large-v3'].find((m) => models.isInstalled(m)) || '';
        changed = true;
      }
      if (settings.perf && settings.perf[id]) { const { [id]: _drop, ...rest } = settings.perf; settings.perf = rest; changed = true; }
      // suppression seulement si le dossier ne contient QUE des fichiers de modèle VoxForge
      // (un dossier « base » ou « small » de l'utilisateur dans le même dossier n'est jamais touché)
      if (fs.existsSync(dir)) {
        const names = fs.readdirSync(dir);
        const ours = names.length && names.every((n) => /^(manifest\.json|test_wavs|.*(encoder|decoder|joiner|tokens)[\w.-]*\.(onnx|txt)(\.part)?|.*\.tar\.bz2(\.part)?)$/i.test(n))
          && names.some((n) => /\.onnx$|^manifest\.json$/i.test(n));
        if (ours) { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); log(`Modèle ${id} retiré du disque`); }
      }
      if (changed) saveSettings();
    } catch (e) { log(`Retrait du modèle ${id} :`, e.message); }
  }
})();
// ---------- Carte graphique (NVIDIA) ----------
const makeGpu = () => new Gpu(models.root, (u, d, sig, cb) => models.downloadFile(u, d, sig, cb), path.join(ROOT, 'node_modules', 'sherpa-onnx-win-x64'), log);
let gpu = makeGpu();
/** La carte graphique sert pour ce modèle si le pack est installé ET si le test l'a montrée plus rapide. */
function gpuFor(modelId) {
  const g = settings.gpu || {};
  if (g.use === 'off' || !gpu.installed()) return false;
  const b = (g.bench || {})[modelId];
  return !!(b && b.ok);
}
/** Fichiers du modèle à charger : version carte graphique (pleine précision) si c'est elle qui a gagné le test. */
function modelPathsFor(id) {
  const b = ((settings.gpu || {}).bench || {})[id];
  if (gpuFor(id) && b && b.variant === 'float32' && gpu.variantInstalled(id)) return gpu.variantPaths(id);
  return models.paths(id);
}
const workerKey = (eo) => `${eo.modelId}|${settings.threads}${eo.provider === 'cuda' || eo.checkerProvider === 'cuda' ? '|gpu' : ''}`;

/** Mesure la vitesse d'un modèle dans un processus dédié (processeur ou carte graphique). */
function benchIn(useGpu, options, seconds = 20) {
  return new Promise((resolve) => {
    const w = utilityProcess.fork(path.join(ROOT, 'src', 'engine', 'worker.js'), [], {
      serviceName: 'VoxForge Test de vitesse', stdio: 'pipe',
      env: { ...process.env, ...(useGpu ? { VOX_GPU_DIR: gpu.dir } : {}) },
    });
    let errTail = '';
    w.stderr && w.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-2000); });
    const timer = setTimeout(() => { try { w.kill(); } catch { /* */ } resolve({ error: 'délai dépassé' }); }, 6 * 60 * 1000);
    w.on('message', (m) => {
      if (m.type === 'bench-done' || m.type === 'bench-failed') {
        clearTimeout(timer); try { w.kill(); } catch { /* */ }
        resolve(m.type === 'bench-done' ? { msPerSec: m.msPerSec, loadMs: m.loadMs, fallback: /Fallback to cpu/i.test(errTail) } : { error: m.message });
      }
    });
    w.on('exit', (code) => { clearTimeout(timer); resolve({ error: `arrêt du processus (code ${code})${/cudnn|cublas|cuda/i.test(errTail) ? ' : ' + errTail.trim().split(/\r?\n/).slice(-1)[0] : ''}` }); });
    w.postMessage({ type: 'bench', seconds, options: { ...options, provider: useGpu ? 'cuda' : 'cpu' } });
  });
}
let gpuTesting = false;
const busy = () => !!((workers.file && workers.file._job) || (workers.live && workers.live._active));
async function testGpu(only = null) {
  if (gpuTesting) return settings.gpu;
  if (busy()) throw new Error('Une transcription ou une dictée est en cours : le test de la carte graphique se fera plus tard (bouton « Refaire le test »).');
  gpuTesting = true;
  try {
    const bench = { ...((settings.gpu || {}).bench || {}) };
    const ids = CATALOG.filter((m) => models.isInstalled(m.id) && (!only || only.includes(m.id))).map((m) => m.id);
    // pendant le test : aucun autre modèle en mémoire
    if (workers.file && !workers.file._job) killWorker('file');
    for (const id of ids) {
      send('gpu:progress', { phase: 'test', label: CATALOG.find((m) => m.id === id).name, done: ids.indexOf(id), total: ids.length });
      const opts = { model: models.paths(id), threads: settings.threads, language: 'fr', task: 'transcribe', vadModel: VAD_MODEL };
      // carte graphique : version pleine précision si elle est installée (la version compressée n'y gagne rien)
      const variant = gpu.variantInstalled(id) ? 'float32' : 'int8';
      const g = await benchIn(true, variant === 'float32' ? { ...opts, model: gpu.variantPaths(id) } : opts);
      const c = g.error ? null : await benchIn(false, opts);
      const cpuErr = c && c.error ? 'test sur le processeur impossible : ' + c.error : '';
      const speedup = c && !c.error && g.msPerSec ? c.msPerSec / g.msPerSec : 0;
      const ok = !g.error && !g.fallback && !cpuErr && speedup >= 1.3;
      bench[id] = { ok, variant, speedup: +speedup.toFixed(2), gpuMs: g.msPerSec || null, cpuMs: c && !c.error ? c.msPerSec : null, error: g.error || cpuErr || (g.fallback ? 'la carte graphique n’a pas pu être utilisée (repli sur le processeur)' : ''), at: new Date().toISOString() };
      log(`Test carte graphique ${id} : ${g.error || cpuErr ? 'échec — ' + (g.error || cpuErr) : `processeur ${c && c.msPerSec} ms/s, carte ${g.msPerSec} ms/s → ×${speedup.toFixed(2)} ${ok ? '(utilisée)' : '(non utilisée)'}`}`);
    }
    settings.gpu = { ...(settings.gpu || {}), use: (settings.gpu || {}).use || 'auto', bench };
    await saveSettings();
    // nouveaux réglages : processus neufs (sauf s'ils travaillent — ils seront remplacés au prochain fichier)
    if (workers.file && !workers.file._job) killWorker('file');
    if (workers.live && !workers.live._active) killWorker('live');
    setTimeout(() => preloadModel('test carte graphique'), 500);
    send('gpu:progress', { phase: 'tested', bench });
    return settings.gpu;
  } finally { gpuTesting = false; }
}
canal('gpu:status', R.rien, async () => ({
  info: await gpu.detect(), installed: gpu.installed(), installing: !!gpu.ctrl, testing: gpuTesting, total: gpu.sizeInfo().total, settings: settings.gpu || {},
  variants: Object.fromEntries(CATALOG.filter((m) => VARIANTS[m.id] && models.isInstalled(m.id)).map((m) => [m.id, {
    name: m.name, installed: gpu.variantInstalled(m.id), downloading: gpu.vctrl.has(m.id), size: variantSize(m.id), vramGB: VARIANTS[m.id].vramGB,
  }])),
}));
canal('gpu:installModel', [R.id], async (e, id) => {
  if (!gpu.installed()) return { ok: false, error: 'Installez d’abord l’accélération par carte graphique.' };
  if (!models.isInstalled(id)) return { ok: false, error: 'Installez d’abord le modèle normal.' };
  try {
    await gpu.installVariant(id, models.paths(id).tokens, (p) => send('gpu:progress', { ...p, phase: 'model-' + p.phase }));
    log(`Version carte graphique de ${id} installée`);
    if (!busy()) await testGpu([id]);
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError' || /annul|abort/i.test(err.message)) return { ok: false, cancelled: true };
    log('Version carte graphique', id, ':', err.message);
    return { ok: false, error: err.message };
  }
});
canal('gpu:removeModel', [R.id], async (e, id) => {
  if (!VARIANTS[id]) return false;
  if (busy()) throw new Error('Attendez la fin de la transcription ou de la dictée en cours.');
  if (workers.file) killWorker('file');
  await gpu.removeVariant(id);
  const g = settings.gpu || {}; const bench = { ...(g.bench || {}) };
  if (bench[id] && bench[id].variant === 'float32') delete bench[id];
  settings.gpu = { ...g, bench }; await saveSettings();
  setTimeout(() => preloadModel('version carte graphique retirée'), 500);
  return true;
});
canal('gpu:install', R.rien, async () => {
  try {
    await gpu.install((p) => send('gpu:progress', p));
    log('Pack carte graphique installé');
    await testGpu();
    return { ok: true };
  } catch (e) {
    if (e.name === 'AbortError' || /annul/i.test(e.message)) return { ok: false, cancelled: true };
    log('Pack carte graphique :', e.message);
    return { ok: false, error: e.message };
  }
});
canal('gpu:cancel', R.rien, () => { gpu.cancel(); return true; });
canal('gpu:test', R.rien, async () => { try { return { ok: true, settings: await testGpu() }; } catch (e) { return { ok: false, error: e.message }; } });
canal('gpu:remove', R.rien, async () => {
  if (busy()) throw new Error('Attendez la fin de la transcription ou de la dictée en cours.');
  killWorker('file'); killWorker('live');
  await gpu.remove();
  settings.gpu = { use: (settings.gpu || {}).use || 'auto', bench: {} };
  await saveSettings();
  setTimeout(() => preloadModel('carte graphique retirée'), 500);
  return true;
});

const aiStore = {
  get: () => settings.ai,
  set: async (patch) => { settings.ai = { ...settings.ai, ...patch }; await saveSettings(); },
};
const makeLlm = () => new LlmModels(path.join(settings.modelsDir, 'llm'), (u, init) => net.fetch(u, init), aiStore);
let llms = makeLlm();

// ---------- Fenêtre ----------
let win = null;
function overlayColors() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? { color: '#0f1117', symbolColor: '#c9cdd8', height: 40 } : { color: '#f5f6fa', symbolColor: '#3a3f4b', height: 40 };
}
let shown = false;
function createWindow() {
  log('Création de la fenêtre', SAFE_MODE ? '(mode sans échec)' : '');
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: overlayColors().color,
    title: 'VoxForge',
    icon: path.join(ROOT, 'src', 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  win.removeMenu();
  // affichage immédiat (fond aux couleurs du thème + écran de chargement intégré à la page) :
  // la fenêtre apparaît tout de suite, même si le premier lancement est lent
  if (!process.env.VOX_NO_EARLY_SHOW) { try { win.show(); } catch { /* */ } }
  const reveal = (why) => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    log('Fenêtre affichée :', why);
    writeState({ pending: false, attempts: 0 });
    if (global.__voxMarkShown) global.__voxMarkShown();
    // préchargement du modèle une fois l'interface affichée (sans ralentir l'ouverture)
    setTimeout(() => preloadModel('démarrage'), 2500);
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => { log('Interface chargée'); setTimeout(() => reveal('did-finish-load'), 300); });
  // Filet de sécurité : la fenêtre s'affiche quoi qu'il arrive au bout de 6 s.
  setTimeout(() => reveal('délai de sécurité'), 6000);
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    log('Échec de chargement', code, desc, url);
    reveal('échec de chargement');
    dialog.showErrorBox('VoxForge', `L’interface n’a pas pu se charger (${desc}).\n\nJournal : ${LOG_FILE}`);
  });
  win.webContents.on('render-process-gone', (e, d) => {
    log('Processus d’affichage arrêté', d);
    if (d.reason === 'clean-exit') return;
    dialog.showMessageBox(win, { type: 'error', title: 'VoxForge', message: 'L’affichage de VoxForge s’est arrêté.', detail: `Raison : ${d.reason}. La fenêtre va être rechargée.`, buttons: ['Recharger'] })
      .then(() => { if (!win.isDestroyed()) win.reload(); });
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) log('[interface]', message, `(${path.basename(sourceId || '')}:${line})`);
  });
  win.webContents.on('preload-error', (e, p, err) => log('Erreur preload', err));
  const dark = overlayColors().color === '#0f1117';
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'), { query: { theme: dark ? 'dark' : 'light', accent: settings.accent || '' } }).catch((e) => log('loadFile', e));
  win.webContents.setWindowOpenHandler(({ url }) => { if (urlExterneAutorisee(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (MODE_TEST) brancherTestLancement(win);
  if (isDev && process.env.VOX_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

app.on('second-instance', () => {
  log('Seconde instance : mise au premier plan');
  if (win && !win.isDestroyed()) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
});

// Le processus graphique plante en boucle (pilote incompatible) : relance en mode sans échec.
let gpuCrashes = 0;
app.on('child-process-gone', (e, d) => {
  log('Processus enfant arrêté', d);
  if (d.type === 'GPU' && d.reason !== 'clean-exit' && !SAFE_MODE) {
    gpuCrashes++;
    if (gpuCrashes >= 2 && !shown) {
      log('Plantages GPU répétés : relance en mode sans échec');
      writeState({ forceSafe: true, pending: false, attempts: 0 });
      app.relaunch(); app.exit(0);
    }
  }
});

const SECRET_API = 'ai_api_key';
/** Ancienne version : la clé d'API était écrite en clair dans settings.json → déplacée dans le coffre chiffré. */
function migrerSecrets() {
  const k = settings.ai && settings.ai.apiKey;
  if (!k) return;
  try {
    secrets.enregistrer(SECRET_API, k);
    settings.ai.apiKey = '';
    saveSettings();
    log('Clé d’API déplacée vers le coffre chiffré');
  } catch (e) { log('Clé d’API : coffre indisponible, conservée telle quelle', e.message); declarerSecret(k); }
}
/** Paramètres tels que l'interface les reçoit : jamais la valeur d'un secret, seulement sa présence. */
function settingsPourInterface() {
  const { apiKey, ...ai } = settings.ai || {};
  return { ...settings, ai: { ...ai, apiKey: '', apiKeySet: !!apiKey || secrets.existe(SECRET_API) } };
}
const cleApi = () => secrets.lire(SECRET_API) || (settings.ai && settings.ai.apiKey) || '';

// Linux (tests en conteneur uniquement ; Windows utilise toujours DPAPI) : sans trousseau, le coffre reste utilisable
if (process.platform === 'linux' && typeof safeStorage.setUsePlainTextEncryption === 'function') safeStorage.setUsePlainTextEncryption(true);

if (gotLock) app.whenReady().then(() => {
  log('Electron prêt');
  secrets.initialiser(app.getPath('userData'), safeStorage, declarerSecret);
  migrerSecrets();
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' || perm === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' || perm === 'clipboard-sanitized-write');
  createWindow();
  require('./mises-a-jour').demarrer(win, {
    journal: { info: (...m) => log(...m), avertissement: (...m) => log('AVERT', ...m), erreur: (...m) => log('ERREUR', ...m), declarerSecret },
    parametres: { lire: () => settings, modifier: (p) => { settings = { ...settings, ...p }; saveSettings(); } },
  });
});
app.on('window-all-closed', () => { killWorker('file'); killWorker('live'); killWorker('ai'); app.quit(); });
app.on('will-quit', () => { if (gotLock) { try { fs.rmSync(HEARTBEAT, { force: true }); } catch { /* */ } } log('Fermeture'); });

// ---------- Processus de calcul ----------
const workers = { file: null, live: null, ai: null };
const WORKER_DEF = {
  file: { script: ['src', 'engine', 'worker.js'], name: 'VoxForge Transcription', channel: 'job:event' },
  live: { script: ['src', 'engine', 'worker.js'], name: 'VoxForge Dictée', channel: 'live:event' },
  ai: { script: ['src', 'ai', 'ai-worker.js'], name: 'VoxForge IA', channel: 'ai:event' },
};
function getWorker(kind, useGpu = false) {
  if (workers[kind]) return workers[kind];
  const def = WORKER_DEF[kind];
  const w = utilityProcess.fork(path.join(ROOT, ...def.script), [], {
    serviceName: def.name,
    stdio: 'pipe',
    env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true', ...(useGpu && gpu.installed() ? { VOX_GPU_DIR: gpu.dir } : {}) },
  });
  w._gpu = !!(useGpu && gpu.installed());
  log('Processus démarré :', def.name + (w._gpu ? ' (carte graphique)' : ''));
  w.stderr && w.stderr.on('data', (d) => { const t = String(d); if (!/control-looking token/.test(t)) log(`[${kind}]`, t.trim().slice(0, 1000)); });
  w.on('message', (msg) => {
    if (kind === 'file' && msg.type === 'done' && msg.jobId === w._job) recordPerf(w._jobModel, msg.result);
    if (kind === 'file' && ['done', 'cancelled', 'error'].includes(msg.type) && msg.jobId === w._job) { w._job = null; clearTimeout(cancelTimer); }
    if (kind === 'file' && msg.type === 'preloaded') { log(`Modèle préchargé : ${msg.model} (${msg.reused ? 'déjà en mémoire' : msg.ms + ' ms'})`); send('models:ready', { model: msg.model, selected: settings.model }); return; }
    if (kind === 'file' && msg.type === 'preload-failed') { log('Préchargement impossible :', msg.message); preloadedKey = null; return; }
    if (kind === 'live' && ['live-done', 'error'].includes(msg.type)) w._active = false;
    if (kind === 'ai' && ['done', 'cancelled', 'error'].includes(msg.type)) { w._jobs && w._jobs.delete(msg.id); clearTimeout(aiCancelTimers.get(msg.id)); aiCancelTimers.delete(msg.id); }
    if (kind === 'ai' && msg.type === 'done' && w._detect && w._detect.has(msg.id)) {
      const mp = w._detect.get(msg.id); w._detect.delete(msg.id);
      const c = msg.result && msg.result.calib;
      if (c && !(settings.ai.detectCalib || {})[mp]) { settings.ai.detectCalib = { ...(settings.ai.detectCalib || {}), [mp]: { ...c, v: 1 } }; saveSettings().catch(() => {}); }
    }
    if (msg.type === 'error') log(`[${kind}] erreur :`, msg.message);
    if (msg.type === 'log') { log(`[${kind}]`, msg.message); return; }
    send(def.channel, msg);
  });
  w.on('exit', (code) => {
    log('Processus arrêté :', def.name, 'code', code);
    if (kind === 'file' && workers[kind] === w) preloadedKey = null;
    if (workers[kind] === w) {
      workers[kind] = null;
      if (code !== 0 && !w._killedOnPurpose) {
        if (kind === 'ai') for (const id of (w._jobs || [])) send(def.channel, { type: 'error', id, message: `Le moteur IA s’est arrêté (code ${code}). Mémoire insuffisante ? Essayez un modèle plus petit ou désactivez la carte graphique dans les paramètres.` });
        else send(def.channel, { type: 'crash', code, jobId: w._job || 'live' });
      }
    }
  });
  workers[kind] = w;
  return w;
}
function killWorker(kind) {
  const w = workers[kind];
  if (!w) return;
  if (kind === 'file') preloadedKey = null;
  w._killedOnPurpose = true;
  // les tâches IA encore en cours sont signalées comme annulées (sinon l'interface les croit actives)
  if (kind === 'ai') for (const id of (w._jobs || [])) send('ai:event', { type: 'cancelled', id });
  try { w.kill(); } catch { /* */ }
  workers[kind] = null;
}

/**
 * Parakeet ne connaît que 25 langues européennes et ne traduit pas : dans ces cas,
 * on bascule automatiquement sur le meilleur modèle Whisper installé.
 */
function pickEngineModel(o) {
  const m = CATALOG.find((x) => x.id === o.model);
  if (!m || m.engine !== 'parakeet') return { id: o.model };
  const why = o.task === 'translate' ? 'la traduction vers l’anglais' : (o.language && !m.langs.includes(o.language)) ? 'cette langue' : '';
  if (!why) return { id: o.model };
  const fb = ['turbo', 'large-v3'].find((id) => models.isInstalled(id));
  if (!fb) throw new Error(`Parakeet ne gère pas ${why}. Installez « Large v3 Turbo » (onglet Modèles) pour ce fichier.`);
  return { id: fb, note: `Parakeet ne gère pas ${why} : transcription avec ${CATALOG.find((x) => x.id === fb).name}.` };
}
function engineOptions(o) {
  if (!o.model || !models.isInstalled(o.model)) throw new Error('Aucun modèle installé/sélectionné. Ouvrez l’onglet « Modèles ».');
  const pick = pickEngineModel(o);
  // Parakeet : modèle Whisper de vérification (le meilleur installé qui tient en mémoire avec Parakeet)
  let recheck, recheckId, langId;
  if (pick.id === 'parakeet' && settings.parakeetCheck !== false) {
    const gb = os.totalmem() / 1024 ** 3;
    // Parakeet (1,5 Go) + Whisper de vérification : il faut assez de mémoire pour les deux
    const order = gb >= 7.5 ? ['turbo', 'large-v3'] : gb >= 5.5 ? ['turbo'] : [];
    const chk = order.find((id) => models.isInstalled(id));
    if (chk) { recheck = modelPathsFor(chk); recheckId = chk; }
    // identification de la langue : le moteur décode les 10 premières secondes avec le modèle de vérification (Turbo / Large v3)
  }
  return {
    provider: gpuFor(pick.id) ? 'cuda' : 'cpu',
    checkerProvider: recheckId && gpuFor(recheckId) ? 'cuda' : 'cpu',
    recheck,
    recheckId,
    langId,
    parakeetLangs: (CATALOG.find((x) => x.id === 'parakeet') || {}).langs,
    recheckMode: 'names',
    note: pick.note,
    modelId: pick.id,
    ffmpeg: ffmpegPath(),
    vadModel: VAD_MODEL,
    model: modelPathsFor(pick.id),
    language: o.language || '',
    task: o.task || 'transcribe',
    lockLanguage: !o.multilingual,
    threads: settings.threads,
    vadThreshold: settings.vadThreshold,
    filterHallucinations: settings.filterHallucinations,
    dictionary: settings.dictionary || [],
  };
}

// ---------- Préchargement du modèle ----------
let preloadedKey = null;
function preloadModel(why) {
  try {
    if (settings.preload === false || SAFE_MODE) return;
    const id = settings.model;
    if (!id || !models.isInstalled(id)) return;
    if (workers.file && workers.file._job) return; // une transcription chargera le modèle elle-même
    // modèle réellement utilisé (Parakeet → Whisper si la langue / la traduction l'exige)
    const eo = engineOptions({ model: id, language: settings.language, task: settings.task, multilingual: settings.multilingual });
    const key = workerKey(eo);
    if (preloadedKey === key && workers.file && workers.file._model === key) return;
    // l'ancien modèle est libéré AVANT de mesurer la mémoire libre (sinon un gros modèle bloque le changement)
    if (workers.file && workers.file._model && workers.file._model !== key) { log(`Libération du modèle ${workers.file._model} (passage à ${key})`); killWorker('file'); }
    const m = CATALOG.find((x) => x.id === eo.modelId);
    const need = ((m && m.ramGB) || 1.5) * 1024 ** 3;
    if (os.freemem() < need * 1.25) { log(`Préchargement ignoré (${why}) : mémoire libre insuffisante`); return; }
    log(`Préchargement du modèle ${eo.modelId} (${why})`);
    freshWorkerFor(key).postMessage({ type: 'preload', model: eo.modelId, options: eo });
    preloadedKey = key;
  } catch (e) { log('Préchargement :', e.message); }
}
canal('models:preload', R.rien, () => { preloadModel('demande'); return true; });

/**
 * Changement de modèle : on redémarre le processus de transcription plutôt que de remplacer
 * le modèle « à chaud ». L'ancien modèle (jusqu'à 4 Go) est ainsi libéré immédiatement,
 * au lieu de cohabiter un moment avec le nouveau (risque de saturer la mémoire du PC).
 */
function freshWorkerFor(modelId) {
  const w = workers.file;
  if (w && !w._job && w._model && w._model !== modelId) { log(`Libération du modèle ${w._model} (passage à ${modelId})`); killWorker('file'); }
  const nw = getWorker('file', String(modelId).endsWith('|gpu'));
  nw._model = modelId;
  return nw;
}

/** Vitesse réelle mesurée sur ce PC (sert au conseiller de modèle). */
function recordPerf(model, r) {
  try {
    if (!model || !r || !r.duration || !r.elapsed || r.duration < 20 || r.engine === 'whisper') return;
    // vitesse de calcul pure (sans le chargement des modèles) : sinon un premier fichier court fausse le conseiller
    const rtf = r.duration / (r.computeElapsed || r.elapsed);
    const perf = { ...(settings.perf || {}) };
    const old = perf[model];
    const same = old && old.threads === settings.threads;
    perf[model] = { rtf: same ? +(old.rtf * 0.6 + rtf * 0.4).toFixed(3) : +rtf.toFixed(3), threads: settings.threads, n: same ? old.n + 1 : 1, at: Date.now() };
    settings = { ...settings, perf };
    saveSettings().catch(() => {});
    send('perf:update', perf);
  } catch { /* */ }
}

/** Vocabulaire du cours : liste générale + listes prêtes à l'emploi + vocabulaire du projet. */
async function vocabularyFor(projectId) {
  const terms = [...(settings.vocabulary || [])];
  for (const id of settings.vocabPacks || []) if (Vocab.PACKS[id]) terms.push(...Vocab.PACKS[id].terms);
  if (projectId) {
    try { const p = JSON.parse(await fsp.readFile(projFile(projectId), 'utf8')); terms.push(...(p.vocabulary || [])); } catch { /* projet supprimé */ }
  }
  return [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))];
}
canal('vocab:for', [{ type: 'string', max: 128, optionnel: true }], (e, projectId) => vocabularyFor(projectId));

canal('transcribe:start', [{ type: 'objet', champs: { jobId: R.id, file: R.chemin, options: R.json(200000) } }], async (e, { jobId, file, options }) => {
  if (gpuTesting) throw new Error('Test de la carte graphique en cours (quelques minutes) : relancez ensuite.');
  const eo = engineOptions(options); // erreur éventuelle avant de marquer le moteur comme occupé
  eo.vocabulary = await vocabularyFor(settings.queueProject);
  eo.removeEchoes = settings.removeEchoes !== false;
  const w = freshWorkerFor(workerKey(eo));
  w._job = jobId;
  w._jobModel = eo.modelId;
  if (eo.note) setTimeout(() => send('job:event', { type: 'status', jobId, message: eo.note, model: eo.modelId }), 50);
  w.postMessage({ type: 'transcribe', jobId, options: { ...eo, file } });
  return true;
});
let cancelTimer = null;
canal('transcribe:cancel', [R.id], (e, jobId) => {
  const w = workers.file;
  if (!w) { send('job:event', { type: 'cancelled', jobId, result: { segments: [] } }); return true; }
  // Arrêt propre : le moteur s'interrompt et garde le modèle en mémoire.
  // Si le moteur ne répond pas (phrase longue en cours de calcul), on le force après 2,5 s.
  w.postMessage({ type: 'cancel' });
  clearTimeout(cancelTimer);
  cancelTimer = setTimeout(() => {
    if (workers.file === w && w._job === jobId) {
      killWorker('file');
      send('job:event', { type: 'cancelled', jobId, result: { segments: [] } });
      setTimeout(() => preloadModel('après annulation'), 1500);
    }
  }, 2500);
  return true;
});

canal('live:start', [R.json(200000)], async (e, options) => {
  if (gpuTesting) throw new Error('Test de la carte graphique en cours (quelques minutes) : réessayez ensuite.');
  const eo = engineOptions(options);
  eo.vocabulary = await vocabularyFor(settings.queueProject);
  // le processus de dictée est conservé entre deux dictées (modèle chargé) ; changement de modèle → processus neuf
  const liveGpu = eo.provider === 'cuda';
  if (workers.live && ((workers.live._model && workers.live._model !== eo.modelId) || !!workers.live._gpu !== liveGpu)) killWorker('live');
  const w = getWorker('live', liveGpu);
  w._model = eo.modelId; w._active = true;
  w.postMessage({ type: 'live-start', options: eo });
  return { model: eo.modelId, note: eo.note };
});
canalEvenement('live:audio', [{ type: 'binaire', max: 16 * 1024 * 1024 }], (e, samples) => { const w = workers.live; if (w) w.postMessage({ type: 'live-audio', samples }); });
canal('live:stop', R.rien, () => { const w = workers.live; if (w) w.postMessage({ type: 'live-stop' }); return !!w; });
canal('live:abort', R.rien, () => { killWorker('live'); return true; });

// ---------- Paramètres / infos ----------
canal('system:profile', R.rien, () => {
  const cpus = os.cpus();
  return {
    cpuModel: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(), logical: cpus.length,
    totalMem: os.totalmem(), freeMem: os.freemem(), threads: settings.threads, perf: settings.perf || {},
  };
});
canal('app:info', R.rien, () => ({
  modelsDirError: global.__voxModelsDirError || null,
  version: app.getVersion(), platform: process.platform, cpus: os.cpus().length,
  totalMem: os.totalmem(), modelsDir: settings.modelsDir, userData: USER,
}));
canal('settings:get', R.rien, () => settingsPourInterface());
canal('settings:set', [R.json(2000000)], async (e, patch) => {
  const prevDir = settings.modelsDir;
  const prevAi = settings.ai;
  const prevGpu = settings.gpu;
  settings = { ...settings, ...patch };
  // customModels / hiddenModels sont gérés uniquement ici (jamais écrasés par une copie périmée de l'interface)
  // la clé d'API ne transite plus par les paramètres (coffre chiffré, canal secret:enregistrer)
  if (patch.ai) { const { apiKey, apiKeySet, ...pa } = patch.ai; settings.ai = { ...DEFAULT_AI, ...prevAi, ...pa, apiKey: prevAi.apiKey || '', customModels: prevAi.customModels || [], hiddenModels: prevAi.hiddenModels || [], detectCalib: prevAi.detectCalib || {} }; }
  // carte graphique : seul le choix « auto / off » vient de l'interface (les résultats des tests restent ceux du disque)
  if (patch.gpu) settings.gpu = { ...(prevGpu || {}), use: patch.gpu.use === 'off' ? 'off' : 'auto' };
  if (patch.modelsDir && patch.modelsDir !== prevDir) {
    try { models = new ModelManager(settings.modelsDir, (u, init) => net.fetch(u, init)); llms = makeLlm(); if (!gpu.ctrl) gpu = makeGpu(); }
    catch (e) { settings.modelsDir = prevDir; throw new Error('Dossier inutilisable : ' + e.message); } // jamais enregistré s'il ne marche pas
  }
  if ('theme' in patch && win) { try { win.setTitleBarOverlay(overlayColors()); win.setBackgroundColor(overlayColors().color); } catch { /* */ } }
  await saveSettings();
  // la langue / la tâche peuvent changer le modèle réellement utilisé (Parakeet → Whisper)
  if (patch.gpu && (prevGpu || {}).use !== settings.gpu.use) { if (workers.file && !workers.file._job) killWorker('file'); if (workers.live && !workers.live._active) killWorker('live'); }
  if ('model' in patch || 'threads' in patch || 'language' in patch || 'task' in patch || patch.preload === true || patch.gpu) setTimeout(() => preloadModel('changement de réglage'), 300);
  if (patch.preload === false && workers.file && !workers.file._job) killWorker('file'); // libère la mémoire
  return settingsPourInterface();
});
canal('settings:titlebar', [{ type: 'objet', champs: { color: { type: 'string', max: 9, optionnel: true }, symbolColor: { type: 'string', max: 9, optionnel: true } } }], (e, colors) => { try { win.setTitleBarOverlay({ ...colors, height: 40 }); } catch { /* */ } });

// ---------- Modèles ----------
canal('models:list', R.rien, () => models.list());
canal('models:install', [R.id], async (e, id) => {
  try {
    await models.install(id, (p) => send('models:progress', p));
    // pack carte graphique présent : le nouveau modèle est testé aussi (utilisé seulement s'il va plus vite)
    if (gpu.installed() && (settings.gpu || {}).use !== 'off' && !(workers.file && workers.file._job)) setTimeout(() => testGpu([id]).catch(() => {}), 2000);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
canal('models:cancel', [R.id], (e, id) => models.cancel(id));
canal('models:remove', [R.id], async (e, id) => {
  if (!CATALOG.some((m) => m.id === id)) throw new Error('Modèle inconnu : ' + id);
  const uses = (w) => !!(w && w._model && String(w._model).split('|')[0] === id);
  if (workers.file && workers.file._job) throw new Error('Une transcription est en cours.');
  if (workers.live && workers.live._active && uses(workers.live)) throw new Error('Arrêtez d’abord la dictée en cours.');
  // libère le modèle gardé en mémoire avant de supprimer ses fichiers (sinon verrouillés sous Windows)
  if (uses(workers.file)) killWorker('file');
  if (uses(workers.live)) killWorker('live');
  await models.remove(id);
  await gpu.removeVariant(id).catch(() => {}); // version carte graphique du même modèle
  setTimeout(() => preloadModel('après suppression'), 300);
  return true;
});
canal('models:openDir', R.rien, () => shell.openPath(settings.modelsDir));
canal('models:chooseDir', R.rien, async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Dossier des modèles', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// ---------- Fichiers ----------
const MEDIA_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr', 'webm', 'mp4', 'mkv', 'mov', 'avi', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'caf', 'ac3', 'mka', 'flv'];
canal('dialog:openFiles', R.rien, async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir des fichiers audio ou vidéo',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio & vidéo', extensions: MEDIA_EXT }, { name: 'Tous les fichiers', extensions: ['*'] }],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(fileInfo));
});
async function fileInfo(p) {
  const st = await fsp.stat(p);
  return { path: p, name: path.basename(p), size: st.size, ext: path.extname(p).slice(1).toLowerCase() };
}
/** Fichiers déposés : les dossiers sont parcourus (sous-dossiers inclus) pour y trouver l'audio/vidéo. */
async function collectMedia(paths, out = [], depth = 0) {
  for (const p of paths) {
    if (out.length >= 2000) break;
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) {
        if (depth === 0 || MEDIA_EXT.includes(path.extname(p).slice(1).toLowerCase())) out.push(await fileInfo(p));
      } else if (st.isDirectory() && depth < 6) {
        const entries = (await fsp.readdir(p)).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
        await collectMedia(entries.map((n) => path.join(p, n)), out, depth + 1);
      }
    } catch { /* inaccessible : ignoré */ }
  }
  return out;
}
canal('file:info', [R.chemins], (e, paths) => collectMedia(paths));
canal('dialog:openFolder', R.rien, async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choisir un dossier à transcrire', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return [];
  return collectMedia(r.filePaths, [], 1);
});
canal('file:exists', [R.chemin], (e, p) => fs.existsSync(p));

// ---------- Textes importés (cours rédigés, notes, articles, sous-titres…) ----------
canal('text:exts', R.rien, () => TEXT_EXT);
canal('text:pick', R.rien, async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir des fichiers texte',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Textes', extensions: TEXT_EXT }, { name: 'Tous les fichiers', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
/** Importe chaque fichier dans l'historique (source « text ») ; renvoie les entrées créées et les erreurs. */
canal('text:import', [R.chemins], async (e, paths) => {
  const { guessLang } = require('../engine/engine');
  const done = []; const errors = [];
  for (const file of paths || []) {
    try {
      const r = await importText(file);
      const text = r.segments.map((x) => x.text).join(' ');
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: r.title, file, source: 'text', textKind: r.kind, estimatedTimes: r.estimated,
        createdAt: new Date().toISOString(), duration: r.segments[r.segments.length - 1].end,
        language: guessLang(text.slice(0, 6000)) || '', model: 'Texte importé', task: 'transcribe', elapsed: 0,
        segments: r.segments, translations: {}, summary: null, transforms: {},
      };
      await withFileLock(histFile(entry.id), () => writeHistory(entry));
      if (settings.queueProject) { try { await updateProject(settings.queueProject, (p) => { p.items = [...(p.items || []), entry.id]; }); } catch { /* */ } }
      done.push({ id: entry.id, name: entry.name, words: text.split(/\s+/).filter(Boolean).length, kind: r.kind });
      log(`Texte importé : ${path.basename(file)} (${r.kind}, ${r.segments.length} phrases)`);
    } catch (err) {
      errors.push({ file: path.basename(file), message: err.message });
      log('Import de texte impossible', file, err.message);
    }
  }
  return { done, errors };
});

// ---------- Questions sur tous les cours ----------
let knowledge = null;
canal('qa:search', [{ type: 'objet', champs: { query: R.texte(2000), scope: R.json(20000) } }], async (e, { query, scope }) => {
  if (!knowledge) knowledge = new Knowledge(HISTORY_DIR);
  let ids = null; let source = null;
  if (scope && scope.startsWith('project:')) {
    try { ids = JSON.parse(await fsp.readFile(projFile(scope.slice(8)), 'utf8')).items || []; } catch { ids = []; }
  } else if (scope === 'text' || scope === 'audio') source = scope;
  return knowledge.search(query, { ids, source, limit: 10 });
});

/** Prépare une version lisible par le lecteur intégré pour les formats non pris en charge par Chromium. */
const previewCache = new Map();
canal('media:preview', [R.chemin], async (e, file) => {
  if (previewCache.has(file) && fs.existsSync(previewCache.get(file))) return previewCache.get(file);
  const out = path.join(PREVIEW_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.webm`);
  await new Promise((resolve, reject) => {
    // stderr ignoré (sinon le tuyau se remplit et ffmpeg se bloque) + délai maximal
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', out], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, 10 * 60 * 1000);
    p.on('error', (err) => { clearTimeout(timer); reject(err); });
    p.on('close', (c) => { clearTimeout(timer); c === 0 ? resolve() : reject(new Error('Conversion impossible')); });
  });
  previewCache.set(file, out);
  return out;
});

/** Forme d'onde : amplitude maximale par tranche (perSec tranches par seconde), quantifiée sur 0..255. */
const peaksCache = new Map();
canal('media:peaks', [R.chemin, { type: 'number', min: 1, max: 1000, optionnel: true }], async (e, file, perSec = 50) => {
  const st = await fsp.stat(file);
  const key = `${file}|${st.mtimeMs}|${perSec}`;
  if (peaksCache.has(key)) return peaksCache.get(key);
  const rate = 8000; const win = Math.round(rate / perSec);
  const out = [];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, 10 * 60 * 1000);
    p.on('close', () => clearTimeout(timer));
    let carry = Buffer.alloc(0); let n = 0; let peak = 0;
    p.stdout.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > peak) peak = v;
        if (++n === win) { out.push(peak); n = 0; peak = 0; }
      }
      carry = buf.subarray(usable);
    });
    p.on('error', reject);
    p.on('close', (c) => { if (n) out.push(peak); c === 0 || out.length ? resolve() : reject(new Error('Lecture audio impossible')); });
  });
  // normalisation douce (racine) pour bien voir les passages calmes
  let max = 1; for (const v of out) if (v > max) max = v;
  const q = Buffer.from(out.map((v) => Math.round(Math.sqrt(v / max) * 255)));
  const res = { perSec, data: q.toString('base64'), length: q.length };
  if (peaksCache.size > 6) peaksCache.delete(peaksCache.keys().next().value);
  peaksCache.set(key, res);
  return res;
});
canal('recording:save', [{ type: 'objet', champs: { data: { type: 'binaire', max: 2 * 1024 ** 3 }, ext: { type: 'string', max: 8 } } }], async (e, { data, ext }) => {
  ext = /^[a-z0-9]{1,5}$/i.test(String(ext || '')) ? ext : 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const p = path.join(RECORD_DIR, `enregistrement-${stamp}.${ext || 'webm'}`);
  await fsp.writeFile(p, Buffer.from(data));
  return fileInfo(p);
});

canal('export:save', [{ type: 'objet', champs: { content: R.texte(200 * 1024 * 1024), defaultName: { type: 'string', max: 300, optionnel: true }, format: { type: 'string', max: 16, optionnel: true } } }], async (e, { content, defaultName, format }) => {
  const filters = {
    txt: [{ name: 'Texte', extensions: ['txt'] }], srt: [{ name: 'Sous-titres SRT', extensions: ['srt'] }],
    vtt: [{ name: 'WebVTT', extensions: ['vtt'] }], json: [{ name: 'JSON', extensions: ['json'] }],
    md: [{ name: 'Markdown', extensions: ['md'] }], csv: [{ name: 'CSV', extensions: ['csv'] }],
    html: [{ name: 'Page HTML', extensions: ['html'] }],
  }[format] || [];
  const r = await dialog.showSaveDialog(win, { title: 'Exporter la transcription', defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  const bom = format === 'csv' ? '﻿' : '';
  await fsp.writeFile(r.filePath, bom + content, 'utf8');
  return r.filePath;
});

canal('export:doc', [{ type: 'objet', champs: { format: { type: 'enum', valeurs: ['docx', 'pdf', 'html', 'md'] }, markdown: R.texte(50 * 1024 * 1024), title: { type: 'string', max: 500, optionnel: true }, defaultName: { type: 'string', max: 300, optionnel: true } } }], async (e, { format, markdown, title, defaultName }) => {
  const isPdf = format === 'pdf';
  const r = await dialog.showSaveDialog(win, {
    title: isPdf ? 'Exporter en PDF' : 'Exporter en Word',
    defaultPath: defaultName,
    filters: [isPdf ? { name: 'Document PDF', extensions: ['pdf'] } : { name: 'Document Word', extensions: ['docx'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const { toDocx, toPdf } = require('./docexport');
  const accent = settings.accent || '#7c5cff';
  const buf = isPdf ? await toPdf({ markdown, title, accent }) : await toDocx({ markdown, title, accent });
  await fsp.writeFile(r.filePath, buf);
  log('Export', format, r.filePath);
  return r.filePath;
});
canal('shell:showItem', [R.chemin], (e, p) => shell.showItemInFolder(p));
canal('app:openLogs', R.rien, () => shell.openPath(LOG_DIR));
canalEvenement('app:log', [R.texte(5000)], (e, msg) => log('[interface]', String(msg).slice(0, 2000)));
canal('shell:openExternal', [R.texte(2048)], (e, url) => { if (urlExterneAutorisee(url)) shell.openExternal(url); });

// ---------- Intelligence artificielle (résumé & traduction) ----------
async function aiProviderConfig() {
  const a = settings.ai;
  if (a.provider === 'openai') return { kind: 'openai', baseUrl: a.baseUrl, apiKey: cleApi(), model: a.remoteModel };
  const modelPath = (await llms.resolvePath(a.localModel)) || ((await llms.list()).find((m) => m.installed) || {}).path;
  if (!modelPath) throw new Error('Aucun modèle IA installé. Ouvrez l’onglet « Modèles » › « Modèles IA » pour en télécharger un.');
  return { kind: 'local', modelPath, gpu: a.gpu, threads: settings.threads, parallel: a.parallel === 'off' ? 1 : 0 };
}
const aiCancelTimers = new Map(); // id -> minuteur d'arrêt forcé
canal('ai:run', [{ type: 'objet', champs: { id: R.id, task: { type: 'enum', valeurs: ['translate', 'summarize', 'summarizeMany', 'transform', 'cleanup', 'qa', 'aidetect'] }, payload: R.json(50 * 1024 * 1024) } }], async (e, { id, task, payload }) => {
  const provider = await aiProviderConfig();
  if (provider.kind === 'local') {
    // le modèle de langage local a besoin de beaucoup de mémoire : on libère le modèle de transcription
    // s'il ne travaille pas (il sera rechargé à la prochaine transcription)
    const fw = workers.file;
    if (fw && !fw._job) { log(`Libération du modèle ${fw._model || 'de transcription'} pour l’IA`); killWorker('file'); }
    log(`[ai] tâche ${task} · mémoire libre ${(os.freemem() / 1024 ** 3).toFixed(1)} / ${(os.totalmem() / 1024 ** 3).toFixed(1)} Go`);
  }
  const w = getWorker('ai');
  (w._jobs = w._jobs || new Set()).add(id);
  if (task === 'aidetect' && provider.kind === 'local') {
    // étalonnage de la détection d'origine IA, propre à chaque modèle
    const calib = (settings.ai.detectCalib || {})[provider.modelPath];
    payload = { ...payload, calib: calib && calib.v === 1 ? calib : null };
    (w._detect = w._detect || new Map()).set(id, provider.modelPath);
  }
  w.postMessage({ type: 'run', id, task, provider, payload });
  return true;
});
canal('ai:cancel', [R.id], (e, id) => {
  const w = workers.ai;
  if (!w) return false;
  w.postMessage({ type: 'cancel', id });
  clearTimeout(aiCancelTimers.get(id));
  aiCancelTimers.set(id, setTimeout(() => {
    aiCancelTimers.delete(id);
    if (workers.ai === w && w._jobs && w._jobs.has(id)) killWorker('ai');
  }, 5000));
  return true;
});
// changement de réglage IA : le modèle est libéré dès que les tâches en cours sont terminées
canal('ai:unload', R.rien, () => { if (workers.ai) workers.ai.postMessage({ type: 'unload' }); return true; });

canal('llm:list', R.rien, async () => {
  const list = await llms.list();
  let vram = 0;
  try { const d = await gpu.detect(); vram = d && d.found ? d.vramMB || 0 : 0; } catch { /* pas de carte NVIDIA */ }
  return LlmModels.withRecommendation(list, vram);
});
canal('llm:install', [R.id], async (e, id) => {
  try { await llms.install(id, (p) => send('llm:progress', p)); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
});
canal('llm:cancel', [R.idModele], (e, id) => llms.cancel(id));
canal('llm:remove', [R.idModele], async (e, id) => {
  if (workers.ai) killWorker('ai'); // libère le fichier avant suppression
  await llms.remove(id);
  if (settings.ai.localModel === id) { settings.ai.localModel = ''; await saveSettings(); }
  return true;
});
canal('llm:import', R.rien, async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importer un modèle de langage (.gguf)', properties: ['openFile'], filters: [{ name: 'Modèle GGUF', extensions: ['gguf'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const fd = await fsp.open(r.filePaths[0], 'r'); const head = Buffer.alloc(4); await fd.read(head, 0, 4, 0); await fd.close();
  if (head.toString('ascii') !== 'GGUF') throw new Error('Ce fichier n’est pas un modèle GGUF valide.');
  return llms.addCustom(r.filePaths[0]);
});
canal('llm:remoteModels', [{ type: 'objet', champs: { baseUrl: R.texte(500) } }], async (e, { baseUrl }) => {
  const { listRemoteModels } = require('../ai/providers');
  return listRemoteModels(baseUrl, cleApi());
});
canal('secret:enregistrer', [{ type: 'string', max: 64, motif: /^[a-z][a-z0-9_]{0,63}$/ }, { type: 'string', max: 4096 }], (e, nom, valeur) => { secrets.enregistrer(nom, valeur.trim()); return true; });
canal('secret:existe', [{ type: 'string', max: 64, motif: /^[a-z][a-z0-9_]{0,63}$/ }], (e, nom) => secrets.existe(nom));

// ---------- Historique ----------
const histFile = (id) => path.join(HISTORY_DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);
// Index en mémoire (évite de relire chaque transcription complète à chaque affichage)
const histIndex = new Map(); // fichier -> { mtimeMs, item }
const META_KEYS = ['folder', 'tags', 'favorite'];
function historySummary(h) {
  const text = (h.segments || []).map((s) => s.text).join(' ');
  return {
    id: h.id, name: h.name, file: h.file, createdAt: h.createdAt, duration: h.duration, language: h.language, languages: h.languages,
    model: h.model, task: h.task, source: h.source, preview: text.slice(0, 220), words: text.split(/\s+/).filter(Boolean).length,
    folder: h.folder || '', tags: Array.isArray(h.tags) ? h.tags : [], favorite: !!h.favorite,
    hasSummary: !!h.summary, translations: Object.keys(h.translations || {}), transforms: Object.keys(h.transforms || {}),
    text, // pour la recherche plein texte (reste dans le processus principal)
  };
}
async function readHistory(id) { return JSON.parse(await fsp.readFile(histFile(id), 'utf8')); }
const writeHistory = (entry) => writeJsonAtomic(histFile(entry.id), entry);
canal('history:list', R.rien, async () => {
  const out = [];
  const files = (await fsp.readdir(HISTORY_DIR)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const p = path.join(HISTORY_DIR, f);
    try {
      const st = await fsp.stat(p);
      const c = histIndex.get(f);
      if (c && c.mtimeMs === st.mtimeMs) { out.push(c.light); continue; }
      const item = historySummary(JSON.parse(await fsp.readFile(p, 'utf8')));
      const { text, ...light } = item; // le texte complet n'est pas envoyé à l'interface
      histIndex.set(f, { mtimeMs: st.mtimeMs, item, light });
      out.push(light);
    } catch { /* fichier corrompu ignoré */ }
  }
  for (const k of histIndex.keys()) if (!files.includes(k)) histIndex.delete(k);
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
});
canal('history:get', [R.id], (e, id) => readHistory(id));
/** Recherche plein texte côté processus principal : renvoie les ids correspondants. */
canal('history:search', [R.texte(500)], (e, q) => {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return null;
  const ids = [];
  for (const { item } of histIndex.values()) if (`${item.name} ${(item.tags || []).join(' ')} ${item.text}`.toLowerCase().includes(needle)) ids.push(item.id);
  return ids;
});
canal('history:save', [R.json(100 * 1024 * 1024)], (e, entry) => withFileLock(histFile(entry.id), async () => {
  try {
    const old = await readHistory(entry.id);
    // dossier / étiquettes / favori ne changent que par history:update : la version du disque fait foi
    for (const k of META_KEYS) if (old[k] !== undefined) entry[k] = old[k];
    // résultats IA : fusion (une copie périmée de l'interface ne doit pas effacer une traduction ou un document)
    for (const k of ['translations', 'transforms']) entry[k] = { ...(old[k] || {}), ...(entry[k] || {}) };
    if (!entry.summary && old.summary) entry.summary = old.summary;
    if (!entry.aiOrigin && old.aiOrigin) entry.aiOrigin = old.aiOrigin;
  } catch { /* nouvelle entrée */ }
  await writeHistory(entry);
  return true;
}));
canal('history:update', [R.id, R.json(1024 * 1024)], (e, id, patch) => withFileLock(histFile(id), async () => {
  const h = await readHistory(id);
  for (const k of [...META_KEYS, 'name']) if (k in patch) h[k] = patch[k];
  await writeHistory(h);
  const item = historySummary(h); delete item.text;
  return item;
}));
canal('history:delete', [R.id], async (e, id) => {
  await fsp.rm(histFile(id), { force: true });
  await removeFromProjects([id]);
  return true;
});
canal('history:clear', R.rien, async () => {
  const ids = [];
  for (const f of await fsp.readdir(HISTORY_DIR)) if (f.endsWith('.json')) { ids.push(f.slice(0, -5)); await fsp.rm(path.join(HISTORY_DIR, f), { force: true }); }
  await removeFromProjects(ids);
  return true;
});

// ---------- Projets (regroupements de plusieurs transcriptions) ----------
const PROJECTS_DIR = path.join(USER, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const projFile = (id) => path.join(PROJECTS_DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);
async function listProjects() {
  const out = [];
  for (const f of await fsp.readdir(PROJECTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fsp.readFile(path.join(PROJECTS_DIR, f), 'utf8'))); } catch { /* */ }
  }
  return out.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}
async function saveProjectRaw(p) {
  p.updatedAt = new Date().toISOString();
  await writeJsonAtomic(projFile(p.id), p);
  return p;
}
const saveProject = (p) => withFileLock(projFile(p.id), () => saveProjectRaw(p));
/** Lire-modifier-écrire protégé (deux ajouts simultanés ne s'écrasent plus). */
const updateProject = (id, fn) => withFileLock(projFile(id), async () => {
  const p = JSON.parse(await fsp.readFile(projFile(id), 'utf8'));
  return saveProjectRaw((await fn(p)) || p);
});
async function removeFromProjects(ids) {
  for (const p of await listProjects()) {
    if ((p.items || []).some((x) => ids.includes(x))) await updateProject(p.id, (q) => { q.items = (q.items || []).filter((x) => !ids.includes(x)); });
  }
}
canal('projects:list', R.rien, () => listProjects());
canal('projects:get', [R.id], async (e, id) => JSON.parse(await fsp.readFile(projFile(id), 'utf8')));
canal('projects:save', [R.json(2 * 1024 * 1024)], (e, p) => saveProject(p));
canal('projects:delete', [R.id], async (e, id) => { await fsp.rm(projFile(id), { force: true }); return true; });
canal('projects:addItems', [R.id, { type: 'liste', element: R.id, max: 10000 }], (e, id, ids) => updateProject(id, (p) => { p.items = [...(p.items || []), ...ids.filter((x) => !(p.items || []).includes(x))]; }));
