// Game footage on the channel: a member's live stream, a replay, or a clip,
// shown in Twitch's or YouTube's own embedded player laid over the studio
// screen. Nothing is downloaded or re-hosted; if the member deletes the video
// the player simply says so.
//
// The players are plain iframes addressed by URL (no third-party script runs
// on this page), so there is no way to nudge them once they are playing: a
// replay is started at the right moment of the game and left to run.

const TWITCH_LOGIN = /^[a-z0-9_]{2,25}$/;
const TWITCH_VIDEO = /^\d{1,20}$/;
const TWITCH_CLIP = /^[A-Za-z0-9_-]{1,120}$/;
const YOUTUBE_VIDEO = /^[A-Za-z0-9_-]{11}$/;

// Twitch only plays inside pages it is told about: this one, and whatever
// page is framing it (the Hub, for /embed/channel).
function twitchParents() {
  const hosts = new Set([location.hostname]);
  for (const o of Array.from(location.ancestorOrigins || [])) { try { hosts.add(new URL(o).hostname); } catch { /* opaque origin */ } }
  return [...hosts].map(h => `parent=${encodeURIComponent(h)}`).join('&');
}

const hms = s => `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${Math.floor(s % 60)}s`;

// The player address for a block, or null if the block's ids are not the
// shape the platform uses.
export function footageUrl(block, offsetS = 0, muted = true) {
  const s = block?.stream;
  if (!s) return null;
  const at = Math.max(0, Math.floor(offsetS));
  if (block.kind === 'clip') {
    if (!TWITCH_CLIP.test(block.clipId || '')) return null;
    return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(block.clipId)}&${twitchParents()}&autoplay=true&muted=${muted}`;
  }
  if (s.platform === 'youtube') {
    if (!YOUTUBE_VIDEO.test(s.videoId || '')) return null;
    const start = block.kind === 'replay' ? `&start=${at}` : '';
    return `https://www.youtube-nocookie.com/embed/${s.videoId}?autoplay=1&mute=${muted ? 1 : 0}&playsinline=1&rel=0${start}`;
  }
  if (block.kind === 'live') {
    if (!TWITCH_LOGIN.test(s.channel || '')) return null;
    return `https://player.twitch.tv/?channel=${s.channel}&${twitchParents()}&autoplay=true&muted=${muted}`;
  }
  if (!TWITCH_VIDEO.test(s.videoId || '')) return null;
  return `https://player.twitch.tv/?video=v${s.videoId}&${twitchParents()}&autoplay=true&muted=${muted}&time=${hms(at)}`;
}

const BADGE = { live: 'LIVE', replay: 'REPLAY', clip: 'TOP PLAYS' };

export class Footage {
  // `tv` is the element holding the studio canvas; the layer sits on top of it.
  constructor(tv) {
    this.block = null;
    this.muted = true;
    this.el = document.createElement('div');
    this.el.className = 'footage';
    this.el.hidden = true;
    this.frameBox = document.createElement('div');
    this.frameBox.className = 'footage-frame';
    this.bar = document.createElement('div');
    this.bar.className = 'footage-bar';
    this.el.append(this.frameBox, this.bar);
    tv.insertBefore(this.el, tv.querySelector('canvas').nextSibling);
  }

  get active() { return !!this.block; }

  show(block, offsetS, muted) {
    const url = footageUrl(block, offsetS, muted);
    if (!url) return false;
    this.block = block;
    this.muted = muted;
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = `${block.title} — ${BADGE[block.kind] || ''}`;
    frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    this.frameBox.replaceChildren(frame);

    const g = block.game || {};
    const badge = document.createElement('span');
    badge.className = `footage-badge ${block.kind}`;
    badge.textContent = `HFL-NN · ${BADGE[block.kind] || ''}`;
    const what = document.createElement('span');
    what.className = 'footage-what';
    const week = g.week ? ` · ${g.stage === 'pre' ? 'Preseason ' : g.stage === 'post' ? 'Playoffs ' : ''}Week ${g.week}` : '';
    what.textContent = `${g.away && g.home ? `${g.away} at ${g.home}` : block.title}${week}${g.gotw ? ' · Game of the Week' : ''}`;
    const who = document.createElement('span');
    who.className = 'footage-who';
    who.textContent = block.stream.member ? `from ${block.stream.member}'s stream` : '';
    this.bar.replaceChildren(badge, what, who);
    this.el.hidden = false;
    return true;
  }

  // The players take their sound setting from the address, so changing it
  // means starting the player again at the right moment.
  setMuted(muted, offsetS) {
    if (!this.block || muted === this.muted) return;
    this.show(this.block, offsetS, muted);
  }

  hide() {
    if (!this.block && this.el.hidden) return;
    this.block = null;
    this.frameBox.replaceChildren();
    this.el.hidden = true;
  }
}
