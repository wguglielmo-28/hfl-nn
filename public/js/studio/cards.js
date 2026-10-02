// On-screen graphics. Each card type renders its data (built server-side from
// the league export) into an offscreen canvas of the requested size; the
// result is cached per card id and size, so a card costs one drawImage a frame.
import { PAL, rect, panel, header, badge, chip, drawText, textWidth, shade } from './gfx.js';
import { wrap, clip } from './font.js';

const BODY = '#0f0b28', BORDER = '#5a46a8';
const cache = new Map();

export function renderCard(card, w, h) {
  const key = `${card.id}|${w}|${h}`;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  panel(g, 0, 0, w, h, BODY, BORDER);
  (RENDER[card.type] || RENDER.fallback)(g, card.data || {}, w, h);
  cache.set(key, c);
  if (cache.size > 120) cache.delete(cache.keys().next().value);
  return c;
}

// Cards that read best full-screen; the rest sit beside an anchor.
export const FULL_TYPES = new Set(['scoreboard', 'standings', 'playoff_picture', 'leaders', 'bracket', 'power_rankings', 'matchups']);

const winnerColor = (side, winner) => (winner === side ? PAL.gold : winner === 'tie' ? PAL.white : PAL.gray4);

const RENDER = {
  headline(g, d, w, h) {
    header(g, 1, 1, w - 2, '', { bg: PAL.deep });
    chip(g, 4, 2, d.tag || 'NEWS', PAL.gold, PAL.ink);
    const scale = w > 250 ? 2 : 1;
    let lines = wrap(d.text || '', w - 16, scale, 4);
    if (scale === 2 && lines.length > 3) lines = wrap(d.text || '', w - 16, 1, 6);
    const s = lines.length > 3 && scale === 2 ? 1 : scale;
    const lh = s === 2 ? 18 : 10;
    const top = 20 + Math.max(0, (h - 40 - lines.length * lh) / 2 - 6);
    lines.forEach((ln, i) => drawText(g, ln, w / 2, top + i * lh, { color: PAL.white, scale: s, align: 'center', shadow: PAL.ink }));
    const teams = (d.teams || []).slice(0, 4);
    const bw = 30, gap = 6;
    let x = w / 2 - (teams.length * (bw + gap) - gap) / 2;
    for (const t of teams) { badge(g, x, h - 20, t, { w: bw, h: 14 }); x += bw + gap; }
  },

  scoreboard(g, d, w, h) {
    header(g, 1, 1, w - 2, d.label || 'SCORES', { right: 'FINAL' });
    const games = (d.games || []).slice(0, 16);
    const cols = games.length > 8 ? 2 : 1;
    const rows = Math.ceil(games.length / cols) || 1;
    const rh = Math.min(22, Math.floor((h - 18) / rows));
    const cw = Math.floor((w - 8) / cols);
    games.forEach((gm, i) => {
      const col = Math.floor(i / rows), row = i % rows;
      const x = 4 + col * cw, y = 16 + row * rh;
      if (row % 2) rect(g, x, y - 1, cw - 4, rh, '#151036');
      const bw = Math.min(30, Math.floor(cw / 6));
      badge(g, x + 2, y + Math.floor((rh - 13) / 2), gm.away, { w: bw, h: 13 });
      drawText(g, String(gm.away.score ?? '-'), x + bw + 18, y + Math.floor((rh - 7) / 2), { color: winnerColor('away', gm.winner), align: 'right' });
      drawText(g, '@', x + bw + 26, y + Math.floor((rh - 7) / 2), { color: PAL.gray3 });
      badge(g, x + bw + 36, y + Math.floor((rh - 13) / 2), gm.home, { w: bw, h: 13 });
      drawText(g, String(gm.home.score ?? '-'), x + bw * 2 + 52, y + Math.floor((rh - 7) / 2), { color: winnerColor('home', gm.winner), align: 'right' });
    });
  },

  game(g, d, w, h) {
    header(g, 1, 1, w - 2, d.label || 'FINAL', { right: 'FINAL' });
    const big = w > 250 ? 3 : 2;
    const side = (team, x, which) => {
      badge(g, x - 24, 20, team, { w: 48, h: 20, scale: 1 });
      drawText(g, clip(team.nick || team.name || '', w / 2 - 20), x, 44, { color: PAL.white, align: 'center' });
      drawText(g, String(team.score ?? ''), x, 56, { color: winnerColor(which, d.winner), scale: big, align: 'center', shadow: PAL.ink });
    };
    side(d.away || {}, Math.round(w * 0.25), 'away');
    side(d.home || {}, Math.round(w * 0.75), 'home');
    drawText(g, 'AT', w / 2, 60, { color: PAL.gray4, align: 'center' });
    const perfs = (d.performers || []).slice(0, 3);
    let y = 56 + big * 7 + 10;
    rect(g, 6, y - 4, w - 12, 1, BORDER);
    const split = Math.round(w * 0.4);
    for (const p of perfs) {
      if (y > h - 10) break;
      drawText(g, clip(`${p.name} ${p.team}`, split - 10), 8, y, { color: PAL.teal });
      drawText(g, clip(p.line, w - split - 8), w - 8, y, { color: PAL.white, align: 'right' });
      y += 11;
    }
  },

  leaders(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'LEADERS');
    const secs = (d.sections || []).slice(0, 4);
    const cols = 2, cw = Math.floor((w - 8) / cols), rows = Math.ceil(secs.length / cols) || 1;
    const sh = Math.floor((h - 18) / rows);
    secs.forEach((s, i) => {
      const x = 4 + (i % cols) * cw, y = 16 + Math.floor(i / cols) * sh;
      drawText(g, s.label, x + 2, y + 2, { color: PAL.teal });
      s.rows.slice(0, 3).forEach((r, j) => {
        const ry = y + 13 + j * 11;
        drawText(g, `${j + 1}`, x + 2, ry, { color: PAL.gold });
        drawText(g, clip(r.name, cw - 66), x + 10, ry, { color: PAL.white });
        drawText(g, r.team, x + cw - 36, ry, { color: PAL.gray4, align: 'right' });
        drawText(g, String(r.value), x + cw - 6, ry, { color: PAL.gold, align: 'right' });
      });
    });
  },

  standings(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'STANDINGS');
    const divs = (d.divisions || []).slice(0, 4);
    const cols = 2, cw = Math.floor((w - 8) / cols), dh = Math.floor((h - 18) / 2);
    divs.forEach((dv, i) => {
      const x = 4 + (i % cols) * cw, y = 16 + Math.floor(i / cols) * dh;
      drawText(g, dv.name, x + 2, y + 1, { color: PAL.teal });
      dv.rows.slice(0, 4).forEach((r, j) => {
        const ry = y + 11 + j * Math.min(14, Math.floor((dh - 12) / 4));
        badge(g, x + 2, ry - 3, r, { w: 28, h: 12 });
        drawText(g, r.rec || '-', x + 38, ry, { color: PAL.white });
        drawText(g, r.streak || '', x + cw - 26, ry, { color: /^W/.test(r.streak) ? PAL.green : PAL.red, align: 'right' });
        if (r.mark) drawText(g, r.mark, x + cw - 10, ry, { color: PAL.gold });
      });
    });
  },

  playoff_picture(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'PLAYOFF PICTURE');
    const confs = (d.conferences || []).slice(0, 2);
    const cw = Math.floor((w - 8) / Math.max(1, confs.length));
    confs.forEach((c, i) => {
      const x = 4 + i * cw;
      drawText(g, c.name, x + cw / 2, 17, { color: PAL.teal, align: 'center' });
      c.rows.forEach((r, j) => {
        const y = 29 + j * Math.min(19, Math.floor((h - 34) / 7));
        drawText(g, String(r.seed), x + 6, y + 3, { color: PAL.gold });
        badge(g, x + 18, y, r, { w: 30, h: 13 });
        drawText(g, r.rec || '', x + 56, y + 3, { color: PAL.white });
        if (r.mark) drawText(g, r.mark, x + cw - 12, y + 3, { color: PAL.gold });
      });
    });
  },

  trade(g, d, w, h) {
    header(g, 1, 1, w - 2, 'TRADE', { bg: PAL.gold });
    const half = Math.floor((w - 10) / 2);
    [d.a, d.b].forEach((side, i) => {
      if (!side) return;
      const x = 5 + i * (half + 1);
      rect(g, x, 16, half - 2, h - 20, '#151036');
      badge(g, x + 4, 20, side, { w: 34, h: 15 });
      drawText(g, 'RECEIVE', x + 44, 24, { color: PAL.teal });
      const list = side.gets?.length ? side.gets : [{ name: 'NO PLAYERS', pos: '', ovr: '' }];
      list.slice(0, 5).forEach((p, j) => {
        const y = 42 + j * 14;
        if (p.pos) drawText(g, p.pos, x + 4, y, { color: PAL.gold });
        drawText(g, clip(p.name, half - 48), x + 30, y, { color: PAL.white });
        if (p.ovr) drawText(g, String(p.ovr), x + half - 8, y, { color: PAL.teal, align: 'right' });
      });
    });
    rect(g, w / 2 - 1, 22, 2, h - 30, PAL.gold);
  },

  signing(g, d, w, h) {
    const tagColor = { SIGNED: PAL.green, RELEASED: PAL.red, RETIRED: PAL.gray4, DEPARTED: PAL.gray4, 'RE-SIGNED': PAL.teal }[d.tag] || PAL.gold;
    header(g, 1, 1, w - 2, d.tag || 'MOVE', { bg: tagColor });
    const p = d.player || {};
    const lines = wrap(p.name || '', w - 70, 2, 2);
    lines.forEach((ln, i) => drawText(g, ln, 10, 22 + i * 18, { color: PAL.white, scale: 2, shadow: PAL.ink }));
    const y = 26 + lines.length * 18;
    drawText(g, [p.pos, p.ovr ? `${p.ovr} OVR` : '', p.age ? `AGE ${p.age}` : '', p.dev].filter(Boolean).join(' • '), 10, y, { color: PAL.teal });
    panel(g, w - 58, 18, 50, 40, '#151036', BORDER);
    drawText(g, String(p.ovr ?? ''), w - 33, 26, { color: PAL.gold, scale: 3, align: 'center' });
    badge(g, 10, h - 24, d.team || {}, { w: 34, h: 15 });
    drawText(g, clip(d.team?.name || '', w - 60), 50, h - 20, { color: PAL.white });
    if (d.detail) drawText(g, d.detail, w - 8, h - 36, { color: PAL.gold, align: 'right' });
  },

  injury(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'INJURY REPORT', { bg: PAL.red, fg: PAL.white });
    (d.rows || []).slice(0, 6).forEach((r, i) => {
      const y = 18 + i * Math.min(24, Math.floor((h - 20) / Math.max(1, (d.rows || []).length)));
      rect(g, 8, y + 3, 7, 3, PAL.red); rect(g, 10, y + 1, 3, 7, PAL.red);
      badge(g, 20, y, { abbr: r.team, color: r.color, color2: r.color2 }, { w: 28, h: 11 });
      drawText(g, clip(`${r.pos || ''} ${r.name}`, w - 150), 54, y + 2, { color: PAL.white });
      drawText(g, r.detail || '', w - 8, y + 2, { color: r.ir ? PAL.red : PAL.gold, align: 'right' });
    });
  },

  player(g, d, w, h) {
    header(g, 1, 1, w - 2, d.tag || 'PLAYER', { bg: PAL.gold });
    const lines = wrap(d.name || '', w - 70, 2, 2);
    lines.forEach((ln, i) => drawText(g, ln, 10, 22 + i * 18, { color: PAL.white, scale: 2, shadow: PAL.ink }));
    let y = 26 + lines.length * 18;
    badge(g, 10, y - 2, { abbr: d.team, color: d.color, color2: d.color2 }, { w: 30, h: 13 });
    drawText(g, [d.pos, d.dev].filter(Boolean).join(' • '), 46, y + 1, { color: PAL.teal });
    panel(g, w - 58, 18, 50, 40, '#151036', BORDER);
    drawText(g, String(d.ovr ?? ''), w - 33, 26, { color: PAL.gold, scale: 3, align: 'center' });
    drawText(g, 'OVR', w - 33, 49, { color: PAL.gray4, align: 'center' });
    y += 18;
    for (const ln of wrap(d.line || '', w - 20, 1, 3)) { drawText(g, ln, 10, y, { color: PAL.white }); y += 10; }
  },

  quote(g, d, w, h) {
    header(g, 1, 1, w - 2, d.outlet || 'THE CRIMSON CHRONICLE', { bg: PAL.crimson, fg: PAL.white });
    rect(g, 6, 16, w - 12, h - 22, '#efe6cf');
    const scale = w > 250 ? 2 : 1;
    const tl = wrap(d.title || '', w - 24, scale, 2);
    tl.forEach((ln, i) => drawText(g, ln, 12, 22 + i * (scale === 2 ? 17 : 10), { color: '#3a0d14', scale }));
    let y = 26 + tl.length * (scale === 2 ? 17 : 10);
    rect(g, 12, y - 3, w - 24, 1, '#b9ad8a');
    for (const ln of wrap(d.excerpt ? `"${d.excerpt}"` : '', w - 24, 1, Math.max(1, Math.floor((h - y - 18) / 10)))) {
      drawText(g, ln, 12, y, { color: '#2b2b2b' }); y += 10;
    }
    if (d.author) drawText(g, `- ${d.author}`, w - 12, h - 15, { color: PAL.crimson, align: 'right' });
  },

  matchups(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'UP NEXT');
    const games = (d.games || []).slice(0, 6);
    const rh = Math.min(26, Math.floor((h - 18) / Math.max(1, games.length)));
    games.forEach((gm, i) => {
      const y = 18 + i * rh;
      if (i % 2) rect(g, 4, y - 2, w - 8, rh, '#151036');
      badge(g, w / 2 - 74, y, gm.away, { w: 34, h: 14 });
      drawText(g, gm.away.record || '', w / 2 - 34, y + 4, { color: PAL.gray4 });
      drawText(g, '@', w / 2, y + 4, { color: PAL.gold, align: 'center' });
      badge(g, w / 2 + 14, y, gm.home, { w: 34, h: 14 });
      drawText(g, gm.home.record || '', w / 2 + 52, y + 4, { color: PAL.gray4 });
    });
  },

  power_rankings(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'POWER RANKINGS');
    const rows = (d.rows || []).slice(0, 10);
    const cols = rows.length > 5 ? 2 : 1;
    const per = Math.ceil(rows.length / cols) || 1;
    const cw = Math.floor((w - 8) / cols), rh = Math.min(28, Math.floor((h - 18) / per));
    rows.forEach((r, i) => {
      const x = 4 + Math.floor(i / per) * cw, y = 18 + (i % per) * rh;
      drawText(g, String(r.rank), x + 14, y + 4, { color: PAL.gold, scale: 1, align: 'right' });
      badge(g, x + 20, y, r, { w: 32, h: 14 });
      drawText(g, r.rec || '', x + 58, y + 4, { color: PAL.white });
      if (r.move) drawText(g, `${r.move > 0 ? '▲' : '▼'}${Math.abs(r.move)}`, x + cw - 8, y + 4, { color: r.move > 0 ? PAL.green : PAL.red, align: 'right' });
    });
  },

  bracket(g, d, w, h) {
    header(g, 1, 1, w - 2, d.title || 'BRACKET');
    const rounds = (d.rounds || []).slice(0, 4);
    const cw = Math.floor((w - 8) / Math.max(1, rounds.length));
    rounds.forEach((r, i) => {
      const x = 4 + i * cw;
      drawText(g, clip(r.name, cw - 4), x + cw / 2, 16, { color: PAL.teal, align: 'center' });
      const gh = Math.min(34, Math.floor((h - 28) / Math.max(1, r.games.length)));
      r.games.forEach((gm, j) => {
        const y = 28 + j * gh;
        for (const [k, t] of [[0, gm.away], [1, gm.home]]) {
          const yy = y + k * 12;
          rect(g, x + 2, yy, cw - 6, 11, '#151036');
          drawText(g, `${t.seed ?? ''}`, x + 4, yy + 2, { color: PAL.gold });
          drawText(g, t.abbr, x + 14, yy + 2, { color: PAL.white });
          if (t.score != null) drawText(g, String(t.score), x + cw - 6, yy + 2, { color: PAL.white, align: 'right' });
        }
      });
    });
  },

  corkboard(g, d, w, h) {
    header(g, 1, 1, w - 2, 'CONSPIRACY CORNER', { bg: PAL.cork, fg: PAL.white });
    wrap(d.headline || '', w - 20, 1, 6).forEach((ln, i) => drawText(g, ln, 10, 22 + i * 11, { color: PAL.white }));
  },

  breaking(g, d, w, h) {
    rect(g, 1, 1, w - 2, 18, PAL.red);
    drawText(g, d.tag || 'BREAKING NEWS', w / 2, 6, { color: PAL.white, scale: 1, align: 'center' });
    const lines = wrap(d.text || '', w - 20, 2, 4);
    lines.forEach((ln, i) => drawText(g, ln, w / 2, 32 + i * 18, { color: PAL.white, scale: 2, align: 'center', shadow: PAL.redDark }));
  },

  fallback(g, d, w, h) {
    header(g, 1, 1, w - 2, 'HFL-NN');
    wrap(d.text || d.title || '', w - 20, 1, 8).forEach((ln, i) => drawText(g, ln, 10, 20 + i * 11, { color: PAL.white }));
  },
};

export { textWidth, shade };
