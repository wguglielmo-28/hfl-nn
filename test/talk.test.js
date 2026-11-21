'use strict';
// The Fifth Quarter, the weekly talk show: it replaces the HFL-NN weekly,
// runs on the commissioner's timing (Gather free → Write → Approve & air),
// covers a window of real time, fits an ElevenLabs character budget, and
// shares the show memory with HFL-NN.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { createElevenLabsProvider, delivery } = require('../lib/tts/elevenlabs');
const T = require('../lib/talk');
const M = require('../lib/memory');
const P = require('../lib/writer/prompt');
const talkCfg = require('../config/talk.json');
const basePersonas = require('../config/personas.json');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const DAY = 864e5;

// A stand-in ElevenLabs API: counts what is voiced and reports the balance.
function fakeEleven({ left = 30000 } = {}) {
  const api = { tts: 0, chars: 0, left };
  api.request = async ({ path, body }) => {
    if (path.startsWith('/v1/user/subscription')) {
      return { status: 200, body: Buffer.from(JSON.stringify({ tier: 'starter', character_count: 30000 - api.left, character_limit: 30000 })) };
    }
    if (path.startsWith('/v1/text-to-speech/')) {
      api.tts++;
      api.chars += JSON.parse(body).text.length;
      return { status: 200, body: Buffer.alloc(4800) };
    }
    return { status: 404, body: Buffer.from('{}') };
  };
  return api;
}

// A stand-in AI writer that writes a valid script from the brief alone.
function briefWriter(name) {
  const w = {
    calls: 0, model: `${name}-model`, available: () => true,
    write: async ({ brief, validate }) => {
      w.calls++;
      const segments = [...brief.matchAll(/^\[(s\d+)\] .*? — cast: (.*?) — /gm)].map(([, id, cast]) => {
        const ids = [...cast.matchAll(/\("([a-z]+)"\)/g)].map(m => m[1]);
        return { id, lines: ids.map(sp => ({ speaker: sp, text: `${name} line for ${id}.`, emotion: 'excited', gesture: 'none', shot: 'auto', card: '' })) };
      });
      const script = {
        title: `${name} week`, summary: 's', tickerItems: [], segments, fanPoll: { question: '', answers: [] },
        memoryUpdates: { storylines: [], predictions: [], moods: [], relationships: [], arguments: [], caseFile: [], quotes: [{ persona: 'reggie', text: `${name}: the champs are frauds`, teams: [] }] },
      };
      return { result: validate(script), model: w.model, usage: [], costUsd: 0.05, ms: 1 };
    },
  };
  return w;
}

async function boot({ settings = {}, eleven = fakeEleven(), claude = null, openai = null } = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: true, ...settings });
  const el = createElevenLabsProvider({ apiKey: 'xi-test', request: eleven.request, logger: quiet });
  const tts = createTTS({ provider: 'silent', cacheDir: tmpDir(), elevenlabs: el });
  const writes = { n: 0 };
  const none = { available: () => false, model: 'none', write: async () => { writes.n++; throw new Error('no'); } };
  const ctx = createApp({
    dataDir,
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', NODE_ENV: 'test' },
    tts, claude: claude || none, openai: openai || none,
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  let cookie = '';
  async function req(method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'X-HFLNN': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  await req('POST', '/api/login', { password: 'letmein' });
  const exportWeek = async () => {
    for (const p of fixturePayloads()) ctx.ingest.ingest(p);
    await ctx.ingest.flush();
    await ctx.producer.idle();
  };
  return { ctx, req, exportWeek, eleven, writes, close: async () => { server.close(); await ctx.close(); } };
}

test('gather window: a week back for the first episode, then since the last published one; several HFL weeks', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const first = T.gatherWindow([], now);
  assert.equal(first.first, true);
  assert.equal(Date.parse(first.from), now - 7 * DAY);
  const last = '2026-11-16T01:00:00.000Z';
  const w = T.gatherWindow([{ type: 'talk', status: 'published', publishedAt: last }, { type: 'weekly', status: 'published', publishedAt: '2026-11-20T00:00:00Z' }, { type: 'talk', status: 'draft', publishedAt: null }], now);
  assert.equal(w.from, last, 'starts where the last published talk show left off');

  const at = d => new Date(Date.parse(last) + d * DAY).toISOString();
  const wk = n => ({ seasonIndex: 8, stage: 'reg', week: n });
  const stories = [
    { id: 'a', type: 'game', week: wk(9), createdAt: at(1), score: 50 },
    { id: 'b', type: 'game', week: wk(10), createdAt: at(3), score: 80 },
    { id: 'c', type: 'streak', week: wk(11), createdAt: at(6), score: 60 },
    { id: 'old', type: 'game', week: wk(8), createdAt: at(-1), score: 99 },
    { id: 'gone', type: 'game', week: wk(10), createdAt: at(2), score: 99, excluded: true },
  ];
  const got = T.windowStories(stories, w);
  assert.deepEqual(got.map(s => s.id), ['b', 'c', 'a'], 'inside the window, biggest first, excluded ones out');
  assert.equal(T.weeksLabel(got), 'HFL Weeks 9–11');
  const arts = T.windowArticles([{ id: 'x', published: at(2) }, { id: 'y', published: at(-3), fetchedAt: at(1) }, { id: 'z', published: at(-3), fetchedAt: at(-2) }], w);
  assert.deepEqual(arts.map(a => a.id), ['x', 'y'], 'every Chronicle article published or picked up in the window');
});

test('the character budget decides the rundown: Starter keeps the core, Creator gets the whole show', () => {
  const personas = T.talkPersonas(basePersonas, talkCfg);
  const mk = (id, type, extra = {}) => ({ id, type, headline: `${id} headline`, teams: [1, 2], score: 50, facts: {}, card: { type: 'headline', data: { tag: 'X', text: id } }, ...extra });
  const stories = [mk('g1', 'game'), mk('g2', 'game'), mk('g3', 'game'), mk('st', 'streak'), mk('pf', 'performance')];
  const league = { teams: { 1: { owner: 'a' }, 2: { owner: 'b' } } };
  const context = { powerRankings: { type: 'power_rankings', data: { title: 'PR', rows: [] } } };
  const audience = { messages: [{ name: 'Sam', body: 'you guys are wrong' }] };
  const w = { from: '2026-11-16T00:00:00Z', to: '2026-11-22T00:00:00Z', label: 'HFL Weeks 9–11' };
  const starter = T.buildTalkRundown({ talk: talkCfg, personas, league, context, stories, audience, window: w, charBudget: 6000 });
  assert.deepEqual(starter.segments.map(s => s.kind), ['talk_open', 'rant', 'take_vs_take', 'brothers', 'last_word']);
  assert.ok(starter.estimatedChars <= 6000, `${starter.estimatedChars} fits 6000`);
  assert.match(starter.title, /^The Fifth Quarter: Week of /);
  const creator = T.buildTalkRundown({ talk: talkCfg, personas, league, context, stories, audience, window: w, charBudget: 25000 });
  assert.deepEqual(creator.segments.map(s => s.kind), talkCfg.rundown, 'every segment with material');
  assert.ok(creator.estimatedChars <= 25000 && creator.estimatedChars > 6000);
  assert.ok(creator.segments.every(s => s.cast.every(id => personas.anchors.some(a => a.id === id))));
  assert.equal(creator.aStory.payoff, creator.segments.find(s => s.kind === 'take_vs_take').id);
});

test('eleven_v3 reads the tags the test used; a key without "Voices: read" still gets the stock voices', async () => {
  assert.equal(delivery('angry', 'eleven_v3').tag, '[frustrated]');
  assert.equal(delivery('suspicious', 'eleven_v3').tag, '[conspiratorial]');
  assert.equal(delivery('neutral', 'eleven_v3').key, '');
  assert.equal(delivery('suspicious', 'eleven_v4').tag, '[whispers]', 'v4 unchanged');
  const denied = { status: 401, body: Buffer.from('{"detail":{"message":"The API key you used is missing the permission voices_read to execute this operation."}}') };
  const el = createElevenLabsProvider({ apiKey: 'xi', request: async () => denied, logger: quiet });
  const voices = await el.listVoices();
  assert.ok(voices.some(v => v.name === 'Liam' && v.id === 'TX3LPaxmHKxFdv7VOQHJ'));
  const sub = await createElevenLabsProvider({ apiKey: 'xi', request: async () => ({ status: 401, body: Buffer.from('{"detail":{"message":"The API key you used is missing the permission user_read"}}') }) }).subscription();
  assert.equal(sub.ok, false);
  assert.match(sub.reason, /User: read/);
});

test('a finished HFL week queues nothing when the talk show is the weekly: no desk, no script, no voices', async () => {
  const s = await boot({ claude: { available: () => true, model: 'x', write: async () => { throw new Error('should not be called'); } } });
  try {
    s.ctx.producer.desk.open({ seasonIndex: 8, stage: 'reg', week: 0 }, { label: 'Old week' });
    await s.exportWeek();
    assert.equal(s.ctx.producer.list().length, 0, 'no episode');
    assert.equal(s.ctx.producer.desk.current(), null, 'the waiting weekly was dismissed and nothing new opened');
    assert.equal(s.ctx.producer.desk.entries()[0].status, 'dismissed');
    assert.equal(s.ctx.producer.jobs().length, 0, 'no write or voice job');
    assert.equal(s.eleven.tts, 0);
    const st = await s.req('GET', '/api/admin/status');
    assert.equal(st.json.weeklyShow, 'talk');
  } finally { await s.close(); }
});

test('gather is free, write runs once per click, approve & air voices with ElevenLabs and publishes without Discord', async () => {
  const s = await boot();
  try {
    await s.exportWeek();
    let r = await s.req('POST', '/api/admin/desk/open', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.entry.kind, 'talk');
    assert.ok(r.json.talk.segments.length >= 3);
    assert.ok(r.json.talk.counts.stories > 0, 'the export stories are in the window');
    assert.ok(r.json.talk.estimatedChars <= r.json.talk.charBudget);
    assert.equal(s.ctx.producer.jobs().length, 0, 'gathering wrote nothing');
    assert.equal(s.eleven.tts, 0);

    r = await s.req('POST', '/api/admin/desk/approve', {});
    assert.equal(r.status, 200);
    await s.ctx.producer.idle();
    const id = r.json.episode.id;
    assert.equal(s.ctx.producer.jobs().filter(j => j.kind === 'write').length, 1);
    assert.equal(s.ctx.producer.jobs().filter(j => j.kind === 'voice').length, 0, 'writing never voices');
    assert.equal(s.eleven.tts, 0);
    let ep = (await s.req('GET', `/api/admin/episodes/${id}`)).json;
    assert.equal(ep.type, 'talk');
    assert.equal(ep.status, 'draft', ep.error || JSON.stringify(ep.validation));
    assert.ok(ep.voiceChars > 0);
    const memBefore = s.ctx.store.readJSON('memory.json', null);
    assert.ok(!memBefore?.episodes?.some(e => e.id === id), 'an unpublished draft adds nothing to the memory');

    r = await s.req('POST', `/api/admin/episodes/${id}/voice`, { publish: true });
    assert.equal(r.status, 200);
    await s.ctx.producer.idle();
    ep = (await s.req('GET', `/api/admin/episodes/${id}`)).json;
    assert.equal(ep.status, 'published', ep.error);
    assert.equal(ep.audio.fallbackFrom, undefined, 'no Kokoro fallback');
    assert.ok(ep.audio.provider.includes('elevenlabs'));
    assert.ok(s.eleven.tts > 0);
    assert.ok(s.eleven.chars <= ep.voiceChars, `sent ${s.eleven.chars}, estimated up to ${ep.voiceChars}`);
    assert.equal(ep.preflight.creditsLeft, 30000);
    assert.equal(ep.discordPostedAt, undefined);
    const m = s.ctx.store.readJSON(`episodes/${id}/manifest.json`);
    assert.equal(m.brand.name, 'The Fifth Quarter');
    assert.ok(m.lineup.every(a => talkCfg.anchors.some(t => t.id === a.id)), 'the talk cast, not the HFL-NN desk');
    const mem = s.ctx.store.readJSON('memory.json');
    assert.equal(mem.episodes.at(-1).show, 'The Fifth Quarter');
    assert.ok(mem.relationships.some(x => x.a === 'reggie' && x.b === 'gus'), 'cross-show relationships are seeded');

    // Straight after publishing there is nothing new: no writer is paid to fill air.
    r = await s.req('POST', '/api/admin/desk/open', {});
    assert.equal(r.json.talk.counts.stories, 0);
    const again = await s.req('POST', '/api/admin/desk/approve', {});
    assert.equal(again.status, 400);
    assert.match(again.json.error, /Nothing to talk about/);
    assert.equal(s.ctx.producer.jobs().filter(j => j.kind === 'write').length, 1);
  } finally { await s.close(); }
});

test('voicing refuses a script over the budget or over the credits left, before a credit is spent', async () => {
  const eleven = fakeEleven({ left: 50 });
  const s = await boot({ eleven });
  try {
    await s.exportWeek();
    await s.req('POST', '/api/admin/desk/open', {});
    const id = (await s.req('POST', '/api/admin/desk/approve', {})).json.episode.id;
    await s.ctx.producer.idle();
    await s.req('POST', `/api/admin/episodes/${id}/voice`, { publish: true });
    await s.ctx.producer.idle();
    let job = s.ctx.producer.jobs().find(j => j.kind === 'voice');
    assert.equal(job.status, 'failed');
    assert.match(job.error, /credits and the account has 50 left/);
    assert.equal(eleven.tts, 0);

    eleven.left = 30000;
    await s.req('PUT', '/api/admin/settings', { talkCharBudget: 1000 });
    const chars = s.ctx.producer.talkChars(id);
    if (chars > 1150) {
      await s.req('POST', `/api/admin/episodes/${id}/voice`, {});
      await s.ctx.producer.idle();
      job = s.ctx.producer.jobs().find(j => j.kind === 'voice');
      assert.match(job.error, /over the 1,000-character budget/);
      assert.equal(eleven.tts, 0);
    }
    assert.equal(s.ctx.producer.get(id).status, 'draft');
  } finally { await s.close(); }
});

test('blind test: both writers write the same window, the writer is hidden, the pick sets the talk writer', async () => {
  const claude = briefWriter('claude'), openai = briefWriter('openai');
  const s = await boot({ claude, openai });
  try {
    await s.exportWeek();
    await s.req('POST', '/api/admin/desk/open', {});
    const r = await s.req('POST', '/api/admin/desk/approve', { blind: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await s.ctx.producer.idle();
    assert.equal(claude.calls, 1);
    assert.equal(openai.calls, 1);
    const pair = s.ctx.producer.list().filter(e => e.type === 'talk');
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map(e => e.blind.label).sort(), ['A', 'B']);
    assert.ok(pair.every(e => e.writer === null), 'the list hides who wrote which');
    const a = pair.find(e => e.blind.label === 'A');
    const shown = (await s.req('GET', `/api/admin/episodes/${a.id}`)).json;
    assert.equal(shown.writer.kind, 'hidden');
    assert.equal(shown.status, 'draft', shown.error);
    const pick = await s.req('POST', '/api/admin/desk/blind/pick', { episodeId: a.id });
    assert.equal(pick.status, 200);
    assert.ok(['claude', 'openai'].includes(pick.json.writer));
    assert.equal(s.ctx.settings.get().talkWriter, pick.json.writer);
    assert.equal((await s.req('GET', `/api/admin/episodes/${a.id}`)).json.writer.kind, pick.json.writer, 'revealed after the pick');
  } finally { await s.close(); }
});

test('shared memory: each show hears what the other said; HFL-NN episodes keep their own desk', () => {
  const store = createStore(tmpDir());
  const talkP = T.talkPersonas(basePersonas, talkCfg);
  const network = T.networkPersonas(basePersonas, talkP);
  const mem = M.loadMemory(store, network);
  M.applyEpisode(mem, { id: 'e1', title: 'HFL-NN Tonight: Week 9' }, { summary: '', memoryUpdates: { quotes: [{ persona: 'hal', text: 'The Bills win the conference', teams: ['BUF'] }] } });
  M.applyEpisode(mem, { id: 'e2', title: 'Week of Nov 16', showName: 'The Fifth Quarter' }, { summary: '', memoryUpdates: { quotes: [{ persona: 'reggie', text: 'Hal is dreaming', teams: [] }] } });
  const talkBlock = M.promptBlock(mem, talkP, { network });
  assert.match(talkBlock, /Heard around the network/);
  assert.match(talkBlock, /Hal on HFL-NN .*The Bills win the conference/);
  assert.doesNotMatch(talkBlock, /Ray and Nate/, 'only pairs involving this cast');
  const hflBlock = M.promptBlock(mem, basePersonas, { network });
  assert.match(hflBlock, /Reggie on The Fifth Quarter .*Hal is dreaming/);
  assert.match(hflBlock, /Ray and Nate/);
  assert.match(hflBlock, /Reggie and Gus/, 'a cross-show rivalry touches HFL-NN too');
  assert.doesNotMatch(hflBlock, /Teddy and Mack/);
  assert.match(P.showBible(talkP), /writers' room for The Fifth Quarter/);
  assert.match(P.showBible(basePersonas), /writers' room for HFL-NN/, 'HFL-NN keeps its own bible');
});

test('every talk segment uses a set the studio can draw, and every look an accessory it knows', () => {
  const fs = require('fs');
  const sets = fs.readFileSync(require.resolve('../public/js/studio/talksets.js'), 'utf8').match(/TALK_SETS = new Set\(\[([^\]]+)\]\)/)[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1));
  const known = new Set(['desk', 'corkboard', 'breaking', ...sets]);
  for (const [k, s] of Object.entries(talkCfg.segments)) assert.ok(known.has(s.set), `${k}: set "${s.set}"`);
  assert.deepEqual(sets.sort(), ['booth', 'couch', 'film', 'podiums']);
  const anchorsJs = fs.readFileSync(require.resolve('../public/js/studio/anchors.js'), 'utf8');
  for (const a of talkCfg.anchors) {
    const acc = a.look.accessory;
    assert.ok(!acc || acc === 'none' || anchorsJs.includes(`L.accessory === '${acc}'`), `${a.id}: accessory "${acc}"`);
  }
  assert.ok(talkCfg.network.colors.accent);
});

test('on the channel: the newest Fifth Quarter premieres in its next slot and re-airs mornings and evenings until the next one', () => {
  const { buildDay } = require('../lib/channel/programme');
  const { wallToMs } = require('../lib/channel/clock');
  const config = require('../config/channel.json');
  const TZ = config.timeZone;
  const ep = (id, type, duration, publishedAt) => ({ id, type, duration, publishedAt, title: `Show ${id}`, status: 'published' });
  const older = ep('wk-old', 'weekly', 900, '2026-11-01T01:00:00Z');
  const t1 = ep('talk-1', 'talk', 360, new Date(wallToMs('2026-11-16', '14:00', TZ)).toISOString());
  const slot = (blocks, day, at) => blocks.find(b => b.from === wallToMs(day, at, TZ));

  const before = buildDay({ day: '2026-11-15', config, episodes: [older, t1] });
  assert.ok(!before.some(b => b.episodeId === 'talk-1'), 'nothing airs before it is published');

  const d1 = buildDay({ day: '2026-11-16', config, episodes: [older, t1] });
  const eve = slot(d1, '2026-11-16', '19:30');
  assert.equal(eve.episodeId, 'talk-1');
  assert.equal(eve.showTitle, 'The Fifth Quarter');
  assert.equal(eve.rerun, false, 'the evening it is published is its premiere');
  assert.equal(slot(d1, '2026-11-16', '20:00').episodeId !== 'talk-1', true, 'HFL-NN Tonight keeps its own slot');

  const d3 = buildDay({ day: '2026-11-18', config, episodes: [older, t1] });
  assert.equal(slot(d3, '2026-11-18', '10:00').episodeId, 'talk-1', 'still the newest: it re-airs');
  assert.equal(slot(d3, '2026-11-18', '10:00').rerun, true);

  const t2 = ep('talk-2', 'talk', 380, new Date(wallToMs('2026-11-22', '09:00', TZ)).toISOString());
  const d7 = buildDay({ day: '2026-11-22', config, episodes: [older, t1, t2] });
  assert.equal(slot(d7, '2026-11-22', '10:00').episodeId, 'talk-2', 'the next episode takes over');
});
