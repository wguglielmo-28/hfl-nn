'use strict';
// The Standings Center (/standings).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { standingsReport, gamesBack } = require('../lib/standings');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

// One 16-team conference in four divisions, after `played` games each.
// Team i has wins[i]; seeds follow the order given.
function league({ wins, played = 14, statuses = {}, weekIndex = 14, stage = 'reg', games = {} }) {
  const teams = {}, standings = {};
  const abbrs = ['CHI', 'DET', 'GB', 'MIN', 'DAL', 'NYG', 'PHI', 'WAS', 'ATL', 'CAR', 'NO', 'TB', 'ARI', 'LAR', 'SF', 'SEA'];
  const divs = ['North', 'East', 'South', 'West'];
  abbrs.forEach((a, i) => {
    teams[i + 1] = { id: i + 1, abbr: a, city: a, nickname: `${a} Nick`, primary: '#123456' };
    const w = wins[i];
    standings[i + 1] = {
      teamId: i + 1, w, l: played - w, t: 0, pct: w / played, seed: i + 1, status: statuses[a] || (i < 7 ? 'in' : 'out'),
      streak: 2, division: `NFC ${divs[Math.floor(i / 4)]}`, conference: 'NFC', netPts: 10, divW: 1, divL: 1, confW: 2, confL: 2,
      weekIndex, seasonIndex: 1, stage,
    };
  });
  return { teams, standings, games, updatedAt: '2026-11-26T12:00:00Z', seasonIndex: 1 };
}

test('games back counts wins and losses by halves', () => {
  assert.equal(gamesBack({ w: 8, l: 6 }, { w: 10, l: 4 }), 2);
  assert.equal(gamesBack({ w: 9, l: 5 }, { w: 9, l: 4 }), 0.5);
});

test('seeds, the hunt, clinches and certain eliminations', () => {
  // 14 played, 3 left. Seeds 1-7 at 12..8 wins; seed 8+ trailing.
  // Order: CHI DET GB MIN | DAL NYG PHI WAS | ATL CAR NO TB | ARI LAR SF SEA
  const wins = [12, 11, 10, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 7, 1, 0];
  const r = standingsReport(league({ wins, statuses: { CHI: 'clinched_top_seed', DET: 'clinched_playoffs' } }));
  assert.equal(r.ready, true);
  const c = r.conferences[0];
  assert.deepEqual(c.seeds.map(t => t.abbr), ['CHI', 'DET', 'GB', 'MIN', 'DAL', 'NYG', 'PHI']);
  assert.equal(c.seeds[0].clinch.mark, 'z');
  assert.equal(c.seeds[1].state, 'clinched');
  assert.equal(c.seeds[2].state, 'in');
  const by = Object.fromEntries([...c.seeds, ...c.hunt, ...c.out].map(t => [t.abbr, t]));
  assert.equal(by.WAS.state, 'hunt', '7 wins + 3 left = 10 can still pass the 8-win 7th seed');
  assert.equal(by.WAS.back, 1);
  assert.equal(by.WAS.left, 3);
  // CAR: 5 + 3 = 8. Teams already above 8 wins: CHI DET GB MIN DAL NYG = 6, so not out.
  assert.equal(by.CAR.state, 'hunt');
  // NO: 4 + 3 = 7. Above 7: CHI DET GB MIN DAL NYG PHI = 7, and its leader ATL has 6, so it can still win the division.
  assert.equal(by.NO.state, 'hunt', 'a division title is still open');
  // SEA: 0 + 3 = 3. Seven teams above, and its division leader LAR already has 7.
  assert.equal(by.SEA.state, 'out');
  assert.ok(c.out.every(t => t.state === 'out'));
  assert.ok(!c.out.some(t => t.abbr === 'LAR'), 'a division leader is never eliminated');
  // Divisions: sorted by win pct, games behind the leader.
  const west = c.divisions.find(d => d.name === 'NFC West');
  assert.deepEqual(west.teams.map(t => t.abbr), ['LAR', 'ARI', 'SF', 'SEA']);
  assert.equal(west.teams[1].divBack, 5);
  assert.equal(r.through, null, 'no games, no completed week');
  assert.equal(r.note, null);
  assert.equal(by.CHI._s, undefined, 'internal fields stay out of the API');
});

test('the season over: nobody is chasing', () => {
  const wins = [14, 13, 12, 11, 11, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const r = standingsReport(league({ wins, played: 17, weekIndex: 17 }));
  const c = r.conferences[0];
  assert.equal(c.hunt.length, 0);
  assert.equal(c.out.length, 9);
});

test('the next game comes from the schedule; a preseason table says it is a projection', () => {
  const games = {
    a: { key: 'a', seasonIndex: 1, stage: 'reg', week: 15, homeId: 2, awayId: 1, played: false },
    b: { key: 'b', seasonIndex: 1, stage: 'reg', week: 16, homeId: 1, awayId: 3, played: false },
  };
  const r = standingsReport(league({ wins: Array(16).fill(7), games }));
  const chi = r.conferences[0].divisions.find(d => d.name === 'NFC North').teams.find(t => t.abbr === 'CHI');
  assert.deepEqual(chi.next, { week: 15, home: false, opp: 'DET' });
  const pre = standingsReport(league({ wins: Array(16).fill(0), played: 0, stage: 'pre' }));
  assert.match(pre.note, /Preseason/);
  assert.equal(pre.conferences[0].out.length, 0, 'nobody is eliminated in the preseason');
});

test('an empty league is not ready', () => {
  assert.equal(standingsReport({ teams: {}, standings: {}, games: {} }).ready, false);
});

test('/standings and /api/standings are public', async () => {
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
    const r = await (await fetch(`${base}/api/standings`)).json();
    assert.equal(r.ready, false);
    const page = await fetch(`${base}/standings`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Standings Center/);
  } finally { server.close(); await ctx.close(); }
});
