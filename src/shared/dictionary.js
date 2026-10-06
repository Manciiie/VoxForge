/**
 * VoxForge — dictionnaire personnalisé : remplacements appliqués aux transcriptions.
 * Règle : { from: 'la scène', to: 'la Seine', whole: true, caseSensitive: false, enabled: true }
 * Toutes les règles sont appliquées en UNE passe (une correction n'est jamais re-corrigée par une autre règle).
 * Utilisable côté moteur (Node) et côté interface (navigateur).
 */
(function (root) {
  'use strict';
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cache = new Map();

  function compile(rules) {
    const key = JSON.stringify(rules || []);
    if (cache.has(key)) return cache.get(key);
    const list = (rules || [])
      .filter((r) => r && r.from && String(r.from).trim() && r.to != null && r.enabled !== false)
      // les expressions les plus longues d'abord (« New York City » avant « York »)
      .sort((a, b) => String(b.from).trim().length - String(a.from).trim().length);
    // une expression régulière par sensibilité à la casse, avec un groupe par règle
    const groups = [];
    for (const cs of [false, true]) {
      const rs = list.filter((r) => !!r.caseSensitive === cs);
      if (!rs.length) continue;
      const alts = rs.map((r) => {
        const body = String(r.from).trim().split(/\s+/).map(escRe).join('\\s+'); // espaces souples
        return r.whole === false ? `(${body})` : `(?<![\\p{L}\\p{N}_])(${body})(?![\\p{L}\\p{N}_])`;
      });
      try { groups.push({ re: new RegExp(alts.join('|'), cs ? 'gu' : 'giu'), rules: rs, keepCase: !cs }); } catch { /* règle invalide ignorée */ }
    }
    if (cache.size > 20) cache.clear();
    cache.set(key, groups);
    return groups;
  }

  /** Majuscule initiale conservée (« La scène » → « La Seine »), sauf si le texte trouvé est en capitales (sigle). */
  function matchCase(found, repl) {
    if (!repl || !found) return repl;
    const f0 = found[0];
    const isTitle = f0 === f0.toUpperCase() && f0 !== f0.toLowerCase() && found !== found.toUpperCase();
    if (isTitle && repl[0] === repl[0].toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
    return repl;
  }

  /** @returns {{ text: string, count: number }} */
  function apply(text, rules) {
    const groups = compile(rules);
    let count = 0;
    let out = String(text || '');
    for (const g of groups) {
      out = out.replace(g.re, (...args) => {
        const m = args[0];
        const k = args.slice(1, 1 + g.rules.length).findIndex((x) => x !== undefined);
        const r = g.rules[k];
        if (!r) return m;
        count++;
        return g.keepCase ? matchCase(m, String(r.to)) : String(r.to);
      });
    }
    if (count) out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,]+/, '').trim();
    return { text: out, count };
  }

  const api = { apply, compile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoxDictionary = api;
})(typeof window !== 'undefined' ? window : globalThis);
