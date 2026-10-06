/* Applique le thème dès le chargement (avant l'affichage) pour éviter tout flash de couleur. */
(function () {
  try {
    const q = new URLSearchParams(location.search);
    const t = q.get('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    const a = q.get('accent'); if (/^#[0-9a-f]{3,8}$/i.test(a || '')) document.documentElement.style.setProperty('--accent', a);
  } catch (e) { /* */ }
})();
