// Replays (/replays): every segment from the last week, newest first. Each
// opens the episode at that segment (/watch/<id>?at=<seconds>).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const text = l => String(l).replace(/^(Madden export|HFL Hub|League office):\s*/, '');
let data = null;

function dayName(day, i) {
  if (i === 0) return 'Today';
  if (i === 1) return 'Yesterday';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function render() {
  const q = $('find').value.trim().toLowerCase();
  const hit = it => !q || [it.title, it.episodeTitle, it.showTitle, ...it.sources].some(v => String(v).toLowerCase().includes(q));
  const items = data.items.filter(hit);
  $('summary').textContent = data.items.length
    ? `${items.length} of ${data.items.length} segments from the last seven days.`
    : 'No episodes aired in the last seven days.';
  $('list').innerHTML = data.days.map((day, i) => {
    const today = items.filter(it => it.day === day);
    if (!today.length) return '';
    const eps = [...new Map(today.map(it => [it.episodeId, it])).values()];
    return `<section class="panel today-ep"><h2>${esc(dayName(day, i))}</h2>${eps.map(ep => `
      <h3 class="replay-ep"><a href="/watch/${esc(ep.episodeId)}">${esc(ep.episodeTitle)}</a> <span class="muted">${esc(ep.showTitle)}</span></h3>
      <ul class="replay-segs">${today.filter(it => it.episodeId === ep.episodeId).map(it => `
        <li><a class="replay-play" href="${esc(it.url)}" aria-label="Play ${esc(it.title)}">▶</a>
          <div><a href="${esc(it.url)}">${esc(it.title)}</a> <span class="muted">${esc(mmss(it.seconds))}</span>
          ${it.sources.length ? `<div class="muted replay-src">${it.sources.map(x => esc(text(x))).join(' · ')}</div>` : ''}</div></li>`).join('')}
      </ul>`).join('')}</section>`;
  }).join('');
}

(async () => {
  try {
    const res = await fetch('/api/replays');
    if (!res.ok) throw new Error(res.statusText);
    data = await res.json();
    render();
    $('find').addEventListener('input', render);
  } catch (e) {
    $('summary').textContent = `Couldn't load the replays (${e.message}). Try again in a minute.`;
  }
})();
