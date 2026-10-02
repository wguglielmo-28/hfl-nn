// Madden 27 export receiver.
//
// Speaks the Madden Companion App export protocol — the same routes and JSON
// shapes Snallabot's "custom export URL" posts — so either can point at
//   https://<host>/ingest/<INGEST_KEY>
// and the app appends /:platform/:leagueId/... itself. The key check lives in
// server.js; this module only parses, applies and batches.
//
// An "export" is a burst of requests (teams, standings, a week of stats, 32
// rosters, free agents...). Payloads are applied to the live league as they
// land; once no request has arrived for `debounceMs`, the burst is closed as a
// batch: the league is snapshotted and `onBatchComplete(prev, cur, batch)`
// runs the story engine against the previous snapshot.
'use strict';
const express = require('express');
const L = require('../league');

// Week-route kind → payload list key
const WEEK_LISTS = {
  schedules: 'gameScheduleInfoList',
  teamstats: 'teamStatInfoList',
  passing: 'playerPassingStatInfoList',
  rushing: 'playerRushingStatInfoList',
  receiving: 'playerReceivingStatInfoList',
  defense: 'playerDefensiveStatInfoList',
  kicking: 'playerKickingStatInfoList',
  punting: 'playerPuntingStatInfoList',
};
// Payload list key → kind (used to recognise uploaded files)
const LIST_KINDS = {
  leagueTeamInfoList: 'teams',
  teamStandingInfoList: 'standings',
  rosterInfoList: 'roster',
  ...Object.fromEntries(Object.entries(WEEK_LISTS).map(([k, v]) => [v, k])),
};

function normalizeWeekKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k.startsWith('team')) return 'teamstats';   // Companion sends "teamstats"
  return WEEK_LISTS[k] ? k : null;
}

// Work out what an uploaded payload is from its list key and rows.
function detectPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const listKey = Object.keys(LIST_KINDS).find(k => Array.isArray(body[k]));
  if (!listKey) return null;
  const kind = LIST_KINDS[listKey];
  const rows = body[listKey];
  if (kind === 'roster') {
    const allFa = rows.length > 0 && rows.every(r => r && (r.isFreeAgent || r.teamId === 0));
    if (allFa) return { kind: 'freeagents' };
    const counts = {};
    for (const r of rows) if (r && r.teamId) counts[r.teamId] = (counts[r.teamId] || 0) + 1;
    const teamId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    return teamId ? { kind: 'roster', teamId: Number(teamId) } : null;
  }
  if (WEEK_LISTS[kind]) {
    const r = rows.find(Boolean) || {};
    return { kind: 'week', statKind: kind, stage: L.stageOf(r.stageIndex), week: r.weekIndex != null ? r.weekIndex + 1 : null };
  }
  return { kind };
}

function batchStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `b-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function createMaddenIngest({
  store,
  getLeague,               // () → live league object (mutated in place)
  saveLeague,              // () → persist the live league
  onBatchComplete = async () => {},
  debounceMs = 90 * 1000,
  keepRawBatches = 8,
  keepSnapshots = 30,
  logger = console,
}) {
  let batch = null;
  let timer = null;
  let seq = 0;
  let lastBatch = store.readJSON('league/batches.json', []).slice(-1)[0] || null;

  function openBatch(source) {
    if (!batch) {
      let id = batchStamp();
      while (store.exists(`raw/${id}`) || store.exists(`league/snapshots/${id}.json.gz`)) id += 'x';
      batch = {
        id, source, startedAt: new Date().toISOString(), lastAt: null,
        parts: {}, weeks: [], rosterTeams: [], freeAgents: false, teams: false, standings: false,
        leagueId: null, platform: null,
      };
      seq = 0;
    }
    return batch;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(e => logger.error('[ingest] batch flush failed:', e)); }, debounceMs);
    timer.unref?.();
  }

  function archive(b, label, body) {
    try {
      store.writeGz(`raw/${b.id}/${String(++seq).padStart(3, '0')}-${label}.json.gz`, body);
    } catch (e) {
      logger.warn('[ingest] raw archive failed:', e.message);
    }
  }

  // Apply one payload. `info` = { kind, platform, leagueId, stage, week, statKind, teamId, body, source }
  function ingest(info) {
    const { kind, body } = info;
    const league = getLeague();
    const b = openBatch(info.source || 'export');
    let count = 0, label = kind;

    if (info.leagueId) { b.leagueId = String(info.leagueId); league.leagueId = String(info.leagueId); }
    if (info.platform) { b.platform = String(info.platform); league.platform = String(info.platform); }

    switch (kind) {
      case 'teams':
        count = L.applyTeams(league, body.leagueTeamInfoList);
        b.teams = true;
        break;
      case 'standings':
        count = L.applyStandings(league, body.teamStandingInfoList);
        b.standings = true;
        break;
      case 'week': {
        const statKind = normalizeWeekKind(info.statKind);
        if (!statKind) return { ok: true, ignored: true, kind: info.statKind };
        const list = body[WEEK_LISTS[statKind]];
        const route = { stage: info.stage === 'pre' ? 'pre' : 'reg', week: Number(info.week) || null };
        count = statKind === 'schedules'
          ? L.applySchedules(league, list, route)
          : L.applyStats(league, statKind, list, route);
        const first = (list || []).find(Boolean);
        const wk = {
          seasonIndex: first?.seasonIndex ?? league.seasonIndex ?? 0,
          stage: L.stageOf(first?.stageIndex, route.stage),
          week: first?.weekIndex != null ? first.weekIndex + 1 : route.week,
        };
        if (wk.week && !b.weeks.some(w => w.seasonIndex === wk.seasonIndex && w.stage === wk.stage && w.week === wk.week)) b.weeks.push(wk);
        label = `${wk.stage}-${wk.week}-${statKind}`;
        break;
      }
      case 'roster': {
        const teamId = Number(info.teamId);
        count = L.applyRoster(league, teamId, body.rosterInfoList, b.id);
        if (!b.rosterTeams.includes(teamId)) b.rosterTeams.push(teamId);
        label = `roster-${teamId}`;
        break;
      }
      case 'freeagents':
        count = L.applyFreeAgents(league, body.rosterInfoList, b.id);
        b.freeAgents = true;
        break;
      default:
        return { ok: true, ignored: true, kind };
    }

    if (kind === 'standings' || kind === 'week') L.checkStandingsFresh(league);
    b.parts[label.replace(/-\d+$/, '')] = (b.parts[label.replace(/-\d+$/, '')] || 0) + 1;
    b.lastAt = new Date().toISOString();
    league.updatedAt = b.lastAt;
    archive(b, label, body);
    saveLeague();
    schedule();
    return { ok: true, kind, label, count, batchId: b.id };
  }

  // Close the open batch now: snapshot, diff against the previous snapshot,
  // and hand both to onBatchComplete. Returns the batch summary (or null).
  async function flush() {
    clearTimeout(timer);
    if (!batch) return null;
    const done = batch;
    batch = null;
    done.finishedAt = new Date().toISOString();
    const league = getLeague();

    const index = store.readJSON('league/batches.json', []);
    const prevEntry = index.slice().reverse().find(e => e.snapshot && store.exists(e.snapshot));
    const prev = prevEntry ? store.readGz(prevEntry.snapshot, null) : null;

    const snapshot = `league/snapshots/${done.id}.json.gz`;
    store.writeGz(snapshot, L.snapshotOf(league));
    saveLeague(true);
    done.snapshot = snapshot;

    index.push(done);
    store.writeJSON('league/batches.json', index.slice(-200));
    store.prune('league/snapshots', keepSnapshots);
    store.prune('raw', keepRawBatches);
    lastBatch = done;

    logger.log(`[ingest] batch ${done.id} closed: ${Object.entries(done.parts).map(([k, v]) => `${k}×${v}`).join(', ') || 'empty'}`);
    try {
      await onBatchComplete({ batch: done, prev, cur: league });
    } catch (e) {
      logger.error('[ingest] onBatchComplete failed:', e);
    }
    if (L.pruneDeparted(league, prev)) saveLeague(true);
    return done;
  }

  // ─── Express routes (mounted under /ingest/:key by server.js) ───────────
  const router = express.Router({ mergeParams: true });
  // The Companion App gzips large payloads (Content-Encoding) and doesn't
  // always label the type, so parse every body as JSON. 100mb matches
  // Snallabot's own limit — a full free-agent pool is several MB.
  router.use(express.json({ limit: '100mb', inflate: true, type: () => true }));

  const handle = kind => (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Expected a JSON body' });
    if (body.success === false) {
      logger.warn(`[ingest] ${req.path}: export reported failure: ${body.message || '(no message)'}`);
      return res.sendStatus(200);
    }
    try {
      const r = ingest({
        kind, body, source: 'export',
        platform: req.params.platform, leagueId: req.params.leagueId,
        stage: req.params.stage, week: req.params.week, statKind: req.params.kind, teamId: req.params.teamId,
      });
      res.status(200).json({ ok: true, received: r.count ?? 0 });
    } catch (e) {
      logger.error(`[ingest] ${req.path} failed:`, e);
      res.status(500).json({ error: 'Could not process export payload' });
    }
  };

  router.post('/:platform/:leagueId/leagueteams', handle('teams'));
  router.post('/:platform/:leagueId/standings', handle('standings'));
  router.post('/:platform/:leagueId/week/:stage/:week/:kind', handle('week'));
  router.post('/:platform/:leagueId/team/:teamId/roster', handle('roster'));
  router.post('/:platform/:leagueId/freeagents/roster', handle('freeagents'));
  // Snallabot also sends /extra (league metadata we don't use). Answer 200 to
  // anything else too: a non-200 can make an exporter abort the whole export.
  router.post('*', (req, res) => {
    logger.log(`[ingest] ignored ${req.path}`);
    res.status(200).json({ ok: true, ignored: true });
  });
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err.type === 'encoding.unsupported') return res.status(415).json({ error: 'Unsupported content encoding' });
    logger.error('[ingest] error:', err);
    res.status(500).json({ error: 'Ingest error' });
  });

  function status() {
    return {
      open: batch ? { id: batch.id, startedAt: batch.startedAt, lastAt: batch.lastAt, parts: batch.parts } : null,
      last: lastBatch,
      debounceSeconds: Math.round(debounceMs / 1000),
    };
  }

  return { router, ingest, flush, status };
}

module.exports = { createMaddenIngest, detectPayload, normalizeWeekKind, WEEK_LISTS, LIST_KINDS, batchStamp };
