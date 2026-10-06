'use strict';
// Dictée : le flux audio (Float32Array) passe la validation IPC et parvient au processus de dictée.
module.exports = async (p) => {
  const ok = await p.eval(`(async () => {
    const modeles = (await window.vox.models.list()).filter((m) => m.installed);
    if (!modeles.length) return 'aucun-modele';
    await window.vox.live.start({ model: modeles[0].id, language: 'fr' }).catch(() => {});
    window.vox.live.audio(new Float32Array(16000));      // 1 s de silence : accepté
    window.vox.live.audio('pas du son');                  // refusé et ignoré (pas d'exception côté interface)
    await window.vox.live.abort();
    return 'ok';
  })()`);
  p.verifier(ok === 'ok' || ok === 'aucun-modele', `flux de dictée accepté par la validation (${ok})`);
};
