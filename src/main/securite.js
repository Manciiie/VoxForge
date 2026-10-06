'use strict';
// Fonctions de sécurité partagées. Aucun require d'Electron ici :
// ce module doit rester testable avec `node --test` sans lancer l'app.

const path = require('path');

class ErreurSecurite extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurSecurite';
  }
}

// --- Chemins ---------------------------------------------------------------

// Résout `relatif` sous `base` et refuse tout ce qui en sort
// (../, chemin absolu, lecteur Windows, chemin UNC).
function cheminSousDossier(base, relatif) {
  if (typeof relatif !== 'string' || relatif.length === 0) {
    throw new ErreurSecurite('Chemin vide ou invalide.');
  }
  if (relatif.includes('\0')) {
    throw new ErreurSecurite('Chemin contenant un caractère nul.');
  }
  const normalise = relatif.replace(/\\/g, '/');
  if (normalise.startsWith('/') || /^[a-zA-Z]:/.test(normalise) || normalise.startsWith('//')) {
    throw new ErreurSecurite(`Chemin absolu refusé : ${relatif}`);
  }
  const baseResolue = path.resolve(base);
  const cible = path.resolve(baseResolue, normalise);
  const rel = path.relative(baseResolue, cible);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ErreurSecurite(`Chemin hors du dossier autorisé : ${relatif}`);
  }
  return cible;
}

// Contrôle d'une entrée d'archive avant extraction (protection « zip slip »).
function verifierEntreeArchive(dossierDestination, entree) {
  if (entree.estLienSymbolique) {
    throw new ErreurSecurite(`Lien symbolique refusé dans l'archive : ${entree.nom}`);
  }
  return cheminSousDossier(dossierDestination, entree.nom);
}

// --- Bombes de décompression ----------------------------------------------

class LimitesDecompression {
  constructor({ tailleMax = 20 * 1024 ** 3, fichiersMax = 200000, ratioMax = 200 } = {}) {
    this.tailleMax = tailleMax;
    this.fichiersMax = fichiersMax;
    this.ratioMax = ratioMax;
    this.tailleTotale = 0;
    this.nbFichiers = 0;
  }

  // À appeler pour chaque entrée, AVANT de l'écrire sur le disque.
  ajouter({ tailleDecompressee, tailleCompressee }) {
    this.nbFichiers += 1;
    this.tailleTotale += tailleDecompressee;
    if (this.nbFichiers > this.fichiersMax) {
      throw new ErreurSecurite(`Archive refusée : plus de ${this.fichiersMax} fichiers.`);
    }
    if (this.tailleTotale > this.tailleMax) {
      throw new ErreurSecurite('Archive refusée : taille décompressée trop importante.');
    }
    if (tailleCompressee > 0 && tailleDecompressee / tailleCompressee > this.ratioMax) {
      throw new ErreurSecurite('Archive refusée : taux de compression suspect (bombe de décompression).');
    }
  }
}

// --- Validation des arguments IPC -----------------------------------------

// Schéma : tableau de règles, une par argument.
//   { type: 'string', max: 260 } | { type: 'number', min, max } | { type: 'boolean' }
//   { type: 'enum', valeurs: [...] } | { type: 'chemin' } | { type: 'objet', champs: {...} }
//   { type: 'liste', element: <règle>, max: 1000 } | { type: 'json', max: <octets> } | { type: 'binaire', max: <octets> }
//   Une règle string accepte aussi `motif` (expression régulière à respecter).
function validerArguments(schema, args) {
  if (!Array.isArray(args) || args.length !== schema.length) {
    throw new ErreurSecurite('Nombre d\'arguments invalide.');
  }
  schema.forEach((regle, i) => validerValeur(regle, args[i], `argument ${i + 1}`));
  return args;
}

function contientCleDangereuse(v, profondeur = 0) {
  if (profondeur > 64 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => contientCleDangereuse(x, profondeur + 1));
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
    if (contientCleDangereuse(v[k], profondeur + 1)) return true;
  }
  return false;
}

function validerValeur(regle, valeur, nom) {
  if (regle.optionnel && (valeur === undefined || valeur === null)) return;
  switch (regle.type) {
    case 'string':
    case 'chemin':
      if (typeof valeur !== 'string') throw new ErreurSecurite(`${nom} : texte attendu.`);
      if (valeur.includes('\0')) throw new ErreurSecurite(`${nom} : caractère nul refusé.`);
      if (valeur.length > (regle.max ?? (regle.type === 'chemin' ? 32767 : 10000))) {
        throw new ErreurSecurite(`${nom} : trop long.`);
      }
      if (regle.motif && !regle.motif.test(valeur)) throw new ErreurSecurite(`${nom} : format invalide.`);
      return;
    case 'json':
      // structure libre (paramètres, segments d'une transcription…) : seulement bornée en taille
      // et sans prototype étranger ; le reste est vérifié par la fonction qui la consomme
      if (valeur === undefined || typeof valeur === 'function' || typeof valeur === 'symbol') throw new ErreurSecurite(`${nom} : valeur invalide.`);
      {
        let taille = 0;
        try { taille = JSON.stringify(valeur)?.length ?? 0; } catch { throw new ErreurSecurite(`${nom} : structure non sérialisable.`); }
        if (taille > (regle.max ?? 1_000_000)) throw new ErreurSecurite(`${nom} : structure trop volumineuse.`);
      }
      if (contientCleDangereuse(valeur)) throw new ErreurSecurite(`${nom} : clé interdite (__proto__ / constructor).`);
      return;
    case 'binaire':
      if (!(valeur instanceof ArrayBuffer || ArrayBuffer.isView(valeur))) throw new ErreurSecurite(`${nom} : données binaires attendues.`);
      if (valeur.byteLength > (regle.max ?? 64 * 1024 * 1024)) throw new ErreurSecurite(`${nom} : données trop volumineuses.`);
      return;
    case 'number':
      if (typeof valeur !== 'number' || !Number.isFinite(valeur)) throw new ErreurSecurite(`${nom} : nombre attendu.`);
      if (regle.min !== undefined && valeur < regle.min) throw new ErreurSecurite(`${nom} : trop petit.`);
      if (regle.max !== undefined && valeur > regle.max) throw new ErreurSecurite(`${nom} : trop grand.`);
      return;
    case 'boolean':
      if (typeof valeur !== 'boolean') throw new ErreurSecurite(`${nom} : booléen attendu.`);
      return;
    case 'enum':
      if (!regle.valeurs.includes(valeur)) throw new ErreurSecurite(`${nom} : valeur non autorisée.`);
      return;
    case 'liste':
      if (!Array.isArray(valeur)) throw new ErreurSecurite(`${nom} : liste attendue.`);
      if (valeur.length > (regle.max ?? 1000)) throw new ErreurSecurite(`${nom} : liste trop longue.`);
      valeur.forEach((v, i) => validerValeur(regle.element, v, `${nom}[${i}]`));
      return;
    case 'objet':
      if (typeof valeur !== 'object' || valeur === null || Array.isArray(valeur)) {
        throw new ErreurSecurite(`${nom} : objet attendu.`);
      }
      for (const cle of Object.keys(valeur)) {
        if (!Object.hasOwn(regle.champs, cle)) throw new ErreurSecurite(`${nom} : champ inconnu « ${cle} ».`);
      }
      for (const [cle, sousRegle] of Object.entries(regle.champs)) {
        validerValeur(sousRegle, valeur[cle], `${nom}.${cle}`);
      }
      return;
    default:
      throw new ErreurSecurite(`${nom} : type de règle inconnu.`);
  }
}

// --- Liens externes --------------------------------------------------------

function urlExterneAutorisee(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

// --- Commandes système -----------------------------------------------------

// Vérifie les arguments passés à execFile/spawn (toujours avec shell: false).
function argumentsCommande(args) {
  if (!Array.isArray(args)) throw new ErreurSecurite('Arguments de commande : tableau attendu.');
  for (const a of args) {
    if (typeof a !== 'string') throw new ErreurSecurite('Arguments de commande : texte attendu.');
    if (a.includes('\0')) throw new ErreurSecurite('Arguments de commande : caractère nul refusé.');
  }
  return args;
}

// --- Masquage des secrets dans les journaux --------------------------------

const MOTIFS_SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                // clés type OpenAI / Anthropic
  /\bAIza[0-9A-Za-z_-]{30,}/g,               // clés Google
  /\b(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/g, // jetons GitHub
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,  // jetons Bearer
  /((?:password|pwd|mot_de_passe|apikey|api_key|token)\s*[=:]\s*)("?)[^\s";]+\2/gi,
];

function masquerSecrets(texte, secretsConnus = []) {
  let sortie = String(texte);
  for (const s of secretsConnus) {
    if (s && s.length >= 4) sortie = sortie.split(s).join('••••');
  }
  sortie = sortie.replace(MOTIFS_SECRETS[0], '••••');
  sortie = sortie.replace(MOTIFS_SECRETS[1], '••••');
  sortie = sortie.replace(MOTIFS_SECRETS[2], '••••');
  sortie = sortie.replace(MOTIFS_SECRETS[3], '$1 ••••');
  sortie = sortie.replace(MOTIFS_SECRETS[4], '$1••••');
  return sortie;
}

module.exports = {
  ErreurSecurite,
  cheminSousDossier,
  verifierEntreeArchive,
  LimitesDecompression,
  validerArguments,
  urlExterneAutorisee,
  argumentsCommande,
  masquerSecrets,
};
