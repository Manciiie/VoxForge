'use strict';
// Scénario utilisé par tester-maj.js (mode dans FORGE_TEST_MAJ_MODE).

const visible = (p) => p.eval('!document.getElementById("majFenetre").hidden');

async function attendreVisible(p, ms = 20000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await visible(p)) return true; await p.pause(200); }
  return false;
}

async function attendreEtat(p, etats, ms = 60000) {
  const fin = Date.now() + ms;
  let e;
  while (Date.now() < fin) {
    e = await p.eval('window.vox.majs.etat()');
    if (etats.includes(e.etat)) return e;
    await p.pause(250);
  }
  throw new Error(`État attendu ${etats.join('/')}, obtenu ${e && e.etat}`);
}

module.exports = async (p) => {
  const mode = process.env.FORGE_TEST_MAJ_MODE;

  if (mode === 'a-jour' || mode === 'hors-ligne') {
    await p.pause(9000); // la vérification a lieu ~4 s après l'ouverture
    p.verifier(!(await visible(p)), `${mode} : aucune fenêtre ne s'ouvre au démarrage`);
    await p.ecran('settings');
    await attendreEtat(p, ['a-jour', 'erreur', 'non-configure'], 15000); // fin de la vérification du démarrage
    await p.clic('#btnMajVerifier');
    if (mode === 'a-jour') {
      await attendreEtat(p, ['a-jour']);
      p.verifier(/dernière version/.test(await p.texte('#majStatut')), 'a-jour : « dernière version » affiché dans Paramètres');
    } else {
      p.verifier(await attendreVisible(p, 30000), 'hors-ligne : recherche manuelle -> fenêtre d\'explication');
      p.verifier(/connexion/.test(await p.texte('#majErreur')), 'hors-ligne : message « Pas de connexion à internet »');
      await p.capture('maj-hors-ligne');
    }
    return;
  }

  p.verifier(await attendreVisible(p), 'la fenêtre « Mise à jour disponible » s\'ouvre au démarrage');
  const resume = await p.texte('#majResume');
  const notes = await p.texte('#majNotes');
  p.verifier(/9\.9\.9/.test(resume) && /vous avez/.test(resume), `résumé correct : ${resume}`);
  p.verifier(notes.includes('Export en PDF') && !/alert|<script/.test(notes), 'notes de version en texte brut (script retiré)');
  p.verifier(!(await p.eval('document.getElementById("majTelecharger").hidden')), 'bouton « Télécharger et installer » présent');
  const etatAvant = await p.eval('window.vox.majs.etat()');
  p.verifier(etatAvant.etat === 'disponible', 'rien n\'est téléchargé avant l\'accord');

  if (mode === 'normal') {
    await p.capture('maj-1-disponible');
    await p.clic('#majPlusTard');
    p.verifier(!(await visible(p)), '« Plus tard » ferme la fenêtre');
    await p.ecran('settings');
    p.verifier(/9\.9\.9 disponible/.test(await p.texte('#majStatut')), 'Paramètres indique la version disponible');
    await p.clic('#btnMajVerifier');
    p.verifier(await attendreVisible(p), '« Rechercher maintenant » rouvre la fenêtre');
    await p.clic('#majTelecharger');
    await attendreEtat(p, ['telechargement']);
    await p.pause(400);
    await p.capture('maj-2-telechargement');
    const fin = await attendreEtat(p, ['pret', 'erreur']);
    p.verifier(fin.etat === 'pret', `téléchargement terminé et empreinte vérifiée (${fin.message || 'ok'})`);
    p.verifier(!(await p.eval('document.getElementById("majInstaller").hidden')), 'bouton « Redémarrer maintenant » proposé');
    await p.capture('maj-3-prete');
    await p.clic('#majPlusTard');
    await p.ecran('settings');
    p.verifier(/installée à la fermeture/.test(await p.texte('#majStatut')), 'sinon installée à la fermeture');
  }

  if (mode === 'corrompu') {
    await p.clic('#majTelecharger');
    const fin = await attendreEtat(p, ['pret', 'erreur']);
    p.verifier(fin.etat === 'erreur', 'fichier dont l\'empreinte ne correspond pas : refusé');
    p.verifier(/corrompu/.test(fin.message), `message clair : ${fin.message}`);
    p.verifier(await attendreVisible(p, 3000) && /corrompu/.test(await p.texte('#majErreur')), 'erreur affichée dans la fenêtre');
    await p.capture('maj-corrompu');
  }

  if (mode === 'ignorer') {
    await p.clic('#majIgnorer');
    p.verifier(!(await visible(p)), '« Ignorer cette version » ferme la fenêtre');
    const params = await p.eval('window.vox.settings.get()');
    p.verifier(params.versionIgnoree === '9.9.9', 'version ignorée mémorisée');
  }
};
