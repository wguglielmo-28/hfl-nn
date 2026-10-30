// The HFL Hub contract (docs/embed.md): /embed/* may be framed by the Hub,
// nothing else may, /media plays cross-origin, and the episode list carries
// what the Hub needs to build its links.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

async function boot(env = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false });
  const ctx = createApp({
    dataDir,
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test', ...env },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000,
    logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  return { ctx, get, close: async () => { server.close(); await ctx.close(); } };
}

// A voiced weekly show from the sample league; published unless told not to.
async function episode(ctx, { publish = true } = {}) {
  await ctx.loadSampleLeague();
  const ep = ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
  await ctx.producer.idle();
  ctx.producer.voice(ep.id);
  await ctx.producer.idle();
  if (publish) await ctx.producer.publish(ep.id, { discord: false });
  return ctx.producer.get(ep.id);
}

const frameAncestors = res => (res.headers.get('content-security-policy') || '').split(';').map(s => s.trim()).find(s => s.startsWith('frame-ancestors'));

test('embed: unpublished episodes 404, published ones are framable by the Hub only', async () => {
  const s = await boot();
  try {
    const ep = await episode(s.ctx, { publish: false });
    let r = await s.get(`/embed/${ep.id}`);
    assert.equal(r.status, 404, 'a draft is not embeddable');
    assert.equal((await s.get('/embed/nope-nope')).status, 404);

    await s.ctx.producer.publish(ep.id, { discord: false });
    r = await s.get(`/embed/${ep.id}`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /\/js\/embed\.js/);
    assert.equal(r.headers.get('x-frame-options'), null, 'no X-Frame-Options on /embed');
    assert.equal(frameAncestors(r), "frame-ancestors 'self' https://hfl-hub-5kc.pages.dev https://*.hfl-hub-5kc.pages.dev");

    r = await s.get('/embed/latest');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-frame-options'), null);
    assert.match(frameAncestors(r), /hfl-hub-5kc\.pages\.dev/);
  } finally { await s.close(); }
});

test('embed: /embed/latest answers 200 with nothing published, so the Hub can probe it', async () => {
  const s = await boot();
  try {
    const r = await s.get('/embed/latest');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-frame-options'), null);
  } finally { await s.close(); }
});

test('embed: EMBED_ORIGINS replaces the default Hub origins', async () => {
  const s = await boot({ EMBED_ORIGINS: 'https://hub.example.com, https://other.example.com' });
  try {
    const r = await s.get('/embed/latest');
    assert.equal(frameAncestors(r), "frame-ancestors 'self' https://hub.example.com https://other.example.com");
  } finally { await s.close(); }
});

test('embed: every other page still refuses to be framed', async () => {
  const s = await boot();
  try {
    for (const p of ['/', '/control', '/watch/nope-nope', '/embed.html', '/js/embed.js', '/api/episodes']) {
      const r = await s.get(p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(frameAncestors(r), "frame-ancestors 'none'", p);
    }
  } finally { await s.close(); }
});

test('embed: /media plays cross-origin and the list carries phase and audioFile', async () => {
  const s = await boot();
  try {
    const ep = await episode(s.ctx);
    const list = await (await s.get('/api/episodes')).json();
    assert.equal(list[0].id, ep.id);
    assert.equal(list[0].phase, ep.phase);
    assert.ok(list[0].phase, 'phase is set');
    assert.equal(list[0].audioFile, ep.audio.file);

    let r = await s.get(`/media/${ep.id}/${list[0].audioFile}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    await r.arrayBuffer();
    // An <audio> element asks for ranges; still cross-origin.
    r = await s.get(`/media/${ep.id}/${list[0].audioFile}`, { Range: 'bytes=0-99' });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    await r.arrayBuffer();
    // Everything else keeps Helmet's same-origin default.
    r = await s.get('/');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  } finally { await s.close(); }
});

test('embed: the list falls back to the episode file for indexes without audioFile', async () => {
  const s = await boot();
  try {
    const ep = await episode(s.ctx);
    const index = s.ctx.store.readJSON('episodes/index.json', []);
    assert.ok(index.find(e => e.id === ep.id).audioFile, 'new summaries carry audioFile');
    // Simulate an index written before this change, reloaded on restart.
    s.ctx.store.writeJSON('episodes/index.json', index.map(({ audioFile, ...e }) => e));
    const ctx3 = createApp({
      dataDir: s.ctx.store.dir,
      env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
      tts: createTTS({ provider: 'silent' }), logger: quiet,
    });
    const server = http.createServer(ctx3.app);
    await new Promise(r => server.listen(0, r));
    try {
      const list = await (await fetch(`http://127.0.0.1:${server.address().port}/api/episodes`)).json();
      assert.equal(list[0].audioFile, ep.audio.file);
    } finally { server.close(); await ctx3.close(); }
  } finally { await s.close(); }
});
