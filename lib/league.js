// The normalized league model: what HFL-NN knows about the HFL, built from
// Madden export payloads. Field names follow the Companion App / Snallabot
// export format (see test/fixtures/madden). Everything here is pure data in,
// data out — persistence and batching live in lib/ingest/madden.js.
//
// Export quirks handled here:
// - Weeks are 1-indexed on the route but `weekIndex` is 0-indexed in rows.
// - `stageIndex` 0 = preseason, 1 = regular season (playoffs are reg weeks 19–23).
// - Game status: 1 = not played, 2 = away win, 3 = home win, 4 = tie.
// - `winLossStreak` is an unsigned byte (254 = two-game losing streak).
// - Standings `ptsFor`/`ptsAgainst` are per-game averages; `netPts` is the season total.
// - `rosterId` gets reused, so players are keyed on presentationId + birth date.
// - Free agents carry teamId 0 / isFreeAgent.
// - `playoffStatus` 0/1 = outside/inside playoff position, 2-4 = clinched.
'use strict';
const { toSigned8, colorHex, clamp } = require('./util');

const DEV_TRAITS = ['Normal', 'Star', 'Superstar', 'X-Factor'];
// 0/1 mean outside/inside the current playoff seeds (the sample standings put
// every seed 8-16 team at 0 in Week 9), not "eliminated"/"undecided".
const PLAYOFF_STATUS = { 0: 'out', 1: 'in', 2: 'clinched_playoffs', 3: 'clinched_division', 4: 'clinched_top_seed' };
const GAME_STATUS = { 1: 'scheduled', 2: 'away_win', 3: 'home_win', 4: 'tie' };
const STAT_KINDS = ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'punting', 'teamstats'];
const ROUND_NAMES = { 19: 'Wild Card Round', 20: 'Divisional Round', 21: 'Conference Championships', 22: 'Pro Bowl', 23: 'Championship' };

// Fields kept from each weekly stat row (everything else is dropped on ingest).
const STAT_FIELDS = {
  passing: ['passAtt', 'passComp', 'passYds', 'passTDs', 'passInts', 'passSacks', 'passerRating', 'passLongest'],
  rushing: ['rushAtt', 'rushYds', 'rushTDs', 'rushFum', 'rushLongest', 'rushBrokenTackles', 'rushYdsAfterContact'],
  receiving: ['recCatches', 'recYds', 'recTDs', 'recLongest', 'recDrops', 'recYdsAfterCatch'],
  defense: ['defTotalTackles', 'defSacks', 'defInts', 'defForcedFum', 'defFumRec', 'defTDs', 'defDeflections', 'defSafeties'],
  kicking: ['fGMade', 'fGAtt', 'fGLongest', 'xPMade', 'xPAtt', 'kickPts'],
  punting: ['puntAtt', 'puntYds', 'puntLongest', 'puntNetYdsPerAtt'],
  teamstats: ['offTotalYds', 'offPassYds', 'offRushYds', 'offPassTDs', 'offRushTds', 'tOGiveaways', 'tOTakeaways', 'defSacks', 'penalties', 'penaltyYds'],
};

function emptyLeague() {
  return {
    version: 1,
    leagueId: null,
    platform: null,
    updatedAt: null,
    calendarYear: null,
    seasonIndex: null,
    teams: {},        // teamId → team
    standings: {},    // teamId → standing
    games: {},        // gameKey → game
    stats: {},        // "season-stage-week" → { kind: rows[] }
    players: {},      // playerKey → player
  };
}

const stageOf = (stageIndex, fallback) =>
  stageIndex === 0 ? 'pre' : stageIndex === 1 ? 'reg' : (fallback === 'pre' ? 'pre' : 'reg');
const weekKey = (seasonIndex, stage, week) => `${seasonIndex}-${stage}-${week}`;
const gameKey = (seasonIndex, stage, week, scheduleId) => `${seasonIndex}-${stage}-${week}-${scheduleId}`;

// Order weeks: preseason before regular season, then by number.
function weekOrd(seasonIndex, stage, week) {
  return (Number(seasonIndex) || 0) * 1000 + (stage === 'reg' ? 100 : 0) + (Number(week) || 0);
}

function playerKey(p) {
  if (p.presentationId && p.birthYear) return `${p.presentationId}-${p.birthYear}-${p.birthMonth || 0}-${p.birthDay || 0}`;
  return `r${p.rosterId}`;
}

// ─── Apply export payloads ─────────────────────────────────────────────────

function applyTeams(league, list) {
  // The export always carries all 32 teams, so replace rather than merge:
  // EA title updates can change team ids, and stale ids should not linger.
  const teams = {};
  for (const t of list || []) {
    if (t == null || t.teamId == null) continue;
    const division = t.divName || '';
    teams[t.teamId] = {
      id: t.teamId,
      abbr: t.abbrName || '',
      city: t.cityName || '',
      nickname: t.nickName || t.displayName || '',
      name: t.displayName || t.nickName || '',
      division,
      conference: division.split(' ')[0] || '',
      primary: colorHex(t.primaryColor),
      secondary: colorHex(t.secondaryColor),
      ovr: t.ovrRating ?? null,
      owner: t.userName || '',
      injuries: t.injuryCount ?? null,
    };
  }
  if (Object.keys(teams).length) league.teams = teams;
  return Object.keys(teams).length;
}

function applyStandings(league, list) {
  const standings = {};
  for (const s of list || []) {
    if (s == null || s.teamId == null) continue;
    standings[s.teamId] = {
      teamId: s.teamId,
      w: s.totalWins || 0,
      l: s.totalLosses || 0,
      t: s.totalTies || 0,
      pct: s.winPct ?? null,
      rank: s.rank ?? null,
      prevRank: s.prevRank ?? null,
      seed: s.seed || 0,
      status: PLAYOFF_STATUS[s.playoffStatus] || 'out',
      streak: toSigned8(s.winLossStreak),
      division: s.divisionName || '',
      conference: s.conferenceName || '',
      netPts: s.netPts ?? null,
      ppg: s.ptsFor ?? null,
      oppg: s.ptsAgainst ?? null,
      divW: s.divWins || 0, divL: s.divLosses || 0,
      confW: s.confWins || 0, confL: s.confLosses || 0,
      ovr: s.teamOvr ?? null,
      capRoom: s.capRoom ?? null,
      weekIndex: s.weekIndex ?? null,
      seasonIndex: s.seasonIndex ?? null,
      stage: stageOf(s.stageIndex),
    };
  }
  const first = (list || []).find(Boolean);
  if (first) {
    if (first.calendarYear) league.calendarYear = first.calendarYear;
    if (first.seasonIndex != null) league.seasonIndex = first.seasonIndex;
  }
  if (Object.keys(standings).length) league.standings = standings;
  return Object.keys(standings).length;
}

function applySchedules(league, list, route = {}) {
  let n = 0;
  for (const g of list || []) {
    if (g == null || g.scheduleId == null) continue;
    const seasonIndex = g.seasonIndex ?? league.seasonIndex ?? 0;
    const stage = stageOf(g.stageIndex, route.stage);
    const week = g.weekIndex != null ? g.weekIndex + 1 : Number(route.week) || 0;
    const key = gameKey(seasonIndex, stage, week, g.scheduleId);
    league.games[key] = {
      key, seasonIndex, stage, week,
      scheduleId: g.scheduleId,
      homeId: g.homeTeamId,
      awayId: g.awayTeamId,
      homeScore: g.homeScore || 0,
      awayScore: g.awayScore || 0,
      status: GAME_STATUS[g.status] || 'scheduled',
      played: Number(g.status) > 1,
      gotw: !!g.isGameOfTheWeek,
    };
    if (league.seasonIndex == null) league.seasonIndex = seasonIndex;
    n++;
  }
  return n;
}

function applyStats(league, kind, list, route = {}) {
  if (!STAT_FIELDS[kind]) return 0;
  const fields = STAT_FIELDS[kind];
  const byWeek = {};
  for (const r of list || []) {
    if (r == null) continue;
    const seasonIndex = r.seasonIndex ?? league.seasonIndex ?? 0;
    const stage = stageOf(r.stageIndex, route.stage);
    const week = r.weekIndex != null ? r.weekIndex + 1 : Number(route.week) || 0;
    const row = { rosterId: r.rosterId, name: r.fullName || '', teamId: r.teamId, scheduleId: r.scheduleId };
    for (const f of fields) if (r[f] != null) row[f] = r[f];
    (byWeek[weekKey(seasonIndex, stage, week)] ||= []).push(row);
  }
  for (const [wk, rows] of Object.entries(byWeek)) {
    (league.stats[wk] ||= {})[kind] = rows;
  }
  return (list || []).length;
}

function normalizePlayer(p, batchId) {
  const fa = !!p.isFreeAgent || p.teamId === 0;
  return {
    key: playerKey(p),
    rosterId: p.rosterId,
    first: p.firstName || '',
    last: p.lastName || '',
    name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    pos: p.position || '',
    teamId: fa ? 0 : p.teamId,
    age: p.age ?? null,
    ovr: p.playerBestOvr ?? p.overallRating ?? null,
    dev: clamp(Number(p.devTrait) || 0, 0, 3),
    injury: Number(p.injuryLength) || 0,
    injuryType: p.injuryType ?? null,
    ir: !!p.isOnIR,
    ps: !!p.isOnPracticeSquad,
    contract: {
      salary: p.contractSalary ?? null,
      years: p.contractLength ?? null,
      left: p.contractYearsLeft ?? null,
      bonus: p.contractBonus ?? null,
      capHit: p.capHit ?? null,
    },
    draft: { round: p.draftRound ?? null, pick: p.draftPick ?? null, year: p.rookieYear ?? null },
    yearsPro: p.yearsPro ?? null,
    jersey: p.jerseyNum ?? null,
    college: p.college || '',
    departed: false,
    departedFrom: null,
    seen: batchId || null,
  };
}

// A team's roster payload is its complete roster. Anyone we had on that team
// who isn't in it has left — traded, released, or retired. Their new home is
// filled in if they turn up in another roster or the free-agent list in the
// same batch; otherwise they stay "departed" and the story engine reports it.
// Works in any arrival order: a player already moved by an earlier payload
// isn't on the old team any more, so the later payload doesn't touch them.
function applyRoster(league, teamId, list, batchId) {
  const incoming = new Set();
  for (const raw of list || []) {
    if (raw == null) continue;
    const p = normalizePlayer({ ...raw, teamId: raw.teamId ?? teamId }, batchId);
    incoming.add(p.key);
    league.players[p.key] = p;
  }
  const tid = Number(teamId);
  for (const p of Object.values(league.players)) {
    if (p.teamId === tid && !incoming.has(p.key) && !p.departed) {
      p.departed = true;
      p.departedFrom = tid;
      p.teamId = -1;
    }
  }
  return incoming.size;
}

function applyFreeAgents(league, list, batchId) {
  const incoming = new Set();
  for (const raw of list || []) {
    if (raw == null) continue;
    const p = normalizePlayer({ ...raw, teamId: 0, isFreeAgent: true }, batchId);
    incoming.add(p.key);
    league.players[p.key] = p;
  }
  for (const p of Object.values(league.players)) {
    if (p.teamId === 0 && !incoming.has(p.key) && !p.departed) {
      p.departed = true;
      p.departedFrom = 0;
      p.teamId = -1;
    }
  }
  return incoming.size;
}

// ─── Queries ───────────────────────────────────────────────────────────────

function team(league, id) { return league.teams[id] || null; }

function teamLabel(league, id, style = 'full') {
  const t = team(league, id);
  if (!t) return id === 0 ? 'Free Agency' : 'Unknown';
  if (style === 'abbr') return t.abbr;
  if (style === 'nick') return t.nickname || t.name;
  return `${t.city} ${t.nickname}`.trim();
}

// Records are only quoted when the standings match the latest results — an
// old standings export next to this week's scores would put the wrong record
// in an anchor's mouth. See checkStandingsFresh.
function recordOf(league, id) {
  const s = league.standings[id];
  if (!s || league.standingsFresh === false) return '';
  return s.t ? `${s.w}-${s.l}-${s.t}` : `${s.w}-${s.l}`;
}

// Standings carry `weekIndex` = weeks completed when exported. They're current
// if that lines up with the latest week we have scores for (exported either
// just before or just after the advance). Sets and returns league.standingsFresh.
function checkStandingsFresh(league) {
  const any = Object.values(league.standings)[0];
  if (!any) return (league.standingsFresh = false);
  const wk = lastPlayedWeek(league);
  if (!wk || wk.stage !== 'reg' || wk.week >= 19) return (league.standingsFresh = true);
  const wi = any.weekIndex;
  league.standingsFresh = any.seasonIndex === wk.seasonIndex && (wi === wk.week || wi === wk.week - 1);
  return league.standingsFresh;
}

function gamesForWeek(league, seasonIndex, stage, week) {
  return Object.values(league.games)
    .filter(g => g.seasonIndex === seasonIndex && g.stage === stage && g.week === week)
    .sort((a, b) => a.scheduleId - b.scheduleId);
}

// The most recent week with at least one played game, or null.
function lastPlayedWeek(league) {
  let best = null;
  for (const g of Object.values(league.games)) {
    if (!g.played) continue;
    const ord = weekOrd(g.seasonIndex, g.stage, g.week);
    if (!best || ord > best.ord) best = { seasonIndex: g.seasonIndex, stage: g.stage, week: g.week, ord };
  }
  return best && { seasonIndex: best.seasonIndex, stage: best.stage, week: best.week };
}

// The most recent week whose games are all final, or null. The HFL's exporter
// runs every day, so the latest week with *a* result is usually still being
// played; a weekly show waits for the whole week.
function lastCompleteWeek(league) {
  const weeks = new Map();
  for (const g of Object.values(league.games)) {
    const ord = weekOrd(g.seasonIndex, g.stage, g.week);
    const w = weeks.get(ord) || { seasonIndex: g.seasonIndex, stage: g.stage, week: g.week, ord, done: true };
    w.done = w.done && !!g.played;
    weeks.set(ord, w);
  }
  let best = null;
  for (const w of weeks.values()) if (w.done && (!best || w.ord > best.ord)) best = w;
  return best && { seasonIndex: best.seasonIndex, stage: best.stage, week: best.week };
}

function weekComplete(league, wk) {
  const games = wk ? gamesForWeek(league, wk.seasonIndex, wk.stage, wk.week) : [];
  return games.length > 0 && games.every(g => g.played);
}

// The next week after `wk` that has scheduled games, or null.
function nextWeek(league, wk) {
  const from = wk ? weekOrd(wk.seasonIndex, wk.stage, wk.week) : -1;
  let best = null;
  for (const g of Object.values(league.games)) {
    const ord = weekOrd(g.seasonIndex, g.stage, g.week);
    if (ord <= from) continue;
    if (!best || ord < best.ord) best = { seasonIndex: g.seasonIndex, stage: g.stage, week: g.week, ord };
  }
  return best && { seasonIndex: best.seasonIndex, stage: best.stage, week: best.week };
}

function weekLabel(stage, week, championshipName = 'the Championship') {
  if (stage === 'pre') return `Preseason Week ${week}`;
  if (week >= 19) return week === 23 ? championshipName.replace(/^the /i, '').replace(/^./, c => c.toUpperCase()) : (ROUND_NAMES[week] || `Week ${week}`);
  return `Week ${week}`;
}

// Auto-detected phase; the control room can override it (offseason sub-phases
// like re-signing, free agency and the draft can't be told apart from exports).
function detectPhase(league) {
  const wk = lastPlayedWeek(league);
  if (!wk) return 'offseason';
  if (wk.stage === 'pre') return 'preseason';
  if (wk.week >= 23) return 'offseason';
  if (wk.week >= 19) return 'playoffs';
  return 'regular';
}

function rosterIndex(league) {
  const idx = new Map();
  for (const p of Object.values(league.players)) if (p.rosterId != null && !p.departed) idx.set(p.rosterId, p);
  return idx;
}

// Display name for a stat row: the roster's full name when we have it, else
// the export's abbreviated "J.Smith".
function statName(league, row, idx = rosterIndex(league)) {
  const p = idx.get(row.rosterId);
  return p ? p.name : (row.name || 'Unknown');
}

// Season-to-date totals per player for one stage, optionally up to a week.
function seasonTotals(league, seasonIndex, stage = 'reg', uptoWeek = Infinity) {
  const totals = {};
  for (const [wk, kinds] of Object.entries(league.stats)) {
    const [s, st, w] = wk.split('-');
    if (Number(s) !== seasonIndex || st !== stage || Number(w) > uptoWeek || Number(w) >= 19) continue;
    for (const kind of ['passing', 'rushing', 'receiving', 'defense', 'kicking']) {
      for (const row of kinds[kind] || []) {
        const t = (totals[row.rosterId] ||= { rosterId: row.rosterId, name: row.name, teamId: row.teamId, games: new Set() });
        t.teamId = row.teamId;
        t.games.add(row.scheduleId);
        for (const f of STAT_FIELDS[kind]) {
          if (typeof row[f] !== 'number') continue;
          if (/Longest$/.test(f)) t[f] = Math.max(t[f] || 0, row[f]);
          else if (f === 'passerRating') continue;
          else t[f] = (t[f] || 0) + row[f];
        }
      }
    }
  }
  for (const t of Object.values(totals)) t.games = t.games.size;
  return totals;
}

// What a batch snapshot keeps: enough to diff the next batch against.
// Stats are append-only by week, so they stay out of snapshots.
function snapshotOf(league) {
  return {
    takenAt: new Date().toISOString(),
    calendarYear: league.calendarYear,
    seasonIndex: league.seasonIndex,
    teams: league.teams,
    standings: league.standings,
    players: league.players,
    games: Object.fromEntries(Object.entries(league.games).filter(([, g]) => g.seasonIndex === league.seasonIndex)),
  };
}

// Departed players are kept (so a story can name them) until the season rolls
// over; then anyone who had already left before the previous snapshot is
// dropped. Players who left in the current batch survive one more round.
function pruneDeparted(league, prev) {
  if (!prev || prev.seasonIndex == null || league.seasonIndex == null || league.seasonIndex === prev.seasonIndex) return 0;
  let n = 0;
  for (const [k, p] of Object.entries(league.players)) {
    if (p.departed && (!prev.players?.[k] || prev.players[k].departed)) { delete league.players[k]; n++; }
  }
  return n;
}

module.exports = {
  DEV_TRAITS, PLAYOFF_STATUS, GAME_STATUS, STAT_KINDS, STAT_FIELDS, ROUND_NAMES,
  emptyLeague, stageOf, weekKey, gameKey, weekOrd, playerKey, normalizePlayer,
  applyTeams, applyStandings, applySchedules, applyStats, applyRoster, applyFreeAgents,
  team, teamLabel, recordOf, checkStandingsFresh, gamesForWeek, lastPlayedWeek, lastCompleteWeek, weekComplete, nextWeek, weekLabel, detectPhase,
  rosterIndex, statName, seasonTotals, snapshotOf, pruneDeparted,
};
