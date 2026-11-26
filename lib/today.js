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

module.exports = { todayReport, sourceKind, recentDays, DAYS_BACK };
