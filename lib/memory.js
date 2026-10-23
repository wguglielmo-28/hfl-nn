// Show memory: what makes HFL-NN feel like a running show rather than a
// series of one-offs. Fed into every script and updated only when an episode
// is published, so an unpublished draft can't rewrite history.
//
//   moods          each anchor's mood after the last show
//   relationships  every pair at the desk: kind, heat 0–10, recent flashpoints
//   scoreboard     arguments won/lost and predictions right/wrong per anchor
//   arguments      the last few arguments and who won them
//   predictions    on-air predictions, graded right/wrong in the control room
//   storylines     arcs that build over weeks: building → heating → boiling →
//                  payoff → closed, each with beats, stakes, a champion and a skeptic
//   caseFile       Gus's running conspiracy cases, with evidence pinned weekly
//   episodes       recent episode summaries
'use strict';

const LIMITS = { predictions: 40, arcs: 12, closedArcs: 6, beats: 6, episodes: 12, arguments: 10, flashpoints: 4, cases: 8, evidence: 8 };
const ARC_STATUS = ['building', 'heating', 'boiling', 'payoff', 'closed'];
const CASE_STATUS = ['open', 'growing', 'cracked', 'debunked'];
const REL_CHANGE = ['heated', 'cooled', 'steady'];
const DECIDED_BY = ['host', 'concession', 'viewers', 'numbers'];

const pairKey = (a, b) => [a, b].sort().join('|');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Seeded from config/personas.json; an older config with only "feuds" gets
// each feud as a rivalry.
function seedRelationships(personas) {
  const list = personas?.relationships?.length ? personas.relationships
    : (personas?.feuds || []).map(f => ({ a: f.a, b: f.b, kind: 'rivalry', heat: 7, note: f.topic }));
  return list.map(r => ({ a: r.a, b: r.b, kind: r.kind || 'needling', heat: clamp(Number(r.heat) || 3, 0, 10), note: r.note || '', flashpoints: [] }));
}

function emptyMemory(personas) {
  return {
    moods: {},
    feuds: (personas?.feuds || []).map(f => ({ ...f, since: null })),
    relationships: seedRelationships(personas),
    scoreboard: {},
    arguments: [],
    predictions: [],
    storylines: [],
    caseFile: [],
    episodes: [],
  };
}

// Storylines from before arcs were a thing were { key, text }.
function toArc(s) {
  if (Array.isArray(s.beats)) return s;
  return {
    key: s.key, title: s.text || s.key, status: 'building', teams: [], stakes: '', champion: '', skeptic: '', nextBeat: '',
    beats: s.text ? [{ text: s.text, episodeId: s.episodeId || null, at: s.at || null }] : [],
    openedIn: s.episodeId || null, at: s.at || new Date(0).toISOString(),
  };
}

function loadMemory(store, personas) {
  const m = store.readJSON('memory.json', null) || emptyMemory(personas);
  for (const k of ['predictions', 'storylines', 'episodes', 'feuds', 'relationships', 'arguments', 'caseFile']) if (!Array.isArray(m[k])) m[k] = [];
  if (!m.moods || typeof m.moods !== 'object') m.moods = {};
  if (!m.scoreboard || typeof m.scoreboard !== 'object') m.scoreboard = {};
  if (!m.feuds.length && personas?.feuds?.length) m.feuds = personas.feuds.map(f => ({ ...f, since: null }));
  // A memory from before the relationship web gets the configured web, with
  // any pairs it already had left alone.
  const have = new Set(m.relationships.map(r => pairKey(r.a, r.b)));
  for (const r of seedRelationships(personas)) if (!have.has(pairKey(r.a, r.b))) m.relationships.push(r);
  m.storylines = m.storylines.map(toArc);
  return m;
}

const score = (memory, id) => ((memory.scoreboard ||= {})[id] ||= { won: 0, lost: 0, right: 0, wrong: 0 });

function applyEpisode(memory, episode, script) {
  const at = new Date().toISOString();
  const mu = script?.memoryUpdates || {};
  const beat = text => ({ text, episodeId: episode.id, title: episode.title, at });

  for (const { persona, mood } of mu.moods || []) memory.moods[persona] = { mood, since: episode.id, at };

  for (const { persona, text } of mu.predictions || []) {
    memory.predictions.push({ id: `${episode.id}:${memory.predictions.length}`, persona, text, madeIn: episode.title, episodeId: episode.id, at, status: 'open' });
  }

  // Arcs: a new beat each time an episode touches one.
  for (const u of mu.storylines || []) {
    if (!u?.key) continue;
    const text = u.beat || u.text;
    let arc = memory.storylines.find(s => s.key === u.key);
    if (!arc) {
      arc = { key: u.key, title: u.title || text || u.key, status: 'building', teams: [], stakes: '', champion: '', skeptic: '', nextBeat: '', beats: [], openedIn: episode.id, at };
      memory.storylines.push(arc);
    }
    if (u.title) arc.title = u.title;
    if (ARC_STATUS.includes(u.status)) arc.status = u.status;
    if (Array.isArray(u.teams) && u.teams.length) arc.teams = u.teams.slice(0, 4);
    for (const k of ['stakes', 'nextBeat', 'champion', 'skeptic']) if (u[k]) arc[k] = u[k];
    if (text) arc.beats = [...arc.beats, beat(text)].slice(-LIMITS.beats);
    arc.at = at;
  }

  for (const u of mu.relationships || []) {
    if (!u?.a || !u?.b || u.a === u.b) continue;
    let rel = memory.relationships.find(r => pairKey(r.a, r.b) === pairKey(u.a, u.b));
    if (!rel) { rel = { a: u.a, b: u.b, kind: 'needling', heat: 3, note: '', flashpoints: [] }; memory.relationships.push(rel); }
    rel.heat = clamp(rel.heat + (u.change === 'heated' ? 1 : u.change === 'cooled' ? -1 : 0), 0, 10);
    if (u.flashpoint) rel.flashpoints = [...(rel.flashpoints || []), beat(u.flashpoint)].slice(-LIMITS.flashpoints);
  }

  for (const u of mu.arguments || []) {
    if (!u?.topic) continue;
    if (u.winner) score(memory, u.winner).won++;
    if (u.loser) score(memory, u.loser).lost++;
    memory.arguments.push({ topic: u.topic, winner: u.winner || '', loser: u.loser || '', decidedBy: u.decidedBy || '', episodeId: episode.id, title: episode.title, at });
  }
  memory.arguments = memory.arguments.slice(-LIMITS.arguments);

  for (const u of mu.caseFile || []) {
    if (!u?.key) continue;
    let c = memory.caseFile.find(x => x.key === u.key);
    if (!c) { c = { key: u.key, title: u.title || u.key, status: 'open', evidence: [], believers: [], openedIn: episode.id, at }; memory.caseFile.push(c); }
    if (u.title) c.title = u.title;
    if (CASE_STATUS.includes(u.status)) c.status = u.status;
    if (u.evidence) c.evidence = [...c.evidence, beat(u.evidence)].slice(-LIMITS.evidence);
    if (u.believer && !c.believers.includes(u.believer)) c.believers.push(u.believer);
    c.at = at;
  }

  memory.episodes.push({ id: episode.id, title: episode.title, summary: script?.summary || '', at });

  // Keep it bounded. Predictions: resolved first, then the oldest.
  if (memory.predictions.length > LIMITS.predictions) {
    memory.predictions.sort((a, b) => (a.status === 'open') - (b.status === 'open') || a.at.localeCompare(b.at));
    memory.predictions = memory.predictions.slice(-LIMITS.predictions);
  }
  const byAt = (a, b) => String(a.at).localeCompare(String(b.at));
  const open = memory.storylines.filter(s => s.status !== 'closed').sort(byAt).slice(-LIMITS.arcs);
  const closed = memory.storylines.filter(s => s.status === 'closed').sort(byAt).slice(-LIMITS.closedArcs);
  memory.storylines = [...closed, ...open];
  const liveCases = memory.caseFile.filter(c => c.status === 'open' || c.status === 'growing');
  const shutCases = memory.caseFile.filter(c => !liveCases.includes(c)).sort(byAt).slice(-3);
  memory.caseFile = [...shutCases, ...liveCases.sort(byAt).slice(-LIMITS.cases)];
  memory.episodes = memory.episodes.slice(-LIMITS.episodes);
  return memory;
}

// Grading a prediction also keeps each anchor's receipts on the scoreboard.
function resolvePrediction(memory, id, status) {
  const p = memory.predictions.find(x => x.id === id);
  if (!p || !['open', 'right', 'wrong'].includes(status)) return p || null;
  memory.scoreboard ||= {};
  const s = score(memory, p.persona);
  if (p.status === 'right') s.right = Math.max(0, s.right - 1);
  if (p.status === 'wrong') s.wrong = Math.max(0, s.wrong - 1);
  if (status === 'right') s.right++;
  if (status === 'wrong') s.wrong++;
  p.status = status;
  return p;
}

const ARC_ORDER = { boiling: 0, payoff: 1, heating: 2, building: 3 };

// The memory as the writer sees it.
function promptBlock(memory, personas) {
  const name = id => personas.anchors.find(a => a.id === id)?.short || id;
  const lines = [];
  const moods = Object.entries(memory.moods || {});
  if (moods.length) lines.push('Moods: ' + moods.map(([id, m]) => `${name(id)} is ${m.mood}`).join('; ') + '.');

  const rels = (memory.relationships || []).slice().sort((a, b) => b.heat - a.heat);
  if (rels.length) {
    lines.push('The desk (heat 0 to 10; 7 and up means they will not agree on anything tonight):');
    for (const r of rels) {
      const last = r.flashpoints?.at(-1);
      lines.push(`- ${name(r.a)} and ${name(r.b)}: ${r.kind}, heat ${r.heat}. ${r.note}${last ? ` Last flashpoint: ${last.text}` : ''}`);
    }
  }

  const board = Object.entries(memory.scoreboard || {}).filter(([, s]) => s.won || s.lost || s.right || s.wrong);
  if (board.length) {
    lines.push('Hot-take scoreboard (bragging rights; the anchors know these numbers and bring them up):');
    for (const [id, s] of board) lines.push(`- ${name(id)}: arguments ${s.won} won, ${s.lost} lost; predictions ${s.right} right, ${s.wrong} wrong`);
  }
  const args = (memory.arguments || []).slice(-3);
  if (args.length) {
    lines.push('Recent arguments:');
    for (const a of args) lines.push(`- "${a.topic}" (${a.title}): ${a.winner ? `${name(a.winner)} beat ${a.loser ? name(a.loser) : 'the desk'}` : 'left to the viewers'}${a.decidedBy ? `, decided by ${a.decidedBy}` : ''}`);
  }

  const open = (memory.predictions || []).filter(p => p.status === 'open').slice(-10);
  if (open.length) {
    lines.push('Predictions made on air (call back to them when today\'s facts settle one):');
    for (const p of open) lines.push(`- ${name(p.persona)}: "${p.text}" (in "${p.madeIn}")`);
  }
  const graded = (memory.predictions || []).filter(p => p.status !== 'open').slice(-4);
  for (const p of graded) lines.push(`- ${name(p.persona)} was ${p.status.toUpperCase()} about "${p.text}"`);

  const arcs = (memory.storylines || []).map(toArc);
  const live = arcs.filter(s => s.status !== 'closed').sort((a, b) => (ARC_ORDER[a.status] ?? 9) - (ARC_ORDER[b.status] ?? 9)).slice(0, 8);
  if (live.length) {
    lines.push('Running storylines (arcs; keep their keys when you add a beat):');
    for (const s of live) {
      const who = [s.champion && `${name(s.champion)} believes`, s.skeptic && `${name(s.skeptic)} doesn't`].filter(Boolean).join(', ');
      lines.push(`- [${s.key}] ${s.title}: ${s.status.toUpperCase()}${s.teams?.length ? ` (${s.teams.join(', ')})` : ''}${s.stakes ? `. Stakes: ${s.stakes}` : ''}${who ? `. ${who}` : ''}.`);
      for (const b of s.beats.slice(-3)) lines.push(`    ${b.title ? `${b.title}: ` : ''}${b.text}`);
      if (s.nextBeat) lines.push(`    Next beat to watch for: ${s.nextBeat}`);
    }
  }
  const closed = arcs.filter(s => s.status === 'closed').slice(-3);
  if (closed.length) lines.push('Closed storylines (worth a callback): ' + closed.map(s => `${s.title}${s.beats.at(-1) ? ` (ended: ${s.beats.at(-1).text})` : ''}`).join('; ') + '.');

  const cases = memory.caseFile || [];
  if (cases.length) {
    lines.push('Gus\'s case file (keep the keys; exhibits are numbered in order):');
    for (const c of cases) {
      const last = c.evidence.at(-1);
      lines.push(`- [${c.key}] ${c.title}: ${c.status.toUpperCase()}, ${c.evidence.length} exhibit${c.evidence.length === 1 ? '' : 's'}${last ? `, latest: ${last.text}` : ''}${c.believers.length ? `. Believers: ${c.believers.map(name).join(', ')}` : ''}`);
    }
  }

  if (memory.episodes?.length) {
    lines.push('Recent episodes:');
    for (const e of memory.episodes.slice(-3)) lines.push(`- ${e.title}: ${e.summary}`);
  }
  return lines.length ? lines.join('\n') : 'This is the first episode. No history yet.';
}

// Live arcs whose teams appear in a set of team abbreviations.
function arcsTouching(memory, abbrs) {
  const set = new Set(abbrs);
  return (memory.storylines || []).map(toArc).filter(s => s.status !== 'closed' && (s.teams || []).some(t => set.has(t)));
}

module.exports = {
  emptyMemory, loadMemory, applyEpisode, resolvePrediction, promptBlock, arcsTouching, pairKey,
  ARC_STATUS, CASE_STATUS, REL_CHANGE, DECIDED_BY,
};
