'use strict';
// Storyline arcs, the desk's relationships, the hot-take scoreboard, Gus's
// case file, the A-story and cameos.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/league');
const S = require('../lib/stories');
const { buildRundown } = require('../lib/rundown');
const { writeTemplateScript } = require('../lib/writer/template');
const { validateScript } = require('../lib/writer/validate');
const { scriptJsonSchema } = require('../lib/writer/schema');
const P = require('../lib/writer/prompt');
const M = require('../lib/memory');
const { createStore } = require('../lib/store');
const { createMaddenIngest } = require('../lib/ingest/madden');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const personaIds = personas.anchors.map(a => a.id);
const quiet = { log() {}, warn() {}, error() {} };

async function weekly(type = 'weekly') {
  const store = createStore(tmpDir());
  let league = L.emptyLeague();
  const batches = [];
  const ingest = createMaddenIngest({
    store, getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet,
    onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }),
  });
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const stories = batches[0].stories;
  const context = S.buildContext(league, {});
  const breakingStories = type === 'breaking' ? stories.slice(0, 1) : [];
  const rundown = buildRundown({ type, phase: 'regular', show, personas, league, context, stories, breakingStories });
  return { league, stories, context, rundown, storiesById: Object.fromEntries(stories.map(s => [s.id, s])) };
}

const ep = n => ({ id: `ep${n}`, title: `Week ${n}` });

test('storyline arcs: opened, built beat by beat, escalated, capped and closed', () => {
  const mem = M.emptyMemory(personas);
  const up = (n, s) => M.applyEpisode(mem, ep(n), { summary: '', memoryUpdates: { storylines: [s] } });
  up(1, { key: 'bills-run', title: 'Can anyone stop the Bills?', beat: 'Bills win big', status: 'building', teams: ['BUF'], stakes: 'the top seed', nextBeat: 'the Chiefs game', champion: 'ray', skeptic: 'nate' });
  let arc = mem.storylines.find(s => s.key === 'bills-run');
  assert.equal(arc.title, 'Can anyone stop the Bills?');
  assert.deepEqual(arc.teams, ['BUF']);
  assert.equal(arc.openedIn, 'ep1');
  for (let n = 2; n <= 8; n++) up(n, { key: 'bills-run', beat: `beat ${n}`, status: n >= 5 ? 'boiling' : 'heating' });
  arc = mem.storylines.find(s => s.key === 'bills-run');
  assert.equal(arc.status, 'boiling');
  assert.equal(arc.beats.length, 6, 'beats are capped');
  assert.equal(arc.beats.at(-1).text, 'beat 8');
  assert.equal(arc.beats.at(-1).title, 'Week 8');
  assert.equal(arc.champion, 'ray', 'fields not sent again are kept');

  for (let n = 0; n < 9; n++) up(20 + n, { key: `closed-${n}`, beat: 'done', status: 'closed' });
  assert.equal(mem.storylines.filter(s => s.status === 'closed').length, 6, 'only the last few closed arcs are kept, for callbacks');
  assert.ok(mem.storylines.some(s => s.key === 'bills-run'), 'live arcs survive');
});

test('old memories upgrade: { key, text } storylines become arcs, missing desk pairs are added', () => {
  const store = createStore(tmpDir());
  store.writeJSON('memory.json', { moods: {}, feuds: [], predictions: [], storylines: [{ key: 'old', text: 'Lions on a heater', at: '2026-10-01T00:00:00Z', episodeId: 'e0' }], episodes: [] });
  const mem = M.loadMemory(store, personas);
  assert.equal(mem.storylines[0].title, 'Lions on a heater');
  assert.equal(mem.storylines[0].status, 'building');
  assert.equal(mem.storylines[0].beats[0].text, 'Lions on a heater');
  assert.equal(mem.relationships.length, personas.relationships.length);
  assert.deepEqual(mem.scoreboard, {});
  assert.deepEqual(mem.caseFile, []);
});

test('relationships heat up and cool down within 0 to 10, keeping their flashpoints', () => {
  const mem = M.emptyMemory(personas);
  const rayNate = () => mem.relationships.find(r => M.pairKey(r.a, r.b) === M.pairKey('ray', 'nate'));
  assert.equal(rayNate().heat, 8);
  for (let n = 1; n <= 4; n++) M.applyEpisode(mem, ep(n), { memoryUpdates: { relationships: [{ a: 'nate', b: 'ray', change: 'heated', flashpoint: `round ${n}` }] } });
  assert.equal(rayNate().heat, 10, 'capped at 10, and order of the pair does not matter');
  assert.deepEqual(rayNate().flashpoints.map(f => f.text), ['round 1', 'round 2', 'round 3', 'round 4']);
  M.applyEpisode(mem, ep(5), { memoryUpdates: { relationships: [{ a: 'ray', b: 'nate', change: 'cooled', flashpoint: 'a truce' }] } });
  assert.equal(rayNate().heat, 9);
  assert.equal(rayNate().flashpoints.length, 4, 'flashpoints are capped');
});

test('the scoreboard counts arguments and keeps receipts straight through re-grading', () => {
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, ep(1), { memoryUpdates: {
    arguments: [{ topic: 'Bills', winner: 'nate', loser: 'ray', decidedBy: 'numbers' }, { topic: 'Poll', winner: '', loser: '', decidedBy: 'viewers' }],
    predictions: [{ persona: 'ray', text: 'Bills win' }],
  } });
  assert.deepEqual(mem.scoreboard.nate, { won: 1, lost: 0, right: 0, wrong: 0 });
  assert.deepEqual(mem.scoreboard.ray, { won: 0, lost: 1, right: 0, wrong: 0 });
  assert.equal(mem.arguments.length, 2);
  const id = mem.predictions[0].id;
  M.resolvePrediction(mem, id, 'right');
  M.resolvePrediction(mem, id, 'wrong');
  assert.equal(mem.scoreboard.ray.right, 0, 'a re-grade moves the receipt, it does not double count');
  assert.equal(mem.scoreboard.ray.wrong, 1);
  M.resolvePrediction(mem, id, 'open');
  assert.equal(mem.scoreboard.ray.wrong, 0);
});

test('Gus\'s case file collects numbered exhibits and believers', () => {
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, ep(1), { memoryUpdates: { caseFile: [{ key: 'case-cin', title: 'The schedule hates the Bengals', evidence: 'Bengals lose by 1', status: 'open', believer: '' }] } });
  M.applyEpisode(mem, ep(2), { memoryUpdates: { caseFile: [{ key: 'case-cin', title: '', evidence: 'Bengals lose by 2', status: 'growing', believer: 'ray' }] } });
  const c = mem.caseFile[0];
  assert.equal(c.title, 'The schedule hates the Bengals', 'an empty title keeps the old one');
  assert.equal(c.status, 'growing');
  assert.deepEqual(c.evidence.map(e => e.text), ['Bengals lose by 1', 'Bengals lose by 2']);
  assert.deepEqual(c.believers, ['ray']);
  const block = M.promptBlock(mem, personas);
  assert.match(block, /Gus's case file/);
  assert.match(block, /\[case-cin\] The schedule hates the Bengals: GROWING, 2 exhibits, latest: Bengals lose by 2\. Believers: Ray/);
});

test('the prompt block carries the desk, the scoreboard and live arcs with their beats', () => {
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, ep(1), { memoryUpdates: {
    storylines: [{ key: 'bills-run', title: 'Can anyone stop the Bills?', beat: 'Bills win big', status: 'heating', teams: ['BUF'], stakes: 'the top seed', nextBeat: 'the Chiefs game', champion: 'ray', skeptic: 'nate' }],
    arguments: [{ topic: 'Bills', winner: 'nate', loser: 'ray', decidedBy: 'numbers' }],
  } });
  const block = M.promptBlock(mem, personas);
  assert.match(block, /Ray and Nate: rivalry, heat 8/);
  assert.match(block, /Nate: arguments 1 won, 0 lost/);
  assert.match(block, /"Bills" \(Week 1\): Nate beat Ray, decided by numbers/);
  assert.match(block, /\[bills-run\] Can anyone stop the Bills\?: HEATING \(BUF\)\. Stakes: the top seed\. Ray believes, Nate doesn't\./);
  assert.match(block, /Week 1: Bills win big/);
  assert.match(block, /Next beat to watch for: the Chiefs game/);
  assert.deepEqual(M.arcsTouching(mem, ['BUF', 'MIA']).map(a => a.key), ['bills-run']);
  assert.deepEqual(M.arcsTouching(mem, ['MIA']), []);
});

test('the A-story is teased, simmers, pays off in the debate and gets a callback; bulletins have none', async () => {
  const { rundown } = await weekly();
  const debate = rundown.segments.find(s => s.kind === 'debate');
  assert.equal(rundown.aStory.payoff, debate.id);
  assert.equal(rundown.aStory.storyId, debate.storyIds[0]);
  assert.deepEqual(rundown.aStory.sides, ['ray', 'nate']);
  const threads = Object.fromEntries(rundown.segments.filter(s => s.thread).map(s => [s.kind, s.thread]));
  assert.equal(threads.cold_open, 'tease');
  assert.equal(threads.debate, 'payoff');
  assert.equal(threads.signoff, 'callback');
  const simmer = rundown.segments.filter(s => s.thread === 'simmer');
  assert.ok(simmer.length >= 1 && simmer.length <= 2);
  assert.ok(simmer.every(s => rundown.segments.indexOf(s) < rundown.segments.indexOf(debate)), 'it simmers before it pays off');
  assert.ok(simmer.every(s => s.cast.some(id => rundown.aStory.sides.includes(id))), 'where one of its sides can jab');
  assert.equal(rundown.cameos, 3);

  const { rundown: bulletin } = await weekly('breaking');
  assert.equal(bulletin.aStory, null);
  assert.equal(bulletin.cameos, 0);
});

test('the brief threads the A-story, gives the cameo budget and hooks each arc once', async () => {
  const { league, rundown, storiesById } = await weekly();
  const debateStory = storiesById[rundown.aStory.storyId];
  const abbr = league.teams[debateStory.teams[0]].abbr;
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, ep(1), { memoryUpdates: { storylines: [{ key: 'arc-1', title: 'A big season', beat: 'it started', status: 'heating', teams: [abbr] }] } });
  const teamAbbr = Object.fromEntries(Object.values(league.teams).map(t => [t.id, t.abbr]));
  const brief = P.episodeBrief({ rundown, storiesById, personas, memory: mem, teamAbbr });
  assert.match(brief, /A-STORY \(tonight's main argument\): ".+", Ray against Nate/);
  assert.match(brief, /CAMEOS: up to 3 tonight/);
  assert.match(brief, /A-story: tease the A-story/);
  assert.match(brief, /A-story: this is where the A-story pays off/);
  assert.equal((brief.match(/Storyline hook: .*\[arc-1\]/g) || []).length, 1, 'one hook per arc per episode');
});

test('validator: cameos inside the budget pass; beyond it they are flagged; new memory fields are cleaned', async () => {
  const { rundown } = await weekly();
  const seg = rundown.segments.find(s => s.kind === 'scoreboard');
  const base = { title: 'T', summary: '', tickerItems: [], fanPoll: { question: '', answers: [] } };
  const lines = speakers => speakers.map(speaker => ({ speaker, text: 'A line here.', emotion: 'neutral', gesture: 'none', shot: 'auto', card: '' }));
  const outsider = personaIds.find(id => !seg.cast.includes(id));
  const script = extra => ({ ...base, segments: rundown.segments.map(s => ({ id: s.id, lines: lines(s.id === seg.id ? [...s.cast, ...extra] : s.cast) })), memoryUpdates: {} });
  const cast = w => w.filter(x => /cast/.test(x));

  assert.deepEqual(cast(validateScript(script([outsider, outsider]), { rundown, personaIds }).warnings), [], 'one anchor, two lines: a cameo');
  assert.equal(cast(validateScript(script([outsider, outsider, outsider]), { rundown, personaIds }).warnings).length, 1, 'three lines is more than a cameo');
  assert.equal(cast(validateScript(script([outsider]), { rundown: { ...rundown, cameos: 0 }, personaIds }).warnings).length, 1, 'no budget, no cameos');

  const r = validateScript({ ...script([]), memoryUpdates: {
    storylines: [{ key: ' k ', title: 'T', beat: 'B', status: 'molten', teams: ['buf', 'Buffalo', 'MIA'], stakes: '', nextBeat: '', champion: 'nobody', skeptic: 'nate' }],
    relationships: [{ a: 'ray', b: 'ray', change: 'heated', flashpoint: 'x' }, { a: 'ray', b: 'gus', change: 'boiling', flashpoint: 'y' }],
    arguments: [{ topic: 'Q', winner: 'ray', loser: 'ray', decidedBy: 'coin flip' }],
    caseFile: [{ key: 'c', title: 'Case', evidence: 'E', status: 'solved', believer: 'sasha' }],
  } }, { rundown, personaIds });
  const mu = r.script.memoryUpdates;
  assert.deepEqual(mu.storylines[0], { key: 'k', title: 'T', beat: 'B', status: 'building', teams: ['BUF', 'MIA'], stakes: '', nextBeat: '', champion: '', skeptic: 'nate' });
  assert.deepEqual(mu.relationships, [{ a: 'ray', b: 'gus', change: 'steady', flashpoint: 'y' }]);
  assert.deepEqual(mu.arguments, [{ topic: 'Q', winner: 'ray', loser: '', decidedBy: '' }]);
  assert.deepEqual(mu.caseFile, [{ key: 'c', title: 'Case', evidence: 'E', status: 'open', believer: 'sasha' }]);
});

test('template writer fills every new memory field, and a published episode lands in memory', async () => {
  const { league, context, rundown, storiesById } = await weekly();
  const v = validateScript(writeTemplateScript({ rundown, storiesById, personas, league, context }), { rundown, personaIds });
  assert.ok(v.ok, v.errors.join('; '));
  const mu = v.script.memoryUpdates;
  assert.ok(mu.storylines.length >= 1);
  assert.equal(mu.relationships[0].change, 'heated');
  assert.equal(mu.arguments.length, 1);
  assert.match(mu.caseFile[0].key, /^case-/);
  const gusCameo = v.script.segments.find(s => s.kind === 'debate').lines.some(l => l.speaker === 'gus');
  assert.ok(gusCameo, 'Gus breaks in on the debate');
  assert.deepEqual(v.warnings.filter(w => /cast/.test(w)), []);
  const mem = M.applyEpisode(M.emptyMemory(personas), ep(1), v.script);
  assert.equal(mem.caseFile.length, 1);
  assert.equal(Object.values(mem.scoreboard).reduce((n, s) => n + s.won, 0), 1);
});

test('script schema stays strict-mode safe: every object closes and requires all its keys', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path} allows extra keys`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${path} does not require every key`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
    }
    if (node.type === 'array') walk(node.items, `${path}[]`);
  };
  walk(scriptJsonSchema(personaIds), 'script');
});

test('script schema keeps its enums to the spoken line, so strict output can compile it', () => {
  const enums = schema => { const out = []; const walk = (n, p) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n.enum)) out.push(p); for (const [k, v] of Object.entries(n)) if (k !== 'enum') walk(v, `${p}.${k}`); }; walk(schema, 'script'); return out; };
  const full = enums(scriptJsonSchema(personaIds));
  assert.equal(full.length, 4, `enums outside the line: ${full.filter(p => !/lines.items/.test(p)).join(', ')}`);
  assert.ok(full.every(p => /lines.items.properties.(speaker|emotion|gesture|shot)$/.test(p)));
  assert.deepEqual(enums(scriptJsonSchema(personaIds, { lean: true })), [], 'the lean schema has none');
});
