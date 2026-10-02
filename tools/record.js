#!/usr/bin/env node
// Records an episode (or part of one) to MP4, for posting a clip to Discord
// or YouTube. Renders the player frame by frame in a headless browser, then
// muxes the frames with the episode audio. Needs Playwright, ffmpeg and a
// running server.
//
//   node tools/record.js --id <episode> [--from 0] [--to 90] [--fps 24] [--out clip.mp4]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
const base = (args.base || 'http://localhost:3000').replace(/\/$/, '');

function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(p); } catch { /* next */ }
  }
  console.error('Playwright is not installed: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

(async () => {
  const { chromium } = loadPlaywright();
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const id = args.id || (await (await fetch(`${base}/api/episodes`)).json())[0]?.id;
  if (!id) throw new Error('No published episode to record');
  const m = await (await fetch(`${base}/api/episodes/${id}`)).json();
  const fps = Number(args.fps) || 24;
  const from = Math.max(0, Number(args.from) || 0);
  const to = Math.min(m.duration, Number(args.to) || m.duration);
  const out = path.resolve(args.out || `${id}.mp4`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hflnn-rec-'));

  const audioPath = path.join(tmp, m.audio);
  fs.writeFileSync(audioPath, Buffer.from(await (await fetch(`${base}/media/${id}/${m.audio}`)).arrayBuffer()));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/watch/${id}?t=${from}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.hflnnReady === true);
  const frames = Math.ceil((to - from) * fps);
  for (let i = 0; i < frames; i++) {
    const t = from + i / fps;
    const data = await page.evaluate(tt => { window.hflnn.player.renderAt(tt); return document.getElementById('screen').toDataURL('image/png'); }, t);
    fs.writeFileSync(path.join(tmp, `f${String(i).padStart(6, '0')}.png`), Buffer.from(data.split(',')[1], 'base64'));
    if (i % (fps * 10) === 0) console.log(`frame ${i}/${frames}`);
  }
  await browser.close();

  const r = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps), '-i', path.join(tmp, 'f%06d.png'),
    '-ss', String(from), '-t', String(to - from), '-i', audioPath,
    '-vf', 'scale=960:540:flags=neighbor', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', out,
  ], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log(`saved ${out} (${(to - from).toFixed(1)}s at ${fps} fps)`);
})().catch(e => { console.error(e.message); process.exit(1); });
