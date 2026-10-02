#!/usr/bin/env node
// Screenshots of the player at interesting moments of an episode, for
// checking the pixel art without watching the whole show. Needs Playwright
// (npm i -g playwright && npx playwright install chromium) and a running server.
//
//   node tools/snap.js                       latest published episode
//   node tools/snap.js --id <episode-id>     a specific one
//   node tools/snap.js --times 5,42.5        specific seconds
//   node tools/snap.js --base http://localhost:3000 --out snaps
'use strict';
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
const base = (args.base || 'http://localhost:3000').replace(/\/$/, '');
const out = path.resolve(args.out || 'snaps');

function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { return require(p); } catch { /* next */ }
  }
  console.error('Playwright is not installed: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

(async () => {
  const { chromium } = loadPlaywright();
  const episodes = await (await fetch(`${base}/api/episodes`)).json();
  const id = args.id || episodes[0]?.id;
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // The channel page itself (off-air or latest episode, before pressing play)
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.hflnnReady === true, null, { timeout: 15000 });
  await page.screenshot({ path: path.join(out, 'page.png'), fullPage: true });

  if (id) {
    const m = await (await fetch(`${base}/api/episodes/${id}`)).json();
    let times = args.times ? String(args.times).split(',').map(Number) : null;
    if (!times) {
      times = [1.5];
      for (const seg of m.segments) {
        const lines = m.lines.filter(l => l.seg === seg.id);
        if (!lines.length) continue;
        times.push(+(seg.t0 + 0.5).toFixed(2));                 // the transition
        times.push(+(lines[0].t0 + 1.2).toFixed(2));            // the first shot
        const cued = lines.find(l => l.card && l !== lines[0]);
        if (cued) times.push(+(cued.t0 + 1.0).toFixed(2));      // a card on screen
      }
      times.push(m.duration - 1);
    }
    for (const t of times.slice(0, Number(args.max) || 40)) {
      await page.goto(`${base}/watch/${id}?t=${t}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.hflnnReady === true, null, { timeout: 15000 });
      const canvas = await page.$('#screen');
      await canvas.screenshot({ path: path.join(out, `${id}-${String(t).replace('.', '_')}.png`) });
    }
    console.log(`saved ${times.length} frames of ${id} to ${out}`);
  }
  await browser.close();
  if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exit(2); }
})().catch(e => { console.error(e); process.exit(1); });
