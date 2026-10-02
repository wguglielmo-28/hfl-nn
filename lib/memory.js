// Show memory: what makes HFL-NN feel like a running show rather than a
// series of one-offs. Persona moods, feuds, on-air predictions (so they can be
// revisited), running storylines and recent episode summaries. Fed into every
// script and updated only when an episode is published, so an unpublished
// draft can't rewrite history.
'use strict';

const LIMITS = { predictions: 40, storylines: 20, episodes: 12 };

function emptyMemory(personas) {
  return {
    moods: {},
    feuds: (personas?.feuds || []).map(f => ({ ...f, since: null })),
    predictions: [],
    storylines: [],
    episodes: [],
  };
}

function loadMemory(store, personas) {
  const m = store.readJSON('memory.json', null) || emptyMemory(personas);
  for (const k of ['predictions', 'storylines', 'episodes', 'feuds']) if (!Array.isArray(m[k])) m[k] = [];
  if (!m.moods || typeof m.moods !== 'object') m.moods = {};
  if (!m.feuds.length && personas?.feuds?.length) m.feuds = personas.feuds.map(f => ({ ...f, since: null }));
  return m;
}

function applyEpisode(memory, episode, script) {
  const at = new Date().toISOString();
  const mu = script?.memoryUpdates || {};
  for (const { persona, mood } of mu.moods || []) memory.moods[persona] = { mood, since: episode.id, at };
  for (const { persona, text } of mu.predictions || []) {
    memory.predictions.push({ id: `${episode.id}:${memory.predictions.length}`, persona, text, madeIn: episode.title, episodeId: episode.id, at, status: 'open' });
  }
  for (const { key, text } of mu.storylines || []) {
    const existing = memory.storylines.find(s => s.key === key);
    if (existing) Object.assign(existing, { text, at, episodeId: episode.id });
    else memory.storylines.push({ key, text, at, episodeId: episode.id });
  }
  memory.episodes.push({ id: episode.id, title: episode.title, summary: script?.summary || '', at });

  // Keep it bounded: resolved predictions go first, then the oldest.
  if (memory.predictions.length > LIMITS.predictions) {
    memory.predictions.sort((a, b) => (a.status === 'open') - (b.status === 'open') || a.at.localeCompare(b.at));
    memory.predictions = memory.predictions.slice(-LIMITS.predictions);
  }
  memory.storylines = memory.storylines.sort((a, b) => a.at.localeCompare(b.at)).slice(-LIMITS.storylines);
  memory.episodes = memory.episodes.slice(-LIMITS.episodes);
  return memory;
}

function resolvePrediction(memory, id, status) {
  const p = memory.predictions.find(x => x.id === id);
  if (p && ['open', 'right', 'wrong'].includes(status)) p.status = status;
  return p || null;
}

// The memory as the writer sees it.
function promptBlock(memory, personas) {
  const name = id => personas.anchors.find(a => a.id === id)?.short || id;
  const lines = [];
  const moods = Object.entries(memory.moods || {});
  if (moods.length) lines.push('Moods: ' + moods.map(([id, m]) => `${name(id)} is ${m.mood}`).join('; ') + '.');
  if (memory.feuds?.length) lines.push('Running feuds: ' + memory.feuds.map(f => `${name(f.a)} vs. ${name(f.b)} over ${f.topic}`).join('; ') + '.');
  const open = (memory.predictions || []).filter(p => p.status === 'open').slice(-10);
  if (open.length) {
    lines.push('Predictions made on air (call back to them when today\'s facts settle one):');
    for (const p of open) lines.push(`- ${name(p.persona)}: "${p.text}" (in "${p.madeIn}")`);
  }
  const graded = (memory.predictions || []).filter(p => p.status !== 'open').slice(-4);
  for (const p of graded) lines.push(`- ${name(p.persona)} was ${p.status.toUpperCase()} about "${p.text}"`);
  if (memory.storylines?.length) {
    lines.push('Running storylines:');
    for (const s of memory.storylines.slice(-8)) lines.push(`- ${s.text}`);
  }
  if (memory.episodes?.length) {
    lines.push('Recent episodes:');
    for (const e of memory.episodes.slice(-3)) lines.push(`- ${e.title}: ${e.summary}`);
  }
  return lines.length ? lines.join('\n') : 'This is the first episode. No history yet.';
}

module.exports = { emptyMemory, loadMemory, applyEpisode, resolvePrediction, promptBlock };
