// Season Kickoff material: the show that airs as the regular season starts.
// Preseason is over, rosters are cut to 53 and Week 1 is on the board. Built
// from a league that has already been rolled back to the start of Week 1
// (L.beforeWeek), so nothing here can know how a Week 1 game went. Like
// lib/preview.js these are story-shaped, so the rundown, both writers and the
// number check treat them like any other story.
'use strict';
const L = require('./league');
const C = require('./cards');

const DEV = L.DEV_TRAITS;
const ROMAN = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

// 9 → "IX". Season numbers only; anything else is not a season number.
function roman(n) {
  let x = Math.floor(Number(n));
  if (!(x >= 1 && x <= 99)) return null;
  let out = '';
  for (const [v, s] of [[90, 'XC'], [50, 'L'], [40, 'XL'], ...ROMAN]) while (x >= v) { out += s; x -= v; }
  return out;
}

// The season's number: Settings first, then the Hub's league.season when it
// is a number (the sample Hub sends a calendar year, which isn't).
function seasonLabel(settings = {}, hub = null) {
  const n = [settings.seasonNumber, hub?.league?.season].map(Number).find(v => v >= 1 && v <= 99);
  return n ? { number: n, label: `Season ${roman(n)}` } : null;
}

const n = v => Number(v) || 0;
const byOvr = (a, b) => (b.ovr || 0) - (a.ovr || 0) || a.name.localeCompare(b.name);
const teamName = (league, id) => C.teamRef(league, id).name;
const nick = (league, id) => C.teamRef(league, id).nick || C.teamRef(league, id).abbr;
const rec = r => (r.t ? `${r.w}-${r.l}-${r.t}` : `${r.w}-${r.l}`);
const leaderRow = (league, name, teamId, value) => {
  const t = C.teamRef(league, teamId);
  return { name, team: t.abbr, color: t.color, color2: t.color2, value };
};

// ── Preseason in review ────────────────────────────────────────────────────
function preseasonStory(league, season, at) {
  const games = Object.values(league.games).filter(g => g.seasonIndex === season && g.stage === 'pre' && g.played);
  if (!games.length) return null;
  const records = {};
  for (const id of Object.keys(league.teams)) records[id] = { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
  for (const g of games) {
    const h = records[g.homeId], a = records[g.awayId];
    if (!h || !a) continue;
    h.pf += g.homeScore; h.pa += g.awayScore; a.pf += g.awayScore; a.pa += g.homeScore;
    if (g.homeScore === g.awayScore) { h.t++; a.t++; } else if (g.homeScore > g.awayScore) { h.w++; a.l++; } else { a.w++; h.l++; }
  }
  const played = Object.entries(records).filter(([, r]) => r.w + r.l + r.t);
  const perfect = played.filter(([, r]) => !r.l && !r.t && r.w >= 2).map(([id, r]) => ({ team: teamName(league, id), record: rec(r) }));
  const winless = played.filter(([, r]) => !r.w && !r.t && r.l >= 2).map(([id, r]) => ({ team: teamName(league, id), record: rec(r) }));
  const final = g => {
    const [w, l] = g.homeScore >= g.awayScore ? [g.homeId, g.awayId] : [g.awayId, g.homeId];
    const [ws, ls] = g.homeScore >= g.awayScore ? [g.homeScore, g.awayScore] : [g.awayScore, g.homeScore];
    return { winner: teamName(league, w), loser: teamName(league, l), score: `${ws}-${ls}`, week: L.weekLabel('pre', g.week), margin: ws - ls };
  };
  const blowouts = games.slice().sort((a, b) => Math.abs(b.homeScore - b.awayScore) - Math.abs(a.homeScore - a.awayScore)).slice(0, 2).map(final);
  const thrillers = games.filter(g => g.homeScore !== g.awayScore && Math.abs(g.homeScore - g.awayScore) <= 3).slice(0, 2).map(final);
  const weeks = [...new Set(games.map(g => g.week))].sort((a, b) => a - b);

  const idx = L.rosterIndex(league);
  const totals = Object.values(L.seasonTotals(league, season, 'pre'));
  const top = (field, count = 3) => totals.filter(t => n(t[field]) > 0).sort((a, b) => n(b[field]) - n(a[field])).slice(0, count)
    .map(t => ({ name: idx.get(t.rosterId)?.name || t.name, teamId: t.teamId, value: n(t[field]) }));
  const leaders = { passingYards: top('passYds'), rushingYards: top('rushYds'), receivingYards: top('recYds'), sacks: top('defSacks') };
  const sections = [['PASS YDS', 'passingYards'], ['RUSH YDS', 'rushingYards'], ['REC YDS', 'receivingYards'], ['SACKS', 'sacks']]
    .map(([label, k]) => ({ label, rows: leaders[k].map(p => leaderRow(league, p.name, p.teamId, p.value)) }))
    .filter(s => s.rows.length);
  const factLeaders = Object.fromEntries(Object.entries(leaders).filter(([, v]) => v.length).map(([k, v]) => [k, v.map(p => `${p.name} (${C.teamRef(league, p.teamId).abbr}) ${p.value}`)]));

  const headline = perfect.length
    ? `Preseason wrap: ${perfect.length === 1 ? `the ${perfect[0].team.split(' ').pop()} ran the table` : `${perfect.length} teams went unbeaten`} as the exhibition slate closed`
    : `Preseason wrap: ${games.length} exhibition games are in the books`;
  return {
    id: `kickoff:preseason:${season}`, type: 'preseason_recap', category: 'PRESEASON', score: 65,
    headline, teams: [], players: [], batchId: null, createdAt: at,
    facts: {
      note: 'Preseason games are exhibitions: they do not count in the standings and starters often sit. Treat results as a hint, not proof.',
      preseasonWeeks: weeks.length, gamesPlayed: games.length,
      unbeaten: perfect, winless, biggestWins: blowouts, closestGames: thrillers,
      statLeaders: factLeaders,
    },
    card: sections.length ? C.leaders('PRESEASON LEADERS', sections) : C.headline('PRESEASON', headline.toUpperCase()),
  };
}

// ── Setting the 53 ─────────────────────────────────────────────────────────
// Who survived cut day: rookies who made it, the best players let go (wire
// releases whose player is still unsigned), the best free agents left, and
// roster ages. The export has no cut-day log, so "released" means released
// this offseason or preseason and still a free agent.
function rosterStory(league, wire, at) {
  const active = Object.values(league.players).filter(p => !p.departed && p.teamId > 0 && league.teams[p.teamId] && !p.ps);
  if (!active.length) return null;
  const free = Object.values(league.players).filter(p => !p.departed && p.teamId === 0 && p.ovr != null).sort(byOvr);
  const byTeam = {};
  for (const p of active) (byTeam[p.teamId] ||= []).push(p);
  const practice = Object.values(league.players).filter(p => !p.departed && p.teamId > 0 && p.ps).length;

  const releases = (wire || []).filter(s => s.type === 'release' && !s.excluded && !s.retired && s.players?.[0] && league.players[s.players[0]]?.teamId === 0);
  const cut = [...new Map(releases.map(s => [s.players[0], s])).values()]
    .sort((a, b) => (b.facts.player?.overall || 0) - (a.facts.player?.overall || 0)).slice(0, 6);
  const rookies = active.filter(p => p.yearsPro === 0).sort(byOvr);
  const ages = Object.entries(byTeam).map(([id, ps]) => {
    const withAge = ps.filter(p => p.age != null);
    return { id: Number(id), avg: withAge.length ? withAge.reduce((s, p) => s + p.age, 0) / withAge.length : null };
  }).filter(x => x.avg != null).sort((a, b) => a.avg - b.avg);
  // Injured reserve doesn't count against the 53.
  const off53 = Object.entries(byTeam).map(([id, ps]) => [id, ps.filter(p => !p.ir).length]).filter(([, count]) => count !== 53)
    .map(([id, count]) => ({ team: teamName(league, id), activePlayers: count }));

  const fact = p => ({ name: p.name, position: p.pos, overall: p.ovr, age: p.age, devTrait: DEV[p.dev] || 'Normal' });
  const sections = [
    cut.length && { label: 'RELEASED, UNSIGNED', rows: cut.slice(0, 3).map(s => leaderRow(league, s.facts.player.name, s.teams[0], s.facts.player.overall)) },
    free.length && { label: 'BEST AVAILABLE', rows: free.slice(0, 3).map(p => ({ ...leaderRow(league, p.name, 0, p.ovr), team: 'FA' })) },
    rookies.length && { label: 'TOP ROOKIES', rows: rookies.slice(0, 3).map(p => leaderRow(league, p.name, p.teamId, p.ovr)) },
  ].filter(Boolean);
  const top = cut[0];
  return {
    id: 'kickoff:rosters', type: 'cutdown', category: 'FINAL CUTS', score: 62,
    headline: top
      ? `Cut day is done: ${top.facts.player.name} leads the list of released players still looking for work`
      : `Cut day is done: ${Object.keys(byTeam).length} teams have set their regular-season rosters`,
    teams: [...new Set(cut.map(s => s.teams[0]))].slice(0, 4), players: cut.map(s => s.players[0]), batchId: null, createdAt: at,
    // The wire's release stories this one covers, so The Wire doesn't repeat them.
    covers: cut.map(s => s.id),
    facts: {
      note: 'Rosters as of the start of Week 1. "Released" means let go this offseason or preseason and still unsigned; the export has no cut-day log, so never say exactly when a player was cut.',
      teamsWithRosters: Object.keys(byTeam).length,
      ...(off53.length && off53.length < 10 ? { teamsNotAt53Active: off53 } : {}),
      practiceSquadPlayers: practice,
      releasedStillUnsigned: cut.map(s => ({ ...s.facts.player, releasedBy: s.facts.team })),
      bestAvailableFreeAgents: free.slice(0, 6).map(fact),
      rookiesOnActiveRosters: rookies.length,
      topRookies: rookies.slice(0, 5).map(p => ({ ...fact(p), team: teamName(league, p.teamId) })),
      ...(ages.length >= 2 ? {
        youngestRoster: { team: teamName(league, ages[0].id), averageAge: Math.round(ages[0].avg * 10) / 10 },
        oldestRoster: { team: teamName(league, ages[ages.length - 1].id), averageAge: Math.round(ages[ages.length - 1].avg * 10) / 10 },
      } : {}),
    },
    card: sections.length ? C.leaders('SETTING THE 53', sections) : C.headline('FINAL CUTS', 'ROSTERS ARE SET'),
    extraCards: top ? [C.signing(league, 'RELEASED', league.players[top.players[0]], top.teams[0], `${top.facts.player.overall} OVR • STILL UNSIGNED`)] : [],
  };
}

// ── The Week 1 slate ───────────────────────────────────────────────────────
// Every game on the board, best first: the Hub's Game of the Week if it named
// one, then owner-vs-owner games, then the best combined roster.
function slateStory(league, wk, hub, at) {
  const games = L.gamesForWeek(league, wk.seasonIndex, wk.stage, wk.week);
  if (!games.length) return null;
  const pick = (hub?.gamesOfTheWeek || []).find(g => g.stage === wk.stage && g.week === wk.week);
  const want = pick ? [pick.away, pick.home].map(x => String(x).toUpperCase()).sort().join('|') : null;
  const abbr = id => String(league.teams[id]?.abbr || '').toUpperCase();
  const official = want && games.find(g => [abbr(g.awayId), abbr(g.homeId)].sort().join('|') === want);
  const ovr = id => league.teams[id]?.ovr || 0;
  const owned = id => (league.teams[id]?.owner ? 1 : 0);
  const weight = g => (g === official ? 1e6 : 0) + (owned(g.homeId) + owned(g.awayId)) * 1000 + ovr(g.homeId) + ovr(g.awayId) - Math.abs(ovr(g.homeId) - ovr(g.awayId)) / 2;
  const ranked = games.slice().sort((a, b) => weight(b) - weight(a));
  const side = id => ({ team: teamName(league, id), abbr: C.teamRef(league, id).abbr, overall: league.teams[id]?.ovr ?? null, owner: league.teams[id]?.owner || 'CPU' });
  const lead = ranked[0];
  const label = L.weekLabel(wk.stage, wk.week);
  // Team overall in the record slot: before kickoff every record is 0-0.
  const withOvr = g => {
    const m = C.matchups(league, [g], '').data.games[0];
    for (const [k, id] of [['away', g.awayId], ['home', g.homeId]]) m[k].record = ovr(id) ? `${ovr(id)} OVR` : '';
    return m;
  };
  const slate = C.scoreboard(league, ranked, `${label.toUpperCase()} • THE SLATE`);
  slate.data.right = 'KICKOFF';
  for (const g of slate.data.games) { g.away.score = null; g.home.score = null; }
  return {
    id: `kickoff:slate:${wk.seasonIndex}-${wk.stage}-${wk.week}`, type: 'slate', category: label.toUpperCase(), score: 75,
    headline: `${label} kicks off with the ${nick(league, lead.awayId)} at the ${nick(league, lead.homeId)}${official ? ', the league\'s Game of the Week' : ''}`,
    teams: [lead.awayId, lead.homeId], players: [], batchId: null, createdAt: at,
    facts: {
      week: label,
      note: `None of the ${label} games has been played yet. Never state or hint at a result.`,
      gameOfTheWeek: official ? { away: side(official.awayId), home: side(official.homeId) } : null,
      spotlight: official ? null : { away: side(lead.awayId), home: side(lead.homeId), why: owned(lead.homeId) + owned(lead.awayId) === 2 ? 'owner against owner, best combined roster' : 'best combined roster on the slate' },
      ownerVsOwnerGames: games.filter(g => owned(g.homeId) && owned(g.awayId)).length,
      games: ranked.map(g => ({ away: side(g.awayId), home: side(g.homeId) })),
    },
    card: slate,
    extraCards: [{ type: 'matchups', data: { title: official ? 'GAME OF THE WEEK + MORE' : 'MATCHUPS TO WATCH', games: ranked.slice(0, 5).map(withOvr) } }],
    official: !!official,
  };
}

function kickoffStories(league, { wire = [], hub = null } = {}) {
  const season = league.seasonIndex ?? 0;
  const at = new Date().toISOString();
  const out = [
    preseasonStory(league, season, at),
    rosterStory(league, wire, at),
    slateStory(league, { seasonIndex: season, stage: 'reg', week: 1 }, hub, at),
  ].filter(Boolean);
  return out.sort((a, b) => b.score - a.score);
}

module.exports = { kickoffStories, seasonLabel, roman };
