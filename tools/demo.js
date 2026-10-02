#!/usr/bin/env node
// Builds a working HFL-NN in a data directory, end to end: loads the sample
// league (two export batches + a Chronicle article + a Hub feed), writes,
// voices and publishes a weekly show and a breaking-news bulletin.
//
//   npm run demo                         (Claude if ANTHROPIC_API_KEY is set, Kokoro voices if installed)
//   npm run demo -- --writer template    (no API key needed)
//   npm run demo -- --tts silent         (skip voice synthesis; quick)
//   npm run demo -- --data ./demo-data   (default: ./data)
//
// Then `npm start` and open http://localhost:3000.
'use strict';
const path = require('path');
const { createApp } = require('../server');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

const log = (...m) => console.log('[demo]', ...m);

async function waitForJobs(ctx) {
  const timer = setInterval(() => {
    const j = ctx.producer.jobs().find(x => x.status === 'running');
    if (j?.progress?.stage === 'voicing') log(`voicing line ${j.progress.done}/${j.progress.total}`);
    else if (j?.progress?.stage === 'writing') log(`writing… ${j.progress.chars} characters`);
  }, 10000);
  await ctx.producer.idle();
  clearInterval(timer);
}

async function produce(ctx, opts) {
  const ep = ctx.producer.createEpisode(opts);
  log(`writing "${ep.title}" (${opts.writer || 'auto'} writer)…`);
  await waitForJobs(ctx);
  let e = ctx.producer.get(ep.id);
  if (e.status === 'failed' || !e.script) throw new Error(`writing failed: ${e.error}`);
  log(`script: ${e.script.segments.length} segments, ${e.script.words} words, writer ${e.writer.kind}${e.writer.costUsd != null ? ` ($${e.writer.costUsd.toFixed(3)})` : ''}`);
  for (const w of e.validation.warnings) log(`  warning: ${w}`);
  if (e.validation.errors.length) throw new Error(`script errors: ${e.validation.errors.join('; ')}`);
  ctx.producer.voice(ep.id);
  log(`voicing with ${ctx.tts.provider} voices…`);
  await waitForJobs(ctx);
  e = ctx.producer.get(ep.id);
  if (!e.audio) throw new Error(`voicing failed: ${e.error}`);
  await ctx.producer.publish(ep.id, { discord: false });
  log(`published ${ep.id}: ${Math.round(e.audio.duration)}s ${e.audio.format}`);
  return ep.id;
}

(async () => {
  const dataDir = path.resolve(args.data || 'data');
  const env = { ...process.env, TTS_PROVIDER: args.tts || process.env.TTS_PROVIDER || 'auto' };
  const ctx = createApp({ dataDir, env, debounceMs: 60 * 60 * 1000 });
  const before = ctx.settings.get().autoProduce;
  ctx.settings.update({ autoProduce: false });   // this script drives production itself
  try {
    if (Object.keys(ctx.getLeague().teams).length && !args.force) {
      log(`${dataDir} already has league data; producing from it (use --force with an empty --data dir for a fresh demo)`);
    } else {
      log(`loading the sample league into ${dataDir}`);
      await ctx.loadSampleLeague();
    }
    const writer = args.writer || 'auto';
    const weekly = await produce(ctx, { type: 'weekly', writer });
    let breaking = null;
    const trade = ctx.producer.wireStories().find(s => s.type === 'trade');
    if (trade && !args['no-breaking']) breaking = await produce(ctx, { type: 'breaking', breakingStoryIds: [trade.id], writer });
    log('done. Run `npm start` and open:');
    log(`  http://localhost:3000/watch/${weekly}`);
    if (breaking) log(`  http://localhost:3000/watch/${breaking}`);
  } finally {
    ctx.settings.update({ autoProduce: before });
    await ctx.close();
  }
})().catch(e => {
  console.error('[demo] failed:', e.message);
  process.exit(1);
});
