#!/usr/bin/env node
// One-time helper: turns the sample Madden export payloads published in
// snallabot-service (MIT — https://github.com/snallabot/snallabot-service,
// docs/madden/api_data) into the trimmed, scrubbed fixtures under
// test/fixtures/madden. Kept in the repo so the fixtures are reproducible.
//
//   node tools/make-fixtures.js <path-to-snallabot-service>/docs/madden/api_data
//
// Trimming keeps only the fields HFL-NN reads, so the fixtures stay small.
// Gamer tags are replaced — the samples come from a real league.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('usage: node tools/make-fixtures.js <snallabot-service>/docs/madden/api_data');
  process.exit(1);
}
const out = path.join(__dirname, '..', 'test', 'fixtures', 'madden');
fs.mkdirSync(out, { recursive: true });

const read = f => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const write = (name, payload) => {
  fs.writeFileSync(path.join(out, name + '.json.gz'), zlib.gzipSync(JSON.stringify(payload)));
  console.log('wrote', name);
};

const PLAYER_KEYS = [
  'rosterId', 'presentationId', 'birthYear', 'birthMonth', 'birthDay', 'firstName', 'lastName',
  'position', 'teamId', 'age', 'playerBestOvr', 'devTrait', 'injuryLength', 'injuryType', 'isOnIR',
  'isFreeAgent', 'isOnPracticeSquad', 'isActive', 'contractSalary', 'contractLength', 'contractYearsLeft',
  'contractBonus', 'capHit', 'draftRound', 'draftPick', 'rookieYear', 'yearsPro', 'jerseyNum', 'college',
];
const STAT_KEYS = {
  playerPassingStatInfoList: ['passAtt', 'passComp', 'passYds', 'passTDs', 'passInts', 'passSacks', 'passerRating', 'passLongest'],
  playerRushingStatInfoList: ['rushAtt', 'rushYds', 'rushTDs', 'rushFum', 'rushLongest', 'rushBrokenTackles', 'rushYdsAfterContact'],
  playerReceivingStatInfoList: ['recCatches', 'recYds', 'recTDs', 'recLongest', 'recDrops', 'recYdsAfterCatch'],
  playerDefensiveStatInfoList: ['defTotalTackles', 'defSacks', 'defInts', 'defForcedFum', 'defFumRec', 'defTDs', 'defDeflections', 'defSafeties'],
  playerKickingStatInfoList: ['fGMade', 'fGAtt', 'fGLongest', 'xPMade', 'xPAtt', 'kickPts'],
  playerPuntingStatInfoList: ['puntAtt', 'puntYds', 'puntLongest', 'puntNetYdsPerAtt', 'puntsIn20'],
  teamStatInfoList: ['offTotalYds', 'offPassYds', 'offRushYds', 'offPassTDs', 'offRushTds', 'tOGiveaways', 'tOTakeaways', 'defSacks', 'penalties', 'penaltyYds', 'totalWins', 'totalLosses', 'totalTies'],
};
const ID_KEYS = ['rosterId', 'fullName', 'teamId', 'scheduleId', 'seasonIndex', 'weekIndex', 'stageIndex', 'statId'];

// League info
const teams = read('pc_2890093_leagueTeams.json');
teams.leagueTeamInfoList = teams.leagueTeamInfoList.map(t => ({ ...t, userName: t.userName ? 'SampleOwner' : '' }));
write('leagueteams', teams);
write('standings', read('pc_2890093_standings.json'));
write('week-reg-1-schedules', read('pc_2890093_week1_1_schedules.json'));

// Weekly stats
const STAT_FILES = {
  passing: 'playerPassingStatInfoList', rushing: 'playerRushingStatInfoList', receiving: 'playerReceivingStatInfoList',
  defense: 'playerDefensiveStatInfoList', kicking: 'playerKickingStatInfoList', punting: 'playerPuntingStatInfoList',
  teamStats: 'teamStatInfoList',
};
for (const [file, listKey] of Object.entries(STAT_FILES)) {
  const payload = read(`pc_2890093_week1_1_${file}.json`);
  payload[listKey] = payload[listKey].map(r => pick(r, [...ID_KEYS, ...STAT_KEYS[listKey]]));
  write(`week-reg-1-${file === 'teamStats' ? 'teamstats' : file}`, payload);
}

// Rosters: one combined fixture (team id → payload) to keep the file count down
const rosters = {};
for (const f of fs.readdirSync(path.join(src, 'team_data')).filter(f => f.endsWith('_teamRoster.json'))) {
  const teamId = f.split('_')[2];
  const payload = JSON.parse(fs.readFileSync(path.join(src, 'team_data', f), 'utf8'));
  payload.rosterInfoList = payload.rosterInfoList.map(p => pick(p, PLAYER_KEYS));
  rosters[teamId] = payload;
}
write('rosters', rosters);

// Free agents: the best 150 by overall is plenty for tests and the demo
const fa = JSON.parse(fs.readFileSync(path.join(src, 'team_data', 'pc_2890093_freeagents.json'), 'utf8'));
fa.rosterInfoList = fa.rosterInfoList
  .sort((a, b) => (b.playerBestOvr || 0) - (a.playerBestOvr || 0))
  .slice(0, 150)
  .map(p => pick(p, PLAYER_KEYS));
write('freeagents', fa);
