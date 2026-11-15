// Members' takes and segment requests, sent through the HFL Hub and approved
// there, reach the Week Desk as suggestions and nothing more.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { normalizeHubFeed } = require('../lib/ingest/hub');
const { cleanHeadline, CATEGORIES } = require('../lib/desk');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };

test('the Hub feed carries approved takes and requests, clipped and tidied', () => {
  const feed = normalizeHubFeed({
    fanTakes: [
      { id: 'nn4', name: 'GB GM', team: 'gb', text: '  The Packers  defense\nis the best unit in the league. ', week: 9 },
      { id: 'nn5', name: '', team: 'TOOLONGABBR', text: 'x'.repeat(500) },
      { id: '', text: 'no id' }, { id: 'nn6', text: '' }, null,
    ],
    segmentRequests: [{ id: 'nn7', name: 'Fan', text: 'Break down Packers at Cowboys.' }],
  });
  assert.deepEqual(feed.fanTakes[0], { id: 'nn4', name: 'GB GM', team: 'GB', text: 'The Packers defense is the best unit in the league.', week: 9 });
  assert.equal(feed.fanTakes.length, 2, 'entries without an id or text are dropped');
  assert.equal(feed.fanTakes[1].name, 'A member');
  assert.equal(feed.fanTakes[1].team.length, 5);
  assert.equal(feed.fanTakes[1].text.length, 280);
  assert.deepEqual(feed.segmentRequests.map(r => r.id), ['nn7']);
});

test('a feed without them is still a feed', () => {
  const feed = normalizeHubFeed({ league: { name: 'HFL' } });
  assert.deepEqual(feed.fanTakes, []);
  assert.deepEqual(feed.segmentRequests, []);
});

test('a headline made from a submission remembers which one', () => {
  assert.ok(CATEGORIES.includes('FAN TAKE') && CATEGORIES.includes('VIEWER REQUEST'));
  const h = cleanHeadline({ headline: 'Fan take from GB GM (GB)', details: 'd', category: 'FAN TAKE', teams: 'GB', fromMember: 'nn4' });
  assert.equal(h.fromMember, 'nn4');
  assert.equal(h.category, 'FAN TAKE');
  assert.equal('fromMember' in cleanHeadline({ headline: 'An ordinary headline' }), false);
});

test('the control room desk lists them, and the public API does not', async () => {
  const ctx = createApp({
    dataDir: tmpDir(), env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', HUB_PUSH_KEY: 'hub-key', NODE_ENV: 'test' },
    tts: createTTS({ provider: 'silent' }), claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const push = await fetch(`${base}/api/hub/push`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hub-key' },
      body: JSON.stringify({ fanTakes: [{ id: 'nn4', name: 'GB GM', team: 'GB', text: 'The Packers defense is the best unit in the league.' }] }),
    });
    assert.equal(push.status, 200);

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'letmein' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const desk = await (await fetch(`${base}/api/admin/desk`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(desk.fromMembers.takes, [{ id: 'nn4', name: 'GB GM', team: 'GB', text: 'The Packers defense is the best unit in the league.', week: null, used: false }]);
    assert.deepEqual(desk.fromMembers.requests, []);

    for (const path of ['/api/episodes', '/api/ticker', '/api/channel']) {
      assert.doesNotMatch(await (await fetch(`${base}${path}`)).text(), /best unit in the league/, `${path} does not leak an unaired take`);
    }
  } finally {
    await new Promise(r => server.close(r));
    await ctx.close?.();
  }
});
