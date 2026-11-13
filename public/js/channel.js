// The public channel page. It opens on the live channel (whatever is on air
// right now, in step with every other viewer); picking an episode from the
// on-demand list, or opening /watch/<id>, plays that episode with the full
// controls instead. Also: captions, today's listings, sources for the segment
// on air, and the anchor lineup.
import { Player } from './studio/player.js';
import { drawAnchor, ANCHOR_W, ANCHOR_H } from './studio/anchors.js';
import { Tuner, tunerOptions, clockTime, nowText } from './studio/channelPlayer.js';
import { Footage } from './studio/footage.js';
import { Audience } from './studio/audience.js';

const $ = id => document.getElementById(id);
const player = new Player($('screen'));
const footage = new Footage(document.querySelector('.tv'));
const tuner = new Tuner(player, { ...tunerOptions(), footage });
// The Hub's chat, reactions and poll, read-only, under and over the live channel.
const audience = new Audience(document.querySelector('.tv'), document.querySelector('.tv-wrap'));
window.hflnn = { player, tuner, audience };

const state = { live: false, episodes: [], current: null, preview: false, cc: readPref('hflnn.cc', 'false') === 'true' };

function readPref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

async function api(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

const fmt = t => {
  t = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

// ── Episode guide ────────────────────────────────────────────────────────
function renderGuide() {
  const ul = $('episodes');
  if (!state.episodes.length) {
    ul.innerHTML = '<li class="muted">No broadcasts yet. The first show airs after the next league export.</li>';
    return;
  }
  ul.innerHTML = state.episodes.map(ep => `
    <li><button type="button" data-id="${esc(ep.id)}" aria-current="${ep.id === state.current}">
      <span class="type ${esc(ep.type)}">${esc(ep.type === 'weekly' ? 'WEEKLY' : ep.type === 'breaking' ? 'BREAKING' : ep.type === 'premiere' ? 'PREMIERE' : ep.type === 'kickoff' ? 'KICKOFF' : 'SPECIAL')}</span>
      <span class="ep-title">${esc(ep.title)}</span>
      <span class="ep-meta">${esc([ep.weekLabel, ep.publishedAt ? new Date(ep.publishedAt).toLocaleDateString() : '', ep.duration ? fmt(ep.duration) : ''].filter(Boolean).join(' • '))}</span>
    </button></li>`).join('');
}
$('episodes').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]');
  if (b) { leaveLive(); open(b.dataset.id, { autoplay: true }); }
});

// ── The live channel ─────────────────────────────────────────────────────
async function renderListings() {
  const ol = $('listings');
  try {
    const q = tuner.sim ? `?at=${Math.round(tuner.now())}` : '';
    const { blocks } = await api(`/api/channel/listings${q}`);
    const t = tuner.now();
    const rows = blocks.filter(b => b.until > t).slice(0, 12);
    if (!rows.length) { ol.innerHTML = '<li class="muted">Nothing more today. The channel starts again with the next broadcast.</li>'; return; }
    ol.innerHTML = rows.map(b => `
      <li class="${b.from <= t ? 'on' : ''}">
        <span class="when">${b.from <= t ? 'ON NOW' : esc(clockTime(b.from))}</span>
        <span class="what">
          <span class="show">${esc(b.showTitle)}<span class="tag">${b.kind === 'replay' ? 'REPLAY' : b.kind === 'clips' ? 'CLIPS' : b.rerun ? 'ENCORE' : 'NEW'}</span></span>
          <span class="ep-title">${esc(b.title)}</span>
        </span>
      </li>`).join('');
  } catch { ol.innerHTML = '<li class="muted">The listings are not available right now.</li>'; }
}

function setSoundButton() {
  $('play').textContent = tuner.sound ? '🔊' : '🔇';
  $('play').setAttribute('aria-label', tuner.sound ? 'Turn the sound off' : 'Turn the sound on');
  $('play').title = 'Sound on/off';
}

function tuneIn() {
  $('power').hidden = true;
  tuner.setSound(true);
}

async function goLive(offAir) {
  state.live = true;
  state.current = null;
  document.body.classList.add('live');
  $('back-live').hidden = true;
  $('now-label').textContent = 'LIVE';
  $('marks').innerHTML = '';
  $('power').querySelector('.power-label').textContent = 'Tune in';
  $('power').hidden = false;
  setSoundButton();
  audience.start();
  await tuner.start(offAir);
}

function leaveLive() {
  if (!state.live) return;
  state.live = false;
  tuner.stop();
  audience.stop();
  document.body.classList.remove('live');
  $('back-live').hidden = false;
  $('now-label').textContent = 'NOW';
  $('play').title = 'Play/pause';
  $('power').querySelector('.power-label').textContent = 'Turn on the TV';
}

tuner.addEventListener('block', e => {
  const { block, next } = e.detail;
  const programme = ['episode', 'replay', 'clip', 'live'].includes(block?.kind);
  $('now').textContent = nowText(block);
  $('upnext').textContent = next ? `${clockTime(next.from)} · ${next.title}` : '—';
  $('power-sub').textContent = programme ? block.title : 'Sound on';
  document.title = programme ? `${block.title} — HFL-NN` : 'HFL-NN — HFL News Network';
  if (block?.kind !== 'episode') { renderSources(null); $('captions').hidden = true; }
  renderListings();
});
tuner.addEventListener('loaded', e => { if (e.detail.manifest?.lineup?.length) renderLineup(e.detail.manifest.lineup); });
tuner.addEventListener('sound', e => {
  setSoundButton();
  if (e.detail.blocked) $('power').hidden = false;
});
tuner.addEventListener('error', e => showError(e.detail.message));
tuner.addEventListener('guide', () => { showError(''); renderLiveBar(); });

// League games live right now: the channel cuts to one by itself; these
// buttons switch between them or go back to the studio.
function renderLiveBar() {
  const bar = $('live-bar');
  const live = tuner.live;
  bar.hidden = !live.length;
  if (!live.length) { bar.innerHTML = ''; return; }
  const on = tuner.liveBlock()?.liveId || 'studio';
  bar.innerHTML = '<span class="label">● LIVE GAMES</span>' + live.map(l => `
    <button type="button" data-live="${esc(l.id)}" aria-pressed="${l.id === on}">${esc(l.game.away)} at ${esc(l.game.home)}${l.game.gotw ? ' ★' : ''}</button>`).join('')
    + `<button type="button" data-live="studio" aria-pressed="${on === 'studio'}">Studio</button>`;
}
$('live-bar').addEventListener('click', e => {
  const b = e.target.closest('button[data-live]');
  if (b) tuner.chooseLive(b.dataset.live);
});

// ── The desk ─────────────────────────────────────────────────────────────
function renderLineup(lineup) {
  const ul = $('lineup');
  ul.innerHTML = '';
  for (const a of lineup) {
    const li = document.createElement('li');
    const c = document.createElement('canvas');
    c.width = ANCHOR_W; c.height = ANCHOR_H;
    const g = c.getContext('2d');
    g.fillStyle = '#160d33'; g.fillRect(0, 0, ANCHOR_W, ANCHOR_H);
    drawAnchor(g, a.look, 0, 4, 1, { emotion: 'happy' });
    li.appendChild(c);
    const d = document.createElement('div');
    d.innerHTML = `<div class="name">${esc(a.name)}</div><div class="role">${esc(a.role)}</div><p class="bio">${esc(a.bio)}</p>`;
    li.appendChild(d);
    ul.appendChild(li);
  }
}

// ── Loading an episode ───────────────────────────────────────────────────
async function open(id, { autoplay = false, preview = false, quiet = false } = {}) {
  showError('');
  const manifestUrl = preview ? `/api/admin/episodes/${encodeURIComponent(id)}/manifest` : `/api/episodes/${encodeURIComponent(id)}`;
  const audioBase = preview ? `/api/admin/media/${encodeURIComponent(id)}` : `/media/${encodeURIComponent(id)}`;
  try {
    const m = await player.load(manifestUrl, audioBase);
    state.current = id;
    state.preview = preview;
    renderGuide();
    renderMarks(m);
    if (m.lineup?.length) renderLineup(m.lineup);
    $('now').textContent = m.title;
    $('upnext').textContent = m.segments[0]?.title || '—';
    renderSources(m.segments[0]);
    $('power-sub').textContent = m.title;
    document.title = `${m.title} — HFL-NN`;
    if (!quiet && !preview && location.pathname !== `/watch/${id}`) history.pushState({ id }, '', `/watch/${id}`);
    if (autoplay) start(); else $('power').hidden = false;
  } catch (e) {
    showError(e.message.includes('404') ? 'That episode is not available.' : `Could not load the episode: ${e.message}`);
  }
}

function start() {
  $('power').hidden = true;
  player.play();
}

function renderMarks(m) {
  const d = m.duration || 1;
  $('marks').innerHTML = (m.segments || []).slice(1).map(s => `<span style="left:${(100 * s.t0 / d).toFixed(2)}%" title="${esc(s.title)}"></span>`).join('');
}

function renderSources(seg) {
  const ul = $('sources');
  const list = seg?.sources || [];
  if (!list.length) { ul.innerHTML = `<li class="muted">${seg ? 'Opinions only in this segment.' : 'Nothing on air yet.'}</li>`; return; }
  ul.innerHTML = list.map(s => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>` : esc(s.label)}</li>`).join('');
}

// ── Player events ────────────────────────────────────────────────────────
player.addEventListener('line', e => {
  const ln = e.detail.line;
  const box = $('captions');
  if (!state.cc || !ln) { box.hidden = true; return; }
  const who = player.manifest?.lineup?.find(a => a.id === ln.speaker);
  box.innerHTML = `<b>${esc(who?.short || ln.speaker)}</b>${esc(ln.text)}`;
  box.hidden = false;
});
player.addEventListener('segment', e => {
  const seg = e.detail.segment;
  const segs = player.manifest?.segments || [];
  const i = segs.findIndex(s => s.id === seg?.id);
  renderSources(seg);
  if (state.live) return;   // the live strip names the show, not the segment
  $('now').textContent = seg?.title || '—';
  $('upnext').textContent = segs[i + 1]?.title || 'Sign-off';
});
player.addEventListener('state', () => {
  if (state.live) return;
  $('play').textContent = player.playing ? '⏸' : '▶';
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
});
player.addEventListener('ended', () => {
  if (state.live) return;   // the channel moves on by itself
  $('power').hidden = false;
  $('power').querySelector('.power-label').textContent = 'Watch again';
});
player.addEventListener('error', e => showError(e.detail.message));

// ── Controls ─────────────────────────────────────────────────────────────
$('power').addEventListener('click', () => {
  if (state.live) return tuneIn();
  if (!player.manifest) return;
  if (player.audio.ended) player.seek(0);
  start();
});
$('play').addEventListener('click', () => {
  if (state.live) { $('power').hidden = true; return tuner.setSound(!tuner.sound); }
  if (!player.manifest) return;
  $('power').hidden = true;
  player.toggle();
});
$('prev').addEventListener('click', () => player.prevSegment());
$('next').addEventListener('click', () => player.nextSegment());
$('volume').addEventListener('input', e => player.setVolume(Number(e.target.value)));
$('cc').addEventListener('click', () => {
  state.cc = !state.cc;
  writePref('hflnn.cc', String(state.cc));
  $('cc').setAttribute('aria-pressed', String(state.cc));
  if (!state.cc) $('captions').hidden = true;
});
$('cc').setAttribute('aria-pressed', String(state.cc));
$('fullscreen').addEventListener('click', () => {
  const tv = document.querySelector('.tv');
  if (document.fullscreenElement) document.exitFullscreen(); else tv.requestFullscreen?.();
});
const seekFromEvent = e => {
  if (state.live) return;   // live television does not rewind
  const r = $('progress').getBoundingClientRect();
  player.seek(((e.clientX - r.left) / r.width) * player.duration);
};
$('progress').addEventListener('click', seekFromEvent);
$('progress').addEventListener('keydown', e => {
  if (state.live) return;
  if (e.key === 'ArrowRight') player.seek(player.time + 5);
  if (e.key === 'ArrowLeft') player.seek(player.time - 5);
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [role=slider]')) return;
  if (e.key === ' ' && state.live) { e.preventDefault(); $('power').hidden = true; tuner.setSound(!tuner.sound); }
  else if (e.key === ' ' && player.manifest) { e.preventDefault(); $('power').hidden = true; player.toggle(); }
  if (e.key === 'c') $('cc').click();
});
setInterval(() => {
  let d = player.duration, t = player.time;
  if (state.live) {
    // How far through the block on air, and when it ends.
    const b = tuner.cur;
    const open = !b || !Number.isFinite(b.until);   // a live game ends when it ends
    d = open ? 0 : (b.until - b.from) / 1000;
    t = open ? 0 : Math.min(d, (tuner.now() - b.from) / 1000);
    $('time').textContent = open ? 'LIVE' : `ends ${clockTime(b.until)}`;
  } else $('time').textContent = `${fmt(t)} / ${fmt(d)}`;
  $('bar').style.width = d ? `${(100 * t) / d}%` : '0';
  $('progress').setAttribute('aria-valuenow', d ? String(Math.round((100 * t) / d)) : '0');
}, 250);
window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\/watch\/([\w-]+)/);
  if (m) { leaveLive(); open(m[1], { quiet: true }); } else location.reload();
});

// ── Boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  const params = new URLSearchParams(location.search);
  const [episodes, ticker] = await Promise.all([
    api('/api/episodes').catch(() => []),
    api('/api/ticker').catch(() => ({ items: [], lineup: [] })),
  ]);
  state.episodes = episodes;
  renderGuide();
  renderLineup(ticker.lineup || []);
  const offAir = { ticker: ticker.items || [], message: ticker.message || 'OFF AIR', lineup: ticker.lineup || [] };
  player.unload(offAir);

  const preview = params.get('preview');
  const watch = location.pathname.match(/^\/watch\/([\w-]+)/);
  if (preview || watch) {
    $('back-live').hidden = false;
    $('listings').closest('section').hidden = true;
    if (preview) await open(preview, { preview: true }); else await open(watch[1], { quiet: true });
  } else {
    await goLive(offAir);
    if (!episodes.length) $('power').hidden = true;
  }

  // Still frames for tools/snap.js: /watch/<id>?t=42 renders that instant.
  if (params.has('t') && player.manifest) {
    $('power').hidden = true;
    player.renderAt(Number(params.get('t')));
  }
  window.hflnnReady = true;
})();
