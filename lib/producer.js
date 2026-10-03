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
const L = require('./league');
const S = require('./stories');
const C = require('./cards');
const { buildRundown, chronicleItem, hubItem } = require('./rundown');
const { writeTemplateScript } = require('./writer/template');
const { validateScript, factNumberSet } = require('./writer/validate');
const P = require('./writer/prompt');
const M = require('./memory');
const { buildEpisodeAudio } = require('./audio/mixer');
const { writeEpisodeAudio } = require('./audio/encode');
const { postWebhook, episodeMessage } = require('./discord');
const secrets = require('./secrets');
const { sha256 } = require('./util');

const SUMMARY_KEYS = ['id', 'type', 'phase', 'title', 'summary', 'status', 'weekLabel', 'createdAt', 'updatedAt', 'publishedAt', 'error'];
const ID_RE = /^[a-z0-9-]{6,64}$/;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function createProducer({
  store, show, getPersonas, getLeague, getSettings, tts, claude, chronicle, hub,
  publicUrl = () => '', logger = console,
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

  function selectStories({ focusWeek, storyIds }) {
    let list = wire.stories.filter(s => !s.excluded);
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
    sum.writer = ep.writer?.kind || null;
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
      bulletin = null, writer = 'auto', title = null, chain = null,
    } = opts;
    if (!['weekly', 'breaking', 'special', 'custom'].includes(type)) throw new Error(`Unknown episode type "${type}"`);
    const league = getLeague();
    const settings = getSettings();
    const personas = getPersonas();
    const phase = opts.phase || settings.phaseOverride || L.detectPhase(league);
    const focusWeek = L.lastCompleteWeek(league) || L.lastPlayedWeek(league);
    const stories = S.withOfficialGotw(selectStories({ focusWeek, storyIds }), S.officialGotwKey(league, focusWeek, hub.data()));

    // Give the writer the article itself, not just the teaser.
    const articles = type === 'breaking' ? [] : chronicle.unused().slice(0, 3).map(a => {
      const item = chronicleItem(a, chronicle.outlet);
      item.facts.text = a.text.slice(0, 5000);
      return item;
    });
    const usedHub = hubUsed();
    const hubData = hub.data();
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

    const context = S.buildContext(league, { focusWeek, hub: hubData });
    const rundown = buildRundown({ type, phase, show, personas, league, context, stories, chronicle: articles, hub: hubItems, customKinds, breakingStories, title, notes });
    const id = `${stamp()}-${type}`;
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
    save(ep);
    enqueue('write', id, job => writeScript(id, { writer, job, chain }));
    return ep;
  }

  // eslint-disable-next-line no-unused-vars
  const stripWire = ({ usedIn, pinned, excluded, ...story }) => story;

  // Write (or rewrite) the script; `segmentId` rewrites a single segment.
  async function writeScript(id, { writer = 'auto', job = null, segmentId = null, notes = null, chain = null } = {}) {
    const ep = load(id);
    if (!ep) throw new Error('Episode not found');
    const personas = getPersonas();
    const settings = getSettings();
    const league = getLeague();
    const personaIds = personas.anchors.map(a => a.id);
    ep.status = 'writing';
    ep.error = null;
    save(ep);

    let rundown = ep.rundown;
    if (segmentId) {
      const seg = rundown.segments.find(s => s.id === segmentId);
      if (!seg) throw new Error(`No segment ${segmentId}`);
      rundown = { ...rundown, segments: [seg], targetWords: seg.targetWords, storyIds: seg.storyIds };
    }
    const memory = M.loadMemory(store, personas);
    const context = S.buildContext(league, { focusWeek: ep.rundown.focusWeek, hub: hub.data() });
    const brief = P.episodeBrief({ rundown, storiesById: ep.stories, personas, memory, notes: notes ?? ep.notes })
      + (segmentId && ep.script ? `\n\nOnly write segment ${segmentId}. The rest of the episode currently reads:\n${ep.script.segments.filter(s => s.id !== segmentId).map(s => s.lines.map(l => `${l.speaker}: ${l.text}`).join('\n')).join('\n')}` : '');
    const leagueText = P.leagueContext(league, context, { phase: ep.phase, hub: hub.data() });
    const factNumbers = factNumberSet(brief, leagueText, JSON.stringify(ep.stories));
    const validate = s => validateScript(s, { rundown, personaIds, factNumbers });
    const template = () => validate(writeTemplateScript({ rundown, storiesById: ep.stories, personas, league, context, seed: `${id}-${Date.now()}` }));

    const choice = writer === 'auto' ? (settings.writer === 'template' || !claude.available() ? 'template' : 'claude') : writer;
    let result, info;
    if (choice === 'claude') {
      if (!claude.available()) throw new Error('Claude is not configured (set ANTHROPIC_API_KEY).');
      try {
        const out = await claude.write({
          personas, settings, leagueText, brief, validate,
          model: settings.claudeModel, kind: ep.type === 'breaking' ? 'bulletin' : 'show',
          onProgress: p => { if (job) job.progress = { stage: 'writing', chars: p.chars }; },
        });
        if (!out.result.ok) throw new Error(`Claude's script failed validation: ${out.result.errors.slice(0, 3).join('; ')}`);
        result = out.result;
        info = { kind: 'claude', model: out.model, usage: out.usage, costUsd: out.costUsd, repaired: out.repaired, ms: out.ms };
      } catch (e) {
        if (writer === 'claude') throw e;
        logger.warn(`[producer] Claude writer failed (${e.message}); using the template writer`);
        result = template();
        info = { kind: 'template', fallbackFrom: 'claude', fallbackReason: e.message };
      }
    } else {
      result = template();
      info = { kind: 'template' };
    }

    if (segmentId && ep.script) {
      const merged = { ...ep.script, segments: ep.script.segments.map(s => (s.id === segmentId ? result.script.segments[0] || s : s)) };
      result = validateScript(merged, { rundown: ep.rundown, personaIds, factNumbers });
    }
    ep.script = result.script;
    ep.validation = { errors: result.errors, warnings: result.warnings };
    ep.writer = { ...info, at: new Date().toISOString(), history: [...(ep.writer?.history || []), ...(ep.writer ? [{ kind: ep.writer.kind, costUsd: ep.writer.costUsd ?? null, at: ep.writer.at }] : [])].slice(-10) };
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
    const personas = getPersonas();
    const result = validateScript(script, { rundown: ep.rundown, personaIds: personas.anchors.map(a => a.id), factNumbers: factNumberSet(JSON.stringify(ep.stories), JSON.stringify(ep.rundown.segments.map(s => s.cards))) });
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
    const wasPublished = ep.status === 'published';
    ep.status = 'voicing';
    save(ep);
    const personas = getPersonas();
    const settings = getSettings();
    const audio = await buildEpisodeAudio({
      script: ep.script, rundown: ep.rundown, personas, tts, settings,
      onProgress: p => { if (job) job.progress = { stage: 'voicing', ...p }; },
    });
    const dir = store.ensureDir(`episodes/${id}`);
    for (const f of ['audio.mp3', 'audio.wav']) store.remove(`episodes/${id}/${f}`);
    const out = await writeEpisodeAudio(audio.samples, audio.sampleRate, dir, 'audio');
    ep.audio = { file: out.file, format: out.format, bytes: out.bytes, duration: audio.duration, voicedAt: new Date().toISOString(), provider: tts.provider };
    ep.status = wasPublished ? 'published' : 'ready';
    store.writeJSON(`episodes/${id}/manifest.json`, buildManifest(ep, audio, personas));
    save(ep);
    if (chain?.publish) await publish(id, { discord: true });
    return ep;
  }

  function buildManifest(ep, audio, personas) {
    const rsegs = Object.fromEntries(ep.rundown.segments.map(s => [s.id, s]));
    const headlines = ep.rundown.storyIds.map(i => ep.stories[i]).filter(Boolean).sort((a, b) => b.score - a.score).map(s => s.headline.toUpperCase());
    return {
      id: ep.id, type: ep.type, phase: ep.phase,
      title: ep.script.title || ep.title, summary: ep.script.summary || '', weekLabel: ep.weekLabel,
      createdAt: ep.createdAt, publishedAt: ep.publishedAt,
      audio: ep.audio.file, duration: audio.duration,
      bugLabel: ep.type === 'breaking' ? 'BREAKING' : String(ep.weekLabel || ep.phase || '').toUpperCase(),
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
    const personas = getPersonas();
    const settings = getSettings();
    ep.status = 'published';
    ep.publishedAt = ep.publishedAt || new Date().toISOString();
    const manifest = store.readJSON(`episodes/${id}/manifest.json`, null);
    if (manifest) { manifest.publishedAt = ep.publishedAt; store.writeJSON(`episodes/${id}/manifest.json`, manifest); }

    if (!ep.memoryApplied) {
      const memory = M.loadMemory(store, personas);
      M.applyEpisode(memory, ep, ep.script);
      store.writeJSON('memory.json', memory);
      ep.memoryApplied = true;
    }
    for (const s of wire.stories) if (ep.rundown.storyIds.includes(s.id) && !s.usedIn.includes(id)) s.usedIn.push(id);
    saveWire();
    chronicle.markUsed(ep.rundown.storyIds.filter(x => x.startsWith('chronicle:')), id);
    const used = hubUsed();
    for (const x of ep.rundown.storyIds.filter(x => x.startsWith('hub:'))) used.add(x.slice(4));
    store.writeJSON('sources/hub-used.json', [...used].slice(-300));

    const hook = secrets.decryptSecret(settings.discordWebhook);
    if (discord && hook && !ep.discordPostedAt) {
      const base = (baseUrl || settings.publicUrl || publicUrl() || '').replace(/\/$/, '');
      const headlines = ep.rundown.storyIds.map(i => ep.stories[i]).filter(Boolean).sort((a, b) => b.score - a.score).map(s => s.headline);
      try {
        await postWebhook(hook, episodeMessage({ ...ep, headlines }, base ? `${base}/watch/${id}` : undefined));
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
  }

  // ── Automation ──────────────────────────────────────────────────────────
  // A batch either finishes a week nobody has covered yet (→ the weekly show)
  // or it's a mid-week export (→ a bulletin if something big just happened).
  // The HFL exports daily, so most batches are the second kind.
  async function onBatch({ batch, prev, cur }, { automate = true } = {}) {
    const stories = S.detectStories({ prev, cur, batch });
    const fresh = addToWire(stories);
    const settings = getSettings();
    const focus = S.focusWeekOf(cur, batch);
    const covered = focus && index.some(e => e.type === 'weekly' && e.status !== 'failed' && sameWeek(e.focusWeek, focus));
    const newWeek = focus && !covered ? focus : null;
    const out = { stories: stories.length, added: fresh.length, newWeek, episodes: [] };
    logger.log(`[producer] batch ${batch.id}: ${stories.length} stories (${fresh.length} new)${newWeek ? `, ${L.weekLabel(newWeek.stage, newWeek.week)} is final` : ''}`);

    if (!automate) return out;
    if (newWeek) {
      // The weekly covers this batch's transactions too.
      if (settings.autoProduce) {
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
    if (settings.autoBreaking && breaking.length) {
      createEpisode({ type: 'breaking', chronicleIds: breaking.slice(0, 1).map(a => a.id), auto: true, chain: { voice: true, publish: !!settings.autoPublishBreaking } });
    }
  }

  // A Hub announcement marked breaking becomes a bulletin read by the insider.
  function onHub({ freshAnnouncements = [] } = {}) {
    const settings = getSettings();
    const breaking = freshAnnouncements.filter(a => a.breaking);
    if (settings.autoBreaking && breaking.length) {
      const a = breaking[0];
      createEpisode({ type: 'breaking', bulletin: { headline: a.title, details: a.body }, auto: true, chain: { voice: true, publish: !!settings.autoPublishBreaking } });
    }
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
    createEpisode, writeScript, saveScript, publish, unpublish, remove,
    voice: id => enqueue('voice', id, job => voiceEpisode(id, { job })),
    rewrite: (id, opts = {}) => enqueue('write', id, job => writeScript(id, { ...opts, job })),
    get: load, list: () => index, published,
    manifest: id => (ID_RE.test(String(id)) ? store.readJSON(`episodes/${id}/manifest.json`, null) : null),
    // jobs & automation
    jobs: () => jobs.slice(0, 50), idle, busy, reset, onBatch, onChronicle, onHub, ticker,
    ID_RE,
  };
}

module.exports = { createProducer };
