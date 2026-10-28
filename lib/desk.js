// The week desk: the commissioner's sign-off before a weekly show is written.
//
// When an export finishes a week, the producer opens a desk entry for it
// instead of writing straight away (Settings → "Wait for my approval"). On
// the desk the commissioner picks the Game of the Week and the Players of the
// Week, adds headlines the export can't know about (a trade agreed in
// Discord, an owner change, a rivalry flaring up), leaves notes for the
// writers, then approves. Only then is the script written. Daily exports
// while an entry waits keep the wire fresh; the entry keeps the picks.
//
// DATA_DIR/desk.json: { entries: [entry, ...] }, newest last, the last 12 kept.
// entry: { key, week, label, status: 'pending'|'approved'|'dismissed'|'superseded',
//          openedAt, batchId, gotwStoryId, potw: { offense, defense }, headlines,
//          notes, approvedAt, episodeId }
// A Player of the Week pick is { rosterId } (one of the week's candidates) or
// { name, team, line } typed in by hand.
'use strict';
const crypto = require('crypto');

const MAX_ENTRIES = 12;
const MAX_HEADLINES = 8;
const CATEGORIES = ['LEAGUE NEWS', 'BREAKING', 'TRADE', 'SIGNING', 'INJURY', 'OWNERS', 'RIVALRY', 'DRAMA', 'RECORD'];

const weekKey = wk => (wk ? `${wk.seasonIndex}-${wk.stage}-${wk.week}` : null);
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const abbrs = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/))
  .map(t => String(t).trim().toUpperCase()).filter(t => /^[A-Z]{2,4}$/.test(t)).slice(0, 4);

function cleanPick(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.rosterId != null && p.rosterId !== '') return { rosterId: String(p.rosterId) };
  const name = clip(p.name, 60), team = abbrs([p.team])[0] || '', line = clip(p.line, 120);
  return name && line ? { name, team, line } : null;
}

function cleanHeadline(h) {
  const headline = clip(h?.headline, 140);
  if (!headline) throw new Error('A headline needs some text.');
  const category = clip(h.category, 24).toUpperCase() || (h.breaking ? 'BREAKING' : 'LEAGUE NEWS');
  return {
    id: `h${crypto.randomBytes(4).toString('hex')}`,
    headline,
    details: String(h.details ?? '').trim().slice(0, 1500),
    category,
    teams: abbrs(h.teams),
    breaking: !!h.breaking,
    createdAt: new Date().toISOString(),
  };
}

function createDesk({ store }) {
  let data = store.readJSON('desk.json', { entries: [] });
  if (!Array.isArray(data.entries)) data = { entries: [] };
  const save = () => store.writeJSON('desk.json', data);
  const find = key => data.entries.find(e => e.key === key) || null;

  const current = () => data.entries.slice().reverse().find(e => e.status === 'pending') || null;

  // Opens (or returns) the entry for a finished week. A newer week supersedes
  // an older entry still waiting.
  function open(wk, { label = '', batchId = null } = {}) {
    const key = weekKey(wk);
    if (!key) throw new Error('No finished week to open the desk for.');
    const have = find(key);
    if (have) {
      if (have.status === 'dismissed' || have.status === 'superseded') return have;
      if (batchId) have.batchId = batchId;
      save();
      return have;
    }
    for (const e of data.entries) if (e.status === 'pending') e.status = 'superseded';
    const entry = {
      key, week: { seasonIndex: wk.seasonIndex, stage: wk.stage, week: wk.week }, label, status: 'pending',
      openedAt: new Date().toISOString(), batchId, gotwStoryId: null, potw: { offense: null, defense: null },
      headlines: [], notes: '', approvedAt: null, episodeId: null,
    };
    data.entries = [...data.entries, entry].slice(-MAX_ENTRIES);
    save();
    return entry;
  }

  function pending() {
    const e = current();
    if (!e) throw new Error('Nothing is waiting on the desk.');
    return e;
  }

  function update(patch = {}) {
    const e = pending();
    if ('gotwStoryId' in patch) {
      const id = patch.gotwStoryId ? String(patch.gotwStoryId) : null;
      if (id && !id.startsWith('game:')) throw new Error('The Game of the Week has to be one of the week\'s games.');
      e.gotwStoryId = id;
    }
    if (patch.potw && typeof patch.potw === 'object') {
      for (const side of ['offense', 'defense']) if (side in patch.potw) e.potw[side] = cleanPick(patch.potw[side]);
    }
    if ('notes' in patch) e.notes = String(patch.notes ?? '').trim().slice(0, 2000);
    save();
    return e;
  }

  function addHeadline(h) {
    const e = pending();
    if (e.headlines.length >= MAX_HEADLINES) throw new Error(`The desk holds ${MAX_HEADLINES} headlines at most.`);
    e.headlines.push(cleanHeadline(h));
    save();
    return e;
  }

  function removeHeadline(id) {
    const e = pending();
    e.headlines = e.headlines.filter(h => h.id !== id);
    save();
    return e;
  }

  function markApproved(key, episodeId) {
    const e = find(key);
    if (!e) return null;
    Object.assign(e, { status: 'approved', approvedAt: new Date().toISOString(), episodeId });
    save();
    return e;
  }

  function dismiss() {
    const e = pending();
    e.status = 'dismissed';
    save();
    return e;
  }

  function reset() { data = { entries: [] }; save(); }

  return { current, open, update, addHeadline, removeHeadline, markApproved, dismiss, reset, entries: () => data.entries, find };
}

module.exports = { createDesk, weekKey, cleanHeadline, cleanPick, CATEGORIES };
