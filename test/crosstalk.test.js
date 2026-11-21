'use strict';
// Crosstalk: anchors talking over each other. The writer marks how a line
// comes in ("enter"); the mixer overlaps, cuts, fades or ducks the voices;
// the studio moves both mouths. Costs no extra voicing: every line is still
// voiced on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEpisodeAudio, GAP_OTHER } = require('../lib/audio/mixer');
const { validateScript } = require('../lib/writer/validate');
const { scriptJsonSchema } = require('../lib/writer/schema');
const P = require('../lib/writer/prompt');
const basePersonas = require('../config/personas.json');
const show = require('../config/show.json');
const talk = require('../config/talk.json');

const SR = 24000;
// Each line is 2 s of a constant level: "low" lines 0.2, "high" lines 0.5, so
// what the mix holds at any instant says whose voice is in it.
const tts = { SAMPLE_RATE: SR, speak: async text => ({ samples: new Float32Array(2 * SR).fill(/high/.test(text) ? 0.5 : 0.2), synthetic: false }) };
const personas = { network: { name: 'HFL-NN' }, anchors: [{ id: 'ray', voice: 'am_onyx' }, { id: 'nate', voice: 'bm_george' }, { id: 'hal', voice: 'am_michael' }] };
const rundown = { type: 'weekly', segments: [{ id: 's1', kind: 'debate', set: 'desk' }] };
const line = (speaker, text, enter = '') => ({ speaker, text, emotion: 'neutral', gesture: 'none', shot: 'auto', card: '', ...(enter ? { enter } : {}) });
const mix = lines => buildEpisodeAudio({ script: { segments: [{ id: 's1', lines }] }, rundown, personas, tts, settings: {} });
const at = (out, sec) => out.samples[Math.round(sec * SR)];
const ratio = (out, a, b) => +(at(out, a) / at(out, b)).toFixed(2);

test('no crosstalk: lines take turns with the usual gap and no per-anchor mouths', async () => {
  const out = await mix([line('ray', 'low one'), line('nate', 'high two'), line('hal', 'low three')]);
  assert.equal(+(out.lines[1].t0 - out.lines[0].t1).toFixed(2), GAP_OTHER);
  assert.equal(+(out.lines[2].t0 - out.lines[1].t1).toFixed(2), GAP_OTHER);
  assert.equal(out.mouthBySpeaker, undefined, 'old-style manifests are unchanged');
  assert.ok(out.lines.every(l => !('enter' in l)));
});

test('cut: the new voice jumps in and the other stops dead; the segment runs on from the cut', async () => {
  const out = await mix([line('ray', 'low one'), line('nate', 'high two', 'cut'), line('hal', 'low three')]);
  const [a, b, c] = out.lines;
  assert.ok(b.t0 < a.t0 + 2, 'starts before the first line would have ended');
  assert.ok(Math.abs(a.t1 - (b.t0 + 0.06)) < 0.01, `first line now ends just after the cut (${a.t1} vs ${b.t0})`);
  assert.equal(ratio(out, b.t0 + 0.3, a.t0 + 1), 2.5, 'only the new voice is left');
  assert.equal(+(c.t0 - b.t1).toFixed(2), GAP_OTHER, 'the next turn follows the line that won, not the cut one');
  assert.equal(b.enter, 'cut');
  assert.ok(out.mouthBySpeaker.ray && out.mouthBySpeaker.nate);
});

test('over: both voices at once, the one losing the floor turned down; trail fades the other out', async () => {
  const over = await mix([line('ray', 'low one'), line('nate', 'high two', 'over')]);
  const [a, b] = over.lines;
  assert.ok(b.t0 < a.t1, 'they overlap');
  assert.equal(ratio(over, b.t0 + 0.3, a.t0 + 0.6), +((0.2 * 0.63 + 0.5) / 0.2).toFixed(2), 'the first voice ducked about 4 dB under the second');
  const fi = Math.floor((b.t0 + 0.3) * 30);
  assert.ok(Number(over.mouthBySpeaker.ray[fi]) > 0 && Number(over.mouthBySpeaker.nate[fi]) > 0, 'two mouths move in the overlap');

  const trail = await mix([line('ray', 'low one'), line('nate', 'high two', 'trail')]);
  const [ta, tb] = trail.lines;
  assert.ok(Math.abs(ta.t1 - (tb.t0 + 0.4)) < 0.01, 'trails off over 0.4 s');
  assert.equal(ratio(trail, tb.t0 + 0.6, ta.t0 + 0.6), 2.5, 'then gone');
});

test('persist: the voice already talking keeps the floor over the one trying to get in', async () => {
  const out = await mix([line('ray', 'low one'), line('nate', 'high two', 'persist')]);
  const [a, b] = out.lines;
  assert.ok(b.t0 < a.t1);
  assert.equal(ratio(out, b.t0 + 0.3, a.t0 + 0.6), +((0.2 + 0.5 * 0.63) / 0.2).toFixed(2), 'the newcomer sits under');
  assert.equal(a.t1, +(a.t0 + 2).toFixed(3), 'the first voice finishes');
});

test('the validator keeps crosstalk inside each segment\'s level', () => {
  const rd = { targetWords: 0, segments: [
    { id: 's1', kind: 'debate', crosstalk: 'heavy', cast: ['ray', 'nate', 'hal'], cards: [] },
    { id: 's2', kind: 'scoreboard', crosstalk: 'light', cast: ['hal', 'ray'], cards: [] },
    { id: 's3', kind: 'signoff', cast: ['hal'], cards: [] },
  ] };
  const l = (sp, enter) => ({ speaker: sp, text: 'Words here.', emotion: 'angry', gesture: 'none', shot: 'auto', card: '', enter });
  const script = { title: 't', segments: [
    { id: 's1', lines: [l('ray', 'cut'), l('nate', 'cut'), l('nate', 'over'), l('ray', 'fight'), l('nate', 'persist')] },
    { id: 's2', lines: [l('hal', ''), l('ray', 'cut'), l('hal', 'cut'), l('ray', 'cut')] },
    { id: 's3', lines: [l('hal', ''), l('ray', 'over')] },
  ] };
  const r = validateScript(script, { rundown: rd, personaIds: ['ray', 'nate', 'hal'] });
  const enters = r.script.segments.map(s => s.lines.map(x => x.enter || ''));
  assert.deepEqual(enters[0], ['', 'cut', '', 'fight', 'persist'], 'not the first line, never over yourself');
  assert.deepEqual(enters[1], ['', 'cut', 'cut', ''], 'light allows two');
  assert.deepEqual(enters[2], ['', ''], 'none allows none');
  assert.ok(r.ok, 'dropped crosstalk is a warning, never an error');
  assert.ok(r.warnings.some(w => /crosstalk here is light \(at most 2\)/.test(w)));
});

test('levels are set per segment, the schema asks for "enter", and the brief and bibles explain it', () => {
  assert.equal(show.segments.debate.crosstalk, 'heavy');
  assert.equal(show.segments.scoreboard.crosstalk, 'light');
  assert.equal(show.segments.breaking.crosstalk, undefined);
  assert.equal(talk.segments.take_vs_take.crosstalk, 'heavy');
  assert.equal(talk.segments.rant.crosstalk, undefined);
  const lineSchema = scriptJsonSchema(['ray']).properties.segments.items.properties.lines.items;
  assert.ok(lineSchema.required.includes('enter'));
  assert.deepEqual(lineSchema.properties.enter.enum, ['', 'cut', 'over', 'fight', 'trail', 'persist']);
  assert.match(P.showBible(basePersonas), /Crosstalk \(anchors talking over each other\)/);
  const brief = P.episodeBrief({ rundown: { title: 'x', type: 'weekly', phase: 'regular', targetWords: 10, segments: [{ id: 's1', kind: 'debate', title: 'Debate', crosstalk: 'heavy', cast: ['ray', 'nate'], storyIds: [], cards: [], targetWords: 10 }] }, storiesById: {}, personas: basePersonas, memory: require('../lib/memory').emptyMemory(basePersonas) });
  assert.match(brief, /Crosstalk: heavy \(up to 6/);
});
