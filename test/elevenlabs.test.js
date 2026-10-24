'use strict';
// ElevenLabs voices alongside Kokoro.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createElevenLabsProvider, pcm16ToFloat, clampSpeed } = require('../lib/tts/elevenlabs');
const { createTTS } = require('../lib/tts');
const { voiceFor } = require('../lib/audio/mixer');
const { tmpDir } = require('./helpers');

const VOICE = 'JBFqnCBsd6RMkjVDRZzb';

// PCM16 for n samples of a quiet ramp.
const pcm = n => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE((i % 200) * 50, i * 2); return b; };

function fakeApi(reply = () => ({ status: 200, body: pcm(2400) })) {
  const calls = [];
  const request = async r => { calls.push({ ...r, json: r.body ? JSON.parse(r.body) : null }); return reply(r); };
  return { calls, request };
}

test('ElevenLabs: request shape, PCM decoding and speed clamping', async () => {
  const api = fakeApi();
  let model = 'eleven_multilingual_v2';
  const el = createElevenLabsProvider({ apiKey: 'xi-test', getModel: () => model, request: api.request, logger: { log() {} } });
  const out = await el.synth('Stay Hypnotic.', VOICE, 1.3);
  assert.equal(out.sampleRate, 24000);
  assert.equal(out.samples.length, 2400);
  const c = api.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.path, `/v1/text-to-speech/${VOICE}?output_format=pcm_24000`);
  assert.equal(c.headers['xi-api-key'], 'xi-test');
  assert.equal(c.json.text, 'Stay Hypnotic.');
  assert.equal(c.json.model_id, 'eleven_multilingual_v2');
  assert.equal(c.json.voice_settings.speed, 1.2, 'speed clamped to ElevenLabs\' 0.7–1.2');
  assert.equal(c.json.voice_settings.stability, 0.4);

  await el.synth('Again.', VOICE, 0.5, 'eleven_flash_v2_5');
  assert.equal(api.calls[1].json.model_id, 'eleven_flash_v2_5');
  assert.equal(api.calls[1].json.voice_settings.speed, 0.7);
  assert.equal(el.model('not-a-model'), 'eleven_multilingual_v2', 'unknown models fall back to the Settings default');
  model = 'eleven_v4';
  assert.equal(el.model(), 'eleven_v4');

  const f = pcm16ToFloat(Buffer.from([0x00, 0x80, 0xff, 0x7f]));
  assert.equal(f[0], -1);
  assert.ok(Math.abs(f[1] - 32767 / 32768) < 1e-9);
  assert.equal(clampSpeed('x'), 1);
});

test('ElevenLabs: clear errors for a bad key, an empty account and bad voice ids', async () => {
  const quota = fakeApi(() => ({ status: 401, body: Buffer.from(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } })) }));
  const el = createElevenLabsProvider({ apiKey: 'xi-test', request: quota.request });
  await assert.rejects(el.synth('Hi.', VOICE), e => e.code === 'quota_exceeded' && /out of characters/.test(e.message));
  assert.equal(el.status().status, 'error');

  const bad = createElevenLabsProvider({ apiKey: 'xi-test', request: fakeApi(() => ({ status: 401, body: Buffer.from('{"detail":{"message":"Invalid API key"}}') })).request });
  await assert.rejects(bad.synth('Hi.', VOICE), /HTTP 401: Invalid API key\. Check ELEVENLABS_API_KEY/);

  const api = fakeApi();
  const ok = createElevenLabsProvider({ apiKey: 'xi-test', request: api.request });
  await assert.rejects(ok.synth('Hi.', '../../v1/user'), /not an ElevenLabs voice id/);
  assert.equal(api.calls.length, 0, 'a bad id never reaches the API');

  const none = createElevenLabsProvider({ apiKey: '' });
  assert.equal(none.configured(), false);
  await assert.rejects(none.synth('Hi.', VOICE), /ELEVENLABS_API_KEY/);
  assert.deepEqual(await none.listVoices(), []);
});

test('ElevenLabs: the account\'s voices are listed, labelled and cached', async () => {
  const api = fakeApi(() => ({ status: 200, body: Buffer.from(JSON.stringify({ voices: [
    { voice_id: VOICE, name: 'George', category: 'premade', labels: { accent: 'british', gender: 'male', age: 'middle aged' } },
    { voice_id: 'bad id', name: 'Broken' },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', labels: {} },
  ] })) }));
  const el = createElevenLabsProvider({ apiKey: 'xi-test', request: api.request, logger: { log() {} } });
  const voices = await el.listVoices();
  assert.deepEqual(voices.map(v => v.name), ['Bella', 'George']);
  assert.equal(voices[1].label, 'George (british, male, middle aged)');
  await el.listVoices();
  assert.equal(api.calls.length, 1, 'cached');
  await el.listVoices({ fresh: true });
  assert.equal(api.calls.length, 2);
});

test('TTS routing: eleven: voices go to ElevenLabs, are cached by model, and are counted', async () => {
  const api = fakeApi();
  let model = 'eleven_multilingual_v2';
  const eleven = createElevenLabsProvider({ apiKey: 'xi-test', getModel: () => model, request: api.request });
  const tts = createTTS({ provider: 'silent', cacheDir: tmpDir(), elevenlabs: eleven });

  const a = await tts.speak('Back in my day.', { voice: `eleven:${VOICE}`, speed: 1 });
  assert.equal(a.provider, 'elevenlabs');
  assert.equal(a.cached, false);
  assert.equal(a.samples.length, 2400);
  assert.equal(tts.usage().elevenlabsChars, 'Back in my day.'.length);

  const again = await tts.speak('Back in my day.', { voice: `eleven:${VOICE}`, speed: 1 });
  assert.equal(again.cached, true);
  assert.equal(api.calls.length, 1, 're-voicing a line costs nothing');
  assert.equal(tts.usage().elevenlabsChars, 15);

  await tts.speak('Back in my day.', { voice: `eleven:${VOICE}`, speed: 1, elevenModel: 'eleven_flash_v2_5' });
  assert.equal(api.calls[1].json.model_id, 'eleven_flash_v2_5');
  assert.equal(api.calls.length, 2, 'another model is another voice: no stale cache hit');

  const k = await tts.speak('The numbers do not lie.', { voice: 'bm_george', speed: 1 });
  assert.equal(k.provider, 'silent');
  assert.equal(api.calls.length, 2, 'Kokoro voices never touch ElevenLabs');
  assert.equal(tts.status().elevenlabs.configured, true);
});

test('mixer: an anchor uses ElevenLabs only when the engine is on and they have a voice', () => {
  const ray = { voice: 'am_onyx', elevenVoice: VOICE };
  const nate = { voice: 'bm_george' };
  assert.equal(voiceFor(ray, { voiceEngine: 'elevenlabs' }), `eleven:${VOICE}`);
  assert.equal(voiceFor(nate, { voiceEngine: 'elevenlabs' }), 'bm_george');
  assert.equal(voiceFor(ray, { voiceEngine: 'kokoro' }), 'am_onyx');
  assert.equal(voiceFor(ray, {}), 'am_onyx');
  assert.equal(voiceFor({}, {}), 'am_michael');
});

const { delivery } = require('../lib/tts/elevenlabs');
const { buildEpisodeAudio, GAP_HEATED, GAP_OTHER } = require('../lib/audio/mixer');

test('emotion delivery: v4 reads tags, every model gets per-emotion settings, neutral is untouched', () => {
  assert.deepEqual(delivery('suspicious', 'eleven_v4'), { tag: '[whispers]', settings: { stability: 0.35, style: 0.3 }, key: 'suspicious' });
  assert.deepEqual(delivery('excited', 'eleven_multilingual_v2'), { tag: '', settings: { stability: 0.3, style: 0.35 }, key: 'excited' }, 'no tags outside v4');
  assert.equal(delivery('angry', 'eleven_v4').tag, '', 'no documented tag: settings carry it');
  assert.deepEqual(delivery('neutral', 'eleven_v4'), { tag: '', settings: null, key: '' });
  assert.deepEqual(delivery(null, 'eleven_v4'), { tag: '', settings: null, key: '' });
});

test('ElevenLabs requests carry the emotion, and neutral lines keep their old cache entries', async () => {
  const api = fakeApi();
  const eleven = createElevenLabsProvider({ apiKey: 'xi-test', getModel: () => 'eleven_v4', request: api.request });
  const tts = createTTS({ provider: 'silent', cacheDir: tmpDir(), elevenlabs: eleven });
  const voice = `eleven:${VOICE}`;

  await tts.speak('Follow the red string.', { voice, emotion: 'suspicious' });
  assert.equal(api.calls[0].json.text, '[whispers] Follow the red string.');
  assert.equal(api.calls[0].json.voice_settings.stability, 0.35);
  assert.equal(api.calls[0].json.voice_settings.style, 0.3);
  assert.equal(tts.usage().elevenlabsChars, '[whispers] Follow the red string.'.length, 'the tag is billed too');

  await tts.speak('Back to you.', { voice, emotion: null });
  await tts.speak('Back to you.', { voice, emotion: 'neutral' });
  assert.equal(api.calls.length, 2, 'neutral and no emotion are the same line');
  assert.equal(api.calls[1].json.text, 'Back to you.');
  assert.equal(api.calls[1].json.voice_settings.stability, 0.4);

  await tts.speak('Back to you.', { voice, emotion: 'angry' });
  assert.equal(api.calls.length, 3, 'an angry read is a different line');
  assert.equal(api.calls[2].json.voice_settings.stability, 0.25);
});

test('mixer: heated back-and-forth is tighter and every line carries its emotion; the setting turns it off', async () => {
  const calls = [];
  const tts = { SAMPLE_RATE: 24000, speak: async (text, opts) => { calls.push(opts); return { samples: new Float32Array(24000).fill(0.1), synthetic: true }; } };
  const line = (speaker, emotion) => ({ speaker, text: 'A line.', emotion, gesture: 'none', shot: 'auto', card: '' });
  const script = { segments: [{ id: 's1', kind: 'debate', lines: [line('ray', 'angry'), line('nate', 'smug'), line('ray', 'neutral'), line('nate', 'neutral')] }] };
  const rundown = { type: 'weekly', segments: [{ id: 's1', kind: 'debate', set: 'desk' }] };
  const personas = { network: { name: 'HFL-NN' }, anchors: [{ id: 'ray', voice: 'am_onyx' }, { id: 'nate', voice: 'bm_george' }] };
  const gaps = out => out.lines.slice(1).map((l, i) => +(l.t0 - out.lines[i].t1).toFixed(2));

  const on = await buildEpisodeAudio({ script, rundown, personas, tts, settings: {} });
  assert.deepEqual(gaps(on), [GAP_HEATED, GAP_OTHER, GAP_OTHER], 'angry into smug is heated; the rest is normal pacing');
  assert.deepEqual(calls.map(c => c.emotion), ['angry', 'smug', 'neutral', 'neutral']);

  calls.length = 0;
  const off = await buildEpisodeAudio({ script, rundown, personas, tts, settings: { voiceEmotion: false } });
  assert.deepEqual(gaps(off), [GAP_OTHER, GAP_OTHER, GAP_OTHER]);
  assert.deepEqual(calls.map(c => c.emotion), [null, null, null, null]);
});
