// Control-room login: one commissioner password (ADMIN_PASSWORD), a session
// cookie, and a header check on every write so a cross-site form can't drive
// the control room.
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

function createAuth({ store, password, secure = false, logger = console }) {
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

  return { login, logout, sessionOf, cookie, requireAdmin, generatedPassword: generated ? password : null, COOKIE };
}

module.exports = { createAuth, parseCookies };
