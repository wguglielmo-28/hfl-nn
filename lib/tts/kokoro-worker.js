// Worker thread that runs Kokoro TTS (kokoro-js, Apache-2.0) so voicing an
// episode doesn't block the web server. The model (~90 MB at q8) downloads
// from Hugging Face on first use into the cache directory, then loads from
// disk. Messages: { id, text, voice, speed } → { id, ok, samples, sampleRate }.
'use strict';
const { parentPort, workerData } = require('worker_threads');

let ready = null;

async function load() {
  const transformers = await import('@huggingface/transformers');
  if (workerData.cacheDir) transformers.env.cacheDir = workerData.cacheDir;
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(workerData.modelId, { dtype: workerData.dtype || 'q8', device: 'cpu' });
  parentPort.postMessage({ type: 'ready', voices: Object.keys(tts.voices || {}) });
  return tts;
}

// A failed load (no network on first run, say) is retried on the next request.
function getTTS() {
  if (!ready) ready = load().catch(e => { ready = null; throw e; });
  return ready;
}

parentPort.on('message', async msg => {
  if (msg.type === 'warm') {
    getTTS().catch(e => parentPort.postMessage({ type: 'error', error: e.message || String(e) }));
    return;
  }
  const { id, text, voice, speed } = msg;
  try {
    const tts = await getTTS();
    const audio = await tts.generate(text, { voice, speed: speed || 1 });
    const samples = audio.audio instanceof Float32Array ? audio.audio : Float32Array.from(audio.audio);
    parentPort.postMessage({ id, ok: true, samples, sampleRate: audio.sampling_rate }, [samples.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message || String(e) });
  }
});
