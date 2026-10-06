'use strict';
/**
 * Questions sur tous les cours : recherche des passages les plus pertinents dans l'historique
 * (transcriptions + textes importés), avant de les confier à l'IA pour rédiger une réponse sourcée.
 *
 * Recherche « BM25 » (comme un moteur de recherche) sur des passages d'environ 120 mots,
 * avec normalisation du français (accents, pluriels, mots vides). Aucun modèle supplémentaire.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const STOP = new Set(('a au aux avec ce ces cet cette dans de des du elle elles en et eux il ils je la le les leur leurs lui ma mais me meme mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous c d j l m n s t y est sont ete etre avoir a ai as avons avez ont etait etaient fait faire plus moins tres bien aussi alors donc comme si tout tous toute toutes cela ca celui celle ceux celles dont ou quand quoi quel quelle quels quelles the of and to in is it that this for on with as be are was were by an at or from what which who how why does do did').split(' '));
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function stem(w) {
  // racinisation légère : pluriels et féminins (« comparés », « comparée » → « compar »)
  if (w.length > 5) w = w.replace(/(ements?|ments?)$/, 'm');
  if (w.length > 4) w = w.replace(/(aux)$/, 'al').replace(/([^s])(es|s|x)$/, '$1');
  if (w.length > 4) w = w.replace(/(ees|ee|es|e)$/, '');
  return w;
}
function tokens(text) {
  return deaccent(String(text).toLowerCase()).split(/[^a-z0-9]+/).filter((w) => w && (w.length > 1 || /\d/.test(w)) && !STOP.has(w)).map(stem);
}

function fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }

class Knowledge {
  constructor(historyDir) {
    this.dir = historyDir;
    this.docs = new Map(); // fichier -> { mtimeMs, id, name, source, passages: [{ start, end, text, toks, tf }] }
  }

  async refresh() {
    const files = (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const p = path.join(this.dir, f);
      try {
        const st = await fsp.stat(p);
        const c = this.docs.get(f);
        if (c && c.mtimeMs === st.mtimeMs) continue;
        const h = JSON.parse(await fsp.readFile(p, 'utf8'));
        this.docs.set(f, { mtimeMs: st.mtimeMs, id: h.id, name: h.name || 'Sans titre', source: h.source || 'file', createdAt: h.createdAt, passages: this.passages(h.segments || []) });
      } catch { /* fichier abîmé ignoré */ }
    }
    for (const k of this.docs.keys()) if (!files.includes(k)) this.docs.delete(k);
  }

  passages(segments) {
    const out = []; let cur = null;
    const flush = () => { if (cur && cur.text.trim()) { cur.toks = tokens(cur.text); cur.bigrams = new Set(cur.toks.slice(1).map((t, i) => cur.toks[i] + ' ' + t)); cur.tf = new Map(); for (const t of cur.toks) cur.tf.set(t, (cur.tf.get(t) || 0) + 1); out.push(cur); } };
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (!cur) cur = { start: s.start || 0, end: s.end || 0, text: '' };
      cur.text += (cur.text ? ' ' : '') + String(s.text || '').trim();
      cur.end = s.end || cur.end;
      if (cur.text.split(/\s+/).length >= 120) {
        flush();
        // chevauchement : la dernière phrase ouvre le passage suivant (une idée coupée en deux reste trouvable)
        cur = { start: s.start || 0, end: s.end || 0, text: String(s.text || '').trim() };
      }
    }
    flush();
    return out;
  }

  /**
   * @param {string} query
   * @param {{ ids?: string[], source?: 'text'|'audio', limit?: number }} opts
   */
  async search(query, { ids = null, source = null, limit = 8 } = {}) {
    await this.refresh();
    const qSeq = tokens(query);
    const q = [...new Set(qSeq)];
    if (!q.length) return [];
    const all = [];
    for (const d of this.docs.values()) {
      if (ids && !ids.includes(d.id)) continue;
      if (source === 'text' && d.source !== 'text') continue;
      if (source === 'audio' && d.source === 'text') continue;
      for (const p of d.passages) all.push({ d, p });
    }
    if (!all.length) return [];
    const N = all.length;
    const avg = all.reduce((a, x) => a + x.p.toks.length, 0) / N || 1;
    const df = new Map();
    for (const t of q) { let n = 0; for (const x of all) if (x.p.tf.has(t)) n++; df.set(t, n); }
    const k1 = 1.4, b = 0.75;
    const scored = [];
    for (const x of all) {
      let s = 0; let hit = 0;
      for (const t of q) {
        const f = x.p.tf.get(t); if (!f) continue;
        hit++;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * x.p.toks.length / avg));
      }
      if (s > 0) {
        // bonus d'expression : mots de la question qui se suivent aussi dans le passage (« règle des 3 C », « congrès international »)
        let bi = 0;
        for (let i = 0; i + 1 < qSeq.length; i++) if (x.p.bigrams.has(qSeq[i] + ' ' + qSeq[i + 1])) bi++;
        scored.push({ score: s * (0.6 + 0.4 * hit / q.length) * (1 + 0.5 * bi), x });
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
    // au plus 3 passages par document (variété des sources)
    const perDoc = new Map(); const out = [];
    for (const r of scored) {
      const n = perDoc.get(r.x.d.id) || 0;
      if (n >= 3) continue;
      perDoc.set(r.x.d.id, n + 1);
      out.push({ docId: r.x.d.id, title: r.x.d.name, source: r.x.d.source, start: r.x.p.start, end: r.x.p.end, time: fmt(r.x.p.start), text: r.x.p.text, score: +r.score.toFixed(3) });
      if (out.length >= limit) break;
    }
    return out;
  }
}

module.exports = { Knowledge, tokens };
