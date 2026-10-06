// Rendu Markdown minimal et sûr (le texte est échappé avant toute mise en forme)
(function (root) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  }
  function render(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = []; let list = null; let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushPara(); closeList(); const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ul') { closeList(); out.push('<ul class="tasks">'); list = 'ul'; } out.push(`<li><input type="checkbox" disabled ${m[1].trim() ? 'checked' : ''}> ${inline(m[2])}</li>`); continue; }
      if ((m = /^\s*[-*+•]\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
      if ((m = /^\s*(\d+)[.)/]\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li value="${m[1]}">${inline(m[2])}</li>`); continue; }
      closeList(); para.push(line);
    }
    flushPara(); closeList();
    return out.join('\n');
  }
  const plain = (md) => String(md || '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '☐ ').replace(/^\s*[-*+]\s+/gm, '• ');
  const api = { render, plain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
