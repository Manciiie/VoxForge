#!/usr/bin/env node
'use strict';
// Place resources/bin/ffmpeg.exe (requis par l'installeur Windows) et vérifie son empreinte SHA-256.
// Ordre : copie déjà présente → copie de VoxForge déjà installé sur ce PC → téléchargement
// (build gyan.dev « essentials » 6.0, celui livré avec VoxForge) puis extraction de bin/ffmpeg.exe.
// Le binaire n'est accepté que si son empreinte est exactement celle attendue.
//   node scripts/preparer-ffmpeg.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RACINE = path.resolve(__dirname, '..');
const CIBLE = path.join(RACINE, 'resources', 'bin', 'ffmpeg.exe');
const SHA256 = 'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1';
const URL_ZIP = process.env.VOX_FFMPEG_URL || 'https://github.com/GyanD/codexffmpeg/releases/download/6.0/ffmpeg-6.0-essentials_build.zip';
const TAILLE_MAX = 300 * 1024 * 1024;

function empreinte(fichier) {
  return new Promise((ok, ko) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(fichier).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', ko);
  });
}
async function valide(fichier) {
  try { return fs.statSync(fichier).isFile() && (await empreinte(fichier)) === SHA256; } catch { return false; }
}

function copiesInstallees() {
  const l = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'VoxForge')] : [];
  for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) if (process.env[v]) l.push(path.join(process.env[v], 'VoxForge'));
  if (process.env.VOX_FFMPEG_INSTALLE) l.unshift(process.env.VOX_FFMPEG_INSTALLE);
  return l.map((d) => path.join(d, 'resources', 'bin', 'ffmpeg.exe'));
}

async function telecharger(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (total > TAILLE_MAX) throw new Error('archive anormalement grosse');
  const out = fs.createWriteStream(dest);
  let recu = 0; let dernier = 0;
  for await (const morceau of res.body) {
    recu += morceau.length;
    if (recu > TAILLE_MAX) { out.destroy(); throw new Error('archive anormalement grosse'); }
    if (!out.write(morceau)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - dernier > 1000) { dernier = Date.now(); process.stdout.write(`\r  ${(recu / 1048576).toFixed(0)} Mo${total ? ' / ' + (total / 1048576).toFixed(0) + ' Mo' : ''}   `); }
  }
  await new Promise((ok, ko) => out.end((e) => (e ? ko(e) : ok())));
  process.stdout.write('\n');
}

(async () => {
  fs.mkdirSync(path.dirname(CIBLE), { recursive: true });
  if (await valide(CIBLE)) { console.log('  ffmpeg.exe : déjà présent et vérifié.'); return; }

  for (const src of copiesInstallees()) {
    if (await valide(src)) {
      fs.copyFileSync(src, CIBLE);
      console.log(`  ffmpeg.exe : repris de VoxForge installé (${src}).`);
      return;
    }
  }

  console.log('  ffmpeg.exe : téléchargement (environ 80 Mo)…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-ffmpeg-'));
  try {
    const zipFichier = path.join(tmp, 'ffmpeg.zip');
    await telecharger(URL_ZIP, zipFichier);
    const Zip = require(path.join(RACINE, 'src', 'main', 'zip.js'));
    await Zip.extract(zipFichier, (e) => /(^|\/)bin\/ffmpeg\.exe$/i.test(e.name), tmp);
    const extrait = path.join(tmp, 'ffmpeg.exe');
    if (!(await valide(extrait))) throw new Error('empreinte SHA-256 différente de celle attendue');
    fs.copyFileSync(extrait, CIBLE);
    console.log('  ffmpeg.exe : téléchargé et vérifié.');
  } catch (e) {
    console.error(`\n  ✗ ffmpeg.exe introuvable ou non conforme (${e.message}).`);
    console.error(`    Solution : copier ffmpeg.exe (ffmpeg 6.0 « essentials » de gyan.dev) dans\n    ${CIBLE}\n    puis relancer construire-setup.bat.`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
