// The HFL Hub's channel chat, read-only, for HFL-NN's own channel page.
//
// The audience lives on the Hub (/hfl-nn): members are signed in there with
// Discord, so every message has a name and a commissioner can hide it.
// HFL-NN's site has no accounts, so it only shows that conversation -- the
// chat, the floating reactions, the crowd meter and the poll -- and sends
// people to the Hub to join in.
//
// One cache for every viewer: the Hub is asked at most every few seconds,
// however many people are watching, and only while someone is. Everything is
// checked for shape on the way in and shown as text by the page.
'use strict';

const EMOJI = new Set(['🔥', '😂', '👏', '😮', '🧂', '💀']);
const KEEP_MESSAGES = 80;
const KEEP_REACTIONS = 120;
const MAX_BYTES = 256 * 1024;

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const int = v => (Number.isInteger(v) && v >= 0 ? v : null);

// …/api/hfl-nn-feed → the Hub's origin.
function hubOriginFrom(hubFeedUrl, override) {
  const raw = override || hubFeedUrl;
  if (!raw) return '';
  try { return new URL(raw).origin; } catch { return ''; }
}

function cleanMessage(m) {
  const id = int(m?.id);
  const body = str(m?.body, 300).trim();
  return id && body ? { id, name: str(m?.name, 60) || 'A member', body, at: str(m?.at, 30) } : null;
}

function cleanPoll(p) {
  if (!p || typeof p !== 'object') return null;
  const options = (Array.isArray(p.options) ? p.options : []).slice(0, 4).map(o => str(o, 60));
  const counts = options.map((_, i) => Math.max(0, Number(p.counts?.[i]) || 0));
  const question = str(p.question, 140);
  if (!question || options.length < 2) return null;
  return { id: int(p.id), question, options, counts, total: counts.reduce((a, b) => a + b, 0), open: !!p.open, closesAt: str(p.closesAt, 30) };
}

function createAudience({ getHubOrigin, fetchImpl = fetch, now = Date.now, refreshMs = 3000, timeoutMs = 5000, logger = console }) {
  let state = { messages: [], reactions: [], hidden: [], crowd: 0, poll: null, lastMessage: 0, lastReaction: 0, fetchedAt: 0, error: null, origin: '' };
  let inflight = null;

  async function pull() {
    const origin = getHubOrigin();
    if (!origin) return;
    // A new Hub address starts over.
    if (origin !== state.origin) state = { ...state, messages: [], reactions: [], hidden: [], lastMessage: 0, lastReaction: 0, origin };
    const first = !state.lastMessage && !state.lastReaction && !state.messages.length;
    const url = `${origin}/api/hfl-nn/live${first ? '' : `?m=${state.lastMessage}&r=${state.lastReaction}`}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'HFL-NN' } });
      if (!res.ok) throw new Error(`Hub chat answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('Hub chat answer too large');
      const u = JSON.parse(text);
      const hidden = new Set((Array.isArray(u.hidden) ? u.hidden : []).map(int).filter(Boolean));
      const known = new Set(state.messages.map(m => m.id));
      const fresh = (Array.isArray(u.messages) ? u.messages : []).map(cleanMessage).filter(m => m && !known.has(m.id));
      const reactions = (Array.isArray(u.reactions) ? u.reactions : [])
        .map(r => ({ id: int(r?.id), emoji: str(r?.emoji, 8) }))
        .filter(r => r.id && EMOJI.has(r.emoji) && r.id > state.lastReaction);
      state = {
        ...state,
        messages: [...state.messages, ...fresh].filter(m => !hidden.has(m.id)).slice(-KEEP_MESSAGES),
        hidden: [...hidden],
        reactions: [...state.reactions, ...reactions].slice(-KEEP_REACTIONS),
        crowd: Math.max(0, Number(u.crowd) || 0),
        poll: cleanPoll(u.poll),
        lastMessage: Math.max(state.lastMessage, int(u.lastMessage) || 0, ...fresh.map(m => m.id)),
        lastReaction: Math.max(state.lastReaction, int(u.lastReaction) || 0),
        fetchedAt: now(),
        error: null,
      };
    } catch (e) {
      // Keep showing what we had; say it is stale.
      state = { ...state, fetchedAt: now(), error: e.name === 'AbortError' ? 'Hub chat did not answer in time' : e.message };
      logger.warn?.(`[audience] ${state.error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // What a viewer who has seen up to message `m` and reaction `r` needs.
  // Without them (a first load), the latest page and no backlog of emoji.
  async function view({ m = null, r = null } = {}) {
    const origin = getHubOrigin();
    if (!origin) return { on: false };
    if (now() - state.fetchedAt >= refreshMs || origin !== state.origin) {
      inflight ||= pull().finally(() => { inflight = null; });
      await inflight;
    }
    const first = m == null;
    const afterM = first ? 0 : m;
    const afterR = first ? state.lastReaction : r ?? state.lastReaction;
    return {
      on: true,
      joinUrl: `${state.origin || origin}/hfl-nn`,
      messages: first ? state.messages.slice(-60) : state.messages.filter(x => x.id > afterM),
      hidden: state.hidden,
      reactions: state.reactions.filter(x => x.id > afterR).slice(-40),
      crowd: state.crowd,
      poll: state.poll,
      lastMessage: state.lastMessage,
      lastReaction: state.lastReaction,
      stale: !!state.error,
    };
  }

  return { view, status: () => ({ origin: state.origin, fetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null, error: state.error, messages: state.messages.length }) };
}

module.exports = { createAudience, hubOriginFrom };
