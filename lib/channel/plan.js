// The day plan: today's programme, saved to channel/plan-<day>.json so a
// restart never reshuffles what is on air. When the library changes (an
// episode is published, re-voiced or pulled; a replay appears or expires)
// the rest of the day is rebuilt, but anything that has already started
// keeps its place.
//
// Live games are not in the plan: a member going live cuts in over whatever
// is scheduled (the player does that, from `live` in the guide), and the
// schedule carries on underneath for when the game ends.
//
// A cut-in (the Chat Check-In, lib/channel/scheduler.js) is not in the plan
// either. It goes on air a minute after it is published, over whatever is
// on, and the block it interrupts carries on afterwards where it would have
// been by then (`start` keeps that block's own clock). It waits for a new
// episode's premiere to finish rather than cut into it.
'use strict';
const { buildDay, blockAt, markReruns, newestFirst, airable, isCutIn } = require('./programme');
const { dayKey, nextDay, DAY_RE } = require('./clock');

const KEEP_DAYS = 3;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const PROGRAMME = new Set(['episode', 'replay', 'clip']);
const MINUTE = 60000;

// When each recent cut-in airs, given the schedule underneath: a minute
// after it was published, on the minute, after any premiere it would cut
// into and after the cut-in before it. One that cannot air within
// `keepHours` of being published is dropped.
function placeCutIns(blocks, episodes, config, t) {
  const out = [];
  const eps = episodes
    .filter(e => airable(e) && isCutIn(config, e) && Number.isFinite(Date.parse(e.publishedAt)))
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || String(a.id).localeCompare(String(b.id)));
  for (const e of eps) {
    const show = config.shows[e.channelShow];
    const pub = Date.parse(e.publishedAt);
    const keep = (Number(show.cutIn.keepHours) || 3) * 3600e3;
    if (t - pub > keep + 3600e3) continue;
    const len = Math.ceil(Number(e.duration) * 1000);
    let from = Math.ceil((pub + MINUTE) / MINUTE) * MINUTE;
    for (let i = 0; i < 6; i++) {
      const prev = out[out.length - 1];
      if (prev && prev.until > from) from = prev.until;
      const premiere = blocks.find(b => b.kind === 'episode' && !b.rerun && b.from < from + len && b.until > from);
      if (!premiere) break;
      from = premiere.until;
    }
    if (from - pub > keep) continue;
    out.push({ id: `cutin:${e.id}`, kind: 'episode', show: e.channelShow, showTitle: show.title, title: e.title || show.title, from, until: from + len, episodeId: e.id, type: e.type, rerun: false, cutIn: true });
  }
  return out;
}

// The schedule with the cut-ins in it: a block a cut-in lands in is split,
// and its second half keeps the first half's clock (`start`), so the show
// picks up where it would have been without the interruption.
function withCutIns(blocks, ins) {
  if (!ins.length) return blocks;
  const out = [];
  for (const b of blocks) {
    let pieces = [b];
    for (const c of ins) {
      pieces = pieces.flatMap(p => {
        if (c.until <= p.from || c.from >= p.until) return [p];
        const origin = p.start ?? p.from;
        return [
          ...(c.from > p.from ? [{ ...p, until: c.from }] : []),
          ...(c.until < p.until ? [{ ...p, id: `${p.id}~${c.id}`, from: c.until, start: origin }] : []),
        ];
      });
    }
    out.push(...pieces);
  }
  return [...out, ...ins].sort((a, b) => a.from - b.from || a.until - b.until);
}

// What the programme depends on: which episodes exist and how long they run,
// and which replays and clips can be played.
function signature(episodes, replays = []) {
  const eps = newestFirst(episodes.filter(airable)).map(e => `${e.id}:${Math.ceil(e.duration * 1000)}:${e.type}${e.channelShow ? `:${e.channelShow}` : ''}`).join('|');
  const rep = replays.map(r => `${r.id}:${r.duration}:${r.replayExpiresAt || ''}:${(r.clips || []).map(c => `${c.id}.${c.views}`).join(',')}`).join('|');
  return rep ? `${eps}||${rep}` : eps;
}

// Keep `old` up to and including whatever is on at `now`; take `fresh` after
// that. A fresh block already under way at the join becomes an ident.
function splice(old, fresh, now) {
  const kept = old.filter(b => b.from <= now);
  const cut = kept.length ? kept[kept.length - 1].until : -Infinity;
  const out = kept.map(b => ({ ...b }));
  for (const b of fresh) {
    if (b.until <= cut) continue;
    if (b.from >= cut) out.push({ ...b });
    else out.push({ id: b.id, kind: 'ident', show: b.show, showTitle: b.showTitle, title: b.showTitle, from: cut, until: b.until });
  }
  return markReruns(out.map((b, i) => ({ ...b, id: `${b.id.split('#')[0]}#${i}` })));
}

function createChannel({ store, config, getEpisodes, getReplays = () => [], getLive = () => [], now = Date.now, logger = console }) {
  const tz = config.timeZone;
  const cache = new Map();   // day → { day, sig, blocks }

  function today(t) {
    const day = dayKey(t, tz);
    const episodes = getEpisodes().filter(e => !isCutIn(config, e));
    const replays = getReplays();
    const sig = signature(episodes, replays);
    let plan = cache.get(day) || store.readJSON(`channel/plan-${day}.json`, null);
    if (plan?.sig !== sig || plan?.day !== day) {
      const fresh = buildDay({ day, config, episodes, replays });
      const blocks = plan?.day === day ? splice(plan.blocks, fresh, t) : fresh;
      plan = { day, sig, blocks };
      try {
        store.writeJSON(`channel/plan-${day}.json`, plan);
        for (const f of store.list('channel')) {
          const d = f.match(/^plan-(\d{4}-\d{2}-\d{2})\.json(\.bak)?$/)?.[1];
          if (d && d < nextDay(day, -KEEP_DAYS)) store.remove(`channel/${f}`);
        }
      } catch (e) { logger.warn(`[channel] could not save the plan: ${e.message}`); }
    }
    cache.clear();
    cache.set(day, plan);
    return plan;
  }

  // Blocks for any day. Only today is saved; other days are computed fresh,
  // so asking about them never writes to disk.
  function blocksFor(day) {
    if (!DAY_RE.test(day)) throw new Error(`bad day: ${day}`);
    const real = now();
    if (day === dayKey(real, tz)) return today(real).blocks;
    return buildDay({ day, config, episodes: getEpisodes().filter(e => !isCutIn(config, e)), replays: getReplays() });
  }

  const publicBlock = b => b && ({
    id: b.id, kind: b.kind, show: b.show, showTitle: b.showTitle, title: b.title, from: b.from, until: b.until,
    ...(b.start != null && b.start !== b.from ? { start: b.start } : {}),
    ...(b.cutIn ? { cutIn: true } : {}),
    ...(b.kind === 'episode' ? { episodeId: b.episodeId, type: b.type, rerun: !!b.rerun } : {}),
    ...(b.kind === 'replay' || b.kind === 'clip' ? { stream: b.stream, game: b.game } : {}),
    ...(b.kind === 'clip' ? { clipId: b.clipId } : {}),
  });

  // A live game as the player needs it. No scores: the Hub does not send a
  // live one, and the channel never guesses.
  const publicLive = s => ({
    id: s.id, title: `${s.game.awayName} at ${s.game.homeName}`, startedAt: Date.parse(s.startedAt),
    stream: { platform: s.platform, channel: s.channel, videoId: s.videoId, member: s.member },
    game: { away: s.game.away, home: s.game.home, awayName: s.game.awayName, homeName: s.game.homeName, season: s.game.season, stage: s.game.stage, week: s.game.week, gotw: !!s.game.gotw },
  });

  // What the player needs: the block on air, everything up to six hours
  // ahead, and any league game that is live right now (Game of the Week
  // first). `at` looks at another instant (dev and tests); live games are
  // only ever reported for the real present.
  function guide(at) {
    const t = Number.isFinite(at) ? at : now();
    const day = dayKey(t, tz);
    const regular = [...blocksFor(day), ...blocksFor(nextDay(day))];
    const blocks = withCutIns(regular, placeCutIns(regular, getEpisodes(), config, t));
    const on = blockAt(blocks, t);
    const upcoming = blocks.filter(b => b.from > t && b.from < t + WINDOW_MS);
    const next = upcoming.find(b => PROGRAMME.has(b.kind)) || null;
    return {
      now: t, timeZone: tz, day,
      onNow: publicBlock(on),
      upNext: publicBlock(next),
      blocks: [on, ...upcoming].filter(Boolean).map(publicBlock),
      live: Number.isFinite(at) ? [] : getLive(t).map(publicLive),
      shows: Object.fromEntries(Object.entries(config.shows).map(([k, s]) => [k, { title: s.title, blurb: s.blurb || '' }])),
    };
  }

  // The whole day's listings, for the guide panel: every programme, with a
  // run of clips shown as one entry.
  function listings(at) {
    const t = Number.isFinite(at) ? at : now();
    const day = dayKey(t, tz);
    const rows = [];
    for (const b of blocksFor(day)) {
      if (!PROGRAMME.has(b.kind)) continue;
      const prev = rows[rows.length - 1];
      if (b.kind === 'clip' && prev?.kind === 'clips' && prev.until === b.from) { prev.until = b.until; prev.count++; prev.title = `${prev.count} clips from league games`; continue; }
      rows.push(b.kind === 'clip'
        ? { id: b.id, kind: 'clips', show: b.show, showTitle: b.showTitle, title: '1 clip from a league game', from: b.from, until: b.until, count: 1 }
        : publicBlock(b));
    }
    return { now: t, timeZone: tz, day, blocks: rows };
  }

  return { guide, listings, blocksFor, reset: () => cache.clear() };
}

module.exports = { createChannel, splice, signature, placeCutIns, withCutIns };
