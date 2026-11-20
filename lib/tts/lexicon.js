// The NFL pronunciation guide, applied to what the voices read.
//
// config/pronunciations.json (built by tools/import-pronunciations.js from the
// commissioner's guide) gives, per name, the respelling and Kokoro phonemes
// for the part of the name the guide covers. Every guide name in a line is
// marked as [[ipa:<phonemes>|<respelling>]]:
//   - Kokoro reads the phonemes (lib/tts/phonemes.js),
//   - ElevenLabs and the silent provider get the respelling (spokenText),
//   - captions never see any of it (they keep the script's own text).
// Full names always match. A name part said alone ("Allgeier") matches only
// when the guide has one way to say it and it isn't an everyday name or
// word; both match case-sensitively, so "pole position" stays put.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'pronunciations.json');
const MARK = /\[\[ipa:([^|\]]+)\|([^\]]*)\]\]/g;
const SUFFIX = /\s+(?:Jr\.?|Sr\.?|II|III|IV|V)$/;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mark = (ipa, said) => `[[ipa:${ipa}|${said}]]`;
const hasMarks = text => text.includes('[[ipa:');
// What a voice without phoneme input should read.
const spokenText = text => String(text).replace(MARK, (m, ipa, said) => said);

function buildRules(data) {
  const rules = [];
  const add = (key, replace) => {
    if (!key || key.length < 3) return;
    // Letters or digits may not touch the name; a possessive is voiced too.
    rules.push({ key, re: new RegExp(`(?<![A-Za-z0-9'])${escapeRe(key)}('s)?(?![A-Za-z0-9])`, 'g'), replace });
  };
  const possessive = (ipa, said, s) => (s ? mark(`${ipa}z`, `${said}'s`) : mark(ipa, said));

  for (const e of data.entries || []) {
    const name = e.name.replace(SUFFIX, '');
    // The full name with each covered part marked, the rest left as text.
    add(name, (m, s) => {
      let out = name;
      for (const p of e.parts) {
        const target = p.piece || p.token;
        if (out.includes(target)) out = out.replace(target, () => mark(p.ipa, p.said));
      }
      if (!s) return out;
      const last = e.parts.find(p => name.endsWith(p.piece || p.token));
      return last ? `${out.slice(0, out.lastIndexOf('[[ipa:'))}${possessive(last.ipa, last.said, s)}` : `${out}'s`;
    });
  }
  for (const [part, v] of Object.entries(data.alone || {})) add(part, (m, s) => possessive(v.ipa, v.said, s));
  // Longest first, so "Tua Tagovailoa" is handled before "Tagovailoa".
  return rules.sort((a, b) => b.key.length - a.key.length);
}

let cached = null;
function defaultRules() {
  if (!cached) {
    try { cached = buildRules(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cached = []; }
  }
  return cached;
}

// Marks every guide name in `text`. Text already marked is left alone: each
// new mark becomes its own piece, so later, shorter rules can't reach inside.
const SPLIT = /(\[\[ipa:[^\]]*\]\])/;
function applyLexicon(text, rules = defaultRules()) {
  if (!rules.length) return text;
  let parts = [String(text)];
  for (const r of rules) {
    parts = parts.flatMap(p => (p.startsWith('[[ipa:') || !p.includes(r.key) ? [p] : p.replace(r.re, r.replace).split(SPLIT).filter(Boolean)));
  }
  return parts.join('');
}

module.exports = { applyLexicon, buildRules, defaultRules, spokenText, hasMarks, MARK };
