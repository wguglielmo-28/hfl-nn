// HFL-NN server: the public channel, the Madden export receiver, the HFL Hub
// and Crimson Chronicle readers, and the commissioner's control room.
//
//   npm start            → http://localhost:3000        (channel)
//                          http://localhost:3000/control (control room)
//
// See README.md for setup and DEPLOYMENT.md for Railway.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { resolveDataDir, createStore } = require('./lib/store');
const secrets = require('./lib/secrets');
const net = require('./lib/net');
const L = require('./lib/league');
const { createMaddenIngest, detectPayload } = require('./lib/ingest/madden');
const { createHubSource } = require('./lib/ingest/hub');
const { createChronicleSource } = require('./lib/ingest/chronicle');
const { createTTS, voiceLabel, KOKORO_VOICES } = require('./lib/tts');
const { encodeWav } = require('./lib/audio/wav');
const { findFfmpeg } = require('./lib/audio/encode');
const { createClaudeWriter } = require('./lib/writer/claude');
const { createProducer } = require('./lib/producer');
const { createAuth } = require('./lib/auth');
const { createSettings } = require('./lib/settings');
const { postWebhook } = require('./lib/discord');
const M = require('./lib/memory');
const S = require('./lib/stories');

const PUBLIC = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;

function createApp(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const dataDir = opts.dataDir || resolveDataDir(env);
  const store = createStore(dataDir);

  // ── At-rest encryption key (protects the Discord webhook) ────────────────
  const keyFile = path.join(dataDir, '.instance-key');
  let seed = null;
  try {
    if (fs.existsSync(keyFile)) seed = fs.readFileSync(keyFile, 'utf8').trim();
    else { seed = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, seed, { mode: 0o600 }); }
  } catch { seed = 'hfl-nn-ephemeral'; }
  secrets.configureKey({ secret: env.SECRET_KEY, fallbackSeed: seed });

  // ── The export URL secret ────────────────────────────────────────────────
  // INGEST_KEY if set, else a generated one kept in DATA_DIR so the URL the
  // commissioner pasted into Snallabot keeps working across restarts.
  let ingestKey = env.INGEST_KEY;
  if (!ingestKey) {
    ingestKey = store.readJSON('ingest-key.json', null)?.key;
    if (!ingestKey) { ingestKey = crypto.randomBytes(12).toString('base64url'); store.writeJSON('ingest-key.json', { key: ingestKey }); }
  }
  const ingestKeyDigest = secrets.sha256(ingestKey);

  const basePersonas = opts.personas || JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'personas.json'), 'utf8'));
  const show = opts.show || JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'show.json'), 'utf8'));
  const settings = createSettings({ store, basePersonas, env });

  // ── League state ─────────────────────────────────────────────────────────
  let league = store.readJSON('league/current.json', null) || L.emptyLeague();
  let saveTimer = null;
  const saveLeague = (now = false) => {
    clearTimeout(saveTimer);
    if (now) return store.writeJSON('league/current.json', league);
    saveTimer = setTimeout(() => store.writeJSON('league/current.json', league), 2000);
    saveTimer.unref?.();
  };

  // ── Services ─────────────────────────────────────────────────────────────
  const tts = opts.tts || createTTS({ provider: env.TTS_PROVIDER || 'auto', cacheDir: path.join(dataDir, 'tts-cache'), modelDir: path.join(dataDir, 'models'), logger });
  const claude = opts.claude || createClaudeWriter({ apiKey: env.ANTHROPIC_API_KEY, model: env.HFLNN_MODEL || undefined, logger });
  let producer = null;
  const chronicle = createChronicleSource({
    store, getUrl: () => settings.get().chronicleFeedUrl, outlet: basePersonas.network.chronicleName || 'The Crimson Chronicle',
    onNew: fresh => producer?.onChronicle(fresh), fetchImpl: opts.fetchImpl, logger,
  });
  const hub = createHubSource({ store, getUrl: () => settings.get().hubFeedUrl, onUpdate: u => producer?.onHub(u), fetchImpl: opts.fetchImpl, logger });
  const publicUrl = () => settings.get().publicUrl || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  producer = createProducer({
    store, show, getPersonas: settings.personas, getLeague: () => league, getSettings: settings.get,
    tts, claude, chronicle, hub, publicUrl, logger,
  });
  let quietBatches = false;   // set while loading the sample league's first batch
  const ingest = createMaddenIngest({
    store, getLeague: () => league, saveLeague, logger,
    debounceMs: opts.debounceMs ?? (Number(env.EXPORT_DEBOUNCE_SECONDS) || 90) * 1000,
    onBatchComplete: x => producer.onBatch(x, { automate: !quietBatches }),
    onLeagueChange: ({ from, to }) => logger.log(`[producer] league ${from} → ${to}: retired ${producer.retireWire()} unused stories`),
  });

  const httpsOnly = env.FORCE_HTTPS === '1' || (env.NODE_ENV === 'production' && env.FORCE_HTTPS !== '0');
  const auth = createAuth({ store, password: env.ADMIN_PASSWORD, secure: httpsOnly, logger });
  const extraOrigins = net.parseExtraOrigins(env);

  // ── Express ──────────────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);   // Railway terminates TLS one hop in front

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        styleSrcElem: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: httpsOnly ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()');
    next();
  });
  // Cross-origin browser requests are refused outright. Exporters and the Hub
  // are servers, not browsers, so they send no Origin header.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && !net.originAllowed(origin, req.headers.host, extraOrigins)) return res.status(403).send('Origin not allowed');
    next();
  });
  app.use((req, res, next) => {
    if (!httpsOnly) return next();
    const proto = req.get('x-forwarded-proto') || req.protocol;
    if (proto === 'https') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).send('HTTPS required');
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });

  // ── Madden export receiver ───────────────────────────────────────────────
  const ingestLimiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/ingest/:key', ingestLimiter, (req, res, next) => {
    if (!secrets.hashEq(secrets.sha256(req.params.key), ingestKeyDigest)) return res.status(404).json({ error: 'Not found' });
    next();
  }, ingest.router);

  app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests — slow down.' } }));

  // ── HFL Hub push ─────────────────────────────────────────────────────────
  app.post('/api/hub/push', express.json({ limit: '2mb' }), (req, res) => {
    const key = env.HUB_PUSH_KEY;
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!key || !secrets.hashEq(secrets.sha256(given), secrets.sha256(key))) return res.status(401).json({ error: 'Bad or missing HUB_PUSH_KEY' });
    try { res.json(hub.push(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Public API ───────────────────────────────────────────────────────────
  const pickEpisode = e => ({ id: e.id, type: e.type, title: e.title, summary: e.summary, weekLabel: e.weekLabel, publishedAt: e.publishedAt, duration: e.duration });
  app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));
  app.get('/api/episodes', (req, res) => res.json(producer.published().map(pickEpisode)));
  app.get('/api/episodes/:id', (req, res) => {
    const sum = producer.list().find(e => e.id === req.params.id);
    const m = sum?.status === 'published' && producer.manifest(req.params.id);
    if (!m) return res.status(404).json({ error: 'Episode not found' });
    res.set('Cache-Control', 'public, max-age=60').json(m);
  });
  app.get('/api/ticker', (req, res) => res.json(producer.ticker()));

  const sendMedia = (req, res, id) => {
    const ep = producer.get(id);
    const file = ep?.audio?.file;
    if (!file || req.params.file !== file) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(store.path(`episodes/${id}/${file}`));
  };
  app.get('/media/:id/:file', (req, res) => {
    const sum = producer.list().find(e => e.id === req.params.id);
    if (sum?.status !== 'published') return res.status(404).end();
    sendMedia(req, res, req.params.id);
  });

  // ── Control room auth ────────────────────────────────────────────────────
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } });
  app.post('/api/login', loginLimiter, express.json({ limit: '4kb' }), (req, res) => {
    const token = auth.login(req.body?.password);
    if (!token) return res.status(401).json({ error: 'Wrong password' });
    res.set('Set-Cookie', auth.cookie(token)).json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    auth.logout(req);
    res.set('Set-Cookie', auth.cookie('', 0)).json({ ok: true });
  });

  // ── Control room API ─────────────────────────────────────────────────────
  const admin = express.Router();
  admin.use(auth.requireAdmin);
  admin.use(express.json({ limit: '100mb' }));
  const wrap = fn => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      logger.warn(`[admin] ${req.method} ${req.path}: ${e.message}`);
      if (!res.headersSent) res.status(e.status || 400).json({ error: e.message });
    }
  };
  const need = (cond, msg, status = 404) => { if (!cond) { const e = new Error(msg); e.status = status; throw e; } };
  const baseUrlOf = req => publicUrl() || `${req.protocol}://${req.get('host')}`;

  admin.get('/me', wrap(() => ({ ok: true })));
  admin.get('/status', wrap(req => {
    const wk = L.lastPlayedWeek(league);
    const done = L.lastCompleteWeek(league);
    return {
      version: VERSION,
      dataDir: store.dir,
      persistentVolume: store.dir.startsWith('/data'),
      ingestUrl: `${baseUrlOf(req)}/ingest/${ingestKey}`,
      league: {
        leagueId: league.leagueId, platform: league.platform, updatedAt: league.updatedAt, calendarYear: league.calendarYear,
        teams: Object.keys(league.teams).length, players: Object.keys(league.players).length,
        games: Object.keys(league.games).length, standingsFresh: league.standingsFresh !== false,
        latestWeek: wk ? L.weekLabel(wk.stage, wk.week) : null,
        latestWeekFinal: !!wk && L.weekComplete(league, wk),
        lastFinalWeek: done ? L.weekLabel(done.stage, done.week) : null,
        detectedPhase: L.detectPhase(league), phase: settings.get().phaseOverride || L.detectPhase(league),
      },
      ingest: ingest.status(),
      batches: store.readJSON('league/batches.json', []).slice(-10).reverse(),
      chronicle: chronicle.status(),
      hub: hub.status(),
      writer: { claude: claude.available(), model: settings.get().claudeModel || claude.model, mode: settings.get().writer },
      tts: { ...tts.status(), ffmpeg: !!findFfmpeg() },
      wire: { total: producer.wireStories().length, unused: producer.wireStories().filter(s => !s.usedIn.length && !s.excluded).length },
      jobs: producer.jobs().slice(0, 5),
      generatedPassword: !!auth.generatedPassword,
    };
  }));

  admin.post('/upload', wrap(req => {
    const payloads = Array.isArray(req.body?.payloads) ? req.body.payloads : [req.body];
    const results = [];
    for (const body of payloads) {
      const kind = detectPayload(body);
      if (!kind) { results.push({ ok: false, error: 'Not a recognised Madden export payload' }); continue; }
      results.push(ingest.ingest({ ...kind, body, source: 'upload', platform: league.platform || 'upload', leagueId: league.leagueId || 'upload' }));
    }
    return { results };
  }));
  admin.post('/batch/flush', wrap(async () => ({ batch: await ingest.flush() })));
  admin.post('/sample-data', wrap(async req => {
    need(!Object.keys(league.teams).length || req.body?.force, 'League data already exists. Sample data is only for an empty install.', 409);
    return loadSampleLeague();
  }));
  admin.post('/reset', wrap(req => {
    need(req.body?.confirm === 'RESET', 'Type RESET to confirm.', 400);
    return startOver();
  }));

  admin.get('/wire', wrap(() => producer.wireStories().slice(0, 200).map(s => ({
    id: s.id, type: s.type, category: s.category, score: s.score, headline: s.headline, createdAt: s.createdAt,
    usedIn: s.usedIn, pinned: s.pinned, excluded: s.excluded, breaking: S.isBreaking(s), facts: s.facts,
  }))));
  admin.post('/wire/:id', wrap(req => {
    const s = producer.flagStory(req.params.id, req.body || {});
    need(s, 'Story not found');
    return { ok: true };
  }));

  admin.get('/chronicle', wrap(() => chronicle.list().map(({ text, ...a }) => ({ ...a, words: text.split(/\s+/).length }))));
  admin.post('/chronicle/refresh', wrap(() => chronicle.refresh()));
  admin.post('/chronicle/add', wrap(async req => {
    if (req.body?.url) return chronicle.addUrl(req.body.url);
    return chronicle.addText(req.body || {});
  }));
  admin.post('/hub/refresh', wrap(() => hub.refresh()));
  admin.get('/hub', wrap(() => hub.data() || {}));

  admin.get('/episodes', wrap(() => producer.list()));
  admin.post('/episodes', wrap(req => producer.createEpisode(req.body || {})));
  admin.get('/episodes/:id', wrap(req => {
    const ep = producer.get(req.params.id);
    need(ep, 'Episode not found');
    return ep;
  }));
  admin.put('/episodes/:id/script', wrap(req => producer.saveScript(req.params.id, req.body)));
  admin.post('/episodes/:id/rewrite', wrap(req => {
    need(producer.get(req.params.id), 'Episode not found');
    const { segmentId = null, notes = null, writer = 'auto' } = req.body || {};
    return { job: producer.rewrite(req.params.id, { segmentId, notes, writer }) };
  }));
  admin.post('/episodes/:id/voice', wrap(req => {
    const ep = producer.get(req.params.id);
    need(ep, 'Episode not found');
    need(!ep.validation?.errors?.length, 'Fix the script errors before voicing.', 400);
    return { job: producer.voice(req.params.id) };
  }));
  admin.post('/episodes/:id/publish', wrap(req => producer.publish(req.params.id, { discord: req.body?.discord !== false, baseUrl: baseUrlOf(req) })));
  admin.post('/episodes/:id/unpublish', wrap(req => producer.unpublish(req.params.id)));
  admin.delete('/episodes/:id', wrap(req => { producer.remove(req.params.id); return { ok: true }; }));
  admin.get('/episodes/:id/manifest', wrap(req => {
    const m = producer.manifest(req.params.id);
    need(m, 'This episode has not been voiced yet.');
    return m;
  }));
  admin.get('/media/:id/:file', (req, res) => sendMedia(req, res, req.params.id));
  admin.get('/jobs', wrap(() => producer.jobs()));

  admin.get('/settings', wrap(() => settings.publicView()));
  admin.put('/settings', wrap(req => settings.update(req.body || {})));
  admin.post('/discord/test', wrap(async () => {
    const hook = secrets.decryptSecret(settings.get().discordWebhook);
    need(hook, 'Add a Discord webhook first.', 400);
    await postWebhook(hook, { content: '📺 HFL-NN is connected. New episodes will be announced here.' });
    return { ok: true };
  }));
  admin.post('/tts/preview', wrap(async (req, res) => {
    const voice = KOKORO_VOICES.includes(req.body?.voice) ? req.body.voice : 'am_michael';
    const text = String(req.body?.text || `This is ${voiceLabel(voice)} on HFL-NN.`).slice(0, 240);
    const out = await tts.speak(text, { voice, speed: Number(req.body?.speed) || 1 });
    res.set('Content-Type', 'audio/wav').send(encodeWav(out.samples, out.sampleRate));
  }));
  admin.get('/memory', wrap(() => M.loadMemory(store, settings.personas())));
  admin.post('/memory/prediction', wrap(req => {
    const mem = M.loadMemory(store, settings.personas());
    const p = M.resolvePrediction(mem, req.body?.id, req.body?.status);
    need(p, 'Prediction not found');
    store.writeJSON('memory.json', mem);
    return p;
  }));

  app.use('/api/admin', admin);

  // ── Pages ────────────────────────────────────────────────────────────────
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function channelPage(req, ep) {
    const base = baseUrlOf(req);
    const title = ep ? `${ep.title} — HFL-NN` : 'HFL-NN — HFL News Network';
    const desc = ep?.summary || 'Pixel-art AI anchors report on the Hypnotical Football League.';
    const tags = [
      ['og:site_name', 'HFL-NN'], ['og:title', title], ['og:description', desc],
      ['og:type', ep ? 'video.episode' : 'website'], ['og:url', `${base}${req.originalUrl.split('?')[0]}`],
      ['og:image', `${base}/img/og.png`],
    ].map(([p, c]) => `<meta property="${p}" content="${esc(c)}">`).join('\n  ') + '\n  <meta name="twitter:card" content="summary_large_image">';
    return indexHtml.replace('<!--OG-->', tags).replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  }
  app.get('/', (req, res) => res.type('html').send(channelPage(req, null)));
  app.get('/watch/:id', (req, res) => {
    const sum = producer.list().find(e => e.id === req.params.id && e.status === 'published');
    res.type('html').status(sum ? 200 : 404).send(channelPage(req, sum));
  });
  app.get('/control', (req, res) => res.sendFile(path.join(PUBLIC, 'control.html')));
  app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // ── Background polling of the Hub and the Chronicle ─────────────────────
  let pollTimer = null;
  function startPolling() {
    const tick = async () => {
      if (settings.get().chronicleFeedUrl) await chronicle.refresh().catch(() => {});
      if (settings.get().hubFeedUrl) await hub.refresh().catch(() => {});
      pollTimer = setTimeout(tick, settings.get().pollMinutes * 60 * 1000);
      pollTimer.unref?.();
    };
    pollTimer = setTimeout(tick, 10 * 1000);
    pollTimer.unref?.();
  }

  // Remove the league and everything made from it — the sample league, or
  // exports from before a fantasy draft. Settings, the Discord webhook, the
  // export URL and the voice cache stay. The Chronicle and Hub refill from
  // their URLs (the Chronicle from its newest issue only).
  function startOver() {
    need(!ingest.status().open, 'An export is arriving right now. Try again in a couple of minutes.', 409);
    need(!producer.busy(), 'An episode is still being written or voiced. Try again when it finishes.', 409);
    const removed = { leagueId: league.leagueId, episodes: producer.list().length, stories: producer.wireStories().length };
    ingest.reset();
    producer.reset();
    chronicle.reset();
    hub.reset();
    logger.log(`[control] started over: removed league ${removed.leagueId}, ${removed.episodes} episodes, ${removed.stories} stories`);
    for (const src of [chronicle, hub]) src.refresh().catch(e => logger.warn(`[control] refresh after start-over failed: ${e.message}`));
    return { ok: true, removed };
  }

  // The demo league: two consistent export batches, a Chronicle article and
  // a Hub feed (see lib/demo.js). Only offered on an empty install.
  async function loadSampleLeague() {
    const { demoBatches, SAMPLE_ARTICLE, SAMPLE_HUB } = require('./lib/demo');
    // Article and Hub feed first, so the show drafted after the last batch can use them.
    chronicle.addText(SAMPLE_ARTICLE);
    hub.push(SAMPLE_HUB);
    const batches = [];
    const all = demoBatches();
    for (const [i, payloads] of all.entries()) {
      for (const p of payloads) ingest.ingest(p);
      quietBatches = i < all.length - 1;   // only the latest week triggers the newsroom
      try { batches.push(await ingest.flush()); } finally { quietBatches = false; }
    }
    return { batches: batches.map(b => b?.id) };
  }

  return {
    app, store, producer, ingest, settings, tts, auth, chronicle, hub,
    ingestKey, startPolling, loadSampleLeague, startOver,
    getLeague: () => league,
    close: async () => { clearTimeout(pollTimer); clearTimeout(saveTimer); await tts.close?.(); },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const ctx = createApp();
  ctx.startPolling();
  ctx.app.listen(port, () => {
    const persistent = ctx.store.dir.startsWith('/data');
    console.log(`\n  📺 HFL-NN v${VERSION} on http://localhost:${port}`);
    console.log(`     Control room:   http://localhost:${port}/control`);
    console.log(`     Data directory: ${ctx.store.dir}${persistent ? ' (persistent volume)' : ''}`);
    console.log(`     Voices:         ${ctx.tts.provider}${ctx.tts.provider === 'silent' ? ' (install optional dependency kokoro-js for real voices)' : ''}`);
    console.log(`     Writer:         ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'template (set ANTHROPIC_API_KEY for Claude)'}\n`);
  });
}

module.exports = { createApp };
