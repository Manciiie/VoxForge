#!/usr/bin/env node
'use strict';
// Prépare le dossier de livraison : installeur (découpé si trop gros), empreinte SHA-256,
// script de réassemblage qui vérifie l'empreinte, et zip du code source.
//   node scripts/livrer.js [--taille-partie 95]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const nom = pkg.build?.productName || pkg.productName || pkg.name;
const version = pkg.version;
const i = process.argv.indexOf('--taille-partie');
const TAILLE_PARTIE = (i > 0 ? Number(process.argv[i + 1]) : 95) * 1024 * 1024;

const dist = path.join(RACINE, 'dist');
const sortie = path.join(RACINE, 'livraison', version);
fs.rmSync(sortie, { recursive: true, force: true });
fs.mkdirSync(sortie, { recursive: true });

function sha256(fichier) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(fichier, 'r');
  const tampon = Buffer.alloc(4 * 1024 * 1024);
  let lu;
  while ((lu = fs.readSync(fd, tampon, 0, tampon.length, null)) > 0) h.update(tampon.subarray(0, lu));
  fs.closeSync(fd);
  return h.digest('hex');
}

const fichiersLivres = [];
const installeurs = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((f) => /\.(exe|AppImage)$/.test(f) && f.includes(version) && !f.includes('__uninstaller'))
  : [];
if (!installeurs.length) {
  console.error(`Aucun installeur ${version} trouvé dans dist/. Lancer d'abord le build.`);
  process.exit(1);
}

const empreintes = [];
for (const nomInstalleur of installeurs) {
  const source = path.join(dist, nomInstalleur);
  const taille = fs.statSync(source).size;
  // Un installeur Electron fait au moins ~60 Mo : en dessous, le build a échoué en cours de route
  // (ex. wine manquant) et a laissé un fichier tronqué qu'il ne faut surtout pas livrer.
  if (taille < 20 * 1024 * 1024 && !process.argv.includes('--forcer')) {
    console.error(`${nomInstalleur} ne fait que ${(taille / 1024 / 1024).toFixed(1)} Mo : installeur incomplet, build à refaire.`);
    process.exit(1);
  }
  const empreinte = sha256(source);
  empreintes.push(`${empreinte}  ${nomInstalleur}`);

  if (taille <= TAILLE_PARTIE) {
    fs.copyFileSync(source, path.join(sortie, nomInstalleur));
    fichiersLivres.push(nomInstalleur);
    continue;
  }

  // Découpage en parties .part01, .part02…
  const fd = fs.openSync(source, 'r');
  const tampon = Buffer.alloc(TAILLE_PARTIE);
  let n = 0;
  let lu;
  const parties = [];
  while ((lu = fs.readSync(fd, tampon, 0, TAILLE_PARTIE, null)) > 0) {
    n += 1;
    const nomPartie = `${nomInstalleur}.part${String(n).padStart(2, '0')}`;
    fs.writeFileSync(path.join(sortie, nomPartie), tampon.subarray(0, lu));
    parties.push(nomPartie);
  }
  fs.closeSync(fd);
  fichiersLivres.push(...parties);

  if (nomInstalleur.endsWith('.exe')) {
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      `echo Reassemblage de ${nomInstalleur}...`,
      `copy /b ${parties.map((p) => `"${p}"`).join(' + ')} "${nomInstalleur}" >nul`,
      `if errorlevel 1 ( echo ERREUR : une partie est manquante. & pause & exit /b 1 )`,
      `for /f "tokens=* delims=" %%h in ('certutil -hashfile "${nomInstalleur}" SHA256 ^| findstr /v ":"') do ( set "H=%%h" & goto :verif )`,
      ':verif',
      'set "H=%H: =%"',
      `if /i "%H%"=="${empreinte}" ( echo OK : fichier intact. Vous pouvez lancer ${nomInstalleur}. ) else ( echo ERREUR : empreinte differente, fichier corrompu. Retelechargez les parties. & del "${nomInstalleur}" )`,
      'pause',
      '',
    ].join('\r\n');
    const nomBat = `reassembler-${nom}.bat`;
    fs.writeFileSync(path.join(sortie, nomBat), bat);
    fichiersLivres.push(nomBat);
  }
}

fs.writeFileSync(path.join(sortie, 'SHA256.txt'), `${empreintes.join('\n')}\n`);
fichiersLivres.push('SHA256.txt');

// Zip du code source (sans node_modules, dist, livraison).
const zip = `${nom}-source-${version}.zip`;
const exclusions = ['node_modules/*', 'dist/*', 'livraison/*', 'captures*', '*.log', '.git/*', 'resources/bin/*'];
try {
  execFileSync('zip', ['-rq', path.join(sortie, zip), '.', '-x', ...exclusions], { cwd: RACINE });
} catch {
  // Pas de zip en ligne de commande : repli Python.
  execFileSync('python3', ['-c', `
import os, sys, zipfile, fnmatch
racine, cible = sys.argv[1], sys.argv[2]
excl = ['node_modules', 'dist', 'livraison', '.git']
with zipfile.ZipFile(cible, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, dirs, fs_ in os.walk(racine):
        dirs[:] = [x for x in dirs if x not in excl and not x.startswith('captures')]
        for f in fs_:
            if f.endswith('.log'): continue
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, racine))
`, RACINE, path.join(sortie, zip)]);
}
fichiersLivres.push(zip);

let majOk = false;
try { majOk = Boolean(JSON.parse(fs.readFileSync(path.join(RACINE, 'src', 'main', 'maj-config.json'), 'utf8')).jeton); } catch { /* absent */ }
console.log(majOk ? 'Mises à jour automatiques : configurées.' : '⚠ Mises à jour automatiques : NON configurées (pas de jeton dans cette version).');
console.log(`Livraison prête dans ${path.relative(RACINE, sortie)} :`);
for (const f of fichiersLivres) {
  const t = fs.statSync(path.join(sortie, f)).size;
  console.log(`  ${f}  (${(t / 1024 / 1024).toFixed(1)} Mo)`);
}
console.log(`\n${empreintes.join('\n')}`);
