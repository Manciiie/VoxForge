/**
 * VoxForge — suppression des « échos » : passages que la reconnaissance (surtout Whisper, en fin de bloc)
 * recopie par erreur quelques mots après les avoir déjà écrits.
 *
 *   « …dès le fonctionnement des institutions. Cela impose la nécessité d'une conscience pleine,
 *     et de permettre une construction par le bas, dès le fonctionnement des institutions. Cela impose… »
 *
 * Les répétitions VOLONTAIRES d'un enseignant qui dicte (« La législation comparée. La législation comparée… »)
 * sont collées l'une à l'autre : elles sont conservées. Un écho est retiré seulement si :
 *  - au moins MIN_LEN mots identiques (hors ponctuation),
 *  - séparés de leur première occurrence par 3 à MAX_GAP mots (ni collés, ni trop loin),
 *  - et la copie commence au milieu d'une phrase (après une virgule, un mot…) : un enseignant qui répète
 *    pour la prise de notes reprend sa phrase depuis le début, Whisper qui « bégaie » repart n'importe où.
 * Utilisable côté moteur (Node) et côté interface (navigateur).
 */
(function (root) {
  'use strict';
  const MIN_LEN = 10;
  const MAX_GAP = 40;
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  const key = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

  /**
   * @param {{text:string}[]} segments
   * @returns {{ segments: object[], removed: { text: string, segIndex: number }[] }}
   */
  function removeEchoes(segments, { minLen = MIN_LEN, maxGap = MAX_GAP, keepEmpty = false } = {}) {
    const words = []; // { k, seg, s, e }
    segments.forEach((sg, si) => {
      const t = String(sg.text || ''); let m; WORD.lastIndex = 0;
      while ((m = WORD.exec(t))) words.push({ k: key(m[0]), seg: si, s: m.index, e: m.index + m[0].length });
    });
    const n = words.length;
    const drop = new Uint8Array(n);
    // le mot i commence-t-il une phrase (début de segment, ou après . ! ? …) ?
    const startsSentence = (k) => {
      const w = words[k];
      if (k === 0 || words[k - 1].seg !== w.seg) return true;
      const before = String(segments[w.seg].text).slice(words[k - 1].e, w.s);
      return /[.!?…]/.test(before);
    };
    // début de phrase, éventuellement précédé d'un petit mot (« La comparaison… », « Et donc… »)
    const nearSentenceStart = (k) => startsSentence(k) || (k > 0 && words[k - 1].k.length <= 3 && startsSentence(k - 1));
    // index des positions par mot pour trouver vite les débuts candidats
    const pos = new Map();
    let i = 0;
    while (i < n) {
      let best = null;
      const list = pos.get(words[i].k) || [];
      for (let q = list.length - 1; q >= 0; q--) {
        const j = list[q];
        if (i - j > maxGap + 200) break;
        let len = 0;
        while (i + len < n && j + len < i && words[j + len].k === words[i + len].k && !drop[j + len]) len++;
        const gap = i - (j + len);
        // la copie doit être prise en entier (maximale vers la gauche), sinon on la jugerait sur un bout
        const leftMax = !(j > 0 && words[i - 1].k === words[j - 1].k);
        if (len >= minLen && gap >= 3 && gap <= maxGap && leftMax && !nearSentenceStart(i) && (!best || len > best.len)) best = { j, len };
      }
      if (best) {
        for (let k = i; k < i + best.len; k++) drop[k] = 1;
        i += best.len;
        continue;
      }
      if (!pos.has(words[i].k)) pos.set(words[i].k, []);
      pos.get(words[i].k).push(i);
      i++;
    }
    if (!drop.some(Boolean)) return { segments, removed: [] };
    // réécriture des segments concernés
    const removed = [];
    const bySeg = new Map();
    words.forEach((w, k) => { if (drop[k]) { if (!bySeg.has(w.seg)) bySeg.set(w.seg, []); bySeg.get(w.seg).push(w); } });
    const out = segments.map((sg, si) => {
      const ws = bySeg.get(si);
      if (!ws) return sg;
      let t = String(sg.text);
      // retire chaque plage de mots (avec la ponctuation et l'espace qui suivent), de la fin vers le début
      const ranges = [];
      for (const w of ws) {
        const last = ranges[ranges.length - 1];
        if (last && /^[\s,;:.!?«»"'’()\-–—]*$/.test(t.slice(last.e, w.s))) last.e = w.e; else ranges.push({ s: w.s, e: w.e });
      }
      for (let r = ranges.length - 1; r >= 0; r--) {
        let { s, e } = ranges[r];
        const m = /^[\s,;:.!?…]*/.exec(t.slice(e)); e += m ? m[0].length : 0;
        removed.push({ text: t.slice(s, e).trim(), segIndex: si });
        t = t.slice(0, s) + t.slice(e);
      }
      t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
      return { ...sg, text: t };
    });
    return { segments: keepEmpty ? out : out.filter((sg) => String(sg.text || '').trim()), removed };
  }

  const api = { removeEchoes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoxEchoes = api;
})(typeof window !== 'undefined' ? window : globalThis);
