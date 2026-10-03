'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/league');
const S = require('../lib/stories');
const { buildRundown, chronicleItem } = require('../lib/rundown');
const { writeTemplateScript } = require('../lib/writer/template');
const { validateScript, factNumberSet } = require('../lib/writer/validate');
const { createClaudeWriter, costOf, effortFor } = require('../lib/writer/claude');
const P = require('../lib/writer/prompt');
const M = require('../lib/memory');
const { createStore } = require('../lib/store');
const { createMaddenIngest } = require('../lib/ingest/madden');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixture, fixturePayloads, secondBatch, tmpDir, clone } = require('./helpers');

const personaIds = personas.anchors.map(a => a.id);
const quiet = { log() {}, warn() {}, error() {} };

// Builds the fixture league; optional `mutate(payloads)` makes a second batch.
async function leagueWithBatches(mutate) {
  const store = createStore(tmpDir());
  let league = L.emptyLeague();
  const batches = [];
  const ingest = createMaddenIngest({
    store, getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet,
    onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }),
  });
  for (const p of fixturePayloads()) ingest.ingest(p);
  await ingest.flush();
  if (mutate) {
    for (const p of mutate()) ingest.ingest(p);
    await ingest.flush();
  }
  return { league, batches };
}


test('game stories come from the week in the batch; stale standings are not quoted', async () => {
  const { league, batches } = await leagueWithBatches();
  const stories = batches[0].stories;
  assert.equal(league.standingsFresh, false, 'fixture standings are Week 9, scores are Week 1');
  assert.equal(L.recordOf(league, Object.keys(league.teams)[0]), '');
  const games = stories.filter(s => s.type === 'game');
  assert.equal(games.length, 16);
  const buf = games.find(s => s.facts.away.abbr === 'BUF');
  assert.match(buf.headline, /Bills .* Phins 49-24/);
  assert.equal(buf.facts.margin, 25);
  assert.equal(buf.facts.away.recordAfter, null);
  assert.ok(stories.some(s => s.type === 'performance' && /Josh Allen/.test(s.headline)));
  assert.ok(!stories.some(s => s.type === 'streak'), 'no standings stories from stale standings');
  // Sorted best first
  for (let i = 1; i < stories.length; i++) assert.ok(stories[i - 1].score >= stories[i].score);
});

test('roster diffs become trade, signing, injury and dev stories', async () => {
  const { batches } = await leagueWithBatches(secondBatch);
  const stories = batches[1].stories;
  const types = new Set(stories.map(s => s.type));
  for (const t of ['trade', 'signing', 'injury', 'dev_change']) assert.ok(types.has(t), `expected a ${t} story, got ${[...types]}`);
  const trade = stories.find(s => s.type === 'trade');
  assert.equal(trade.card.type, 'trade');
  assert.ok(S.isBreaking(stories.find(s => s.type === 'dev_change')), 'X-Factor upgrades are breaking news');
  assert.equal(stories.filter(s => s.type === 'game').length, 0, 'a roster-only batch has no game stories');
});

test('a fantasy draft is one story, not hundreds of trades', async () => {
  // Every team's roster moves to the next team over.
  const { league, batches } = await leagueWithBatches(() => {
    const rosters = fixture('rosters');
    const ids = Object.keys(rosters);
    return ids.map((id, i) => {
      const to = Number(ids[(i + 1) % ids.length]);
      const body = clone(rosters[id]);
      body.rosterInfoList = body.rosterInfoList.map(p => ({ ...p, teamId: to }));
      return { kind: 'roster', teamId: to, body };
    });
  });
  const stories = batches[1].stories;
  const rebuild = stories.filter(s => s.type === 'roster_rebuild');
  assert.equal(rebuild.length, 1);
  assert.ok(rebuild[0].facts.playersMoved > 1000, `moved ${rebuild[0].facts.playersMoved}`);
  assert.equal(rebuild[0].facts.headliners.length, 12);
  assert.deepEqual(stories.filter(s => ['trade', 'signing', 'release', 'departure', 'bulk'].includes(s.type)), [], 'no per-player moves');
  assert.ok(!stories.some(S.isBreaking), 'and no bulletin');

  const context = S.buildContext(league, {});
  const draft = buildRundown({ type: 'special', phase: 'draft', show, personas, league, context, stories });
  const desk = draft.segments.find(s => s.kind === 'draft_desk');
  assert.ok(desk.storyIds.includes(rebuild[0].id));
  assert.match(desk.brief, /fantasy draft/);
  const script = writeTemplateScript({ rundown: draft, storiesById: Object.fromEntries(stories.map(s => [s.id, s])), personas, league, context });
  assert.ok(validateScript(script, { rundown: draft, personaIds }).ok);
});

test('a free-agency wave is not mistaken for a fantasy draft', async () => {
  // A third of every roster hits the open market in one advance.
  const { batches } = await leagueWithBatches(() => {
    const fa = clone(fixture('freeagents'));
    const rosters = Object.entries(fixture('rosters')).map(([id, r]) => {
      const body = clone(r);
      const gone = body.rosterInfoList.splice(0, Math.floor(body.rosterInfoList.length * 0.35));
      fa.rosterInfoList.push(...gone.map(p => ({ ...p, teamId: 0, isFreeAgent: true })));
      return { kind: 'roster', teamId: Number(id), body };
    });
    return [{ kind: 'freeagents', body: fa }, ...rosters];
  });
  const stories = batches[1].stories;
  assert.ok(!stories.some(s => s.type === 'roster_rebuild'));
  assert.ok(stories.some(s => s.type === 'release'), 'the releases are reported as releases');
});

test('a preseason special straight after the draft reads the rankings once, without 0-0 records', async () => {
  const store = createStore(tmpDir());
  const league = L.emptyLeague();
  const ingest = createMaddenIngest({ store, getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet });
  for (const p of fixturePayloads().filter(x => x.kind !== 'week')) {
    if (p.kind === 'standings') p.body.teamStandingInfoList.forEach(r => Object.assign(r, { totalWins: 0, totalLosses: 0, totalTies: 0 }));
    ingest.ingest(p);
  }
  await ingest.flush();
  const context = S.buildContext(league, {});
  assert.ok(context.powerRankings, 'rankings come from the rosters alone');
  const rundown = buildRundown({ type: 'special', phase: 'preseason', show, personas, league, context, stories: [] });
  const checked = validateScript(writeTemplateScript({ rundown, storiesById: {}, personas, league, context }), { rundown, personaIds });
  assert.ok(checked.ok, checked.errors.join('; '));
  const lines = kind => (checked.script.segments.find(s => s.kind === kind)?.lines || []).map(l => l.text);
  assert.ok(lines('power_rankings').some(t => /^Number 1: /.test(t)));
  assert.ok(!lines('power_rankings').some(t => /0-0/.test(t)), 'no 0-0 records read aloud');
  assert.ok(lines('predictions').length && !lines('predictions').some(t => /^Number \d+: /.test(t)), 'predictions do not repeat the countdown');
});

test('rundowns: weekly, breaking and offseason shapes', async () => {
  const { league, batches } = await leagueWithBatches(secondBatch);
  const stories = [...batches[1].stories, ...batches[0].stories].sort((a, b) => b.score - a.score);
  const context = S.buildContext(league, {});
  const weekly = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories });
  const kinds = weekly.segments.map(s => s.kind);
  assert.equal(kinds[0], 'cold_open');
  assert.equal(kinds[kinds.length - 1], 'signoff');
  for (const k of ['scoreboard', 'game_of_week', 'transactions', 'conspiracy_corner']) assert.ok(kinds.includes(k), `weekly has ${k}`);
  assert.ok(!kinds.includes('standings'), 'standings segment sits out when standings are stale');
  assert.deepEqual(weekly.segments.map(s => s.id), weekly.segments.map((_, i) => `s${i + 1}`));
  const cardIds = weekly.segments.flatMap(s => s.cards.map(c => c.id));
  assert.equal(new Set(cardIds).size, cardIds.length, 'card ids are unique');
  for (const seg of weekly.segments) assert.ok(seg.cast.every(id => personaIds.includes(id)));

  const breaking = buildRundown({ type: 'breaking', phase: 'regular', show, personas, league, context, stories, breakingStories: stories.filter(S.isBreaking) });
  assert.deepEqual(breaking.segments.map(s => s.kind), ['breaking']);
  assert.ok(breaking.segments[0].cards.some(c => c.type === 'breaking'));
  assert.match(breaking.title, /^Breaking: /);

  const off = buildRundown({ type: 'special', phase: 'offseason', show, personas, league, context, stories });
  assert.equal(off.name, 'offseason');
  assert.ok(off.segments.some(s => s.kind === 'transactions'));
});

test('Game of the Week: the Hub names it; otherwise the segment is the Spotlight Game', async () => {
  const { league, batches } = await leagueWithBatches();
  const stories = batches[0].stories;
  const storiesById = Object.fromEntries(stories.map(s => [s.id, s]));
  const context = S.buildContext(league, {});
  const wk = context.focusWeek;
  const gotwSeg = r => r.segments.find(s => s.kind === 'game_of_week');

  const plain = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories });
  assert.equal(gotwSeg(plain).title, 'Spotlight Game', 'the league never self-selects a Game of the Week');
  assert.match(gotwSeg(plain).brief, /never call it that/);
  const script = writeTemplateScript({ rundown: plain, storiesById, personas, league, context });
  assert.doesNotMatch(JSON.stringify(script), /Game of the Week/i);

  // The Hub names the week's third game (teams in either order, any case).
  const g = L.gamesForWeek(league, wk.seasonIndex, wk.stage, wk.week)[2];
  const hub = normalizeHubFeed({ gamesOfTheWeek: [{ week: wk.week, away: league.teams[g.homeId].abbr.toLowerCase(), home: league.teams[g.awayId].abbr }] });
  const key = S.officialGotwKey(league, wk, hub);
  assert.equal(key, g.key);
  assert.equal(S.officialGotwKey(league, { ...wk, week: wk.week + 1 }, hub), null, 'another week has no pick');
  const named = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories: S.withOfficialGotw(stories, key) });
  assert.equal(gotwSeg(named).title, 'Game of the Week');
  assert.deepEqual(gotwSeg(named).storyIds, [`game:${g.key}`]);
  assert.ok(!storiesById[`game:${g.key}`].facts.flags.includes('game-of-the-week'), 'wire stories are not edited');
});

test('template writer produces valid scripts for every rundown type', async () => {
  const { league, batches } = await leagueWithBatches(secondBatch);
  const stories = [...batches[1].stories, ...batches[0].stories].sort((a, b) => b.score - a.score);
  const storiesById = Object.fromEntries(stories.map(s => [s.id, s]));
  const article = chronicleItem({ id: 'chronicle:1', title: 'The Bills Are Back', author: 'Red Ink', excerpt: 'Buffalo looked like a juggernaut. Nobody can stop them.' }, 'The Crimson Chronicle');
  storiesById[article.id] = article;
  const context = S.buildContext(league, {});
  const variants = [
    { type: 'weekly', phase: 'regular', chronicle: [article] },
    { type: 'breaking', phase: 'regular', breakingStories: stories.filter(S.isBreaking) },
    { type: 'special', phase: 'offseason' },
    { type: 'special', phase: 'preseason' },
    { type: 'special', phase: 'draft' },
    { type: 'custom', phase: 'regular', customKinds: ['cold_open', 'debate', 'signoff'], notes: 'Testing.' },
  ];
  for (const v of variants) {
    const rundown = buildRundown({ show, personas, league, context, stories, ...v });
    const script = writeTemplateScript({ rundown, storiesById, personas, league, context });
    const r = validateScript(script, { rundown, personaIds });
    assert.ok(r.ok, `${v.type}/${v.phase}: ${r.errors.join('; ')}`);
    assert.equal(r.script.segments.length, rundown.segments.length);
    if (v.chronicle) assert.ok(r.script.segments.find(s => s.kind === 'press_review').lines.some(l => /Crimson Chronicle/.test(l.text)));
    const countdown = r.script.segments.filter(s => s.lines.some(l => /^Number \d+: /.test(l.text))).map(s => s.kind);
    assert.ok(countdown.every(k => k === 'power_rankings'), `${v.type}/${v.phase}: the rankings countdown is read once, not in ${countdown}`);
  }
});

test('validator: errors block, warnings flag', () => {
  const rundown = {
    title: 'T', targetWords: 20,
    segments: [{ id: 's1', kind: 'cold_open', cast: ['hal', 'sasha'], cards: [{ id: 'c1', type: 'headline', data: {} }] }, { id: 's2', kind: 'signoff', cast: ['hal'], cards: [] }],
  };
  const good = { title: 'Ep', summary: 'x', tickerItems: [], memoryUpdates: { storylines: [], predictions: [], moods: [] },
    segments: [
      { id: 's1', lines: [{ speaker: 'hal', text: 'The Bills scored 49 points! *wow* 🎉', emotion: 'excited', gesture: 'none', shot: 'auto', card: 'c9' }] },
      { id: 's2', lines: [{ speaker: 'hal', text: 'Stay Hypnotical.', emotion: 'party', gesture: 'none', shot: 'auto', card: '' }] },
    ] };
  const r = validateScript(good, { rundown, personaIds, factNumbers: factNumberSet('Bills 24') });
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.script.segments[0].lines[0].text, 'The Bills scored 49 points! wow');
  assert.equal(r.script.segments[0].lines[0].card, '', 'unknown card cleared');
  assert.equal(r.script.segments[1].lines[0].emotion, 'neutral', 'unknown emotion defaulted');
  assert.ok(r.warnings.some(w => /49/.test(w)), 'unsupported number flagged');
  assert.ok(r.warnings.some(w => /unknown card/.test(w)));

  const bad = clone(good);
  bad.segments[0].lines[0].speaker = 'mystery';
  bad.segments.pop();
  bad.segments[0].lines.push({ speaker: 'sasha', text: 'Holy shit.', emotion: 'shocked', gesture: 'none', shot: 'auto', card: '' });
  const r2 = validateScript(bad, { rundown, personaIds });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => /unknown speaker/.test(e)));
  assert.ok(r2.errors.some(e => /s2 .*no lines/.test(e)));
  assert.ok(r2.errors.some(e => /profanity/.test(e)));
});

test('Claude writer: request shape, parsing, and one repair pass', async () => {
  const { league, batches } = await leagueWithBatches();
  const stories = batches[0].stories;
  const storiesById = Object.fromEntries(stories.map(s => [s.id, s]));
  const context = S.buildContext(league, {});
  const rundown = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories });
  const good = writeTemplateScript({ rundown, storiesById, personas, league, context });
  const broken = { ...clone(good), segments: good.segments.slice(1) };

  const requests = [];
  const replies = [broken, good];
  const fakeClient = {
    beta: { messages: { stream(req) {
      requests.push(req);
      const body = replies.shift();
      return {
        on() { return this; },
        finalMessage: async () => ({
          model: req.model, stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(body) }],
          usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
        }),
      };
    } } },
  };
  const writer = createClaudeWriter({ client: fakeClient, logger: quiet });
  assert.equal(writer.available(), true);
  const brief = P.episodeBrief({ rundown, storiesById, personas, memory: M.emptyMemory(personas) });
  const leagueText = P.leagueContext(league, context, { phase: 'regular' });
  const out = await writer.write({
    personas, leagueText, brief,
    validate: s => validateScript(s, { rundown, personaIds, factNumbers: factNumberSet(brief, leagueText) }),
  });
  assert.equal(requests.length, 2, 'invalid first draft triggers exactly one repair');
  assert.equal(out.repaired, true);
  assert.ok(out.result.ok);
  const req = requests[0];
  assert.equal(req.model, 'claude-sonnet-5-5', 'Sonnet 5.5 is the default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.output_config.effort, 'medium', 'Sonnet 5.5 writes a full show at medium');
  assert.equal(requests[1].model, 'claude-sonnet-5-5', 'the repair stays on the same model');
  const opts = { personas, leagueText, brief };
  assert.equal(writer.buildRequest({ ...opts, model: 'claude-sonnet-5-5', effort: effortFor('claude-sonnet-5-5', 'bulletin') }).output_config.effort, 'low');
  assert.equal(writer.buildRequest({ ...opts, model: 'claude-opus-5-5' }).output_config.effort, 'high');
  assert.equal(effortFor('claude-opus-5-5', 'bulletin'), 'medium');
  assert.equal(effortFor('claude-some-other-model', 'show'), 'high', 'unknown models get the Opus levels');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.output_config.format.schema.properties.segments.items.properties.lines.items.properties.speaker.enum, personaIds);
  assert.equal(req.system.length, 2);
  assert.ok(req.system.every(b => b.cache_control?.type === 'ephemeral' && b.cache_control.ttl === '1h'));
  assert.match(requests[1].messages[0].content, /YOUR PREVIOUS DRAFT HAD THESE PROBLEMS/);
  assert.equal(out.usage.length, 2);
  // Sonnet 5.5: $2 in, $10 out, 1h cache writes at 2x input.
  assert.ok(Math.abs(costOf(out.usage[0]) - (1000 * 2 + 2000 * 10 + 500 * 4) / 1e6) < 1e-9);
  assert.ok(Math.abs(costOf({ ...out.usage[0], model: 'claude-opus-5-5' }) - (1000 * 4 + 2000 * 20 + 500 * 8) / 1e6) < 1e-9);
});

test('Claude writer surfaces refusals instead of voicing nothing', async () => {
  const models = [];
  const fakeClient = { beta: { messages: { stream: req => { models.push(req.model); return { on() { return this; }, finalMessage: async () => ({ model: req.model, stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: {} }) }; } } } };
  const writer = createClaudeWriter({ client: fakeClient, logger: quiet });
  await assert.rejects(writer.write({ personas, leagueText: '', brief: '', validate: () => ({ ok: true }) }), /declined/);
  assert.deepEqual(models, ['claude-sonnet-5-5', 'claude-opus-5-5'], 'a Sonnet decline gets one try on Opus first');
});

test('a Sonnet 5.5 decline is rewritten on Opus 5.5, and the repair stays there', async () => {
  const { league, batches } = await leagueWithBatches();
  const stories = batches[0].stories;
  const storiesById = Object.fromEntries(stories.map(s => [s.id, s]));
  const context = S.buildContext(league, {});
  const rundown = buildRundown({ type: 'weekly', phase: 'regular', show, personas, league, context, stories });
  const good = writeTemplateScript({ rundown, storiesById, personas, league, context });
  const broken = { ...clone(good), segments: good.segments.slice(1) };
  const replies = [null, broken, good];
  const requests = [];
  const fakeClient = { beta: { messages: { stream(req) {
    requests.push(req);
    const body = replies.shift();
    return { on() { return this; }, finalMessage: async () => (body
      ? { model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }], usage: { input_tokens: 10, output_tokens: 10 } }
      : { model: req.model, stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }) };
  } } } };
  const writer = createClaudeWriter({ client: fakeClient, logger: quiet });
  const brief = P.episodeBrief({ rundown, storiesById, personas, memory: M.emptyMemory(personas) });
  const leagueText = P.leagueContext(league, context, { phase: 'regular' });
  const out = await writer.write({ personas, leagueText, brief, kind: 'bulletin', validate: s => validateScript(s, { rundown, personaIds }) });
  assert.ok(out.result.ok);
  assert.deepEqual(requests.map(r => [r.model, r.output_config.effort]), [['claude-sonnet-5-5', 'low'], ['claude-opus-5-5', 'medium'], ['claude-opus-5-5', 'medium']]);
  assert.equal(out.usage.length, 3, 'every request is costed, the declined one too');
  assert.equal(out.model, 'claude-opus-5-5');
});

test('show memory remembers predictions and storylines', () => {
  const mem = M.emptyMemory(personas);
  M.applyEpisode(mem, { id: 'ep1', title: 'Week 1' }, { summary: 'Bills rolled.', memoryUpdates: {
    predictions: [{ persona: 'ray', text: 'Bills win it all' }], storylines: [{ key: 'bills', text: 'Bills look unstoppable' }], moods: [{ persona: 'ray', mood: 'smug' }],
  } });
  const block = M.promptBlock(mem, personas);
  assert.match(block, /Ray: "Bills win it all"/);
  assert.match(block, /Bills look unstoppable/);
  assert.match(block, /Ray is smug/);
  assert.match(block, /Ray vs\. Nate/);
  M.resolvePrediction(mem, mem.predictions[0].id, 'wrong');
  assert.match(M.promptBlock(mem, personas), /WRONG/);
});
