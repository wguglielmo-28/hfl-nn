// Text-to-speech front end with a pluggable provider and an on-disk cache.
//
// Providers:
//   kokoro — free, local, Apache-2.0 (kokoro-js) running in a child process.
//   silent — timed silence, for tests and machines without Kokoro.
//   elevenlabs — paid, hosted (lib/tts/elevenlabs.js), used alongside the
//     main provider: a voice written "eleven:<voice id>" goes to ElevenLabs,
//     every other voice to Kokoro (or silence).
// Another provider only needs a synth(text, voice, speed) →
// { samples: Float32Array, sampleRate } function to slot in here.
//
// Every voiced line is cached by provider + voice + speed + text, so editing
// one line of a script only re-voices that line.
'use strict';
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { sha256 } = require('../util');
const { encodeWav, decodeWav, resample } = require('../audio/wav');
const { splitForSpeech } = require('./textprep');
const { createElevenLabsProvider } = require('./elevenlabs');

const ELEVEN_PREFIX = 'eleven:';
const isElevenVoice = v => String(v || '').startsWith(ELEVEN_PREFIX);

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

// A child process and its IPC channel both hold the server's event loop open.
const ref = c => { c.ref(); c.channel?.ref?.(); };
const unref = c => { c.unref(); c.channel?.unref?.(); };

function createKokoroProvider({ modelDir, dtype = 'q8', logger = console }) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let state = { status: 'idle', error: null, voices: null };

  function start() {
    if (worker) return worker;
    // A child process, not a worker thread: onnxruntime-node's native addon
    // loads only once per process, so a second worker thread (after the idle
    // stop) died with "Module did not self-register". 'advanced'
    // serialization carries the Float32Array samples across intact.
    const child = fork(path.join(__dirname, 'kokoro-worker.js'), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, KOKORO_CACHE_DIR: modelDir || '', KOKORO_MODEL_ID: KOKORO_MODEL, KOKORO_DTYPE: dtype },
    });
    worker = child;
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
      if (!pending.size) { unref(child); scheduleIdleStop(); }
    });
    // Only this process's lines: a killed process's exit can arrive after
    // its replacement has already taken new work.
    const mine = () => [...pending].filter(([, p]) => p.child === child);
    const fail = e => {
      state = { ...state, status: 'error', error: e.message };
      for (const [id, p] of mine()) { pending.delete(id); p.reject(e); }
      if (worker === child) worker = null;
    };
    child.on('error', e => { logger.error('[tts] Kokoro process failed:', e); fail(e); });
    child.on('exit', (code, signal) => {
      if (mine().length) {
        logger.error(`[tts] Kokoro process exited mid-line (code ${code}, signal ${signal})`);
        fail(new Error(`Kokoro: the voice process exited (${signal || `code ${code}`})`));
      }
      if (worker === child) worker = null;
    });
    unref(child);
    return child;
  }

  // The loaded model holds ~300 MB; let it go after 10 idle minutes.
  let idleTimer = null;
  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (worker && !pending.size) { worker.kill(); worker = null; state = { ...state, status: 'idle' }; }
    }, 10 * 60 * 1000);
    idleTimer.unref?.();
  }

  function synth(text, voice, speed) {
    clearTimeout(idleTimer);
    const w = start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, child: w });
      ref(w);   // keep the server process alive while a line is being voiced
      w.send({ id, text, voice, speed });
    });
  }

  return {
    name: 'kokoro',
    synth,
    warm() { start().send({ type: 'warm' }); },
    status: () => ({ ...state }),
    async close() { clearTimeout(idleTimer); if (worker) worker.kill(); worker = null; },
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

function createTTS({ provider = 'auto', cacheDir, modelDir, elevenlabs = null, logger = console } = {}) {
  const useKokoro = provider === 'kokoro' || (provider === 'auto' && kokoroInstalled());
  const main = useKokoro ? createKokoroProvider({ modelDir, logger }) : createSilentProvider();
  const eleven = elevenlabs || createElevenLabsProvider({ apiKey: null, logger });
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  // Characters sent to ElevenLabs (cache misses only): what the account is billed for.
  const usage = { elevenlabsChars: 0 };

  // Voice one line. Long lines are split into sentences and stitched back
  // together with short pauses.
  async function speak(text, { voice, speed = 1, elevenModel = null } = {}) {
    const useEleven = isElevenVoice(voice);
    const impl = useEleven ? eleven : main;
    const voiceId = useEleven ? voice.slice(ELEVEN_PREFIX.length) : voice;
    const synthetic = impl.name === 'silent';
    const key = sha256(JSON.stringify(useEleven
      ? ['elevenlabs', eleven.model(elevenModel), voiceId, Math.round(speed * 100), text]
      : [impl.name, KOKORO_MODEL, voice, Math.round(speed * 100), text]));
    const file = cacheDir ? path.join(cacheDir, key.slice(0, 2), `${key}.wav`) : null;
    if (file && !synthetic && fs.existsSync(file)) {
      const { samples, sampleRate } = decodeWav(fs.readFileSync(file));
      return { samples, sampleRate, synthetic, cached: true, provider: impl.name };
    }
    const pause = Math.round(0.09 * SAMPLE_RATE);
    const chunks = [];
    for (const part of splitForSpeech(text)) {
      const r = await impl.synth(part, voiceId, speed, useEleven ? eleven.model(elevenModel) : undefined);
      if (useEleven) usage.elevenlabsChars += part.length;
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
    return { samples, sampleRate: SAMPLE_RATE, synthetic, cached: false, provider: impl.name };
  }

  return {
    provider: main.name,
    SAMPLE_RATE,
    speak,
    usage: () => ({ ...usage }),
    elevenlabs: eleven,
    warm: () => main.warm(),
    status: () => ({ provider: main.name, ...main.status(), elevenlabs: { configured: eleven.configured(), model: eleven.model(), ...eleven.status() } }),
    close: () => main.close(),
  };
}

module.exports = { createTTS, isElevenVoice, ELEVEN_PREFIX, KOKORO_VOICES, KOKORO_MODEL, voiceLabel, kokoroInstalled, SAMPLE_RATE };
