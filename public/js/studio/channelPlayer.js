// The live channel. The server says what is on (/api/channel); the tuner
// keeps the player on that block at the right moment — tune in halfway
// through a show and you land halfway through it, in step with everyone else.
//
// The picture runs off the channel clock, so it is live even with the sound
// off. Once the viewer turns the sound on, the audio is started at the
// matching offset and nudged back if it drifts.
//
//   ?at=<epoch ms>   start the channel clock at another instant
//   ?speed=<n>       run the channel clock faster (checking block changes)

const RESYNC_S = 1.5;
const POLL_MS = 30000;
const TICK_MS = 250;

const keyOf = b => (b ? `${b.kind}:${b.episodeId || ''}:${b.from}` : '');

export class Tuner extends EventTarget {
  constructor(player, { at = null, speed = 1 } = {}) {
    super();
    this.player = player;
    this.at = Number.isFinite(at) ? at : null;
    this.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    this.sim = this.at != null || this.speed !== 1;
    this.base = null;         // channel time at `mark`
    this.mark = 0;
    this.blocks = [];
    this.guide = null;
    this.cur = null;          // block on air
    this.ready = null;        // key of the block whose episode is loaded
    this.sound = false;
    this.offAir = {};
    this.timer = null;
    this.lastPoll = 0;
    this.polling = false;
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Channel time, epoch ms.
  now() { return this.base == null ? Date.now() : this.base + (performance.now() - this.mark) * this.speed; }

  async refresh() {
    if (this.polling) return;
    this.polling = true;
    this.lastPoll = performance.now();
    try {
      const first = this.base == null;
      const q = this.sim ? `?at=${Math.round(first ? (this.at ?? Date.now()) : this.now())}` : '';
      const t0 = performance.now();
      const r = await fetch(`/api/channel${q}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(`channel: ${r.status}`);
      const g = await r.json();
      const t1 = performance.now();
      // Follow the server's clock, not the viewer's (which may be minutes out).
      if (first || !this.sim) { this.base = g.now + (this.sim ? 0 : (t1 - t0) / 2); this.mark = t1; }
      this.guide = g;
      this.blocks = g.blocks || [];
      this.emit('guide', { guide: g });
    } catch (e) {
      this.emit('error', { message: 'Lost the channel. Retrying…' });
    } finally { this.polling = false; }
  }

  async start(offAir = {}) {
    this.offAir = offAir;
    await this.refresh();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.player.clock = null;
    this.player.bugLabel = null;
    this.player.audio.playbackRate = 1;
    this.cur = null;
    this.ready = null;
  }

  blockAt(t) { return this.blocks.find(b => b.from <= t && t < b.until) || null; }
  nextEpisode(t = this.now()) { return this.blocks.find(b => b.kind === 'episode' && b.from > t) || null; }

  setSound(on) {
    this.sound = !!on;
    if (!this.sound) this.player.audio.pause();
    this.tick();
    this.emit('sound', { on: this.sound });
  }

  tick() {
    const t = this.now();
    const b = this.blockAt(t);
    const stale = performance.now() - this.lastPoll;
    const last = this.blocks[this.blocks.length - 1];
    // Poll on a timer, and sooner when the listings are about to run out.
    if (stale > POLL_MS || ((!b || !last || last.until - t < 10 * 60000) && stale > 5000)) this.refresh();
    if (keyOf(b) !== keyOf(this.cur)) this.enter(b);
    if (b?.kind === 'episode' && this.ready === keyOf(b)) this.sync(b, t);
  }

  async enter(b) {
    const p = this.player;
    this.cur = b;
    this.ready = null;
    const key = keyOf(b);
    this.emit('block', { block: b, next: this.nextEpisode(b ? b.until - 1 : this.now()) });
    if (b?.kind !== 'episode') {
      const next = this.nextEpisode();
      p.clock = null;
      p.unload({ ...this.offAir, bug: b ? 'HFL-NN' : 'STAND BY', message: next ? `NEXT: ${String(next.title).toUpperCase()}` : 'STAND BY' });
      return;
    }
    try {
      const id = encodeURIComponent(b.episodeId);
      p.clock = () => (this.now() - b.from) / 1000;
      await p.load(`/api/episodes/${id}`, `/media/${id}`);
      if (keyOf(this.cur) !== key) return;   // the channel moved on while it loaded
      p.bugLabel = b.rerun ? 'ENCORE' : null;
      p.audio.playbackRate = Math.min(8, Math.max(0.25, this.speed));
      this.ready = key;
      this.emit('loaded', { block: b, manifest: p.manifest });
    } catch (e) {
      if (keyOf(this.cur) !== key) return;
      p.clock = null;
      p.unload({ ...this.offAir, bug: 'STAND BY', message: 'STAND BY' });
    }
  }

  // Hold the audio to the channel clock.
  sync(b, t) {
    const a = this.player.audio;
    const want = (t - b.from) / 1000;
    const dur = this.player.duration;
    if (!this.sound || !dur || want >= dur - 0.25 || want < 0) { if (!a.paused) a.pause(); return; }
    if (a.readyState < 1) return;   // seeking before the metadata arrives is ignored
    if (a.paused) {
      a.currentTime = want;
      a.play().catch(() => { this.sound = false; this.emit('sound', { on: false, blocked: true }); });
    } else if (Math.abs(a.currentTime - want) > RESYNC_S * Math.max(1, this.speed)) {
      a.currentTime = want;
    }
  }
}

// Shared by the channel page and the framed player.
export function tunerOptions(search = location.search) {
  const q = new URLSearchParams(search);
  return {
    at: q.has('at') ? Number(q.get('at')) : null,
    speed: q.has('speed') ? Number(q.get('speed')) : 1,
  };
}

export const clockTime = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// "HFL-NN Tonight: Week 2" already names its show; "Breaking: …" on The Wire does not.
export const onAirTitle = b => (String(b.title).toLowerCase().startsWith(String(b.showTitle).toLowerCase()) ? b.title : `${b.showTitle}: ${b.title}`);
