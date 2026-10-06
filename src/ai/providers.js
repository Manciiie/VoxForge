'use strict';
/**
 * Moteurs de langage :
 *  - LocalLLM : modèle GGUF exécuté sur le PC (node-llama-cpp, CPU ou carte graphique via Vulkan)
 *  - OpenAICompatible : LM Studio, Ollama, ou tout service compatible avec l'API OpenAI
 */

class LocalLLM {
  constructor({ modelPath, gpu = 'auto', threads = 0, contextSize = 8192, parallel = 0 }) {
    this.modelPath = modelPath; this.gpu = gpu; this.threads = threads; this.contextSize = contextSize;
    this.maxParallel = parallel; // 0 = automatique
    this.grammars = new Map();
    this.seqs = []; this.free = []; this.waiters = []; this.busy = 0;
    this.parallel = 1;
  }

  get key() { return `${this.modelPath}|${this.gpu}|${this.threads}|${this.maxParallel}`; }

  async load(onStatus = () => {}) {
    const { getLlama, resolveChatWrapper } = await import('node-llama-cpp');
    onStatus('Initialisation du moteur IA…');
    const gpu = this.gpu === 'off' ? false : 'auto';
    try {
      this.llama = await getLlama({ gpu, build: 'never', logLevel: 'error', progressLogs: false });
    } catch (e) {
      if (gpu === false) throw e;
      onStatus('Carte graphique indisponible, utilisation du processeur…');
      this.llama = await getLlama({ gpu: false, build: 'never', logLevel: 'error', progressLogs: false });
    }
    this.backend = this.llama.gpu || 'cpu';
    onStatus(`Chargement du modèle (${this.backend === 'cpu' ? 'processeur' : 'carte graphique : ' + this.backend})…`);
    let lastPct = -1;
    this.model = await this.llama.loadModel({
      modelPath: this.modelPath,
      onLoadProgress: (p) => { const pct = Math.round(p * 100); if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; onStatus(`Chargement du modèle… ${pct} %`); } },
    });
    // modèles « qui réfléchissent » (Gemma 4, Qwen 3…) : réflexion désactivée, beaucoup plus rapide pour ces tâches
    try {
      this.chatWrapper = resolveChatWrapper(this.model, { customWrapperSettings: { gemma4: { reasoning: false }, qwen: { thoughts: 'discourage' } } });
    } catch { this.chatWrapper = undefined; }
    onStatus('Préparation de la mémoire de travail…');
    await this.newContext();
    onStatus(`Modèle prêt (contexte ${this.ctxSize} jetons${this.parallel > 1 ? ` · ${this.parallel} rédactions en parallèle` : ''})`);
    this.info = `${require('path').basename(this.modelPath)} · ${this.backend === 'cpu' ? 'processeur' : 'carte graphique ' + this.backend} · contexte ${this.ctxSize} · ${this.parallel} en parallèle · ${this.threads || 'auto'} threads`;
    return this;
  }

  /**
   * (Re)crée le contexte et ses séquences de travail.
   * Sur carte graphique, plusieurs séquences sont générées EN MÊME TEMPS : la carte calcule 2 à 4 réponses
   * presque aussi vite qu'une seule (la vitesse d'écriture est limitée par la lecture des poids du modèle,
   * partagée entre toutes les séquences). On essaie 4, puis 3, 2… selon la mémoire de la carte.
   */
  async newContext() {
    this.free = []; this.seqs = []; // synchrone : plus aucune séquence distribuée pendant la reconstruction
    if (this.context) {
      // un calcul natif bloqué peut empêcher la libération : on n'attend pas indéfiniment
      let timer;
      try { await Promise.race([this.context.dispose(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('libération bloquée')), 15000); })]); }
      catch (e) { if (/libération bloquée/.test(e && e.message)) throw Object.assign(new Error('Le moteur IA est bloqué : relancez l’opération.'), { stalled: true }); }
      finally { clearTimeout(timer); }
    }
    this.context = null;
    const trainCtx = this.model.trainContextSize || 8192;
    const max = Math.min(this.contextSize, trainCtx);
    const base = { flashAttention: 'auto', ...(this.threads ? { threads: this.threads } : {}) };
    const envP = parseInt(process.env.VOX_LLM_PARALLEL || '', 10);
    let want = this.maxParallel || (Number.isFinite(envP) && envP > 0 ? envP : (this.backend === 'cpu' ? 1 : 4));
    if (this.parallelBroken) want = 1;
    // (pas de « swaFullCache » ici : chaque requête repart de zéro, le cache partiel des modèles à fenêtre
    // glissante suffit et laisse de la place pour plusieurs séquences)
    for (let n = Math.min(4, want); n >= 2 && !this.context; n--) {
      try {
        this.context = await this.model.createContext({ ...base, contextSize: max, sequences: n, failedCreationRemedy: false });
      } catch { this.context = null; }
    }
    if (!this.context) {
      try {
        this.context = await this.model.createContext({ ...base, contextSize: { min: 2048, max }, sequences: 1, ...(process.env.VOX_SWA === '0' ? {} : { swaFullCache: true }) });
      } catch {
        // pilote sans « flash attention » : réglages d'origine
        this.context = await this.model.createContext({ contextSize: { min: 2048, max }, sequences: 1, ...(process.env.VOX_SWA === '0' ? {} : { swaFullCache: true }), ...(this.threads ? { threads: this.threads } : {}) });
      }
    }
    this.parallel = this.context.totalSequences || 1;
    this.ctxSize = this.context.contextSize;
    for (let i = 0; i < this.parallel; i++) this.seqs.push(this.context.getSequence());
    this.free = this.seqs.slice();
    this.wake();
  }

  wake() { const w = this.waiters.splice(0); w.forEach((r) => r()); }

  /** Réserve une séquence libre (attend si toutes travaillent). */
  async acquire(signal) {
    for (;;) {
      if (signal && signal.aborted) throw Object.assign(new Error('Annulé'), { name: 'AbortError' });
      if (this.stalled) throw Object.assign(new Error('Le moteur IA est bloqué : relancez l’opération.'), { stalled: true });
      if (this.dirty && this.busy === 0) {
        this.dirty = false; this.busy++;
        try { await this.newContext(); } catch (e) { this.dirty = true; throw e; } finally { this.busy--; this.wake(); }
        continue;
      }
      if (!this.dirty && this.free.length) { const s = this.free.pop(); this.busy++; return s; }
      await new Promise((resolve) => {
        const done = () => { const i = this.waiters.indexOf(done); if (i >= 0) this.waiters.splice(i, 1); if (signal) signal.removeEventListener('abort', done); resolve(); };
        this.waiters.push(done);
        if (signal) signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  release(seq, ok) {
    this.busy--;
    if (seq && ok && !seq.disposed && this.seqs.includes(seq)) this.free.push(seq);
    else if (seq && this.seqs.includes(seq)) this.dirty = true; // séquence douteuse : contexte recréé dès que tout est libre
    this.wake();
  }

  async grammar(schema) {
    const k = JSON.stringify(schema);
    if (!this.grammars.has(k)) {
      const p = this.llama.createGrammarForJsonSchema(schema);
      this.grammars.set(k, p); // promesse gardée : deux requêtes simultanées ne la créent qu'une fois
      p.catch(() => this.grammars.delete(k));
    }
    if (this.grammars.size > 64) this.grammars.delete(this.grammars.keys().next().value);
    return this.grammars.get(k);
  }

  /**
   * Jusqu'à `parallel` requêtes simultanées ; les suivantes attendent une séquence libre.
   * L'historique d'une séquence réutilisée n'est pas effacé exprès : le moteur compare la nouvelle requête
   * avec ce qui est déjà en mémoire, garde le début commun (consigne identique) et ne recalcule que la suite.
   */
  async complete(opts) {
    const seq = await this.acquire(opts.signal);
    let ok = false;
    try {
      const r = await this._complete(opts, seq);
      ok = true;
      return r;
    } catch (e) {
      if (e && e.untouched) { ok = true; throw e; } // la séquence n'a pas été touchée : réutilisable telle quelle
      // erreur du moteur en mode parallèle (pilote récalcitrant) : on repasse à une séquence unique
      if (this.parallel > 1 && !(opts.signal && opts.signal.aborted) && !(e && e.stalled)) {
        this.parallelBroken = true; this.dirty = true;
        if (this.onLog) this.onLog(`génération parallèle désactivée après une erreur : ${e && e.message}`);
      }
      throw e;
    } finally {
      this.release(seq, ok);
    }
  }

  async _complete({ system, user, schema, maxTokens = 1024, signal: outerSignal, temperature = 0.2, onToken }, seq) {
    // garde-fou : si le modèle ne produit plus rien (mémoire saturée, carte graphique bloquée…), on arrête
    // avec un message clair au lieu d'un chargement infini
    const ctrl = new AbortController();
    const onOuter = () => ctrl.abort();
    if (outerSignal) { if (outerSignal.aborted) ctrl.abort(); else outerSignal.addEventListener('abort', onOuter, { once: true }); }
    const signal = ctrl.signal;
    let stalled = false; let timer = null; let tokens = 0; const t0 = Date.now(); let tFirst = 0;
    let onStall = () => {};
    const stallP = new Promise((resolve, reject) => { onStall = reject; });
    stallP.catch(() => {});
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctrl.abort(); onStall(new Error('stall')); }, ms); };
    arm(this.firstTokenTimeout || 6 * 60 * 1000); // lecture du texte (peut être longue sur processeur)
    const userOnToken = onToken;
    onToken = (t) => {
      tokens++; if (!tFirst) tFirst = Date.now();
      arm(this.tokenTimeout || 2 * 60 * 1000);
      if (this.onTokenStats) this.onTokenStats(1);
      if (userOnToken) userOnToken(t);
    };
    try {
      // si le calcul natif reste bloqué malgré l'arrêt demandé, on n'attend pas indéfiniment
      const r = await Promise.race([this._completeInner({ system, user, schema, maxTokens, signal, temperature, onToken }, seq), stallP]);
      if (this.onCallStats) this.onCallStats({ promptMs: (tFirst || Date.now()) - t0, genMs: tFirst ? Date.now() - tFirst : 0, tokens });
      return r;
    } catch (e) {
      if (stalled && !(outerSignal && outerSignal.aborted)) {
        this.dirty = true; this.stalled = true; // plus aucune requête : le processus IA sera relancé
        throw Object.assign(new Error(`Le modèle IA ne répond plus (${tokens ? 'plus aucun mot depuis 2 min' : 'aucun mot après 6 min'}). ` +
          'Mémoire probablement saturée : fermez d’autres logiciels, choisissez un modèle IA plus petit (Qwen 2.5 — 1.5B ou 3B) ou changez l’option « carte graphique » dans les paramètres.'), { stalled: true });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter);
    }
  }

  async _completeInner({ system, user, schema, maxTokens, signal, temperature, onToken }, seq) {
    const { LlamaChatSession } = await import('node-llama-cpp');
    if (signal.aborted) throw Object.assign(new Error('Annulé'), { name: 'AbortError', untouched: true });
    let session = null;
    try {
      session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system, autoDisposeSequence: false, ...(this.chatWrapper ? { chatWrapper: this.chatWrapper } : {}) });
      // garde-fou : la réponse doit tenir dans le contexte restant
      const promptTokens = this.model.tokenize(system + '\n' + user).length + 64;
      const room = this.ctxSize - promptTokens;
      if (room < 128) throw Object.assign(new Error(`Texte trop long pour le contexte du modèle (${this.ctxSize} jetons)`), { untouched: true });
      return await session.prompt(user, {
        grammar: schema ? await this.grammar(schema) : undefined,
        maxTokens: Math.max(64, Math.min(maxTokens, room)),
        temperature,
        signal,
        onTextChunk: onToken,
      });
    } catch (e) {
      // annulation ou erreur interne du moteur : contexte neuf (dès que les autres requêtes sont finies)
      if (!(e && e.untouched)) this.dirty = true;
      throw e;
    } finally {
      try { if (session) session.dispose({ disposeSequence: false }); } catch { /* */ }
    }
  }

  /**
   * Prévisibilité d'un texte pour le modèle (détection d'origine IA) : pour chaque mot, le modèle avait-il
   * deviné ce mot (premier choix) ? À quelle distance (logits) était son premier choix ?
   * @param {string[]} paragraphs
   * @returns {Promise<{tokens:number, top1:number, top10:number, gap:number, burst:number|null, paragraphs:(object|null)[]}>}
   */
  async predictability(paragraphs, { signal, onProgress, maxTokens = 3000 } = {}) {
    const bos = this.model.tokens.bos;
    const sentEnd = new Set(['.', '!', '?', '…']);
    // échantillon : au plus maxTokens jetons, répartis sur tout le document
    const items = paragraphs.map((t, i) => ({ i, text: String(t || '').trim() })).filter((x) => x.text);
    const toks = items.map((x) => this.model.tokenize(x.text));
    const total = toks.reduce((a, t) => a + t.length, 0);
    const chosen = [];
    if (total <= maxTokens) items.forEach((x, k) => chosen.push([k, toks[k]]));
    else {
      // un paragraphe sur N (répartis sur tout le document), 500 jetons au plus chacun, jusqu'au budget
      const stride = Math.max(1, Math.ceil(total / maxTokens));
      let budget = maxTokens;
      const order = [];
      for (let r = 0; r < stride; r++) for (let k = r; k < items.length; k += stride) order.push(k);
      for (const k of order) { if (budget <= 0) break; const t = toks[k].slice(0, 500); chosen.push([k, t]); budget -= t.length; }
      chosen.sort((a, b) => a[0] - b[0]);
    }
    const seq = await this.acquire(signal);
    let ok = false;
    const per = new Array(paragraphs.length).fill(null);
    const all = { top1: 0, top10: 0, gap: 0, n: 0 }; const sentGaps = [];
    try {
      const chunkMax = Math.max(256, Math.min(1500, this.ctxSize - 64));
      let done = 0;
      for (const [k, t] of chosen) {
        if (signal && signal.aborted) throw Object.assign(new Error('Annulé'), { name: 'AbortError' });
        const stats = { top1: 0, top10: 0, gap: 0, n: 0, sg: [] };
        for (let off = 0; off < t.length; off += chunkMax) {
          const part = t.slice(off, off + chunkMax);
          const input = [];
          if (bos != null) input.push(bos);
          for (let j = 0; j < part.length; j++) {
            if (j + 1 < part.length) input.push([part[j], { generateNext: { logits: { filter: { tokens: [part[j + 1]], includeTop: 10 } } } }]);
            else input.push(part[j]);
          }
          await seq.clearHistory();
          const out = await seq.controlledEvaluate(input, { signal });
          let cur = 0; let curN = 0;
          for (let j = 0; j + 1 < part.length; j++) {
            const o = out[(bos != null ? 1 : 0) + j]; if (!o || !o.next || !o.next.logits) continue;
            const actual = part[j + 1];
            const entries = [...o.next.logits.entries()];
            const top = entries[0][1];
            const mine = o.next.logits.get(actual);
            const rank = entries.findIndex(([tok]) => tok === actual);
            const gap = mine == null ? 8 : Math.min(8, Math.max(0, top - mine));
            stats.n++; if (rank === 0) stats.top1++; if (rank >= 0 && rank < 10) stats.top10++; stats.gap += gap;
            cur += gap; curN++;
            const txt = this.model.detokenize([actual]);
            if (sentEnd.has(txt.trim().slice(-1)) && curN >= 4) { stats.sg.push(cur / curN); cur = 0; curN = 0; }
          }
        }
        if (stats.n >= 20) {
          const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
          const burst = stats.sg.length >= 3 ? Math.sqrt(mean(stats.sg.map((x) => (x - mean(stats.sg)) ** 2))) / Math.max(0.3, mean(stats.sg)) : null;
          per[items[k].i] = { tokens: stats.n, top1: stats.top1 / stats.n, top10: stats.top10 / stats.n, gap: stats.gap / stats.n, burst };
        }
        all.top1 += stats.top1; all.top10 += stats.top10; all.gap += stats.gap; all.n += stats.n; sentGaps.push(...stats.sg);
        done += t.length;
        if (onProgress) onProgress(done / Math.max(1, chosen.reduce((a, [, x]) => a + x.length, 0)));
      }
      ok = true;
    } finally {
      this.release(seq, ok);
    }
    if (!all.n) throw new Error('Texte trop court pour une mesure.');
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const burst = sentGaps.length >= 4 ? Math.sqrt(mean(sentGaps.map((x) => (x - mean(sentGaps)) ** 2))) / Math.max(0.3, mean(sentGaps)) : null;
    return { tokens: all.n, sampled: total > maxTokens, top1: all.top1 / all.n, top10: all.top10 / all.n, gap: all.gap / all.n, burst, paragraphs: per };
  }

  async dispose() {
    try { await this.context?.dispose(); } catch { /* */ }
    try { await this.model?.dispose(); } catch { /* */ }
  }
}

class OpenAICompatible {
  constructor({ baseUrl, apiKey = '', model = '' }) {
    this.parallel = 1; // un serveur externe gère lui-même sa file d'attente
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey; this.model = model;
    this.supportsSchema = true;
  }

  get key() { return `openai|${this.baseUrl}|${this.model}`; }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async load(onStatus = () => {}) {
    if (!this.baseUrl) throw new Error('Adresse du serveur IA non renseignée (Paramètres › Intelligence artificielle).');
    onStatus('Connexion au serveur IA…');
    if (!this.model) {
      const models = await listRemoteModels(this.baseUrl, this.apiKey);
      if (!models.length) throw new Error('Aucun modèle chargé sur le serveur IA.');
      this.model = models[0];
    }
    onStatus(`Serveur IA prêt (${this.model})`);
    this.ctxSize = 32768;
    return this;
  }

  async complete({ system, user, schema, maxTokens = 1024, signal, temperature = 0.2, onToken }) {
    if (onToken && !schema) return this.stream({ system, user, maxTokens, signal, temperature, onToken });
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature, max_tokens: maxTokens, stream: false,
    };
    if (schema && this.supportsSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: false, schema } };
    let res = await fetch(this.baseUrl + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok && body.response_format) {
      // certains serveurs ne gèrent pas les schémas : on réessaie en mode texte (le JSON est demandé dans la consigne)
      this.supportsSchema = false;
      delete body.response_format;
      res = await fetch(this.baseUrl + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Serveur IA : HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    // retire un éventuel raisonnement <think>…</think>
    return String((msg && msg.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  /** Réponse en flux (SSE) pour afficher le texte au fur et à mesure. */
  async stream({ system, user, maxTokens, signal, temperature, onToken }) {
    const body = { model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens, stream: true };
    const res = await fetch(this.baseUrl + '/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`Serveur IA : HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const strip = (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!(res.headers.get('content-type') || '').includes('event-stream')) { // serveur sans flux
      const j = await res.json(); const t = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      onToken(t); return strip(t);
    }
    const dec = new TextDecoder(); let buf = ''; let full = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try { const j = JSON.parse(data); const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (d) { full += d; onToken(d); } } catch { /* ligne incomplète */ }
      }
    }
    return strip(full);
  }

  async dispose() { /* rien */ }
}

async function listRemoteModels(baseUrl, apiKey) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/models';
  const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Serveur IA injoignable (HTTP ${res.status})`);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).filter((id) => !/embed/i.test(id));
}

module.exports = { LocalLLM, OpenAICompatible, listRemoteModels };
