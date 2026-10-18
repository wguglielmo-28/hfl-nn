// ElevenLabs voices: a paid, hosted alternative to Kokoro for any anchor who
// is given an ElevenLabs voice in Settings → Anchors.
//
// - Audio comes back as raw 16-bit PCM at 24 kHz (output_format=pcm_24000,
//   allowed on every plan), the rate the mixer already runs at.
// - Billing is per character voiced. lib/tts/index.js caches every line, so
//   re-voicing an edited script only pays for the lines that changed, and it
//   counts the characters sent so the control room can show the spend.
// - Speed: ElevenLabs takes 0.7–1.2; the mixer's per-emotion speeds are
//   clamped into that.
'use strict';
const https = require('node:https');

const HOST = 'api.elevenlabs.io';
const SAMPLE_RATE = 24000;
const MODELS = {
  eleven_multilingual_v2: { label: 'Multilingual v2 (stable, $0.08 per 1,000 characters)' },
  eleven_v4: { label: 'v4 (most expressive, $0.08 per 1,000 characters)' },
  eleven_flash_v2_5: { label: 'Flash v2.5 (half price, $0.04 per 1,000 characters)' },
};
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;
// A news desk wants some range: a touch less stable than ElevenLabs' 0.5 default.
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.75, style: 0, use_speaker_boost: true };

class ElevenLabsError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function httpsRequest({ method, path, headers, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname: HOST, path, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, timeout: 120000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('ElevenLabs timed out')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function apiError(status, body) {
  let detail = {};
  try { detail = JSON.parse(body.toString('utf8'))?.detail || {}; } catch { /* not JSON */ }
  if (typeof detail === 'string') detail = { message: detail };
  const msg = String(detail.message || '').slice(0, 300);
  const code = detail.status || `http_${status}`;
  const hint = code === 'quota_exceeded' ? ' The ElevenLabs account is out of characters for this month.'
    : status === 401 ? ' Check ELEVENLABS_API_KEY.'
      : status === 429 ? ' Too many requests at once; try again shortly.' : '';
  return new ElevenLabsError(`ElevenLabs returned HTTP ${status}${msg ? `: ${msg}` : ''}.${hint}`, code);
}

// 16-bit little-endian mono PCM → floats in [-1, 1].
function pcm16ToFloat(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

const clampSpeed = s => Math.max(0.7, Math.min(1.2, Number(s) || 1));

function createElevenLabsProvider({ apiKey, getModel = () => DEFAULT_MODEL, request = httpsRequest, logger = console } = {}) {
  let state = { status: apiKey ? 'ready' : 'not configured', error: null };
  let voiceCache = null;   // { at, voices }

  const pickModel = m => (MODELS[m] ? m : MODELS[getModel()] ? getModel() : DEFAULT_MODEL);

  // `model` comes from Settings → ElevenLabs model with each line.
  async function synth(text, voiceId, speed = 1, model = null) {
    if (!apiKey) throw new ElevenLabsError('ElevenLabs is not configured (set ELEVENLABS_API_KEY).', 'not_configured');
    if (!VOICE_ID.test(String(voiceId))) throw new ElevenLabsError(`"${voiceId}" is not an ElevenLabs voice id.`, 'bad_voice');
    const res = await request({
      method: 'POST',
      path: `/v1/text-to-speech/${voiceId}?output_format=pcm_${SAMPLE_RATE}`,
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: pickModel(model), voice_settings: { ...VOICE_SETTINGS, speed: clampSpeed(speed) } }),
    });
    if (res.status !== 200) {
      const err = apiError(res.status, res.body);
      state = { status: 'error', error: err.message };
      throw err;
    }
    state = { status: 'ready', error: null };
    return { samples: pcm16ToFloat(res.body), sampleRate: SAMPLE_RATE };
  }

  // The account's voices (premade, cloned and library), cached for 10 minutes.
  async function listVoices({ fresh = false } = {}) {
    if (!apiKey) return [];
    if (!fresh && voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;
    const res = await request({ method: 'GET', path: '/v1/voices', headers: { 'xi-api-key': apiKey, accept: 'application/json' } });
    if (res.status !== 200) throw apiError(res.status, res.body);
    const list = JSON.parse(res.body.toString('utf8'))?.voices || [];
    const voices = list
      .filter(v => VOICE_ID.test(String(v.voice_id)))
      .map(v => {
        const l = v.labels || {};
        const desc = [l.accent, l.gender, l.age, l.descriptive || l.description || l.use_case].filter(Boolean).join(', ');
        return { id: v.voice_id, name: String(v.name || v.voice_id).slice(0, 60), label: `${String(v.name || v.voice_id).slice(0, 40)}${desc ? ` (${desc})` : ''}`, category: v.category || '' };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    voiceCache = { at: Date.now(), voices };
    logger.log?.(`[tts] ElevenLabs: ${voices.length} voices on the account`);
    return voices;
  }

  return {
    name: 'elevenlabs',
    model: (m = null) => pickModel(m),
    synth,
    listVoices,
    configured: () => !!apiKey,
    status: () => ({ ...state }),
  };
}

module.exports = { createElevenLabsProvider, ElevenLabsError, pcm16ToFloat, clampSpeed, MODELS, DEFAULT_MODEL, VOICE_ID };
