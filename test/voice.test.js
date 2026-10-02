'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareSpeech, splitForSpeech } = require('../lib/tts/textprep');
const { createTTS } = require('../lib/tts');
const { buildEpisodeAudio, FPS } = require('../lib/audio/mixer');
const { encodeWav, decodeWav } = require('../lib/audio/wav');
const { jingle, JINGLE_NAMES } = require('../lib/audio/jingles');
const { writeEpisodeAudio } = require('../lib/audio/encode');
const personas = require('../config/personas.json');
const { tmpDir } = require('./helpers');

test('speech prep reads scores, records, money and stat shorthand aloud', () => {
  const p = t => prepareSpeech(t, { network: personas.network });
  assert.equal(p('Jags stun Commanders 23-14'), 'Jags stun Commanders 23 to 14');
  assert.equal(p('The Ravens improve to 6-2.'), 'The Ravens improve to 6 and 2.');
  assert.equal(p('Welcome to HFL-NN Tonight'), 'Welcome to H F L N N Tonight');
  assert.equal(p('Best team in the HFL.'), 'Best team in the H F L.');
  assert.equal(p('5 TDs and 308 yds'), '5 touchdowns and 308 yards');
  assert.equal(p('A $45.5M deal'), 'A 45.5 million dollars deal');
  assert.equal(prepareSpeech('Ja’Marr Chase', { pronunciations: { "Ja'Marr": 'Juh Mar' } }), 'Juh Mar Chase');
});

test('long lines split into sentence-sized chunks', () => {
  const long = 'One sentence here. '.repeat(30).trim();
  const parts = splitForSpeech(long, 120);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 192));
  assert.equal(parts.join(' '), long);
  assert.deepEqual(splitForSpeech('Short line.'), ['Short line.']);
});

test('WAV round trip', () => {
  const s = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const back = decodeWav(encodeWav(s, 24000));
  assert.equal(back.sampleRate, 24000);
  for (let i = 0; i < s.length; i++) assert.ok(Math.abs(back.samples[i] - s[i]) < 1e-3);
});

test('jingles render', () => {
  for (const name of JINGLE_NAMES) {
    const s = jingle(name);
    assert.ok(s.length > 24000 * 0.8, name);
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(peak > 0.1 && peak <= 1, `${name} peak ${peak}`);
  }
});

test('mixer lays out lines, segments and mouth frames on one clock', async () => {
  const tts = createTTS({ provider: 'silent' });
  const rundown = {
    type: 'weekly',
    segments: [{ id: 's1', kind: 'cold_open', set: 'desk' }, { id: 's2', kind: 'conspiracy_corner', set: 'corkboard' }],
  };
  const script = {
    segments: [
      { id: 's1', kind: 'cold_open', lines: [
        { speaker: 'hal', text: 'Good evening and welcome to the show.', emotion: 'happy', gesture: 'none', shot: 'auto', card: '' },
        { speaker: 'sasha', text: 'Big news tonight.', emotion: 'excited', gesture: 'none', shot: 'auto', card: 'c1' },
      ] },
      { id: 's2', kind: 'conspiracy_corner', lines: [
        { speaker: 'gus', text: 'Follow the red string, people.', emotion: 'suspicious', gesture: 'lean_in', shot: 'single', card: '' },
      ] },
    ],
  };
  const progress = [];
  const r = await buildEpisodeAudio({ script, rundown, personas, tts, onProgress: p => progress.push(p) });
  assert.equal(r.lines.length, 3);
  assert.deepEqual(progress.at(-1), { done: 3, total: 3 });
  for (let i = 1; i < r.lines.length; i++) assert.ok(r.lines[i].t0 >= r.lines[i - 1].t1, 'lines never overlap');
  assert.ok(r.lines[0].t0 > 2, 'speech starts as the theme fades');
  assert.equal(r.segments.length, 2);
  assert.ok(r.segments[1].t0 < r.lines[2].t0, 'a segment starts with its transition sting');
  assert.deepEqual(r.cues.map(c => c.type), ['theme', 'spooky', 'outro']);
  assert.equal(r.mouth.fps, FPS);
  assert.equal(r.mouth.data.length, Math.ceil(r.duration * FPS));
  const during = r.mouth.data.slice(Math.ceil(r.lines[0].t0 * FPS), Math.floor(r.lines[0].t1 * FPS));
  assert.ok(/[123]/.test(during), 'mouth moves while talking');
  assert.equal(r.mouth.data.slice(0, 30), '0'.repeat(30), 'mouth closed during the theme');
  assert.ok(Math.abs(r.samples.length / r.sampleRate - r.duration) < 0.01);

  const dir = tmpDir();
  const out = await writeEpisodeAudio(r.samples, r.sampleRate, dir);
  assert.ok(['mp3', 'wav'].includes(out.format));
  assert.ok(fs.statSync(path.join(dir, out.file)).size > 1000);

  const breaking = await buildEpisodeAudio({ script, rundown: { ...rundown, type: 'breaking' }, personas, tts });
  assert.equal(breaking.cues[0].type, 'breaking');
});
