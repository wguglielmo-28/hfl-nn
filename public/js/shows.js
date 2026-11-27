// The program guide (/shows): every show, when it airs and who is on it.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "20:00" in the league's time zone, as a readable clock.
const clock = hm => {
  const [h, m] = hm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
};
const list = xs => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function render(r, names) {
  const title = Object.fromEntries(r.shows.map(s => [s.id, s.title]));
  $('tz').textContent = 'Every day, in Eastern time. The Vault fills the gaps with past broadcasts.';
  $('grid').innerHTML = r.grid.map(g => `<li><span class="when">${esc(clock(g.at))}</span> <a href="#${esc(g.show)}">${esc(title[g.show] || g.show)}</a></li>`).join('');
  $('shows').innerHTML = r.shows.map(s => {
    const airs = s.airs.length ? `Airs at ${list(s.airs.map(clock))}` : s.kind === 'cutin' ? 'Cuts in when the HFL Hub chat gets busy' : '';
    const fresh = s.newAt.length ? ` · new edition at ${list(s.newAt.map(clock))}` : '';
    const cast = s.cast.filter(id => names[id]).map(id => `<a href="/anchors#${esc(id)}">${esc(names[id])}</a>`);
    return `
    <section class="panel show-card" id="${esc(s.id)}">
      <h2>${esc(s.title)} <span class="tag">${esc(s.kindLabel)}</span></h2>
      <p>${esc(s.blurb)}</p>
      <p class="muted">${esc(airs)}${esc(fresh)}${s.minutes ? ` · about ${s.minutes} minutes` : ''}</p>
      ${cast.length ? `<p><span class="muted">On the desk:</span> ${list(cast)}</p>` : ''}
      ${s.segments.length ? `<p class="muted">Segments: ${esc(s.segments.join(' · '))}</p>` : ''}
    </section>`;
  }).join('');
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

(async () => {
  try {
    const [shows, cast] = await Promise.all(['/api/shows', '/api/anchors'].map(u => fetch(u).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })));
    const names = Object.fromEntries(cast.groups.flatMap(g => g.anchors.map(a => [a.id, a.name])));
    render(shows, names);
  } catch {
    $('tz').textContent = 'The guide could not be loaded. Try again in a minute.';
  }
})();
