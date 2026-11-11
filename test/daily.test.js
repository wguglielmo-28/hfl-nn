// The channel's daily shows (lib/channel/scheduler.js): off until switched
// on, made once a day in the run-up to their slot, only with news the show
// has not covered, only inside the daily spending cap, and without taking
// anything away from the weekly show.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { dayKey, nextDay, wallToMs } = require('../lib/channel/clock');
const { blockAt } = require('../lib/channel/programme');
const { tmpDir } = require('./helpers');

const TZ = 'America/New_York';
const quiet = { log() {}, warn() {}, error() {} };
// Tomorrow, so the sample league's stories (stamped now) are already on the wire.
const DAY = nextDay(dayKey(Date.now(), TZ));
const at = (hhmm, day = DAY) => wallToMs(day, hhmm, TZ);

async function boot(settings = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false, autoBreaking: false, ...settings });
  const clock = { t: at('05:00') };
  let claudeCalls = 0;
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), logger: quiet, debounceMs: 60 * 60 * 1000, now: () => clock.t,
    claude: { available: () => false, model: 'none', write: async () => { claudeCalls++; throw new Error('no'); } },
  });
  await ctx.loadSampleLeague();
  await ctx.producer.idle();
  return { ctx, clock, claudeCalls: () => claudeCalls, close: () => ctx.close() };
}

test('daily shows: nothing is made until the commissioner switches them on', async () => {
  const s = await boot();
  try {
    assert.equal(s.ctx.settings.get().channelAuto, false);
    assert.equal(s.ctx.settings.get().dailyCapUsd, 2);
    s.clock.t = at('06:30');
    assert.deepEqual(s.ctx.scheduler.tick(), { made: null, reason: 'off' });
    assert.equal(s.ctx.producer.list().length, 0);
    const st = s.ctx.scheduler.status();
    assert.deepEqual([st.auto, st.spent, st.cap, st.left], [false, 0, 2, 2]);
    assert.deepEqual(st.shows.map(x => x.key), ['blitz', 'statlab', 'afterdark']);
  } finally { await s.close(); }
});

test('daily shows: Morning Blitz is made once, in the run-up to its slot, and airs there', async () => {
  const s = await boot({ channelAuto: true, channelWriter: 'template' });
  try {
    const { ctx, clock } = s;
    assert.equal(ctx.scheduler.tick().reason, 'nothing due', 'two hours early is too early');
    clock.t = at('07:05');
    assert.equal(ctx.scheduler.tick().reason, 'nothing due', 'a missed window is not made up late');

    clock.t = at('06:20');
    const made = ctx.scheduler.tick();
    assert.equal(made.show, 'blitz');
    assert.equal(ctx.scheduler.tick().reason, 'busy', 'one job at a time');
    await ctx.producer.idle();   // written, then voiced, then published
    await ctx.producer.idle();
    const ep = ctx.producer.get(made.made);
    assert.equal(ep.status, 'published', ep.error || '');
    assert.deepEqual([ep.type, ep.channelShow, ep.channelDay, ep.voiceEngine, ep.auto, ep.writer.kind], ['custom', 'blitz', DAY, 'kokoro', true, 'template']);
    assert.ok(ep.rundown.segments.length >= 3 && ep.rundown.storyIds.length >= 2);
    assert.equal(ctx.producer.list().find(e => e.id === ep.id).channelShow, 'blitz');

    // A side show: the wire, the show's memory and Discord are left alone.
    assert.ok(ctx.producer.wireStories().every(st => !st.usedIn.includes(ep.id)), 'no story is used up');
    assert.ok(!ep.memoryApplied && !ep.discordPostedAt);

    // Once a day: nothing more for this show, however often it is asked.
    assert.equal(ctx.scheduler.tick().reason, 'nothing due');
    assert.equal(ctx.producer.list().length, 1);
    const blocksBefore = ctx.channel.blocksFor(DAY);

    // It leads its 7:00 slot and its 9:30 re-air, and never passes for the flagship.
    const blocks = blocksBefore;
    const seven = blockAt(blocks, at('07:00'));
    assert.deepEqual([seven.kind, seven.show, seven.episodeId], ['episode', 'blitz', ep.id]);
    assert.deepEqual([blockAt(blocks, at('09:30')).show, blockAt(blocks, at('09:30')).episodeId, blockAt(blocks, at('09:30')).rerun], ['blitz', ep.id, true]);
    assert.ok(blocks.filter(b => b.episodeId === ep.id).every(b => b.show === 'blitz' || b.show === 'vault'));
    // Three days on it has gone stale and is off the schedule altogether.
    assert.ok(ctx.channel.blocksFor(nextDay(DAY, 4)).every(b => b.episodeId !== ep.id));

    // The public episode list says which show it is, so the Hub can file it as a daily.
    const server = require('http').createServer(ctx.app);
    await new Promise(r => server.listen(0, r));
    try {
      const weekly = ctx.producer.createEpisode({ type: 'weekly', writer: 'template', chain: { voice: true, publish: true } });
      await ctx.producer.idle(); await ctx.producer.idle();
      const list = await (await fetch(`http://127.0.0.1:${server.address().port}/api/episodes`)).json();
      assert.equal(list.find(e => e.id === ep.id).show, 'blitz');
      assert.equal(list.find(e => e.id === weekly.id).show, null);
    } finally { server.close(); }

    const st = ctx.scheduler.status();
    assert.equal(st.shows[0].made.episodeId, ep.id);
    assert.equal(st.log[0].outcome, 'started');
    assert.equal(st.spent, 0, 'the template writer costs nothing');
    assert.equal(ctx.producer.list().length, 2);
  } finally { await s.close(); }
});

test('daily shows: a show only goes out with news it has not covered', async () => {
  const s = await boot({ channelAuto: true, channelWriter: 'template' });
  try {
    const { ctx, clock } = s;
    const seen = new Set();
    let skipped = null;
    for (let d = 0; d < 9 && !skipped; d++) {
      const day = nextDay(DAY, d);
      clock.t = at('06:20', day);
      const r = ctx.scheduler.tick();
      if (!r.made) { skipped = ctx.scheduler.status().log[0]; break; }
      await ctx.producer.idle(); await ctx.producer.idle();
      for (const id of ctx.producer.get(r.made).rundown.storyIds) {
        if (ctx.producer.wireStories().some(w => w.id === id)) { assert.ok(!seen.has(id), `story ${id} aired twice on the same show`); seen.add(id); }
      }
    }
    assert.ok(seen.size >= 2);
    assert.ok(skipped, 'the wire runs dry');
    assert.equal(skipped.outcome, 'skipped');
    assert.match(skipped.reason, /nothing new/);
    // Another show has its own record of what it covered.
    assert.ok(ctx.scheduler.freshStories('afterdark', at('06:20'), 8).length >= 2);  } finally { await s.close(); }
});

test('daily shows: the daily cap stops a paid show before a single token is spent', async () => {
  const s = await boot({ channelAuto: true, channelWriter: 'claude', dailyCapUsd: 0.2 });
  try {
    const { ctx, clock } = s;
    // Today, so what is "spent" below falls inside the day being budgeted.
    clock.t = at('06:20', dayKey(Date.now(), TZ));
    assert.equal(ctx.scheduler.tick().made, null);
    assert.match(ctx.scheduler.status().log[0].reason, /daily cap: \$0\.00 spent of \$0\.20, this show is about \$0\.25/);
    assert.equal(s.claudeCalls(), 0);
    assert.equal(ctx.producer.list().length, 0);

    // Money already spent today counts, whatever it was spent on.
    ctx.settings.update({ dailyCapUsd: 1, channelWriter: 'template' });
    const other = ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
    await ctx.producer.idle();
    const file = `episodes/${other.id}/episode.json`;
    const ep = ctx.store.readJSON(file);
    ep.writer = { kind: 'claude', costUsd: 0.6, at: new Date(clock.t - 3600000).toISOString(), history: [{ kind: 'claude', costUsd: 0.3, at: new Date(clock.t - 7200000).toISOString() }, { kind: 'claude', costUsd: 5, at: new Date(clock.t - 3 * 86400000).toISOString() }] };
    ctx.store.writeJSON(file, ep);
    const b = ctx.scheduler.budget(clock.t);
    assert.deepEqual([b.spent, b.cap, b.left], [0.9, 1, 0.1], "today's draft and rewrite count; last week's does not");

    ctx.settings.update({ channelWriter: 'claude' });
    assert.equal(ctx.scheduler.tick().made, null);
    assert.match(ctx.scheduler.status().log[0].reason, /\$0\.90 spent of \$1\.00/);
    // Raising the cap inside the window lets the show through.
    ctx.settings.update({ dailyCapUsd: 3, channelWriter: 'template' });
    assert.equal(ctx.scheduler.tick().show, 'blitz');
    await ctx.producer.idle(); await ctx.producer.idle();

    assert.throws(() => ctx.settings.update({ dailyCapUsd: 500 }), /between \$0 and \$50/);
    assert.throws(() => ctx.settings.update({ dailyCapUsd: -1 }), /between/);
  } finally { await s.close(); }
});

test('daily shows: held in the preseason, like every other automatic show', async () => {
  const s = await boot({ channelAuto: true, channelWriter: 'template', phaseOverride: 'preseason' });
  try {
    s.clock.t = at('06:20');
    assert.deepEqual(s.ctx.scheduler.tick(), { made: null, reason: 'held' });
    assert.equal(s.ctx.producer.list().length, 0);
    assert.equal(s.ctx.scheduler.status().held, true);
  } finally { await s.close(); }
});
