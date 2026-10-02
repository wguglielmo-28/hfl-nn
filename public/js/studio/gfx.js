// Shared drawing helpers and the HFL-NN palette. Everything draws at the
// studio's native 480×270 resolution on integer pixels; the page scales the
// canvas up with nearest-neighbour filtering.
import { drawText, textWidth, fold } from './font.js';

export const W = 480, H = 270;

export const PAL = {
  night: '#0d0820', deep: '#160d33', purple: '#24164f', violet: '#3b2678', lilac: '#6a4fc4',
  teal: '#2de2c8', tealDark: '#13897d', gold: '#ffc93c', goldDark: '#b8860b',
  red: '#ff2e4d', redDark: '#9c0f25', white: '#f4f1ea', paper: '#efe6cf',
  ink: '#121018', gray1: '#1d1b2a', gray2: '#2e2b42', gray3: '#4a4766', gray4: '#8c89a8',
  green: '#4cd964', crimson: '#a3162f', cork: '#9a6b3f', corkDark: '#6e4a29',
};

export function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function frame(ctx, x, y, w, h, color, t = 1) {
  rect(ctx, x, y, w, t, color); rect(ctx, x, y + h - t, w, t, color);
  rect(ctx, x, y, t, h, color); rect(ctx, x + w - t, y, t, h, color);
}

// Rect with 1px chamfered corners — the default panel shape.
export function panel(ctx, x, y, w, h, fill, border = null) {
  rect(ctx, x + 1, y, w - 2, h, fill);
  rect(ctx, x, y + 1, w, h - 2, fill);
  if (border) {
    rect(ctx, x + 1, y, w - 2, 1, border); rect(ctx, x + 1, y + h - 1, w - 2, 1, border);
    rect(ctx, x, y + 1, 1, h - 2, border); rect(ctx, x + w - 1, y + 1, 1, h - 2, border);
  }
}

// Checkerboard dither between two colors — the 8-bit way to blend.
export function dither(ctx, x, y, w, h, c1, c2, step = 2) {
  rect(ctx, x, y, w, h, c1);
  ctx.fillStyle = c2;
  for (let yy = 0; yy < h; yy += step) {
    for (let xx = (yy / step) % 2 ? step : 0; xx < w; xx += step * 2) ctx.fillRect(x + xx, y + yy, step, step);
  }
}

// Vertical banded gradient (no smooth blending — pixel art style).
export function bands(ctx, x, y, w, h, colors) {
  const bh = Math.ceil(h / colors.length);
  colors.forEach((c, i) => rect(ctx, x, y + i * bh, w, Math.min(bh, h - i * bh), c));
}

export function luminance(hex) {
  const n = parseInt(String(hex || '#000').slice(1), 16) || 0;
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

export function shade(hex, f) {
  const n = parseInt(String(hex || '#000').slice(1), 16) || 0;
  const c = v => Math.max(0, Math.min(255, Math.round(v * f)));
  return '#' + [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Team badge: primary color shield with a secondary-color rim and the abbr.
export function badge(ctx, x, y, team, { w = 26, h = 13, scale = 1 } = {}) {
  const primary = team?.color || PAL.gray3;
  let secondary = team?.color2 || PAL.gray4;
  if (Math.abs(luminance(primary) - luminance(secondary)) < 30) secondary = luminance(primary) > 128 ? '#111111' : '#eeeeee';
  panel(ctx, x, y, w, h, primary, secondary);
  rect(ctx, x + 2, y + h - 3, w - 4, 1, shade(primary, 0.75));
  const text = luminance(primary) > 150 ? '#111111' : '#ffffff';
  drawText(ctx, team?.abbr || '?', x + w / 2, y + Math.floor((h - 7 * scale) / 2), { color: text, scale, align: 'center' });
}

// A "chip" label: colored pill with text.
export function chip(ctx, x, y, text, bg = PAL.gold, fg = PAL.ink, scale = 1) {
  const w = textWidth(text, scale) + 6 * scale;
  const h = 7 * scale + 4;
  panel(ctx, x, y, w, h, bg);
  drawText(ctx, text, x + 3 * scale, y + 2, { color: fg, scale });
  return w;
}

// Card header bar used by most graphics.
export function header(ctx, x, y, w, text, { bg = PAL.teal, fg = PAL.ink, right = null } = {}) {
  rect(ctx, x, y, w, 11, bg);
  rect(ctx, x, y + 11, w, 1, shade(bg, 0.6));
  drawText(ctx, text, x + 4, y + 2, { color: fg });
  if (right) drawText(ctx, right, x + w - 4, y + 2, { color: fg, align: 'right' });
}

// Little HFL-NN spiral mark ("hypnotic"), size 9 or 18.
export function spiral(ctx, x, y, s = 1, c1 = PAL.teal, c2 = PAL.gold) {
  const px = [
    '.#######.', '#.......#', '#.#####.#', '#.#...#.#', '#.#.#.#.#', '#.#.###.#', '#.#.....#', '#.#######', '#........',
  ];
  px.forEach((row, yy) => {
    for (let xx = 0; xx < row.length; xx++) if (row[xx] === '#') rect(ctx, x + xx * s, y + yy * s, s, s, (xx + yy) % 2 ? c1 : c2);
  });
}

export { drawText, textWidth, fold };
