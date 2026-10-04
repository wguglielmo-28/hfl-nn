// Official names only. The league is the Hypnotic Football League (never
// "Hypnotical"), and teams go by their NFL names: the Chargers, not the Bolts.
// The writer is told this in the show bible; this is the backstop for when it
// slips, applied to everything an anchor says or the ticker shows.
'use strict';

// slang → official nickname. Matched only in Title Case or ALL CAPS, so plain
// words ("pats him on the back", "the boys") are left alone.
const TEAM_SLANG = [
  [['Bolts'], 'Chargers'],
  [['Niners', '9ers'], '49ers'],
  [['Pats'], 'Patriots'],
  [['Fins', 'Phins', 'the Fish'], 'Dolphins', true],
  [['Bucs'], 'Buccaneers'],
  [['Jags'], 'Jaguars'],
  [['Vikes'], 'Vikings'],
  [['Hawks'], 'Seahawks'],
  [['G-Men', 'Big Blue'], 'Giants'],
  [['Gang Green'], 'Jets'],
  [['Dirty Birds'], 'Falcons'],
  [['Da Bears'], 'Bears'],
  [['the Cards'], 'Cardinals', true],
  [['the Pack'], 'Packers', true],
  [['the Boys', "the 'Boys"], 'Cowboys', true],
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [regex, replacement, official nickname, slang as written in the table]
const RULES = TEAM_SLANG.flatMap(([slang, official, phrase]) => slang.flatMap(s => {
  const the = phrase && s.startsWith('the ');
  const to = the ? `the ${official}` : official;
  const forms = [[s, to], [s.toUpperCase(), to.toUpperCase()]];
  if (the) forms.push([`T${s.slice(1)}`, `T${to.slice(1)}`]); // sentence start
  return forms.map(([from, rep]) =>
    [new RegExp(`(?<![\\w'])${escapeRe(from)}(?![\\w-])`, 'g'), rep, official, s]);
}));

const LEAGUE_TYPO = /\bhypnotical\b/gi;
const keepCase = (m, word) => (m === m.toUpperCase() ? word.toUpperCase() : m[0] === m[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);

// officialNames(text, { nicknames }) → { text, swaps: { "Bolts → Chargers": n } }
// `nicknames` (the league's team nicknames) limits swaps to teams that exist,
// so a relocated or renamed team never gets an NFL name pinned on it.
function officialNames(text, { nicknames = null, swaps = {} } = {}) {
  let s = String(text ?? '');
  s = s.replace(LEAGUE_TYPO, m => {
    swaps['Hypnotical → Hypnotic'] = (swaps['Hypnotical → Hypnotic'] || 0) + 1;
    return keepCase(m, 'hypnotic');
  });
  for (const [re, rep, official, from] of RULES) {
    if (nicknames && !nicknames.has(official)) continue;
    s = s.replace(re, () => {
      const k = `${from} → ${official}`;
      swaps[k] = (swaps[k] || 0) + 1;
      return rep;
    });
  }
  return { text: s, swaps };
}

const fixNames = (text, opts) => officialNames(text, opts).text;

function leagueNicknames(league) {
  const names = Object.values(league?.teams || {}).map(t => t.nickname).filter(Boolean);
  return names.length ? new Set(names) : null;
}

module.exports = { officialNames, fixNames, leagueNicknames, TEAM_SLANG };
