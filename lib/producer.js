// The producer: owns the news wire and the episodes, and runs the pipeline
//   stories → rundown → script (Claude or template) → voices + mix → publish
// as background jobs, one at a time. Also the automation: after each export
// batch it can draft (and optionally voice and publish) the weekly show and
// breaking-news bulletins.
//
// Storage (under DATA_DIR):
//   wire.json                       stories from every batch, with used/pinned/excluded flags
//   episodes/index.json             episode summaries
//   episodes/<id>/episode.json      rundown, script, validation, writer info
//   episodes/<id>/manifest.json     what the player loads
//   episodes/<id>/audio.mp3         the soundtrack
//   jobs.json                       recent jobs (for the control room)
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./league');
const S = require('./stories');
const C = require('./cards');
const { buildRundown, chronicleItem, hubItem, STANDINGS_TYPES } = require('./rundown');
const { previewStories } = require('./preview');
const { kickoffStories, seasonLabel } = require('./kickoff');
const { writeTemplateScript } = require('./writer/template');
const { validateScript, factNumberSet } = require('./writer/validate');
const { leagueNicknames } = require('./writer/names');
const P = require('./writer/prompt');
const M = require('./memory');
const R = require('./receipts');
const { createDesk, CATEGORIES } = require('./desk');
const { buildEpisodeAudio } = require('./audio/mixer');
const { writeEpisodeAudio } = require('./audio/encode');
const { postWebhook, episodeMessage } = require('./discord');
const secrets = require('./secrets');
const { sha256 } = require('./util');
const T = require('./talk');
const ELEVEN = require('./tts/elevenlabs');

const SUMMARY_KEYS = ['id', 'type', 'phase', 'title', 'summary', 'status', 'weekLabel', 'createdAt', 'updatedAt', 'publishedAt', 'error'];
const ID_RE = /^[a-z0-9-]{6,64}$/;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function createProducer({
  store, show, getPersonas, getLeague, getSettings, tts, claude, openai = { available: () => false }, chronicle, hub,
  publicUrl = () => '', logger = console,
  // The Fifth Quarter (config/talk.json): its config, its cast, and both
  // casts together for the show memory the two shows share.
  talk = null, getTalkPersonas = () => null, getNetworkPersonas = null,
  getChat = () => null,   // (sinceMs, anchors) → the Hub chat's handful for the Mailbag, or null
  baselineBefore = () => null,   // wk → the last snapshot before any game from wk on was final (lib/ingest/madden.js)
  // In production a missing voice engine must stop voicing, not make a mute
  // episode (2026-11-20: a deploy came up without Kokoro and a weekly was
  // voiced and published silent). Tests and demos use the silent voice on purpose.
  requireRealVoices = false,
}) {
  // ── News wire ───────────────────────────────────────────────────────────
  const wire = store.readJSON('wire.json', { stories: [] });
  const saveWire = () => store.writeJSON('wire.json', wire);

  // Adds stories the wire hasn't seen and returns them. Re-detections (the
  // daily export re-sends the same week) are skipped by id.
  function addToWire(stories) {
    const known = new Set(wire.stories.map(s => s.id));
    const added = [];
    for (const s of stories) {
      if (known.has(s.id)) continue;
      known.add(s.id);
      wire.stories.push({ ...s, usedIn: [], pinned: false, excluded: false });
      added.push(s);
    }
    wire.stories.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.score - a.score);
    wire.stories = wire.stories.slice(0, 500);
    if (added.length) saveWire();
    return added;
  }

  // A different franchise took over (a new Madden year, or the real league
  // replacing the sample): nothing left on the wire is news for it.
  function retireWire() {
    let n = 0;
    for (const s of wire.stories) if (!s.usedIn.length && !s.excluded) { s.excluded = true; s.retired = true; n++; }
    if (n) saveWire();
    return n;
  }

  function flagStory(id, { pinned, excluded }) {
    const s = wire.stories.find(x => x.id === id);
    if (!s) return null;
    if (pinned != null) s.pinned = !!pinned;
    if (excluded != null) s.excluded = !!excluded;
    saveWire();
    return s;
  }

  const sameWeek = (a, b) => a && b && a.seasonIndex === b.seasonIndex && a.stage === b.stage && a.week === b.week;

  // ── Which show an episode belongs to ────────────────────────────────────
  const isTalk = ep => ep?.type === 'talk';
  // The cast that writes and voices an episode. A talk episode also carries
  // HFL-NN's ids (otherIds), so a relationship can name an anchor from there.
  function personasFor(ep) {
    if (!isTalk(ep)) return getPersonas();
    const p = getTalkPersonas();
    if (!p) throw new Error('The talk show is not configured (config/talk.json).');
    return { ...p, otherIds: getPersonas().anchors.map(a => a.id) };
  }
  // Both casts: the memory is one, shared by HFL-NN and the talk show.
  const memoryPersonas = () => (getNetworkPersonas ? getNetworkPersonas() : getPersonas());
  const talkShowName = () => talk?.network?.name || 'The Fifth Quarter';

  // ── What an episode may know ────────────────────────────────────────────
  // An episode airs as if the week being played right now hadn't started:
  // the daily export catches games mid-week, and a show released then
  // ignores them (the Crimson Chronicle's rule too). A kickoff airs before
  // Week 1. See L.beforeWeek.
  function cutoffWeek(type, league) {
    if (type === 'kickoff') return { seasonIndex: league.seasonIndex ?? 0, stage: 'reg', week: 1 };
    return L.currentWeek(league);
  }

  // Stories that only exist because of a game result.
  const OUTCOME_TYPES = new Set(['game', 'performance', 'milestone', 'injury', ...STANDINGS_TYPES]);

  // The league as of `asOf`, plus which stories that rules out.
  function leagueAsOf(live, asOf) {
    const none = { league: live, hides: () => false };
    if (!asOf) return none;
    let league = L.beforeWeek(live, asOf);
    if (league === live) return none;
    const base = league.asOf.hiddenGames ? (baselineBefore(asOf) || null) : null;
    if (base?.snapshot) league = L.beforeWeek(live, asOf, { baseline: base.snapshot });
    const later = new Set(base?.laterBatches || []);
    const cut = L.weekOrd(asOf.seasonIndex, asOf.stage, asOf.week);
    const hides = s => (s.week && s.week.seasonIndex === asOf.seasonIndex && L.weekOrd(s.week.seasonIndex, s.week.stage, s.week.week) >= cut)
      || (OUTCOME_TYPES.has(s.type) && later.has(s.batchId));
    return { league, hides, baselineBatch: base?.batchId || null };
  }

  function selectStories({ focusWeek, storyIds, hides = () => false }) {
    let list = wire.stories.filter(s => !s.excluded && !hides(s));
    if (storyIds?.length) list = list.filter(s => storyIds.includes(s.id));
    else list = list.filter(s => (!s.usedIn.length || s.pinned) && (!s.week || !focusWeek || sameWeek(s.week, focusWeek)));
    return list.slice().sort((a, b) => (b.pinned - a.pinned) || b.score - a.score);
  }

  // ── Episodes ────────────────────────────────────────────────────────────
  let index = store.readJSON('episodes/index.json', []);
  const saveIndex = () => store.writeJSON('episodes/index.json', index);
  const load = id => {
    if (!ID_RE.test(String(id))) return null;
    return store.readJSON(`episodes/${id}/episode.json`, null);
  };
  function save(ep) {
    ep.updatedAt = new Date().toISOString();
    store.writeJSON(`episodes/${ep.id}/episode.json`, ep);
    const sum = Object.fromEntries(SUMMARY_KEYS.map(k => [k, ep[k] ?? null]));
    sum.duration = ep.audio?.duration ?? null;
    sum.audioFile = ep.audio?.file ?? null;
    sum.writer = ep.blind && !ep.blind.revealed ? null : ep.writer?.kind || null;
    if (ep.blind) sum.blind = { pair: ep.blind.pair, label: ep.blind.label, revealed: !!ep.blind.revealed, winner: !!ep.blind.winner };
    sum.channelShow = ep.channelShow || null;
    sum.focusWeek = ep.rundown?.focusWeek || null;
    const i = index.findIndex(e => e.id === ep.id);
    if (i >= 0) index[i] = sum; else index.unshift(sum);
    index.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    saveIndex();
    return ep;
  }

  // ── Jobs: one at a time, in order ──────────────────────────────────────
  const jobs = store.readJSON('jobs.json', []).map(j => (['queued', 'running'].includes(j.status) ? { ...j, status: 'failed', error: 'Interrupted by a server restart' } : j));
  const saveJobs = () => store.writeJSON('jobs.json', jobs.slice(0, 50));
  saveJobs();
  // Episodes caught mid-job by a restart
  for (const sum of index) {
    if (['writing', 'voicing'].includes(sum.status)) {
      const ep = load(sum.id);
      if (ep) { ep.status = ep.script ? 'draft' : 'failed'; ep.error = 'Interrupted by a server restart — run it again.'; save(ep); }
    }
  }
  let queue = Promise.resolve();
  let seq = 0;
  function enqueue(kind, episodeId, fn) {
    const job = { id: `${stamp()}-${++seq}`, kind, episodeId, status: 'queued', progress: null, createdAt: new Date().toISOString() };
    jobs.unshift(job);
    saveJobs();
    queue = queue.then(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      saveJobs();
      try {
        await fn(job);
        job.status = 'done';
      } catch (e) {
        job.status = 'failed';
        job.error = e.message;
        logger.error(`[producer] ${kind} ${episodeId} failed:`, e);
        const ep = load(episodeId);
        if (ep && ['writing', 'voicing'].includes(ep.status)) { ep.status = ep.script ? 'draft' : 'failed'; ep.error = e.message; save(ep); }
      }
      job.finishedAt = new Date().toISOString();
      saveJobs();
    });
    return job;
  }
  const idle = () => queue;
  const busy = () => jobs.some(j => ['queued', 'running'].includes(j.status));

  // ── Creating episodes ───────────────────────────────────────────────────
  function hubUsed() { return new Set(store.readJSON('sources/hub-used.json', [])); }

  function createEpisode(opts = {}) {
    const {
      type = 'weekly', customKinds = null, notes = '', storyIds = null, breakingStoryIds = null,
      bulletin = null, writer = 'auto', title = null, chain = null, channel = null, fallback = writer === 'auto',
    } = opts;
    if (type === 'talk') return createTalkEpisode(opts);
    if (!['weekly', 'breaking', 'special', 'custom', 'premiere', 'kickoff'].includes(type)) throw new Error(`Unknown episode type "${type}"`);
    const live = getLeague();
    const settings = getSettings();
    const personas = getPersonas();
    const hubData = hub.data();
    // The channel's live shows see the league as it is right now, the week
    // being played included; everything else airs as if that week's games
    // had not been played yet (L.beforeWeek).
    const liveShow = !!channel?.live;
    const cutoff = liveShow ? null : cutoffWeek(type, live);
    const { league, hides, baselineBatch } = leagueAsOf(live, cutoff);
    const asOf = cutoff && { ...cutoff, label: L.weekLabel(cutoff.stage, cutoff.week), hiddenGames: league.asOf?.hiddenGames || 0, baselineBatch: baselineBatch || null };
    const phase = opts.phase || settings.phaseOverride || (type === 'kickoff' ? 'regular' : L.detectPhase(league));
    const focusWeek = liveShow ? (L.lastPlayedWeek(league) || L.lastCompleteWeek(league)) : (L.lastCompleteWeek(league) || L.lastPlayedWeek(league));
    // An approved week desk (lib/desk.js) brings the commissioner's picks.
    const deskEntry = opts.desk || null;
    if (deskEntry && !sameWeek(deskEntry.week, focusWeek)) {
      throw new Error(`${deskEntry.label || 'That week'} is no longer the latest finished week. Open the desk for ${focusWeek ? L.weekLabel(focusWeek.stage, focusWeek.week) : 'the current week'} instead.`);
    }
    let stories = S.withOfficialGotw(liveShow ? channelStories(storyIds) : selectStories({ focusWeek, storyIds, hides }), S.officialGotwKey(league, focusWeek, hubData));
    if (deskEntry?.gotwStoryId) stories = S.withOfficialGotw(stories, deskEntry.gotwStoryId.slice('game:'.length));
    if (deskEntry?.headlines?.length) {
      stories = [...stories, ...deskEntry.headlines.map(h => deskHeadlineStory(h, league))]
        .sort((a, b) => (!!b.pinned - !!a.pinned) || b.score - a.score);
    }
    // A premiere is built from the rosters themselves: the first export of a
    // league is a starting point and gives the story engine nothing to say.
    if (type === 'premiere') stories = [...previewStories(league), ...stories];
    // A kickoff adds the preseason, cut day and the Week 1 slate, plus the
    // premiere's division and roster material for the expectations segments.
    if (type === 'kickoff') stories = [...kickoffStories(league, { wire: wire.stories, hub: hubData }), ...previewStories(league).filter(s => s.type !== 'talent'), ...stories];

    // Give the writer the article itself, not just the teaser.
    const articles = type === 'breaking' ? [] : chronicle.unused().slice(0, 3).map(a => {
      const item = chronicleItem(a, chronicle.outlet);
      item.facts.text = a.text.slice(0, 5000);
      return item;
    });
    const usedHub = hubUsed();
    const hubItems = type === 'breaking' ? [] : (hubData?.announcements || []).filter(a => !usedHub.has(a.id)).slice(0, 3).map(hubItem);

    let breakingStories = [];
    if (type === 'breaking') {
      if (bulletin?.headline) {
        const headline = String(bulletin.headline).slice(0, 140);
        breakingStories.push({
          id: `bulletin:${sha256(headline + Date.now()).slice(0, 10)}`, type: 'bulletin', category: 'LEAGUE OFFICE', score: 90,
          headline, teams: [], players: [], facts: { headline, details: String(bulletin.details || '').slice(0, 1500), source: 'HFL commissioner' },
          card: C.headline('LEAGUE OFFICE', headline.toUpperCase()),
        });
      }
      const ids = breakingStoryIds || [];
      breakingStories.push(...wire.stories.filter(s => ids.includes(s.id)));
      for (const id of opts.chronicleIds || []) {
        const a = chronicle.list().find(x => x.id === id);
        if (a) breakingStories.push(chronicleItem(a, chronicle.outlet));
      }
      if (!breakingStories.length) breakingStories = stories.filter(S.isBreaking).slice(0, 2);
      if (!breakingStories.length) throw new Error('A bulletin needs a headline or at least one story.');
    }

    const context = { ...S.buildContext(league, { focusWeek, hub: hubData }), season: seasonLabel(settings, hubData) };
    if (deskEntry) context.playersOfWeek = deskPlayersOfWeek(league, focusWeek, deskEntry.potw, context.playersOfWeek);
    // Settled predictions not yet called out on air get a Receipts segment.
    // Only this cast's receipts: the talk show's predictions are its own business.
    const mine = new Set(personas.anchors.map(a => a.id));
    const receipts = type === 'breaking' ? [] : R.freshReceipts(M.loadMemory(store, memoryPersonas())).filter(r => mine.has(r.persona));
    const rundown = buildRundown({
      type, phase, show, personas, league, context, stories, chronicle: articles, hub: hubItems, customKinds, breakingStories, title, notes, asOf, receipts,
      ...(channel?.minutes ? { targetMinutes: Number(channel.minutes) } : {}), ...(channel?.maxRecaps ? { maxRecaps: Number(channel.maxRecaps) } : {}),
      ...(channel?.chat ? { audience: channel.chat } : {}),
    });
    // Ids are second-resolution timestamps; two episodes of one type in the
    // same second (an automated show right behind a manual one) would share
    // an id and the second would overwrite the first.
    const base = `${stamp()}-${type}`;
    let id = base;
    for (let n = 2; load(id) || index.some(e => e.id === id); n++) id = `${base}-${n}`;
    const pool = [...stories, ...articles, ...hubItems, ...breakingStories];
    const ep = {
      id, type, phase, title: rundown.title, summary: '', status: 'writing', weekLabel: rundown.weekLabel,
      createdAt: new Date().toISOString(), publishedAt: null, notes, auto: !!opts.auto,
      rundown,
      // The episode keeps its own copy of every story it covers, so it can be
      // re-written or re-voiced after the wire moves on.
      stories: Object.fromEntries(pool.filter(s => rundown.storyIds.includes(s.id)).map(s => [s.id, stripWire(s)])),
      script: null, validation: null, writer: null, audio: null, error: null,
    };
    // A daily show made for the 24/7 channel (lib/channel/scheduler.js). It
    // is a side show: always voiced with the free local voices, and
    // publishing it leaves the wire, the show's memory and Discord alone, so
    // the weekly show still has everything to work with.
    if (channel?.show) { ep.channelShow = String(channel.show); ep.channelDay = channel.day || null; ep.voiceEngine = 'kokoro'; }
    save(ep);
    enqueue('write', id, job => writeScript(id, { writer, fallback, job, chain }));
    return ep;
  }

  // ── The Fifth Quarter ───────────────────────────────────────────────────
  // Everything in the gather window: export stories, Chronicle articles (the
  // whole text, newest first, up to about 16,000 characters in all) and Hub
  // announcements, plus the commissioner's desk headlines.
  const CHRONICLE_BUDGET = 16000;
  function gatherTalk(w, entry = null) {
    const league = getLeague();
    let stories = T.windowStories(wire.stories, w);
    if (entry?.headlines?.length) {
      stories = [...stories, ...entry.headlines.map(h => deskHeadlineStory(h, league))]
        .sort((a, b) => (!!b.pinned - !!a.pinned) || b.score - a.score);
    }
    let room = CHRONICLE_BUDGET;
    const articles = T.windowArticles(chronicle.list(), w)
      .sort((a, b) => String(b.published || b.fetchedAt).localeCompare(String(a.published || a.fetchedAt)))
      .map(a => {
        const item = chronicleItem(a, chronicle.outlet);
        const text = String(a.text || '').slice(0, Math.max(0, room));
        room -= text.length;
        item.facts.text = text;
        return item;
      }).filter(a => a.facts.text || a.facts.excerpt);
    const usedHub = hubUsed();
    const hubItems = (hub.data()?.announcements || []).filter(a => !usedHub.has(a.id)).slice(0, 3).map(hubItem);
    return { league, stories, articles, hubItems };
  }

  function talkRundown(w, entry = null) {
    const settings = getSettings();
    const personas = personasFor({ type: 'talk' });
    const hubData = hub.data();
    const { league, stories, articles, hubItems } = gatherTalk(w, entry);
    const focusWeek = L.lastCompleteWeek(league) || L.lastPlayedWeek(league);
    const phase = settings.phaseOverride || L.detectPhase(league);
    const context = { ...S.buildContext(league, { focusWeek, hub: hubData }), season: seasonLabel(settings, hubData), phase };
    const window = { ...w, label: T.weeksLabel(stories) || w.label || '' };
    let audience = null;
    try { audience = getChat(Date.parse(w.from), personas.anchors); } catch { audience = null; }
    const rundown = T.buildTalkRundown({
      talk, personas, league, context, stories, chronicle: articles, hub: hubItems, audience, fanTakes: hubData?.fanTakes || [],
      window, charBudget: settings.talkCharBudget || 6000, notes: entry?.notes || '',
    });
    return { rundown, pool: [...stories, ...articles, ...hubItems], counts: { stories: stories.length, articles: articles.length, hub: hubItems.length, chat: audience?.messages?.length || 0 }, articles, stories };
  }

  function createTalkEpisode(opts = {}) {
    if (!talk) throw new Error('The talk show is not configured (config/talk.json).');
    const settings = getSettings();
    const entry = opts.desk || null;
    const w = entry?.window || T.gatherWindow(index);
    const { rundown, pool } = talkRundown(w, entry);
    // Nothing new since the last episode: don't pay a writer to fill air.
    if (!rundown.segments.length || !rundown.storyIds.length) {
      const e = new Error('Nothing to talk about yet: no stories, Chronicle articles or Hub announcements since the last episode. Gather again after the next export.');
      e.status = 400;
      throw e;
    }
    const base = `${stamp()}-talk`;
    let id = base;
    for (let n = 2; load(id) || index.some(e => e.id === id); n++) id = `${base}-${n}`;
    const ep = {
      id, type: 'talk', phase: rundown.phase, title: rundown.title, summary: '', status: 'writing', weekLabel: rundown.weekLabel,
      createdAt: new Date().toISOString(), publishedAt: null, notes: entry?.notes || opts.notes || '', auto: false,
      rundown,
      stories: Object.fromEntries(pool.filter(s => rundown.storyIds.includes(s.id)).map(s => [s.id, stripWire(s)])),
      script: null, validation: null, writer: null, audio: null, error: null,
      // Voiced with ElevenLabs only: a talk episode never falls back to Kokoro.
      voiceEngine: 'elevenlabs', elevenModel: settings.talkModel || 'eleven_v3', showName: talkShowName(),
      ...(opts.blind ? { blind: opts.blind } : {}),
    };
    save(ep);
    const writer = opts.writer || settings.talkWriter || 'auto';
    enqueue('write', id, job => writeScript(id, { writer, fallback: opts.fallback ?? writer === 'auto', job, chain: opts.chain || null }));
    return ep;
  }

  // What a talk script will cost to voice: every character sent, emotion
  // tags included (lines already in the voice cache cost nothing, so this is
  // the most it can cost).
  function talkChars(ep) {
    const model = ep.elevenModel || getSettings().talkModel || 'eleven_v3';
    let n = 0;
    for (const seg of ep.script?.segments || []) {
      for (const ln of seg.lines) {
        const tag = ELEVEN.delivery(ln.emotion, model).tag;
        n += ln.text.length + (tag ? tag.length + 1 : 0);
      }
    }
    return n;
  }

  // Stories a live channel show can use: the week being played (built fresh
  // from the live league) first, then the wire, one copy of each, biggest
  // first within each.
  function liveStories() {
    const byId = new Map(wire.stories.filter(s => !s.excluded).map(s => [s.id, s]));
    for (const s of S.liveWeekStories(getLeague())) byId.set(s.id, s);
    return [...byId.values()].sort((a, b) => (!!b.live - !!a.live) || b.score - a.score);
  }
  function channelStories(ids) {
    const want = new Set(ids || []);
    return liveStories().filter(s => !ids || want.has(s.id));
  }

  // ── The week desk ───────────────────────────────────────────────────────
  const desk = createDesk({ store });

  // A headline typed on the desk, as a story the rundown can place.
  function deskHeadlineStory(h, league) {
    const teams = (h.teams || []).map(a => R.teamByAbbr(league, a)?.id).filter(id => id != null);
    return {
      id: `desk:${h.id}`, type: 'headline', category: h.breaking ? 'BREAKING' : h.category, score: h.breaking ? 95 : 70,
      headline: h.headline, teams, players: [], week: null,
      facts: { headline: h.headline, details: h.details || '', source: 'HFL commissioner', breaking: !!h.breaking },
      card: C.headline(h.breaking ? 'BREAKING' : h.category, h.headline.toUpperCase(), teams, league),
    };
  }

  // The desk's Players of the Week: a candidate by roster id, or a player
  // typed in by hand. A side left unpicked keeps the automatic choice.
  function deskPlayersOfWeek(league, wk, picks = {}, auto = {}) {
    const idx = L.rosterIndex(league);
    const ranked = wk ? S.rankPerformersWeek(league, wk, idx, 40) : { offense: [], defense: [] };
    const hubPicks = S.hubPlayersOfWeek(wk, hub.data());
    const out = { ...auto, official: false };
    for (const side of ['offense', 'defense']) {
      const p = picks?.[side];
      if (!p) continue;
      const tag = side === 'defense' ? 'DEFENSIVE PLAYER OF THE WEEK' : 'OFFENSIVE PLAYER OF THE WEEK';
      if (p.rosterId != null) {
        const hit = ranked[side].find(x => String(x.rosterId) === String(p.rosterId));
        // A Hub pick outside HFL-NN's own top 40 still airs, from the Hub's line.
        const fromHub = !hit && hubPicks[side].find(x => x.rosterId === String(p.rosterId));
        if (hit) out[side] = hit;
        else if (fromHub) out[side] = namedPlayer(league, idx, fromHub, tag);
        else continue;
        out.official = true;
        continue;
      }
      out[side] = namedPlayer(league, idx, p, tag);
      out.official = true;
    }
    return out;
  }

  // A Player of the Week the stat ranking didn't produce: typed in by hand,
  // or named by the Hub. The roster's card when the export knows the player,
  // else a card from the name, team and line given.
  function namedPlayer(league, idx, p, tag) {
    const known = p.rosterId != null ? idx.get(Number(p.rosterId)) : null;
    if (known) {
      const ref = C.teamRef(league, known.teamId);
      return { rosterId: known.rosterId, name: known.name, team: ref.abbr, teamId: known.teamId, line: p.line, card: C.playerCard(league, known, p.line, tag) };
    }
    const team = R.teamByAbbr(league, p.team);
    const ref = team ? C.teamRef(league, team.id) : { abbr: p.team || '' };
    return {
      name: p.name, team: ref.abbr, teamId: team?.id ?? null, line: p.line, manual: true,
      card: { type: 'player', data: { tag, name: p.name, pos: p.position || '', team: ref.abbr, color: ref.color, color2: ref.color2, ovr: null, dev: '', line: p.line } },
    };
  }

  // What the control room's desk shows: the waiting entry and its choices.
  function deskView() {
    const league = getLeague();
    const entry = desk.current();
    const latest = L.lastCompleteWeek(league);
    const out = { entry, latestWeek: latest && { ...latest, label: L.weekLabel(latest.stage, latest.week) }, categories: CATEGORIES };
    // Members' takes and requests the commissioner approved on the Hub. Shown
    // on the desk as suggestions; `used` marks the ones already added.
    const usedIds = new Set((entry?.headlines || []).map(h => h.fromMember).filter(Boolean));
    const mark = list => (list || []).map(m => ({ ...m, used: usedIds.has(m.id) }));
    out.fromMembers = { takes: mark(hub.data()?.fanTakes), requests: mark(hub.data()?.segmentRequests) };
    out.weeklyShow = getSettings().weeklyShow || 'talk';
    out.talkShowName = talkShowName();
    if (entry?.kind === 'talk') {
      // Gathering is free: a dry run of the rundown shows what the show would
      // cover, how long it runs and roughly what it costs to voice.
      const settings = getSettings();
      const { rundown, counts, articles, stories } = talkRundown(entry.window, entry);
      const names = personasFor({ type: 'talk' }).anchors;
      const short = id => names.find(a => a.id === id)?.short || id;
      out.talk = {
        window: { ...entry.window, range: rundown.window.range, label: rundown.weekLabel },
        counts,
        stories: stories.slice(0, 12).map(s => ({ id: s.id, headline: s.headline, type: s.type })),
        articles: articles.map(a => ({ id: a.id, title: a.facts.title, author: a.facts.author })),
        segments: rundown.segments.map(s => ({ title: s.title, cast: s.cast.map(short), seconds: s.targetSeconds })),
        estimatedChars: rundown.estimatedChars, charBudget: rundown.charBudget,
        writer: settings.talkWriter || 'auto', model: settings.talkModel || 'eleven_v3',
        writers: { claude: !!claude?.available?.(), openai: !!openai?.available?.() },
      };
      return out;
    }
    if (!entry) return out;
    const wk = entry.week;
    const games = wire.stories.filter(s => s.type === 'game' && sameWeek(s.week, wk))
      .map(s => ({ id: s.id, headline: s.headline, madden: !!s.facts.flags?.includes('game-of-the-week') }));
    const hubKey = S.officialGotwKey(league, wk, hub.data());
    const ranked = S.rankPerformersWeek(league, wk, L.rosterIndex(league), 40);
    const hubPicks = S.hubPlayersOfWeek(wk, hub.data());
    const brief = x => ({ rosterId: String(x.rosterId), name: x.name, team: x.team, line: x.line });
    // The top five by HFL-NN's own ranking, plus the Hub's picks (marked with
    // their conference) wherever they rank. The Hub names one per conference;
    // the show has one per side, so the suggestion is the Hub pick HFL-NN
    // ranks highest, a commissioner's manual pick winning a tie.
    const rankOf = (side, id) => { const i = ranked[side].findIndex(x => String(x.rosterId) === id); return i < 0 ? Infinity : i; };
    const side = s => {
      const list = ranked[s].slice(0, 5).map(brief);
      const picks = hubPicks[s].filter(p => p.rosterId)
        .sort((a, b) => rankOf(s, a.rosterId) - rankOf(s, b.rosterId) || b.manual - a.manual);
      for (const p of picks) {
        let c = list.find(x => x.rosterId === p.rosterId);
        if (!c) {
          const hit = ranked[s].find(x => String(x.rosterId) === p.rosterId);
          list.push(c = hit ? brief(hit) : { rosterId: p.rosterId, name: p.name, team: p.team, line: p.line });
        }
        c.hub = p.conference || 'HFL';
      }
      return { list, hubPick: picks[0]?.rosterId || null };
    };
    const offense = side('offense'), defense = side('defense');
    out.candidates = { games, offense: offense.list, defense: defense.list, hubGotw: hubKey ? `game:${hubKey}` : null };
    out.suggested = {
      gotwStoryId: out.candidates.hubGotw || games.find(g => g.madden)?.id || null,
      potw: { offense: offense.hubPick || offense.list[0]?.rosterId || null, defense: defense.hubPick || defense.list[0]?.rosterId || null },
      potwFromHub: { offense: !!offense.hubPick, defense: !!defense.hubPick },
    };
    return out;
  }

  // Opens the desk for the latest finished week by hand.
  function openDesk() {
    if ((getSettings().weeklyShow || 'talk') === 'talk' && talk) {
      const w = T.gatherWindow(index);
      return desk.openTalk(w, { label: `${talkShowName()}: week of ${T.dateRange(w)}` });
    }
    const wk = L.lastCompleteWeek(getLeague());
    if (!wk) throw new Error('No week has finished yet.');
    return desk.open(wk, { label: L.weekLabel(wk.stage, wk.week) });
  }

  // The commissioner's sign-off: writes the weekly with the desk's picks,
  // and voices it (publishing too, with auto-publish on) when asked.
  function approveDesk({ voice = false, blind = false } = {}) {
    const entry = desk.current();
    if (!entry) throw new Error('Nothing is waiting on the desk.');
    const settings = getSettings();
    if (entry.kind === 'talk') {
      // Write only: voicing spends ElevenLabs credits, so it is its own click.
      if (blind) {
        // The blind test: both AI writers write the same window; the control
        // room shows them as Script A and Script B until one is picked.
        for (const k of ['claude', 'openai']) if (!WRITERS[k].impl().available()) throw new Error(`The blind test needs both writers: ${WRITERS[k].name} is not configured (set ${WRITERS[k].key}).`);
        const pair = `blind-${stamp()}`;
        const order = Math.random() < 0.5 ? ['claude', 'openai'] : ['openai', 'claude'];
        const eps = order.map((writer, i) => createTalkEpisode({ desk: entry, writer, fallback: false, blind: { pair, label: i === 0 ? 'A' : 'B', revealed: false } }));
        desk.markApproved(entry.key, eps[0].id, { blindPair: pair, episodeIds: eps.map(e => e.id) });
        return eps[0];
      }
      const ep = createTalkEpisode({ desk: entry });
      desk.markApproved(entry.key, ep.id);
      return ep;
    }
    const ep = createEpisode({ type: 'weekly', desk: entry, notes: entry.notes, chain: voice ? { voice: true, publish: !!settings.autoPublish } : null });
    desk.markApproved(entry.key, ep.id);
    return ep;
  }

  // eslint-disable-next-line no-unused-vars
  const stripWire = ({ usedIn, pinned, excluded, ...story }) => story;

  const WRITERS = {
    claude: { name: 'Claude', key: 'ANTHROPIC_API_KEY', setting: 'claudeModel', impl: () => claude },
    openai: { name: 'OpenAI', key: 'OPENAI_API_KEY', setting: 'openaiModel', impl: () => openai },
  };

  // ── Which writer, and what happens when it fails ───────────────────────
  // A writer that failed for a reason the next script will hit too -- out of
  // credits, a refused key, a rate limit, an outage -- is benched for a
  // while and skipped without being asked (writers.json, so a restart
  // remembers). Benched writers are tried again once the time is up, or
  // straight away from the control room after topping up.
  const BENCH_MS = { credits: 6 * 3600e3, auth: 6 * 3600e3, rate: 15 * 60e3, outage: 10 * 60e3 };
  const BENCH_SAYS = { credits: 'out of credits', auth: 'the API key was refused', rate: 'rate-limited', outage: 'not answering' };
  let benched = store.readJSON('writers.json', {});
  const saveBenched = () => store.writeJSON('writers.json', benched);
  const isBenched = (kind, t = Date.now()) => !!benched[kind] && Date.parse(benched[kind].until) > t;

  function whyUnusable(err) {
    const status = Number(err?.status) || Number(String(err?.code || '').match(/^http_(\d{3})$/)?.[1]) || 0;
    const text = String(err?.message || '');
    if (status === 402 || /insufficient_quota|exceeded your current quota|credit balance is too low|billing/i.test(text)) return 'credits';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate';
    if (status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|overloaded/i.test(text)) return 'outage';
    return null;
  }

  function bench(kind, why, message) {
    const until = new Date(Date.now() + BENCH_MS[why]).toISOString();
    benched[kind] = { why, says: BENCH_SAYS[why], message: String(message || '').slice(0, 300), at: new Date().toISOString(), until };
    saveBenched();
    logger.warn(`[producer] ${WRITERS[kind].name} is ${BENCH_SAYS[why]}; skipping it until ${until}`);
  }
  function unbench(kind) {
    if (!benched[kind]) return false;
    delete benched[kind];
    saveBenched();
    return true;
  }
  const benchedNow = () => Object.entries(benched).filter(([k]) => isBenched(k)).map(([kind, b]) => ({ kind, name: WRITERS[kind]?.name || kind, ...b }));

  // The writers a script goes to, in order. 'auto' starts from Settings →
  // Script writer (Claude when that is 'auto' too); a named writer starts
  // there. With fallback on -- every automatic script, and any 'auto'
  // request -- a writer without its key, benched, or failing hands over to
  // the other AI writer, then the free template writer. 'template' never
  // escalates to a paid writer. A writer named by hand in the control room
  // (fallback off) is used as is, and its failure is reported.
  function writerChain(writer = 'auto', { fallback = writer === 'auto' } = {}) {
    const pref = writer === 'auto' ? (getSettings().writer || 'auto') : writer;
    if (pref === 'template') return ['template'];
    if (!fallback && WRITERS[pref]) return [pref];
    const order = pref === 'openai' ? ['openai', 'claude'] : ['claude', 'openai'];
    return [...order.filter(k => WRITERS[k].impl().available() && !isBenched(k)), 'template'];
  }
  const pickWriter = (writer = 'auto', opts) => writerChain(writer, opts)[0];

  // Write (or rewrite) the script; `segmentId` rewrites a single segment.
  async function writeScript(id, { writer = 'auto', fallback = writer === 'auto', job = null, segmentId = null, notes = null, chain = null } = {}) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    const personas = personasFor(ep);
    const settings = getSettings();
    const personaIds = personas.anchors.map(a => a.id);
    const otherIds = personas.otherIds || [];
    // Same cutoff as when the episode was made (older episodes have none).
    const { league } = leagueAsOf(getLeague(), ep.rundown.asOf);
    ep.status = 'writing';
    ep.error = null;
    save(ep);

    let rundown = ep.rundown;
    if (segmentId) {
      const seg = rundown.segments.find(s => s.id === segmentId);
      if (!seg) throw new Error(`No segment ${segmentId}`);
      rundown = { ...rundown, segments: [seg], targetWords: seg.targetWords, storyIds: seg.storyIds };
    }
    const network = memoryPersonas();
    const memory = M.loadMemory(store, network);
    const context = S.buildContext(league, { focusWeek: ep.rundown.focusWeek, hub: hub.data() });
    // A poll only makes sense if the episode will be posted to Discord.
    const fanPoll = settings.fanPolls !== false && !!settings.discordWebhook && !isTalk(ep);
    const teamAbbr = Object.fromEntries(Object.values(league.teams || {}).map(t => [t.id, t.abbr]));
    const brief = P.episodeBrief({ rundown, storiesById: ep.stories, personas, memory, notes: notes ?? ep.notes, fanPoll, teamAbbr, network })
      + (segmentId && ep.script ? `\n\nOnly write segment ${segmentId}. The rest of the episode currently reads:\n${ep.script.segments.filter(s => s.id !== segmentId).map(s => s.lines.map(l => `${l.speaker}: ${l.text}`).join('\n')).join('\n')}` : '');
    const leagueText = P.leagueContext(league, context, { phase: ep.phase, hub: hub.data(), asOf: ep.rundown.asOf });
    const factNumbers = factNumberSet(brief, leagueText, JSON.stringify(ep.stories));
    const nicknames = leagueNicknames(league);
    const validate = s => validateScript(s, { rundown, personaIds, factNumbers, nicknames, otherIds });
    const template = () => validate(writeTemplateScript({ rundown, storiesById: ep.stories, personas, league, context, fanPoll, seed: `${id}-${Date.now()}` }));

    // Down the chain until one writes a script that passes validation.
    const order = writerChain(writer, { fallback });
    const strict = order.length === 1;
    const tried = [];
    let result, info;
    for (const choice of order) {
      if (choice === 'template') { result = template(); info = { kind: 'template' }; break; }
      const llm = WRITERS[choice];
      if (!llm.impl().available()) {
        const msg = `${llm.name} is not configured (set ${llm.key}).`;
        if (strict) throw new Error(msg);
        tried.push({ kind: choice, error: msg });
        continue;
      }
      let spent = 0;
      try {
        const out = await llm.impl().write({
          personas, settings, leagueText, brief, validate,
          model: settings[llm.setting], kind: ep.type === 'breaking' ? 'bulletin' : 'show',
          onProgress: p => { if (job) job.progress = { stage: 'writing', chars: p.chars }; },
        });
        spent = Number(out.costUsd) || 0;
        if (!out.result.ok) throw new Error(`${llm.name}'s script failed validation: ${out.result.errors.slice(0, 3).join('; ')}`);
        result = out.result;
        info = { kind: choice, model: out.model, usage: out.usage, costUsd: out.costUsd, repaired: out.repaired, ms: out.ms };
        if (benched[choice]) unbench(choice);
        break;
      } catch (e) {
        const why = whyUnusable(e);
        if (why) bench(choice, why, e.message);
        if (strict) throw e;
        const next = order[order.indexOf(choice) + 1];
        logger.warn(`[producer] ${llm.name} writer failed (${e.message}); trying ${WRITERS[next]?.name || 'the template writer'}`);
        tried.push({ kind: choice, error: String(e.message).slice(0, 300), ...(why ? { why } : {}), ...(spent ? { costUsd: spent } : {}) });
      }
    }
    if (tried.length) {
      // What the failed attempts cost still counts against the daily cap.
      const failedCostUsd = Math.round(tried.reduce((n, t) => n + (t.costUsd || 0), 0) * 10000) / 10000;
      info = { ...info, fallbackFrom: tried[0].kind, fallbackReason: tried[0].error, tried, ...(failedCostUsd ? { failedCostUsd } : {}) };
    }

    if (segmentId && ep.script) {
      const merged = { ...ep.script, segments: ep.script.segments.map(s => (s.id === segmentId ? result.script.segments[0] || s : s)) };
      result = validateScript(merged, { rundown: ep.rundown, personaIds, factNumbers, nicknames, otherIds });
    }
    ep.script = result.script;
    ep.validation = { errors: result.errors, warnings: result.warnings };
    ep.writer = { ...info, at: new Date().toISOString(), history: [...(ep.writer?.history || []), ...(ep.writer ? [{ kind: ep.writer.kind, costUsd: ep.writer.costUsd ?? null, ...(ep.writer.failedCostUsd ? { failedCostUsd: ep.writer.failedCostUsd } : {}), at: ep.writer.at }] : [])].slice(-10) };
    ep.title = result.script?.title || ep.title;
    ep.summary = result.script?.summary || '';
    ep.status = result.errors.length ? 'needs_fixes' : 'draft';
    if (ep.audio) ep.audio = { ...ep.audio, stale: true };
    save(ep);
    if (chain?.voice && ep.status === 'draft') enqueue('voice', id, j => voiceEpisode(id, { job: j, chain }));
    return ep;
  }

  // Save a hand-edited script from the control room.
  function saveScript(id, script) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    const personas = personasFor(ep);
    // The editor doesn't send the poll; keep the writer's unless it does.
    if (script && typeof script === 'object' && !('fanPoll' in script)) script = { ...script, fanPoll: ep.script?.fanPoll || null };
    const result = validateScript(script, { rundown: ep.rundown, personaIds: personas.anchors.map(a => a.id), otherIds: personas.otherIds || [], factNumbers: factNumberSet(JSON.stringify(ep.stories), JSON.stringify(ep.rundown.segments.map(s => s.cards))), nicknames: leagueNicknames(getLeague()) });
    if (!result.script) throw new Error(result.errors.join('; '));
    ep.script = { ...result.script, memoryUpdates: script.memoryUpdates || ep.script?.memoryUpdates || result.script.memoryUpdates };
    ep.validation = { errors: result.errors, warnings: result.warnings };
    ep.title = result.script.title || ep.title;
    ep.summary = result.script.summary || ep.summary;
    ep.status = result.errors.length ? 'needs_fixes' : (ep.status === 'published' ? 'published' : 'draft');
    if (ep.audio) ep.audio = { ...ep.audio, stale: true };
    ep.edited = true;
    save(ep);
    return ep;
  }

  async function voiceEpisode(id, { job = null, chain = null } = {}) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    if (!ep.script || ep.validation?.errors?.length) throw new Error('Fix the script errors before voicing.');
    if (requireRealVoices && tts.provider === 'silent') {
      throw new Error('The voices are not available on the server (Kokoro is not installed), so this episode was not voiced. Redeploy, check the dashboard says the voices are kokoro, then voice it again.');
    }
    const personas = personasFor(ep);
    const settings = { ...getSettings(), ...(ep.voiceEngine ? { voiceEngine: ep.voiceEngine } : {}), ...(ep.elevenModel ? { elevenModel: ep.elevenModel } : {}) };
    // The talk show is paid by the character: check before a credit is spent.
    if (isTalk(ep)) ep.preflight = await talkPreflight(ep, personas, settings);
    const wasPublished = ep.status === 'published';
    ep.status = 'voicing';
    save(ep);
    const build = s => buildEpisodeAudio({
      script: ep.script, rundown: ep.rundown, personas, tts, settings: s,
      onProgress: p => { if (job) job.progress = { stage: 'voicing', ...p }; },
    });
    const charsBefore = tts.usage?.().elevenlabsChars || 0;
    const eleven = settings.voiceEngine === 'elevenlabs' && personas.anchors.some(a => a.elevenVoice);
    let audio, fallback = null;
    try {
      audio = await build(settings);
    } catch (e) {
      // Out of characters or a bad key shouldn't sink the show: voice it with
      // Kokoro instead (lines Kokoro has voiced before come from the cache).
      // The talk show is ElevenLabs or nothing: lines already voiced are cached,
      // so voicing it again after a fix only pays for the rest.
      if (!eleven || isTalk(ep)) throw e;
      logger.warn(`[producer] ElevenLabs voicing failed (${e.message}); using Kokoro voices`);
      fallback = e.message;
      audio = await build({ ...settings, voiceEngine: 'kokoro' });
    }
    const elevenlabsChars = (tts.usage?.().elevenlabsChars || 0) - charsBefore;
    const dir = store.ensureDir(`episodes/${id}`);
    for (const f of ['audio.mp3', 'audio.wav']) store.remove(`episodes/${id}/${f}`);
    const out = await writeEpisodeAudio(audio.samples, audio.sampleRate, dir, 'audio');
    ep.audio = {
      file: out.file, format: out.format, bytes: out.bytes, duration: audio.duration, voicedAt: new Date().toISOString(),
      provider: eleven && !fallback ? `${tts.provider} + elevenlabs` : tts.provider,
      ...(eleven ? { elevenlabsChars, elevenlabsModel: tts.elevenlabs?.model?.(settings.elevenModel) || settings.elevenModel || null } : {}),
      ...(fallback ? { fallbackFrom: 'elevenlabs', fallbackReason: fallback } : {}),
    };
    ep.status = wasPublished ? 'published' : 'ready';
    store.writeJSON(`episodes/${id}/manifest.json`, buildManifest(ep, audio, personas));
    save(ep);
    if (chain?.publish) await publish(id, { discord: true });
    return ep;
  }

  async function talkPreflight(ep, personas, settings) {
    const el = tts.elevenlabs;
    if (!el?.configured?.()) throw new Error('ElevenLabs is not configured (set ELEVENLABS_API_KEY), so the talk show was not voiced.');
    const silent = personas.anchors.filter(a => !a.elevenVoice).map(a => a.short);
    if (silent.length) throw new Error(`${silent.join(', ')} ${silent.length === 1 ? 'has' : 'have'} no ElevenLabs voice; set one in Settings first.`);
    const chars = talkChars(ep);
    const budget = Number(settings.talkCharBudget) || 6000;
    const allow = Math.round(budget * 1.15);
    if (chars > allow) throw new Error(`The script is ${chars.toLocaleString('en-US')} characters, over the ${budget.toLocaleString('en-US')}-character budget (${allow.toLocaleString('en-US')} with the 15% allowance). Trim it or raise the budget, then voice it again.`);
    const sub = await el.subscription?.().catch(() => null);
    if (sub?.ok && chars > sub.left) throw new Error(`The script needs up to ${chars.toLocaleString('en-US')} ElevenLabs credits and the account has ${sub.left.toLocaleString('en-US')} left this month.`);
    return { chars, budget, creditsLeft: sub?.ok ? sub.left : null, note: sub?.ok ? null : (sub?.reason || null), at: new Date().toISOString() };
  }

  function buildManifest(ep, audio, personas) {
    const rsegs = Object.fromEntries(ep.rundown.segments.map(s => [s.id, s]));
    const headlines = ep.rundown.storyIds.map(i => ep.stories[i]).filter(Boolean).sort((a, b) => b.score - a.score).map(s => s.headline.toUpperCase());
    return {
      id: ep.id, type: ep.type, phase: ep.phase,
      title: ep.script.title || ep.title, summary: ep.script.summary || '', weekLabel: ep.weekLabel,
      createdAt: ep.createdAt, publishedAt: ep.publishedAt,
      // Versioned by when it was voiced: media is cached for an hour under one
      // file name, so a re-voiced episode needs a new address to be heard.
      audio: `${ep.audio.file}?v=${Date.parse(ep.audio.voicedAt) || Date.now()}`, duration: audio.duration,
      bugLabel: ep.type === 'breaking' ? 'BREAKING' : isTalk(ep) ? String(ep.rundown?.window?.range || ep.weekLabel || '').toUpperCase() : String(ep.weekLabel || ep.phase || '').toUpperCase(),
      // A show other than HFL-NN brings its own name to the bug, open and end slate.
      ...(isTalk(ep) ? { brand: { name: personas.network.name, bug: personas.network.bug || null, tagline: personas.network.tagline, network: personas.network.hflnnName || 'HFL-NN' } } : {}),
      lineup: personas.anchors.map(a => ({ id: a.id, name: a.name, short: a.short, role: a.role, kind: a.kind, bio: a.bio, look: a.look })),
      segments: audio.segments.map(s => {
        const r = rsegs[s.id] || {};
        return { ...s, title: r.title, lowerThird: r.lowerThird, set: r.set, cards: r.cards || [], sources: sourcesFor(r, ep.stories) };
      }),
      lines: audio.lines,
      mouth: audio.mouth,
      cues: audio.cues,
      ticker: ep.script.tickerItems?.length ? ep.script.tickerItems : headlines.slice(0, 8),
    };
  }

  function sourcesFor(seg, stories) {
    const out = [];
    for (const id of seg.storyIds || []) {
      const s = stories[id];
      if (!s) continue;
      if (s.type === 'chronicle') out.push({ label: `${s.facts.outlet}: "${s.facts.title}"${s.facts.author ? ` by ${s.facts.author}` : ''}`, url: s.facts.url || null });
      else if (s.type === 'hub') out.push({ label: `HFL Hub: ${s.facts.title}` });
      else if (s.type === 'bulletin') out.push({ label: `League office: ${s.headline}` });
      else out.push({ label: `Madden export: ${s.headline}` });
    }
    if (!out.length && seg.cards?.length) out.push({ label: 'Madden export: league standings and stats' });
    return out.filter((s, i, a) => a.findIndex(x => x.label === s.label) === i).slice(0, 8);
  }

  async function publish(id, { discord = true, baseUrl = null } = {}) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    if (!ep.audio) throw new Error('Voice the episode before publishing.');
    if (ep.audio.stale) throw new Error('The script changed since it was voiced. Voice it again first.');
    const settings = getSettings();
    ep.status = 'published';
    ep.publishedAt = ep.publishedAt || new Date().toISOString();
    const manifest = store.readJSON(`episodes/${id}/manifest.json`, null);
    if (manifest) { manifest.publishedAt = ep.publishedAt; store.writeJSON(`episodes/${id}/manifest.json`, manifest); }

    // A daily channel show changes nothing but the schedule; an imported
    // episode (voiced elsewhere) has no stories, memory or Discord post either.
    const side = !!ep.channelShow || !!ep.imported;
    // The talk show writes to the shared memory (its takes are heard on
    // HFL-NN), but covers a window of time rather than taking stories off the
    // wire, and is never posted to Discord.
    if (!ep.memoryApplied && !side) {
      const memory = M.loadMemory(store, memoryPersonas());
      M.applyEpisode(memory, ep, ep.script);
      // Tie tonight's predictions to games still to be played, as the episode saw the league.
      R.anchorChecks(memory.predictions.filter(p => p.episodeId === id && p.check), leagueAsOf(getLeague(), ep.rundown.asOf).league);
      store.writeJSON('memory.json', memory);
      ep.memoryApplied = true;
    }
    if (!side && !isTalk(ep)) {
      for (const s of wire.stories) if (ep.rundown.storyIds.includes(s.id) && !s.usedIn.includes(id)) s.usedIn.push(id);
      saveWire();
      chronicle.markUsed(ep.rundown.storyIds.filter(x => x.startsWith('chronicle:')), id);
      const used = hubUsed();
      for (const x of ep.rundown.storyIds.filter(x => x.startsWith('hub:'))) used.add(x.slice(4));
      store.writeJSON('sources/hub-used.json', [...used].slice(-300));
    }

    const hook = secrets.decryptSecret(settings.discordWebhook);
    if (discord && hook && !ep.discordPostedAt && !side && !isTalk(ep)) {
      const base = (baseUrl || settings.publicUrl || publicUrl() || '').replace(/\/$/, '');
      const headlines = ep.rundown.storyIds.map(i => ep.stories[i]).filter(Boolean).sort((a, b) => b.score - a.score).map(s => s.headline);
      try {
        const poll = settings.fanPolls !== false ? ep.script?.fanPoll : null;
        await postWebhook(hook, episodeMessage({ ...ep, headlines }, base ? `${base}/watch/${id}` : undefined, { poll, personas: getPersonas() }));
        ep.discordPostedAt = new Date().toISOString();
        ep.discordError = null;
      } catch (e) {
        ep.discordError = e.message;
        logger.warn(`[producer] Discord post failed: ${e.message}`);
      }
    }
    save(ep);
    return ep;
  }

  // An episode voiced outside HFL-NN (e.g. ElevenLabs takes made on
  // elevenlabs.io and mixed with lib/audio/mixer.js): its player manifest and
  // its MP3, saved as a ready episode for the desk to preview and publish.
  // It has no script or stories, so it can't be re-voiced or rewritten here.
  function importEpisode({ manifest, audio, title = null, source = null } = {}) {
    const fail = msg => { const e = new Error(msg); e.status = 400; throw e; };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('The manifest must be a JSON object (manifest.json).');
    const num = v => typeof v === 'number' && Number.isFinite(v);
    if (!num(manifest.duration) || manifest.duration <= 0 || manifest.duration > 4 * 3600) fail('The manifest has no usable duration.');
    const lines = manifest.lines;
    if (!Array.isArray(lines) || !lines.length) fail('The manifest has no lines.');
    for (const l of lines) {
      if (!l || typeof l.speaker !== 'string' || typeof l.text !== 'string' || !num(l.t0) || !num(l.t1) || l.t1 < l.t0 || l.t1 > manifest.duration + 1) {
        fail('Every line needs a speaker, text and start/end times inside the episode.');
      }
    }
    if (!manifest.mouth || !num(manifest.mouth.fps) || typeof manifest.mouth.data !== 'string' || !/^[0-3]*$/.test(manifest.mouth.data)) fail('The manifest has no lip-sync track (mouth).');
    if (!Array.isArray(manifest.segments) || !manifest.segments.length) fail('The manifest has no segments.');
    if (typeof audio !== 'string' || !audio) fail('Attach the episode audio (an MP3).');
    const bytes = Buffer.from(audio.replace(/^data:[^,]*,/, ''), 'base64');
    const isMp3 = bytes.length > 4 && (bytes.slice(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    if (!isMp3) fail('The audio must be an MP3.');
    if (bytes.length > 60 * 1024 * 1024) fail('The audio is larger than 60 MB.');

    const now = new Date();
    let id = `${stamp(now)}-import`;
    for (let n = 2; load(id); n++) id = `${stamp(now)}-import${n}`;
    const at = now.toISOString();
    const name = String(title || manifest.title || 'Imported episode').trim().slice(0, 140);
    const dir = store.ensureDir(`episodes/${id}`);
    fs.writeFileSync(path.join(dir, 'audio.mp3'), bytes);
    const ep = {
      id, type: typeof manifest.type === 'string' ? manifest.type : 'custom', phase: manifest.phase || null,
      title: name, summary: typeof manifest.summary === 'string' ? manifest.summary : '', weekLabel: manifest.weekLabel || null,
      status: 'ready', createdAt: at,
      imported: { at, source: source ? String(source).slice(0, 80) : 'import', fromId: typeof manifest.id === 'string' ? manifest.id : null, lines: lines.length },
      audio: { file: 'audio.mp3', format: 'mp3', bytes: bytes.length, duration: manifest.duration, voicedAt: at, provider: source ? String(source).slice(0, 80) : 'imported' },
    };
    store.writeJSON(`episodes/${id}/manifest.json`, {
      ...manifest, id, title: name, createdAt: at, publishedAt: null,
      audio: `audio.mp3?v=${now.getTime()}`,
      cues: Array.isArray(manifest.cues) ? manifest.cues : [],
      ticker: Array.isArray(manifest.ticker) ? manifest.ticker : [],
    });
    save(ep);
    return ep;
  }

  function unpublish(id) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    ep.status = ep.audio ? 'ready' : 'draft';
    save(ep);
    return ep;
  }

  function remove(id) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    if (jobs.some(j => j.episodeId === id && ['queued', 'running'].includes(j.status))) throw new Error('A job is still running for this episode.');
    store.remove(`episodes/${id}`);
    index = index.filter(e => e.id !== id);
    saveIndex();
  }

  // The control room's "start over": every episode, story and job, and the
  // show's memory. (Files are removed with their .bak, or they'd come back.)
  function reset() {
    if (busy()) throw new Error('An episode is still being written or voiced. Try again when it finishes.');
    wire.stories = [];
    saveWire();
    store.remove('episodes');
    index = [];
    saveIndex();
    jobs.length = 0;
    saveJobs();
    for (const f of ['wire.json.bak', 'jobs.json.bak', 'memory.json', 'memory.json.bak', 'sources/hub-used.json', 'sources/hub-used.json.bak']) store.remove(f);
    desk.reset();
  }

  // ── Automation ──────────────────────────────────────────────────────────
  // A batch either finishes a week nobody has covered yet (→ the weekly show)
  // or it's a mid-week export (→ a bulletin if something big just happened).
  // The HFL exports daily, so most batches are the second kind.
  // The commissioner reviews every preseason script before anything is
  // written or voiced: preseason games are exhibitions, and each automatic
  // show or bulletin spends real Claude tokens. During the preseason (detected
  // from the exports, or set in Settings) the wire still fills and the
  // Dashboard still offers "Produce weekly show"; nothing is drafted on its own.
  function automationHeld(league) {
    const s = getSettings();
    return (s.phaseOverride || L.detectPhase(league)) === 'preseason';
  }

  async function onBatch({ batch, prev, cur }, { automate = true } = {}) {
    const stories = S.detectStories({ prev, cur, batch });
    const fresh = addToWire(stories);
    const settings = getSettings();
    const focus = S.focusWeekOf(cur, batch);
    const covered = focus && index.some(e => e.type === 'weekly' && e.status !== 'failed' && sameWeek(e.focusWeek, focus));
    const newWeek = focus && !covered ? focus : null;
    const out = { stories: stories.length, added: fresh.length, newWeek, episodes: [] };
    // Final scores settle predictions; they become receipts for the next show.
    try {
      const memory = M.loadMemory(store, memoryPersonas());
      const graded = R.gradeOpenPredictions(memory, cur);
      if (graded.length) {
        store.writeJSON('memory.json', memory);
        out.graded = graded.length;
        logger.log(`[producer] receipts: graded ${graded.map(p => `"${p.text}" ${p.status}`).join(', ')}`);
      }
    } catch (e) { logger.warn(`[producer] grading predictions failed: ${e.message}`); }
    logger.log(`[producer] batch ${batch.id}: ${stories.length} stories (${fresh.length} new)${newWeek ? `, ${L.weekLabel(newWeek.stage, newWeek.week)} is final` : ''}`);

    if (!automate) return out;
    if (automationHeld(cur)) {
      if (newWeek || fresh.some(S.isBreaking)) logger.log('[producer] preseason: automatic shows and bulletins are held for the commissioner');
      out.held = true;
      return out;
    }
    if (newWeek && (settings.weeklyShow || 'talk') === 'talk') {
      // The Fifth Quarter is the weekly show: a finished HFL week queues
      // nothing (no desk entry, no script), so nothing can be spent on it. A
      // weekly already waiting is dismissed; none was written.
      const gone = desk.dismissWeekly();
      out.weeklySkipped = true;
      logger.log(`[producer] ${L.weekLabel(newWeek.stage, newWeek.week)} is final; the weekly show is ${talkShowName()}, so no HFL-NN weekly is queued${gone ? ` (dismissed ${gone.label})` : ''}`);
    } else if (newWeek) {
      // The weekly covers this batch's transactions too. With approval on
      // (the default) it waits on the week desk for the commissioner.
      if (settings.approveWeekly !== false) {
        const entry = desk.open(newWeek, { label: L.weekLabel(newWeek.stage, newWeek.week), batchId: batch.id });
        out.awaitingApproval = entry.key;
        logger.log(`[producer] ${entry.label} is on the week desk, waiting for the commissioner's approval`);
      } else if (settings.autoProduce) {
        const ep = createEpisode({ type: 'weekly', auto: true, chain: { voice: true, publish: !!settings.autoPublish } });
        out.episodes.push(ep.id);
      }
    } else if (settings.autoBreaking) {
      const big = fresh.filter(S.isBreaking).slice(0, 2);
      if (big.length) {
        const ep = createEpisode({ type: 'breaking', breakingStoryIds: big.map(s => s.id), auto: true, chain: { voice: true, publish: !!settings.autoPublishBreaking } });
        out.episodes.push(ep.id);
      }
    }
    return out;
  }

  function onChronicle(fresh) {
    const settings = getSettings();
    const breaking = fresh.filter(a => a.breaking);
    if (settings.autoBreaking && breaking.length && !automationHeld(getLeague())) {
      createEpisode({ type: 'breaking', chronicleIds: breaking.slice(0, 1).map(a => a.id), auto: true, chain: { voice: true, publish: !!settings.autoPublishBreaking } });
    }
  }

  // A Hub announcement marked breaking becomes a bulletin read by the insider.
  function onHub({ freshAnnouncements = [] } = {}) {
    const settings = getSettings();
    const breaking = freshAnnouncements.filter(a => a.breaking);
    if (settings.autoBreaking && breaking.length && !automationHeld(getLeague())) {
      const a = breaking[0];
      createEpisode({ type: 'breaking', bulletin: { headline: a.title, details: a.body }, auto: true, chain: { voice: true, publish: !!settings.autoPublishBreaking } });
    }
  }

  // The blind test's verdict: reveals both scripts' writers and returns the
  // winner's, for Settings → talk show writer. The loser stays as a draft.
  function pickBlind(id) {
    const ep = load(id);
    if (!ep?.blind) throw new Error('That episode is not part of a blind test.');
    const pair = index.filter(e => e.type === 'talk').map(e => load(e.id)).filter(e => e?.blind?.pair === ep.blind.pair);
    for (const e of pair) { e.blind = { ...e.blind, revealed: true, winner: e.id === id }; save(e); }
    return { writer: ep.writer?.kind || null, episode: ep, others: pair.filter(e => e.id !== id).map(e => e.id) };
  }

  // A blind script hides its writer until the pick.
  function view(ep) {
    if (!ep?.blind || ep.blind.revealed || !ep.writer) return ep;
    const { kind, model, ...rest } = ep.writer;   // eslint-disable-line no-unused-vars
    return { ...ep, writer: { ...rest, kind: 'hidden', history: [] } };
  }

  // What the script writers were paid between two instants (epoch ms), over
  // every episode: first drafts and rewrites, automatic or not. The channel's
  // daily cap is checked against this.
  function spentBetween(from, until) {
    let total = 0;
    for (const sum of index) {
      if (Date.parse(sum.updatedAt || sum.createdAt) < from) continue;
      const ep = load(sum.id);
      for (const w of [ep?.writer, ...(ep?.writer?.history || [])]) {
        const at = Date.parse(w?.at);
        if (!w || !(at >= from && at < until)) continue;
        if (Number.isFinite(w.costUsd)) total += w.costUsd;
        if (Number.isFinite(w.failedCostUsd)) total += w.failedCostUsd;
      }
    }
    return Math.round(total * 10000) / 10000;
  }

  // ── Read side ───────────────────────────────────────────────────────────
  function published() {
    return index.filter(e => e.status === 'published').sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  }

  function ticker() {
    const league = getLeague();
    const items = [];
    const wk = L.lastPlayedWeek(league);
    if (wk) {
      for (const g of L.gamesForWeek(league, wk.seasonIndex, wk.stage, wk.week).filter(x => x.played).slice(0, 16)) {
        const a = C.teamRef(league, g.awayId), h = C.teamRef(league, g.homeId);
        items.push(`${a.abbr} ${g.awayScore}  ${h.abbr} ${g.homeScore}  FINAL`);
      }
    }
    for (const s of wire.stories.filter(x => !x.usedIn.length && x.type !== 'game').slice(0, 6)) items.push(s.headline.toUpperCase());
    const last = published()[0];
    return {
      items: items.length ? items : ['WELCOME TO HFL-NN', 'THE FIRST BROADCAST AIRS AFTER THE NEXT LEAGUE EXPORT'],
      message: last ? `LAST: ${String(last.title).toUpperCase()}` : 'FIRST BROADCAST SOON',
      lineup: getPersonas().anchors.map(a => ({ id: a.id, name: a.name, short: a.short, role: a.role, kind: a.kind, bio: a.bio, look: a.look })),
    };
  }

  return {
    // wire
    addToWire, flagStory, retireWire, wireStories: () => wire.stories, selectStories,
    // episodes
    createEpisode, writeScript, saveScript, publish, unpublish, remove, importEpisode, pickWriter, writerChain, benchedWriters: benchedNow, unbenchWriter: unbench,
    voice: (id, { publish: andPublish = false } = {}) => enqueue('voice', id, job => voiceEpisode(id, { job, chain: andPublish ? { publish: true } : null })),
    pickBlind, view, talkChars: id => talkChars(load(id)), gatherWindow: () => T.gatherWindow(index),
    rewrite: (id, opts = {}) => enqueue('write', id, job => writeScript(id, { ...opts, job })),
    get: load, list: () => index, published,
    manifest: id => (ID_RE.test(String(id)) ? store.readJSON(`episodes/${id}/manifest.json`, null) : null),
    // jobs & automation
    jobs: () => jobs.slice(0, 50), idle, busy, reset, onBatch, onChronicle, onHub, ticker,
    // the channel's daily shows
    spentBetween, held: () => automationHeld(getLeague()), liveStories,
    // week desk
    desk, deskView, openDesk, approveDesk,
    ID_RE,
  };
}

module.exports = { createProducer };
