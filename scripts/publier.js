#!/usr/bin/env node
'use strict';
// Publie la version compilée sur le dépôt GitHub des mises à jour (<Nom>-releases).
// Les applications déjà installées la proposeront à leur prochain démarrage.
//
//   node scripts/publier.js              -> publie dist/<Nom>-Setup-<version>.exe + .blockmap + latest.yml
//   node scripts/publier.js --brouillon  -> brouillon (invisible pour les applications)
//
// Prérequis : `gh` authentifié avec un accès en ÉCRITURE au dépôt des installeurs
// (jamais le jeton en lecture seule embarqué dans l'application).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const version = pkg.version;
const nom = pkg.build?.productName || pkg.productName;
const pub = [].concat(pkg.build?.publish || []).find((p) => p && p.provider === 'github');
const BROUILLON = process.argv.includes('--brouillon');

function arreter(message) { console.error(`✗ ${message}`); process.exit(1); }
if (!pub) arreter('Pas de dépôt de mises à jour dans package.json (build.publish).');
const depot = `${pub.owner}/${pub.repo}`;
const tag = `v${version}`;

function gh(args, options = {}) {
  return execFileSync('gh', args, { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// --- 1. Fichiers à publier et cohérence -----------------------------------------
const dist = path.join(RACINE, 'dist');
const exe = path.join(dist, `${nom}-Setup-${version}.exe`);
const blockmap = `${exe}.blockmap`;
const latest = path.join(dist, 'latest.yml');
for (const f of [exe, blockmap, latest]) {
  if (!fs.existsSync(f)) arreter(`Fichier manquant : ${path.relative(RACINE, f)}. Lancer d'abord « npm run build ».`);
}
if (fs.statSync(exe).size < 20 * 1024 * 1024) arreter('Installeur anormalement petit : build incomplet.');

const yml = fs.readFileSync(latest, 'utf8');
const versionYml = (yml.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
if (versionYml !== version) arreter(`latest.yml annonce la version ${versionYml}, package.json la ${version}.`);
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
if (!yml.includes(sha512)) arreter('L\'empreinte SHA-512 de latest.yml ne correspond pas à l\'installeur : refaire le build.');

const config = JSON.parse(fs.readFileSync(path.join(RACINE, 'src', 'main', 'maj-config.json'), 'utf8'));
if (!config.jeton) {
  console.warn('⚠ Cette version est compilée SANS jeton de mise à jour : une fois installée, elle ne pourra plus');
  console.warn('  se mettre à jour toute seule. Publier quand même ? Relancer avec --sans-jeton pour confirmer.');
  if (!process.argv.includes('--sans-jeton')) process.exit(1);
}

// --- 2. Dépôt accessible, non vide, version pas encore publiée ----------------------
try { gh(['--version']); } catch { arreter('gh (GitHub CLI) introuvable.'); }
let infoDepot;
try { infoDepot = JSON.parse(gh(['api', `repos/${depot}`])); } catch (e) {
  arreter(`Dépôt ${depot} inaccessible (${(e.stderr || e.message).split('\n')[0]}). Il doit exister et la session doit y avoir accès en écriture.`);
}
if (!infoDepot.private) console.warn(`⚠ ${depot} est PUBLIC : les installeurs sont téléchargeables par tout le monde.`);
if (infoDepot.size === 0) {
  // Un dépôt vide n'accepte pas de tag : on crée un README.
  const contenu = Buffer.from(`# ${nom} — mises à jour\n\nInstalleurs de ${nom}. Le code source n'est pas ici.\n`).toString('base64');
  try {
    gh(['api', '-X', 'PUT', `repos/${depot}/contents/README.md`, '-f', `message=Initialisation`, '-f', `content=${contenu}`]);
    console.log('Dépôt vide : README créé.');
  } catch { /* il a peut-être déjà un commit */ }
}
try {
  gh(['release', 'view', tag, '--repo', depot]);
  arreter(`La version ${tag} est déjà publiée sur ${depot}. Incrémenter la version avant de publier.`);
} catch (e) {
  if (e.status === undefined) throw e;
}

// --- 3. Notes de version : section du CHANGELOG ---------------------------------
let notes = `${nom} ${version}`;
try {
  const changelog = fs.readFileSync(path.join(RACINE, 'CHANGELOG.md'), 'utf8');
  const debut = changelog.search(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\b`, 'm'));
  if (debut >= 0) {
    const reste = changelog.slice(debut);
    const fin = reste.slice(3).search(/^## /m);
    notes = (fin >= 0 ? reste.slice(0, fin + 3) : reste).replace(/^## .*\n/, '').trim();
  } else {
    console.warn(`⚠ Pas de section « ## ${version} » dans CHANGELOG.md : notes de version minimales.`);
  }
} catch { /* pas de CHANGELOG */ }
const fichierNotes = path.join(os.tmpdir(), `notes-${process.pid}.md`);
fs.writeFileSync(fichierNotes, notes);

// --- 4. Publication + vérification -------------------------------------------------
const args = ['release', 'create', tag, exe, blockmap, latest, '--repo', depot, '--title', `${nom} ${version}`, '--notes-file', fichierNotes];
if (BROUILLON) args.push('--draft');
gh(args, { stdio: ['ignore', 'inherit', 'inherit'] });
fs.unlinkSync(fichierNotes);

const vue = JSON.parse(gh(['release', 'view', tag, '--repo', depot, '--json', 'assets,isDraft,url']));
const noms = vue.assets.map((a) => a.name);
for (const attendu of [path.basename(exe), path.basename(blockmap), 'latest.yml']) {
  if (!noms.includes(attendu)) arreter(`Fichier absent de la publication : ${attendu}`);
}
console.log(`✓ ${nom} ${version} publié sur ${depot}${vue.isDraft ? ' (brouillon)' : ''}.`);
console.log(BROUILLON
  ? '  Brouillon : les applications ne le verront qu\'une fois publié depuis GitHub.'
  : '  Les applications installées le proposeront à leur prochain démarrage.');
