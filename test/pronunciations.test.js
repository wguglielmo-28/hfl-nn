'use strict';
// The NFL pronunciation guide: config/pronunciations.json, lib/tts/lexicon.js,
// lib/tts/phonemes.js and tools/import-pronunciations.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLexicon, spokenText, hasMarks, defaultRules } = require('../lib/tts/lexicon');
const { prepareSpeech } = require('../lib/tts/textprep');
const { createTTS } = require('../lib/tts');
const { createElevenLabsProvider } = require('../lib/tts/elevenlabs');
const { coreTokens, cleanGuide, bestAssignment } = require('../tools/import-pronunciations');
const data = require('../config/pronunciations.json');

const hasPhonemizer = (() => { try { require.resolve('phonemizer'); return true; } catch { return false; } })();

test('the guide is built: every name has phonemes, and risky single names only work as full names', () => {
  assert.ok(data.entries.length >= 830, `${data.entries.length} names`);
  for (const e of data.entries) {
    assert.ok(e.parts.length, e.name);
    for (const p of e.parts) assert.ok(p.ipa && !/[[\]|]/.test(p.ipa), `${e.name}: ${p.ipa}`);
  }
  assert.ok(data.alone.Allgeier, 'a distinctive last name works alone');
  assert.equal(data.alone.Xavier, undefined, 'said seven different ways: full names only');
  assert.equal(data.alone.Pole, undefined, 'an everyday word: full names only');
  assert.equal(data.alone.Seumalo, undefined, 'two players, two pronunciations');
  assert.ok(defaultRules().length > 1500);
});

test('names are marked with phonemes and respelling; everything else is left alone', () => {
  const m = applyLexicon("Tyler Allgeier ran. Allgeier's day, Tua Tagovailoa to Jaxon Smith-Njigba. Xavier Watts and Xavier. Esa Pole on pole position.");
  assert.match(m, /^Tyler \[\[ipa:ælˈdʒɪɹ\|al-JEER\]\] ran\./, 'the full name, with only the part the guide covers marked');
  assert.match(m, /\[\[ipa:ælˈdʒɪɹz\|al-JEER's\]\] day/, 'a last name alone, possessive voiced');
  assert.match(m, /\[\[ipa:[^|]+\|TOO-uh\]\] \[\[ipa:[^|]+\|TUNG-oh-vai-LOA\]\]/);
  assert.match(m, /Jaxon Smith-\[\[ipa:[^|]+\|in-JIGG-buh\]\]/, 'one half of a hyphenated name');
  assert.match(m, /\[\[ipa:[^|]+\|ex-AY-vee-er\]\] Watts and Xavier\./, 'Xavier alone stays as written');
  assert.match(m, /on pole position\.$/);
  assert.equal(spokenText(m).includes('[['), false);
  assert.match(spokenText(m), /^Tyler al-JEER ran\. al-JEER's day, TOO-uh TUNG-oh-vai-LOA/);
  assert.equal(applyLexicon('Nobody from the guide here.'), 'Nobody from the guide here.');
  assert.equal(applyLexicon(m), m, 'marking twice changes nothing');
});

test('speech prep marks names last, and your own Settings → Pronunciations still win', () => {
  const p = prepareSpeech('Mecole Hardman Jr. caught 2 TDs | Tyler Allgeier 28-3');
  assert.match(p, /\[\[ipa:[^|]+\|muh-COLE\]\] Hardman Jr\. caught 2 touchdowns ?, Tyler \[\[ipa:ælˈdʒɪɹ\|al-JEER\]\] 28 to 3/);
  assert.equal(prepareSpeech('Tyler Allgeier', { pronunciations: { Allgeier: 'Al Jeer' } }), 'Tyler Al Jeer');
  assert.equal(prepareSpeech('Tyler Allgeier', { lexicon: false }), 'Tyler Allgeier');
  assert.ok(!hasMarks(prepareSpeech('Season IX opens with the Bills.')));
});

test('ElevenLabs and the silent voice read the respelling, never the marks', async () => {
  const sent = [];
  const request = async r => { sent.push(JSON.parse(r.body).text); return { status: 200, body: Buffer.alloc(4800) }; };
  const eleven = createElevenLabsProvider({ apiKey: 'xi-test', request });
  const tts = createTTS({ provider: 'silent', elevenlabs: eleven });
  await tts.speak(prepareSpeech('Tyler Allgeier scores.'), { voice: 'eleven:JBFqnCBsd6RMkjVDRZzb' });
  assert.deepEqual(sent, ['Tyler al-JEER scores.']);
  const silent = await tts.speak(prepareSpeech('Tua Tagovailoa'), { voice: 'am_michael' });
  assert.ok(silent.samples.length > 0);
});

test('Kokoro phonemes: guide names verbatim, the rest through espeak-ng as kokoro-js does', { skip: !hasPhonemizer && 'phonemizer (optional) not installed' }, async () => {
  const { phonemesFor, langFor } = require('../lib/tts/phonemes');
  const ph = await phonemesFor(prepareSpeech('Tyler Allgeier ran, then Allgeier scored!'), 'am_michael');
  assert.match(ph, /ælˈdʒɪɹ ɹˈæn, /, 'punctuation kept as its own token');
  assert.equal((ph.match(/ælˈdʒɪɹ/g) || []).length, 2);
  assert.ok(!/[[\]|]/.test(ph));
  assert.match(ph, /!$/);
  assert.equal(langFor('bm_george'), 'en');
  assert.equal(langFor('am_onyx'), 'en-us');
});

test('importer: which part of a name a respelling covers', () => {
  assert.deepEqual(coreTokens('Ryan Van Demark'), ['Ryan', 'Van Demark']);
  assert.deepEqual(coreTokens('Wydett Williams Jr.'), ['Wydett', 'Williams']);
  assert.deepEqual(coreTokens('Francis "Sisi" Mauigoa'), ['Francis', 'Sisi', 'Mauigoa'], 'the nickname is a part of its own');
  assert.equal(cleanGuide('rhymes with broker'), 'broker');
  assert.equal(cleanGuide('DUG-er (first syllable pronounced as "Doug")'), 'DUG-er');
  assert.equal(cleanGuide('geh (hard "g") -SICK-ee'), 'geh-SICK-ee');
  const parts = (said, name) => bestAssignment(cleanGuide(said), coreTokens(name)).parts.map(p => `${p.piece || p.token}=${p.said}`);
  assert.deepEqual(parts('al-JEER', 'Tyler Allgeier'), ['Allgeier=al-JEER']);
  assert.deepEqual(parts('KEY-trell', "Kei'Trel Clark"), ["Kei'Trel=KEY-trell"]);
  assert.deepEqual(parts('SIM-ee / FAY-ho-ko', 'Simi Fehoko'), ['Simi=SIM-ee', 'Fehoko=FAY-ho-ko']);
  assert.deepEqual(parts('TOO-uh TUNG-oh-vai-LOA', 'Tua Tagovailoa'), ['Tua=TOO-uh', 'Tagovailoa=TUNG-oh-vai-LOA']);
  assert.deepEqual(parts('van duh-MARK', 'Ryan Van Demark'), ['Van Demark=van duh-MARK']);
  assert.deepEqual(parts('in-JIGG-buh', 'Jaxon Smith-Njigba'), ['Njigba=in-JIGG-buh']);
  assert.deepEqual(parts('al kwah-DEEN moo-HAH-mud', 'Al-Quadin Muhammad'), ['Al-Quadin=al kwah-DEEN', 'Muhammad=moo-HAH-mud']);
});
