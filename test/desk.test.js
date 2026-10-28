'use strict';
// The week desk: a finished week waits for the commissioner's picks and
// approval before the weekly show is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { createDesk, cleanPick } = require('../lib/desk');
const { fixturePayloads, tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const wk = week => ({ seasonIndex: 8, stage: 'reg', week });

// Approval is on by default: no settings are seeded.
async function boot({ settings = null } = {}) {
  const dataDir = tmpDir();
  if (settings) createStore(dataDir).writeJSON('settings.json', settings);
  const ctx = createApp({
    dataDir,
    env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'secret-key-123', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }),
    claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000,
    logger: quiet,
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
  return { ctx, req, exportWeek, close: async () => { server.close(); await ctx.close(); } };
}

test('desk entries: one per week, a newer week supersedes a waiting one, inputs are cleaned', () => {
  const desk = createDesk({ store: createStore(tmpDir()) });
  const a = desk.open(wk(1), { label: 'Week 1', batchId: 'b1' });
  assert.equal(desk.open(wk(1), { batchId: 'b2' }), a, 'the same week reopens the same entry');
  assert.equal(a.batchId, 'b2');
  const b = desk.open(wk(2), { label: 'Week 2' });
  assert.equal(a.status, 'superseded');
  assert.equal(desk.current(), b);

  assert.throws(() => desk.update({ gotwStoryId: 'perf:123' }), /one of the week's games/);
  desk.update({ gotwStoryId: 'game:abc', potw: { offense: { rosterId: 77 }, defense: { name: ' Jane  Doe ', team: 'buf', line: '3 sacks' } }, notes: '  hi  ' });
  assert.deepEqual(b.potw, { offense: { rosterId: '77' }, defense: { name: 'Jane Doe', team: 'BUF', line: '3 sacks' } });
  assert.equal(b.notes, 'hi');
  assert.equal(cleanPick({ name: 'No Line' }), null, 'a typed-in player needs a stat line');

  assert.throws(() => desk.addHeadline({ headline: '   ' }), /needs some text/);
  desk.addHeadline({ headline: 'Packers and Bears agree to a trade', details: 'Two firsts', teams: 'gb, chi, toolong', breaking: true });
  assert.deepEqual(b.headlines[0].teams, ['GB', 'CHI']);
  assert.equal(b.headlines[0].category, 'BREAKING');
  for (let i = 1; i < 8; i++) desk.addHeadline({ headline: `Item ${i}` });
  assert.throws(() => desk.addHeadline({ headline: 'one too many' }), /8 headlines/);
  desk.removeHeadline(b.headlines[0].id);
  assert.equal(b.headlines.length, 7);

  desk.dismiss();
  assert.equal(desk.current(), null);
  assert.throws(() => desk.update({ notes: 'x' }), /Nothing is waiting/);
  assert.equal(desk.open(wk(2)).status, 'dismissed', 'a skipped week stays skipped');
});

test('an export that finishes a week waits on the desk instead of writing the show', async () => {
  const s = await boot();
  try {
    await s.exportWeek();
    assert.equal(s.ctx.producer.list().length, 0, 'nothing written yet');
    let r = await s.req('GET', '/api/admin/desk');
    assert.equal(r.status, 200);
    const { entry, candidates, suggested } = r.json;
    assert.equal(entry.label, 'Week 1');
    assert.equal(entry.status, 'pending');
    assert.equal(candidates.games.length, 16);
    assert.equal(candidates.offense.length, 5);
    assert.equal(candidates.defense.length, 5);
    assert.equal(suggested.potw.offense, candidates.offense[0].rosterId);
    r = await s.req('GET', '/api/admin/status');
    assert.equal(r.json.desk.label, 'Week 1', 'the dashboard knows a week is waiting');

    // The daily export runs again while it waits: same entry, picks kept, still nothing written.
    await s.req('PUT', '/api/admin/desk', { notes: 'Keep it light this week.' });
    await s.exportWeek();
    r = await s.req('GET', '/api/admin/desk');
    assert.equal(r.json.entry.key, entry.key);
    assert.equal(r.json.entry.notes, 'Keep it light this week.');
    assert.equal(s.ctx.producer.list().length, 0);
  } finally { await s.close(); }
});

test('approving writes the show with the commissioner\'s Game of the Week, Players of the Week and headlines', async () => {
  const s = await boot();
  try {
    await s.exportWeek();
    let r = await s.req('GET', '/api/admin/desk');
    const { candidates } = r.json;
    const pick = candidates.games.find(g => !g.madden && g.id !== candidates.hubGotw) || candidates.games[1];
    const defense = candidates.defense[2];
    r = await s.req('PUT', '/api/admin/desk', {
      gotwStoryId: pick.id,
      potw: { offense: { name: 'Sam Example', team: 'BUF', line: '4 total touchdowns' }, defense: { rosterId: defense.rosterId } },
      notes: 'Mention the rain game.',
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await s.req('POST', '/api/admin/desk/headlines', { headline: 'Packers and Bears agree to a blockbuster trade', details: 'Announced in the league Discord.', category: 'TRADE', teams: 'GB CHI', breaking: true });
    assert.equal(r.json.entry.headlines.length, 1);
    await s.req('POST', '/api/admin/desk/headlines', { headline: 'Commissioner extends the trade deadline', category: 'LEAGUE NEWS' });

    r = await s.req('POST', '/api/admin/desk/approve', { voice: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.episode.id;
    await s.ctx.producer.idle();
    const ep = s.ctx.producer.get(id);
    const seg = kind => ep.rundown.segments.find(x => x.kind === kind);

    assert.equal(seg('game_of_week').title, 'Game of the Week', 'named, not the Spotlight Game');
    assert.deepEqual(seg('game_of_week').storyIds, [pick.id]);
    assert.match(seg('top_performers').brief, /official Players of the Week: Sam Example \(BUF\) on offense and .+ on defense/);
    assert.ok(seg('top_performers').cards.some(c => c.data.name === 'Sam Example' && c.data.line === '4 total touchdowns'));
    assert.ok(seg('top_performers').cards.some(c => c.data.name === defense.name), 'the picked defender');
    const desk = seg('desk_report');
    assert.equal(desk.storyIds.length, 2);
    assert.ok(seg('cold_open').storyIds[0].startsWith('desk:'), 'the breaking headline leads the show');
    assert.equal(ep.stories[seg('cold_open').storyIds[0]].facts.details, 'Announced in the league Discord.');
    assert.equal(ep.notes, 'Mention the rain game.');
    assert.equal(ep.status, 'draft', 'written, not voiced');
    assert.ok(!ep.audio);

    r = await s.req('GET', '/api/admin/desk');
    assert.equal(r.json.entry, null, 'the desk is clear');
    const entry = s.ctx.producer.desk.entries().at(-1);
    assert.equal(entry.status, 'approved');
    assert.equal(entry.episodeId, id);

    // The finished week is covered now: the next export doesn't open it again.
    await s.exportWeek();
    assert.equal((await s.req('GET', '/api/admin/desk')).json.entry, null);
  } finally { await s.close(); }
});

test('the Hub\'s Players of the Week are suggested on the desk and air, even ones HFL-NN ranks low', async () => {
  const s = await boot();
  try {
    await s.exportWeek();
    let r = await s.req('GET', '/api/admin/desk');
    const { entry, candidates } = r.json;
    const wk = entry.week;
    // One offensive pick per conference: HFL-NN ranks the AFC one higher, so
    // it is the suggestion. On defense the Hub names someone HFL-NN doesn't rank.
    const [high, low] = [candidates.offense[1], candidates.offense[3]];
    s.ctx.hub.push({
      playersOfTheWeek: [
        { stage: 'reg', week: wk.week, side: 'offense', conference: 'NFC', rosterId: low.rosterId, name: low.name, team: low.team, line: low.line, manual: true },
        { stage: 'reg', week: wk.week, side: 'offense', conference: 'AFC', rosterId: high.rosterId, name: high.name, team: high.team, line: high.line },
        { stage: 'reg', week: wk.week, side: 'defense', conference: 'NFC', rosterId: 987654321, name: 'Hub Only', team: 'GB', line: '2 INT, 1 TD' },
        { stage: 'reg', week: wk.week + 1, side: 'defense', conference: 'AFC', rosterId: 1, name: 'Next Week', team: 'BUF', line: 'x' },
      ],
    });
    r = await s.req('GET', '/api/admin/desk');
    const { candidates: c, suggested } = r.json;
    assert.equal(suggested.potw.offense, high.rosterId, 'the Hub pick HFL-NN ranks highest');
    assert.deepEqual(suggested.potwFromHub, { offense: true, defense: true });
    assert.equal(c.offense.length, 5, 'both offensive picks were already in the top five');
    assert.equal(c.offense.find(x => x.rosterId === high.rosterId).hub, 'AFC');
    assert.equal(c.offense.find(x => x.rosterId === low.rosterId).hub, 'NFC');
    assert.equal(c.offense.filter(x => x.hub).length, 2);
    assert.equal(suggested.potw.defense, '987654321');
    assert.deepEqual(c.defense.at(-1), { rosterId: '987654321', name: 'Hub Only', team: 'GB', line: '2 INT, 1 TD', hub: 'NFC' });
    assert.ok(!c.defense.some(x => x.name === 'Next Week'), 'another week\'s pick stays out');

    // Approving with the suggestions (what the desk preselects) airs both.
    await s.req('PUT', '/api/admin/desk', { potw: { offense: { rosterId: suggested.potw.offense }, defense: { rosterId: suggested.potw.defense } } });
    r = await s.req('POST', '/api/admin/desk/approve', { voice: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await s.ctx.producer.idle();
    const ep = s.ctx.producer.get(r.json.episode.id);
    const seg = ep.rundown.segments.find(x => x.kind === 'top_performers');
    assert.ok(seg.cards.some(card => card.data.name === high.name), 'the Hub\'s offensive pick');
    assert.ok(seg.cards.some(card => card.data.name === 'Hub Only' && card.data.line === '2 INT, 1 TD'), 'the Hub\'s defensive pick, from its own line');
  } finally { await s.close(); }
});

test('approval off keeps the classic flow; a request body can never smuggle desk picks in', async () => {
  const s = await boot({ settings: { approveWeekly: false } });
  try {
    await s.exportWeek();
    assert.equal(s.ctx.producer.list().length, 1, 'written straight away, as before');
    assert.equal((await s.req('GET', '/api/admin/desk')).json.entry, null);
    const r = await s.req('POST', '/api/admin/episodes', { type: 'weekly', desk: { week: { seasonIndex: 99, stage: 'reg', week: 99 }, gotwStoryId: 'game:x', headlines: [] } });
    assert.equal(r.status, 200, 'the desk field is ignored rather than trusted');
  } finally { await s.close(); }
});

test('the desk can be opened by hand, skipped, and refuses to approve when nothing waits', async () => {
  const s = await boot({ settings: { approveWeekly: false, autoProduce: false } });
  try {
    await s.exportWeek();
    let r = await s.req('POST', '/api/admin/desk/approve', {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Nothing is waiting/);
    r = await s.req('POST', '/api/admin/desk/open', {});
    assert.equal(r.json.entry.label, 'Week 1');
    r = await s.req('POST', '/api/admin/desk/dismiss', {});
    assert.equal(r.json.entry, null);
    assert.equal(s.ctx.producer.list().length, 0);
  } finally { await s.close(); }
});
