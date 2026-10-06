'use strict';
// Scénario de bout en bout pour scripts/piloter.js : import d'un texte, onglets Statistiques et Origine IA,
// historique, coffre à secrets (clé d'API jamais renvoyée à l'interface), carte Mises à jour, captures.
const fs = require('fs');
const path = require('path');

module.exports = async (p) => {
  // 1. fichier texte réel importé sans boîte de dialogue (fonction exposée par l'interface)
  const texte = path.join(p.dossierTemp, 'cours.txt');
  fs.writeFileSync(texte, ['Introduction. Le licenciement pour motif personnel repose sur une cause réelle et sérieuse.',
    'Il est important de noter que cette exigence protège le salarié. En outre, la procédure comporte un entretien préalable.',
    'Section 1. La cause réelle. La cause doit exister et être exacte ; elle ne peut pas être inventée par l’employeur.',
    'Section 2. La cause sérieuse. Elle doit être suffisamment grave pour justifier la rupture du contrat de travail.',
    'En conclusion, le respect de la procédure garantit un équilibre entre les droits de chacun. N’hésitez pas à relire vos notes.'].join('\n\n'));
  await p.eval(`window.VF.importTexts([${JSON.stringify(texte)}], true)`);
  await p.attendre('.result.is-text', 15000);
  p.verifier((await p.eval('window.VF.doc && window.VF.doc.segments.length')) >= 5, 'texte importé et affiché');
  await p.capture('e2e-texte');

  // 2. onglets Statistiques et Origine IA (indices de style, sans modèle)
  await p.clic('[data-tab="stats"]'); await p.pause(300);
  p.verifier((await p.texte('#statsOut')).includes('Mots'), 'statistiques du texte');
  await p.clic('[data-tab="origin"]'); await p.pause(400);
  const verdict = await p.texte('#originOut .verdict h3');
  p.verifier(/IA|personne|Indécis|court/.test(verdict), `origine IA : « ${verdict.trim()} »`);
  await p.capture('e2e-origine');

  // 3. historique : le document est enregistré
  const hist = await p.eval('window.vox.history.list().then((l) => l.length)');
  p.verifier(hist >= 1, 'document présent dans l’historique');

  // 4. coffre à secrets : la clé n'est jamais renvoyée en clair
  await p.ecran('settings');
  await p.eval(`window.vox.secrets.enregistrer('ai_api_key', 'sk-e2e-0123456789abcdef')`);
  const reglages = await p.eval('window.vox.settings.get()');
  p.verifier(reglages.ai.apiKeySet === true && reglages.ai.apiKey === '', 'clé d’API dans le coffre, jamais renvoyée à l’interface');
  await p.eval(`window.vox.secrets.enregistrer('ai_api_key', '')`);
  p.verifier((await p.eval('window.vox.settings.get()')).ai.apiKeySet === false, 'clé d’API effacée');

  // 5. mises à jour : carte présente, état « non configuré » tant qu'aucun jeton n'est fourni
  const statut = await p.texte('#majStatut');
  p.verifier(statut && statut.length > 0, `état des mises à jour : « ${statut} »`);
  await p.eval(`document.querySelector('#majStatut').scrollIntoView({ block: 'center' })`); await p.pause(200);
  await p.capture('e2e-parametres');

  // 6. canal IPC hors liste blanche refusé par le preload
  const refuse = await p.eval(`window.vox.history.get('../../etc/passwd').then(() => 'accepté', (e) => e.message)`);
  p.verifier(/format|refusé|invalide/i.test(refuse), `identifiant hostile refusé par la validation (${refuse})`);
};
