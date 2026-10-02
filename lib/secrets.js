// Password hashing, session/recovery secrets, and at-rest encryption.
//
// Split out of server.js so it can be tested without starting a listener, and
// so there is exactly one place that decides how a secret is stored.
'use strict';
const crypto = require('crypto');

// ─── Passwords ────────────────────────────────────────────────────────────
// scrypt with a per-user salt. Low-entropy input, so the cost is the point.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ─── High-entropy secrets ─────────────────────────────────────────────────
// Session secrets and recovery codes are 128+ bits of randomness, so a fast
// digest is correct here — scrypt is for guessable inputs, not these.
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function newSecret() { return crypto.randomBytes(32).toString('base64url'); }
function hashEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Unambiguous alphabet — no O/0/I/1, because these get read aloud in Discord
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const g = () => Array.from(crypto.randomBytes(4)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${g()}-${g()}-${g()}`;
}
function normalizeCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ─── At-rest encryption (AES-256-GCM) ─────────────────────────────────────
// For values the server must be able to read back and use — a Discord webhook
// URL is a bearer credential: anyone holding it can post to the league channel.
// Storing it in plaintext means a leaked drafts.json hands it over.
//
// The key comes from SECRET_KEY. Without one set, encryption is derived from a
// per-install key file so a default deployment is still better than plaintext;
// callers can check `usingDerivedKey()` to warn about it.
let _key = null;
let _derived = false;

function configureKey({ secret, fallbackSeed } = {}) {
  if (secret && String(secret).length >= 16) {
    _key = crypto.createHash('sha256').update(String(secret)).digest();
    _derived = false;
  } else {
    _key = crypto.createHash('sha256').update(String(fallbackSeed || 'hfl-nn-local')).digest();
    _derived = true;
  }
  return { derived: _derived };
}
function usingDerivedKey() { return _derived; }
function keyReady() { return !!_key; }

const ENC_PREFIX = 'enc:v1:';

function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  if (!_key) throw new Error('secrets.configureKey() must be called first');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv, tag, ct].map(b => b.toString('base64')).join('.');
}

// Tolerates a plaintext value so an existing drafts.json keeps working; the
// caller re-saves it encrypted on next write.
function decryptSecret(stored) {
  if (stored == null || stored === '') return null;
  const s = String(stored);
  if (!s.startsWith(ENC_PREFIX)) return s;          // legacy plaintext
  if (!_key) throw new Error('secrets.configureKey() must be called first');
  try {
    const [ivB, tagB, ctB] = s.slice(ENC_PREFIX.length).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', _key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;   // wrong key or tampered — treat as absent, never throw mid-draft
  }
}
function isEncrypted(stored) { return typeof stored === 'string' && stored.startsWith(ENC_PREFIX); }

// What a client is allowed to see of a stored secret: enough to recognise it,
// not enough to use it.
function maskWebhook(url) {
  if (!url) return '';
  const m = String(url).match(/^https:\/\/discord\.com\/api\/webhooks\/(\d+)\//);
  if (m) return `https://discord.com/api/webhooks/${m[1]}/••••••••`;
  return '••••••••';
}

module.exports = {
  hashPassword, verifyPassword,
  sha256, newSecret, hashEq,
  newRecoveryCode, normalizeCode, CODE_ALPHABET,
  configureKey, usingDerivedKey, keyReady,
  encryptSecret, decryptSecret, isEncrypted, ENC_PREFIX,
  maskWebhook,
};
