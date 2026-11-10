// The programme: what is on the channel, as a pure function of the day, the
// grid (config/channel.json) and the published episodes. No clock, no I/O —
// the same inputs always give the same day, so every viewer and every restart
// agree on what is on air.
//
// A day is a list of blocks that cover it exactly, with no gaps or overlaps:
//   { id, kind: 'episode', show, showTitle, title, from, until, episodeId, type, rerun }
//   { id, kind: 'ident',   show, showTitle, title, from, until }   filler up to the next start
//   { id, kind: 'standby', show, showTitle, title, from, until }   nothing to air
// Times are epoch milliseconds.
'use strict';
const { wallToMs, dayStart, nextDay, dayNumber } = require('./clock');

const airable = e => !!e && Number(e.duration) > 0;
// When an episode went out; one with no usable date counts as always there.
const publishedMs = e => { const t = Date.parse(e.publishedAt); return Number.isFinite(t) ? t : -Infinity; };
// A daily show made for the channel (ep.channelShow) belongs to that show
// alone, plus any catch-all show; everything else goes by episode type.
const matches = (show, ep, key) => show.types.includes('*') || (ep.channelShow ? ep.channelShow === key : show.types.includes(ep.type));
const DAILY_KEEP_DAYS = 2;

// Newest first, with the id as a tiebreak so the order never depends on how
// the index happened to be sorted.
function newestFirst(episodes) {
  return [...episodes].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)) || String(b.id).localeCompare(String(a.id)));
}

function validateConfig(config) {
  const errs = [];
  if (!config?.timeZone) errs.push('timeZone is missing');
  if (!Array.isArray(config?.grid) || !config.grid.length) errs.push('grid is empty');
  for (const s of config?.grid || []) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) errs.push(`bad slot time: ${s.at}`);
    if (!config.shows?.[s.show]) errs.push(`slot ${s.at} names an unknown show: ${s.show}`);
  }
  for (const [k, s] of Object.entries(config?.shows || {})) {
    if (s.kind && !['replay', 'clips'].includes(s.kind)) errs.push(`show ${k} has an unknown kind: ${s.kind}`);
    if (!Array.isArray(s.types)) errs.push(`show ${k} needs a types list (it may be empty)`);
    if (s.produce && (!Array.isArray(s.produce.kinds) || !s.produce.kinds.length)) errs.push(`show ${k} is produced daily but lists no segment kinds`);
  }
  if ((config?.grid || [])[0]?.at !== '00:00') errs.push('the first slot must start at 00:00');
  const times = (config?.grid || []).map(s => s.at);
  if (times.some((t, i) => i && t <= times[i - 1])) errs.push('slots must be in time order');
  if (errs.length) throw new Error(`config/channel.json: ${errs.join('; ')}`);
  return config;
}

// ── Footage: members' game streams (lib/ingest/streams.js) ────────────────
const MIN_REPLAY_MS = 10 * 60000;   // not worth starting a game with less than this left
const CLIP_PAD_MS = 2000;           // the embedded player needs a moment to start
const CLIP_DAYS = 14;
const CLIPS_PER_REEL = 20;

const gameOf = g => ({ away: g.away, home: g.home, awayName: g.awayName, homeName: g.homeName, season: g.season, stage: g.stage, week: g.week, gotw: !!g.gotw });
const gameTitle = g => `${g.awayName} at ${g.homeName}`;

// Replays, newest game first, turned so each slot and day leads with a different one.
function replayQueue(replays, turn) {
  const list = replays.filter(r => r.duration * 1000 >= MIN_REPLAY_MS);
  const k = list.length ? turn % list.length : 0;
  return [...list.slice(k), ...list.slice(0, k)].map(r => ({
    kind: 'replay', lenMs: r.duration * 1000, availableMs: Date.parse(r.endedAt),
    expiresMs: r.replayExpiresAt ? Date.parse(r.replayExpiresAt) : null,
    title: gameTitle(r.game), game: gameOf(r.game),
    stream: { platform: r.platform, channel: r.channel, videoId: r.videoId, member: r.member },
  }));
}

// The most-watched clips of the last two weeks, one reel.
function clipQueue(replays, dayEnd) {
  const since = dayEnd - (CLIP_DAYS + 1) * 86400000;
  return replays
    .filter(r => Date.parse(r.startedAt) >= since)
    .flatMap(r => (r.clips || []).map(c => ({ c, r })))
    .sort((a, b) => b.c.views - a.c.views || String(b.c.createdAt).localeCompare(String(a.c.createdAt)) || a.c.id.localeCompare(b.c.id))
    .slice(0, CLIPS_PER_REEL)
    .map(({ c, r }) => ({
      kind: 'clip', lenMs: Math.ceil(c.duration * 1000) + CLIP_PAD_MS,
      availableMs: Math.max(Date.parse(r.endedAt), Date.parse(c.createdAt) || 0), expiresMs: null,
      title: c.title || gameTitle(r.game), game: gameOf(r.game), clipId: c.id,
      stream: { platform: 'twitch', channel: r.channel, member: r.member },
    }));
}

function buildDay({ day, config, episodes = [], replays = [] }) {
  const tz = config.timeZone;
  const alignMs = Math.max(1, Number(config.alignMinutes) || 5) * 60000;
  const start = dayStart(day, tz);
  const end = dayStart(nextDay(day), tz);
  // Daily shows go stale: each is dropped from the schedule once it is older
  // than its show's keepDays.
  const keeps = e => !e.channelShow || end - Date.parse(e.publishedAt) <= ((config.shows[e.channelShow]?.keepDays ?? DAILY_KEEP_DAYS) + 1) * 86400000;
  const library = newestFirst(episodes.filter(e => airable(e) && keeps(e)));
  const dayN = dayNumber(day);
  const tidyUp = t => start + Math.ceil((t - start) / alignMs) * alignMs;
  const blocks = [];
  let seq = 0;
  let replaySlots = 0;   // so each replay slot of the day leads with a different game
  let last = null;   // the episode that aired last, carried across slots so filler never repeats it
  const push = b => { if (b.until > b.from) blocks.push({ id: `${day}#${seq++}`, ...b }); };

  config.grid.forEach((slot, si) => {
    const show = config.shows[slot.show];
    // On the two clock-change days a slot can come out empty or reversed; clamp.
    const from = Math.max(start, Math.min(end, wallToMs(day, slot.at, tz)));
    const next = config.grid[si + 1];
    const until = next ? Math.max(from, Math.min(end, wallToMs(day, next.at, tz))) : end;
    if (until <= from) return;
    const head = { show: slot.show, showTitle: show.title };
    const fill = config.shows[config.filler] ? { show: config.filler, showTitle: config.shows[config.filler].title } : head;
    // A footage show (kind 'replay' or 'clips') leads its slot with members'
    // game streams; whatever time is left goes to episodes as usual.
    const footage = show.kind === 'replay' ? replayQueue(replays, dayN + replaySlots++) : show.kind === 'clips' ? clipQueue(replays, end) : [];
    if (!library.length && !footage.length) return push({ ...head, kind: 'standby', title: 'Stand by', from, until });
    let f = 0;
    // It cannot air before the stream ended, a replay must outlast its
    // airing, and a clip is never cut short.
    const airs = (it, at) => it.availableMs <= at
      && (it.expiresMs == null || it.expiresMs >= Math.min(until, at + it.lenMs))
      && (it.kind === 'replay' ? until - at >= MIN_REPLAY_MS : it.lenMs <= until - at);

    // A slot opens with the show's own episodes, each once: 'latest' newest
    // first, 'rotate' from somewhere new each slot and day. When they run out,
    // the rest of the slot is filled from the whole library, in rotation.
    const own = library.filter(e => matches(show, e, slot.show));
    let i = show.order === 'rotate' && own.length ? (dayN * 7 + si * 3) % own.length : 0;
    let j = library.length ? (dayN * 7 + si * 3) % library.length : 0;
    const used = new Set();
    let cursor = from;
    while (cursor < until) {
      const left = until - cursor;
      let shot = null;
      while (f < footage.length && !shot) { const it = footage[f++]; if (airs(it, cursor)) shot = it; }
      if (shot) {
        const len = Math.min(shot.lenMs, left);   // a long game is cut off at the end of its slot
        push({
          ...head, kind: shot.kind, title: shot.title, from: cursor, until: cursor + len,
          stream: shot.stream, game: shot.game, ...(shot.clipId ? { clipId: shot.clipId } : {}),
        });
        cursor += len;
        last = null;
        // Clips run back to back; anything else is followed by a tidy start.
        const reelGoesOn = shot.kind === 'clip' && footage.slice(f).some(it => airs(it, cursor));
        const tidy = Math.min(until, tidyUp(cursor));
        if (!reelGoesOn && tidy > cursor) { push({ ...head, kind: 'ident', title: show.title, from: cursor, until: tidy }); cursor = tidy; }
        continue;
      }
      const fits = e => Math.ceil(e.duration * 1000) <= left && publishedMs(e) <= cursor;   // it cannot air before it exists
      let pick = null, label = head;
      // A rotating show steps past whatever just aired; a 'latest' show
      // always leads with its newest, whatever came before.
      for (const allowRepeat of show.order === 'rotate' ? [false, true] : [true]) {
        for (let k = 0; k < own.length && !pick; k++) {
          const e = own[(i + k) % own.length];
          if (used.has(e.id) || !fits(e) || (e.id === last && !allowRepeat)) continue;
          pick = e; i = (i + k + 1) % own.length;
        }
      }
      // Filler never repeats what just aired if anything else fits.
      for (const allowRepeat of pick ? [] : [false, true]) {
        for (let k = 0; k < library.length && !pick; k++) {
          const e = library[(j + k) % library.length];
          if (!fits(e) || (e.id === last && !allowRepeat)) continue;
          pick = e; j = (j + k + 1) % library.length; label = matches(show, e, slot.show) ? head : fill;
        }
      }
      if (!pick) {
        // Nothing fits. Fill up to the end of the slot, or to the moment the
        // next episode of the day is published, whichever comes first.
        const soon = Math.min(...library.map(publishedMs).filter(p => p > cursor && p < until), Infinity);
        const to = Number.isFinite(soon) ? Math.min(until, tidyUp(soon)) : until;
        const anything = library.some(e => publishedMs(e) <= cursor);
        push({ ...head, kind: anything ? 'ident' : 'standby', title: anything ? show.title : 'Stand by', from: cursor, until: to });
        cursor = to;
        last = null;
        continue;
      }
      const len = Math.ceil(pick.duration * 1000);
      push({
        ...label, kind: 'episode', title: pick.title, from: cursor, until: cursor + len,
        episodeId: pick.id, type: pick.type, fresh: isFresh(pick, day, tz),
      });
      used.add(pick.id);
      last = pick.id;
      cursor += len;
      // Programmes start on a tidy boundary; an ident fills the seconds between.
      const tidy = Math.min(until, tidyUp(cursor));
      if (tidy > cursor) { push({ ...label, kind: 'ident', title: label.showTitle, from: cursor, until: tidy }); cursor = tidy; }
    }
  });
  return markReruns(blocks);
}

// An airing is an encore unless it is the day's first showing of a fresh
// episode. Run again after two days' plans are joined (plan.js).
function markReruns(blocks) {
  const aired = new Set();
  for (const b of blocks) {
    if (b.kind !== 'episode') continue;
    b.rerun = aired.has(b.episodeId) || !b.fresh;
    aired.add(b.episodeId);
  }
  return blocks;
}

// A premiere is an episode published on the day it airs (or the day before,
// so a late-night show still premieres the next morning).
function isFresh(ep, day, tz) {
  const t = Date.parse(ep.publishedAt);
  if (!Number.isFinite(t)) return false;
  return t >= dayStart(nextDay(day, -1), tz);
}

// The block on air at `t` (binary search; blocks are sorted and contiguous).
function blockAt(blocks, t) {
  let lo = 0, hi = blocks.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].from <= t) { found = blocks[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found && t < found.until ? found : null;
}

module.exports = { buildDay, blockAt, markReruns, validateConfig, newestFirst, airable };
