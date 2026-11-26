// Roadmap C1: record chases from the HFL Hub's record books, season pace,
// and the stat types the big-game stories used to miss (tackles, forced
// fumbles, long punts, yards from scrimmage).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const S = require('../lib/stories');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

function league(stats) {
  return {
    teams: { 1: { id: 1, abbr: 'GB', city: 'Green Bay', nickname: 'Packers' }, 2: { id: 2, abbr: 'AZ', city: 'Arizona', nickname: 'Cardinals' } },
    players: {}, stats,
  };
}
const wk = w => ({ seasonIndex: 8, stage: 'reg', week: w });

test('big games now count tackles, forced fumbles, long punts and yards from scrimmage', () => {
  const cur = league({
    '8-reg-5': {
      defense: [{ rosterId: 1, name: 'Tackler', teamId: 1, scheduleId: 9, defTotalTackles: 14, defForcedFum: 0 }, { rosterId: 2, name: 'Stripper', teamId: 1, scheduleId: 9, defTotalTackles: 3, defForcedFum: 2 }],
      punting: [{ rosterId: 3, name: 'Boot', teamId: 2, scheduleId: 9, puntLongest: 68 }],
      rushing: [{ rosterId: 4, name: 'Dual Back', teamId: 1, scheduleId: 9, rushYds: 120, rushTDs: 0 }],
      receiving: [{ rosterId: 4, name: 'Dual Back', teamId: 1, scheduleId: 9, recYds: 95, recTDs: 0 }],
    },
  });
  const got = Object.fromEntries(S.performanceStories(cur, wk(5), new Map()).map(s => [s.facts.player, s.headline]));
  assert.equal(got.Tackler, 'Tackler piles up 14 tackles');
  assert.equal(got.Stripper, 'Stripper piles up 2 forced fumbles');
  assert.equal(got.Boot, 'Boot booms a 68-yard punt');
  assert.equal(got['Dual Back'], 'Dual Back piles up 215 yards from scrimmage');
});

test('season pace: from week 4, past a round number, once per mark', () => {
  const stats = {};
  for (let w = 1; w <= 4; w++) stats[`8-reg-${w}`] = { rushing: [{ rosterId: 7, name: 'Workhorse', teamId: 1, scheduleId: w, rushYds: 130 }] };
  const cur = league(stats);
  const early = S.paceStories(league({ '8-reg-1': stats['8-reg-1'], '8-reg-2': stats['8-reg-2'] }), wk(2), new Map());
  assert.deepEqual(early, [], 'two games is not a pace');
  const [s] = S.paceStories(cur, wk(4), new Map());
  assert.equal(s.type, 'pace');
  assert.equal(s.headline, 'Workhorse is on pace for 2,210 rushing yards');
  assert.deepEqual([s.facts.seasonTotal, s.facts.games, s.facts.pace, s.facts.mark], [520, 4, 2210, 2000]);
  assert.equal(s.id, 'pace:8-7-rushYds-2000', 'the same mark next week is the same story');
});

test('record chases become stories: one per level, naming the book, Arizona matched through AZ', () => {
  const cur = league({});
  const chases = [
    { player: 'New Back', team: 'GB', label: 'Rushing Yards', scope: 'game', level: 'broken', value: 160, pace: null, mark: { book: 'HFL Hub', value: 150, holder: 'Old Back', when: 'Season VIII' } },
    { player: 'Air Mail', team: 'ARI', label: 'Receiving Yards', scope: 'season', level: 'close', value: 1900, pace: 2100, mark: { book: 'NeonSportz', value: 2000, holder: 'Neon WR', when: 'S2' } },
    { player: 'Pace Man', team: 'GB', label: 'Sacks', scope: 'season', level: 'watch', value: 9, pace: 25, mark: { book: 'HFL Hub', value: 22, holder: null, when: null } },
  ];
  const [broken, close, watch] = S.recordStories(chases, cur, wk(6));
  assert.equal(broken.type, 'record');
  assert.equal(broken.headline, 'New Back breaks the HFL Hub all-time single-game Rushing Yards record with 160 (old mark 150, Old Back, Season VIII)');
  assert.deepEqual(broken.teams, [1]);
  assert.equal(close.type, 'record_chase');
  assert.equal(close.headline, 'Air Mail is 100 short of the NeonSportz-era single-season Receiving Yards record (2,000, Neon WR, S2)');
  assert.deepEqual(close.teams, [2], 'the Hub says ARI, the league says AZ');
  assert.equal(watch.headline, 'Pace Man is on pace to break the HFL Hub all-time single-season Sacks record (22)');
  assert.ok(broken.score > close.score && close.score > watch.score);
  assert.notEqual(close.id, S.recordStories([{ ...chases[1], level: 'broken' }], cur, wk(7))[0].id, 'a new level is a new story');
});

test('when several games beat the same old record, only the best one is the new record', () => {
  const mk = (player, value) => ({ player, team: 'GB', label: 'Total Tackles', scope: 'game', level: 'broken', value, mark: { book: 'HFL Hub', value: 11, holder: 'E.Cooper', when: 'Season VIII' } });
  const got = S.recordStories([mk('A', 12), mk('B', 13), mk('C', 12)], league({}), wk(6));
  assert.deepEqual(got.map(s => s.facts.player), ['B']);
});

test('the feed carries record chases, and junk is dropped', () => {
  const feed = normalizeHubFeed({ recordChases: [
    { player: 'New Back', team: 'gb', label: 'Rushing Yards', scope: 'game', level: 'broken', value: 160, mark: { book: 'HFL Hub', value: 150 } },
    { player: 'No Level', label: 'X', level: 'huge', mark: { value: 3 } },
    { player: 'No Mark', label: 'X', level: 'close', mark: {} },
  ] });
  assert.equal(feed.recordChases.length, 1);
  assert.equal(feed.recordChases[0].team, 'GB');
  assert.deepEqual(normalizeHubFeed({}).recordChases, []);
});

test('a Hub push with record chases puts them on the wire once', async () => {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { weeklyShow: 'hflnn', approveWeekly: false });
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', HUB_PUSH_KEY: 'hub-key', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of fixturePayloads()) ctx.ingest.ingest(p);
    await ctx.ingest.flush();
    await ctx.producer.idle();
    const body = JSON.stringify({ recordChases: [{ player: 'New Back', team: 'GB', label: 'Rushing Yards', scope: 'game', level: 'broken', value: 160, mark: { book: 'HFL Hub', value: 150, holder: 'Old Back', when: 'Season VIII' } }] });
    const push = () => fetch(`${base}/api/hub/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' }, body });
    assert.equal((await push()).status, 200);
    assert.equal((await push()).status, 200);
    const recs = ctx.producer.wireStories().filter(s => s.type === 'record');
    assert.equal(recs.length, 1, 'one story, however often the Hub repeats it');
    assert.match(recs[0].headline, /^New Back breaks the HFL Hub all-time single-game Rushing Yards record/);
    assert.ok(recs[0].createdAt);
  } finally { server.close(); await ctx.close(); }
});
