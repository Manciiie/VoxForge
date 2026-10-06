'use strict';
// Preload en mode sandbox : l'interface ne reçoit jamais ipcRenderer, seulement des fonctions précises.
// Chaque canal doit figurer dans la liste blanche ci-dessous ET être déclaré côté principal
// avec `canal()` / `canalEvenement()` (cohérence vérifiée par tests/securite/ipc.test.js).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Appels avec réponse (ipcRenderer.invoke)
const CANAUX = [
  'ai:cancel',
  'ai:run',
  'ai:unload',
  'app:info',
  'app:openLogs',
  'dialog:openFiles',
  'dialog:openFolder',
  'export:doc',
  'export:save',
  'file:exists',
  'file:info',
  'gpu:cancel',
  'gpu:install',
  'gpu:installModel',
  'gpu:remove',
  'gpu:removeModel',
  'gpu:status',
  'gpu:test',
  'history:clear',
  'history:delete',
  'history:get',
  'history:list',
  'history:save',
  'history:search',
  'history:update',
  'live:abort',
  'live:start',
  'live:stop',
  'llm:cancel',
  'llm:import',
  'llm:install',
  'llm:list',
  'llm:remoteModels',
  'llm:remove',
  'media:peaks',
  'media:preview',
  'models:cancel',
  'models:chooseDir',
  'models:install',
  'models:list',
  'models:openDir',
  'models:preload',
  'models:remove',
  'projects:addItems',
  'projects:delete',
  'projects:get',
  'projects:list',
  'projects:save',
  'qa:search',
  'recording:save',
  'settings:get',
  'settings:set',
  'settings:titlebar',
  'shell:openExternal',
  'shell:showItem',
  'system:profile',
  'text:exts',
  'text:import',
  'text:pick',
  'transcribe:cancel',
  'transcribe:start',
  'vocab:for',
  'secret:enregistrer',
  'secret:existe',
  'maj:etat',
  'maj:verifier',
  'maj:telecharger',
  'maj:installer',
  'maj:ignorer',
];
// Envois sans réponse (ipcRenderer.send)
const ENVOIS = [
  'app:log',
  'live:audio',
];
// Événements reçus du processus principal (lecture seule)
const EVENEMENTS = [
  'ai:event',
  'gpu:progress',
  'job:event',
  'live:event',
  'llm:progress',
  'models:progress',
  'models:ready',
  'perf:update',
  'maj:changement',
];

const appeler = (canal, ...args) => (CANAUX.includes(canal) ? ipcRenderer.invoke(canal, ...args) : Promise.reject(new Error(`Canal non autorisé : ${canal}`)));
const envoyer = (canal, ...args) => { if (ENVOIS.includes(canal)) ipcRenderer.send(canal, ...args); };
const on = (ch) => (fn) => {
  if (!EVENEMENTS.includes(ch) || typeof fn !== 'function') return () => {};
  const h = (e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h); // désabonnement : pas de fuite d'écouteurs
};

window.addEventListener('error', (e) => envoyer('app:log', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => envoyer('app:log', 'Promesse rejetée : ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

contextBridge.exposeInMainWorld('vox', {
  info: () => appeler('app:info'),
  log: (m) => envoyer('app:log', m),
  openLogs: () => appeler('app:openLogs'),
  settings: {
    get: () => appeler('settings:get'),
    set: (patch) => appeler('settings:set', patch),
    titlebar: (colors) => appeler('settings:titlebar', colors),
  },
  models: {
    list: () => appeler('models:list'),
    install: (id) => appeler('models:install', id),
    cancel: (id) => appeler('models:cancel', id),
    remove: (id) => appeler('models:remove', id),
    openDir: () => appeler('models:openDir'),
    chooseDir: () => appeler('models:chooseDir'),
    onProgress: on('models:progress'),
    preload: () => appeler('models:preload'),
    onReady: on('models:ready'),
  },
  system: {
    profile: () => appeler('system:profile'),
    onPerf: on('perf:update'),
  },
  files: {
    open: () => appeler('dialog:openFiles'),
    openFolder: () => appeler('dialog:openFolder'),
    info: (paths) => appeler('file:info', paths),
    exists: (p) => appeler('file:exists', p),
    pathOf: (file) => webUtils.getPathForFile(file),
    preview: (p) => appeler('media:preview', p),
    saveRecording: (data, ext) => appeler('recording:save', { data, ext }),
    exportSave: (opts) => appeler('export:save', opts),
    exportDoc: (opts) => appeler('export:doc', opts),
    peaks: (p, perSec) => appeler('media:peaks', p, perSec),
    showItem: (p) => appeler('shell:showItem', p),
    openExternal: (u) => appeler('shell:openExternal', u),
  },
  transcribe: {
    start: (jobId, file, options) => appeler('transcribe:start', { jobId, file, options }),
    cancel: (jobId) => appeler('transcribe:cancel', jobId),
    onEvent: on('job:event'),
  },
  live: {
    start: (options) => appeler('live:start', options),
    audio: (samples) => envoyer('live:audio', samples),
    stop: () => appeler('live:stop'),
    abort: () => appeler('live:abort'),
    onEvent: on('live:event'),
  },
  ai: {
    run: (id, task, payload) => appeler('ai:run', { id, task, payload }),
    cancel: (id) => appeler('ai:cancel', id),
    unload: () => appeler('ai:unload'),
    onEvent: on('ai:event'),
  },
  llm: {
    list: () => appeler('llm:list'),
    install: (id) => appeler('llm:install', id),
    cancel: (id) => appeler('llm:cancel', id),
    remove: (id) => appeler('llm:remove', id),
    import: () => appeler('llm:import'),
    remoteModels: (baseUrl) => appeler('llm:remoteModels', { baseUrl }),
    onProgress: on('llm:progress'),
  },
  history: {
    list: () => appeler('history:list'),
    get: (id) => appeler('history:get', id),
    save: (entry) => appeler('history:save', entry),
    remove: (id) => appeler('history:delete', id),
    clear: () => appeler('history:clear'),
    update: (id, patch) => appeler('history:update', id, patch),
    search: (q) => appeler('history:search', q),
  },
  text: {
    exts: () => appeler('text:exts'),
    pick: () => appeler('text:pick'),
    import: (paths) => appeler('text:import', paths),
  },
  qa: { search: (query, scope) => appeler('qa:search', { query, scope }) },
  vocab: { for: (projectId) => appeler('vocab:for', projectId) },
  gpu: {
    status: () => appeler('gpu:status'),
    install: () => appeler('gpu:install'),
    cancel: () => appeler('gpu:cancel'),
    remove: () => appeler('gpu:remove'),
    test: () => appeler('gpu:test'),
    installModel: (id) => appeler('gpu:installModel', id),
    removeModel: (id) => appeler('gpu:removeModel', id),
    onProgress: on('gpu:progress'),
  },
  secrets: {
    enregistrer: (nom, valeur) => appeler('secret:enregistrer', nom, valeur),
    existe: (nom) => appeler('secret:existe', nom),
  },
  majs: {
    etat: () => appeler('maj:etat'),
    verifier: () => appeler('maj:verifier'),
    telecharger: () => appeler('maj:telecharger'),
    installer: () => appeler('maj:installer'),
    ignorer: () => appeler('maj:ignorer'),
    surChangement: on('maj:changement'),
  },
  projects: {
    list: () => appeler('projects:list'),
    get: (id) => appeler('projects:get', id),
    save: (p) => appeler('projects:save', p),
    remove: (id) => appeler('projects:delete', id),
    addItems: (id, ids) => appeler('projects:addItems', id, ids),
  },
});
