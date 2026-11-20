// Kokoro phonemes for a line with pronunciation-guide marks in it.
//
// kokoro-js has no inline-phoneme syntax: generate(text) runs the text through
// espeak-ng and then the model. For a line with guide names (lib/tts/lexicon.js
// marks), the worker builds the phonemes itself and hands them to the model:
// ordinary text goes the way kokoro-js 1.2.1 sends it (punctuation kept as its
// own tokens, words through espeak-ng, the same clean-ups afterwards), and each
// mark contributes the guide's phonemes untouched. Lines without marks never
// come here; they still use kokoro-js's own generate().
'use strict';
const { MARK } = require('./lexicon');

const PUNCT_CHARS = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT = new RegExp(`(\\s*[${PUNCT_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

let phonemizer = null;
async function espeak() {
  if (!phonemizer) phonemizer = (await import('phonemizer')).phonemize;
  return phonemizer;
}

// American voices (a…) use en-us, British voices (b…) en, as kokoro-js does.
const langFor = voice => (String(voice || 'a')[0] === 'b' ? 'en' : 'en-us');

async function plain(text, lang) {
  const phonemize = await espeak();
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (m.index > last) pieces.push({ text: text.slice(last, m.index) });
    pieces.push({ text: m[0], punct: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  const out = await Promise.all(pieces.map(async p => (p.punct || !p.text.trim() ? p.text : (await phonemize(p.text, lang)).join(' '))));
  return out.join('');
}

// kokoro-js's post-processing of espeak output.
function tidy(s, lang) {
  let out = s.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ').replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'en-us') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out;
}

async function phonemesFor(text, voice) {
  const lang = langFor(voice);
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(MARK)) {
    if (m.index > last) out.push(await plain(text.slice(last, m.index), lang));
    out.push(` ${m[1]} `);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(await plain(text.slice(last), lang));
  return tidy(out.join('').replace(/\s+/g, ' ').replace(/ ([;:,.!?…])/g, '$1').trim(), lang);
}

module.exports = { phonemesFor, langFor };
