'use strict';
// Production never voices an episode silently, and every voicing gets its own
// audio address so browsers don't keep playing an old, cached file.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

async function app(env) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { weeklyShow: 'hflnn',  approveWeekly: false });
  const ctx = createApp({
    dataDir,
    env: { ADMIN_PASSWORD: 'x', INGEST_KEY: 'k', FORCE_HTTPS: '0', ...env },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 1e9,
    logger: quiet,
  });
  for (const p of fixturePayloads()) ctx.ingest.ingest(p);
  await ctx.ingest.flush();
  await ctx.producer.idle();
  return ctx;
}

test('in production, a server without voices refuses to voice instead of making a mute episode', async () => {
  const ctx = await app({ NODE_ENV: 'production' });
  try {
    const ep = ctx.producer.get(ctx.producer.list()[0].id);
    assert.equal(ep.audio, null, 'the automatic weekly was written but not voiced');
    const job = ctx.producer.jobs().find(j => j.kind === 'voice');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /voices are not available on the server/);
    assert.notEqual(ep.status, 'voicing');
  } finally { await ctx.close(); }
});

test('TTS_PROVIDER=silent, and tests and demos, still voice silently on purpose', async () => {
  for (const env of [{ NODE_ENV: 'production', TTS_PROVIDER: 'silent' }, { NODE_ENV: 'test' }]) {
    const ctx = await app(env);
    try {
      assert.ok(ctx.producer.get(ctx.producer.list()[0].id).audio, JSON.stringify(env));
    } finally { await ctx.close(); }
  }
});

test('the manifest points at a versioned audio address, and the media route serves it', async () => {
  const ctx = await app({ NODE_ENV: 'test' });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  try {
    const id = ctx.producer.list()[0].id;
    await ctx.producer.publish(id, { discord: false });
    const ep = ctx.producer.get(id);
    const m = ctx.producer.manifest(id);
    assert.equal(m.audio, `${ep.audio.file}?v=${Date.parse(ep.audio.voicedAt)}`);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/media/${id}/${m.audio}`);
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  } finally { server.close(); await ctx.close(); }
});
