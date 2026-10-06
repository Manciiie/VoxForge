/* VoxForge — bibliothèque : dossiers, étiquettes, favoris et projets multi-fichiers */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const VF = window.VF;
  const { esc, E } = VF;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const COLORS = ['#7c5cff', '#4f8cff', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#94a3b8'];
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const normTag = (t) => String(t || '').trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 40);
  const ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8L3 12Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
    proj: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M8 13h8M8 16h5"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/></svg>',
  };

  const folders = () => (VF.settings.library && VF.settings.library.folders) || [];
  const saveFolders = (list) => VF.setSetting({ library: { ...(VF.settings.library || {}), folders: list } });
  const folderById = (id) => folders().find((f) => f.id === id);

  // ------------------------------------------------------------------ fenêtre modale
  // pile de fenêtres modales : une modale peut en ouvrir une autre (seule celle du dessus réagit au clavier)
  const modalStack = [];
  function modal({ title, body, buttons = [], onOpen, wide }) {
    return new Promise((resolve) => {
      const base = $('#modal');
      // la première utilise #modal ; les suivantes une copie posée par-dessus
      const m = modalStack.length ? base.cloneNode(true) : base;
      if (m !== base) { m.removeAttribute('id'); m.style.zIndex = String(1000 + modalStack.length * 10); document.body.appendChild(m); }
      const q = (sel) => m.querySelector(sel);
      const bodyEl = q('.modal-body');
      q('.modal').classList.toggle('wide', !!wide);
      q('.modal-head h3').textContent = title;
      bodyEl.innerHTML = body;
      q('.modal-foot').innerHTML = buttons.map((b, i) => `<button class="btn small ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-mb="${i}">${esc(b.label)}</button>`).join('');
      m.hidden = false;
      const me = { m };
      modalStack.push(me);
      let done = false;
      const close = (v) => {
        if (done) return; done = true;
        modalStack.splice(modalStack.indexOf(me), 1);
        document.removeEventListener('keydown', onKey);
        m.onclick = null;
        if (m === base) m.hidden = true; else m.remove();
        resolve(v);
      };
      const onKey = (e) => {
        if (modalStack[modalStack.length - 1] !== me) return;
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && m.contains(e.target)) { const p = buttons.findIndex((b) => b.primary); if (p >= 0) { e.preventDefault(); act(p); } }
      };
      const act = async (i) => { const b = buttons[i]; const v = b.onClick ? await b.onClick(bodyEl) : b.value; if (v !== false) close(v === undefined ? b.value ?? true : v); };
      m.onclick = (e) => {
        if (e.target === m || e.target.closest('.modal-head .x')) return close(null);
        const b = e.target.closest('[data-mb]'); if (b) act(+b.dataset.mb);
      };
      document.addEventListener('keydown', onKey);
      if (onOpen) onOpen(bodyEl);
      const first = bodyEl.querySelector('input, select'); if (first) setTimeout(() => first.focus(), 30);
    });
  }
  VF.modal = modal;

  async function folderDialog(f) {
    let color = f ? f.color : COLORS[folders().length % COLORS.length];
    return modal({
      title: f ? 'Renommer le dossier' : 'Nouveau dossier',
      body: `<label>Nom<input type="text" id="mfName" value="${esc(f ? f.name : '')}" maxlength="40" placeholder="ex. Cours, Réunions, Podcasts…"></label>
        <div class="color-pick" id="mfColors">${COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'active' : ''}"></button>`).join('')}</div>`,
      onOpen: (b) => { $('#mfColors', b).onclick = (e) => { const x = e.target.closest('[data-c]'); if (!x) return; color = x.dataset.c; $$('#mfColors button', b).forEach((y) => y.classList.toggle('active', y === x)); }; },
      buttons: [{ label: 'Annuler', value: null }, { label: f ? 'Enregistrer' : 'Créer', primary: true, onClick: (b) => { const name = $('#mfName', b).value.trim(); if (!name) { $('#mfName', b).focus(); return false; } return { name, color }; } }],
    });
  }

  // ------------------------------------------------------------------ historique : filtres, cartes, actions
  const filter = { view: 'all', tag: '', sort: 'date' };
  const selected = new Set();
  let lastList = [];

  function allTags(list) {
    const m = new Map();
    list.forEach((h) => (h.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'));
  }

  // recherche plein texte : le texte complet reste dans le processus principal (liste allégée côté interface)
  const fts = { q: null, ids: null, pending: '' };
  VF.drawHistory = (list) => {
    if (list !== lastList) fts.q = null; // historique rechargé : résultats à recalculer
    lastList = list;
    // nettoyage de la sélection
    for (const id of [...selected]) if (!list.some((h) => h.id === id)) selected.delete(id);
    const fl = folders();
    if (filter.view.startsWith('folder:') && !folderById(filter.view.slice(7))) filter.view = 'all';
    const count = (fn) => list.filter(fn).length;
    const tags = allTags(list);
    if (filter.tag && !tags.some(([t]) => t === filter.tag)) filter.tag = '';
    $('#libSide').innerHTML = `
      <div class="lib-group">
        <button class="lib-item ${filter.view === 'all' ? 'active' : ''}" data-view-f="all"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>Toutes</span><b>${list.length}</b></button>
        <button class="lib-item ${filter.view === 'fav' ? 'active' : ''}" data-view-f="fav">${ICON.star}<span>Favoris</span><b>${count((h) => h.favorite)}</b></button>
        <button class="lib-item ${filter.view === 'none' ? 'active' : ''}" data-view-f="none" data-drop-folder="">${ICON.folder}<span>Sans dossier</span><b>${count((h) => !h.folder || !folderById(h.folder))}</b></button>
      </div>
      <div class="lib-title"><span>Dossiers</span><button class="lib-add" id="libAddFolder" title="Nouveau dossier">+</button></div>
      <div class="lib-group">
        ${fl.length ? fl.map((f) => `<div class="lib-item folder ${filter.view === 'folder:' + f.id ? 'active' : ''}" data-view-f="folder:${f.id}" data-drop-folder="${f.id}" role="button" tabindex="0">
          <i class="dot" style="background:${f.color}"></i><span>${esc(f.name)}</span><b>${count((h) => h.folder === f.id)}</b>
          <span class="lib-acts"><button data-folder-edit="${f.id}" title="Renommer">${ICON.edit}</button><button data-folder-del="${f.id}" title="Supprimer le dossier">${ICON.x}</button></span></div>`).join('')
        : '<p class="lib-empty">Créez des dossiers pour ranger vos transcriptions (glisser-déposer possible).</p>'}
      </div>
      <div class="lib-title"><span>Étiquettes</span></div>
      <div class="lib-tags">${tags.length ? tags.map(([t, n]) => `<button class="tag-chip ${filter.tag === t ? 'active' : ''}" data-tag-f="${esc(t)}">#${esc(t)} <small>${n}</small></button>`).join('') : '<p class="lib-empty">Ajoutez des étiquettes depuis une transcription ou le menu ⋯ d’une carte.</p>'}</div>`;

    // filtrage
    const qv = $('#histSearch').value.trim().toLowerCase();
    if (qv && fts.q !== qv && fts.pending !== qv) {
      fts.pending = qv;
      window.vox.history.search(qv).then((ids) => {
        if (fts.pending !== qv) return;
        fts.pending = ''; fts.q = qv; fts.ids = new Set(ids || []);
        if ($('#histSearch').value.trim().toLowerCase() === qv) VF.drawHistory(lastList);
      }).catch(() => { fts.pending = ''; });
    }
    let items = list.filter((h) => {
      if (filter.view === 'fav' && !h.favorite) return false;
      if (filter.view === 'none' && h.folder && folderById(h.folder)) return false;
      if (filter.view.startsWith('folder:') && h.folder !== filter.view.slice(7)) return false;
      if (filter.tag && !(h.tags || []).includes(filter.tag)) return false;
      if (qv && !(fts.q === qv && fts.ids.has(h.id)) && !(`${h.name} ${(h.tags || []).join(' ')} ${h.preview || ''}`).toLowerCase().includes(qv)) return false;
      return true;
    });
    const sorts = { date: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)), old: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)), name: (a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }), duration: (a, b) => (b.duration || 0) - (a.duration || 0) };
    items = items.sort(sorts[filter.sort] || sorts.date);

    const fTitle = filter.view === 'all' ? 'Historique' : filter.view === 'fav' ? 'Favoris' : filter.view === 'none' ? 'Sans dossier' : (folderById(filter.view.slice(7)) || {}).name;
    $('#histTitle').innerHTML = `${esc(fTitle || 'Historique')}${filter.tag ? ` <span class="tag-chip active small" data-tag-f="${esc(filter.tag)}">#${esc(filter.tag)} ✕</span>` : ''}`;

    // statistiques de la sélection courante
    const totalDur = items.reduce((a, h) => a + (h.duration || 0), 0);
    const totalWords = items.reduce((a, h) => a + (h.words || 0), 0);
    const langs = {};
    items.forEach((h) => { if (h.language) langs[h.language] = (langs[h.language] || 0) + (h.duration || 0); });
    const topLangs = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => window.langName(l)).join(', ');
    $('#histStats').hidden = !items.length;
    $('#histStats').innerHTML = `
      <div class="tile"><div class="k">Transcriptions</div><div class="v">${items.length}</div></div>
      <div class="tile"><div class="k">Audio transcrit</div><div class="v">${VF.humanDur(totalDur)}</div></div>
      <div class="tile"><div class="k">Mots</div><div class="v">${totalWords.toLocaleString('fr-FR')}</div></div>
      <div class="tile"><div class="k">Langues principales</div><div class="v" style="font-size:15px;padding-top:5px">${esc(topLangs || '—')}</div></div>`;

    $('#historyList').innerHTML = items.length ? items.map((h) => {
      const f = folderById(h.folder);
      const badges = [h.hasSummary ? '<span class="badge-ai" title="Résumé disponible">Résumé</span>' : '', (h.translations || []).length ? `<span class="badge-ai" title="Traductions">${h.translations.map((l) => esc(l.toUpperCase())).join(' · ')}</span>` : '', (h.transforms || []).length ? '<span class="badge-ai" title="Documents générés">Docs</span>' : ''].join('');
      return `<div class="card hitem ${selected.has(h.id) ? 'sel' : ''}" data-h="${esc(h.id)}" draggable="true">
        <div class="top">
          <label class="pick" data-lib-act title="Sélectionner"><input type="checkbox" data-pick="${esc(h.id)}" ${selected.has(h.id) ? 'checked' : ''}></label>
          <div style="min-width:0;flex:1"><div class="nm">${h.source === 'live' ? '🎙️ ' : ''}${esc(h.name)}</div>
            <div class="meta"><span class="chip accent">${esc(window.langName(h.language))}</span><span class="chip">${E.short(h.duration)}</span><span class="chip">${h.words} mots</span>${f ? `<span class="chip"><i class="dot" style="background:${f.color}"></i>${esc(f.name)}</span>` : ''}</div></div>
          <button class="ic-btn star ${h.favorite ? 'on' : ''}" data-lib-act="fav" data-id="${esc(h.id)}" title="${h.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${ICON.star}</button>
          <button class="ic-btn" data-lib-act="menu" data-id="${esc(h.id)}" title="Plus d’actions">${ICON.more}</button>
        </div>
        <div class="pv">${esc(h.preview)}</div>
        <div class="hfoot">${(h.tags || []).map((t) => `<span class="tag-chip small" data-lib-act="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}${badges}<small class="muted">${fmtDate(h.createdAt)}</small></div>
      </div>`;
    }).join('') : `<div class="empty-state">${list.length ? 'Aucune transcription ne correspond.' : 'Vos transcriptions terminées apparaîtront ici.'}</div>`;
    drawBulk();
  };

  function drawBulk() {
    const n = selected.size;
    $('#histBulk').hidden = !n;
    if (!n) return;
    $('#histBulk').innerHTML = `<b>${n} sélectionnée${n > 1 ? 's' : ''}</b>
      <button class="btn small" data-bulk="folder">${ICON.folder}Déplacer…</button>
      <button class="btn small" data-bulk="tag">${ICON.tag}Étiqueter…</button>
      <button class="btn small" data-bulk="project">${ICON.proj}Ajouter à un projet…</button>
      <button class="btn small" data-bulk="fav">${ICON.star}Favoris</button>
      <button class="btn ghost small danger" data-bulk="delete">Supprimer</button>
      <span class="spacer"></span><button class="btn ghost small" data-bulk="none">Désélectionner</button>`;
  }

  async function updateMeta(ids, patchFn) {
    for (const id of ids) {
      const h = lastList.find((x) => x.id === id);
      const patch = patchFn(h || {});
      try { await window.vox.history.update(id, patch); } catch (e) { VF.toast('Mise à jour impossible : ' + esc(e.message), 'error'); }
      // le document affiché suit les changements
      const d = VF.doc;
      if (d && d.id === id) { Object.assign(d, patch); if (d.job) Object.assign(d.job, patch); drawDocOrg(); }
    }
    await VF.renderHistory();
  }

  /** Renvoie l'id du dossier choisi ('' = sans dossier) ou null si annulé. */
  async function pickFolder() {
    const fl = folders();
    let pick = null;
    const v = await modal({
      title: 'Déplacer vers un dossier',
      body: `<div class="pick-list">${[{ id: '', name: 'Sans dossier', color: 'transparent' }, ...fl].map((f) => `<button class="pick-row" data-fid="${f.id}"><i class="dot" style="background:${f.color};${f.id ? '' : 'border:1px solid var(--line-2)'}"></i>${esc(f.name)}</button>`).join('')}</div>`,
      onOpen: (b) => { b.onclick = (e) => { const r = e.target.closest('[data-fid]'); if (r) { pick = r.dataset.fid; $('#modalFoot [data-mb="1"]').click(); } }; },
      buttons: [{ label: '+ Nouveau dossier', onClick: async () => { const f = await newFolder(); return f ? f.id : false; } }, { label: 'Annuler', value: null }],
    });
    if (pick !== null) return pick;
    return typeof v === 'string' ? v : null;
  }
  async function newFolder() {
    const r = await folderDialog();
    if (!r) return null;
    const f = { id: uid(), name: r.name, color: r.color };
    await saveFolders([...folders(), f]);
    return f;
  }

  async function tagDialog(current = []) {
    const known = allTags(lastList).map(([t]) => t);
    let tags = [...current];
    return modal({
      title: 'Étiquettes',
      body: `<div class="tag-edit" id="teList"></div>
        <input type="text" id="teInput" placeholder="Nouvelle étiquette puis Entrée (ex. important, client X, examen)" maxlength="40">
        <div class="tag-suggest" id="teSuggest"></div>`,
      onOpen: (b) => {
        const draw = () => {
          $('#teList', b).innerHTML = tags.length ? tags.map((t) => `<span class="tag-chip active">#${esc(t)} <button data-rm="${esc(t)}">✕</button></span>`).join('') : '<span class="muted">Aucune étiquette.</span>';
          const sug = known.filter((t) => !tags.includes(t));
          $('#teSuggest', b).innerHTML = sug.length ? 'Suggestions : ' + sug.slice(0, 16).map((t) => `<button class="tag-chip small" data-add="${esc(t)}">#${esc(t)}</button>`).join('') : '';
        };
        draw();
        b.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-rm]'); if (rm) { tags = tags.filter((t) => t !== rm.dataset.rm); draw(); }
          const ad = e.target.closest('[data-add]'); if (ad && !tags.includes(ad.dataset.add)) { tags.push(ad.dataset.add); draw(); }
        });
        $('#teInput', b).addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault(); e.stopPropagation();
            const t = normTag(e.target.value); if (t && !tags.includes(t)) tags.push(t);
            e.target.value = ''; draw();
          }
        });
      },
      buttons: [{ label: 'Annuler', value: null }, { label: 'Enregistrer', primary: true, onClick: (b) => { const t = normTag($('#teInput', b).value); if (t && !tags.includes(t)) tags.push(t); return tags; } }],
    });
  }

  async function chooseProject(title = 'Ajouter à un projet') {
    const list = await window.vox.projects.list();
    let pick = null;
    const v = await modal({
      title,
      body: `<div class="pick-list">${list.map((p) => `<button class="pick-row" data-pid="${p.id}"><i class="dot" style="background:${p.color || COLORS[0]}"></i>${esc(p.name)}<small>${(p.items || []).length} enreg.</small></button>`).join('') || '<p class="muted">Aucun projet pour l’instant.</p>'}</div>`,
      onOpen: (b) => { b.onclick = (e) => { const r = e.target.closest('[data-pid]'); if (r) { pick = r.dataset.pid; $('#modalFoot [data-mb="1"]').click(); } }; },
      buttons: [{ label: '+ Nouveau projet', onClick: async () => { const p = await createProject(false); return p ? p.id : false; } }, { label: 'Annuler', value: null }],
    });
    return pick || (typeof v === 'string' ? v : null);
  }

  // clics dans la liste de l'historique (phase de capture : avant l'ouverture de la carte)
  $('#historyList').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-lib-act]');
    if (!a) return;
    e.stopPropagation();
    const id = a.dataset.id;
    const act = a.dataset.libAct;
    if (act === 'fav') { const h = lastList.find((x) => x.id === id); await updateMeta([id], () => ({ favorite: !h.favorite })); }
    if (act === 'tag') { filter.tag = a.dataset.tag; VF.drawHistory(lastList); }
    if (act === 'menu') cardMenu(id, a);
    if (e.target.matches('[data-pick]')) {
      const pid = e.target.dataset.pick;
      if (e.target.checked) selected.add(pid); else selected.delete(pid);
      e.target.closest('.hitem').classList.toggle('sel', e.target.checked);
      drawBulk();
    }
  }, true);

  function cardMenu(id, anchor) {
    $$('.ctx-menu').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'menu ctx-menu';
    m.innerHTML = `<button data-cm="open">Ouvrir</button><button data-cm="folder">Déplacer vers un dossier…</button><button data-cm="tag">Étiquettes…</button><button data-cm="project">Ajouter à un projet…</button><button data-cm="rename">Renommer…</button><button data-cm="delete" class="danger">Supprimer</button>`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.position = 'fixed'; m.style.top = Math.min(window.innerHeight - 240, r.bottom + 4) + 'px'; m.style.left = Math.max(8, r.right - 220) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    m.onclick = async (e) => {
      const b = e.target.closest('[data-cm]'); if (!b) return;
      m.remove();
      const h = lastList.find((x) => x.id === id);
      if (b.dataset.cm === 'open') VF.openHistory(await window.vox.history.get(id));
      if (b.dataset.cm === 'folder') { const f = await pickFolder(); if (f !== null && f !== undefined) await updateMeta([id], () => ({ folder: f })); }
      if (b.dataset.cm === 'tag') { const t = await tagDialog(h.tags || []); if (t) await updateMeta([id], () => ({ tags: t })); }
      if (b.dataset.cm === 'project') { const p = await chooseProject(); if (p) { await window.vox.projects.addItems(p, [id]); VF.toast('Ajouté au projet ✔', 'ok'); } }
      if (b.dataset.cm === 'rename') {
        const n = await modal({ title: 'Renommer', body: `<label>Nom<input type="text" id="rnName" value="${esc(h.name)}"></label>`, buttons: [{ label: 'Annuler', value: null }, { label: 'Renommer', primary: true, onClick: (bd) => $('#rnName', bd).value.trim() || false }] });
        if (n) await updateMeta([id], () => ({ name: n }));
      }
      if (b.dataset.cm === 'delete') {
        if (confirm(`Supprimer « ${h.name} » de l’historique ?`)) { await window.vox.history.remove(id); await VF.renderHistory(); }
      }
    };
  }

  // barre de sélection multiple
  $('#histBulk').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    const ids = [...selected];
    const act = b.dataset.bulk;
    if (act === 'none') { selected.clear(); VF.drawHistory(lastList); return; }
    if (act === 'folder') { const f = await pickFolder(); if (f !== null && f !== undefined) await updateMeta(ids, () => ({ folder: f })); }
    if (act === 'tag') {
      const t = await tagDialog([]);
      if (t && t.length) await updateMeta(ids, (h) => ({ tags: [...new Set([...(h.tags || []), ...t])] }));
    }
    if (act === 'fav') { const allFav = ids.every((id) => (lastList.find((x) => x.id === id) || {}).favorite); await updateMeta(ids, () => ({ favorite: !allFav })); }
    if (act === 'project') { const p = await chooseProject(); if (p) { await window.vox.projects.addItems(p, ids); VF.toast(`${ids.length} transcription${ids.length > 1 ? 's' : ''} ajoutée${ids.length > 1 ? 's' : ''} au projet ✔`, 'ok'); } }
    if (act === 'delete') {
      if (!confirm(`Supprimer définitivement ${ids.length} transcription${ids.length > 1 ? 's' : ''} ?`)) return;
      for (const id of ids) await window.vox.history.remove(id);
      selected.clear(); await VF.renderHistory();
    }
  });

  // barre latérale : filtres et dossiers
  $('#libSide').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-folder-edit]');
    if (ed) {
      e.stopPropagation();
      const f = folderById(ed.dataset.folderEdit);
      const r = await folderDialog(f);
      if (r) { await saveFolders(folders().map((x) => (x.id === f.id ? { ...x, ...r } : x))); VF.drawHistory(lastList); }
      return;
    }
    const del = e.target.closest('[data-folder-del]');
    if (del) {
      e.stopPropagation();
      const f = folderById(del.dataset.folderDel);
      const n = lastList.filter((h) => h.folder === f.id).length;
      if (!confirm(`Supprimer le dossier « ${f.name} » ?${n ? `\n\nSes ${n} transcription${n > 1 ? 's' : ''} ne seront pas supprimées : elles iront dans « Sans dossier ».` : ''}`)) return;
      await saveFolders(folders().filter((x) => x.id !== f.id));
      if (n) await updateMeta(lastList.filter((h) => h.folder === f.id).map((h) => h.id), () => ({ folder: '' }));
      else VF.drawHistory(lastList);
      return;
    }
    if (e.target.closest('#libAddFolder')) { const f = await newFolder(); if (f) { filter.view = 'folder:' + f.id; VF.drawHistory(lastList); } return; }
    const v = e.target.closest('[data-view-f]');
    if (v) { filter.view = v.dataset.viewF; selected.clear(); VF.drawHistory(lastList); return; }
    const t = e.target.closest('[data-tag-f]');
    if (t) { filter.tag = filter.tag === t.dataset.tagF ? '' : t.dataset.tagF; VF.drawHistory(lastList); }
  });
  $('#histTitle').addEventListener('click', (e) => { if (e.target.closest('[data-tag-f]')) { filter.tag = ''; VF.drawHistory(lastList); } });
  $('#histSort').addEventListener('change', (e) => { filter.sort = e.target.value; VF.drawHistory(lastList); });

  // glisser-déposer des cartes vers un dossier
  $('#historyList').addEventListener('dragstart', (e) => {
    const c = e.target.closest('.hitem'); if (!c) return;
    const ids = selected.has(c.dataset.h) ? [...selected] : [c.dataset.h];
    e.dataTransfer.setData('application/x-voxforge-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  });
  $('#libSide').addEventListener('dragover', (e) => {
    const t = e.target.closest('[data-drop-folder]');
    if (t && e.dataTransfer.types.includes('application/x-voxforge-ids')) { e.preventDefault(); e.stopPropagation(); $$('.lib-item.drop').forEach((x) => x.classList.remove('drop')); t.classList.add('drop'); }
  });
  $('#libSide').addEventListener('dragleave', (e) => { const t = e.target.closest('[data-drop-folder]'); if (t) t.classList.remove('drop'); });
  $('#libSide').addEventListener('drop', async (e) => {
    const t = e.target.closest('[data-drop-folder]');
    const raw = e.dataTransfer.getData('application/x-voxforge-ids');
    if (!t || !raw) return;
    e.preventDefault(); e.stopPropagation();
    t.classList.remove('drop');
    const ids = JSON.parse(raw);
    await updateMeta(ids, () => ({ folder: t.dataset.dropFolder }));
    const f = folderById(t.dataset.dropFolder);
    VF.toast(`${ids.length} transcription${ids.length > 1 ? 's' : ''} déplacée${ids.length > 1 ? 's' : ''} vers « ${esc(f ? f.name : 'Sans dossier')} »`, 'ok', 2500);
  });

  // ------------------------------------------------------------------ rangement du document affiché
  function docSaved(d) { return d && d.segments && d.segments.length && (!d.job || d.job.status === 'done'); }
  async function ensureSaved(d) {
    if (d.job) { d.job.historyId = d.job.historyId || d.job.id; d.id = d.job.historyId; }
    try { await window.vox.history.get(d.id); } catch { await window.vox.history.save(VF.toHistory(d)); }
  }
  function drawDocOrg() {
    const d = VF.doc; const box = $('#docOrg');
    if (!docSaved(d)) { box.innerHTML = ''; return; }
    const f = folderById(d.folder);
    box.innerHTML = `
      <button class="org-btn star ${d.favorite ? 'on' : ''}" data-org="fav" title="Favori">${ICON.star}</button>
      <button class="org-btn" data-org="folder" title="Dossier">${f ? `<i class="dot" style="background:${f.color}"></i>${esc(f.name)}` : `${ICON.folder}Dossier`}</button>
      ${(d.tags || []).map((t) => `<span class="tag-chip small">#${esc(t)}</span>`).join('')}
      <button class="org-btn" data-org="tags" title="Étiquettes">${ICON.tag}${(d.tags || []).length ? '' : 'Étiquettes'}</button>
      <button class="org-btn" data-org="project" title="Ajouter à un projet">${ICON.proj}Projet</button>`;
  }
  $('#docOrg').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-org]'); if (!b) return;
    const d = VF.doc; if (!docSaved(d)) return;
    await ensureSaved(d);
    const apply = async (patch) => {
      Object.assign(d, patch); if (d.job) Object.assign(d.job, patch);
      await window.vox.history.update(d.id, patch); drawDocOrg();
    };
    if (b.dataset.org === 'fav') await apply({ favorite: !d.favorite });
    if (b.dataset.org === 'folder') { const f = await pickFolder(); if (f !== null && f !== undefined) await apply({ folder: f }); }
    if (b.dataset.org === 'tags') { const t = await tagDialog(d.tags || []); if (t) await apply({ tags: t }); }
    if (b.dataset.org === 'project') { const p = await chooseProject(); if (p) { await window.vox.projects.addItems(p, [d.id]); VF.toast('Ajouté au projet ✔', 'ok'); } }
  });
  const prevOnDoc = VF.onDoc;
  VF.onDoc = (d) => { prevOnDoc && prevOnDoc(d); drawDocOrg(); };

  // ------------------------------------------------------------------ projet par défaut pour la file d'attente
  async function fillQueueProject() {
    const list = await window.vox.projects.list();
    const sel = $('#optProject');
    sel.innerHTML = '<option value="">Aucun</option>' + list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') + '<option value="__new">+ Nouveau projet…</option>';
    sel.value = list.some((p) => p.id === VF.settings.queueProject) ? VF.settings.queueProject : '';
  }
  $('#optProject').addEventListener('change', async (e) => {
    let v = e.target.value;
    if (v === '__new') {
      const p = await createProject(false);
      if (!p) { fillQueueProject(); return; } // annulé : on garde le projet choisi avant
      v = p.id;
    }
    await VF.setSetting({ queueProject: v });
    fillQueueProject();
    if (v) VF.toast('Les prochaines transcriptions seront ajoutées automatiquement à ce projet.', '', 3500);
  });
  VF.onJobSaved = async (d) => {
    const pid = VF.settings.queueProject;
    if (!pid) return;
    try { await window.vox.projects.addItems(pid, [d.id]); } catch { /* projet supprimé entre-temps */ }
  };

  // =====================================================================================
  // PROJETS
  // =====================================================================================
  let project = null;      // projet ouvert
  let members = [];        // transcriptions complètes du projet ouvert
  let pTab = 'items';
  const pRunning = {};     // tâches IA du projet : kind -> { id, project, ... }

  async function createProject(open = true) {
    let color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const r = await modal({
      title: 'Nouveau projet',
      body: `<label>Nom<input type="text" id="npName" maxlength="60" placeholder="ex. Cours de droit — semestre 1"></label>
        <label>Description (facultatif)<input type="text" id="npDesc" maxlength="200" placeholder="À quoi sert ce projet ?"></label>
        <div class="color-pick" id="npColors">${COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'active' : ''}"></button>`).join('')}</div>`,
      onOpen: (b) => { $('#npColors', b).onclick = (e) => { const x = e.target.closest('[data-c]'); if (!x) return; color = x.dataset.c; $$('#npColors button', b).forEach((y) => y.classList.toggle('active', y === x)); }; },
      buttons: [{ label: 'Annuler', value: null }, { label: 'Créer', primary: true, onClick: (b) => { const name = $('#npName', b).value.trim(); if (!name) { $('#npName', b).focus(); return false; } return { name, description: $('#npDesc', b).value.trim() }; } }],
    });
    if (!r) return null;
    const p = await window.vox.projects.save({ id: uid(), name: r.name, description: r.description, color, items: [], createdAt: new Date().toISOString() });
    fillQueueProject();
    if (open) { VF.show('projects'); openProject(p.id); }
    return p;
  }
  $('#btnNewProject').onclick = () => createProject(true);

  VF.renderProjects = async () => {
    if (project) { await openProject(project.id); return; }
    const [list, hist] = [await window.vox.projects.list(), await window.vox.history.list()];
    const byId = new Map(hist.map((h) => [h.id, h]));
    $('#projectsHome').hidden = false; $('#projectDetail').hidden = true;
    $('#projectsGrid').innerHTML = list.length ? list.map((p) => {
      const its = (p.items || []).map((id) => byId.get(id)).filter(Boolean);
      const dur = its.reduce((a, h) => a + (h.duration || 0), 0);
      return `<div class="card pcard" data-project="${p.id}" style="--pc:${p.color || COLORS[0]}">
        <div class="pc-top"><span class="pc-ic">${ICON.proj}</span><div style="min-width:0"><h3>${esc(p.name)}</h3><p>${esc(p.description || '')}</p></div></div>
        <div class="meta"><span class="chip">${its.length} enregistrement${its.length > 1 ? 's' : ''}</span><span class="chip">${VF.humanDur(dur)}</span>${p.summary ? '<span class="badge-ai">Résumé</span>' : ''}</div>
        <small class="muted">Modifié le ${fmtDate(p.updatedAt || p.createdAt)}</small></div>`;
    }).join('') : `<div class="empty-state">Aucun projet.<br><br><button class="btn primary small" onclick="document.getElementById('btnNewProject').click()">Créer mon premier projet</button></div>`;
  };
  $('#projectsGrid').addEventListener('click', (e) => { const c = e.target.closest('[data-project]'); if (c) openProject(c.dataset.project); });

  let openSeq = 0;
  async function openProject(id) {
    const seq = ++openSeq; // un clic plus récent annule l'affichage d'un chargement plus ancien
    let p;
    try { p = await window.vox.projects.get(id); } catch { if (seq === openSeq) { project = null; VF.renderProjects(); } return; }
    const loaded = await Promise.all((p.items || []).map((hid) => window.vox.history.get(hid).catch(() => null)));
    if (seq !== openSeq) return;
    const missing = (p.items || []).filter((hid, i) => !loaded[i]);
    project = p;
    members = loaded.filter(Boolean);
    if (missing.length) { try { project.items = project.items.filter((x) => !missing.includes(x)); project = await window.vox.projects.save(project); } catch { /* */ } if (seq !== openSeq) return; }
    $('#projectsHome').hidden = true; $('#projectDetail').hidden = false;
    drawProject();
  }

  const pParts = () => members.map((h) => ({ title: h.name, segments: (h.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })) }));

  function drawProject() {
    const p = project;
    const dur = members.reduce((a, h) => a + (h.duration || 0), 0);
    const words = members.reduce((a, h) => a + (h.segments || []).reduce((x, s) => x + s.text.split(/\s+/).filter(Boolean).length, 0), 0);
    $('#projectDetail').innerHTML = `
      <div class="proj-head" style="--pc:${p.color || COLORS[0]}">
        <button class="btn ghost small" id="pBack">← Projets</button>
        <div class="proj-title">
          <input class="title-input" id="pName" value="${esc(p.name)}" spellcheck="false">
          <input class="desc-input" id="pDesc" value="${esc(p.description || '')}" placeholder="Ajouter une description…" spellcheck="false">
          <div class="meta"><span class="chip">${members.length} enregistrement${members.length > 1 ? 's' : ''}</span><span class="chip">${VF.humanDur(dur)}</span><span class="chip">${words.toLocaleString('fr-FR')} mots</span></div>
        </div>
        <div class="page-tools">
          <button class="btn primary small" id="pAdd">+ Ajouter des transcriptions</button>
          <div class="dropdown"><button class="btn small" id="pExportBtn">Exporter ▾</button>
            <div class="menu" id="pExportMenu" hidden><button data-px="docx">Tout le projet — Word (.docx)</button><button data-px="pdf">Tout le projet — PDF (.pdf)</button><button data-px="md">Tout le projet (.md)</button><button data-px="txt">Tout le projet (.txt)</button><button data-px="srt">Sous-titres concaténés (.srt)</button></div></div>
          <button class="btn ghost small danger" id="pDelete">Supprimer</button>
        </div>
      </div>
      <nav class="tabs proj-tabs" id="pTabs">
        ${[['items', 'Enregistrements'], ['summary', 'Résumé global'], ['transform', 'Transformer'], ['search', 'Rechercher'], ['stats', 'Statistiques'], ['vocab', 'Vocabulaire']].map(([k, l]) => `<button data-ptab="${k}" class="${pTab === k ? 'active' : ''}">${l}${(k === 'summary' && p.summary) || (k === 'transform' && p.transforms && Object.keys(p.transforms).length) ? '<i class="tab-dot"></i>' : ''}</button>`).join('')}
      </nav>
      <div class="proj-body" id="pBody"></div>`;
    drawProjectTab();
  }

  function drawProjectTab() {
    const body = $('#pBody'); if (!body) return;
    if (pTab === 'vocab') return drawPVocab(body);
    if (!members.length && pTab !== 'items') { body.innerHTML = '<div class="empty-state">Ajoutez d’abord des transcriptions à ce projet.</div>'; return; }
    if (pTab === 'items') {
      body.innerHTML = members.length ? `<div class="p-items">${members.map((h, i) => `
        <div class="p-item" data-hid="${esc(h.id)}">
          <span class="num">${i + 1}</span>
          <div class="p-main"><div class="nm">${esc(h.name)}</div><div class="pv">${esc((h.segments || []).map((s) => s.text).join(' ').slice(0, 180))}</div>
            <div class="meta"><span class="chip accent">${esc(window.langName(h.language))}</span><span class="chip">${E.short(h.duration)}</span>${h.summary ? '<span class="badge-ai">Résumé</span>' : ''}</div></div>
          <div class="p-acts">
            <button class="ic-btn" data-pi="up" title="Monter" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button class="ic-btn" data-pi="down" title="Descendre" ${i === members.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            <button class="btn small" data-pi="open">Ouvrir</button>
            <button class="ic-btn" data-pi="remove" title="Retirer du projet">${ICON.x}</button>
          </div></div>`).join('')}</div>`
        : `<div class="empty-ai"><span style="font-size:34px">📂</span><b>Ce projet est vide</b><span>Ajoutez des transcriptions existantes, ou choisissez ce projet dans « Transcrire › Projet » pour y ranger automatiquement les prochaines.</span><button class="btn primary small" onclick="document.getElementById('pAdd').click()">+ Ajouter des transcriptions</button></div>`;
      return;
    }
    if (pTab === 'summary') return drawPSummary(body);
    if (pTab === 'transform') return drawPTransform(body);
    if (pTab === 'search') return drawPSearch(body);
    if (pTab === 'stats') return drawPStats(body);
  }

  $('#projectDetail').addEventListener('click', async (e) => {
    if (e.target.closest('#pBack')) { project = null; return VF.renderProjects(); }
    const tb = e.target.closest('[data-ptab]'); if (tb) { pTab = tb.dataset.ptab; $$('#pTabs button').forEach((b) => b.classList.toggle('active', b === tb)); return drawProjectTab(); }
    if (e.target.closest('#pAdd')) return addItemsDialog();
    if (e.target.closest('#pDelete')) {
      if (!confirm(`Supprimer le projet « ${project.name} » ?\n\nLes transcriptions ne sont pas supprimées.`)) return;
      await window.vox.projects.remove(project.id);
      if (VF.settings.queueProject === project.id) await VF.setSetting({ queueProject: '' });
      project = null; fillQueueProject(); return VF.renderProjects();
    }
    if (e.target.closest('#pExportBtn')) { e.stopPropagation(); $('#pExportMenu').hidden = !$('#pExportMenu').hidden; return; }
    const px = e.target.closest('[data-px]'); if (px) { $('#pExportMenu').hidden = true; return exportProject(px.dataset.px); }
    const pi = e.target.closest('[data-pi]');
    if (pi) {
      const id = pi.closest('[data-hid]').dataset.hid;
      const i = project.items.indexOf(id);
      if (pi.dataset.pi === 'open') { VF.openHistory(members.find((h) => h.id === id)); return; }
      if (pi.dataset.pi === 'remove') project.items.splice(i, 1);
      if (pi.dataset.pi === 'up' && i > 0) [project.items[i - 1], project.items[i]] = [project.items[i], project.items[i - 1]];
      if (pi.dataset.pi === 'down' && i < project.items.length - 1) [project.items[i + 1], project.items[i]] = [project.items[i], project.items[i + 1]];
      project = await window.vox.projects.save(project);
      members = project.items.map((x) => members.find((h) => h.id === x)).filter(Boolean);
      drawProject();
    }
    const ch = e.target.closest('[data-open-item]');
    if (ch) { const h = members[+ch.dataset.openItem]; if (h) VF.openHistory(h); }
    const hit = e.target.closest('[data-hit]');
    if (hit) {
      const h = members.find((x) => x.id === hit.dataset.hit);
      if (h) { VF.openHistory(h); setTimeout(() => VF.seek(+hit.dataset.t), 400); }
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#pExportBtn') && $('#pExportMenu')) $('#pExportMenu').hidden = true; });
  /** Vocabulaire propre au projet (une matière, un semestre…), ajouté au vocabulaire général. */
  function drawPVocab(body) {
    const V = window.VoxVocabulary;
    body.innerHTML = `<div class="card p-vocab">
      <p class="muted">Noms propres et termes techniques de <b>${esc(project.name)}</b>, un par ligne. Ils corrigent les nouvelles transcriptions rangées dans ce projet (choisissez-le dans « Transcrire › Projet ») et aident l’IA dans « Questions ».</p>
      <textarea id="pVocab" rows="10" spellcheck="false" placeholder="Saleilles&#10;Constantinesco&#10;stare decisis">${esc((project.vocabulary || []).join('\n'))}</textarea>
      <div class="p-vocab-acts"><button class="btn small primary" id="pVocabApply">Corriger les transcriptions du projet</button><span class="muted" id="pVocabInfo"></span></div></div>`;
  }
  const savePVocab = VF.debounce(async (txt) => {
    if (!project) return;
    project.vocabulary = [...new Set(txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
    project = await window.vox.projects.save(project);
  }, 500);
  $('#projectDetail').addEventListener('input', (e) => { if (e.target.id === 'pVocab') savePVocab(e.target.value); });
  $('#projectDetail').addEventListener('click', async (e) => {
    if (!e.target.closest('#pVocabApply')) return;
    const V = window.VoxVocabulary; if (!V) return;
    // vocabulaire tapé à l'instant : enregistré avant d'être utilisé
    const ta = $('#pVocab');
    if (ta) { project.vocabulary = [...new Set(ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))]; project = await window.vox.projects.save(project); }
    const terms = await window.vox.vocab.for(project.id);
    if (!terms.length) { VF.toast('Le vocabulaire est vide.'); return; }
    let n = 0, docs = 0;
    for (const m of members) {
      // document ouvert : on part de sa version affichée (modifications pas encore enregistrées comprises)
      const open = VF.doc && VF.doc.id === m.id ? VF.doc : null;
      const h = open ? null : await window.vox.history.get(m.id).catch(() => null);
      const segsSrc = open ? open.segments : (h && h.segments) || [];
      let c = 0;
      const texts = segsSrc.map((sg) => { const r = V.apply(sg.text, terms); c += r.count; return r.text; });
      if (!c) continue;
      if (open) { texts.forEach((t, i) => { open.segments[i].text = t; }); VF.refreshSegments(); await VF.saveDoc(open); }
      else { h.segments = h.segments.map((sg, i) => ({ ...sg, text: texts[i] })); await window.vox.history.save(h); m.segments = h.segments; }
      n += c; docs++;
    }
    $('#pVocabInfo').textContent = n ? `${n} correction${n > 1 ? 's' : ''} dans ${docs} transcription${docs > 1 ? 's' : ''} ✔` : 'Rien à corriger.';
  });

  $('#projectDetail').addEventListener('change', async (e) => {
    if (e.target.id === 'pName' && e.target.value.trim()) { project.name = e.target.value.trim(); project = await window.vox.projects.save(project); fillQueueProject(); }
    if (e.target.id === 'pDesc') { project.description = e.target.value.trim(); project = await window.vox.projects.save(project); }
  });

  async function addItemsDialog() {
    const hist = await window.vox.history.list();
    const avail = hist.filter((h) => !(project.items || []).includes(h.id));
    if (!avail.length) { VF.toast('Toutes vos transcriptions sont déjà dans ce projet (ou l’historique est vide).'); return; }
    const chosen = new Set();
    const ids = await modal({
      title: 'Ajouter des transcriptions',
      wide: true,
      body: `<div class="search wide"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="aiSearch" placeholder="Filtrer…"></div>
        <div class="pick-list tall" id="aiList"></div>`,
      onOpen: (b) => {
        const draw = () => {
          const q = $('#aiSearch', b).value.trim().toLowerCase();
          $('#aiList', b).innerHTML = avail.filter((h) => !q || `${h.name} ${(h.tags || []).join(' ')} ${h.preview}`.toLowerCase().includes(q)).map((h) => {
            const f = folderById(h.folder);
            return `<label class="pick-row check"><input type="checkbox" value="${esc(h.id)}" ${chosen.has(h.id) ? 'checked' : ''}><span class="pr-main"><b>${esc(h.name)}</b><small>${E.short(h.duration)} · ${fmtDate(h.createdAt)}${f ? ' · ' + esc(f.name) : ''}${(h.tags || []).map((t) => ' #' + esc(t)).join('')}</small></span></label>`;
          }).join('') || '<p class="muted">Aucun résultat.</p>';
        };
        draw();
        $('#aiSearch', b).addEventListener('input', draw);
        b.addEventListener('change', (e) => { if (e.target.type === 'checkbox') { if (e.target.checked) chosen.add(e.target.value); else chosen.delete(e.target.value); } });
      },
      buttons: [{ label: 'Annuler', value: null }, { label: 'Ajouter', primary: true, onClick: () => [...chosen] }],
    });
    if (!ids || !ids.length) return;
    project = await window.vox.projects.addItems(project.id, ids);
    await openProject(project.id);
    VF.toast(`${ids.length} transcription${ids.length > 1 ? 's' : ''} ajoutée${ids.length > 1 ? 's' : ''} ✔`, 'ok');
  }

  // ---- résumé global
  function langSelect(id, val) {
    const sel = document.createElement('select'); sel.id = id;
    VF.fillLangSelect(sel, val); sel.querySelector('option[value=""]').remove(); sel.value = val;
    return sel.outerHTML.replace(`value="${val}"`, `value="${val}" selected`);
  }
  function drawPSummary(body) {
    const p = project; const r = pRunning['summary:' + p.id] || null;
    const a = VF.settings.ai || {};
    const sm = p.summary;
    body.innerHTML = `
      <div class="ai-bar"><label>Langue${langSelect('psLang', (sm && sm.lang) || a.summaryLang || 'fr')}</label>
        <label>Longueur<select id="psLength"><option value="short">Court</option><option value="medium" selected>Moyen</option><option value="long">Détaillé</option></select></label>
        <button class="btn primary small" id="psGo" ${r ? 'disabled' : ''}>${sm ? 'Régénérer' : 'Générer le résumé global'}</button><span class="spacer"></span>
        ${sm ? '<button class="btn small" id="psCopy">Copier</button><button class="btn small" id="psExport">Word</button><button class="btn small" id="psPdf">PDF</button>' : ''}</div>
      <div class="ai-progress" id="psProg" hidden><div class="progress"><i></i></div><div class="progress-info"><span class="txt"></span><button class="btn ghost small danger" data-pcancel="summary:${esc(p.id)}">Annuler</button></div></div>
      <div class="summary" id="psOut"></div>`;
    VF.ai.progressUi($('#psProg'), r);
    const out = $('#psOut');
    if (!sm) {
      out.innerHTML = r ? '' : VF.ai.hasEngine()
        ? `<div class="empty-ai"><span style="font-size:34px">🧭</span><b>Synthèse de tout le projet</b><span>Chaque enregistrement est résumé (les résumés déjà faits sont réutilisés), puis l’IA rédige une synthèse globale : points clés, décisions, actions et un aperçu de chaque enregistrement.</span></div>`
        : VF.ai.noEngineHtml('résumer le projet');
      return;
    }
    const s = sm.data; const L = VF.ai.SUM_LABELS[sm.lang] || VF.ai.SUM_LABELS.en;
    const list = (arr, fn) => (arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : `<div class="none">${L[4]}</div>`);
    out.innerHTML = `<div class="sum-title">${esc(s.title || p.name)}</div><p class="sum-text">${esc(s.summary)}</p>
      <div class="sum-grid">
        <div class="sum-card"><h5>${L[0]}</h5>${list(s.key_points, (k) => `<li>${esc(k)}</li>`)}</div>
        <div class="sum-card"><h5>${L[1]}</h5>${list(s.decisions, (k) => `<li>${esc(k)}</li>`)}</div>
        <div class="sum-card"><h5>${L[2]}</h5>${list(s.action_items, (x) => `<li>${esc(x.task)}${x.owner ? ` — <span class="owner">${esc(x.owner)}</span>` : ''}</li>`)}</div>
        <div class="sum-card"><h5>Enregistrements</h5>${s.chapters.length ? `<ul class="chap">${s.chapters.map((c, i) => { const n = parseInt(String(c.time).replace(/\D/g, ''), 10) - 1; const idx = Number.isFinite(n) ? n : i; return `<li><span class="t" data-open-item="${idx}">${esc(c.time)}</span><span>${esc(c.title)}</span></li>`; }).join('')}</ul>` : `<div class="none">${L[4]}</div>`}</div>
      </div><div class="sum-meta">Généré par ${esc(sm.model || 'IA')} en ${VF.humanDur(sm.elapsed || 0)} · ${sm.count} enregistrement(s) · L’IA peut se tromper.</div>`;
  }
  function projectSummaryMd() {
    const sm = project.summary; const s = sm.data; const L = VF.ai.SUM_LABELS[sm.lang] || VF.ai.SUM_LABELS.en;
    const o = [`# ${s.title || project.name}`, '', s.summary, ''];
    const sec = (t, a) => { if (a.length) o.push(`## ${t}`, '', ...a, ''); };
    sec(L[0], s.key_points.map((k) => `- ${k}`)); sec(L[1], s.decisions.map((k) => `- ${k}`));
    sec(L[2], s.action_items.map((x) => `- [ ] ${x.task}${x.owner ? ` — **${x.owner}**` : ''}`));
    sec('Enregistrements', s.chapters.map((c) => `- **${c.time}** ${c.title}`));
    return o.join('\n');
  }

  // ---- transformer (projet)
  let pTf = 'notes';
  function drawPTransform(body) {
    const p = project; const r = pRunning['transform:' + p.id] || null;
    const a = VF.settings.ai || {};
    const res = p.transforms && p.transforms[pTf];
    body.innerHTML = `
      <div class="tf-formats">${VF.ai.TF_FORMATS.map((f) => `<button class="tf-card ${f.id === pTf ? 'active' : ''}" data-ptf="${f.id}" title="${f.desc}"><span class="ic">${f.icon}</span><span><b>${f.name}${p.transforms && p.transforms[f.id] ? ' <i class="ok">✓</i>' : ''}</b><small>${f.desc}</small></span></button>`).join('')}</div>
      <div class="ai-bar"><label>Langue${langSelect('ptLang', (res && res.lang) || a.transformLang || 'fr')}</label>
        <input type="text" id="ptCustom" class="tf-custom" placeholder="Décrivez ce que vous voulez…" ${pTf === 'custom' ? '' : 'hidden'} value="${esc((res && res.custom) || '')}">
        <button class="btn primary small" id="ptGo" ${r ? 'disabled' : ''}>${res ? 'Régénérer' : 'Générer'}</button><span class="spacer"></span>
        ${res && !r ? '<button class="btn small" id="ptCopy">Copier</button><button class="btn small" id="ptExport">Word</button><button class="btn small" id="ptPdf">PDF</button>' : ''}</div>
      <div class="ai-progress" id="ptProg" hidden><div class="progress"><i></i></div><div class="progress-info"><span class="txt"></span><button class="btn ghost small danger" data-pcancel="transform:${esc(p.id)}">Annuler</button></div></div>
      <div class="tf-out md" id="ptOut"></div>`;
    VF.ai.progressUi($('#ptProg'), r);
    const out = $('#ptOut');
    if (r) { out.innerHTML = r.text ? window.Markdown.render(r.text) + '<span class="caret"></span>' : ''; return; }
    if (res) { out.innerHTML = window.Markdown.render(res.text) + `<div class="sum-meta">Généré par ${esc(res.model || 'IA')} en ${VF.humanDur(res.elapsed || 0)} à partir de ${res.count} enregistrement(s).</div>`; return; }
    const f = VF.ai.TF_FORMATS.find((x) => x.id === pTf);
    out.innerHTML = VF.ai.hasEngine() ? `<div class="empty-ai"><span style="font-size:34px">${f.icon}</span><b>${f.name} — tout le projet</b><span>Un seul document rédigé à partir des ${members.length} enregistrements.</span></div>` : VF.ai.noEngineHtml('transformer le projet');
  }

  // ---- recherche dans tout le projet
  let pQuery = '';
  function drawPSearch(body) {
    body.innerHTML = `<div class="search wide big"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="pq" placeholder="Rechercher un mot ou une expression dans tous les enregistrements…" value="${esc(pQuery)}"></div><div id="pResults" class="p-results"></div>`;
    const run = () => {
      pQuery = $('#pq').value.trim();
      const q = pQuery.toLowerCase();
      if (q.length < 2) { $('#pResults').innerHTML = '<p class="muted">Tapez au moins 2 caractères.</p>'; return; }
      const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      let total = 0;
      const html = members.map((h) => {
        const hits = (h.segments || []).filter((s) => s.text.toLowerCase().includes(q));
        total += hits.length;
        if (!hits.length) return '';
        return `<div class="p-res"><h5>${esc(h.name)} <small>${hits.length} résultat${hits.length > 1 ? 's' : ''}</small></h5>${hits.slice(0, 50).map((s) => `<div class="p-hit" data-hit="${esc(h.id)}" data-t="${s.start}"><span class="ts">${E.short(s.start)}</span><span>${s.text.split(re).map((x, k) => (k % 2 ? `<mark>${esc(x)}</mark>` : esc(x))).join('')}</span></div>`).join('')}</div>`;
      }).join('');
      $('#pResults').innerHTML = total ? `<p class="muted">${total} passage${total > 1 ? 's' : ''} trouvé${total > 1 ? 's' : ''} — cliquez pour écouter.</p>${html}` : '<p class="muted">Aucun résultat.</p>';
    };
    $('#pq').addEventListener('input', VF.debounce(run, 200));
    $('#pq').focus();
    if (pQuery) run();
  }

  // ---- statistiques du projet
  function drawPStats(body) {
    const stats = members.map((h) => ({ h, st: VF.ai.computeStats({ ...h, segments: h.segments || [] }) }));
    const sum = (k) => stats.reduce((a, x) => a + x.st[k], 0);
    const dur = sum('duration'); const speech = sum('speech'); const words = sum('words');
    const langs = {}; stats.forEach(({ st }) => st.langs.forEach(([l, v]) => { langs[l] = (langs[l] || 0) + v; }));
    const freq = new Map(); stats.forEach(({ st }) => st.top.forEach(([w, c]) => freq.set(w, (freq.get(w) || 0) + c)));
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const maxDur = Math.max(...stats.map((x) => x.st.duration), 1);
    const maxW = top.length ? top[0][1] : 1;
    const totL = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
    body.innerHTML = `<div class="stats" style="padding:0">
      <div class="tiles">
        <div class="tile"><div class="k">Enregistrements</div><div class="v">${members.length}</div></div>
        <div class="tile"><div class="k">Durée totale</div><div class="v">${VF.humanDur(dur)}</div><div class="s">${E.short(speech)} de parole</div></div>
        <div class="tile"><div class="k">Mots</div><div class="v">${words.toLocaleString('fr-FR')}</div><div class="s">${Math.round(words / 230)} min de lecture</div></div>
        <div class="tile"><div class="k">Débit moyen</div><div class="v">${speech ? Math.round(words / (speech / 60)) : 0} mots/min</div></div>
      </div>
      <div class="chart-card"><h5>Durée par enregistrement</h5><div class="sub">Cliquez pour ouvrir</div>
        <div class="hbars">${stats.map(({ h, st }, i) => `<div class="hbar clickable" data-open-item="${i}"><span class="lbl">${i + 1}. ${esc(h.name)}</span><div class="track"><div class="fill" style="width:${(st.duration / maxDur) * 100}%"></div></div><span class="val">${E.short(st.duration)}</span></div>`).join('')}</div></div>
      <div class="chart-row">
        <div class="chart-card"><h5>Mots les plus fréquents</h5><div class="sub">Sur l’ensemble du projet</div><div class="hbars">${top.map(([w, c]) => `<div class="hbar"><span class="lbl">${esc(w)}</span><div class="track"><div class="fill" style="width:${(c / maxW) * 100}%"></div></div><span class="val">${c}</span></div>`).join('') || '<span class="muted">—</span>'}</div></div>
        <div class="chart-card"><h5>Langues parlées</h5><div class="sub">Part du temps de parole</div><div class="hbars">${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, v]) => `<div class="hbar"><span class="lbl">${esc(window.langName(l))}</span><div class="track"><div class="fill" style="width:${(v / totL) * 100}%"></div></div><span class="val">${Math.round((v / totL) * 100)} %</span></div>`).join('')}</div></div>
      </div></div>`;
  }

  // ---- export du projet complet
  async function exportProject(fmt) {
    const p = project;
    let content = '';
    if (fmt === 'srt') {
      let n = 0; let offset = 0;
      for (const h of members) {
        for (const s of h.segments || []) { n++; content += `${n}\n${E.clock(s.start + offset)} --> ${E.clock(s.end + offset)}\n${s.text}\n\n`; }
        offset += (h.duration || 0) + 1;
      }
    } else if (fmt === 'docx' || fmt === 'pdf') {
      let md = `# ${p.name}\n\n${p.description ? `*${p.description}*\n\n` : ''}`;
      if (p.summary) md += projectSummaryMd().replace(/^# .*\n/, '## Synthèse\n') + '\n';
      members.forEach((h, i) => {
        md += `## ${i + 1}. ${h.name}\n\n*${E.short(h.duration)} · ${window.langName(h.language)}*\n\n`;
        md += E.paragraphs(h.segments || []).map((par) => `**[${E.short(par[0].start)}]** ` + par.map((s) => s.text).join(' ')).join('\n\n') + '\n\n';
      });
      const saved = await window.vox.files.exportDoc({ format: fmt, markdown: md, title: p.name, defaultName: `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.${fmt}` });
      if (saved) VF.toast('Projet exporté ✔', 'ok');
      return;
    } else {
      const md = fmt === 'md';
      content = md ? `# ${p.name}\n\n${p.description ? `> ${p.description}\n\n` : ''}` : `${p.name}\n${'='.repeat(p.name.length)}\n\n`;
      if (p.summary && md) content += projectSummaryMd().replace(/^# .*\n/, '## Synthèse\n') + '\n';
      members.forEach((h, i) => {
        content += md ? `## ${i + 1}. ${h.name}\n\n*${E.short(h.duration)} · ${window.langName(h.language)}*\n\n` : `${i + 1}. ${h.name} (${E.short(h.duration)})\n\n`;
        content += E.paragraphs(h.segments || []).map((par) => (md ? `**[${E.short(par[0].start)}]** ` : `[${E.short(par[0].start)}] `) + par.map((s) => s.text).join(' ')).join('\n\n') + '\n\n';
      });
    }
    const saved = await window.vox.files.exportSave({ content, defaultName: `${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.${fmt}`, format: fmt });
    if (saved) VF.toast('Projet exporté ✔', 'ok');
  }

  // ---- tâches IA du projet
  $('#projectDetail').addEventListener('click', async (e) => {
    const ptf = e.target.closest('[data-ptf]'); if (ptf) { pTf = ptf.dataset.ptf; drawProjectTab(); return; }
    if (e.target.closest('#psGo')) {
      if (!VF.ai.hasEngine()) return drawProjectTab();
      const lang = $('#psLang').value; const length = $('#psLength').value;
      const parts = members.map((h) => ({ title: h.name, segments: (h.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })), existing: h.summary && h.summary.lang === lang ? h.summary.data : null }));
      runP('summary', 'summarizeMany', { parts, lang, length }, { lang, length });
    }
    if (e.target.closest('#ptGo')) {
      if (!VF.ai.hasEngine()) return drawProjectTab();
      const lang = $('#ptLang').value; const custom = ($('#ptCustom') && $('#ptCustom').value.trim()) || '';
      if (pTf === 'custom' && !custom) { VF.toast('Décrivez d’abord ce que vous voulez obtenir.', 'error'); return; }
      runP('transform', 'transform', { parts: pParts(), format: pTf, lang, custom }, { lang, format: pTf, custom });
    }
    const c = e.target.closest('[data-pcancel]');
    if (c) { const r = pRunning[c.dataset.pcancel]; if (r) { r.cancelling = true; window.vox.ai.cancel(r.id); } c.disabled = true; c.textContent = 'Annulation…'; }
    if (e.target.closest('#psCopy')) VF.copyText(projectSummaryMd());
    if (e.target.closest('#psExport')) { const s = await window.vox.files.exportDoc({ format: 'docx', markdown: projectSummaryMd(), title: project.name, defaultName: `${project.name} - synthèse.docx` }); if (s) VF.toast('Synthèse exportée ✔', 'ok'); }
    if (e.target.closest('#psPdf')) { const s = await window.vox.files.exportDoc({ format: 'pdf', markdown: projectSummaryMd(), title: project.name, defaultName: `${project.name} - synthèse.pdf` }); if (s) VF.toast('Synthèse exportée ✔', 'ok'); }
    if (e.target.closest('#ptCopy')) VF.copyText(project.transforms[pTf].text);
    if (e.target.closest('#ptExport') || e.target.closest('#ptPdf')) {
      const f = VF.ai.TF_FORMATS.find((x) => x.id === pTf); const fmt = e.target.closest('#ptPdf') ? 'pdf' : 'docx';
      const s = await window.vox.files.exportDoc({ format: fmt, markdown: project.transforms[pTf].text, title: `${project.name} — ${f.name}`, defaultName: `${project.name} - ${f.name}.${fmt}` });
      if (s) VF.toast('Document exporté ✔', 'ok');
    }
  });
  $('#projectDetail').addEventListener('change', (e) => { if (e.target.id === 'ptLang') VF.setSetting({ ai: { transformLang: e.target.value } }); });

  function runP(kind, task, payload, extra) {
    const id = uid(); const key = kind + ':' + project.id;
    if (pRunning[key]) return;
    pRunning[key] = { id, kind, pid: project.id, count: members.length, status: 'Préparation…', ...extra };
    window.vox.ai.run(id, task, payload).catch((err) => { delete pRunning[key]; VF.toast(esc(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'error', 8000); drawProjectTab(); });
    drawProjectTab();
  }
  window.vox.ai.onEvent(async (ev) => {
    const key = Object.keys(pRunning).find((k) => pRunning[k].id === ev.id);
    if (!key) return;
    const r = pRunning[key]; const kind = r.kind;
    if (ev.type === 'status') r.status = ev.message;
    if (ev.type === 'progress') { if (ev.ratio != null) r.ratio = ev.ratio; if (ev.message) r.status = ev.message; if (ev.text != null) r.text = ev.text; }
    if (['done', 'error', 'cancelled'].includes(ev.type)) delete pRunning[key];
    if (ev.type === 'done') {
      let p; try { p = await window.vox.projects.get(r.pid); } catch { return; }
      const meta = { model: ev.model, elapsed: ev.elapsed, createdAt: new Date().toISOString(), count: r.count, lang: r.lang };
      if (kind === 'summary') p.summary = { ...meta, length: r.length, data: ev.result };
      else p.transforms = { ...(p.transforms || {}), [r.format]: { ...meta, text: ev.result, custom: r.custom } };
      p = await window.vox.projects.save(p);
      if (project && project.id === p.id) project = p;
      VF.toast(kind === 'summary' ? 'Résumé global du projet généré ✔' : 'Document du projet généré ✔', 'ok');
    }
    if (ev.type === 'error') VF.toast(esc(ev.message), 'error', 9000);
    if (project && project.id === r.pid && $('#view-projects').classList.contains('active')) {
      if (ev.type === 'done') drawProject(); else throttled();
    }
  });
  const throttled = (() => { let p = false; return () => { if (p) return; p = true; requestAnimationFrame(() => { p = false; drawProjectTab(); }); }; })();

  // ------------------------------------------------------------------ init
  const prevInit = VF.init;
  VF.init = async () => { if (prevInit) await prevInit(); await fillQueueProject(); };
})();
