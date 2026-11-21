// The TV guide: today and tomorrow, slot by slot, saying what is new, which
// live shows are still to come (if there's news), and what is encores.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { guideDay } = require('../lib/channel/guide');
const { dayKey, nextDay, wallToMs } = require('../lib/channel/clock');
const { tmpDir } = require('./helpers');

const TZ = 'America/New_York';
const quiet = { log() {}, warn() {}, error() {} };
const DAY = nextDay(dayKey(Date.now(), TZ));
const at = (hhmm, day = DAY) => wallToMs(day, hhmm, TZ);

async function boot(settings = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { weeklyShow: 'hflnn',  approveWeekly: false, autoProduce: false, autoBreaking: false, channelAuto: true, channelWriter: 'template', ...settings });
  const clock = { t: at('05:00') };
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'x', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet,
    debounceMs: 1e9, now: () => clock.t, claude: { available: () => false, model: 'n', write: async () => { throw new Error('no'); } },
  });
  await ctx.loadSampleLeague();
  await ctx.producer.idle();
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const get = async path => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json();
  return { ctx, clock, get, close: async () => { server.close(); await ctx.close(); } };
}
const slot = (day, show, time) => day.slots.find(s => s.show === show && new Date(s.from).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) === time);

test('guide: before the day starts, live shows are expected and the rest is encores', async () => {
  const s = await boot();
  try {
    const g = await s.get('/api/channel/guide');
    assert.equal(g.timeZone, TZ);
    assert.deepEqual(g.days.map(d => d.day), [DAY, nextDay(DAY)]);
    const today = g.days[0];
    assert.equal(today.slots.length, 19, 'one entry per slot of the grid');
    assert.deepEqual([slot(today, 'blitz', '07:00').status, slot(today, 'blitz', '07:00').note], ['expected', 'New, about 12 minutes, if there is news']);
    assert.match(slot(today, 'wire', '17:00').note, /if new results have come in/);
    assert.equal(slot(today, 'blitz', '09:30').status, 'repeats', 'only the edition the show is made for is new');
    assert.equal(slot(today, 'vault', '00:00').status, 'repeats');
    assert.equal(slot(today, 'tonight', '20:00').status, 'expected');
    assert.equal(slot(g.days[1], 'afterdark', '23:30').status, 'expected', 'tomorrow too');
    // Blurbs come from the config, for the guide's hover text.
    assert.match(slot(today, 'afterdark', '23:30').blurb, /Gus/);
  } finally { await s.close(); }
});

test('guide: a show once made is new, with its title; a skipped one becomes encores', async () => {
  const s = await boot();
  try {
    s.clock.t = at('06:20');
    const made = s.ctx.scheduler.tick();
    await s.ctx.producer.idle(); await s.ctx.producer.idle();
    const ep = s.ctx.producer.get(made.made);
    // Published on the test's clock, not the real one (else it airs overnight first).
    s.ctx.producer.list().find(e => e.id === ep.id).publishedAt = new Date(at('06:25')).toISOString();
    let g = await s.get('/api/channel/guide');
    const blitz = slot(g.days[0], 'blitz', '07:00');
    assert.equal(blitz.status, 'new');
    assert.deepEqual(blitz.items.map(i => i.title), [ep.title]);

    // The 9:00 Wire passes with no new result: encores.
    s.clock.t = at('08:30');
    s.ctx.producer.liveStories = () => [];
    s.ctx.scheduler.tick();
    s.clock.t = at('09:05');
    g = await s.get('/api/channel/guide');
    assert.equal(slot(g.days[0], 'wire', '09:00').status, 'repeats');
    assert.equal(slot(g.days[0], 'wire', '09:00').onNow, true);
  } finally { await s.close(); }
});

test('guide: with live shows switched off, nothing is promised', async () => {
  const s = await boot({ channelAuto: false });
  try {
    const g = await s.get('/api/channel/guide');
    assert.equal(g.auto, false);
    assert.ok(g.days[0].slots.every(x => x.status !== 'expected'));
  } finally { await s.close(); }
});

test('guide: game replays and clips in a slot count as new', () => {
  const config = { timeZone: TZ, grid: [{ at: '00:00', show: 'vault' }, { at: '15:00', show: 'rewind' }, { at: '18:00', show: 'plays' }], shows: { vault: { title: 'The Vault' }, rewind: { title: 'HFL Rewind', kind: 'replay' }, plays: { title: 'Top Plays', kind: 'clips' } } };
  const b = (kind, hhmm, title, rerun = false) => ({ kind, from: at(hhmm), until: at(hhmm) + 60e3, title, rerun });
  const day = guideDay({ config, day: DAY, now: at('12:00'), blocks: [b('episode', '01:00', 'Old show', true), b('replay', '15:00', 'Patriots at Bills'), b('clip', '18:00', 'c1'), b('clip', '18:01', 'c2')] });
  assert.deepEqual(day.map(x => x.status), ['repeats', 'new', 'new']);
  assert.deepEqual(day[1].items, [{ kind: 'replay', title: 'Patriots at Bills' }]);
  assert.deepEqual(day[2].items, [{ kind: 'clips', title: '2 clips from league games' }]);
  assert.equal(day[0].note, 'Encores');
});

test("guide: last night's live shows are encores the next morning, not new", () => {
  const { buildDay } = require('../lib/channel/programme');
  const config = require('../config/channel.json');
  const day = DAY;
  const lastNight = new Date(wallToMs(nextDay(day, -1), '22:45', TZ)).toISOString();
  const episodes = [
    { id: 'ad', type: 'custom', channelShow: 'afterdark', duration: 700, publishedAt: lastNight, title: 'Grimley After Dark: Henry on Trial' },
    { id: 'wk', type: 'weekly', duration: 700, publishedAt: lastNight, title: 'Week 10' },
  ];
  const blocks = buildDay({ day, config, episodes });
  const g = guideDay({ config, day, blocks, now: wallToMs(day, '01:00', TZ) });
  const vault = g.find(s => s.show === 'vault');
  assert.deepEqual(vault.items.map(i => i.title), ['Week 10'], 'a weekly approved late still premieres the next morning; After Dark does not');
  assert.ok(blocks.filter(b => b.episodeId === 'ad').every(b => b.rerun));
});
