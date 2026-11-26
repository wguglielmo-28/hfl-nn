// Roadmap C3: a rookie or fantasy draft imported on the HFL Hub becomes
// stories (the first pick, the first round, the steal), once per draft, and
// the Draft Desk segment leads with them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const { creditFor } = require('../lib/coaches');
const { buildRundown } = require('../lib/rundown');
const S = require('../lib/stories');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const cur = {
  seasonIndex: 8,
  teams: {
    1: { id: 1, abbr: 'GB', city: 'Green Bay', nickname: 'Packers' }, 2: { id: 2, abbr: 'NE', city: 'New England', nickname: 'Patriots' },
    3: { id: 3, abbr: 'CHI', city: 'Chicago', nickname: 'Bears' },
  },
};
const pk = (overall, round, team, player, position, ovr, via = null) => ({ overall, round, pick: overall, team, via, player, position, ovr, age: 22, dev: 'Normal' });
const DRAFT = {
  id: 7, kind: 'rookie', name: 'Season IX Rookie Draft', importedAt: '2026-11-26 20:00:00', picks: 224, rounds: 7,
  firstRound: [pk(1, 1, 'GB', 'Rookie Dos', 'WR', 70, 'NE'), pk(2, 1, 'GB', 'Rookie Tres', 'CB', 69), pk(3, 1, 'CHI', 'Big Uno', 'QB', 74)],
  steals: [pk(97, 4, 'CHI', 'Late Gem', 'HB', 72), pk(40, 2, 'NE', 'Second Rounder', 'DT', 71)],
};

test('the feed carries the draft; nothing without a first round', () => {
  assert.equal(normalizeHubFeed({}).draft, null);
  assert.equal(normalizeHubFeed({ draft: { id: 1, firstRound: [] } }).draft, null);
  const d = normalizeHubFeed({ draft: DRAFT }).draft;
  assert.equal(d.firstRound[0].via, 'NE');
  assert.equal(d.firstRound[1].via, null);
  assert.equal(d.steals.length, 2);
});

test('stories: the first pick (with a traded slot), the first round, the steal', () => {
  const got = Object.fromEntries(S.draftStories(DRAFT, cur, creditFor).map(s => [s.type, s]));
  assert.equal(got.draft_pick.headline, "The Packers take Rookie Dos (WR, 70 OVR) first overall in the Season IX Rookie Draft, with the Patriots' pick");
  assert.equal(got.draft_pick.facts.gm, 'Hank Nottick of the Packers');
  assert.equal(got.draft_round.headline, 'Round 1 of the Season IX Rookie Draft: Packers take Rookie Dos, Packers take Rookie Tres, Bears take Big Uno');
  assert.equal(got.draft_round.facts.firstRound[0], '1. Packers (via Patriots): Rookie Dos, WR, 70 OVR, age 22, Normal');
  assert.equal(got.draft_steal.headline, 'Steal of the Season IX Rookie Draft? The Bears get Late Gem (HB, 72 OVR) in round 4');
  assert.deepEqual(Object.values(got).map(s => s.id), ['draftfeed:7:first', 'draftfeed:7:round1', 'draftfeed:7:steal']);
});

test('the Draft Desk leads with the Hub draft', () => {
  const stories = S.draftStories(DRAFT, cur, creditFor);
  const r = buildRundown({ type: 'special', phase: 'draft', show, personas, league: cur, context: {}, stories, customKinds: ['draft_desk'] });
  const seg = r.segments.find(s => s.kind === 'draft_desk');
  assert.ok(seg, 'the Draft Desk runs');
  assert.deepEqual(seg.storyIds.slice(0, 3), ['draftfeed:7:first', 'draftfeed:7:round1', 'draftfeed:7:steal']);
  assert.match(seg.brief, /The draft from the HFL Hub/);
  assert.match(seg.brief, /never add a pick that is not there/);
});

test('a Hub push puts each draft on the wire once', async () => {
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
    const push = () => fetch(`${base}/api/hub/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' }, body: JSON.stringify({ draft: DRAFT }) });
    assert.equal((await push()).status, 200);
    assert.equal((await push()).status, 200);
    const got = ctx.producer.wireStories().filter(s => s.id.startsWith('draftfeed:'));
    assert.deepEqual(got.map(s => s.type).sort(), ['draft_pick', 'draft_round', 'draft_steal']);
  } finally { server.close(); await ctx.close(); }
});
