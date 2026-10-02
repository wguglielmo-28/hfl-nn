// Origin allowlisting (ported from hfl-draft lib/net.js).
'use strict';

// "Our own domain" is whatever host the request arrived on. Deriving it from
// the request rather than an env var means a new Railway domain, a custom
// domain, or a preview URL keeps working with no config change.
function sameHost(origin, host) {
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

// No Origin header at all = a same-origin navigation or a non-browser client
// (the Madden Companion App, Snallabot, curl).
function originAllowed(origin, host, extraOrigins = []) {
  if (!origin) return true;
  return sameHost(origin, host) || extraOrigins.includes(origin);
}

function parseExtraOrigins(env = {}) {
  return [
    ...String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    ...(env.RAILWAY_PUBLIC_DOMAIN ? [`https://${env.RAILWAY_PUBLIC_DOMAIN}`] : []),
  ];
}

module.exports = { sameHost, originAllowed, parseExtraOrigins };
