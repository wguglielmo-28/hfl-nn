// Assembles an episode's soundtrack: voices every script line, lays the lines
// out with natural gaps, drops jingles between segments, and mixes it all into
// one track. Also produces the timeline the player animates from:
//   lines    — when each line starts/ends, who says it, emotion/gesture/card
//   segments — segment boundaries (a segment starts with its transition sting)
//   mouth    — mouth-openness 0–3 per video frame, from the voice's loudness
//   mouthBySpeaker — the same per anchor, only when anchors talk over each
//              other (crosstalk), so two mouths can move at once
//
// Crosstalk: a script line's `enter` (lib/writer/schema.js ENTERS) starts it
// before the previous anchor has finished. "cut" stops the other voice dead,
// "trail" fades it out, "over" turns it down under the new voice, "fight"
// keeps both up and louder, "persist" keeps the first voice on top. Every
// line is still voiced on its own; only where it sits in the mix changes.
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
// With Settings → emotion in voices on (the default): a shout sits a little
// louder and a whisper quieter than the rest of the mix, and when two heated
// lines from different anchors meet, the second barely lets the first finish.
const EMOTION_GAIN = { angry: 1.12, excited: 1.1, shocked: 1.08, laughing: 1.05, suspicious: 0.8, sad: 0.85, serious: 0.95 };
const HEATED = new Set(['angry', 'excited', 'shocked', 'smug', 'laughing']);
const GAP_HEATED = 0.12;
// How far (seconds) each kind of entrance reaches back over the line before.
const OVERLAP = { cut: 0.35, over: 1.2, fight: 1.6, trail: 0.6, persist: 1.4 };
const MAX_OVERLAP = 2.5;
const DUCK = 0.63;        // about -4 dB for the voice that loses the floor
const FIGHT_GAIN = 1.08;  // both voices up a touch in a fight

// With Settings → Voice engine on ElevenLabs, an anchor who has an ElevenLabs
// voice uses it; everyone else keeps their Kokoro voice.
function voiceFor(anchor, settings = {}) {
  if (settings.voiceEngine === 'elevenlabs' && anchor.elevenVoice) return `eleven:${anchor.elevenVoice}`;
  return anchor.voice || 'am_michael';
}

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
  let done = 0, prevSpeaker = null, prevEmotion = null;
  let prev = null;          // the segment's previous line: { clip, line, sp, start, end }
  let crosstalk = false;    // any overlap at all (then mouthBySpeaker is written)

  // Ends the previous line's audio `at` samples in, fading over `fade`.
  const endAt = (p, at, fade) => {
    if (at >= p.clip.samples.length) return;
    const out = p.clip.samples.slice(0, Math.max(1, at));
    const f = Math.min(fade, out.length);
    for (let i = 0; i < f; i++) out[out.length - f + i] *= 1 - (i + 1) / f;
    p.clip.samples = out;
    p.sp.samples = out;
    p.end = p.start + out.length;
    p.line.t1 = +(p.end / SR).toFixed(3);
  };
  // Turns the previous line down from `from` samples in (a 50 ms ramp).
  const duckFrom = (p, from, g) => {
    const out = p.clip.samples.slice();
    const ramp = secs(0.05);
    for (let i = Math.max(0, from); i < out.length; i++) out[i] *= 1 - (1 - g) * Math.min(1, (i - from) / ramp);
    p.clip.samples = out;
  };
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
    prev = null;
    const segLines = [];
    for (let li = 0; li < seg.lines.length; li++) {
      const ln = seg.lines[li];
      const a = anchors[ln.speaker] || {};
      const speed = (a.speed || 1) * (EMOTION_SPEED[ln.emotion] || 1);
      const spoken = prepareSpeech(ln.text, { network: personas.network, pronunciations: settings.pronunciations });
      const feel = settings.voiceEmotion !== false;
      const audio = await tts.speak(spoken, { voice: voiceFor(a, settings), speed: Math.round(speed * 100) / 100, elevenModel: settings.elevenModel, emotion: feel ? ln.emotion : null });
      const heated = feel && prevSpeaker && prevSpeaker !== ln.speaker && HEATED.has(ln.emotion) && HEATED.has(prevEmotion);
      const enter = OVERLAP[ln.enter] && prev && prev.line.speaker !== ln.speaker ? ln.enter : '';
      let start, ov = 0;
      if (enter) {
        // Start inside the previous line (never in its first 0.4 s).
        ov = Math.min(secs(OVERLAP[enter]), secs(MAX_OVERLAP), Math.round((prev.end - prev.start) * 0.7));
        start = Math.max(prev.start + secs(0.4), prev.end - ov);
        ov = prev.end - start;
        const into = start - prev.start;
        if (enter === 'cut') endAt(prev, into + secs(0.06), secs(0.03));
        else if (enter === 'trail') endAt(prev, into + secs(0.4), secs(0.4));
        else if (enter === 'over') duckFrom(prev, into, DUCK);
        else if (enter === 'fight') prev.clip.gain *= FIGHT_GAIN;
        crosstalk = true;
      } else {
        if (prevSpeaker) t += secs(prevSpeaker === ln.speaker ? GAP_SAME : heated ? GAP_HEATED : GAP_OTHER);
        start = t;
      }
      let samples = audio.samples;
      if (enter === 'persist' && ov > 0) {
        // The one already talking keeps the floor: this voice sits under it.
        samples = samples.slice();
        for (let i = 0; i < Math.min(ov, samples.length); i++) samples[i] *= DUCK;
      }
      const clip = { at: start, samples, gain: (feel ? EMOTION_GAIN[ln.emotion] || 1 : 1) * (enter === 'fight' ? FIGHT_GAIN : 1) };
      clips.push(clip);
      const end = start + samples.length;
      // The segment runs on from whichever voice ends last (a cut line ends early).
      t = enter ? Math.max(end, ...segLines.map(x => x.end)) : end;
      const line = {
        seg: seg.id, i: li, t0: +(start / SR).toFixed(3), t1: +(end / SR).toFixed(3),
        speaker: ln.speaker, text: ln.text, emotion: ln.emotion, gesture: ln.gesture, shot: ln.shot, card: ln.card,
        ...(enter ? { enter } : {}),
      };
      lines.push(line);
      const sp = { start, samples, synthetic: audio.synthetic, text: spoken, speaker: ln.speaker };
      speech.push(sp);
      prev = { clip, line, sp, start, end };
      segLines.push(prev);
      prevSpeaker = ln.speaker;
      prevEmotion = ln.emotion;
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

  const frames = Math.ceil((length / SR) * FPS);
  const mouth = new Uint8Array(frames);
  for (const s of speech) fillMouth(mouth, s, SR);
  // With crosstalk, a track per anchor too, so both mouths move in an overlap.
  let mouthBySpeaker;
  if (crosstalk) {
    const by = {};
    for (const s of speech) fillMouth(by[s.speaker] ||= new Uint8Array(frames), s, SR);
    mouthBySpeaker = Object.fromEntries(Object.entries(by).map(([id, m]) => [id, Array.from(m).join('')]));
  }
  return {
    samples: mix,
    sampleRate: SR,
    duration: +(length / SR).toFixed(3),
    lines, segments, cues,
    mouth: { fps: FPS, data: Array.from(mouth).join('') },
    ...(mouthBySpeaker ? { mouthBySpeaker } : {}),
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

module.exports = { buildEpisodeAudio, fillMouth, voiceFor, FPS, EMOTION_SPEED, EMOTION_GAIN, GAP_HEATED, GAP_OTHER, OVERLAP, DUCK };
