// HFL Hub feed. The Hub is the league's own app, so HFL-NN defines a small
// JSON contract (docs/hub-feed.md) that the Hub can serve at a URL HFL-NN
// polls, or POST to /api/hub/push. Every section is optional and unknown
// fields are ignored, so the Hub can grow without breaking the show.
'use strict';

const MAX_BYTES = 2 * 1024 * 1024;

const str = (v, n = 400) => (v == null ? '' : String(v).slice(0, n));
const arr = v => (Array.isArray(v) ? v : []);

function normalizeHubFeed(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Hub feed must be a JSON object');
  const league = raw.league && typeof raw.league === 'object' ? raw.league : {};
  return {
    league: {
      name: str(league.name, 100), season: league.season ?? null, phase: str(league.phase, 30) || null, week: league.week ?? null,
    },
    owners: arr(raw.owners).slice(0, 64).map(o => ({
      teamAbbr: str(o.teamAbbr, 5).toUpperCase(), displayName: str(o.displayName, 60), discord: str(o.discord, 60),
      since: o.since ?? null, titles: Number(o.titles) || 0, note: str(o.note, 200),
    })).filter(o => o.teamAbbr),
    announcements: arr(raw.announcements).slice(0, 50).map((a, i) => ({
      id: str(a.id || a.title || i, 80), title: str(a.title, 160), body: str(a.body, 2000), date: str(a.date, 40) || null, breaking: !!a.breaking,
    })).filter(a => a.title),
    powerRankings: arr(raw.powerRankings).slice(0, 32).map(r => ({
      rank: Number(r.rank) || 0, teamAbbr: str(r.teamAbbr, 5).toUpperCase(), note: str(r.note, 160), move: Number(r.move) || 0,
    })).filter(r => r.rank && r.teamAbbr).sort((a, b) => a.rank - b.rank),
    awards: arr(raw.awards).slice(0, 30).map(a => ({ name: str(a.name, 80), winner: str(a.winner, 80), team: str(a.team, 5), season: a.season ?? null })),
    rivalries: arr(raw.rivalries).slice(0, 30).map(r => ({ teams: arr(r.teams).map(t => str(t, 5).toUpperCase()).slice(0, 2), note: str(r.note, 200) })),
    records: arr(raw.records).slice(0, 30).map(r => (typeof r === 'string' ? str(r, 200) : { text: str(r.text || r.name, 200) })),
    history: arr(raw.history).slice(0, 30).map(h => (typeof h === 'string' ? str(h, 200) : { text: str(h.text || h.summary, 200) })),
  };
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'HFL-NN' } });
    if (!res.ok) throw new Error(`Hub answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('Hub feed is larger than 2 MB');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function createHubSource({ store, getUrl, onUpdate = () => {}, fetchImpl, logger = console }) {
  let state = store.readJSON('sources/hub.json', { data: null, fetchedAt: null, error: null, source: null });

  function accept(raw, source) {
    const data = normalizeHubFeed(raw);
    const prevIds = new Set((state.data?.announcements || []).map(a => a.id));
    state = { data, fetchedAt: new Date().toISOString(), error: null, source };
    store.writeJSON('sources/hub.json', state);
    const fresh = data.announcements.filter(a => !prevIds.has(a.id));
    onUpdate({ data, freshAnnouncements: fresh });
    return { ok: true, announcements: data.announcements.length, fresh: fresh.length };
  }

  async function refresh() {
    const url = getUrl();
    if (!url) return { ok: false, error: 'No Hub feed URL configured' };
    try {
      return accept(await fetchJson(url, { fetchImpl }), url);
    } catch (e) {
      state = { ...state, error: e.message, errorAt: new Date().toISOString() };
      store.writeJSON('sources/hub.json', state);
      logger.warn(`[hub] ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  return { refresh, push: raw => accept(raw, 'push'), status: () => ({ ...state, data: undefined, hasData: !!state.data }), data: () => state.data };
}

module.exports = { createHubSource, normalizeHubFeed };
