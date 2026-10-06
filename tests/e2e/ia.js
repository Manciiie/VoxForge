'use strict';
// Scénario IA (processus utilitaire + modèle local) : à lancer avec un modèle GGUF visible par l'app
// (dossier LM Studio ~/.lmstudio/models). Vérifie que le processus IA démarre dans la version empaquetée
// et qu'une mesure « Origine IA » aboutit.
const fs = require('fs');
const path = require('path');

module.exports = async (p) => {
  const modeles = await p.eval('window.vox.llm.list().then((l) => l.filter((m) => m.installed).map((m) => m.id))');
  p.verifier(modeles.length >= 1, `modèle IA disponible : ${modeles[0]}`);
  await p.eval(`window.VF.setSetting({ ai: { provider: 'local', localModel: ${JSON.stringify(modeles[0])}, gpu: 'off' }, threads: 2 })`);
  const texte = path.join(p.dossierTemp, 'texte.txt');
  fs.writeFileSync(texte, 'Le licenciement pour motif personnel repose sur une cause réelle et sérieuse. '.repeat(12) + '\n\n' + 'Il est important de noter que la procédure protège le salarié. '.repeat(10));
  await p.eval(`window.VF.importTexts([${JSON.stringify(texte)}], true)`);
  await p.attendre('.result.is-text', 15000);
  await p.clic('[data-tab="origin"]'); await p.pause(300);
  await p.clic('#btnOrigin');
  const fin = Date.now() + 240000;
  while (Date.now() < fin && !(await p.eval('!!(window.VF.doc && window.VF.doc.aiOrigin)'))) await p.pause(1000);
  p.verifier(await p.eval('!!(window.VF.doc && window.VF.doc.aiOrigin && window.VF.doc.aiOrigin.measure.tokens > 0)'), 'mesure par le modèle IA terminée (processus IA opérationnel)');
  await p.capture('e2e-ia-origine');
};
