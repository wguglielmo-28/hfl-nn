// The director and renderer. The director reads an episode manifest (script
// timeline + mouth envelope + cards) and decides, for any time t, which shot
// is on air, who is talking, which card is up and what every anchor is doing.
// The renderer draws that frame. Shots are decided per line, so the camera
// cuts on line changes like a real control room.
import { W, H, PAL, rect } from './gfx.js';
import { drawAnchor, ANCHOR_W, DESK_Y } from './anchors.js';
import { drawStudio, drawDesk, drawClose, drawFullBg, drawBreakingBg, drawCorkboard, drawChair, DESK_TOP } from './sets.js';
import { renderCard, FULL_TYPES } from './cards.js';
import { drawBug, drawLowerThird, drawTicker, drawTransition, drawOpen, drawEndSlate, drawBreakingBanner } from './overlays.js';

const KIND_ORDER = ['analyst', 'insider', 'host', 'analyst2', 'wildcard'];
const OTS = { x: 150, y: 16, w: 318, h: 176 };
const FULL = { x: 16, y: 38, w: 448, h: 166 };   // below the network bug, above the lower third
const TRANSITION = 1.1;

export class Director {
  constructor(m) {
    this.m = m;
    this.lines = m.lines || [];
    this.segs = m.segments || [];
    this.anchors = m.lineup || [];
    this.byId = Object.fromEntries(this.anchors.map(a => [a.id, a]));
    this.mouth = m.mouth?.data || '';
    this.fps = m.mouth?.fps || 30;
    // Desk seating: host in the middle, analysts either side, Gus on the end.
    const analysts = this.anchors.filter(a => a.kind === 'analyst');
    const slotOf = a => KIND_ORDER.indexOf(a.kind === 'analyst' ? (analysts.indexOf(a) === 0 ? 'analyst' : 'analyst2') : a.kind);
    this.seating = this.anchors.slice().sort((a, b) => slotOf(a) - slotOf(b));
    this.plan = this.planLines();
  }

  segOf(id) { return this.segs.find(s => s.id === id) || {}; }

  planLines() {
    const plan = [];
    const seen = new Set();
    let card = null, cardSince = 0, cueLine = -1, segId = null, segLine = 0;
    this.lines.forEach((ln, i) => {
      const seg = this.segOf(ln.seg);
      if (ln.seg !== segId) { segId = ln.seg; card = null; cueLine = -1; segLine = 0; seen.clear(); }
      if (ln.card) {
        const c = (seg.cards || []).find(x => x.id === ln.card);
        if (c) { card = c; cardSince = ln.t0; cueLine = i; }
      }
      const firstInSeg = !seen.has(ln.speaker);
      seen.add(ln.speaker);
      plan.push({ card, cardSince, shot: this.chooseShot(ln, seg, card, i - cueLine, segLine), nameStrap: firstInSeg, segLine });
      segLine++;
    });
    return plan;
  }

  chooseShot(ln, seg, card, sinceCue, segLine) {
    const speaker = this.byId[ln.speaker] || {};
    if (seg.set === 'corkboard') return speaker.kind === 'wildcard' ? 'cork' : 'single';
    if (seg.set === 'breaking') return card ? 'breaking_graphic' : 'breaking';
    const want = ln.shot && ln.shot !== 'auto' ? ln.shot : null;
    if (want === 'graphic' || want === 'full_graphic') return card ? (FULL_TYPES.has(card.type) ? 'full_graphic' : want) : 'single';
    if (want) return want;
    const reacting = ['shocked', 'laughing', 'angry'].includes(ln.emotion);
    if (card && FULL_TYPES.has(card.type) && !reacting) return 'full_graphic';
    if (card && sinceCue <= 1) return 'graphic';
    if (segLine === 0) return 'wide';
    if (seg.kind === 'debate') return segLine % 3 === 2 ? 'two_shot' : 'single';
    return speaker.kind === 'host' && segLine % 3 === 0 ? 'wide' : 'single';
  }

  lineIndexAt(t) {
    let lo = 0, hi = this.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid].t0 <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  segmentAt(t) {
    let s = null;
    for (const seg of this.segs) if (seg.t0 <= t) s = seg;
    return s;
  }

  mouthAt(t) {
    const c = this.mouth.charCodeAt(Math.floor(t * this.fps));
    return c >= 48 && c <= 51 ? c - 48 : 0;
  }

  sceneAt(t) {
    const duration = this.m.duration || 0;
    const first = this.lines[0];
    if (!first || t < first.t0 - 0.25) return { kind: 'open', t };
    const last = this.lines[this.lines.length - 1];
    if (t > last.t1 + 1.5 || (duration && t >= duration - 0.05)) return { kind: 'end', t };
    const i = this.lineIndexAt(t);
    const ln = this.lines[Math.max(0, i)];
    const plan = this.plan[Math.max(0, i)];
    const seg = this.segmentAt(t) || this.segOf(ln.seg);
    const talking = t >= ln.t0 && t <= ln.t1;
    const segStart = seg.t0 ?? 0;
    const transition = seg !== this.segs[0] && t - segStart < TRANSITION ? (t - segStart) / TRANSITION : 0;
    return { kind: 'show', t, ln, plan, seg, talking, transition, lineIdx: i };
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────

function anchorState(d, a, scene, seatX) {
  const t = scene.t;
  const seed = [...a.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 17;
  const blink = (t + seed * 1.7) % (3.1 + (seed % 5) * 0.37) < 0.12;
  const bob = (t + seed * 0.4) % 2.6 < 1.3 ? 0 : 1;
  const ln = scene.ln;
  const speaking = ln && ln.speaker === a.id;
  const st = { blink, bob, mouth: 0, emotion: 'neutral', gesture: 'none', gestureT: 1, look: 0 };
  if (speaking) {
    st.emotion = ln.emotion || 'neutral';
    if (scene.talking) st.mouth = d.mouthAt(t);
    const since = t - ln.t0;
    const hold = ln.gesture === 'facepalm' || ln.gesture === 'arms_crossed' ? 2.2 : 1.3;
    if (ln.gesture && ln.gesture !== 'none' && since >= 0 && since < hold) {
      st.gesture = ln.gesture;
      st.gestureT = Math.min(1, since / (ln.gesture === 'desk_slam' ? 0.9 : hold));
    }
  } else if (ln) {
    const sp = seatX[ln.speaker], me = seatX[a.id];
    if (sp != null && me != null) st.look = sp < me ? -1 : sp > me ? 1 : 0;
    if (ln.emotion === 'laughing') st.emotion = 'happy';
  }
  return st;
}

function drawCardIn(g, card, since, box) {
  if (!card) return;
  const img = renderCard(card, box.w, box.h);
  const p = Math.min(1, Math.max(0, since / 0.3));
  const w = Math.max(1, Math.round(box.w * p));
  g.drawImage(img, 0, 0, w, box.h, box.x, box.y, w, box.h);
  if (p < 1) rect(g, box.x + w - 2, box.y, 2, box.h, PAL.teal);
}

export function renderFrame(g, d, t, { ticker = [], bugLabel = '', title = '' } = {}) {
  const scene = d.sceneAt(t);
  g.imageSmoothingEnabled = false;
  if (scene.kind === 'open') {
    drawOpen(g, t, title, d.m.type === 'breaking');
    return scene;
  }
  if (scene.kind === 'end') {
    drawEndSlate(g, t, { title });
    return scene;
  }

  const { ln, plan, seg } = scene;
  const speaker = d.byId[ln.speaker];
  // Desk-slam shake
  let shake = 0;
  if (ln.gesture === 'desk_slam') {
    const since = t - ln.t0;
    if (since > 0.3 && since < 0.45) shake = Math.round(Math.sin(since * 120) * 2);
  }
  g.save();
  g.translate(shake, Math.abs(shake) > 0 ? 1 : 0);

  const seatX = {};
  d.seating.forEach((a, i) => { seatX[a.id] = 48 + i * 96; });
  const shot = plan.shot;
  const card = plan.card;
  const cardSince = t - plan.cardSince;

  switch (shot) {
    case 'wide': {
      drawStudio(g, t, { segmentTitle: seg.title || '' });
      for (const a of d.seating) {
        if (seg.set === 'corkboard' && a.kind === 'wildcard') { drawChair(g, seatX[a.id] - ANCHOR_W / 2, DESK_TOP - DESK_Y); continue; }
        drawAnchor(g, a.look, seatX[a.id] - ANCHOR_W / 2, DESK_TOP - DESK_Y, 1, anchorState(d, a, scene, seatX));
      }
      drawDesk(g, DESK_TOP);
      break;
    }
    case 'two_shot': {
      drawClose(g, t);
      const segLines = d.lines.filter(x => x.seg === ln.seg);
      const partnerId = [...segLines].reverse().find(x => x.t0 < ln.t0 && x.speaker !== ln.speaker)?.speaker
        || segLines.find(x => x.speaker !== ln.speaker)?.speaker;
      const pair = [speaker, d.byId[partnerId]].filter(Boolean);
      const sx = { [pair[0]?.id]: 100, [pair[1]?.id]: 330 };
      pair.forEach(a => drawAnchor(g, a.look, sx[a.id] - ANCHOR_W, 200 - DESK_Y * 2, 2, anchorState(d, a, scene, sx)));
      drawDesk(g, 200, { scale: 2, logo: false });
      break;
    }
    case 'graphic': case 'breaking_graphic': case 'breaking': {
      if (shot === 'graphic') drawClose(g, t); else drawBreakingBg(g, t);
      if (speaker) drawAnchor(g, speaker.look, 18, 200 - DESK_Y * 2, 2, anchorState(d, speaker, scene, { [speaker.id]: 0 }));
      drawDesk(g, 200, { scale: 2, logo: false });
      if (card) drawCardIn(g, card, cardSince, OTS);
      if (shot !== 'graphic') drawBreakingBanner(g, t);
      break;
    }
    case 'full_graphic': {
      drawFullBg(g);
      drawCardIn(g, card, cardSince, FULL);
      break;
    }
    case 'cork': {
      drawCorkboard(g, t, card || (seg.cards || [])[0]);
      if (speaker) drawAnchor(g, speaker.look, 24, 214 - DESK_Y * 2, 2, anchorState(d, speaker, scene, { [speaker.id]: 0 }));
      rect(g, 0, 214, 150, 6, '#4a3020'); rect(g, 0, 220, 150, 50, '#2e1d12');
      break;
    }
    case 'single':
    default: {
      drawClose(g, t);
      if (speaker) drawAnchor(g, speaker.look, 40, 214 - DESK_Y * 3, 3, anchorState(d, speaker, scene, { [speaker.id]: 0 }));
      drawDesk(g, 214, { scale: 2, logo: false });
    }
  }
  g.restore();

  // Overlays
  drawBug(g, t, bugLabel);
  const strapSince = t - ln.t0;
  if (speaker && plan.nameStrap && strapSince >= 0 && strapSince < 4) {
    drawLowerThird(g, { title: speaker.name, subtitle: speaker.role, since: strapSince });
  } else if (seg.lowerThird && shot !== 'full_graphic') {
    drawLowerThird(g, { title: seg.lowerThird, subtitle: speaker ? speaker.name : '', accent: PAL.gold, since: 1 });
  } else if (speaker && shot === 'full_graphic') {
    drawLowerThird(g, { title: speaker.short || speaker.name, subtitle: '', accent: PAL.gold, since: 1 });
  }
  drawTicker(g, t, ticker);
  if (scene.transition) drawTransition(g, scene.transition, seg.title || '');
  return scene;
}

// Off-air: empty desk, dim lights, ticker still running.
export function renderOffAir(g, t, { ticker = [], message = 'OFF AIR', lineup = [] } = {}) {
  g.imageSmoothingEnabled = false;
  drawStudio(g, t, { segmentTitle: message, dim: false });
  const n = Math.max(lineup.length, 5);
  for (let i = 0; i < n; i++) drawChair(g, 48 + i * 96 - ANCHOR_W / 2, DESK_TOP - DESK_Y);
  drawDesk(g, DESK_TOP);
  g.fillStyle = 'rgba(5,3,15,0.45)';
  g.fillRect(0, 0, W, H - 16);
  drawBug(g, t, 'OFF AIR');
  drawTicker(g, t, ticker);
}
