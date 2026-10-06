'use strict';
/**
 * Lecture minimale des archives .zip (Word .docx, OpenDocument .odt, paquets .whl) sans dépendance.
 * Méthodes « stockée » (0) et « deflate » (8). Archives jusqu'à 4 Go (pas de ZIP64).
 */
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');
const { LimitesDecompression, ErreurSecurite, cheminSousDossier } = require('./securite');

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** @returns {Promise<{name:string, method:number, compSize:number, size:number, offset:number}[]>} */
async function listEntries(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Archive .zip illisible (fin de répertoire introuvable).');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error('Archive ZIP64 non prise en charge.');
    const cd = await readAt(fh, cdOff, cdSize);
    const out = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      out.push({ name, method, compSize, size: usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally { await fh.close(); }
}

async function dataStart(file, entry) {
  const fh = await fsp.open(file, 'r');
  try {
    const h = await readAt(fh, entry.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('Entrée .zip abîmée : ' + entry.name);
    return entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { await fh.close(); }
}

/** Étapes de lecture d'une entrée (fichier brut → décompression éventuelle). */
function entryStages(file, entry, start) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Méthode de compression ${entry.method} non prise en charge (${entry.name}).`);
  if (!entry.compSize) return [Readable.from([])]; // entrée vide (ex. __init__.py)
  const raw = fs.createReadStream(file, { start, end: start + entry.compSize - 1, highWaterMark: 1 << 20 });
  return entry.method === 0 ? [raw] : [raw, zlib.createInflateRaw()];
}

/** Contenu d'une entrée en mémoire (petits fichiers : XML d'un document). */
async function readEntry(file, name) {
  const entries = await listEntries(file);
  const e = entries.find((x) => x.name === name);
  if (!e) return null;
  const start = await dataStart(file, e);
  const chunks = [];
  await pipeline(...entryStages(file, e, start), new Writable({ write(c, enc, cb) { chunks.push(c); cb(); } }));
  return Buffer.concat(chunks);
}

/**
 * Extrait les entrées choisies dans `destDir`, à plat (nom de base de l'entrée uniquement : jamais de
 * sous-dossier ni de « ../ » venant de l'archive — protection « zip slip »), avec suivi des octets écrits.
 */
async function extract(file, filter, destDir, onBytes = () => {}, { limites = new LimitesDecompression({ tailleMax: 8 * 1024 ** 3, fichiersMax: 20000, ratioMax: 400 }) } = {}) {
  if (typeof destDir !== 'string') throw new ErreurSecurite('Dossier de destination attendu.');
  const entries = (await listEntries(file)).filter((e) => !e.name.endsWith('/') && filter(e));
  // protection « bombe de décompression » : tailles annoncées vérifiées avant d'écrire, octets réels comptés pendant
  for (const e of entries) limites.ajouter({ tailleDecompressee: e.size, tailleCompressee: e.compSize });
  for (const e of entries) {
    const start = await dataStart(file, e);
    const nom = path.basename(e.name.replace(/\\/g, '/'));
    if (!nom || nom === '.' || nom === '..') throw new ErreurSecurite('Nom d’entrée invalide : ' + e.name);
    const out = cheminSousDossier(destDir, nom);
    const stages = entryStages(file, e, start);
    let ecrit = 0;
    stages[stages.length - 1].on('data', (c) => {
      ecrit += c.length; onBytes(c.length);
      if (ecrit > e.size + 1024 * 1024) stages[0].destroy(new ErreurSecurite('Archive refusée : taille réelle supérieure à la taille annoncée (' + e.name + ').'));
    });
    await pipeline(...stages, fs.createWriteStream(out));
  }
  return entries.map((e) => e.name);
}

module.exports = { listEntries, readEntry, extract };
