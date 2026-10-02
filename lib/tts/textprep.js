// Turns a script line into what the TTS engine should read. Captions keep the
// original text; only the voice hears this version.
'use strict';
const { asciiFold } = require('../util');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ABBREVIATIONS = [
  [/\bTDs\b/g, 'touchdowns'], [/\bTD\b/g, 'touchdown'],
  [/\bINTs\b/g, 'interceptions'], [/\bINT\b/g, 'interception'],
  [/\byds\b/gi, 'yards'], [/\byd\b/gi, 'yard'],
  [/\bQBs\b/g, 'quarterbacks'], [/\bQB\b/g, 'quarterback'],
  [/\bWRs\b/g, 'receivers'], [/\bWR\b/g, 'receiver'],
  [/\b[HR]B\b/g, 'running back'], [/\bTE\b/g, 'tight end'],
  [/\bOVR\b/g, 'overall'], [/\bFGs?\b/g, 'field goal'],
  [/\bvs\.?(?=\s)/gi, 'versus'], [/\bw\/(?=\s)/gi, 'with'],
  [/\bX-Factor\b/gi, 'X Factor'],
  [/\bGOTW\b/g, 'Game of the Week'],
];

// Words before a record ("improve to 6-2") read it as "6 and 2"; every other
// dash pair is a score ("won 28-3" → "28 to 3").
const RECORD_LEAD = /(\b(?:improve|improves|improved|fall|falls|fell|drop|drops|dropped|move|moves|moved|sit|sits|sitting|at|to|now|record of|are|is|go|goes|went|start|starts|started)\s+)(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?\b/gi;

function prepareSpeech(text, { network = {}, pronunciations = {} } = {}) {
  let s = asciiFold(text);
  for (const [from, to] of Object.entries(pronunciations || {})) {
    if (from.trim()) s = s.replace(new RegExp(`\\b${escapeRe(from.trim())}\\b`, 'gi'), to);
  }
  if (network.name && network.spoken) s = s.replace(new RegExp(escapeRe(network.name), 'g'), network.spoken);
  if (network.leagueShort && network.leagueSpoken) s = s.replace(new RegExp(`\\b${escapeRe(network.leagueShort)}\\b`, 'g'), network.leagueSpoken);
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(RECORD_LEAD, (m, lead, a, b, c) => `${lead}${a} and ${b}${c ? ` and ${c}` : ''}`);
  s = s.replace(/\b(\d{1,3})-(\d{1,3})\b/g, '$1 to $2');
  s = s.replace(/\$(\d+(?:\.\d+)?)\s?M\b/g, '$1 million dollars')
    .replace(/\$(\d+(?:\.\d+)?)\s?K\b/g, '$1 thousand dollars')
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars');
  s = s.replace(/(\d)%/g, '$1 percent').replace(/&/g, ' and ').replace(/\s@\s/g, ' at ')
    .replace(/[→]/g, ' to ').replace(/[•|]/g, ', ').replace(/\s+/g, ' ').trim();
  return s;
}

// Kokoro handles roughly 500 phonemes per call; long lines are voiced
// sentence by sentence and stitched together.
function splitForSpeech(text, maxChars = 220) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [text];
  const out = [];
  let cur = '';
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (cur && (cur + ' ' + s).length > maxChars) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  // A single sentence can still be too long: break it at commas.
  return out.flatMap(p => (p.length <= maxChars * 1.6 ? [p] : p.split(/,\s+/).filter(Boolean)));
}

module.exports = { prepareSpeech, splitForSpeech };
