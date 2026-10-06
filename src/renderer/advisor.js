/* VoxForge — conseiller de modèle : estime la vitesse de chaque modèle sur ce PC et choisit le plus adapté.
 *
 * 1) Avant toute transcription : estimation à partir du processeur (nombre de cœurs + petit test de calcul)
 *    et de la mémoire, en partant des vitesses mesurées sur un PC de référence.
 * 2) Après chaque transcription : la vitesse réellement mesurée remplace l'estimation et recale
 *    tous les autres modèles (rapport de coût constant entre modèles).
 */
(function () {
  'use strict';

  // PC de référence (2 cœurs, 2 threads) : vitesse en « × temps réel », toutes mesurées
  // (2 enregistrements en français, au calme ; Parakeet avec la revérification par Whisper).
  const REF = {
    score: 700, // résultat de cpuScore() sur le PC de référence
    threads: 2,
    rtf: { parakeet: 9.4, turbo: 3.85, 'large-v3': 0.37 },
  };
  // ordre de préférence ; Large v3 n'est jamais conseillé automatiquement (trop lent)
  // Parakeet passe en tête : plus rapide ET plus précis, mais seulement pour les langues européennes
  const PREFERENCE = ['parakeet', 'turbo'];

  const threadScale = (t) => Math.pow(Math.max(1, Math.min(8, t || 1)), 0.75);

  /** Petit test de calcul (≈ 0,5 s) : multiplications de matrices, comme le moteur. */
  function cpuScore() {
    const n = 96;
    const a = new Float32Array(n * n), b = new Float32Array(n * n), c = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) { a[i] = (i % 7) * 0.1; b[i] = (i % 5) * 0.2; }
    const mm = () => {
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const x = a[i * n + k]; for (let j = 0; j < n; j++) c[i * n + j] += x * b[k * n + j]; }
    };
    let best = 0;
    for (let round = 0; round < 3; round++) { // le 1er tour sert à « chauffer » le compilateur
      const t0 = performance.now(); let reps = 0;
      do { mm(); reps++; } while (performance.now() - t0 < 150);
      best = Math.max(best, reps / ((performance.now() - t0) / 1000));
    }
    return Math.round(best);
  }

  /**
   * @param {{logical:number,totalMem:number,threads:number,perf:object,cpuScore:number}} pc
   * @param {{id:string,ramGB:number}[]} catalog
   * @returns {{ estimates: Object<string,{rtf:number,measured:boolean,ramOk:boolean,level:string}>, recommended: string, calibrated: boolean }}
   */
  function advise(pc, catalog) {
    const threads = pc.threads || Math.max(1, Math.min(8, Math.floor((pc.logical || 4) / 2)));
    const totalGB = (pc.totalMem || 8 * 1024 ** 3) / 1024 ** 3;
    // facteur machine : test de calcul × nombre de cœurs utilisés
    let factor = ((pc.cpuScore || REF.score) / REF.score) * (threadScale(threads) / threadScale(REF.threads));
    // recalage sur les vitesses réellement mesurées (avec le même nombre de cœurs)
    const measured = Object.entries(pc.perf || {}).filter(([id, p]) => p && p.rtf > 0 && p.threads === threads && REF.rtf[id] > 0);
    if (measured.length) {
      const logs = measured.map(([id, p]) => Math.log(p.rtf / REF.rtf[id]));
      factor = Math.exp(logs.reduce((x, y) => x + y, 0) / logs.length);
    }
    const estimates = {};
    for (const m of catalog) {
      const own = (pc.perf || {})[m.id];
      const isMeasured = !!(own && own.threads === threads && own.rtf > 0);
      const rtf = isMeasured ? own.rtf : (REF.rtf[m.id] || 1) * factor;
      // le modèle doit tenir largement en mémoire (Windows + navigateur + VoxForge)
      const ramOk = (m.ramGB || 1) * 2.2 <= totalGB;
      const level = !ramOk ? 'ram' : rtf >= 2 ? 'fast' : rtf >= 1 ? 'ok' : rtf >= 0.5 ? 'slow' : 'tooslow';
      estimates[m.id] = { rtf, measured: isMeasured, ramOk, level };
    }
    // le meilleur modèle qui va au moins aussi vite que le temps réel (et qui connaît la langue choisie)
    const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
    const langOk = (id) => !byId[id] || ((!byId[id].langs || !pc.language || byId[id].langs.includes(pc.language))
      && !(pc.task === 'translate' && byId[id].noTranslate)); // Parakeet ne traduit pas vers l'anglais
    const pick = (list) => list.find((id) => estimates[id] && estimates[id].ramOk && estimates[id].rtf >= 1.0)
      || list.find((id) => estimates[id] && estimates[id].ramOk) || list[0] || 'turbo';
    const recommended = pick(PREFERENCE.filter(langOk));
    // conseil Whisper pour les langues que Parakeet ne connaît pas (japonais, arabe, chinois…)
    const whisper = pick(PREFERENCE.filter((id) => !(byId[id] && byId[id].langs)));
    return { estimates, recommended, whisper, calibrated: measured.length > 0, threads, totalGB };
  }

  /** « ≈ 18 min pour 1 h d'audio » */
  function perHour(rtf) {
    if (!rtf) return '';
    const min = 60 / rtf;
    if (min < 1) return '< 1 min pour 1 h d’audio';
    if (min < 90) return `≈ ${Math.round(min)} min pour 1 h d’audio`;
    return `≈ ${(min / 60).toFixed(1).replace('.', ',')} h pour 1 h d’audio`;
  }

  window.Advisor = { REF, cpuScore, advise, perHour, PREFERENCE };
})();
