// Checks a script against its rundown before it is voiced, and normalizes it.
//
// Errors block voicing (and trigger the writer's one repair pass); warnings
// are shown to the commissioner in the review screen. The number check is
// the main accuracy guard: any figure an anchor says that appears nowhere in
// the facts the writer was given is flagged for a human to look at.
'use strict';
const { EMOTIONS, GESTURES, SHOTS } = require('./schema');
const { wordCount, asciiFold } = require('../util');

const PROFANITY = /\b(fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*|motherf\w*)\b/i;
const MAX_LINE = 420;

// Numbers worth checking: anything over 12 (small counts, ordinals and
// "6 and 2"-style records are too common to police).
function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function factNumberSet(...texts) {
  const set = new Set();
  for (const t of texts) for (const v of numbersIn(t)) set.add(v);
  return set;
}

// Strip what a TTS engine would read aloud but an anchor wouldn't say.
function cleanSpoken(text) {
  return asciiFold(text)
    .replace(/\[[^\]]*\]/g, ' ')            // [stage directions]
    .replace(/\*+([^*]+)\*+/g, '$1')        // *emphasis*
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/#(\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateScript(script, { rundown, personaIds, factNumbers = new Set() }) {
  const errors = [], warnings = [];
  if (!script || typeof script !== 'object') {
    return { ok: false, errors: ['Script is not an object'], warnings, script: null };
  }
  const bySeg = new Map((Array.isArray(script.segments) ? script.segments : []).map(s => [s && s.id, s]));
  for (const id of bySeg.keys()) {
    if (!rundown.segments.some(s => s.id === id)) warnings.push(`Dropped segment "${id}": not in the rundown`);
  }

  const unknownNumbers = new Set();
  let words = 0;
  const segments = [];
  for (const seg of rundown.segments) {
    const src = bySeg.get(seg.id);
    if (!src || !Array.isArray(src.lines) || !src.lines.length) {
      errors.push(`Segment ${seg.id} (${seg.kind}) has no lines`);
      continue;
    }
    const cardIds = new Set(seg.cards.map(c => c.id));
    const lines = [];
    src.lines.forEach((ln, i) => {
      const where = `${seg.id} line ${i + 1}`;
      if (!ln || typeof ln !== 'object') { errors.push(`${where}: not an object`); return; }
      if (!personaIds.includes(ln.speaker)) { errors.push(`${where}: unknown speaker "${ln.speaker}"`); return; }
      const text = cleanSpoken(ln.text);
      if (!text) { errors.push(`${where}: empty text`); return; }
      if (text.length > MAX_LINE * 2) errors.push(`${where}: line is ${text.length} characters; split it up`);
      else if (text.length > MAX_LINE) warnings.push(`${where}: long line (${text.length} characters)`);
      if (PROFANITY.test(text)) errors.push(`${where}: profanity is off-limits on HFL-NN`);
      if (!seg.cast.includes(ln.speaker)) warnings.push(`${where}: ${ln.speaker} isn't in this segment's cast`);
      let card = typeof ln.card === 'string' ? ln.card : '';
      if (card && !cardIds.has(card)) { warnings.push(`${where}: unknown card "${card}" ignored`); card = ''; }
      for (const v of numbersIn(text)) if (v > 12 && !factNumbers.has(v)) unknownNumbers.add(v);
      words += wordCount(text);
      lines.push({
        speaker: ln.speaker,
        text,
        emotion: EMOTIONS.includes(ln.emotion) ? ln.emotion : 'neutral',
        gesture: GESTURES.includes(ln.gesture) ? ln.gesture : 'none',
        shot: SHOTS.includes(ln.shot) ? ln.shot : 'auto',
        card,
      });
    });
    if (lines.length) segments.push({ id: seg.id, kind: seg.kind, lines });
  }

  if (unknownNumbers.size) {
    warnings.push(`Check these numbers — they aren't in the facts: ${[...unknownNumbers].slice(0, 12).join(', ')}`);
  }
  if (rundown.targetWords) {
    const ratio = words / rundown.targetWords;
    if (ratio < 0.5) warnings.push(`Script is short: ${words} words for a ${rundown.targetWords}-word target`);
    if (ratio > 1.7) warnings.push(`Script is long: ${words} words for a ${rundown.targetWords}-word target`);
  }

  const mu = script.memoryUpdates && typeof script.memoryUpdates === 'object' ? script.memoryUpdates : {};
  const arr = v => (Array.isArray(v) ? v : []);
  const normalized = {
    title: cleanSpoken(script.title || rundown.title).slice(0, 80) || rundown.title,
    summary: cleanSpoken(script.summary || '').slice(0, 400),
    tickerItems: arr(script.tickerItems).map(t => cleanSpoken(t).slice(0, 80)).filter(Boolean).slice(0, 12),
    segments,
    memoryUpdates: {
      storylines: arr(mu.storylines).filter(s => s && s.key && s.text).slice(0, 8),
      predictions: arr(mu.predictions).filter(p => p && personaIds.includes(p.persona) && p.text).slice(0, 8),
      moods: arr(mu.moods).filter(m => m && personaIds.includes(m.persona) && m.mood).slice(0, 8),
    },
    words,
  };
  return { ok: errors.length === 0, errors, warnings, script: normalized };
}

module.exports = { validateScript, factNumberSet, numbersIn, cleanSpoken };
