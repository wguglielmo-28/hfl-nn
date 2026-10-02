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

function episodeMessage(episode, watchUrl) {
  const color = episode.type === 'breaking' ? 0xff2e4d : 0x2de2c8;
  const headlines = (episode.headlines || []).slice(0, 4);
  return {
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

module.exports = { isDiscordWebhook, postWebhook, episodeMessage };
