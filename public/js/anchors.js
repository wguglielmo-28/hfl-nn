// The anchors (/anchors): bios, moods, receipts, rivalries and latest takes.
import { drawAnchor, ANCHOR_W, ANCHOR_H } from './studio/anchors.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { rivalry: 'Rivals', needling: 'Needles', exasperation: 'Exasperated by', respect: 'Respects', alliance: 'Allies', competition: 'Competes with', grudge: 'Holds a grudge' };
const kindLabel = k => KIND[k] || (k ? k[0].toUpperCase() + k.slice(1) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function receipts(r) {
  const parts = [];
  if (r.won || r.lost) parts.push(`Arguments: ${r.won} won, ${r.lost} lost`);
  if (r.right || r.wrong) parts.push(`Predictions: ${r.right} right, ${r.wrong} wrong`);
  return parts.length ? parts.join(' · ') : 'No receipts yet.';
}

function card(a) {
  return `
  <section class="panel anchor-card" id="${esc(a.id)}">
    <canvas width="${ANCHOR_W}" height="${ANCHOR_H}" data-id="${esc(a.id)}" aria-hidden="true"></canvas>
    <div>
      <h3>${esc(a.name)}</h3>
      <p class="role">${esc(a.role)}${a.mood ? ` · <span class="mood">Mood: ${esc(a.mood)}</span>` : ''}</p>
      <p>${esc(a.bio)}</p>
      ${a.lines.length ? `<p class="muted lines">${a.lines.map(l => `“${esc(l)}”`).join(' ')}</p>` : ''}
      ${a.shows.length ? `<p><span class="muted">On:</span> ${a.shows.map(s => `<a href="/shows#${esc(s.id)}">${esc(s.title)}</a>`).join(', ')}</p>` : ''}
      <p class="muted">${esc(receipts(a.receipts))}</p>
      ${a.relationships.length ? `<details><summary>At the desk with (${a.relationships.length})</summary><ul class="rels">${a.relationships.map(r => `
        <li><span class="tag">${esc(kindLabel(r.kind))}</span> <a href="#${esc(r.with)}">${esc(r.withName)}</a>${r.note ? `: ${esc(r.note)}` : ''}</li>`).join('')}</ul></details>` : ''}
      ${a.quotes.length ? `<div class="quotes"><p class="muted">Latest on air</p>${a.quotes.map(q => `
        <blockquote>${esc(q.text)}${q.title ? ` <cite>${q.episodeId ? `<a href="/watch/${esc(q.episodeId)}">${esc(q.title)}</a>` : esc(q.title)}</cite>` : ''}</blockquote>`).join('')}</div>` : ''}
    </div>
  </section>`;
}

function render(r, looks) {
  const n = r.groups.reduce((t, g) => t + g.anchors.length, 0);
  $('summary').textContent = `${plural(n, 'anchor')} across ${plural(r.groups.length, 'show')}. Moods and receipts come from what aired; the opinions are theirs, written by AI.`;
  $('groups').innerHTML = r.groups.map(g => `<h2 class="group-h">${esc(g.title)}</h2>${g.anchors.map(card).join('')}`).join('');
  for (const c of document.querySelectorAll('canvas[data-id]')) {
    const g = c.getContext('2d');
    g.fillStyle = '#160d33'; g.fillRect(0, 0, ANCHOR_W, ANCHOR_H);
    drawAnchor(g, looks[c.dataset.id], 0, 4, 1, { emotion: 'happy' });
  }
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

(async () => {
  try {
    const res = await fetch('/api/anchors');
    if (!res.ok) throw new Error(res.statusText);
    const r = await res.json();
    render(r, Object.fromEntries(r.groups.flatMap(g => g.anchors.map(a => [a.id, a.look]))));
  } catch {
    $('summary').textContent = 'The anchors could not be loaded. Try again in a minute.';
  }
})();
