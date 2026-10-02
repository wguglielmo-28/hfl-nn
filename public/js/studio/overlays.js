// Broadcast overlays: network bug, lower thirds, the ticker, transitions and
// the open/close slates.
import { W, H, PAL, rect, panel, spiral, drawText, textWidth, shade } from './gfx.js';
import { wrap, fold } from './font.js';

export function drawBug(g, t, label) {
  panel(g, 6, 6, 74, 15, 'rgba(13,8,32,0.85)', PAL.lilac);
  spiral(g, 9, 9, 1);
  drawText(g, 'HFL-NN', 22, 10, { color: PAL.white });
  if (label) {
    const w = textWidth(label) + 8;
    panel(g, 6, 23, w, 11, PAL.teal);
    drawText(g, label, 10, 25, { color: PAL.ink });
  }
}

// Lower third. `since` = seconds since it appeared (slides in over 0.25 s).
export function drawLowerThird(g, { title, subtitle, accent = PAL.teal, since = 1 }) {
  const slide = Math.min(1, since / 0.25);
  const tw = Math.max(textWidth(title, 2) + 16, textWidth(subtitle || '', 1) + 16, 120);
  const x = Math.round(-tw + (tw + 12) * easeOut(slide));
  const y = 208;
  rect(g, x, y, tw, 20, PAL.deep);
  rect(g, x, y, 3, 20, accent);
  drawText(g, title, x + 9, y + 3, { color: PAL.white, scale: 2 });
  if (subtitle) {
    const sw = textWidth(subtitle) + 12;
    rect(g, x, y + 20, sw, 11, accent);
    drawText(g, subtitle, x + 6, y + 22, { color: PAL.ink });
  }
}

const easeOut = p => 1 - Math.pow(1 - p, 3);

// Bottom ticker: a label box and the crawl.
export function drawTicker(g, t, items, { label = 'HFL-NN', color = PAL.red } = {}) {
  const y = H - 16;
  rect(g, 0, y, W, 16, PAL.night);
  rect(g, 0, y, W, 1, PAL.lilac);
  const text = (items && items.length ? items : ['STAY HYPNOTICAL']).map(fold).join('   •   ') + '   •   ';
  const tw = textWidth(text);
  const lw = textWidth(label) + 12;
  const off = Math.floor((t * 38) % (tw + 6));
  g.save();
  g.beginPath(); g.rect(lw, y, W - lw, 16); g.clip();
  for (let x = lw + 4 - off; x < W; x += tw + 6) drawText(g, text, x, y + 5, { color: PAL.white });
  g.restore();
  rect(g, 0, y + 1, lw, 15, color);
  drawText(g, label, 6, y + 5, { color: PAL.white });
}

// Segment transition: stripes sweep across with the segment title.
export function drawTransition(g, p, title) {
  if (p <= 0 || p >= 1) return;
  const sweep = p < 0.5 ? p * 2 : 1;
  const out = p > 0.75 ? (p - 0.75) / 0.25 : 0;
  const x0 = Math.round(-W + sweep * W * 1.4 + out * W * 1.4);
  for (let i = 0; i < 6; i++) {
    const c = i % 2 ? PAL.teal : PAL.violet;
    g.fillStyle = c;
    g.beginPath();
    g.moveTo(x0 + i * 40, 0); g.lineTo(x0 + i * 40 + W * 0.6, 0);
    g.lineTo(x0 + i * 40 + W * 0.6 - 120, H); g.lineTo(x0 + i * 40 - 120, H);
    g.fill();
  }
  if (p > 0.22 && p < 0.82) {
    rect(g, 0, H / 2 - 20, W, 40, PAL.deep);
    rect(g, 0, H / 2 - 20, W, 2, PAL.gold); rect(g, 0, H / 2 + 18, W, 2, PAL.gold);
    const lines = wrap(title, W - 40, 3, 1);
    drawText(g, lines[0] || '', W / 2, H / 2 - 10, { color: PAL.white, scale: 3, align: 'center', shadow: PAL.ink });
  }
}

// The cold open title card while the theme plays.
export function drawOpen(g, t, title, breaking = false) {
  if (breaking) {
    const flash = Math.floor(t * 4) % 2;
    rect(g, 0, 0, W, H, flash ? PAL.red : PAL.redDark);
    rect(g, 0, H / 2 - 30, W, 60, PAL.ink);
    drawText(g, 'BREAKING NEWS', W / 2, H / 2 - 20, { color: PAL.white, scale: 4, align: 'center' });
    drawText(g, title.replace(/^BREAKING:\s*/i, ''), W / 2, H / 2 + 14, { color: PAL.gold, align: 'center' });
    return;
  }
  const p = Math.min(1, t / 1.2);
  rect(g, 0, 0, W, H, PAL.night);
  for (let i = 0; i < 14; i++) {
    const r = 10 + i * 14 + ((t * 40) % 14);
    g.strokeStyle = i % 2 ? PAL.violet : PAL.deep;
    g.lineWidth = 6;
    g.beginPath(); g.arc(W / 2, H / 2 - 10, r, 0, Math.PI * 2); g.stroke();
  }
  const s = Math.max(1, Math.round(6 * p));
  spiral(g, W / 2 - 4.5 * s, 40 + (6 - s) * 4, s);
  if (p >= 1) {
    drawText(g, 'HFL-NN', W / 2, 150, { color: PAL.white, scale: 5, align: 'center', shadow: PAL.ink });
    const lines = wrap(title, W - 40, 1, 2);
    lines.forEach((ln, i) => drawText(g, ln, W / 2, 196 + i * 10, { color: PAL.gold, align: 'center' }));
  }
}

export function drawEndSlate(g, t, { title, tagline = 'STAY HYPNOTICAL.' } = {}) {
  rect(g, 0, 0, W, H, PAL.night);
  spiral(g, W / 2 - 18, 50, 4);
  drawText(g, 'THANKS FOR WATCHING', W / 2, 110, { color: PAL.white, scale: 2, align: 'center' });
  drawText(g, tagline, W / 2, 134, { color: PAL.teal, align: 'center' });
  if (title) drawText(g, title, W / 2, 152, { color: PAL.gray4, align: 'center' });
  const blink = Math.floor(t * 2) % 2;
  if (blink) drawText(g, 'PICK ANOTHER EPISODE BELOW', W / 2, 200, { color: PAL.gold, align: 'center' });
}

export function drawBreakingBanner(g, t) {
  const flash = Math.floor(t * 3) % 2;
  rect(g, 0, 186, W, 18, flash ? PAL.red : PAL.redDark);
  rect(g, 0, 186, W, 1, PAL.white);
  drawText(g, 'BREAKING NEWS', 10, 191, { color: PAL.white });
  drawText(g, 'HFL-NN', W - 10, 191, { color: shade(PAL.white, 0.85), align: 'right' });
}
