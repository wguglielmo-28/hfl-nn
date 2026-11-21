// The Fifth Quarter's sets (config/talk.json "set"): a morning-show couch, the
// debate podiums, the podcast booth and the film room. Each set has a wide
// background, a close-up background, and a foreground drawn over the anchors
// (couch cushions, podiums, mics, a high-top table) at the anchors' seats.
import { W, H, PAL, rect, panel, dither, bands, shade, drawText } from './gfx.js';
import { brand, fitScale } from './brand.js';

export const TALK_SETS = new Set(['couch', 'podiums', 'booth', 'film']);

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
function rng(seed) { let a = seed >>> 0; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); }

const SUN = ['#2a1240', '#4a1d4f', '#7a2d4f', '#b2464a', '#e3713f', '#f4a64a'];
const WOOD = '#6b4426', WOOD_D = '#4a2e18', WOOD_L = '#8a5a34';

// ── Couch: a morning show in front of a sunrise window ───────────────────
function couchWide(g) {
  bands(g, 0, 0, W, 176, ['#1d1430', '#241a3c', '#2c2048']);
  // Big sunrise window with mullions
  panel(g, 70, 14, 340, 112, '#3a2f52', '#57487a');
  bands(g, 74, 18, 332, 104, SUN);
  rect(g, 210, 70, 60, 30, '#ffd479'); rect(g, 220, 62, 40, 8, '#ffd479'); rect(g, 230, 58, 20, 4, '#ffe9a8');
  const r = rng(5);
  let x = 74;
  while (x < 406) { const bw = 8 + Math.floor(r() * 16), bh = 14 + Math.floor(r() * 34); rect(g, x, 122 - bh, Math.min(bw, 406 - x), bh, r() > 0.5 ? '#2a1838' : '#331d44'); x += bw + 2; }
  for (const mx of [184, 296]) rect(g, mx, 18, 3, 104, '#57487a');
  rect(g, 74, 68, 332, 2, '#57487a');
  // Plants and lamps at the sides
  for (const px of [20, 438]) {
    rect(g, px + 6, 100, 10, 30, '#3d2a1c');
    for (let i = 0; i < 6; i++) rect(g, px + (i % 3) * 7, 70 + i * 5, 9, 6, i % 2 ? '#2f7a4a' : '#3f9a5c');
  }
  // Couch back
  panel(g, 30, 128, 420, 44, '#c0563f', '#8a3a2a');
  for (let i = 0; i < 4; i++) rect(g, 36 + i * 104, 132, 98, 4, shade('#c0563f', 1.12));
  dither(g, 0, 172, W, H - 172, '#3a2a40', '#2e2236', 2);
}
function couchClose(g) {
  bands(g, 0, 0, W, H, SUN);
  rect(g, 300, 120, 120, 60, '#ffd479'); rect(g, 320, 104, 80, 16, '#ffd479');
  for (const mx of [150, 380]) rect(g, mx, 0, 6, H, '#57487a');
  rect(g, 0, 150, W, 6, '#57487a');
  panel(g, 0, 170, W, 100, '#c0563f', '#8a3a2a');
}
function couchFront(g, seats, scale) {
  if (scale > 1) { rect(g, 0, H - 40, W, 40, '#a64a36'); rect(g, 0, H - 40, W, 4, '#d06a52'); return; }
  rect(g, 24, 164, 432, 22, '#a64a36'); rect(g, 24, 164, 432, 3, '#d06a52');
  panel(g, 14, 140, 22, 50, '#b04e3a', '#7a3426'); panel(g, 444, 140, 22, 50, '#b04e3a', '#7a3426');
  // Coffee table with mugs
  panel(g, 150, 200, 180, 12, WOOD_L, WOOD_D); rect(g, 160, 212, 6, 30, WOOD_D); rect(g, 314, 212, 6, 30, WOOD_D);
  for (const mx of [190, 236, 280]) { rect(g, mx, 192, 9, 9, '#f4f1ea'); rect(g, mx + 9, 194, 2, 4, '#f4f1ea'); }
}

// ── Podiums: two-chair debate under spotlights ───────────────────────────
function podiumsWide(g) {
  rect(g, 0, 0, W / 2, H, '#3a0d18'); rect(g, W / 2, 0, W / 2, H, '#0d1a3a');
  for (let i = 0; i < 12; i++) { rect(g, i * 20, 0, 2, 170, '#4a1222'); rect(g, W / 2 + i * 20 + 10, 0, 2, 170, '#122550'); }
  // Spotlight cones
  g.fillStyle = 'rgba(255,240,200,0.08)';
  for (const sx of [100, 240, 380]) { g.beginPath(); g.moveTo(sx - 6, 0); g.lineTo(sx + 6, 0); g.lineTo(sx + 50, 190); g.lineTo(sx - 50, 190); g.fill(); }
  // Big VS screen
  panel(g, 190, 18, 100, 60, '#120c22', PAL.gold);
  drawText(g, 'VS', 240, 30, { color: PAL.gold, scale: 4, align: 'center', shadow: PAL.ink });
  dither(g, 0, 176, W, H - 176, '#1a1020', '#120a18', 2);
}
function podiumsClose(g) {
  rect(g, 0, 0, W / 2, H, '#3a0d18'); rect(g, W / 2, 0, W / 2, H, '#0d1a3a');
  for (let i = 0; i < 24; i++) rect(g, i * 20 + (i >= 12 ? 10 : 0), 0, 2, H, i >= 12 ? '#122550' : '#4a1222');
  drawText(g, 'VS', 400, 60, { color: shade(PAL.gold, 0.7), scale: 6, align: 'center' });
}
function podiumsFront(g, seats, scale) {
  if (scale > 1) {
    panel(g, 0, H - 56, W, 56, '#1a1a26', PAL.gold); rect(g, 0, H - 52, W, 4, brand.accent || PAL.teal);
    return;
  }
  const mid = seats.length === 3 ? seats[1] : null;
  for (const s of seats) {
    const w = s === mid ? 50 : 64, h = s === mid ? 96 : 104, x = s.x - w / 2, y = H - h;
    panel(g, x, y, w, h, '#1a1a26', PAL.gold);
    rect(g, x + 2, y + 6, w - 4, 4, s.x < W / 2 ? '#c8102e' : '#1f6fff');
    if (s === mid) rect(g, x + w / 2 - 8, y + 20, 16, 16, PAL.gold);
    rect(g, s.x - 1, y - 14, 2, 14, '#333344'); rect(g, s.x - 2, y - 17, 4, 4, '#111118');
  }
}

// ── Booth: the podcast room ──────────────────────────────────────────────
function boothWide(g) {
  rect(g, 0, 0, W, 176, '#1b1b22');
  // Acoustic foam
  for (let y = 10; y < 150; y += 12) for (let x = (y / 12) % 2 ? 0 : 6; x < W; x += 12) { rect(g, x, y, 10, 10, '#26262f'); rect(g, x + 2, y + 2, 4, 4, '#2f2f3a'); }
  // Neon sign
  panel(g, 150, 22, 180, 44, '#0f0f14', '#2a2a34');
  const sign = brand.name;
  drawText(g, sign, 240, 32, { color: brand.accent || '#ff8a1f', scale: fitScale(sign, 170, 3), align: 'center', shadow: '#5a2a08' });
  drawText(g, 'ON AIR', 240, 54, { color: '#ff2e4d', align: 'center' });
  // Shelves with records
  for (const sx of [24, 386]) {
    rect(g, sx, 70, 70, 3, WOOD_L); rect(g, sx, 104, 70, 3, WOOD_L);
    const r = rng(sx);
    for (let i = 0; i < 9; i++) { rect(g, sx + 4 + i * 7, 52 + (i % 2) * 2, 5, 18 - (i % 2) * 2, ['#c8102e', '#1f6fff', '#ffc93c', '#2de2c8'][Math.floor(r() * 4)]); rect(g, sx + 4 + i * 7, 86, 5, 18, ['#ff8a1f', '#6a4fc4', '#f4f1ea'][Math.floor(r() * 3)]); }
  }
  dither(g, 0, 176, W, H - 176, '#20181a', '#181214', 2);
}
function boothClose(g) {
  rect(g, 0, 0, W, H, '#1b1b22');
  for (let y = 0; y < H; y += 16) for (let x = (y / 16) % 2 ? 0 : 8; x < W; x += 16) { rect(g, x, y, 14, 14, '#24242d'); rect(g, x + 3, y + 3, 6, 6, '#2d2d38'); }
  drawText(g, 'ON AIR', 400, 40, { color: '#ff2e4d', scale: 3, align: 'center' });
}
function boothFront(g, seats, scale) {
  if (scale > 1) {
    rect(g, 0, H - 34, W, 34, WOOD); rect(g, 0, H - 34, W, 3, WOOD_L);
    // A big mic on a boom in front of the speaker
    rect(g, 196, 150, 4, 90, '#333340'); panel(g, 186, 118, 24, 40, '#22222c', '#55556a');
    for (let y = 122; y < 154; y += 4) rect(g, 190, y, 16, 1, '#3a3a48');
    return;
  }
  rect(g, 0, 168, W, 8, WOOD_L); rect(g, 0, 176, W, H - 176, WOOD); rect(g, 0, 176, W, 2, WOOD_D);
  for (const s of seats) {
    const mx = s.x + 10;
    rect(g, mx + 4, 150, 2, 22, '#333340');
    panel(g, mx, 132, 10, 20, '#22222c', '#55556a');
    for (let y = 135; y < 150; y += 3) rect(g, mx + 2, y, 6, 1, '#3a3a48');
    rect(g, s.x - 16, 178, 18, 10, '#2a2a34'); rect(g, s.x - 14, 180, 14, 1, PAL.teal);   // laptop
  }
}

// ── Film room: the big screen of X's and O's ─────────────────────────────
function filmWide(g) {
  rect(g, 0, 0, W, H, '#07060c');
  panel(g, 60, 10, 360, 140, '#111118', '#333344');
  field(g, 66, 16, 348, 128);
  dither(g, 0, 176, W, H - 176, '#0e0c14', '#0a0910', 2);
}
function filmClose(g) {
  rect(g, 0, 0, W, H, '#07060c');
  panel(g, 170, 14, 300, 180, '#111118', '#333344');
  field(g, 176, 20, 288, 168);
}
function field(g, x, y, w, h) {
  rect(g, x, y, w, h, '#1d5a2c');
  for (let i = 0; i < w; i += 24) rect(g, x + i, y, 1, h, '#2f7a40');
  rect(g, x + Math.floor(w / 2), y, 2, h, '#e8e8e8');
}
function filmPlay(g, t, x, y, w, h) {
  // X's and O's with a route that draws itself, looping
  const losX = x + Math.floor(w / 2);
  for (let i = 0; i < 5; i++) { const oy = y + 20 + i * Math.floor((h - 40) / 4); drawText(g, 'O', losX - 12, oy, { color: '#f4f1ea' }); drawText(g, 'X', losX + 8, oy + 4, { color: '#ffc93c' }); }
  const p = (t % 4) / 3;
  const pts = [[losX - 10, y + h / 2], [losX + 30, y + h / 2 - 20], [losX + 90, y + 24], [x + w - 20, y + 20]];
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.min(1, Math.max(0, p * (pts.length - 1) - (i - 1)));
    if (!seg) break;
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2);
    for (let k = 0; k <= n * seg; k++) rect(g, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 2, 2, '#ff8a1f');
  }
  if (p >= 1) rect(g, x + w - 22, y + 18, 6, 6, '#ff8a1f');
}
function filmFront(g, seats, scale) {
  if (scale > 1) { rect(g, 0, H - 30, W, 30, '#2a2a34'); rect(g, 0, H - 30, W, 3, '#4a4766'); return; }
  for (const s of seats) { panel(g, s.x - 24, 170, 48, 8, '#2a2a34', '#4a4766'); rect(g, s.x - 2, 178, 4, H - 178, '#2a2a34'); }
}

const SETS = {
  couch: { wide: couchWide, close: couchClose, front: couchFront },
  podiums: { wide: podiumsWide, close: podiumsClose, front: podiumsFront },
  booth: { wide: boothWide, close: boothClose, front: boothFront },
  film: { wide: filmWide, close: filmClose, front: filmFront },
};

export function drawTalkWide(g, t, set) {
  g.drawImage(layer(`${set}:wide:${brand.key}`, SETS[set].wide), 0, 0);
  if (set === 'film') filmPlay(g, t, 66, 16, 348, 128);
  if (set === 'booth' && Math.floor(t * 1.5) % 2) rect(g, 214, 54, 52, 9, 'rgba(255,46,77,0.25)');
}
export function drawTalkClose(g, t, set) {
  g.drawImage(layer(`${set}:close:${brand.key}`, SETS[set].close), 0, 0);
  if (set === 'film') filmPlay(g, t, 176, 20, 288, 168);
}
// `seats`: [{ id, x }] in seat order; scale 1 for the wide shot, 2+ for close-ups.
export function drawTalkFront(g, set, seats, scale = 1) { SETS[set].front(g, seats, scale); }
