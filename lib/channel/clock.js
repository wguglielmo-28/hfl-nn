// Channel time. The channel runs on wall-clock time in one fixed zone
// (config/channel.json → timeZone), so "8:00 PM" is the same slot for every
// viewer and stays put across daylight saving. Everything here is pure: the
// caller passes the instant in.
'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

// The wall-clock fields of an instant in a zone.
function wallParts(ms, tz) {
  const p = {};
  for (const { type, value } of partsFmt(tz).formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(value);
  return p;
}

// Minutes the zone is ahead of UTC at that instant.
function offsetMinutes(ms, tz) {
  const p = wallParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// 'YYYY-MM-DD' of an instant in a zone.
function dayKey(ms, tz) {
  const p = wallParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// The instant of a wall-clock time on a day. A time skipped by the spring
// clock change lands on the first real minute after it.
function wallToMs(day, hhmm, tz) {
  if (!DAY_RE.test(day)) throw new Error(`bad day: ${day}`);
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi || 0);
  let ms = guess - offsetMinutes(guess, tz) * 60000;
  ms = guess - offsetMinutes(ms, tz) * 60000;   // settle across a clock change
  return ms;
}

const dayStart = (day, tz) => wallToMs(day, '00:00', tz);

// The calendar day after `day` (pure date arithmetic, no zone involved).
function nextDay(day, n = 1) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// Days since 1970-01-01 — a stable number to rotate the re-air order by.
const dayNumber = day => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000);

module.exports = { DAY_RE, wallParts, offsetMinutes, dayKey, wallToMs, dayStart, nextDay, dayNumber };
