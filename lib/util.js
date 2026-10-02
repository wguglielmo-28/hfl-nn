// Small shared helpers with no dependencies.
'use strict';
const crypto = require('crypto');

// Madden sends some signed values as unsigned bytes: a two-game losing streak
// arrives as 254. Anything above 127 is negative.
function toSigned8(v) {
  const n = Number(v) || 0;
  return n > 127 ? n - 256 : n;
}

// Team colors arrive as 24-bit integers (2364255 → #24135f).
function colorHex(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '#000000';
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

// Perceived brightness, 0–255 — picks black or white text on a team color.
function luminance(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Deterministic PRNG (mulberry32) so the template writer and the player's idle
// animation are reproducible for a given seed.
function seededRandom(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashInt(String(seed));
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pick(rand, arr) { return arr[Math.floor(rand() * arr.length) % arr.length]; }

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// "$96.1M" style money for graphics; contract values arrive in whole dollars.
function money(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
  return '$' + v;
}

function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

function nowIso() { return new Date().toISOString(); }

// Fold accents and smart punctuation so text fits the player's bitmap font and
// reads cleanly through TTS.
function asciiFold(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ');
}

module.exports = {
  toSigned8, colorHex, luminance, seededRandom, hashInt, pick, sha256, ordinal, clamp, slug, money,
  wordCount, nowIso, asciiFold,
};
