// Roadmap C2: the HFL Sportsbook (play money) on HFL-NN: the week's line,
// upsets against the closing line, the biggest winning ticket and the season
// leader. Members are named by HFL coach name only, never a Hub handle.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const { creditFor } = require('../lib/coaches');
const S = require('../lib/stories');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const cur = {
  seasonIndex: 8,
  teams: {
    1: { id: 1, abbr: 'GB', city: 'Green Bay', nickname: 'Packers' }, 2: { id: 2, abbr: 'HOU', city: 'Houston', nickname: 'Texans' },
    3: { id: 3, abbr: 'NE', city: 'New England', nickname: 'Patriots' }, 4: { id: 4, abbr: 'DAL', city: 'Dallas', nickname: 'Cowboys' },
  },
};
const SB = {
  week: 14, lastWeek: 13,
  lines: [
    { away: 'HOU', home: 'GB', favorite: 'GB', spread: 7.5, total: 47.5, favoriteWinPct: 74 },
    { away: 'DAL', home: 'NE', favorite: 'NE', spread: 1.5, total: 41, favoriteWinPct: 54 },
  ],
  upsets: [{ winner: 'DAL', loser: 'NE', winnerScore: 24, loserScore: 20, spread: 6.5 }],
  bigWins: [{ team: 'GB', profit: 850, kind: 'parlay', legs: 4 }],
  leaders: [{ team: 'DAL', profit: 1200, won: 14, lost: 6 }, { team: '', profit: 300, won: 5, lost: 4 }],
};

test('the feed carries the sportsbook, null while it is off', () => {
  assert.equal(normalizeHubFeed({}).sportsbook, null);
  assert.equal(normalizeHubFeed({ sportsbook: null }).sportsbook, null);
  const sb = normalizeHubFeed({ sportsbook: { ...SB, upsets: [...SB.upsets, { winner: 'X', loser: 'Y', spread: 0 }], bigWins: [{ team: 'GB', profit: 0 }] } }).sportsbook;
  assert.equal(sb.lines.length, 2);
  assert.equal(sb.upsets.length, 1, 'an "upset" with no spread is no upset');
  assert.deepEqual(sb.bigWins, [], 'a ticket that made nothing is no big win');
});

test('stories: the line, the upset, the big win and the leader, by coach name', () => {
  const got = Object.fromEntries(S.sportsbookStories(SB, cur, creditFor).map(s => [s.type, s]));
  assert.equal(got.odds.headline, 'The HFL Sportsbook makes the Packers 7.5-point favorites over the Texans');
  assert.equal(got.odds.facts.closestGame.favorite, 'Patriots');
  assert.equal(got.odds.id, 'odds:8-14');
  assert.equal(got.upset.headline, 'The Cowboys win 24-20 as 6.5-point underdogs against the Patriots');
  assert.deepEqual(got.upset.teams, [4, 3]);
  assert.equal(got.bettor.headline, 'Hank Nottick of the Packers cashes a 4-leg parlay for 850 HFL Bucks');
  assert.equal(got.book_leader.headline, 'Mike Bugatti of the Cowboys leads the HFL Sportsbook, up 1,200 HFL Bucks on the season');
  assert.equal(got.book_leader.facts.chasers[0].who, 'a member', 'no team, no name');
  assert.ok(Object.values(got).every(s => /HFL Sportsbook|HFL Bucks|closing line/.test(JSON.stringify(s.facts))), 'every story says it is the play-money book');
});

test('a CPU-team or teamless winner is "a bettor"; no lines, no line story', () => {
  const got = S.sportsbookStories({ week: 2, lastWeek: 1, lines: [], upsets: [], bigWins: [{ team: 'BUF', profit: 90, kind: 'single', legs: 1 }], leaders: [] }, cur, creditFor);
  assert.deepEqual(got.map(s => s.type), ['bettor']);
  assert.equal(got[0].headline, 'A bettor cashes a single for 90 HFL Bucks');
  assert.deepEqual(S.sportsbookStories(null, cur, creditFor), []);
});

test('a Hub push puts the sportsbook on the wire once a week', async () => {
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
    const push = () => fetch(`${base}/api/hub/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' }, body: JSON.stringify({ sportsbook: SB }) });
    assert.equal((await push()).status, 200);
    assert.equal((await push()).status, 200);
    const book = ctx.producer.wireStories().filter(s => ['odds', 'upset', 'bettor', 'book_leader'].includes(s.type));
    assert.deepEqual(book.map(s => s.type).sort(), ['bettor', 'book_leader', 'odds', 'upset'], 'one of each, however often the Hub repeats it');
    assert.doesNotMatch(JSON.stringify(book), /handle/);
  } finally { server.close(); await ctx.close(); }
});

test('the slate quotes the book when there is a line story', async () => {
  const L = require('../lib/league');
  const { buildRundown } = require('../lib/rundown');
  const { createMaddenIngest } = require('../lib/ingest/madden');
  const personas = require('../config/personas.json');
  const show = require('../config/show.json');
  let league = L.emptyLeague();
  const batches = [];
  const ingest = createMaddenIngest({ store: createStore(tmpDir()), getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet, onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }) });
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const context = { ...S.buildContext(league, {}), matchups: { type: 'matchups', data: { title: 'NEXT WEEK', games: [] } }, nextWeek: { label: 'Week 14' } };
  const odds = S.sportsbookStories(SB, league, creditFor).find(s => s.type === 'odds');
  const r = buildRundown({ type: 'custom', customKinds: ['slate'], phase: 'regular', show, personas, league, context, stories: [...batches[0].stories, odds] });
  const slate = r.segments.find(s => s.kind === 'slate');
  assert.ok(slate, 'the slate runs');
  assert.ok(slate.storyIds.includes(odds.id));
  assert.match(slate.brief, /HFL Sportsbook has lines/);
  assert.match(slate.brief, /Never give betting advice/);
});
