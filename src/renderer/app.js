/* VoxForge — interface */
// erreurs de l'interface → journal (le preload ne voit pas celles de la page)
window.addEventListener('unhandledrejection', (e) => window.vox && window.vox.log('Promesse rejetée : ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const E = window.Exporters;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtBytes = (b) => (b >= 1e9 ? (b / 1073741824).toFixed(2).replace('.', ',') + ' Go' : b >= 1048576 ? Math.round(b / 1048576) + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');
  const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const ICONS = {
    audio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8Z"/></svg>',
    spin: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
    err: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3h.01"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>',
    play: '<path d="m7 4 13 8-13 8V4Z"/>',
    pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  };
  const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'flv', 'webm'];
  const ACCENTS = ['#7c5cff', '#4f8cff', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#a855f7'];

  // ------------------------------------------------------------------ état
  let settings = {};
  let modelList = [];
  const queue = [];
  let running = null;      // job en cours
  let doc = null;          // document affiché
  let selectedJob = null;

  function toast(msg, kind = '', ms = 4200) {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
    return t;
  }

  // ------------------------------------------------------------------ navigation
  function show(view) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    if (view === 'history') renderHistory();
    if (view === 'models') refreshModels();
    if (view === 'live') initMics();
    if (view === 'projects' && window.VF && window.VF.renderProjects) window.VF.renderProjects();
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // ------------------------------------------------------------------ thème
  function resolvedTheme() {
    if (settings.theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return settings.theme || 'dark';
  }
  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme();
    root.style.setProperty('--accent', settings.accent || ACCENTS[0]);
    const cs = getComputedStyle(root);
    window.vox.settings.titlebar({ color: cs.getPropertyValue('--bg').trim(), symbolColor: cs.getPropertyValue('--muted').trim() });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => settings.theme === 'system' && applyTheme());

  async function setSetting(patch) {
    settings = await window.vox.settings.set(patch);
    return settings;
  }

  // ------------------------------------------------------------------ sélecteurs
  function fillLangSelect(sel, value, autoLabel = 'Détection automatique') {
    const entries = Object.entries(window.LANGUAGES).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
    const top = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar', 'zh', 'ja', 'ru'];
    sel.innerHTML = `<option value="">✨ ${autoLabel}</option>` +
      `<optgroup label="Fréquentes">${top.map((c) => `<option value="${c}">${window.LANGUAGES[c]}</option>`).join('')}</optgroup>` +
      `<optgroup label="Toutes les langues (99)">${entries.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</optgroup>`;
    sel.value = value || '';
  }
  function fillModelSelects() {
    const inst = modelList.filter((m) => m.installed);
    const html = inst.length
      ? inst.map((m) => `<option value="${m.id}">${esc(m.name)}${advice && advice.recommended === m.id ? ' ★' : ''}</option>`).join('')
      : '<option value="">— Aucun modèle installé —</option>';
    for (const sel of [$('#optModel'), $('#liveModel')]) {
      sel.innerHTML = html;
      if (inst.find((m) => m.id === settings.model)) sel.value = settings.model;
      else if (inst.length) sel.value = (inst.find((m) => advice && m.id === advice.recommended) || inst.find((m) => m.recommended) || inst[inst.length - 1]).id;
    }
    if (inst.length && !inst.find((m) => m.id === settings.model)) setSetting({ model: $('#optModel').value });
    $('#onboarding').hidden = inst.length > 0 || modelList.some((m) => m.downloading);
    $('#modelsDot').hidden = inst.length > 0;
    const cur = inst.find((m) => m.id === $('#optModel').value);
    $('#sidebarModel').innerHTML = cur ? `Modèle actif<b>${esc(cur.name)}${readyModel === cur.id ? ' <span class="ready" title="Modèle chargé en mémoire : la transcription démarre aussitôt">⚡ prêt</span>' : ''}</b>` : 'Aucun modèle<b>À installer</b>';
    renderOnboarding();
  }

  // ------------------------------------------------------------------ conseiller de modèle
  let pc = null;          // profil du PC (processeur, mémoire, vitesses mesurées)
  let advice = null;      // estimation par modèle + modèle conseillé
  let readyModel = null;  // modèle préchargé en mémoire
  const A = window.Advisor;
  async function loadAdvisor() {
    pc = await window.vox.system.profile();
    // le test de calcul n'est refait que si le processeur change
    const bench = settings.cpuBench;
    if (bench && bench.cpu === pc.cpuModel && bench.score > 0) pc.cpuScore = bench.score;
    else {
      pc.cpuScore = A.cpuScore();
      setSetting({ cpuBench: { cpu: pc.cpuModel, score: pc.cpuScore } });
    }
    computeAdvice();
  }
  function computeAdvice() {
    if (!pc || !modelList.length) return;
    advice = A.advise({ ...pc, threads: settings.threads, language: settings.language, task: settings.task }, modelList);
    renderPcCard(); renderOnboarding();
  }
  const fmtGB = (b) => (b / 1024 ** 3).toFixed(0) + ' Go';
  function renderPcCard() {
    const box = $('#pcCard'); if (!advice) return;
    const rec = modelList.find((m) => m.id === advice.recommended); if (!rec) return;
    const est = advice.estimates[rec.id];
    const hasChecker = modelList.some((x) => x.installed && !x.engine);
    const whisperRec = modelList.find((m) => m.id === advice.whisper);
    const recWer = rec.werNoCheck && (!hasChecker || settings.parakeetCheck === false) ? rec.werNoCheck : rec.wer;
    const action = !rec.installed ? `<button class="btn primary small" data-install="${rec.id}">Installer ${esc(rec.name)}</button>`
      : settings.model !== rec.id ? `<button class="btn primary small" data-use="${rec.id}">Utiliser ${esc(rec.name)}</button>` : '<span class="chip accent">Déjà utilisé ✓</span>';
    box.hidden = false;
    box.innerHTML = `<div class="pc-ic"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg></div>
      <div class="pc-main">
        <div class="pc-spec">${esc(pc.cpuModel || 'Processeur')} · ${pc.logical} cœurs logiques (${advice.threads} utilisés) · ${fmtGB(pc.totalMem)} de mémoire</div>
        <div class="pc-reco">Conseillé pour votre PC : <b>${esc(rec.name)}</b> — ${A.perHour(est.rtf)}${recWer ? ` · ${recWer.min.toLocaleString('fr-FR')} à ${recWer.max.toLocaleString('fr-FR')} % de mots faux` : ''}</div>
        ${rec.id === 'parakeet' && !hasChecker && whisperRec ? `<small class="muted">Conseil : installez aussi « ${esc(whisperRec.name)} ». Il sert à revérifier les passages douteux et à transcrire les langues non européennes.</small>` : ''}
        ${advice.whisper && advice.whisper !== rec.id && rec.langs ? `<small class="muted">Pour les autres langues (japonais, arabe, chinois…) : <b>${esc((modelList.find((m) => m.id === advice.whisper) || {}).name || '')}</b>, utilisé automatiquement si besoin.</small>` : ''}
        <small class="muted">${advice.calibrated ? '✓ Estimation calibrée sur vos propres transcriptions.' : 'Estimation à partir de votre processeur : elle s’affine automatiquement après chaque transcription.'}
          ${rec.id === 'turbo' ? ' Turbo est presque aussi précis que Large v3, pour une fraction du temps.' : ''}${rec.id === 'parakeet' ? ' Parakeet est à la fois le plus rapide et le plus précis de nos tests.' : ''}</small>
      </div><div class="pc-act">${action}</div>`;
  }
  function renderOnboarding() {
    const box = $('#onboardingActions'); if (!box || !advice) return;
    const rec = modelList.find((m) => m.id === advice.recommended); if (!rec) return;
    const est = advice.estimates;
    // Parakeet conseillé → alternative « toutes les langues » ; sinon → un modèle vraiment plus rapide (le plus précis d'entre eux)
    const faster = A.PREFERENCE.filter((id) => id !== 'parakeet' && est[id] && est[id].ramOk && est[id].rtf > est[rec.id].rtf * 1.2);
    const alt = rec.langs ? modelList.find((m) => m.id === advice.whisper) : modelList.find((m) => m.id === faster[0]);
    const line = (m) => `${esc(m.name)} · ${fmtBytes(m.size)} · ${A.perHour(advice.estimates[m.id].rtf)}`;
    box.innerHTML = `<button class="btn primary" data-install="${rec.id}">Installer « ${line(rec)} » — conseillé pour votre PC</button>` +
      (alt ? `<button class="btn" data-install="${alt.id}">${rec.langs ? 'Toutes les langues (99)' : 'Plus rapide'} : « ${line(alt)} »</button>` : '');
  }
  window.vox.system.onPerf((perf) => { if (pc) { pc.perf = perf; computeAdvice(); renderModels(); } });
  window.vox.models.onReady((r) => { readyModel = r.selected && r.model !== r.selected ? null : r.model; fillModelSelects(); });

  // ------------------------------------------------------------------ modèles
  const dlState = {};
  async function refreshModels() {
    modelList = await window.vox.models.list();
    computeAdvice();
    fillModelSelects();
    renderModels();
  }
  function meter(n) { return `<div class="meter">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`; }
  function renderModels() {
    $('#modelsGrid').innerHTML = modelList.map((m) => {
      const st = dlState[m.id];
      const busy = m.downloading || (st && !['done', 'error', 'cancelled'].includes(st.phase));
      let foot;
      if (busy) {
        const pct = st && st.total ? (st.received / st.total) * 100 : 0;
        const label = !st ? 'Démarrage…' : st.phase === 'extract' ? `Extraction… ${Math.round(pct)} %` : st.phase === 'fallback' ? 'Changement de source…'
          : `${fmtBytes(st.received || 0)} / ${fmtBytes(st.total || m.size)} · ${st.speed ? (st.speed / 1048576).toFixed(1).replace('.', ',') + ' Mo/s' : ''}`;
        foot = `<div class="mprog"><div class="progress ${!st || !st.total ? 'indeterminate' : ''}"><i style="width:${pct}%"></i></div>
          <div class="mfoot"><span>${label}</span><button class="btn ghost small danger" data-cancel="${m.id}">Annuler</button></div></div>`;
      } else if (m.installed) {
        foot = `<div class="mfoot"><span class="sz">${fmtBytes(m.onDisk || m.size)} sur le disque</span><div class="acts">
          ${settings.model === m.id ? '<span class="chip accent">Actif</span>' : `<button class="btn small" data-use="${m.id}">Utiliser</button>`}
          <button class="btn ghost small danger" data-remove="${m.id}" title="Supprimer">${ICONS.trash}</button></div></div>`;
      } else {
        foot = `<div class="mfoot"><span class="sz">${fmtBytes(m.size)} à télécharger</span><button class="btn ${(advice ? advice.recommended === m.id : m.recommended) ? 'primary' : ''} small" data-install="${m.id}">Télécharger</button></div>`;
      }
      const reco = advice ? advice.recommended === m.id : m.recommended;
      const est = advice && advice.estimates[m.id];
      const estLine = !est ? '' : est.level === 'ram'
        ? `<div class="est est-ram">Mémoire insuffisante sur ce PC (${m.ram} requis)</div>`
        : `<div class="est est-${est.level}" title="${est.measured ? 'Vitesse mesurée sur vos transcriptions' : 'Estimation pour votre PC'}">${est.measured ? '⏱' : '≈'} ${A.perHour(est.rtf).replace(/^≈ /, '')}${est.measured ? ' (mesuré)' : ''}${est.level === 'tooslow' ? ' — trop lent pour ce PC' : ''}</div>`;
      return `<div class="card mcard ${reco ? 'reco' : ''}">
        ${reco ? '<span class="badge">Conseillé pour votre PC</span>' : m.installed ? '<span class="badge inst">Installé</span>' : ''}
        <div><h3>${esc(m.name)}</h3><p>${esc(m.tagline)}</p></div>
        <div class="meters"><span>Précision</span>${meter(m.quality)}<span>Vitesse</span>${meter(m.speed)}<span>Mémoire</span><span>${m.ram}</span></div>
        ${werLine(m)}${estLine}${foot}</div>`;
    }).join('');
  }
  /** Taux de mots faux mesuré : fourchette audio propre → audio difficile, avec une petite jauge (0 à 20 %). */
  function werLine(m) {
    if (!m.wer) return '';
    // Parakeet sans modèle Whisper installé (ou vérification désactivée) : pas de revérification
    const hasChecker = modelList.some((x) => x.installed && !x.engine);
    const noCheck = m.werNoCheck && (!hasChecker || settings.parakeetCheck === false);
    const w = noCheck ? m.werNoCheck : m.wer;
    const pct = (v) => Math.min(100, (v / 20) * 100);
    const f = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    const tone = w.avg <= 6 ? 'good' : w.avg <= 10 ? 'mid' : 'bad';
    const extra = !m.werNoCheck ? '' : noCheck
      ? `<small class="wer-warn">${hasChecker ? 'Vérification désactivée (Paramètres)' : 'Installez aussi « Large v3 Turbo »'} : les passages douteux ne sont pas revérifiés (jusqu’à ${f(m.werNoCheck.max)} % au lieu de ${f(m.wer.max)} %).</small>`
      : '<small class="wer-ok">✓ Passages douteux revérifiés par Whisper.</small>';
    return `<div class="wer wer-${tone}" title="Mesuré sur 2 enregistrements en français, chacun en 3 versions : audio propre, bruit de fond, qualité téléphone. Moyenne : ${f(w.avg)} %.">
      <div class="wer-top"><span>Mots faux</span><b>${f(w.min)} à ${f(w.max)} % <span class="muted">(moy. ${f(w.avg)} %)</span></b></div>
      <div class="wer-track"><i style="left:${pct(w.min)}%;width:${Math.max(2, pct(w.max) - pct(w.min))}%"></i><em style="left:${pct(w.avg)}%"></em></div>
      <small>soit ${Math.round(w.min)} à ${Math.round(w.max)} mots faux sur 100 selon la qualité de l’audio</small>${extra}</div>`;
  }
  async function installModel(id) {
    dlState[id] = { phase: 'download', received: 0, total: 0 };
    renderModels();
    $('#onboarding').hidden = true;
    const r = await window.vox.models.install(id);
    if (r.ok) {
      toast(`Modèle <b>${esc(modelList.find((m) => m.id === id)?.name || id)}</b> installé ✔`, 'ok');
      if (!modelList.some((m) => m.installed)) await setSetting({ model: id });
    } else if (dlState[id]?.phase !== 'cancelled') {
      toast(`Échec du téléchargement : ${esc(r.error)}<br><small>Vous pouvez relancer : le téléchargement reprendra où il s’était arrêté.</small>`, 'error', 8000);
    }
    delete dlState[id];
    await refreshModels();
  }
  const renderModelsSoon = (() => { let p = false; return () => { if (p) return; p = true; requestAnimationFrame(() => { p = false; renderModels(); }); }; })();
  /** Mise à jour sur place de la carte en cours de téléchargement (le bouton « Annuler » reste cliquable). */
  function patchProgress(id) {
    const st = dlState[id]; const m = modelList.find((x) => x.id === id);
    const btn = document.querySelector(`#modelsGrid [data-cancel="${id}"]`);
    if (!st || !m || !btn || !['download', 'extract'].includes(st.phase)) return false;
    const card = btn.closest('.mcard'); const bar = card && card.querySelector('.mprog .progress'); const lbl = card && card.querySelector('.mprog .mfoot span');
    if (!bar || !lbl) return false;
    const pct = st.total ? (st.received / st.total) * 100 : 0;
    bar.classList.toggle('indeterminate', !st.total);
    bar.querySelector('i').style.width = pct + '%';
    lbl.textContent = st.phase === 'extract' ? `Extraction… ${Math.round(pct)} %`
      : `${fmtBytes(st.received || 0)} / ${fmtBytes(st.total || m.size)} · ${st.speed ? (st.speed / 1048576).toFixed(1).replace('.', ',') + ' Mo/s' : ''}`;
    return true;
  }
  window.vox.models.onProgress((p) => {
    const prevPhase = dlState[p.id] && dlState[p.id].phase;
    dlState[p.id] = { ...(dlState[p.id] || {}), ...p };
    if (prevPhase !== p.phase || !patchProgress(p.id)) renderModelsSoon();
    const st = dlState[p.id];
    if (st.phase === 'download' || st.phase === 'extract') {
      const pct = st.total ? Math.round((st.received / st.total) * 100) : 0;
      setGlobal(`${st.phase === 'extract' ? 'Extraction' : 'Téléchargement'} du modèle ${p.id} · ${pct} %`, true);
    } else setGlobal('');
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-install],[data-cancel],[data-remove],[data-use]');
    if (!b) return;
    if (b.dataset.install) { if (b.closest('#onboarding')) show('models'); installModel(b.dataset.install); }
    if (b.dataset.cancel) { dlState[b.dataset.cancel] = { phase: 'cancelled' }; await window.vox.models.cancel(b.dataset.cancel); }
    if (b.dataset.remove) {
      const m = modelList.find((x) => x.id === b.dataset.remove);
      if (running && running.model === m.id) { toast('Ce modèle est utilisé par la transcription en cours.', 'error'); return; }
      if (live.on) { toast('Arrêtez d’abord la dictée en cours.', 'error'); return; }
      if (confirm(`Supprimer le modèle « ${m.name} » (${fmtBytes(m.onDisk)}) ?`)) {
        try { await window.vox.models.remove(m.id); } catch (err) { toast('Suppression impossible : ' + esc(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'error'); }
        await refreshModels();
      }
    }
    if (b.dataset.use) { readyModel = null; await setSetting({ model: b.dataset.use }); await refreshModels(); toast('Modèle actif : <b>' + esc(modelList.find((m) => m.id === b.dataset.use).name) + '</b>'); }
  });
  $('#btnModelsDir').onclick = () => window.vox.models.openDir();

  function setGlobal(text, busy) {
    $('#globalStatus').innerHTML = text ? `${busy ? '<i class="pulse"></i>' : ''}${esc(text)}` : '';
  }

  // ------------------------------------------------------------------ file d'attente
  async function addFiles(infos) {
    let added = 0;
    for (const f of infos) {
      if (queue.some((q) => q.path === f.path && q.status === 'pending')) continue;
      queue.push({ id: uid(), ...f, status: 'pending', progress: 0, segments: [] });
      added++;
    }
    renderQueue();
    if (added) {
      toast(`${added} fichier${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''} à la file`);
      if (!selectedJob) selectJob(queue.find((q) => q.status === 'pending'));
    }
  }
  function renderQueue() {
    $('#queueCount').textContent = queue.length;
    const ul = $('#queue');
    if (!queue.length) { ul.innerHTML = '<li class="empty">Aucun fichier pour l’instant.</li>'; return; }
    ul.innerHTML = queue.map((q) => {
      const isVid = VIDEO_EXT.includes(q.ext) && q.ext !== 'webm';
      const ico = q.status === 'running' ? ICONS.spin : q.status === 'done' ? ICONS.ok : q.status === 'error' ? ICONS.err : isVid ? ICONS.video : ICONS.audio;
      const sub = {
        pending: `En attente · ${fmtBytes(q.size)}`,
        running: q.statusText || 'Transcription…',
        done: `Terminé · ${E.short(q.duration)} · ${window.langName(q.language)}`,
        error: 'Erreur : ' + (q.error || ''),
        cancelled: 'Annulé',
      }[q.status];
      return `<li class="qitem ${q.status} ${selectedJob === q ? 'selected' : ''}" data-id="${q.id}" title="${esc(q.path)}">
        <span class="ico">${ico}</span><div style="min-width:0"><div class="nm">${esc(q.name)}</div><div class="sub">${esc(sub)}</div></div>
        <button class="x" data-rm="${q.id}" title="${q.status === 'running' ? 'Annuler' : 'Retirer'}">${ICONS.x}</button>
        ${q.status === 'running' ? `<i class="bar" style="width:${(q.progress * 100).toFixed(1)}%"></i>` : ''}</li>`;
    }).join('');
  }
  $('#queue').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const q = queue.find((x) => x.id === rm.dataset.rm);
      if (q.status === 'running') cancelRunning();
      else { queue.splice(queue.indexOf(q), 1); if (selectedJob === q) { selectedJob = null; showDoc(null); } renderQueue(); }
      return;
    }
    const li = e.target.closest('.qitem');
    if (li) selectJob(queue.find((x) => x.id === li.dataset.id));
  });
  $('#btnAddFolder').onclick = async () => {
    const files = await window.vox.files.openFolder();
    if (!files.length) { toast('Aucun fichier audio ou vidéo trouvé dans ce dossier.'); return; }
    addFiles(files);
  };
  $('#btnClearDone').onclick = () => {
    for (let i = queue.length - 1; i >= 0; i--) if (['done', 'error', 'cancelled'].includes(queue[i].status)) queue.splice(i, 1);
    if (selectedJob && !queue.includes(selectedJob)) { selectedJob = null; }
    renderQueue();
  };

  /** Un seul objet document par tâche : traductions, résumés, étiquettes… ne sont jamais perdus en changeant de fichier. */
  function jobDoc(q) {
    const d = q._doc || (q._doc = { source: 'file', job: q, translations: {}, summary: null, transforms: {}, folder: '', tags: [], favorite: false });
    if (!q.createdAt) q.createdAt = new Date().toISOString();
    return Object.assign(d, {
      id: q.historyId || q.id, title: q.title || q.name.replace(/\.[^.]+$/, ''), file: q.path, segments: q.segments,
      language: q.language || '', duration: q.duration || 0, model: q.model || settings.model, task: q.task || 'transcribe',
      createdAt: q.createdAt, elapsed: q.elapsed, languages: q.languages,
    });
  }
  function selectJob(q) {
    selectedJob = q || null;
    renderQueue();
    if (q) showDoc(jobDoc(q)); else showDoc(null);
  }

  // drag & drop
  let TEXT_EXTS = ['txt', 'md', 'docx', 'odt', 'pdf', 'srt', 'vtt', 'html', 'htm', 'rtf'];
  window.vox.text.exts().then((x) => { if (Array.isArray(x)) TEXT_EXTS = x; }).catch(() => {});
  const isTextFile = (p) => TEXT_EXTS.includes(String(p).split('.').pop().toLowerCase());
  const dz = $('#dropzone');
  dz.onclick = async () => {
    const infos = await window.vox.files.open();
    const texts = infos.filter((f) => isTextFile(f.path));
    if (texts.length && window.VF && window.VF.importTexts) window.VF.importTexts(texts.map((f) => f.path), false);
    addFiles(infos.filter((f) => !isTextFile(f.path)));
  };
  dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') dz.click(); };
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dragOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dragOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('#dragOverlay').hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => window.vox.files.pathOf(f)).filter(Boolean);
    if (!paths.length) return;
    const infos = await window.vox.files.info(paths);
    const texts = infos.filter((f) => isTextFile(f.path));
    const media = infos.filter((f) => !isTextFile(f.path));
    if (texts.length && window.VF && window.VF.importTexts) window.VF.importTexts(texts.map((f) => f.path), !media.length);
    if (media.length) { show('transcribe'); addFiles(media); }
  });

  // options
  $$('#optTask button').forEach((b) => b.onclick = async () => {
    $$('#optTask button').forEach((x) => x.classList.toggle('active', x === b));
    readyModel = null;
    await setSetting({ task: b.dataset.task });
    computeAdvice(); renderModels(); fillModelSelects();
  });
  $('#optModel').onchange = async (e) => { readyModel = null; await setSetting({ model: e.target.value }); $('#liveModel').value = e.target.value; fillModelSelects(); };
  $('#optLang').onchange = async (e) => { readyModel = null; await setSetting({ language: e.target.value }); computeAdvice(); renderModels(); fillModelSelects(); };
  $('#optMulti').onchange = (e) => setSetting({ multilingual: e.target.checked });

  // ------------------------------------------------------------------ exécution
  $('#btnStart').onclick = startQueue;
  function startQueue() {
    if (!modelList.some((m) => m.installed)) { toast('Installez d’abord un modèle (onglet <b>Modèles</b>).', 'error'); show('models'); return; }
    const cur = modelList.find((m) => m.id === settings.model);
    if (cur && cur.noTranslate && settings.task === 'translate' && !modelList.some((m) => m.installed && !m.engine)) {
      toast(`« ${esc(cur.name)} » ne sait pas traduire vers l’anglais. Installez « Large v3 Turbo » (onglet <b>Modèles</b>) ou choisissez « Transcrire ».`, 'error', 9000);
      return;
    }
    if (!queue.some((q) => q.status === 'pending')) {
      if (!queue.length) { dz.click(); return; }
      // Rien en attente : on relance les fichiers annulés ou en erreur
      const retry = queue.filter((q) => ['cancelled', 'error'].includes(q.status));
      if (!retry.length) { toast('Tous les fichiers sont déjà transcrits. Ajoutez-en d’autres !'); return; }
      retry.forEach((q) => { q.status = 'pending'; q.error = null; });
      toast(`Nouvelle tentative pour ${retry.length} fichier${retry.length > 1 ? 's' : ''}.`);
    }
    if (!running) runNext(true);
  }
  async function runNext(fromUser = false, prev = null) {
    if (running && running.status === 'running') return; // une seule transcription à la fois
    const q = queue.find((x) => x.status === 'pending');
    if (!q) { running = null; setGlobal(''); updateStartBtn(); return; }
    // on n'arrache pas l'utilisateur au document qu'il est en train de lire/corriger
    // on suit la file si l'utilisateur regardait le fichier qui vient de finir (sauf s'il est en train d'écrire dedans)
    const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#resultBody') && /INPUT|TEXTAREA/.test(document.activeElement.tagName + (document.activeElement.isContentEditable ? 'TEXTAREA' : ''));
    const follow = fromUser || !doc || doc.job === q || (prev && doc.job === prev && !editing);
    running = q;
    q._doc = null; // nouvelle transcription : les anciennes traductions/résumés ne correspondent plus
    Object.assign(q, {
      status: 'running', progress: 0, segments: [], cancelling: false, language: settings.language || '', statusText: 'Chargement du modèle…',
      model: settings.model, task: settings.task, multilingual: settings.multilingual, createdAt: new Date().toISOString(), startedAt: Date.now(),
    });
    if (follow) selectJob(q); else renderQueue();
    updateStartBtn();
    try {
      await window.vox.transcribe.start(q.id, q.path, { model: q.model, language: settings.language, task: q.task, multilingual: q.multilingual });
    } catch (e) {
      finishJob(q, 'error', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }
  function updateStartBtn() {
    $('#btnStart').disabled = !!running;
    $('#btnCancel').disabled = !running || !!running.cancelling;
    $('#btnStart').innerHTML = running ? `${ICONS.spin.replace('<svg', '<svg style="animation:spin 1.1s linear infinite"')}En cours…` : '<svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8V4Z"/></svg>Lancer';
  }
  function cancelRunning() {
    if (!running || running.cancelling) return;
    running.cancelling = true;
    $('#btnCancel').disabled = true;
    running.statusText = 'Annulation…'; renderQueue();
    window.vox.transcribe.cancel(running.id);
  }
  $('#btnCancel').onclick = cancelRunning;

  window.vox.transcribe.onEvent((ev) => {
    const q = queue.find((x) => x.id === ev.jobId);
    if (!q) return;
    switch (ev.type) {
      case 'status': q.statusText = ev.message; if (ev.model) { q.model = ev.model; toast(esc(ev.message), '', 6000); } break;
      case 'engine-switch': {
        if (ev.model) q.model = ev.model;
        const wn = esc((modelList.find((m) => m.id === ev.model) || {}).name || 'Whisper');
        toast(ev.reason === 'drift'
          ? `Parakeet bascule souvent en anglais sur « ${esc(q.name)} » : la suite est transcrite avec ${wn}.`
          : `Langue détectée : <b>${esc(window.langName(ev.language))}</b> — non gérée par Parakeet, transcription avec ${wn}.`, '', 7000);
        break;
      }
      case 'duration': q.duration = ev.duration; break;
      case 'language': q.language = ev.language; break;
      case 'segment':
        q.segments.push(ev.segment);
        if (!q.language && ev.segment.lang) q.language = ev.segment.lang;
        if (doc && doc.job === q) appendSegment(ev.segment);
        break;
      case 'progress': {
        q.progress = ev.ratio || 0;
        const speed = ev.elapsed > 0 ? ev.position / ev.elapsed : 0;
        const remain = speed > 0 && ev.duration ? (ev.duration - ev.position) / speed : 0;
        q.statusText = `${Math.round(q.progress * 100)} % · ${speed ? speed.toFixed(1).replace('.', ',') + '× temps réel' : ''}${remain > 5 ? ' · reste ~' + humanDur(remain) : ''}`;
        q.progressText = `${E.short(ev.position)} / ${E.short(ev.duration)} · ${q.statusText}`;
        break;
      }
      case 'done':
        Object.assign(q, { language: ev.result.language || q.language, languages: ev.result.languages, duration: ev.result.duration, elapsed: ev.result.elapsed });
        q.segments = ev.result.segments;
        finishJob(q, 'done');
        return;
      case 'cancelled': finishJob(q, 'cancelled'); return;
      case 'error': finishJob(q, 'error', ev.message); return;
      case 'crash': finishJob(q, 'error', `Le moteur s’est arrêté (code ${ev.code}). Mémoire insuffisante ? Essayez un modèle plus léger.`); return;
      default: break;
    }
    throttledJobUi(q);
  });
  const throttledJobUi = (() => {
    let pending = false;
    return (q) => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; if (q.status !== 'running') return; renderQueue(); if (doc && doc.job === q) updateDocProgress(q); setGlobal(`Transcription : ${q.name} · ${Math.round(q.progress * 100)} %`, true); }); };
  })();
  function humanDur(s) { s = Math.round(s); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; }

  async function finishJob(q, status, error) {
    if (['done', 'error', 'cancelled'].includes(q.status)) return; // évènement en double
    q.status = status;
    q.error = error;
    if (status === 'done') {
      const n = q.segments.length;
      if (!n) toast(`« ${esc(q.name)} » : aucune parole détectée. Essayez de baisser la sensibilité de détection de voix (Paramètres).`, 'error', 7000);
      else toast(`✔ « ${esc(q.name)} » transcrit en ${humanDur(q.elapsed || 0)} (${esc(window.langName(q.language))})`, 'ok');
      if (settings.autoSave && n) {
        q.historyId = q.historyId || q.id;
        try {
          await window.vox.history.save(toHistory(jobDoc(q)));
          if (window.VF && window.VF.onJobSaved) window.VF.onJobSaved(jobDoc(q));
        } catch (e) { toast('Enregistrement dans l’historique impossible : ' + esc(e.message), 'error'); }
      }
    } else if (status === 'error') toast(`Erreur sur « ${esc(q.name)} » : ${esc(error)}`, 'error', 9000);
    else if (status === 'cancelled') toast(`« ${esc(q.name)} » annulé. Cliquez sur « Lancer » pour continuer la file.`, '', 3500);
    if (running === q) running = null; // libéré seulement maintenant : « Lancer » ne peut pas démarrer 2 tâches
    renderQueue();
    if (doc && doc.job === q) showDoc(jobDoc(q));
    updateStartBtn();
    if (status !== 'cancelled') runNext(false, q); else { setGlobal(''); }
  }

  // ------------------------------------------------------------------ affichage d'un document
  const audio = $('#audio');
  let segEls = [];
  function showDoc(d) {
    doc = d;
    $('#resultEmpty').hidden = !!d;
    $('#resultBody').hidden = !d;
    if (!d) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    $('#resTitle').value = d.title;
    renderMeta();
    const q = d.job;
    const isRunning = q && q.status === 'running';
    $('#progressWrap').hidden = !isRunning;
    if (isRunning) updateDocProgress(q);
    const isText = d.source === 'text';
    $('#result').classList.toggle('is-text', isText);
    const subsTab = $('#docTabs [data-tab="subs"]'); if (subsTab) subsTab.hidden = isText;
    renderSegments();
    loadAudio(isText ? null : d.file);
    $('#resSearch').value = '';
    $('#resSearchCount').textContent = '';
    hits = []; hitIdx = -1;
    if (window.VF && window.VF.onDoc) window.VF.onDoc(d);
  }
  function renderMeta() {
    const d = doc; if (!d) return;
    const q = d.job;
    const chips = [];
    const votes = d.languages || {};
    const tot = Object.values(votes).reduce((a, b) => a + b, 0);
    const langs = Object.entries(votes).filter(([, v]) => tot && v / tot >= 0.12).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (langs.length > 1) chips.push(`<span class="chip accent">${langs.map((l) => esc(window.langName(l))).join(' · ')}</span>`);
    else if (d.language) chips.push(`<span class="chip accent">${esc(window.langName(d.language))}</span>`);
    if (d.task === 'translate') chips.push('<span class="chip">Traduit en anglais</span>');
    if (d.source === 'text') chips.push(`<span class="chip">📄 Texte importé${d.textKind ? ' (.' + esc(d.textKind) + ')' : ''}</span>`);
    else if (d.duration) chips.push(`<span class="chip">Durée ${E.short(d.duration)}</span>`);
    const words = wordCount(d);
    if (words) chips.push(`<span class="chip">${words.toLocaleString('fr-FR')} mots</span>`);
    const m = modelList.find((x) => x.id === d.model);
    if (m) chips.push(`<span class="chip">${esc(m.name)}</span>`);
    if (d.outline && d.outline.length) chips.push(`<span class="chip">Plan : ${d.outline.length} titre${d.outline.length > 1 ? 's' : ''}</span>`);
    if (d.elapsed && d.duration) chips.push(`<span class="chip">${humanDur(d.elapsed)} · ${(d.duration / d.elapsed).toFixed(1).replace('.', ',')}× temps réel</span>`);
    if (q && q.status === 'pending') chips.push('<span class="chip">En attente — cliquez sur « Lancer »</span>');
    $('#resMeta').innerHTML = chips.join('');
  }
  let wc = { segs: null, n: -1, words: 0 };
  function wordCount(d) {
    if (wc.segs !== d.segments || wc.n !== d.segments.length) {
      let w = 0;
      for (const s of d.segments) w += s.text.split(/\s+/).filter(Boolean).length;
      wc = { segs: d.segments, n: d.segments.length, words: w };
    }
    return wc.words;
  }
  function updateDocProgress(q) {
    const indeterminate = !q.duration || q.progress === 0;
    $('#progressWrap').hidden = q.status !== 'running';
    $('.progress', $('#progressWrap')).classList.toggle('indeterminate', indeterminate);
    $('#progressBar').style.width = (q.progress * 100).toFixed(1) + '%';
    $('#progressText').textContent = q.progressText || q.statusText || '';
    renderMeta();
  }
  function segHtml(s, i) {
    return `<div class="seg" data-i="${i}"><div class="ts" data-t="${s.start}">${E.short(s.start)}${doc && doc.multiLang && s.lang ? `<small>${esc(s.lang)}</small>` : ''}</div><div class="tx" contenteditable="plaintext-only" spellcheck="true">${esc(s.text)}</div></div>`;
  }
  const headText = (h) => `${h.label && !/^(Introduction|Conclusion)$/i.test(h.label) && !h.title.toLowerCase().startsWith(h.label.toLowerCase()) ? `<b>${esc(h.label)}</b> — ` : ''}${esc(h.title)}`;
  const headHtml = (h) => `<div class="outline-h d${h.depth || 0}" data-t="${h.start}" title="Titre repéré automatiquement dans le plan du cours">${headText(h)}</div>`;
  function renderSegments() {
    const box = $('#segments');
    const d = doc;
    d.multiLang = new Set(d.segments.map((s) => s.lang).filter(Boolean)).size > 1;
    const running = d.job && d.job.status === 'running';
    d.outline = !running && window.VoxOutline ? window.VoxOutline.withDepth(window.VoxOutline.detectOutline(d.segments)) : (d.outline || []);
    const heads = new Map(); for (const h of d.outline || []) { if (!heads.has(h.segIndex)) heads.set(h.segIndex, []); heads.get(h.segIndex).push(h); }
    box.innerHTML = d.segments.map((sg, i) => (heads.get(i) || []).map(headHtml).join('') + segHtml(sg, i)).join('') + (running ? '<div class="typing"><i></i><i></i><i></i></div>' : '');
    segEls = $$('.seg', box);
    if (!d.segments.length && !(d.job && d.job.status === 'running')) {
      box.innerHTML = `<p class="muted" style="padding:10px">${d.job && d.job.status === 'pending' ? 'Ce fichier est en attente. Cliquez sur « Lancer » pour démarrer.' : 'Aucun texte.'}</p>`;
    }
    wc.n = -1;
    renderPlain();
  }
  function appendSegment(s) {
    const box = $('#segments');
    const typing = $('.typing', box);
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const tmp = document.createElement('div');
    tmp.innerHTML = segHtml(s, doc.segments.length - 1);
    const el = tmp.firstChild; el.classList.add('new');
    if (typing) box.insertBefore(el, typing); else box.appendChild(el);
    segEls.push(el);
    if (nearBottom) box.scrollTop = box.scrollHeight;
    if (!$('#plaintext').hidden) renderPlainSoon();
  }
  const renderPlainSoon = (() => { let t = 0; return () => { if (t) return; t = setTimeout(() => { t = 0; if (doc) renderPlain(); }, 500); }; })();
  function renderPlain() {
    const ps = E.paragraphs(doc.segments);
    const heads = new Map(); for (const h of doc.outline || []) { const sg = doc.segments[h.segIndex]; if (!sg) continue; if (!heads.has(sg)) heads.set(sg, []); heads.get(sg).push(h); }
    $('#plaintext').innerHTML = ps.map((p) => p.flatMap((sg) => heads.get(sg) || []).map((h) => `<h4 class="outline-h d${h.depth || 0}" data-t="${h.start}">${headText(h)}</h4>`).join('') +
      `<p><span class="pt" data-t="${p[0].start}">${E.short(p[0].start)}</span>${esc(p.map((s) => s.text).join(' '))}</p>`).join('') || '<p class="muted">Aucun texte.</p>';
  }
  $$('#resView button').forEach((b) => b.onclick = () => {
    $$('#resView button').forEach((x) => x.classList.toggle('active', x === b));
    const text = b.dataset.v === 'text';
    $('#segments').hidden = text; $('#plaintext').hidden = !text;
    if (text) renderPlain();
  });

  // édition
  // sauvegarde différée PAR document : changer de fichier pendant le délai n'empêche pas l'enregistrement
  const saveTimers = new Map();
  async function persistNow(d) {
    if (!d || !d.segments.length) return;
    if (d.job && d.job.status !== 'done') return;
    if (d.job) { d.job.historyId = d.job.historyId || d.job.id; d.id = d.job.historyId; }
    if (settings.autoSave || d.source !== 'file' || !d.job) {
      try { await window.vox.history.save(toHistory(d)); } catch (e) { toast('Enregistrement impossible : ' + esc(e.message), 'error'); }
    }
  }
  function persistDoc(d = doc) {
    if (!d) return;
    clearTimeout(saveTimers.get(d));
    saveTimers.set(d, setTimeout(() => { saveTimers.delete(d); persistNow(d); }, 800));
  }
  $('#segments').addEventListener('input', (e) => {
    const tx = e.target.closest('.tx'); if (!tx) return;
    const i = +tx.parentElement.dataset.i;
    if (!doc.segments[i]) return;
    doc.segments[i].text = tx.textContent.replace(/\s+/g, ' ').trim();
    wc.n = -1;
    persistDoc();
  });
  $('#segments').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.tx')) { e.preventDefault(); e.target.blur(); } });
  $('#resTitle').addEventListener('input', (e) => { doc.title = e.target.value; if (doc.job) doc.job.title = e.target.value; persistDoc(); });

  // clic horodatage → lecture
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (t && (t.closest('#segments') || t.closest('#plaintext') || t.closest('#trList') || t.closest('#summaryOut'))) { audio.currentTime = +t.dataset.t; audio.play().catch(() => {}); }
  });

  // ------------------------------------------------------------------ lecteur
  function fileUrl(p) {
    return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map((x, i) => (i === 0 && /^[a-z]:$/i.test(x) ? x : encodeURIComponent(x))).join('/');
  }
  let triedPreview = false;
  function loadAudio(p) {
    triedPreview = false;
    $('#player').hidden = !p;
    if (!p) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    audio.src = fileUrl(p);
    audio.playbackRate = +$('#rate').value;
  }
  audio.addEventListener('error', async () => {
    if (!doc || !doc.file || triedPreview) return;
    triedPreview = true;
    try {
      if (!(await window.vox.files.exists(doc.file))) { $('#player').hidden = true; return; }
      const p = await window.vox.files.preview(doc.file);
      audio.src = fileUrl(p);
    } catch { $('#player').hidden = true; }
  });
  const playIcon = $('#playIcon');
  $('#btnPlay').onclick = () => (audio.paused ? audio.play() : audio.pause());
  audio.addEventListener('play', () => { playIcon.innerHTML = ICONS.pause; });
  audio.addEventListener('pause', () => { playIcon.innerHTML = ICONS.play; });
  audio.addEventListener('loadedmetadata', () => { $('#timeDur').textContent = E.short(audio.duration); });
  $('#rate').onchange = (e) => { audio.playbackRate = +e.target.value; };
  let seeking = false;
  $('#seek').addEventListener('input', () => { seeking = true; $('#timeCur').textContent = E.short(($('#seek').value / 1000) * (audio.duration || 0)); });
  $('#seek').addEventListener('change', () => { audio.currentTime = ($('#seek').value / 1000) * (audio.duration || 0); seeking = false; });
  let curSeg = -1;
  audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    $('#timeCur').textContent = E.short(t);
    if (!seeking && audio.duration) $('#seek').value = (t / audio.duration) * 1000;
    if (!doc) return;
    let idx = -1;
    for (let i = 0; i < doc.segments.length; i++) { if (doc.segments[i].start <= t + 0.05) idx = i; else break; }
    if (idx >= 0 && t > doc.segments[idx].end + 1.5) idx = -1;
    if (idx !== curSeg) {
      if (segEls[curSeg]) segEls[curSeg].classList.remove('current');
      curSeg = idx;
      if (segEls[idx]) {
        segEls[idx].classList.add('current');
        if ($('#followPlay').checked && !audio.paused && document.activeElement?.className !== 'tx') segEls[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  });

  // ------------------------------------------------------------------ recherche
  let hits = [], hitIdx = -1;
  const runSearch = debounce(() => {
    const qv = $('#resSearch').value.trim();
    hits = []; hitIdx = -1;
    segEls.forEach((el, i) => {
      const tx = $('.tx', el); const text = doc.segments[i]?.text || '';
      if (!qv) { tx.textContent = text; return; }
      const parts = text.split(new RegExp('(' + qv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'));
      if (parts.length < 2) { tx.textContent = text; return; }
      tx.innerHTML = parts.map((p, k) => (k % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
      hits.push(...$$('mark', tx));
    });
    $('#resSearchCount').textContent = qv ? (hits.length ? `${hits.length}` : '0') : '';
    if (hits.length) nextHit();
  }, 200);
  function nextHit() {
    if (!hits.length) return;
    if (hits[hitIdx]) hits[hitIdx].classList.remove('cur');
    hitIdx = (hitIdx + 1) % hits.length;
    hits[hitIdx].classList.add('cur');
    hits[hitIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('#resSearchCount').textContent = `${hitIdx + 1}/${hits.length}`;
  }
  $('#resSearch').addEventListener('input', runSearch);
  $('#resSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nextHit(); } if (e.key === 'Escape') { e.target.value = ''; runSearch(); } });

  // ------------------------------------------------------------------ copier / exporter
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Texte copié dans le presse-papiers ✔', 'ok', 2200); }
    catch { toast('Copie impossible', 'error'); }
  }
  $('#btnCopy').onclick = () => {
    if (!doc) return;
    const alt = window.VF && window.VF.copyContent && window.VF.copyContent();
    copyText(alt || E.plain(doc.segments));
  };
  $('#btnExport').onclick = (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; };
  // menus déroulants : repositionnés à l'ouverture pour ne jamais être coupés par le bord du panneau
  function placeMenus() {
    for (const m of $$('.menu:not(.ctx-menu)')) {
      if (m.hidden) { m.style.left = m.style.right = ''; continue; }
      if (m.dataset.placed) continue;
      m.dataset.placed = '1';
      m.style.left = m.style.right = '';
      const box = (m.closest('.card') || document.body).getBoundingClientRect();
      const r = m.getBoundingClientRect();
      if (r.left < box.left + 4) { m.style.left = '0'; m.style.right = 'auto'; }
      else if (r.right > box.right - 4) { m.style.right = '0'; m.style.left = 'auto'; }
    }
    $$('.menu[hidden]').forEach((m) => { delete m.dataset.placed; });
  }
  document.addEventListener('click', () => setTimeout(placeMenus, 0), true);
  // un clic ailleurs ferme tous les menus (sauf celui dans lequel on clique)
  document.addEventListener('click', (e) => {
    const own = e.target.closest('.dropdown');
    $$('.menu:not(.ctx-menu)').forEach((m) => { if (!own || !own.contains(m)) m.hidden = true; });
  });
  $('#exportMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-fmt]'); if (!b || !doc) return;
    $('#exportMenu').hidden = true;
    const f = b.dataset.fmt;
    if (!doc.segments.length) { toast('Rien à exporter pour le moment.', 'error'); return; }
    // onglet Traduction actif : on exporte la traduction (ou une version bilingue)
    const tr = window.VF && window.VF.activeTranslation && window.VF.activeTranslation();
    let d = doc; let suffix = '';
    if (tr) {
      suffix = '-' + tr.lang;
      d = { ...doc, language: tr.lang, title: `${doc.title} (${window.langName(tr.lang)})`, segments: doc.segments.map((sg, i) => ({ ...sg, text: tr.texts[i] || sg.text })) };
    }
    if (f === 'docx' || f === 'pdf') {
      const saved = await window.vox.files.exportDoc({ format: f, markdown: docMarkdown(d), title: d.title, defaultName: (d.title || 'transcription').replace(/[\\/:*?"<>|]+/g, '_') + suffix + '.' + f });
      if (saved) { const t = toast(`Exporté : ${esc(saved.split(/[\\/]/).pop())} — <a>Afficher dans le dossier</a>`, 'ok', 6000); $('a', t).onclick = () => window.vox.files.showItem(saved); }
      return;
    }
    let content;
    if (f === 'srt-bi') {
      if (!tr) { toast('Traduisez d’abord la transcription (onglet Traduction).', 'error'); return; }
      content = doc.segments.map((sg, i) => `${i + 1}\n${E.clock(sg.start)} --> ${E.clock(sg.end)}\n${sg.text}\n${tr.texts[i] || ''}\n`).join('\n');
      suffix = '-bilingue-' + tr.lang;
    } else content = E.fmt[f](d);
    const ext = f === 'srt-bi' ? 'srt' : E.ext[f];
    const name = (doc.title || 'transcription').replace(/[\\/:*?"<>|]+/g, '_') + suffix + (f === 'txt-ts' ? '-horodate' : '') + '.' + ext;
    const saved = await window.vox.files.exportSave({ content, defaultName: name, format: ext });
    if (saved) {
      const t = toast(`Exporté : ${esc(saved.split(/[\\/]/).pop())} — <a>Afficher dans le dossier</a>`, 'ok', 6000);
      $('a', t).onclick = () => window.vox.files.showItem(saved);
      setSetting({ exportFormat: f });
    }
  });

  /** Transcription mise en forme (Markdown) pour l'export Word / PDF. */
  function docMarkdown(d) {
    const meta = [window.langName(d.language), d.source === 'text' ? 'Texte importé' : d.duration ? 'Durée ' + E.short(d.duration) : '', E.paragraphs(d.segments).length ? '' : '', d.createdAt ? new Date(d.createdAt).toLocaleDateString('fr-FR', { dateStyle: 'long' }) : ''].filter(Boolean).join(' · ');
    const O = window.VoxOutline;
    const outline = d.outline || (O ? O.withDepth(O.detectOutline(d.segments)) : []);
    const heads = new Map(); for (const h of outline) { const sg = d.segments[h.segIndex]; if (!sg) continue; if (!heads.has(sg)) heads.set(sg, []); heads.get(sg).push(h); }
    const isText = d.source === 'text';
    return `# ${d.title || 'Transcription'}\n\n*${meta}*\n\n` + E.paragraphs(d.segments).map((p) => {
      const hs = p.flatMap((sg) => heads.get(sg) || []).map((h) => (O ? O.headingMd(h) : '## ' + h.title) + '\n\n').join('');
      return hs + (isText ? '' : `**[${E.short(p[0].start)}]** `) + p.map((s) => s.text).join(' ');
    }).join('\n\n') + '\n';
  }

  // ------------------------------------------------------------------ historique
  function toHistory(d) {
    return { id: d.id, name: d.title, file: d.file, createdAt: d.createdAt, duration: d.duration, language: d.language, languages: d.languages, model: d.model, task: d.task, elapsed: d.elapsed, source: d.source, ...(d.source === 'text' ? { textKind: d.textKind, estimatedTimes: d.estimatedTimes } : {}), segments: d.segments, translations: d.translations || {}, summary: d.summary || null, transforms: d.transforms || {}, aiOrigin: d.aiOrigin || null };
  }
  let histCache = [];
  async function renderHistory() {
    histCache = await window.vox.history.list();
    drawHistory();
  }
  function drawHistory() {
    if (window.VF && window.VF.drawHistory) return window.VF.drawHistory(histCache);
    // statistiques globales
    const totalDur = histCache.reduce((a, h) => a + (h.duration || 0), 0);
    const totalWords = histCache.reduce((a, h) => a + (h.words || 0), 0);
    const langs = {};
    histCache.forEach((h) => { if (h.language) langs[h.language] = (langs[h.language] || 0) + (h.duration || 0); });
    const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => window.langName(l)).join(', ');
    $('#histStats').hidden = !histCache.length;
    $('#histStats').innerHTML = `
      <div class="tile"><div class="k">Transcriptions</div><div class="v">${histCache.length}</div></div>
      <div class="tile"><div class="k">Audio transcrit</div><div class="v">${humanDur(totalDur)}</div></div>
      <div class="tile"><div class="k">Mots</div><div class="v">${totalWords.toLocaleString('fr-FR')}</div></div>
      <div class="tile"><div class="k">Langues principales</div><div class="v" style="font-size:15px;padding-top:5px">${esc(topLangs || '—')}</div></div>`;
    const qv = $('#histSearch').value.trim().toLowerCase();
    const items = histCache.filter((h) => !qv || (h.name + ' ' + h.preview).toLowerCase().includes(qv));
    $('#historyList').innerHTML = items.length ? items.map((h) => `
      <div class="card hitem" data-h="${esc(h.id)}">
        <div class="top"><div style="min-width:0"><div class="nm">${h.source === 'live' ? '🎙️ ' : h.source === 'text' ? '📄 ' : ''}${esc(h.name)}</div>
          <div class="meta"><span class="chip accent">${esc(window.langName(h.language))}</span><span class="chip">${E.short(h.duration)}</span><span class="chip">${h.words} mots</span></div></div>
          <button class="del" data-hdel="${esc(h.id)}" title="Supprimer">${ICONS.trash}</button></div>
        <div class="pv">${esc(h.preview)}</div>
        <small class="muted">${fmtDate(h.createdAt)}</small>
      </div>`).join('') : `<div class="empty-state">${histCache.length ? 'Aucun résultat.' : 'Vos transcriptions terminées apparaîtront ici.'}</div>`;
  }
  $('#histSearch').addEventListener('input', debounce(drawHistory, 150));
  $('#historyList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-hdel]');
    if (del) { e.stopPropagation(); await window.vox.history.remove(del.dataset.hdel); renderHistory(); return; }
    const it = e.target.closest('[data-h]');
    if (!it) return;
    const h = await window.vox.history.get(it.dataset.h);
    openHistory(h);
  });
  function openHistory(h) {
    selectedJob = null; renderQueue();
    show('transcribe');
    showDoc({ id: h.id, title: h.name, file: h.file, segments: h.segments || [], translations: h.translations || {}, summary: h.summary || null, transforms: h.transforms || {}, aiOrigin: h.aiOrigin || null, folder: h.folder || '', tags: h.tags || [], favorite: !!h.favorite, language: h.language, languages: h.languages, duration: h.duration, model: h.model, task: h.task, createdAt: h.createdAt, elapsed: h.elapsed, source: h.source || 'file', textKind: h.textKind, estimatedTimes: h.estimatedTimes });
  }
  $('#histClear').onclick = async () => {
    if (!histCache.length) return;
    if (confirm(`Supprimer définitivement les ${histCache.length} transcriptions de l’historique ?`)) { await window.vox.history.clear(); renderHistory(); }
  };

  // ------------------------------------------------------------------ dictée en direct
  const live = { on: false, ctx: null, stream: null, node: null, rec: null, chunks: [], segments: [], t0: 0, timer: null, analyser: null, raf: 0, starting: false };
  async function initMics() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const sel = $('#liveMic'); const prev = sel.value;
      sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || (d.deviceId === 'default' ? 'Micro par défaut' : 'Micro ' + (i + 1)))}</option>`).join('') || '<option value="">Micro par défaut</option>';
      if (prev) sel.value = prev;
    } catch { /* */ }
  }
  $('#liveModel').onchange = async (e) => { readyModel = null; await setSetting({ model: e.target.value }); $('#optModel').value = e.target.value; fillModelSelects(); };
  $('#btnMic').onclick = () => (live.on ? stopLive() : startLive());

  async function startLive() {
    if (live.starting) return;
    if (!modelList.some((m) => m.installed)) { toast('Installez d’abord un modèle.', 'error'); show('models'); return; }
    live.starting = true;
    try {
      const deviceId = $('#liveMic').value;
      live.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      initMics();
      $('#liveState').textContent = 'Chargement du modèle…';
      const started = await window.vox.live.start({ model: $('#liveModel').value, language: $('#liveLang').value, task: 'transcribe', multilingual: !$('#liveLang').value });
      live.model = (started && started.model) || $('#liveModel').value;
      if (started && started.note) toast(esc(started.note), '', 6000);
      $('#liveModel').disabled = true;
      live.ctx = new AudioContext({ sampleRate: 16000 });
      await live.ctx.audioWorklet.addModule('capture-worklet.js');
      const src = live.ctx.createMediaStreamSource(live.stream);
      live.node = new AudioWorkletNode(live.ctx, 'pcm-capture');
      live.node.port.onmessage = (e) => window.vox.live.audio(e.data);
      live.analyser = live.ctx.createAnalyser(); live.analyser.fftSize = 1024;
      src.connect(live.analyser); src.connect(live.node);
      const mute = live.ctx.createGain(); mute.gain.value = 0; live.node.connect(mute).connect(live.ctx.destination);
      live.chunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      live.rec = new MediaRecorder(live.stream, mime ? { mimeType: mime } : undefined);
      live.rec.ondataavailable = (e) => e.data.size && live.chunks.push(e.data);
      live.rec.start(1000);
      live.segments = [];
      live.on = true; live.t0 = Date.now();
      $('#liveText').innerHTML = '';
      $('#liveOpen').disabled = true;
      $('#btnMic').classList.add('rec'); $('#btnMic').innerHTML = ICONS.stop;
      $('#liveState').textContent = 'À l’écoute…';
      live.timer = setInterval(() => { const s = (Date.now() - live.t0) / 1000; $('#liveTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }, 500);
      drawViz();
      setGlobal('Dictée en cours', true);
    } catch (e) {
      toast('Micro inaccessible : ' + esc(e.message), 'error');
      cleanupLive();
      window.vox.live.abort();
      $('#liveState').textContent = 'Prêt';
    } finally { live.starting = false; }
  }
  function drawViz() {
    const c = $('#liveViz'); const g = c.getContext('2d');
    const data = new Uint8Array(live.analyser.frequencyBinCount);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const loop = () => {
      if (!live.on) { g.clearRect(0, 0, c.width, c.height); return; }
      live.analyser.getByteTimeDomainData(data);
      g.clearRect(0, 0, c.width, c.height);
      const bars = 48; const w = c.width / bars;
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        const step = Math.floor(data.length / bars);
        for (let j = 0; j < step; j++) peak = Math.max(peak, Math.abs(data[i * step + j] - 128));
        const h = Math.max(3, (peak / 128) * c.height * 1.6);
        g.fillStyle = accent; g.globalAlpha = 0.35 + Math.min(0.65, peak / 60);
        g.beginPath(); g.roundRect(i * w + 2, (c.height - h) / 2, w - 4, Math.min(h, c.height), 3); g.fill();
      }
      live.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  function cleanupLive() {
    $('#liveModel').disabled = false;
    live.on = false;
    clearInterval(live.timer);
    cancelAnimationFrame(live.raf);
    const cv = $('#liveViz'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    $('#liveState').classList.remove('speaking');
    try { live.node && live.node.disconnect(); } catch { /* */ }
    try { live.ctx && live.ctx.close(); } catch { /* */ }
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    live.ctx = null; live.node = null; live.stream = null;
    $('#btnMic').classList.remove('rec'); $('#btnMic').innerHTML = ICONS.mic;
  }
  async function stopLive() {
    const recDone = new Promise((r) => { if (live.rec && live.rec.state !== 'inactive') { live.rec.onstop = r; live.rec.stop(); } else r(); });
    cleanupLive();
    $('#liveState').textContent = 'Finalisation…';
    await recDone;
    live.blob = new Blob(live.chunks, { type: 'audio/webm' });
    await window.vox.live.stop();
  }
  window.vox.live.onEvent(async (ev) => {
    if (ev.type === 'segment') {
      live.segments.push(ev.segment);
      const t = $('#liveText');
      if (live.segments.length === 1) t.innerHTML = '';
      const p = document.createElement('div'); p.className = 'ln';
      p.innerHTML = `<small>${E.short(ev.segment.start)}</small>${esc(ev.segment.text)}`;
      t.appendChild(p); t.scrollTop = t.scrollHeight;
    } else if (ev.type === 'live-level') {
      if (live.on) { $('#liveState').textContent = ev.speaking ? 'Vous parlez…' : 'À l’écoute…'; $('#liveState').classList.toggle('speaking', ev.speaking); }
    } else if (ev.type === 'live-done') {
      setGlobal('');
      $('#liveState').textContent = 'Prêt'; $('#liveState').classList.remove('speaking');
      const r = ev.result;
      if (!r.segments.length) { toast('Aucune parole détectée.', 'error'); return; }
      let file = null;
      try { if (live.blob && live.blob.size) file = (await window.vox.files.saveRecording(await live.blob.arrayBuffer(), 'webm')).path; } catch { /* */ }
      const d = { id: uid(), title: 'Dictée du ' + new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }), file, segments: r.segments, language: r.language, duration: r.duration, model: live.model || $('#liveModel').value, task: 'transcribe', createdAt: new Date().toISOString(), source: 'live' };
      live.lastDoc = d;
      $('#liveOpen').disabled = false;
      if (settings.autoSave) await window.vox.history.save(toHistory(d));
      toast('Dictée enregistrée dans l’historique ✔', 'ok');
    } else if (ev.type === 'error' || ev.type === 'crash') {
      toast('Dictée : ' + esc(ev.message || 'le moteur s’est arrêté'), 'error');
      cleanupLive(); setGlobal(''); $('#liveState').textContent = 'Prêt';
    }
  });
  $('#liveCopy').onclick = () => copyText(live.segments.map((s) => s.text).join(' '));
  $('#liveOpen').onclick = () => live.lastDoc && openHistory(toHistory(live.lastDoc));

  // ------------------------------------------------------------------ paramètres
  function renderSettings(info) {
    $$('#setTheme button').forEach((b) => b.classList.toggle('active', b.dataset.v === settings.theme));
    $('#setAccent').innerHTML = ACCENTS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === settings.accent ? 'active' : ''}" title="${c}"></button>`).join('') +
      `<input type="color" id="setAccentCustom" value="${settings.accent}" title="Couleur personnalisée">`;
    const th = $('#setThreads'); th.max = Math.max(2, info.cpus); th.value = settings.threads; $('#setThreadsVal').textContent = settings.threads;
    $('#threadsHint').textContent = `Votre PC dispose de ${info.cpus} cœurs logiques. Plus = plus rapide, mais le PC est plus sollicité.`;
    $('#setVad').value = settings.vadThreshold; $('#setVadVal').textContent = (+settings.vadThreshold).toFixed(2);
    $('#setFilter').checked = settings.filterHallucinations;
    $('#setAutoSave').checked = settings.autoSave;
    $('#setPreload').checked = settings.preload !== false;
    $('#setParakeetCheck').checked = settings.parakeetCheck !== false;
    $('#setModelsDir').textContent = settings.modelsDir;
  }
  $('#setTheme').addEventListener('click', async (e) => { const b = e.target.closest('button'); if (!b) return; await setSetting({ theme: b.dataset.v }); applyTheme(); renderSettings(appInfo); });
  $('#setAccent').addEventListener('click', async (e) => { const b = e.target.closest('[data-c]'); if (!b) return; await setSetting({ accent: b.dataset.c }); applyTheme(); renderSettings(appInfo); });
  $('#setAccent').addEventListener('input', debounce(async (e) => { if (e.target.id !== 'setAccentCustom') return; await setSetting({ accent: e.target.value }); applyTheme(); }, 120));
  $('#setThreads').oninput = (e) => { $('#setThreadsVal').textContent = e.target.value; };
  $('#setThreads').onchange = async (e) => { readyModel = null; await setSetting({ threads: +e.target.value }); computeAdvice(); renderModels(); fillModelSelects(); };
  $('#setVad').oninput = (e) => { $('#setVadVal').textContent = (+e.target.value).toFixed(2); };
  $('#setVad').onchange = (e) => setSetting({ vadThreshold: +e.target.value });
  $('#setFilter').onchange = (e) => setSetting({ filterHallucinations: e.target.checked });
  $('#setAutoSave').onchange = (e) => setSetting({ autoSave: e.target.checked });
  $('#setParakeetCheck').onchange = async (e) => { await setSetting({ parakeetCheck: e.target.checked }); renderModels(); };
  $('#setPreload').onchange = async (e) => { await setSetting({ preload: e.target.checked }); if (!e.target.checked) { readyModel = null; fillModelSelects(); } };
  $('#setModelsDirBtn').onclick = async () => {
    const dir = await window.vox.models.chooseDir();
    if (!dir) return;
    try { await setSetting({ modelsDir: dir }); }
    catch (e) { toast(esc(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'error', 8000); return; }
    renderSettings(appInfo);
    await refreshModels();
    toast('Dossier des modèles modifié. Les modèles déjà présents dans ce dossier sont détectés automatiquement.');
  };

  // ------------------------------------------------------------------ raccourcis
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); show('transcribe'); dz.click(); }
    else if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); startQueue(); }
    else if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); if (doc && audio.src) $('#btnPlay').click(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); if (doc) { show('transcribe'); $('#resSearch').focus(); } }
    else if (e.key === 'F9') { e.preventDefault(); show('live'); $('#btnMic').click(); }
    else if (e.key === 'Escape') { $$('.menu:not(.ctx-menu)').forEach((m) => { m.hidden = true; }); $$('.ctx-menu').forEach((m) => m.remove()); }
  });

  // ------------------------------------------------------------------ API pour les modules (IA, statistiques)
  window.VF = {
    get doc() { return doc; },
    get settings() { return settings; },
    setSetting, toast, esc, show, E, ICONS, fmtBytes, humanDur, persistDoc, copyText, fillLangSelect, debounce, toHistory,
    /** Enregistre un document (pas forcément celui affiché) dans l'historique. */
    async saveDoc(d) {
      if (!d || !d.segments || !d.segments.length) return;
      if (d.job) {
        if (d.job.status !== 'done') return;
        d.job.historyId = d.job.historyId || d.job.id; d.id = d.job.historyId;
        if (!settings.autoSave) return;
      }
      await window.vox.history.save(toHistory(d));
    },
    get audio() { return audio; },
    get histCache() { return histCache; },
    openHistory, renderHistory, renderMeta: () => renderMeta(), docMarkdown,
    refreshSegments() { if (!doc) return; wc.n = -1; renderSegments(); renderMeta(); },
    seek(t) { audio.currentTime = t; audio.play().catch(() => {}); },
  };

  // ------------------------------------------------------------------ démarrage
  let appInfo = {};
  (async () => {
    [settings, appInfo] = await Promise.all([window.vox.settings.get(), window.vox.info()]);
    $('#appVersion').textContent = 'v' + appInfo.version;
    if (appInfo.modelsDirError) setTimeout(() => toast(`Le dossier des modèles est inaccessible (<b>${esc(appInfo.modelsDirError)}</b> : disque débranché ?). Le dossier par défaut est utilisé ; rebranchez le disque ou changez de dossier dans Paramètres.`, 'error', 12000), 1500);
    $('#aboutVersion').textContent = 'v' + appInfo.version;
    applyTheme();
    fillLangSelect($('#optLang'), settings.language);
    fillLangSelect($('#liveLang'), '');
    $('#liveLang').value = settings.language || 'fr';
    $$('#optTask button').forEach((b) => b.classList.toggle('active', b.dataset.task === settings.task));
    $('#optMulti').checked = !!settings.multilingual;
    renderSettings(appInfo);
    await refreshModels();
    renderQueue();
    hideSplash();
    // conseiller : le petit test de calcul est lancé après l'affichage (et seulement si le processeur a changé)
    setTimeout(() => loadAdvisor().then(() => { fillModelSelects(); renderModels(); }).catch((e) => window.vox.log('Conseiller : ' + e.message)), 1200);
    // les modules (IA, bibliothèque) sont chargés après ce fichier : on attend la fin du chargement de la page
    const runInit = async () => {
      if (window.VF.init) await Promise.resolve(window.VF.init()).catch((e) => { window.vox.log('Initialisation : ' + (e && e.stack || e)); toast('Erreur d’initialisation : ' + esc(e.message), 'error', 8000); });
      window.__forgePret = true; // signal « interface prête » (tous les modules chargés) pour scripts/verifier-lancement.js et piloter.js
    };
    if (document.readyState === 'complete') runInit(); else window.addEventListener('load', runInit, { once: true });
  })().catch((e) => { hideSplash(); window.vox.log('Démarrage interface : ' + (e && e.stack || e)); });
  function hideSplash() {
    const sp = document.getElementById('splash'); if (!sp) return;
    sp.style.opacity = '0'; setTimeout(() => sp.remove(), 260);
  }
  setTimeout(hideSplash, 8000); // filet de sécurité
})();
