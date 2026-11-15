// A trade whose two rosters arrive in different export batches (review of
// 2026-10-18, finding 1). The team a player left can land a batch before the
// team he joined. That used to air "X retires" for any veteran of 31 or more,
// and then say nothing at all when he turned up on his new team.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/store');
const L = require('../lib/league');
const S = require('../lib/stories');
const { createMaddenIngest } = require('../lib/ingest/madden');
const { fixture, fixturePayloads, tmpDir, clone } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const base = { platform: 'pc', leagueId: '2890093', source: 'test' };

function setup() {
  const league = L.emptyLeague();
  const batches = [];
  const ingest = createMaddenIngest({
    store: createStore(tmpDir()), getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet,
    onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }),
  });
  return { ingest, league, batches };
}

// The oldest good player on the first team: a veteran the old rule called retired.
function veteranTrade() {
  const rosters = fixture('rosters');
  const [fromId, toId] = Object.keys(rosters).map(Number);
  const from = clone(rosters[fromId]), to = clone(rosters[toId]);
  const vet = from.rosterInfoList.filter(p => p.age >= 31 && p.playerBestOvr >= 75).sort((x, y) => y.playerBestOvr - x.playerBestOvr)[0];
  assert.ok(vet, 'the fixture has a veteran of 31 or more to trade');
  from.rosterInfoList = from.rosterInfoList.filter(p => p !== vet);
  to.rosterInfoList.push({ ...vet, teamId: toId });
  return { fromId, toId, from, to, vet };
}

const about = (stories, vet) => stories.filter(s => `${s.headline}`.includes(vet.lastName));

test('the team a player left arrives first: no retirement is announced', async () => {
  const { ingest, batches } = setup();
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const { fromId, from, vet } = veteranTrade();

  ingest.ingest({ ...base, kind: 'roster', teamId: fromId, body: from });
  await ingest.flush();

  const stories = about(batches[1].stories, vet);
  assert.deepEqual(stories.filter(s => s.type === 'retirement'), [], 'nobody retires in the middle of a season');
  for (const s of stories) assert.doesNotMatch(s.headline, /retire/i);
});

test('the team he joined arrives next: the move is reported, from the team he left', async () => {
  const { ingest, league, batches } = setup();
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const { fromId, toId, from, to, vet } = veteranTrade();

  ingest.ingest({ ...base, kind: 'roster', teamId: fromId, body: from });
  await ingest.flush();
  ingest.ingest({ ...base, kind: 'roster', teamId: toId, body: to });
  await ingest.flush();

  const moved = batches[2].stories.filter(s => s.type === 'trade' && s.teams.includes(fromId) && s.teams.includes(toId));
  assert.equal(moved.length, 1, 'one trade story between the two teams');
  const player = Object.values(league.players).find(p => p.rosterId === vet.rosterId);
  assert.ok(moved[0].players.includes(player.key), 'and it is about him');
  assert.equal(player.teamId, toId);
  assert.equal(player.departed, false);
});

test('a player who simply comes back to the same roster makes no news', async () => {
  const { ingest, batches } = setup();
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const rosters = fixture('rosters');
  const fromId = Number(Object.keys(rosters)[0]);
  const { from, vet } = veteranTrade();

  ingest.ingest({ ...base, kind: 'roster', teamId: fromId, body: from });
  await ingest.flush();
  ingest.ingest({ ...base, kind: 'roster', teamId: fromId, body: clone(rosters[fromId]) });
  await ingest.flush();

  assert.deepEqual(about(batches[2].stories, vet).filter(s => ['trade', 'signing', 'retirement'].includes(s.type)), []);
});

test('a new season still retires a veteran who is gone', async () => {
  const { ingest, league, batches } = setup();
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const { fromId, from, vet } = veteranTrade();

  league.seasonIndex = (league.seasonIndex ?? 0) + 1;
  ingest.ingest({ ...base, kind: 'roster', teamId: fromId, body: from });
  await ingest.flush();

  assert.equal(about(batches[1].stories, vet).filter(s => s.type === 'retirement').length, 1);
});
