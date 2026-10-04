// A believable sample league for demos and first-time setup, built from the
// trimmed sample exports in test/fixtures/madden (MIT, from snallabot-service).
//
// Two export batches that agree with each other:
//   batch 1 — Week 1 results (the real sample), standings to match, rosters
//   batch 2 — a simulated Week 2 with a blockbuster trade, a free-agent
//             signing, an injury and an X-Factor upgrade
// plus a sample Crimson Chronicle article and an HFL Hub feed. Owner gamer
// tags are made up.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { seededRandom } = require('./util');

const FIX = path.join(__dirname, '..', 'test', 'fixtures', 'madden');
const read = n => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIX, `${n}.json.gz`))).toString('utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

const OWNERS = { BUF: 'HypnoKing', KC: 'BlitzBaron', DET: 'SwirlSzn', PHI: 'GridironGhost', BAL: 'TurfTitan', SF: 'CoachSpiral', DAL: 'PrimeTimeP', NE: 'SnapCount' };
const STAT_LISTS = {
  passing: 'playerPassingStatInfoList', rushing: 'playerRushingStatInfoList', receiving: 'playerReceivingStatInfoList',
  defense: 'playerDefensiveStatInfoList', kicking: 'playerKickingStatInfoList', punting: 'playerPuntingStatInfoList', teamstats: 'teamStatInfoList',
};
const ok = (key, list) => ({ success: true, message: 'demo', [key]: list });

function standings(teams, games, weekIndex, prevRanks = {}) {
  const rec = Object.fromEntries(teams.map(t => [t.teamId, { w: 0, l: 0, t: 0, pf: 0, pa: 0, res: [] }]));
  for (const g of games.filter(x => x.status > 1).sort((a, b) => a.weekIndex - b.weekIndex)) {
    const h = rec[g.homeTeamId], a = rec[g.awayTeamId];
    h.pf += g.homeScore; h.pa += g.awayScore; a.pf += g.awayScore; a.pa += g.homeScore;
    if (g.homeScore === g.awayScore) { h.t++; a.t++; h.res.push('T'); a.res.push('T'); }
    else if (g.homeScore > g.awayScore) { h.w++; a.l++; h.res.push('W'); a.res.push('L'); }
    else { a.w++; h.l++; a.res.push('W'); h.res.push('L'); }
  }
  const pct = r => (r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : 0);
  const order = teams.slice().sort((x, y) => pct(rec[y.teamId]) - pct(rec[x.teamId]) || (rec[y.teamId].pf - rec[y.teamId].pa) - (rec[x.teamId].pf - rec[x.teamId].pa) || y.ovrRating - x.ovrRating);
  const rank = Object.fromEntries(order.map((t, i) => [t.teamId, i + 1]));
  const seeds = {};
  for (const conf of ['AFC', 'NFC']) order.filter(t => t.divName.startsWith(conf)).slice(0, 7).forEach((t, i) => { seeds[t.teamId] = i + 1; });
  return teams.map(t => {
    const r = rec[t.teamId];
    const last = r.res[r.res.length - 1];
    let streak = 0;
    for (let i = r.res.length - 1; i >= 0 && r.res[i] === last; i--) streak++;
    const signed = last === 'L' ? -streak : last === 'W' ? streak : 0;
    const gp = Math.max(1, r.w + r.l + r.t);
    return {
      teamId: t.teamId, teamName: t.nickName, totalWins: r.w, totalLosses: r.l, totalTies: r.t, winPct: Math.round(pct(r) * 1000) / 1000,
      rank: rank[t.teamId], prevRank: prevRanks[t.teamId] || rank[t.teamId], seed: seeds[t.teamId] || 0, playoffStatus: seeds[t.teamId] ? 1 : 0,
      winLossStreak: signed < 0 ? 256 + signed : signed, divisionName: t.divName, conferenceName: t.divName.split(' ')[0],
      netPts: r.pf - r.pa, ptsFor: Math.round(r.pf / gp), ptsAgainst: Math.round(r.pa / gp), teamOvr: t.ovrRating,
      seasonIndex: 1, weekIndex, calendarYear: 2026, stageIndex: 1, capRoom: 0, capSpent: 0,
    };
  });
}

function demoBatches({ seed = 'hfl-nn-demo' } = {}) {
  const rand = seededRandom(seed);
  const teamsPayload = read('leagueteams');
  for (const t of teamsPayload.leagueTeamInfoList) t.userName = OWNERS[t.abbrName] || '';
  const teams = teamsPayload.leagueTeamInfoList;
  const byAbbr = Object.fromEntries(teams.map(t => [t.abbrName, t]));
  const week1 = read('week-reg-1-schedules').gameScheduleInfoList;
  const rosters = read('rosters');
  const fa = read('freeagents');

  // Week N pairings: rotate the Week 1 opponents so nobody repeats.
  const pairs = shift => week1.map((g, i) => ({ awayTeamId: g.homeTeamId, homeTeamId: week1[(i + shift) % week1.length].awayTeamId }));
  const scheduled = (list, weekIndex, idBase) => list.map((p, i) => ({ ...p, awayScore: 0, homeScore: 0, scheduleId: idBase + i, seasonIndex: 1, stageIndex: 1, weekIndex, status: 1, isGameOfTheWeek: false }));
  const week2Upcoming = scheduled(pairs(1), 1, 544736500);
  const week3Upcoming = scheduled(pairs(3), 2, 544737500);

  // Simulate Week 2: team strength plus luck, with a few headline results.
  const ovr = id => teams.find(t => t.teamId === id).ovrRating;
  const week2 = week2Upcoming.map((g, i) => {
    let home = Math.round(17 + (ovr(g.homeTeamId) - 83) * 0.9 + rand() * 17 + 2);
    let away = Math.round(17 + (ovr(g.awayTeamId) - 83) * 0.9 + rand() * 17);
    if (i === 2) { home = 27; away = 24; }           // a nail-biter
    if (i === 5) { away = 45; home = 10; }           // a blowout
    if (home === away) home += 3;
    return { ...g, homeScore: home, awayScore: away, status: home > away ? 3 : 2 };
  });
  const gotw = week2.slice().sort((a, b) => (ovr(b.homeTeamId) + ovr(b.awayTeamId)) - (ovr(a.homeTeamId) + ovr(a.awayTeamId)))[0];
  gotw.isGameOfTheWeek = true;
  const gameOfTeam = Object.fromEntries(week2.flatMap(g => [[g.homeTeamId, g.scheduleId], [g.awayTeamId, g.scheduleId]]));

  // Week 2 box scores: Week 1 lines with some variance.
  const week2Stats = {};
  for (const [kind, key] of Object.entries(STAT_LISTS)) {
    const rows = read(`week-reg-1-${kind}`)[key].map(r => {
      const f = 0.55 + rand() * 0.9;
      const out = { ...r, weekIndex: 1, scheduleId: gameOfTeam[r.teamId], statId: r.statId + 100000 };
      for (const [k, v] of Object.entries(r)) {
        if (typeof v !== 'number' || ['rosterId', 'teamId', 'scheduleId', 'seasonIndex', 'weekIndex', 'stageIndex', 'statId'].includes(k)) continue;
        out[k] = /TDs?$|Tds$|Ints|Sacks|FGs|Fum/.test(k) ? Math.max(0, Math.round(v * (0.4 + rand()))) : Math.round(v * f * 10) / 10;
        if (!/Rating|Pct|PerAtt/.test(k)) out[k] = Math.round(out[k]);
      }
      return out;
    });
    week2Stats[kind] = rows;
  }
  const qb = week2Stats.passing.sort((a, b) => b.passYds - a.passYds)[0];
  Object.assign(qb, { passYds: 412, passTDs: 4, passInts: 0, passComp: 31, passAtt: 40, passerRating: 138.4 });
  const rb = week2Stats.rushing.sort((a, b) => b.rushYds - a.rushYds)[0];
  Object.assign(rb, { rushYds: 181, rushTDs: 2, rushAtt: 24 });

  // Roster moves for batch 2.
  const r2 = clone(rosters);
  const fa2 = clone(fa);
  const roster = abbr => r2[byAbbr[abbr].teamId].rosterInfoList;
  const find = (abbr, last) => roster(abbr).find(p => p.lastName === last);
  const shakir = find('BUF', 'Shakir'), mcduffie = find('KC', 'McDuffie');
  if (shakir && mcduffie) {
    r2[byAbbr.BUF.teamId].rosterInfoList = roster('BUF').filter(p => p !== shakir).concat({ ...mcduffie, teamId: byAbbr.BUF.teamId });
    r2[byAbbr.KC.teamId].rosterInfoList = roster('KC').filter(p => p !== mcduffie).concat({ ...shakir, teamId: byAbbr.KC.teamId });
  }
  const conner = fa2.rosterInfoList.find(p => p.lastName === 'Conner') || fa2.rosterInfoList[0];
  fa2.rosterInfoList = fa2.rosterInfoList.filter(p => p !== conner);
  roster('DET').push({ ...conner, teamId: byAbbr.DET.teamId, isFreeAgent: false, contractLength: 1, contractYearsLeft: 1, contractSalary: 4500000, contractBonus: 500000 });
  const brown = find('PHI', 'Brown');
  if (brown) Object.assign(brown, { injuryLength: 4, injuryType: 12 });
  const cook = find('BUF', 'Cook');
  if (cook) cook.devTrait = 3;

  const s1 = standings(teams, week1, 1);
  const ranks1 = Object.fromEntries(s1.map(s => [s.teamId, s.rank]));
  const s2 = standings(teams, [...week1, ...week2], 2, ranks1);

  const batch1 = [
    { kind: 'teams', body: teamsPayload },
    { kind: 'standings', body: ok('teamStandingInfoList', s1) },
    { kind: 'week', stage: 'reg', week: 1, statKind: 'schedules', body: read('week-reg-1-schedules') },
    ...Object.keys(STAT_LISTS).map(k => ({ kind: 'week', stage: 'reg', week: 1, statKind: k, body: read(`week-reg-1-${k}`) })),
    { kind: 'week', stage: 'reg', week: 2, statKind: 'schedules', body: ok('gameScheduleInfoList', week2Upcoming) },
    ...Object.entries(rosters).map(([teamId, body]) => ({ kind: 'roster', teamId: Number(teamId), body })),
    { kind: 'freeagents', body: fa },
  ];
  const changed = ['BUF', 'KC', 'DET', 'PHI'].map(a => byAbbr[a].teamId);
  const batch2 = [
    { kind: 'teams', body: teamsPayload },
    { kind: 'standings', body: ok('teamStandingInfoList', s2) },
    { kind: 'week', stage: 'reg', week: 2, statKind: 'schedules', body: ok('gameScheduleInfoList', week2) },
    ...Object.entries(STAT_LISTS).map(([k, key]) => ({ kind: 'week', stage: 'reg', week: 2, statKind: k, body: ok(key, week2Stats[k]) })),
    { kind: 'week', stage: 'reg', week: 3, statKind: 'schedules', body: ok('gameScheduleInfoList', week3Upcoming) },
    ...changed.map(teamId => ({ kind: 'roster', teamId, body: r2[teamId] })),
    { kind: 'freeagents', body: fa2 },
  ];
  const tag = p => ({ platform: 'pc', leagueId: 'demo', source: 'sample', ...p });
  return [batch1.map(tag), batch2.map(tag)];
}

const SAMPLE_ARTICLE = {
  title: 'Is Buffalo Already the Team to Beat?',
  author: 'Crimson Chronicle Staff',
  url: null,
  body: [
    'Two weeks into the season, the Bills look like the class of the HFL. Josh Allen has been close to unstoppable, and HypnoKing just pushed his chips in with a blockbuster deal for cornerback Trent McDuffie.',
    'Not everyone is buying it. Over in Kansas City, BlitzBaron called the trade "panic with a press release" and insisted the Chiefs got the better end by landing receiver Khalil Shakir.',
    'The schedule gets tougher from here, and the Chronicle will be watching. For now, the rest of the league has been put on notice.',
  ].join('\n\n'),
};

const SAMPLE_HUB = {
  league: { name: 'Hypnotic Football League', season: 2026, phase: 'regular', week: 3 },
  owners: Object.entries(OWNERS).map(([teamAbbr, displayName], i) => ({ teamAbbr, displayName, titles: i === 0 ? 2 : i === 3 ? 1 : 0, note: i === 0 ? 'Two-time champion; mentions it constantly' : '' })),
  announcements: [
    { id: 'trade-deadline-2026', title: 'Trade deadline set for the Week 9 advance', body: 'All trades must be approved by the commissioner before the Week 9 advance. Deals submitted after that will be reversed.', date: '2026-10-01' },
  ],
  records: ['Most passing yards in a season: 5,102 by Josh Allen (2025)'],
  history: ['2025 champion: Buffalo Bills (HypnoKing)'],
};

module.exports = { demoBatches, SAMPLE_ARTICLE, SAMPLE_HUB, OWNERS };
