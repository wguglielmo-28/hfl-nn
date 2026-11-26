// Roadmap C4: Hub poll results (Crimson Chronicle issue polls and channel
// chat polls) become upbeat "what the fans picked" stories, once each, and
// only when the poll is final with enough votes to be a result.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const S = require('../lib/stories');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const POLLS = [
  { id: 'chronicle:72', source: 'chronicle', question: 'Most fun Week 13 performance?', options: [{ label: 'Daniels', votes: 2 }, { label: 'Golden', votes: 4 }], total: 6, final: false, issue: { slug: 'v3-issue-13', volume: 3, number: 13 } },
  { id: 'chronicle:71', source: 'chronicle', question: 'Most fun Week 12 performance?', options: [{ label: 'Rolle: 2 records in one game', votes: 2 }, { label: 'Lutz', votes: 1 }, { label: 'Allen', votes: 0 }], total: 3, final: true, issue: { slug: 'v3-issue-12', volume: 3, number: 12 } },
  { id: 'channel:5', source: 'channel', question: 'Best uniform?', options: [{ label: 'Home', votes: 2 }, { label: 'Away', votes: 2 }], total: 4, final: true, issue: null },
  { id: 'channel:4', source: 'channel', question: 'Too few votes?', options: [{ label: 'Yes', votes: 1 }, { label: 'No', votes: 1 }], total: 2, final: true, issue: null },
];

test('the feed carries polls; a poll needs a question and two options', () => {
  const polls = normalizeHubFeed({ polls: [...POLLS, { id: 'x', question: 'One option', options: [{ label: 'A', votes: 1 }] }] }).polls;
  assert.deepEqual(polls.map(p => p.id), ['chronicle:72', 'chronicle:71', 'channel:5', 'channel:4']);
  assert.deepEqual(normalizeHubFeed({}).polls, []);
});

test('only final polls with at least 3 votes become stories, said as what the fans picked', () => {
  const got = S.pollStories(POLLS, { teams: {} });
  assert.deepEqual(got.map(s => s.id), ['poll:chronicle:71', 'poll:channel:5'], 'open and tiny polls wait');
  assert.equal(got[0].headline, '"Most fun Week 12 performance?" Crimson Chronicle readers picked Rolle, 2 of 3 votes');
  assert.equal(got[0].facts.where, 'Crimson Chronicle Vol. 3 Issue 12');
  assert.equal(got[1].headline, '"Best uniform?" The HFL-NN chat split between Home and Away');
  assert.deepEqual(got[1].facts.tie, ['Home', 'Away']);
  assert.match(got[0].card.data.text, /ROLLE: 2 RECORDS IN ONE GAME 67%/);
  assert.equal(got[0].facts.results[0], 'Rolle: 2 records in one game: 2');
});

test('a Hub push puts each final poll on the wire once', async () => {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { weeklyShow: 'hflnn', approveWeekly: false });
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', HUB_PUSH_KEY: 'hub-key', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of fixturePayloads()) ctx.ingest.ingest(p);
    await ctx.ingest.flush();
    await ctx.producer.idle();
    const push = () => fetch(`${base}/api/hub/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' }, body: JSON.stringify({ polls: POLLS }) });
    assert.equal((await push()).status, 200);
    assert.equal((await push()).status, 200);
    assert.deepEqual(ctx.producer.wireStories().filter(s => s.type === 'poll_result').map(s => s.id).sort(), ['poll:channel:5', 'poll:chronicle:71']);
  } finally { server.close(); await ctx.close(); }
});
