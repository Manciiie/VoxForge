'use strict';
// Cohérence entre la liste blanche du preload et les canaux déclarés côté principal
// (canal() et canalEvenement()), et absence de canaux « fourre-tout » dangereux.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', '..', 'src', 'main');

function lireTous(dossier) {
  return fs.readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dossier, e.name);
    return e.isDirectory() ? lireTous(p) : e.name.endsWith('.js') ? [fs.readFileSync(p, 'utf8')] : [];
  }).join('\n');
}

const preload = fs.readFileSync(path.join(MAIN, 'preload.js'), 'utf8');
const liste = (nom) => [...preload.match(new RegExp(`const ${nom} = \\[([\\s\\S]*?)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const listePreload = liste('CANAUX');
const envoisPreload = liste('ENVOIS');
const evenementsPreload = liste('EVENEMENTS');
const codePrincipal = lireTous(MAIN).replace(preload, '');
const declares = [...codePrincipal.matchAll(/\bcanal\(\s*'([^']+)'/g)].map((m) => m[1]);
const declaresEvenements = [...codePrincipal.matchAll(/\bcanalEvenement\(\s*'([^']+)'/g)].map((m) => m[1]);

test('chaque canal du preload est déclaré (avec schéma) côté principal', () => {
  for (const c of listePreload) assert.ok(declares.includes(c), `Canal « ${c} » absent de main.js / services`);
  for (const c of envoisPreload) assert.ok(declaresEvenements.includes(c), `Envoi « ${c} » absent de main.js`);
});

test('chaque canal déclaré est exposé par le preload', () => {
  for (const c of declares) assert.ok(listePreload.includes(c), `Canal « ${c} » déclaré mais pas dans la liste du preload`);
  for (const c of declaresEvenements) assert.ok(envoisPreload.includes(c), `Envoi « ${c} » déclaré mais pas dans ENVOIS`);
});

test('chaque canal déclaré a un schéma (tableau de règles)', () => {
  for (const m of codePrincipal.matchAll(/\bcanal(?:Evenement)?\(\s*'([^']+)',\s*([^,]+?),/g)) {
    assert.ok(/^(\[|R\.(rien|chemins))/.test(m[2].trim()), `Canal « ${m[1]} » sans schéma : ${m[2].trim()}`);
  }
});

test('aucun ipcMain.handle/on direct en dehors de ipc.js (tout passe par la validation)', () => {
  const fichiers = fs.readdirSync(MAIN, { recursive: true }).filter((f) => f.endsWith('.js') && path.basename(f) !== 'ipc.js');
  for (const f of fichiers) {
    const t = fs.readFileSync(path.join(MAIN, f), 'utf8');
    assert.ok(!/ipcMain\.(handle|on)\s*\(/.test(t), `${f} enregistre un canal sans passer par canal()`);
  }
});

test('pas de canal générique d\'exécution ou de lecture libre', () => {
  for (const c of [...declares, ...declaresEvenements]) {
    const [module, action] = c.split(':');
    const moduleGenerique = /^(app|systeme|system|shell|fs|fichiers?|os|node|cmd)$/i.test(module);
    const actionGenerique = /^(exec|executer|commande|cmd|shell|eval|run|lire|ecrire|supprimer|readFile|writeFile|unlink|rm)$/i.test(action || '');
    assert.ok(!(moduleGenerique && actionGenerique), `Canal trop générique : ${c}`);
    assert.ok(/^[a-z][a-zA-Z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*$/.test(c), `Nom de canal attendu « module:action » : ${c}`);
  }
});

test('le preload n\'expose pas ipcRenderer ni require, et filtre les événements', () => {
  const expose = preload.split('exposeInMainWorld')[1] || '';
  assert.ok(!/exposeInMainWorld\([^)]*\bipcRenderer\b\s*[,)]/.test(preload));
  assert.ok(!/ipcRenderer\s*:\s*ipcRenderer|\bipcRenderer\s*[,}]\s*\)/.test(expose));
  assert.ok(!/require\s*:/.test(preload));
  assert.ok(/EVENEMENTS\.includes/.test(preload) && /CANAUX\.includes/.test(preload) && /ENVOIS\.includes/.test(preload));
  // tous les événements utilisés par le preload sont dans la liste
  for (const m of expose.matchAll(/\bon\('([^']+)'\)/g)) assert.ok(evenementsPreload.includes(m[1]), `Événement non listé : ${m[1]}`);
});

test('shell:openExternal n\'ouvre que des liens https', () => {
  const main = fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8');
  const ligne = main.split('\n').find((l) => l.includes("canal('shell:openExternal'"));
  assert.ok(ligne && /urlExterneAutorisee\(url\)/.test(ligne));
});
