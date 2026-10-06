// Formats d'export — fonctions pures
(function () {
  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  function clock(sec, sep = ',', forceHours = true) {
    // arrondi une seule fois en millisecondes : 59,9996 s donne 01:00,000 et non 00:59,000
    const t = Math.round(Math.max(0, sec || 0) * 1000);
    const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), s = Math.floor((t % 60000) / 1000), ms = t % 1000;
    return `${forceHours || h ? pad(h) + ':' : ''}${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
  }
  function short(sec) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** Regroupe les segments en paragraphes (pause > 1,6 s ou ~600 caractères). */
  function paragraphs(segments) {
    const out = []; let cur = []; let len = 0;
    segments.forEach((s, i) => {
      const prev = segments[i - 1];
      const gap = prev ? s.start - prev.end : 0;
      if (cur.length && (gap > 1.6 || len > 600) && /[.!?…。！？]["»”']?$/.test(prev.text)) { out.push(cur); cur = []; len = 0; }
      cur.push(s); len += s.text.length;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  const plain = (segs) => paragraphs(segs).map((p) => p.map((s) => s.text).join(' ')).join('\n\n');
  /** Titres du plan (repérés automatiquement) qui ouvrent ce paragraphe. */
  function headsFor(d, p) {
    if (!d.outline || !d.outline.length) return [];
    const set = new Set(p);
    return d.outline.filter((h) => set.has(d.segments[h.segIndex]));
  }
  const headLabel = (h) => (h.label && !/^(Introduction|Conclusion)$/i.test(h.label) && !h.title.toLowerCase().startsWith(h.label.toLowerCase()) ? `${h.label} — ` : '') + h.title;
  const isText = (d) => d.source === 'text';

  /** Découpe un segment long en sous-titres lisibles (≤ 84 caractères, ~2 lignes). */
  function subtitleCues(segments, maxChars = 84) {
    const cues = [];
    for (const s of segments) {
      // chinois, japonais, coréen… : pas d'espaces entre les mots, on coupe par caractères (ponctuation de préférence)
      const cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(s.text);
      const max = cjk ? Math.round(maxChars / 2.5) : maxChars;
      const words = s.text.split(/\s+/).filter(Boolean);
      if (s.text.length <= max || (!cjk && words.length < 4)) { cues.push({ start: s.start, end: s.end, text: s.text }); continue; }
      const chunks = []; let cur = '';
      if (cjk) {
        const units = s.text.match(/[^，。！？、,.!?；;]+[，。！？、,.!?；;]*/g) || [s.text];
        for (let u of units) {
          while (u.length > max) { if (cur) { chunks.push(cur); cur = ''; } chunks.push(u.slice(0, max)); u = u.slice(max); }
          if ((cur + u).length > max && cur) { chunks.push(cur); cur = u; } else cur += u;
        }
      } else {
        for (const w of words) {
          if ((cur + ' ' + w).trim().length > maxChars && cur) { chunks.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
        }
      }
      if (cur) chunks.push(cur);
      const total = chunks.reduce((a, c) => a + c.length, 0);
      let t = s.start;
      for (const c of chunks) {
        const d = (s.end - s.start) * (c.length / total);
        cues.push({ start: t, end: t + d, text: c });
        t += d;
      }
    }
    return cues.map((c) => ({ ...c, text: wrap2(c.text) }));
  }
  function wrap2(text) {
    if (text.length <= 42 || !text.includes(' ')) return text;
    const mid = Math.floor(text.length / 2);
    let best = -1;
    for (let d = 0; d < mid; d++) {
      if (text[mid + d] === ' ') { best = mid + d; break; }
      if (text[mid - d] === ' ') { best = mid - d; break; }
    }
    return best > 0 ? text.slice(0, best) + '\n' + text.slice(best + 1) : text;
  }
  /** WebVTT : « --> » interdit dans le texte, < et & doivent être échappés. */
  const vttText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '→').replace(/\n{2,}/g, '\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const fmt = {
    txt: (d) => paragraphs(d.segments).map((p) => headsFor(d, p).map((h) => headLabel(h).toUpperCase() + '\n\n').join('') + p.map((s) => s.text).join(' ')).join('\n\n') + '\n',
    'txt-ts': (d) => d.segments.map((s) => `[${short(s.start)} → ${short(s.end)}] ${s.text}`).join('\n') + '\n',
    srt: (d) => subtitleCues(d.segments).map((c, i) => `${i + 1}\n${clock(c.start)} --> ${clock(c.end)}\n${c.text.replace(/\n{2,}/g, '\n')}\n`).join('\n'),
    vtt: (d) => 'WEBVTT\n\n' + subtitleCues(d.segments).map((c) => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${vttText(c.text)}\n`).join('\n'),
    json: (d) => JSON.stringify({
      title: d.title, source: d.file || null, language: d.language, model: d.model, task: d.task,
      duration: d.duration, createdAt: d.createdAt, text: plain(d.segments),
      segments: d.segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: s.text, language: s.lang || undefined })),
    }, null, 2),
    md: (d) => `# ${d.title}\n\n> Langue : ${window.langName(d.language)} · ${isText(d) ? 'Texte importé' : `Durée : ${short(d.duration)} · Modèle : ${d.model || '—'}`}\n\n` +
      paragraphs(d.segments).map((p) => headsFor(d, p).map((h) => `${'#'.repeat(Math.min(6, 2 + (h.depth || 0)))} ${headLabel(h)}\n\n`).join('') + (isText(d) ? '' : `**[${short(p[0].start)}]** `) + p.map((s) => s.text).join(' ')).join('\n\n') + '\n',
    csv: (d) => 'debut;fin;langue;texte\n' + d.segments.map((s) => `${clock(s.start)};${clock(s.end)};${s.lang || ''};"${s.text.replace(/"/g, '""')}"`).join('\n') + '\n',
    html: (d) => `<!doctype html><html lang="${esc(d.language || 'fr')}"><head><meta charset="utf-8"><title>${esc(d.title)}</title>
<style>body{font:17px/1.65 system-ui,Segoe UI,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1d2230}h1{font-size:28px}.m{color:#6b7280;font-size:14px}p{margin:0 0 1em}.t{color:#7c5cff;font:600 12px ui-monospace,monospace;margin-right:8px}</style></head>
<body><h1>${esc(d.title)}</h1><p class="m">Langue : ${esc(window.langName(d.language))} · ${isText(d) ? 'Texte importé' : `Durée : ${short(d.duration)} · Transcrit avec VoxForge`}</p>
${paragraphs(d.segments).map((p) => headsFor(d, p).map((h) => `<h${Math.min(6, 2 + (h.depth || 0))}>${esc(headLabel(h))}</h${Math.min(6, 2 + (h.depth || 0))}>`).join('') + `<p>${isText(d) ? '' : `<span class="t">${short(p[0].start)}</span>`}${esc(p.map((s) => s.text).join(' '))}</p>`).join('\n')}
</body></html>`,
  };
  const ext = { txt: 'txt', 'txt-ts': 'txt', srt: 'srt', vtt: 'vtt', json: 'json', md: 'md', csv: 'csv', html: 'html' };

  window.Exporters = { fmt, ext, clock, short, plain, paragraphs, subtitleCues };
})();
