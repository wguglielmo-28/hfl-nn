// Text-to-speech front end with a pluggable provider and an on-disk cache.
//
// Providers:
//   kokoro — free, local, Apache-2.0 (kokoro-js) running in a worker thread.
//   silent — timed silence, for tests and machines without Kokoro.
// A premium provider (OpenAI, ElevenLabs...) only needs a synth(text, voice,
// speed) → { samples: Float32Array, sampleRate } function to slot in here.
//
// Every voiced line is cached by provider + voice + speed + text, so editing
// one line of a script only re-voices that line.
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { sha256 } = require('../util');
const { encodeWav, decodeWav, resample } = require('../audio/wav');
const { splitForSpeech } = require('./textprep');

const SAMPLE_RATE = 24000;
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Kokoro v1.0 English voices: a = American, b = British; f = female, m = male.
const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];
function voiceLabel(v) {
  const [kind, name] = v.split('_');
  const accent = kind[0] === 'a' ? 'American' : 'British';
  const sex = kind[1] === 'f' ? 'female' : 'male';
  return `${name.charAt(0).toUpperCase() + name.slice(1)} (${accent} ${sex})`;
}

function kokoroInstalled() {
  try { require.resolve('kokoro-js'); return true; } catch { return false; }
}

function createKokoroProvider({ modelDir, dtype = 'q8', logger = console }) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let state = { status: 'idle', error: null, voices: null };

  function start() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'kokoro-worker.js'), { workerData: { cacheDir: modelDir, modelId: KOKORO_MODEL, dtype } });
    state = { ...state, status: 'loading', error: null };
    worker.on('message', m => {
      if (m.type === 'ready') { state = { status: 'ready', error: null, voices: m.voices }; return; }
      if (m.type === 'error') { state = { ...state, status: 'error', error: m.error }; return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) {
        state = { ...state, status: 'ready', error: null };
        p.resolve({ samples: m.samples, sampleRate: m.sampleRate });
      } else {
        state = { ...state, status: 'error', error: m.error };
        p.reject(new Error(`Kokoro: ${m.error}`));
      }
      if (!pending.size) { worker?.unref(); scheduleIdleStop(); }
    });
    worker.on('error', e => {
      logger.error('[tts] Kokoro worker crashed:', e);
      state = { ...state, status: 'error', error: e.message };
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      worker = null;
    });
    worker.on('exit', () => { worker = null; });
    worker.unref();
    return worker;
  }

  // The loaded model holds ~300 MB; let it go after 10 idle minutes.
  let idleTimer = null;
  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (worker && !pending.size) { worker.terminate(); worker = null; state = { ...state, status: 'idle' }; }
    }, 10 * 60 * 1000);
    idleTimer.unref?.();
  }

  function synth(text, voice, speed) {
    clearTimeout(idleTimer);
    const w = start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.ref();   // keep the process alive while a line is being voiced
      w.postMessage({ id, text, voice, speed });
    });
  }

  return {
    name: 'kokoro',
    synth,
    warm() { start().postMessage({ type: 'warm' }); },
    status: () => ({ ...state }),
    async close() { clearTimeout(idleTimer); if (worker) await worker.terminate(); worker = null; },
  };
}

// Timed silence at roughly speaking pace. Flagged synthetic so the mixer
// animates mouths from the word rhythm instead of the (silent) audio.
function createSilentProvider() {
  return {
    name: 'silent',
    async synth(text, voice, speed = 1) {
      const words = String(text).split(/\s+/).filter(Boolean).length;
      const secs = Math.max(0.6, words / (2.6 * speed) + 0.15);
      return { samples: new Float32Array(Math.round(secs * SAMPLE_RATE)), sampleRate: SAMPLE_RATE };
    },
    warm() {},
    status: () => ({ status: 'ready', error: null }),
    async close() {},
  };
}

function createTTS({ provider = 'auto', cacheDir, modelDir, logger = console } = {}) {
  const useKokoro = provider === 'kokoro' || (provider === 'auto' && kokoroInstalled());
  const impl = useKokoro ? createKokoroProvider({ modelDir, logger }) : createSilentProvider();
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  // Voice one line. Long lines are split into sentences and stitched back
  // together with short pauses.
  async function speak(text, { voice, speed = 1 } = {}) {
    const synthetic = impl.name === 'silent';
    const key = sha256(JSON.stringify([impl.name, KOKORO_MODEL, voice, Math.round(speed * 100), text]));
    const file = cacheDir ? path.join(cacheDir, key.slice(0, 2), `${key}.wav`) : null;
    if (file && !synthetic && fs.existsSync(file)) {
      const { samples, sampleRate } = decodeWav(fs.readFileSync(file));
      return { samples, sampleRate, synthetic, cached: true };
    }
    const pause = Math.round(0.09 * SAMPLE_RATE);
    const chunks = [];
    for (const part of splitForSpeech(text)) {
      const r = await impl.synth(part, voice, speed);
      chunks.push(resample(r.samples, r.sampleRate, SAMPLE_RATE));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0) + pause * Math.max(0, chunks.length - 1);
    const samples = new Float32Array(total);
    let at = 0;
    chunks.forEach((c, i) => { samples.set(c, at); at += c.length + (i < chunks.length - 1 ? pause : 0); });
    if (file && !synthetic) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encodeWav(samples, SAMPLE_RATE));
    }
    return { samples, sampleRate: SAMPLE_RATE, synthetic, cached: false };
  }

  return {
    provider: impl.name,
    SAMPLE_RATE,
    speak,
    warm: () => impl.warm(),
    status: () => ({ provider: impl.name, ...impl.status() }),
    close: () => impl.close(),
  };
}

module.exports = { createTTS, KOKORO_VOICES, KOKORO_MODEL, voiceLabel, kokoroInstalled, SAMPLE_RATE };
