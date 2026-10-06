'use strict';
/**
 * Processus de calcul isolé (Electron utilityProcess) : garde l'interface fluide
 * et permet d'annuler instantanément une transcription en tuant le processus.
 */
const { transcribe, preload, LiveSession, releaseChecker, benchmark } = require('./engine');
let idleTimer = null; // libération du modèle de vérification après 1 min sans fichier

const port = process.parentPort;
const send = (msg) => (port ? port.postMessage(msg) : process.send && process.send(msg));
const onMessage = (fn) => (port ? port.on('message', (e) => fn(e.data)) : process.on('message', fn));

let cancelled = false;
let live = null;

onMessage(async (msg) => {
  try {
    switch (msg.type) {
      case 'transcribe': {
        cancelled = false;
        clearTimeout(idleTimer);
        const jobId = msg.jobId;
        let result;
        try { result = await transcribe(msg.options, (ev) => send({ ...ev, jobId }), () => cancelled); }
        finally { idleTimer = setTimeout(releaseChecker, 60000); }
        send({ type: result.cancelled ? 'cancelled' : 'done', jobId, result });
        break;
      }
      case 'preload': {
        // erreurs silencieuses : le modèle sera simplement chargé au lancement de la transcription
        try { const r = await preload(msg.options); send({ type: 'preloaded', model: msg.model, ...r }); }
        catch (e) { send({ type: 'preload-failed', model: msg.model, message: e.message }); }
        break;
      }
      case 'cancel':
        cancelled = true;
        break;
      case 'bench': {
        // mesure de vitesse (processeur ou carte graphique selon le processus)
        try { send({ type: 'bench-done', ...benchmark(msg.options, msg.seconds || 20), gpu: !!process.env.VOX_GPU_DIR }); }
        catch (e) { send({ type: 'bench-failed', message: e && e.message ? e.message : String(e) }); }
        break;
      }
      case 'live-start':
        if (live) { live.closed = true; live = null; }
        live = new LiveSession(msg.options, (ev) => send({ ...ev, jobId: 'live' }));
        try { await live.init(); } catch (e) { live = null; throw e; } // pas de session à moitié démarrée
        break;
      case 'live-audio':
        if (live) live.push(msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples));
        break;
      case 'live-stop': {
        if (!live) break;
        const s = live; live = null;
        const result = await s.stop();
        send({ type: 'live-done', jobId: 'live', result });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    send({ type: 'error', jobId: msg.jobId || (msg.type.startsWith('live') ? 'live' : null), message: e && e.message ? e.message : String(e) });
  }
});

send({ type: 'worker-ready' });
