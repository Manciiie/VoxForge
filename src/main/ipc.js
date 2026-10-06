'use strict';
// Liste blanche des canaux IPC. Chaque canal déclare le schéma de ses arguments ;
// tout appel non conforme ou venant d'une autre page est refusé.
// Pour un nouveau module : déclarer ses canaux avec `canal(nom, schema, fonction)`
// (appel avec réponse) ou `canalEvenement(nom, schema, fonction)` (envoi sans réponse),
// puis les ajouter à la liste blanche du preload. tests/securite/ipc.test.js vérifie la cohérence.

const { ipcMain } = require('electron');
const { validerArguments, ErreurSecurite } = require('./securite');

const CANAUX = new Map();
let journal = { avertissement: (...m) => console.warn(...m) };

/** Journal utilisé pour tracer les appels refusés (main.js fournit le sien). */
function definirJournal(j) { journal = j; }

function expediteurAutorise(event) {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith('file://') && url.includes('/src/renderer/');
}

function verifier(nom, schema, event, args) {
  if (!expediteurAutorise(event)) {
    journal.avertissement(`IPC refusé (expéditeur inconnu) sur ${nom}`);
    throw new ErreurSecurite('Appel refusé.');
  }
  try {
    validerArguments(schema, args);
  } catch (e) {
    journal.avertissement(`IPC refusé sur ${nom} : ${e.message}`);
    throw e;
  }
}

/** Canal avec réponse (ipcRenderer.invoke). */
function canal(nom, schema, fonction) {
  if (CANAUX.has(nom)) throw new Error(`Canal IPC déjà déclaré : ${nom}`);
  CANAUX.set(nom, schema);
  ipcMain.handle(nom, async (event, ...args) => {
    verifier(nom, schema, event, args);
    return fonction(event, ...args);
  });
}

/** Canal sans réponse (ipcRenderer.send) : flux audio, journal de l'interface. */
function canalEvenement(nom, schema, fonction) {
  if (CANAUX.has(nom)) throw new Error(`Canal IPC déjà déclaré : ${nom}`);
  CANAUX.set(nom, schema);
  ipcMain.on(nom, (event, ...args) => {
    try { verifier(nom, schema, event, args); } catch { return; } // un envoi refusé est simplement ignoré
    fonction(event, ...args);
  });
}

// Règles réutilisables
const R = {
  rien: [],
  // identifiant interne (historique, projet, modèle) : jamais un chemin
  id: { type: 'string', max: 128, motif: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ },
  // identifiant de modèle IA : catalogue, ou « custom:<chemin> » / « lms:<chemin> » (le chemin n'est utilisé que comme clé)
  idModele: { type: 'string', max: 1100, motif: /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|(?:custom|lms):.{1,1000})$/ },
  chemin: { type: 'chemin' },
  chemins: { type: 'liste', element: { type: 'chemin' }, max: 5000 },
  texte: (max) => ({ type: 'string', max }),
  json: (max) => ({ type: 'json', max }),
};

module.exports = { canal, canalEvenement, definirJournal, canauxDeclares: () => [...CANAUX.keys()], R };
