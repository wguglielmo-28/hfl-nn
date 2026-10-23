// EA reissuing every team id mid-season (Madden 27, 2026-10-21): the league
// moves onto the new ids, older snapshots are read in them, and the next
// batch reports no moves.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/store');
const L = require('../lib/league');
const S = require('../lib/stories');
const { createMaddenIngest } = require('../lib/ingest/madden');
const { fixturePayloads, tmpDir, clone } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const SHIFT = 1000000;
const ID_FIELDS = ['teamId', 'homeTeamId', 'awayTeamId'];

// The same payloads with every team id moved, as EA sent them after the reissue.
function reissued(payloads) {
  const shift = v => (typeof v === 'number' && v > 0 ? v + SHIFT : v);
  const walk = o => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = ID_FIELDS.includes(k) ? shift(v) : walk(v);
    return out;
  };
  return payloads.map(p => ({ ...walk(clone(p)), ...(p.teamId != null ? { teamId: shift(p.teamId) } : {}) }));
}

function setup(store = createStore(tmpDir()), league = L.emptyLeague()) {
  const batches = [];
  const ingest = createMaddenIngest({
    store, getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet,
    onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }),
  });
  return { store, ingest, league, batches };
}

const rosterOnly = payloads => payloads.filter(p => p.kind === 'teams' || p.kind === 'roster' || p.kind === 'freeagents');

test('reissuedTeamIds pairs only one-to-one abbreviation matches', () => {
  const old = { 1: { id: 1, abbr: 'NE' }, 2: { id: 2, abbr: 'BUF' } };
  assert.deepEqual(L.reissuedTeamIds(old, { 11: { id: 11, abbr: 'NE' }, 12: { id: 12, abbr: 'buf' } }), { 1: 11, 2: 12 });
  assert.deepEqual(L.reissuedTeamIds(old, { 1: { id: 1, abbr: 'NE' }, 2: { id: 2, abbr: 'BUF' } }), {}, 'an ordinary re-export');
  assert.deepEqual(L.reissuedTeamIds(old, { 1: { id: 1, abbr: 'NE' }, 11: { id: 11, abbr: 'NE' } }), {}, 'an abbreviation sent twice');
  assert.deepEqual(L.reissuedTeamIds({}, { 11: { id: 11, abbr: 'NE' } }), {}, 'a first export');
});

test('a reissue moves the league onto the new ids and reports no moves', async () => {
  const { ingest, league, batches } = setup();
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const oldIds = Object.keys(league.teams).map(Number);

  for (const p of rosterOnly(reissued(fixturePayloads()))) ingest.ingest(p);
  await ingest.flush();

  assert.deepEqual(Object.keys(league.teams).map(Number).sort(), oldIds.map(id => id + SHIFT).sort());
  assert.equal(L.unknownTeamIds(league).size, 0, 'games, standings and players all name a current team');
  for (const rows of Object.values(league.stats['1-reg-1'])) for (const r of rows) assert.ok(league.teams[r.teamId], `stat row on team ${r.teamId}`);
  assert.equal(Object.keys(league.teamIdChanges).length, 32);

  const { prev, stories } = batches[1];
  for (const p of Object.values(prev.players)) assert.ok(p.teamId <= 0 || league.teams[p.teamId], 'the earlier snapshot reads in the new ids');
  const moves = stories.filter(s => ['roster_rebuild', 'trade', 'signing', 'release', 'departure', 'retirement'].includes(s.type));
  assert.deepEqual(moves.map(s => s.type), []);
  const buf = L.gamesForWeek(league, 1, 'reg', 1).find(g => league.teams[g.awayId].abbr === 'BUF');
  assert.deepEqual([buf.awayScore, buf.homeScore], [49, 24], 'Week 1 still resolves to its teams');
});

test('a league that took a reissue before this fix is repaired from its snapshots at startup', async () => {
  const first = setup();
  for (const p of fixturePayloads()) first.ingest.ingest(p);
  await first.ingest.flush();
  // What the old applyTeams left behind: new teams and rosters, old games.
  const broken = clone(first.league);
  broken.teams = Object.fromEntries(Object.values(broken.teams).map(t => [t.id + SHIFT, { ...t, id: t.id + SHIFT }]));
  for (const p of Object.values(broken.players)) if (p.teamId > 0) p.teamId += SHIFT;
  assert.ok(L.unknownTeamIds(broken).size > 0);

  const second = setup(first.store, broken);
  assert.equal(L.unknownTeamIds(broken).size, 0);
  assert.equal(Object.keys(broken.teamIdChanges).length, 32);

  // And the baseline a show reads is in today's ids too.
  const base = second.ingest.baselineBefore({ seasonIndex: 1, stage: 'reg', week: 2 });
  assert.ok(base.snapshot);
  for (const id of Object.keys(base.snapshot.teams)) assert.ok(broken.teams[id], `baseline team ${id}`);
});
