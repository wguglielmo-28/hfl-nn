// The TV guide: the channel's day, slot by slot, saying which slots bring
// something new and which are repeats, so viewers know when to tune in.
//
// A slot is one entry of the grid (config/channel.json), from its start to
// the next slot's. What it says:
//
//   new       something airs for the first time: a show premiere, a live
//             show already made today, a game replay or clips
//   expected  a live show is still to be made for this slot; it airs if
//             there is news (The Wire: if a result has come in)
//   repeats   encores from the vault, or a live show that wasn't made
//
// Pure: the caller hands in the day's blocks and the scheduler's editions.
'use strict';
const { wallToMs, dayStart, nextDay } = require('./clock');

const MAX_ITEMS = 4;

function slotsOf(config, day) {
  const tz = config.timeZone;
  const end = dayStart(nextDay(day), tz);
  return config.grid.map((g, i) => {
    const next = config.grid[i + 1];
    return { at: g.at, show: g.show, from: wallToMs(day, g.at, tz), until: next ? wallToMs(day, next.at, tz) : end };
  }).filter(s => s.until > s.from);
}

// What is new in a slot: first airings, game replays, clips (as one item).
function newItems(blocks, from, until) {
  const items = [];
  let clips = 0;
  for (const b of blocks) {
    if (b.from < from || b.from >= until) continue;
    if (b.kind === 'clip') { clips++; continue; }
    if (b.kind === 'replay') items.push({ kind: 'replay', title: b.title });
    else if (b.kind === 'episode' && !b.rerun) items.push({ kind: 'episode', title: b.title, show: b.showTitle });
  }
  if (clips) items.unshift({ kind: 'clips', title: `${clips} ${clips === 1 ? 'clip' : 'clips'} from league games` });
  return [...new Map(items.map(x => [`${x.kind}:${x.title}`, x])).values()].slice(0, MAX_ITEMS);
}

// editions: [{ show, at, state }] from the scheduler for that day.
function guideDay({ config, day, blocks, editions = [], auto = true, now }) {
  return slotsOf(config, day).map(s => {
    const show = config.shows[s.show] || {};
    const ed = editions.find(e => e.show === s.show && e.at === s.at);
    const items = newItems(blocks, s.from, s.until);
    const base = { from: s.from, until: s.until, show: s.show, title: show.title || s.show, blurb: show.blurb || '', onNow: s.from <= now && now < s.until };
    if (items.length) return { ...base, status: 'new', items };
    if (ed && auto && ['waiting', 'due', 'working'].includes(ed.state) && s.until > now) {
      const minutes = show.produce?.minutes;
      const when = show.produce?.needs?.includes('game') ? 'if new results have come in' : 'if there is news';
      return { ...base, status: 'expected', items: [], note: `New${minutes ? `, about ${minutes} minutes,` : ''} ${when}` };
    }
    return { ...base, status: 'repeats', items: [], note: show.kind === 'replay' ? 'No new game replays: encores' : 'Encores' };
  });
}

module.exports = { guideDay, slotsOf, newItems };
