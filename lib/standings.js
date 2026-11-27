// The Standings Center (/standings): the playoff race as of the latest
// export. Each conference's seven playoff seeds, the teams chasing them with
// how far back they are, who has clinched (from EA's playoff status) and who
// can no longer get in, plus every division table.
//
// Elimination is worked out only where it is certain, never by tiebreaker:
// a team is out when, even winning every game left, it would still finish
// behind at least seven conference teams' current marks AND behind its own
// division leader's current mark. Seven teams ahead hold at most four
// division titles, so at least three non-division-winners finish ahead of it
// for the three wild cards, and it cannot win its division.
'use strict';

const L = require('./league');
const { coachFor } = require('./coaches');

const SEASON_GAMES = 17;
const SEEDS = 7;
const STATUS = {
  clinched_top_seed: { mark: 'z', label: 'Clinched the No. 1 seed' },
  clinched_division: { mark: 'y', label: 'Clinched the division' },
  clinched_playoffs: { mark: 'x', label: 'Clinched a playoff spot' },
};

const points = s => s.w + s.t / 2;
const record = s => (s.t ? `${s.w}-${s.l}-${s.t}` : `${s.w}-${s.l}`);
// Games behind b (positive when a trails).
const gamesBack = (a, b) => ((b.w - a.w) + (a.l - b.l)) / 2;

function nextGame(league, s) {
  let best = null;
  for (const g of Object.values(league.games || {})) {
    if (g.played || g.seasonIndex !== s.seasonIndex || g.stage !== 'reg' || g.week >= 19) continue;
    if (g.homeId !== s.teamId && g.awayId !== s.teamId) continue;
    if (!best || g.week < best.week) best = g;
  }
  if (!best) return null;
  const home = best.homeId === s.teamId;
  const opp = league.teams[home ? best.awayId : best.homeId];
  return { week: best.week, home, opp: opp?.abbr || '?' };
}

function standingsReport(league) {
  const rows = Object.values(league?.standings || {}).filter(s => league.teams?.[s.teamId]);
  if (!rows.length) return { ready: false, note: 'No standings yet: they arrive with the next Madden export.' };
  const stage = rows[0].stage;
  const fresh = L.checkStandingsFresh({ ...league });
  const view = rows.map(s => {
    const t = league.teams[s.teamId];
    const played = s.w + s.l + s.t;
    const left = stage === 'reg' && played < SEASON_GAMES ? SEASON_GAMES - played : 0;
    const c = coachFor(t.abbr);
    return {
      teamId: s.teamId, abbr: t.abbr, name: `${t.city} ${t.nickname}`.trim(), nick: t.nickname || t.name,
      color: t.primary || null, coach: c?.coach || null,
      conference: s.conference, division: s.division, w: s.w, l: s.l, t: s.t, rec: record(s), pct: s.pct,
      seed: s.seed || 0, streak: s.streak ? `${s.streak > 0 ? 'W' : 'L'}${Math.abs(s.streak)}` : '-',
      divRec: `${s.divW}-${s.divL}`, confRec: `${s.confW}-${s.confL}`, netPts: s.netPts,
      left, best: points(s) + left,
      clinch: STATUS[s.status] || null,
      next: left ? nextGame(league, s) : null,
      _s: s,
    };
  });

  const conferences = [...new Set(view.map(r => r.conference))].sort().map(name => {
    const conf = view.filter(r => r.conference === name).sort((a, b) => (a.seed || 99) - (b.seed || 99) || b.pct - a.pct);
    const divisions = [...new Set(conf.map(r => r.division))].sort().map(dn => {
      const list = conf.filter(r => r.division === dn).sort((a, b) => b.pct - a.pct || (a.seed || 99) - (b.seed || 99));
      for (const r of list) r.divBack = gamesBack(r._s, list[0]._s);
      return { name: dn, teams: list };
    });
    const last = conf.find(r => r.seed === SEEDS);
    // With no games left the seeds are final: everyone outside them is out.
    const over = stage === 'reg' && conf.every(r => !r.left);
    for (const r of conf) {
      const ahead = conf.filter(o => o !== r && points(o._s) > r.best).length;
      const leader = divisions.find(d => d.name === r.division).teams[0];
      const outside = r.seed > SEEDS || !r.seed;
      r.eliminated = stage === 'reg' && !r.clinch && outside && (over || (ahead >= SEEDS && leader !== r && points(leader._s) > r.best));
      r.back = last && r.seed > SEEDS ? gamesBack(r._s, last._s) : 0;
      r.state = r.clinch ? 'clinched' : r.seed && r.seed <= SEEDS ? 'in' : r.eliminated ? 'out' : 'hunt';
    }
    return {
      name,
      seeds: conf.filter(r => r.seed && r.seed <= SEEDS),
      hunt: conf.filter(r => r.state === 'hunt'),
      out: conf.filter(r => r.state === 'out'),
      divisions,
    };
  });
  const strip = r => { const { _s, best, ...rest } = r; return rest; };
  for (const c of conferences) {
    for (const k of ['seeds', 'hunt', 'out']) c[k] = c[k].map(strip);
    for (const d of c.divisions) d.teams = d.teams.map(strip);
  }
  const wk = L.lastCompleteWeek(league);
  return {
    ready: true, stage, fresh, updatedAt: league.updatedAt || null,
    through: wk ? L.weekLabel(wk.stage, wk.week) : null,
    note: stage === 'pre' ? 'Preseason: the seeds are only a projection until Week 1.'
      : !fresh ? 'The latest standings export is behind the scores; records may be a week old.' : null,
    conferences,
  };
}

module.exports = { standingsReport, gamesBack, SEEDS };
