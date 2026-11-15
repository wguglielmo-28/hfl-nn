// Control-room sign-in from the HFL Hub: a one-use signed link (lib/auth.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { createAuth, SSO_AUDIENCE } = require('../lib/auth');
const { createApp } = require('../server');
const { createTTS } = require('../lib/tts');
const { createStore } = require('../lib/store');
const { tmpDir } = require('./helpers');

const quiet = { log() {}, warn() {}, error() {} };
const SECRET = 'shared-secret-for-tests-0123456789';

// What the Hub does (hfl-hub src/lib/server/nnSso.ts), in Node.
function mint(payload = {}, secret = SECRET) {
  const body = Buffer.from(JSON.stringify({ aud: SSO_AUDIENCE, sub: '1', exp: Date.now() + 60000, nonce: crypto.randomBytes(16).toString('hex'), ...payload })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const auth = (ssoSecret = SECRET) => createAuth({ store: createStore(tmpDir()), password: 'letmein', ssoSecret, logger: quiet });

test('a fresh link signs in, once', () => {
  const a = auth();
  const link = mint();
  const session = a.loginWithToken(link);
  assert.ok(session, 'first use gives a session');
  assert.ok(a.sessionOf({ headers: { cookie: `${a.COOKIE}=${session}` } }), 'and the session is real');
  assert.equal(a.loginWithToken(link), null, 'the same link does not work twice');
});

test('expired, far-future, wrong-audience and malformed links are refused', () => {
  const a = auth();
  assert.equal(a.loginWithToken(mint({ exp: Date.now() - 1 })), null);
  assert.equal(a.loginWithToken(mint({ exp: Date.now() + 60 * 60 * 1000 })), null, 'a link claiming an hour is not one of ours');
  assert.equal(a.loginWithToken(mint({ aud: 'something-else' })), null);
  assert.equal(a.loginWithToken(mint({ nonce: 'short' })), null);
  for (const junk of ['', 'abc', 'a.b.c', null, undefined, '.', 'e30.']) assert.equal(a.loginWithToken(junk), null);
});

test('a link signed with another secret, or tampered with, is refused', () => {
  const a = auth();
  assert.equal(a.loginWithToken(mint({}, 'not-the-secret')), null);
  const [body, sig] = mint().split('.');
  const forged = Buffer.from(JSON.stringify({ aud: SSO_AUDIENCE, sub: '999', exp: Date.now() + 60000, nonce: 'x'.repeat(32) })).toString('base64url');
  assert.equal(a.loginWithToken(`${forged}.${sig}`), null);
  assert.ok(a.loginWithToken(`${body}.${sig}`), 'the untouched one is still fine');
});

test('with no secret configured the link is off and the password still works', () => {
  const a = auth('');
  assert.equal(a.ssoEnabled, false);
  assert.equal(a.loginWithToken(mint()), null);
  assert.ok(a.login('letmein'));
});

test('GET /sso sets the session cookie and sends the browser to the control room', async () => {
  const ctx = createApp({
    dataDir: tmpDir(), env: { ADMIN_PASSWORD: 'letmein', INGEST_KEY: 'k', NODE_ENV: 'test', HFL_NN_SSO_SECRET: SECRET },
    tts: createTTS({ provider: 'silent' }), claude: { available: () => false, model: 'none', write: async () => { throw new Error('no'); } },
    debounceMs: 60 * 60 * 1000, logger: quiet,
  });
  const server = http.createServer(ctx.app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/sso?t=nope`, { redirect: 'manual' });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);

    const ok = await fetch(`${base}/sso?t=${mint()}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/control');
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const admin = await fetch(`${base}/api/admin/desk`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(admin.status, 200, 'the cookie opens the control room');
    const none = await fetch(`${base}/api/admin/desk`);
    assert.equal(none.status, 401);
  } finally {
    await new Promise(r => server.close(r));
    ctx.close?.();
  }
});
