// The episode player: one <audio> element is the clock; every animation frame
// reads audio.currentTime and asks the director for that instant. Seeking,
// pausing and buffering can never desync lips from voices.
import { W, H } from './gfx.js';
import { Director, renderFrame, renderOffAir } from './show.js';

export class Player extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.g = canvas.getContext('2d', { alpha: false });
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.director = null;
    this.manifest = null;
    this.offAir = { ticker: [], message: 'OFF AIR' };
    this.manualTime = null;     // set by renderAt() for screenshots
    this.lastLine = -1;
    this.lastSeg = null;
    this.audio.addEventListener('ended', () => this.emit('ended'));
    this.audio.addEventListener('play', () => this.emit('state'));
    this.audio.addEventListener('pause', () => this.emit('state'));
    this.audio.addEventListener('error', () => this.emit('error', { message: 'Could not load the episode audio.' }));
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async load(manifestUrl, audioBase) {
    const res = await fetch(manifestUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Episode not available (${res.status})`);
    const m = await res.json();
    this.manifest = m;
    this.director = new Director(m);
    this.audio.src = `${audioBase}/${m.audio}`;
    this.audio.load();
    this.lastLine = -1;
    this.lastSeg = null;
    this.emit('loaded', { manifest: m });
    return m;
  }

  unload(offAir = {}) {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.manifest = null;
    this.director = null;
    this.offAir = { ...this.offAir, ...offAir };
  }

  get time() { return this.manualTime ?? this.audio.currentTime ?? 0; }
  get duration() { return this.manifest?.duration || this.audio.duration || 0; }
  get playing() { return !this.audio.paused && !this.audio.ended; }

  async play() {
    if (!this.manifest) return;
    this.manualTime = null;
    try { await this.audio.play(); } catch (e) { this.emit('error', { message: 'Press play to start (the browser blocked autoplay).' }); }
  }
  pause() { this.audio.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }
  seek(t) { this.manualTime = null; this.audio.currentTime = Math.max(0, Math.min(this.duration - 0.1, t)); }
  setVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); }

  segmentIndex(t = this.time) {
    const segs = this.manifest?.segments || [];
    let idx = 0;
    segs.forEach((s, i) => { if (s.t0 <= t) idx = i; });
    return idx;
  }
  nextSegment() { const s = this.manifest?.segments || []; const i = this.segmentIndex() + 1; if (s[i]) this.seek(s[i].t0 + 0.01); }
  prevSegment() {
    const s = this.manifest?.segments || [];
    const i = this.segmentIndex();
    const target = this.time - (s[i]?.t0 || 0) > 3 ? i : Math.max(0, i - 1);
    if (s[target]) this.seek(s[target].t0 + 0.01);
  }

  // Draw a specific instant without audio (used by tools/snap.js).
  renderAt(t) { this.manualTime = t; this.draw(); }

  draw() {
    const t = this.time;
    if (!this.director) {
      renderOffAir(this.g, performance.now() / 1000, { ...this.offAir, lineup: this.offAir.lineup || [] });
      return;
    }
    const m = this.manifest;
    const scene = renderFrame(this.g, this.director, t, { ticker: m.ticker, bugLabel: m.bugLabel || '', title: m.title });
    if (scene.kind === 'show') {
      if (scene.lineIdx !== this.lastLine) { this.lastLine = scene.lineIdx; this.emit('line', { line: scene.ln, talking: scene.talking }); }
      if (scene.seg?.id !== this.lastSeg) { this.lastSeg = scene.seg?.id; this.emit('segment', { segment: scene.seg }); }
    } else if (this.lastLine !== -1) {
      this.lastLine = -1;
      this.emit('line', { line: null });
    }
  }

  loop() {
    if (this.manualTime == null) this.draw();
    requestAnimationFrame(this.loop);
  }
}
