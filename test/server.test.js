'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const { parseFeed, extractArticle } = require('../lib/ingest/chronicle');
const { isDiscordWebhook, episodeMessage } = require('../lib/discord');
const { fixture, fixturePayloads, secondBatch, tmpDir, clone } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

async function boot(extra = {}) {
  const ctx = createApp({
    dataDir: tmpDir(),
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', HUB_PUSH_KEY: 'hub-key', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000,
    logger: quiet,
    ...extra,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  let cookie = '';
  async function req(method, path, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const adminReq = (method, path, opts = {}) => req(method, path, { ...opts, headers: { 'X-HFLNN': '1', ...(opts.headers || {}) } });
  return { ctx, req, adminReq, close: async () => { server.close(); await ctx.close(); } };
}

test('export receiver: secret key, gzip payloads, batch → wire stories', async () => {
  const s = await boot();
  try {
    const teams = zlib.gzipSync(Buffer.from(JSON.stringify(fixture('leagueteams'))));
    let r = await s.req('POST', '/ingest/wrong-key/pc/1/leagueteams', { body: teams, headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' } });
    assert.equal(r.status, 404, 'a wrong key looks like nothing is there');
    r = await s.req('POST', '/ingest/secret-key-123/pc/2890093/leagueteams', { body: teams, headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200);
    r = await s.req('POST', '/ingest/secret-key-123/pc/2890093/week/reg/1/schedules', { body: fixture('week-reg-1-schedules') });
    assert.equal(r.status, 200);
    r = await s.req('POST', '/ingest/secret-key-123/pc/2890093/week/reg/1/passing', { body: fixture('week-reg-1-passing') });
    assert.equal(r.status, 200);
    const batch = await s.ctx.ingest.flush();
    assert.ok(batch.parts.teams);
    assert.ok(s.ctx.producer.wireStories().some(st => st.type === 'game'));
  } finally { await s.close(); }
});

test('control room: login, CSRF header, and the full produce → voice → publish flow', async () => {
  const s = await boot();
  try {
    let r = await s.req('GET', '/api/admin/status');
    assert.equal(r.status, 401);
    r = await s.req('POST', '/api/login', { body: { password: 'nope' } });
    assert.equal(r.status, 401);
    r = await s.req('POST', '/api/login', { body: { password: 'letmein' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);

    r = await s.req('POST', '/api/admin/sample-data', { body: {} });
    assert.equal(r.status, 403, 'writes need the X-HFLNN header');
    s.ctx.settings.update({ autoProduce: false });
    r = await s.adminReq('POST', '/api/admin/sample-data', { body: {} });
    assert.equal(r.status, 200, r.text);
    r = await s.adminReq('POST', '/api/admin/sample-data', { body: {} });
    assert.equal(r.status, 409, 'sample data refuses to overwrite a league');

    r = await s.adminReq('GET', '/api/admin/status');
    assert.equal(r.json.league.teams, 32);
    assert.equal(r.json.league.latestWeek, 'Week 2');
    assert.equal(r.json.league.standingsFresh, true);
    assert.match(r.json.ingestUrl, /\/ingest\/secret-key-123$/);

    r = await s.adminReq('POST', '/api/admin/episodes', { body: { type: 'weekly', writer: 'template' } });
    assert.equal(r.status, 200, r.text);
    const id = r.json.id;
    await s.ctx.producer.idle();
    let ep = (await s.adminReq('GET', `/api/admin/episodes/${id}`)).json;
    assert.equal(ep.status, 'draft', JSON.stringify(ep.validation));
    assert.ok(ep.rundown.segments.some(x => x.kind === 'transactions'), 'the demo trade makes the show');
    assert.ok(ep.rundown.segments.some(x => x.kind === 'press_review'), 'the sample Chronicle article makes the show');
    assert.ok(ep.rundown.segments.some(x => x.kind === 'league_office'), 'the sample Hub announcement makes the show');

    // Not public until published
    assert.equal((await s.req('GET', `/api/episodes/${id}`)).status, 404);
    r = await s.adminReq('POST', `/api/admin/episodes/${id}/publish`, { body: {} });
    assert.equal(r.status, 400, 'publishing needs audio');

    // Edit a line, then voice and publish
    ep.script.segments[0].lines[0].text = 'Good evening, HFL. Big night tonight.';
    r = await s.adminReq('PUT', `/api/admin/episodes/${id}/script`, { body: ep.script });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.edited, true);
    r = await s.adminReq('POST', `/api/admin/episodes/${id}/voice`, { body: {} });
    assert.equal(r.status, 200, r.text);
    await s.ctx.producer.idle();
    ep = (await s.adminReq('GET', `/api/admin/episodes/${id}`)).json;
    assert.equal(ep.status, 'ready');
    const preview = await s.adminReq('GET', `/api/admin/episodes/${id}/manifest`);
    assert.equal(preview.status, 200);
    r = await s.adminReq('POST', `/api/admin/episodes/${id}/publish`, { body: { discord: false } });
    assert.equal(r.status, 200, r.text);

    // Public side
    const list = (await s.req('GET', '/api/episodes')).json;
    assert.equal(list[0].id, id);
    const m = (await s.req('GET', `/api/episodes/${id}`)).json;
    assert.equal(m.lines[0].text, 'Good evening, HFL. Big night tonight.');
    assert.ok(m.segments.every(x => typeof x.t0 === 'number' && Array.isArray(x.cards)));
    assert.equal(m.lineup.length, 5);
    assert.ok(m.mouth.data.length > 100);
    assert.ok(m.segments.find(x => x.kind === 'press_review').sources.some(src => /Crimson Chronicle/.test(src.label)));
    const audio = await s.req('GET', `/media/${id}/${m.audio}`, { raw: true });
    assert.equal(audio.status, 200);
    assert.ok(Number(audio.headers.get('content-length')) > 10000);
    assert.equal((await s.req('GET', `/media/${id}/../episode.json`, { raw: true })).status, 404);

    const page = await s.req('GET', `/watch/${id}`);
    assert.match(page.text, /property="og:title" content="[^"]*HFL-NN/);
    assert.equal((await s.req('GET', '/watch/nope-nope')).status, 404);

    // Publishing updates the show memory and marks stories used
    const mem = (await s.adminReq('GET', '/api/admin/memory')).json;
    assert.equal(mem.episodes.length, 1);
    const wire = (await s.adminReq('GET', '/api/admin/wire')).json;
    assert.ok(wire.some(st => st.usedIn.includes(id)));

    // A breaking bulletin typed by the commissioner
    r = await s.adminReq('POST', '/api/admin/episodes', { body: { type: 'breaking', writer: 'template', bulletin: { headline: 'League expands playoffs to 14 teams', details: 'Starts next season.' } } });
    assert.equal(r.status, 200, r.text);
    await s.ctx.producer.idle();
    const b = (await s.adminReq('GET', `/api/admin/episodes/${r.json.id}`)).json;
    assert.equal(b.status, 'draft');
    assert.match(JSON.stringify(b.script), /expands playoffs/i);
  } finally { await s.close(); }
});

test('automation: a game-week export drafts and voices the weekly show by itself', async () => {
  const s = await boot();
  try {
    s.ctx.settings.update({ autoProduce: true, autoPublish: true });
    await s.ctx.loadSampleLeague();
    await s.ctx.producer.idle();
    await s.ctx.producer.idle();
    const eps = s.ctx.producer.list();
    assert.equal(eps.length, 1, 'only the latest sample week triggers the newsroom');
    assert.equal(eps[0].status, 'published');
    assert.equal(eps[0].type, 'weekly');
  } finally { await s.close(); }
});

test('daily exports: a half-played week waits for the advance; big mid-week moves get a bulletin', async () => {
  const s = await boot();
  try {
    s.ctx.settings.update({ autoProduce: true, autoBreaking: true });
    const run = async payloads => {
      for (const p of payloads) s.ctx.ingest.ingest(p);
      await s.ctx.ingest.flush();
      await s.ctx.producer.idle();
      await s.ctx.producer.idle();
    };
    const of = type => s.ctx.producer.list().filter(e => e.type === type);
    const week2 = played => {
      const body = clone(fixture('week-reg-1-schedules'));
      body.gameScheduleInfoList.forEach((g, i) => {
        Object.assign(g, { weekIndex: 1, scheduleId: 900000 + i });
        if (i >= played) Object.assign(g, { status: 1, homeScore: 0, awayScore: 0 });
      });
      return { kind: 'week', stage: 'reg', week: 2, statKind: 'schedules', body, platform: 'pc', leagueId: '2890093' };
    };

    await run(fixturePayloads());
    assert.equal(of('weekly').length, 1, 'Week 1 is final, so it gets its show');

    await run([...fixturePayloads(), week2(2)]);
    assert.equal(of('weekly').length, 1, 'two Week 2 games in: no show yet, and no repeat of Week 1');
    assert.equal(of('breaking').length, 0, 'an unchanged export is not news');

    await run([...fixturePayloads(), week2(5), ...secondBatch()]);
    assert.equal(of('breaking').length, 1, 'a mid-week X-Factor upgrade and trade make a bulletin');
    assert.equal(of('weekly').length, 1);

    await run([...fixturePayloads(), ...secondBatch(), week2(16)]);
    const weeklies = of('weekly');
    assert.equal(weeklies.length, 2, 'the advance finishes Week 2');
    assert.equal(s.ctx.producer.get(weeklies[0].id).rundown.focusWeek.week, 2);
    assert.equal(of('breaking').length, 1, 'the weekly covers that batch instead of a second bulletin');
  } finally { await s.close(); }
});

test('an export for a different league starts fresh instead of reading as a pile of trades', async () => {
  const s = await boot();
  try {
    await s.ctx.loadSampleLeague();
    await s.ctx.producer.idle();
    assert.ok(s.ctx.producer.wireStories().some(x => !x.usedIn.length && !x.excluded), 'the sample leaves unused stories');

    for (const p of fixturePayloads()) s.ctx.ingest.ingest(p);
    const batch = await s.ctx.ingest.flush();
    await s.ctx.producer.idle();
    const league = s.ctx.getLeague();
    assert.equal(league.leagueId, '2890093');
    assert.equal(Object.keys(league.teams).length, 32);
    const mine = s.ctx.producer.wireStories().filter(x => x.batchId === batch.id);
    assert.ok(!mine.some(x => ['trade', 'signing', 'release', 'departure', 'owner_change', 'injury'].includes(x.type)), `no phantom roster moves: ${mine.map(x => x.type)}`);
    assert.ok(s.ctx.producer.wireStories().filter(x => x.batchId !== batch.id).every(x => x.usedIn.length || x.excluded), 'the sample league\'s leftovers are retired');
    assert.equal(s.ctx.store.list('league/archive').length, 0, 'the sample league is not worth archiving');

    // A real league giving way to another (next Madden year) is kept.
    for (const p of fixturePayloads()) s.ctx.ingest.ingest({ ...p, leagueId: '3000001' });
    await s.ctx.ingest.flush();
    assert.equal(s.ctx.getLeague().leagueId, '3000001');
    assert.deepEqual(s.ctx.store.list('league/archive').map(f => f.split('-')[0]), ['2890093'], 'the old real league is archived, not just dropped');
  } finally { await s.close(); }
});

test('start over: the sample league and everything made from it can be removed', async () => {
  const s = await boot();
  const dir = s.ctx.store.dir;
  try {
    await s.req('POST', '/api/login', { body: { password: 'letmein' } });
    await s.ctx.loadSampleLeague();
    await s.ctx.producer.idle();
    await s.ctx.producer.idle();
    const [ep] = s.ctx.producer.list();
    await s.adminReq('POST', `/api/admin/episodes/${ep.id}/publish`, { body: { discord: false } });
    assert.ok(s.ctx.store.exists('memory.json'), 'publishing wrote the show memory');
    assert.ok(s.ctx.chronicle.list().length && s.ctx.hub.data() && s.ctx.producer.wireStories().length);

    let r = await s.adminReq('POST', '/api/admin/reset', { body: {} });
    assert.equal(r.status, 400, 'needs the typed confirmation');
    s.ctx.ingest.ingest({ ...fixturePayloads()[0], leagueId: 'demo' });
    r = await s.adminReq('POST', '/api/admin/reset', { body: { confirm: 'RESET' } });
    assert.equal(r.status, 409, 'not while an export is arriving');
    await s.ctx.ingest.flush();
    await s.ctx.producer.idle();
    await s.ctx.producer.idle();

    r = await s.adminReq('POST', '/api/admin/reset', { body: { confirm: 'RESET' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.removed.leagueId, 'demo');
    assert.equal(Object.keys(s.ctx.getLeague().teams).length, 0);
    assert.equal(s.ctx.producer.list().length, 0);
    assert.equal(s.ctx.producer.wireStories().length, 0);
    assert.equal(s.ctx.chronicle.list().length, 0);
    assert.equal(s.ctx.hub.data(), null);
    for (const f of ['memory.json', 'memory.json.bak', 'league/batches.json', 'league/batches.json.bak', 'league/current.json.bak', 'wire.json.bak', 'raw', `episodes/${ep.id}`]) {
      assert.ok(!s.ctx.store.exists(f), `${f} is gone`);
    }
    assert.equal(s.ctx.store.list('league/archive').length, 0, 'the sample league is not worth archiving');
    r = await s.req('GET', '/api/episodes');
    assert.deepEqual(r.json, [], 'nothing left on the public channel');
  } finally { await s.close(); }

  // Nothing comes back after a restart (each file's .bak went too), and the
  // next export starts the real league clean.
  const again = await boot({ dataDir: dir });
  try {
    assert.equal(Object.keys(again.ctx.getLeague().teams).length, 0);
    assert.equal(again.ctx.producer.list().length, 0);
    assert.equal(again.ctx.producer.wireStories().length, 0);
    assert.equal(again.ctx.chronicle.list().length, 0);
    for (const p of fixturePayloads()) again.ctx.ingest.ingest(p);
    const batch = await again.ctx.ingest.flush();
    assert.equal(again.ctx.getLeague().leagueId, '2890093');
    assert.ok(!again.ctx.producer.wireStories().some(x => x.batchId === batch.id && ['trade', 'signing', 'release'].includes(x.type)));
  } finally { await again.close(); }
});

test('Claude model setting: Sonnet 5.5 by default, switchable, and passed to the writer', async () => {
  const calls = [];
  const claude = { available: () => true, model: 'claude-sonnet-5-5', write: async a => { calls.push([a.model, a.kind]); throw new Error('stub writer'); } };
  const s = await boot({ claude });
  try {
    await s.req('POST', '/api/login', { body: { password: 'letmein' } });
    let r = await s.adminReq('GET', '/api/admin/settings');
    assert.equal(r.json.claudeModel, 'claude-sonnet-5-5');
    assert.deepEqual(r.json.claudeModels.map(m => m.id), ['claude-sonnet-5-5', 'claude-opus-5-5']);

    for (const p of fixturePayloads()) s.ctx.ingest.ingest(p);
    await s.ctx.ingest.flush();
    await s.ctx.producer.idle();
    assert.deepEqual(calls[0], ['claude-sonnet-5-5', 'show'], 'the weekly goes to Sonnet 5.5');
    assert.equal(s.ctx.producer.list()[0].writer, 'template', 'a failed Claude call still leaves a script');

    r = await s.adminReq('PUT', '/api/admin/settings', { body: { claudeModel: 'claude-opus-5-5' } });
    assert.equal(r.status, 200);
    s.ctx.producer.createEpisode({ type: 'breaking', bulletin: { headline: 'League office approves the trade' } });
    await s.ctx.producer.idle();
    assert.deepEqual(calls[1], ['claude-opus-5-5', 'bulletin']);
    r = await s.adminReq('GET', '/api/admin/status');
    assert.equal(r.json.writer.model, 'claude-opus-5-5');

    r = await s.adminReq('PUT', '/api/admin/settings', { body: { claudeModel: 'gpt-5' } });
    assert.equal(r.status, 400);
  } finally { await s.close(); }
});

test('settings: webhook validation and masking, persona overrides', async () => {
  const s = await boot();
  try {
    await s.req('POST', '/api/login', { body: { password: 'letmein' } });
    let r = await s.adminReq('PUT', '/api/admin/settings', { body: { discordWebhook: 'https://discord.com.evil.com/api/webhooks/1/abc' } });
    assert.equal(r.status, 400);
    const hook = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';
    r = await s.adminReq('PUT', '/api/admin/settings', { body: { discordWebhook: hook, personaOverrides: { hal: { name: 'Hal Hypno', voice: 'am_adam' }, ray: { voice: 'not_a_voice' } }, spice: 'spicy' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.hasWebhook, true);
    assert.ok(!JSON.stringify(r.json).includes('abcdefghijklmnop'), 'the webhook secret never comes back');
    assert.equal(r.json.personas.find(p => p.id === 'hal').name, 'Hal Hypno');
    assert.equal(r.json.personas.find(p => p.id === 'ray').voice, 'am_onyx', 'unknown voices are ignored');
    const stored = JSON.stringify(s.ctx.store.readJSON('settings.json'));
    assert.ok(!stored.includes('abcdefghijklmnop'), 'stored encrypted');
  } finally { await s.close(); }
});

test('hub push needs the key; feeds are normalized', async () => {
  const s = await boot();
  try {
    let r = await s.req('POST', '/api/hub/push', { body: { owners: [] } });
    assert.equal(r.status, 401);
    r = await s.req('POST', '/api/hub/push', { body: { announcements: [{ title: 'Hello', body: 'World' }], owners: [{ teamAbbr: 'buf', displayName: 'X' }] }, headers: { Authorization: 'Bearer hub-key' } });
    assert.equal(r.status, 200);
    assert.equal(s.ctx.hub.data().owners[0].teamAbbr, 'BUF');
  } finally { await s.close(); }
  const n = normalizeHubFeed({
    powerRankings: [{ rank: 2, teamAbbr: 'kc' }, { rank: 1, teamAbbr: 'buf' }], junk: true,
    owners: [{ teamAbbr: 'gb', displayName: 'hypnotic01', coach: 'Hank Nottick', note: 'Humble to a fault' }],
    gamesOfTheWeek: [{ week: '20', stage: 'reg', away: 'phi', home: 'GB' }, { week: 0, away: 'X', home: 'Y' }, { week: 3, stage: 'preseason', away: 'NE', home: 'NYG' }],
  });
  assert.deepEqual(n.powerRankings.map(p => p.teamAbbr), ['BUF', 'KC']);
  assert.equal(n.owners[0].coach, 'Hank Nottick');
  assert.deepEqual(n.gamesOfTheWeek, [
    { season: null, stage: 'reg', week: 20, away: 'PHI', home: 'GB' },
    { season: null, stage: 'pre', week: 3, away: 'NE', home: 'NYG' },
  ]);
  assert.throws(() => normalizeHubFeed('nope'));
});

test('chronicle: RSS and Atom parsing, article extraction', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>The Crimson Chronicle</title>
    <item><title>Bills &amp; Chiefs Make a Deal</title><link>https://chronicle.example/deal</link><guid>deal-1</guid><dc:creator>Red Ink</dc:creator><pubDate>Thu, 01 Oct 2026 12:00:00 GMT</pubDate>
    <description>&lt;p&gt;Short teaser.&lt;/p&gt;</description><content:encoded><![CDATA[<p>The full story about the <b>trade</b>.</p><script>evil()</script>]]></content:encoded><category>Breaking</category></item></channel></rss>`;
  const [a] = parseFeed(rss);
  assert.equal(a.title, 'Bills & Chiefs Make a Deal');
  assert.equal(a.author, 'Red Ink');
  assert.equal(a.url, 'https://chronicle.example/deal');
  assert.match(a.body, /full story about the trade/);
  assert.doesNotMatch(a.body, /evil/);
  assert.equal(a.breaking, true);

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>C</title><entry><title>Week 2 Power Poll</title><id>tag:c,2026:2</id>
    <link rel="alternate" href="https://chronicle.example/poll"/><author><name>Staff</name></author><updated>2026-10-02T00:00:00Z</updated><summary>Who is number one?</summary></entry></feed>`;
  const [b] = parseFeed(atom);
  assert.equal(b.url, 'https://chronicle.example/poll');
  assert.equal(b.author, 'Staff');
  assert.equal(b.excerpt, 'Who is number one?');

  const page = extractArticle(`<html><head><title>X</title><meta property="og:title" content="Big Win"><meta name="author" content="Jo"><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>
    <body><nav>menu</nav><article><h1>Big Win</h1><p>${'Words. '.repeat(80)}</p></article></body></html>`);
  assert.equal(page.title, 'Big Win');
  assert.equal(page.author, 'Jo');
  assert.equal(page.feedLink, '/feed.xml');
  assert.ok(page.body.length > 300);
  assert.doesNotMatch(page.body, /menu/);
});

test('discord helpers', () => {
  assert.equal(isDiscordWebhook('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(isDiscordWebhook('http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(isDiscordWebhook('https://discord.com.evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), false);
  const msg = episodeMessage({ type: 'breaking', title: 'Breaking: X', summary: 'Y', headlines: ['A', 'B'], weekLabel: 'Week 3' }, 'https://x.test/watch/1');
  assert.match(msg.content, /Breaking/);
  assert.equal(msg.embeds[0].url, 'https://x.test/watch/1');
  assert.match(msg.embeds[0].fields[0].value, /• A/);
});

test('segment rewrite, unpublish and delete', async () => {
  const s = await boot();
  try {
    s.ctx.settings.update({ autoProduce: false });
    await s.ctx.loadSampleLeague();
    const ep = s.ctx.producer.createEpisode({ type: 'weekly', writer: 'template' });
    await s.ctx.producer.idle();
    const before = s.ctx.producer.get(ep.id);
    const segId = before.rundown.segments[2].id;
    const untouched = JSON.stringify(before.script.segments[0]);
    s.ctx.producer.rewrite(ep.id, { segmentId: segId, writer: 'template' });
    await s.ctx.producer.idle();
    const after = s.ctx.producer.get(ep.id);
    assert.equal(after.status, 'draft', JSON.stringify(after.validation));
    assert.equal(after.script.segments.length, before.script.segments.length);
    assert.equal(JSON.stringify(after.script.segments[0]), untouched, 'other segments are left alone');
    assert.equal(after.writer.history.length, 1);

    s.ctx.producer.voice(ep.id);
    await s.ctx.producer.idle();
    await s.ctx.producer.publish(ep.id, { discord: false });
    assert.equal(s.ctx.producer.published().length, 1);
    s.ctx.producer.unpublish(ep.id);
    assert.equal(s.ctx.producer.published().length, 0);
    assert.equal((await s.req('GET', `/api/episodes/${ep.id}`)).status, 404);
    s.ctx.producer.remove(ep.id);
    assert.equal(s.ctx.producer.get(ep.id), null);
    assert.ok(!s.ctx.store.exists(`episodes/${ep.id}`));
  } finally { await s.close(); }
});

test('chronicle: a page with no feed is read as a list of issues (the HFL Hub)', async () => {
  // Shaped like the Hub's /chronicle/week-N pages.
  const issue = (n, feature) => `<html><head><title>The HFL Crimson Chronicle — Week ${n}</title></head><body>
    <header><nav><a href="/chronicle">Chronicle</a><a href="/games">Games</a></nav></header>
    <main><div class="chron-masthead svelte-a"><h1>THE HFL CRIMSON CHRONICLE</h1><div class="byline svelte-a">Jenna Tulls, Senior HFL Correspondent</div>
      <div class="cover-label svelte-a">On the Cover: Joey Bosa, REDGE, Tennessee Titans</div></div>
      <p class="cover-deck svelte-a">Week ${n} ends a perfect season. More of the deck follows here.</p><p class="lede">The lede.</p>
      <h2 class="section">Week ${n} Scoreboard</h2><table><tr><td>DEN</td><td>13</td></tr></table><p>${'Scoreboard notes. '.repeat(60)}</p>
      <h2 class="section">Feature Story: ${feature}</h2><p class="body-text">${'The feature runs long. '.repeat(200)}</p>
      <h2 class="section">Press Row &amp; Transaction Wire</h2><h4>Transaction Wire</h4><p>Nothing crossed the wire.</p>
      <h2 class="section">Divisional Round Preview</h2><p>${'Preview text. '.repeat(200)}</p>
      <h2 class="section">League Poll</h2><p class="poll-question">Which game?</p>
      <section class="comments svelte-c"><h2>Discussion</h2><p>No comments yet.</p></section></main></body></html>`;
  const pages = {
    'https://hub.test/chronicle': `<html><body><nav><a href="/chronicle">Chronicle</a><a href="/news">News</a></nav><main>
      <a href="/chronicle/week-3">Issue 3</a><a href="/chronicle/week-2">Issue 2</a><a href="/chronicle/week-1">Issue 1</a><a href="/teams">Teams</a></main></body></html>`,
    'https://hub.test/chronicle/week-3': issue(3, 'Tennessee Ends the Perfect Season'),
    'https://hub.test/chronicle/week-2': issue(2, 'Old News'),
    'https://hub.test/chronicle/week-1': issue(1, 'Older News'),
  };
  const fetched = [];
  const fetchImpl = async url => { fetched.push(url); return { ok: !!pages[url], status: pages[url] ? 200 : 404, text: async () => pages[url] || 'not found' }; };
  const s = await boot({ fetchImpl });
  try {
    s.ctx.settings.update({ chronicleFeedUrl: 'https://hub.test/chronicle' });
    let r = await s.ctx.chronicle.refresh();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.mode, 'page');
    assert.equal(r.fresh, 1, 'the first read starts from the newest issue');
    const [a] = s.ctx.chronicle.list();
    assert.equal(a.title, 'Tennessee Ends the Perfect Season');
    assert.equal(a.author, 'Jenna Tulls');
    assert.equal(a.issue, 'The HFL Crimson Chronicle - Week 3');
    assert.match(a.excerpt, /^Week 3 ends a perfect season/);
    assert.match(a.text, /^On the Cover: Joey Bosa/);
    assert.match(a.text, /Feature Story: Tennessee Ends the Perfect Season\nThe feature runs long/);
    assert.match(a.text, /Transaction Wire: Nothing crossed the wire/);
    assert.match(a.text, /Divisional Round Preview\nPreview text/, 'long issues keep every section, not just the top');
    assert.doesNotMatch(a.text, /No comments yet|Which game|DEN 13/);
    assert.ok(a.text.length <= 6000);
    assert.ok(!fetched.includes('https://hub.test/chronicle/week-1'), 'back issues are not fetched');

    assert.equal((await s.ctx.chronicle.refresh()).fresh, 0, 'back issues never turn up as new');
    pages['https://hub.test/chronicle'] = pages['https://hub.test/chronicle'].replace('<main>', '<main><a href="/chronicle/week-4">Issue 4</a>');
    pages['https://hub.test/chronicle/week-4'] = issue(4, 'The Bracket Nobody Drew');
    r = await s.ctx.chronicle.refresh();
    assert.equal(r.fresh, 1);
    assert.equal(s.ctx.chronicle.list()[0].title, 'The Bracket Nobody Drew');

    // An issue with no feature story takes its headline from the cover summary.
    pages['https://hub.test/x'] = issue(5, 'X').replace(/Feature Story: X/, 'The Championship')
      .replace(/Week 5 ends a perfect season\. More of the deck follows here\./, 'Green Bay beats Houston 34-10 to win the HFL Championship, closing a 16-1 season and the entire cycle in the same afternoon -- only the final score survives.');
    assert.equal((await s.ctx.chronicle.addUrl('https://hub.test/x')).title, 'Green Bay beats Houston 34-10 to win the HFL Championship');

    pages['https://hub.test/'] = '<html><body><main><a href="/a">A</a></main></body></html>';
    s.ctx.settings.update({ chronicleFeedUrl: 'https://hub.test/' });
    r = await s.ctx.chronicle.refresh();
    assert.equal(r.ok, false, 'a site root is too broad to read as an index');
    assert.match(r.error, /No RSS\/Atom feed or list of articles/);
  } finally { await s.close(); }
});

test('chronicle and hub polling with a fake web', async () => {
  const pages = {
    'https://chronicle.test/': '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>Home</body></html>',
    'https://chronicle.test/feed.xml': `<rss version="2.0"><channel><item><title>Week 2 Winners and Losers</title><link>https://chronicle.test/w2</link><guid>w2</guid><description>Teaser only.</description></item>
      <item><title>BREAKING: Commissioner Sacks the Sim</title><link>https://chronicle.test/b</link><guid>b</guid><description>${'Long enough body. '.repeat(40)}</description><category>Breaking</category></item></channel></rss>`,
    'https://chronicle.test/w2': `<html><head><meta name="author" content="Ink Slinger"></head><body><article><p>${'The full winners and losers column. '.repeat(30)}</p></article></body></html>`,
    'https://hub.test/feed': JSON.stringify({ announcements: [{ id: 'a1', title: 'Draft order set', body: 'Lottery done.' }], owners: [{ teamAbbr: 'BUF', displayName: 'HypnoKing' }] }),
  };
  const fetchImpl = async url => ({
    ok: !!pages[url], status: pages[url] ? 200 : 404,
    text: async () => pages[url] || 'not found',
  });
  const s = await boot({ fetchImpl });
  try {
    s.ctx.settings.update({ chronicleFeedUrl: 'https://chronicle.test/', hubFeedUrl: 'https://hub.test/feed', autoBreaking: true });
    const r = await s.ctx.chronicle.refresh();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.fresh, 2);
    const w2 = s.ctx.chronicle.list().find(a => a.title.startsWith('Week 2'));
    assert.match(w2.text, /full winners and losers column/, 'teaser feeds get the full article');
    assert.equal(w2.author, 'Ink Slinger');
    await s.ctx.producer.idle();
    await s.ctx.producer.idle();
    const bulletin = s.ctx.producer.list().find(e => e.type === 'breaking');
    assert.ok(bulletin, 'a Chronicle post tagged Breaking drafts a bulletin');
    assert.equal((await s.ctx.chronicle.refresh()).fresh, 0, 'no duplicates on the next poll');

    const h = await s.ctx.hub.refresh();
    assert.equal(h.ok, true, h.error);
    assert.equal(s.ctx.hub.data().announcements[0].title, 'Draft order set');
  } finally { await s.close(); }
});
