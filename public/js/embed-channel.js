// The framed live channel (/embed/channel): the screen, a sound switch,
// captions and what is on now. The picture is live from the moment it loads;
// sound waits for a click, as browsers require. See docs/embed.md.
import { Player } from './studio/player.js';
import { Tuner, tunerOptions, clockTime, nowText } from './studio/channelPlayer.js';
import { Footage } from './studio/footage.js';

const $ = id => document.getElementById(id);
const player = new Player($('screen'));
const tuner = new Tuner(player, { ...tunerOptions(), footage: new Footage($('tv')) });
window.hflnn = { player, tuner };

const state = { cc: readPref('hflnn.cc', 'false') === 'true' };

function readPref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode, or third-party storage blocked */ } }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

function setSoundButton() {
  $('play').textContent = tuner.sound ? '🔊' : '🔇';
  $('play').setAttribute('aria-label', tuner.sound ? 'Turn the sound off' : 'Turn the sound on');
}

player.addEventListener('line', e => {
  const ln = e.detail.line;
  const box = $('captions');
  if (!state.cc || !ln) { box.hidden = true; return; }
  const who = player.manifest?.lineup?.find(a => a.id === ln.speaker);
  box.innerHTML = `<b>${esc(who?.short || ln.speaker)}</b>${esc(ln.text)}`;
  box.hidden = false;
});
player.addEventListener('error', e => showError(e.detail.message));

tuner.addEventListener('block', e => {
  const { block, next } = e.detail;
  const programme = ['episode', 'replay', 'clip', 'live'].includes(block?.kind);
  $('now').textContent = programme ? nowText(block) : next ? `Next ${clockTime(next.from)}: ${next.title}` : 'Stand by';
  $('time').textContent = programme && Number.isFinite(block.until) ? `ends ${clockTime(block.until)}` : '';
  $('power-sub').textContent = programme ? block.title : 'Sound on';
  if (block?.kind !== 'episode') $('captions').hidden = true;
});
tuner.addEventListener('sound', e => {
  setSoundButton();
  if (e.detail.blocked) $('power').hidden = false;
});
tuner.addEventListener('error', e => showError(e.detail.message));
tuner.addEventListener('guide', () => showError(''));

$('power').addEventListener('click', () => { $('power').hidden = true; tuner.setSound(true); });
$('play').addEventListener('click', () => { $('power').hidden = true; tuner.setSound(!tuner.sound); });
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
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
  if (e.key === 'c') $('cc').click();
});

(async function boot() {
  const ticker = await fetch('/api/ticker', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  await tuner.start({ ticker: ticker.items || [], lineup: ticker.lineup || [] });
  window.hflnnReady = true;
})();
