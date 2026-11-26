// Today on HFL-NN: every story that aired on a day, episode by episode and
// segment by segment, credited to where it came from. Built from what was
// published: each episode's manifest already carries its segments' sources
// (lib/producer.js sourcesFor), so nothing here is new reporting.
'use strict';
const { dayKey, nextDay, DAY_RE } = require('./channel/clock');

const DAYS_BACK = 7;

// What a source line is, from the label sourcesFor gives it.
function sourceKind(label) {
  const l = String(label || '');
  if (l.startsWith('Madden export:')) return 'export';
  if (l.startsWith('HFL Hub:')) return 'hub';
  if (l.startsWith('League office:')) return 'office';
  return 'chronicle';
}

// The days a viewer can look back on, newest first.
function recentDays(now, tz, n = DAYS_BACK) {
  const today = dayKey(now, tz);
  return Array.from({ length: n }, (_, i) => nextDay(today, -i));
}

function todayReport({ episodes, manifest, day = null, now = Date.now(), timeZone, showTitles = {} }) {
  const days = recentDays(now, timeZone);
  const want = day && DAY_RE.test(day) && days.includes(day) ? day : days[0];
  const totals = { export: 0, chronicle: 0, hub: 0, office: 0 };
  const list = (episodes || [])
    .filter(e => e.publishedAt && dayKey(Date.parse(e.publishedAt), timeZone) === want)
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    .map(e => {
      const m = manifest(e.id);
      if (!m) return null;
      const segments = (m.segments || []).map(s => ({
        title: s.title || '',
        t0: Math.max(0, Math.round(Number(s.t0) || 0)),
        sources: (s.sources || []).map(x => {
          const kind = sourceKind(x.label);
          totals[kind]++;
          return { label: String(x.label), kind, ...(x.url && /^https?:\/\//.test(x.url) ? { url: x.url } : {}) };
        }),
      }));
      const show = e.channelShow || e.show || null;
      return {
        id: e.id, title: m.title || e.title, type: e.type, show, showTitle: (show && showTitles[show]) || m.brand?.name || 'HFL-NN',
        publishedAt: e.publishedAt, duration: m.duration || e.duration || null, segments,
      };
    })
    .filter(Boolean);
  return { day: want, days, timeZone, episodes: list, totals };
}

// Segment replays: every segment of every episode first aired in the last
// week, newest first, each starting the episode audio at its own start.
function replaysReport({ episodes, manifest, now = Date.now(), timeZone, showTitles = {} }) {
  const days = recentDays(now, timeZone);
  const oldest = days.at(-1);
  const items = [];
  for (const e of [...(episodes || [])].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))) {
    if (!e.publishedAt) continue;
    const day = dayKey(Date.parse(e.publishedAt), timeZone);
    if (day < oldest || day > days[0]) continue;
    const m = manifest(e.id);
    if (!m?.segments?.length) continue;
    const show = e.channelShow || e.show || null;
    const showTitle = (show && showTitles[show]) || m.brand?.name || 'HFL-NN';
    const end = Number(m.duration) || 0;
    m.segments.forEach((s, i) => {
      // Rounded up to a tenth, so the link never lands in the segment before.
      const t0 = Math.max(0, Math.ceil((Number(s.t0) || 0) * 10) / 10);
      const next = m.segments[i + 1];
      const t1 = next ? Number(next.t0) || end : end;
      items.push({
        episodeId: e.id, episodeTitle: m.title || e.title, showTitle, day, publishedAt: e.publishedAt,
        segment: i + 1, title: s.title || `Segment ${i + 1}`, t0, seconds: Math.max(0, Math.round(t1 - t0)),
        sources: (s.sources || []).map(x => String(x.label)).slice(0, 4),
        url: `/watch/${encodeURIComponent(e.id)}?at=${t0}`,
      });
    });
  }
  return { days, timeZone, items };
}

module.exports = { todayReport, replaysReport, sourceKind, recentDays, DAYS_BACK };
