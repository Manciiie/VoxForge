'use strict';
// Tests de sécurité de base. Lancer : npm test
// Chaque module qui lit des fichiers, extrait des archives, lance des commandes
// ou stocke des secrets AJOUTE ses propres cas ici (voir les modèles en bas).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../../src/main/securite');

const DEST = path.join(os.tmpdir(), 'forge-dest');

test('zip slip : les chemins qui sortent du dossier sont refusés', () => {
  for (const nom of ['../evil.txt', '..\\evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:\\Windows\\evil.dll', 'C:evil', '\\\\serveur\\partage\\x', 'a/b/../../../x']) {
    assert.throws(() => s.verifierEntreeArchive(DEST, { nom }), s.ErreurSecurite, nom);
  }
});

test('zip slip : les chemins normaux sont acceptés et restent dans le dossier', () => {
  for (const nom of ['fichier.txt', 'dossier/sous/fichier.txt', 'dossier\\fichier.txt', 'a/./b.txt', 'a/../b.txt']) {
    const cible = s.verifierEntreeArchive(DEST, { nom });
    assert.ok(cible.startsWith(path.resolve(DEST) + path.sep), nom);
  }
});

test('zip slip : liens symboliques et caractères nuls refusés', () => {
  assert.throws(() => s.verifierEntreeArchive(DEST, { nom: 'lien', estLienSymbolique: true }), s.ErreurSecurite);
  assert.throws(() => s.cheminSousDossier(DEST, 'a\0b'), s.ErreurSecurite);
  assert.throws(() => s.cheminSousDossier(DEST, ''), s.ErreurSecurite);
});

test('bombe de décompression : ratio, taille et nombre de fichiers limités', () => {
  assert.throws(() => new s.LimitesDecompression().ajouter({ tailleDecompressee: 1e9, tailleCompressee: 1e6 }), /taux de compression/);
  const l = new s.LimitesDecompression({ tailleMax: 1000 });
  l.ajouter({ tailleDecompressee: 600, tailleCompressee: 300 });
  assert.throws(() => l.ajouter({ tailleDecompressee: 600, tailleCompressee: 300 }), /taille/);
  const n = new s.LimitesDecompression({ fichiersMax: 2 });
  n.ajouter({ tailleDecompressee: 1, tailleCompressee: 1 });
  n.ajouter({ tailleDecompressee: 1, tailleCompressee: 1 });
  assert.throws(() => n.ajouter({ tailleDecompressee: 1, tailleCompressee: 1 }), /fichiers/);
});

test('IPC : arguments invalides refusés', () => {
  const schema = [{ type: 'string', max: 10 }, { type: 'number', min: 0, max: 5 }, { type: 'enum', valeurs: ['a', 'b'] }];
  assert.doesNotThrow(() => s.validerArguments(schema, ['ok', 3, 'a']));
  assert.throws(() => s.validerArguments(schema, ['ok', 3]), s.ErreurSecurite);                 // manque un argument
  assert.throws(() => s.validerArguments(schema, ['ok', 3, 'a', 'x']), s.ErreurSecurite);      // argument en trop
  assert.throws(() => s.validerArguments(schema, [{ toString: () => 'x' }, 3, 'a']), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['x'.repeat(11), 3, 'a']), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['ok', NaN, 'a']), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['ok', 9, 'a']), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['ok', 3, 'c']), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['o\0k', 3, 'a']), s.ErreurSecurite);
});

test('IPC : objets avec champs inconnus refusés (pas de pollution de prototype)', () => {
  const schema = [{ type: 'objet', champs: { theme: { type: 'enum', valeurs: ['sombre'], optionnel: true } } }];
  assert.doesNotThrow(() => s.validerArguments(schema, [{ theme: 'sombre' }]));
  assert.throws(() => s.validerArguments(schema, [{ theme: 'sombre', inconnu: 1 }]), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, [JSON.parse('{"__proto__": {"admin": true}}')]), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, [[]]), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, [null]), s.ErreurSecurite);
});

test('IPC : listes validées élément par élément', () => {
  const schema = [{ type: 'liste', element: { type: 'chemin' }, max: 3 }];
  assert.doesNotThrow(() => s.validerArguments(schema, [['a.txt', 'b.txt']]));
  assert.throws(() => s.validerArguments(schema, [['a', 'b', 'c', 'd']]), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, [['a', 42]]), s.ErreurSecurite);
  assert.throws(() => s.validerArguments(schema, ['a.txt']), s.ErreurSecurite);
});

test('liens externes : https uniquement', () => {
  assert.equal(s.urlExterneAutorisee('https://exemple.fr/page'), true);
  for (const u of ['http://exemple.fr', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'smb://serveur/x', 'https://user:mdp@exemple.fr', 'pas une url']) {
    assert.equal(s.urlExterneAutorisee(u), false, u);
  }
});

test('commandes : arguments passés séparément, sans interprétation shell', () => {
  const nomPiege = 'fichier"; del /q C:\\* & echo .txt';
  assert.deepEqual(s.argumentsCommande(['-i', nomPiege]), ['-i', nomPiege]);
  assert.throws(() => s.argumentsCommande('-i fichier'), s.ErreurSecurite);
  assert.throws(() => s.argumentsCommande(['a\0b']), s.ErreurSecurite);
  assert.throws(() => s.argumentsCommande([42]), s.ErreurSecurite);
});

test('commandes : un nom de fichier piégé n\'exécute rien (execFile sans shell)', () => {
  const { execFileSync } = require('child_process');
  const temoin = path.join(os.tmpdir(), `forge-injection-${process.pid}`);
  const piege = `x; touch ${temoin}; echo & type nul > ${temoin}`;
  const sortie = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', piege], { shell: false, encoding: 'utf8' });
  assert.equal(sortie, piege);
  assert.equal(fs.existsSync(temoin), false);
});

test('journaux : les secrets sont masqués', () => {
  const cle = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const t = s.masquerSecrets(`clé=${cle} Authorization: Bearer abcdefghijklmnop password=Hunter2!x AIzaSyA1234567890abcdefghijklmnopqrstu`, ['MonMotDePasseSQL']);
  assert.ok(!t.includes(cle));
  assert.ok(!t.includes('abcdefghijklmnop'));
  assert.ok(!t.includes('Hunter2!x'));
  assert.ok(!t.includes('AIzaSyA1234567890'));
  assert.ok(!s.masquerSecrets('connexion avec MonMotDePasseSQL', ['MonMotDePasseSQL']).includes('MonMotDePasseSQL'));
});

test('journal de VoxForge (main.js) : chaque ligne passe par masquerSecrets avec les secrets déclarés', () => {
  // VoxForge garde son journal historique (logs/main.log, rotation à 1 Mo) : la protection est dans log()
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function log('), main.indexOf('function log(') + 600);
  assert.ok(/masquerSecrets\(/.test(fn) && /secretsConnus/.test(fn), 'log() doit masquer les secrets');
  assert.ok(/secrets\.initialiser\(app\.getPath\('userData'\), safeStorage, declarerSecret\)/.test(main), 'les secrets du coffre doivent être déclarés au journal');
});

// --- Modèles à copier selon les modules du logiciel ----------------------------
//
// Archive piégée réelle (ArcForge, PatchForge…) : construire un zip contenant
// "../evil.txt" (ex. avec le module zip utilisé par l'app), appeler la fonction
// d'extraction du module vers un dossier temporaire, puis vérifier que
// path.join(dossierTemp, '..', 'evil.txt') n'existe PAS et qu'une ErreurSecurite est levée.
//
// Secrets (TokenScope, SQL Bridge…) : enregistrer une clé via le module,
// relire parametres.json et tous les fichiers de logs, vérifier que la clé n'y figure pas.
//
// Requêtes SQL (SQL Bridge) : passer un nom de table "x; DROP TABLE y; --" et
// vérifier que l'identifiant est échappé ou refusé.
