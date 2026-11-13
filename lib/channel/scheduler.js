// The channel's live shows. Each show in config/channel.json with a
// `produce` block is written, voiced and published shortly before the slots
// it lists (`produce.slots`, default: its first slot of the day) — if, and
// only if, every one of these holds:
//
//   • Settings → "Make the daily shows for the channel automatically" is on
//   • the league is not in the preseason (the commissioner reviews those)
//   • there is something new to say: at least `minFresh` stories this show
//     has not covered yet, counting the games of the week being played
//     (`needs` narrows it: The Wire waits for a new result)
//   • `skipIfNew` says nothing else is new tonight (HFL-NN Tonight's
//     nightly edition stands aside on the night the weekly show comes out)
//   • today's spend on script writing, across every episode, plus this
//     show's estimate, is still inside the daily cap
//
// The league advances every 72 hours and its games are played in between.
// These shows cover those games as they come in (lib/stories.js
// liveWeekStories), long before the weekly show, which still treats the week
// as unplayed until it is final.
//
// Each edition is attempted at most once a day. A script that fails, or
// needs fixes, is left for the commissioner; nothing is retried, so a bad day
// can never loop and spend. When an edition is not made, its slot airs the
// show's last episode, or the vault.
//
// They are side shows: voiced with the free local voices, and publishing one
// does not use up wire stories, touch the show's memory or post to Discord
// (lib/producer.js), so the weekly show loses nothing.
'use strict';
const { dayKey, dayStart, nextDay, wallToMs } = require('./clock');

const STORY_DAYS = 7;        // older wire stories are not news
const AIRED_KEEP = 800;      // story ids remembered per show
const LOG_KEEP = 80;

// Said to the writers on every live show.
const LIVE_NOTE = 'A live show on the HFL-NN 24/7 channel. The league advances every 72 hours and members play their games in between: games marked final in the facts were played this week, before the advance, and the rest of the week is still to be played. Say "so far this week" about them, never call the week final, and never name Players of the Week. Use only the scores and stat lines in the facts. There is no play-by-play, so never describe a play, a drive, a quarter, a turning point or any moment that is not in the facts. Keep it moving and full: this show has a long slot to fill, so give every segment its full length with real analysis, arguments and callbacks rather than repeating the same facts.';

function createScheduler({ store, config, producer, getSettings, now = Date.now, logger = console }) {
  const tz = config.timeZone;
  // channel/daily.json: { made: { '<day>:<show>[@HH:MM]': { episodeId, at } }, aired: { <show>: [storyId…] }, log: [...] }
  let state = { made: {}, aired: {}, log: [], ...store.readJSON('channel/daily.json', {}) };
  const save = () => store.writeJSON('channel/daily.json', state);
  let lastNote = {};

  // One line per decision, and only when it changes: this runs every minute.
  function note(key, outcome, detail = {}) {
    const text = `${outcome}${detail.reason ? `: ${detail.reason}` : ''}`;
    if (lastNote[key] === text) return;
    lastNote[key] = text;
    state.log = [{ at: new Date(now()).toISOString(), key, outcome, ...detail }, ...state.log].slice(0, LOG_KEEP);
    save();
    logger.log(`[channel] ${key} ${text}`);
  }

  const producedShows = () => Object.entries(config.shows).filter(([, s]) => s.produce);

  // The editions of a show on a day: one per slot it is made for. A show made
  // once a day keeps the plain '<day>:<show>' id.
  function editions(key, show, day) {
    const mine = config.grid.filter(g => g.show === key).map(g => g.at);
    const wanted = (show.produce.slots || mine.slice(0, 1)).filter(at => mine.includes(at));
    return wanted.map(at => ({
      id: wanted.length > 1 ? `${day}:${key}@${at}` : `${day}:${key}`,
      at, slot: wallToMs(day, at, tz),
    }));
  }

  // Stories this show has not covered: the week being played first (always
  // current), then the last week of wire stories, biggest first within each.
  function freshStories(showKey, t, max) {
    const aired = new Set(state.aired[showKey] || []);
    return producer.liveStories()
      .filter(s => !aired.has(s.id) && (s.live || t - Date.parse(s.createdAt) < STORY_DAYS * 86400000))
      .sort((a, b) => (!!b.live - !!a.live) || b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max);
  }

  function budget(t = now()) {
    const day = dayKey(t, tz);
    const spent = producer.spentBetween(dayStart(day, tz), dayStart(nextDay(day), tz));
    const cap = Number(getSettings().dailyCapUsd) || 0;
    return { day, spent, cap, left: Math.max(0, Math.round((cap - spent) * 10000) / 10000) };
  }

  // Something listed in `skipIfNew` came out in the last `hours`: the episode
  // types (e.g. the weekly) that make this edition unnecessary tonight.
  function newer(show, t) {
    const rule = show.produce.skipIfNew;
    if (!rule?.types?.length) return null;
    const since = t - (Number(rule.hours) || 20) * 3600e3;
    return producer.published().find(e => rule.types.includes(e.type) && !e.channelShow && Date.parse(e.publishedAt) >= since) || null;
  }

  // Called every minute. Starts at most one show per call.
  function tick() {
    const t = now();
    const settings = getSettings();
    if (!settings.channelAuto) return { made: null, reason: 'off' };
    if (producer.held()) { note('channel', 'held', { reason: 'preseason: the commissioner reviews every script' }); return { made: null, reason: 'held' }; }
    if (producer.busy()) return { made: null, reason: 'busy' };
    const day = dayKey(t, tz);
    for (const [key, show] of producedShows()) {
      const p = show.produce;
      const lead = (Number(p.leadMinutes) || 45) * 60000;
      for (const ed of editions(key, show, day)) {
        const id = ed.id;
        if (state.made[id]) continue;
        // Only in the run-up to the slot. A missed window (the server was
        // down) is not made up late: the show would be stale by the next one.
        if (t < ed.slot - lead || t >= ed.slot) continue;

        const fresh = newer(show, t);
        if (fresh) { note(id, 'skipped', { reason: `"${fresh.title}" is new tonight` }); continue; }

        const stories = freshStories(key, t, Number(p.maxStories) || 12);
        // `needs` narrows what counts as new (The Wire waits for a new result).
        const minFresh = Number(p.minFresh) || 1;
        // A "new result" is a game of the latest week, not an old one still on the wire.
        const counted = p.needs?.length ? stories.filter(s => p.needs.includes(s.type) && (s.type !== 'game' || s.live)) : stories;
        const what = p.needs?.includes('game') ? ['new result', 'new results'] : ['fresh story', 'fresh stories'];
        if (counted.length < minFresh) { note(id, 'skipped', { reason: `nothing new (${counted.length} ${counted.length === 1 ? what[0] : what[1]}, needs ${minFresh})` }); continue; }

        // The daily shows always fall back: a writer out of credits hands over
        // to the other one, then the free template.
        const writer = producer.pickWriter(settings.channelWriter || 'auto', { fallback: true });
        const est = writer === 'template' ? 0 : Number(p.estUsd) || 0.25;
        const b = budget(t);
        if (est > 0 && b.spent + est > b.cap) { note(id, 'skipped', { reason: `daily cap: $${b.spent.toFixed(2)} spent of $${b.cap.toFixed(2)}, this show is about $${est.toFixed(2)}` }); continue; }

        let ep;
        try {
          ep = producer.createEpisode({
            type: 'custom', customKinds: p.kinds, title: show.title, storyIds: stories.map(s => s.id), notes: LIVE_NOTE,
            writer: settings.channelWriter || 'auto', fallback: true, auto: true,
            channel: { show: key, day, live: true, minutes: p.minutes || null, maxRecaps: p.maxRecaps ?? null },
            chain: { voice: true, publish: true },
          });
        } catch (e) {
          // Recorded as made so a show that cannot be built is not retried all morning.
          state.made[id] = { episodeId: null, at: new Date(t).toISOString(), error: e.message };
          note(id, 'failed', { reason: e.message });
          continue;
        }
        state.made[id] = { episodeId: ep.id, at: new Date(t).toISOString(), writer };
        // Every story the show was offered counts as covered, placed in a
        // segment or not; otherwise the ones it passed over would be offered
        // again every time and the show would never run out of "news".
        state.aired[key] = [...new Set([...stories.map(x => x.id), ...(state.aired[key] || [])])].slice(0, AIRED_KEEP);
        // Keep a fortnight of "made" records.
        const cutoff = nextDay(day, -14);
        for (const k of Object.keys(state.made)) if (k.slice(0, 10) < cutoff) delete state.made[k];
        note(id, 'started', { episodeId: ep.id, writer, stories: stories.length });
        return { made: ep.id, show: key, edition: id };
      }
    }
    return { made: null, reason: 'nothing due' };
  }

  // For the control room: today's budget, and where each edition stands.
  function status() {
    const t = now();
    const day = dayKey(t, tz);
    return {
      auto: !!getSettings().channelAuto, held: producer.held(), ...budget(t),
      writer: producer.pickWriter(getSettings().channelWriter || 'auto', { fallback: true }),
      writers: producer.writerChain(getSettings().channelWriter || 'auto', { fallback: true }),
      shows: producedShows().flatMap(([key, show]) => editions(key, show, day).map(ed => ({
        key, edition: ed.id, title: show.title, slot: ed.slot, made: state.made[ed.id] || null,
        estUsd: Number(show.produce.estUsd) || 0.25, minutes: show.produce.minutes || null,
        today: today(show, ed, t),
      }))),
      log: state.log.slice(0, 20),
    };
  }

  // Where one edition stands today, in words the control room can print:
  //   waiting  its run-up has not started          due      in its run-up, not made yet (reason says why)
  //   made     written, voiced and published       working  being written or voiced
  //   stuck    the script needs the commissioner   failed   could not be built or written
  //   missed   its slot passed without a show (reason: the last thing the scheduler said)
  function today(show, ed, t) {
    const said = state.log.find(l => l.key === ed.id && l.outcome === 'skipped')?.reason || null;
    const made = state.made[ed.id];
    if (made) {
      const ep = made.episodeId ? producer.get(made.episodeId) : null;
      if (!ep) return { state: 'failed', reason: made.error || 'the episode was removed', episodeId: made.episodeId || null };
      const cost = [ep.writer, ...(ep.writer?.history || [])].reduce((n, w) => n + (Number.isFinite(w?.costUsd) ? w.costUsd : 0) + (Number.isFinite(w?.failedCostUsd) ? w.failedCostUsd : 0), 0);
      const base = { episodeId: ep.id, title: ep.title, writer: ep.writer?.kind || made.writer || null, ...(ep.writer?.fallbackFrom ? { fallbackFrom: ep.writer.fallbackFrom } : {}), costUsd: Math.round(cost * 10000) / 10000, at: made.at, ...(ep.audio?.duration ? { seconds: Math.round(ep.audio.duration) } : {}) };
      if (ep.status === 'published') return { state: 'made', ...base };
      if (ep.status === 'failed') return { state: 'failed', reason: ep.error || 'the script could not be written', ...base };
      if (['writing', 'voicing'].includes(ep.status)) return { state: 'working', reason: ep.status, ...base };
      return { state: 'stuck', reason: ep.status === 'needs_fixes' ? 'the script needs fixes before it can be voiced' : `left as ${ep.status}`, ...base };
    }
    const lead = (Number(show.produce.leadMinutes) || 45) * 60000;
    if (t >= ed.slot) return { state: 'missed', reason: said || (getSettings().channelAuto ? 'the server was not running in the run-up' : 'daily shows are switched off') };
    if (t >= ed.slot - lead) return { state: 'due', reason: said };
    return { state: 'waiting', reason: null, startsAt: ed.slot - lead };
  }

  function reset() { state = { made: {}, aired: {}, log: [] }; lastNote = {}; store.remove('channel/daily.json'); store.remove('channel/daily.json.bak'); }

  return { tick, status, budget, freshStories, reset };
}

module.exports = { createScheduler, LIVE_NOTE };
