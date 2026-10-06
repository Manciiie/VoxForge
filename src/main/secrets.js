'use strict';
/**
 * Coffre à secrets (clé d'API du serveur IA…) chiffré par Windows (safeStorage / DPAPI).
 * L'interface ne reçoit jamais la valeur d'un secret : seulement « existe » ou non.
 */
const fs = require('fs');
const path = require('path');

let fichier = null;
let safeStorage = null;
let declarer = () => {};

function initialiser(dossierDonnees, moduleSafeStorage, declarerSecret) {
  fichier = path.join(dossierDonnees, 'secrets.dat');
  safeStorage = moduleSafeStorage;
  if (typeof declarerSecret === 'function') declarer = declarerSecret;
}

function disponible() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function lireCoffre() {
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(fichier)));
  } catch { return {}; }
}

function enregistrer(nom, valeur) {
  if (!disponible()) throw new Error('Le chiffrement Windows n’est pas disponible : secret non enregistré.');
  const coffre = lireCoffre();
  if (valeur) coffre[nom] = String(valeur); else delete coffre[nom];
  const tmp = `${fichier}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(coffre)));
  fs.renameSync(tmp, fichier);
  if (valeur) declarer(String(valeur));
}

function lire(nom) {
  const v = lireCoffre()[nom];
  if (v) declarer(v);
  return v || '';
}

function existe(nom) { return Boolean(lireCoffre()[nom]); }

module.exports = { initialiser, disponible, enregistrer, lire, existe };
