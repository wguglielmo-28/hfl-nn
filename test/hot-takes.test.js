'use strict';
// Hot Takes, the sharper Hot Take Hotline, and the Discord fan poll.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/league');
const S = require('../lib/stories');
const { buildRundown } = require('../lib/rundown');
const { writeTemplateScript } = require('../lib/writer/template');
const { validateScript, normalizePoll } = require('../lib/writer/validate');
const { scriptJsonSchema } = require('../lib/writer/schema');
const { episodeMessage, pollPayload } = require('../lib/discord');
const P = require('../lib/writer/prompt');
const M = require('../lib/memory');
const { createStore } = require('../lib/store');
const { createMaddenIngest } = require('../lib/ingest/madden');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const personaIds = personas.anchors.map(a => a.id);
const quiet = { log() {}, warn() {}, error() {} };

async function weekly() {
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
  const rundown = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories });
  return { league, stories, context, rundown, storiesById: Object.fromEntries(stories.map(s => [s.id, s])) };
}

test('the weekly show gets a Hot Takes segment on its own topics, and the debate has to end with a winner', async () => {
  const { rundown } = await weekly();
  const kinds = rundown.segments.map(s => s.kind);
  assert.ok(kinds.includes('hot_takes'));
  assert.ok(kinds.indexOf('hot_takes') > kinds.indexOf('top_performers'), 'after the results, before the wire');

  const hot = rundown.segments.find(s => s.kind === 'hot_takes');
  const debate = rundown.segments.find(s => s.kind === 'debate');
  const gus = rundown.segments.find(s => s.kind === 'conspiracy_corner');
  assert.ok(hot.storyIds.length >= 1 && hot.storyIds.length <= 3);
  assert.equal(hot.cards.length, hot.storyIds.length, 'one card per topic');
  for (const id of hot.storyIds) {
    assert.ok(!debate.storyIds.includes(id), 'hot takes leave the debate topic alone');
    assert.ok(!gus?.storyIds.includes(id), 'and Gus\'s case');
  }
  assert.deepEqual(hot.cast, ['hal', 'ray', 'nate', 'sasha', 'gus']);
  assert.match(hot.brief, /Buy" or "Sell/);
  assert.match(hot.brief, /rotate through Ray, Nate, Sasha, Gus/);
  assert.match(debate.brief, /Never a draw/);
  assert.match(debate.brief, /Hal opens by framing it/);
});

test('the show bible tells every segment to argue; the brief asks for a poll only when it will be posted', async () => {
  const { rundown, storiesById } = await weekly();
  const bible = P.showBible(personas, {});
  assert.match(bible, /# Rules[\s\S]*Arguments and hot takes/);
  assert.match(bible, /No both-sides endings/);
  assert.match(bible, /never each other as people/);

  const memory = M.emptyMemory(personas);
  const withPoll = P.episodeBrief({ rundown, storiesById, personas, memory, fanPoll: true });
  assert.match(withPoll, /FAN POLL: the episode is posted to the league's Discord with a poll/);
  assert.match(withPoll, /Keep it upbeat/);
  assert.match(P.episodeBrief({ rundown, storiesById, personas, memory }), /FAN POLL: none for this episode/);
  assert.match(P.episodeBrief({ rundown: { ...rundown, type: 'breaking' }, storiesById, personas, memory, fanPoll: true }), /FAN POLL: none/, 'bulletins never get a poll');
});

test('script schema: fanPoll is required and strict-mode safe', () => {
  const schema = scriptJsonSchema(personaIds);
  assert.ok(schema.required.includes('fanPoll'));
  const poll = schema.properties.fanPoll;
  assert.equal(poll.additionalProperties, false);
  assert.deepEqual(poll.required, ['question', 'answers']);
  assert.deepEqual(poll.properties.answers.items.required, ['text', 'persona']);
  assert.deepEqual(poll.properties.answers.items.properties.persona.enum, [...personaIds, '']);
});

test('template writer: hot takes rotate, the debate gets a winner or a poll, and both validate', async () => {
  const { league, context, rundown, storiesById } = await weekly();
  const check = s => validateScript(s, { rundown, personaIds });

  const polled = check(writeTemplateScript({ rundown, storiesById, personas, league, context, fanPoll: true }));
  assert.ok(polled.ok, polled.errors.join('; '));
  const hot = polled.script.segments.find(s => s.kind === 'hot_takes');
  const speakers = new Set(hot.lines.map(l => l.speaker));
  assert.ok(speakers.size >= 3, 'more than one anchor gets a take');
  assert.ok(hot.lines.some(l => /^(Buy|Sell)\./.test(l.text)));
  assert.equal(polled.script.fanPoll.answers.length, 2);
  assert.deepEqual(polled.script.fanPoll.answers.map(a => a.persona), ['ray', 'nate']);
  const debate = polled.script.segments.find(s => s.kind === 'debate');
  assert.match(debate.lines.at(-1).text, /Vote in the poll on our Discord/);

  const plain = check(writeTemplateScript({ rundown, storiesById, personas, league, context }));
  assert.ok(plain.ok);
  assert.equal(plain.script.fanPoll, null);
  const all = plain.script.segments.flatMap(s => s.lines.map(l => l.text)).join(' ');
  assert.doesNotMatch(all, /draw/i, 'no both-sides endings');
  assert.doesNotMatch(all, /poll/i, 'no poll is mentioned when there is none');
});

test('fan poll normalisation keeps it inside Discord\'s limits or drops it', () => {
  const say = t => String(t).trim();
  const run = poll => { const warnings = []; return { poll: normalizePoll(poll, { personaIds, say, warnings }), warnings }; };
  assert.equal(run({ question: '', answers: [] }).poll, null);
  assert.equal(run(null).poll, null);

  const one = run({ question: 'Who is right?', answers: [{ text: 'Ray', persona: 'ray' }, { text: 'ray', persona: 'ray' }] });
  assert.equal(one.poll, null, 'duplicate answers leave one side, which is no poll');
  assert.match(one.warnings[0], /Dropped the fan poll/);

  const { poll } = run({
    question: 'Who is right?',
    answers: [
      { text: 'x'.repeat(80), persona: 'ray' }, { text: 'Nate', persona: 'nate' },
      { text: 'Neither', persona: 'nobody' }, { text: 'Both', persona: '' }, { text: 'Gus, somehow', persona: 'gus' },
    ],
  });
  assert.equal(poll.answers.length, 4);
  assert.equal(poll.answers[0].text.length, 55);
  assert.equal(poll.answers[2].persona, '', 'unknown personas are cleared');
});

test('Discord: the poll rides on the episode post, labelled by anchor; bulletins never carry one', () => {
  const fanPoll = { question: 'Hot Take Hotline: who is right?', answers: [{ text: 'the Bills win the conference', persona: 'ray' }, { text: 'Nate: regression is coming', persona: 'nate' }, { text: 'Both', persona: '' }] };
  const p = pollPayload(fanPoll, personas);
  assert.deepEqual(p.answers.map(a => a.poll_media.text), ['Ray: the Bills win the conference', 'Nate: regression is coming', 'Both']);
  assert.equal(p.duration, 48);
  assert.equal(p.allow_multiselect, false);
  assert.equal(pollPayload({ question: 'Q', answers: [{ text: 'one' }] }), null);

  const msg = episodeMessage({ type: 'weekly', title: 'HFL-NN Tonight', summary: 's' }, 'https://x/watch/1', { poll: fanPoll, personas });
  assert.equal(msg.poll.question.text, fanPoll.question);
  assert.ok(msg.embeds.length, 'the embed stays alongside the poll');
  assert.equal(episodeMessage({ type: 'breaking', title: 'B', summary: '' }, '', { poll: fanPoll, personas }).poll, undefined);
  assert.equal(episodeMessage({ type: 'weekly', title: 'T', summary: '' }, '').poll, undefined, 'no poll, no poll field');
});
