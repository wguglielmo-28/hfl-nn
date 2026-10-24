// Receipts: on-air predictions graded automatically from final scores.
//
// A prediction can carry a `check` the writer fills in when the facts can
// settle it later:
//   { kind: 'game', team: 'BUF', opponent: 'MIA', week: 7 }  BUF beats MIA in week 7
//   { kind: 'wins', team: 'BUF', wins: 11 }                    BUF wins at least 11 regular-season games
//   { kind: 'none' }                                           graded by the commissioner, as before
// Grading reads games only, never the standings export (its snapshots can be
// mid-week). Each export batch grades what it can; a graded prediction is a
// receipt until an episode calls it out.
'use strict';
const L = require('./league');
const { resolvePrediction } = require('./memory');

const REG_WEEKS = 18;
const isReg = g => g.stage === 'reg' && g.week >= 1 && g.week <= REG_WEEKS;

function teamByAbbr(league, abbr) {
  const a = String(abbr || '').toUpperCase();
  return a ? Object.values(league.teams || {}).find(t => String(t.abbr).toUpperCase() === a) || null : null;
}

const nameOf = t => t.nickname || t.abbr;
const score = (g, id) => (g.homeId === id ? [g.homeScore, g.awayScore] : [g.awayScore, g.homeScore]);

// → { status: 'right' | 'wrong', result } once the facts settle it, else null.
function gradePrediction(p, league) {
  const check = p?.check;
  if (!check || !check.kind || check.kind === 'none') return null;
  const season = p.seasonIndex ?? league.seasonIndex;
  const team = teamByAbbr(league, check.team);
  if (!team) return null;
  const games = Object.values(league.games || {}).filter(g => g.seasonIndex === season);

  if (check.kind === 'game') {
    const opp = teamByAbbr(league, check.opponent);
    if (!opp) return null;
    const g = games.find(x => Number(x.week) === Number(check.week)
      && ((x.homeId === team.id && x.awayId === opp.id) || (x.homeId === opp.id && x.awayId === team.id)));
    if (!g || !g.played) return null;
    const [us, them] = score(g, team.id);
    const label = L.weekLabel(g.stage, g.week);
    if (us > them) return { status: 'right', result: `The ${nameOf(team)} beat the ${nameOf(opp)} ${us} to ${them} in ${label}.` };
    if (us < them) return { status: 'wrong', result: `The ${nameOf(team)} lost to the ${nameOf(opp)} ${them} to ${us} in ${label}.` };
    return { status: 'wrong', result: `The ${nameOf(team)} and the ${nameOf(opp)} tied ${us} to ${them} in ${label}.` };
  }

  if (check.kind === 'wins') {
    const target = Number(check.wins);
    if (!Number.isInteger(target) || target < 1 || target > REG_WEEKS) return null;
    const mine = games.filter(g => isReg(g) && (g.homeId === team.id || g.awayId === team.id));
    if (!mine.length) return null;
    const wins = mine.filter(g => g.played && (([us, them]) => us > them)(score(g, team.id))).length;
    const left = mine.filter(g => !g.played).length;
    if (wins >= target) return { status: 'right', result: `The ${nameOf(team)} have ${wins} wins, so they got to ${target}.` };
    if (wins + left < target) return { status: 'wrong', result: `The ${nameOf(team)} have ${wins} wins with ${left} game${left === 1 ? '' : 's'} left, so ${target} is out of reach.` };
    return null;
  }
  return null;
}

// Ties each new prediction's check to something still to be played, against
// the league as the episode saw it (L.beforeWeek's view for a show that airs
// before its week):
// - a game pick to that unplayed meeting (the week the writer named, else the
//   teams' next meeting); no such game, no automatic grading;
// - a wins total to the season still being played, or to next season when
//   this one's regular season is over, so an offseason "12 wins next year"
//   isn't graded against the season that just ended.
function anchorChecks(predictions, league) {
  const games = Object.values(league.games || {});
  for (const p of predictions) {
    const check = p.check;
    if (!check) continue;
    const team = teamByAbbr(league, check.team);
    if (!team) { delete p.check; continue; }
    if (check.kind === 'game') {
      const opp = teamByAbbr(league, check.opponent);
      const meetings = opp ? games.filter(g => !g.played && ((g.homeId === team.id && g.awayId === opp.id) || (g.homeId === opp.id && g.awayId === team.id)))
        .sort((a, b) => L.weekOrd(a.seasonIndex, a.stage, a.week) - L.weekOrd(b.seasonIndex, b.stage, b.week)) : [];
      const g = meetings.find(x => Number(x.week) === Number(check.week)) || (check.week ? null : meetings[0]);
      if (!g) { delete p.check; continue; }
      p.check = { ...check, week: g.week };
      p.seasonIndex = g.seasonIndex;
    } else if (check.kind === 'wins') {
      const season = league.seasonIndex ?? 0;
      const left = games.some(g => g.seasonIndex === season && isReg(g) && !g.played && (g.homeId === team.id || g.awayId === team.id));
      p.seasonIndex = left ? season : season + 1;
    } else {
      delete p.check;
    }
  }
  return predictions;
}

// Grades every open prediction the league can now settle. Mutates `memory`
// (status, result, scoreboard) and returns the ones it graded.
function gradeOpenPredictions(memory, league, { now = new Date() } = {}) {
  const graded = [];
  for (const p of memory.predictions || []) {
    if (p.status !== 'open') continue;
    const r = gradePrediction(p, league);
    if (!r) continue;
    resolvePrediction(memory, p.id, r.status, { by: 'auto', result: r.result, at: now.toISOString() });
    graded.push(p);
  }
  return graded;
}

// Graded predictions no episode has called out yet, newest first.
function freshReceipts(memory, max = 4) {
  return (memory.predictions || [])
    .filter(p => (p.status === 'right' || p.status === 'wrong') && !p.calledOutIn)
    .sort((a, b) => String(b.gradedAt || b.at).localeCompare(String(a.gradedAt || a.at)))
    .slice(0, max);
}

module.exports = { gradePrediction, gradeOpenPredictions, anchorChecks, freshReceipts, teamByAbbr };
