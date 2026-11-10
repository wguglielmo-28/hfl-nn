// The 24/7 channel (lib/channel): the programme covers every day exactly, is
// the same for everyone, keeps what is on air when the library changes, and
// the server tells the player what is on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildDay, blockAt, validateConfig } = require('../lib/channel/programme');
const { createChannel, splice } = require('../lib/channel/plan');
const { dayKey, dayStart, nextDay, wallToMs } = require('../lib/channel/clock');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers');

const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'channel.json'), 'utf8')));
const TZ = config.timeZone;
const quiet = { log() {}, warn() {}, error() {} };

const ep = (id, type, duration, publishedAt) => ({ id, type, duration, publishedAt, title: `Show ${id}`, status: 'published' });
const LIBRARY = [
  ep('w3', 'weekly', 412.4, '2026-11-08T03:00:00Z'),
  ep('w2', 'weekly', 380.2, '2026-11-01T03:00:00Z'),
  ep('w1', 'weekly', 395.9, '2026-10-25T03:00:00Z'),
  ep('b2', 'breaking', 71.3, '2026-11-07T15:00:00Z'),
  ep('b1', 'breaking', 64.8, '2026-11-03T15:00:00Z'),
  ep('p1', 'premiere', 244.0, '2026-10-04T15:00:00Z'),
];

// Every block starts where the last one ended, from midnight to midnight.
function assertCovers(blocks, day) {
  assert.ok(blocks.length, 'the day has blocks');
  assert.equal(blocks[0].from, dayStart(day, TZ), 'starts at local midnight');
  assert.equal(blocks.at(-1).until, dayStart(nextDay(day), TZ), 'ends at the next local midnight');
  blocks.forEach((b, i) => {
    assert.ok(b.until > b.from, `block ${i} has length`);
    if (i) assert.equal(b.from, blocks[i - 1].until, `block ${i} starts where ${i - 1} ended`);
  });
  assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length, 'ids are unique');
}

test('clock: wall-clock times land on the right instant across daylight saving', () => {
  assert.equal(new Date(wallToMs('2026-07-01', '20:00', TZ)).toISOString(), '2026-07-02T00:00:00.000Z');   // EDT
  assert.equal(new Date(wallToMs('2026-12-01', '20:00', TZ)).toISOString(), '2026-12-02T01:00:00.000Z');   // EST
  assert.equal(dayKey(Date.parse('2026-11-09T04:59:59Z'), TZ), '2026-11-08');
  assert.equal(dayKey(Date.parse('2026-11-09T05:00:00Z'), TZ), '2026-11-09');
  assert.equal((dayStart('2026-11-02', TZ) - dayStart('2026-11-01', TZ)) / 3600000, 25, 'the autumn change makes a 25-hour day');
  assert.equal((dayStart('2026-03-09', TZ) - dayStart('2026-03-08', TZ)) / 3600000, 23, 'the spring change makes a 23-hour day');
});

test('programme: covers ordinary and clock-change days with no gaps or overlaps', () => {
  for (const day of ['2026-11-09', '2026-11-01', '2026-03-08', '2026-12-31']) {
    assertCovers(buildDay({ day, config, episodes: LIBRARY }), day);
  }
});

test('programme: the same inputs give the same day, whatever order the library is in', () => {
  const a = buildDay({ day: '2026-11-09', config, episodes: LIBRARY });
  const b = buildDay({ day: '2026-11-09', config, episodes: [...LIBRARY].reverse() });
  assert.deepEqual(a, b);
  const other = buildDay({ day: '2026-11-10', config, episodes: LIBRARY });
  assert.notDeepEqual(a.map(x => x.episodeId), other.map(x => x.episodeId), 'the vault rotates from day to day');
});

test('programme: shows air their own kind, fit their slot and start on tidy boundaries', () => {
  const day = '2026-11-09';
  const blocks = buildDay({ day, config, episodes: LIBRARY });
  const byId = Object.fromEntries(LIBRARY.map(e => [e.id, e]));
  const eps = blocks.filter(b => b.kind === 'episode');
  assert.ok(eps.length > 50, 'a full day of programmes');
  for (const b of eps) {
    const show = config.shows[b.show];
    assert.ok(show.types.includes('*') || show.types.includes(b.type), `${b.show} airs ${b.type}`);
    assert.equal(b.until - b.from, Math.ceil(byId[b.episodeId].duration * 1000), 'a block is as long as its episode');
    assert.equal((b.from - dayStart(day, TZ)) % (config.alignMinutes * 60000), 0, 'starts on a 5-minute boundary');
  }
  const at8 = blockAt(blocks, wallToMs(day, '20:00', TZ));
  assert.equal(at8.show, 'tonight');
  assert.equal(at8.episodeId, 'w3', 'prime time leads with the newest flagship');
  assert.equal(blockAt(blocks, wallToMs(day, '09:00', TZ)).episodeId, 'b2', 'The Wire leads with the newest bulletin');
  // A slot airs its own episodes once each, then fills from the vault.
  const wireHour = eps.filter(b => b.from >= wallToMs(day, '09:00', TZ) && b.from < wallToMs(day, '10:00', TZ));
  assert.deepEqual(wireHour.slice(0, 2).map(b => [b.show, b.episodeId]), [['wire', 'b2'], ['wire', 'b1']]);
  assert.ok(wireHour.length > 4 && wireHour.slice(2).some(b => b.show === 'vault'), 'the rest of the hour is the vault');
  // Nothing airs twice in a row while there is something else to show.
  eps.forEach((b, i) => { if (i && eps[i - 1].show === b.show && eps[i - 1].until > b.from - 5 * 60000) assert.notEqual(b.episodeId, eps[i - 1].episodeId); });
});

test('programme: only the first airing of a new episode is not an encore', () => {
  const day = '2026-11-08';   // w3 was published the evening of the 7th (ET)
  const airings = buildDay({ day, config, episodes: LIBRARY }).filter(b => b.episodeId === 'w3');
  assert.ok(airings.length > 1);
  assert.equal(airings[0].rerun, false);
  assert.ok(airings.slice(1).every(b => b.rerun));
  assert.ok(buildDay({ day: '2026-11-20', config, episodes: LIBRARY }).filter(b => b.episodeId === 'w3').every(b => b.rerun));
});

test('programme: an empty library is all stand-by, one episode loops, and unvoiced episodes never air', () => {
  const day = '2026-11-09';
  const empty = buildDay({ day, config, episodes: [] });
  assertCovers(empty, day);
  assert.ok(empty.every(b => b.kind === 'standby'));

  const one = buildDay({ day, config, episodes: [LIBRARY[0], ep('x', 'weekly', 0, '2026-11-09T00:00:00Z'), ep('y', 'weekly', null, '2026-11-09T00:00:00Z')] });
  assertCovers(one, day);
  assert.ok(one.filter(b => b.kind === 'episode').every(b => b.episodeId === 'w3'));
  assert.ok(one.some(b => b.kind === 'ident'));

  // Longer than any slot: it can never air, and the day still holds together.
  assertCovers(buildDay({ day, config, episodes: [ep('long', 'weekly', 30 * 3600, '2026-11-09T00:00:00Z')] }), day);
});

test('programme: a bad grid is refused', () => {
  assert.throws(() => validateConfig({ ...config, grid: [{ at: '06:00', show: 'vault' }] }), /first slot/);
  assert.throws(() => validateConfig({ ...config, grid: [{ at: '00:00', show: 'nope' }] }), /unknown show/);
  assert.throws(() => validateConfig({ ...config, grid: [{ at: '00:00', show: 'vault' }, { at: '00:00', show: 'wire' }] }), /time order/);
});

test('plan: a new episode changes the rest of the day but not what is on air', () => {
  const day = '2026-11-09';
  const now = wallToMs(day, '13:02', TZ);
  const before = buildDay({ day, config, episodes: LIBRARY });
  const fresh = buildDay({ day, config, episodes: [ep('w4', 'weekly', 300, '2026-11-09T17:00:00Z'), ...LIBRARY] });
  const merged = splice(before, fresh, now);
  assertCovers(merged, day);
  const onAir = blockAt(before, now);
  assert.deepEqual({ ...blockAt(merged, now), id: 0 }, { ...onAir, id: 0 }, 'the block on air is untouched');
  assert.deepEqual(merged.filter(b => b.until <= now).map(b => b.episodeId), before.filter(b => b.until <= now).map(b => b.episodeId), 'the past is untouched');
  assert.equal(blockAt(merged, wallToMs(day, '20:00', TZ)).episodeId, 'w4', 'tonight leads with the new show');
  // It was published at noon: nothing before then, the first airing after
  // the join is the premiere, and every later one is an encore.
  const airings = merged.filter(b => b.episodeId === 'w4');
  assert.ok(airings[0].from >= blockAt(merged, now).until);
  assert.deepEqual(airings.map(b => b.rerun), [false, ...airings.slice(1).map(() => true)]);
  assert.ok(fresh.filter(b => b.episodeId === 'w4').every(b => b.from >= Date.parse('2026-11-09T17:00:00Z')));
});

test('plan: today is saved and survives a restart; other days are never written', () => {
  const store = createStore(tmpDir());
  const day = '2026-11-09';
  // A moment in the middle of the first programme after 1 PM.
  const mid = buildDay({ day, config, episodes: LIBRARY }).find(b => b.kind === 'episode' && b.from >= wallToMs(day, '13:00', TZ));
  let t = mid.from + 60000;
  let library = LIBRARY;
  const make = () => createChannel({ store, config, getEpisodes: () => library, now: () => t, logger: quiet });

  const first = make().guide();
  assert.equal(first.day, day);
  assert.equal(first.onNow.kind, 'episode');
  assert.ok(first.onNow.from <= t && t < first.onNow.until);
  assert.ok(first.upNext.from > t);
  assert.ok(first.blocks.at(-1).from < t + 6 * 3600000 && first.blocks.at(-1).from > t + 5 * 3600000, 'six hours ahead');
  assert.deepEqual(store.list('channel').filter(f => !f.endsWith('.bak')), [`plan-${day}.json`]);

  // A restart mid-show with a bigger library keeps the show on air.
  library = [ep('w4', 'weekly', 300, '2026-11-09T17:00:00Z'), ...LIBRARY];
  const second = make().guide();
  assert.equal(second.onNow.episodeId, first.onNow.episodeId);
  assert.equal(second.onNow.from, first.onNow.from);
  assert.ok(second.blocks.some(b => b.episodeId === 'w4'));

  // Looking at other days computes them without saving anything.
  const ch = make();
  assert.equal(ch.guide(wallToMs('2026-12-25', '20:00', TZ)).onNow.show, 'tonight');
  assert.equal(ch.listings(wallToMs('2026-12-25', '20:00', TZ)).day, '2026-12-25');
  assert.deepEqual(store.list('channel').filter(f => !f.endsWith('.bak')), [`plan-${day}.json`]);

  // Old plans are cleared out as the days pass.
  for (let i = 1; i <= 6; i++) { t = wallToMs(nextDay(day, i), '12:00', TZ); make().guide(); }
  const kept = store.list('channel').filter(f => !f.endsWith('.bak'));
  assert.ok(kept.length <= 5 && kept.includes(`plan-${nextDay(day, 6)}.json`) && !kept.includes(`plan-${day}.json`), kept.join(','));
});

// ── Over HTTP ──────────────────────────────────────────────────────────────
async function boot() {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false });
  const ctx = createApp({
    dataDir,
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000,
    logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ctx, get: p => fetch(base + p), close: async () => { server.close(); await ctx.close(); } };
}

test('server: /api/channel is stand-by with nothing published, then airs the first show', async () => {
  const s = await boot();
  try {
    let r = await s.get('/api/channel');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    let g = await r.json();
    assert.equal(g.onNow.kind, 'standby');
    assert.equal(g.upNext, null);
    assert.ok(Math.abs(g.now - Date.now()) < 5000);

    await s.ctx.loadSampleLeague();
    const made = s.ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
    await s.ctx.producer.idle();
    s.ctx.producer.voice(made.id);
    await s.ctx.producer.idle();
    g = await (await s.get('/api/channel')).json();
    assert.equal(g.upNext, null, 'a voiced draft is not on the channel');
    await s.ctx.producer.publish(made.id, { discord: false });

    g = await (await s.get('/api/channel')).json();
    assert.ok(g.upNext, 'the published show is scheduled');
    assert.equal(g.upNext.episodeId, made.id);
    assert.equal(g.upNext.rerun, false);
    assert.ok((await s.get(`/api/episodes/${g.upNext.episodeId}`)).ok, 'the player can load what is scheduled');

    // Tomorrow at 8 PM it is on, as an encore.
    const at = wallToMs(nextDay(g.day, 2), '20:00', TZ) + 5000;
    const later = await (await s.get(`/api/channel?at=${at}`)).json();
    assert.equal(later.now, at);
    assert.equal(later.onNow.episodeId, made.id);
    assert.equal(later.onNow.show, 'tonight');
    assert.equal(later.onNow.rerun, true);

    const list = await (await s.get(`/api/channel/listings?at=${at}`)).json();
    assert.ok(list.blocks.length > 10 && list.blocks.every(b => b.kind === 'episode'));
    assert.equal((await s.get('/api/channel?at=banana')).status, 200, 'a bad ?at= is ignored');
  } finally { await s.close(); }
});

test('server: /embed/channel always answers and may be framed by the Hub', async () => {
  const s = await boot();
  try {
    const r = await s.get('/embed/channel');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /\/js\/embed-channel\.js/);
    assert.equal(r.headers.get('x-frame-options'), null);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/hfl-hub-5kc\.pages\.dev/);
    assert.match(await (await s.get('/')).text(), /id="listings"/);
  } finally { await s.close(); }
});
