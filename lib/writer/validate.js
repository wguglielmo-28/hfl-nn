// Checks a script against its rundown before it is voiced, and normalizes it.
//
// Errors block voicing (and trigger the writer's one repair pass); warnings
// are shown to the commissioner in the review screen. The number check is
// the main accuracy guard: any figure an anchor says that appears nowhere in
// the facts the writer was given is flagged for a human to look at.
'use strict';
const { EMOTIONS, GESTURES, SHOTS } = require('./schema');
const { ARC_STATUS, CASE_STATUS, REL_CHANGE, DECIDED_BY } = require('../memory');
const { wordCount, asciiFold } = require('../util');
const { officialNames } = require('./names');

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

function validateScript(script, { rundown, personaIds, factNumbers = new Set(), nicknames = null }) {
  const errors = [], warnings = [];
  // Spoken and on-screen text: cleaned, then held to official league and team names.
  const swaps = {};
  const say = t => officialNames(cleanSpoken(t), { nicknames, swaps }).text;
  if (!script || typeof script !== 'object') {
    return { ok: false, errors: ['Script is not an object'], warnings, script: null };
  }
  const bySeg = new Map((Array.isArray(script.segments) ? script.segments : []).map(s => [s && s.id, s]));
  for (const id of bySeg.keys()) {
    if (!rundown.segments.some(s => s.id === id)) warnings.push(`Dropped segment "${id}": not in the rundown`);
  }

  const unknownNumbers = new Set();
  // Cameos: one anchor from outside a segment's cast, two lines at most, in
  // up to rundown.cameos segments. Anything past that is flagged.
  const cameoBudget = rundown.cameos ?? 0;
  let cameoSegments = 0;
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
    const outsiders = new Map();
    src.lines.forEach((ln, i) => {
      const where = `${seg.id} line ${i + 1}`;
      if (!ln || typeof ln !== 'object') { errors.push(`${where}: not an object`); return; }
      if (!personaIds.includes(ln.speaker)) { errors.push(`${where}: unknown speaker "${ln.speaker}"`); return; }
      const text = say(ln.text);
      if (!text) { errors.push(`${where}: empty text`); return; }
      if (text.length > MAX_LINE * 2) errors.push(`${where}: line is ${text.length} characters; split it up`);
      else if (text.length > MAX_LINE) warnings.push(`${where}: long line (${text.length} characters)`);
      if (PROFANITY.test(text)) errors.push(`${where}: profanity is off-limits on HFL-NN`);
      if (!seg.cast.includes(ln.speaker)) outsiders.set(ln.speaker, (outsiders.get(ln.speaker) || 0) + 1);
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
    if (outsiders.size) {
      cameoSegments++;
      const ok = outsiders.size === 1 && [...outsiders.values()][0] <= 2 && cameoSegments <= cameoBudget;
      if (!ok) warnings.push(`${seg.id}: ${[...outsiders.keys()].join(', ')} ${outsiders.size === 1 ? "isn't" : "aren't"} in this segment's cast (more than tonight's cameo budget allows)`);
    }
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
  const named = t => officialNames(t, { nicknames }).text;
  const normalized = {
    title: say(script.title || rundown.title).slice(0, 80) || rundown.title,
    summary: say(script.summary || '').slice(0, 400),
    tickerItems: arr(script.tickerItems).map(t => say(t).slice(0, 80)).filter(Boolean).slice(0, 12),
    segments,
    fanPoll: normalizePoll(script.fanPoll, { personaIds, say, warnings }),
    memoryUpdates: {
      storylines: arr(mu.storylines).filter(s => s && s.key && (s.beat || s.text || s.title)).slice(0, 8).map(s => ({
        key: String(s.key).trim().slice(0, 80),
        title: named(String(s.title || '')).slice(0, 120),
        beat: named(String(s.beat || s.text || '')).slice(0, 400),
        status: ARC_STATUS.includes(s.status) ? s.status : 'building',
        teams: arr(s.teams).map(t => String(t).trim().toUpperCase()).filter(t => /^[A-Z]{2,4}$/.test(t)).slice(0, 4),
        stakes: named(String(s.stakes || '')).slice(0, 200),
        nextBeat: named(String(s.nextBeat || '')).slice(0, 200),
        champion: personaIds.includes(s.champion) ? s.champion : '',
        skeptic: personaIds.includes(s.skeptic) ? s.skeptic : '',
      })),
      predictions: arr(mu.predictions).filter(p => p && personaIds.includes(p.persona) && p.text).slice(0, 8).map(p => ({ ...p, text: named(p.text) })),
      moods: arr(mu.moods).filter(m => m && personaIds.includes(m.persona) && m.mood).slice(0, 8),
      relationships: arr(mu.relationships).filter(r => r && personaIds.includes(r.a) && personaIds.includes(r.b) && r.a !== r.b).slice(0, 6)
        .map(r => ({ a: r.a, b: r.b, change: REL_CHANGE.includes(r.change) ? r.change : 'steady', flashpoint: named(String(r.flashpoint || '')).slice(0, 300) })),
      arguments: arr(mu.arguments).filter(x => x && x.topic).slice(0, 4).map(x => {
        const winner = personaIds.includes(x.winner) ? x.winner : '';
        const loser = personaIds.includes(x.loser) && x.loser !== winner ? x.loser : '';
        return { topic: named(String(x.topic)).slice(0, 200), winner, loser, decidedBy: DECIDED_BY.includes(x.decidedBy) ? x.decidedBy : '' };
      }),
      caseFile: arr(mu.caseFile).filter(c => c && c.key && (c.evidence || c.title)).slice(0, 3).map(c => ({
        key: String(c.key).trim().slice(0, 80),
        title: named(String(c.title || '')).slice(0, 160),
        evidence: named(String(c.evidence || '')).slice(0, 300),
        status: CASE_STATUS.includes(c.status) ? c.status : 'open',
        believer: personaIds.includes(c.believer) ? c.believer : '',
      })),
    },
    words,
  };
  const swapped = Object.entries(swaps);
  if (swapped.length) warnings.push(`Swapped in official names: ${swapped.map(([k, n]) => (n > 1 ? `${k} (${n}x)` : k)).join(', ')}`);
  return { ok: errors.length === 0, errors, warnings, script: normalized };
}

// The viewer poll: Discord allows 300 characters a question, 55 an answer and
// 10 answers; HFL-NN keeps it to a short question and 2 to 4 sides. A poll
// that doesn't fit is dropped with a warning rather than blocking the show.
function normalizePoll(poll, { personaIds, say, warnings }) {
  if (!poll || typeof poll !== 'object' || !String(poll.question || '').trim()) return null;
  const question = say(poll.question).slice(0, 300);
  const seen = new Set();
  const answers = (Array.isArray(poll.answers) ? poll.answers : [])
    .map(a => ({ text: say(a?.text || '').slice(0, 55).trim(), persona: personaIds.includes(a?.persona) ? a.persona : '' }))
    .filter(a => a.text && !seen.has(a.text.toLowerCase()) && seen.add(a.text.toLowerCase()))
    .slice(0, 4);
  if (!question || answers.length < 2) {
    warnings.push('Dropped the fan poll: it needs a question and at least 2 different answers');
    return null;
  }
  return { question, answers };
}

module.exports = { validateScript, normalizePoll, factNumberSet, numbersIn, cleanSpoken };
