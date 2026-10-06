/* VoxForge — nettoyage du texte, dictionnaire personnalisé et éditeur de sous-titres */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const VF = window.VF;
  const { esc, E } = VF;
  const Dict = window.VoxDictionary;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let staleView = null;
  const docReady = (d) => d && d.segments && d.segments.length && (!d.job || d.job.status === 'done');

  // =====================================================================================
  // Opérations sur les segments (les traductions restent alignées)
  // =====================================================================================
  function splitWords(text, ratio) {
    const w = String(text || '').split(/\s+/).filter(Boolean);
    if (w.length < 2) return [text || '', ''];
    const k = Math.min(w.length - 1, Math.max(1, Math.round(w.length * ratio)));
    return [w.slice(0, k).join(' '), w.slice(k).join(' ')];
  }
  const forTr = (d, fn) => { for (const t of Object.values(d.translations || {})) if (t && Array.isArray(t.texts)) fn(t.texts); };
  const Ops = {
    split(d, i, t, textPos) {
      const s = d.segments[i];
      if (!(t > s.start + 0.1 && t < s.end - 0.1)) t = (s.start + s.end) / 2;
      const ratio = (t - s.start) / (s.end - s.start);
      let a, b;
      if (textPos != null && textPos > 0 && textPos < s.text.length) { a = s.text.slice(0, textPos).trim(); b = s.text.slice(textPos).trim(); } else [a, b] = splitWords(s.text, ratio);
      d.segments.splice(i, 1, { ...s, end: t, text: a }, { ...s, id: uid(), start: t, text: b });
      forTr(d, (tx) => { const [x, y] = splitWords(tx[i] || '', ratio); tx.splice(i, 1, x, y); });
    },
    merge(d, i) {
      if (i >= d.segments.length - 1) return false;
      const a = d.segments[i], b = d.segments[i + 1];
      d.segments.splice(i, 2, { ...a, end: Math.max(a.end, b.end), text: `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim() });
      forTr(d, (tx) => tx.splice(i, 2, `${tx[i] || ''} ${tx[i + 1] || ''}`.trim()));
      return true;
    },
    remove(d, i) { d.segments.splice(i, 1); forTr(d, (tx) => tx.splice(i, 1)); },
    insert(d, t) {
      let i = d.segments.findIndex((s) => s.start > t);
      if (i < 0) i = d.segments.length;
      const prev = d.segments[i - 1]; const next = d.segments[i];
      let start = Math.max(t, prev ? prev.end : 0);
      let end = Math.min(start + 2, next ? next.start : start + 2);
      if (end - start < 0.3) { start = Math.max(0, (prev ? prev.end : t)); end = start + 0.5; }
      d.segments.splice(i, 0, { id: uid(), start, end, text: 'Nouveau sous-titre', lang: d.language || '' });
      forTr(d, (tx) => tx.splice(i, 0, ''));
      return i;
    },
    shift(d, sec) {
      for (const s of d.segments) { s.start = Math.max(0, s.start + sec); s.end = Math.max(s.start + 0.1, s.end + sec); }
    },
    autoSplit(d, maxChars) {
      let n = 0;
      for (let i = 0; i < d.segments.length; i++) {
        const s = d.segments[i];
        if (s.text.length <= maxChars || s.text.split(/\s+/).length < 4) continue;
        // coupe de préférence après une ponctuation proche du milieu
        const mid = s.text.length / 2; let pos = -1; let best = Infinity;
        const re = /[.!?;,:…]\s/g; let m;
        while ((m = re.exec(s.text))) { const dd = Math.abs(m.index + 1 - mid); if (dd < best && dd < s.text.length * 0.3) { best = dd; pos = m.index + 1; } }
        if (pos < 0) { pos = s.text.indexOf(' ', Math.floor(mid)); if (pos < 0) pos = s.text.lastIndexOf(' ', Math.floor(mid)); }
        const ratio = pos / s.text.length;
        Ops.split(d, i, s.start + (s.end - s.start) * ratio, pos);
        n++; i--; // le premier morceau peut encore être trop long
      }
      return n;
    },
  };

  // ---- annuler / rétablir (par document)
  const history = new WeakMap(); // doc -> { undo: [], redo: [] }
  const snap = (d) => clone({ segments: d.segments, translations: d.translations || {} });
  function checkpoint(d, st = snap(d)) {
    const h = history.get(d) || { undo: [], redo: [] };
    h.undo.push(st); if (h.undo.length > 60) h.undo.shift(); h.redo = [];
    history.set(d, h);
    lazyCp = null;
  }
  // point de reprise « paresseux » : capturé au focus / clic, enregistré seulement à la 1re vraie modification
  // (un simple clic n'efface donc plus l'historique « Rétablir »)
  let lazyCp = null;
  const prepareCp = (d) => { lazyCp = { d, st: snap(d) }; };
  const ensureCp = (d) => { if (lazyCp && lazyCp.d === d) checkpoint(d, lazyCp.st); };
  function restore(d, st) {
    d.segments = st.segments; d.translations = st.translations;
    if (d.job) { d.job.segments = d.segments; d.job.translations = d.translations; }
  }
  function undo(d, redo = false) {
    const h = history.get(d); if (!h) return false;
    const from = redo ? h.redo : h.undo; const to = redo ? h.undo : h.redo;
    if (!from.length) return false;
    to.push(snap(d)); restore(d, from.pop());
    lazyCp = null;
    return true;
  }
  function commit(d, { structure = true } = {}) {
    if (d.job) { d.job.segments = d.segments; d.job.translations = d.translations; }
    VF.saveDoc(d);
    if (structure) VF.refreshSegments(); else staleView = d; // la vue Transcription sera rafraîchie en y revenant
    updateUndoBtn();
  }

  // =====================================================================================
  // NETTOYAGE DU TEXTE
  // =====================================================================================
  // uniquement des hésitations sans ambiguïté (« ben », « este », « tipo », « hein »… peuvent avoir un sens)
  const FILLERS = {
    fr: ['euh+', 'heu+', 'euuh', 'hum+', 'hm+', 'bah', 'beh', 'mh+', 'pff+'],
    en: ['u+m+', 'u+h+', 'uhm', 'erm+', 'hm+', 'mm+'],
    es: ['e+h+m*', 'e+m+', 'mm+'],
    de: ['ä+h+m*', 'ö+h+m*', 'hm+'],
    it: ['e+h+m+', 'mm+'],
    pt: ['é+h+', 'hum+'],
  };
  const FILLERS_ANY = ['euh+', 'u+m+', 'u+h+', 'hm+', 'mm+'];
  const endsSentence = (t) => !t || /[.!?…。！？]["»”')\]]?\s*$/.test(t);
  const KEEP_REPEAT = new Set(['nous', 'vous', 'très', 'si', 'non', 'oui', 'bien', 'that', 'had', 'very', 'no', 'yes', 'muy', 'sehr', 'molto', 'is']);
  function quickClean(text, lang, { fillers = true, prev = null } = {}) {
    let t = ' ' + text + ' ';
    lang = String(lang || '').slice(0, 2);
    if (fillers) {
      const list = FILLERS[lang] || FILLERS_ANY;
      const re = new RegExp(`(^|[\\s,.;!?…])(?:${list.join('|')})(?=[\\s,.;!?…]|$)[,…]?`, 'giu');
      for (let k = 0; k < 2; k++) t = t.replace(re, '$1');
      // répétitions immédiates : « je je », « c'est c'est », « the the »
      t = t.replace(/(^|\s)([\p{L}\p{N}'’-]+)(?:[\s,]+\2)+(?=[\s,.;!?…]|$)/giu, (m, sp, w) => (w.length < 3 || /^\d+$/.test(w) || KEEP_REPEAT.has(w.toLowerCase()) ? m : sp + w));
    }
    // français : on garde l'espace avant ; : ! ?
    t = t.replace(/\s+([,.!?…;:])/g, (m, p) => (/[;:!?]/.test(p) && lang === 'fr' ? ' ' + p : p))
      .replace(/([,;:])\s*\1+/g, '$1').replace(/^[\s,;:]+/, '').replace(/\s*,+\s*([.…])/g, '$1').replace(/,+(\s*[!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    // majuscule seulement en début de phrase (le segment précédent se termine par un point)
    if (t && endsSentence(prev)) t = t[0].toUpperCase() + t.slice(1);
    return t;
  }

  // diff mot à mot
  function wordDiff(a, b) {
    const A = a.split(/(\s+)/).filter((x) => x !== ''), B = b.split(/(\s+)/).filter((x) => x !== '');
    const n = A.length, m = B.length;
    if (n * m > 250000) return `<del>${esc(a)}</del> <ins>${esc(b)}</ins>`;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0; const out = [];
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push(esc(A[i])); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push(/^\s+$/.test(A[i]) ? A[i] : `<del>${esc(A[i])}</del>`); i++; }
      else { out.push(/^\s+$/.test(B[j]) ? B[j] : `<ins>${esc(B[j])}</ins>`); j++; }
    }
    return out.join('').replace(/<\/del>(\s*)<del>/g, '$1').replace(/<\/ins>(\s*)<ins>/g, '$1');
  }

  let clMode = 'quick';
  let proposal = null; // { doc, texts: [], accept: Set }
  let clRun = null;    // tâche IA en cours
  const panel = $('#cleanupPanel');
  function openCleanup() {
    const d = VF.doc; if (!docReady(d)) { VF.toast('Disponible quand la transcription est terminée.', 'error'); return; }
    panel.hidden = false;
    drawCleanup();
  }
  function closeCleanup() {
    panel.hidden = true; proposal = null;
    $('#diffList').hidden = true;
    const textMode = $('#resView [data-v="text"]').classList.contains('active');
    $('#segments').hidden = textMode; $('#plaintext').hidden = !textMode;
  }
  function drawCleanup() {
    $$('#clMode button').forEach((b) => b.classList.toggle('active', b.dataset.v === clMode));
    $$('[data-clai]').forEach((el) => { el.hidden = clMode !== 'ai'; });
    const r = clRun && clRun.doc === VF.doc ? clRun : null;
    VF.ai.progressUi($('#clProgress'), r);
    $('#clRun').disabled = !!clRun;
    const sum = $('#clSummary');
    if (!proposal || proposal.doc !== VF.doc) { sum.hidden = true; $('#diffList').hidden = true; return; }
    const d = proposal.doc;
    const changed = proposal.texts.map((t, i) => (t !== proposal.orig[i] ? i : -1)).filter((i) => i >= 0);
    const wordsBefore = proposal.orig.reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0);
    const wordsAfter = proposal.texts.reduce((a, t) => a + t.split(/\s+/).filter(Boolean).length, 0);
    sum.hidden = false;
    sum.innerHTML = changed.length
      ? `<b>${changed.length} segment${changed.length > 1 ? 's' : ''} modifié${changed.length > 1 ? 's' : ''}</b> · ${Math.max(0, wordsBefore - wordsAfter)} mot(s) en moins · ${proposal.accept.size} retenu(s)
         <span class="spacer"></span><button class="btn small" data-cl="none">Tout refuser</button><button class="btn small" data-cl="all">Tout accepter</button><button class="btn primary small" data-cl="apply" ${proposal.accept.size ? '' : 'disabled'}>Appliquer ${proposal.accept.size} modification${proposal.accept.size > 1 ? 's' : ''}</button>`
      : '<b>Aucune modification proposée</b> : le texte est déjà propre. <span class="spacer"></span>';
    $('#segments').hidden = true; $('#plaintext').hidden = true;
    const list = $('#diffList'); list.hidden = false;
    list.innerHTML = changed.length ? changed.map((i) => `<div class="diff-row ${proposal.accept.has(i) ? '' : 'off'}" data-di="${i}">
        <label class="chk"><input type="checkbox" ${proposal.accept.has(i) ? 'checked' : ''}></label>
        <span class="ts" data-t="${proposal.segs[i].start}">${E.short(proposal.segs[i].start)}</span>
        <div class="dtx">${wordDiff(proposal.orig[i], proposal.texts[i])}</div></div>`).join('') : '';
  }
  $('#btnCleanup').onclick = () => (panel.hidden ? openCleanup() : closeCleanup());
  $('#clClose').onclick = closeCleanup;
  $('#clMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { clMode = b.dataset.v; drawCleanup(); } });
  $('#clRun').onclick = () => {
    const d = VF.doc; if (!docReady(d)) return;
    const fillers = $('#clFillers').checked;
    if (clMode === 'quick') {
      const rules = VF.settings.dictionary || [];
      let texts = d.segments.map((s, i) => Dict.apply(quickClean(s.text, s.lang || d.language || '', { fillers, prev: i ? d.segments[i - 1].text : null }), rules).text);
      // passages recopiés par erreur quelques mots plus loin (« échos » de Whisper)
      if (fillers && window.VoxEchoes) texts = window.VoxEchoes.removeEchoes(texts.map((text) => ({ text })), { keepEmpty: true }).segments.map((x) => x.text);
      proposal = makeProposal(d, d.segments.slice(), texts);
      drawCleanup();
      return;
    }
    if (!VF.ai.hasEngine()) { VF.toast('Installez un modèle IA (onglet Modèles) ou utilisez le mode Rapide.', 'error', 6000); return; }
    const id = uid();
    clRun = { id, doc: d, segs: d.segments.slice(), status: 'Préparation…' };
    const glossary = [...new Set((VF.settings.dictionary || []).filter((r) => r.enabled !== false).map((r) => r.to).filter(Boolean))];
    window.vox.ai.run(id, 'cleanup', { segments: d.segments.map((s) => ({ text: s.text })), options: { fillers, fix: $('#clFix').checked, punct: $('#clPunct').checked, glossary, lang: d.language || '' } })
      .catch((e) => { clRun = null; VF.toast(esc(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'error', 8000); drawCleanup(); });
    drawCleanup();
  };
  window.vox.ai.onEvent((ev) => {
    if (!clRun || ev.id !== clRun.id) return;
    if (ev.type === 'status') clRun.status = ev.message;
    if (ev.type === 'progress') { clRun.ratio = ev.ratio; if (ev.message) clRun.status = ev.message; }
    if (ev.type === 'done') {
      const segs = clRun.segs;
      const texts = segs.map((s, i) => (ev.result && ev.result[i] != null ? Dict.apply(String(ev.result[i]), VF.settings.dictionary || []).text : s.text));
      proposal = makeProposal(clRun.doc, segs, texts);
      VF.toast('Nettoyage prêt : vérifiez les modifications proposées.', 'ok');
    }
    if (ev.type === 'error') VF.toast(esc(ev.message), 'error', 9000);
    if (['done', 'error', 'cancelled'].includes(ev.type)) clRun = null;
    if (VF.doc && !panel.hidden) drawCleanup();
  });
  /** Proposition liée aux objets segments (pas aux index) : une édition entre-temps ne décale rien. */
  function makeProposal(d, segs, texts) {
    const orig = segs.map((s) => s.text);
    return { doc: d, segs, orig, texts, accept: new Set(texts.map((t, i) => (t !== orig[i] ? i : -1)).filter((i) => i >= 0)) };
  }
  $('#diffList').addEventListener('change', (e) => {
    const row = e.target.closest('[data-di]'); if (!row || !proposal) return;
    const i = +row.dataset.di;
    if (e.target.checked) proposal.accept.add(i); else proposal.accept.delete(i);
    drawCleanup();
  });
  $('#diffList').addEventListener('click', (e) => { const t = e.target.closest('[data-t]'); if (t) VF.seek(+t.dataset.t); });
  $('#clSummary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cl]'); if (!b || !proposal) return;
    const d = proposal.doc;
    if (b.dataset.cl === 'none') proposal.accept.clear();
    if (b.dataset.cl === 'all') proposal.texts.forEach((t, i) => { if (t !== proposal.orig[i]) proposal.accept.add(i); });
    if (b.dataset.cl === 'apply') {
      setCleanupUndo(d);
      checkpoint(d);
      const live = new Set(d.segments);
      let n = 0, skipped = 0;
      for (const i of proposal.accept) {
        const s = proposal.segs[i];
        // segment supprimé ou modifié à la main depuis la proposition : on ne l'écrase pas
        if (live.has(s) && s.text === proposal.orig[i]) { s.text = proposal.texts[i]; n++; } else skipped++;
      }
      if (skipped) VF.toast(`${skipped} segment(s) modifié(s) entre-temps ont été laissés tels quels.`, '', 5000);
      // segments entièrement retirés (écho complet) : supprimés
      // (traductions décalées en même temps ; gardés de côté pour « Annuler le nettoyage »)
      const removed = [];
      for (let k = d.segments.length - 1; k >= 0; k--) {
        if (String(d.segments[k].text || '').trim()) continue;
        const tr = {}; for (const [l, t] of Object.entries(d.translations || {})) if (t && Array.isArray(t.texts)) tr[l] = t.texts[k];
        removed.unshift({ s: d.segments[k], prev: d.segments[k - 1] || null, tr });
        Ops.remove(d, k);
      }
      if (removed.length && Array.isArray(d.cleanupUndo)) d.cleanupUndo.removed = removed;
      commit(d);
      VF.toast(`${n} modification${n > 1 ? 's' : ''} appliquée${n > 1 ? 's' : ''} ✔ (bouton « Annuler le nettoyage » pour revenir en arrière)`, 'ok', 5000);
      closeCleanup(); updateUndoBtn();
      return;
    }
    drawCleanup();
  });
  // sauvegarde avant nettoyage : par référence de segment (reste valable après découpe/fusion d'autres lignes)
  function setCleanupUndo(d) { d.cleanupUndo = d.segments.map((s) => ({ s, text: s.text })); }
  function updateUndoBtn() {
    const d = VF.doc;
    let ok = false;
    if (d && Array.isArray(d.cleanupUndo)) { const live = new Set(d.segments); ok = d.cleanupUndo.some((u) => u && live.has(u.s) && u.s.text !== u.text) || !!(d.cleanupUndo.removed && d.cleanupUndo.removed.length); }
    $('#btnUndoClean').hidden = !ok;
  }
  $('#btnUndoClean').onclick = () => {
    const d = VF.doc; if (!d || !d.cleanupUndo) return;
    checkpoint(d);
    const live = new Set(d.segments);
    // segments supprimés par le nettoyage : remis à leur place (avec leurs traductions)
    for (const r of d.cleanupUndo.removed || []) {
      if (live.has(r.s)) continue;
      const at = r.prev ? d.segments.indexOf(r.prev) + 1 : 0;
      const i = r.prev && at === 0 ? d.segments.findIndex((x) => x.start > r.s.start) : at;
      const pos = i < 0 ? d.segments.length : i;
      d.segments.splice(pos, 0, r.s);
      for (const [l, t] of Object.entries(d.translations || {})) if (t && Array.isArray(t.texts)) t.texts.splice(pos, 0, r.tr[l] ?? '');
      live.add(r.s);
    }
    d.cleanupUndo.forEach((u) => { if (u && live.has(u.s)) u.s.text = u.text; });
    delete d.cleanupUndo;
    commit(d); updateUndoBtn();
    VF.toast('Texte d’origine restauré.');
  };

  // =====================================================================================
  // DICTIONNAIRE PERSONNALISÉ
  // =====================================================================================
  const rules = () => VF.settings.dictionary || [];
  const saveRules = async (list) => { await VF.setSetting({ dictionary: list }); drawDict(); };
  function drawDict() {
    const list = rules();
    $('#dictTable').innerHTML = list.length ? `<div class="dict-head"><span></span><span>Mot reconnu</span><span></span><span>Correction</span><span>Mot entier</span><span>Casse exacte</span><span></span></div>` +
      list.map((r, i) => `<div class="dict-row ${r.enabled === false ? 'off' : ''}" data-ri="${i}">
        <label class="switch mini"><input type="checkbox" data-rk="enabled" ${r.enabled !== false ? 'checked' : ''}><i></i></label>
        <input type="text" data-rk="from" value="${esc(r.from)}"><span>→</span><input type="text" data-rk="to" value="${esc(r.to)}">
        <label class="switch mini"><input type="checkbox" data-rk="whole" ${r.whole !== false ? 'checked' : ''}><i></i></label>
        <label class="switch mini"><input type="checkbox" data-rk="caseSensitive" ${r.caseSensitive ? 'checked' : ''}><i></i></label>
        <button class="ic-btn" data-rdel title="Supprimer">✕</button></div>`).join('')
      : '<p class="muted small-p">Aucune règle pour l’instant.</p>';
  }
  $('#dictTable').addEventListener('change', (e) => {
    const row = e.target.closest('[data-ri]'); if (!row) return;
    const list = clone(rules()); const r = list[+row.dataset.ri]; const k = e.target.dataset.rk;
    r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
    if (!r.from) list.splice(+row.dataset.ri, 1);
    saveRules(list);
  });
  $('#dictTable').addEventListener('click', (e) => { const b = e.target.closest('[data-rdel]'); if (!b) return; const list = clone(rules()); list.splice(+b.closest('[data-ri]').dataset.ri, 1); saveRules(list); });
  function addRule(from, to, opts = {}) {
    from = String(from || '').trim(); to = String(to ?? '').trim();
    if (!from) return false;
    const list = clone(rules()).filter((r) => r.from.toLowerCase() !== from.toLowerCase());
    list.push({ from, to, whole: opts.whole !== false, caseSensitive: !!opts.caseSensitive, enabled: true });
    saveRules(list);
    return true;
  }
  $('#dictAddBtn').onclick = () => {
    if (addRule($('#dictFrom').value, $('#dictTo').value)) { $('#dictFrom').value = ''; $('#dictTo').value = ''; $('#dictFrom').focus(); VF.toast('Règle ajoutée ✔', 'ok', 2000); }
  };
  ['#dictFrom', '#dictTo'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#dictAddBtn').click(); }));
  $('#dictExport').onclick = async () => {
    const csv = 'mot reconnu;correction;mot entier;casse exacte\n' + rules().map((r) => [r.from, r.to, r.whole !== false ? 'oui' : 'non', r.caseSensitive ? 'oui' : 'non'].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
    const s = await window.vox.files.exportSave({ content: csv, defaultName: 'dictionnaire-voxforge.csv', format: 'csv' });
    if (s) VF.toast('Dictionnaire exporté ✔', 'ok');
  };
  $('#dictImport').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,.txt,.tsv';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const text = await f.text();
      const list = clone(rules()); let n = 0;
      for (const line of text.split(/\r?\n/)) {
        const cells = (line.match(/("([^"]|"")*"|[^;,\t]+)(?=[;,\t]|$)/g) || []).map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
        if (cells.length < 2 || /^mot reconnu$/i.test(cells[0])) continue;
        if (list.some((r) => r.from.toLowerCase() === cells[0].toLowerCase())) continue;
        list.push({ from: cells[0], to: cells[1], whole: !/^non$/i.test(cells[2] || ''), caseSensitive: /^oui$/i.test(cells[3] || ''), enabled: true }); n++;
      }
      await saveRules(list);
      VF.toast(`${n} règle${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''} ✔`, 'ok');
    };
    inp.click();
  };
  $('#btnApplyDict').onclick = async () => {
    const d = VF.doc; if (!docReady(d)) return;
    // vocabulaire général + celui du projet qui contient ce document (sinon celui de la file d'attente)
    let pid = VF.settings.queueProject || '';
    try { const ps = await window.vox.projects.list(); const p = ps.find((x) => (x.items || []).includes(d.id)); if (p) pid = p.id; } catch { /* */ }
    const vocab = window.VoxVocabulary ? await window.vox.vocab.for(pid) : [];
    if (VF.doc !== d) return; // autre document ouvert entre-temps
    if (!rules().length && !vocab.length) { VF.toast('Votre dictionnaire et votre vocabulaire sont vides : ajoutez des mots dans Paramètres › Dictionnaire / Vocabulaire du cours, ou sélectionnez un mot puis clic droit.'); return; }
    let n = 0; const changes = [];
    const texts = d.segments.map((s) => {
      const r = Dict.apply(s.text, rules()); n += r.count;
      if (!vocab.length) return r.text;
      const v = window.VoxVocabulary.apply(r.text, vocab); n += v.count; changes.push(...v.changes);
      return v.text;
    });
    if (!n) { VF.toast('Aucun mot du dictionnaire ni du vocabulaire à corriger dans cette transcription.'); return; }
    if (changes.length) VF.toast(`Vocabulaire : ${changes.slice(0, 6).map((c) => `${VF.esc(c.from)} → <b>${VF.esc(c.to)}</b>`).join(', ')}${changes.length > 6 ? '…' : ''}`, '', 7000);
    setCleanupUndo(d); checkpoint(d);
    texts.forEach((t, i) => { d.segments[i].text = t; });
    commit(d); updateUndoBtn();
    VF.toast(`${n} correction${n > 1 ? 's' : ''} appliquée${n > 1 ? 's' : ''} ✔`, 'ok');
  };

  // clic droit sur une sélection → ajouter au dictionnaire / remplacer partout
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('#segments, #plaintext, #sbList')) return;
    const ta = e.target.closest('textarea, input');
    const sel = (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : String(window.getSelection() || '')).trim();
    if (!sel || sel.length > 60) return;
    e.preventDefault();
    $$('.ctx-menu').forEach((m) => m.remove());
    const m = document.createElement('div'); m.className = 'menu ctx-menu';
    m.innerHTML = `<button data-cx="dict">Ajouter « ${esc(sel)} » au dictionnaire…</button><button data-cx="replace">Remplacer « ${esc(sel)} » partout dans ce texte…</button><button data-cx="copy">Copier</button>`;
    document.body.appendChild(m);
    m.style.position = 'fixed'; m.style.left = Math.min(window.innerWidth - 300, e.clientX) + 'px'; m.style.top = Math.min(window.innerHeight - 140, e.clientY) + 'px';
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    m.onclick = async (ev) => {
      const b = ev.target.closest('[data-cx]'); if (!b) return; m.remove();
      if (b.dataset.cx === 'copy') { VF.copyText(sel); return; }
      const toDict = b.dataset.cx === 'dict';
      const r = await VF.modal({
        title: toDict ? 'Ajouter au dictionnaire' : 'Remplacer partout',
        body: `<label>Texte reconnu<input type="text" id="dxFrom" value="${esc(sel)}"></label><label>Remplacer par<input type="text" id="dxTo" value="${esc(sel)}"></label>
          ${toDict ? '<label class="switch mini"><input type="checkbox" id="dxNow" checked><i></i><span>Corriger aussi cette transcription maintenant</span></label>' : ''}`,
        onOpen: (bd) => { const t = $('#dxTo', bd); setTimeout(() => { t.focus(); t.select(); }, 40); },
        buttons: [{ label: 'Annuler', value: null }, { label: toDict ? 'Ajouter' : 'Remplacer', primary: true, onClick: (bd) => ({ from: $('#dxFrom', bd).value.trim(), to: $('#dxTo', bd).value, now: toDict ? $('#dxNow', bd).checked : true }) }],
      });
      if (!r || !r.from) return;
      if (toDict) addRule(r.from, r.to);
      if (r.now) {
        const d = VF.doc; if (!docReady(d)) return;
        let n = 0;
        const texts = d.segments.map((s) => { const x = Dict.apply(s.text, [{ from: r.from, to: r.to }]); n += x.count; return x.text; });
        if (n) { setCleanupUndo(d); checkpoint(d); texts.forEach((t, i) => { d.segments[i].text = t; }); commit(d); updateUndoBtn(); if (subsActive()) drawSubs(); }
        VF.toast(`${toDict ? 'Ajouté au dictionnaire. ' : ''}${n} remplacement${n > 1 ? 's' : ''} ✔`, 'ok');
      } else VF.toast('Ajouté au dictionnaire ✔ — appliqué aux prochaines transcriptions.', 'ok');
    };
  });

  // =====================================================================================
  // ÉDITEUR DE SOUS-TITRES
  // =====================================================================================
  const subsActive = () => !!$('.tab-pane.active[data-pane="subs"]') && $('#view-transcribe').classList.contains('active') && !(VF.doc && VF.doc.source === 'text');
  const sb = { sel: 0, zoom: 80, peaks: null, peaksFor: null, drag: null, raf: 0 };
  const LIMITS = { cps: 20, chars: 84, minDur: 0.7, maxDur: 7 };
  const canvas = $('#sbCanvas'); const wrap = $('#sbTimelineWrap');
  const spacer = document.createElement('div'); spacer.className = 'tl-spacer'; wrap.appendChild(spacer);
  const ctx2 = canvas.getContext('2d');
  // variables CSS lues une seule fois par dessin (getComputedStyle est coûteux à 60 i/s)
  let cssCache = null;
  const css = (v) => { if (!cssCache) cssCache = getComputedStyle(document.documentElement); return cssCache.getPropertyValue(v).trim(); };

  function parseTime(str) {
    const m = String(str).trim().replace(',', '.').match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$|^(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    if (m[4] !== undefined) return parseFloat(m[4]);
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  const fmtT = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s - h * 3600 - m * 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${x.toFixed(2).padStart(5, '0')}`; };
  function issuesOf(d, i) {
    const s = d.segments[i]; const dur = s.end - s.start; const len = s.text.length;
    const out = [];
    if (dur > 0 && len / dur > LIMITS.cps) out.push(['fast', `trop rapide (${Math.round(len / dur)} car./s)`]);
    if (len > LIMITS.chars) out.push(['long', `texte long (${len} car.)`]);
    if (dur < LIMITS.minDur) out.push(['short', 'durée trop courte']);
    if (dur > LIMITS.maxDur) out.push(['dur', `affiché ${dur.toFixed(1)} s`]);
    const n = d.segments[i + 1]; if (n && n.start < s.end - 0.01) out.push(['overlap', 'chevauche le suivant']);
    return out;
  }
  function totalDur(d) { return Math.max(d.duration || 0, d.segments.length ? d.segments[d.segments.length - 1].end : 0, VF.audio.duration || 0) + 2; }

  async function loadPeaks(d) {
    if (!d.file) { sb.peaks = null; sb.peaksFor = null; return; }
    if (sb.peaksFor === d.file) return;
    sb.peaksFor = d.file; sb.peaks = null;
    try {
      if (!(await window.vox.files.exists(d.file))) return;
      const r = await window.vox.files.peaks(d.file, 50);
      if (sb.peaksFor !== d.file) return;
      const bin = atob(r.data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      sb.peaks = { perSec: r.perSec, data: arr };
      drawTimeline();
    } catch { sb.peaks = null; }
  }

  function drawSubs() {
    const d = VF.doc; if (!d || !subsActive()) return;
    if (!docReady(d)) { $('#sbList').innerHTML = '<p class="muted" style="padding:10px">L’éditeur sera disponible quand la transcription sera terminée.</p>'; $('#sbIssues').innerHTML = ''; return; }
    sb.sel = Math.min(sb.sel, d.segments.length - 1);
    loadPeaks(d);
    drawList(); drawIssues(); drawTimeline();
    if (!VF.audio.paused && !sb.raf) sb.raf = requestAnimationFrame(tick); // onglet ouvert pendant la lecture
    const h = history.get(d);
    $('#sbUndo').disabled = !(h && h.undo.length); $('#sbRedo').disabled = !(h && h.redo.length);
  }
  function drawIssues() {
    const d = VF.doc; const counts = {};
    d.segments.forEach((s, i) => issuesOf(d, i).forEach(([k]) => { counts[k] = (counts[k] || 0) + 1; }));
    const labels = { fast: 'trop rapides', long: 'trop longs', short: 'trop courts', dur: 'affichés trop longtemps', overlap: 'chevauchements' };
    const parts = Object.entries(counts).map(([k, n]) => `<button class="iss ${k}" data-iss="${k}">${n} ${labels[k]}</button>`);
    $('#sbIssues').innerHTML = `<span class="muted">${d.segments.length} sous-titres</span>${parts.length ? ' · ' + parts.join('') : ' · <span class="ok">✓ aucun problème détecté</span>'}`;
  }
  function cueHtml(d, i) {
    const s = d.segments[i]; const iss = issuesOf(d, i); const dur = s.end - s.start;
    return `<div class="cue ${i === sb.sel ? 'sel' : ''} ${iss.length ? 'warn' : ''}" data-ci="${i}">
      <span class="ci">${i + 1}</span>
      <div class="times"><input class="tin" data-k="start" value="${fmtT(s.start)}" spellcheck="false"><input class="tin" data-k="end" value="${fmtT(s.end)}" spellcheck="false"><small>${dur.toFixed(2)} s · ${dur > 0 ? Math.round(s.text.length / dur) : 0} c/s</small></div>
      <textarea class="ctext" rows="2" spellcheck="true">${esc(s.text)}</textarea>
      <div class="cflags">${iss.map(([k, l]) => `<span class="flag ${k}" title="${l}">${l}</span>`).join('')}</div>
    </div>`;
  }
  function drawList() {
    const d = VF.doc;
    $('#sbList').innerHTML = d.segments.map((s, i) => cueHtml(d, i)).join('');
  }
  function refreshCue(i) {
    const d = VF.doc; const el = $(`#sbList [data-ci="${i}"]`); if (!el || !d.segments[i]) return;
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
    if (focused) { // ne pas recréer le champ en cours de saisie
      const s = d.segments[i]; const dur = s.end - s.start; const iss = issuesOf(d, i);
      $('small', el).textContent = `${dur.toFixed(2)} s · ${dur > 0 ? Math.round(s.text.length / dur) : 0} c/s`;
      $('.cflags', el).innerHTML = iss.map(([k, l]) => `<span class="flag ${k}">${l}</span>`).join('');
      el.classList.toggle('warn', !!iss.length);
      return;
    }
    const tmp = document.createElement('div'); tmp.innerHTML = cueHtml(d, i);
    el.replaceWith(tmp.firstElementChild);
  }
  function select(i, { seek = true, scroll = true } = {}) {
    const d = VF.doc; if (!d || !d.segments[i]) return;
    const prev = $('#sbList .cue.sel'); if (prev) prev.classList.remove('sel');
    sb.sel = i;
    const el = $(`#sbList [data-ci="${i}"]`); if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
    if (seek) { VF.audio.currentTime = d.segments[i].start + 0.001; }
    const s = d.segments[i]; const x0 = s.start * sb.zoom, x1 = s.end * sb.zoom;
    if (x0 < wrap.scrollLeft || x1 > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = Math.max(0, x0 - 60);
    drawTimeline();
  }

  // ---- frise
  function drawTimeline() {
    const d = VF.doc; if (!d || !subsActive()) return;
    cssCache = null;
    const W = Math.floor(Math.max(200, wrap.getBoundingClientRect().width - 2)), H = 110, dpr = window.devicePixelRatio || 1;
    const total = totalDur(d);
    spacer.style.width = Math.max(W, total * sb.zoom) + 'px';
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
    const c = ctx2; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x0 = wrap.scrollLeft; const t0 = x0 / sb.zoom; const t1 = (x0 + W) / sb.zoom;
    c.fillStyle = css('--panel-2'); c.fillRect(0, 0, W, H);
    // graduations
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * sb.zoom >= 70) || 600;
    c.fillStyle = css('--muted'); c.font = '10px ' + css('--font'); c.strokeStyle = css('--line'); c.lineWidth = 1;
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(t * sb.zoom - x0) + 0.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 14); c.stroke();
      c.fillText(E.short(t) + (step < 1 ? '.' + Math.round((t % 1) * 10) : ''), x + 3, 10);
    }
    // forme d'onde
    const midY = 62, amp = 40;
    if (sb.peaks) {
      c.fillStyle = css('--faint');
      const ps = sb.peaks.perSec, data = sb.peaks.data;
      const pxPer = sb.zoom / ps;
      const stepPx = Math.max(1, Math.round(1 / Math.max(pxPer, 0.0001)));
      for (let px = 0; px < W; px += 1) {
        const t = (x0 + px) / sb.zoom; const k = Math.floor(t * ps);
        if (k >= data.length) break;
        let v = 0; for (let q = 0; q < stepPx && k + q < data.length; q++) v = Math.max(v, data[k + q]);
        const h = (v / 255) * amp; if (h > 0.5) c.fillRect(px, midY - h, 1, h * 2);
      }
    } else { c.fillStyle = css('--faint'); c.fillText(d.file ? 'Chargement de la forme d’onde…' : 'Pas de fichier audio', 8, midY + 4); }
    // sous-titres
    const acc = css('--accent');
    d.segments.forEach((s, i) => {
      if (s.end < t0 || s.start > t1) return;
      const xa = s.start * sb.zoom - x0, xb = s.end * sb.zoom - x0, w = Math.max(2, xb - xa);
      const sel = i === sb.sel; const warn = issuesOf(d, i).length;
      c.globalAlpha = sel ? 0.34 : 0.16; c.fillStyle = acc; c.fillRect(xa, 18, w, 88);
      c.globalAlpha = 1; c.strokeStyle = warn ? css('--warn') : acc; c.lineWidth = sel ? 2 : 1;
      c.strokeRect(xa + 0.5, 18.5, w - 1, 87);
      if (sel) { c.fillStyle = acc; c.fillRect(xa, 18, 4, 88); c.fillRect(xb - 4, 18, 4, 88); }
      if (w > 30) {
        c.save(); c.beginPath(); c.rect(xa + 4, 18, w - 8, 88); c.clip();
        c.fillStyle = css('--text'); c.font = `${sel ? 600 : 500} 11px ${css('--font')}`;
        c.fillText(`${i + 1}. ${s.text}`, xa + 6, 100); c.restore();
      }
    });
    // tête de lecture
    const ph = VF.audio.currentTime * sb.zoom - x0;
    if (ph >= 0 && ph <= W) { c.fillStyle = css('--danger'); c.fillRect(Math.round(ph), 0, 2, H); }
  }
  wrap.addEventListener('scroll', () => drawTimeline());
  window.addEventListener('resize', () => { if (subsActive()) drawTimeline(); });

  function hit(e) {
    const d = VF.doc; const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left + wrap.scrollLeft; const t = x / sb.zoom;
    const edge = 6 / sb.zoom;
    for (let i = 0; i < d.segments.length; i++) {
      const s = d.segments[i];
      if (Math.abs(t - s.start) <= edge) return { i, part: 'start', t };
      if (Math.abs(t - s.end) <= edge) return { i, part: 'end', t };
    }
    const i = d.segments.findIndex((s) => t >= s.start && t <= s.end);
    return i >= 0 ? { i, part: 'move', t } : { i: -1, part: 'seek', t };
  }
  canvas.addEventListener('mousemove', (e) => {
    if (sb.drag) return;
    const h = docReady(VF.doc) ? hit(e) : { part: 'seek' };
    canvas.style.cursor = h.part === 'start' || h.part === 'end' ? 'ew-resize' : h.part === 'move' ? 'grab' : 'text';
  });
  canvas.addEventListener('mousedown', (e) => {
    const d = VF.doc; if (!docReady(d)) return;
    const h = hit(e);
    if (h.part === 'seek') { VF.audio.currentTime = h.t; drawTimeline(); return; }
    select(h.i, { seek: h.part === 'move' });
    const s = d.segments[h.i];
    sb.drag = { ...h, orig: { start: s.start, end: s.end }, x: e.clientX, moved: false };
    prepareCp(d);
  });
  window.addEventListener('mousemove', (e) => {
    if (!sb.drag) return;
    const d = VF.doc; const g = sb.drag; const s = d.segments[g.i];
    const dt = (e.clientX - g.x) / sb.zoom;
    if (!g.moved && Math.abs(e.clientX - g.x) <= 2) return;
    if (!g.moved) { g.moved = true; ensureCp(d); }
    const prev = d.segments[g.i - 1], next = d.segments[g.i + 1];
    const lo = prev ? prev.end : 0, hi = next ? next.start : totalDur(d);
    if (g.part === 'start') s.start = Math.min(Math.max(lo, g.orig.start + dt), s.end - 0.2);
    else if (g.part === 'end') s.end = Math.max(Math.min(hi, g.orig.end + dt), s.start + 0.2);
    else {
      const len = g.orig.end - g.orig.start;
      // pas la place entre les voisins : on ne déplace pas (sinon le sous-titre passerait avant le précédent)
      const ns = hi - len < lo ? g.orig.start : Math.min(Math.max(lo, g.orig.start + dt), hi - len);
      s.start = ns; s.end = ns + len;
    }
    drawTimeline(); refreshCue(g.i);
  });
  window.addEventListener('mouseup', () => {
    if (!sb.drag) return;
    const d = VF.doc; const g = sb.drag; sb.drag = null;
    if (!g.moved) return;
    commit(d, { structure: false }); refreshCue(g.i); drawIssues();
    if (d.segments[g.i - 1]) refreshCue(g.i - 1);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect(); const tAt = (e.clientX - r.left + wrap.scrollLeft) / sb.zoom;
    sb.zoom = Math.max(10, Math.min(400, sb.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    $('#sbZoom').value = sb.zoom;
    spacer.style.width = Math.max(wrap.clientWidth, totalDur(VF.doc) * sb.zoom) + 'px';
    wrap.scrollLeft = tAt * sb.zoom - (e.clientX - r.left);
    drawTimeline();
  }, { passive: false });
  $('#sbZoom').addEventListener('input', (e) => { const tAt = VF.audio.currentTime; sb.zoom = +e.target.value; drawTimeline(); wrap.scrollLeft = Math.max(0, tAt * sb.zoom - wrap.clientWidth / 3); drawTimeline(); });

  // lecture : la tête de lecture avance et le sous-titre courant est mis en évidence
  const tick = () => {
    if (!subsActive()) { sb.raf = 0; return; }
    const d = VF.doc; const t = VF.audio.currentTime;
    const x = t * sb.zoom;
    if (!VF.audio.paused && (x < wrap.scrollLeft || x > wrap.scrollLeft + wrap.clientWidth - 40)) wrap.scrollLeft = Math.max(0, x - 80);
    if (!VF.audio.paused && d && d.segments) {
      const i = d.segments.findIndex((s) => t >= s.start && t < s.end);
      if (i >= 0 && i !== sb.sel && !document.activeElement.closest('#sbList')) select(i, { seek: false });
    }
    drawTimeline();
    sb.raf = VF.audio.paused ? 0 : requestAnimationFrame(tick);
  };
  VF.audio.addEventListener('play', () => { if (subsActive() && !sb.raf) sb.raf = requestAnimationFrame(tick); });
  VF.audio.addEventListener('seeked', () => { if (subsActive()) drawTimeline(); });

  // ---- liste
  $('#sbList').addEventListener('focusin', (e) => {
    const cue = e.target.closest('[data-ci]'); if (!cue) return;
    if (+cue.dataset.ci !== sb.sel) select(+cue.dataset.ci, { seek: true, scroll: false });
    prepareCp(VF.doc);
  });
  $('#sbList').addEventListener('focusout', (e) => {
    // position du curseur mémorisée : le bouton « Couper » prend le focus avant d'agir
    const cue = e.target.closest('[data-ci]');
    if (cue && e.target.classList.contains('ctext') && VF.doc) sb.caret = { seg: VF.doc.segments[+cue.dataset.ci], pos: e.target.selectionStart };
  });
  $('#sbList').addEventListener('input', (e) => {
    const cue = e.target.closest('[data-ci]'); if (!cue) return;
    const d = VF.doc; const i = +cue.dataset.ci; const s = d.segments[i];
    if (e.target.classList.contains('ctext')) { ensureCp(d); s.text = e.target.value.replace(/\s*\n\s*/g, ' ').trimStart(); refreshCue(i); saveSoon(d); drawTimeline(); }
  });
  $('#sbList').addEventListener('change', (e) => {
    const cue = e.target.closest('[data-ci]'); if (!cue || !e.target.classList.contains('tin')) return;
    const d = VF.doc; const i = +cue.dataset.ci; const s = d.segments[i];
    const v = parseTime(e.target.value);
    if (v == null) { VF.toast('Format attendu : m:ss.cc (ex. 1:05.40)', 'error'); e.target.value = fmtT(s[e.target.dataset.k]); return; }
    ensureCp(d);
    if (e.target.dataset.k === 'start') s.start = Math.min(v, s.end - 0.1); else s.end = Math.max(v, s.start + 0.1);
    e.target.value = fmtT(s[e.target.dataset.k]);
    commit(d, { structure: false }); refreshCue(i); drawIssues(); drawTimeline();
  });
  $('#sbList').addEventListener('click', (e) => { const cue = e.target.closest('[data-ci]'); if (cue && !e.target.closest('input, textarea')) select(+cue.dataset.ci); });
  // enregistrement différé PAR document
  const subTimers = new Map();
  const saveSoon = (d) => { clearTimeout(subTimers.get(d)); subTimers.set(d, setTimeout(() => { subTimers.delete(d); commit(d, { structure: false }); }, 700)); };
  $('#sbIssues').addEventListener('click', (e) => {
    const b = e.target.closest('[data-iss]'); if (!b) return;
    const d = VF.doc; const k = b.dataset.iss;
    const start = sb.sel + 1;
    const idx = [...d.segments.keys()].map((n) => (n + start) % d.segments.length).find((i) => issuesOf(d, i).some(([x]) => x === k));
    if (idx != null) select(idx);
  });

  // ---- actions
  function act(name) {
    const d = VF.doc; if (!docReady(d)) return;
    const i = sb.sel; const t = VF.audio.currentTime;
    if (name === 'undo' || name === 'redo') { if (undo(d, name === 'redo')) { commit(d); drawSubs(); } return; }
    if (!d.segments[i] && name !== 'insert') return;
    if (name === 'merge' && i >= d.segments.length - 1) return;
    if (name === 'delete' && d.segments.length <= 1) { VF.toast('Impossible de supprimer le dernier sous-titre.'); return; }
    checkpoint(d);
    if (name === 'split') {
      const s = d.segments[i];
      const ta = $(`#sbList [data-ci="${i}"] textarea`);
      let pos = ta && document.activeElement === ta ? ta.selectionStart : (sb.caret && sb.caret.seg === s ? sb.caret.pos : null);
      if (pos != null && !(pos > 0 && pos < s.text.length)) pos = null;
      const at = pos != null ? s.start + (s.end - s.start) * (pos / Math.max(1, s.text.length)) : t > s.start + 0.1 && t < s.end - 0.1 ? t : (s.start + s.end) / 2;
      Ops.split(d, i, at, pos);
      sb.caret = null;
    }
    if (name === 'merge') Ops.merge(d, i);
    if (name === 'delete') { Ops.remove(d, i); sb.sel = Math.max(0, i - 1); }
    if (name === 'insert') sb.sel = Ops.insert(d, t);
    commit(d); drawSubs(); select(sb.sel, { seek: false });
    if (name === 'insert') { const ta = $(`#sbList [data-ci="${sb.sel}"] textarea`); if (ta) { ta.focus(); ta.select(); } }
  }
  $('#sbSplit').onclick = () => act('split');
  $('#sbMerge').onclick = () => act('merge');
  $('#sbInsert').onclick = () => act('insert');
  $('#sbDelete').onclick = () => act('delete');
  $('#sbUndo').onclick = () => act('undo');
  $('#sbRedo').onclick = () => act('redo');
  $('#sbShift').onclick = async () => {
    const d = VF.doc; if (!docReady(d)) return;
    const r = await VF.modal({
      title: 'Décaler les horodatages',
      body: `<p class="muted small-p">Utile si les sous-titres sont en avance ou en retard sur la vidéo.</p>
        <label>Décalage en secondes (négatif = plus tôt)<input type="text" id="shV" value="0.5"></label>
        <label class="switch mini"><input type="checkbox" id="shFrom"><i></i><span>Seulement à partir du sous-titre sélectionné (n° ${sb.sel + 1})</span></label>`,
      buttons: [{ label: 'Annuler', value: null }, { label: 'Décaler', primary: true, onClick: (b) => { const v = parseFloat($('#shV', b).value.replace(',', '.')); return Number.isFinite(v) ? { v, from: $('#shFrom', b).checked } : false; } }],
    });
    if (!r || !r.v) return;
    checkpoint(d);
    if (r.from) { const part = { segments: d.segments.slice(sb.sel) }; Ops.shift(part, r.v); } else Ops.shift(d, r.v);
    commit(d); drawSubs();
    VF.toast(`Horodatages décalés de ${r.v > 0 ? '+' : ''}${r.v} s ✔`, 'ok');
  };
  $('#sbAuto').onclick = async () => {
    const d = VF.doc; if (!docReady(d)) return;
    const r = await VF.modal({
      title: 'Découper les sous-titres trop longs',
      body: `<p class="muted small-p">Chaque sous-titre plus long que la limite est coupé (de préférence après une ponctuation). Les horodatages sont répartis proportionnellement.</p>
        <label>Nombre maximal de caractères<input type="text" id="asMax" value="84"></label>`,
      buttons: [{ label: 'Annuler', value: null }, { label: 'Découper', primary: true, onClick: (b) => { const v = parseInt($('#asMax', b).value, 10); return v >= 20 ? v : false; } }],
    });
    if (!r) return;
    const before = snap(d);
    const n = Ops.autoSplit(d, r);
    if (!n) { VF.toast('Aucun sous-titre ne dépasse cette limite.'); return; }
    checkpoint(d, before);
    commit(d); drawSubs();
    VF.toast(`${n} découpe${n > 1 ? 's' : ''} effectuée${n > 1 ? 's' : ''} ✔`, 'ok');
  };
  document.addEventListener('keydown', (e) => {
    if (!subsActive() || !$('#modal').hidden) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); act(e.shiftKey ? 'redo' : 'undo'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); act('redo'); return; }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); VF.audio.paused ? VF.audio.play() : VF.audio.pause(); }
    else if (k === 's') { e.preventDefault(); act('split'); }
    else if (k === 'm') { e.preventDefault(); act('merge'); }
    else if (k === 'i') { e.preventDefault(); act('insert'); }
    else if (k === 'delete') { e.preventDefault(); act('delete'); }
    else if (k === 'arrowdown' || k === 'j') { e.preventDefault(); select(Math.min(VF.doc.segments.length - 1, sb.sel + 1)); }
    else if (k === 'arrowup' || k === 'k') { e.preventDefault(); select(Math.max(0, sb.sel - 1)); }
  });

  // ---- intégration
  $('#docTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    setTimeout(() => {
      if (subsActive()) drawSubs();
      else if (b.dataset.tab === 'transcript' && staleView && staleView === VF.doc) { staleView = null; VF.refreshSegments(); }
    }, 0);
  });
  const prevOnDoc = VF.onDoc;
  VF.onDoc = (d) => {
    prevOnDoc && prevOnDoc(d);
    if (proposal && proposal.doc !== d) { closeCleanup(); }
    if (!panel.hidden) drawCleanup();
    updateUndoBtn();
    if (subsActive()) { sb.sel = 0; wrap.scrollLeft = 0; drawSubs(); }
  };
  const prevInit = VF.init;
  VF.init = async () => { if (prevInit) await prevInit(); drawDict(); };
  VF.editor = { Ops, quickClean, wordDiff, parseTime };
})();
