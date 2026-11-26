// Ask the desk: members' questions, approved on the HFL Hub, air by
// themselves in an Ask the Desk segment, credited by HFL coach name (never a
// Hub handle), and each only once.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const { coachFor, creditFor } = require('../lib/coaches');
const T = require('../lib/talk');
const talkCfg = require('../config/talk.json');
const basePersonas = require('../config/personas.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const Q = { id: 'nn42', name: 'gbgm_handle', team: 'GB', text: 'Who is the real favorite in the NFC North this year?' };

test('coaches are named by their HFL name, through aliases; a CPU team or no team gets "a viewer"', () => {
  assert.deepEqual(coachFor('gb'), { team: 'Packers', coach: 'Hank Nottick' });
  assert.equal(coachFor('AZ').coach, coachFor('ARI').coach, 'AZ is ARI');
  assert.equal(creditFor('GB').who, 'Hank Nottick of the Packers');
  assert.equal(creditFor('BUF').who, 'a viewer', 'the Bills are a CPU team');
  assert.equal(creditFor('').who, 'a viewer');
});

test('the feed carries questions, and owners get their HFL coach name when the Hub leaves it blank', () => {
  const feed = normalizeHubFeed({ questions: [Q, { id: '', text: 'no id' }], owners: [{ teamAbbr: 'GB', displayName: 'gbgm_handle' }, { teamAbbr: 'DET', coach: 'Given' }] });
  assert.deepEqual(feed.questions.map(q => q.id), ['nn42']);
  assert.equal(feed.owners[0].coach, 'Hank Nottick');
  assert.equal(feed.owners[1].coach, 'Given', 'a coach the Hub sends wins');
  assert.deepEqual(normalizeHubFeed({}).questions, []);
});

test('the Fifth Quarter Mailbag credits takes and questions by coach name, never the handle', () => {
  const personas = T.talkPersonas(basePersonas, talkCfg);
  const w = { from: '2026-11-20T00:00:00Z', to: '2026-11-26T00:00:00Z', label: 'HFL Week 13' };
  const r = T.buildTalkRundown({
    talk: talkCfg, personas, league: { teams: {} }, stories: [{ id: 'g', type: 'game', headline: 'x', teams: [], score: 1, facts: {}, card: null }],
    fanTakes: [{ id: 'nn1', name: 'dal_handle', team: 'DAL', text: 'Cowboys win it all.' }], questions: [Q],
    window: w, charBudget: 25000, include: ['mailbag'],
  });
  const mb = r.segments.find(s => s.kind === 'mailbag');
  assert.ok(mb, 'the mailbag runs');
  assert.match(mb.brief, /Mike Bugatti of the Cowboys/);
  assert.match(mb.brief, /question from Hank Nottick of the Packers/);
  assert.doesNotMatch(JSON.stringify(mb), /handle/);
  assert.deepEqual(mb.questionIds, ['nn42']);
});

test('Ask the Desk airs an approved question on a daily show, credited by coach name, and only once', async () => {
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
    const push = await fetch(`${base}/api/hub/push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' },
      body: JSON.stringify({ questions: [Q] }),
    });
    assert.equal(push.status, 200);

    const make = async () => {
      const e = ctx.producer.createEpisode({ type: 'custom', customKinds: ['cold_open', 'ask_the_desk', 'signoff'], title: 'Morning Blitz', writer: 'template' });
      await ctx.producer.idle();
      return e;
    };
    const ep = await make();
    assert.equal(ctx.producer.get(ep.id).status, 'draft', ctx.producer.get(ep.id).error || '');
    ctx.producer.voice(ep.id);
    await ctx.producer.idle();
    await ctx.producer.publish(ep.id, { discord: false });
    const done = ctx.producer.get(ep.id);
    assert.equal(done.status, 'published', done.error || '');
    const seg = done.rundown.segments.find(s => s.kind === 'ask_the_desk');
    assert.ok(seg, 'the segment ran');
    assert.deepEqual(seg.questionIds, ['nn42']);
    assert.match(seg.brief, /from Hank Nottick of the Packers/);
    const said = done.script.segments.find(s => s.id === seg.id).lines.map(l => l.text).join(' ');
    assert.match(said, /Hank Nottick of the Packers: Who is the real favorite/);
    assert.doesNotMatch(JSON.stringify(done.script) + JSON.stringify(done.rundown), /gbgm_handle/, 'the Hub handle never reaches the show');

    const again = await make();
    assert.equal(ctx.producer.get(again.id).rundown.segments.some(s => s.kind === 'ask_the_desk'), false, 'an aired question does not air twice');
  } finally { server.close(); await ctx.close(); }
});
