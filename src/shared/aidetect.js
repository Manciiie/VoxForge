/**
 * VoxForge — origine d'un texte : écrit par une personne, généré ou retouché par une IA ?
 *
 * Deux familles d'indices, combinées en un score de 0 (humain) à 100 (IA) :
 *  1. Indices de style, calculés ici sans modèle (instantané) : régularité des phrases, tournures et
 *     connecteurs typiques des assistants, mise en forme « réponse de chatbot », absence de marques d'oralité…
 *  2. Prévisibilité mesurée par le modèle IA local (facultatif, voir providers.js → predictability) :
 *     un texte généré par une IA est composé de mots que le modèle « devine » bien plus souvent qu'un texte humain.
 *
 * Aucun détecteur n'est fiable à 100 % : le résultat est un indice, jamais une preuve.
 * Utilisable côté moteur (Node) et côté interface (navigateur).
 */
(function (root) {
  'use strict';

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

  // Tournures typiques des assistants (français et anglais), en minuscules (comparées sans accents).
  // Poids : 1 = fréquente chez les humains aussi, 3 = très rare hors texte généré.
  const PHRASES = [
    ['il est important de noter', 3], ['il convient de noter', 2], ['il est essentiel de', 2], ['il est crucial de', 3], ['joue un rôle crucial', 3], ['joue un rôle essentiel', 2],
    ['dans un monde en constante evolution', 3], ['dans le monde d\'aujourd\'hui', 2], ['à l\'ère du numérique', 2], ['en conclusion', 1], ['en somme', 1], ['en résumé', 1], ['pour conclure', 1],
    ['n\'hésitez pas à', 3], ['j\'espère que cela', 3], ['j\'espère que ces', 3], ['bien sûr !', 3], ['certainement !', 3], ['absolument !', 3], ['voici un', 1], ['voici une', 1], ['voici quelques', 2], ['voici les', 1],
    ['plongeons', 3], ['explorons', 2], ['découvrons', 1], ['il est à noter que', 2], ['force est de constater', 1], ['à cet égard', 1], ['en effet,', 1], ['en d\'autres termes', 1],
    ['approche holistique', 3], ['un ecosysteme', 1], ['un paysage', 1], ['naviguer dans', 2], ['témoigne de', 1], ['une véritable', 1], ['sans précédent', 2], ['incontournable', 1], ['un large eventail', 2], ['une multitude de', 2], ['un eventail de', 2],
    ['favoriser', 1], ['optimiser', 1], ['renforcer', 1], ['mettre en lumière', 2], ['souligner l\'importance', 2], ['à bien des égards', 2], ['il est indéniable', 2], ['il ne fait aucun doute', 2], ['en fin de compte', 1],
    ['points clés', 2], ['à retenir', 1], ['en tant qu\'ia', 3], ['en tant que modele de langage', 3], ['je ne peux pas', 1], ['je suis là pour', 3],
    // anglais
    ['it is important to note', 3], ['it\'s important to note', 3], ['it is worth noting', 2], ['in conclusion', 1], ['in summary', 1], ['delve into', 3], ['delves into', 3], ['a tapestry', 3], ['rich tapestry', 3], ['testament to', 2], ['in today\'s fast-paced', 3], ['ever-evolving', 3], ['navigate the', 2], ['landscape of', 2], ['plays a crucial role', 3], ['plays a vital role', 2], ['i hope this helps', 3], ['feel free to', 2], ['certainly!', 3], ['absolutely!', 2], ['as an ai', 3], ['as a language model', 3], ['here is a', 1], ['here are some', 2], ['let\'s dive', 3], ['let\'s explore', 2], ['ultimately,', 1], ['moreover,', 1], ['furthermore,', 1], ['additionally,', 1], ['vibrant', 1], ['robust', 1], ['seamless', 2], ['leverage', 2], ['comprehensive', 1], ['key takeaways', 2], ['unlock', 1], ['elevate', 1], ['game-changer', 3],
  ];
  // connecteurs en tête de phrase : les assistants en mettent presque partout
  const CONNECTORS = /^(de plus|en outre|par ailleurs|cependant|toutefois|neanmoins|ainsi|enfin|tout d'abord|d'abord|ensuite|en effet|en conclusion|en somme|en resume|pour conclure|par consequent|en revanche|d'une part|d'autre part|premierement|deuxiemement|troisiemement|finalement|egalement|notamment|moreover|furthermore|additionally|however|therefore|finally|first|firstly|secondly|thirdly|in conclusion|overall|ultimately|consequently|nevertheless|nonetheless|in addition|on the other hand)\b[,:]?/;
  // marques d'oralité / d'écriture spontanée (rares chez une IA)
  const HUMAN = [/\b(euh|heu|bah|ben|hein|bref|bon,|voila|ouais|ok|mdr|lol|ptdr|pcq|parce qu|jsp|tkt|svp|stp|genre,|du coup|en vrai|franchement|carrement|trop bien|j'avoue|chui|j'suis|t'es|t'as|y a|y'a|ya pas|c'est pas|je sais pas|j'sais pas|faut que|faut pas)\b/g, /\.{3}(?!\.)/g, /!{2,}|\?{2,}|\?!|!\?/g, /\b[a-z]+ [a-z]+ \1 /g];

  function sentences(text) {
    return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+(?=[\p{Lu}«"(\d])/u).map((s) => s.trim()).filter((s) => s.length > 1);
  }
  const words = (t) => String(t || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];

  /** Indices de style d'un bloc de texte. Retourne des mesures brutes, pas encore de score. */
  function measure(text) {
    const sents = sentences(text);
    const lens = sents.map((s) => words(s).length).filter((n) => n > 0);
    const ws = words(text);
    const n = ws.length;
    const lower = norm(text);
    const m = { words: n, sentences: lens.length, avgLen: mean(lens), cv: lens.length >= 3 ? stdev(lens) / Math.max(1, mean(lens)) : null };
    // tournures d'assistant
    let phr = 0; const found = new Map();
    for (const [p, w] of PHRASES) { const key = norm(p); let i = -1; let c = 0; while ((i = lower.indexOf(key, i + 1)) >= 0) c++; if (c) { phr += c * w; found.set(p, (found.get(p) || 0) + c); } }
    m.phrases = phr; m.phraseHits = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, c]) => ({ phrase: p, count: c }));
    // connecteurs en tête de phrase
    m.connectors = lens.length ? sents.filter((s) => CONNECTORS.test(norm(s))).length / lens.length : 0;
    // mise en forme « chatbot » : titres Markdown, gras, puces avec intitulé en gras, tirets cadratins, émojis, deux-points d'annonce
    const lines = String(text || '').split('\n');
    m.md = lines.filter((l) => /^\s*(#{1,6}\s|[-*•]\s+\*\*|\d+[.)]\s+\*\*)/.test(l)).length + (text.match(/\*\*[^*\n]{2,80}\*\*/g) || []).length;
    m.emdash = (text.match(/\s—\s|—/g) || []).length;
    m.emoji = (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}]/gu) || []).length;
    m.bullets = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
    // triades « X, Y et Z » (rythme ternaire cher aux assistants)
    m.triads = (text.match(/\b[\p{L}'’-]+, [\p{L}'’-]+ (et|and|ou|or) [\p{L}'’-]+\b/gu) || []).length;
    // marques humaines : oralité, points de suspension, ponctuation expressive, mots doublés ; majuscules non accentuées (Etat, Ecole)
    let hum = 0; for (const re of HUMAN) { re.lastIndex = 0; hum += (lower.match(re) || []).length; }
    hum += (text.match(/\b(Etat|Ecole|Eglise|Egalite|Etude|Element|Epoque|Evolution|Economie|Etre)\b/g) || []).length;
    m.human = hum;
    // richesse lexicale sur une fenêtre fixe (comparable d'un texte à l'autre)
    const win = ws.slice(0, 250).map((w) => norm(w));
    m.ttr = win.length >= 60 ? new Set(win).size / win.length : null;
    // phrases qui se terminent par « : » puis liste, ou qui commencent par un verbe à l'impératif / une question rhétorique
    m.rhetoric = sents.filter((s) => /\?$/.test(s)).length;
    return m;
  }

  /**
   * Score de style 0–100 à partir des mesures. Chaque indice renvoie une contribution signée
   * (positif = IA, négatif = humain) et une explication en français.
   */
  function scoreStyle(m) {
    const per1k = (x) => (m.words ? (x / m.words) * 1000 : 0);
    const signals = [];
    let s = 50; // a priori : on ne sait pas
    const add = (delta, label, detail) => { if (Math.abs(delta) < 0.5) return; s += delta; signals.push({ delta: Math.round(delta), label, detail }); };
    if (m.cv != null) {
      // phrases très régulières (coefficient de variation < 0,35) : IA ; très irrégulières (> 0,65) : humain
      if (m.cv < 0.3) add(14, 'Phrases de longueur très régulière', `variation de ${Math.round(m.cv * 100)} % autour de ${Math.round(m.avgLen)} mots`);
      else if (m.cv < 0.42) add(7, 'Phrases de longueur assez régulière', `variation de ${Math.round(m.cv * 100)} %`);
      else if (m.cv > 0.7) add(-12, 'Rythme irrégulier (phrases courtes et longues mêlées)', `variation de ${Math.round(m.cv * 100)} %`);
      else if (m.cv > 0.55) add(-5, 'Rythme plutôt varié', `variation de ${Math.round(m.cv * 100)} %`);
    }
    const ph = per1k(m.phrases);
    if (ph >= 12) add(22, 'Nombreuses tournures d’assistant IA', m.phraseHits.map((h) => `« ${h.phrase} »${h.count > 1 ? ' ×' + h.count : ''}`).join(', '));
    else if (ph >= 5) add(12, 'Quelques tournures typiques d’une IA', m.phraseHits.map((h) => `« ${h.phrase} »`).join(', '));
    else if (ph >= 2) add(5, 'Une ou deux tournures typiques d’une IA', m.phraseHits.map((h) => `« ${h.phrase} »`).join(', '));
    if (m.sentences >= 5) {
      if (m.connectors >= 0.35) add(14, 'Connecteurs logiques en tête de presque chaque phrase', `${Math.round(m.connectors * 100)} % des phrases (De plus, En outre, Cependant…)`);
      else if (m.connectors >= 0.2) add(7, 'Connecteurs logiques fréquents en tête de phrase', `${Math.round(m.connectors * 100)} % des phrases`);
    }
    const md = per1k(m.md);
    if (md >= 8) add(14, 'Mise en forme de réponse d’assistant', 'titres, gras ou puces avec intitulé en gras');
    else if (md >= 2) add(6, 'Un peu de mise en forme Markdown', 'gras ou titres');
    const dash = per1k(m.emdash);
    if (dash >= 6) add(10, 'Tirets cadratins (—) très fréquents', `${m.emdash} dans le texte`);
    else if (dash >= 2) add(4, 'Quelques tirets cadratins (—)', `${m.emdash} dans le texte`);
    if (m.emoji >= 3) add(8, 'Émojis en ponctuation ou en tête de liste', `${m.emoji} émojis`);
    const tri = per1k(m.triads);
    if (tri >= 10) add(8, 'Rythme ternaire systématique (« X, Y et Z »)', `${m.triads} triades`);
    else if (tri >= 5) add(4, 'Rythme ternaire fréquent', `${m.triads} triades`);
    const hum = per1k(m.human);
    if (hum >= 8) add(-18, 'Marques d’écriture spontanée', 'oralité, points de suspension, ponctuation expressive, majuscules non accentuées');
    else if (hum >= 3) add(-9, 'Quelques marques d’écriture spontanée', 'oralité ou ponctuation expressive');
    else if (m.words >= 200 && hum === 0) add(5, 'Aucune marque d’oralité ni d’hésitation', 'texte parfaitement lisse');
    if (m.ttr != null) {
      if (m.ttr >= 0.72) add(4, 'Vocabulaire très varié, sans répétition', `${Math.round(m.ttr * 100)} % de mots différents sur 250 mots`);
      else if (m.ttr <= 0.48) add(-6, 'Mots souvent répétés', `${Math.round(m.ttr * 100)} % de mots différents sur 250 mots`);
    }
    if (m.sentences >= 4 && m.avgLen >= 17 && m.avgLen <= 26 && m.cv != null && m.cv < 0.45) add(4, 'Phrases « moyennes » typiques (17 à 26 mots)', `${Math.round(m.avgLen)} mots en moyenne`);
    return { score: Math.round(clamp(s, 0, 100)), signals: signals.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)) };
  }

  /**
   * Score de prévisibilité 0–100 à partir des mesures du modèle local :
   *  - top1 : part des mots que le modèle avait placés en premier choix (IA ≈ 0,55 à 0,8 ; humain ≈ 0,3 à 0,45)
   *  - gap  : écart moyen (en logits) entre le mot réel et le premier choix du modèle (IA ≈ < 1,5 ; humain ≈ > 2,5)
   *  - burst : variation de cet écart d'une phrase à l'autre (faible chez une IA)
   * Les seuils correspondent à des modèles de 3 à 12 milliards de paramètres sur du français ou de l'anglais.
   */
  function scoreModel(p, calib) {
    if (!p || !p.tokens) return null;
    // repères : « IA » = texte écrit par le modèle lui-même sur ce PC (étalonnage), « humain » = décalage fixe en dessous
    const aiTop1 = calib && calib.top1 ? clamp(calib.top1, 0.45, 0.9) : 0.68;
    const aiGap = calib && calib.gap ? clamp(calib.gap, 0.6, 2.2) : 1.2;
    const huTop1 = aiTop1 - 0.26; const huGap = aiGap + 1.6;
    const t1 = clamp((p.top1 - huTop1) / (aiTop1 - huTop1));
    const g = clamp((huGap - p.gap) / (huGap - aiGap));
    const b = p.burst == null ? 0.5 : clamp((0.9 - p.burst) / (0.9 - 0.3));
    const score = Math.round(100 * (0.5 * t1 + 0.35 * g + 0.15 * b));
    const signals = [];
    signals.push({ delta: Math.round((t1 - 0.5) * 40), label: `${Math.round(p.top1 * 100)} % des mots devinés du premier coup par le modèle`, detail: t1 >= 0.7 ? `très prévisible (un texte du modèle lui-même : ${Math.round(aiTop1 * 100)} %)` : t1 <= 0.3 ? 'peu prévisible, typique d’une écriture humaine' : 'zone intermédiaire' });
    signals.push({ delta: Math.round((g - 0.5) * 30), label: `Écart moyen au premier choix du modèle : ${p.gap.toFixed(2)}`, detail: g >= 0.7 ? 'les mots réels sont presque toujours ceux attendus' : g <= 0.3 ? 'le texte surprend souvent le modèle' : 'zone intermédiaire' });
    if (p.burst != null) signals.push({ delta: Math.round((b - 0.5) * 14), label: `Surprise ${p.burst < 0.4 ? 'uniforme' : p.burst > 0.8 ? 'très irrégulière' : 'variable'} d’une phrase à l’autre`, detail: `variation de ${Math.round(p.burst * 100)} %` });
    return { score, signals: signals.filter((x) => x.delta !== 0), calibrated: !!(calib && calib.top1) };
  }

  /**
   * Analyse complète d'un document découpé en paragraphes.
   * @param {string[]} paragraphs
   * @param {{ paragraphs?: ({top1:number,gap:number,burst?:number,tokens:number}|null)[], top1:number, gap:number, burst?:number, tokens:number }} [model] mesures du modèle (facultatif)
   * @param {{top1:number,gap:number}} [calib] étalonnage du modèle (texte écrit par le modèle lui-même)
   */
  function analyze(paragraphs, model, calib) {
    const paras = (paragraphs || []).map((t) => String(t || '').trim()).filter(Boolean);
    const full = paras.join('\n\n');
    const m = measure(full);
    const style = scoreStyle(m);
    const mdl = model ? scoreModel(model, calib) : null;
    // combinaison : le modèle pèse plus que le style quand il est disponible
    let score = style.score;
    if (mdl) score = Math.round(0.4 * style.score + 0.6 * mdl.score);
    // confiance : longueur du texte
    const confidence = m.words < 60 ? 'none' : m.words < 150 ? 'low' : m.words < 400 ? 'medium' : 'high';
    // par paragraphe (mélange humain / IA)
    const perPara = paras.map((t, i) => {
      const pm = measure(t);
      const ps = scoreStyle(pm);
      const pmod = model && model.paragraphs && model.paragraphs[i] ? scoreModel(model.paragraphs[i], calib) : null;
      let sc = ps.score;
      if (pmod) sc = Math.round(0.4 * ps.score + 0.6 * pmod.score);
      return { index: i, words: pm.words, score: sc, style: ps.score, model: pmod ? pmod.score : null, reliable: pm.words >= 40 };
    });
    const rel = perPara.filter((p) => p.reliable);
    const ai = rel.filter((p) => p.score >= 65); const human = rel.filter((p) => p.score <= 40);
    const mixed = rel.length >= 3 && ai.length >= 1 && human.length >= 1 && ai.length < rel.length;
    let verdict;
    if (confidence === 'none') verdict = { kind: 'short', label: 'Texte trop court pour se prononcer', hint: 'Au moins 60 mots sont nécessaires ; 400 ou plus pour un indice solide.' };
    else if (mixed && (ai.reduce((a, p) => a + p.words, 0) / Math.max(1, rel.reduce((a, p) => a + p.words, 0))) >= 0.15) verdict = { kind: 'mixed', label: 'Mélange probable : certains passages ressemblent à une IA', hint: `${ai.length} passage${ai.length > 1 ? 's' : ''} sur ${rel.length} présentent des traits d’IA (texte retouché ou complété ?).` };
    else if (score >= 72) verdict = { kind: 'ai', label: 'Probablement généré par une IA', hint: 'Plusieurs traits caractéristiques d’un texte produit par un assistant.' };
    else if (score >= 58) verdict = { kind: 'likely-ai', label: 'Traits d’IA assez marqués', hint: 'Peut aussi être un texte humain très formaté (rapport, cours, fiche).' };
    else if (score >= 42) verdict = { kind: 'unsure', label: 'Indécis', hint: 'Le texte ne penche clairement d’aucun côté.' };
    else if (score >= 28) verdict = { kind: 'likely-human', label: 'Plutôt écrit par une personne', hint: 'Peu de traits d’IA relevés.' };
    else verdict = { kind: 'human', label: 'Probablement écrit par une personne', hint: 'Rythme et tournures caractéristiques d’une écriture humaine.' };
    return { score, confidence, verdict, style, model: mdl, paragraphs: perPara, words: m.words, sentences: m.sentences, mixed };
  }

  const api = { analyze, measure, scoreStyle, scoreModel, sentences };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoxAiDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
