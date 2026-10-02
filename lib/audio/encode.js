// Writes the mixed episode to disk: MP3 via ffmpeg when available (about a
// tenth the size of WAV — an 8-minute show is ~6 MB instead of ~23 MB), WAV
// otherwise. ffmpeg is looked up as FFMPEG_PATH, then on PATH, then the
// optional ffmpeg-static package.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { encodeWav } = require('./wav');

let cached;
function findFfmpeg() {
  if (cached !== undefined) return cached;
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'];
  try { candidates.push(require('ffmpeg-static')); } catch { /* optional */ }
  for (const c of candidates.filter(Boolean)) {
    try {
      if (spawnSync(c, ['-version'], { stdio: 'ignore', timeout: 10000 }).status === 0) return (cached = c);
    } catch { /* try the next one */ }
  }
  return (cached = null);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))));
  });
}

async function writeEpisodeAudio(samples, sampleRate, dir, base = 'audio') {
  fs.mkdirSync(dir, { recursive: true });
  const wav = encodeWav(samples, sampleRate);
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const tmp = path.join(dir, `${base}.tmp.wav`);
    const out = path.join(dir, `${base}.mp3`);
    fs.writeFileSync(tmp, wav);
    try {
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '96k', out]);
      return { file: `${base}.mp3`, format: 'mp3', bytes: fs.statSync(out).size };
    } catch (e) {
      console.warn(`[audio] MP3 encode failed, keeping WAV: ${e.message}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  fs.writeFileSync(path.join(dir, `${base}.wav`), wav);
  return { file: `${base}.wav`, format: 'wav', bytes: wav.length };
}

module.exports = { writeEpisodeAudio, findFfmpeg };
