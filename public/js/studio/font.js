// HFL-NN's 5×7 bitmap font. Broadcast graphics are all caps, so lowercase is
// drawn as uppercase. Glyphs are cached per color and scale as small atlases,
// so a frame full of text is a few hundred drawImage calls, not thousands of
// fillRects.

const ROWS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....', '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '"': '.#.#.|.#.#.|.....|.....|.....|.....|.....', '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  $: '..#..|.####|#.#..|.###.|..#.#|####.|..#..', '%': '##..#|##.#.|...#.|..#..|.#...|.#.##|#..##',
  '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#', "'": '..#..|..#..|.#...|.....|.....|.....|.....',
  '(': '...#.|..#..|.#...|.#...|.#...|..#..|...#.', ')': '.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '*': '.....|..#..|#.#.#|.###.|#.#.#|..#..|.....', '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  ',': '.....|.....|.....|.....|.##..|..#..|.#...', '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..', '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....', ';': '.....|.##..|.##..|.....|.##..|..#..|.#...',
  '<': '...#.|..#..|.#...|#....|.#...|..#..|...#.', '=': '.....|.....|#####|.....|#####|.....|.....',
  '>': '.#...|..#..|...#.|....#|...#.|..#..|.#...', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  '@': '.###.|#...#|#.###|#.#.#|#.###|#....|.####', '[': '.###.|.#...|.#...|.#...|.#...|.#...|.###.',
  ']': '.###.|...#.|...#.|...#.|...#.|...#.|.###.', _: '.....|.....|.....|.....|.....|.....|#####',
  '•': '.....|.....|.###.|.###.|.###.|.....|.....', '▲': '.....|.....|..#..|.###.|#####|.....|.....',
  '▼': '.....|.....|#####|.###.|..#..|.....|.....', '→': '.....|..#..|...#.|#####|...#.|..#..|.....',
  '←': '.....|..#..|.#...|#####|.#...|..#..|.....', '★': '..#..|..#..|#####|.###.|.#.#.|#...#|.....',
};

export const GLYPH_W = 5, GLYPH_H = 7, ADVANCE = 6;
const CHARS = Object.keys(ROWS);
const INDEX = Object.fromEntries(CHARS.map((c, i) => [c, i]));
const atlases = new Map();

function atlas(color, scale) {
  const key = `${color}|${scale}`;
  let a = atlases.get(key);
  if (a) return a;
  a = document.createElement('canvas');
  a.width = CHARS.length * ADVANCE * scale;
  a.height = GLYPH_H * scale;
  const g = a.getContext('2d');
  g.fillStyle = color;
  CHARS.forEach((ch, i) => {
    ROWS[ch].split('|').forEach((row, y) => {
      for (let x = 0; x < GLYPH_W; x++) if (row[x] === '#') g.fillRect((i * ADVANCE + x) * scale, y * scale, scale, scale);
    });
  });
  atlases.set(key, a);
  return a;
}

// Normalize to what the font can draw.
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .toUpperCase()
    .replace(/[^\x20-\x5F•▲▼→←★]/g, '?');
}

export function textWidth(s, scale = 1) {
  const n = fold(s).length;
  return n ? (n * ADVANCE - 1) * scale : 0;
}

// Draw text at integer pixel coordinates. opts: { color, scale, align, shadow }
export function drawText(ctx, s, x, y, { color = '#ffffff', scale = 1, align = 'left', shadow = null } = {}) {
  const str = fold(s);
  let px = Math.round(align === 'center' ? x - textWidth(str, scale) / 2 : align === 'right' ? x - textWidth(str, scale) : x);
  const py = Math.round(y);
  if (shadow) drawText(ctx, str, px + scale, py + scale, { color: shadow, scale });
  const a = atlas(color, scale);
  const w = ADVANCE * scale, h = GLYPH_H * scale;
  for (const ch of str) {
    const i = INDEX[ch] ?? INDEX['?'];
    if (ch !== ' ') ctx.drawImage(a, i * w, 0, w, h, px, py, w, h);
    px += w;
  }
  return px;
}

// Greedy word wrap to a pixel width; returns lines (folded).
export function wrap(s, maxWidth, scale = 1, maxLines = Infinity) {
  const words = fold(s).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, scale) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && textWidth(last + '...', scale) > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last + '...';
    return kept;
  }
  return lines;
}

// Fit text into a width by trimming with an ellipsis.
export function clip(s, maxWidth, scale = 1) {
  let t = fold(s);
  if (textWidth(t, scale) <= maxWidth) return t;
  while (t && textWidth(t + '.', scale) > maxWidth) t = t.slice(0, -1);
  return t + '.';
}
