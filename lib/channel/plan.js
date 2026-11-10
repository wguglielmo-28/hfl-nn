// The day plan: today's programme, saved to channel/plan-<day>.json so a
// restart never reshuffles what is on air. When the library changes (an
// episode is published, re-voiced or pulled; a replay appears or expires)
// the rest of the day is rebuilt, but anything that has already started
// keeps its place.
//
// Live games are not in the plan: a member going live cuts in over whatever
// is scheduled (the player does that, from `live` in the guide), and the
// schedule carries on underneath for when the game ends.
'use strict';
const { buildDay, blockAt, markReruns, newestFirst, airable } = require('./programme');
const { dayKey, nextDay, DAY_RE } = require('./clock');

const KEEP_DAYS = 3;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const PROGRAMME = new Set(['episode', 'replay', 'clip']);

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
    const episodes = getEpisodes();
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
    return buildDay({ day, config, episodes: getEpisodes(), replays: getReplays() });
  }

  const publicBlock = b => b && ({
    id: b.id, kind: b.kind, show: b.show, showTitle: b.showTitle, title: b.title, from: b.from, until: b.until,
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
    const blocks = [...blocksFor(day), ...blocksFor(nextDay(day))];
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

module.exports = { createChannel, splice, signature };
