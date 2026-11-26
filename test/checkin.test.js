// The Chat Check-In: when the HFL Hub chat gets busy between shows, a short
// bulletin that reads it is made, cuts in over the schedule a minute after it
// is published, and the show it interrupts carries on where it would have
// been. It never fires on a quiet chat, too often, with the setting off,
// during a live game, or just before a live show that will read the chat
// itself; it is never vault filler; and what it read is listed for the Hub's
// "Read on HFL-NN" marks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { buildDay, validateConfig } = require('../lib/channel/programme');
const { placeCutIns, withCutIns } = require('../lib/channel/plan');
const { dayKey, nextDay, wallToMs } = require('../lib/channel/clock');
const { tmpDir } = require('./helpers');

const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'channel.json'), 'utf8')));
const TZ = config.timeZone;
const quiet = { log() {}, warn() {}, error() {} };
const DAY = nextDay(dayKey(Date.now(), TZ));
const at = (hhmm, day = DAY) => wallToMs(day, hhmm, TZ);
const sqliteTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const MIN = 60000;

async function boot(settings = {}, hub = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', {
    weeklyShow: 'hflnn', approveWeekly: false, autoProduce: false, autoBreaking: false, channelAuto: true, channelWriter: 'template',
    hubFeedUrl: 'https://hub.example/api/hfl-nn-feed', ...settings,
  });
  const clock = { t: at('05:00') };
  hub.messages ||= [];
  hub.live ||= [];
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('/api/hfl-nn/chat-digest')) return new Response(JSON.stringify({ messages: hub.messages, polls: [] }), { status: 200 });
    if (u.includes('/streams')) return new Response(JSON.stringify({ live: hub.live, replays: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'x', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet,
    debounceMs: 1e9, now: () => clock.t, fetchImpl, claude: { available: () => false, model: 'n', write: async () => { throw new Error('no'); } },
  });
  await ctx.loadSampleLeague();
  await ctx.producer.idle();
  const run = async () => { await ctx.producer.idle(); await ctx.producer.idle(); };
  const chatAt = async hhmm => { clock.t = at(hhmm); await ctx.chatDigest.refresh(); };
  return { ctx, clock, hub, run, chatAt, close: () => ctx.close() };
}

const busy = (start = '09:50') => {
  const t0 = at(start);
  return [
    { id: 31, name: 'Anna', body: 'Big Ray has been wrong all week long', at: sqliteTime(t0) },
    { id: 32, name: 'Ben', body: 'The Chiefs defense is the real deal this year', at: sqliteTime(t0 + 2 * MIN) },
    { id: 33, name: 'Anna', body: 'Gus, what is your theory about the Bills?', at: sqliteTime(t0 + 5 * MIN) },
  ];
};

test('check-in: a busy chat between shows gets a short bulletin that reads it, cut in over the schedule', async () => {
  const s = await boot({}, { messages: busy() });
  try {
    await s.chatAt('10:00');
    const made = s.ctx.scheduler.tick();
    assert.equal(made.show, 'checkin', JSON.stringify(made));
    await s.run();
    const ep = s.ctx.producer.get(made.made);
    assert.equal(ep.status, 'published', ep.error || '');
    assert.equal(ep.channelShow, 'checkin');
    assert.equal(ep.title, 'Chat Check-In');
    assert.deepEqual(ep.rundown.segments.map(x => x.kind), ['chat_check', 'signoff']);
    const seg = ep.rundown.segments[0];
    assert.deepEqual(seg.chatIds, [31, 32, 33]);
    assert.ok(seg.cast.includes('ray') && seg.cast.includes('gus'), 'the anchors named get to answer');
    const planned = ep.rundown.segments.reduce((n, x) => n + x.targetSeconds, 0);
    assert.ok(planned >= 120 && planned <= 200, `about 3 minutes planned, not ${planned}s`);
    assert.ok(ep.audio.duration > 10 && ep.audio.duration < 6 * 60, `${ep.audio.duration}s`);

    // Read once: nothing new, and the cooldown, mean no second one.
    s.clock.t = at('10:05');
    assert.notEqual(s.ctx.scheduler.tick().show, 'checkin');
    const st = s.ctx.scheduler.status().checkIn;
    assert.equal(st.today.length, 1);
    assert.equal(st.today[0].status, 'published');
    assert.match(st.waiting, /one aired recently/);

    // On air a minute after it was published, on the minute, over whatever
    // was on, which carries on afterwards on its own clock.
    const pub = Date.parse(ep.publishedAt);
    const from = Math.ceil((pub + MIN) / MIN) * MIN;
    const g = s.ctx.channel.guide(from + 1000);
    assert.equal(g.onNow.episodeId, ep.id);
    assert.equal(g.onNow.cutIn, true);
    assert.equal(g.onNow.from, from);
    assert.equal(g.onNow.until, from + Math.ceil(ep.audio.duration * 1000));
    const after = g.blocks.find(b => b.from === g.onNow.until);
    assert.ok(after, 'the schedule picks up straight after');
    const before = s.ctx.channel.guide(from - 1000).onNow;
    if (before.until > g.onNow.until) assert.equal(after.start ?? after.from, before.start ?? before.from, 'same clock as before the cut-in');

    // Never filler: the vault does not air it again.
    const blocks = [...s.ctx.channel.blocksFor(DAY), ...s.ctx.channel.blocksFor(nextDay(DAY))];
    assert.ok(!blocks.some(b => b.episodeId === ep.id));
    assert.ok(!s.ctx.channel.guide(from + 4 * 3600e3).blocks.some(b => b.episodeId === ep.id), 'gone once it has aired');

    // What it read, for the Hub.
    // (publishedAt is the real clock, not the test's.)
    const aired = s.ctx.producer.chatAired(Date.parse(ep.publishedAt) - 1000);
    const mine = aired.find(x => x.episodeId === ep.id);
    assert.deepEqual(mine.ids, [31, 32, 33]);
    assert.equal(mine.show, 'checkin');
    assert.deepEqual(mine.quotes[0], { name: 'ANNA', body: 'Big Ray has been wrong all week long' });

    // A new burst after the cooldown gets the next one, with only the new messages.
    s.hub.messages.push(
      { id: 41, name: 'Cam', body: 'Stat Lab better have the Lions at the top', at: sqliteTime(at('11:00')) },
      { id: 42, name: 'Dee', body: 'Nobody is talking about that Ravens defense', at: sqliteTime(at('11:02')) },
      { id: 43, name: 'Cam', body: 'Sasha called the upset last week, give her credit', at: sqliteTime(at('11:04')) },
    );
    await s.chatAt('11:08');
    const next = s.ctx.scheduler.tick();
    assert.equal(next.show, 'checkin');
    await s.run();
    assert.deepEqual(s.ctx.producer.get(next.made).rundown.segments[0].chatIds, [41, 42, 43]);
  } finally { await s.close(); }
});

test('check-in: a quiet chat, one person, the setting off, a show about to read the chat, a live game or the cap mean none', async () => {
  const none = async (settings, hub, hhmm, why) => {
    const s = await boot(settings, hub);
    try {
      await s.chatAt(hhmm);
      const r = s.ctx.scheduler.tick();
      assert.notEqual(r.show, 'checkin', why);
      return s.ctx.scheduler.status().checkIn;
    } finally { await s.close(); }
  };
  await none({}, { messages: busy().slice(0, 2) }, '10:00', 'two messages are not busy');
  await none({}, { messages: busy().map(m => ({ ...m, name: 'Anna' })) }, '10:00', 'one person is not a crowd');
  await none({}, { messages: busy('08:00') }, '10:00', 'two hours ago is not now');
  assert.match((await none({ chatCheckIns: false }, { messages: busy() }, '10:00', 'switched off')).waiting, /check-ins are switched off/);
  assert.match((await none({ chatOnAir: false }, { messages: busy() }, '10:00', 'chat on air off')).waiting, /chat on air is switched off/);
  assert.match((await none({ channelAuto: false }, { messages: busy() }, '10:00', 'daily shows off')).waiting, /daily shows are switched off/);
  // Stat Lab (13:00) is made from 12:00 and reads the chat itself.
  const soon = await none({}, { messages: busy('11:40') }, '11:50', 'Stat Lab will read it');
  assert.match(soon.waiting, /Stat Lab reads the chat soon/);
  // An AI writer with no money left today.
  const s = await boot({ channelWriter: 'auto', dailyCapUsd: 0 }, { messages: busy() });
  try {
    s.ctx.producer.pickWriter = () => 'claude';
    await s.chatAt('10:00');
    assert.notEqual(s.ctx.scheduler.tick().show, 'checkin');
    assert.match(s.ctx.scheduler.status().log[0].reason, /daily cap/);
  } finally { await s.close(); }
});

test('check-in: none while a league game is live', async () => {
  const { createScheduler } = require('../lib/channel/scheduler');
  const made = [];
  const producer = {
    held: () => false, busy: () => false, liveStories: () => [], published: () => [], spentBetween: () => 0,
    pickWriter: () => 'template', get: () => null, writerChain: () => ['template'],
    createEpisode: o => { made.push(o); return { id: `e${made.length}` }; },
  };
  const store = { readJSON: (_, d) => d, writeJSON() {}, remove() {} };
  let live = true;
  const t = at('10:00');
  const sched = createScheduler({
    store, config, producer, getSettings: () => ({ channelAuto: true, dailyCapUsd: 2 }), now: () => t, logger: quiet,
    isLive: () => live, getChat: () => ({ messages: busy().map(m => ({ ...m, about: [] })), poll: null }),
  });
  assert.equal(sched.tick().made, null);
  assert.match(sched.status().checkIn.waiting, /a league game is live/);
  live = false;
  assert.equal(sched.tick().show, 'checkin');
  assert.deepEqual(made[0].customKinds, ['chat_check', 'signoff']);
  assert.equal(made[0].channel.show, 'checkin');
  assert.equal(made[0].channel.minutes, 3);
});

test('cut-ins: placed after a premiere, never over one, and the block they split keeps its clock', () => {
  const base = at('10:00');
  const blocks = [
    { id: 'a', kind: 'episode', episodeId: 'old', rerun: true, from: base, until: base + 20 * MIN },
    { id: 'b', kind: 'episode', episodeId: 'new', rerun: false, from: base + 20 * MIN, until: base + 40 * MIN },
    { id: 'c', kind: 'ident', from: base + 40 * MIN, until: base + 60 * MIN },
  ];
  const ci = (id, pubMin, secs) => ({ id, type: 'custom', channelShow: 'checkin', duration: secs, publishedAt: new Date(base + pubMin * MIN + 5000).toISOString(), title: 'Chat Check-In' });

  // In the rerun: a minute after publishing, on the minute.
  let ins = placeCutIns(blocks, [ci('x', 5, 150)], config, base + 6 * MIN);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].from, base + 7 * MIN);
  let out = withCutIns(blocks, ins);
  assert.deepEqual(out.map(b => [b.id.split('~')[0], (b.from - base) / MIN]), [['a', 0], ['cutin:x', 7], ['a', 9.5], ['b', 20], ['c', 40]]);
  const resumed = out[2];
  assert.equal(resumed.start, base, 'the rerun carries on where it would have been');
  assert.equal(resumed.until, base + 20 * MIN);
  assert.ok(out.every((b, i) => !i || b.from === out[i - 1].until), 'no gaps, no overlaps');

  // One that would run into the premiere waits for it to finish.
  ins = placeCutIns(blocks, [ci('y', 18, 150)], config, base + 19 * MIN);
  assert.equal(ins[0].from, base + 40 * MIN);
  // Two close together go one after the other.
  ins = placeCutIns(blocks, [ci('p', 2, 120), ci('q', 2, 60)], config, base + 3 * MIN);
  assert.equal(ins[1].from, ins[0].until);
  // Too old to air: dropped.
  assert.equal(placeCutIns(blocks, [ci('z', -300, 150)], config, base).length, 0);

  // The vault never picks one up as filler.
  const day = buildDay({ day: DAY, config, episodes: [ci('v', 0, 150), { id: 'w1', type: 'weekly', duration: 400, publishedAt: new Date(base - 86400e3).toISOString(), title: 'W' }] });
  assert.ok(!day.some(b => b.episodeId === 'v'));
  assert.ok(day.some(b => b.episodeId === 'w1'));
});

test('config: a cut-in show needs a chat_check segment and no slots', () => {
  const bad = JSON.parse(JSON.stringify(config));
  bad.shows.checkin.cutIn.kinds = ['signoff'];
  assert.throws(() => validateConfig(bad), /has no chat_check segment/);
  const slotted = JSON.parse(JSON.stringify(config));
  slotted.grid.push({ at: '23:59', show: 'checkin' });
  assert.throws(() => validateConfig(slotted), /no slots of its own/);
});
