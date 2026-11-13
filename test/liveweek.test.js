// The live channel shows between advances. The league advances every 72
// hours and members play their games in between; the live shows (The Wire,
// Morning Blitz, Stat Lab, Top Plays, HFL-NN Tonight's nightly edition,
// Grimley After Dark) cover those games as they come in, while the weekly
// show still airs as if the week had not started until all of it is final.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const L = require('../lib/league');
const S = require('../lib/stories');
const { dayKey, nextDay, wallToMs } = require('../lib/channel/clock');
const { blockAt } = require('../lib/channel/programme');
const { LIVE_NOTE } = require('../lib/channel/scheduler');
const { tmpDir } = require('./helpers');

const TZ = 'America/New_York';
const quiet = { log() {}, warn() {}, error() {} };
const DAY = nextDay(dayKey(Date.now(), TZ));
const at = (hhmm, day = DAY) => wallToMs(day, hhmm, TZ);

async function boot(settings = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false, autoBreaking: false, channelAuto: true, channelWriter: 'template', ...settings });
  const clock = { t: at('05:00') };
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet,
    debounceMs: 1e9, now: () => clock.t, claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
  });
  await ctx.loadSampleLeague();
  await ctx.producer.idle();
  const league = ctx.getLeague();
  const wk = L.currentWeek(league);   // Week 3: scheduled, nothing played yet
  const games = L.gamesForWeek(league, wk.seasonIndex, wk.stage, wk.week);
  // A member plays a game mid-week: the hourly export brings the final and
  // the box score.
  const play = (g, away, home, qb = null) => {
    Object.assign(g, { played: true, status: 'final', awayScore: away, homeScore: home });
    if (qb) {
      const p = Object.values(league.players).find(x => x.teamId === g.homeId && x.pos === 'QB' && !x.departed);
      const key = L.weekKey(wk.seasonIndex, wk.stage, wk.week);
      league.stats[key] ||= {};
      (league.stats[key].passing ||= []).push({ rosterId: p.rosterId, fullName: p.name, teamId: g.homeId, scheduleId: g.scheduleId, passAtt: 41, passComp: 29, passYds: 412, passTDs: 5, passInts: 0 });
      return p;
    }
    return null;
  };
  const run = async () => { await ctx.producer.idle(); await ctx.producer.idle(); };
  return { ctx, clock, league, wk, games, play, run, close: () => ctx.close() };
}

test('live week: games played before the advance become stories, with the ids the weekly will use', async () => {
  const s = await boot();
  try {
    assert.deepEqual(S.liveWeekStories(s.league).filter(x => x.week?.week === 3), [], 'nothing played yet');
    const qb = s.play(s.games[0], 17, 38, true);
    s.play(s.games[1], 24, 21);
    const live = S.liveWeekStories(s.league);
    const games = live.filter(x => x.type === 'game');
    assert.deepEqual(games.map(x => x.id).sort(), [`game:${s.games[0].key}`, `game:${s.games[1].key}`].sort());
    assert.ok(live.every(x => x.live && x.week.week === 3));
    assert.ok(live.some(x => x.type === 'performance' && x.facts.player === qb.name), 'a big game makes a performance story');

    // The context knows the week is still going.
    const ctx = S.buildContext(s.league, { focusWeek: s.wk });
    assert.equal(ctx.inProgress, true);
    assert.deepEqual(ctx.weekProgress, { played: 2, total: 16 });
    assert.match(ctx.scoreboard.data.label || JSON.stringify(ctx.scoreboard.data), /SO FAR/);
    assert.equal(ctx.nextWeek.stillToPlay, true);
    assert.equal(ctx.nextWeek.games.length, 14);
    assert.ok(ctx.nextWeek.games.every(g => !g.played));

    // The weekly show still airs as if Week 3 had not started.
    const weekly = s.ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
    await s.run();
    const ep = s.ctx.producer.get(weekly.id);
    assert.equal(ep.rundown.asOf.week, 3);
    assert.ok(!ep.rundown.storyIds.some(id => games.some(g => g.id === id)), 'no Week 3 result in the weekly');
  } finally { await s.close(); }
});

test('live week: The Wire runs three editions a day, each on the games since the last one', async () => {
  const s = await boot();
  try {
    s.play(s.games[0], 17, 38, true);
    s.play(s.games[1], 24, 21);

    s.clock.t = at('08:30');
    const first = s.ctx.scheduler.tick();
    assert.equal(first.edition, `${DAY}:wire@09:00`);
    await s.run();
    let ep = s.ctx.producer.get(first.made);
    assert.equal(ep.status, 'published', ep.error || '');
    assert.equal(ep.rundown.asOf, null, 'a live show sees the week being played');
    assert.equal(ep.notes, LIVE_NOTE);
    const recaps = ep.rundown.segments.filter(x => x.kind === 'game_recap');
    assert.deepEqual(recaps.map(x => x.storyIds[0]).sort(), [`game:${s.games[0].key}`, `game:${s.games[1].key}`].sort());
    assert.match(recaps[0].brief, /never describe a play/);
    assert.match(recaps[0].lowerThird, /^FINAL: /);
    const board = ep.rundown.segments.find(x => x.kind === 'scoreboard');
    assert.match(board.brief, /2 of 16 games are final/);
    // Stretched toward five minutes.
    assert.ok(ep.rundown.targetWords >= 600, `${ep.rundown.targetWords} words`);
    assert.equal(ep.channelShow, 'wire');

    // Another game comes in during the day; the 5 PM edition leads with it alone.
    const late = s.games[2];
    s.play(late, 31, 30);
    s.clock.t = at('16:45');
    const second = s.ctx.scheduler.tick();
    assert.equal(second.edition, `${DAY}:wire@17:00`);
    await s.run();
    ep = s.ctx.producer.get(second.made);
    assert.deepEqual(ep.rundown.segments.filter(x => x.kind === 'game_recap').map(x => x.storyIds[0]), [`game:${late.key}`]);
    assert.ok(s.ctx.scheduler.status().shows.filter(x => x.key === 'wire' && x.today.state === 'made').length === 2);
  } finally { await s.close(); }
});

test('live week: Morning Blitz and Stat Lab run long, with the rest of the week and the stat leaders', async () => {
  const s = await boot();
  try {
    s.play(s.games[0], 17, 38, true);
    s.play(s.games[1], 24, 21);
    s.clock.t = at('06:20');
    const blitz = s.ctx.scheduler.tick();
    assert.equal(blitz.show, 'blitz');
    await s.run();
    let ep = s.ctx.producer.get(blitz.made);
    const kinds = ep.rundown.segments.map(x => x.kind);
    assert.ok(kinds.includes('slate'), kinds.join(','));
    const slate = ep.rundown.segments.find(x => x.kind === 'slate');
    assert.equal(slate.title, 'Still to Play');
    assert.match(slate.brief, /never state or hint at a result/);
    assert.ok(ep.rundown.targetWords >= 1500, `Morning Blitz aims long: ${ep.rundown.targetWords} words`);

    s.clock.t = at('12:20');
    const lab = s.ctx.scheduler.tick();
    assert.equal(lab.show, 'statlab');
    await s.run();
    ep = s.ctx.producer.get(lab.made);
    const best = ep.rundown.segments.find(x => x.kind === 'best_lines');
    assert.ok(best && best.storyIds.some(id => id.startsWith('perf:')), 'the 412-yard game is counted down');
    assert.ok(ep.rundown.segments.some(x => x.kind === 'season_leaders'));
  } finally { await s.close(); }
});

test('live week: HFL-NN Tonight makes a nightly edition, but not on the night the weekly show is new', async () => {
  const s = await boot();
  try {
    s.play(s.games[0], 17, 38, true);
    s.clock.t = at('19:30');
    const night = s.ctx.scheduler.tick();
    assert.equal(night.show, 'tonight');
    await s.run();
    const ep = s.ctx.producer.get(night.made);
    assert.equal(ep.title, 'HFL-NN Tonight');
    assert.ok(ep.rundown.targetWords >= 1900, `${ep.rundown.targetWords} words`);
    // It leads the 8 PM slot; the newest weekly follows it in the same slot.
    const blocks = s.ctx.channel.blocksFor(DAY);
    assert.equal(blockAt(blocks, at('20:00')).episodeId, ep.id);
  } finally { await s.close(); }

  // The weekly came out today: the nightly edition stands aside.
  const t = await boot();
  try {
    const today = dayKey(Date.now(), TZ);
    const weekly = t.ctx.producer.createEpisode({ type: 'weekly', writer: 'template', chain: { voice: true, publish: true } });
    await t.run();
    assert.equal(t.ctx.producer.get(weekly.id).status, 'published');
    t.play(t.games[0], 17, 38);
    t.clock.t = at('19:30', today);
    assert.equal(t.ctx.scheduler.tick().made, null);
    const row = t.ctx.scheduler.status().shows.find(x => x.key === 'tonight');
    assert.match(row.today.reason, /is new tonight/);
  } finally { await t.close(); }
});

test('live week: The Wire stands aside when no new result has come in since the last edition', async () => {
  const s = await boot();
  try {
    s.play(s.games[0], 17, 38);
    s.clock.t = at('08:30');
    assert.equal(s.ctx.scheduler.tick().edition, `${DAY}:wire@09:00`);
    await s.run();
    s.clock.t = at('16:45');
    assert.equal(s.ctx.scheduler.tick().made, null);
    const row = s.ctx.scheduler.status().shows.find(x => x.edition === `${DAY}:wire@17:00`);
    assert.match(row.today.reason, /nothing new \(0 new results, needs 1\)/);
  } finally { await s.close(); }
});
