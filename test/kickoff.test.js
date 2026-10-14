'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const L = require('../lib/league');
const S = require('../lib/stories');
const { buildRundown } = require('../lib/rundown');
const { kickoffStories, seasonLabel, roman } = require('../lib/kickoff');
const { previewStories } = require('../lib/preview');
const { writeTemplateScript } = require('../lib/writer/template');
const { validateScript, factNumberSet } = require('../lib/writer/validate');
const { prepareSpeech } = require('../lib/tts/textprep');
const P = require('../lib/writer/prompt');
const M = require('../lib/memory');
const { createStore } = require('../lib/store');
const { createMaddenIngest } = require('../lib/ingest/madden');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const personas = require('../config/personas.json');
const show = require('../config/show.json');
const { fixture, tmpDir, clone } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const personaIds = personas.anchors.map(a => a.id);
const ok = (key, list) => ({ success: true, message: 'test', [key]: list });
const WEEK1 = { seasonIndex: 1, stage: 'reg', week: 1 };

// Standings rows for `games` (played ones only), the way Madden exports them.
function standingsFor(teams, games, weekIndex) {
  const div = Object.fromEntries(teams.map(t => [t.teamId, t.divName]));
  const rec = Object.fromEntries(teams.map(t => [t.teamId, { w: 0, l: 0, pf: 0, pa: 0, dw: 0, dl: 0, cw: 0, cl: 0, last: 0 }]));
  for (const g of games.filter(x => x.status > 1)) {
    const sides = [[g.homeTeamId, g.homeScore, g.awayTeamId, g.awayScore], [g.awayTeamId, g.awayScore, g.homeTeamId, g.homeScore]];
    for (const [id, us, opp, them] of sides) {
      const r = rec[id];
      const won = us > them;
      r.pf += us; r.pa += them; r[won ? 'w' : 'l']++; r.last = won ? 1 : -1;
      if (div[id] === div[opp]) r[won ? 'dw' : 'dl']++;
      if (div[id].split(' ')[0] === div[opp].split(' ')[0]) r[won ? 'cw' : 'cl']++;
    }
  }
  return teams.map((t, i) => {
    const r = rec[t.teamId];
    const gp = r.w + r.l;
    return {
      teamId: t.teamId, totalWins: r.w, totalLosses: r.l, totalTies: 0, winPct: gp ? r.w / gp : 0, rank: i + 1, prevRank: i + 1,
      seed: 0, playoffStatus: 0, winLossStreak: r.last < 0 ? 255 : r.last, divisionName: t.divName, conferenceName: t.divName.split(' ')[0],
      netPts: r.pf - r.pa, ptsFor: gp ? r.pf / gp : 0, ptsAgainst: gp ? r.pa / gp : 0, divWins: r.dw, divLosses: r.dl, confWins: r.cw, confLosses: r.cl,
      teamOvr: t.ovrRating, seasonIndex: 1, stageIndex: 1, weekIndex, calendarYear: 2026,
    };
  });
}

// Two exports: the morning after the advance to Week 1 (preseason finished,
// nothing played yet) and two days later, with half of Week 1 played, a star
// hurt in one of those games and a veteran cut.
function kickoffPayloads() {
  const teams = fixture('leagueteams').leagueTeamInfoList;
  const week1 = fixture('week-reg-1-schedules').gameScheduleInfoList;
  const rosters = fixture('rosters');
  const fa = fixture('freeagents');
  const unplayed = week1.map(g => ({ ...g, homeScore: 0, awayScore: 0, status: 1 }));
  const preseason = [1, 2, 3].flatMap(w => week1.map((g, i) => {
    const home = 10 + ((i * 7 + w * 5) % 24), away = 10 + ((i * 11 + w * 3) % 21);
    const [hs, as] = home === away ? [home + 3, away] : [home, away];
    return { ...g, scheduleId: 900000 + w * 100 + i, stageIndex: 0, weekIndex: w - 1, homeScore: hs, awayScore: as, status: hs > as ? 3 : 2 };
  }));
  const prePassing = clone(fixture('week-reg-1-passing'));
  for (const r of prePassing.playerPassingStatInfoList) Object.assign(r, { stageIndex: 0, weekIndex: 2, scheduleId: 900300 });

  const tag = p => ({ platform: 'pc', leagueId: '2890093', source: 'test', ...p });
  const batchA = [
    { kind: 'teams', body: fixture('leagueteams') },
    { kind: 'standings', body: ok('teamStandingInfoList', standingsFor(teams, [], 0)) },
    ...[1, 2, 3].map(w => ({ kind: 'week', stage: 'pre', week: w, statKind: 'schedules', body: ok('gameScheduleInfoList', preseason.filter(g => g.weekIndex === w - 1)) })),
    { kind: 'week', stage: 'pre', week: 3, statKind: 'passing', body: prePassing },
    { kind: 'week', stage: 'reg', week: 1, statKind: 'schedules', body: ok('gameScheduleInfoList', unplayed) },
    ...Object.entries(rosters).map(([teamId, body]) => ({ kind: 'roster', teamId: Number(teamId), body })),
    { kind: 'freeagents', body: fa },
  ].map(tag);

  // Half of Week 1 is final.
  const midweek = week1.map((g, i) => (i < 8 ? g : unplayed[i]));
  const playedTeams = new Set(midweek.filter(g => g.status > 1).flatMap(g => [g.homeTeamId, g.awayTeamId]));
  const ids = Object.keys(rosters).map(Number);
  const hurtTeam = ids.find(id => playedTeams.has(id));
  const cutTeam = ids.find(id => id !== hurtTeam);
  const hurtRoster = clone(rosters[hurtTeam]);
  const star = hurtRoster.rosterInfoList.filter(p => !p.injuryLength).sort((a, b) => b.playerBestOvr - a.playerBestOvr)[0];
  star.injuryLength = 5;
  const cutRoster = clone(rosters[cutTeam]);
  const vet = cutRoster.rosterInfoList.filter(p => p.playerBestOvr >= 75).sort((a, b) => b.playerBestOvr - a.playerBestOvr)[0];
  cutRoster.rosterInfoList = cutRoster.rosterInfoList.filter(p => p !== vet);
  const fa2 = clone(fa);
  fa2.rosterInfoList.unshift({ ...vet, teamId: 0, isFreeAgent: true });
  const batchB = [
    { kind: 'standings', body: ok('teamStandingInfoList', standingsFor(teams, midweek, 0)) },
    { kind: 'week', stage: 'reg', week: 1, statKind: 'schedules', body: ok('gameScheduleInfoList', midweek) },
    { kind: 'week', stage: 'reg', week: 1, statKind: 'passing', body: fixture('week-reg-1-passing') },
    { kind: 'roster', teamId: hurtTeam, body: hurtRoster },
    { kind: 'roster', teamId: cutTeam, body: cutRoster },
    { kind: 'freeagents', body: fa2 },
  ].map(tag);
  const playedGame = midweek[0];
  return { batchA, batchB, star, vet, playedGame };
}

async function kickoffLeague() {
  const store = createStore(tmpDir());
  const league = L.emptyLeague();
  const batches = [];
  const ingest = createMaddenIngest({
    store, getLeague: () => league, saveLeague: () => {}, debounceMs: 1e9, logger: quiet,
    onBatchComplete: async x => batches.push({ ...x, stories: S.detectStories(x) }),
  });
  const p = kickoffPayloads();
  for (const x of p.batchA) ingest.ingest(x);
  await ingest.flush();
  for (const x of p.batchB) ingest.ingest(x);
  await ingest.flush();
  return { store, league, ingest, batches, ...p };
}

test('beforeWeek: the league as it stood when Week 1 kicked off', async () => {
  const { league, ingest, batches, star, playedGame } = await kickoffLeague();
  const starKey = L.playerKey(star);
  assert.equal(L.gamesForWeek(league, 1, 'reg', 1).filter(g => g.played).length, 8, 'the live league has half of Week 1');
  assert.deepEqual(L.currentWeek(league), WEEK1, 'Week 1 is the week being played');
  const liveRecord = L.recordOf(league, playedGame.homeTeamId);
  assert.match(liveRecord, /^[01]-[01]$/);
  assert.notEqual(liveRecord, '0-0');

  // No baseline: the results are taken back out of the standings.
  const view = L.beforeWeek(league, WEEK1);
  assert.notEqual(view, league);
  assert.equal(view.asOf.hiddenGames, 8);
  assert.ok(L.gamesForWeek(view, 1, 'reg', 1).every(g => !g.played && g.homeScore === 0 && g.awayScore === 0));
  assert.equal(view.stats['1-reg-1'], undefined, 'Week 1 box scores are gone');
  assert.ok(view.stats['1-pre-3'], 'preseason box scores stay');
  for (const s of Object.values(view.standings)) {
    assert.deepEqual([s.w, s.l, s.t, s.divW, s.divL, s.confW, s.confL, s.streak, s.netPts], [0, 0, 0, 0, 0, 0, 0, 0, 0], `team ${s.teamId} is back to 0-0`);
  }
  assert.notEqual(view.standingsFresh, false);
  assert.equal(L.recordOf(league, playedGame.homeTeamId), liveRecord, 'the live league is untouched');
  assert.ok(L.gamesForWeek(league, 1, 'reg', 1).some(g => g.played));
  assert.deepEqual(L.lastCompleteWeek(view), { seasonIndex: 1, stage: 'pre', week: 3 });

  // With the snapshot from before kickoff, the star hurt in Week 1 is healthy.
  assert.equal(league.players[starKey].injury, 5);
  assert.equal(view.players[starKey].injury, 5, 'without a baseline, injuries are as exported');
  const base = ingest.baselineBefore(WEEK1);
  assert.equal(base.batchId, batches[0].batch.id);
  assert.deepEqual(base.laterBatches, [batches[1].batch.id]);
  const asOf = L.beforeWeek(league, WEEK1, { baseline: base.snapshot });
  assert.equal(asOf.players[starKey].injury, 0);
  assert.equal(league.players[starKey].injury, 5, 'the live league keeps the injury');
  // A snapshot from before the advance has the preseason table: rewind instead.
  const preTable = Object.fromEntries(Object.entries(base.snapshot.standings).map(([k, s]) => [k, { ...s, stage: 'pre', w: 2 }]));
  const fromPre = L.beforeWeek(league, WEEK1, { baseline: { ...base.snapshot, standings: preTable } });
  assert.ok(Object.values(fromPre.standings).every(s => s.stage === 'reg' && s.w === 0 && s.l === 0));

  // Standings that don't add up to the games are left off, not guessed.
  const stale = { ...league, standings: Object.fromEntries(Object.entries(league.standings).map(([k, s]) => [k, { ...s, w: s.w + 3 }])) };
  assert.equal(L.beforeWeek(stale, WEEK1).standingsFresh, false);
  // Nothing to hide: the league itself.
  assert.equal(L.beforeWeek(league, { seasonIndex: 1, stage: 'reg', week: 2 }), league);
  assert.equal(L.beforeWeek(league, null), league);
});

test('kickoff stories and rundown: preseason, cut day, the Week 1 slate, and no Week 1 results', async () => {
  const { store, league, ingest, batches, vet } = await kickoffLeague();
  const base = ingest.baselineBefore(WEEK1);
  const view = L.beforeWeek(league, WEEK1, { baseline: base.snapshot });
  const wire = batches.flatMap(b => b.stories);
  const stories = kickoffStories(view, { wire });
  const byType = Object.fromEntries(stories.map(s => [s.type, s]));
  for (const t of ['preseason_recap', 'cutdown', 'slate']) assert.ok(byType[t], `a ${t} story`);

  const pre = byType.preseason_recap.facts;
  assert.equal(pre.gamesPlayed, 48);
  assert.equal(pre.preseasonWeeks, 3);
  assert.ok(pre.statLeaders.passingYards.length, 'preseason stat leaders');
  assert.match(pre.note, /exhibitions/);

  const cuts = byType.cutdown.facts;
  assert.equal(cuts.releasedStillUnsigned[0].name, `${vet.firstName} ${vet.lastName}`, 'the veteran cut leads cut day');
  assert.ok(cuts.bestAvailableFreeAgents.length);
  assert.deepEqual(byType.cutdown.covers, wire.filter(s => s.type === 'release').map(s => s.id));

  const slate = byType.slate;
  assert.equal(slate.facts.games.length, 16, 'the whole Week 1 slate');
  assert.equal(slate.facts.gameOfTheWeek, null, 'the league named no Game of the Week');
  assert.ok(slate.facts.spotlight);
  assert.doesNotMatch(JSON.stringify(slate.facts), /score/i, 'nothing about how a game went');
  assert.ok(slate.card.data.games.every(g => g.away.score == null && g.home.score == null && !g.final));
  assert.equal(slate.card.data.right, 'KICKOFF');

  // The Hub names Week 1's Game of the Week.
  const g = L.gamesForWeek(view, 1, 'reg', 1)[5];
  const hub = { league: { season: 9 }, gamesOfTheWeek: [{ stage: 'reg', week: 1, away: league.teams[g.awayId].abbr, home: league.teams[g.homeId].abbr }] };
  const named = kickoffStories(view, { wire, hub }).find(s => s.type === 'slate');
  assert.equal(named.facts.gameOfTheWeek.home.abbr, league.teams[g.homeId].abbr);
  assert.equal(named.facts.games[0].home.abbr, league.teams[g.homeId].abbr, 'the Game of the Week leads the slate');

  // The rundown and a template script.
  const all = [...stories, ...previewStories(view).filter(s => s.type !== 'talent'), ...wire.filter(s => s.type === 'release')];
  const context = { ...S.buildContext(view, {}), season: seasonLabel({}, hub) };
  const asOf = { ...WEEK1, label: 'Week 1', hiddenGames: 8 };
  const rundown = buildRundown({ type: 'kickoff', phase: 'regular', show, personas, league: view, context, stories: all, asOf });
  assert.equal(rundown.name, 'kickoff');
  assert.equal(rundown.title, 'HFL-NN Season IX Kickoff');
  assert.equal(rundown.weekLabel, 'Week 1 Kickoff');
  const kinds = rundown.segments.map(s => s.kind);
  for (const k of ['cold_open', 'preseason_recap', 'final_cuts', 'division_preview', 'power_rankings', 'kickoff_slate', 'debate', 'predictions', 'conspiracy_corner', 'signoff']) assert.ok(kinds.includes(k), `kickoff has ${k}`);
  for (const k of ['scoreboard', 'game_of_week', 'meet_the_desk', 'preview']) assert.ok(!kinds.includes(k), `no ${k}`);
  assert.ok(!rundown.segments.find(s => s.kind === 'transactions')?.storyIds.some(id => id.startsWith('release:')), 'The Wire does not repeat cut day');
  const minutes = rundown.targetWords / show.wordsPerSecond / 60;
  assert.ok(minutes >= 7 && minutes <= 11, `a kickoff runs 7 to 11 minutes (${minutes.toFixed(1)})`);

  const storiesById = Object.fromEntries(all.map(s => [s.id, s]));
  const leagueText = P.leagueContext(view, context, { phase: 'regular', asOf });
  assert.match(leagueText, /as of the start of Week 1: no Week 1 game has been played/);
  const brief = P.episodeBrief({ rundown, storiesById, personas, memory: M.loadMemory(store, personas) });
  assert.match(brief, /airs before Week 1 kicks off/);
  assert.match(brief, /Season IX, the league's season 9/);
  const played = L.gamesForWeek(league, 1, 'reg', 1).filter(x => x.played);
  for (const x of played) {
    const score = new RegExp(`\\b${x.homeScore}-${x.awayScore}\\b|\\b${x.awayScore}-${x.homeScore}\\b`);
    assert.doesNotMatch(leagueText + JSON.stringify(all), score, 'no Week 1 score reaches the writers');
  }

  const factNumbers = factNumberSet(brief, leagueText, JSON.stringify(all));
  const checked = validateScript(writeTemplateScript({ rundown, storiesById, personas, league: view, context }), { rundown, personaIds, factNumbers });
  assert.ok(checked.ok, checked.errors.join('; '));
  assert.ok(!checked.warnings.some(w => /aren't in the facts/.test(w)), checked.warnings.join('; '));
  const text = kind => checked.script.segments.find(s => s.kind === kind).lines.map(l => l.text).join(' ');
  assert.match(text('cold_open'), /Season IX kickoff special/);
  assert.match(text('final_cuts'), new RegExp(vet.lastName));
  assert.match(text('kickoff_slate'), /Spotlight Game|Game of the Week/);
  assert.ok(checked.script.memoryUpdates.predictions.some(p => /Week 1/.test(p.text)), 'slate picks are saved');
  assert.doesNotMatch(JSON.stringify(checked.script), /\b0-0\b/, 'no 0-0 records read aloud');
});

test('season numbers: Settings, then the Hub; spoken as a number', () => {
  assert.equal(roman(9), 'IX');
  assert.equal(roman(14), 'XIV');
  assert.equal(roman(2026), null);
  assert.deepEqual(seasonLabel({ seasonNumber: 9 }), { number: 9, label: 'Season IX' });
  assert.deepEqual(seasonLabel({}, { league: { season: 9 } }), { number: 9, label: 'Season IX' });
  assert.equal(seasonLabel({}, { league: { season: 2026 } }), null, 'a calendar year is not a season number');
  assert.equal(prepareSpeech('Welcome to the Season IX kickoff.'), 'Welcome to the Season 9 kickoff.');
});

test('control room: a Season IX kickoff made mid-Week 1 ignores Week 1, and so does the weekly show', async () => {
  const ctx = createApp({
    dataDir: tmpDir(),
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000,
    logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  try {
    ctx.settings.update({ autoProduce: false, autoBreaking: false, seasonNumber: 9 });
    const p = kickoffPayloads();
    for (const x of p.batchA) ctx.ingest.ingest(x);
    const a = await ctx.ingest.flush();
    for (const x of p.batchB) ctx.ingest.ingest(x);
    await ctx.ingest.flush();
    const injury = ctx.producer.wireStories().find(s => s.type === 'injury');
    assert.ok(injury, 'the Week 1 injury is on the wire');
    assert.ok(ctx.producer.wireStories().some(s => s.type === 'release'), 'so is the cut');

    const ep = ctx.producer.createEpisode({ type: 'kickoff', writer: 'template' });
    await ctx.producer.idle();
    const k = ctx.producer.get(ep.id);
    assert.equal(k.status, 'draft', JSON.stringify(k.validation));
    assert.equal(k.title, 'HFL-NN Season IX Kickoff');
    assert.deepEqual({ ...k.rundown.asOf }, { ...WEEK1, label: 'Week 1', hiddenGames: 8, baselineBatch: a.id });
    assert.ok(!k.stories[injury.id], 'an injury from a Week 1 game is not news yet');
    const kinds = k.rundown.segments.map(s => s.kind);
    for (const kind of ['preseason_recap', 'final_cuts', 'kickoff_slate']) assert.ok(kinds.includes(kind), kind);
    const inj = k.rundown.segments.find(s => s.kind === 'injuries');
    assert.ok(!inj || !JSON.stringify(inj.cards).includes(`${p.star.firstName} ${p.star.lastName}`), 'the injury report is from before kickoff');
    assert.ok(!k.validation.warnings.some(w => /aren't in the facts/.test(w)), k.validation.warnings.join('; '));

    // The general rule: any show made now airs as if Week 1 hadn't started.
    const weekly = ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
    await ctx.producer.idle();
    const w = ctx.producer.get(weekly.id);
    assert.equal(w.rundown.asOf.week, 1);
    assert.equal(w.rundown.asOf.hiddenGames, 8);
    assert.ok(!w.stories[injury.id]);
    assert.ok(!JSON.stringify(w.stories).includes('"stage":"reg","week":1'), 'no Week 1 game stories');
    // Rewriting later keeps the same cutoff.
    await ctx.producer.writeScript(weekly.id, { writer: 'template' });
    assert.equal(ctx.producer.get(weekly.id).status, 'draft');
  } finally {
    server.close();
    await ctx.close();
  }
});
