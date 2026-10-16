// Discord webhook announcements (same approach as hfl-draft): the webhook URL
// is a bearer credential, stored encrypted and only decrypted to send;
// mentions are disabled so a post can never ping @everyone.
'use strict';
const https = require('https');

const DISCORD_HOSTS = new Set([
  'discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com', 'canary.discordapp.com', 'ptb.discordapp.com',
]);

// Parsed, not substring-matched, so discord.com.evil.com can't slip through.
function isDiscordWebhook(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (!DISCORD_HOSTS.has(u.host.toLowerCase())) return false;
  return /^\/api\/(v\d+\/)?webhooks\/\d{5,}\/[\w-]{20,}$/.test(u.pathname);
}

function postWebhook(url, payload, { request = https.request } = {}) {
  return new Promise((resolve, reject) => {
    if (!isDiscordWebhook(url)) return reject(new Error('Not a Discord webhook URL'));
    const u = new URL(url);
    const body = JSON.stringify({ allowed_mentions: { parse: [] }, ...payload });
    const req = request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => (res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error(`Discord answered ${res.statusCode}: ${data.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Discord timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// A Discord poll from the script's fanPoll (lib/writer/validate.js keeps it
// inside Discord's limits). Open for two days, one vote each.
function pollPayload(poll, personas = null) {
  if (!poll?.question || !Array.isArray(poll.answers) || poll.answers.length < 2) return null;
  const name = id => personas?.anchors?.find(a => a.id === id)?.short;
  return {
    question: { text: String(poll.question).slice(0, 300) },
    answers: poll.answers.slice(0, 10).map(a => {
      const who = name(a.persona);
      // "Ray: ..." unless the writer already led with the anchor's name.
      const text = who && !String(a.text).toLowerCase().startsWith(who.toLowerCase()) ? `${who}: ${a.text}` : String(a.text);
      return { poll_media: { text: text.slice(0, 55) } };
    }),
    duration: 48,
    allow_multiselect: false,
  };
}

function episodeMessage(episode, watchUrl, { poll = null, personas = null } = {}) {
  const color = episode.type === 'breaking' ? 0xff2e4d : 0x2de2c8;
  const headlines = (episode.headlines || []).slice(0, 4);
  const discordPoll = episode.type === 'breaking' ? null : pollPayload(poll, personas);
  return {
    ...(discordPoll ? { poll: discordPoll } : {}),
    content: episode.type === 'breaking' ? '🚨 **Breaking news on HFL-NN**' : '📺 **New on HFL-NN**',
    embeds: [{
      title: String(episode.title).slice(0, 250),
      url: watchUrl,
      description: String(episode.summary || '').slice(0, 1000),
      color,
      fields: headlines.length ? [{ name: 'On the show', value: headlines.map(h => `• ${h}`).join('\n').slice(0, 1000) }] : [],
      footer: { text: `HFL-NN${episode.weekLabel ? ` • ${episode.weekLabel}` : ''}` },
    }],
  };
}

module.exports = { isDiscordWebhook, postWebhook, episodeMessage, pollPayload };
