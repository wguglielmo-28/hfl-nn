'use strict';
// The voice cache sweep: unused clips are deleted so the volume stays small;
// ElevenLabs clips (which cost credits to remake) are kept longer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTTS, CACHE_DAYS } = require('../lib/tts');
const { tmpDir } = require('./helpers');

const DAY = 86400e3;

function fakeEleven() {
  let calls = 0;
  return {
    name: 'elevenlabs',
    model: () => 'eleven_multilingual_v2',
    deliveryKey: () => null,
    synth: async text => { calls++; return { samples: new Float32Array(240), sampleRate: 24000, chars: text.length }; },
    configured: () => true,
    status: () => ({}),
    calls: () => calls,
  };
}

const files = dir => {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.relative(dir, path.join(d, e.name)).split(path.sep).join('/')); };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};
function put(dir, rel, ageDays, now) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(1000));
  const t = new Date(now - ageDays * DAY);
  fs.utimesSync(p, t, t);
}

test('the sweep keeps Kokoro clips 3 days and ElevenLabs clips 30, and tidies empty folders', () => {
  assert.deepEqual(CACHE_DAYS, { kokoro: 3, elevenlabs: 30 });
  const dir = tmpDir();
  const now = Date.now();
  put(dir, 'ab/new.wav', 1, now);
  put(dir, 'ab/old.wav', 4, now);
  put(dir, 'cd/old.wav', 10, now);
  put(dir, 'elevenlabs/ef/recent.wav', 10, now);
  put(dir, 'elevenlabs/ef/stale.wav', 31, now);
  put(dir, 'ab/notes.txt', 100, now);
  const tts = createTTS({ provider: 'silent', cacheDir: dir });
  const r = tts.sweepCache({ now });
  assert.equal(r.files, 3);
  assert.equal(r.bytes, 3000);
  assert.deepEqual(files(dir), ['ab/new.wav', 'ab/notes.txt', 'elevenlabs/ef/recent.wav']);
  assert.ok(!fs.existsSync(path.join(dir, 'cd')), 'an emptied folder is removed');
  assert.deepEqual(tts.sweepCache({ now }), { files: 0, bytes: 0 });
});

test('ElevenLabs clips go in their own folder; old clips are still found and a hit refreshes the clip', async () => {
  const dir = tmpDir();
  const eleven = fakeEleven();
  const tts = createTTS({ provider: 'silent', cacheDir: dir, elevenlabs: eleven });
  const a = await tts.speak('Back in my day.', { voice: 'eleven:V1' });
  assert.equal(a.cached, false);
  const [clip] = files(dir);
  assert.match(clip, /^elevenlabs\/[0-9a-f]{2}\/[0-9a-f]{64}\.wav$/);

  // A clip from before the folder existed sits at the top level; it is still used.
  const name = clip.split('/').slice(1).join('/');
  fs.mkdirSync(path.join(dir, name.slice(0, 2)), { recursive: true });
  fs.renameSync(path.join(dir, ...clip.split('/')), path.join(dir, ...name.split('/')));
  const old = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(path.join(dir, ...name.split('/')), old, old);
  const b = await tts.speak('Back in my day.', { voice: 'eleven:V1' });
  assert.equal(b.cached, true);
  assert.equal(eleven.calls(), 1, 'no second ElevenLabs call');
  const age = Date.now() - fs.statSync(path.join(dir, ...name.split('/'))).mtimeMs;
  assert.ok(age < DAY, 'reading a clip marks it as used');
});
