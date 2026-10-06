'use strict';
// Mises à jour automatiques depuis un dépôt GitHub privé dédié aux installeurs
// (<Nom>-releases), lu avec un jeton en LECTURE SEULE sur ce seul dépôt.
//
// Déroulé : vérification discrète au démarrage -> si une version plus récente existe,
// l'interface demande avant de télécharger -> téléchargement avec progression ->
// vérification SHA-512 (faite par electron-updater d'après latest.yml) -> « Redémarrer
// maintenant » ou installation à la fermeture.
//
// Le jeton vient de maj-config.json, généré au build par scripts/configurer-maj.js
// (jamais écrit à la main dans le code, jamais envoyé à l'interface ni aux journaux).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { canal } = require('./ipc');

// fournis par main.js au démarrage (journal et paramètres de VoxForge)
let journal = { info: () => {}, avertissement: () => {}, erreur: () => {}, declarerSecret: () => {} };
let parametres = { lire: () => ({ verifierMajAuDemarrage: true, versionIgnoree: null }), modifier: () => {} };
const { notesEnTexte, messageErreur } = require('./maj-outils');

const DELAI_DEMARRAGE = 4000;

let autoUpdater = null;
let etat = { etat: 'inactif' };
let verificationManuelle = false;

function diffuser(nouvelEtat) {
  etat = { versionActuelle: app.getVersion(), ...nouvelEtat };
  for (const f of BrowserWindow.getAllWindows()) {
    if (!f.isDestroyed()) f.webContents.send('maj:changement', etat);
  }
}

function lireConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'maj-config.json'), 'utf8'));
    if (c && c.proprietaire && c.depot && c.jeton) return c;
  } catch { /* absent : mises à jour non configurées */ }
  return null;
}

function configurer() {
  // Adresse de test (faux serveur local) : uniquement hors version compilée.
  const urlTest = !app.isPackaged ? process.env.FORGE_TEST_MAJ_URL : null;
  const config = lireConfig();
  if (!urlTest && !config) {
    diffuser({ etat: 'non-configure', message: 'Mises à jour non configurées dans cette version.' });
    return false;
  }

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;          // on demande toujours avant de télécharger
  autoUpdater.autoInstallOnAppQuit = true;   // une fois téléchargée, installée à la fermeture
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (m) => journal.info('[MAJ]', m),
    warn: (m) => journal.avertissement('[MAJ]', m),
    error: (m) => journal.erreur('[MAJ]', m),
    debug: () => {},
  };

  if (urlTest) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: urlTest });
  } else {
    journal.declarerSecret(config.jeton); // masqué si jamais il apparaît dans un message
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: config.proprietaire,
      repo: config.depot,
      private: true,
      token: config.jeton,
    });
  }

  autoUpdater.on('checking-for-update', () => diffuser({ etat: 'verification' }));
  autoUpdater.on('update-not-available', () => diffuser({ etat: 'a-jour', manuel: verificationManuelle }));
  autoUpdater.on('update-available', (info) => {
    const ignoree = parametres.lire().versionIgnoree === info.version;
    if (ignoree && !verificationManuelle) {
      journal.info(`[MAJ] Version ${info.version} disponible mais ignorée par l'utilisateur.`);
      diffuser({ etat: 'ignoree', version: info.version });
      return;
    }
    const taille = (info.files || []).reduce((t, f) => t + (f.size || 0), 0);
    diffuser({
      etat: 'disponible',
      version: info.version,
      date: info.releaseDate || null,
      taille: taille || null,
      notes: notesEnTexte(info.releaseNotes),
      manuel: verificationManuelle,
    });
  });
  autoUpdater.on('download-progress', (p) => diffuser({
    etat: 'telechargement',
    version: etat.version,
    pourcent: Math.round(p.percent || 0),
    transfere: p.transferred || 0,
    total: p.total || 0,
    vitesse: p.bytesPerSecond || 0,
  }));
  autoUpdater.on('update-downloaded', (info) => diffuser({ etat: 'pret', version: info.version }));
  autoUpdater.on('error', (e) => {
    journal.erreur('[MAJ] Erreur :', e);
    const pendantTelechargement = etat.etat === 'telechargement';
    diffuser({ etat: 'erreur', message: messageErreur(e), manuel: verificationManuelle || pendantTelechargement });
  });
  return true;
}

async function verifier(manuel) {
  if (!autoUpdater) {
    if (manuel) diffuser({ etat: 'non-configure', manuel: true, message: 'Mises à jour non configurées dans cette version.' });
    return etat;
  }
  if (['verification', 'telechargement'].includes(etat.etat)) return etat;
  verificationManuelle = manuel;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    // déjà signalé par l'événement 'error'
    if (etat.etat !== 'erreur') diffuser({ etat: 'erreur', message: messageErreur(e), manuel });
  }
  return etat;
}

function enregistrerCanaux() {
  canal('maj:etat', [], () => ({ versionActuelle: app.getVersion(), ...etat }));

  canal('maj:verifier', [], () => verifier(true));

  canal('maj:telecharger', [], async () => {
    if (!autoUpdater || etat.etat !== 'disponible') throw new Error('Aucune mise à jour à télécharger.');
    diffuser({ etat: 'telechargement', version: etat.version, pourcent: 0, transfere: 0, total: etat.taille || 0 });
    autoUpdater.downloadUpdate().catch(() => { /* signalé par 'error' */ });
    return true;
  });

  canal('maj:installer', [], () => {
    if (!autoUpdater || etat.etat !== 'pret') throw new Error('La mise à jour n\'est pas encore téléchargée.');
    journal.info(`[MAJ] Installation de la version ${etat.version} et redémarrage.`);
    // Installation silencieuse (pas d'assistant) puis relance de l'application.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  canal('maj:ignorer', [], () => {
    if (etat.version) parametres.modifier({ versionIgnoree: etat.version });
    diffuser({ etat: 'ignoree', version: etat.version });
    return true;
  });
}

// À appeler une fois, après la création de la fenêtre principale.
function demarrer(fenetre, deps = {}) {
  if (deps.journal) journal = deps.journal;
  if (deps.parametres) parametres = deps.parametres;
  enregistrerCanaux();
  const actif = configurer();
  if (!actif || process.env.FORGE_TEST_LANCEMENT === '1') return;
  if (!parametres.lire().verifierMajAuDemarrage) {
    journal.info('[MAJ] Vérification au démarrage désactivée dans les paramètres.');
    return;
  }
  const lancer = () => setTimeout(() => verifier(false), DELAI_DEMARRAGE);
  if (fenetre.webContents.isLoading()) fenetre.webContents.once('did-finish-load', lancer);
  else lancer();
}

module.exports = { demarrer };
