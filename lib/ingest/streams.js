// Members' game streams, read from the HFL Hub (/api/hfl-nn-streams): who is
// live on a league game right now, the replays that can still be played, and
// the Twitch clips cut from them. The channel plays all of it through
// Twitch's and YouTube's own embedded players — nothing is downloaded.
//
// Every id that ends up in a player URL is checked against the shape the
// platform uses, so nothing from the feed can smuggle markup or a different
// address into the page.
'use strict';

const MAX_BYTES = 1024 * 1024;
const TWITCH_LOGIN = /^[a-z0-9_]{2,25}$/;
const TWITCH_VIDEO = /^\d{1,20}$/;
const TWITCH_CLIP = /^[A-Za-z0-9_-]{1,120}$/;
const YOUTUBE_VIDEO = /^[A-Za-z0-9_-]{11}$/;

const str = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));
const arr = v => (Array.isArray(v) ? v : []);
const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const score = v => (Number.isInteger(v) && v >= 0 && v < 1000 ? v : null);

function normalizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  const away = str(g.away, 5).toUpperCase(), home = str(g.home, 5).toUpperCase();
  if (!away || !home) return null;
  return {
    pk: Number(g.pk) || 0, season: Number(g.season) || null, week: Number(g.week) || null,
    stage: ['pre', 'reg', 'post'].includes(g.stage) ? g.stage : 'reg',
    away, home, awayName: str(g.awayName, 40) || away, homeName: str(g.homeName, 40) || home,
    awayScore: score(g.awayScore), homeScore: score(g.homeScore), gotw: !!g.gotw,
  };
}

function normalizeStream(s, { live }) {
  if (!s || typeof s !== 'object') return null;
  const platform = s.platform === 'youtube' ? 'youtube' : s.platform === 'twitch' ? 'twitch' : null;
  const game = normalizeGame(s.game);
  const startedAt = time(s.startedAt);
  if (!platform || !game || !startedAt) return null;
  const channel = platform === 'twitch' && TWITCH_LOGIN.test(String(s.channel || '').toLowerCase()) ? String(s.channel).toLowerCase() : null;
  const rawVideo = s.videoId == null ? '' : String(s.videoId);
  const videoId = (platform === 'youtube' ? YOUTUBE_VIDEO : TWITCH_VIDEO).test(rawVideo) ? rawVideo : null;
  // A live Twitch stream plays by channel; everything else needs its video.
  if (live && platform === 'twitch' ? !channel : !videoId) return null;
  const out = {
    id: `${platform}:${live && platform === 'twitch' ? channel : videoId}`,
    platform, channel, videoId, member: str(s.member, 60) || 'A member', title: str(s.title, 140), startedAt, game,
  };
  if (live) return out;
  const endedAt = time(s.endedAt);
  const duration = Math.round(Number(s.duration) || (endedAt ? (Date.parse(endedAt) - Date.parse(startedAt)) / 1000 : 0));
  if (!endedAt || !(duration > 0)) return null;
  return {
    ...out, endedAt, duration: Math.min(duration, 12 * 3600), replayExpiresAt: time(s.replayExpiresAt),
    clips: platform !== 'twitch' ? [] : arr(s.clips).slice(0, 20).map(c => ({
      id: String(c?.id || ''), title: str(c?.title, 100), creator: str(c?.creator, 40),
      duration: Math.min(120, Number(c?.duration) || 0), views: Math.max(0, Math.round(Number(c?.views) || 0)), createdAt: time(c?.createdAt),
    })).filter(c => TWITCH_CLIP.test(c.id) && c.duration >= 3),
  };
}

function normalizeStreams(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('The streams feed must be a JSON object');
  const uniq = list => [...new Map(list.filter(Boolean).map(s => [s.id, s])).values()];
  return {
    live: uniq(arr(raw.live).slice(0, 40).map(s => normalizeStream(s, { live: true })))
      .sort((a, b) => Number(b.game.gotw) - Number(a.game.gotw) || a.startedAt.localeCompare(b.startedAt)),
    replays: uniq(arr(raw.replays).slice(0, 60).map(s => normalizeStream(s, { live: false })))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)),
  };
}

// The streams URL sits beside the Hub feed: …/api/hfl-nn-feed → …/api/hfl-nn-streams.
function streamsUrlFrom(hubFeedUrl, override) {
  if (override) return override;
  if (!hubFeedUrl || !/\/api\/hfl-nn-feed\/?(\?.*)?$/.test(hubFeedUrl)) return '';
  return hubFeedUrl.replace(/\/api\/hfl-nn-feed\/?(\?.*)?$/, '/api/hfl-nn-streams');
}

function createStreamsSource({ store, getUrl, fetchImpl = fetch, onChange = () => {}, logger = console, timeoutMs = 10000 }) {
  let state = store.readJSON('sources/streams.json', { data: null, fetchedAt: null, error: null });
  const empty = { live: [], replays: [] };
  const fingerprint = d => JSON.stringify(d || empty);

  function accept(raw) {
    const data = normalizeStreams(raw);
    const changed = fingerprint(data) !== fingerprint(state.data);
    state = { data, fetchedAt: new Date().toISOString(), error: null };
    // Polled every minute; only touch the disk when something moved.
    if (changed) { store.writeJSON('sources/streams.json', state); try { onChange(data); } catch (e) { logger.warn(`[streams] change hook failed: ${e.message}`); } }
    return { ok: true, live: data.live.length, replays: data.replays.length, changed };
  }

  async function refresh() {
    const url = getUrl();
    if (!url) return { ok: false, error: 'No Hub feed URL configured' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'HFL-NN' } });
      if (!res.ok) throw new Error(`Hub answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('The streams feed is larger than 1 MB');
      return accept(JSON.parse(text));
    } catch (e) {
      // Keep the replays we knew about; a stream we can no longer confirm is
      // not shown as live once the last good answer is five minutes old.
      state = { ...state, error: e.message, errorAt: new Date().toISOString() };
      logger.warn(`[streams] ${e.message}`);
      return { ok: false, error: e.message };
    } finally { clearTimeout(timer); }
  }

  const fresh = (now = Date.now()) => state.fetchedAt && now - Date.parse(state.fetchedAt) < 5 * 60 * 1000;

  return {
    refresh, push: accept,
    live: now => (fresh(now) ? (state.data || empty).live : []),
    replays: () => (state.data || empty).replays,
    status: () => ({ fetchedAt: state.fetchedAt, error: state.error, live: (state.data || empty).live.length, replays: (state.data || empty).replays.length }),
    reset() { state = { data: null, fetchedAt: null, error: null }; store.remove('sources/streams.json'); store.remove('sources/streams.json.bak'); },
  };
}

module.exports = { createStreamsSource, normalizeStreams, streamsUrlFrom };
