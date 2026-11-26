// HFL coach names (config/coaches.json). On air a coach is called only by
// this name, never by a Discord, Twitch or Hub handle.
'use strict';
const cfg = require('../config/coaches.json');

function coachFor(abbr) {
  const a = String(abbr || '').toUpperCase();
  const key = cfg.aliases?.[a] || a;
  return cfg.coaches?.[key] || null;
}

// How a member's question is credited: "Hank Nottick of the Packers", or
// "a Packers fan" for a CPU team, or "a viewer" with no team at all. The
// Hub handle the feed carries as `name` is never used.
function creditFor(abbr) {
  const c = coachFor(abbr);
  if (c) return { who: `${c.coach} of the ${c.team}`, short: c.coach, team: c.team };
  return { who: 'a viewer', short: 'A viewer', team: null };
}

module.exports = { coachFor, creditFor };
