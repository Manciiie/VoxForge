'use strict';
// Protections propres à VoxForge, prouvées avec de vrais fichiers piégés :
//  - archives (pack GPU .zip, modèles .tar.bz2) : chemins « ../ » neutralisés, bombes refusées ;
//  - coffre à secrets : la clé d'API ne sort jamais en clair, ancienne clé migrée ;
//  - rendu Markdown (textes produits par l'IA) : aucun HTML injectable ;
//  - validation IPC : identifiants et structures hostiles refusés.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');

const RACINE = path.join(__dirname, '..', '..');
const Zip = require('../../src/main/zip');
const { validerArguments, masquerSecrets } = require('../../src/main/securite');
const { R } = (() => {
  // ipc.js charge electron : on n'extrait que les règles R, sans Electron
  const src = fs.readFileSync(path.join(RACINE, 'src', 'main', 'ipc.js'), 'utf8');
  const ctx = { module: { exports: {} }, require: (m) => (m === 'electron' ? { ipcMain: { handle() {}, on() {} } } : require(path.join(RACINE, 'src', 'main', m))) };
  vm.runInNewContext(src, ctx);
  return ctx.module.exports;
})();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vox-sec-'));

// --- fabrique une archive .zip minimale (méthode « stockée ») avec des noms arbitraires ---
function zipDe(entries) {
  const parts = []; const cd = []; let off = 0;
  for (const [name, data, fakeSize] of entries) {
    const n = Buffer.from(name); const d = Buffer.from(data);
    const crc = 0; const size = fakeSize ?? d.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, n, d);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt32LE(off, 42);
    cd.push(ch, n);
    off += 30 + n.length + d.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

test('zip piégé : une entrée « ../../evil.dll » reste dans le dossier de destination', async () => {
  const d = path.join(tmp(), 'a', 'b'); fs.mkdirSync(d, { recursive: true }); const dest = path.join(d, 'dest'); fs.mkdirSync(dest);
  const z = path.join(d, 'pack.zip');
  fs.writeFileSync(z, zipDe([['../../evil.dll', 'MZ'], ['lib/ok.dll', 'MZ']]));
  // même usage que gpu.js : nom de base uniquement
  const noms = await Zip.extract(z, () => true, dest);
  assert.deepEqual(noms.sort(), ['../../evil.dll', 'lib/ok.dll']);
  assert.ok(fs.existsSync(path.join(dest, 'evil.dll')) && fs.existsSync(path.join(dest, 'ok.dll')));
  assert.ok(!fs.existsSync(path.join(d, 'evil.dll')) && !fs.existsSync(path.join(path.dirname(d), 'evil.dll')), 'écrit hors du dossier !');
  // l'API n'accepte plus de fonction de chemin : impossible d'utiliser le nom brut par erreur
  await assert.rejects(Zip.extract(z, () => true, (e) => path.join(dest, e.name)), /Dossier de destination/);
});

test('zip bombe : taille annoncée mensongère ou ratio suspect refusés avant écriture', async () => {
  const d = tmp(); const z = path.join(d, 'bombe.zip');
  // ratio annoncé 1 000 000:1
  fs.writeFileSync(z, zipDe([['a.bin', 'x', 1_000_000]]));
  await assert.rejects(Zip.extract(z, () => true, d), /bombe|taille/i);
  assert.ok(!fs.existsSync(path.join(d, 'a.bin')));
});

test('tar.bz2 piégé (modèle) : « ../../x-int8.onnx » écrit sous son nom de base, dans le dossier seulement', async () => {
  const { Worker } = require('worker_threads');
  const tar = require('tar-stream');
  const d = tmp(); const dir = path.join(d, 'modele'); fs.mkdirSync(dir);
  const pack = tar.pack();
  pack.entry({ name: '../../x-int8.onnx' }, 'ONNX');
  pack.entry({ name: 'ok/tokens.txt' }, 'a 1');
  pack.entry({ name: 'ok/ignore.bin' }, 'zzz');
  pack.finalize();
  const chunks = []; for await (const c of pack) chunks.push(c);
  // unbzip2-stream attend du bz2 : on utilise le même worker avec un flux bz2 produit par Python si présent, sinon bzip2
  const raw = Buffer.concat(chunks);
  const { execFileSync } = require('child_process');
  const tarPath = path.join(d, 'm.tar'); fs.writeFileSync(tarPath, raw);
  execFileSync('bzip2', ['-f', tarPath]);
  await new Promise((resolve, reject) => {
    const w = new Worker(path.join(RACINE, 'src', 'main', 'extract-worker.js'), { workerData: { tarPath: tarPath + '.bz2', dir } });
    w.on('message', (m) => { if (m.type === 'done') resolve(); if (m.type === 'error') reject(new Error(m.message)); });
    w.on('error', reject);
  });
  assert.ok(fs.existsSync(path.join(dir, 'x-int8.onnx')) && fs.existsSync(path.join(dir, 'tokens.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'ignore.bin')), 'fichier hors liste écrit');
  assert.ok(!fs.existsSync(path.join(d, 'x-int8.onnx')) && !fs.existsSync(path.join(path.dirname(d), 'x-int8.onnx')), 'écrit hors du dossier !');
});

test('coffre : clé d\'API chiffrée, jamais relue en clair par l\'interface, masquée dans le journal', () => {
  const secrets = require('../../src/main/secrets');
  const d = tmp();
  const faux = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('ENC' + Buffer.from(s).toString('base64')), decryptString: (b) => Buffer.from(String(b).slice(3), 'base64').toString() };
  const declares = []; secrets.initialiser(d, faux, (v) => declares.push(v));
  secrets.enregistrer('ai_api_key', 'sk-test-1234567890abcdef');
  const brut = fs.readFileSync(path.join(d, 'secrets.dat'), 'utf8');
  assert.ok(!brut.includes('sk-test'), 'secret en clair sur le disque');
  assert.equal(secrets.existe('ai_api_key'), true);
  assert.equal(secrets.lire('ai_api_key'), 'sk-test-1234567890abcdef');
  assert.equal(masquerSecrets('clé sk-test-1234567890abcdef envoyée', declares), 'clé •••• envoyée');
  secrets.enregistrer('ai_api_key', '');
  assert.equal(secrets.existe('ai_api_key'), false);
  // sans chiffrement disponible : refus explicite, rien d'écrit
  secrets.initialiser(tmp(), { isEncryptionAvailable: () => false }, () => {});
  assert.throws(() => secrets.enregistrer('x', 'y'), /chiffrement/);
});

test('settings:get ne renvoie jamais la clé d\'API (code de main.js)', () => {
  const main = fs.readFileSync(path.join(RACINE, 'src', 'main', 'main.js'), 'utf8');
  assert.ok(/canal\('settings:get', R\.rien, \(\) => settingsPourInterface\(\)\)/.test(main));
  assert.ok(/apiKey: '', apiKeySet:/.test(main));
  assert.ok(/apiKey: cleApi\(\)/.test(main), 'le fournisseur IA doit lire la clé dans le coffre');
});

test('rendu Markdown des textes IA : aucun HTML brut, attributs d\'événement neutralisés', () => {
  const src = fs.readFileSync(path.join(RACINE, 'src', 'renderer', 'markdown.js'), 'utf8');
  const ctx = { window: {} }; vm.runInNewContext(src, ctx);
  const html = ctx.window.Markdown.render('# Titre <img src=x onerror=alert(1)>\n\n<script>alert(2)</script> **gras** [lien](javascript:alert(3))\n- a\n1) b');
  const balises = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
  assert.ok(balises.every((b) => ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'blockquote', 'hr', 'input'].includes(b)), 'balise inattendue : ' + balises.join(','));
  assert.ok(!/<[^>]*\bon[a-z]+\s*=/i.test(html) && !/<a\b|href=/i.test(html), html); // pas d'attribut d'événement ni de lien javascript:
  assert.ok(html.includes('<strong>gras</strong>') && html.includes('<h2>'));
});

test('validation IPC : identifiants et structures hostiles refusés', () => {
  assert.throws(() => validerArguments([R.id], ['../../x']), /format/);
  assert.throws(() => validerArguments([R.id], ['a/b']), /format/);
  assert.throws(() => validerArguments([R.chemin], ['x\0y']), /nul/);
  assert.throws(() => validerArguments([R.json(100)], [{ a: 'x'.repeat(200) }]), /volumineuse/);
  assert.throws(() => validerArguments([R.json(1000)], [JSON.parse('{"__proto__":{"polluted":1}}')]), /interdite/);
  assert.throws(() => validerArguments([{ type: 'binaire', max: 8 }], [new Float32Array(10)]), /volumineuses/);
  assert.throws(() => validerArguments([{ type: 'objet', champs: { baseUrl: R.texte(10) } }], [{ baseUrl: 'x', apiKey: 'y' }]), /inconnu/);
  validerArguments([R.id, R.idModele, R.chemins], ['muwhrg5xu9refb', 'custom:C:\\Users\\x\\m.gguf', ['C:\\a.mp3']]);
});
