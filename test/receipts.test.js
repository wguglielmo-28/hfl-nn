'use strict';
// Receipts: predictions graded automatically from final scores, then called
// out on air.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/receipts');
const M = require('../lib/memory');
const S = require('../lib/stories');
const L = require('../lib/league');
const { buildRundown } = require('../lib/rundown');
const { writeTemplateScript } = require('../lib/writer/template');
const { validateScript } = require('../lib/writer/validate');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const personaIds = personas.anchors.map(a => a.id);
const quiet = { log() {}, warn() {}, error() {} };

// Two teams, a season that is half played.
function league({ played = 9 } = {}) {
  const teams = { 1: { id: 1, abbr: 'BUF', nickname: 'Bills' }, 2: { id: 2, abbr: 'MIA', nickname: 'Dolphins' } };
  const games = {};
  for (let w = 1; w <= 17; w++) {
    const done = w <= played;
    games[`g${w}`] = { key: `g${w}`, seasonIndex: 8, stage: 'reg', week: w, homeId: w % 2 ? 1 : 2, awayId: w % 2 ? 2 : 1, played: done,
      homeScore: done ? (w % 2 ? 30 : 10) : 0, awayScore: done ? (w % 2 ? 20 : 27) : 0 };   // BUF wins every game played
  }
  return { seasonIndex: 8, teams, games };
}
const pred = (check, extra = {}) => ({ id: 'p1', persona: 'ray', text: 'call', status: 'open', at: '2026-10-01T00:00:00Z', check, seasonIndex: 8, ...extra });

test('game picks are graded once the game is final, and never before', () => {
  const lg = league();
  assert.deepEqual(R.gradePrediction(pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 3 }), lg),
    { status: 'right', result: 'The Bills beat the Dolphins 30 to 20 in Week 3.' });
  assert.deepEqual(R.gradePrediction(pred({ kind: 'game', team: 'MIA', opponent: 'BUF', week: 4 }), lg),
    { status: 'wrong', result: 'The Dolphins lost to the Bills 27 to 10 in Week 4.' });
  assert.equal(R.gradePrediction(pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 12 }), lg), null, 'not played yet');
  assert.equal(R.gradePrediction(pred({ kind: 'game', team: 'NYJ', opponent: 'MIA', week: 3 }), lg), null, 'unknown team');
  assert.equal(R.gradePrediction(pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 3 }, { seasonIndex: 7 }), lg), null, 'another season');
  assert.equal(R.gradePrediction(pred({ kind: 'none' }), lg), null);
});

test('win totals are graded right when reached and wrong when out of reach', () => {
  assert.equal(R.gradePrediction(pred({ kind: 'wins', team: 'BUF', wins: 9 }), league()).status, 'right');
  assert.equal(R.gradePrediction(pred({ kind: 'wins', team: 'BUF', wins: 12 }), league()), null, '9 wins, 8 left: still alive');
  const r = R.gradePrediction(pred({ kind: 'wins', team: 'MIA', wins: 9 }), league());
  assert.deepEqual(r, { status: 'wrong', result: 'The Dolphins have 0 wins with 8 games left, so 9 is out of reach.' });
});

test('checks are anchored to games still to be played, and wins totals to the right season', () => {
  const lg = league();
  const [named, next, played, bogus] = R.anchorChecks([
    pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 12 }),
    pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 0 }),
    pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 3 }),
    pred({ kind: 'game', team: 'XXX', opponent: 'MIA', week: 12 }),
  ], lg);
  assert.equal(named.check.week, 12);
  assert.equal(next.check.week, 10, 'no week named: their next meeting');
  assert.equal(played.check, undefined, 'a pick on a game already played is never auto-graded');
  assert.equal(bogus.check, undefined);

  const [now] = R.anchorChecks([pred({ kind: 'wins', team: 'BUF', wins: 12 }, { seasonIndex: null })], lg);
  assert.equal(now.seasonIndex, 8);
  const done = league({ played: 17 });
  const [nextYear] = R.anchorChecks([pred({ kind: 'wins', team: 'MIA', wins: 3 }, { seasonIndex: null })], done);
  assert.equal(nextYear.seasonIndex, 9, 'an offseason call is about next season');
  assert.equal(R.gradePrediction(nextYear, done), null, 'so the finished season cannot grade it');
});

test('grading updates the scoreboard and makes a receipt; airing it uses it up; re-grading makes a new one', () => {
  const mem = M.emptyMemory(personas);
  mem.predictions.push(pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 3 }), pred({ kind: 'game', team: 'BUF', opponent: 'MIA', week: 12 }, { id: 'p2', persona: 'nate' }));
  const graded = R.gradeOpenPredictions(mem, league());
  assert.deepEqual(graded.map(p => p.id), ['p1']);
  const p = mem.predictions[0];
  assert.equal(p.status, 'right');
  assert.equal(p.gradedBy, 'auto');
  assert.match(p.result, /30 to 20/);
  assert.equal(mem.scoreboard.ray.right, 1);
  assert.deepEqual(R.freshReceipts(mem).map(x => x.id), ['p1']);
  assert.deepEqual(R.gradeOpenPredictions(mem, league()), [], 'graded once');

  M.applyEpisode(mem, { id: 'ep9', title: 'Week 9', rundown: { receipts: ['p1'] } }, { memoryUpdates: {} });
  assert.equal(p.calledOutIn, 'ep9');
  assert.deepEqual(R.freshReceipts(mem), []);
  assert.match(M.promptBlock(mem, personas), /Ray was RIGHT about "call" \(The Bills beat the Dolphins 30 to 20 in Week 3\.\)/);

  M.resolvePrediction(mem, 'p1', 'wrong');
  assert.equal(p.gradedBy, 'commissioner');
  assert.equal(p.calledOutIn, undefined, 'a changed verdict is news again');
  assert.deepEqual(mem.scoreboard.ray, { won: 0, lost: 0, right: 0, wrong: 1 });
  M.resolvePrediction(mem, 'p1', 'open');
  assert.equal(p.result, undefined);
});

test('a published prediction keeps its check; one without a check is the commissioner\'s to grade', () => {
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, { id: 'ep1', title: 'Week 1', rundown: { focusWeek: { seasonIndex: 8 } } }, { memoryUpdates: { predictions: [
    { persona: 'ray', text: 'Bills win', check: { kind: 'game', team: 'BUF', opponent: 'MIA', week: 12, wins: 0 } },
    { persona: 'nate', text: 'Someone gets traded', check: { kind: 'none', team: '', opponent: '', week: 0, wins: 0 } },
  ] } });
  assert.equal(mem.predictions[0].check.kind, 'game');
  assert.equal(mem.predictions[0].seasonIndex, 8);
  assert.equal(mem.predictions[1].check, undefined);
});

async function fixtureWeekly(receipts) {
  const store = createStore(tmpDir());
  let lg = L.emptyLeague();
  const batches = [];
  const { createMaddenIngest } = require('../lib/ingest/madden');
  const ingest = createMaddenIngest({ store, getLeague: () => lg, saveLeague() {}, debounceMs: 1e9, logger: quiet, onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }) });
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  const stories = batches[0].stories, context = S.buildContext(lg, {});
  return { league: lg, context, stories, rundown: buildRundown({ type: 'weekly', phase: 'regular', show, personas, league: lg, context, stories, receipts }) };
}

test('the Receipts segment seats whoever made the calls, with a card each, and the template plays it', async () => {
  const receipts = [
    { id: 'a', persona: 'ray', text: 'Bills win', status: 'right', result: 'The Bills beat the Dolphins 49 to 24 in Week 1.', madeIn: 'Preseason Special' },
    { id: 'b', persona: 'nate', text: 'Jets win', status: 'wrong', result: '', madeIn: '' },
  ];
  const { league: lg, context, stories, rundown } = await fixtureWeekly(receipts);
  const seg = rundown.segments.find(s => s.kind === 'receipts');
  assert.deepEqual(seg.cast, ['hal', 'ray', 'nate']);
  assert.equal(seg.cards.length, 2);
  assert.equal(seg.cards[0].data.text, 'RAY: BILLS WIN');
  assert.match(seg.brief, /Ray said "Bills win" on "Preseason Special": RIGHT\. The Bills beat the Dolphins 49 to 24 in Week 1\./);
  assert.deepEqual(rundown.receipts, ['a', 'b']);
  assert.ok(rundown.segments.indexOf(seg) === rundown.segments.findIndex(s => s.kind === 'scoreboard') + 1, 'right after the scores');

  const storiesById = Object.fromEntries(stories.map(s => [s.id, s]));
  const v = validateScript(writeTemplateScript({ rundown, storiesById, personas, league: lg, context }), { rundown, personaIds });
  assert.ok(v.ok, v.errors.join('; '));
  const lines = v.script.segments.find(s => s.kind === 'receipts').lines;
  assert.ok(lines.some(l => l.speaker === 'ray') && lines.some(l => l.speaker === 'nate'));

  const { rundown: none } = await fixtureWeekly([]);
  assert.ok(!none.segments.some(s => s.kind === 'receipts'), 'no receipts, no segment');
  assert.deepEqual(none.receipts, []);
});

test('end to end: an export grades an open pick, and the automatic weekly opens with its receipt', async () => {
  const dataDir = tmpDir();
  // Ray picked the Bills over the Dolphins in Week 1 (they won 49 to 24 in the fixture).
  createStore(dataDir).writeJSON('memory.json', { ...M.emptyMemory(personas), predictions: [
    { id: 'old:0', persona: 'ray', text: 'Bills beat the Dolphins', madeIn: 'Preseason Special', episodeId: 'old', at: '2026-09-01T00:00:00Z', status: 'open', check: { kind: 'game', team: 'BUF', opponent: 'MIA', week: 1, wins: 0 } },
  ] });
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'x', INGEST_KEY: 'k', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } }, debounceMs: 1e9, logger: quiet,
  });
  try {
    for (const p of fixturePayloads()) ctx.ingest.ingest(p);
    await ctx.ingest.flush();
    await ctx.producer.idle();
    const mem = M.loadMemory(ctx.store, personas);
    assert.equal(mem.predictions[0].status, 'right');
    assert.match(mem.predictions[0].result, /Bills beat the Dolphins 49 to 24 in Week 1/);
    const ep = ctx.producer.get(ctx.producer.list()[0].id);
    assert.deepEqual(ep.rundown.receipts, ['old:0']);
    assert.ok(ep.script.segments.some(s => s.kind === 'receipts'));
  } finally { await ctx.close(); }
});
