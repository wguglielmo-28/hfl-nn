// Game footage on the channel: the Hub's streams feed is checked before any
// of it reaches a player address, replays and clips take their slots in the
// programme, and a live league game is offered as a cut-in.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildDay, blockAt, validateConfig } = require('../lib/channel/programme');
const { createChannel } = require('../lib/channel/plan');
const { dayStart, nextDay, wallToMs } = require('../lib/channel/clock');
const { createStreamsSource, normalizeStreams, streamsUrlFrom } = require('../lib/ingest/streams');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers');

const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'channel.json'), 'utf8')));
const TZ = config.timeZone;
const quiet = { log() {}, warn() {}, error() {} };
const DAY = '2026-11-09';

const game = (away, home, extra = {}) => ({ pk: 500, season: 9, stage: 'reg', week: 6, away, home, awayName: away + 's', homeName: home + 's', awayScore: 17, homeScore: 24, gotw: false, ...extra });
const FEED = {
  version: 1,
  live: [
    { id: 1, platform: 'twitch', member: 'MIA GM', channel: 'MiaFins', videoId: null, title: 'wk 7', startedAt: '2026-11-09T20:10:00Z', endedAt: null, game: game('MIA', 'NYJ') },
    { id: 2, platform: 'youtube', member: 'KC GM', channel: null, videoId: 'kcgame00001', title: 'GOTW', startedAt: '2026-11-09T20:20:00Z', endedAt: null, game: game('DEN', 'KC', { gotw: true }) },
  ],
  replays: [
    {
      id: 3, platform: 'twitch', member: 'NE GM', channel: 'nepats', videoId: '777', title: 'Wk 6 @ BUF', startedAt: '2026-11-07T01:00:00Z', endedAt: '2026-11-07T02:20:00Z',
      duration: 4800, replayExpiresAt: '2026-11-21T01:00:00Z', game: game('NE', 'BUF'),
      clips: [
        { id: 'GreatCatch-abc123', title: 'What a catch', creator: 'fan1', duration: 28.5, views: 40, createdAt: '2026-11-07T01:40:00Z' },
        { id: 'PickSix-def456', title: '', creator: 'fan2', duration: 15, views: 90, createdAt: '2026-11-07T02:00:00Z' },
      ],
    },
    { id: 4, platform: 'youtube', member: 'BUF GM', channel: null, videoId: 'bufgame0001', title: 'NE at BUF', startedAt: '2026-11-07T01:05:00Z', endedAt: '2026-11-07T02:30:00Z', duration: 5100, replayExpiresAt: null, game: game('NE', 'BUF'), clips: [] },
  ],
};

function assertCovers(blocks, day) {
  assert.equal(blocks[0].from, dayStart(day, TZ));
  assert.equal(blocks.at(-1).until, dayStart(nextDay(day), TZ));
  blocks.forEach((b, i) => { assert.ok(b.until > b.from); if (i) assert.equal(b.from, blocks[i - 1].until); });
}

test('streams feed: only well-formed streams of league games get through', () => {
  const ok = normalizeStreams(FEED);
  assert.deepEqual(ok.live.map(s => s.id), ['youtube:kcgame00001', 'twitch:miafins'], 'Game of the Week first; Twitch login lower-cased');
  assert.deepEqual(ok.replays.map(s => s.id), ['youtube:bufgame0001', 'twitch:777']);
  assert.equal(ok.replays[1].clips.length, 2);
  assert.equal(ok.replays[0].clips.length, 0);

  const bad = normalizeStreams({
    live: [
      { ...FEED.live[0], channel: 'evil"><script>' },                       // not a Twitch login
      { ...FEED.live[1], videoId: 'x" onload="alert(1)' },                   // not a YouTube id
      { ...FEED.live[0], game: null },                                       // not a league game
      { ...FEED.live[0], platform: 'kick' },
      { ...FEED.live[0], startedAt: 'yesterday-ish' },
    ],
    replays: [
      { ...FEED.replays[0], videoId: '777/../../x' },
      { ...FEED.replays[0], videoId: '778', endedAt: null, duration: 0 },    // no length
      { ...FEED.replays[0], videoId: '779', clips: [{ id: 'a b', duration: 10 }, { id: 'ok-1', duration: 1 }, { id: 'ok-2', duration: 20, title: 'x'.repeat(500) }] },
      FEED.replays[0], FEED.replays[0],                                      // duplicates collapse
    ],
  });
  assert.deepEqual(bad.live, []);
  assert.deepEqual(bad.replays.map(s => s.videoId), ['777', '779']);
  const clips = bad.replays.find(s => s.videoId === '779').clips;
  assert.deepEqual(clips.map(c => c.id), ['ok-2'], 'bad slugs and blink-length clips are dropped');
  assert.equal(clips[0].title.length, 100);
  assert.throws(() => normalizeStreams('nope'), /JSON object/);
  assert.deepEqual(normalizeStreams({}), { live: [], replays: [] });
});

test('streams feed: the URL sits beside the Hub feed, and an old answer stops counting as live', async () => {
  assert.equal(streamsUrlFrom('https://hub.example/api/hfl-nn-feed'), 'https://hub.example/api/hfl-nn-streams');
  assert.equal(streamsUrlFrom('https://hub.example/api/hfl-nn-feed/', ''), 'https://hub.example/api/hfl-nn-streams');
  assert.equal(streamsUrlFrom('https://hub.example/some/other/feed.json'), '');
  assert.equal(streamsUrlFrom('', ''), '');
  assert.equal(streamsUrlFrom('https://hub.example/api/hfl-nn-feed', 'https://x.example/s.json'), 'https://x.example/s.json');

  const store = createStore(tmpDir());
  let body = JSON.stringify(FEED), status = 200, changes = 0;
  const src = createStreamsSource({
    store, getUrl: () => 'https://hub.example/api/hfl-nn-streams', logger: quiet, onChange: () => changes++,
    fetchImpl: async () => new Response(body, { status }),
  });
  assert.deepEqual(src.live(), []);
  assert.deepEqual(await src.refresh(), { ok: true, live: 2, replays: 2, changed: true });
  assert.equal((await src.refresh()).changed, false);
  assert.equal(changes, 1, 'an unchanged answer is not written again');
  assert.equal(src.live().length, 2);
  assert.equal(src.live(Date.now() + 6 * 60000).length, 0, 'six minutes without a good answer: nobody is called live');
  assert.equal(src.replays().length, 2);

  // An outage keeps the replays we knew about and reports the error.
  status = 503;
  assert.equal((await src.refresh()).ok, false);
  assert.equal(src.replays().length, 2);
  assert.match(src.status().error, /503/);
  // A restart reads the last good answer back, but it is too old to trust for "live".
  const again = createStreamsSource({ store, getUrl: () => '', logger: quiet });
  assert.equal(again.replays().length, 2);
  assert.equal((await again.refresh()).ok, false);
});

test('programme: HFL Rewind airs a replay from where the game is up to, cut off at the end of its slot', () => {
  const { replays } = normalizeStreams(FEED);
  const blocks = buildDay({ day: DAY, config, episodes: [], replays });
  assertCovers(blocks, DAY);
  const at3 = blockAt(blocks, wallToMs(DAY, '15:00', TZ));
  assert.equal(at3.kind, 'replay');
  assert.equal(at3.show, 'rewind');
  assert.equal(at3.title, 'NEs at BUFs');
  assert.ok(['777', 'bufgame0001'].includes(at3.stream.videoId));
  assert.equal(at3.game.awayScore, undefined, 'a replay never carries the final score');
  assert.ok(at3.until - at3.from >= 4800 * 1000 && at3.until - at3.from <= 5100 * 1000);

  // Two games in a two-hour slot: the second is on until the slot ends.
  const slot = blocks.filter(b => b.kind === 'replay' && b.from >= wallToMs(DAY, '15:00', TZ) && b.from < wallToMs(DAY, '17:00', TZ));
  assert.equal(slot.length, 2);
  assert.notEqual(slot[0].stream.videoId, slot[1].stream.videoId);
  assert.equal(slot[1].until, wallToMs(DAY, '17:00', TZ));
  assert.equal((slot[1].from - dayStart(DAY, TZ)) % 300000, 0, 'it starts on a tidy boundary');
  // The late slot leads with the other game.
  assert.notEqual(blockAt(blocks, wallToMs(DAY, '22:00', TZ)).stream.videoId, at3.stream.videoId);
});

test('programme: a replay is skipped once Twitch would have deleted it, or before the stream has ended', () => {
  const { replays } = normalizeStreams(FEED);
  // The Twitch replay expires on the 21st: gone from that day's afternoon slot, YouTube's is still there.
  const later = buildDay({ day: '2026-11-21', config, episodes: [], replays });
  const shown = later.filter(b => b.kind === 'replay').map(b => b.stream.videoId);
  assert.ok(shown.length && shown.every(v => v === 'bufgame0001'), shown.join(','));
  // Before the games were played: nothing to replay yet.
  const before = buildDay({ day: '2026-11-05', config, episodes: [], replays });
  assertCovers(before, '2026-11-05');
  assert.ok(before.every(b => b.kind !== 'replay' && b.kind !== 'clip'));
});

test('programme: Top Plays runs the clips back to back, most watched first, then hands back to the studio', () => {
  const { replays } = normalizeStreams(FEED);
  const episodes = [{ id: 'w1', type: 'weekly', duration: 400, publishedAt: '2026-11-01T03:00:00Z', title: 'Week 5' }];
  const blocks = buildDay({ day: DAY, config, episodes, replays });
  assertCovers(blocks, DAY);
  const from = wallToMs(DAY, '18:00', TZ), until = wallToMs(DAY, '18:30', TZ);
  const slot = blocks.filter(b => b.from >= from && b.from < until);
  assert.deepEqual(slot.slice(0, 2).map(b => [b.kind, b.show, b.clipId]), [['clip', 'plays', 'PickSix-def456'], ['clip', 'plays', 'GreatCatch-abc123']]);
  assert.equal(slot[0].title, 'NEs at BUFs', 'an untitled clip is named for its game');
  assert.equal(slot[1].title, 'What a catch');
  assert.equal(slot[1].from, slot[0].until, 'no gap between clips');
  assert.equal(slot[0].until - slot[0].from, 17000, 'a clip gets its length plus two seconds for the player to start');
  assert.equal(slot[2].kind, 'ident');
  assert.deepEqual([slot[3].kind, slot[3].show, slot[3].episodeId], ['episode', 'vault', 'w1']);
  // With no footage at all the same slots just air the vault.
  const plain = buildDay({ day: DAY, config, episodes, replays: [] });
  assert.equal(blockAt(plain, from).show, 'vault');
  assert.equal(blockAt(plain, wallToMs(DAY, '15:00', TZ)).show, 'vault');
});

test('guide: replays and clips are listed, and live games are offered only for the real present', () => {
  const store = createStore(tmpDir());
  const data = normalizeStreams(FEED);
  const t = wallToMs(DAY, '15:30', TZ);
  const ch = createChannel({ store, config, getEpisodes: () => [], getReplays: () => data.replays, getLive: () => data.live, now: () => t, logger: quiet });

  const g = ch.guide();
  assert.equal(g.onNow.kind, 'replay');
  assert.deepEqual(Object.keys(g.onNow.stream).sort(), ['channel', 'member', 'platform', 'videoId']);
  assert.deepEqual(g.live.map(l => [l.id, l.title, l.game.gotw]), [['youtube:kcgame00001', 'DENs at KCs', true], ['twitch:miafins', 'MIAs at NYJs', false]]);
  assert.equal(g.live[0].game.awayScore, undefined);
  assert.equal(ch.guide(t + 3600000).live.length, 0, 'looking at another time never claims a game is live');

  const list = ch.listings().blocks;
  const reel = list.find(b => b.kind === 'clips');
  assert.deepEqual([reel.showTitle, reel.title, reel.count], ['Top Plays', '2 clips from league games', 2]);
  assert.ok(list.some(b => b.kind === 'replay' && b.showTitle === 'HFL Rewind'));
  assert.ok(list.every(b => ['episode', 'replay', 'clips'].includes(b.kind)));

  // A replay disappearing (deleted by the streamer) changes later slots, not the one on air.
  const onAir = g.onNow;
  data.replays = data.replays.filter(r => r.videoId !== onAir.stream.videoId);
  const after = ch.guide();
  assert.equal(after.onNow.stream.videoId, onAir.stream.videoId);
  assert.ok(after.blocks.filter(b => b.kind === 'replay' && b.from > t).every(b => b.stream.videoId !== onAir.stream.videoId));
});

test('server: the page may frame Twitch and YouTube players, and /api/channel carries live games from the Hub', async () => {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false, hubFeedUrl: 'https://hub.example/api/hfl-nn-feed' });
  const asked = [];
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), logger: quiet, debounceMs: 60 * 60 * 1000,
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    fetchImpl: async url => { asked.push(String(url)); return new Response(JSON.stringify(FEED), { status: 200 }); },
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let g = await (await fetch(`${base}/api/channel`)).json();
    assert.deepEqual(g.live, []);
    await ctx.streams.refresh();
    assert.deepEqual(asked, ['https://hub.example/api/hfl-nn-streams']);
    g = await (await fetch(`${base}/api/channel`)).json();
    assert.equal(g.live.length, 2);
    assert.deepEqual(g.live[0].stream, { platform: 'youtube', channel: null, videoId: 'kcgame00001', member: 'KC GM' });

    for (const p of ['/', '/embed/channel']) {
      const csp = (await fetch(base + p)).headers.get('content-security-policy');
      assert.match(csp, /frame-src 'self' https:\/\/player\.twitch\.tv https:\/\/clips\.twitch\.tv https:\/\/www\.youtube-nocookie\.com/, p);
      assert.match(csp, /script-src 'self'/, 'no third-party script is allowed in');
    }
  } finally { server.close(); await ctx.close(); }
});

test('server: scripts and styles are revalidated on every load, so a deploy never mixes old and new', async () => {
  const ctx = createApp({ dataDir: tmpDir(), env: { ADMIN_PASSWORD: 'letmein', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['/js/channel.js', '/js/studio/footage.js', '/css/site.css']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
      assert.ok(r.headers.get('etag'), p);
    }
    assert.match((await fetch(`${base}/img/favicon.svg`)).headers.get('cache-control'), /max-age=3600/);
  } finally { server.close(); await ctx.close(); }
});
