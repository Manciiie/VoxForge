/**
 * VoxForge — vocabulaire du cours : corrige l'orthographe des noms propres et termes techniques
 * quand la reconnaissance vocale écrit « à l'oreille » (Saleï → Saleilles, Konstantin Echko → Constantinesco).
 *
 * Principe : chaque terme est comparé aux groupes de 1 à n+1 mots du texte, sur une clé phonétique
 * française (eill → ey, ch → sh, c dur → k, lettres muettes finales…) ET sur l'orthographe.
 * Prudence : un mot courant en minuscules n'est jamais remplacé par un terme d'un seul mot
 * (« main » ne devient pas « Maine » ; seul « Henry Main » devient « Henry Maine » si le terme est « Henry Maine »).
 *
 * Utilisable côté moteur (Node) et côté interface (navigateur).
 */
(function (root) {
  'use strict';

  const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  /** Clé phonétique française simplifiée (suffisante pour rapprocher deux graphies d'un même son). */
  function phon(word) {
    let s = deaccent(String(word).toLowerCase()).replace(/[^a-z]/g, '');
    if (!s) return '';
    s = s
      .replace(/^h/, '')
      .replace(/ph/g, 'f').replace(/th/g, 't').replace(/gh/g, 'g')
      .replace(/sch/g, 'sh').replace(/ch/g, 'sh').replace(/sh/g, 'S')
      .replace(/eill/g, 'ey').replace(/aill/g, 'ay').replace(/ouill/g, 'uy').replace(/([aeiou])ill/g, '$1y')
      .replace(/qu/g, 'k').replace(/ck/g, 'k').replace(/c([eiy])/g, 's$1').replace(/c/g, 'k').replace(/q/g, 'k')
      .replace(/x/g, 'ks').replace(/w/g, 'v').replace(/z/g, 's')
      .replace(/g([eiy])/g, 'j$1').replace(/gn/g, 'n').replace(/gu([eiy])/g, 'g$1')
      .replace(/eau/g, 'o').replace(/au/g, 'o').replace(/ou/g, 'u').replace(/oi/g, 'wa')
      .replace(/ai/g, 'e').replace(/ei/g, 'e').replace(/ay/g, 'e').replace(/ey/g, 'e')
      .replace(/(an|en|am|em)(?![aeiouy])/g, 'A').replace(/(in|im|ain|ein|un|um)(?![aeiouy])/g, 'I').replace(/(on|om)(?![aeiouy])/g, 'O')
      .replace(/y/g, 'i')
      .replace(/([a-zA-Z])\1+/g, '$1')
      .replace(/h/g, '');
    // consonnes finales souvent muettes, e final
    s = s.replace(/(?<=..)[stdxp]$/, '');
    return s;
  }

  /** Distance d'édition, arrêtée dès qu'elle dépasse `max` (renvoie max + 1). */
  function lev(a, b, max = 99) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > max) return max + 1;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1); for (let j = 0; j <= n; j++) prev[j] = j;
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i; let rowMin = i;
      const ai = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === b.charCodeAt(j - 1) ? 0 : 1));
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  const norm = (s) => deaccent(String(s).toLowerCase()).replace(/[^a-z0-9]/g, '');
  const isCap = (w) => /^\p{Lu}/u.test(w);

  // découpe en jetons « mot » + séparateurs, pour réécrire le texte sans toucher à la ponctuation
  const TOKEN = /([\p{L}\p{N}][\p{L}\p{N}'’\-]*)/gu;

  const cache = new Map();
  function compile(terms) {
    const key = JSON.stringify(terms || []);
    if (cache.has(key)) return cache.get(key);
    const list = [];
    for (const raw of terms || []) {
      const t = String(raw || '').trim();
      if (!t || t.length < 3) continue;
      const words = t.split(/\s+/);
      const flat = words.join('');
      list.push({ term: t, words: words.length, wordNorms: words.map(norm), phon: phon(flat), norm: norm(flat), cap: isCap(t) });
    }
    // les termes les plus longs d'abord
    list.sort((a, b) => b.norm.length - a.norm.length);
    if (cache.size > 20) cache.clear();
    cache.set(key, list);
    return list;
  }

  const SUFFIX = /^(s|x|e|es)$/;
  /** mot du texte = mot du terme, ou sa forme plurielle / féminine (« codes » pour « code ») */
  const sameWord = (w, tw) => w === tw || (w.length > tw.length && w.startsWith(tw) && SUFFIX.test(w.slice(tw.length)));

  /** Le groupe de mots `c` (pré-calculé : mots, norm, phon) est-il une mauvaise graphie du terme ? */
  function matches(t, c) {
    const { n, p, words: candWords } = c;
    if (!n || n === t.norm || !p || !t.phon) return false; // déjà correct (ou vide)
    if (Math.abs(p.length - t.phon.length) > 2) return false;
    const minLen = Math.min(p.length, t.phon.length);
    // simple variante grammaticale (pluriel, féminin…) d'un mot correct : on n'y touche pas
    if (n.startsWith(t.norm) && n.length - t.norm.length <= 3) return false;
    const dPh = lev(p, t.phon, 3);
    const okPhon = dPh === 0 ? minLen >= 4 : dPh === 1 ? minLen >= 6 : dPh === 2 ? minLen >= 10 : false;
    let okChar = false;
    if (!okPhon) {
      if (t.norm.length < 9 || !(dPh <= 1 || (candWords.length > 1 && candWords.every(isCap)))) return false;
      okChar = lev(n, t.norm, 1) <= 1;
      if (!okChar) return false;
    }
    if (candWords.length === t.words && c.wn.every((w, k) => sameWord(w, t.wordNorms[k]))) return false;
    // un groupe de plusieurs mots ne peut pas « avaler » un article (le, la, un, du…)
    if (candWords.length > 1 && candWords.some((w, k) => !isCap(w) && c.wn[k].length <= 3)) return false;
    // garde-fous : un terme d'un seul mot ne remplace qu'un mot qui ressemble à un nom propre / terme rare
    if (t.words === 1 && candWords.length === 1) {
      const w = candWords[0];
      if (!isCap(w) && t.cap) return false;           // « main » ≠ « Maine »
      if (!isCap(w) && n.length < 7) return false;     // mots courts en minuscules : trop risqué
    }
    // plusieurs mots du texte pour un seul mot du terme : au moins un doit ressembler à un nom propre
    if (candWords.length > t.words && !candWords.some(isCap) && t.cap) return false;
    return true;
  }

  /**
   * Corrige `text` avec la liste de termes.
   * @returns {{ text: string, count: number, changes: {from:string,to:string}[] }}
   */
  function apply(text, terms) {
    const list = compile(terms);
    const src = String(text || '');
    if (!list.length || !src) return { text: src, count: 0, changes: [] };
    // positions des mots
    const toks = [];
    let m; TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src))) toks.push({ w: m[1], s: m.index, e: m.index + m[1].length, n: '' });
    for (const tk of toks) tk.n = norm(tk.w);
    const repl = []; // { s, e, to }
    const used = new Uint8Array(toks.length);
    // 1) termes déjà bien écrits (ou au pluriel) : protégés, jamais « corrigés » vers un terme voisin
    const maxW = Math.max(...list.map((t) => t.words));
    const byFirst = new Map(); // premier mot (4 lettres) → termes
    for (const t of list) { const k = t.wordNorms[0].slice(0, 4); if (!byFirst.has(k)) byFirst.set(k, []); byFirst.get(k).push(t); }
    for (let i = 0; i < toks.length; i++) {
      const cands = byFirst.get(toks[i].n.slice(0, 4));
      if (!cands) continue;
      let best = 0;
      for (const t of cands) {
        if (t.words > best && i + t.words <= toks.length && t.wordNorms.every((tw, k) => sameWord(toks[i + k].n, tw) || (t.words === 1 && toks[i].n.length >= 6 && toks[i].n.startsWith(tw) && toks[i].n.length - tw.length <= 3))) best = t.words;
      }
      if (best) for (let k = i; k < i + best; k++) used[k] = 1;
    }
    // 2) graphies approchées — chaque groupe de mots n'est analysé qu'une fois (clé phonétique en cache)
    const spanCache = new Array(toks.length * 8);
    const span = (i, len) => {
      const key = i * 8 + len;
      let c = spanCache[key];
      if (!c) {
        const ws = toks.slice(i, i + len);
        const text = src.slice(toks[i].s, toks[i + len - 1].e);
        c = { words: ws.map((x) => x.w), wn: ws.map((x) => x.n), n: ws.map((x) => x.n).join(''), text, punct: len > 1 && /[.!?;:,«»"()]/.test(text), p: null };
        spanCache[key] = c;
      }
      return c;
    };
    // longueur (lettres) des groupes de mots, pour un filtre rapide
    const pre = new Int32Array(toks.length + 1);
    for (let k = 0; k < toks.length; k++) pre[k + 1] = pre[k] + toks[k].n.length;
    for (const t of list) {
      const slack = Math.max(4, t.norm.length * 0.5);
      for (let i = 0; i < toks.length; i++) {
        if (used[i]) continue;
        // groupes de t.words-1 … t.words+1 mots, le plus long d'abord
        for (let len = Math.min(t.words + 1, toks.length - i, 7); len >= Math.max(1, t.words - 1); len--) {
          if (Math.abs(pre[i + len] - pre[i] - t.norm.length) > slack) continue;
          let free = true;
          for (let k = i; k < i + len; k++) if (used[k]) { free = false; break; }
          if (!free) continue;
          const c = span(i, len);
          if (c.punct) continue; // pas de ponctuation forte à l'intérieur du groupe
          if (c.p === null) c.p = phon(c.words.join(''));
          if (matches(t, c)) {
            repl.push({ s: toks[i].s, e: toks[i + len - 1].e, to: t.term, from: c.text });
            for (let k = i; k < i + len; k++) used[k] = 1;
            break;
          }
        }
      }
    }
    if (!repl.length) return { text: src, count: 0, changes: [] };
    repl.sort((a, b) => a.s - b.s);
    let out = ''; let pos = 0;
    for (const r of repl) { out += src.slice(pos, r.s) + r.to; pos = r.e; }
    out += src.slice(pos);
    return { text: out, count: repl.length, changes: repl.map((r) => ({ from: r.from, to: r.to })) };
  }

  /** Pack prêt à l'emploi : droit (auteurs, juridictions, expressions latines…). */
  const PACKS = {
    droit: {
      name: 'Droit',
      terms: [
        'Montesquieu', 'Portalis', 'Cambacérès', 'Pothier', 'Domat', 'Savigny', 'Jhering', 'Saleilles', 'Édouard Lambert',
        'Constantinesco', 'René David', 'Zweigert', 'Kötz', 'Rodolfo Sacco', 'Pierre Legrand', 'Henry Sumner Maine', 'Henry Maine',
        'Kelsen', 'Carbonnier', 'Gény', 'Duguit', 'Hauriou', 'Josserand', 'Planiol', 'Ripert', 'Capitant', 'Grotius', 'Leibniz',
        'Feuerbach', 'Vico', 'Bentham', 'Blackstone', 'Edward Coke', 'Beccaria', 'Tocqueville', 'Rousseau', 'Hobbes', 'Locke',
        'Code civil', 'Code Napoléon', 'BGB', 'ABGB', 'common law', 'equity', 'stare decisis', 'ratio decidendi', 'obiter dictum',
        'jus commune', 'ius commune', 'Corpus juris civilis', 'Digeste', 'Justinien', 'Gaius', 'Ulpien',
        'Conseil constitutionnel', "Conseil d'État", 'Cour de cassation', 'CEDH', 'CJUE', 'QPC', 'Cour européenne des droits de l’homme',
        'erga omnes', 'inter partes', 'habeas corpus', 'de cujus', 'nue-propriété', 'usufruit', 'synallagmatique', 'cocontractant',
        'jurisprudence', 'macro-comparaison', 'micro-comparaison', 'comparatisme', 'comparatiste', 'synchronique', 'diachronique',
        'codification', 'pandectistes', 'glossateurs', 'postglossateurs', 'jusnaturalisme', 'positivisme',
      ],
    },
  };

  const api = { apply, phon, compile, PACKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoxVocabulary = api;
})(typeof window !== 'undefined' ? window : globalThis);
