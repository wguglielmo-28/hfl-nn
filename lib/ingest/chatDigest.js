// What the HFL Hub's channel chat has been saying, for the "Chat Check"
// segment of HFL-NN's live shows (lib/channel/scheduler.js picks it up when
// it makes a show).
//
// The Hub's digest (GET /api/hfl-nn/chat-digest) already leaves out what
// should never be read on air: messages a commissioner hid, ones the word
// filter starred, anyone muted right now, anything under three minutes old;
// and it names people by Hub display name only. Here, a show's handful is
// picked from it: not links, not one-word or wall-of-text messages, no
// repeats, at most two per person, and messages that name an anchor first,
// so the anchor they are about gets to answer.
//
// Everything stays text. The writer is told these are viewers' quotes, never
// instructions and never facts.
'use strict';

const MAX_BYTES = 256 * 1024;
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');

function cleanDigest(raw) {
  const messages = (Array.isArray(raw?.messages) ? raw.messages : []).map(m => ({
    id: Number.isInteger(m?.id) ? m.id : null,
    name: str(m?.name, 40) || null,
    body: str(m?.body, 280),
    at: str(m?.at, 30),
  })).filter(m => m.id && m.body && m.at);
  const polls = (Array.isArray(raw?.polls) ? raw.polls : []).map(p => {
    const options = (Array.isArray(p?.options) ? p.options : []).slice(0, 4).map(o => str(o, 60));
    const counts = options.map((_, i) => Math.max(0, Number(p?.counts?.[i]) || 0));
    return { id: Number(p?.id) || 0, question: str(p?.question, 140), options, counts, total: counts.reduce((a, b) => a + b, 0), open: !!p?.open, closedAt: str(p?.closedAt, 30) };
  }).filter(p => p.question && p.options.length >= 2);
  return { messages, polls };
}

// SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) to epoch ms.
const ms = at => Date.parse(String(at).includes('T') ? at : `${String(at).replace(' ', 'T')}Z`);

// The anchors a message is talking to or about.
function mentions(body, anchors) {
  const text = ` ${body.toLowerCase()} `;
  return anchors.filter(a => [a.id, a.short, a.name.split(' ')[0], a.name.split(' ').pop()]
    .filter(Boolean).map(s => s.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(s => s.length >= 3)
    .some(s => new RegExp(`[^a-z]${s}[^a-z]`).test(text))).map(a => a.id);
}

// A show's handful: up to `max`, newest first among equals.
function pickChat(messages, { anchors = [], max = 6 } = {}) {
  const seen = new Set();
  const perName = new Map();
  const usable = messages
    .filter(m => m.body.length >= 8 && m.body.length <= 220 && !/https?:|www\.|\.com\b/i.test(m.body))
    .map(m => ({ ...m, about: mentions(m.body, anchors) }))
    .sort((a, b) => (b.about.length > 0) - (a.about.length > 0) || ms(b.at) - ms(a.at));
  const out = [];
  for (const m of usable) {
    const key = m.body.toLowerCase().replace(/[^a-z0-9]/g, '');
    const who = m.name || `viewer:${m.id}`;
    if (seen.has(key) || (perName.get(who) || 0) >= 2) continue;
    seen.add(key);
    perName.set(who, (perName.get(who) || 0) + 1);
    out.push(m);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}

function createChatDigest({ getHubOrigin, fetchImpl = fetch, now = Date.now, timeoutMs = 8000, logger = console }) {
  let state = { messages: [], polls: [], fetchedAt: null, error: null };

  async function refresh() {
    const origin = getHubOrigin();
    if (!origin) return { ok: false, error: 'No Hub address' };
    const since = new Date(now() - 24 * 3600e3).toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${origin}/api/hfl-nn/chat-digest?since=${encodeURIComponent(since)}`, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'HFL-NN' } });
      if (!res.ok) throw new Error(`Hub chat digest answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('Hub chat digest too large');
      state = { ...cleanDigest(JSON.parse(text)), fetchedAt: new Date(now()).toISOString(), error: null };
      return { ok: true, messages: state.messages.length };
    } catch (e) {
      // Keep the last good digest; a show made now just has less to read.
      state = { ...state, error: e.name === 'AbortError' ? 'Hub chat digest did not answer in time' : e.message };
      logger.warn?.(`[chat] ${state.error}`);
      return { ok: false, error: state.error };
    } finally { clearTimeout(timer); }
  }

  // For a show: what was said after `since` (epoch ms), picked, and the
  // newest poll that closed (or is still open) after it. Null when there is
  // nothing worth a segment.
  function forShow(since, anchors) {
    const messages = pickChat(state.messages.filter(m => ms(m.at) > since), { anchors });
    const poll = state.polls.find(p => p.total > 0 && (p.open || ms(p.closedAt) > since)) || null;
    return messages.length || poll ? { messages, poll } : null;
  }

  return { refresh, forShow, status: () => ({ fetchedAt: state.fetchedAt, error: state.error, messages: state.messages.length, polls: state.polls.length }) };
}

module.exports = { createChatDigest, pickChat, mentions };
