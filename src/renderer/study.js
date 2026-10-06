/* VoxForge — outils de révision : textes importés, questions sur les cours, plan du cours,
   vocabulaire du cours, accélération par carte graphique. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const VF = window.VF;
  const esc = VF.esc;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const cleanErr = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

  // =====================================================================================
  // Textes importés
  // =====================================================================================
  async function importTexts(paths, openFirst = true) {
    if (!paths || !paths.length) return;
    const t = VF.toast(`Import de ${paths.length} fichier${paths.length > 1 ? 's' : ''} texte…`, '', 60000);
    let r;
    try { r = await window.vox.text.import(paths); } catch (e) { t.remove(); VF.toast(esc(cleanErr(e)), 'error', 8000); return; }
    t.remove();
    for (const e of r.errors) VF.toast(`${esc(e.file)} : ${esc(e.message)}`, 'error', 9000);
    if (r.done.length) {
      VF.toast(`${r.done.length} texte${r.done.length > 1 ? 's importés' : ' importé'} ✔ — traduction, résumé, Transformer, statistiques et Questions sont disponibles.`, 'ok', 6000);
      if (openFirst) {
        const h = await window.vox.history.get(r.done[0].id);
        VF.openHistory(h);
      }
    }
    renderTexts();
  }
  VF.importTexts = importTexts;

  async function renderTexts() {
    const box = $('#txList'); if (!box) return;
    const list = (await window.vox.history.list()).filter((h) => h.source === 'text');
    box.innerHTML = list.length ? list.map((h) => `
      <div class="card tx-item" data-h="${esc(h.id)}">
        <span class="tx-ic">📄</span>
        <div class="tx-main"><div class="nm">${esc(h.name)}</div>
          <div class="meta"><span class="chip accent">${esc(window.langName(h.language) || '—')}</span><span class="chip">${(h.words || 0).toLocaleString('fr-FR')} mots</span>
          ${h.hasSummary ? '<span class="badge-ai">Résumé</span>' : ''}${(h.translations || []).length ? '<span class="badge-ai">Traduit</span>' : ''}${(h.transforms || []).length ? '<span class="badge-ai">Transformé</span>' : ''}</div>
          <div class="pv">${esc(h.preview || '')}</div><small class="muted">Importé le ${fmtDate(h.createdAt)}</small></div>
        <div class="tx-acts"><button class="btn small primary" data-tx="open">Ouvrir</button><button class="ic-btn" data-tx="del" title="Supprimer">${VF.ICONS.trash}</button></div>
      </div>`).join('')
      : '<div class="empty-state">Aucun texte importé pour l’instant. Glissez un fichier ci-dessus (ou n’importe où dans la fenêtre).</div>';
  }
  $('#txList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tx]'); const it = e.target.closest('[data-h]');
    if (!it) return;
    const id = it.dataset.h;
    if (b && b.dataset.tx === 'del') {
      if (!confirm('Supprimer ce texte importé ? (le fichier d’origine n’est pas touché)')) return;
      await window.vox.history.remove(id); renderTexts(); return;
    }
    VF.openHistory(await window.vox.history.get(id));
  });
  $('#txPick').onclick = async () => importTexts(await window.vox.text.pick());
  $('#txDrop').onclick = () => $('#txPick').click();
  $('#txDrop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('#txPick').click(); };

  // =====================================================================================
  // Plan du cours (titres repérés automatiquement)
  // =====================================================================================
  function headLabel(h) {
    return (h.label && !/^(Introduction|Conclusion)$/i.test(h.label) && !h.title.toLowerCase().startsWith(h.label.toLowerCase()) ? `${h.label} — ` : '') + h.title;
  }
  function updatePlan() {
    const d = VF.doc;
    const ol = (d && d.outline) || [];
    $('#planWrap').hidden = !ol.length;
    $('#planMenu').innerHTML = ol.map((h, i) => `<button data-plan="${i}" class="d${h.depth || 0}"><span class="pt">${d.source === 'text' ? '' : VF.E.short(h.start)}</span>${esc(headLabel(h))}</button>`).join('');
  }
  function jumpTo(segIndex, t) {
    const d = VF.doc; if (!d) return;
    const seg = $(`#segments .seg[data-i="${segIndex}"]`);
    const target = (seg && seg.previousElementSibling && seg.previousElementSibling.classList.contains('outline-h')) ? seg.previousElementSibling : seg;
    if (target && !$('#segments').hidden) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!$('#plaintext').hidden) { const h = $$('#plaintext .outline-h').find((x) => +x.dataset.t === t); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (d.source !== 'text' && VF.audio.src) VF.seek(t);
  }
  $('#btnPlan').addEventListener('click', (e) => { e.stopPropagation(); $('#planMenu').hidden = !$('#planMenu').hidden; });
  $('#planMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan]'); if (!b) return;
    const h = VF.doc.outline[+b.dataset.plan];
    $('#planMenu').hidden = true;
    if (h) jumpTo(h.segIndex, h.start);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#planWrap')) $('#planMenu').hidden = true; });
  // textes importés : cliquer un titre fait défiler (pas d'audio)
  document.addEventListener('click', (e) => {
    const h = e.target.closest('.outline-h');
    if (h && VF.doc && VF.doc.source === 'text') h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const prevRefresh = VF.refreshSegments;
  VF.refreshSegments = () => { prevRefresh(); updatePlan(); };

  // =====================================================================================
  // Vocabulaire du cours + phrases répétées (Paramètres)
  // =====================================================================================
  function drawVocab() {
    const s = VF.settings;
    $('#vocabText').value = (s.vocabulary || []).join('\n');
    const packs = (window.VoxVocabulary && window.VoxVocabulary.PACKS) || {};
    $('#vocabPacks').innerHTML = Object.entries(packs).map(([id, p]) => `
      <label class="switch mini" title="${esc(p.terms.slice(0, 30).join(', '))}…"><input type="checkbox" data-pack="${id}" ${(s.vocabPacks || []).includes(id) ? 'checked' : ''}><i></i>
      <span>Liste « ${esc(p.name)} » (${p.terms.length} termes : auteurs, juridictions, latin juridique…)</span></label>`).join('');
    $('#setEchoes').checked = s.removeEchoes !== false;
  }
  const saveVocab = VF.debounce(() => {
    const terms = [...new Set($('#vocabText').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
    VF.setSetting({ vocabulary: terms });
  }, 500);
  $('#vocabText').addEventListener('input', saveVocab);
  $('#vocabPacks').addEventListener('change', () => {
    VF.setSetting({ vocabPacks: $$('#vocabPacks [data-pack]').filter((x) => x.checked).map((x) => x.dataset.pack) });
  });
  $('#setEchoes').addEventListener('change', (e) => VF.setSetting({ removeEchoes: e.target.checked }));

  // =====================================================================================
  // Questions sur tous les cours
  // =====================================================================================
  let qa = null; // { id, question, passages, text, status }
  async function fillQaScope() {
    const sel = $('#qaScope'); const cur = sel.value;
    let projects = [];
    try { projects = await window.vox.projects.list(); } catch { /* */ }
    sel.innerHTML = '<option value="">Tous vos cours</option><option value="audio">Transcriptions audio</option><option value="text">Textes importés</option>' +
      (projects.length ? `<optgroup label="Un projet">${projects.map((p) => `<option value="project:${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>` : '');
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    const lang = $('#qaLang');
    if (!lang.options.length) VF.fillLangSelect(lang, (VF.settings.ai || {}).summaryLang || 'fr', 'Langue de la question');
    $('#qaEngine').textContent = VF.ai.hasEngine() ? VF.ai.engineLabel() : 'Sans modèle IA : seuls les passages sont affichés';
  }
  function citeHtml(text) {
    // [1], [2][3] → liens vers les sources
    return window.Markdown.render(text).replace(/\[(\d{1,2})\]/g, (m, n) => (qa && qa.passages[+n - 1] ? `<a class="cite" data-cite="${+n - 1}" title="${esc(qa.passages[+n - 1].title)} — ${esc(qa.passages[+n - 1].time)}">${n}</a>` : m));
  }
  function drawQa() {
    const out = $('#qaOut');
    if (!qa) { out.innerHTML = ''; $('#qaProgress').hidden = true; return; }
    $('#qaProgress').hidden = !qa.running;
    if (qa.running) $('#qaProgress .txt').textContent = qa.status || 'Recherche…';
    const answer = qa.text ? `<div class="qa-answer md">${citeHtml(qa.text)}</div>` : qa.noEngine ? `<div class="qa-answer muted">Installez un modèle IA (onglet Modèles) pour obtenir une réponse rédigée. Voici les passages de vos cours qui en parlent :</div>` : '';
    const src = qa.passages.length ? `<h5>Sources</h5><div class="qa-sources">${qa.passages.map((p, i) => `
      <div class="qa-src card" data-src="${i}"><span class="n">${i + 1}</span><div><div class="nm">${p.source === 'text' ? '📄 ' : ''}${esc(p.title)} <span class="chip">${p.source === 'text' ? 'texte' : esc(p.time)}</span></div>
      <div class="pv">${esc(p.text.length > 420 ? p.text.slice(0, 420) + '…' : p.text)}</div></div></div>`).join('')}</div>` : '';
    out.innerHTML = `<div class="qa-q">${esc(qa.question)}</div>${answer}${src}`;
  }
  async function ask() {
    const question = $('#qaInput').value.trim();
    if (!question) { $('#qaInput').focus(); return; }
    if (qa && qa.running) return;
    const id = uid();
    qa = { id, question, passages: [], text: '', running: true, status: 'Recherche dans vos cours…' };
    drawQa();
    try { qa.passages = await window.vox.qa.search(question, $('#qaScope').value); } catch (e) { qa.running = false; VF.toast(esc(cleanErr(e)), 'error', 8000); drawQa(); return; }
    if (!qa.passages.length) { qa.running = false; qa.text = 'Aucun passage de vos cours ne parle de cela. Essayez d’autres mots (un nom, une notion), ou vérifiez l’orthographe.'; drawQa(); return; }
    if (!VF.ai.hasEngine()) { qa.running = false; qa.noEngine = true; drawQa(); return; }
    qa.status = 'Lecture des passages par l’IA…'; drawQa();
    const vocabulary = await window.vox.vocab.for('').catch(() => []);
    try {
      await window.vox.ai.run(id, 'qa', { question, passages: qa.passages, lang: $('#qaLang').value || 'fr', vocabulary });
    } catch (e) { qa.running = false; VF.toast(esc(cleanErr(e)), 'error', 8000); drawQa(); }
  }
  window.vox.ai.onEvent((ev) => {
    if (!qa || ev.id !== qa.id) return;
    if (ev.type === 'status') qa.status = ev.message;
    if (ev.type === 'progress') { if (ev.message) qa.status = ev.message; if (ev.text != null) qa.text = ev.text; }
    if (ev.type === 'done') { qa.running = false; qa.text = (ev.result && ev.result.text) || qa.text; }
    if (ev.type === 'error') { qa.running = false; VF.toast(esc(ev.message), 'error', 9000); }
    if (ev.type === 'cancelled') { qa.running = false; }
    drawQa();
  });
  $('#qaAsk').onclick = ask;
  $('#qaInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  $('#qaCancel').onclick = () => { if (qa && qa.running) window.vox.ai.cancel(qa.id); };
  $('#qaOut').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cite]') || e.target.closest('[data-src]');
    if (!c || !qa) return;
    const p = qa.passages[+(c.dataset.cite ?? c.dataset.src)]; if (!p) return;
    if (e.target.closest('[data-cite]')) { const card = $(`#qaOut [data-src="${c.dataset.cite}"]`); if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1200); } return; }
    const h = await window.vox.history.get(p.docId).catch(() => null);
    if (!h) { VF.toast('Ce document n’existe plus.'); return; }
    VF.openHistory(h);
    setTimeout(() => {
      const d = VF.doc; if (!d) return;
      const i = d.segments.findIndex((s) => s.start >= p.start - 0.01);
      jumpTo(Math.max(0, i), p.start);
      const seg = $(`#segments .seg[data-i="${Math.max(0, i)}"]`);
      if (seg) { seg.classList.add('flash'); setTimeout(() => seg.classList.remove('flash'), 1600); }
    }, 350);
  });

  // =====================================================================================
  // Carte graphique (Modèles)
  // =====================================================================================
  let gpuState = null; let gpuProg = null;
  async function refreshGpu() {
    try { gpuState = await window.vox.gpu.status(); } catch { gpuState = null; }
    drawGpu();
  }
  function drawGpu() {
    const card = $('#gpuCard'); if (!card) return;
    const g = gpuState;
    if (!g || !g.info) { card.hidden = true; return; }
    card.hidden = false;
    const info = g.info;
    const gb = (mb) => (mb / 1024).toFixed(1).replace('.', ',') + ' Go';
    const sizeGo = (g.total / 1073741824).toFixed(1).replace('.', ',');
    let body = '';
    if (!info.ok && !g.installed) {
      body = `<div class="gpu-line"><b>Accélération par carte graphique : indisponible sur ce PC</b><small>${esc(info.reason || '')} La transcription reste rapide sur le processeur.</small></div>`;
    } else if (gpuProg && (gpuProg.phase === 'download' || gpuProg.phase === 'verify' || gpuProg.phase === 'extract')) {
      const ratio = gpuProg.total ? gpuProg.done / gpuProg.total : 0;
      const label = gpuProg.phase === 'download' ? `Téléchargement — ${esc(gpuProg.label || '')} · ${VF.fmtBytes(gpuProg.done)} / ${VF.fmtBytes(gpuProg.total)}`
        : gpuProg.phase === 'verify' ? `Vérification — ${esc(gpuProg.label || '')}` : `Installation — ${esc(gpuProg.label || '')}`;
      body = `<div class="gpu-line"><b>Accélération par carte graphique — ${esc(info.name || '')}</b><small>${label}</small></div>
        <div class="progress"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>
        <div class="gpu-acts"><button class="btn ghost small danger" data-gpu="cancel">Annuler</button></div>`;
    } else if (g.testing || (gpuProg && gpuProg.phase === 'test')) {
      body = `<div class="gpu-line"><b>Test de vitesse en cours…</b><small>${esc(gpuProg && gpuProg.label ? 'Modèle : ' + gpuProg.label : '')} — comparaison carte graphique / processeur (quelques minutes). La carte graphique ne sera utilisée que si elle va réellement plus vite.</small></div><div class="progress indeterminate"><i></i></div>`;
    } else if (!g.installed) {
      body = `<div class="gpu-line"><b>Carte graphique compatible : ${esc(info.name)} (${gb(info.vramMB)})</b>
        <small>La transcription peut être accélérée en l’exécutant sur la carte graphique. Il faut d’abord télécharger le pack d’accélération NVIDIA (≈ ${sizeGo} Go, une seule fois). Un test de vitesse décide ensuite automatiquement, modèle par modèle, si la carte graphique est utilisée.</small></div>
        <div class="gpu-acts"><button class="btn primary small" data-gpu="install">Installer l’accélération (${sizeGo} Go)</button></div>`;
    } else {
      const bench = (g.settings && g.settings.bench) || {};
      const nameOf = (id) => (id === 'large-v3' ? 'Large v3' : id === 'turbo' ? 'Large v3 Turbo' : id === 'parakeet' ? 'Parakeet v3' : id[0].toUpperCase() + id.slice(1));
      const vram = (info.vramMB || 0) / 1024;
      const variants = g.variants || {};
      const ids = [...new Set([...Object.keys(variants), ...Object.keys(bench)])];
      const rows = ids.map((id) => {
        const b = bench[id]; const v = variants[id];
        const gain = !b ? '<span class="muted">pas encore testé</span>' : b.error ? `<span class="muted">${esc(b.error)}</span>` : `×${String(b.speedup).replace('.', ',')} <small class="muted">(${b.variant === 'float32' ? 'version carte graphique' : 'version compressée'})</small>`;
        const uses = b && b.ok ? '<span class="chip accent">carte graphique</span>' : '<span class="chip">processeur</span>';
        let act = '';
        if (v && !v.installed) {
          if (gpuProg && gpuProg.phase && gpuProg.phase.startsWith('model-') && gpuProg.id === id) act = `<div class="progress"><i style="width:${(gpuProg.total ? (gpuProg.done / gpuProg.total) * 100 : 0).toFixed(1)}%"></i></div><small class="muted">${gpuProg.phase === 'model-verify' ? 'Vérification…' : `${VF.fmtBytes(gpuProg.done || 0)} / ${VF.fmtBytes(gpuProg.total || 0)}`}</small> <button class="btn ghost small danger" data-gpu="cancel">Annuler</button>`;
          else if (vram && vram < v.vramGB - 0.3) act = `<small class="muted">Version carte graphique : ${String(v.vramGB).replace('.', ',')} Go de mémoire vidéo nécessaires</small>`;
          else act = `<button class="btn small primary" data-gpu-model="${esc(id)}">Télécharger la version carte graphique (${VF.fmtBytes(v.size)})</button>`;
        } else if (v && v.installed) act = `<small class="muted">Version carte graphique installée</small> <button class="ic-btn" data-gpu-rm="${esc(id)}" title="Supprimer la version carte graphique">${VF.ICONS.trash}</button>`;
        return `<tr><td>${esc(nameOf(id))}</td><td>${gain}</td><td>${uses}</td><td class="gpu-act">${act}</td></tr>`;
      }).join('');
      const off = g.settings && g.settings.use === 'off';
      const needVariant = Object.values(variants).some((v) => !v.installed) && Object.values(bench).some((b) => b && !b.ok && b.variant !== 'float32');
      body = `<div class="gpu-line"><b>Accélération par carte graphique — ${esc(info.name || '')}</b>
        <small>${off ? 'Désactivée : tout est calculé par le processeur.' : 'Utilisée automatiquement pour les modèles où elle va plus vite que le processeur.'}</small></div>
        ${needVariant ? '<div class="gpu-hint">Les modèles installés sont des versions <b>compressées pour le processeur</b> : sur la carte graphique, une partie de leurs calculs repasse par le processeur, d’où un gain proche de ×1. Téléchargez la <b>version carte graphique</b> (pleine précision) d’un modèle : elle tourne entièrement sur la carte, et un nouveau test décide automatiquement.</div>' : ''}
        ${rows ? `<table class="gpu-table"><tr><th>Modèle</th><th>Gain mesuré</th><th>Utilise</th><th></th></tr>${rows}</table>` : '<small class="muted">Aucun test pour l’instant.</small>'}
        <div class="gpu-acts"><label class="switch mini"><input type="checkbox" data-gpu="use" ${off ? '' : 'checked'}><i></i><span>Utiliser la carte graphique</span></label>
        <span class="spacer"></span><button class="btn small" data-gpu="test">Refaire le test</button><button class="btn ghost small danger" data-gpu="remove">Désinstaller</button></div>`;
    }
    card.innerHTML = body;
  }
  $('#gpuCard').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-gpu]'); if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.gpu;
    if (a === 'install') {
      gpuProg = { phase: 'download', done: 0, total: gpuState.total }; drawGpu();
      const r = await window.vox.gpu.install();
      gpuProg = null;
      if (r.ok) VF.toast('Accélération par carte graphique installée et testée ✔', 'ok', 6000);
      else if (!r.cancelled) VF.toast('Carte graphique : ' + esc(r.error || 'échec'), 'error', 10000);
      refreshGpu();
    }
    if (a === 'cancel') window.vox.gpu.cancel();
    if (a === 'test') { gpuProg = { phase: 'test' }; drawGpu(); const r = await window.vox.gpu.test(); gpuProg = null; if (!r.ok) VF.toast(esc(r.error), 'error', 8000); refreshGpu(); }
    if (a === 'remove') { if (!confirm('Désinstaller le pack d’accélération et les versions carte graphique des modèles ?')) return; await window.vox.gpu.remove(); refreshGpu(); }
  });
  $('#gpuCard').addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-gpu-model]');
    if (dl) {
      const id = dl.dataset.gpuModel;
      gpuProg = { phase: 'model-download', id, done: 0, total: ((gpuState.variants || {})[id] || {}).size || 0 }; drawGpu();
      const r = await window.vox.gpu.installModel(id);
      gpuProg = null;
      if (r.ok) { const b = ((await window.vox.gpu.status()).settings.bench || {})[id]; VF.toast(b && b.ok ? `Version carte graphique installée : transcription ×${String(b.speedup).replace('.', ',')} plus rapide ✔` : 'Version carte graphique installée, mais pas plus rapide que le processeur sur ce PC : le processeur reste utilisé.', b && b.ok ? 'ok' : '', 8000); }
      else if (!r.cancelled) VF.toast('Carte graphique : ' + esc(r.error || 'échec'), 'error', 10000);
      refreshGpu(); return;
    }
    const rm = e.target.closest('[data-gpu-rm]');
    if (rm) {
      if (!confirm('Supprimer la version carte graphique de ce modèle ?')) return;
      try { await window.vox.gpu.removeModel(rm.dataset.gpuRm); } catch (err) { VF.toast(esc(cleanErr(err)), 'error', 7000); }
      refreshGpu();
    }
  });
  $('#gpuCard').addEventListener('change', async (e) => {
    if (e.target.dataset.gpu === 'use') { await VF.setSetting({ gpu: { use: e.target.checked ? 'auto' : 'off' } }); refreshGpu(); }
  });
  let lastDraw = 0;
  window.vox.gpu.onProgress((p) => {
    if (p.phase === 'tested' || p.phase === 'done' || p.phase === 'model-done') { gpuProg = p.phase === 'tested' ? null : { phase: 'test' }; refreshGpu(); return; }
    gpuProg = p;
    const now = Date.now(); if (now - lastDraw < 250) return; lastDraw = now;
    drawGpu();
  });

  // =====================================================================================
  // Navigation / documents
  // =====================================================================================
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === 'texts') renderTexts();
    if (b.dataset.view === 'qa') { fillQaScope(); setTimeout(() => $('#qaInput').focus(), 50); }
    if (b.dataset.view === 'models') refreshGpu();
    if (b.dataset.view === 'settings') drawVocab();
  }));
  const prevOnDoc = VF.onDoc;
  VF.onDoc = (d) => { if (prevOnDoc) prevOnDoc(d); updatePlan(); };
  const prevInit = VF.init;
  VF.init = async () => { if (prevInit) await prevInit(); drawVocab(); };
  VF.renderTexts = renderTexts;
})();
