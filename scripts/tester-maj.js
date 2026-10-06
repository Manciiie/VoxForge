#!/usr/bin/env node
'use strict';
// Teste le cycle de mise à jour de bout en bout, dans l'interface réelle, avec un faux serveur local :
//   1. normal    : la fenêtre s'ouvre au démarrage, « Plus tard » la ferme, « Rechercher maintenant »
//                  la rouvre, le téléchargement va au bout, l'empreinte est vérifiée -> « Redémarrer maintenant »
//   2. corrompu  : le fichier ne correspond pas à son empreinte -> refusé, message « corrompu »
//   3. ignorer   : « Ignorer cette version » est mémorisé
//   4. a-jour    : pas de version plus récente -> aucune fenêtre au démarrage
//   5. hors-ligne: serveur injoignable -> aucune fenêtre au démarrage, message clair sur demande
//
//   node scripts/tester-maj.js [--captures captures-maj]
// L'installation elle-même (remplacement de l'exe par l'installeur NSIS) ne peut être testée que sous Windows.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const i = process.argv.indexOf('--captures');
const CAPTURES = path.resolve(RACINE, i > 0 ? process.argv[i + 1] : 'captures-maj');

// Faux installeur de 12 Mo et son empreinte.
const contenu = crypto.randomBytes(12 * 1024 * 1024);
const sha512 = crypto.createHash('sha512').update(contenu).digest('base64');
const NOM_FICHIER = 'Appli-Setup-9.9.9.exe';
const NOTES = '<h3>Nouveautés</h3><ul><li>Export en PDF</li><li>Démarrage deux fois plus rapide</li></ul><script>alert("piège")</script>';

function yml(version, empreinte) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${NOM_FICHIER}`,
    `    sha512: ${empreinte}`,
    `    size: ${contenu.length}`,
    `path: ${NOM_FICHIER}`,
    `sha512: ${empreinte}`,
    `releaseDate: '${new Date().toISOString()}'`,
    `releaseNotes: '${NOTES.replace(/'/g, "''")}'`,
    '',
  ].join('\n');
}

const serveur = http.createServer((req, res) => {
  const [, mode, fichier] = new URL(req.url, 'http://x').pathname.split('/');
  if (/^latest/.test(fichier || '') && fichier.endsWith('.yml')) {
    const version = mode === 'a-jour' ? '0.0.1' : '9.9.9';
    const empreinte = mode === 'corrompu' ? crypto.createHash('sha512').update('autre chose').digest('base64') : sha512;
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    return res.end(yml(version, empreinte));
  }
  if (fichier === NOM_FICHIER) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': contenu.length });
    // Envoi en plusieurs morceaux pour que la progression soit visible.
    let pos = 0;
    const suite = () => {
      if (pos >= contenu.length) return res.end();
      res.write(contenu.subarray(pos, pos + 1024 * 1024));
      pos += 1024 * 1024;
      setTimeout(suite, 250);
    };
    return suite();
  }
  res.writeHead(404); res.end();
});

const SCENARIO = path.join(__dirname, 'tester-maj.scenario.js');

// Port local fermé (pour simuler l'absence de connexion) : ouvert puis refermé aussitôt.
function portFerme() {
  return new Promise((ok) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

function lancer(mode, port, portHorsLigne) {
  return new Promise((ok) => {
    const appimage = path.join(os.tmpdir(), `forge-appimage-${process.pid}`);
    fs.writeFileSync(appimage, 'factice');
    const env = {
      ...process.env,
      FORGE_TEST_MAJ_URL: mode === 'hors-ligne' ? `http://127.0.0.1:${portHorsLigne}/` : `http://127.0.0.1:${port}/${mode}/`,
      FORGE_TEST_MAJ_MODE: mode,
      APPIMAGE: appimage, // Linux uniquement : electron-updater exige ce chemin pour télécharger
    };
    const p = spawn(process.execPath, [path.join(__dirname, 'piloter.js'), SCENARIO, '--captures', CAPTURES], { cwd: RACINE, env, stdio: 'inherit' });
    p.on('close', (code) => { fs.rmSync(appimage, { force: true }); ok(code); });
  });
}

// En développement, electron-updater lit dev-app-update.yml (la version compilée a son
// app-update.yml, généré par electron-builder) : on le crée le temps du test.
const DEV_YML = path.join(RACINE, 'dev-app-update.yml');
function nettoyer() { fs.rmSync(DEV_YML, { force: true }); }
process.on('exit', nettoyer);

serveur.listen(0, '127.0.0.1', async () => {
  const port = serveur.address().port;
  fs.writeFileSync(DEV_YML, `provider: generic\nurl: http://127.0.0.1:${port}/\nupdaterCacheDirName: forge-test-maj\n`);
  const portHorsLigne = await portFerme();
  const resultats = [];
  for (const mode of (process.env.MODES || 'normal,corrompu,ignorer,a-jour,hors-ligne').split(',')) {
    console.log(`\n=== Mise à jour : ${mode} ===`);
    resultats.push([mode, await lancer(mode, port, portHorsLigne)]);
  }
  serveur.close();
  console.log('\n=== Bilan ===');
  for (const [mode, code] of resultats) console.log(`${code === 0 ? '✓' : '✗'} ${mode}`);
  process.exit(resultats.every(([, c]) => c === 0) ? 0 : 1);
});
