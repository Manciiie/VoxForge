'use strict';
// Extraction .tar.bz2 dans un thread séparé (évite de figer l'interface).
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const bz2 = require('unbzip2-stream');
const tar = require('tar-stream');

(async () => {
  const { tarPath, dir } = workerData;
  const total = fs.statSync(tarPath).size;
  const keep = /(int8\.onnx|tokens\.txt)$/;
  const input = fs.createReadStream(tarPath, { highWaterMark: 1 << 20 });
  let read = 0; let last = 0;
  input.on('data', (c) => {
    read += c.length;
    const now = Date.now();
    if (now - last > 250) { last = now; parentPort.postMessage({ type: 'progress', read, total }); }
  });
  const ex = tar.extract();
  // garde-fous : nom de base seulement (jamais de « ../ »), taille totale écrite bornée (bombe de décompression)
  const TAILLE_MAX = 8 * 1024 ** 3; let ecrit = 0;
  ex.on('entry', (h, stream, next) => {
    const name = path.basename(String(h.name || '')).replace(/[\\/]/g, '');
    if (h.type === 'file' && keep.test(name) && name) {
      if ((ecrit += h.size || 0) > TAILLE_MAX) { next(new Error('archive refusée : taille décompressée trop importante')); return; }
      // pipeline : une erreur de la source ferme aussi le fichier de sortie (pas de fichier verrouillé sous Windows)
      pipeline(stream, fs.createWriteStream(path.join(dir, name))).then(() => next(), (e) => next(e));
    } else {
      stream.on('end', next);
      stream.resume();
    }
  });
  await pipeline(input, bz2(), ex);
  parentPort.postMessage({ type: 'done' });
})().catch((e) => parentPort.postMessage({ type: 'error', message: (e.code ? e.code + ' ' : '') + e.message }));
