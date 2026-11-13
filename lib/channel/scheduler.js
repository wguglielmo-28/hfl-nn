// The channel's daily shows. Each show in config/channel.json with a
// `produce` block (Morning Blitz, Stat Lab, Grimley After Dark) is written,
// voiced and published shortly before its first slot of the day — if, and
// only if, every one of these holds:
//
//   • Settings → "Make the channel's daily shows automatically" is on
//   • the league is not in the preseason (the commissioner reviews those)
//   • there is something new to say: at least `minFresh` stories on the wire
//     that this show has not already covered
//   • today's spend on script writing, across every episode, plus this
//     show's estimate, is still inside the daily cap
//
// A show is attempted at most once a day. A script that fails, or needs
// fixes, is left for the commissioner; nothing is retried, so a bad day can
// never loop and spend. When a show is not made, its slot airs its last
// episode, or the vault.
//
// Daily shows are side shows: they are voiced with the free local voices and
// publishing one does not use up wire stories, touch the show's memory or
// post to Discord (lib/producer.js), so the weekly show loses nothing.
'use strict';
const { dayKey, dayStart, nextDay, wallToMs } = require('./clock');

const STORY_DAYS = 7;        // older stories are not news
const AIRED_KEEP = 600;      // story ids remembered per show
const LOG_KEEP = 60;

function createScheduler({ store, config, producer, getSettings, now = Date.now, logger = console }) {
  const tz = config.timeZone;
  // channel/daily.json: { made: { '<day>:<show>': { episodeId, at } }, aired: { <show>: [storyId…] }, log: [...] }
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

  // The first slot of a show on a day, epoch ms (null if it is not on the grid).
  function firstSlot(showKey, day) {
    const slot = config.grid.find(g => g.show === showKey);
    return slot ? wallToMs(day, slot.at, tz) : null;
  }

  // Stories this show has not covered, newest and biggest first.
  function freshStories(showKey, t, max) {
    const aired = new Set(state.aired[showKey] || []);
    return producer.wireStories()
      .filter(s => !s.excluded && !aired.has(s.id) && t - Date.parse(s.createdAt) < STORY_DAYS * 86400000)
      .sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max);
  }

  function budget(t = now()) {
    const day = dayKey(t, tz);
    const spent = producer.spentBetween(dayStart(day, tz), dayStart(nextDay(day), tz));
    const cap = Number(getSettings().dailyCapUsd) || 0;
    return { day, spent, cap, left: Math.max(0, Math.round((cap - spent) * 10000) / 10000) };
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
      const id = `${day}:${key}`;
      if (state.made[id]) continue;
      const slot = firstSlot(key, day);
      const lead = (Number(show.produce.leadMinutes) || 45) * 60000;
      // Only in the run-up to the slot. A missed window (the server was
      // down) is not made up late: the show would be stale by the next one.
      if (slot == null || t < slot - lead || t >= slot) continue;

      const stories = freshStories(key, t, Number(show.produce.maxStories) || 8);
      const minFresh = Number(show.produce.minFresh) || 2;
      if (stories.length < minFresh) { note(id, 'skipped', { reason: `nothing new (${stories.length} fresh ${stories.length === 1 ? 'story' : 'stories'}, needs ${minFresh})` }); continue; }

      // The daily shows always fall back: a writer out of credits hands over
      // to the other one, then the free template.
      const writer = producer.pickWriter(settings.channelWriter || 'auto', { fallback: true });
      const est = writer === 'template' ? 0 : Number(show.produce.estUsd) || 0.25;
      const b = budget(t);
      if (est > 0 && b.spent + est > b.cap) { note(id, 'skipped', { reason: `daily cap: $${b.spent.toFixed(2)} spent of $${b.cap.toFixed(2)}, this show is about $${est.toFixed(2)}` }); continue; }

      let ep;
      try {
        ep = producer.createEpisode({
          type: 'custom', customKinds: show.produce.kinds, title: show.title, storyIds: stories.map(s => s.id),
          writer: settings.channelWriter || 'auto', fallback: true, auto: true, channel: { show: key, day }, chain: { voice: true, publish: true },
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
      // again every morning and the show would never run out of "news".
      state.aired[key] = [...new Set([...stories.map(x => x.id), ...(state.aired[key] || [])])].slice(0, AIRED_KEEP);
      // Keep a fortnight of "made" records.
      const cutoff = nextDay(day, -14);
      for (const k of Object.keys(state.made)) if (k.slice(0, 10) < cutoff) delete state.made[k];
      note(id, 'started', { episodeId: ep.id, writer, stories: stories.length });
      return { made: ep.id, show: key };
    }
    return { made: null, reason: 'nothing due' };
  }

  // For the control room: today's budget, and what the scheduler last decided.
  function status() {
    const t = now();
    const day = dayKey(t, tz);
    return {
      auto: !!getSettings().channelAuto, held: producer.held(), ...budget(t),
      writer: producer.pickWriter(getSettings().channelWriter || 'auto', { fallback: true }),
      writers: producer.writerChain(getSettings().channelWriter || 'auto', { fallback: true }),
      shows: producedShows().map(([key, show]) => ({
        key, title: show.title, slot: firstSlot(key, day), made: state.made[`${day}:${key}`] || null,
        estUsd: Number(show.produce.estUsd) || 0.25,
        today: today(key, show, day, t),
      })),
      log: state.log.slice(0, 20),
    };
  }

  // Where one show stands today, in words the control room can print:
  //   waiting  its run-up has not started          due      in its run-up, not made yet (reason says why)
  //   made     written, voiced and published       working  being written or voiced
  //   stuck    the script needs the commissioner   failed   could not be built or written
  //   missed   its slot passed without a show (reason: the last thing the scheduler said)
  function today(key, show, day, t) {
    const id = `${day}:${key}`;
    const slot = firstSlot(key, day);
    const said = state.log.find(l => l.key === id && l.outcome === 'skipped')?.reason || null;
    const made = state.made[id];
    if (made) {
      const ep = made.episodeId ? producer.get(made.episodeId) : null;
      if (!ep) return { state: 'failed', reason: made.error || 'the episode was removed', episodeId: made.episodeId || null };
      const cost = [ep.writer, ...(ep.writer?.history || [])].reduce((n, w) => n + (Number.isFinite(w?.costUsd) ? w.costUsd : 0) + (Number.isFinite(w?.failedCostUsd) ? w.failedCostUsd : 0), 0);
      const base = { episodeId: ep.id, title: ep.title, writer: ep.writer?.kind || made.writer || null, ...(ep.writer?.fallbackFrom ? { fallbackFrom: ep.writer.fallbackFrom } : {}), costUsd: Math.round(cost * 10000) / 10000, at: made.at };
      if (ep.status === 'published') return { state: 'made', ...base };
      if (ep.status === 'failed') return { state: 'failed', reason: ep.error || 'the script could not be written', ...base };
      if (['writing', 'voicing'].includes(ep.status)) return { state: 'working', reason: ep.status, ...base };
      return { state: 'stuck', reason: ep.status === 'needs_fixes' ? 'the script needs fixes before it can be voiced' : `left as ${ep.status}`, ...base };
    }
    if (slot == null) return { state: 'waiting', reason: 'not on the schedule' };
    const lead = (Number(show.produce.leadMinutes) || 45) * 60000;
    if (t >= slot) return { state: 'missed', reason: said || (getSettings().channelAuto ? 'the server was not running in the run-up' : 'daily shows are switched off') };
    if (t >= slot - lead) return { state: 'due', reason: said };
    return { state: 'waiting', reason: null, startsAt: slot - lead };
  }

  function reset() { state = { made: {}, aired: {}, log: [] }; lastNote = {}; store.remove('channel/daily.json'); store.remove('channel/daily.json.bak'); }

  return { tick, status, budget, freshStories, reset };
}

module.exports = { createScheduler };
