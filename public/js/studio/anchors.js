// The anchors, drawn procedurally as pixel art from each persona's "look"
// (skin, hair style, suit, tie, accessory, build) in personas.json. One
// character is a 44×64 grid; the same drawing scales up for close-ups.
//
// state: { mouth 0–3, blink, emotion, gesture, gestureT 0–1, look -1|0|1, bob 0|1 }
import { rect, shade } from './gfx.js';

export const ANCHOR_W = 44, ANCHOR_H = 64, DESK_Y = 58;

const MOUTH_DARK = '#3a1418', TEETH = '#f6f1e8', TONGUE = '#d94a5c', EYE_WHITE = '#f8f6f0', PUPIL = '#16121c';

export function drawAnchor(ctx, appearance, X, Y, s, state = {}) {
  const p = (x, y, w, h, c) => rect(ctx, X + x * s, Y + y * s, w * s, h * s, c);
  const L = appearance || {};
  const skin = L.skin || '#e0b48a', skinD = shade(skin, 0.82), skinL = shade(skin, 1.1);
  const hair = L.hair || '#222222', hairD = shade(hair, 0.65), hairL = shade(hair, 1.35);
  const suit = L.suit || '#223355', suitD = shade(suit, 0.68), suitL = shade(suit, 1.25);
  const shirt = L.shirt || '#f2f2f2';
  const tie = L.tie && L.tie !== 'none' ? L.tie : null;
  const b = L.build || 0;
  const sw = 15 + b * 2;          // shoulder half-width
  const cx = 22;
  const emotion = state.emotion || 'neutral';
  const gesture = state.gesture || 'none';
  const gt = state.gestureT ?? 1;
  const lean = gesture === 'lean_in' ? 2 : 0;
  const by = (state.bob || 0) + lean;  // body offset (breathing / lean)
  const hy = by;                        // head moves with the body

  // ── Torso ───────────────────────────────────────────────────────────────
  p(cx - sw + 2, 38 + by, sw * 2 - 3, 2, suit);
  p(cx - sw, 40 + by, sw * 2 + 1, 26, suit);
  p(cx + sw - 3, 40 + by, 4, 26, suitD);                     // shading on the far side
  p(cx - sw, 40 + by, 1, 26, suitL);
  // Shirt V and collar
  for (let y = 37; y <= 46; y++) {
    const w = Math.max(1, 11 - (y - 37) * 1.2);
    p(cx - Math.floor(w / 2), y + by, Math.round(w), 1, shirt);
  }
  p(cx - 5, 37 + by, 2, 2, shade(shirt, 1.08)); p(cx + 4, 37 + by, 2, 2, shade(shirt, 1.08));
  // Lapels
  for (let i = 0; i < 8; i++) { p(cx - 6 + Math.floor(i / 2), 38 + i + by, 1, 1, suitD); p(cx + 6 - Math.floor(i / 2), 38 + i + by, 1, 1, suitD); }
  if (tie) {
    p(cx - 1, 38 + by, 3, 2, shade(tie, 0.8));
    p(cx - 1, 40 + by, 3, 9, tie);
    p(cx - 2, 49 + by, 5, 3, tie);
    p(cx, 52 + by, 1, 1, tie);
    p(cx + 1, 41 + by, 1, 8, shade(tie, 0.8));
  } else {
    p(cx - 1, 44 + by, 3, 1, L.accessory === 'headset' ? '#d4a017' : shade(shirt, 0.85));   // necklace / shirt fold
  }
  p(cx, 54 + by, 1, 1, suitD);
  if (L.accessory === 'pocket') { p(cx - sw + 5, 46 + by, 5, 2, '#f4f4f4'); p(cx - sw + 6, 45 + by, 1, 1, '#f4f4f4'); p(cx - sw + 8, 45 + by, 1, 1, tie || '#c8102e'); }

  // ── Neck and head ───────────────────────────────────────────────────────
  p(cx - 4, 32 + hy, 9, 7, skin);
  p(cx - 4, 33 + hy, 9, 1, skinD);
  p(cx - 7, 10 + hy, 15, 24, skin);
  p(cx - 8, 12 + hy, 17, 19, skin);
  p(cx - 6, 30 + hy, 13, 4, skin);
  p(cx + 6, 13 + hy, 2, 18, skinD);                          // cheek shadow
  p(cx - 9, 19 + hy, 2, 6, skin); p(cx + 8, 19 + hy, 2, 6, skinD);   // ears
  p(cx - 9, 21 + hy, 1, 2, skinD);

  drawHair(p, L.hairStyle || 'short', cx, hy, hair, hairD, hairL, skinL);

  // ── Face ────────────────────────────────────────────────────────────────
  const look = state.look || 0;
  if (state.blink || emotion === 'laughing') {
    if (emotion === 'laughing') {
      p(cx - 6, 21 + hy, 1, 1, PUPIL); p(cx - 5, 20 + hy, 1, 1, PUPIL); p(cx - 4, 21 + hy, 1, 1, PUPIL);
      p(cx + 2, 21 + hy, 1, 1, PUPIL); p(cx + 3, 20 + hy, 1, 1, PUPIL); p(cx + 4, 21 + hy, 1, 1, PUPIL);
    } else {
      p(cx - 6, 21 + hy, 3, 1, skinD); p(cx + 2, 21 + hy, 3, 1, skinD);
    }
  } else {
    const tall = emotion === 'shocked' ? 3 : 2;
    const ey = emotion === 'shocked' ? 19 : 20;
    p(cx - 6, ey + hy, 3, tall, EYE_WHITE); p(cx + 2, ey + hy, 3, tall, EYE_WHITE);
    const squint = emotion === 'suspicious' || emotion === 'smug';
    p(cx - 5 + look, ey + hy + (squint ? 1 : 0), 1, squint ? 1 : tall, PUPIL);
    p(cx + 3 + look, ey + hy + (squint ? 1 : 0), 1, squint ? 1 : tall, PUPIL);
    if (squint) { p(cx - 6, ey + hy, 3, 1, skinD); p(cx + 2, ey + hy, 3, 1, skinD); }
  }
  // Eyebrows: y offsets for [outer, middle, inner]
  const brow = {
    angry: [[-1, 0, 1], [1, 0, -1]], sad: [[1, 0, -1], [-1, 0, 1]], shocked: [[-1, -1, -1], [-1, -1, -1]],
    suspicious: [[0, 0, 0], [-1, -1, -1]], smug: [[0, 0, 0], [-1, -1, -1]], serious: [[0, 1, 1], [1, 1, 0]],
  }[emotion] || [[0, 0, 0], [0, 0, 0]];
  const browC = L.hairStyle === 'bald' ? shade(skin, 0.6) : hairD;
  for (let i = 0; i < 3; i++) {
    p(cx - 6 + i, 18 + hy + brow[0][i], 1, 1, browC);
    p(cx + 2 + i, 18 + hy + brow[1][i], 1, 1, browC);
  }
  // Nose
  p(cx, 22 + hy, 1, 4, skinD); p(cx - 1, 26 + hy, 2, 1, skinD);
  if (L.hairStyle === 'bald') { p(cx - 2, 31 + hy, 5, 2, hair); p(cx - 3, 30 + hy, 1, 1, hair); p(cx + 3, 30 + hy, 1, 1, hair); }

  drawMouth(p, cx, hy, state.mouth || 0, emotion);

  // Accessories that sit on the face/head
  if (L.accessory === 'glasses') {
    const fc = '#1a1a1a';
    for (const ex of [cx - 7, cx + 1]) {
      p(ex, 19 + hy, 5, 1, fc); p(ex, 22 + hy, 5, 1, fc); p(ex, 19 + hy, 1, 4, fc); p(ex + 4, 19 + hy, 1, 4, fc);
    }
    p(cx - 2, 20 + hy, 3, 1, fc);
    p(cx - 8, 20 + hy, 1, 1, fc); p(cx + 6, 20 + hy, 1, 1, fc);
  }
  if (L.accessory === 'headset') {
    const hc = '#2a2a33';
    p(cx - 9, 6 + hy, 19, 1, hc); p(cx - 10, 7 + hy, 1, 13, hc); p(cx + 9, 7 + hy, 1, 13, hc);
    p(cx - 11, 18 + hy, 3, 6, hc); p(cx + 8, 18 + hy, 3, 6, hc);
    p(cx - 10, 24 + hy, 1, 5, hc); p(cx - 9, 28 + hy, 4, 1, hc); p(cx - 5, 27 + hy, 2, 2, '#55556a');
  }
  if (L.accessory === 'foilhat') {
    for (let i = 0; i < 14; i++) {
      const w = 3 + Math.round(i * 1.25);
      const y = -6 + i;
      p(cx - Math.floor(w / 2), y + hy, w, 1, i % 3 === 0 ? '#eef2f6' : '#c3c9d2');
      if (i % 4 === 2) p(cx - Math.floor(w / 2) + (i % 3), y + hy, 1, 1, '#8a919c');
    }
    p(cx - 10, 8 + hy, 21, 2, '#aeb5bf');
  }

  // ── Arms and gestures ───────────────────────────────────────────────────
  drawArms(p, { cx, sw, by, skin, skinD, suit, suitD, ring: L.accessory === 'ring', gesture, gt });
}

function drawHair(p, style, cx, hy, hair, hairD, hairL, skinL) {
  switch (style) {
    case 'swoop':
      p(cx - 8, 7 + hy, 17, 6, hair); p(cx - 9, 9 + hy, 19, 5, hair);
      p(cx - 9, 12 + hy, 3, 7, hair); p(cx + 7, 12 + hy, 3, 5, hair);
      p(cx - 3, 5 + hy, 11, 3, hair); p(cx + 6, 6 + hy, 3, 3, hair);
      p(cx - 2, 7 + hy, 8, 1, hairL); p(cx - 7, 12 + hy, 4, 2, hair);
      p(cx + 7, 9 + hy, 2, 5, hairD);
      break;
    case 'ponytail':
      p(cx - 8, 7 + hy, 17, 6, hair); p(cx - 9, 9 + hy, 19, 5, hair);
      p(cx - 9, 13 + hy, 3, 15, hair); p(cx + 7, 13 + hy, 3, 13, hair);
      p(cx - 7, 12 + hy, 7, 2, hair); p(cx + 1, 12 + hy, 3, 1, hair);
      p(cx + 9, 11 + hy, 4, 5, hair); p(cx + 10, 16 + hy, 3, 10, hair); p(cx + 11, 26 + hy, 2, 3, hairD);
      p(cx - 4, 8 + hy, 7, 1, hairL);
      break;
    case 'bald':
      p(cx - 3, 12 + hy, 4, 1, skinL); p(cx - 4, 13 + hy, 1, 1, skinL);
      break;
    case 'messy':
      p(cx - 8, 8 + hy, 17, 5, hair); p(cx - 9, 10 + hy, 19, 4, hair);
      p(cx - 9, 13 + hy, 3, 7, hair); p(cx + 7, 13 + hy, 3, 7, hair);
      for (const [x, y, h] of [[-8, 6, 2], [-5, 4, 4], [-1, 5, 3], [3, 4, 4], [6, 6, 2]]) p(cx + x, y + hy, 2, h, hair);
      p(cx - 6, 12 + hy, 2, 2, hair); p(cx + 2, 12 + hy, 3, 2, hair);
      p(cx - 3, 9 + hy, 6, 1, hairL);
      break;
    case 'short':
    default:
      p(cx - 8, 8 + hy, 17, 5, hair); p(cx - 9, 10 + hy, 19, 3, hair);
      p(cx - 9, 13 + hy, 2, 6, hair); p(cx + 8, 13 + hy, 2, 6, hair);
      p(cx - 3, 9 + hy, 7, 1, hairL);
  }
}

function drawMouth(p, cx, hy, level, emotion) {
  const y = 29 + hy;
  if (level <= 0) {
    if (emotion === 'smug') {
      p(cx - 3, y + 1, 6, 1, MOUTH_DARK); p(cx + 3, y, 1, 1, MOUTH_DARK);          // lopsided smirk
    } else if (['happy', 'laughing', 'excited'].includes(emotion)) {
      p(cx - 2, y + 1, 5, 1, MOUTH_DARK); p(cx - 3, y, 1, 1, MOUTH_DARK); p(cx + 3, y, 1, 1, MOUTH_DARK);
    } else if (['sad', 'angry'].includes(emotion)) {
      p(cx - 2, y, 5, 1, MOUTH_DARK); p(cx - 3, y + 1, 1, 1, MOUTH_DARK); p(cx + 3, y + 1, 1, 1, MOUTH_DARK);
    } else if (emotion === 'shocked') {
      p(cx - 1, y, 3, 2, MOUTH_DARK);
    } else {
      p(cx - 3, y, 7, 1, MOUTH_DARK);
    }
    return;
  }
  if (level === 1) { p(cx - 2, y, 5, 2, MOUTH_DARK); return; }
  if (level === 2) { p(cx - 3, y - 1, 7, 3, MOUTH_DARK); p(cx - 2, y - 1, 5, 1, TEETH); return; }
  p(cx - 3, y - 1, 7, 4, MOUTH_DARK); p(cx - 2, y - 1, 5, 1, TEETH); p(cx - 1, y + 2, 3, 1, TONGUE);
}

function drawArms(p, { cx, sw, by, skin, skinD, suit, suitD, ring, gesture, gt }) {
  const restLeft = () => { p(cx - sw - 1, 46 + by, 4, 10, suitD); p(cx - sw + 1, 54, 11, 4, suit); p(cx - sw + 11, 53, 5, 5, skin); p(cx - sw + 11, 57, 5, 1, skinD); };
  const restRight = () => {
    p(cx + sw - 2, 46 + by, 4, 10, suitD); p(cx + sw - 11, 54, 11, 4, suit); p(cx + sw - 15, 53, 5, 5, skin); p(cx + sw - 15, 57, 5, 1, skinD);
    if (ring) p(cx + sw - 14, 55, 2, 1, '#ffd23f');
  };
  switch (gesture) {
    case 'point': {
      restLeft();
      const up = gt < 0.15 ? gt / 0.15 : 1;
      const ty = Math.round(44 - 12 * up);
      p(cx + sw - 2, 42 + by, 5, 8, suit); p(cx + sw + 2, ty + by, 4, 50 - ty, suit);
      p(cx + sw + 2, ty - 4 + by, 5, 5, skin); p(cx + sw + 6, ty - 4 + by, 4, 2, skin);
      if (ring) p(cx + sw + 3, ty - 2 + by, 2, 1, '#ffd23f');
      break;
    }
    case 'shrug':
      for (const dir of [-1, 1]) {
        const x = dir < 0 ? cx - sw - 5 : cx + sw + 1;
        p(x, 40 + by, 5, 12, suit); p(x - (dir < 0 ? 1 : -1), 35 + by, 6, 5, skin);
        p(x + (dir < 0 ? 0 : 2), 34 + by, 2, 1, skin);
      }
      break;
    case 'desk_slam':
      if (gt < 0.35) {
        p(cx - 10, 36 + by, 7, 7, skin); p(cx + 4, 36 + by, 7, 7, skin);
        p(cx - 10, 43 + by, 6, 12, suit); p(cx + 5, 43 + by, 6, 12, suit);
      } else {
        p(cx - sw + 1, 50, 10, 6, suit); p(cx + sw - 10, 50, 10, 6, suit);
        p(cx - 11, 52, 8, 6, skin); p(cx + 4, 52, 8, 6, skin);
        p(cx - 11, 57, 8, 1, skinD); p(cx + 4, 57, 8, 1, skinD);
      }
      if (ring) p(cx + 6, gt < 0.35 ? 38 + by : 54, 2, 1, '#ffd23f');
      break;
    case 'facepalm':
      restLeft();
      p(cx + sw - 3, 40 + by, 5, 10, suit); p(cx + 5, 26 + by, 6, 16, suit);
      p(cx - 2, 16 + by, 11, 8, skin); p(cx - 2, 23 + by, 11, 1, skinD);
      break;
    case 'thumbs_up':
      restLeft();
      p(cx + sw - 3, 42 + by, 5, 10, suit); p(cx + sw - 6, 40 + by, 6, 6, skin); p(cx + sw - 5, 35 + by, 2, 5, skin);
      break;
    case 'arms_crossed':
      p(cx - sw + 1, 45 + by, sw * 2 - 1, 5, suit); p(cx - sw + 2, 49 + by, sw * 2 - 3, 2, suitD);
      p(cx - sw - 1, 44 + by, 4, 5, skin); p(cx + sw - 2, 44 + by, 4, 5, skin);
      break;
    default:
      restLeft(); restRight();
  }
}
