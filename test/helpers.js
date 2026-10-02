// Shared test helpers: fixture loading and throwaway data directories.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const FIX = path.join(__dirname, 'fixtures', 'madden');

function fixture(name) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIX, name + '.json.gz'))).toString('utf8'));
}

function tmpDir(prefix = 'hflnn-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const clone = o => JSON.parse(JSON.stringify(o));

// Every fixture payload as ingest() calls, in the order an export sends them.
function fixturePayloads() {
  const out = [
    { kind: 'teams', body: fixture('leagueteams') },
    { kind: 'standings', body: fixture('standings') },
  ];
  for (const k of ['schedules', 'teamstats', 'passing', 'rushing', 'receiving', 'defense', 'kicking', 'punting']) {
    out.push({ kind: 'week', stage: 'reg', week: 1, statKind: k, body: fixture(`week-reg-1-${k}`) });
  }
  for (const [teamId, body] of Object.entries(fixture('rosters'))) out.push({ kind: 'roster', teamId: Number(teamId), body });
  out.push({ kind: 'freeagents', body: fixture('freeagents') });
  return out.map(p => ({ platform: 'pc', leagueId: '2890093', source: 'test', ...p }));
}

// A mid-week roster shuffle on top of the fixture league: the best player on
// team 1 is traded to team 2, team 3 signs a free agent and loses a starter to
// a six-week injury, and a team 2 player jumps to X-Factor.
function secondBatch() {
  const rosters = fixture('rosters');
  const ids = Object.keys(rosters);
  const a = clone(rosters[ids[0]]), b = clone(rosters[ids[1]]), c = clone(rosters[ids[2]]);
  const fa = clone(fixture('freeagents'));
  const star = a.rosterInfoList.sort((x, y) => y.playerBestOvr - x.playerBestOvr)[0];
  a.rosterInfoList = a.rosterInfoList.filter(p => p !== star);
  b.rosterInfoList.push({ ...star, teamId: Number(ids[1]) });
  const signee = fa.rosterInfoList.shift();
  c.rosterInfoList.push({ ...signee, teamId: Number(ids[2]), isFreeAgent: false });
  const hurt = c.rosterInfoList.find(p => p.playerBestOvr >= 80 && !p.injuryLength);
  hurt.injuryLength = 6;
  const riser = b.rosterInfoList.find(p => p.devTrait === 1);
  riser.devTrait = 3;
  return [
    { kind: 'freeagents', body: fa },
    { kind: 'roster', teamId: Number(ids[0]), body: a },
    { kind: 'roster', teamId: Number(ids[1]), body: b },
    { kind: 'roster', teamId: Number(ids[2]), body: c },
  ];
}

module.exports = { fixture, fixturePayloads, secondBatch, tmpDir, clone };
