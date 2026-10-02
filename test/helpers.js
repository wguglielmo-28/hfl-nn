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

module.exports = { fixture, fixturePayloads, tmpDir, clone };
