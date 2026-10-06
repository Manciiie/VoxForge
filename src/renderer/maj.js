/* VoxForge — mises à jour : fenêtre « Mise à jour disponible » + carte dans Paramètres.
   Rien n'est téléchargé sans un clic sur « Télécharger et installer ». */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const VF = window.VF;
  const fenetre = $('#majFenetre');
  const statut = $('#majStatut');
  const boutonVerifier = $('#btnMajVerifier');
  const mo = (o) => `${(o / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
  const dateFr = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const erreur = (e) => VF.toast(VF.esc(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'error', 8000);
  let fermeeParUtilisateur = false;
  const ouvrir = () => { fenetre.hidden = false; };
  const fermer = () => { fenetre.hidden = true; fermeeParUtilisateur = true; };

  function boutons({ telecharger = false, installer = false, plusTard = true, ignorer = false, textePlusTard = 'Plus tard' }) {
    $('#majTelecharger').hidden = !telecharger;
    $('#majInstaller').hidden = !installer;
    $('#majPlusTard').hidden = !plusTard;
    $('#majPlusTard').textContent = textePlusTard;
    $('#majIgnorer').hidden = !ignorer;
  }

  function afficher(e) {
    const libelles = {
      inactif: `Version ${e.versionActuelle || ''}`,
      'non-configure': e.message || 'Mises à jour non configurées dans cette version.',
      verification: 'Recherche de mises à jour…',
      'a-jour': `Version ${e.versionActuelle} — vous avez la dernière version.`,
      ignoree: `Version ${e.version} disponible (ignorée).`,
      disponible: `Version ${e.version} disponible.`,
      telechargement: `Téléchargement de la version ${e.version}… ${e.pourcent ?? 0} %`,
      pret: `Version ${e.version} prête : elle sera installée à la fermeture.`,
      erreur: e.message || 'Erreur de mise à jour.',
    };
    statut.textContent = libelles[e.etat] || '';
    boutonVerifier.disabled = ['verification', 'telechargement'].includes(e.etat);
    $('#majErreur').hidden = true;
    $('#majProgression').hidden = true;
    switch (e.etat) {
      case 'disponible':
        fermeeParUtilisateur = false;
        $('#majTitre').textContent = 'Mise à jour disponible';
        $('#majResume').textContent = [`Version ${e.version} (vous avez la ${e.versionActuelle})`, e.date ? `publiée le ${dateFr(e.date)}` : '', e.taille ? mo(e.taille) : ''].filter(Boolean).join(' · ');
        $('#majNotes').textContent = e.notes || '';
        boutons({ telecharger: true, ignorer: true });
        ouvrir();
        break;
      case 'telechargement':
        $('#majTitre').textContent = 'Téléchargement de la mise à jour';
        $('#majProgression').hidden = false;
        $('#majBarre').style.width = `${e.pourcent || 0}%`;
        $('#majProgressionTexte').textContent = e.total ? `${mo(e.transfere)} / ${mo(e.total)}${e.vitesse ? ` · ${mo(e.vitesse)}/s` : ''}` : 'Préparation…';
        boutons({ textePlusTard: 'Continuer en arrière-plan' });
        if (!fermeeParUtilisateur) ouvrir();
        break;
      case 'pret':
        $('#majTitre').textContent = 'Mise à jour prête';
        $('#majResume').textContent = `La version ${e.version} est téléchargée et vérifiée.`;
        $('#majNotes').textContent = '';
        boutons({ installer: true, textePlusTard: 'À la fermeture' });
        ouvrir();
        break;
      case 'erreur':
        if (e.manuel) {
          $('#majTitre').textContent = 'Mise à jour impossible';
          $('#majResume').textContent = ''; $('#majNotes').textContent = '';
          $('#majErreur').textContent = e.message; $('#majErreur').hidden = false;
          boutons({ textePlusTard: 'Fermer' });
          ouvrir();
        }
        break;
      case 'a-jour':
        if (e.manuel) VF.toast(`Vous avez la dernière version (${VF.esc(e.versionActuelle)}).`, 'ok');
        break;
      case 'non-configure':
        if (e.manuel) VF.toast(VF.esc(e.message), 'error', 6000);
        break;
      default: break;
    }
  }

  $('#majTelecharger').onclick = () => window.vox.majs.telecharger().catch(erreur);
  $('#majInstaller').onclick = () => window.vox.majs.installer().catch(erreur);
  $('#majPlusTard').onclick = fermer;
  $('#majFermer').onclick = fermer;
  $('#majIgnorer').onclick = async () => { await window.vox.majs.ignorer().catch(erreur); fermer(); VF.toast('Cette version ne sera plus proposée au démarrage.'); };
  fenetre.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fermer(); });
  boutonVerifier.onclick = () => window.vox.majs.verifier().catch(erreur);
  $('#setMajDemarrage').onchange = (e) => VF.setSetting({ verifierMajAuDemarrage: e.target.checked });

  window.addEventListener('DOMContentLoaded', async () => {
    try {
      $('#setMajDemarrage').checked = (VF.settings || {}).verifierMajAuDemarrage !== false;
      window.vox.majs.surChangement(afficher);
      afficher(await window.vox.majs.etat());
    } catch (e) { window.vox.log('Mises à jour : ' + (e && e.message)); }
  });
  // VF.settings peut être chargé après DOMContentLoaded : on resynchronise la case à l'ouverture des paramètres
  document.addEventListener('click', (e) => { if (e.target.closest('[data-view="settings"]')) $('#setMajDemarrage').checked = (VF.settings || {}).verifierMajAuDemarrage !== false; });
})();
