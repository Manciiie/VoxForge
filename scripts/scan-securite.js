#!/usr/bin/env node
'use strict';
// Scan de sécurité statique du projet. Code de sortie 1 si un problème bloquant est trouvé.
//   node scripts/scan-securite.js            -> motifs + config Electron + CSP + npm audit
//   node scripts/scan-securite.js --complet  -> + electronegativity (téléchargé via npx)
//   node scripts/scan-securite.js --json rapport.json
//
// Exception ponctuelle : ajouter en fin de ligne  // securite-ok: <raison>
// La raison est reprise dans le rapport : elle doit être réelle.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const SRC = path.join(RACINE, 'src');
const args = process.argv.slice(2);
const COMPLET = args.includes('--complet');
const SORTIE_JSON = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const resultats = { bloquants: [], avertissements: [], exceptions: [], verifications: [] };

function fichiers(dossier, exts) {
  const out = [];
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) out.push(...fichiers(p, exts)); }
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(RACINE, p).replace(/\\/g, '/');

// --- 1. Motifs dangereux -----------------------------------------------------
const MOTIFS = [
  { re: /\{[^}]*\bexec(Sync)?\b[^}]*\}\s*=\s*require\(\s*['"](node:)?child_process['"]\s*\)|(child_?[pP]rocess|\bcp)\.exec(Sync)?\s*\(/, gravite: 'bloquant', msg: 'exec/execSync : passe par un shell, risque d\'injection. Utiliser execFile/spawn avec un tableau d\'arguments.' },
  { re: /shell\s*:\s*true/, gravite: 'bloquant', msg: 'shell: true : risque d\'injection de commande.' },
  { re: /\beval\s*\(/, gravite: 'bloquant', msg: 'eval() interdit.' },
  { re: /new\s+Function\s*\(/, gravite: 'bloquant', msg: 'new Function() interdit.' },
  { re: /nodeIntegration\s*:\s*true/, gravite: 'bloquant', msg: 'nodeIntegration doit rester à false.' },
  { re: /contextIsolation\s*:\s*false/, gravite: 'bloquant', msg: 'contextIsolation doit rester à true.' },
  { re: /sandbox\s*:\s*false/, gravite: 'bloquant', msg: 'sandbox doit rester à true.' },
  { re: /webSecurity\s*:\s*false/, gravite: 'bloquant', msg: 'webSecurity doit rester à true.' },
  { re: /allowRunningInsecureContent\s*:\s*true/, gravite: 'bloquant', msg: 'allowRunningInsecureContent interdit.' },
  { re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/, gravite: 'bloquant', msg: 'Vérification TLS désactivée.' },
  { re: /webviewTag\s*:\s*true/, gravite: 'avertissement', msg: 'webviewTag activé : à justifier.' },
  { re: /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/, gravite: 'avertissement', msg: 'Injection HTML : utiliser textContent ou DOMPurify.' },
  { re: /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/, gravite: 'bloquant', msg: 'ipcRenderer exposé directement à l\'interface.' },
  { re: /ipcRenderer\.(send|invoke)\s*\(\s*[a-zA-Z_$][\w$]*\s*[,)]/, gravite: 'avertissement', msg: 'Canal IPC dynamique dans le preload : vérifier la liste blanche.', fichierSeul: 'preload.js', ignorerSi: /CANAUX\.includes/ },
  { re: /openExternal\s*\(/, gravite: 'avertissement', msg: 'shell.openExternal : l\'URL doit être validée (https uniquement).', ignorerSi: /urlExterneAutorisee/ },
  { re: /http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org)/, gravite: 'avertissement', msg: 'URL en http:// (non chiffrée).' },
  { re: /devTools\s*:\s*true/, gravite: 'avertissement', msg: 'DevTools forcés : désactiver en production.' },
  { re: /(api[_-]?key|password|mot_de_passe|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, gravite: 'bloquant', msg: 'Secret écrit en dur dans le code.' },
  { re: /github_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}/, gravite: 'bloquant', msg: 'Jeton GitHub écrit dans le code : il doit venir de maj-config.json (généré au build).' },
  { re: /localStorage\.setItem\s*\(\s*['"][^'"]*(key|cle|token|password|secret)/i, gravite: 'bloquant', msg: 'Secret stocké en clair dans localStorage : utiliser safeStorage.' },
];

for (const f of fichiers(SRC, ['.js', '.mjs', '.cjs', '.html', '.ts'])) {
  const lignes = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const contenu = lignes.join('\n');
  lignes.forEach((ligne, i) => {
    const code = ligne.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (!code.trim()) return;
    for (const m of MOTIFS) {
      if (m.fichierSeul && path.basename(f) !== m.fichierSeul) continue;
      if (!m.re.test(code)) continue;
      if (m.filtre && !m.filtre(code)) continue;
      if (m.ignorerSi && m.ignorerSi.test(contenu)) continue;
      const ou = `${rel(f)}:${i + 1}`;
      const exception = ligne.match(/\/\/\s*securite-ok:\s*(.+)$/);
      if (exception) { resultats.exceptions.push(`${ou} — ${m.msg} Justification : ${exception[1].trim()}`); continue; }
      (m.gravite === 'bloquant' ? resultats.bloquants : resultats.avertissements).push(`${ou} — ${m.msg}`);
    }
  });
}
resultats.verifications.push('Motifs dangereux dans src/');

// Le jeton de mise à jour ne doit jamais partir dans git (GitHub bloquerait le push, et il serait exposé).
const gitignore = fs.existsSync(path.join(RACINE, '.gitignore')) ? fs.readFileSync(path.join(RACINE, '.gitignore'), 'utf8') : '';
if (fs.existsSync(path.join(SRC, 'main', 'mises-a-jour.js')) && !/maj-config\.json/.test(gitignore)) {
  resultats.bloquants.push('.gitignore — src/main/maj-config.json (jeton de mise à jour) n\'est pas exclu de git.');
}

// --- 2. Configuration des fenêtres ---------------------------------------------
const OBLIGATOIRES = ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true'];
for (const f of fichiers(path.join(SRC, 'main'), ['.js'])) {
  const t = fs.readFileSync(f, 'utf8');
  const blocs = t.match(/webPreferences\s*:\s*\{[\s\S]*?\}/g) || [];
  for (const b of blocs) {
    const plat = b.replace(/\s+/g, ' ');
    for (const o of OBLIGATOIRES) {
      if (!plat.includes(o)) resultats.bloquants.push(`${rel(f)} — webPreferences sans « ${o} ».`);
    }
  }
  if (/new BrowserWindow/.test(t) && !/setWindowOpenHandler/.test(fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8'))) {
    resultats.bloquants.push('main.js — setWindowOpenHandler absent : les nouvelles fenêtres ne sont pas bloquées.');
  }
  if (/new BrowserWindow/.test(t) && !/will-navigate/.test(fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8'))) {
    resultats.bloquants.push('main.js — will-navigate non intercepté : la fenêtre peut être redirigée.');
  }
}
const main = fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8');
if (!/setPermissionRequestHandler/.test(main)) resultats.bloquants.push('main.js — aucune politique de permissions (setPermissionRequestHandler).');
resultats.verifications.push('Configuration Electron (webPreferences, navigation, permissions)');

// --- 3. CSP ----------------------------------------------------------------------
for (const f of fichiers(SRC, ['.html'])) {
  const t = fs.readFileSync(f, 'utf8');
  const csp = t.match(/Content-Security-Policy"\s+content="([^"]+)"/);
  if (!csp) { resultats.bloquants.push(`${rel(f)} — pas de Content-Security-Policy.`); continue; }
  if (/unsafe-eval/.test(csp[1])) resultats.bloquants.push(`${rel(f)} — CSP avec 'unsafe-eval'.`);
  if (/script-src[^;]*unsafe-inline/.test(csp[1])) resultats.bloquants.push(`${rel(f)} — CSP autorise les scripts inline.`);
  if (!/object-src 'none'/.test(csp[1])) resultats.avertissements.push(`${rel(f)} — CSP sans object-src 'none'.`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(t)) resultats.bloquants.push(`${rel(f)} — script inline (bloqué par la CSP, à déplacer dans un fichier).`);
}
resultats.verifications.push('Content-Security-Policy des pages');

// --- 4. Dépendances -------------------------------------------------------------
try {
  let sortie;
  try {
    sortie = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    sortie = e.stdout; // npm audit sort en code 1 quand il trouve quelque chose
    if (!sortie) throw e;
  }
  const audit = JSON.parse(sortie);
  if (audit.error) throw new Error(audit.error.summary || 'erreur npm audit');
  const v = audit.metadata?.vulnerabilities || {};
  const graves = (v.high || 0) + (v.critical || 0);
  if (graves) resultats.bloquants.push(`npm audit : ${v.critical || 0} critique(s), ${v.high || 0} haute(s) dans les dépendances de production.`);
  if (v.moderate) resultats.avertissements.push(`npm audit : ${v.moderate} vulnérabilité(s) modérée(s).`);
  resultats.verifications.push(`npm audit (production) : ${graves} haute/critique`);
} catch (e) {
  resultats.avertissements.push(`npm audit non vérifié (${e.message.split('\n')[0]}). Relancer avec un accès au registre npm.`);
}
if (!fs.existsSync(path.join(RACINE, 'package-lock.json'))) resultats.avertissements.push('package-lock.json absent.');

// --- 5. Electronegativity (optionnel) ----------------------------------------------
if (COMPLET) {
  const fichierRapport = path.join(RACINE, '.electronegativity.csv');
  try {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '@doyensec/electronegativity', '-i', 'src', '-o', fichierRapport, '-r'], { cwd: RACINE, stdio: 'ignore' });
  } catch { /* sort en erreur dès qu'il trouve quelque chose : on lit le rapport */ }
  // Constats génériques « à revoir » déjà traités par le squelette, avec la preuve vérifiée.
  const codeMain = fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8');
  const codeTout = fichiers(path.join(SRC, 'main'), ['.js']).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const GERES = {
    AUXCLICK_JS_CHECK: [/setWindowOpenHandler[\s\S]{0,200}action:\s*'deny'/.test(codeMain), 'nouvelles fenêtres refusées par setWindowOpenHandler'],
    REMOTE_MODULE_JS_CHECK: [!/@electron\/remote|enableRemoteModule/.test(codeTout), 'module remote absent (supprimé d\'Electron)'],
    PRELOAD_JS_CHECK: [/CANAUX\.includes/.test(codeTout) && /sandbox:\s*true/.test(codeMain), 'preload en sandbox avec liste blanche, vérifié par tests/securite/ipc.test.js'],
    OPEN_EXTERNAL_JS_CHECK: [null, 'URL validée par urlExterneAutorisee (https uniquement)'],
    CSP_GLOBAL_CHECK: [null, 'CSP contrôlée par ce scan (pas de unsafe-eval ni de script inline)'],
  };
  function lireCsv(texte) {
    const lignes = [];
    let ligne = [], champ = '', guillemets = false;
    for (let i = 0; i < texte.length; i++) {
      const c = texte[i];
      if (guillemets) {
        if (c === '"' && texte[i + 1] === '"') { champ += '"'; i++; }
        else if (c === '"') guillemets = false;
        else champ += c;
      } else if (c === '"') guillemets = true;
      else if (c === ',') { ligne.push(champ.trim()); champ = ''; }
      else if (c === '\n') { ligne.push(champ.trim()); lignes.push(ligne); ligne = []; champ = ''; }
      else if (c !== '\r') champ += c;
    }
    if (champ || ligne.length) { ligne.push(champ.trim()); lignes.push(ligne); }
    return lignes;
  }
  if (fs.existsSync(fichierRapport)) {
    const lignes = lireCsv(fs.readFileSync(fichierRapport, 'utf8')).slice(1).filter((l) => l.length > 4);
    for (const [regle, gravite, , fichier, position, extrait] of lignes) {
      const ou = `src/${fichier}:${position.split(':')[0]}`;
      const texte = `electronegativity ${regle} (${gravite}) — ${ou}`;
      const gere = GERES[regle];
      let preuve = gere && gere[0];
      if (gere && preuve === null) {
        if (regle === 'OPEN_EXTERNAL_JS_CHECK') {
          // La validation doit se trouver juste avant l'appel, dans le même fichier.
          const lignesFichier = fs.readFileSync(path.join(SRC, fichier), 'utf8').split(/\r?\n/);
          const n = Number(position.split(':')[0]);
          const contexte = lignesFichier.slice(Math.max(0, n - 4), n).join('\n');
          preuve = /urlExterneAutorisee\(/.test(contexte);
        } else {
          preuve = !resultats.bloquants.some((b) => b.includes('CSP'));
        }
      }
      if (gere && preuve) resultats.exceptions.push(`${texte} — ${gere[1]}`);
      else if (gravite === 'HIGH') resultats.bloquants.push(texte);
      else if (gravite === 'MEDIUM') resultats.avertissements.push(`${texte} — à revoir`);
    }
    fs.unlinkSync(fichierRapport);
    resultats.verifications.push(`electronegativity : ${lignes.length} constat(s) bruts`);
  } else {
    resultats.avertissements.push('electronegativity non exécuté.');
  }
}

// --- Rapport ----------------------------------------------------------------------
const titre = (t, l) => (l.length ? `\n${t} (${l.length})\n${l.map((x) => `  - ${x}`).join('\n')}` : '');
console.log('=== Scan de sécurité ===');
console.log(`Vérifié : ${resultats.verifications.join(' ; ')}`);
console.log(titre('BLOQUANTS', resultats.bloquants) || '\nAucun problème bloquant.');
console.log(titre('Avertissements', resultats.avertissements));
console.log(titre('Exceptions justifiées', resultats.exceptions));
if (SORTIE_JSON) fs.writeFileSync(SORTIE_JSON, JSON.stringify(resultats, null, 2));
process.exit(resultats.bloquants.length ? 1 : 0);
