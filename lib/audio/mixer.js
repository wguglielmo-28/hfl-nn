// Assembles an episode's soundtrack: voices every script line, lays the lines
// out with natural gaps, drops jingles between segments, and mixes it all into
// one track. Also produces the timeline the player animates from:
//   lines    — when each line starts/ends, who says it, emotion/gesture/card
//   segments — segment boundaries (a segment starts with its transition sting)
//   mouth    — mouth-openness 0–3 per video frame, from the voice's loudness
// One audio file + one timeline means the player can use audio.currentTime as
// its only clock, so lips never drift from the voice.
'use strict';
const { jingle } = require('./jingles');
const { prepareSpeech } = require('../tts/textprep');

const FPS = 30;
const EMOTION_SPEED = {
  excited: 1.06, angry: 1.04, shocked: 1.03, laughing: 1.03, happy: 1.02,
  smug: 1, neutral: 1, serious: 0.98, suspicious: 0.96, sad: 0.94,
};
const GAP_SAME = 0.14, GAP_OTHER = 0.3;

async function buildEpisodeAudio({ script, rundown, personas, tts, settings = {}, onProgress }) {
  const SR = tts.SAMPLE_RATE;
  const secs = s => Math.round(s * SR);
  const anchors = Object.fromEntries(personas.anchors.map(a => [a.id, a]));
  const breaking = rundown.type === 'breaking';
  const clips = [];
  const lines = [], segments = [], cues = [], speech = [];
  const place = (samples, gain, at) => { clips.push({ at, samples, gain }); return at + samples.length; };

  // Open on the station ident (or the breaking-news alarm); speech starts as it fades.
  const open = jingle(breaking ? 'breaking' : 'theme');
  place(open, 0.55, 0);
  cues.push({ t: 0, type: breaking ? 'breaking' : 'theme' });
  let t = Math.max(0, open.length - secs(0.45));

  const total = script.segments.reduce((n, s) => n + s.lines.length, 0);
  let done = 0, prevSpeaker = null;
  for (let si = 0; si < script.segments.length; si++) {
    const seg = script.segments[si];
    const rseg = rundown.segments.find(r => r.id === seg.id) || {};
    let segStart = si === 0 ? 0 : t;
    if (si > 0) {
      t += secs(0.3);
      segStart = t;
      const kind = rseg.set === 'corkboard' ? 'spooky' : 'sting';
      const s = jingle(kind);
      cues.push({ t: +(t / SR).toFixed(3), type: kind });
      place(s, 0.5, t);
      t += s.length - secs(0.3);
      prevSpeaker = null;
    }
    for (let li = 0; li < seg.lines.length; li++) {
      const ln = seg.lines[li];
      const a = anchors[ln.speaker] || {};
      const speed = (a.speed || 1) * (EMOTION_SPEED[ln.emotion] || 1);
      const spoken = prepareSpeech(ln.text, { network: personas.network, pronunciations: settings.pronunciations });
      const audio = await tts.speak(spoken, { voice: a.voice || 'am_michael', speed: Math.round(speed * 100) / 100 });
      if (prevSpeaker) t += secs(prevSpeaker === ln.speaker ? GAP_SAME : GAP_OTHER);
      const start = t;
      t = place(audio.samples, 1, start);
      lines.push({
        seg: seg.id, i: li, t0: +(start / SR).toFixed(3), t1: +(t / SR).toFixed(3),
        speaker: ln.speaker, text: ln.text, emotion: ln.emotion, gesture: ln.gesture, shot: ln.shot, card: ln.card,
      });
      speech.push({ start, samples: audio.samples, synthetic: audio.synthetic, text: spoken });
      prevSpeaker = ln.speaker;
      onProgress?.({ done: ++done, total });
    }
    segments.push({ id: seg.id, kind: rseg.kind || seg.kind, t0: +(segStart / SR).toFixed(3), t1: +(t / SR).toFixed(3) });
  }

  // Close on the outro.
  t += secs(0.4);
  const outro = jingle('outro');
  cues.push({ t: +(t / SR).toFixed(3), type: 'outro' });
  t = place(outro, 0.55, t);

  const length = t + secs(0.25);
  const mix = new Float32Array(length);
  for (const c of clips) {
    const n = Math.min(c.samples.length, length - c.at);
    for (let i = 0; i < n; i++) mix[c.at + i] += c.samples[i] * c.gain;
  }
  // Normalize so the loud parts sit just under full scale (Kokoro speaks at
  // about -24 dB average), then soft-limit any stray peaks.
  const abs = new Float32Array(Math.ceil(length / 64));
  for (let i = 0, j = 0; i < length; i += 64, j++) abs[j] = Math.abs(mix[i]);
  abs.sort();
  const p999 = abs[Math.floor(abs.length * 0.999)] || 0;
  const gain = p999 > 1e-4 ? Math.min(2.5, 0.89 / p999) : 1;
  for (let i = 0; i < length; i++) {
    const v = mix[i] * gain;
    mix[i] = v > 0.95 || v < -0.95 ? Math.tanh(v) : v;
  }

  const mouth = new Uint8Array(Math.ceil((length / SR) * FPS));
  for (const s of speech) fillMouth(mouth, s, SR);
  return {
    samples: mix,
    sampleRate: SR,
    duration: +(length / SR).toFixed(3),
    lines, segments, cues,
    mouth: { fps: FPS, data: Array.from(mouth).join('') },
  };
}

// Mouth openness per video frame from the line's loudness, normalized to the
// line's own loud parts so a quiet voice still moves its mouth. Silent
// (synthetic) audio gets a syllable-rate flap instead.
function fillMouth(mouth, { start, samples, synthetic, text }, SR) {
  const hop = SR / FPS;
  const first = Math.round(start / hop);
  const n = Math.ceil(samples.length / hop);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0, c = 0;
    for (let i = Math.floor(f * hop); i < Math.min(samples.length, Math.floor((f + 1) * hop)); i++) { sum += samples[i] * samples[i]; c++; }
    rms[f] = c ? Math.sqrt(sum / c) : 0;
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  let prev = 0;
  for (let f = 0; f < n && first + f < mouth.length; f++) {
    let level;
    if (synthetic || p90 < 1e-4) {
      // ~4.5 syllables a second, with a short closed beat at word gaps.
      const words = Math.max(1, String(text).split(/\s+/).length);
      const phase = (f / FPS) * 4.5 * 2 * Math.PI;
      const wordGap = Math.floor((f / n) * words * 3) % 3 === 2 && f % 7 === 0;
      level = wordGap ? 0 : [0, 1, 2, 3, 2, 1][Math.floor(((Math.sin(phase) + 1) / 2) * 5.99)];
    } else {
      const r = rms[f] / p90;
      level = r < 0.12 ? 0 : r < 0.35 ? 1 : r < 0.7 ? 2 : 3;
    }
    if (level < prev - 1) level = prev - 1;   // close smoothly, open instantly
    mouth[first + f] = level;
    prev = level;
  }
}

module.exports = { buildEpisodeAudio, fillMouth, FPS, EMOTION_SPEED };
