'use strict';
// The program guide (/shows) and the anchor pages (/anchors).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { showsReport, castReport, showKind } = require('../lib/cast');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const channel = require('../config/channel.json');
const show = require('../config/show.json');
const personas = require('../config/personas.json');
const talkCfg = require('../config/talk.json');
const talk = { network: talkCfg.network, anchors: talkCfg.anchors };

test('every show is listed with its kind, slots and cast, in grid order', () => {
  const r = showsReport({ config: channel, segments: show.segments, network: personas, talk, timeZone: 'America/New_York' });
  assert.equal(r.shows.length, Object.keys(channel.shows).length);
  const by = Object.fromEntries(r.shows.map(s => [s.id, s]));
  assert.equal(by.tonight.kind, 'live');
  assert.deepEqual(by.tonight.airs, ['07:30', '12:00', '20:00']);
  assert.deepEqual(by.tonight.newAt, ['20:00']);
  assert.ok(by.tonight.cast.includes('hal') && by.tonight.cast.includes('sasha'));
  assert.ok(!by.tonight.segments.includes('Sign-off') && by.tonight.segments.length > 3, 'segment titles, no sign-off');
  assert.equal(by.fifthq.kind, 'talk');
  assert.deepEqual(by.fifthq.cast, talk.anchors.map(a => a.id), 'the talk show has its own cast');
  assert.equal(by.vault.kind, 'rerun');
  assert.deepEqual(by.vault.cast, []);
  assert.equal(by.rewind.kind, 'replay');
  assert.equal(by.checkin.kind, 'cutin');
  assert.deepEqual(by.checkin.airs, []);
  assert.equal(r.shows[0].id, 'vault', 'midnight first');
  assert.equal(r.shows.at(-1).id, 'checkin', 'shows off the grid go last');
  assert.equal(r.grid.length, channel.grid.length);
});

test('a show kind is read from its config', () => {
  assert.equal(showKind('x', { kind: 'clips' }), 'clips');
  assert.equal(showKind('x', { types: ['talk'] }), 'talk');
  assert.equal(showKind('x', { types: [], produce: {} }), 'live');
});

test('each anchor gets a bio, mood, receipts, relationships and their latest aired takes', () => {
  const memory = {
    moods: { ray: { mood: 'fired up' } },
    scoreboard: { ray: { won: 3, lost: 1, right: 2, wrong: 4 } },
    relationships: [
      { a: 'ray', b: 'nate', kind: 'rivalry', heat: 8, note: 'eye test vs analytics' },
      { a: 'hal', b: 'ray', kind: 'needling', heat: 4, note: '' },
      { a: 'ray', b: 'ghost', kind: 'grudge', heat: 9, note: 'not in the cast' },
    ],
    quotes: [1, 2, 3, 4].map(i => ({ persona: 'ray', text: `take ${i}`, title: `Ep ${i}`, episodeId: `e${i}` })).concat([{ persona: 'nate', text: 'numbers' }]),
  };
  const shows = showsReport({ config: channel, segments: show.segments, network: personas, talk }).shows;
  const r = castReport({ network: personas, talk, memory, shows });
  assert.deepEqual(r.groups.map(g => g.id), ['network', 'talk']);
  const ray = r.groups[0].anchors.find(a => a.id === 'ray');
  assert.equal(ray.mood, 'fired up');
  assert.deepEqual(ray.receipts, { won: 3, lost: 1, right: 2, wrong: 4 });
  assert.deepEqual(ray.relationships.map(x => x.with), ['nate', 'hal'], 'hottest first; unknown anchors left out');
  assert.equal(ray.relationships[0].withName, personas.anchors.find(a => a.id === 'nate').name);
  assert.deepEqual(ray.quotes.map(q => q.text), ['take 4', 'take 3', 'take 2'], 'the last three, newest first');
  assert.ok(ray.lines.length > 0 && ray.look);
  assert.ok(ray.shows.some(s => s.id === 'tonight'));
  const boomer = r.groups[1].anchors[0];
  assert.deepEqual(boomer.receipts, { won: 0, lost: 0, right: 0, wrong: 0 });
  assert.equal(boomer.mood, null);
  assert.ok(boomer.lines.length > 0, 'talk anchors show their sample lines');
  assert.deepEqual(boomer.shows.map(s => s.id), ['fifthq']);
  assert.equal(boomer.style, undefined, 'writer directions stay private');
});

test('/shows, /anchors and their APIs are public', async () => {
  const ctx = createApp({
    dataDir: tmpDir(), env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await (await fetch(`${base}/api/shows`)).json();
    assert.ok(s.shows.find(x => x.id === 'fifthq'));
    const a = await (await fetch(`${base}/api/anchors`)).json();
    assert.equal(a.groups.length, 2);
    assert.ok(a.groups[0].anchors.find(x => x.id === 'hal'));
    for (const p of ['/shows', '/anchors']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>HFL-NN/);
    }
  } finally {
    server.close();
    await ctx.close?.();
  }
});
