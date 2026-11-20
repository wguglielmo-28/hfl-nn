'use strict';
// Importing an episode voiced outside HFL-NN (e.g. ElevenLabs takes): it
// arrives ready, publishes like any episode, and plays from its own MP3.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
// A few bytes that look like an MP3 frame header are all the server checks.
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400, 1)]);
const manifest = (over = {}) => ({
  id: '20261120-211534-custom', type: 'custom', phase: 'regular', title: 'The Wire: Test', summary: 'A test.', weekLabel: 'Week 13',
  duration: 12.5, audio: 'audio.mp3?v=1',
  lineup: [], segments: [{ id: 's1', kind: 'cold_open', t0: 0, t1: 12, title: 'Open', cards: [] }],
  lines: [
    { seg: 's1', i: 0, t0: 1, t1: 5, speaker: 'hal', text: 'Welcome to The Wire.', emotion: 'happy' },
    { seg: 's1', i: 1, t0: 5.3, t1: 11, speaker: 'sasha', text: 'Dallas wins again.', emotion: 'serious' },
  ],
  mouth: { fps: 30, data: '0123'.repeat(90) }, cues: [{ t: 0, type: 'theme' }], ticker: ['DAL 24 SEA 14 FINAL'],
  ...over,
});

async function boot() {
  const ctx = createApp({
    dataDir: tmpDir(), env: { ADMIN_PASSWORD: 'letmein', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet,
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } }, debounceMs: 1e9,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function req(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { 'X-HFLNN': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  await req('POST', '/api/login', { password: 'letmein' });
  return { ctx, req, base, close: async () => { server.close(); await ctx.close(); } };
}

test('import: a voiced episode arrives ready, publishes without side effects, and plays', async () => {
  const s = await boot();
  try {
    const r = await s.req('POST', '/api/admin/episodes/import', { manifest: manifest(), audio: MP3.toString('base64'), title: 'The Wire (ElevenLabs test)', source: 'elevenlabs' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ep = r.json;
    assert.match(ep.id, /^\d{8}-\d{6}-import$/);
    assert.equal(ep.status, 'ready');
    assert.equal(ep.imported.fromId, '20261120-211534-custom');
    assert.equal(ep.audio.provider, 'elevenlabs');
    assert.equal(ep.audio.bytes, MP3.length);

    // Not public until published.
    assert.equal((await s.req('GET', `/api/episodes/${ep.id}`)).status, 404);

    // It can't be voiced or rewritten: there is no script.
    assert.equal((await s.req('POST', `/api/admin/episodes/${ep.id}/voice`, {})).status, 400);
    assert.equal((await s.req('POST', `/api/admin/episodes/${ep.id}/rewrite`, {})).status, 400);

    const wireBefore = JSON.stringify(s.ctx.producer.wireStories());
    const pub = await s.req('POST', `/api/admin/episodes/${ep.id}/publish`, { discord: true });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.equal(pub.json.status, 'published');
    assert.ok(!pub.json.memoryApplied && !pub.json.discordPostedAt, 'no show memory, no Discord post');
    assert.equal(JSON.stringify(s.ctx.producer.wireStories()), wireBefore);

    const m = (await s.req('GET', `/api/episodes/${ep.id}`)).json;
    assert.equal(m.id, ep.id);
    assert.equal(m.title, 'The Wire (ElevenLabs test)');
    assert.equal(m.lines.length, 2);
    assert.equal(m.mouth.data.length, 360);
    assert.match(m.audio, /^audio\.mp3\?v=\d+$/);
    assert.ok(m.publishedAt);
    const audio = await fetch(`${s.base}/media/${ep.id}/audio.mp3`);
    assert.equal(audio.status, 200);
    assert.equal(Buffer.from(await audio.arrayBuffer()).length, MP3.length);
    assert.ok(s.ctx.producer.published().some(e => e.id === ep.id), 'listed with the published episodes');
  } finally { await s.close(); }
});

test('import: bad manifests and audio are refused with a reason', async () => {
  const s = await boot();
  try {
    const audio = MP3.toString('base64');
    const bad = async (body, re) => {
      const r = await s.req('POST', '/api/admin/episodes/import', body);
      assert.equal(r.status, 400);
      assert.match(r.json.error, re);
    };
    await bad({ audio }, /manifest/);
    await bad({ manifest: manifest({ lines: [] }), audio }, /no lines/);
    await bad({ manifest: manifest({ lines: [{ speaker: 'hal', text: 'x', t0: 5, t1: 2 }] }), audio }, /start\/end/);
    await bad({ manifest: manifest({ mouth: null }), audio }, /lip-sync/);
    await bad({ manifest: manifest({ duration: 0 }), audio }, /duration/);
    await bad({ manifest: manifest() }, /audio/);
    await bad({ manifest: manifest(), audio: Buffer.from('<html>not audio</html>').toString('base64') }, /MP3/);
    assert.equal(s.ctx.producer.list().length, 0, 'nothing half-imported');
    // Logged out: refused.
    const anon = await fetch(`${s.base}/api/admin/episodes/import`, { method: 'POST', headers: { 'X-HFLNN': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: manifest(), audio }) });
    assert.equal(anon.status, 401);
  } finally { await s.close(); }
});

test('import: two imports in the same second get different ids', () => {
  return boot().then(async s => {
    try {
      const a = s.ctx.producer.importEpisode({ manifest: manifest(), audio: MP3.toString('base64') });
      const b = s.ctx.producer.importEpisode({ manifest: manifest(), audio: MP3.toString('base64') });
      assert.notEqual(a.id, b.id);
      assert.equal(s.ctx.producer.list().length, 2);
    } finally { await s.close(); }
  });
});
