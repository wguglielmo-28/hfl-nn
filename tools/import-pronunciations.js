#!/usr/bin/env node
// Builds config/pronunciations.json from config/pronunciation-guide.tsv (the
// commissioner's NFL Pronunciation Guide).
//
// The guide writes respellings for people ("al-JEER", "TOO-uh TUNG-oh-vai-LOA").
// Fed to Kokoro as text they go wrong: espeak-ng spells capitalised chunks out
// as letters ("KEY" → "K E Y") and stresses every hyphenated syllable. So for
// each name this works out:
//   - which part of the name the respelling covers (first, last or both),
//   - the respelling itself (ElevenLabs reads these well as written),
//   - Kokoro phonemes: every syllable phonemized in lowercase by the same
//     espeak-ng Kokoro uses, with primary stress only on the syllables the
//     guide capitalises (the first syllable when it capitalises none).
// lib/tts/lexicon.js applies the result to every line before it is voiced.
//
//   node tools/import-pronunciations.js            rebuild
//   node tools/import-pronunciations.js --review   also list the low-confidence matches
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { asciiFold } = require('../lib/util');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'config', 'pronunciation-guide.tsv');
const OUT = path.join(ROOT, 'config', 'pronunciations.json');

// Where the guide's wording isn't a respelling, or espeak can't read it,
// what we use instead. Each says why.
const OVERRIDES = {
  'Bijan Robinson': { said: 'bih-ZHAHN', why: 'the guide writes "buh-Xian"; espeak reads the X as Z' },
  'Tahj Brooks': { said: 'TAHZH', why: 'the guide says "second syllable of montage"' },
  'Nick Broeker': { said: 'BROH-ker', why: 'the guide says "rhymes with broker"' },
  'Scott Fuchs': { said: 'FOOKS', why: 'the guide says "rhymes with books"' },
  'Billy Schrauth': { said: 'SHROWTH', ipa: { Schrauth: 'ˈʃɹaʊθ' }, why: 'the guide says "like South"' },
  'Jamien Sherwood': { said: 'JAY-mee-en', why: 'the guide says "like Damien"' },
  'Tyler Bass': { said: 'BAS', why: 'BASS like the fish; espeak reads "bass" as the instrument' },
  'Darius Muasau': { said: 'MOO-uh-sau', why: '"sow" like cow' },
  'Cody Mauch': { said: 'MOUK', why: 'the guide writes "m(OW)k"' },
  'Eli Stowers': { said: 'STOW-erz', ipa: { Stowers: 'ˈstaʊɚz' }, why: '"STOW-ers", rhymes with hours' },
  'Jonah Savaiinaea': { said: 'suh-vai-ee-NEYE-uh', why: 'the guide writes "suh-vaiʻi-neye-uh (like Hawaiʻi)"' },
  'Andre Szmyt': { said: 'SHMIT', why: 'the guide writes "sch-MITT"' },
  // The guide writes the soft sound as "gee" (Ajiake, "AH-gee-kay") and the
  // hard one as "gh"; here it spells out "hard g" instead.
  'Mike Gesicki': { said: 'gheh-SICK-ee', why: 'the guide says "geh (hard g)"' },
  // The guide's "O-LIE-vuh-VENG-uh" is his full first name, Olaivavega; the
  // roster says Vega, so only the last name is taken.
  'Vega Ioane': { parts: { Ioane: 'yo-WAHN-ay' }, why: 'the first part spells out Olaivavega, not Vega' },
  'Chau Smith-Wade': { parts: { Chau: 'Shaw' }, why: '"Shaw" is how Chau is said' },
  'Danny van Dijk': { parts: { 'van Dijk': 'van DIKE' }, why: '"dike" is the last name' },
  'Febechi Nwaiwu': { parts: { Febechi: 'feh-BETCH-ee', Nwaiwu: 'WEE-woo' }, why: 'first and last name in one respelling' },
  'Odafe Oweh': { parts: { Odafe: 'uh-DAH-fay', Oweh: 'oh-WAY' }, why: 'first and last name in one respelling' },
};

const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;
const PARTICLES = new Set(['de', 'van', 'von', 'st.', 'da', 'la', 'le', 'del', 'di']);

// Names people say on their own: a guide entry for "Tyler Allgeier" must not
// rewrite every Tyler. Common English first names and words that are also
// surnames only change as part of the full name.
const COMMON = new Set(`aaron adam alan albert alex andre andrew andy anthony ashton austin bass beau ben benjamin billy black blake blue brandon brett brian brock brown bryce cam cameron carson casey chad charles charlie chase chris christian cody cole connor cooper corey dan daniel danny david davis dee devin devon dillon dominic drew dylan eli eric ethan evan felix foster fox george grant gray greg green grey hank harrison height henry hunt hunter isaac isaiah israel jack jackson jacob jake james jason jay jeff jeffrey jerry jesse jimmy joe joey john johnson jonah jonas jones jordan joseph josh joshua justin keith kelly kevin king kyle lane larry leo levi logan lou love lucas luke malik marc marcus mark marshall mason matt max michael mike miller mitch mitchell morris nate neal nick noah nolan oliver omar owen pat patrick paul pete peter price quinton reed reese rex rice rico rob robert robinson rock roman rome ross ryan sam sean shane smith spencer stephen steve stout taylor terry thomas tommy tony travis trent trevor trey troy ty tyler wade walker ward wells wes west wheat white will williams wright york young zach zack
ale cato christen dare dike divine lux pharaoh pole sincere smile sunday tip upton vita`.split(/\s+/));

const fold = s => asciiFold(s).replace(/ʻ/g, '');

function coreTokens(name) {
  // A nickname in quotes is said in place of the first name.
  const nick = name.match(/"([^"]+)"/);
  const words = fold(name.replace(/"[^"]+"/, nick ? nick[1] : '')).split(/\s+/).filter(Boolean).filter(w => !SUFFIX.test(w));
  // "Ryan Van Demark", "Jacob De Jesus", "Amon-Ra St. Brown": the particle
  // belongs to the last name.
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (i > 0 && i < words.length - 1 && PARTICLES.has(words[i].toLowerCase())) { out.push(words.slice(i).join(' ')); break; }
    out.push(words[i]);
  }
  return out;
}

function cleanGuide(p) {
  let s = fold(p).replace(/\([^)]*\)/g, ' ');
  const phrase = s.match(/^\s*(?:rhymes with|pronounced as|like)\s+"?([^"]+?)"?\s*$/i);
  if (phrase) s = phrase[1];
  return s.replace(/\s+-/g, '-').replace(/-\s+/g, '-').replace(/\s+/g, ' ').trim();
}

// A crude sound-alike key for matching a respelling to a name part.
function key(s) {
  return fold(s).toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/ck|q|c(?=[aou]|$)|ch(?=r)/g, 'k').replace(/x/g, 'ks')
    .replace(/(.)\1+/g, '$1').replace(/[aeiouyhw]+/g, 'a');
}
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out.length ? out : [s]; }
function similarity(said, token) {
  const a = key(said), b = key(token);
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  const pool = [...B];
  let hit = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  const dice = (2 * hit) / (A.length + B.length);
  return dice + (a[0] === b[0] ? 0.15 : 0);
}

// Every way to lay k respelled words over the name: one group per name part,
// over a run of consecutive parts, or everything on a single part.
function assignments(words, tokens) {
  const out = [];
  const n = tokens.length;
  // Split the words into g contiguous groups for every run of g consecutive tokens.
  const splits = (arr, g) => {
    if (g === 1) return [[arr]];
    const res = [];
    for (let i = 1; i <= arr.length - g + 1; i++) for (const rest of splits(arr.slice(i), g - 1)) res.push([arr.slice(0, i), ...rest]);
    return res;
  };
  for (let g = 1; g <= Math.min(words.length, n); g++) {
    for (let start = 0; start + g <= n; start++) {
      for (const groups of splits(words, g)) out.push(groups.map((grp, i) => ({ token: tokens[start + i], said: grp.join(' ') })));
    }
  }
  return out;
}

function bestAssignment(said, tokens) {
  // The guide separates first and last name with " / " or ", ".
  const explicit = /\s\/\s|,\s/.test(said) ? said.split(/\s*\/\s*|,\s*/).filter(Boolean) : null;
  const words = explicit || said.split(' ');
  // A hyphenated name part can be covered alone: "Smith-Njigba" by "in-JIGG-buh".
  const candidates = [...new Set(tokens)];
  let best = null;
  for (const a of assignments(words, candidates)) {
    if (explicit && a.length !== Math.min(words.length, candidates.length)) continue;
    const score = a.reduce((sum, x) => sum + similarity(x.said, x.token), 0) / a.length;
    if (!best || score > best.score) best = { parts: a, score };
  }
  // Single-word respellings may cover one piece of a hyphenated part.
  if (!explicit && words.length === 1) {
    for (const t of tokens) {
      if (!t.includes('-')) continue;
      for (const piece of t.split('-')) {
        const score = similarity(said, piece);
        if (score > best.score + 0.05) best = { parts: [{ token: t, piece, said }], score };
      }
    }
  }
  return best;
}

async function main() {
  const { phonemize } = await import(pathToFileURL(require.resolve('phonemizer')).href);
  const cache = new Map();
  const syllable = async s => {
    if (!cache.has(s)) cache.set(s, (await phonemize(s, 'en-us')).join('').replace(/[ˈˌ\s]/g, ''));
    return cache.get(s);
  };
  // "al-JEER" → ælˈdʒɪɹ: stress only where the guide capitalises.
  const ipaOf = async said => {
    const words = [];
    for (const word of said.split(/\s+/)) {
      const raw = word.split('-').map(x => x.replace(/[^A-Za-z]/g, '')).filter(Boolean);
      if (!raw.length) continue;
      // A chunk with no vowel ("muh-LEE-k", "krew-tz", "Sh-RAID-err") would be
      // read as letter names; it joins its neighbour instead. A lone leading
      // "r" or "x" is the letter sound ("r-CURE-e", "x-ZAY-vian").
      const syls = [], stressed = [];
      for (let i = 0; i < raw.length; i++) {
        const s = raw[i];
        const caps = s.length > 1 && s === s.toUpperCase();
        if (i === 0 && /^[rRxX]$/.test(s)) { syls.push(/^[xX]$/.test(s) ? 'ex' : 'ar'); stressed.push(false); continue; }
        if (!/[aeiouyAEIOUY]/.test(s)) {
          if (syls.length) { syls[syls.length - 1] += s; stressed[stressed.length - 1] ||= caps; } else if (raw[i + 1]) raw[i + 1] = s + raw[i + 1];
          continue;
        }
        syls.push(s);
        stressed.push(caps);
      }
      if (!syls.length) continue;
      if (!stressed.some(Boolean)) stressed[0] = true;
      let ipa = '';
      for (let i = 0; i < syls.length; i++) {
        const spelt = syls[i].toLowerCase();
        let p = await syllable(spelt);
        // On its own espeak says "er" the British way; in an American name an
        // unstressed "-er" is ɚ and a stressed one keeps its r.
        if (/[eiu]rr?[dsz]?$/.test(spelt)) p = p.replace(/(ɜː|ɛɹ)(?=[dsz]?$)/, stressed[i] ? 'ɜːɹ' : 'ɚ');
        ipa += (stressed[i] ? 'ˈ' : '') + p;
      }
      words.push(ipa);
    }
    return words.join(' ');
  };

  const rows = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'));
  const entries = [];
  const review = [];
  for (const [team, name, guide] of rows) {
    if (!name || !guide) continue;
    const tokens = coreTokens(name);
    const o = OVERRIDES[name];
    let parts;
    let score = 1;
    if (o?.parts) {
      parts = Object.entries(o.parts).map(([token, said]) => ({ token, said }));
    } else {
      const best = bestAssignment(cleanGuide(o?.said || guide), tokens);
      parts = best.parts;
      score = best.score;
    }
    // An override can give the phonemes outright where espeak can't be steered.
    for (const p of parts) p.ipa = o?.ipa?.[p.token] || await ipaOf(p.said);
    const entry = { name: fold(name.replace(/"[^"]+"\s*/, '')), team, guide, parts };
    if (o) entry.override = o.why;
    entries.push(entry);
    if (score < 0.45 && !o) review.push({ name, guide, parts: parts.map(p => `${p.piece || p.token} = ${p.said}`).join('; '), score: +score.toFixed(2) });
  }

  // Name parts said alone (usually the last name): only when every entry
  // that covers that part agrees, and it isn't an everyday name or word.
  const byPart = new Map();
  for (const e of entries) {
    for (const p of e.parts) {
      const k = p.piece ? null : p.token;
      if (!k || k.length < 3) continue;
      if (!byPart.has(k)) byPart.set(k, []);
      byPart.get(k).push({ e, p });
    }
  }
  const alone = {};
  const skipped = [];
  for (const [part, uses] of byPart) {
    const said = new Set(uses.map(u => u.p.said.toLowerCase().replace(/[^a-z]/g, '')));
    const everyday = part.split(/[\s-]/).every(w => COMMON.has(w.toLowerCase()));
    // Same spelling on another guide entry without a respelling for that part:
    // e.g. a first name here that is somebody else's last name.
    if (said.size > 1) { skipped.push(`${part} (said differently by ${uses.map(u => u.e.name).join(', ')})`); continue; }
    if (everyday) continue;
    alone[part] = { said: uses[0].p.said, ipa: uses[0].p.ipa };
  }

  const out = {
    about: 'Generated by tools/import-pronunciations.js from config/pronunciation-guide.tsv. Do not edit by hand; edit the guide and rerun.',
    generatedAt: new Date().toISOString(),
    entries,
    alone,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`${entries.length} names, ${Object.keys(alone).length} name parts that also work alone, ${Object.keys(OVERRIDES).length} overrides.`);
  if (skipped.length) console.log(`Only as full names (said two ways): ${skipped.join('; ')}`);
  if (process.argv.includes('--review')) {
    console.log(`\nLow-confidence matches (${review.length}):`);
    for (const r of review.sort((a, b) => a.score - b.score)) console.log(`  ${r.score}  ${r.name} | ${r.guide}  →  ${r.parts}`);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { coreTokens, cleanGuide, similarity, bestAssignment };
