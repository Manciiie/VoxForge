#!/usr/bin/env node
'use strict';
// Prépare src/main/maj-config.json avant chaque build : dépôt des mises à jour + jeton en lecture seule.
//
// Le jeton est pris, dans l'ordre :
//   1. la variable d'environnement FORGE_MAJ_JETON ;
//   2. le maj-config.json déjà présent (conservé dans le zip source d'une version à l'autre).
// Sans jeton, le build continue mais l'application affichera « Mises à jour non configurées ».
//
// maj-config.json est exclu de git (.gitignore) : GitHub bloquerait le push d'un jeton.
// Il reste dans le zip source livré, pour que la version suivante garde le même jeton.

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const FICHIER = path.join(RACINE, 'src', 'main', 'maj-config.json');
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const publication = [].concat(pkg.build?.publish || []).find((p) => p && p.provider === 'github');

if (!publication || /__MAJ_/.test(`${publication.owner}${publication.repo}`)) {
  console.error('✗ Dépôt de mises à jour non renseigné dans package.json (build.publish : owner / repo).');
  process.exit(1);
}

let ancien = {};
try { ancien = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); } catch { /* premier build */ }

const jeton = (process.env.FORGE_MAJ_JETON || ancien.jeton || '').trim();

if (jeton && !/^(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,})$/.test(jeton)) {
  console.error('✗ Le jeton ne ressemble pas à un jeton GitHub (github_pat_… ou ghp_…).');
  process.exit(1);
}
if (jeton.startsWith('ghp_')) {
  console.warn('⚠ Jeton « classique » (ghp_) : il donne accès à TOUS les dépôts du compte.');
  console.warn('  Utiliser plutôt un jeton « fine-grained » limité au dépôt des installeurs, en lecture seule.');
}

const config = { proprietaire: publication.owner, depot: publication.repo, jeton: jeton || null };
fs.writeFileSync(FICHIER, `${JSON.stringify(config, null, 2)}\n`);

if (jeton) {
  console.log(`✓ Mises à jour : ${publication.owner}/${publication.repo} (jeton ${jeton.slice(0, 15)}…).`);
} else {
  console.warn('⚠ AUCUN JETON : cette version ne pourra pas se mettre à jour toute seule.');
  console.warn('  Définir FORGE_MAJ_JETON puis relancer le build.');
}
