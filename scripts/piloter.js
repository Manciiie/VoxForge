#!/usr/bin/env node
'use strict';
// Pilote l'interface réelle de l'application (clics, saisies, captures d'écran) pour les
// tests de bout en bout et pour relire l'interface en images avant de livrer.
//
//   node scripts/piloter.js                              -> scénario par défaut : capture de chaque écran, thème sombre et clair
//   node scripts/piloter.js tests/e2e/mon-scenario.js    -> scénario personnalisé
//   node scripts/piloter.js <scenario> --exe dist/linux-unpacked/<nom>   -> même chose sur la version compilée
//   Options : --captures <dossier> (défaut : captures/)
//
// Un scénario exporte une fonction async (p) => { ... } qui reçoit :
//   p.clic(sel)  p.saisir(sel, texte)  p.choisir(sel, valeur)  p.attendre(sel, ms)  p.texte(sel)
//   p.eval(expression) p.capture(nom)  p.pause(ms)  p.verifier(condition, message)  p.ecran(nom)  p.dossierTemp
// Les fichiers d'exemple se créent dans p.dossierTemp ; pour les ajouter à l'app sans boîte de
// dialogue, exposer dans le module une fonction de test ou appeler directement le traitement via p.eval.

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (o) => (args.includes(o) ? args[args.indexOf(o) + 1] : null);
const fichierScenario = args.find((a, i) => !a.startsWith('--') && !['--exe', '--captures'].includes(args[i - 1]));
const exe = val('--exe');
const dossierCaptures = path.resolve(RACINE, val('--captures') || 'captures');
const PORT = 9300 + Math.floor(Math.random() * 500);

fs.mkdirSync(dossierCaptures, { recursive: true });
const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pilote-'));
const dossierTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fichiers-'));

let commande = exe ? path.resolve(exe) : require(path.join(RACINE, 'node_modules', 'electron'));
let lancement = [...(exe ? [] : [RACINE]), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`, '--disable-gpu'];
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) lancement.push('--no-sandbox');
if (process.platform === 'linux') lancement.push('--password-store=basic'); // coffre à secrets sans trousseau (test en conteneur)
if (process.platform === 'linux' && !process.env.DISPLAY) {
  lancement = ['-a', '-s', '-screen 0 1366x860x24', commande, ...lancement];
  commande = 'xvfb-run';
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(commande, lancement, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let journalApp = '';
app.stdout.on('data', (d) => { journalApp += d; });
app.stderr.on('data', (d) => { journalApp += d; });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, ko) => http.get(url, (r) => { let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => { try { ok(JSON.parse(t)); } catch (e) { ko(e); } }); }).on('error', ko));

async function connecter() {
  for (let i = 0; i < 120; i++) {
    try {
      const cibles = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = cibles.find((c) => c.type === 'page' && c.url.includes('/renderer/'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* l'app démarre */ }
    await pause(500);
  }
  throw new Error('Impossible de se connecter à l\'application (délai dépassé).');
}

async function principal() {
  const ws = new WebSocket(await connecter());
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
  let id = 0;
  const attentes = new Map();
  const erreursConsole = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && attentes.has(msg.id)) { attentes.get(msg.id)(msg); attentes.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') erreursConsole.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') erreursConsole.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((ok, ko) => {
    const n = ++id;
    attentes.set(n, (r) => (r.error ? ko(new Error(r.error.message)) : ok(r.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const evalJs = async (code) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const q = (sel) => JSON.stringify(sel);
  const p = {
    dossierTemp,
    eval: (expression) => evalJs(`return (${expression});`),
    pause,
    async attendre(sel, ms = 5000) {
      const fin = Date.now() + ms;
      while (Date.now() < fin) {
        if (await evalJs(`return !!document.querySelector(${q(sel)});`)) return;
        await pause(100);
      }
      throw new Error(`Élément introuvable : ${sel}`);
    },
    async clic(sel) { await p.attendre(sel); await evalJs(`document.querySelector(${q(sel)}).click();`); await pause(150); },
    async saisir(sel, texte) {
      await p.attendre(sel);
      await evalJs(`const e = document.querySelector(${q(sel)}); e.focus(); e.value = ${q(texte)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));`);
      await pause(150);
    },
    async choisir(sel, valeur) { return p.saisir(sel, valeur); },
    texte: (sel) => evalJs(`return document.querySelector(${q(sel)})?.textContent ?? null;`),
    async ecran(nom) { await p.clic(`.nav-item[data-view="${nom}"]`); await pause(250); },
    async capture(nom) {
      const r = await cdp('Page.captureScreenshot', { format: 'png' });
      const f = path.join(dossierCaptures, `${nom}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log(`  capture : ${path.relative(RACINE, f)}`);
    },
    verifier(condition, message) {
      if (!condition) throw new Error(`Vérification échouée : ${message}`);
      console.log(`  ✓ ${message}`);
    },
  };

  await p.attendre('body');
  for (let i = 0; i < 50 && !(await evalJs('return window.__forgePret === true;')); i++) await pause(200);

  const scenario = fichierScenario ? require(path.resolve(fichierScenario)) : scenarioParDefaut;
  await scenario(p);

  if (erreursConsole.length) throw new Error(`Erreurs dans la console :\n${erreursConsole.join('\n')}`);
  ws.close();
}

// Capture de chaque écran en thème sombre puis clair.
async function scenarioParDefaut(p) {
  const ecrans = await p.eval('[...document.querySelectorAll(".nav-item[data-view]")].map((b) => b.dataset.view)');
  for (const theme of ['dark', 'light']) {
    await p.ecran('settings');
    await p.clic(`#setTheme [data-v="${theme}"]`);
    await pause(300);
    for (const e of ecrans) {
      await p.ecran(e);
      await p.capture(`${theme === 'dark' ? 'sombre' : 'clair'}-${e}`);
    }
  }
}

principal()
  .then(() => { console.log('✓ Scénario terminé sans erreur.'); fin(0); })
  .catch((e) => { console.error(`✗ ${e.message}`); fin(1); });

function fin(code) {
  app.kill('SIGTERM');
  setTimeout(() => {
    try { app.kill('SIGKILL'); } catch { /* déjà fermée */ }
    if (code) {
      console.error(journalApp.split('\n').filter((l) => /error|erreur/i.test(l) && !/bus\.cc/.test(l)).slice(-15).join('\n'));
      // journal de l'application (profil jetable) : copié à côté des captures pour le diagnostic, avant suppression du profil
      try {
        const j = path.join(profil, 'logs', 'main.log');
        if (fs.existsSync(j)) { const dst = path.join(dossierCaptures, 'dernier-journal.log'); fs.copyFileSync(j, dst); console.error(`journal de l'app : ${path.relative(RACINE, dst)}`); }
      } catch { /* */ }
    }
    fs.rmSync(profil, { recursive: true, force: true });
    fs.rmSync(dossierTemp, { recursive: true, force: true });
    process.exit(code);
  }, 800);
}
