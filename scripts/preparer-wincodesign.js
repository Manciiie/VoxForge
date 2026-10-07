#!/usr/bin/env node
'use strict';
// Prépare la boîte à outils « winCodeSign » d'electron-builder (rcedit : icône et version de VoxForge.exe).
//
// Pourquoi : l'archive officielle contient aussi des fichiers macOS sous forme de liens symboliques.
// Windows refuse de les créer sans droits administrateur ni « Mode développeur », et electron-builder
// échoue alors en boucle (« Cannot create symbolic link : A required privilege is not held by the client »).
// Ici, on extrait l'archive SANS la partie macOS, dans le dossier de cache qu'electron-builder consulte
// avant tout téléchargement : il la trouve et ne retente plus l'extraction.
//   node scripts/preparer-wincodesign.js            (Windows uniquement ; ne fait rien ailleurs)
// VOX_WCS_TEST=<url> : test hors Windows avec une archive locale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

if (process.platform !== 'win32' && !process.env.VOX_WCS_TEST) { console.log('  winCodeSign : rien à faire hors Windows.'); process.exit(0); }

const VERSION = 'winCodeSign-2.6.0';
const URL_7Z = process.env.VOX_WCS_TEST || `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;
const RCEDIT_SHA256 = 'ab53500d556fd824636621bca7dbecd8583ba181891c3e9efdcf16b72a28b0cd'; // rcedit-x64.exe de winCodeSign 2.6.0
const CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
const DOSSIER = path.join(CACHE, 'winCodeSign', VERSION);

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pret = () => { try { return sha256(path.join(DOSSIER, 'rcedit-x64.exe')) === RCEDIT_SHA256; } catch { return false; } };

(async () => {
  if (pret()) { console.log('  winCodeSign : déjà prêt.'); return; }
  const sevenZip = require('7zip-bin').path7za;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-wcs-'));
  try {
    console.log('  winCodeSign : téléchargement (5,6 Mo)…');
    const res = await fetch(URL_7Z, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = path.join(tmp, `${VERSION}.7z`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    fs.rmSync(DOSSIER, { recursive: true, force: true });
    fs.mkdirSync(DOSSIER, { recursive: true });
    // -xr!darwin : la partie macOS (liens symboliques) n'est pas extraite
    execFileSync(sevenZip, ['x', '-y', '-bd', '-xr!darwin', `-o${DOSSIER}`, archive], { stdio: 'ignore', windowsHide: true });
    if (!pret()) throw new Error('rcedit-x64.exe absent ou différent de celui attendu');
    console.log('  winCodeSign : prêt (sans la partie macOS).');
  } catch (e) {
    fs.rmSync(DOSSIER, { recursive: true, force: true });
    console.error(`\n  ✗ winCodeSign : préparation impossible (${e.message}).`);
    console.error('    Solution de secours : activer le « Mode développeur » de Windows (Paramètres › Système › Pour les développeurs)\n    ou lancer construire-setup.bat en tant qu’administrateur.');
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
