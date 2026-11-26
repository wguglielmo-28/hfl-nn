// Today on HFL-NN (/today): what aired on a day and where each story came from.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { export: 'Madden export', chronicle: 'Crimson Chronicle', hub: 'HFL Hub', office: 'League office' };

function dayName(day, tz, first) {
  if (first) return 'Today';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const clock = (iso, tz) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
// The tag already says where it came from.
const text = x => String(x.label).replace(/^(Madden export|HFL Hub|League office):\s*/, '');
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function render(r) {
  $('days').innerHTML = r.days.map((d, i) => `<a href="/today?day=${d}" ${d === r.day ? 'aria-current="page"' : ''}>${esc(dayName(d, r.timeZone, i === 0))}</a>`).join('');
  const n = Object.values(r.totals).reduce((a, b) => a + b, 0);
  const parts = Object.entries(r.totals).filter(([, v]) => v).map(([k, v]) => `${v} from the ${KIND[k]}`);
  $('summary').textContent = r.episodes.length
    ? `${r.episodes.length} episode${r.episodes.length === 1 ? '' : 's'}, ${n} source${n === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}. Times are Eastern.`
    : 'Nothing new aired this day. Reruns don\'t count; pick another day above.';
  $('episodes').innerHTML = r.episodes.map(e => `
    <section class="panel today-ep">
      <h2><a href="/watch/${esc(e.id)}">${esc(e.title)}</a></h2>
      <p class="muted">${esc(e.showTitle)} · first aired ${esc(clock(e.publishedAt, r.timeZone))}${e.duration ? ` · ${esc(mmss(e.duration))}` : ''}</p>
      <ol class="today-segs">${e.segments.map(s => `
        <li><h3>${esc(s.title || 'Segment')} <span class="muted">at ${esc(mmss(s.t0))}</span></h3>
          ${s.sources.length ? `<ul>${s.sources.map(x => `<li><span class="src src-${esc(x.kind)}">${esc(KIND[x.kind])}</span> ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(text(x))}</a>` : esc(text(x))}</li>`).join('')}</ul>` : '<p class="muted">Opinions only in this segment.</p>'}
        </li>`).join('')}
      </ol>
    </section>`).join('');
}

(async () => {
  const day = new URLSearchParams(location.search).get('day') || '';
  try {
    const res = await fetch(`/api/today${day ? `?day=${encodeURIComponent(day)}` : ''}`);
    if (!res.ok) throw new Error(res.statusText);
    render(await res.json());
  } catch (e) {
    $('summary').textContent = `Couldn't load today's stories (${e.message}). Try again in a minute.`;
  }
})();
