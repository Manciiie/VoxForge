/* VoxForge — onglets Traduction, Résumé, Statistiques + modèles IA et réglages IA */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const VF = window.VF;
  const { esc, E } = VF;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const EXTRA_TARGETS = { 'zh-TW': 'Chinois (traditionnel)', 'pt-BR': 'Portugais (Brésil)' };
  const tName = (c) => EXTRA_TARGETS[c] || window.langName(c);

  // ------------------------------------------------------------------ onglets
  let activeTab = 'transcript';
  function setTab(t) {
    activeTab = t;
    $$('#docTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t));
    $('#resSearch').parentElement.style.visibility = t === 'transcript' ? '' : 'hidden';
    renderTab();
  }
  $('#docTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  function renderTab() {
    const d = VF.doc; if (!d) return;
    if (activeTab === 'translate') renderTranslation();
    if (activeTab === 'summary') renderSummary();
    if (activeTab === 'stats') renderStats();
    if (activeTab === 'transform') renderTransform();
    if (activeTab === 'origin') renderOrigin();
    updateBadges();
  }
  function updateBadges() {
    const d = VF.doc;
    $('#trDot').hidden = !(d && d.translations && Object.keys(d.translations).length);
    $('#sumDot').hidden = !(d && d.summary);
    $('#tfDot').hidden = !(d && d.transforms && Object.keys(d.transforms).length);
    $('#fmtBi').hidden = !(activeTranslation());
  }

  // ------------------------------------------------------------------ tâches IA
  const running = {}; // task -> { id, doc, lang }
  const idle = (d) => !d || !d.job || d.job.status === 'done';

  function engineLabel() {
    const a = VF.settings.ai || {};
    if (a.provider === 'openai') return `Serveur IA : ${a.remoteModel || 'modèle par défaut'}`;
    const m = llmList.find((x) => x.id === a.localModel && x.installed) || llmList.find((x) => x.installed);
    return m ? `Modèle IA : ${m.name}` : '';
  }
  function hasEngine() {
    const a = VF.settings.ai || {};
    return a.provider === 'openai' ? !!a.baseUrl : llmList.some((m) => m.installed);
  }
  function noEngineHtml(what) {
    return `<div class="empty-ai"><svg viewBox="0 0 24 24"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/></svg>
      <b>Un modèle IA est nécessaire pour ${what}</b>
      <span>Téléchargez-en un une seule fois (tout reste ensuite hors ligne), ou connectez LM Studio / Ollama dans les paramètres.</span>
      <div><button class="btn primary small" data-goto-llm>Choisir un modèle IA</button> <button class="btn small" data-goto-settings>Paramètres IA</button></div></div>`;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-llm]')) { VF.show('models'); setTimeout(() => $('#llmGrid').scrollIntoView({ behavior: 'smooth' }), 100); }
    if (e.target.closest('[data-goto-settings]')) VF.show('settings');
  });

  function startAi(task, payload, d, extra) {
    const id = uid();
    running[task] = { id, doc: d, ...extra };
    return window.vox.ai.run(id, task, payload).catch((e) => {
      delete running[task];
      VF.toast(esc(cleanErr(e)), 'error', 8000);
      renderTab();
    });
  }
  const cleanErr = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ai-cancel]'); if (!b) return;
    const r = running[b.dataset.aiCancel]; if (!r) return;
    r.cancelling = true; window.vox.ai.cancel(r.id);
    b.disabled = true; b.textContent = 'Annulation…';
  });

  window.vox.ai.onEvent((ev) => {
    const task = Object.keys(running).find((k) => running[k].id === ev.id);
    if (!task) return;
    const r = running[task];
    if (ev.type === 'status') r.status = ev.message;
    if (ev.type === 'progress' && ev.text != null) r.text = ev.text;
    if (ev.type === 'progress') { r.ratio = ev.ratio; if (ev.message) r.status = ev.message; if (ev.partial) r.partial = ev.partial;
      if (ev.updates) { r.partial = r.partial || []; r.dirty = r.dirty || new Set(); for (const k of Object.keys(ev.updates)) { r.partial[+k] = ev.updates[k]; r.dirty.add(+k); } }
      if (ev.total) r.status = `Traduction… ${ev.done}/${ev.total} segments`; }
    if (ev.type === 'done') {
      delete running[task];
      const d = r.doc;
      const meta = { model: ev.model || engineLabel().replace(/^[^:]+: /, ''), createdAt: new Date().toISOString(), elapsed: ev.elapsed, backend: ev.backend };
      if (task === 'translate') {
        const texts = d.segments.map((_, i) => (ev.result && ev.result[i] != null ? String(ev.result[i]) : ''));
        d.translations = { ...(d.translations || {}), [r.lang]: { texts, ...meta } };
        if (d.job) d.job.translations = d.translations;
        VF.toast(`Traduction en ${esc(tName(r.lang))} terminée ✔ (${VF.humanDur(ev.elapsed)})`, 'ok');
      } else if (task === 'transform') {
        d.transforms = { ...(d.transforms || {}), [r.format]: { text: ev.result, lang: r.lang, custom: r.custom || '', ...meta } };
        if (d.job) d.job.transforms = d.transforms;
        VF.toast(`Document généré ✔ (${VF.humanDur(ev.elapsed)})`, 'ok');
      } else if (task === 'aidetect') {
        d.aiOrigin = { measure: ev.result.measure, calib: ev.result.calib, ...meta };
        if (d.job) d.job.aiOrigin = d.aiOrigin;
        VF.toast(`Mesure par le modèle IA terminée ✔ (${VF.humanDur(ev.elapsed)})`, 'ok');
      } else {
        d.summary = { lang: r.lang, length: r.length, data: ev.result, ...meta };
        if (d.job) d.job.summary = d.summary;
        VF.toast(`Résumé généré ✔ (${VF.humanDur(ev.elapsed)})`, 'ok');
      }
      VF.saveDoc(d);
    }
    if (ev.type === 'error') { delete running[task]; VF.toast(esc(ev.message), 'error', 9000); }
    if (ev.type === 'cancelled') { delete running[task]; VF.toast('Opération IA annulée.'); }
    if (VF.doc === r.doc) throttledRender(task);
  });
  /** Traduction en cours : on ne met à jour que les lignes nouvellement traduites (pas de re-rendu complet). */
  function patchTranslation() {
    const r = running.translate; const list = $('#trList');
    if (!r || r.doc !== VF.doc || list.dataset.live !== r.id || !r.dirty) return false;
    progressUi($('#trProgress'), r);
    for (const i of r.dirty) {
      const dst = list.children[i] && list.children[i].querySelector('.dst');
      if (dst) { dst.textContent = r.partial[i] ?? '…'; dst.classList.toggle('pending', r.partial[i] == null); }
    }
    r.dirty.clear();
    return true;
  }
  const throttledRender = (() => {
    let p = {};
    return (task) => { if (p[task]) return; p[task] = true; requestAnimationFrame(() => { p[task] = false; if (task === 'translate' && activeTab === 'translate' && patchTranslation()) return; if ((task === 'translate' && activeTab === 'translate') || (task === 'summarize' && activeTab === 'summary') || (task === 'transform' && activeTab === 'transform') || (task === 'aidetect' && activeTab === 'origin')) renderTab(); else updateBadges(); }); };
  })();
  function progressUi(box, r) {
    box.hidden = !r;
    if (!r) return;
    const bar = $('.progress', box);
    bar.classList.toggle('indeterminate', !r.ratio);
    $('i', bar).style.width = ((r.ratio || 0) * 100).toFixed(1) + '%';
    $('.txt', box).textContent = r.status || 'Préparation…';
    const c = $('[data-ai-cancel], [data-pcancel]', box);
    if (c) { const busy = !!(r.cancelling || c.dataset.busy); c.disabled = busy; c.textContent = busy ? 'Annulation…' : 'Annuler'; }
  }

  // ------------------------------------------------------------------ Traduction
  let trViewMode = 'side';
  function currentTrLang() { return $('#trTarget').value; }
  function activeTranslation() {
    const d = VF.doc;
    if (!d || activeTab !== 'translate' || !d.translations) return null;
    const lang = currentTrLang();
    const t = d.translations[lang];
    return t ? { lang, texts: t.texts } : null;
  }
  function renderTranslation() {
    const d = VF.doc;
    const lang = currentTrLang();
    const r = running.translate && running.translate.doc === d ? running.translate : null;
    progressUi($('#trProgress'), r);
    $('#btnTranslate').disabled = !!running.translate || !idle(d) || !d.segments.length;
    const tr = d.translations && d.translations[lang];
    $('#btnTranslate').lastChild.textContent = tr ? 'Retraduire' : 'Traduire';
    $('#trEngine').textContent = tr ? `Traduit avec ${tr.model || 'IA'} · ${VF.humanDur(tr.elapsed || 0)}` : engineLabel();
    $('#trView').hidden = !tr && !r;
    const list = $('#trList');
    list.dataset.live = '';
    if (!idle(d)) { list.innerHTML = '<p class="muted" style="padding:10px">La traduction sera disponible quand la transcription sera terminée.</p>'; return; }
    if (!tr && !r) {
      list.innerHTML = hasEngine()
        ? `<div class="empty-ai"><svg viewBox="0 0 24 24"><path d="M4 5h8M8 3v2m3 0c-1 4-3.5 7-7 9m2-5c1.5 2 3.5 3.5 6 4.5"/><path d="m13 21 4-10 4 10m-6.5-3.5h5"/></svg>
           <b>Traduire en ${esc(tName(lang))}</b><span>Chaque phrase garde son horodatage : vous pourrez exporter des sous-titres traduits ou bilingues.${otherTr(d, lang)}</span></div>`
        : noEngineHtml('traduire');
      return;
    }
    const texts = tr ? tr.texts : (r.partial || []);
    if (!tr && r) { list.dataset.live = r.id; if (r.dirty) r.dirty.clear(); }
    const only = trViewMode === 'only';
    list.innerHTML = d.segments.map((s, i) => {
      const t = texts[i];
      return `<div class="tr-row ${only ? 'only' : ''}" data-i="${i}"><div class="ts" data-t="${s.start}">${E.short(s.start)}</div>${only ? '' : `<div class="src">${esc(s.text)}</div>`}<div class="dst ${t == null ? 'pending' : ''}" ${tr ? 'contenteditable="plaintext-only" spellcheck="false"' : ''}>${t == null ? '…' : esc(t)}</div></div>`;
    }).join('');
  }
  function otherTr(d, lang) {
    const others = Object.keys(d.translations || {}).filter((l) => l !== lang);
    return others.length ? `<br><br>Déjà traduit en : ${others.map((l) => `<a href="#" data-trlang="${esc(l)}">${esc(tName(l))}</a>`).join(', ')}` : '';
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-trlang]'); if (!a) return;
    e.preventDefault(); $('#trTarget').value = a.dataset.trlang; renderTranslation(); updateBadges();
  });
  $('#trList').addEventListener('input', (e) => {
    const dst = e.target.closest('.dst'); if (!dst) return;
    const d = VF.doc; const i = +dst.parentElement.dataset.i; const lang = currentTrLang();
    if (d.translations && d.translations[lang]) { d.translations[lang].texts[i] = dst.textContent.replace(/\s+/g, ' ').trim(); saveSoon(d); }
  });
  const saveSoon = (d) => VF.persistDoc(d); // différé par document
  $('#trTarget').addEventListener('change', () => { VF.setSetting({ ai: { translateTarget: currentTrLang() } }); renderTranslation(); updateBadges(); });
  $$('#trView button').forEach((b) => b.onclick = () => { trViewMode = b.dataset.v; $$('#trView button').forEach((x) => x.classList.toggle('active', x === b)); renderTranslation(); });
  $('#btnTranslate').onclick = () => {
    const d = VF.doc; if (!d || running.translate) return;
    if (!hasEngine()) { renderTranslation(); return; }
    const lang = currentTrLang();
    startAi('translate', { segments: d.segments.map((s) => ({ text: s.text, lang: s.lang || d.language || '' })), target: lang }, d, { lang, status: 'Préparation…' });
    renderTranslation();
  };

  // ------------------------------------------------------------------ Résumé
  const SUM_LABELS = {
    fr: ['Points clés', 'Décisions', 'Actions à mener', 'Chapitres', 'Aucune'],
    en: ['Key points', 'Decisions', 'Action items', 'Chapters', 'None'],
    es: ['Puntos clave', 'Decisiones', 'Acciones', 'Capítulos', 'Ninguna'],
    de: ['Kernpunkte', 'Entscheidungen', 'Aufgaben', 'Kapitel', 'Keine'],
    it: ['Punti chiave', 'Decisioni', 'Azioni', 'Capitoli', 'Nessuna'],
    pt: ['Pontos-chave', 'Decisões', 'Ações', 'Capítulos', 'Nenhuma'],
  };
  const timeToSec = (t) => { const p = String(t).replace(/[[\]]/g, '').split(':').map(Number); if (p.some(isNaN)) return null; return p.reduce((a, x) => a * 60 + x, 0); };
  function renderSummary() {
    const d = VF.doc;
    const r = running.summarize && running.summarize.doc === d ? running.summarize : null;
    progressUi($('#sumProgress'), r);
    $('#btnSummarize').disabled = !!running.summarize || !idle(d) || !d.segments.length;
    const sm = d.summary;
    $('#btnSummarize').lastChild.textContent = sm ? 'Régénérer' : 'Générer';
    $('#sumCopy').hidden = $('#sumExport').hidden = !sm;
    const out = $('#summaryOut');
    if (!idle(d)) { out.innerHTML = '<p class="muted">Le résumé sera disponible quand la transcription sera terminée.</p>'; return; }
    if (!sm) {
      out.innerHTML = r ? '' : hasEngine()
        ? `<div class="empty-ai"><svg viewBox="0 0 24 24"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/></svg><b>Résumé et points clés</b><span>L’IA rédige un résumé, les points importants, les décisions, les actions à mener et un découpage en chapitres horodatés.</span><small>${esc(engineLabel())}</small></div>`
        : noEngineHtml('résumer');
      return;
    }
    const s = sm.data; const L = SUM_LABELS[sm.lang] || SUM_LABELS.en;
    const list = (arr, fn) => (arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : `<div class="none">${L[4]}</div>`);
    out.innerHTML = `
      <div class="sum-title">${esc(s.title || d.title)}</div>
      <p class="sum-text">${esc(s.summary)}</p>
      <div class="sum-grid">
        <div class="sum-card"><h5><svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>${L[0]}</h5>${list(s.key_points, (k) => `<li>${esc(k)}</li>`)}</div>
        <div class="sum-card"><h5><svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/></svg>${L[1]}</h5>${list(s.decisions, (k) => `<li>${esc(k)}</li>`)}</div>
        <div class="sum-card"><h5><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/></svg>${L[2]}</h5>${list(s.action_items, (a) => `<li>${esc(a.task)}${a.owner ? ` — <span class="owner">${esc(a.owner)}</span>` : ''}</li>`)}</div>
        <div class="sum-card"><h5><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>${L[3]}</h5>${s.chapters.length ? `<ul class="chap">${s.chapters.map((c) => { const t = timeToSec(c.time); return `<li><span class="t" ${t != null ? `data-t="${t}"` : ''}>${esc(c.time)}</span><span>${esc(c.title)}</span></li>`; }).join('')}</ul>` : `<div class="none">${L[4]}</div>`}</div>
      </div>
      <div class="sum-meta">Généré par ${esc(sm.model || 'IA')} en ${VF.humanDur(sm.elapsed || 0)} · ${new Date(sm.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · Vérifiez les informations importantes : l’IA peut se tromper.</div>`;
  }
  function summaryMarkdown(d) {
    const sm = d.summary; const L = SUM_LABELS[sm.lang] || SUM_LABELS.en; const s = sm.data;
    const out = [`# ${s.title || d.title}`, '', s.summary, ''];
    const sec = (t, arr) => { if (arr.length) out.push(`## ${t}`, '', ...arr, ''); };
    sec(L[0], s.key_points.map((k) => `- ${k}`));
    sec(L[1], s.decisions.map((k) => `- ${k}`));
    sec(L[2], s.action_items.map((a) => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ''}`));
    sec(L[3], s.chapters.map((c) => `- **${c.time}** ${c.title}`));
    return out.join('\n');
  }
  $('#btnSummarize').onclick = () => {
    const d = VF.doc; if (!d || running.summarize) return;
    if (!hasEngine()) { renderSummary(); return; }
    const lang = $('#sumLang').value; const length = $('#sumLength').value;
    startAi('summarize', { segments: d.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })), lang, length, title: d.title }, d, { lang, length, status: 'Préparation…' });
    renderSummary();
  };
  $('#sumLang').addEventListener('change', () => VF.setSetting({ ai: { summaryLang: $('#sumLang').value } }));
  $('#sumLength').addEventListener('change', () => VF.setSetting({ ai: { summaryLength: $('#sumLength').value } }));
  $('#sumCopy').onclick = () => VF.doc && VF.doc.summary && VF.copyText(summaryMarkdown(VF.doc));
  $('#sumExport').onclick = (e) => { e.stopPropagation(); $('#sumExportMenu').hidden = !$('#sumExportMenu').hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('#sumExport')) $('#sumExportMenu').hidden = true; });
  $('#sumExportMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sx]'); if (!b) return;
    const d = VF.doc; if (!d || !d.summary) return;
    const fmt = b.dataset.sx; const base = (d.title || 'resume').replace(/[\\/:*?"<>|]+/g, '_') + ' - résumé';
    const saved = fmt === 'md'
      ? await window.vox.files.exportSave({ content: summaryMarkdown(d), defaultName: base + '.md', format: 'md' })
      : await window.vox.files.exportDoc({ format: fmt, markdown: summaryMarkdown(d), title: d.title, defaultName: `${base}.${fmt}` });
    if (saved) VF.toast('Résumé exporté ✔', 'ok');
  });

  // ------------------------------------------------------------------ Transformer
  const TF_FORMATS = [
    { id: 'meeting', icon: '📋', name: 'Compte rendu', desc: 'Réunion : décisions, actions, suite' },
    { id: 'article', icon: '📰', name: 'Article de blog', desc: 'Titre, intro, sections, conclusion' },
    { id: 'email', icon: '✉️', name: 'E-mail récapitulatif', desc: 'Prêt à envoyer' },
    { id: 'notes', icon: '🗒️', name: 'Notes structurées', desc: 'Tous les détails, organisés' },
    { id: 'study', icon: '🎓', name: 'Fiche de révision', desc: 'Notions clés, à retenir' },
    { id: 'quiz', icon: '❓', name: 'Quiz', desc: '10 questions à choix multiples' },
    { id: 'thread', icon: '🧵', name: 'Fil X / Twitter', desc: '5 à 10 posts' },
    { id: 'linkedin', icon: '💼', name: 'Post LinkedIn', desc: 'Accroche et points clés' },
    { id: 'custom', icon: '✨', name: 'Sur mesure', desc: 'Décrivez ce que vous voulez' },
  ];
  let tfFormat = 'meeting';
  let tfEditing = false;
  function renderTfFormats() {
    const d = VF.doc;
    $('#tfFormats').innerHTML = TF_FORMATS.map((f) => `<button class="tf-card ${f.id === tfFormat ? 'active' : ''}" data-tf="${f.id}" title="${f.desc}"><span class="ic">${f.icon}</span><span><b>${f.name}${d && d.transforms && d.transforms[f.id] ? ' <i class="ok">✓</i>' : ''}</b><small>${f.desc}</small></span></button>`).join('');
  }
  $('#tfFormats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    tfFormat = b.dataset.tf; tfEditing = false; renderTransform();
  });
  function renderTransform() {
    const d = VF.doc;
    renderTfFormats();
    const r = running.transform && running.transform.doc === d ? running.transform : null;
    progressUi($('#tfProgress'), r);
    const res = d.transforms && d.transforms[tfFormat];
    $('#tfCustom').hidden = tfFormat !== 'custom';
    if (tfFormat === 'custom' && res && res.custom && !$('#tfCustom').value) $('#tfCustom').value = res.custom;
    $('#btnTransform').disabled = !!running.transform || !idle(d) || !d.segments.length;
    $('#btnTransform').lastChild.textContent = res ? 'Régénérer' : 'Générer';
    $('#tfCopy').hidden = $('#tfExportBtn').hidden = $('#tfEdit').hidden = !res || !!r;
    $('#tfEdit').textContent = tfEditing ? 'Terminer' : 'Modifier';
    const out = $('#tfOut'); const ed = $('#tfEditor');
    ed.hidden = !(tfEditing && res); out.hidden = !ed.hidden;
    if (!idle(d)) { out.innerHTML = '<p class="muted">Disponible quand la transcription sera terminée.</p>'; return; }
    if (r) { out.innerHTML = r.text ? window.Markdown.render(r.text) + '<span class="caret"></span>' : ''; out.scrollTop = out.scrollHeight; return; }
    if (res) {
      if (tfEditing) { if (ed.dataset.fmt !== tfFormat) { ed.value = res.text; ed.dataset.fmt = tfFormat; } }
      else out.innerHTML = window.Markdown.render(res.text) + `<div class="sum-meta">Généré par ${esc(res.model || 'IA')} en ${VF.humanDur(res.elapsed || 0)} · ${esc(tName(res.lang))} · Relisez avant de diffuser : l’IA peut se tromper.</div>`;
      return;
    }
    const f = TF_FORMATS.find((x) => x.id === tfFormat);
    out.innerHTML = hasEngine()
      ? `<div class="empty-ai"><span style="font-size:34px">${f.icon}</span><b>${f.name}</b><span>${f.desc}. L’IA rédige le document à partir de la transcription ; vous pourrez ensuite le modifier, le copier ou l’exporter.</span><small>${esc(engineLabel())}</small></div>`
      : noEngineHtml('transformer le texte');
  }
  $('#btnTransform').onclick = () => {
    const d = VF.doc; if (!d || running.transform) return;
    if (!hasEngine()) { renderTransform(); return; }
    const custom = $('#tfCustom').value.trim();
    if (tfFormat === 'custom' && !custom) { VF.toast('Décrivez d’abord ce que vous voulez obtenir.', 'error'); $('#tfCustom').focus(); return; }
    const lang = $('#tfLang').value;
    tfEditing = false;
    startAi('transform', { parts: [{ title: d.title, segments: d.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) }], format: tfFormat, lang, custom }, d, { lang, format: tfFormat, custom, status: 'Préparation…' });
    renderTransform();
  };
  $('#tfLang').addEventListener('change', () => VF.setSetting({ ai: { transformLang: $('#tfLang').value } }));
  $('#tfEdit').onclick = () => {
    const d = VF.doc; const res = d && d.transforms && d.transforms[tfFormat]; if (!res) return;
    if (tfEditing) { res.text = $('#tfEditor').value; VF.saveDoc(d); }
    else $('#tfEditor').dataset.fmt = '';
    tfEditing = !tfEditing; renderTransform();
  };
  $('#tfEditor').addEventListener('input', () => {
    // document et format capturés tout de suite : changer de fichier pendant le délai ne mélange rien
    const d = VF.doc; const res = d && d.transforms && d.transforms[$('#tfEditor').dataset.fmt || tfFormat];
    if (res) { res.text = $('#tfEditor').value; VF.persistDoc(d); }
  });
  $('#tfCopy').onclick = () => { const res = VF.doc && VF.doc.transforms && VF.doc.transforms[tfFormat]; if (res) VF.copyText(res.text); };
  $('#tfExportBtn').onclick = (e) => { e.stopPropagation(); $('#tfExportMenu').hidden = !$('#tfExportMenu').hidden; };
  document.addEventListener('click', (e) => { if (!e.target.closest('#tfExportBtn')) $('#tfExportMenu').hidden = true; });
  $('#tfExportMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tfx]'); if (!b) return;
    const d = VF.doc; const res = d && d.transforms && d.transforms[tfFormat]; if (!res) return;
    const f = TF_FORMATS.find((x) => x.id === tfFormat);
    const ext = b.dataset.tfx;
    if (ext === 'docx' || ext === 'pdf') {
      const saved = await window.vox.files.exportDoc({ format: ext, markdown: res.text, title: `${d.title} — ${f.name}`, defaultName: `${(d.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')} - ${f.name}.${ext}` });
      if (saved) VF.toast('Document exporté ✔', 'ok');
      return;
    }
    const content = ext === 'md' ? res.text : ext === 'txt' ? window.Markdown.plain(res.text)
      : `<!doctype html><html lang="${esc(res.lang)}"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>body{font:16px/1.6 Calibri,Segoe UI,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1d2230}h1,h2,h3{line-height:1.25}blockquote{border-left:3px solid #7c5cff;margin:0;padding-left:12px;color:#555}</style></head><body>${window.Markdown.render(res.text)}</body></html>`;
    const name = `${(d.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')} - ${f.name}.${ext}`;
    const saved = await window.vox.files.exportSave({ content, defaultName: name, format: ext });
    if (saved) VF.toast('Document exporté ✔', 'ok');
  });

  // ------------------------------------------------------------------ Statistiques
  const STOP = new Set(('a,à,ai,au,aux,avec,ce,ces,c,ça,cela,cet,cette,d,dans,de,des,du,elle,en,est,et,être,eu,il,ils,je,j,la,le,les,leur,lui,l,ma,mais,me,même,mes,moi,mon,ne,nos,notre,nous,on,ou,où,par,pas,pour,qu,que,qui,sa,se,ses,si,son,sur,ta,te,tes,toi,ton,tu,un,une,vos,votre,vous,y,était,sont,été,fait,faire,plus,bien,très,tout,tous,alors,donc,aussi,comme,quand,là,ici,oui,non,euh,ben,bah,hein,voilà,va,vais,peu,peut,avez,avons,ont,suis,es,sommes,êtes,faut,dit,fois,chose,choses,juste,vraiment,encore,après,avant,déjà,quoi,the,a,an,and,or,of,to,in,on,at,for,with,is,are,was,were,be,been,it,its,this,that,these,those,i,you,he,she,we,they,me,my,your,our,their,his,her,them,us,not,no,yes,do,does,did,have,has,had,so,but,if,as,by,from,just,like,what,there,here,about,can,will,would,could,should,um,uh,yeah,okay,ok,get,got,go,going,know,think,really,one,all,some,more,very,el,la,los,las,de,del,y,que,en,un,una,es,por,con,para,no,se,lo,le,su,al,como,más,pero,muy,der,die,das,und,ist,ich,nicht,ein,eine,zu,den,mit,sich,auf,il,di,che,non,per,una,sono,e,o').split(','));
  function computeStats(d) {
    const segs = d.segments;
    const duration = d.duration || (segs.length ? segs[segs.length - 1].end : 0);
    const speech = segs.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
    const words = []; const freq = new Map();
    for (const s of segs) {
      const ws = s.text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
      for (let w of ws) {
        words.push(w);
        w = w.replace(/^(l|d|j|qu|n|s|c|m|t)['’]/, '');
        if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    const sentences = segs.reduce((a, s) => a + Math.max(1, (s.text.match(/[.!?…。！？]+/g) || []).length), 0);
    const langs = {};
    for (const s of segs) { const l = s.lang || d.language || '?'; langs[l] = (langs[l] || 0) + (s.end - s.start); }
    // activité de parole par tranche de temps
    const buckets = Math.max(1, Math.min(60, Math.max(Math.min(12, Math.ceil(duration / 2)), Math.ceil(duration / 10))));
    const bw = duration / buckets || 1;
    const act = new Array(buckets).fill(0);
    for (const s of segs) {
      for (let b = Math.floor(s.start / bw); b <= Math.min(buckets - 1, Math.floor(s.end / bw)); b++) {
        const a0 = Math.max(s.start, b * bw), a1 = Math.min(s.end, (b + 1) * bw);
        if (a1 > a0) act[b] += a1 - a0;
      }
    }
    const longest = segs.reduce((m, s) => (s.end - s.start > (m ? m.end - m.start : 0) ? s : m), null);
    const pauses = segs.slice(1).map((s, i) => s.start - segs[i].end).filter((g) => g > 1.5);
    return {
      duration, speech, silence: Math.max(0, duration - speech), words: words.length,
      unique: new Set(words).size, wpm: speech > 0 ? words.length / (speech / 60) : 0, segments: segs.length, sentences,
      avgSentence: sentences ? words.length / sentences : 0,
      top: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      langs: Object.entries(langs).sort((a, b) => b[1] - a[1]),
      act, bw, longest, pauses: pauses.length, longestPause: pauses.length ? Math.max(...pauses) : 0,
      readMin: words.length / 230,
    };
  }
  const fmt1 = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  function renderStats() {
    const d = VF.doc;
    const out = $('#statsOut');
    if (!d.segments.length) { out.innerHTML = '<p class="muted">Pas encore de statistiques : la transcription est vide.</p>'; return; }
    const st = computeStats(d);
    if (d.source === 'text') return renderTextStats(d, st, out);
    const pace = st.wpm < 110 ? 'lent' : st.wpm < 160 ? 'posé' : st.wpm < 190 ? 'normal' : 'rapide';
    const tiles = [
      ['Durée', E.short(st.duration), d.elapsed ? `transcrit en ${VF.humanDur(d.elapsed)}` : ''],
      ['Temps de parole', E.short(st.speech), `${pct(st.speech, st.duration)} % de l’enregistrement`],
      ['Silences', E.short(st.silence), `${st.pauses} pause${st.pauses > 1 ? 's' : ''} > 1,5 s`],
      ['Mots', st.words.toLocaleString('fr-FR'), `${st.unique.toLocaleString('fr-FR')} mots différents`],
      ['Débit', `${Math.round(st.wpm)} mots/min`, `débit ${pace}`],
      ['Phrases', st.sentences.toLocaleString('fr-FR'), `${fmt1(st.avgSentence)} mots en moyenne`],
      ['Temps de lecture', `${Math.max(1, Math.round(st.readMin))} min`, 'à 230 mots/min'],
      ['Segments', st.segments.toLocaleString('fr-FR'), st.longest ? `le plus long : ${Math.round(st.longest.end - st.longest.start)} s` : ''],
    ];
    const maxAct = Math.max(...st.act, 0.0001);
    const W = 600, H = 100, n = st.act.length, gap = n > 40 ? 1 : 2, bwPx = (W - gap * (n - 1)) / n;
    const bars = st.act.map((v, i) => {
      const h = Math.max(v > 0 ? 2 : 0, (v / maxAct) * H);
      const x = i * (bwPx + gap);
      const r = Math.min(4, bwPx / 2, h);
      const path = h ? `M${x},${H} V${H - h + r} Q${x},${H - h} ${x + r},${H - h} H${x + bwPx - r} Q${x + bwPx},${H - h} ${x + bwPx},${H - h + r} V${H} Z` : '';
      return `<path class="bar" d="${path}" data-tip="${E.short(i * st.bw)} – ${E.short((i + 1) * st.bw)}" data-val="${pct(v, st.bw)} % de parole"/><rect x="${x}" y="0" width="${bwPx + gap}" height="${H}" fill="transparent" data-tip="${E.short(i * st.bw)} – ${E.short((i + 1) * st.bw)}" data-val="${pct(v, st.bw)} % de parole" data-seek="${i * st.bw}"/>`;
    }).join('');
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${E.short(f * st.duration)}</span>`).join('');
    const maxW = st.top.length ? st.top[0][1] : 1;
    const totalLang = st.langs.reduce((a, [, v]) => a + v, 0) || 1;
    out.innerHTML = `
      <div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('')}</div>
      <div class="chart-card">
        <h5>Activité de parole</h5><div class="sub">Part de parole par tranche de ${Math.round(st.bw)} s · cliquez sur une barre pour écouter ce passage</div>
        <div class="timeline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Activité de parole au fil du temps">
          <line class="grid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke-dasharray="3 4"/>
          ${bars}<line class="grid" x1="0" x2="${W}" y1="${H}" y2="${H}"/></svg><div class="ticks">${ticks}</div></div>
      </div>
      <div class="chart-row">
        <div class="chart-card"><h5>Mots les plus fréquents</h5><div class="sub">Hors mots courants (articles, pronoms…)</div>
          <div class="hbars">${st.top.length ? st.top.map(([w, c]) => `<div class="hbar" data-tip="${esc(w)}" data-val="${c} occurrence${c > 1 ? 's' : ''}"><span class="lbl">${esc(w)}</span><div class="track"><div class="fill" style="width:${(c / maxW) * 100}%"></div></div><span class="val">${c}</span></div>`).join('') : '<span class="muted">Pas assez de texte.</span>'}</div></div>
        <div class="chart-card"><h5>Langues parlées</h5><div class="sub">Part du temps de parole</div>
          <div class="hbars">${st.langs.map(([l, v]) => `<div class="hbar" data-tip="${esc(window.langName(l))}" data-val="${E.short(v)} de parole"><span class="lbl">${esc(window.langName(l))}</span><div class="track"><div class="fill" style="width:${(v / totalLang) * 100}%"></div></div><span class="val">${pct(v, totalLang)} %</span></div>`).join('')}</div></div>
      </div>`;
  }
  // ------------------------------------------------------------------ Origine IA (texte écrit par une personne ou par une IA ?)
  function originParagraphs(d) {
    return E.paragraphs(d.segments).map((p) => ({ text: p.map((s) => s.text).join(' '), seg: d.segments.indexOf(p[0]) }));
  }
  function renderOrigin() {
    const d = VF.doc; const out = $('#originOut');
    const r = running.aidetect && running.aidetect.doc === d ? running.aidetect : null;
    progressUi($('#orProgress'), r);
    if (!d.segments.length) { out.innerHTML = '<p class="muted">Le document est vide.</p>'; return; }
    const paras = originParagraphs(d);
    const model = d.aiOrigin && d.aiOrigin.measure;
    const a = VoxAiDetect.analyze(paras.map((p) => p.text), model, d.aiOrigin && d.aiOrigin.calib);
    const C = 2 * Math.PI * 62;
    const verdictColor = { ai: '#e5636c', 'likely-ai': '#e58a3b', unsure: '#e2b93b', short: '#e2b93b', 'likely-human': '#7cc77b', human: '#35c08a', mixed: '#b67cf0' }[a.verdict.kind];
    const confLabel = { none: 'texte trop court', low: 'fiabilité faible (texte court)', medium: 'fiabilité moyenne', high: 'fiabilité correcte' }[a.confidence];
    const sig = (x) => `<div class="sig"><span class="d ${x.delta > 0 ? 'ai' : 'hu'}">${x.delta > 0 ? '+' : ''}${x.delta}</span><div>${esc(x.label)}${x.detail ? `<small>${esc(x.detail)}</small>` : ''}</div></div>`;
    const styleSig = a.style.signals.length ? a.style.signals.map(sig).join('') : '<p class="muted">Aucun indice marquant dans un sens ou dans l’autre.</p>';
    const modelSig = a.model ? a.model.signals.map(sig).join('') : '';
    const paraRows = a.paragraphs.map((p) => {
      const col = p.score >= 65 ? '#e5636c' : p.score >= 45 ? '#e2b93b' : '#35c08a';
      return `<div class="para ${p.reliable ? '' : 'low'}" data-seg="${paras[p.index].seg}" title="${p.reliable ? 'Cliquer pour afficher ce passage' : 'Passage trop court pour être jugé'}"><span class="n">${p.index + 1}</span><span class="ex">${esc(paras[p.index].text.slice(0, 120))}</span><div class="track"><i style="width:${p.score}%;background:${col}"></i></div></div>`;
    }).join('');
    const modelBox = model
      ? `<div class="model-box"><span class="chip accent">Mesuré par ${esc(d.aiOrigin.model || 'le modèle IA')}</span><span class="muted">${a.model && a.model.calibrated ? 'étalonné sur ce PC' : 'sans étalonnage'} · ${model.tokens.toLocaleString('fr-FR')} jetons${model.sampled ? ' (échantillon réparti sur le document)' : ''}</span> <button class="btn small" id="btnOrigin" ${r ? 'disabled' : ''}>Mesurer à nouveau</button></div>`
      : hasEngine()
        ? `<div class="model-box"><button class="btn primary small" id="btnOrigin" ${r ? 'disabled' : ''}>Affiner avec le modèle IA</button><span class="muted">Le modèle local mesure à quel point chaque mot était prévisible : un texte généré par une IA l’est beaucoup plus qu’un texte humain. Compte pour 60 % du score. Nécessite un modèle IA local (pas un serveur).</span></div>`
        : `<div class="model-box"><span class="muted">Un modèle IA local permettrait d’affiner cet indice en mesurant la prévisibilité du texte.</span> <button class="btn small" data-goto-llm>Choisir un modèle IA</button></div>`;
    out.innerHTML = `
      <div class="verdict kind-${a.verdict.kind}">
        <div class="gauge"><svg viewBox="0 0 140 140"><circle class="track" cx="70" cy="70" r="62"/><circle class="arc" cx="70" cy="70" r="62" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - a.score / 100)}" style="stroke:${verdictColor}"/></svg><div class="num">${a.score}<small>indice IA / 100</small></div></div>
        <div><h3>${esc(a.verdict.label)}<span class="conf">${confLabel}</span></h3><p class="hint">${esc(a.verdict.hint)}</p>
          <div class="scale"><span>Humain</span><div class="bar"><i style="left:${a.score}%"></i></div><span>IA</span></div>
          <div class="muted" style="font-size:12px;margin-top:8px">${a.words.toLocaleString('fr-FR')} mots · ${a.sentences} phrases · ${a.paragraphs.length} paragraphe${a.paragraphs.length > 1 ? 's' : ''}${model ? ' · indices de style 40 % + modèle 60 %' : ' · indices de style seulement'}</div>
        </div>
      </div>
      <div class="warn">Un indice, pas une preuve : aucun détecteur n’est fiable à 100 %. Un texte très formaté (rapport, cours, fiche de révision) peut ressembler à une IA, et un texte généré puis retravaillé peut passer inaperçu. N’accusez personne sur ce seul résultat.</div>
      ${modelBox}
      <div class="cols">
        <div class="chart-card"><h5>Indices de style</h5><div class="sub">Calculés sans modèle, instantanément · + = ressemble à une IA, − = ressemble à une personne</div>${styleSig}</div>
        <div class="chart-card"><h5>Prévisibilité (modèle IA)</h5><div class="sub">${model ? 'Mots devinés par le modèle et écart au premier choix' : 'Pas encore mesurée'}</div>${modelSig || '<p class="muted">Cliquez sur « Affiner avec le modèle IA » pour mesurer la prévisibilité du texte.</p>'}</div>
      </div>
      <div class="chart-card" style="margin-top:12px"><h5>Passage par passage</h5><div class="sub">Repère un texte humain complété ou retouché par une IA (ou l’inverse) · cliquez pour afficher le passage</div><div class="paras">${paraRows}</div></div>`;
    const b = $('#btnOrigin');
    if (b) b.onclick = () => {
      if (running.aidetect) return;
      startAi('aidetect', { paragraphs: paras.map((p) => p.text), lang: d.language || '' }, d);
      renderOrigin();
    };
  }
  $('#originOut').addEventListener('click', (e) => {
    const p = e.target.closest('.para'); if (!p || !p.dataset.seg) return;
    setTab('transcript');
    const el = $(`#segments .seg[data-i="${p.dataset.seg}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  });

  /** Statistiques d'un texte importé : pas d'audio, donc lecture, lisibilité et répartition des mots. */
  function syllables(w) {
    const v = w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/e$/, '').match(/[aeiouy]+/g);
    return Math.max(1, v ? v.length : 1);
  }
  function renderTextStats(d, st, out) {
    const segs = d.segments;
    const all = segs.map((x) => x.text).join(' ');
    const ws = all.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
    const syl = ws.reduce((a, w) => a + syllables(w), 0);
    const paras = E.paragraphs(segs).length;
    // indice de lisibilité de Kandel et Moles (adaptation française de Flesch)
    const read = st.sentences && ws.length ? 207 - 1.015 * (ws.length / st.sentences) - 73.6 * (syl / ws.length) : 0;
    const level = read >= 80 ? 'très facile' : read >= 70 ? 'facile' : read >= 60 ? 'assez facile' : read >= 50 ? 'standard' : read >= 40 ? 'assez difficile' : read >= 30 ? 'difficile' : 'très difficile';
    const outline = (d.outline || []).length;
    const tiles = [
      ['Mots', st.words.toLocaleString('fr-FR'), `${st.unique.toLocaleString('fr-FR')} mots différents (${pct(st.unique, st.words)} %)`],
      ['Phrases', st.sentences.toLocaleString('fr-FR'), `${fmt1(st.avgSentence)} mots en moyenne`],
      ['Paragraphes', paras.toLocaleString('fr-FR'), outline ? `${outline} titre${outline > 1 ? 's' : ''} dans le plan` : ''],
      ['Caractères', all.length.toLocaleString('fr-FR'), `${all.replace(/\s/g, '').length.toLocaleString('fr-FR')} sans les espaces`],
      ['Temps de lecture', `${Math.max(1, Math.round(st.readMin))} min`, 'lecture silencieuse, 230 mots/min'],
      ['À voix haute', `${Math.max(1, Math.round(st.words / 150))} min`, 'environ 150 mots/min'],
      ['Lisibilité', `${Math.round(read)} / 100`, level],
      ['Langue', window.langName(d.language || '') || '—', d.textKind ? `fichier .${d.textKind}` : ''],
    ];
    // répartition des mots le long du texte (20 tranches)
    const n = Math.min(20, Math.max(1, segs.length));
    const per = new Array(n).fill(0);
    segs.forEach((x, i) => { per[Math.min(n - 1, Math.floor((i / segs.length) * n))] += (x.text.match(/\S+/g) || []).length; });
    const max = Math.max(...per, 1);
    const W = 600, H = 100, gap = 3, bw = (W - gap * (n - 1)) / n;
    const bars = per.map((v, i) => { const h = Math.max(2, (v / max) * H); return `<rect class="bar" x="${i * (bw + gap)}" y="${H - h}" width="${bw}" height="${h}" rx="3" data-tip="Partie ${i + 1} / ${n}" data-val="${v} mots"/>`; }).join('');
    const maxW = st.top.length ? st.top[0][1] : 1;
    out.innerHTML = `
      <div class="tiles">${tiles.map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(x)}</div></div>`).join('')}</div>
      <div class="chart-card"><h5>Répartition des mots</h5><div class="sub">Nombre de mots du début à la fin du texte (${n} parties égales)</div>
        <div class="timeline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Répartition des mots dans le texte">${bars}</svg></div></div>
      <div class="chart-row">
        <div class="chart-card"><h5>Mots les plus fréquents</h5><div class="sub">Hors mots courants (articles, pronoms…)</div>
          <div class="hbars">${st.top.length ? st.top.map(([w, c]) => `<div class="hbar" data-tip="${esc(w)}" data-val="${c} occurrence${c > 1 ? 's' : ''}"><span class="lbl">${esc(w)}</span><div class="track"><div class="fill" style="width:${(c / maxW) * 100}%"></div></div><span class="val">${c}</span></div>`).join('') : '<span class="muted">Pas assez de texte.</span>'}</div></div>
        <div class="chart-card"><h5>Plan du texte</h5><div class="sub">Titres repérés automatiquement</div>
          ${outline ? `<div class="mini-outline">${d.outline.map((h) => `<div class="mo d${h.depth || 0}">${esc(h.label && !/^(Introduction|Conclusion)$/i.test(h.label) ? h.label + ' — ' : '')}${esc(h.title)}</div>`).join('')}</div>` : '<span class="muted">Aucun titre repéré.</span>'}</div>
      </div>`;
  }

  // infobulle des graphiques
  const tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; document.body.appendChild(tip);
  $('#statsOut').addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(t.dataset.tip)}</b>${esc(t.dataset.val || '')}`;
    tip.hidden = false;
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px';
    tip.style.top = (e.clientY - tip.offsetHeight - 10) + 'px';
  });
  $('#statsOut').addEventListener('mouseleave', () => { tip.hidden = true; });
  $('#statsOut').addEventListener('click', (e) => {
    const t = e.target.closest('[data-seek]'); if (!t) return;
    VF.audio.currentTime = +t.dataset.seek; VF.audio.play().catch(() => {});
  });

  // ------------------------------------------------------------------ copier selon l'onglet
  VF.copyContent = () => {
    const d = VF.doc; if (!d) return null;
    if (activeTab === 'translate') { const tr = activeTranslation(); if (tr) return E.plain(d.segments.map((s, i) => ({ ...s, text: tr.texts[i] || s.text }))); }
    if (activeTab === 'summary' && d.summary) return summaryMarkdown(d);
    if (activeTab === 'transform' && d.transforms && d.transforms[tfFormat]) return d.transforms[tfFormat].text;
    return null;
  };
  VF.activeTranslation = activeTranslation;
  VF.ai = { hasEngine, engineLabel, noEngineHtml, summaryMarkdown, SUM_LABELS, TF_FORMATS, computeStats, tName, timeToSec, progressUi };
  VF.onDoc = (d) => { tfEditing = false; $('#tfEditor').dataset.fmt = ''; if (d && ((d.source === 'text' && activeTab === 'subs') || (d.source !== 'text' && activeTab === 'origin'))) setTab('transcript'); else renderTab(); updateBadges(); };

  // ------------------------------------------------------------------ modèles IA
  let llmList = [];
  const llmState = {};
  async function refreshLlm() {
    llmList = await window.vox.llm.list();
    renderLlm(); fillAiModelSelect();
  }
  const renderLlmSoon = (() => { let p = false; return () => { if (p) return; p = true; requestAnimationFrame(() => { p = false; renderLlm(); }); }; })();
  const meter = (n) => `<div class="meter">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
  function renderLlm() {
    const a = VF.settings.ai || {};
    $('#llmGrid').innerHTML = llmList.map((m) => {
      const st = llmState[m.id];
      const busy = m.downloading || (st && !['done', 'error', 'cancelled'].includes(st.phase));
      const active = a.provider !== 'openai' && (a.localModel === m.id || (!a.localModel && m.installed && m === llmList.find((x) => x.installed)));
      let foot;
      if (busy) {
        const p = st && st.total ? (st.received / st.total) * 100 : 0;
        const label = !st || st.phase === 'resolve' ? 'Recherche du fichier…' : `${VF.fmtBytes(st.received || 0)} / ${VF.fmtBytes(st.total || m.size)}${st.speed ? ' · ' + (st.speed / 1048576).toFixed(1).replace('.', ',') + ' Mo/s' : ''}`;
        foot = `<div class="mprog"><div class="progress ${!p ? 'indeterminate' : ''}"><i style="width:${p}%"></i></div><div class="mfoot"><span>${label}</span><button class="btn ghost small danger" data-llm-cancel="${esc(m.id)}">Annuler</button></div></div>`;
      } else if (m.installed) {
        foot = `<div class="mfoot"><span class="sz">${VF.fmtBytes(m.onDisk || m.size || 0)}</span><div class="acts">${active ? '<span class="chip accent">Actif</span>' : `<button class="btn small" data-llm-use="${esc(m.id)}">Utiliser</button>`}
          ${m.origin === 'lmstudio' ? `<button class="btn ghost small" data-llm-remove="${esc(m.id)}" title="Masquer ce modèle de la liste (le fichier n’est pas supprimé)">Masquer</button>` : `<button class="btn ghost small danger" data-llm-remove="${esc(m.id)}" title="${m.origin === 'import' ? 'Retirer de la liste' : 'Supprimer'}">${VF.ICONS.trash}</button>`}</div></div>`;
      } else {
        foot = `<div class="mfoot"><span class="sz">${VF.fmtBytes(m.size)} à télécharger</span><button class="btn ${m.recommended ? 'primary' : ''} small" data-llm-install="${esc(m.id)}">Télécharger</button></div>`;
      }
      const head = m.origin === 'catalog'
        ? `<div><h3>${esc(m.name)}</h3><p>${esc(m.tagline)}</p></div><div class="meters"><span>Qualité</span>${meter(m.quality)}<span>Vitesse</span>${meter(m.speed)}<span>Mémoire</span><span>${m.ram}</span></div>`
        : `<div><h3>${esc(m.name)}</h3><p class="origin">${m.origin === 'lmstudio' ? 'Trouvé dans LM Studio' : 'Importé'} — ${esc(m.path)}</p></div>`;
      return `<div class="card mcard ${m.recommended ? 'reco' : ''}">${m.installed ? '<span class="badge inst">Installé</span>' : m.recommended ? '<span class="badge">Recommandé</span>' : ''}${head}${foot}</div>`;
    }).join('');
  }
  window.vox.llm.onProgress((p) => {
    llmState[p.id] = { ...(llmState[p.id] || {}), ...p };
    if (p.phase === 'error' && p.message) VF.toast('Téléchargement du modèle IA : ' + esc(p.message), 'error', 9000);
    renderLlmSoon();
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-llm-install],[data-llm-cancel],[data-llm-remove],[data-llm-use]');
    if (!b) return;
    if (b.dataset.llmInstall) {
      const id = b.dataset.llmInstall;
      llmState[id] = { phase: 'resolve' }; renderLlm();
      const r = await window.vox.llm.install(id);
      delete llmState[id];
      if (r.ok) {
        VF.toast('Modèle IA installé ✔ Le résumé et la traduction sont prêts.', 'ok');
        if (!(VF.settings.ai || {}).localModel) await VF.setSetting({ ai: { localModel: id } });
      }
      await refreshLlm(); renderTab();
    }
    if (b.dataset.llmCancel) { llmState[b.dataset.llmCancel] = { phase: 'cancelled' }; await window.vox.llm.cancel(b.dataset.llmCancel); renderLlm(); }
    if (b.dataset.llmRemove) {
      const m = llmList.find((x) => x.id === b.dataset.llmRemove);
      if (Object.keys(running).length) { VF.toast('Une opération IA est en cours.', 'error'); return; }
      if (!confirm(m.origin === 'lmstudio' ? `Masquer « ${m.name} » de la liste ? (le fichier de LM Studio n’est pas supprimé)` : m.origin === 'import' ? `Retirer « ${m.name} » de la liste ? (le fichier n’est pas supprimé)` : `Supprimer le modèle IA « ${m.name} » ?`)) return;
      await window.vox.llm.remove(m.id); await refreshLlm(); renderTab();
    }
    if (b.dataset.llmUse) {
      await VF.setSetting({ ai: { localModel: b.dataset.llmUse, provider: 'local' } });
      renderAiSettings(); await refreshLlm(); renderTab();
      VF.toast('Modèle IA actif : <b>' + esc(llmList.find((x) => x.id === b.dataset.llmUse).name) + '</b>');
    }
  });
  $('#btnLlmImport').onclick = async () => {
    try {
      const m = await window.vox.llm.import();
      if (m) { await VF.setSetting({ ai: { localModel: m.id, provider: 'local' } }); await refreshLlm(); VF.toast(`Modèle « ${esc(m.name)} » importé et activé ✔`, 'ok'); }
    } catch (e) { VF.toast(esc(cleanErr(e)), 'error'); }
  };

  // ------------------------------------------------------------------ paramètres IA
  function fillAiModelSelect() {
    const sel = $('#setAiModel'); const a = VF.settings.ai || {};
    const inst = llmList.filter((m) => m.installed);
    sel.innerHTML = inst.length ? inst.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('') : '<option value="">— aucun modèle installé —</option>';
    if (inst.find((m) => m.id === a.localModel)) sel.value = a.localModel;
  }
  function renderAiSettings() {
    const a = VF.settings.ai || {};
    $$('#setAiProvider button').forEach((b) => b.classList.toggle('active', b.dataset.v === a.provider));
    $$('[data-ai]').forEach((el) => { el.hidden = el.dataset.ai !== a.provider; });
    $('#setAiGpu').checked = a.gpu !== 'off';
    $('#setAiParallel').checked = a.parallel !== 'off';
    $('#setAiUrl').value = a.baseUrl || '';
    $('#setAiKey').value = ''; $('#setAiKey').placeholder = a.apiKeySet ? '•••••••• (enregistrée — saisir pour remplacer)' : 'sk-…';
    const rs = $('#setAiRemoteModel');
    if (a.remoteModel && ![...rs.options].some((o) => o.value === a.remoteModel)) rs.insertAdjacentHTML('beforeend', `<option value="${esc(a.remoteModel)}">${esc(a.remoteModel)}</option>`);
    rs.value = a.remoteModel || '';
  }
  const unloadAi = () => window.vox.ai.unload();
  $('#setAiProvider').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    await VF.setSetting({ ai: { provider: b.dataset.v } }); renderAiSettings(); renderLlm(); renderTab();
  });
  $('#setAiModel').onchange = async (e) => { await VF.setSetting({ ai: { localModel: e.target.value } }); renderLlm(); renderTab(); };
  $('#setAiGpu').onchange = async (e) => { await VF.setSetting({ ai: { gpu: e.target.checked ? 'auto' : 'off' } }); unloadAi(); };
  $('#setAiParallel').onchange = async (e) => { await VF.setSetting({ ai: { parallel: e.target.checked ? 'auto' : 'off' } }); unloadAi(); };
  $('#setAiUrl').onchange = async (e) => { await VF.setSetting({ ai: { baseUrl: e.target.value.trim() } }); unloadAi(); };
  $('#setAiKey').onchange = async (e) => {
    const v = e.target.value.trim();
    try { await window.vox.secrets.enregistrer('ai_api_key', v); VF.toast(v ? 'Clé d’API enregistrée dans le coffre chiffré ✔' : 'Clé d’API effacée.', 'ok'); }
    catch (err) { VF.toast(esc(cleanErr(err)), 'error', 8000); }
    e.target.value = '';
    VF.settings = await window.vox.settings.get(); renderAiSettings(); unloadAi();
  };
  $('#setAiRemoteModel').onchange = async (e) => { await VF.setSetting({ ai: { remoteModel: e.target.value } }); unloadAi(); };
  $('#setAiTest').onclick = async () => {
    const a = VF.settings.ai;
    $('#setAiRemoteHint').textContent = 'Connexion…';
    try {
      const list = await window.vox.llm.remoteModels(a.baseUrl);
      const rs = $('#setAiRemoteModel');
      rs.innerHTML = '<option value="">(automatique)</option>' + list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      rs.value = list.includes(a.remoteModel) ? a.remoteModel : '';
      $('#setAiRemoteHint').textContent = `Connexion réussie ✔ ${list.length} modèle${list.length > 1 ? 's' : ''} disponible${list.length > 1 ? 's' : ''}`;
    } catch (e) {
      $('#setAiRemoteHint').textContent = 'Échec : ' + cleanErr(e) + ' — le serveur est-il démarré ?';
    }
  };
  $('#btnOpenLogs').onclick = () => window.vox.openLogs();

  // ------------------------------------------------------------------ init
  VF.init = async () => {
    const a = VF.settings.ai || {};
    const fill = (sel, val) => {
      VF.fillLangSelect(sel, val);
      sel.querySelector('option[value=""]').remove();
      const og = sel.querySelector('optgroup');
      og.insertAdjacentHTML('beforeend', Object.entries(EXTRA_TARGETS).map(([c, n]) => `<option value="${c}">${n}</option>`).join(''));
      sel.value = val;
    };
    fill($('#trTarget'), a.translateTarget || 'en');
    fill($('#sumLang'), a.summaryLang || 'fr');
    fill($('#tfLang'), a.transformLang || 'fr');
    $('#sumLength').value = a.summaryLength || 'medium';
    renderAiSettings();
    // liste des modèles IA chargée juste après l'affichage (ne retarde pas l'ouverture)
    setTimeout(() => refreshLlm().then(() => renderTab()).catch(() => {}), 300);
  };
  // rafraîchit la liste quand on ouvre l'onglet Modèles
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => { if (b.dataset.view === 'models') refreshLlm(); }));
})();
