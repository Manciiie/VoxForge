'use strict';
/**
 * VoxForge — tâches d'IA : traduction et résumé.
 * Indépendant du moteur : `llm.complete({ system, user, schema, maxTokens, signal })`
 * renvoie le texte produit (JSON si `schema` est fourni).
 */

const LANG_EN = {
  af: 'Afrikaans', sq: 'Albanian', de: 'German', am: 'Amharic', en: 'English', ar: 'Arabic', hy: 'Armenian',
  as: 'Assamese', az: 'Azerbaijani', ba: 'Bashkir', eu: 'Basque', bn: 'Bengali', be: 'Belarusian', my: 'Burmese',
  bs: 'Bosnian', br: 'Breton', bg: 'Bulgarian', yue: 'Cantonese', ca: 'Catalan', zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese', ko: 'Korean', ht: 'Haitian Creole', hr: 'Croatian', da: 'Danish', es: 'Spanish',
  et: 'Estonian', fo: 'Faroese', fi: 'Finnish', fr: 'French', gl: 'Galician', cy: 'Welsh', ka: 'Georgian',
  el: 'Greek', gu: 'Gujarati', ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian',
  id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', jw: 'Javanese', kn: 'Kannada', kk: 'Kazakh',
  km: 'Khmer', lo: 'Lao', la: 'Latin', lv: 'Latvian', ln: 'Lingala', lt: 'Lithuanian', lb: 'Luxembourgish',
  mk: 'Macedonian', ms: 'Malay', ml: 'Malayalam', mg: 'Malagasy', mt: 'Maltese', mi: 'Maori', mr: 'Marathi',
  mn: 'Mongolian', nl: 'Dutch', ne: 'Nepali', no: 'Norwegian', nn: 'Norwegian Nynorsk', oc: 'Occitan', ur: 'Urdu',
  uz: 'Uzbek', ps: 'Pashto', pa: 'Punjabi', fa: 'Persian', pl: 'Polish', pt: 'Portuguese', 'pt-BR': 'Brazilian Portuguese',
  ro: 'Romanian', ru: 'Russian', sa: 'Sanskrit', sr: 'Serbian', sn: 'Shona', sd: 'Sindhi', si: 'Sinhala',
  sk: 'Slovak', sl: 'Slovenian', so: 'Somali', su: 'Sundanese', sv: 'Swedish', sw: 'Swahili', tg: 'Tajik',
  tl: 'Tagalog', ta: 'Tamil', tt: 'Tatar', cs: 'Czech', te: 'Telugu', th: 'Thai', bo: 'Tibetan', tk: 'Turkmen',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', yi: 'Yiddish', yo: 'Yoruba',
};
const langLabel = (code) => LANG_EN[code] || code;

class Cancelled extends Error { constructor() { super('Annulé'); this.name = 'AbortError'; } }
const check = (signal) => { if (signal && signal.aborted) throw new Cancelled(); };

/**
 * Réparation d'un JSON coupé net (le modèle a atteint sa limite de longueur au milieu d'une liste) :
 * on retire l'élément inachevé puis on referme les chaînes, listes et objets restés ouverts.
 */
function repairTruncatedJson(t) {
  const a = t.indexOf('{'); if (a < 0) return null;
  t = t.slice(a);
  const stack = []; let inStr = false; let esc = false; let lastSafe = -1; // position après le dernier élément complet
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') { inStr = false; } continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') { stack.pop(); lastSafe = i + 1; if (!stack.length) return t.slice(0, i + 1); }
    else if (c === ',') lastSafe = i; // tout ce qui précède la virgule est complet
  }
  if (lastSafe < 0) return null;
  let cut = t.slice(0, lastSafe).replace(/[,\s]+$/, '');
  // referme dans l'ordre ce qui est encore ouvert à cet endroit
  const st = []; inStr = false; esc = false;
  for (const c of cut) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{' || c === '[') st.push(c); else if (c === '}' || c === ']') st.pop();
  }
  // clé restée sans valeur (« , "chapters": » ou « { "title" ») : retirée
  cut = cut.replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, (m, p1) => (p1 === '{' ? '{' : '')).replace(/,\s*$/, '');
  while (st.length) cut += st.pop() === '{' ? '}' : ']';
  return cut;
}

/** Extraction tolérante d'un objet JSON dans une réponse (balises ```json, texte autour, réponse coupée…). */
function parseJsonLoose(text) {
  if (text == null) throw new Error('Réponse vide');
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(t); } catch { /* on cherche le premier bloc { … } */ }
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* réponse coupée ? */ } }
  const fixed = repairTruncatedJson(t);
  if (fixed) { try { const j = JSON.parse(fixed); if (j && typeof j === 'object') { Object.defineProperty(j, '__truncated', { value: true }); return j; } } catch { /* */ } }
  throw new Error('Réponse de l’IA illisible (JSON incomplet). Réessayez, ou choisissez une longueur de résumé plus courte.');
}

const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

// =====================================================================================
// Traduction
// =====================================================================================
/**
 * Traduit les segments en conservant l'alignement 1 segment = 1 ligne traduite
 * (indispensable pour exporter des sous-titres traduits).
 * @returns {Promise<string[]>}
 */
/**
 * Exécute fn(item, index, signal) sur chaque élément avec au plus `limit` appels simultanés (ordre conservé).
 * Avec un modèle local sur carte graphique, plusieurs parties sont rédigées en même temps.
 * À la première erreur, les appels en cours sont interrompus (signal) et l'erreur est renvoyée ;
 * une panne du moteur (stalled) prime sur une erreur ordinaire.
 */
async function pmap(items, limit, fn, signal) {
  const out = new Array(items.length);
  let next = 0; let err = null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const worker = async () => {
    while (!err && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i, ctrl.signal); } catch (e) {
        if (!err || (e && e.stalled && !err.stalled)) err = e;
        ctrl.abort(); // les autres s'arrêtent au prochain jeton
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.max(1, Math.min(limit || 1, items.length)) }, worker)); }
  finally { if (signal) signal.removeEventListener('abort', onAbort); }
  if (err) {
    if (signal && signal.aborted) throw new Cancelled(); // annulation demandée par l'utilisateur
    throw err;
  }
  return out;
}
const lanes = (llm) => Math.max(1, Math.min(4, (llm && llm.parallel) || 1));

async function translateSegments(llm, segments, target, { signal, onProgress, batchChars = 1400, batchMax = 14, sourceLang = '' } = {}) {
  const out = new Array(segments.length).fill(null);
  const targetName = langLabel(target);
  const todo = [];
  segments.forEach((s, i) => {
    const text = (s.text || '').trim();
    if (!text) out[i] = '';
    else if (s.lang && (s.lang === target || (target.startsWith(s.lang + '-') && s.lang.length === 2)) && !sourceLang) out[i] = text; // déjà dans la langue cible
    else todo.push(i);
  });
  // lots de segments consécutifs
  const batches = [];
  let cur = []; let len = 0;
  for (const i of todo) {
    const l = segments[i].text.length;
    if (cur.length && (len + l > batchChars || cur.length >= batchMax || i !== cur[cur.length - 1] + 1)) { batches.push(cur); cur = []; len = 0; }
    cur.push(i); len += l;
  }
  if (cur.length) batches.push(cur);

  const total = todo.length;
  let doneCount = 0;
  const report = () => onProgress && onProgress({ done: doneCount, total, ratio: total ? doneCount / total : 1, partial: out });
  report();

  const system = `You are an expert professional translator. Translate faithfully and naturally into ${targetName}. ` +
    'Preserve meaning, tone, names, numbers and line order. Never add notes, explanations or transliterations. ' +
    'Each input line is a fragment of a spoken transcript; translate each one on its own while keeping the context coherent.';

  const runBatch = async (idx, sig = signal) => {
    check(sig);
    const lines = idx.map((i) => segments[i].text.trim());
    if (idx.length === 1) {
      const r = await llm.complete({
        system,
        user: `Translate this text into ${targetName}. Reply with the translation only.\n\n${lines[0]}`,
        maxTokens: Math.min(1024, 64 + lines[0].length * 2),
        signal: sig,
      });
      out[idx[0]] = cleanLine(r) || lines[0];
      doneCount++; report();
      return;
    }
    const schema = {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'string' }, minItems: lines.length, maxItems: lines.length } },
      required: ['translations'],
    };
    let ok = false;
    try {
      const r = await llm.complete({
        system,
        user: `Translate each of the ${lines.length} lines below into ${targetName} (${target}). ` +
          `Return a JSON object {"translations": [...]} containing exactly ${lines.length} strings, in the same order, one per input line.\n\n` +
          JSON.stringify(lines, null, 1),
        schema,
        maxTokens: Math.min(3500, 120 + Math.round(lines.join(' ').length * 2.2)),
        signal: sig,
      });
      const j = parseJsonLoose(r);
      const arr = Array.isArray(j) ? j : j.translations;
      if (Array.isArray(arr) && arr.length === lines.length && arr.every((x) => typeof x === 'string')) {
        arr.forEach((t, k) => { out[idx[k]] = cleanLine(t) || lines[k]; });
        doneCount += idx.length; report();
        ok = true;
      }
    } catch (e) {
      if (e.name === 'AbortError' || (sig && sig.aborted)) throw new Cancelled();
      if (e.stalled) throw e; // moteur bloqué : inutile de réessayer
    }
    if (!ok) {
      // réponse tronquée ou mal alignée : on coupe le lot en deux
      const mid = Math.ceil(idx.length / 2);
      await runBatch(idx.slice(0, mid), sig);
      await runBatch(idx.slice(mid), sig);
    }
  };

  await pmap(batches, lanes(llm), (b, i, sig) => runBatch(b, sig), signal);
  return out.map((t, i) => (t == null ? segments[i].text : t));
}

function cleanLine(t) {
  return String(t || '').replace(/^\s*["«“]|["»”]\s*$/g, '').replace(/^\s*(translation|traduction)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
}

// =====================================================================================
// Résumé & points clés
// =====================================================================================
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    action_items: {
      type: 'array',
      items: { type: 'object', properties: { task: { type: 'string' }, owner: { type: 'string' } }, required: ['task', 'owner'] },
    },
    chapters: {
      type: 'array',
      items: { type: 'object', properties: { time: { type: 'string' }, title: { type: 'string' } }, required: ['time', 'title'] },
    },
  },
  required: ['title', 'summary', 'key_points', 'decisions', 'action_items', 'chapters'],
};

const LENGTHS = {
  short: { sentences: '2-3 sentences', points: '3 to 5', words: 80 },
  medium: { sentences: 'one solid paragraph (5-8 sentences)', points: '5 to 8', words: 180 },
  long: { sentences: 'two or three detailed paragraphs', points: '8 to 12', words: 400 },
};

function transcriptText(segments) {
  // paragraphes horodatés : [mm:ss] texte
  const lines = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.start - cur.end > 2 || cur.text.length > 500) {
      if (cur) lines.push(`[${fmtTime(cur.start)}] ${cur.text}`);
      cur = { start: s.start, end: s.end, text: s.text.trim() };
    } else { cur.text += ' ' + s.text.trim(); cur.end = s.end; }
  }
  if (cur) lines.push(`[${fmtTime(cur.start)}] ${cur.text}`);
  return lines;
}

function chunkLines(lines, maxChars) {
  const chunks = []; let cur = []; let len = 0;
  for (const l of lines) {
    if (cur.length && len + l.length > maxChars) { chunks.push(cur.join('\n')); cur = []; len = 0; }
    cur.push(l); len += l.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

function normalizeSummary(j) {
  const arr = (x) => (Array.isArray(x) ? x : []).filter(Boolean);
  return {
    title: String(j.title || '').trim(),
    summary: String(j.summary || '').trim(),
    key_points: arr(j.key_points).map(String).map((s) => s.trim()).filter(Boolean),
    decisions: arr(j.decisions).map(String).map((s) => s.trim()).filter(Boolean),
    action_items: arr(j.action_items).map((a) => (typeof a === 'string' ? { task: a, owner: '' } : { task: String(a.task || '').trim(), owner: String(a.owner || '').trim() })).filter((a) => a.task),
    chapters: arr(j.chapters).map((c) => ({ time: String(c.time || '').trim(), title: String(c.title || '').trim() })).filter((c) => c.title),
  };
}

/**
 * Résumé « map-reduce » : les longs enregistrements sont découpés, résumés par parties,
 * puis les résumés partiels sont fusionnés.
 */
async function summarize(llm, segments, outLang, { signal, onProgress, length = 'medium', chunkChars = 9000, title = '' } = {}) {
  const L = LENGTHS[length] || LENGTHS.medium;
  const langName = langLabel(outLang);
  const system = `You are an expert assistant who writes clear, faithful meeting/audio summaries. ` +
    `Always write in ${langName}, whatever the language of the transcript. Only use information present in the transcript; never invent facts, names or decisions. ` +
    'Leave a list empty when there is nothing relevant (for example no decision was made).';

  const lines = transcriptText(segments);
  if (!lines.length) throw new Error('La transcription est vide.');
  const chunks = chunkLines(lines, chunkChars);
  const steps = chunks.length > 1 ? chunks.length + 1 : 1;
  let step = 0;
  const report = (label) => onProgress && onProgress({ step, steps, ratio: step / steps, label });

  const ask = async (userText, maxTokens, sig = signal) => {
    check(sig);
    const r = await llm.complete({ system, user: userText, schema: SUMMARY_SCHEMA, maxTokens, signal: sig });
    const sum = normalizeSummary(parseJsonLoose(r));
    // champs repassés en anglais : retraduits
    if (outLang && outLang !== 'en') {
      const fix = async (t) => (englishRatio(t) > 0.12 ? fixLanguage(llm, t, outLang, sig) : t);
      [sum.title, sum.summary] = await Promise.all([fix(sum.title), fix(sum.summary)]);
      const lists = ['key_points', 'decisions'];
      for (const k of lists) if (sum[k].some((x) => englishRatio(x) > 0.12)) { const joined = await fixLanguage(llm, sum[k].join('\n\n'), outLang, sig); const arr = joined.split(/\n{2,}/); if (arr.length === sum[k].length) sum[k] = arr; }
    }
    return sum;
  };

  const instructions = (scope) =>
    `Return a JSON object with these fields, all written in ${langName}:\n` +
    `- "title": a short descriptive title for ${scope}\n` +
    `- "summary": ${L.sentences} summarizing ${scope}\n` +
    `- "key_points": ${L.points} key points (one short sentence each)\n` +
    '- "decisions": decisions that were clearly made (may be empty)\n' +
    '- "action_items": tasks or follow-ups mentioned, with "owner" = the person responsible if named, else ""\n' +
    '- "chapters": the main topics in chronological order, with "time" = the [mm:ss] timestamp where each topic starts';

  if (chunks.length === 1) {
    report('Analyse de la transcription…');
    const res = await ask(`${title ? `Recording title: ${title}\n` : ''}Transcript (timestamps in brackets):\n"""\n${chunks[0]}\n"""\n\n${instructions('the whole recording')}`, 2600);
    step = 1; report('Terminé');
    return res;
  }

  const P = lanes(llm);
  const partLabel = () => (P > 1 ? `Analyse des parties (${P} en parallèle) — ${step}/${chunks.length} terminées…` : `Analyse de la partie ${Math.min(step + 1, chunks.length)}/${chunks.length}…`);
  report(partLabel());
  const partials = await pmap(chunks, P, async (c, i, sig) => {
    const r = await ask(`This is part ${i + 1} of ${chunks.length} of a long transcript (timestamps in brackets):\n"""\n${c}\n"""\n\n${instructions('this part')}`, 2400, sig);
    step++; report(partLabel());
    return r;
  }, signal);
  // fusion (récursive si les résumés partiels sont eux-mêmes trop longs)
  let pool = partials;
  while (true) {
    report('Fusion des résumés…');
    const packed = pool.map((p, i) => `## Part ${i + 1}: ${p.title}\nSummary: ${p.summary}\nKey points:\n${p.key_points.map((k) => '- ' + k).join('\n')}\nDecisions:\n${p.decisions.map((k) => '- ' + k).join('\n')}\nActions:\n${p.action_items.map((a) => `- ${a.task}${a.owner ? ' (' + a.owner + ')' : ''}`).join('\n')}\nChapters:\n${p.chapters.map((c) => `- [${c.time}] ${c.title}`).join('\n')}`);
    let groups = chunkLines(packed, chunkChars);
    if (groups.length > 1 && groups.length >= pool.length) {
      // chaque résumé partiel dépasse à lui seul la taille d'un bloc : on tronque et on fusionne par paires
      const cap = Math.max(400, Math.floor(chunkChars / 2) - 50);
      const cut = packed.map((p) => (p.length > cap ? p.slice(0, cap) + '…' : p));
      groups = [];
      for (let i = 0; i < cut.length; i += 2) groups.push(cut.slice(i, i + 2).join('\n'));
    }
    if (groups.length === 1) {
      const res = await ask(`${title ? `Recording title: ${title}\n` : ''}Below are summaries of consecutive parts of one long recording. Merge them into a single coherent summary of the whole recording, removing duplicates.\n\n${groups[0]}\n\n${instructions('the whole recording')}`, 2600);
      step = steps; report('Terminé');
      return res;
    }
    const next = await pmap(groups, P, (g, i, sig) => ask(`Merge these partial summaries into one:\n\n${g}\n\n${instructions('these parts')}`, 2200, sig), signal);
    pool = next;
  }
}

function summaryToMarkdown(s, { title = '' } = {}, labels = {}) {
  const t = { summary: 'Résumé', key: 'Points clés', decisions: 'Décisions', actions: 'Actions à mener', chapters: 'Chapitres', ...labels };
  const out = [`# ${s.title || title || 'Résumé'}`, '', `## ${t.summary}`, '', s.summary, ''];
  if (s.key_points.length) out.push(`## ${t.key}`, '', ...s.key_points.map((k) => `- ${k}`), '');
  if (s.decisions.length) out.push(`## ${t.decisions}`, '', ...s.decisions.map((k) => `- ${k}`), '');
  if (s.action_items.length) out.push(`## ${t.actions}`, '', ...s.action_items.map((a) => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ''}`), '');
  if (s.chapters.length) out.push(`## ${t.chapters}`, '', ...s.chapters.map((c) => `- **${c.time}** ${c.title}`), '');
  return out.join('\n');
}

// =====================================================================================
// Transformation du texte (article, compte rendu, e-mail, fiche, quiz…)
// =====================================================================================
const FORMATS = {
  article: 'a well-structured blog article: a catchy title (as a level-1 heading), a short introduction, several sections with level-2 headings, and a conclusion. Engaging but faithful to the content.',
  meeting: 'formal meeting minutes: title, participants mentioned (if any), agenda, discussion summary for each topic (level-2 headings), decisions taken, action items as a checklist with owner and deadline when mentioned, next steps.',
  email: 'a recap e-mail ready to send: a subject line (translated "Subject:" label), greeting, short summary, key points as bullets, action items, polite closing. Concise and professional.',
  study: 'a study sheet for revision: main topic as title, key concepts with short definitions, important facts and figures, a "to remember" section, and 3 self-check questions at the end.',
  quiz: 'a quiz of 10 multiple-choice questions based only on the content. For each: the question (numbered), 4 options labelled A–D, then the correct answer and a one-sentence explanation.',
  thread: 'a social media thread (X/Twitter) of 5 to 10 numbered posts (1/, 2/…), each under 280 characters, with a strong hook in the first post. At most 2 hashtags, at the end.',
  notes: 'clean, structured notes: a title, then hierarchical bullet points grouped under short level-2 headings, keeping every important detail, name, number and date.',
  linkedin: 'a LinkedIn post: a hook line, 3–5 short paragraphs or bullets with the key insights, and a closing question to drive engagement.',
};

const fence = (t) => `<<<\n${t}\n>>>`;

// consignes de langue (titres et intitulés compris) : les petits modèles glissent vers l'anglais sinon
const LANG_HINT = {
  fr: 'Tous les titres, intertitres et intitulés doivent être en français (par exemple « ## Notions clés », « ## À retenir », « ## Questions pour s’entraîner », « Réponse : »).',
};
const langReminder = (code, name) => `IMPORTANT: write the whole document in ${name} only — title, headings, labels, lists and content. ${LANG_HINT[code] || ''}`;

/** Part de mots-outils anglais dans un texte (0 à 1). */
function englishRatio(t) {
  const ws = String(t).toLowerCase().match(/[a-z\u00e0-\u00ff']+/g) || [];
  if (ws.length < 8) return 0;
  return ws.filter((w) => EN_WORDS.has(w)).length / ws.length;
}
/**
 * Passages repassés en anglais par le modèle : retraduits dans la bonne langue (le reste n'est pas touché).
 * Le texte est découpé en blocs (paragraphes, titres, listes) ; seuls les blocs anglais sont traduits.
 */
async function fixLanguage(llm, text, code, signal) {
  if (!text || !code || code === 'en') return text;
  const name = langLabel(code);
  const blocks = String(text).split(/\n{2,}/);
  const FR = /\b(le|la|les|des|du|de|et|à|un|une|pour|en|est|sont|au|aux)\b/i;
  const EN_HEAD = /\b(key|points?|summary|questions?|answers?|notes?|remember|concepts?|definitions?|takeaways?|review|correct|explanation|to|the|and|of)\b/i;
  // bloc court (titre, intitulé) : anglais s'il contient des mots anglais et aucun mot-outil français
  const isEnglish = (b) => englishRatio(b) > 0.12 || (b.split(/\s+/).length < 12 && EN_HEAD.test(b) && !FR.test(b.replace(/^#+\s*/, '')));
  const bad = blocks.map((b, i) => (isEnglish(b) ? i : -1)).filter((i) => i >= 0);
  if (!bad.length) return text;
  // blocs anglais consécutifs traduits ensemble (moins d'appels)
  const groups = [];
  for (const i of bad) { const g = groups[groups.length - 1]; if (g && g[g.length - 1] === i - 1 && g.reduce((a, k) => a + blocks[k].length, 0) < 2500) g.push(i); else groups.push([i]); }
  await pmap(groups, lanes(llm), async (g, gi, sig) => {
    check(sig);
    const src = g.map((i) => blocks[i]).join('\n\n');
    try {
      const tr = await llm.complete({
        system: `You are a professional translator. Translate into ${name}. Keep the Markdown formatting exactly (headings, lists, bold, numbering). Output only the translation.`,
        user: `Translate into ${name}:\n\n${src}`,
        maxTokens: Math.min(2000, 80 + Math.round(src.length * 0.7)), temperature: 0.1, signal: sig,
      });
      const parts = String(tr || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim().split(/\n{2,}/);
      if (parts.length === g.length) g.forEach((i, k) => { blocks[i] = parts[k]; });
      else { blocks[g[0]] = parts.join('\n\n'); g.slice(1).forEach((i) => { blocks[i] = null; }); }
    } catch (e) { if (e.name === 'AbortError' || (sig && sig.aborted)) throw new Cancelled(); if (e.stalled) throw e; /* sinon : on garde le bloc tel quel */ }
  }, signal);
  return blocks.filter((b) => b != null).join('\n\n');
}

/** Extraction de notes détaillées par morceau, pour les longs enregistrements. */
async function extractNotes(llm, text, langName, signal, label) {
  check(signal);
  return llm.complete({
    system: 'You extract detailed, faithful notes from transcripts. Never invent anything.',
    user: `Extract detailed notes from this ${label} of a transcript (between <<< and >>>), in ${langName}: every topic, fact, name, number, date, decision, task and notable quote, as bullet points. Keep the [mm:ss] timestamps of topic changes.\n${fence(text)}`,
    maxTokens: 1800, signal,
  });
}

/**
 * @param parts [{ title, segments }] — un seul élément pour une transcription, plusieurs pour un projet
 */
async function transform(llm, parts, format, outLang, { signal, onProgress, onToken, custom = '', chunkChars = 9000 } = {}) {
  const langName = langLabel(outLang);
  const goal = format === 'custom' ? `the following, as requested by the user: ${custom}` : (FORMATS[format] || FORMATS.notes);
  const blocks = parts.map((p, i) => ({ title: p.title || `Part ${i + 1}`, text: transcriptText(p.segments).join('\n') })).filter((b) => b.text);
  if (!blocks.length) throw new Error('La transcription est vide.');
  const total = blocks.reduce((a, b) => a + b.text.length, 0);
  let material;
  if (total <= chunkChars) {
    material = blocks.map((b) => (blocks.length > 1 ? `## ${b.title}\n${b.text}` : b.text)).join('\n\n');
  } else {
    // trop long pour une seule passe : notes intermédiaires par morceau
    const jobs = [];
    for (const b of blocks) chunkLines(b.text.split('\n'), chunkChars).forEach((c, i, arr) => jobs.push({ title: b.title, text: c, label: arr.length > 1 ? `part ${i + 1}/${arr.length}` : 'recording' }));
    const P = lanes(llm); let doneN = 0;
    const lab = () => (P > 1 ? `Lecture des parties (${P} en parallèle) — ${doneN}/${jobs.length} terminées…` : `Lecture de la partie ${Math.min(doneN + 1, jobs.length)}/${jobs.length}…`);
    onProgress && onProgress({ ratio: 0, label: lab() });
    const notes = await pmap(jobs, P, async (j, i, sig) => {
      const n = `## ${j.title}${j.label.startsWith('part') ? ' (' + j.label + ')' : ''}\n` + await extractNotes(llm, j.text, langName, sig, j.label);
      doneN++; onProgress && onProgress({ ratio: doneN / (jobs.length + 1), label: lab() });
      return n;
    }, signal);
    material = notes.join('\n\n');
    if (material.length > chunkChars * 1.6) material = material.slice(0, Math.round(chunkChars * 1.6)); // garde-fou contexte
  }
  onProgress && onProgress({ ratio: total <= chunkChars ? 0.05 : 0.9, label: 'Rédaction…' });
  check(signal);
  const out = await llm.complete({
    system: `You are an expert writer. Always write in ${langName}, in clean Markdown. Use only information from the provided material; never invent facts, names or numbers.`,
    user: `Using the ${total <= chunkChars ? 'transcript' : 'notes taken from a transcript'} below (between <<< and >>>)${blocks.length > 1 ? `, which covers ${blocks.length} recordings of the same project,` : ''} write ${goal}\nWrite everything in ${langName}. Output only the final document.\n\n${fence(material)}\n\n${langReminder(outLang, langName)}`,
    maxTokens: 2500, temperature: 0.3, signal, onToken,
  });
  const doc = String(out || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // passages repassés en anglais : retraduits
  onProgress && onProgress({ ratio: 0.97, label: 'Vérification de la langue…' });
  return fixLanguage(llm, doc, outLang, signal);
}

/** Résumé global de plusieurs transcriptions (projet). Réutilise les résumés existants s'ils sont fournis. */
async function summarizeMany(llm, parts, outLang, opts = {}) {
  const { signal, onProgress, length = 'medium' } = opts;
  let doneN = 0;
  onProgress && onProgress({ ratio: 0, label: `Résumé des enregistrements (0/${parts.length})…` });
  const partial = await pmap(parts, lanes(llm), async (p, i, sig) => {
    check(sig);
    const r = p.existing ? normalizeSummary(p.existing) : await summarize(llm, p.segments, outLang, { ...opts, signal: sig, onProgress: null, title: p.title, length: 'short' });
    doneN++; onProgress && onProgress({ ratio: doneN / (parts.length + 1), label: `Résumé des enregistrements (${doneN}/${parts.length})…` });
    return r;
  }, signal);
  if (parts.length === 1) return partial[0];
  onProgress && onProgress({ ratio: parts.length / (parts.length + 1), label: 'Synthèse globale…' });
  const L = LENGTHS[length] || LENGTHS.medium;
  const langName = langLabel(outLang);
  const packed = partial.map((p, i) => `## Recording ${i + 1}: ${parts[i].title}\nSummary: ${p.summary}\nKey points:\n${p.key_points.map((k) => '- ' + k).join('\n')}\nDecisions:\n${p.decisions.map((k) => '- ' + k).join('\n')}\nActions:\n${p.action_items.map((a) => `- ${a.task}${a.owner ? ' (' + a.owner + ')' : ''}`).join('\n')}`).join('\n\n');
  const r = await llm.complete({
    system: `You write clear, faithful syntheses. Always write in ${langName}. Never invent facts.`,
    user: `Here are the summaries of ${parts.length} recordings belonging to the same project. Write a global synthesis as a JSON object, all in ${langName}:\n` +
      `- "title": a title for the whole project\n- "summary": ${L.sentences} covering the whole project and how the recordings relate\n- "key_points": ${L.points} key points across all recordings\n` +
      '- "decisions": all decisions (may be empty)\n- "action_items": all tasks with "owner" if named, else ""\n' +
      `- "chapters": exactly one entry per recording, in order, with "time" = "#1", "#2"… and "title" = one sentence describing that recording\n\n${packed.slice(0, 24000)}`,
    schema: SUMMARY_SCHEMA, maxTokens: 2200, signal,
  });
  return normalizeSummary(parseJsonLoose(r));
}

// =====================================================================================
// Nettoyage du texte (hésitations, répétitions, erreurs de reconnaissance)
// =====================================================================================
/**
 * Réécrit chaque segment en gardant l'alignement 1:1 (les horodatages restent valides).
 * @param opts.fillers  supprimer « euh », répétitions, faux départs
 * @param opts.fix      corriger les erreurs de reconnaissance évidentes d'après le contexte
 * @param opts.punct    corriger ponctuation et majuscules
 * @param opts.glossary orthographes à respecter (noms propres, jargon)
 */
// mots outils anglais : s'ils apparaissent dans une ligne « corrigée » d'un texte non anglais, le modèle a traduit
const EN_WORDS = new Set('the and of is are was were this that which with from for to in it be by at not have has had will would can could should they their there what when where who how'.split(' '));
const enCount = (t) => (String(t).toLowerCase().match(/[a-z']+/g) || []).filter((w) => EN_WORDS.has(w)).length;
/** Garde-fou : la ligne corrigée est refusée si elle a glissé vers l'anglais ou réécrit trop de mots. */
function acceptCleaned(orig, cleaned, lang) {
  if (!cleaned || cleaned.length < orig.length * 0.25) return false;
  if (lang && lang !== 'en' && enCount(cleaned) > enCount(orig)) return false;
  const words = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  const a = new Set(words(orig)); const b = words(cleaned);
  if (b.length >= 6) { const kept = b.filter((w) => a.has(w)).length; if (kept / b.length < 0.6) return false; } // plus de 40 % de mots nouveaux : réécriture
  return true;
}

async function cleanSegments(llm, segments, { signal, onProgress, fillers = true, fix = true, punct = true, glossary = [], batchChars = 3000, batchMax = 30, lang = '' } = {}) {
  const rules = [];
  if (fillers) rules.push('remove hesitations and filler words (euh, heu, bah, ben, hein, um, uh, er, like…), stutters, word repetitions and false starts');
  if (fix) rules.push('fix obvious speech-recognition mistakes using the context (wrong homophones, misheard words), but never change the meaning and never invent content');
  if (punct) rules.push('fix punctuation, capitalization and spacing');
  const gl = glossary.filter(Boolean).slice(0, 80);
  const langName = lang ? langLabel(lang) : '';
  const system = 'You are a meticulous transcript editor. You clean spoken transcripts while keeping the speaker\'s words, language, meaning and style. ' +
    (langName ? `The transcript is in ${langName}: every output line MUST be written in ${langName}, never in English or any other language. ` : '') +
    'Each line MUST stay in its original language (never translate). Keep the same number of lines in the same order. If a line needs no change, return it unchanged.' +
    (gl.length ? ` Always use these exact spellings when the words appear: ${gl.join(', ')}.` : '');
  const out = new Array(segments.length).fill(null);
  const idx = segments.map((s, i) => i).filter((i) => (segments[i].text || '').trim());
  segments.forEach((s, i) => { if (!(s.text || '').trim()) out[i] = s.text || ''; });
  const batches = []; let cur = []; let len = 0;
  for (const i of idx) {
    const l = segments[i].text.length;
    if (cur.length && (len + l > batchChars || cur.length >= batchMax)) { batches.push(cur); cur = []; len = 0; }
    cur.push(i); len += l;
  }
  if (cur.length) batches.push(cur);
  let done = 0;
  const total = idx.length;
  const report = () => onProgress && onProgress({ done, total, ratio: total ? done / total : 1, partial: out });
  report();
  const run = async (ids, sig = signal) => {
    check(sig);
    const lines = ids.map((i) => segments[i].text.trim());
    if (ids.length === 1) {
      const r = await llm.complete({ system, user: `Clean this transcript line (${rules.join('; ')}). Reply with the cleaned line only.\n\n${lines[0]}`, maxTokens: Math.min(1024, 64 + lines[0].length * 2), signal: sig });
      const t = cleanLine(r);
      out[ids[0]] = acceptCleaned(lines[0], t, lang) ? t : lines[0];
      done++; report(); return;
    }
    // le modèle ne renvoie que des remplacements ciblés (« trouver → remplacer ») et pas des lignes entières :
    // une transcription déjà propre ne coûte presque rien à générer, une correction ne coûte que quelques mots
    const schema = {
      type: 'object',
      properties: { edits: { type: 'array', maxItems: lines.length * 3, items: { type: 'object', properties: { line: { type: 'integer' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['line', 'find', 'replace'] } } },
      required: ['edits'],
    };
    let ok = false;
    try {
      const r = await llm.complete({
        system,
        user: `Here are ${lines.length} numbered transcript lines. Task: ${rules.join('; ')}.\n` +
          'Return a JSON object {"edits": [{"line": <number>, "find": "<exact text copied from that line>", "replace": "<new text>"}]}. ' +
          'Each edit replaces a SHORT exact piece of a line (a few words at most); use "replace": "" to delete words. ' +
          'Only list real changes: never an edit whose replace equals find. Return {"edits": []} if every line is already fine.\n\n' +
          lines.map((l, k) => `${k + 1}. ${l}`).join('\n'),
        schema, maxTokens: Math.min(2500, 200 + lines.length * 40), signal: sig,
      });
      const j = parseJsonLoose(r);
      const eds = Array.isArray(j) ? j : j.edits;
      if (Array.isArray(eds)) {
        const cur = lines.slice();
        for (const e of eds) {
          const k = Number(e && e.line) - 1;
          if (!Number.isInteger(k) || k < 0 || k >= lines.length || typeof e.find !== 'string' || typeof e.replace !== 'string') continue;
          const find = e.find; if (!find || find === e.replace || find.length > 200) continue;
          const at = cur[k].indexOf(find); if (at < 0) continue; // texte introuvable : ignoré (jamais de correction « à peu près »)
          const next = (cur[k].slice(0, at) + e.replace + cur[k].slice(at + find.length)).replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
          // chaque remplacement est vérifié seul : un mauvais (anglais, réécriture) n'annule pas les bons
          if (acceptCleaned(lines[k], next, lang)) cur[k] = next;
        }
        ids.forEach((id, k) => {
          const t = cleanLine(cur[k]);
          // garde-fou : ligne vidée, passée en anglais ou réécrite : on garde l'originale
          out[id] = t !== lines[k] && acceptCleaned(lines[k], t, lang) ? t : lines[k];
        });
        done += ids.length; report(); ok = true;
      }
    } catch (e) { if (e.name === 'AbortError' || (sig && sig.aborted)) throw new Cancelled(); if (e.stalled) throw e; }
    if (!ok) { const mid = Math.ceil(ids.length / 2); await run(ids.slice(0, mid), sig); await run(ids.slice(mid), sig); }
  };
  await pmap(batches, lanes(llm), (b, i, sig) => run(b, sig), signal);
  return out.map((t, i) => (t == null ? segments[i].text : t));
}

/**
 * Questions sur les cours : réponse rédigée UNIQUEMENT à partir des passages retrouvés,
 * avec renvois [1], [2]… vers les sources (cliquables dans l'interface).
 * @param passages [{ title, time, text }]
 */
async function answerQuestion(llm, question, passages, outLang, { signal, onToken, maxChars = 12000, vocabulary = [] } = {}) {
  const langName = langLabel(outLang);
  const q = String(question || '').trim();
  if (!q) throw new Error('Posez une question.');
  if (!passages || !passages.length) throw new Error('Aucun passage de vos cours ne correspond à cette question.');
  // autant de passages que le contexte du modèle le permet (les plus pertinents d'abord)
  const blocks = []; let used = 0;
  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    const b = `[${i + 1}] « ${p.title} » — ${p.time}\n${String(p.text).trim()}`;
    if (used + b.length > maxChars && blocks.length) break;
    blocks.push(b); used += b.length;
  }
  check(signal);
  const glossary = vocabulary.length ? `\nCorrect spellings of names and terms used in these courses: ${vocabulary.slice(0, 80).join(', ')}.` : '';
  const out = await llm.complete({
    system: `You are a helpful study assistant. Answer in ${langName}, clearly and precisely, using ONLY the course excerpts provided. ` +
      'After each sentence that uses an excerpt, cite it with its number in square brackets, like [1] or [2][3]. ' +
      'If the excerpts do not contain the answer, say so plainly in one sentence instead of guessing.' + glossary,
    user: `Course excerpts:\n\n${blocks.join('\n\n')}\n\nQuestion: ${q}\n\nAnswer in ${langName}, citing the excerpts by number.`,
    maxTokens: 900, temperature: 0.2, signal, onToken,
  });
  return { text: await fixLanguage(llm, String(out || '').trim(), outLang, signal), used: blocks.length };
}

module.exports = {
  pmap, answerQuestion, cleanSegments, transform, summarizeMany, FORMATS, translateSegments, summarize, summaryToMarkdown, parseJsonLoose, transcriptText, chunkLines, LANG_EN, langLabel, SUMMARY_SCHEMA };
