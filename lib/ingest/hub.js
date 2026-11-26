// HFL Hub feed. The Hub is the league's own app, so HFL-NN defines a small
// JSON contract (docs/hub-feed.md) that the Hub can serve at a URL HFL-NN
// polls, or POST to /api/hub/push. Every section is optional and unknown
// fields are ignored, so the Hub can grow without breaking the show.
'use strict';
const { coachFor } = require('../coaches');

const MAX_BYTES = 2 * 1024 * 1024;

const str = (v, n = 400) => (v == null ? '' : String(v).slice(0, n));
const arr = v => (Array.isArray(v) ? v : []);

const fromMember = m => ({
  id: str(m?.id, 40), name: str(m?.name, 60) || 'A member', team: str(m?.team, 5).toUpperCase(),
  text: str(m?.text, 280).replace(/\s+/g, ' ').trim(), week: Number(m?.week) || null,
});

const num = (v, d = null) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const ab = v => str(v, 5).toUpperCase();
function normalizeSportsbook(sb) {
  if (!sb || typeof sb !== 'object' || !num(sb.week)) return null;
  return {
    week: num(sb.week),
    lastWeek: num(sb.lastWeek),
    lines: arr(sb.lines).slice(0, 20).map(l => ({ away: ab(l?.away), home: ab(l?.home), favorite: ab(l?.favorite), spread: num(l?.spread), total: num(l?.total), favoriteWinPct: num(l?.favoriteWinPct, 50) }))
      .filter(l => l.away && l.home && l.favorite),
    upsets: arr(sb.upsets).slice(0, 5).map(u => ({ winner: ab(u?.winner), loser: ab(u?.loser), winnerScore: num(u?.winnerScore, 0), loserScore: num(u?.loserScore, 0), spread: num(u?.spread, 0) }))
      .filter(u => u.winner && u.loser && u.spread > 0),
    bigWins: arr(sb.bigWins).slice(0, 3).map(w => ({ team: ab(w?.team), profit: num(w?.profit, 0), kind: w?.kind === 'parlay' ? 'parlay' : 'single', legs: num(w?.legs, 1) }))
      .filter(w => w.profit > 0),
    leaders: arr(sb.leaders).slice(0, 3).map(r => ({ team: ab(r?.team), profit: num(r?.profit, 0), won: num(r?.won, 0), lost: num(r?.lost, 0) })),
  };
}

function draftPick(p) {
  return {
    overall: num(p?.overall, 0), round: num(p?.round, 0), pick: num(p?.pick, 0), team: ab(p?.team), via: ab(p?.via) || null,
    player: str(p?.player, 60), position: str(p?.position, 6) || null, ovr: num(p?.ovr), age: num(p?.age), dev: str(p?.dev, 20) || null,
  };
}
function normalizeDraft(d) {
  if (!d || typeof d !== 'object' || !num(d.id)) return null;
  const firstRound = arr(d.firstRound).slice(0, 40).map(draftPick).filter(p => p.overall && p.player && p.team);
  if (!firstRound.length) return null;
  return {
    id: num(d.id), kind: d.kind === 'fantasy' ? 'fantasy' : 'rookie', name: str(d.name, 80) || 'the draft',
    importedAt: str(d.importedAt, 40) || null, picks: num(d.picks, 0), rounds: num(d.rounds, 0),
    firstRound, steals: arr(d.steals).slice(0, 5).map(draftPick).filter(p => p.overall && p.player && p.team),
  };
}

function normalizeHubFeed(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Hub feed must be a JSON object');
  const league = raw.league && typeof raw.league === 'object' ? raw.league : {};
  return {
    league: {
      name: str(league.name, 100), season: league.season ?? null, phase: str(league.phase, 30) || null, week: league.week ?? null,
    },
    owners: arr(raw.owners).slice(0, 64).map(o => ({
      teamAbbr: str(o.teamAbbr, 5).toUpperCase(), displayName: str(o.displayName, 60), discord: str(o.discord, 60), coach: str(o.coach, 60) || coachFor(o.teamAbbr)?.coach || '',
      since: o.since ?? null, titles: Number(o.titles) || 0, note: str(o.note, 200),
    })).filter(o => o.teamAbbr),
    announcements: arr(raw.announcements).slice(0, 50).map((a, i) => ({
      id: str(a.id || a.title || i, 80), title: str(a.title, 160), body: str(a.body, 2000), date: str(a.date, 40) || null, breaking: !!a.breaking,
    })).filter(a => a.title),
    powerRankings: arr(raw.powerRankings).slice(0, 32).map(r => ({
      rank: Number(r.rank) || 0, teamAbbr: str(r.teamAbbr, 5).toUpperCase(), note: str(r.note, 160), move: Number(r.move) || 0,
    })).filter(r => r.rank && r.teamAbbr).sort((a, b) => a.rank - b.rank),
    gamesOfTheWeek: arr(raw.gamesOfTheWeek).slice(0, 60).map(g => ({
      season: g.season ?? null, stage: /^pre/i.test(String(g.stage || '')) ? 'pre' : 'reg', week: Number(g.week) || 0,
      away: str(g.away, 5).toUpperCase(), home: str(g.home, 5).toUpperCase(),
    })).filter(g => g.week && g.away && g.home),
    // One Offensive and one Defensive pick per conference per week. rosterId
    // is the export's own, so the desk can match the week's stat lines.
    playersOfTheWeek: arr(raw.playersOfTheWeek).slice(0, 120).map(p => ({
      season: p.season ?? null, stage: /^pre/i.test(String(p.stage || '')) ? 'pre' : 'reg', week: Number(p.week) || 0,
      side: /^def/i.test(String(p.side || '')) ? 'defense' : /^off/i.test(String(p.side || '')) ? 'offense' : null,
      conference: str(p.conference, 3).toUpperCase(), rosterId: p.rosterId == null || p.rosterId === '' ? null : str(p.rosterId, 20),
      name: str(p.name, 60), team: str(p.team, 5).toUpperCase(), position: str(p.position, 6), line: str(p.line, 120), manual: !!p.manual,
    })).filter(p => p.week && p.side && p.name),
    awards: arr(raw.awards).slice(0, 30).map(a => ({ name: str(a.name, 80), winner: str(a.winner, 80), team: str(a.team, 5), season: a.season ?? null })),
    rivalries: arr(raw.rivalries).slice(0, 30).map(r => ({ teams: arr(r.teams).map(t => str(t, 5).toUpperCase()).slice(0, 2), note: str(r.note, 200) })),
    records: arr(raw.records).slice(0, 30).map(r => (typeof r === 'string' ? str(r, 200) : { text: str(r.text || r.name, 200) })),
    history: arr(raw.history).slice(0, 30).map(h => (typeof h === 'string' ? str(h, 200) : { text: str(h.text || h.summary, 200) })),
    // What members sent the desk and a commissioner approved on the Hub
    // (its /admin/hfl-nn). These are suggestions for the Week Desk and
    // nothing more: the show uses one only when the commissioner adds it
    // there as a headline. Text is clipped to what can be read in a breath.
    fanTakes: arr(raw.fanTakes).slice(0, 10).map(fromMember).filter(m => m.id && m.text),
    segmentRequests: arr(raw.segmentRequests).slice(0, 10).map(fromMember).filter(m => m.id && m.text),
    // "Ask the desk": members' questions a commissioner approved on the Hub.
    // Unlike takes these air by themselves (the Hub review is the gate), one
    // or two at a time in an Ask the Desk segment, each only once.
    questions: arr(raw.questions).slice(0, 10).map(fromMember).filter(m => m.id && m.text),
    // Record chases from the Hub's record books, become record / record_chase
    // stories on the wire (lib/stories.js recordStories).
    recordChases: arr(raw.recordChases).slice(0, 12).map(c => ({
      player: str(c?.player, 60), position: str(c?.position, 6) || null, team: str(c?.team, 5).toUpperCase(),
      label: str(c?.label, 60), scope: c?.scope === 'game' ? 'game' : 'season',
      level: ['broken', 'close', 'watch'].includes(c?.level) ? c.level : null,
      value: Number(c?.value) || 0, pace: c?.pace == null ? null : Number(c.pace) || null,
      mark: { book: c?.mark?.book === 'NeonSportz' ? 'NeonSportz' : 'HFL Hub', value: Number(c?.mark?.value) || 0, holder: str(c?.mark?.holder, 60) || null, when: str(c?.mark?.when, 30) || null },
    })).filter(c => c.player && c.label && c.level && c.mark.value > 0),
    // The play-money sportsbook, or null while it is off (lib/stories.js sportsbookStories).
    sportsbook: normalizeSportsbook(raw.sportsbook),
    // The newest rookie or fantasy draft, while it is news (lib/stories.js draftStories).
    draft: normalizeDraft(raw.draft),
    // Hub poll results (Chronicle issue polls, channel chat polls); only final ones air.
    polls: arr(raw.polls).slice(0, 10).map(p => ({
      id: str(p?.id, 40), source: p?.source === 'channel' ? 'channel' : 'chronicle', question: str(p?.question, 200),
      options: arr(p?.options).slice(0, 8).map(o => ({ label: str(o?.label, 80), votes: num(o?.votes, 0) })).filter(o => o.label),
      total: num(p?.total, 0), final: !!p?.final,
      issue: p?.issue && typeof p.issue === 'object' ? { slug: str(p.issue.slug, 40), volume: num(p.issue.volume, 0), number: num(p.issue.number, 0) } : null,
    })).filter(p => p.id && p.question && p.options.length >= 2),
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
    try { onUpdate({ data, freshAnnouncements: fresh }); } catch (e) { logger.warn(`[hub] update hook failed: ${e.message}`); }
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

  function reset() {
    state = { data: null, fetchedAt: null, error: null, source: null };
    store.writeJSON('sources/hub.json', state);
    store.remove('sources/hub.json.bak');
  }

  return { refresh, push: raw => accept(raw, 'push'), reset, status: () => ({ ...state, data: undefined, hasData: !!state.data }), data: () => state.data };
}

module.exports = { createHubSource, normalizeHubFeed };
