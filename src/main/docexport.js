'use strict';
/**
 * Export mis en page : Word (.docx) et PDF, à partir d'un Markdown simple
 * (titres, paragraphes, listes, cases à cocher, citations, gras/italique, horodatages).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Markdown = require('../renderer/markdown');

// ---------------------------------------------------------------- analyse en blocs
function parseBlocks(md) {
  const blocks = []; let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'h', level: m[1].length, text: m[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'hr' }); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flush(); blocks.push({ type: 'quote', text: m[1] }); continue; }
    if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'li', task: true, checked: !!m[2].trim(), text: m[3], depth: Math.floor(m[1].length / 2) }); continue; }
    if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'li', text: m[2], depth: Math.floor(m[1].length / 2) }); continue; }
    if ((m = /^(\s*)(\d+)[.)/]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'li', ordered: true, num: +m[2], text: m[3], depth: Math.floor(m[1].length / 2) }); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Découpe le texte en fragments { text, bold, italics, code, time } */
function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|(^|[^*])\*([^*\s][^*]*)\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\])/g;
  let last = 0; let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    let start = m.index;
    if (m[4] !== undefined && m[5] !== undefined) { // italique : le caractère qui précède fait partie du texte
      if (m[4]) { start += m[4].length; }
    }
    if (start > last) runs.push({ text: s.slice(last, start) });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], code: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], italics: true });
    else if (m[6] !== undefined) runs.push({ text: `[${m[6]}]`, time: true });
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.filter((r) => r.text);
}

// ---------------------------------------------------------------- Word
async function toDocx({ markdown, title, accent = '7C5CFF' }) {
  const d = require('docx');
  const acc = accent.replace('#', '').toUpperCase();
  const runsOf = (text, extra = {}) => {
    const out = [];
    inlineRuns(text).forEach((r) => {
      String(r.text).split('\n').forEach((part, i) => {
        out.push(new d.TextRun({
          text: part, break: i > 0 ? 1 : undefined, bold: r.bold || extra.bold, italics: r.italics || extra.italics,
          font: r.code || r.time || (r.bold && /^\[\d/.test(r.text)) ? 'Consolas' : undefined, size: r.time || (r.bold && /^\[\d/.test(r.text)) ? 18 : undefined, color: r.time || (r.bold && /^\[\d/.test(r.text)) ? acc : extra.color,
        }));
      });
    });
    return out;
  };
  const children = [];
  for (const b of parseBlocks(markdown)) {
    if (b.type === 'h') {
      const lvl = [d.HeadingLevel.TITLE, d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5][Math.min(5, b.level - 1)];
      children.push(new d.Paragraph({ heading: b.level === 1 ? d.HeadingLevel.TITLE : lvl, children: runsOf(b.text) }));
    } else if (b.type === 'p') {
      children.push(new d.Paragraph({ children: runsOf(b.text), spacing: { after: 160, line: 300 } }));
    } else if (b.type === 'li') {
      if (b.task) children.push(new d.Paragraph({ children: [new d.TextRun({ text: b.checked ? '☑ ' : '☐ ', font: 'Segoe UI Symbol' }), ...runsOf(b.text)], indent: { left: 360 + b.depth * 360 }, spacing: { after: 80 } }));
      else if (b.ordered) children.push(new d.Paragraph({ children: [new d.TextRun({ text: `${b.num}. `, bold: true }), ...runsOf(b.text)], indent: { left: 360 + b.depth * 360, hanging: 300 }, spacing: { after: 80 } }));
      else children.push(new d.Paragraph({ children: runsOf(b.text), bullet: { level: Math.min(b.depth, 8) }, spacing: { after: 80 } }));
    } else if (b.type === 'quote') {
      children.push(new d.Paragraph({ children: runsOf(b.text, { italics: true, color: '555555' }), indent: { left: 400 }, border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: acc, space: 8 } }, spacing: { after: 160 } }));
    } else if (b.type === 'hr') {
      children.push(new d.Paragraph({ children: [], border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, spacing: { after: 200 } }));
    }
  }
  const doc = new d.Document({
    creator: 'VoxForge', title: title || 'Transcription', description: 'Généré avec VoxForge',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 44, bold: true, color: '1D2230' }, paragraph: { spacing: { after: 240 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 32, bold: true, color: acc }, paragraph: { spacing: { before: 320, after: 140 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 26, bold: true, color: '1D2230' }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', run: { size: 23, bold: true, color: '444444' }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      headers: { default: new d.Header({ children: [new d.Paragraph({ alignment: d.AlignmentType.RIGHT, children: [new d.TextRun({ text: title || '', size: 16, color: '999999' })] })] }) },
      footers: {
        default: new d.Footer({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [
          new d.TextRun({ text: 'VoxForge · page ', size: 16, color: '999999' }), new d.TextRun({ children: [d.PageNumber.CURRENT], size: 16, color: '999999' }),
          new d.TextRun({ text: ' / ', size: 16, color: '999999' }), new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: 16, color: '999999' })] })] }),
      },
      children,
    }],
  });
  return d.Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- PDF (moteur d'impression de Chromium)
function htmlPage({ markdown, title, accent = '#7c5cff' }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = Markdown.render(markdown).replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="ts">$1</span>');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title || '')}</title><style>
    @page { size: A4; margin: 18mm 17mm 20mm; }
    body { font: 11pt/1.55 "Segoe UI", Calibri, Arial, sans-serif; color: #1d2230; }
    h2:first-child { font-size: 22pt; margin: 0 0 10pt; } h2 { font-size: 15pt; color: ${accent}; margin: 18pt 0 6pt; page-break-after: avoid; }
    h3 { font-size: 13pt; margin: 14pt 0 5pt; page-break-after: avoid; } h4 { font-size: 11.5pt; margin: 12pt 0 4pt; }
    p { margin: 0 0 8pt; orphans: 3; widows: 3; } ul, ol { margin: 0 0 8pt; padding-left: 18pt; } li { margin: 2pt 0; }
    ul.tasks { list-style: none; padding-left: 4pt; } ul.tasks input { margin-right: 5pt; }
    blockquote { margin: 0 0 8pt; padding: 2pt 10pt; border-left: 3pt solid ${accent}; color: #555; font-style: italic; }
    code { font-family: Consolas, monospace; font-size: 9.5pt; } hr { border: 0; border-top: 1px solid #ddd; margin: 12pt 0; }
    .ts { font: 8.5pt Consolas, monospace; color: ${accent}; margin-right: 4pt; } strong .ts { font-weight: 600; }
  </style></head><body>${body}</body></html>`;
}

async function toPdf({ markdown, title, accent }) {
  const { BrowserWindow } = require('electron');
  const tmp = path.join(os.tmpdir(), `voxforge-print-${Date.now()}.html`);
  fs.writeFileSync(tmp, htmlPage({ markdown, title, accent }));
  // page d'impression : HTML généré par nous (texte échappé), sans JavaScript, isolée
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  try {
    await w.loadFile(tmp);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return await w.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, displayHeaderFooter: true,
      margins: { marginType: 'custom', top: 0.7, bottom: 0.75, left: 0.67, right: 0.67 },
      headerTemplate: `<div style="font:8px Segoe UI,Arial;color:#999;width:100%;text-align:right;padding:0 16mm">${esc(title || '')}</div>`,
      footerTemplate: '<div style="font:8px Segoe UI,Arial;color:#999;width:100%;text-align:center">VoxForge · page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    w.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
}

module.exports = { toDocx, toPdf, parseBlocks, inlineRuns, htmlPage };
