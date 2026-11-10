// The day plan: today's programme, saved to channel/plan-<day>.json so a
// restart never reshuffles what is on air. When the library changes (an
// episode is published, re-voiced or pulled) the rest of the day is rebuilt,
// but anything that has already started keeps its place.
'use strict';
const { buildDay, blockAt, markReruns, newestFirst, airable } = require('./programme');
const { dayKey, nextDay, DAY_RE } = require('./clock');

const KEEP_DAYS = 3;
const WINDOW_MS = 6 * 60 * 60 * 1000;

// What the programme depends on: which episodes exist and how long they run.
const signature = episodes => newestFirst(episodes.filter(airable)).map(e => `${e.id}:${Math.ceil(e.duration * 1000)}:${e.type}`).join('|');

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

function createChannel({ store, config, getEpisodes, now = Date.now, logger = console }) {
  const tz = config.timeZone;
  const cache = new Map();   // day → { day, sig, blocks }

  function today(t) {
    const day = dayKey(t, tz);
    const episodes = getEpisodes();
    const sig = signature(episodes);
    let plan = cache.get(day) || store.readJSON(`channel/plan-${day}.json`, null);
    if (plan?.sig !== sig || plan?.day !== day) {
      const fresh = buildDay({ day, config, episodes });
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
    return buildDay({ day, config, episodes: getEpisodes() });
  }

  const publicBlock = b => b && ({
    id: b.id, kind: b.kind, show: b.show, showTitle: b.showTitle, title: b.title, from: b.from, until: b.until,
    ...(b.kind === 'episode' ? { episodeId: b.episodeId, type: b.type, rerun: !!b.rerun } : {}),
  });

  // What the player needs: the block on air, and everything up to six hours
  // ahead. `at` looks at another instant (dev and tests).
  function guide(at) {
    const t = Number.isFinite(at) ? at : now();
    const day = dayKey(t, tz);
    const blocks = [...blocksFor(day), ...blocksFor(nextDay(day))];
    const on = blockAt(blocks, t);
    const upcoming = blocks.filter(b => b.from > t && b.from < t + WINDOW_MS);
    const next = upcoming.find(b => b.kind === 'episode') || null;
    return {
      now: t, timeZone: tz, day,
      onNow: publicBlock(on),
      upNext: publicBlock(next),
      blocks: [on, ...upcoming].filter(Boolean).map(publicBlock),
      shows: Object.fromEntries(Object.entries(config.shows).map(([k, s]) => [k, { title: s.title, blurb: s.blurb || '' }])),
    };
  }

  // The whole day's listings (episodes only), for the guide panel.
  function listings(at) {
    const t = Number.isFinite(at) ? at : now();
    const day = dayKey(t, tz);
    return { now: t, timeZone: tz, day, blocks: blocksFor(day).filter(b => b.kind === 'episode').map(publicBlock) };
  }

  return { guide, listings, blocksFor, reset: () => cache.clear() };
}

module.exports = { createChannel, splice, signature };
