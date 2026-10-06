'use strict';
// Mises à jour : notes affichées en texte brut, messages d'erreur en français,
// jeton jamais dans le code, jamais envoyé à l'interface, jamais dans git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { notesEnTexte, messageErreur } = require('../../src/main/maj-outils');
const { masquerSecrets } = require('../../src/main/securite');

const RACINE = path.join(__dirname, '..', '..');
const MODULE = fs.readFileSync(path.join(RACINE, 'src', 'main', 'mises-a-jour.js'), 'utf8');

test('notes de version : HTML et scripts retirés, texte conservé', () => {
  const t = notesEnTexte('<h2>Nouveautés</h2><ul><li>Mode <b>sombre</b></li><li>Export &amp; import</li></ul><script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.ok(t.includes('Mode sombre'));
  assert.ok(t.includes('Export & import'));
  assert.ok(!/<|alert|onerror/.test(t), t);
  assert.equal(notesEnTexte(null), '');
  assert.ok(notesEnTexte('x'.repeat(10000)).length <= 6000);
  assert.ok(notesEnTexte([{ version: '1.2.0', note: '<p>Correctifs</p>' }]).includes('Correctifs'));
});

test('erreurs traduites en français', () => {
  assert.match(messageErreur(new Error('sha512 checksum mismatch, expected abc')), /corrompu/);
  assert.match(messageErreur(new Error('HttpError: 401 Unauthorized "Bad credentials"')), /jeton/);
  assert.match(messageErreur(new Error('HttpError: 404 Not Found')), /Aucune version/);
  assert.match(messageErreur(new Error('net::ERR_INTERNET_DISCONNECTED')), /connexion/);
  assert.match(messageErreur({ code: 'ENOSPC', message: 'no space' }), /Espace disque/);
  assert.match(messageErreur(new Error('quelque chose d\'inconnu')), /journal/);
});

test('le jeton n\'est jamais écrit dans le code source', () => {
  const fichiers = fs.readdirSync(path.join(RACINE, 'src'), { recursive: true }).filter((f) => /\.(js|html)$/.test(f));
  for (const f of fichiers) {
    const t = fs.readFileSync(path.join(RACINE, 'src', f), 'utf8');
    assert.ok(!/github_pat_[A-Za-z0-9_]{20,}|\bghp_[A-Za-z0-9]{30,}/.test(t), `Jeton GitHub dans ${f}`);
  }
});

test('le jeton n\'est jamais envoyé à l\'interface', () => {
  const envois = MODULE.match(/diffuser\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(envois.length > 0);
  for (const e of envois) assert.ok(!/jeton|token/.test(e), `État envoyé à l'interface contenant le jeton : ${e}`);
  assert.ok(!/canal\('maj:[^']+'[\s\S]{0,120}config/.test(MODULE), 'Un canal maj:* renvoie la configuration');
});

test('le jeton est masqué dans les journaux', () => {
  const jeton = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  const t = masquerSecrets(`GET https://api.github.com/repos/x/y/releases authorization: token ${jeton}`);
  assert.ok(!t.includes(jeton));
  assert.ok(!masquerSecrets(`jeton ghp_${'a'.repeat(36)}`).includes('a'.repeat(36)));
});

test('maj-config.json (jeton) exclu de git', () => {
  const gi = ['.gitignore', 'gitignore'].map((f) => path.join(RACINE, f)).find((f) => fs.existsSync(f));
  assert.ok(gi, '.gitignore absent');
  assert.match(fs.readFileSync(gi, 'utf8'), /maj-config\.json/);
});

test('rien n\'est téléchargé ni installé sans accord', () => {
  assert.match(MODULE, /autoDownload\s*=\s*false/);
  assert.match(MODULE, /allowDowngrade\s*=\s*false/);
  assert.match(MODULE, /allowPrerelease\s*=\s*false/);
  // l'adresse de test (faux serveur) n'est jamais utilisable dans la version compilée
  assert.match(MODULE, /!app\.isPackaged\s*\?\s*process\.env\.FORGE_TEST_MAJ_URL/);
});
