// HFL-NN's music: tiny chiptune jingles synthesized from note lists (square,
// triangle and noise channels, like an 8-bit console). Generated at runtime,
// so there is no audio asset to license.
'use strict';

const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

function lfsrNoise() {
  let reg = 0x7fff;
  return () => {
    const bit = (reg ^ (reg >> 1)) & 1;
    reg = (reg >> 1) | (bit << 14);
    return (reg & 1) ? 1 : -1;
  };
}

// tracks: [{ wave: 'square'|'triangle'|'noise', duty, vol, notes: [[beat, beats, midi]] }]
function render({ bpm, beats, tracks, sampleRate = 24000, tail = 0.4 }) {
  const spb = 60 / bpm;
  const len = Math.ceil((beats * spb + tail) * sampleRate);
  const out = new Float32Array(len);
  for (const tr of tracks) {
    const noise = lfsrNoise();
    for (const [beat, dur, midi, velocity = 1] of tr.notes) {
      const start = Math.floor(beat * spb * sampleRate);
      const length = Math.floor(dur * spb * sampleRate);
      const release = Math.floor((tr.release ?? 0.06) * sampleRate);
      const hz = tr.wave === 'noise' ? 0 : midiHz(midi);
      let phase = 0;
      let held = 0;
      const step = tr.wave === 'noise' ? Math.max(1, Math.round(sampleRate / (midi * 40))) : 0;
      for (let i = 0; i < length + release && start + i < len; i++) {
        const t = i / sampleRate;
        // Envelope: fast attack, gentle decay toward sustain, then release.
        const a = Math.min(1, t / 0.005);
        const d = tr.decay ? Math.max(tr.sustain ?? 0.5, Math.exp(-t / tr.decay)) : 1;
        const r = i < length ? 1 : 1 - (i - length) / release;
        let v;
        if (tr.wave === 'square') {
          phase = (phase + hz / sampleRate) % 1;
          v = phase < (tr.duty ?? 0.5) ? 1 : -1;
        } else if (tr.wave === 'triangle') {
          phase = (phase + hz / sampleRate) % 1;
          v = 1 - 4 * Math.abs(phase - 0.5);
        } else {
          if (i % step === 0) held = noise();
          v = held;
        }
        out[start + i] += v * a * d * r * (tr.vol ?? 0.2) * velocity;
      }
    }
  }
  // Gentle soft-clip so stacked channels never crackle.
  for (let i = 0; i < len; i++) out[i] = Math.tanh(out[i] * 1.2) / 1.2;
  return out;
}

const kick = b => [b, 0.12, 2, 1.2];
const snare = b => [b, 0.1, 12, 0.9];
const hat = b => [b, 0.04, 30, 0.5];
// Noise "pitch" sets how often the noise value changes: low = rumble, high = hiss.
const crash = b => [b, 1.5, 45, 1];

const JINGLES = {
  // Station ident: a bright fanfare with drums.
  theme: () => render({
    bpm: 138, beats: 8,
    tracks: [
      { wave: 'square', duty: 0.25, vol: 0.13, decay: 0.25, sustain: 0.6, notes: [[0, 0.5, 72], [0.5, 0.5, 76], [1, 0.5, 79], [1.5, 1.4, 84], [3, 0.5, 79], [3.5, 0.5, 84], [4, 0.5, 86], [4.5, 0.5, 88], [5, 2.6, 91]] },
      { wave: 'square', duty: 0.5, vol: 0.07, decay: 0.3, sustain: 0.5, notes: [[0, 1.5, 64], [1.5, 1.5, 67], [3, 1, 72], [4, 1, 74], [5, 2.6, 76]] },
      { wave: 'triangle', vol: 0.3, notes: [[0, 1.4, 36], [1.5, 1.4, 43], [3, 1, 36], [4, 1, 38], [5, 2.6, 36]] },
      { wave: 'noise', vol: 0.14, decay: 0.09, sustain: 0, release: 0.02, notes: [kick(0), snare(1), kick(1.5), snare(2.5), kick(3), snare(4), kick(4.5), hat(5.5), crash(5)] },
    ],
  }),
  // Segment transition: quick rising arpeggio with a crash.
  sting: () => render({
    bpm: 160, beats: 2.5, tail: 0.3,
    tracks: [
      { wave: 'square', duty: 0.25, vol: 0.12, decay: 0.15, sustain: 0.4, notes: [[0, 0.25, 79], [0.25, 0.25, 83], [0.5, 0.25, 86], [0.75, 1.2, 91]] },
      { wave: 'triangle', vol: 0.28, notes: [[0, 0.5, 43], [0.75, 1.2, 31]] },
      { wave: 'noise', vol: 0.12, decay: 0.09, sustain: 0, release: 0.02, notes: [kick(0), crash(0.75)] },
    ],
  }),
  // Breaking news: urgent alternating alarm over pounding hits.
  breaking: () => render({
    bpm: 150, beats: 6, tail: 0.3,
    tracks: [
      { wave: 'square', duty: 0.5, vol: 0.1, notes: Array.from({ length: 16 }, (_, i) => [i * 0.25, 0.22, i % 2 ? 76 : 81]) },
      { wave: 'square', duty: 0.25, vol: 0.12, decay: 0.4, sustain: 0.6, notes: [[4, 2, 69], [4, 2, 76]] },
      { wave: 'triangle', vol: 0.32, notes: [[0, 1, 33], [1, 1, 33], [2, 1, 36], [3, 1, 35], [4, 2, 33]] },
      { wave: 'noise', vol: 0.15, decay: 0.09, sustain: 0, release: 0.02, notes: [kick(0), kick(1), kick(2), kick(3), snare(3.5), crash(4)] },
    ],
  }),
  // Conspiracy Corner: a spooky minor wobble.
  spooky: () => render({
    bpm: 90, beats: 4, tail: 0.5,
    tracks: [
      { wave: 'triangle', vol: 0.25, notes: [[0, 0.5, 69], [0.5, 0.5, 72], [1, 0.5, 75], [1.5, 0.5, 74], [2, 2, 68]] },
      { wave: 'square', duty: 0.125, vol: 0.05, decay: 0.5, sustain: 0.3, notes: [[0, 4, 45], [2, 2, 44]] },
      { wave: 'noise', vol: 0.06, decay: 0.25, sustain: 0, release: 0.2, notes: [[0, 0.6, 3, 0.7], [2, 0.6, 3, 0.7]] },
    ],
  }),
  // Sign-off: the theme, descending and resolving.
  outro: () => render({
    bpm: 128, beats: 6, tail: 0.8,
    tracks: [
      { wave: 'square', duty: 0.25, vol: 0.12, decay: 0.3, sustain: 0.6, notes: [[0, 0.5, 91], [0.5, 0.5, 88], [1, 0.5, 84], [1.5, 0.5, 79], [2, 1, 81], [3, 3, 84]] },
      { wave: 'triangle', vol: 0.3, notes: [[0, 2, 41], [2, 1, 43], [3, 3, 36]] },
      { wave: 'noise', vol: 0.12, decay: 0.09, sustain: 0, release: 0.02, notes: [kick(0), snare(1), kick(2), snare(2.5), crash(3)] },
    ],
  }),
};

const cache = {};
function jingle(name) {
  if (!JINGLES[name]) throw new Error(`unknown jingle ${name}`);
  return (cache[name] ||= JINGLES[name]());
}

module.exports = { jingle, render, JINGLE_NAMES: Object.keys(JINGLES) };
