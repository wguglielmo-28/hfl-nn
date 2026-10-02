'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { createStore } = require('../lib/store');
const L = require('../lib/league');
const { createMaddenIngest, detectPayload } = require('../lib/ingest/madden');
const { fixture, fixturePayloads, tmpDir, clone } = require('./helpers');

function setup(onBatchComplete) {
  const store = createStore(tmpDir());
  let league = L.emptyLeague();
  const ingest = createMaddenIngest({
    store,
    getLeague: () => league,
    saveLeague: () => store.writeJSON('league/current.json', league),
    onBatchComplete,
    debounceMs: 60 * 60 * 1000,
    logger: { log() {}, warn() {}, error() {} },
  });
  return { store, ingest, league: () => league };
}

test('fixture export builds the league model', async () => {
  const seen = [];
  const { ingest, league, store } = setup(async x => seen.push(x));
  for (const p of fixturePayloads()) ingest.ingest(p);
  const lg = league();

  assert.equal(Object.keys(lg.teams).length, 32);
  assert.equal(Object.keys(lg.standings).length, 32);
  assert.equal(lg.leagueId, '2890093');
  const bal = Object.values(lg.teams).find(t => t.abbr === 'BAL');
  assert.equal(bal.primary, '#24135f');
  assert.equal(bal.conference, 'AFC');

  // Streaks decode from unsigned bytes: the Steelers' 254 is a 2-game skid.
  const pit = Object.values(lg.teams).find(t => t.abbr === 'PIT');
  assert.equal(lg.standings[pit.id].streak, -2);

  const games = L.gamesForWeek(lg, 1, 'reg', 1);
  assert.equal(games.length, 16);
  assert.ok(games.every(g => g.played));
  const buf = games.find(g => lg.teams[g.awayId].abbr === 'BUF');
  assert.deepEqual([buf.awayScore, buf.homeScore, buf.status], [49, 24, 'away_win']);

  assert.equal(lg.stats['1-reg-1'].passing.length, 34);
  assert.deepEqual(L.lastPlayedWeek(lg), { seasonIndex: 1, stage: 'reg', week: 1 });
  assert.equal(L.detectPhase(lg), 'regular');

  const players = Object.values(lg.players);
  assert.ok(players.length > 2000, `expected rosters + free agents, got ${players.length}`);
  assert.equal(players.filter(p => p.teamId === 0).length, 150);
  assert.ok(players.every(p => !p.departed), 'nobody departs within one consistent export');

  const summary = await ingest.flush();
  assert.equal(summary.rosterTeams.length, 32);
  assert.equal(summary.freeAgents, true);
  assert.deepEqual(summary.weeks, [{ seasonIndex: 1, stage: 'reg', week: 1 }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prev, null);
  assert.ok(store.exists(summary.snapshot));
});

test('roster moves between batches: trade, signing, departure', async () => {
  const seen = [];
  const { ingest, league } = setup(async x => seen.push(x));
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();

  const rosters = fixture('rosters');
  const [teamA, teamB] = Object.keys(rosters);
  const a = clone(rosters[teamA]);
  const b = clone(rosters[teamB]);
  const fa = clone(fixture('freeagents'));

  // A's best player goes to B; B's QB goes to A; B signs the top free agent;
  // A's last player vanishes (retired, not in free agency).
  const star = a.rosterInfoList.sort((x, y) => y.playerBestOvr - x.playerBestOvr)[0];
  const qb = b.rosterInfoList.find(p => p.position === 'QB');
  const signee = fa.rosterInfoList.shift();
  const gone = a.rosterInfoList.pop();
  a.rosterInfoList = a.rosterInfoList.filter(p => p !== star).concat({ ...qb, teamId: Number(teamA) });
  b.rosterInfoList = b.rosterInfoList.filter(p => p !== qb).concat({ ...star, teamId: Number(teamB) }, { ...signee, teamId: Number(teamB), isFreeAgent: false });

  // Arrival order shouldn't matter: free agents first, then B, then A.
  ingest.ingest({ kind: 'freeagents', body: fa });
  ingest.ingest({ kind: 'roster', teamId: Number(teamB), body: b });
  ingest.ingest({ kind: 'roster', teamId: Number(teamA), body: a });
  await ingest.flush();

  const lg = league();
  const byRoster = id => Object.values(lg.players).find(p => p.rosterId === id);
  assert.equal(byRoster(star.rosterId).teamId, Number(teamB));
  assert.equal(byRoster(qb.rosterId).teamId, Number(teamA));
  assert.equal(byRoster(signee.rosterId).teamId, Number(teamB));
  assert.equal(byRoster(signee.rosterId).departed, false);
  const g = byRoster(gone.rosterId);
  assert.equal(g.departed, true);
  assert.equal(g.departedFrom, Number(teamA));
  assert.ok(seen[1].prev, 'second batch diffs against the first snapshot');
  assert.equal(seen[1].prev.players[L.playerKey(star)].teamId, Number(teamA));
});

test('detectPayload recognises uploaded files', () => {
  assert.deepEqual(detectPayload(fixture('leagueteams')), { kind: 'teams' });
  assert.deepEqual(detectPayload(fixture('week-reg-1-passing')), { kind: 'week', statKind: 'passing', stage: 'reg', week: 1 });
  assert.deepEqual(detectPayload(fixture('freeagents')), { kind: 'freeagents' });
  const [teamId, roster] = Object.entries(fixture('rosters'))[0];
  assert.deepEqual(detectPayload(roster), { kind: 'roster', teamId: Number(teamId) });
  assert.equal(detectPayload({ hello: 1 }), null);
});

test('HTTP routes accept the Companion App protocol, including gzip', async () => {
  const { ingest, league } = setup(async () => {});
  const app = express();
  app.use('/ingest/:key', ingest.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'POST', headers }, res => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const teams = Buffer.from(JSON.stringify(fixture('leagueteams')));
    let r = await post('/ingest/k/pc/2890093/leagueteams', zlib.gzipSync(teams), { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' });
    assert.equal(r.status, 200);
    assert.equal(Object.keys(league().teams).length, 32);

    r = await post('/ingest/k/pc/2890093/week/reg/1/schedules', JSON.stringify(fixture('week-reg-1-schedules')));
    assert.equal(r.status, 200, 'no content-type header still parses');
    assert.equal(L.gamesForWeek(league(), 1, 'reg', 1).length, 16);

    r = await post('/ingest/k/pc/2890093/week/reg/1/teamstats', JSON.stringify(fixture('week-reg-1-teamstats')));
    assert.equal(r.status, 200);
    assert.equal(league().stats['1-reg-1'].teamstats.length, 32);

    r = await post('/ingest/k/pc/2890093/standings', JSON.stringify({ success: false, message: 'nope' }));
    assert.equal(r.status, 200, 'a failed export is acknowledged, not applied');

    r = await post('/ingest/k/pc/2890093/extra', JSON.stringify({ success: true }));
    assert.equal(r.status, 200);

    r = await post('/ingest/k/pc/2890093/standings', '{not json', { 'Content-Type': 'application/json' });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});
