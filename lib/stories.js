// The story engine. Compares the league before and after an export batch and
// turns what changed into ranked "wire" stories, each with structured facts
// (the only numbers the script writer may use) and an on-screen card.
//
// detectStories({ prev, cur, batch }) → stories[]   (what's new)
// buildContext(cur, opts)            → { focusWeek, scoreboard, standings, ... }  (current state, for graphics)
'use strict';
const L = require('./league');
const C = require('./cards');
const { clamp, money } = require('./util');

const DEV = L.DEV_TRAITS;

// ─── Stat lines ────────────────────────────────────────────────────────────
const n = v => Number(v) || 0;
function passLine(r) { return `${n(r.passComp)}/${n(r.passAtt)}, ${n(r.passYds)} yds, ${n(r.passTDs)} TD, ${n(r.passInts)} INT`; }
function rushLine(r) { return `${n(r.rushAtt)} car, ${n(r.rushYds)} yds, ${n(r.rushTDs)} TD`; }
function recLine(r) { return `${n(r.recCatches)} rec, ${n(r.recYds)} yds, ${n(r.recTDs)} TD`; }
function defLine(r) {
  const bits = [`${n(r.defTotalTackles)} tkl`];
  if (n(r.defSacks)) bits.push(`${n(r.defSacks)} sack${n(r.defSacks) === 1 ? '' : 's'}`);
  if (n(r.defInts)) bits.push(`${n(r.defInts)} INT`);
  if (n(r.defForcedFum)) bits.push(`${n(r.defForcedFum)} FF`);
  if (n(r.defTDs)) bits.push(`${n(r.defTDs)} TD`);
  return bits.join(', ');
}
const impact = {
  passing: r => n(r.passYds) / 25 + 4 * n(r.passTDs) - 2 * n(r.passInts),
  rushing: r => n(r.rushYds) / 10 + 6 * n(r.rushTDs) - 2 * n(r.rushFum),
  receiving: r => n(r.recYds) / 10 + 6 * n(r.recTDs) + n(r.recCatches) * 0.5,
  defense: r => n(r.defSacks) * 4 + n(r.defInts) * 5 + n(r.defTDs) * 6 + n(r.defTotalTackles) * 0.5 + n(r.defForcedFum) * 3,
};
const lineFor = { passing: passLine, rushing: rushLine, receiving: recLine, defense: defLine };

function weekRows(league, wk) {
  return wk ? league.stats[L.weekKey(wk.seasonIndex, wk.stage, wk.week)] || {} : {};
}

// Best performers in one game (or a whole week when scheduleId is null).
function topPerformers(league, wk, scheduleId = null, idx = L.rosterIndex(league)) {
  const rows = weekRows(league, wk);
  const out = [];
  for (const kind of ['passing', 'rushing', 'receiving', 'defense']) {
    const list = (rows[kind] || []).filter(r => scheduleId == null || r.scheduleId === scheduleId);
    const best = list.slice().sort((a, b) => impact[kind](b) - impact[kind](a))[0];
    if (!best || impact[kind](best) <= 0) continue;
    const p = idx.get(best.rosterId);
    out.push({
      kind, rosterId: best.rosterId, key: p?.key || null,
      name: L.statName(league, best, idx), team: C.teamRef(league, best.teamId).abbr, teamId: best.teamId,
      line: lineFor[kind](best), score: impact[kind](best), row: best,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ─── Game stories ──────────────────────────────────────────────────────────

// Record before this game: the previous snapshot when it is exactly one game
// behind, else the result backed out of current standings. Null unless the
// standings are known to match this week's results.
function preGameRecord(prev, cur, teamId, g) {
  if (g.stage !== 'reg' || g.week >= 19 || cur.standingsFresh === false) return null;
  const cs = cur.standings[teamId];
  if (!cs) return null;
  const ps = prev?.standings?.[teamId];
  const total = s => s.w + s.l + s.t;
  if (ps && total(ps) === total(cs) - 1) return { w: ps.w, l: ps.l, t: ps.t };
  const won = (g.homeId === teamId ? g.homeScore > g.awayScore : g.awayScore > g.homeScore);
  const tie = g.homeScore === g.awayScore;
  return { w: cs.w - (won && !tie ? 1 : 0), l: cs.l - (!won && !tie ? 1 : 0), t: cs.t - (tie ? 1 : 0) };
}

function gameStory(prev, cur, g, idx) {
  const label = L.weekLabel(g.stage, g.week);
  const home = cur.teams[g.homeId], away = cur.teams[g.awayId];
  if (!home || !away) return null;
  const homeWon = g.homeScore > g.awayScore;
  const tie = g.homeScore === g.awayScore;
  const [wId, lId] = homeWon ? [g.homeId, g.awayId] : [g.awayId, g.homeId];
  const W = cur.teams[wId], Lt = cur.teams[lId];
  const ws = Math.max(g.homeScore, g.awayScore), ls = Math.min(g.homeScore, g.awayScore);
  const margin = ws - ls;

  const flags = [];
  const wPre = preGameRecord(prev, cur, wId, g), lPre = preGameRecord(prev, cur, lId, g);
  const pct = r => (r && r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : null);
  const ovrGap = (Lt.ovr ?? 0) - (W.ovr ?? 0);
  const recGap = pct(lPre) != null && pct(wPre) != null && lPre.w + lPre.l >= 3 ? pct(lPre) - pct(wPre) : 0;
  if (!tie && (ovrGap >= 4 || recGap >= 0.25)) flags.push('upset');
  if (tie) flags.push('tie');
  else if (margin <= 3) flags.push('nail-biter');
  if (margin >= 28) flags.push('blowout');
  if (!tie && ls === 0) flags.push('shutout');
  if (ws + ls >= 70) flags.push('shootout');
  if (g.gotw) flags.push('game-of-the-week');
  if (g.week >= 19) flags.push('playoffs');
  const humans = [home, away].filter(t => t.owner).length;

  let score = 25 + humans * 8;
  if (flags.includes('upset')) score += 25;
  if (flags.includes('nail-biter')) score += 15;
  if (flags.includes('blowout')) score += 10;
  if (flags.includes('shutout')) score += 15;
  if (flags.includes('shootout')) score += 10;
  if (flags.includes('game-of-the-week')) score += 15;
  if (flags.includes('playoffs')) score += 25;

  const verb = tie ? 'tie' : ls === 0 ? 'blank' : flags.includes('upset') ? 'stun'
    : margin >= 28 ? 'rout' : margin >= 17 ? 'roll past' : margin <= 3 ? 'edge' : 'beat';
  const headline = tie
    ? `${away.nickname} and ${home.nickname} tie ${ws}-${ls}`
    : `${W.nickname} ${verb} ${Lt.nickname} ${ws}-${ls}`;

  const performers = topPerformers(cur, g, g.scheduleId, idx);
  return {
    id: `game:${g.key}`,
    type: 'game',
    category: flags.includes('upset') ? 'UPSET' : flags.includes('playoffs') ? 'PLAYOFFS' : 'FINAL',
    score: clamp(score, 0, 100),
    headline,
    teams: [g.awayId, g.homeId],
    players: performers.map(p => p.key).filter(Boolean),
    week: { seasonIndex: g.seasonIndex, stage: g.stage, week: g.week },
    facts: {
      week: label,
      away: { team: `${away.city} ${away.nickname}`, abbr: away.abbr, owner: away.owner || null, score: g.awayScore, recordAfter: L.recordOf(cur, g.awayId) || null },
      home: { team: `${home.city} ${home.nickname}`, abbr: home.abbr, owner: home.owner || null, score: g.homeScore, recordAfter: L.recordOf(cur, g.homeId) || null },
      winner: tie ? null : W.nickname,
      margin,
      flags,
      topPerformers: performers.map(p => `${p.name} (${p.team}): ${p.line}`),
    },
    card: C.game(cur, g, label.toUpperCase(), performers),
  };
}

// ─── Individual performances and milestones ────────────────────────────────
const THRESHOLDS = [
  ['passing', 'passYds', 350, 'passing yards'], ['passing', 'passTDs', 4, 'passing touchdowns'],
  ['rushing', 'rushYds', 150, 'rushing yards'], ['rushing', 'rushTDs', 3, 'rushing touchdowns'],
  ['receiving', 'recYds', 150, 'receiving yards'], ['receiving', 'recTDs', 3, 'receiving touchdowns'],
  ['defense', 'defSacks', 3, 'sacks'], ['defense', 'defInts', 2, 'interceptions'], ['defense', 'defTDs', 1, 'defensive touchdowns'],
  ['kicking', 'fGLongest', 55, 'yard field goal'],
];

function performanceStories(cur, wk, idx) {
  const rows = weekRows(cur, wk);
  const byPlayer = new Map();
  for (const [kind, field, min, label] of THRESHOLDS) {
    for (const r of rows[kind] || []) {
      if (n(r[field]) < min) continue;
      const e = byPlayer.get(r.rosterId) || { row: r, hits: [], kinds: new Set(), score: 0 };
      e.hits.push({ field, value: n(r[field]), label });
      e.kinds.add(kind);
      e.score += 30 + Math.min(30, ((n(r[field]) - min) / Math.max(1, min)) * 60);
      byPlayer.set(r.rosterId, e);
    }
  }
  const out = [];
  for (const [rosterId, e] of byPlayer) {
    const p = idx.get(rosterId);
    const name = L.statName(cur, e.row, idx);
    const team = C.teamRef(cur, e.row.teamId);
    const top = e.hits.sort((a, b) => b.value - a.value)[0];
    const line = [...e.kinds].filter(k => lineFor[k]).map(k => lineFor[k](rows[k].find(r => r.rosterId === rosterId))).join('; ');
    const headline = top.field === 'fGLongest'
      ? `${name} drills a ${top.value}-yard field goal`
      : `${name} piles up ${top.value} ${top.label}`;
    out.push({
      id: `perf:${wk.seasonIndex}-${wk.stage}-${wk.week}-${rosterId}`,
      type: 'performance',
      category: 'BIG GAME',
      score: clamp(e.score, 0, 80),
      headline,
      teams: [e.row.teamId],
      players: p ? [p.key] : [],
      week: wk,
      facts: { player: name, position: p?.pos || null, team: team.name, statLine: line || `${top.value} ${top.label}`, highlights: e.hits.map(h => `${h.value} ${h.label}`) },
      card: p ? C.playerCard(cur, p, line, 'BIG GAME') : C.headline('BIG GAME', headline, [e.row.teamId], cur),
    });
  }
  return out;
}

const MILESTONES = [
  ['passYds', [1000, 2000, 3000, 4000, 5000], 'passing yards'], ['passTDs', [10, 20, 30, 40, 50], 'passing touchdowns'],
  ['rushYds', [500, 1000, 1500, 2000], 'rushing yards'], ['rushTDs', [10, 15, 20], 'rushing touchdowns'],
  ['recYds', [500, 1000, 1500, 2000], 'receiving yards'], ['recTDs', [10, 15, 20], 'receiving touchdowns'],
  ['defSacks', [5, 10, 15, 20], 'sacks'], ['defInts', [5, 8, 10], 'interceptions'],
];

function milestoneStories(cur, wk, idx) {
  if (!wk || wk.stage !== 'reg' || wk.week >= 19) return [];
  const before = L.seasonTotals(cur, wk.seasonIndex, 'reg', wk.week - 1);
  const after = L.seasonTotals(cur, wk.seasonIndex, 'reg', wk.week);
  const out = [];
  for (const [rosterId, t] of Object.entries(after)) {
    const b = before[rosterId] || {};
    for (const [field, marks, label] of MILESTONES) {
      const crossed = marks.filter(m => n(b[field]) < m && n(t[field]) >= m).pop();
      if (!crossed) continue;
      const p = idx.get(Number(rosterId));
      const name = p?.name || t.name;
      out.push({
        id: `milestone:${wk.seasonIndex}-${rosterId}-${field}-${crossed}`,
        type: 'milestone',
        category: 'MILESTONE',
        score: 30 + marks.indexOf(crossed) * 6,
        headline: `${name} passes ${crossed.toLocaleString('en-US')} ${label}`,
        teams: [t.teamId],
        players: p ? [p.key] : [],
        week: wk,
        facts: { player: name, team: C.teamRef(cur, t.teamId).name, stat: label, milestone: crossed, seasonTotal: n(t[field]), games: t.games },
        card: C.headline('MILESTONE', `${name}: ${n(t[field]).toLocaleString('en-US')} ${label.toUpperCase()}`, [t.teamId], cur),
      });
    }
  }
  return out;
}

// ─── Standings stories ─────────────────────────────────────────────────────
function divisionLeaders(standings) {
  const best = {};
  for (const s of Object.values(standings || {})) {
    const cur = best[s.division];
    const key = x => (x.pct ?? 0) * 1000 + (x.netPts ?? 0) / 1000;
    if (!cur || key(s) > key(cur)) best[s.division] = s;
  }
  return best;
}

function standingsStories(prev, cur, wk) {
  const out = [];
  const tag = wk ? `${wk.seasonIndex}-${wk.stage}-${wk.week}` : 'na';
  for (const s of Object.values(cur.standings)) {
    const t = cur.teams[s.teamId];
    if (!t) continue;
    const rec = L.recordOf(cur, s.teamId);
    const games = s.w + s.l + s.t;
    // Streaks: three or more, plus still-perfect / still-winless after three.
    if (Math.abs(s.streak) >= 3) {
      const win = s.streak > 0;
      const perfect = win && s.l === 0 && s.t === 0 && games >= 3;
      const winless = !win && s.w === 0 && s.t === 0 && games >= 3;
      out.push({
        id: `streak:${tag}:${s.teamId}`,
        type: 'streak',
        category: win ? 'HOT' : 'COLD',
        score: (Math.abs(s.streak) >= 5 ? 45 : 30) + (perfect || winless ? 15 : 0) + (t.owner ? 5 : 0),
        headline: perfect ? `${t.nickname} still perfect at ${rec}` : winless ? `${t.nickname} still winless at ${rec}`
          : `${t.nickname} ${win ? 'win' : 'lose'} ${Math.abs(s.streak)} straight`,
        teams: [s.teamId], players: [], week: wk,
        facts: { team: `${t.city} ${t.nickname}`, record: rec, streak: `${win ? 'won' : 'lost'} ${Math.abs(s.streak)} in a row`, perfect, winless },
        card: C.headline(win ? 'ON A ROLL' : 'SKIDDING', `${t.nickname.toUpperCase()} ${C.streakLabel(s.streak)} • ${rec}`, [s.teamId], cur),
      });
    }
    // Big moves in EA's power ranking (prevRank comes with the export).
    if (s.rank && s.prevRank && Math.abs(s.prevRank - s.rank) >= 6) {
      const up = s.prevRank > s.rank;
      out.push({
        id: `rank:${tag}:${s.teamId}`,
        type: 'rank_move',
        category: 'POWER INDEX',
        score: 20 + Math.abs(s.prevRank - s.rank),
        headline: `${t.nickname} ${up ? 'climb' : 'drop'} from ${s.prevRank} to ${s.rank} in the power index`,
        teams: [s.teamId], players: [], week: wk,
        facts: { team: `${t.city} ${t.nickname}`, from: s.prevRank, to: s.rank, record: rec },
        card: C.headline('POWER INDEX', `${t.abbr} ${up ? '▲' : '▼'} ${s.prevRank} → ${s.rank}`, [s.teamId], cur),
      });
    }
    // Clinches, and late-season moves in or out of playoff position (both
    // need the previous snapshot). The export has no reliable "eliminated".
    const before = prev?.standings?.[s.teamId]?.status;
    const clinched = st => /^clinched/.test(st || '');
    if (prev && before && before !== s.status && clinched(s.status)) {
      const what = { clinched_playoffs: 'clinch a playoff spot', clinched_division: 'clinch the division', clinched_top_seed: 'lock up the top seed' }[s.status];
      out.push({
        id: `status:${s.teamId}:${s.status}:${s.seasonIndex}`,
        type: 'clinch',
        category: 'CLINCHED',
        score: s.status === 'clinched_top_seed' ? 65 : 55,
        headline: `${t.nickname} ${what}`,
        teams: [s.teamId], players: [], week: wk,
        facts: { team: `${t.city} ${t.nickname}`, record: rec, status: s.status.replace(/_/g, ' '), seed: s.seed || null },
        card: C.headline('CLINCHED', `${t.nickname.toUpperCase()} - ${what.toUpperCase()}`, [s.teamId], cur),
      });
    } else if (prev && before && wk && wk.week >= 12 && wk.week < 19 && !clinched(before) && before !== s.status && ['in', 'out'].includes(s.status)) {
      const into = s.status === 'in';
      out.push({
        id: `position:${tag}:${s.teamId}`,
        type: 'playoff_position',
        category: 'PLAYOFF RACE',
        score: 35 + (t.owner ? 5 : 0),
        headline: into ? `${t.nickname} move into playoff position${s.seed ? ` as the ${s.seed} seed` : ''}` : `${t.nickname} fall out of playoff position`,
        teams: [s.teamId], players: [], week: wk,
        facts: { team: `${t.city} ${t.nickname}`, record: rec, nowInPlayoffPosition: into, seed: s.seed || null },
        card: C.headline('PLAYOFF RACE', `${t.abbr} ${into ? 'IN' : 'OUT'}${s.seed ? ` • SEED ${s.seed}` : ''}`, [s.teamId], cur),
      });
    }
  }
  // Division lead changes (needs the previous snapshot).
  if (prev?.standings) {
    const was = divisionLeaders(prev.standings), now = divisionLeaders(cur.standings);
    for (const [div, s] of Object.entries(now)) {
      const old = was[div];
      if (!old || old.teamId === s.teamId) continue;
      const t = cur.teams[s.teamId], o = cur.teams[old.teamId];
      if (!t || !o) continue;
      out.push({
        id: `divlead:${tag}:${div}`,
        type: 'division_lead',
        category: 'DIVISION RACE',
        score: 45,
        headline: `${t.nickname} take over first place in the ${div}`,
        teams: [s.teamId, old.teamId], players: [], week: wk,
        facts: { division: div, newLeader: `${t.city} ${t.nickname}`, record: L.recordOf(cur, s.teamId), previousLeader: `${o.city} ${o.nickname}` },
        card: C.headline('DIVISION RACE', `${t.abbr} TAKES THE ${div.toUpperCase()} LEAD`, [s.teamId, old.teamId], cur),
      });
    }
  }
  return out;
}

// ─── Roster diffs ──────────────────────────────────────────────────────────
function playerFacts(cur, p) {
  return { name: p.name, position: p.pos, overall: p.ovr, age: p.age, devTrait: DEV[p.dev] || 'Normal' };
}

function transactionStories(prev, cur, batch) {
  if (!prev?.players) return [];
  const out = [];
  const bid = batch?.id || 'batch';
  const moves = new Map(); // "a|b" → { a, b, toB: [], toA: [] }
  const rookiesByTeam = new Map();
  const seasonRolled = prev.seasonIndex != null && cur.seasonIndex != null && cur.seasonIndex !== prev.seasonIndex;
  const rosterTeams = new Set(batch?.rosterTeams || []);

  for (const [key, p] of Object.entries(cur.players)) {
    const was = prev.players[key];
    const tName = id => C.teamRef(cur, id).name;

    if (!was) {
      // Someone new: a rookie (draft class) or a newly created player.
      if (p.departed) continue;
      const rookie = (p.yearsPro === 0 || (p.draft.year && cur.calendarYear && p.draft.year >= cur.calendarYear)) && p.draft.round >= 1 && p.draft.round <= 7;
      if (rookie && p.teamId > 0) {
        if (!rookiesByTeam.has(p.teamId)) rookiesByTeam.set(p.teamId, []);
        rookiesByTeam.get(p.teamId).push(p);
      }
      continue;
    }
    if (was.departed) continue;

    const from = was.teamId, to = p.teamId;
    // Trades: team → different team
    if (from > 0 && to > 0 && from !== to) {
      const [a, b] = [from, to].sort((x, y) => x - y);
      const k = `${a}|${b}`;
      if (!moves.has(k)) moves.set(k, { a, b, toA: [], toB: [] });
      (to === a ? moves.get(k).toA : moves.get(k).toB).push(p);
      continue;
    }
    // Signings from free agency
    if (from === 0 && to > 0) {
      const contract = C.contractLine(p.contract);
      out.push({
        id: `sign:${bid}:${key}`, type: 'signing', category: 'SIGNED',
        score: clamp(30 + ((p.ovr || 60) - 70) * 2, 15, 80) + (cur.teams[to]?.owner ? 5 : 0),
        headline: `${tName(to).split(' ').pop()} sign ${p.pos} ${p.name}`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to), contract: contract || null, contractTotal: p.contract.salary ? money(p.contract.salary) : null, years: p.contract.years || null },
        card: C.signing(cur, 'SIGNED', p, to, contract),
      });
      continue;
    }
    // Releases
    if (from > 0 && to === 0) {
      out.push({
        id: `release:${bid}:${key}`, type: 'release', category: 'RELEASED',
        score: clamp(25 + ((p.ovr || 60) - 70) * 1.5, 10, 70),
        headline: `${tName(from).split(' ').pop()} release ${p.pos} ${p.name}`,
        teams: [from], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(from) },
        card: C.signing(cur, 'RELEASED', p, from, `${p.ovr} OVR • AGE ${p.age}`),
      });
      continue;
    }
    // Gone entirely: retirement (age or season rollover) or an unseen release
    if (p.departed && !was.departed && from > 0 && rosterTeams.has(from)) {
      const retired = seasonRolled || (p.age || was.age || 0) >= 31;
      if (!retired && (p.ovr || 0) < 70) continue;
      out.push({
        id: `${retired ? 'retire' : 'depart'}:${bid}:${key}`, type: retired ? 'retirement' : 'departure',
        category: retired ? 'RETIRED' : 'DEPARTED',
        score: clamp(25 + ((was.ovr || 60) - 70) * 2, 10, 75),
        headline: retired ? `${was.name} retires from the ${tName(from).split(' ').pop()}` : `${was.name} no longer on the ${tName(from).split(' ').pop()} roster`,
        teams: [from], players: [key], week: null,
        facts: { player: playerFacts(cur, was), team: tName(from), yearsPro: was.yearsPro ?? null },
        card: C.signing(cur, retired ? 'RETIRED' : 'DEPARTED', was, from, `${was.yearsPro ?? '?'} SEASONS`),
      });
      continue;
    }
    if (p.departed || to <= 0) continue;

    // Same team: injuries, dev traits, ratings, extensions
    if (!was.injury && p.injury > 0 && (p.ovr || 0) >= 72) {
      out.push({
        id: `injury:${bid}:${key}`, type: 'injury', category: 'INJURY',
        score: clamp(25 + ((p.ovr || 72) - 75) * 2 + Math.min(10, p.injury) * 2 + (p.ir ? 10 : 0), 15, 85),
        headline: `${p.name} out ${p.ir ? 'on injured reserve' : `${p.injury} week${p.injury === 1 ? '' : 's'}`}`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to), weeksOut: p.injury, injuredReserve: p.ir },
        card: C.injuryReport(cur, [p]),
      });
    } else if (was.injury > 0 && !p.injury && (p.ovr || 0) >= 78) {
      out.push({
        id: `return:${bid}:${key}`, type: 'return', category: 'RETURNING',
        score: 20 + Math.max(0, (p.ovr || 78) - 78),
        headline: `${p.name} is back for the ${tName(to).split(' ').pop()}`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to) },
        card: C.playerCard(cur, p, 'BACK FROM INJURY', 'RETURNING'),
      });
    }
    if (was.dev !== p.dev) {
      const up = p.dev > was.dev;
      out.push({
        id: `dev:${bid}:${key}`, type: 'dev_change', category: up ? 'DEV UPGRADE' : 'DEV DOWNGRADE',
        score: up ? [0, 20, 45, 65][p.dev] : 30,
        headline: up ? `${p.name} reaches ${DEV[p.dev]} status` : `${p.name} drops to ${DEV[p.dev]}`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to), from: DEV[was.dev], to: DEV[p.dev] },
        card: C.playerCard(cur, p, `${DEV[was.dev].toUpperCase()} → ${DEV[p.dev].toUpperCase()}`, up ? 'DEV UPGRADE' : 'DEV DOWNGRADE'),
      });
    }
    if (was.ovr != null && p.ovr != null && Math.abs(p.ovr - was.ovr) >= 4 && Math.max(p.ovr, was.ovr) >= 70) {
      const up = p.ovr > was.ovr;
      out.push({
        id: `ovr:${bid}:${key}`, type: 'rating_change', category: up ? 'RISING' : 'FALLING',
        score: 15 + Math.abs(p.ovr - was.ovr) * 3,
        headline: `${p.name} ${up ? 'jumps' : 'slides'} from ${was.ovr} to ${p.ovr} overall`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to), from: was.ovr, to: p.ovr },
        card: C.playerCard(cur, p, `${was.ovr} → ${p.ovr} OVR`, up ? 'RISING' : 'FALLING'),
      });
    }
    const wc = was.contract || {}, pc = p.contract || {};
    if (from === to && pc.years && (pc.left ?? 0) > (wc.left ?? 0) && (pc.salary !== wc.salary || pc.years !== wc.years)) {
      const contract = C.contractLine(pc);
      out.push({
        id: `extend:${bid}:${key}`, type: 'extension', category: 'RE-SIGNED',
        score: clamp(25 + ((p.ovr || 70) - 75) * 1.5, 10, 65),
        headline: `${tName(to).split(' ').pop()} re-sign ${p.pos} ${p.name}`,
        teams: [to], players: [key], week: null,
        facts: { player: playerFacts(cur, p), team: tName(to), contract: contract || null, years: pc.years, contractTotal: pc.salary ? money(pc.salary) : null },
        card: C.signing(cur, 'RE-SIGNED', p, to, contract),
      });
    }
  }

  // One trade story per team pair
  for (const m of moves.values()) {
    const all = [...m.toA, ...m.toB];
    const best = Math.max(...all.map(p => p.ovr || 60));
    const A = cur.teams[m.a], B = cur.teams[m.b];
    if (!A || !B) continue;
    const star = all.slice().sort((x, y) => (y.ovr || 0) - (x.ovr || 0))[0];
    const receiver = m.toA.includes(star) ? A : B;
    const sender = receiver === A ? B : A;
    out.push({
      id: `trade:${bid}:${m.a}-${m.b}`, type: 'trade', category: 'TRADE',
      score: clamp(55 + (best - 75) * 1.5 + ([A, B].filter(t => t.owner).length * 5), 40, 95),
      headline: m.toA.length && m.toB.length
        ? `${A.nickname} and ${B.nickname} swap ${all.length} players in blockbuster deal`
        : `${receiver.nickname} acquire ${star.pos} ${star.name} from the ${sender.nickname}`,
      teams: [m.a, m.b], players: all.map(p => p.key), week: null,
      facts: {
        teams: [`${A.city} ${A.nickname}`, `${B.city} ${B.nickname}`],
        [`${A.nickname} receive`]: m.toA.map(p => `${p.pos} ${p.name} (${p.ovr} OVR, age ${p.age})`),
        [`${B.nickname} receive`]: m.toB.map(p => `${p.pos} ${p.name} (${p.ovr} OVR, age ${p.age})`),
        note: 'Draft picks are not visible in the export; do not claim what else changed hands.',
      },
      card: C.trade(cur, m.a, m.b, m.toA, m.toB),
    });
  }

  // Draft classes, one story per team
  for (const [teamId, list] of rookiesByTeam) {
    const t = cur.teams[teamId];
    if (!t) continue;
    list.sort((a, b) => (a.draft.round - b.draft.round) || (a.draft.pick - b.draft.pick));
    const top = list[0];
    out.push({
      id: `rookies:${cur.seasonIndex}:${teamId}`, type: 'rookies', category: 'DRAFT CLASS',
      score: 20 + (top.draft.round === 1 ? 15 : 0) + (t.owner ? 5 : 0),
      headline: `${t.nickname} welcome ${list.length} rookie${list.length === 1 ? '' : 's'}, led by ${top.pos} ${top.name}`,
      teams: [teamId], players: list.map(p => p.key), week: null,
      facts: {
        team: `${t.city} ${t.nickname}`, count: list.length,
        picks: list.slice(0, 6).map(p => `Round ${p.draft.round}, pick ${p.draft.pick}: ${p.pos} ${p.name} (${p.ovr} OVR${p.dev ? ', ' + DEV[p.dev] : ''})`),
      },
      card: C.playerCard(cur, top, `ROUND ${top.draft.round} • PICK ${top.draft.pick}`, 'TOP ROOKIE'),
    });
  }

  // Owner changes (human ↔ CPU or new owner)
  for (const [id, t] of Object.entries(cur.teams)) {
    const was = prev.teams?.[id];
    if (!was || (was.owner || '') === (t.owner || '')) continue;
    const headline = !was.owner ? `${t.nickname} get a new owner: ${t.owner}`
      : !t.owner ? `${was.owner} steps away from the ${t.nickname}` : `${t.owner} takes over the ${t.nickname} from ${was.owner}`;
    out.push({
      id: `owner:${bid}:${id}`, type: 'owner_change', category: 'NEW OWNER',
      score: 55, headline, teams: [Number(id)], players: [], week: null,
      facts: { team: `${t.city} ${t.nickname}`, previousOwner: was.owner || 'CPU', newOwner: t.owner || 'CPU' },
      card: C.headline('OWNERSHIP', headline.toUpperCase(), [Number(id)], cur),
    });
  }

  // A fantasy draft or the first roster sync can produce hundreds of moves:
  // keep the best of each type and fold the rest into one summary.
  const capped = [];
  const byType = {};
  for (const s of out) (byType[s.type] ||= []).push(s);
  for (const [type, list] of Object.entries(byType)) {
    list.sort((a, b) => b.score - a.score);
    capped.push(...list.slice(0, 20));
    if (list.length > 20) {
      capped.push({
        id: `bulk:${bid}:${type}`, type: 'bulk', category: 'ROSTER MOVES', score: 20,
        headline: `${list.length} ${type.replace(/_/g, ' ')} moves across the league`,
        teams: [], players: [], week: null,
        facts: { type, total: list.length, notShown: list.length - 20 },
        card: C.headline('ROSTER MOVES', `${list.length} ${type.replace(/_/g, ' ').toUpperCase()} MOVES`, [], cur),
      });
    }
  }
  return capped;
}

// ─── Entry points ──────────────────────────────────────────────────────────

// The week a batch is "about": the latest week in the batch with played games.
function focusWeekOf(cur, batch) {
  const played = (batch?.weeks || [])
    .filter(w => L.gamesForWeek(cur, w.seasonIndex, w.stage, w.week).some(g => g.played))
    .sort((a, b) => L.weekOrd(b.seasonIndex, b.stage, b.week) - L.weekOrd(a.seasonIndex, a.stage, a.week));
  return played[0] || null;
}

function detectStories({ prev = null, cur, batch = null }) {
  const idx = L.rosterIndex(cur);
  const wk = focusWeekOf(cur, batch);
  const stories = [];
  if (wk) {
    for (const g of L.gamesForWeek(cur, wk.seasonIndex, wk.stage, wk.week)) {
      if (!g.played) continue;
      const s = gameStory(prev, cur, g, idx);
      if (s) stories.push(s);
    }
    stories.push(...performanceStories(cur, wk, idx));
    stories.push(...milestoneStories(cur, wk, idx));
  }
  // Standings stories only when the standings match the latest scores.
  if ((batch?.standings || wk) && cur.standingsFresh !== false) stories.push(...standingsStories(prev, cur, wk));
  stories.push(...transactionStories(prev, cur, batch));
  const at = new Date().toISOString();
  for (const s of stories) {
    s.batchId = batch?.id || null;
    s.createdAt = at;
    s.score = Math.round(s.score);
  }
  return stories.sort((a, b) => b.score - a.score);
}

// Breaking-news worthy? (used for automatic bulletins)
function isBreaking(s) {
  const ovr = s.facts?.player?.overall || 0;
  switch (s.type) {
    case 'trade': return s.score >= 60;
    case 'signing': case 'release': case 'retirement': return ovr >= 85;
    case 'injury': return ovr >= 85 && (s.facts.weeksOut >= 4 || s.facts.injuredReserve);
    case 'dev_change': return s.facts.to === 'X-Factor';
    case 'owner_change': return true;
    default: return false;
  }
}

// Current-state context for graphics and segments.
function buildContext(cur, { focusWeek = null, chronicle = [], hub = null } = {}) {
  const idx = L.rosterIndex(cur);
  const wk = focusWeek || L.lastPlayedWeek(cur);
  const ctx = { focusWeek: wk, weekLabel: wk ? L.weekLabel(wk.stage, wk.week) : 'Offseason' };

  if (wk) {
    const games = L.gamesForWeek(cur, wk.seasonIndex, wk.stage, wk.week).filter(g => g.played);
    ctx.games = games;
    ctx.scoreboard = C.scoreboard(cur, games, `${ctx.weekLabel.toUpperCase()} • FINAL`);
    // Players of the week: best offensive and defensive impact
    const all = topPerformersWeek(cur, wk, idx);
    ctx.playersOfWeek = all;
    ctx.weekLeaders = C.leaders(`${ctx.weekLabel.toUpperCase()} LEADERS`, leaderSections(cur, weekRows(cur, wk), idx, 3));
    if (wk.stage === 'reg' && wk.week > 1 && wk.week < 19) {
      const totals = Object.values(L.seasonTotals(cur, wk.seasonIndex, 'reg', wk.week));
      ctx.seasonLeaders = C.leaders('SEASON LEADERS', seasonSections(cur, totals, idx));
    }
  }
  const next = L.nextWeek(cur, wk);
  if (next) {
    const games = L.gamesForWeek(cur, next.seasonIndex, next.stage, next.week).filter(g => !g.played);
    if (games.length) {
      // Best matchups first: human-owned teams, then combined record.
      const weight = g => [g.homeId, g.awayId].reduce((s, id) => s + (cur.teams[id]?.owner ? 2 : 0) + (cur.standings[id]?.pct ?? 0.5), 0);
      ctx.nextWeek = { ...next, label: L.weekLabel(next.stage, next.week), games: games.sort((a, b) => weight(b) - weight(a)) };
      ctx.matchups = C.matchups(cur, ctx.nextWeek.games.slice(0, 5), `UP NEXT: ${ctx.nextWeek.label.toUpperCase()}`);
    }
  }
  // Stale standings (an old export next to new scores) would put wrong records
  // and streaks on screen, so the tables sit out until standings are re-sent.
  if (Object.keys(cur.standings).length && cur.standingsFresh !== false) {
    const confs = [...new Set(Object.values(cur.standings).map(s => s.conference))].filter(Boolean).sort();
    ctx.standings = confs.map(c => C.standings(cur, c));
    if (Object.values(cur.standings).some(s => s.seed)) ctx.playoffPicture = C.playoffPicture(cur);
    const ranks = Object.values(cur.standings).filter(s => s.rank).sort((a, b) => a.rank - b.rank);
    ctx.powerRankings = C.powerRankings('HFL-NN POWER INDEX', ranks.map(s => {
      const r = C.teamRef(cur, s.teamId);
      return { rank: s.rank, abbr: r.abbr, color: r.color, color2: r.color2, rec: L.recordOf(cur, s.teamId), move: (s.prevRank || s.rank) - s.rank };
    }));
  }
  if (hub?.powerRankings?.length) {
    const byAbbr = Object.fromEntries(Object.values(cur.teams).map(t => [t.abbr, t]));
    ctx.powerRankings = C.powerRankings('HFL POWER RANKINGS', hub.powerRankings.map(r => {
      const t = byAbbr[r.teamAbbr];
      return { rank: r.rank, abbr: r.teamAbbr, color: t?.primary || '#444444', color2: t?.secondary || '#999999', rec: t ? L.recordOf(cur, t.id) : '', move: r.move || 0, note: r.note || '' };
    }));
  }
  // Notable injuries right now
  const hurt = Object.values(cur.players).filter(p => p.teamId > 0 && !p.departed && p.injury > 0 && (p.ovr || 0) >= 78)
    .sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  if (hurt.length) ctx.injuries = C.injuryReport(cur, hurt);
  // Playoff bracket
  if (wk && wk.stage === 'reg' && wk.week >= 19) {
    const rounds = [19, 20, 21, 23].map(w => ({ name: L.weekLabel('reg', w).toUpperCase(), games: L.gamesForWeek(cur, wk.seasonIndex, 'reg', w) })).filter(r => r.games.length);
    ctx.bracket = C.bracket(cur, rounds, 'PLAYOFF BRACKET');
  }
  ctx.chronicle = chronicle;
  ctx.hub = hub;
  return ctx;
}

function topPerformersWeek(cur, wk, idx) {
  const rows = weekRows(cur, wk);
  const off = [], def = [];
  for (const kind of ['passing', 'rushing', 'receiving']) for (const r of rows[kind] || []) off.push({ kind, r, s: impact[kind](r) });
  for (const r of rows.defense || []) def.push({ kind: 'defense', r, s: impact.defense(r) });
  const pick = list => {
    const best = list.sort((a, b) => b.s - a.s)[0];
    if (!best) return null;
    const p = idx.get(best.r.rosterId);
    const line = lineFor[best.kind](best.r);
    return {
      name: L.statName(cur, best.r, idx), team: C.teamRef(cur, best.r.teamId).abbr, teamId: best.r.teamId, line,
      card: p ? C.playerCard(cur, p, line, best.kind === 'defense' ? 'DEFENSIVE PLAYER OF THE WEEK' : 'OFFENSIVE PLAYER OF THE WEEK') : null,
    };
  };
  return { offense: pick(off), defense: pick(def) };
}

function leaderSections(cur, rows, idx, count) {
  const sec = (label, kind, field) => ({
    label,
    rows: (rows[kind] || []).slice().sort((a, b) => n(b[field]) - n(a[field])).slice(0, count).filter(r => n(r[field]) > 0).map(r => {
      const t = C.teamRef(cur, r.teamId);
      return { name: L.statName(cur, r, idx), team: t.abbr, color: t.color, color2: t.color2, value: n(r[field]) };
    }),
  });
  return [sec('PASS YDS', 'passing', 'passYds'), sec('RUSH YDS', 'rushing', 'rushYds'), sec('REC YDS', 'receiving', 'recYds'), sec('SACKS', 'defense', 'defSacks')];
}

function seasonSections(cur, totals, idx) {
  const sec = (label, field) => ({
    label,
    rows: totals.slice().sort((a, b) => n(b[field]) - n(a[field])).slice(0, 3).filter(t => n(t[field]) > 0).map(t => {
      const team = C.teamRef(cur, t.teamId);
      const p = idx.get(t.rosterId);
      return { name: p?.name || t.name, team: team.abbr, color: team.color, color2: team.color2, value: n(t[field]) };
    }),
  });
  return [sec('PASS YDS', 'passYds'), sec('RUSH YDS', 'rushYds'), sec('REC YDS', 'recYds'), sec('SACKS', 'defSacks')];
}

module.exports = { detectStories, buildContext, isBreaking, focusWeekOf, topPerformers, gameStory, passLine, rushLine, recLine, defLine };
