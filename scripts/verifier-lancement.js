#!/usr/bin/env node
'use strict';
// Test de lancement : démarre l'application, vérifie qu'une fenêtre se charge
// sans erreur console et que l'interface signale qu'elle est prête, puis la ferme.
//   node scripts/verifier-lancement.js                 -> version de développement (electron .)
//   node scripts/verifier-lancement.js <exécutable>    -> version compilée (dossier dist/*-unpacked)
// Sous Linux sans écran, utilise xvfb-run automatiquement.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RACINE = path.resolve(__dirname, '..');
const cible = process.argv[2];
const DELAI = 90_000;

let commande;
let args;
if (cible) {
  commande = path.resolve(cible);
  args = [];
} else {
  commande = require(path.join(RACINE, 'node_modules', 'electron'));
  args = [RACINE];
}

// Profil jetable pour ne pas toucher aux paramètres réels.
const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
args.push(`--user-data-dir=${profil}`);
// En conteneur Linux lancé en root, Chromium refuse de démarrer sans ce drapeau (test uniquement).
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
if (process.platform === 'linux') args.push('--disable-gpu');

if (process.platform === 'linux' && !process.env.DISPLAY) {
  args = ['-a', '-s', '-screen 0 1280x800x24', commande, ...args];
  commande = 'xvfb-run';
}

const env = { ...process.env, FORGE_TEST_LANCEMENT: '1', ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const p = spawn(commande, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let sortie = '';
p.stdout.on('data', (d) => { sortie += d; });
p.stderr.on('data', (d) => { sortie += d; });

const minuteur = setTimeout(() => {
  p.kill('SIGKILL');
  terminer(false, `Délai dépassé (${DELAI / 1000} s) : l'application ne s'est pas signalée prête.`);
}, DELAI);

p.on('close', (code) => {
  clearTimeout(minuteur);
  if (sortie.includes('FORGE_PRET') && code === 0) terminer(true, 'Fenêtre créée, interface chargée sans erreur.');
  else terminer(false, `Échec (code ${code}).`);
});

function terminer(ok, message) {
  fs.rmSync(profil, { recursive: true, force: true });
  if (!ok) {
    const utile = sortie.split('\n').filter((l) => /FORGE_|Error|Erreur|ERREUR|Uncaught|failed/i.test(l)).slice(-30).join('\n');
    console.error(`✗ ${message}\n${utile || sortie.slice(-3000)}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
  process.exit(0);
}
