// Child process that runs Kokoro TTS (kokoro-js, Apache-2.0) so voicing an
// episode doesn't block the web server. The model (~90 MB at q8) downloads
// from Hugging Face on first use into the cache directory, then loads from
// disk. Messages: { id, text, voice, speed } → { id, ok, samples, sampleRate }.
//
// A process, not a worker thread: onnxruntime-node's native addon can only be
// loaded once per process, so a second worker thread (after the idle stop, or
// a crash) failed with "Module did not self-register". A fresh process loads
// it cleanly every time, and killing it frees all of the model's memory.
'use strict';

const config = {
  cacheDir: process.env.KOKORO_CACHE_DIR || null,
  modelId: process.env.KOKORO_MODEL_ID,
  dtype: process.env.KOKORO_DTYPE || 'q8',
};
const send = m => { if (process.connected) process.send(m); };

let ready = null;

async function load() {
  const transformers = await import('@huggingface/transformers');
  if (config.cacheDir) transformers.env.cacheDir = config.cacheDir;
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(config.modelId, { dtype: config.dtype, device: 'cpu' });
  send({ type: 'ready', voices: Object.keys(tts.voices || {}) });
  return tts;
}

// A failed load (no network on first run, say) is retried on the next request.
function getTTS() {
  if (!ready) ready = load().catch(e => { ready = null; throw e; });
  return ready;
}

process.on('message', async msg => {
  if (msg.type === 'warm') {
    getTTS().catch(e => send({ type: 'error', error: e.message || String(e) }));
    return;
  }
  const { id, text, voice, speed } = msg;
  try {
    const tts = await getTTS();
    const audio = await tts.generate(text, { voice, speed: speed || 1 });
    const samples = audio.audio instanceof Float32Array ? audio.audio : Float32Array.from(audio.audio);
    send({ id, ok: true, samples, sampleRate: audio.sampling_rate });
  } catch (e) {
    send({ id, ok: false, error: e.message || String(e) });
  }
});

// The server went away: don't linger holding the model.
process.on('disconnect', () => process.exit(0));
