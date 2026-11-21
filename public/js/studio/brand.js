// Whose show is on: HFL-NN, or another show on the network (the Fifth
// Quarter) whose manifest carries a `brand`. The bug, the open, the end slate
// and the studio's logo screens read it. renderFrame sets it every frame.
import { textWidth, PAL } from './gfx.js';

const COLORS = { accent: PAL.teal, ticker: PAL.red, ring: PAL.violet, ring2: PAL.deep };
const DEFAULT = { key: 'hflnn', name: 'HFL-NN', sub: 'NEWS NETWORK', screen: 'TONIGHT', tagline: 'STAY HYPNOTIC.', ...COLORS };
export const brand = { ...DEFAULT };

export function setBrand(b) {
  const next = b?.name
    ? {
      key: String(b.name), name: String(b.bug || b.name).toUpperCase(), sub: `ON ${String(b.network || 'HFL-NN').toUpperCase()}`, screen: 'THIS WEEK', tagline: String(b.tagline || '').toUpperCase(),
      accent: b.colors?.accent || COLORS.accent, ticker: b.colors?.accent2 || COLORS.ticker, ring: b.colors?.ring || COLORS.ring, ring2: b.colors?.ring2 || COLORS.ring2,
    }
    : DEFAULT;
  Object.assign(brand, next);
}

// The largest text scale (up to `max`) at which `text` fits in `width`.
export function fitScale(text, width, max) {
  for (let s = max; s > 1; s--) if (textWidth(text, s) <= width) return s;
  return 1;
}
