// The Standings Center (/standings): the playoff race from the latest export.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = n => (!n ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function team(r) {
  const chip = r.color ? `<span class="chip" style="background:${esc(r.color)}"></span>` : '';
  return `${chip}<span class="abbr">${esc(r.abbr)}</span> <span class="tname">${esc(r.nick)}</span>${r.clinch ? ` <span class="mark" title="${esc(r.clinch.label)}">${esc(r.clinch.mark)}</span>` : ''}${r.coach ? `<span class="coach">${esc(r.coach)}</span>` : ''}`;
}
const next = r => (r.next ? `${r.next.home ? 'vs' : '@'} ${esc(r.next.opp)}` : '');

function seedRow(r) {
  return `<tr class="st-${esc(r.state)}"><td class="num">${r.seed}</td><td>${team(r)}</td><td class="num">${esc(r.rec)}</td><td class="num">${esc(r.streak)}</td><td class="num">${r.left}</td></tr>`;
}
function huntRow(r) {
  return `<tr class="st-hunt"><td class="num">${r.seed || ''}</td><td>${team(r)}</td><td class="num">${esc(r.rec)}</td><td class="num">${gb(r.back)}</td><td class="num">${r.left}</td></tr>`;
}

function conf(c) {
  return `
  <section class="panel std-conf">
    <h2>${esc(c.name)}</h2>
    <table><caption class="muted">In the playoffs</caption>
      <thead><tr><th class="num">Seed</th><th>Team</th><th class="num">W-L</th><th class="num">Strk</th><th class="num" title="Games left">Left</th></tr></thead>
      <tbody>${c.seeds.map(seedRow).join('')}</tbody></table>
    ${c.hunt.length ? `<table><caption class="muted">In the hunt</caption>
      <thead><tr><th class="num">Seed</th><th>Team</th><th class="num">W-L</th><th class="num" title="Games behind the 7th seed">GB</th><th class="num" title="Games left">Left</th></tr></thead>
      <tbody>${c.hunt.map(huntRow).join('')}</tbody></table>` : ''}
    ${c.out.length ? `<p class="muted std-out"><strong>Out:</strong> ${c.out.map(r => `${esc(r.abbr)} (${esc(r.rec)})`).join(', ')}</p>` : ''}
  </section>`;
}

function div(d) {
  return `
  <section class="panel std-div">
    <h3>${esc(d.name)}</h3>
    <table><thead><tr><th>Team</th><th class="num">W-L</th><th class="num">GB</th><th class="num">Div</th><th class="num">Net</th><th>Next</th></tr></thead>
    <tbody>${d.teams.map(r => `<tr class="st-${esc(r.state)}"><td>${team(r)}</td><td class="num">${esc(r.rec)}</td><td class="num">${gb(r.divBack)}</td><td class="num">${esc(r.divRec)}</td><td class="num">${r.netPts > 0 ? '+' : ''}${r.netPts ?? ''}</td><td>${next(r)}</td></tr>`).join('')}</tbody></table>
  </section>`;
}

function render(r) {
  if (!r.ready) { $('summary').textContent = r.note; return; }
  const all = r.conferences.flatMap(c => [...c.seeds, ...c.hunt, ...c.out]);
  const clinched = all.filter(t => t.clinch).length;
  const out = all.filter(t => t.state === 'out').length;
  const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  $('summary').textContent = [r.through ? `Through ${r.through}` : null, `${plural(clinched, 'team')} clinched`, `${out} out`, when ? `updated ${when}` : null].filter(Boolean).join(' · ');
  if (r.note) { $('note').hidden = false; $('note').textContent = r.note; }
  $('confs').innerHTML = r.conferences.map(conf).join('');
  $('divs').innerHTML = r.conferences.flatMap(c => c.divisions).map(div).join('');
}

(async () => {
  try {
    const res = await fetch('/api/standings');
    if (!res.ok) throw new Error(res.statusText);
    render(await res.json());
  } catch {
    $('summary').textContent = 'The standings could not be loaded. Try again in a minute.';
  }
})();
