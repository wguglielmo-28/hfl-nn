// Writer fallback: with OpenAI picked, a script goes to OpenAI first, then
// Claude, then the free template writer. A writer that is out of credits (or
// whose key is refused, or that is rate-limited or down) is benched for a
// while and skipped without being asked; a successful script, the time
// running out, or "Try it again now" brings it back. A writer named by hand
// in the control room is still used as is.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { WriterError } = require('../lib/writer/claude');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

// A stand-in AI writer. `mode` decides what the next call does: 'ok' writes
// the script the template writer would have (so it passes validation),
// anything else throws the error given.
function fakeWriter(name, ctx) {
  const w = {
    calls: 0, mode: 'ok', error: null, model: `${name}-model`,
    available: () => true,
    write: async ({ validate }) => {
      w.calls++;
      if (w.mode === 'invalid') return { result: { ok: false, errors: ['a line names a player who is not in the league'] }, model: w.model, costUsd: 0.07 };
      if (w.mode !== 'ok') throw w.error;
      const ep = ctx.current();
      return { result: validate(JSON.parse(JSON.stringify(ep.templateScript))), model: w.model, usage: {}, costUsd: 0.12, ms: 5 };
    },
  };
  return w;
}

async function boot(settings = {}) {
  const dataDir = tmpDir();
  createStore(dataDir).writeJSON('settings.json', { approveWeekly: false, autoProduce: false, autoBreaking: false, ...settings });
  const shared = { current: () => null };
  const openai = fakeWriter('openai', shared);
  const claude = fakeWriter('claude', shared);
  const ctx = createApp({
    dataDir, env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k-123456', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), logger: quiet, debounceMs: 1e9, claude, openai,
  });
  await ctx.loadSampleLeague();
  await ctx.producer.idle();
  // The fakes hand back the template's script for the episode being written:
  // write it with the template first, then let the fake "write" it again.
  const bulletin = async (opts = {}) => {
    const draft = ctx.producer.createEpisode({ type: 'breaking', bulletin: { headline: 'League office approves the trade' }, writer: 'template' });
    await ctx.producer.idle();
    const templateScript = ctx.producer.get(draft.id).script;
    shared.current = () => ({ templateScript });
    ctx.producer.rewrite(draft.id, opts);
    await ctx.producer.idle();
    return ctx.producer.get(draft.id);
  };
  return { ctx, openai, claude, bulletin, close: () => ctx.close() };
}

const outOfCredits = () => new WriterError('OpenAI returned HTTP 429: You exceeded your current quota, please check your plan and billing details.. Rate limit or no API credit left on the OpenAI account.', 'http_429');
const rateLimited = () => new WriterError('OpenAI returned HTTP 429: Rate limit reached for gpt-6.1-sol on tokens per min.. Rate limit or no API credit left on the OpenAI account.', 'http_429');

test('writers: with OpenAI picked, OpenAI writes while it works', async () => {
  const s = await boot({ writer: 'openai' });
  try {
    assert.deepEqual(s.ctx.producer.writerChain(), ['openai', 'claude', 'template']);
    const ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'openai');
    assert.equal(ep.writer.fallbackFrom, undefined);
    assert.deepEqual([s.openai.calls, s.claude.calls], [1, 0]);
  } finally { await s.close(); }
});

test('writers: out of OpenAI credits, Claude writes, and OpenAI is skipped until it is tried again', async () => {
  const s = await boot({ writer: 'openai' });
  try {
    s.openai.mode = 'fail'; s.openai.error = outOfCredits();
    let ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'claude', 'Claude took over');
    assert.equal(ep.writer.fallbackFrom, 'openai');
    assert.equal(ep.writer.tried[0].why, 'credits');
    assert.deepEqual([s.openai.calls, s.claude.calls], [1, 1]);

    // Benched: the next script skips OpenAI without asking it.
    const [b] = s.ctx.producer.benchedWriters();
    assert.deepEqual([b.kind, b.why, b.says], ['openai', 'credits', 'out of credits']);
    assert.ok(Date.parse(b.until) - Date.now() > 5.9 * 3600e3, 'for six hours');
    assert.deepEqual(s.ctx.producer.writerChain(), ['claude', 'template']);
    ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'claude');
    assert.equal(ep.writer.fallbackFrom, undefined, 'a benched writer is not a failure on this script');
    assert.equal(s.openai.calls, 1);

    // A restart remembers.
    const again = createApp({ dataDir: s.ctx.store.dir, env: { ADMIN_PASSWORD: 'x', NODE_ENV: 'test' }, tts: createTTS({ provider: 'silent' }), logger: quiet, claude: s.claude, openai: s.openai });
    assert.deepEqual(again.producer.writerChain(), ['claude', 'template']);
    await again.close();

    // Topped up: "Try it again now", and OpenAI is first again.
    s.openai.mode = 'ok';
    assert.equal(s.ctx.producer.unbenchWriter('openai'), true);
    assert.deepEqual(s.ctx.producer.writerChain(), ['openai', 'claude', 'template']);
    ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'openai');
  } finally { await s.close(); }
});

test('writers: both AI writers failing still leaves a script, and their cost still counts', async () => {
  const s = await boot({ writer: 'openai' });
  try {
    s.openai.mode = 'fail'; s.openai.error = rateLimited();
    s.claude.mode = 'fail'; s.claude.error = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
    const ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'template');
    assert.deepEqual(ep.writer.tried.map(t => [t.kind, t.why]), [['openai', 'rate'], ['claude', 'credits']]);
    const benched = Object.fromEntries(s.ctx.producer.benchedWriters().map(b => [b.kind, b]));
    assert.ok(Date.parse(benched.openai.until) - Date.now() < 16 * 60e3, 'a rate limit is a short pause');
    assert.equal(benched.claude.why, 'credits');
    assert.deepEqual(s.ctx.producer.writerChain(), ['template']);

    // A script that is simply bad (not a billing problem) moves on but benches nothing.
    s.ctx.producer.unbenchWriter('openai'); s.ctx.producer.unbenchWriter('claude');
    s.openai.error = new WriterError('OpenAI returned something that is not valid JSON.', 'bad_json');
    s.claude.mode = 'ok';
    const next = await s.bulletin();
    assert.equal(next.writer.kind, 'claude');
    assert.deepEqual(s.ctx.producer.benchedWriters(), []);

    // A script that came back and failed validation was paid for: it counts.
    s.openai.mode = 'invalid';
    const t0 = Date.now();
    const paid = await s.bulletin();
    assert.deepEqual([paid.writer.kind, paid.writer.costUsd, paid.writer.failedCostUsd], ['claude', 0.12, 0.07]);
    assert.equal(s.ctx.producer.spentBetween(t0, Date.now() + 1000), 0.19);
  } finally { await s.close(); }
});

test('writers: the template is never escalated to a paid writer, and a hand-picked writer is used as is', async () => {
  const s = await boot({ writer: 'template' });
  try {
    assert.deepEqual(s.ctx.producer.writerChain(), ['template']);
    const ep = await s.bulletin();
    assert.equal(ep.writer.kind, 'template');
    assert.deepEqual([s.openai.calls, s.claude.calls], [0, 0]);

    // Picked by hand in the control room: no quiet fallback, the failure is reported.
    s.openai.mode = 'fail'; s.openai.error = outOfCredits();
    assert.deepEqual(s.ctx.producer.writerChain('openai'), ['openai']);
    const manual = await s.bulletin({ writer: 'openai' });
    assert.equal(manual.status, 'draft', 'the earlier script is kept');
    assert.match(s.ctx.producer.jobs()[0].error, /exceeded your current quota/);
    assert.equal(s.claude.calls, 0);
    // …but the daily shows' path, which asks for fallback, does fall back.
    assert.deepEqual(s.ctx.producer.writerChain('openai', { fallback: true }), ['claude', 'template']);
  } finally { await s.close(); }
});

test('writers: the control room shows the order and a benched writer, and can bring it back', async () => {
  const s = await boot({ writer: 'openai' });
  const server = http.createServer(s.ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'letmein' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const admin = (path, init = {}) => fetch(base + path, { ...init, headers: { cookie, 'Content-Type': 'application/json', 'X-HFLNN': '1', ...(init.headers || {}) } }).then(r => r.json());

    s.openai.mode = 'fail'; s.openai.error = outOfCredits();
    await s.bulletin();
    let st = await admin('/api/admin/status');
    assert.deepEqual(st.writer.chain, ['claude', 'template']);
    assert.deepEqual(st.writer.benched.map(b => [b.kind, b.says]), [['openai', 'out of credits']]);
    assert.deepEqual(st.channel.writers, ['claude', 'template']);

    assert.deepEqual(await admin('/api/admin/writers/openai/retry', { method: 'POST', body: '{}' }), { ok: true });
    st = await admin('/api/admin/status');
    assert.deepEqual(st.writer.chain, ['openai', 'claude', 'template']);
    assert.deepEqual(st.writer.benched, []);
  } finally { server.close(); await s.close(); }
});
