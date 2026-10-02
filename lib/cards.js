// On-screen graphic "cards": small JSON payloads the player draws (scoreboard,
// trade card, standings...). Built here from league data so every number on
// screen comes from the export, never from the script writer.
'use strict';
const L = require('./league');
const { money } = require('./util');

const DEV_SHORT = ['', 'STAR', 'SUPERSTAR', 'X-FACTOR'];

function teamRef(league, id) {
  const t = league.teams[id];
  if (!t) return { abbr: id === 0 ? 'FA' : '???', name: id === 0 ? 'Free Agent' : 'Unknown', color: '#444444', color2: '#999999' };
  return { abbr: t.abbr, name: `${t.city} ${t.nickname}`.trim(), nick: t.nickname, color: t.primary, color2: t.secondary };
}

function streakLabel(n) {
  if (!n) return '-';
  return (n > 0 ? 'W' : 'L') + Math.abs(n);
}

function markOf(status) {
  return { clinched_top_seed: 'z', clinched_division: 'y', clinched_playoffs: 'x' }[status] || '';
}

function gameSide(league, id, score) {
  const r = teamRef(league, id);
  return { abbr: r.abbr, name: r.name, nick: r.nick, score, color: r.color, color2: r.color2, record: L.recordOf(league, id) };
}

function scoreboard(league, games, label) {
  return {
    type: 'scoreboard',
    data: {
      label,
      games: games.map(g => ({
        away: gameSide(league, g.awayId, g.awayScore),
        home: gameSide(league, g.homeId, g.homeScore),
        winner: !g.played ? null : g.awayScore > g.homeScore ? 'away' : g.homeScore > g.awayScore ? 'home' : 'tie',
        final: g.played,
      })),
    },
  };
}

function game(league, g, label, performers = []) {
  return {
    type: 'game',
    data: {
      label,
      away: gameSide(league, g.awayId, g.awayScore),
      home: gameSide(league, g.homeId, g.homeScore),
      winner: g.awayScore > g.homeScore ? 'away' : g.homeScore > g.awayScore ? 'home' : 'tie',
      performers: performers.slice(0, 3).map(p => ({ name: p.name, team: p.team, line: p.line })),
    },
  };
}

function headline(tag, text, teamIds = [], league = null) {
  return {
    type: 'headline',
    data: { tag, text, teams: league ? teamIds.map(id => teamRef(league, id)) : [] },
  };
}

function standings(league, conference) {
  const rows = Object.values(league.standings).filter(s => s.conference === conference);
  const divisions = {};
  for (const s of rows) (divisions[s.division] ||= []).push(s);
  return {
    type: 'standings',
    data: {
      title: `${conference} STANDINGS`,
      divisions: Object.keys(divisions).sort().map(name => ({
        name: name.replace(conference, '').trim().toUpperCase(),
        rows: divisions[name]
          .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (b.netPts ?? 0) - (a.netPts ?? 0))
          .map(s => {
            const r = teamRef(league, s.teamId);
            return { abbr: r.abbr, color: r.color, color2: r.color2, rec: L.recordOf(league, s.teamId), streak: streakLabel(s.streak), mark: markOf(s.status) };
          }),
      })),
    },
  };
}

function playoffPicture(league) {
  const confs = {};
  for (const s of Object.values(league.standings)) {
    if (!s.seed) continue;
    (confs[s.conference] ||= []).push(s);
  }
  return {
    type: 'playoff_picture',
    data: {
      title: 'PLAYOFF PICTURE',
      conferences: Object.keys(confs).sort().map(name => ({
        name,
        rows: confs[name].sort((a, b) => a.seed - b.seed).slice(0, 7).map(s => {
          const r = teamRef(league, s.teamId);
          return { seed: s.seed, abbr: r.abbr, color: r.color, color2: r.color2, rec: L.recordOf(league, s.teamId), mark: markOf(s.status) };
        }),
      })),
    },
  };
}

function leaders(title, sections) {
  return { type: 'leaders', data: { title, sections: sections.filter(s => s.rows.length) } };
}

function playerCard(league, p, line, tag) {
  const r = teamRef(league, p.teamId);
  return {
    type: 'player',
    data: { tag, name: p.name, pos: p.pos, team: r.abbr, color: r.color, color2: r.color2, ovr: p.ovr, dev: DEV_SHORT[p.dev] || '', line },
  };
}

function trade(league, aId, bId, aGets, bGets) {
  const side = (id, list) => {
    const r = teamRef(league, id);
    return { abbr: r.abbr, name: r.name, color: r.color, color2: r.color2, gets: list.map(p => ({ name: p.name, pos: p.pos, ovr: p.ovr })) };
  };
  return { type: 'trade', data: { a: side(aId, aGets), b: side(bId, bGets) } };
}

function contractLine(c) {
  if (!c || !c.years) return '';
  const total = c.salary ? money(c.salary) : '';
  return `${c.years} YR${c.years === 1 ? '' : 'S'}${total ? ' / ' + total : ''}`;
}

function signing(league, tag, p, teamId, detail) {
  const r = teamRef(league, teamId);
  return {
    type: 'signing',
    data: {
      tag,
      player: { name: p.name, pos: p.pos, ovr: p.ovr, age: p.age, dev: DEV_SHORT[p.dev] || '' },
      team: { abbr: r.abbr, name: r.name, color: r.color, color2: r.color2 },
      detail: detail || '',
    },
  };
}

function injuryReport(league, players) {
  return {
    type: 'injury',
    data: {
      title: 'INJURY REPORT',
      rows: players.slice(0, 6).map(p => {
        const r = teamRef(league, p.teamId);
        return { name: p.name, pos: p.pos, team: r.abbr, color: r.color, color2: r.color2, detail: p.ir ? 'INJURED RESERVE' : `OUT ${p.injury} WK${p.injury === 1 ? '' : 'S'}`, ir: p.ir };
      }),
    },
  };
}

function quote(outlet, title, excerpt, author) {
  return { type: 'quote', data: { outlet, title, excerpt, author: author || '' } };
}

function matchups(league, games, title) {
  return {
    type: 'matchups',
    data: {
      title,
      games: games.map(g => ({ away: gameSide(league, g.awayId, null), home: gameSide(league, g.homeId, null) })),
    },
  };
}

function powerRankings(title, rows) {
  return { type: 'power_rankings', data: { title, rows: rows.slice(0, 10) } };
}

function bracket(league, rounds, title) {
  return {
    type: 'bracket',
    data: {
      title,
      rounds: rounds.map(r => ({
        name: r.name,
        games: r.games.map(g => ({
          away: { ...gameSide(league, g.awayId, g.played ? g.awayScore : null), seed: league.standings[g.awayId]?.seed || null },
          home: { ...gameSide(league, g.homeId, g.played ? g.homeScore : null), seed: league.standings[g.homeId]?.seed || null },
          played: g.played,
        })),
      })),
    },
  };
}

function corkboard(headlineText, pins, words) {
  return { type: 'corkboard', data: { headline: headlineText, pins, words } };
}

function breaking(text, tag = 'BREAKING NEWS') {
  return { type: 'breaking', data: { tag, text } };
}

module.exports = {
  teamRef, streakLabel, markOf, contractLine,
  scoreboard, game, headline, standings, playoffPicture, leaders, playerCard, trade, signing,
  injuryReport, quote, matchups, powerRankings, bracket, corkboard, breaking, DEV_SHORT,
};
