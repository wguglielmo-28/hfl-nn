// The framed player (/embed/:id, /embed/latest): the channel's controls
// without the guide, lineup or ticker. Never autoplays; ?t=<seconds> sets
// where playback starts. See docs/embed.md.
import { Player } from './studio/player.js';

const $ = id => document.getElementById(id);
const player = new Player($('screen'));
window.hflnn = { player };

const state = { cc: readPref('hflnn.cc', 'false') === 'true' };

function readPref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode, or third-party storage blocked */ } }

const fmt = t => {
  t = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

function renderMarks(m) {
  const d = m.duration || 1;
  $('marks').innerHTML = (m.segments || []).slice(1).map(s => `<span style="left:${(100 * s.t0 / d).toFixed(2)}%" title="${esc(s.title)}"></span>`).join('');
}

function start() {
  $('power').hidden = true;
  player.play();
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
player.addEventListener('state', () => {
  $('play').textContent = player.playing ? '⏸' : '▶';
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
});
player.addEventListener('ended', () => {
  $('power').hidden = false;
  $('power').querySelector('.power-label').textContent = 'Watch again';
});
player.addEventListener('error', e => showError(e.detail.message));

// ── Controls ─────────────────────────────────────────────────────────────
$('power').addEventListener('click', () => {
  if (!player.manifest) return;
  if (player.audio.ended) player.seek(0);
  start();
});
$('play').addEventListener('click', () => {
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
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
});
const seekFromEvent = e => {
  const r = $('progress').getBoundingClientRect();
  player.seek(((e.clientX - r.left) / r.width) * player.duration);
};
$('progress').addEventListener('click', seekFromEvent);
$('progress').addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') player.seek(player.time + 5);
  if (e.key === 'ArrowLeft') player.seek(player.time - 5);
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [role=slider]')) return;
  if (e.key === ' ' && player.manifest) { e.preventDefault(); $('power').hidden = true; player.toggle(); }
  if (e.key === 'c') $('cc').click();
});
setInterval(() => {
  const d = player.duration, t = player.time;
  $('bar').style.width = d ? `${(100 * t) / d}%` : '0';
  $('time').textContent = `${fmt(t)} / ${fmt(d)}`;
  $('progress').setAttribute('aria-valuenow', d ? String(Math.round((100 * t) / d)) : '0');
}, 250);

// ── Boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  const params = new URLSearchParams(location.search);
  let id = location.pathname.match(/^\/embed\/([\w-]+)/)?.[1];
  if (id === 'latest') {
    const list = await fetch('/api/episodes', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : [])).catch(() => []);
    id = list[0]?.id;
  }
  if (!id) {
    player.unload({ message: 'OFF AIR' });
    showError('No broadcasts yet.');
    window.hflnnReady = true;
    return;
  }
  $('watch-link').href = `/watch/${encodeURIComponent(id)}`;
  try {
    const m = await player.load(`/api/episodes/${encodeURIComponent(id)}`, `/media/${encodeURIComponent(id)}`);
    renderMarks(m);
    $('power-sub').textContent = m.title;
    document.title = `${m.title} — HFL-NN`;
    const t = Number(params.get('t'));
    if (t > 0) {
      // Seeking before the audio's metadata arrives is ignored by some browsers.
      const at = () => player.seek(t);
      if (player.audio.readyState >= 1) at(); else player.audio.addEventListener('loadedmetadata', at, { once: true });
      $('watch-link').href += `?t=${Math.floor(t)}`;
    }
    $('power').hidden = false;
  } catch (e) {
    showError(e.message.includes('404') ? 'That episode is not available.' : `Could not load the episode: ${e.message}`);
  }
  window.hflnnReady = true;
})();
