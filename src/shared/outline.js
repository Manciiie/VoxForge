/**
 * VoxForge — plan du cours détecté automatiquement.
 * Repère les annonces de plan d'un cours (surtout de droit) dans la transcription :
 *   Introduction · Partie I / Première partie · Titre 1 · Chapitre 2 · Section 1 · Sous-section 2 ·
 *   Paragraphe 1 / § 1 · A, B, C (grand A) · 1), 2) · a, b (petit a) · Conclusion
 * Les lettres et numéros doivent se suivre (A puis B puis C…) : un « B, » isolé n'est pas pris pour un titre.
 * Utilisable côté moteur (Node) et côté interface (navigateur).
 */
(function (root) {
  'use strict';

  const ORD = { premier: 1, premiere: 1, un: 1, une: 1, deuxieme: 2, second: 2, seconde: 2, deux: 2, troisieme: 3, trois: 3, quatrieme: 4, quatre: 4, cinquieme: 5, cinq: 5, sixieme: 6, six: 6, septieme: 7, sept: 7, huitieme: 8, huit: 8, neuvieme: 9, neuf: 9, dixieme: 10, dix: 10 };
  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const num = (tok) => {
    if (!tok) return 0;
    const t = deaccent(String(tok).toLowerCase()).replace(/[^a-z0-9]/g, '');
    if (/^\d+$/.test(t)) return +t;
    if (ORD[t]) return ORD[t];
    if (/^(1er|1ere)$/.test(t)) return 1;
    if (ROMAN[t]) return ROMAN[t];
    return 0;
  };
  const N = '(\\d{1,2}|[IVX]{1,4}|premi[eè]re?|1(?:er|re|ère)|un|une|deux(?:i[eè]me)?|second(?:e)?|trois(?:i[eè]me)?|quatre|quatri[eè]me|cinq(?:ui[eè]me)?|six(?:i[eè]me)?|sept(?:i[eè]me)?|huit(?:i[eè]me)?|neu(?:f|vi[eè]me)|dix(?:i[eè]me)?)';
  const SEP = '\\s*(?:[,.:;)\\-–—]\\s*|\\s+)';

  // [niveau, nom affiché, expression (le groupe 1 = numéro), clé de séquence]
  // « Section 2 », « Deuxième section », « Troisième et dernière section », « Le premier paragraphe »…
  const R = (name) => new RegExp(`^(?:(?:la|le|une|un)\\s+)?(?:${name}\\s+${N}|${N}(?:\\s+et\\s+derni[eè]re?)?\\s+${name})${SEP}`, 'i');
  const RULES = [
    [1, 'Partie', R('partie'), 'partie'],
    [1, 'Titre', R('titre'), 'titre'],
    [2, 'Chapitre', R('chapitre'), 'chapitre'],
    [3, 'Section', R('section'), 'section'],
    [4, 'Sous-section', R('sous[-\\s]section'), 'soussection'],
    [4, 'Paragraphe', new RegExp(`^(?:(?:le|un)\\s+)?(?:(?:paragraphe|§)\\s*${N}|${N}(?:\\s+et\\s+dernier)?\\s+paragraphe)${SEP}`, 'i'), 'paragraphe'],
  ];

  function splitSentences(text) {
    return String(text || '').split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  function cleanTitle(s) {
    let t = String(s || '').replace(/^[\s,.:;)\-–—]+/, '').replace(/[\s.;:,]+$/, '').trim();
    if (t.length > 110) t = t.slice(0, 107).replace(/\s+\S*$/, '') + '…';
    return t ? t[0].toUpperCase() + t.slice(1) : '';
  }

  /**
   * @param {{start:number,text:string}[]} segments
   * @returns {{ level:number, label:string, title:string, segIndex:number, start:number }[]}
   */
  function detectOutline(segments) {
    const out = [];
    const last = {}; // dernier numéro vu par clé de séquence
    const letter = { upper: '', lower: '', num: 0 };
    const items = [];
    (segments || []).forEach((sg, si) => splitSentences(sg.text).forEach((s, k, arr) => items.push({ s, si, start: sg.start, next: arr[k + 1] || ((segments[si + 1] && splitSentences(segments[si + 1].text)[0]) || '') })));

    const titleFrom = (rest, next) => {
      const t = cleanTitle(rest);
      if (t && t.split(/\s+/).length >= 1) return t;
      // titre annoncé seul (« Paragraphe 1. ») : la phrase suivante, si elle est courte
      const n = cleanTitle(next);
      return n && n.split(/\s+/).length <= 12 ? n : '';
    };
    const push = (level, label, title, it) => {
      if (!title) title = label;
      // pas deux fois le même titre à la suite (le professeur répète pour la prise de notes)
      const prev = out[out.length - 1];
      if (prev && prev.label === label && prev.title.toLowerCase() === title.toLowerCase()) return;
      out.push({ level, label, title, segIndex: it.si, start: it.start || 0 });
    };

    for (const it of items) {
      const s = it.s;
      // Introduction / Conclusion (phrase courte ou suivie de « : »)
      let m = /^(introduction|conclusion)(?:\s+g[ée]n[ée]rale)?\s*([:.,\-–]\s*(.*))?$/i.exec(s);
      if (m && (s.split(/\s+/).length <= 8 || /[:\-–]/.test(m[2] || ''))) {
        push(1, cleanTitle(m[1]), cleanTitle(m[3] || '') || cleanTitle(m[1]), it);
        if (/^intro/i.test(m[1])) { letter.upper = ''; letter.lower = ''; letter.num = 0; }
        continue;
      }
      let matched = false;
      for (const [level, name, re, key] of RULES) {
        m = re.exec(s);
        if (!m) continue;
        const n = num(m[1] || m[2]);
        if (!n) continue;
        // sans ponctuation après le numéro, le titre doit commencer par une majuscule
        // (« Paragraphe 1 Origine… » oui ; « Deuxième partie de vos tâches » non)
        const rest = s.slice(m[0].length);
        if (!/[,.:;)\-–—]/.test(m[0].slice(-3)) && rest && !/^[\p{Lu}«"]/u.test(rest)) continue;
        // séquence plausible : 1, ou suivant du précédent, ou répétition du même
        if (n !== 1 && last[key] && n !== last[key] + 1 && n !== last[key]) continue;
        // premier titre de ce type : n'importe quel numéro (l'enregistrement peut reprendre un cours commencé avant)
        last[key] = n;
        // un niveau supérieur remet à zéro les sous-niveaux
        for (const [lv2, , , k2] of RULES) if (lv2 > level) delete last[k2];
        if (level <= 4) { letter.upper = ''; letter.lower = ''; letter.num = 0; }
        push(level, `${name} ${n}`, titleFrom(s.slice(m[0].length), it.next), it);
        matched = true;
        break;
      }
      if (matched) continue;
      // chiffres romains en tête de phrase : « I. … », « II - … »
      m = /^([IVX]{1,4})\s*[.)\-–—]\s+(.+)/.exec(s);
      if (m && ROMAN[m[1].toLowerCase()]) {
        const n = ROMAN[m[1].toLowerCase()];
        if (n === 1 || last.roman === n - 1) {
          last.roman = n; letter.upper = ''; letter.lower = ''; letter.num = 0;
          push(1, m[1], cleanTitle(m[2]), it);
          continue;
        }
      }
      // grand A, B, C… : « A, origine du droit comparé. » / « Grand B : … »
      m = /^(?:grand\s+)?([A-H])\s*[,.:)\-–—]\s+(.+)/.exec(s) || /^grand\s+([A-H])\s+(.+)/i.exec(s);
      if (m) {
        const L = m[1].toUpperCase();
        const ok = L === 'A' || (letter.upper && L.charCodeAt(0) === letter.upper.charCodeAt(0) + 1) || L === letter.upper;
        if (ok && m[2].split(/\s+/).length <= 16) {
          letter.upper = L; letter.lower = ''; letter.num = 0;
          push(5, L, cleanTitle(m[2]), it);
          continue;
        }
      }
      // petit a, b… : « petit a, … »
      m = /^petit\s+([a-h])\s*[,.:)\-–—]?\s+(.+)/i.exec(s);
      if (m) {
        const l = m[1].toLowerCase();
        if (l === 'a' || (letter.lower && l.charCodeAt(0) === letter.lower.charCodeAt(0) + 1)) {
          letter.lower = l;
          push(7, l, cleanTitle(m[2]), it);
          continue;
        }
      }
      // 1), 2) / 1°, 2°
      m = /^(\d{1,2})\s*[)°]\s*(.+)/.exec(s);
      if (m) {
        const n = +m[1];
        if ((n === 1 || n === letter.num + 1) && m[2].split(/\s+/).length <= 16) {
          letter.num = n; letter.lower = '';
          push(6, `${n})`, cleanTitle(m[2]), it);
        }
      }
    }
    // un plan d'un seul élément « A » sans suite n'est pas un plan
    if (out.length === 1 && out[0].level >= 5) return [];
    return out;
  }

  /** Profondeur relative (0 = niveau le plus haut présent dans ce plan). */
  function withDepth(list) {
    const levels = [...new Set((list || []).map((h) => h.level))].sort((a, b) => a - b);
    return (list || []).map((h) => ({ ...h, depth: levels.indexOf(h.level) }));
  }

  /** Markdown : un titre par élément du plan (profondeur 0 → ##, 1 → ###, … max ######). */
  function headingMd(h) {
    const hashes = '#'.repeat(Math.min(6, 2 + (h.depth || 0)));
    const label = /^(Introduction|Conclusion)$/i.test(h.label) || h.title.toLowerCase().startsWith(h.label.toLowerCase()) ? '' : `${h.label} — `;
    return `${hashes} ${label}${h.title}`;
  }

  const api = { detectOutline, headingMd, withDepth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoxOutline = api;
})(typeof window !== 'undefined' ? window : globalThis);
