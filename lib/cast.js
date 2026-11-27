// The program guide (/shows) and the anchor pages (/anchors): every show on
// the channel with what it is, when it airs and who is on it, and every
// anchor with their bio and what the show memory says about them (mood,
// receipts, who they get along with, their latest on-air takes). Everything
// here is public: it is config or something that already aired.
'use strict';

const ROLE_KINDS = { host: ['host'], insider: ['insider'], analyst: ['analyst'], analyst2: ['analyst'], wildcard: ['wildcard'] };
const KIND_LABEL = { live: 'New episodes', talk: 'Weekly talk show', replay: 'Game replays', clips: 'Stream clips', cutin: 'Cuts in live', rerun: 'Reruns' };

const hhmm = s => /^\d{2}:\d{2}$/.test(s) ? s : null;

function showKind(id, s) {
  if (s.kind === 'replay') return 'replay';
  if (s.kind === 'clips') return 'clips';
  if (s.cutIn) return 'cutin';
  if ((s.types || []).includes('talk')) return 'talk';
  if ((s.types || []).includes('*') || s.order === 'rotate') return 'rerun';
  return 'live';
}

// Who appears on a show: the talk show's whole cast, or, for a news show,
// the network anchors its segments call for.
function showCast(s, kind, segments, network, talk) {
  if (kind === 'talk') return (talk?.anchors || []).map(a => a.id);
  const kinds = s.produce?.kinds || s.cutIn?.kinds || [];
  if (!kinds.length) return [];
  const want = new Set();
  for (const k of kinds) for (const r of segments?.[k]?.cast || []) for (const pk of ROLE_KINDS[r] || []) want.add(pk);
  return (network?.anchors || []).filter(a => want.has(a.kind)).map(a => a.id);
}

function showsReport({ config, segments = {}, network, talk = null, timeZone }) {
  const grid = (config?.grid || []).filter(g => hhmm(g.at));
  const shows = Object.entries(config?.shows || {}).map(([id, s]) => {
    const kind = showKind(id, s);
    const airs = grid.filter(g => g.show === id).map(g => g.at).sort();
    const minutes = s.produce?.minutes || s.cutIn?.minutes || null;
    return {
      id, title: s.title || id, blurb: s.blurb || '', kind, kindLabel: KIND_LABEL[kind],
      airs, newAt: (s.produce?.slots || []).filter(hhmm).sort(), minutes,
      segments: (s.produce?.kinds || []).filter(k => k !== 'signoff' && segments[k]).map(k => segments[k].title),
      cast: showCast(s, kind, segments, network, talk),
    };
  });
  // Shows on the grid first, by their first slot; the rest (cut-ins) after.
  const first = s => s.airs[0] || '99:99';
  shows.sort((a, b) => first(a).localeCompare(first(b)) || a.title.localeCompare(b.title));
  return { timeZone, grid: grid.map(g => ({ at: g.at, show: g.show })), shows };
}

function anchorView(a, group, memory, names, showsOf) {
  const sc = memory?.scoreboard?.[a.id] || {};
  const rels = (memory?.relationships || [])
    .filter(r => (r.a === a.id || r.b === a.id) && names[r.a === a.id ? r.b : r.a])
    .map(r => ({ with: r.a === a.id ? r.b : r.a, withName: names[r.a === a.id ? r.b : r.a], kind: r.kind, heat: r.heat, note: r.note || '' }))
    .sort((x, y) => y.heat - x.heat);
  const quotes = (memory?.quotes || []).filter(q => q.persona === a.id).slice(-3).reverse()
    .map(q => ({ text: q.text, title: q.title || '', episodeId: q.episodeId || null, at: q.at || null }));
  const mood = memory?.moods?.[a.id]?.mood || null;
  return {
    id: a.id, name: a.name, short: a.short || a.name, role: a.role || '', group, bio: a.bio || '',
    lines: (a.catchphrases?.length ? a.catchphrases : a.sample || []).slice(0, 3),
    look: a.look || null, mood,
    receipts: { won: sc.won || 0, lost: sc.lost || 0, right: sc.right || 0, wrong: sc.wrong || 0 },
    relationships: rels, quotes, shows: showsOf[a.id] || [],
  };
}

function castReport({ network, talk = null, memory = null, shows = [] }) {
  const all = [...(network?.anchors || []), ...(talk?.anchors || [])];
  const names = Object.fromEntries(all.map(a => [a.id, a.name]));
  const showsOf = {};
  for (const s of shows) for (const id of s.cast) (showsOf[id] ||= []).push({ id: s.id, title: s.title });
  const groups = [{ id: 'network', title: network?.network?.name || 'HFL-NN', anchors: network?.anchors || [] }];
  if (talk?.anchors?.length) groups.push({ id: 'talk', title: talk.network?.name || 'The Fifth Quarter', anchors: talk.anchors });
  return {
    groups: groups.map(g => ({ id: g.id, title: g.title, anchors: g.anchors.map(a => anchorView(a, g.id, memory, names, showsOf)) })),
  };
}

module.exports = { showsReport, castReport, showKind };
