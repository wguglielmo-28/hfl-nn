// Control-room settings, persisted in DATA_DIR/settings.json, plus the anchor
// lineup (config/personas.json with the commissioner's overrides applied).
'use strict';
const secrets = require('./secrets');
const { isDiscordWebhook } = require('./discord');
const { KOKORO_VOICES } = require('./tts');

const PHASES = ['regular', 'playoffs', 'preseason', 'offseason', 'draft', 'free_agency'];

function defaults(env = process.env) {
  return {
    phaseOverride: null,          // null = detect from the exports
    autoProduce: true,            // draft the weekly show after each game-week export
    autoPublish: false,           // …and publish it without review
    autoBreaking: true,           // draft bulletins for big roster moves / Chronicle "breaking" posts
    autoPublishBreaking: false,
    writer: 'auto',               // auto | claude | template
    spice: 'medium',              // mild | medium | spicy
    pronunciations: {},           // "Ja'Marr" → "Juh Mar"
    discordWebhook: null,         // encrypted at rest
    hubFeedUrl: env.HUB_FEED_URL || '',
    chronicleFeedUrl: env.CHRONICLE_FEED_URL || '',
    publicUrl: env.PUBLIC_URL || '',
    pollMinutes: 20,
    personaOverrides: {},         // id → { name, short, voice, speed }
  };
}

function createSettings({ store, basePersonas, env = process.env }) {
  let settings = { ...defaults(env), ...store.readJSON('settings.json', {}) };
  const save = () => store.writeJSON('settings.json', settings);

  function personas() {
    const o = settings.personaOverrides || {};
    return {
      ...basePersonas,
      anchors: basePersonas.anchors.map(a => ({ ...a, ...(o[a.id] || {}) })),
    };
  }

  // What the control room sees: the webhook is masked, never returned.
  function publicView() {
    const { discordWebhook, ...rest } = settings;
    return { ...rest, discordWebhook: secrets.maskWebhook(secrets.decryptSecret(discordWebhook)), hasWebhook: !!discordWebhook, personas: personas().anchors, voices: KOKORO_VOICES, phases: PHASES };
  }

  function update(patch = {}) {
    const next = { ...settings };
    const bool = k => { if (k in patch) next[k] = !!patch[k]; };
    ['autoProduce', 'autoPublish', 'autoBreaking', 'autoPublishBreaking'].forEach(bool);
    if ('phaseOverride' in patch) next.phaseOverride = PHASES.includes(patch.phaseOverride) ? patch.phaseOverride : null;
    if ('writer' in patch && ['auto', 'claude', 'template'].includes(patch.writer)) next.writer = patch.writer;
    if ('spice' in patch && ['mild', 'medium', 'spicy'].includes(patch.spice)) next.spice = patch.spice;
    if ('pollMinutes' in patch) next.pollMinutes = Math.max(5, Math.min(240, Number(patch.pollMinutes) || 20));
    for (const k of ['hubFeedUrl', 'chronicleFeedUrl', 'publicUrl']) {
      if (!(k in patch)) continue;
      const v = String(patch[k] || '').trim();
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error(`${k} must be an http(s) URL`);
      next[k] = v.replace(/\/$/, k === 'publicUrl' ? '' : '$&');
    }
    if ('pronunciations' in patch) {
      const p = patch.pronunciations && typeof patch.pronunciations === 'object' ? patch.pronunciations : {};
      next.pronunciations = Object.fromEntries(Object.entries(p).filter(([k, v]) => k.trim() && String(v).trim()).slice(0, 200).map(([k, v]) => [k.trim().slice(0, 60), String(v).trim().slice(0, 80)]));
    }
    if ('discordWebhook' in patch && patch.discordWebhook) {
      if (!isDiscordWebhook(patch.discordWebhook)) throw new Error("That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/...).");
      next.discordWebhook = secrets.encryptSecret(patch.discordWebhook);
    }
    if (patch.clearWebhook) next.discordWebhook = null;
    if (patch.personaOverrides && typeof patch.personaOverrides === 'object') {
      const out = {};
      for (const a of basePersonas.anchors) {
        const o = patch.personaOverrides[a.id];
        if (!o) continue;
        const clean = {};
        if (o.name) clean.name = String(o.name).slice(0, 40);
        if (o.short) clean.short = String(o.short).slice(0, 16);
        if (o.voice && KOKORO_VOICES.includes(o.voice)) clean.voice = o.voice;
        if (o.speed) clean.speed = Math.max(0.8, Math.min(1.25, Number(o.speed) || 1));
        if (Object.keys(clean).length) out[a.id] = clean;
      }
      next.personaOverrides = out;
    }
    settings = next;
    save();
    return publicView();
  }

  return { get: () => settings, personas, publicView, update, PHASES };
}

module.exports = { createSettings, defaults, PHASES };
