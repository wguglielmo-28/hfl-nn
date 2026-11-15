// Control-room login: one commissioner password (ADMIN_PASSWORD), a session
// cookie, and a header check on every write so a cross-site form can't drive
// the control room.
//
// A commissioner already signed in to the HFL Hub can also arrive with a
// short-lived signed link (GET /sso?t=...). The Hub mints it for league
// admins only, with a secret both apps hold (HFL_NN_SSO_SECRET). It is good
// for one use within a minute, and ends in the same session cookie the
// password gives. Without the secret set, the link is simply refused and the
// password is the only way in.
'use strict';
const crypto = require('crypto');
const secrets = require('./secrets');

const COOKIE = 'hflnn_session';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SSO_AUDIENCE = 'hfl-nn-control';
const SSO_MAX_LIFE_MS = 5 * 60 * 1000; // refuse anything claiming to live longer

function createAuth({ store, password, ssoSecret = '', secure = false, logger = console }) {
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  // Compare digests in constant time; the password itself is never stored.
  const pwDigest = secrets.sha256(password);

  // Sessions survive restarts (stored as digests, never the raw token).
  const sessions = new Map(Object.entries(store.readJSON('sessions.json', {})));
  const persist = () => store.writeJSON('sessions.json', Object.fromEntries(sessions));
  const sweep = () => {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of sessions) if (now - s.created > TTL_MS) { sessions.delete(k); changed = true; }
    if (changed) persist();
  };
  sweep();

  function login(attempt) {
    if (!secrets.hashEq(secrets.sha256(String(attempt || '')), pwDigest)) return null;
    const token = secrets.newSecret();
    sessions.set(secrets.sha256(token), { created: Date.now() });
    persist();
    return token;
  }

  // token = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, that first part))
  // payload = { aud, sub, exp (ms), nonce }
  const usedNonces = new Map(); // nonce -> exp, so a link works once
  function loginWithToken(raw, now = Date.now()) {
    if (!ssoSecret) return null;
    const [body, sig, extra] = String(raw || '').split('.');
    if (!body || !sig || extra !== undefined) return null;
    const want = crypto.createHmac('sha256', ssoSecret).update(body).digest('base64url');
    if (!secrets.hashEq(want, sig)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!p || p.aud !== SSO_AUDIENCE || typeof p.exp !== 'number' || typeof p.nonce !== 'string' || p.nonce.length < 16) return null;
    if (p.exp <= now || p.exp > now + SSO_MAX_LIFE_MS) return null;
    for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
    if (usedNonces.has(p.nonce)) return null;
    usedNonces.set(p.nonce, p.exp);
    const token = secrets.newSecret();
    sessions.set(secrets.sha256(token), { created: now, via: 'hub', sub: String(p.sub ?? '').slice(0, 40) });
    persist();
    return token;
  }

  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = sessions.get(secrets.sha256(token));
    if (!s || Date.now() - s.created > TTL_MS) return null;
    return s;
  }

  function logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && sessions.delete(secrets.sha256(token))) persist();
  }

  function cookie(token, maxAgeMs = TTL_MS) {
    return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  // Reads need a session; writes also need the X-HFLNN header, which a
  // cross-site <form> or <img> can't send.
  function requireAdmin(req, res, next) {
    if (!sessionOf(req)) return res.status(401).json({ error: 'Log in to the control room first.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-hflnn') !== '1') return res.status(403).json({ error: 'Missing control-room header.' });
    next();
  }

  if (generated) {
    logger.warn(`\n  ⚠  ADMIN_PASSWORD is not set. Control room password for this run: ${password}\n     Set ADMIN_PASSWORD to choose a permanent one.\n`);
  }
  setInterval(sweep, 60 * 60 * 1000).unref();

  return { login, loginWithToken, ssoEnabled: !!ssoSecret, logout, sessionOf, cookie, requireAdmin, generatedPassword: generated ? password : null, COOKIE };
}

module.exports = { createAuth, parseCookies, SSO_AUDIENCE };
