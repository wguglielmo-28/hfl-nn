// The HFL-NN sets: the main studio (wide and close), Gus's basement cork
// board, the breaking-news set and the off-air screen. Static parts are
// rendered once into offscreen canvases; animated bits are drawn per frame.
import { W, H, PAL, rect, panel, dither, bands, spiral, shade, badge, drawText, textWidth } from './gfx.js';
import { wrap } from './font.js';

export const DESK_TOP = 168;           // desk top line in the wide shot
const cache = {};
function layer(key, draw) {
  if (!cache[key]) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    draw(c.getContext('2d'));
    cache[key] = c;
  }
  return cache[key];
}

// Deterministic pseudo-random for set dressing.
function rng(seed) { let a = seed >>> 0; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── Main studio, wide ─────────────────────────────────────────────────────
function studioStatic(g) {
  bands(g, 0, 0, W, DESK_TOP + 8, [PAL.night, PAL.deep, PAL.deep, PAL.purple, PAL.purple, PAL.violet]);
  // Light panels on the back wall
  for (let x = 6; x < W; x += 58) { dither(g, x, 18, 4, 150, PAL.purple, PAL.lilac); rect(g, x + 1, 18, 2, 150, shade(PAL.lilac, 0.8)); }
  // Ceiling truss and lamps
  rect(g, 0, 0, W, 6, PAL.gray1); rect(g, 0, 6, W, 1, PAL.gray3);
  for (let x = 20; x < W; x += 40) { rect(g, x, 3, 8, 6, PAL.gray2); rect(g, x + 2, 9, 4, 2, PAL.gold); }
  // City window (left)
  const wx = 14, wy = 28, ww = 140, wh = 104;
  panel(g, wx - 3, wy - 3, ww + 6, wh + 6, PAL.gray2, PAL.gray3);
  bands(g, wx, wy, ww, wh, ['#0b1030', '#101640', '#18205a', '#22296b']);
  const r = rng(7);
  for (let i = 0; i < 40; i++) rect(g, wx + Math.floor(r() * ww), wy + Math.floor(r() * 40), 1, 1, '#c8d0ff');
  let bx = wx;
  while (bx < wx + ww) {
    const bw = 10 + Math.floor(r() * 14), bh = 30 + Math.floor(r() * 60);
    const by = wy + wh - bh;
    rect(g, bx, by, Math.min(bw, wx + ww - bx), bh, r() > 0.5 ? '#1a1838' : '#221f48');
    bx += bw + 1;
  }
  rect(g, wx + ww / 2 - 1, wy, 2, wh, PAL.gray2); rect(g, wx, wy + wh / 2 - 1, ww, 2, PAL.gray2);
  // Center logo screen bezel
  panel(g, 168, 22, 144, 86, PAL.gray1, PAL.gray3);
  // Right video wall bezel
  panel(g, 328, 24, 140, 112, PAL.gray1, PAL.gray3);
  // Floor
  dither(g, 0, DESK_TOP + 8, W, H - DESK_TOP - 8, PAL.night, PAL.deep, 2);
}

export function drawDesk(g, top = DESK_TOP, { scale = 1, logo = true } = {}) {
  const fh = H - top;
  rect(g, 0, top, W, 6 * scale, '#c9c3e6');
  rect(g, 0, top + 2 * scale, W, 1, '#ffffff');
  rect(g, 0, top + 6 * scale, W, 2 * scale, PAL.gray3);
  rect(g, 0, top + 8 * scale, W, fh, PAL.gray1);
  rect(g, 0, top + 12 * scale, W, 2 * scale, PAL.teal);
  rect(g, 0, top + 14 * scale, W, 1, PAL.tealDark);
  for (let x = 40; x < W; x += 80) rect(g, x, top + 18 * scale, 2, fh, PAL.gray2);
  if (logo && scale === 1) {
    rect(g, W / 2 - 60, top + 18, 120, 26, PAL.deep);
    spiral(g, W / 2 - 54, top + 22, 2);
    drawText(g, 'HFL-NN', W / 2 + 10, top + 24, { color: PAL.white, scale: 2, align: 'center' });
    drawText(g, 'NEWS NETWORK', W / 2 + 10, top + 40 - 1, { color: PAL.teal, align: 'center' });
  }
}

export function drawStudio(g, t, { segmentTitle = '', dim = false } = {}) {
  g.drawImage(layer('studio', studioStatic), 0, 0);
  // Twinkling city lights
  const r = rng(11);
  for (let i = 0; i < 70; i++) {
    const x = 16 + Math.floor(r() * 136), y = 60 + Math.floor(r() * 70), phase = r() * 6;
    if (Math.sin(t * 0.7 + phase * 3) > -0.2 && y > 80) rect(g, x, y, 1, 1, r() > 0.6 ? PAL.gold : '#9ad6ff');
  }
  // Logo screen: spiral that cycles colors
  rect(g, 171, 25, 138, 80, PAL.deep);
  const flip = Math.floor(t * 2) % 2;
  spiral(g, 182, 38, 4, flip ? PAL.teal : PAL.gold, flip ? PAL.gold : PAL.teal);
  drawText(g, 'HFL-NN', 268, 46, { color: PAL.white, scale: 3, align: 'center' });
  drawText(g, dim ? 'OFF AIR' : 'TONIGHT', 268, 74, { color: dim ? PAL.red : PAL.teal, scale: 1, align: 'center' });
  // Right video wall: segment title
  rect(g, 331, 27, 134, 106, '#0f0b28');
  for (let y = 27; y < 133; y += 3) rect(g, 331, y, 134, 1, '#140f33');
  spiral(g, 388, 40, 2);
  const lines = wrap(segmentTitle || 'HFL-NN', 120, 1, 4);
  lines.forEach((ln, i) => drawText(g, ln, 398, 72 + i * 10, { color: PAL.white, align: 'center' }));
  if (dim) { g.fillStyle = 'rgba(5,3,15,0.55)'; g.fillRect(0, 0, W, H); }
}

// ── Close-up background (single / two-shot / graphic) ─────────────────────
function closeStatic(g) {
  bands(g, 0, 0, W, H, [PAL.night, PAL.deep, PAL.purple, PAL.purple, PAL.violet, PAL.violet]);
  for (let x = 0; x < W; x += 96) { dither(g, x + 30, 0, 10, H, PAL.purple, PAL.lilac); rect(g, x + 33, 0, 4, H, shade(PAL.lilac, 0.85)); }
  // A big out-of-focus logo screen behind the anchor
  panel(g, 250, 30, 210, 120, PAL.gray1, PAL.gray3);
  rect(g, 254, 34, 202, 112, PAL.deep);
  spiral(g, 268, 52, 8);
  drawText(g, 'HFL-NN', 410, 70, { color: shade(PAL.white, 0.7), scale: 3, align: 'center' });
}
export function drawClose(g, t) {
  g.drawImage(layer('close', closeStatic), 0, 0);
  const flip = Math.floor(t * 1.5) % 2;
  rect(g, 268 + 8 * 4, 52 + 8 * 4, 8, 8, flip ? PAL.gold : PAL.teal);
}

// ── Full-screen graphic background ───────────────────────────────────────
function fullStatic(g) {
  bands(g, 0, 0, W, H, [PAL.night, PAL.deep, PAL.deep, PAL.purple]);
  for (let y = 0; y < H; y += 4) rect(g, 0, y, W, 1, '#140c30');
  for (let x = -H; x < W; x += 24) for (let i = 0; i < H; i += 2) rect(g, x + i, i, 1, 1, '#1f1545');
}
export function drawFullBg(g) { g.drawImage(layer('full', fullStatic), 0, 0); }

// ── Breaking news set ────────────────────────────────────────────────────
export function drawBreakingBg(g, t) {
  rect(g, 0, 0, W, H, '#1a0308');
  const off = Math.floor(t * 30) % 32;
  for (let x = -H - 32 + off; x < W; x += 32) {
    for (let y = 0; y < H; y++) rect(g, x + y, y, 12, 1, '#3d0610');
  }
  const pulse = Math.floor(t * 4) % 2;
  rect(g, 0, 0, W, 4, pulse ? PAL.red : PAL.redDark);
  rect(g, 0, H - 22, W, 2, pulse ? PAL.red : PAL.redDark);
}

// ── Conspiracy Corner: the basement cork board ───────────────────────────
function corkStatic(g) {
  rect(g, 0, 0, W, H, '#1b120c');
  // Brick-ish basement wall
  for (let y = 0; y < H; y += 8) for (let x = (y / 8) % 2 ? -10 : 0; x < W; x += 20) panel(g, x, y, 19, 7, '#2a1c13');
  // Cork board
  panel(g, 150, 10, 316, 190, '#5a3b1f', '#3c2612');
  dither(g, 156, 16, 304, 178, PAL.cork, PAL.corkDark, 1);
  const r = rng(3);
  for (let i = 0; i < 400; i++) rect(g, 156 + Math.floor(r() * 304), 16 + Math.floor(r() * 178), 1, 1, r() > 0.5 ? '#b07d4c' : '#5c3d20');
  // Hanging bulb wire
  rect(g, 80, 0, 1, 38, '#111111');
}
export function drawCorkboard(g, t, card) {
  g.drawImage(layer('cork', corkStatic), 0, 0);
  const flicker = Math.sin(t * 13) > 0.92 ? 0 : 1;
  panel(g, 76, 38, 9, 10, flicker ? '#ffe9a0' : '#8a7a40');
  if (flicker) { g.fillStyle = 'rgba(255,233,160,0.10)'; g.beginPath(); g.moveTo(80, 44); g.lineTo(10, 200); g.lineTo(150, 200); g.fill(); }
  const d = card?.data || {};
  const pins = (d.pins || []).slice(0, 3);
  const words = (d.words || []).slice(0, 3);
  const spots = [[180, 28], [330, 36], [250, 120], [390, 128], [176, 128], [300, 80]];
  const anchorsPts = [];
  pins.forEach((team, i) => {
    const [x, y] = spots[i];
    panel(g, x, y, 56, 50, '#f2eee4', '#b9b2a2');
    rect(g, x + 4, y + 4, 48, 32, '#1d1b2a');
    badge(g, x + 9, y + 12, team, { w: 38, h: 17 });
    drawText(g, team.abbr || '?', x + 28, y + 40, { color: '#333333', align: 'center' });
    rect(g, x + 26, y - 2, 4, 4, PAL.red);
    anchorsPts.push([x + 28, y]);
  });
  words.forEach((w, i) => {
    const [x, y] = spots[3 + i] || [200 + i * 60, 160];
    const tw = Math.max(40, textWidth(w) + 10);
    panel(g, x, y, tw, 16, '#fff6b0', '#d8c96a');
    drawText(g, w, x + tw / 2, y + 5, { color: '#222222', align: 'center' });
    rect(g, x + tw / 2 - 2, y - 2, 4, 4, PAL.red);
    anchorsPts.push([x + tw / 2, y]);
  });
  // Red string between every pin, in order
  for (let i = 1; i < anchorsPts.length; i++) {
    const [x0, y0] = anchorsPts[i - 1], [x1, y1] = anchorsPts[i];
    line(g, x0, y0, x1, y1, '#d01c2c');
  }
  if (d.headline) {
    const lines = wrap(d.headline, 290, 1, 2);
    panel(g, 160, 168, 296, 24, '#efe6cf', '#b9ad8a');
    lines.forEach((ln, i) => drawText(g, ln, 308, 172 + i * 9, { color: '#3a1d10', align: 'center' }));
  }
  // Gus's little table
  rect(g, 0, 214, 150, 6, '#4a3020'); rect(g, 0, 220, 150, 50, '#2e1d12');
}

// Bresenham line in solid pixels.
export function line(g, x0, y0, x1, y1, color) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  g.fillStyle = color;
  for (;;) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Empty chair, for the off-air studio.
export function drawChair(g, x, y) {
  rect(g, x + 8, y + 26, 28, 34, '#22202e'); rect(g, x + 10, y + 28, 24, 30, '#2c2a3a');
  rect(g, x + 6, y + 40, 32, 6, '#1a1824');
}
