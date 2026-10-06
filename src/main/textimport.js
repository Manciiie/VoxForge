'use strict';
/**
 * Import de fichiers texte (cours rédigés, notes, articles, sous-titres…) pour profiter de la traduction,
 * du résumé, de « Transformer », des statistiques et des questions sur les cours.
 *
 * Le texte est découpé en phrases (« segments ») avec un minutage ESTIMÉ (lecture à voix haute, ~150 mots/min) :
 * il n'existe pas d'audio, mais tout le reste de l'application (paragraphes, exports, IA) fonctionne pareil.
 * Les sous-titres .srt / .vtt gardent leurs vrais horodatages.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Zip = require('./zip');

const TEXT_EXT = ['txt', 'text', 'md', 'markdown', 'csv', 'log', 'srt', 'vtt', 'docx', 'odt', 'pdf', 'html', 'htm', 'rtf', 'json', 'xml', 'tex'];
const WORDS_PER_SEC = 2.5;

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { /* ANSI */ }
  return new TextDecoder('windows-1252').decode(buf);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î', euml: 'ë', iuml: 'ï' };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

/** Word .docx : un paragraphe par <w:p>, titres repérés par leur style. */
async function docxParagraphs(file) {
  const xml = (await Zip.readEntry(file, 'word/document.xml'))?.toString('utf8');
  if (!xml) throw new Error('Document Word illisible.');
  const paras = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p);
    let t = '';
    p.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g, (m, txt) => { t += txt != null ? txt : m.startsWith('<w:tab') ? '\t' : '\n'; return m; });
    t = unxml(t).trim();
    if (t) paras.push({ text: t, heading: !!(style && /^(Heading|Titre|Title)\d*/i.test(style[1])) });
  }
  return paras;
}

async function odtParagraphs(file) {
  const xml = (await Zip.readEntry(file, 'content.xml'))?.toString('utf8');
  if (!xml) throw new Error('Document OpenDocument illisible.');
  const paras = [];
  xml.replace(/<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g, (m, kind, inner) => {
    const t = unxml(inner.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, '')).trim();
    if (t) paras.push({ text: t, heading: kind === 'h' });
    return m;
  });
  return paras;
}

function htmlParagraphs(html) {
  const body = html.replace(/<(script|style|head|nav|footer)\b[\s\S]*?<\/\1>/gi, '');
  const out = [];
  body.replace(/<(h[1-6]|p|li|div|blockquote|td|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => {
    const t = unxml(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
    if (t && !/<(p|div|li)\b/i.test(inner)) out.push({ text: t, heading: /^h/i.test(tag) });
    return m;
  });
  if (!out.length) return plainParagraphs(unxml(body.replace(/<[^>]+>/g, '\n')));
  return out;
}

function rtfToText(rtf) {
  // 1) groupes non textuels (polices, couleurs, styles, infos, destinations « \* ») retirés en suivant les accolades
  const SKIP = /^\{\\(\*|fonttbl|colortbl|stylesheet|info|listtable|listoverridetable|rsidtbl|generator|pict|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|mmathPr|header|footer)/;
  let out = ''; let i = 0;
  while (i < rtf.length) {
    if (rtf[i] === '{' && SKIP.test(rtf.slice(i, i + 24))) {
      let depth = 0;
      for (; i < rtf.length; i++) {
        if (rtf[i] === '\\') { i++; continue; }
        if (rtf[i] === '{') depth++;
        else if (rtf[i] === '}' && --depth === 0) { i++; break; }
      }
      continue;
    }
    out += rtf[i++];
  }
  const cp1252 = new TextDecoder('windows-1252');
  return out
    // \uN suivi de son caractère de remplacement (\'xx ou une lettre) : on garde seulement le caractère Unicode
    .replace(/\\u(-?\d+) ?(?:\\'[0-9a-f]{2}|[^\\{}])?/gi, (m, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => cp1252.decode(Uint8Array.of(parseInt(h, 16))))
    .replace(/\\(par|line|sect|page)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
    .replace(/\\[{}\\]/g, (m) => m[1])
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

function plainParagraphs(text) {
  return String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => {
    const t = p.replace(/\n/g, ' ').replace(/[ \t]+/g, ' ').trim();
    return { text: t.replace(/^#{1,6}\s+/, ''), heading: /^#{1,6}\s+/.test(p.trim()) };
  }).filter((p) => p.text);
}

async function pdfParagraphs(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    lines.push(''); // fin de page
    page.cleanup();
  }
  await doc.destroy();
  // recolle les lignes coupées par la mise en page ; ligne vide = nouveau paragraphe
  const text = lines.join('\n').replace(/-\n(?=\p{Ll})/gu, '').replace(/([^\n.!?:;»"])\n(?=[\p{Ll}\p{N}(«"])/gu, '$1 ');
  const paras = plainParagraphs(text);
  if (!paras.length) throw new Error('Ce PDF ne contient pas de texte (document scanné ?).');
  return paras;
}

function parseClock(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000 : null;
}
function subtitleSegments(text) {
  const segs = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const ls = block.split('\n');
    const i = ls.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = ls[i].split('-->');
    const start = parseClock(a); const end = parseClock(b);
    const t = ls.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (start != null && end != null && t) segs.push({ start, end, text: t });
  }
  return segs;
}

function splitSentences(text) {
  return String(text).split(/(?<=[.!?…»])\s+(?=[\p{Lu}«"(\d])/u).map((s) => s.trim()).filter(Boolean);
}

/** Paragraphes → segments (une phrase par segment) avec minutage estimé ; écart de 2 s entre paragraphes. */
function toSegments(paras) {
  const segs = []; let t = 0; let id = 0;
  for (const p0 of paras) {
    // horodatages d'une transcription exportée (« [3:25] ») : retirés du texte
    const p = { ...p0, text: p0.text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, '').trim() };
    if (!p.text) continue;
    const sentences = p.heading ? [p.text] : splitSentences(p.text);
    for (const s of sentences) {
      // phrases très longues (texte sans ponctuation) : morceaux de ~40 mots
      const words = s.split(/\s+/);
      for (let k = 0; k < words.length; k += 40) {
        const part = words.slice(k, k + 40).join(' ');
        const d = Math.max(0.8, part.split(/\s+/).length / WORDS_PER_SEC);
        segs.push({ id: id++, start: +t.toFixed(2), end: +(t + d).toFixed(2), text: part, ...(p.heading ? { heading: true } : {}) });
        t += d + 0.25;
      }
    }
    t += 2;
  }
  return segs;
}

/**
 * @returns {Promise<{ title:string, segments:object[], estimated:boolean, kind:string, chars:number }>}
 */
async function importText(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!TEXT_EXT.includes(ext)) throw new Error(`Format .${ext} non pris en charge pour l’import de texte.`);
  const st = await fsp.stat(file);
  if (st.size > 60 * 1024 * 1024) throw new Error('Fichier trop volumineux (60 Mo maximum).');
  let paras = null; let segments = null;
  if (ext === 'docx') paras = await docxParagraphs(file);
  else if (ext === 'odt') paras = await odtParagraphs(file);
  else if (ext === 'pdf') paras = await pdfParagraphs(file);
  else {
    const text = decodeText(await fsp.readFile(file));
    if (ext === 'srt' || ext === 'vtt') {
      segments = subtitleSegments(text).map((s, i) => ({ id: i, ...s }));
      if (!segments.length) throw new Error('Aucun sous-titre trouvé dans ce fichier.');
    } else if (ext === 'html' || ext === 'htm' || ext === 'xml') paras = htmlParagraphs(text);
    else if (ext === 'rtf') paras = plainParagraphs(rtfToText(text));
    else if (ext === 'json') {
      // export VoxForge ou JSON quelconque : on prend les champs texte
      let j; try { j = JSON.parse(text); } catch { j = null; }
      if (j && Array.isArray(j.segments)) segments = j.segments.filter((s) => s && s.text).map((s, i) => ({ id: i, start: +s.start || 0, end: +s.end || 0, text: String(s.text) }));
      else paras = plainParagraphs(text);
    } else paras = plainParagraphs(text);
  }
  const estimated = !segments;
  if (!segments) segments = toSegments(paras || []);
  if (!segments.length) throw new Error('Ce fichier ne contient pas de texte.');
  const firstHeading = (paras || []).find((p) => p.heading && p.text.length < 120);
  const title = (firstHeading && firstHeading.text) || path.basename(file).replace(/\.[^.]+$/, '');
  return { title, segments, estimated, kind: ext, chars: segments.reduce((a, s) => a + s.text.length, 0) };
}

module.exports = { importText, TEXT_EXT };
