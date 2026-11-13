// The Hub's channel chat, shown read-only on HFL-NN's channel page: one
// cache for every viewer (the Hub is asked at most every few seconds),
// everything checked for shape, hidden messages taken back, reactions only
// ever new ones, and the last good answer kept when the Hub is down.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createAudience, hubOriginFrom } = require('../lib/ingest/audience');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const HUB = 'https://hub.example';

function fakeHub() {
  const hub = { calls: [], down: false, messages: [], reactions: [], hidden: [], crowd: 0, poll: null };
  hub.fetch = async url => {
    hub.calls.push(String(url));
    if (hub.down) return new Response('nope', { status: 503 });
    const u = new URL(url);
    const m = u.searchParams.has('m') ? Number(u.searchParams.get('m')) : null;
    const r = Number(u.searchParams.get('r') || 0);
    const body = {
      messages: m == null ? hub.messages.slice(-60) : hub.messages.filter(x => x.id > m),
      hidden: hub.hidden,
      reactions: m == null ? [] : hub.reactions.filter(x => x.id > r),
      crowd: hub.crowd, poll: hub.poll,
      lastMessage: Math.max(0, ...hub.messages.map(x => x.id)),
      lastReaction: Math.max(0, ...hub.reactions.map(x => x.id)),
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return hub;
}

test('audience: the Hub address comes from the Hub feed URL', () => {
  assert.equal(hubOriginFrom('https://hfl-hub-5kc.pages.dev/api/hfl-nn-feed'), 'https://hfl-hub-5kc.pages.dev');
  assert.equal(hubOriginFrom('', 'https://other.example/x'), 'https://other.example');
  assert.equal(hubOriginFrom('not a url'), '');
  assert.equal(hubOriginFrom(''), '');
});

test('audience: newest page first, then only what is new, for any number of viewers', async () => {
  const hub = fakeHub();
  let t = 1000;
  const a = createAudience({ getHubOrigin: () => HUB, fetchImpl: hub.fetch, now: () => t, logger: quiet });
  hub.messages = [{ id: 1, userId: 7, name: 'Anna', body: 'Chiefs by 20', at: '2026-11-13 18:00:00' }, { id: 2, name: 'Ben', body: 'Bills cover', at: '2026-11-13 18:00:05' }];
  hub.poll = { id: 3, question: 'Who wins?', options: ['Chiefs', 'Bills'], counts: [3, 1], open: true, closesAt: '2026-11-13 18:30:00', myVote: 1 };
  hub.crowd = 4;

  const first = await a.view();
  assert.equal(hub.calls[0], `${HUB}/api/hfl-nn/live`, 'a first read asks for the newest page');
  assert.deepEqual(first.messages.map(m => m.body), ['Chiefs by 20', 'Bills cover']);
  assert.equal(first.messages[0].userId, undefined, 'no Hub user ids on HFL-NN');
  assert.equal(first.joinUrl, `${HUB}/hfl-nn`);
  assert.deepEqual(first.poll, { id: 3, question: 'Who wins?', options: ['Chiefs', 'Bills'], counts: [3, 1], total: 4, open: true, closesAt: '2026-11-13 18:30:00' });
  assert.equal(first.crowd, 4);

  // Many viewers inside the refresh window: one Hub call.
  for (let i = 0; i < 20; i++) await a.view({ m: 2, r: 0 });
  assert.equal(hub.calls.length, 1);

  t += 3500;
  hub.messages.push({ id: 3, name: 'Cam', body: '<script>alert(1)</script>', at: '2026-11-13 18:01:00' });
  hub.reactions = [{ id: 10, emoji: '🔥' }, { id: 11, emoji: '🍕' }, { id: 12, emoji: '😂' }];
  const next = await a.view({ m: 2, r: 0 });
  assert.equal(hub.calls[1], `${HUB}/api/hfl-nn/live?m=2&r=0`);
  assert.deepEqual(next.messages.map(m => m.body), ['<script>alert(1)</script>'], 'kept as text; the page never renders it as markup');
  assert.deepEqual(next.reactions.map(r => r.emoji), ['🔥', '😂'], "only the Hub's own emoji");
  // A viewer who has seen those gets nothing again.
  const seen = await a.view({ m: next.lastMessage, r: next.lastReaction });
  assert.deepEqual([seen.messages, seen.reactions], [[], []]);

  // A message a commissioner hid disappears for everyone.
  t += 3500;
  hub.hidden = [1];
  const after = await a.view({ m: 3, r: 12 });
  assert.deepEqual(after.hidden, [1]);
  assert.ok(!(await a.view()).messages.some(m => m.id === 1));
});

test('audience: the Hub being down keeps the last answer, marked stale; no Hub, no audience', async () => {
  const hub = fakeHub();
  let t = 0;
  const a = createAudience({ getHubOrigin: () => HUB, fetchImpl: hub.fetch, now: () => t, logger: quiet });
  hub.messages = [{ id: 5, name: 'Anna', body: 'hello', at: '2026-11-13 18:00:00' }];
  await a.view();
  t += 5000;
  hub.down = true;
  const v = await a.view({ m: 5, r: 0 });
  assert.equal(v.stale, true);
  assert.deepEqual((await a.view()).messages.map(m => m.body), ['hello']);
  assert.match(a.status().error, /503/);

  const none = createAudience({ getHubOrigin: () => '', fetchImpl: hub.fetch, logger: quiet });
  assert.deepEqual(await none.view(), { on: false });
});

test("server: /api/audience serves the Hub chat from the Hub feed URL's site", async () => {
  const hub = fakeHub();
  hub.messages = [{ id: 1, name: 'Anna', body: 'on air!', at: '2026-11-13 18:00:00' }];
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { hubFeedUrl: `${HUB}/api/hfl-nn-feed` });
  const ctx = createApp({ dataDir, env: { ADMIN_PASSWORD: 'x', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet, fetchImpl: hub.fetch });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/audience`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await r.json();
    assert.deepEqual([body.on, body.messages[0].body, body.joinUrl], [true, 'on air!', `${HUB}/hfl-nn`]);
    assert.ok(hub.calls.some(c => c.startsWith(`${HUB}/api/hfl-nn/live`)));
  } finally { server.close(); await ctx.close(); }
});
