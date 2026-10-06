#!/usr/bin/env node
'use strict';
// Génère livraison/<version>/Setup-<Nom>.exe : un petit programme (≈ 100 Ko) à lancer depuis le dossier
// des parties. Il recolle l'installeur, vérifie son empreinte SHA-256 puis le lance — sans fenêtre de
// commandes. Remplace reassembler-<Nom>.bat pour qui préfère un .exe.
//   node scripts/assembleur-exe.js            (après scripts/livrer.js)
// Nécessite makensis (fourni par electron-builder dans ~/.cache/electron-builder).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const nom = pkg.build?.productName || pkg.productName || pkg.name;
const version = pkg.version;
const dossier = path.join(RACINE, 'livraison', version);
const installeur = `${nom}-Setup-${version}.exe`;

const parties = fs.readdirSync(dossier).filter((f) => f.startsWith(`${installeur}.part`)).sort();
if (!parties.length) { console.error('✗ Aucune partie trouvée : lancer d’abord scripts/livrer.js.'); process.exit(1); }
const empreinte = (fs.readFileSync(path.join(dossier, 'SHA256.txt'), 'utf8').match(/[0-9a-f]{64}/i) || [])[0];
if (!empreinte) { console.error('✗ Empreinte introuvable dans SHA256.txt.'); process.exit(1); }

function trouverMakensis() {
  const base = path.join(os.homedir(), '.cache', 'electron-builder');
  const pile = [base];
  while (pile.length) {
    const d = pile.pop();
    let entrees = [];
    try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entrees) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) pile.push(p);
      else if (e.name === (process.platform === 'win32' ? 'makensis.exe' : 'makensis') && (process.platform === 'win32' || p.includes(`${path.sep}linux${path.sep}`))) return p;
    }
  }
  return null;
}
const makensis = trouverMakensis();
if (!makensis) { console.error('✗ makensis introuvable (lancer un build Windows une fois).'); process.exit(1); }

const nsisEsc = (s) => String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
const icone = path.join(RACINE, 'build', 'icon.ico');
// ASSEMBLEUR_TEST_HASH / ASSEMBLEUR_SORTIE : uniquement pour tester l'assembleur sous wine (pas de PowerShell)
const sortie = process.env.ASSEMBLEUR_SORTIE || path.join(dossier, `Setup-${nom}.exe`);
const verifs = parties.map((p) => `  IfFileExists "$EXEDIR\\${nsisEsc(p)}" +3 0\n    MessageBox MB_ICONSTOP "Partie manquante : ${nsisEsc(p)}$\\r$\\nPlacez ce programme dans le dossier qui contient les ${parties.length} parties."\n    Quit`).join('\n');
const liste = parties.map((p) => `"$EXEDIR\\${nsisEsc(p)}"`).join('+');

const script = `Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
Name "${nsisEsc(nom)} ${version}"
Caption "Installation de ${nsisEsc(nom)} ${version}"
OutFile "${sortie}"
${fs.existsSync(icone) ? `Icon "${icone}"` : ''}
BrandingText "${nsisEsc(nom)}"
ShowInstDetails show
LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\French.nlf"
Page instfiles
VIProductVersion "${version}.0"
VIAddVersionKey /LANG=1036 "ProductName" "${nsisEsc(nom)}"
VIAddVersionKey /LANG=1036 "FileDescription" "Assemblage et lancement de l'installeur ${nsisEsc(nom)} ${version}"
VIAddVersionKey /LANG=1036 "FileVersion" "${version}"
VIAddVersionKey /LANG=1036 "ProductVersion" "${version}"
VIAddVersionKey /LANG=1036 "LegalCopyright" "${nsisEsc(pkg.author || nom)}"

Section
  SetDetailsPrint both
  InitPluginsDir
${verifs}
  DetailPrint "Assemblage des ${parties.length} parties…"
  nsExec::ExecToLog '"$SYSDIR\\cmd.exe" /c copy /b ${liste.replace(/'/g, '')} "$PLUGINSDIR\\${nsisEsc(installeur)}"'
  Pop $0
  StrCmp $0 "0" +3 0
    MessageBox MB_ICONSTOP "L'assemblage a échoué (code $0). Vérifiez l'espace disque libre."
    Quit
  DetailPrint "Vérification de l'empreinte SHA-256…"
  nsExec::ExecToStack \`${process.env.ASSEMBLEUR_TEST_HASH || `"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '$PLUGINSDIR\\${nsisEsc(installeur)}').Hash"`}\`
  Pop $0
  Pop $1
  StrCpy $1 $1 64
  StrCmp $1 "${empreinte}" ok 0
    Delete "$PLUGINSDIR\\${nsisEsc(installeur)}"
    MessageBox MB_ICONSTOP "Fichier corrompu : l'empreinte ne correspond pas.$\\r$\\nRetéléchargez les parties.$\\r$\\n$\\r$\\nAttendue : ${empreinte}$\\r$\\nObtenue : $1"
    Quit
  ok:
  DetailPrint "Fichier intact. Lancement de l'installeur de ${nsisEsc(nom)}…"
  HideWindow
  ExecWait '"$PLUGINSDIR\\${nsisEsc(installeur)}"'
  Delete "$PLUGINSDIR\\${nsisEsc(installeur)}"
  Quit
SectionEnd
`;
const nsi = path.join(os.tmpdir(), `assembleur-${process.pid}.nsi`);
fs.writeFileSync(nsi, '﻿' + script, 'utf8');
const env = { ...process.env, NSISDIR: path.resolve(path.dirname(makensis), '..') };
try {
  execFileSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', nsi], { stdio: 'inherit', env });
  if (process.env.ASSEMBLEUR_GARDER_NSI) fs.copyFileSync(nsi, process.env.ASSEMBLEUR_GARDER_NSI);
} finally { fs.rmSync(nsi, { force: true }); }
console.log(`✓ ${path.relative(RACINE, sortie)} (${(fs.statSync(sortie).size / 1024).toFixed(0)} Ko)`);
