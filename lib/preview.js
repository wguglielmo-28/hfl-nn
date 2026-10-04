// Season-preview material for the Season Premiere, built from the rosters
// alone. The first export of a new league is a starting point, not news, so
// the story engine has nothing to say about it; a premiere still needs to
// tell viewers who the stars are, where they landed and how the teams stack
// up. These are story-shaped (id, headline, facts, card) so the rundown,
// both writers and the number check treat them like any other story.
'use strict';
const L = require('./league');
const C = require('./cards');

const DEV = L.DEV_TRAITS;

// Position groups, covering Madden 25-27 codes (Madden 27 renamed the edge
// rushers LEDG/REDG; older titles used LE/RE, LOLB/MLB/ROLB).
const GROUPS = [
  { key: 'qb', label: 'QUARTERBACKS', codes: ['QB'] },
  { key: 'skill', label: 'PLAYMAKERS', codes: ['HB', 'FB', 'WR', 'TE'] },
  { key: 'front', label: 'FRONT SEVEN', codes: ['LEDG', 'REDG', 'LEDGE', 'REDGE', 'LE', 'RE', 'DT', 'MIKE', 'WILL', 'SAM', 'MLB', 'LOLB', 'ROLB'] },
  { key: 'secondary', label: 'SECONDARY', codes: ['CB', 'FS', 'SS'] },
  { key: 'line', label: 'OFFENSIVE LINE', codes: ['LT', 'LG', 'C', 'RG', 'RT'] },
];

const listText = xs => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const byOvr = (a, b) => (b.ovr || 0) - (a.ovr || 0) || a.name.localeCompare(b.name);

function rostered(league) {
  return Object.values(league.players).filter(p => !p.departed && p.teamId > 0 && league.teams[p.teamId] && p.ovr != null);
}

function teamName(league, id) {
  const t = league.teams[id];
  return t ? `${t.city} ${t.nickname}`.trim() : 'Unknown';
}

function playerFact(league, p) {
  return { name: p.name, position: p.pos, team: teamName(league, p.teamId), overall: p.ovr, devTrait: DEV[p.dev] || 'Normal', age: p.age };
}

function previewStories(league) {
  const players = rostered(league);
  const teams = Object.values(league.teams);
  if (!players.length || teams.length < 2) return [];
  const at = new Date().toISOString();
  const out = [];
  const story = s => out.push({ teams: [], players: [], batchId: null, createdAt: at, ...s });

  // ── Where the stars landed ────────────────────────────────────────────
  const top = players.slice().sort(byOvr);
  const best = top[0];
  const topOvr = best.ovr;
  const atTop = top.filter(p => p.ovr === topOvr);
  const xf = players.filter(p => p.dev === 3);
  const groups = GROUPS.map(g => ({ ...g, players: top.filter(p => g.codes.includes(String(p.pos).toUpperCase())).slice(0, 3) }));
  story({
    id: 'preview:talent', type: 'talent', category: 'SEASON PREVIEW', score: 80,
    // A tie at the top is a tie: name some of them rather than crown whoever
    // sorts first alphabetically.
    headline: atTop.length > 1
      ? `${atTop.length} players share the league's top rating of ${topOvr} overall, including ${listText(atTop.slice(0, 3).map(p => p.name))}`
      : `${best.name} opens the season as the league's top-rated player at ${topOvr} overall`,
    teams: [...new Set(top.slice(0, 4).map(p => p.teamId))],
    players: top.slice(0, 4).map(p => p.key),
    facts: {
      topPlayers: top.slice(0, 15).map(p => playerFact(league, p)),
      playersRated90Plus: players.filter(p => p.ovr >= 90).length,
      xFactorPlayers: xf.length,
      bestByPositionGroup: Object.fromEntries(groups.map(g => [g.key, g.players.map(p => playerFact(league, p))])),
    },
    card: C.leaders('STARS BY POSITION', groups.slice(0, 4).map(g => ({
      label: g.label,
      rows: g.players.map(p => { const r = C.teamRef(league, p.teamId); return { name: p.name, team: r.abbr, color: r.color, color2: r.color2, value: p.ovr }; }),
    }))),
    extraCards: top.slice(0, 3).map(p => C.playerCard(league, p, [p.age != null && `AGE ${p.age}`, p.yearsPro != null && `${p.yearsPro === 0 ? 'ROOKIE' : `${p.yearsPro} YRS PRO`}`].filter(Boolean).join(' • '), 'TOP-RATED PLAYER')),
  });

  // ── Team by team, one conference at a time ────────────────────────────
  const xfBy = {}, rosterBy = {};
  for (const p of players) {
    (rosterBy[p.teamId] ||= []).push(p);
    if (p.dev === 3) xfBy[p.teamId] = (xfBy[p.teamId] || 0) + 1;
  }
  const teamFact = t => ({
    team: teamName(league, t.id), abbr: t.abbr, overall: t.ovr, owner: t.owner || 'CPU',
    xFactors: xfBy[t.id] || 0,
    bestPlayers: (rosterBy[t.id] || []).slice().sort(byOvr).slice(0, 3).map(p => ({ name: p.name, position: p.pos, overall: p.ovr })),
  });
  const rankedTeams = teams.filter(t => t.ovr != null).sort((a, b) => b.ovr - a.ovr || a.abbr.localeCompare(b.abbr));
  const conferences = [...new Set(teams.map(t => t.conference).filter(Boolean))].sort();
  for (const conf of conferences) {
    const inConf = teams.filter(t => t.conference === conf);
    const divisions = [...new Set(inConf.map(t => t.division))].sort();
    const leader = inConf.filter(t => t.ovr != null).sort((a, b) => b.ovr - a.ovr)[0];
    story({
      id: `preview:${conf.toLowerCase()}`, type: 'division_preview', category: `${conf} PREVIEW`, score: 60,
      headline: leader ? `${conf} preview: the ${leader.nickname} top the conference at ${leader.ovr} overall` : `${conf} preview`,
      teams: inConf.map(t => t.id),
      facts: {
        conference: conf,
        divisions: divisions.map(d => ({ division: d, teams: inConf.filter(t => t.division === d).sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).map(teamFact) })),
      },
      // The standings graphic, with team overall where the record would be.
      card: {
        type: 'standings',
        data: {
          title: `${conf} • TEAM OVERALL`,
          divisions: divisions.map(d => ({
            name: d.replace(conf, '').trim().toUpperCase(),
            rows: inConf.filter(t => t.division === d).sort((a, b) => (b.ovr || 0) - (a.ovr || 0)).map(t => {
              const r = C.teamRef(league, t.id);
              return { abbr: r.abbr, color: r.color, color2: r.color2, rec: t.ovr != null ? `${t.ovr} OVR` : '-', streak: '', mark: '' };
            }),
          })),
        },
      },
    });
  }

  // ── Debate: who has the best roster? ──────────────────────────────────
  if (rankedTeams.length >= 3) {
    const contenders = rankedTeams.slice(0, 4);
    const tied = rankedTeams.filter(t => t.ovr === contenders[0].ovr);
    story({
      id: 'preview:best-roster', type: 'team_preview', category: 'HOT TAKE', score: 70,
      headline: tied.length > 1
        ? `Best roster in the league: the ${listText(tied.map(t => t.nickname))} share the top team overall at ${tied[0].ovr}`
        : `Best roster in the league: the ${contenders[0].nickname} open the season on top at ${contenders[0].ovr} overall`,
      teams: contenders.map(t => t.id),
      facts: { topTeams: contenders.map(teamFact), lowestRated: teamFact(rankedTeams[rankedTeams.length - 1]) },
      card: C.powerRankings('TEAM OVERALL: TOP 4', contenders.map((t, i) => {
        const r = C.teamRef(league, t.id);
        return { rank: i + 1, abbr: r.abbr, color: r.color, color2: r.color2, rec: `${t.ovr} OVR`, move: 0 };
      })),
    });
  }

  // ── Conspiracy fodder: the X-Factor hoard ─────────────────────────────
  const hoard = Object.entries(xfBy).map(([id, n]) => ({ t: league.teams[id], n })).filter(x => x.t).sort((a, b) => b.n - a.n);
  if (hoard.length && hoard[0].n >= 2) {
    const most = hoard.filter(x => x.n === hoard[0].n);
    const none = teams.filter(t => !xfBy[t.id]).map(t => t.nickname).sort();
    story({
      id: 'preview:xfactors', type: 'roster_quirk', category: 'X-FACTORS', score: 50,
      headline: `${most.map(x => `The ${x.t.nickname}`).join(' and ')} ${most.length > 1 ? 'each have' : 'have'} ${hoard[0].n} X-Factor players${none.length ? `, while ${none.length} teams have none` : ''}`,
      teams: most.map(x => x.t.id),
      facts: { mostXFactors: most.map(x => ({ team: teamName(league, x.t.id), xFactors: x.n })), teamsWithNone: none, xFactorPlayers: xf.length },
      card: C.headline('X-FACTORS', `${most.map(x => x.t.abbr).join(' + ')}: ${hoard[0].n} X-FACTORS${most.length > 1 ? ' EACH' : ''}`, most.map(x => x.t.id), league),
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

module.exports = { previewStories, GROUPS };
