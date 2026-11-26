'use strict';
// Today on HFL-NN (/today): every story that aired on a day, with its source.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { todayReport, replaysReport, sourceKind } = require('../lib/today');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const TZ = 'America/New_York';

test('sources are labelled by where they came from', () => {
  assert.equal(sourceKind('Madden export: Bears beat Lions'), 'export');
  assert.equal(sourceKind('HFL Hub: Trade deadline moved'), 'hub');
  assert.equal(sourceKind('League office: Owner change in Dallas'), 'office');
  assert.equal(sourceKind('The Crimson Chronicle: "Week 13" by W.'), 'chronicle');
});

test('the report holds the episodes first aired on the day, in league time, with each segment\'s sources', () => {
  const now = Date.parse('2026-11-26T15:00:00Z');   // 10:00 AM Eastern
  const eps = [
    { id: 'a', type: 'custom', channelShow: 'blitz', title: 'Blitz', publishedAt: '2026-11-26T12:00:00Z' },
    { id: 'late', type: 'weekly', title: 'Late last night', publishedAt: '2026-11-26T03:30:00Z' },   // 10:30 PM Nov 25 Eastern
    { id: 'gone', type: 'weekly', title: 'No manifest', publishedAt: '2026-11-26T13:00:00Z' },
  ];
  const manifests = {
    a: { title: 'Morning Blitz', duration: 300, segments: [
      { title: 'Scores', t0: 0, sources: [{ label: 'Madden export: Bears 24, Lions 17' }, { label: 'The Crimson Chronicle: "Week 13"', url: 'https://hub.example/chronicle/v3-issue-13' }] },
      { title: 'Hot takes', t0: 95.4, sources: [] },
    ] },
    late: { title: 'Tonight', segments: [{ title: 'Open', t0: 0, sources: [{ label: 'HFL Hub: Deadline', url: 'javascript:alert(1)' }] }] },
  };
  const r = todayReport({ episodes: eps, manifest: id => manifests[id] || null, now, timeZone: TZ, showTitles: { blitz: 'Morning Blitz' } });
  assert.equal(r.day, '2026-11-26');
  assert.equal(r.days.length, 7);
  assert.equal(r.days[6], '2026-11-20');
  assert.deepEqual(r.episodes.map(e => e.id), ['a'], 'yesterday evening in Eastern time is yesterday; no manifest, no entry');
  assert.equal(r.episodes[0].showTitle, 'Morning Blitz');
  assert.equal(r.episodes[0].segments[1].t0, 95);
  assert.deepEqual(r.episodes[0].segments[0].sources.map(s => s.kind), ['export', 'chronicle']);
  assert.deepEqual(r.totals, { export: 1, chronicle: 1, hub: 0, office: 0 });

  const y = todayReport({ episodes: eps, manifest: id => manifests[id] || null, day: '2026-11-25', now, timeZone: TZ });
  assert.deepEqual(y.episodes.map(e => e.id), ['late']);
  assert.equal(y.episodes[0].segments[0].sources[0].url, undefined, 'only http(s) links are kept');
  const far = todayReport({ episodes: eps, manifest: () => null, day: '2026-10-01', now, timeZone: TZ });
  assert.equal(far.day, '2026-11-26', 'a day outside the last week falls back to today');
});

test('replays: every segment from the last week, newest episode first, each opening at its start', () => {
  const now = Date.parse('2026-11-26T15:00:00Z');
  const eps = [
    { id: 'old', title: 'Too old', publishedAt: '2026-11-19T15:00:00Z' },
    { id: 'a', title: 'A', channelShow: 'blitz', publishedAt: '2026-11-24T15:00:00Z' },
    { id: 'b', title: 'B', publishedAt: '2026-11-26T12:00:00Z' },
  ];
  const manifests = {
    old: { title: 'Too old', duration: 60, segments: [{ title: 'X', t0: 0 }] },
    a: { title: 'A', duration: 200, segments: [{ title: 'Open', t0: 0, sources: [{ label: 'Madden export: Bears win' }] }, { title: 'Debate', t0: 80.7 }] },
    b: { title: 'B', duration: 50, segments: [{ title: 'Only', t0: 0 }] },
  };
  const r = replaysReport({ episodes: eps, manifest: id => manifests[id] || null, now, timeZone: TZ, showTitles: { blitz: 'Morning Blitz' } });
  assert.deepEqual(r.items.map(i => `${i.episodeId}:${i.title}`), ['b:Only', 'a:Open', 'a:Debate'], 'older than a week drops off');
  const debate = r.items.find(i => i.title === 'Debate');
  assert.equal(debate.t0, 80.7);
  assert.equal(debate.seconds, 119, 'runs to the end of the episode');
  assert.equal(r.items.find(i => i.title === 'Open').seconds, 81);
  assert.equal(debate.url, '/watch/a?at=80.7');
  assert.equal(debate.showTitle, 'Morning Blitz');
  assert.deepEqual(r.items.find(i => i.title === 'Open').sources, ['Madden export: Bears win']);
});

test('/today and /api/today serve what was published, and nothing from drafts', async () => {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { weeklyShow: 'hflnn', approveWeekly: false });
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of fixturePayloads()) ctx.ingest.ingest(p);
    await ctx.ingest.flush();
    await ctx.producer.idle();
    const ep = ctx.producer.list()[0];
    assert.ok(ep, 'the export made an episode');
    let r = await (await fetch(`${base}/api/today`)).json();
    assert.equal(r.episodes.filter(e => e.id === ep.id).length, 0, 'an unpublished episode is not listed');

    if (ctx.producer.get(ep.id).status !== 'published') await ctx.producer.publish(ep.id, { discord: false });
    r = await (await fetch(`${base}/api/today`)).json();
    const got = r.episodes.find(e => e.id === ep.id);
    assert.ok(got, 'the published episode is listed');
    assert.ok(got.segments.length > 0);
    assert.ok(got.segments.some(s => s.sources.some(x => x.kind === 'export')), 'export stories are credited');

    const rp = await (await fetch(`${base}/api/replays`)).json();
    const first = rp.items.find(i => i.episodeId === ep.id);
    assert.ok(first, 'the published episode has replays');
    assert.ok(first.url.startsWith(`/watch/${ep.id}?at=`) && /\?at=\d+(\.\d)?$/.test(first.url), first.url);
    assert.equal((await fetch(`${base}/replays`)).status, 200);
    assert.equal((await fetch(`${base}/js/replays.js`)).status, 200);

    const page = await fetch(`${base}/today`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\/js\/today\.js/);
    assert.equal((await fetch(`${base}/js/today.js`)).status, 200);
  } finally { server.close(); await ctx.close(); }
});
