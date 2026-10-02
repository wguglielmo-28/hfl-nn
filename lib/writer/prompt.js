// Prompt assembly for the Claude writer.
//
// Three parts, ordered for prompt caching (stable → volatile):
//   1. showBible()      — system block 1: the show, personas, rules. Changes only
//                          when the lineup or settings change.
//   2. leagueContext()  — system block 2: teams, owners, standings. Changes once
//                          per export batch, so regenerations reuse the cache.
//   3. episodeBrief()   — user turn: rundown, facts, memory, notes.
'use strict';
const L = require('../league');
const C = require('../cards');
const { promptBlock } = require('../memory');

const SPICE = {
  mild: 'Keep the ribbing gentle and family-friendly.',
  medium: 'Trash talk about teams and performances is welcome; keep it good-natured.',
  spicy: 'Go hard on bad teams and bad performances, like a real hot-take show, but never personal.',
};

function showBible(personas, settings = {}) {
  const net = personas.network;
  const anchors = personas.anchors.map(a => [
    `## ${a.name} (id: "${a.id}") — ${a.role}`,
    a.bio,
    `Voice and style: ${a.style}`,
    `Catchphrases (use sparingly, at most once per episode each): ${a.catchphrases.map(c => `"${c}"`).join(', ')}`,
  ].join('\n')).join('\n\n');

  return `You are the writers' room for ${net.name} (${net.longName}), a pixel-art sports news show covering the ${net.league} (${net.leagueShort}): a 32-team Madden NFL online franchise league whose teams are run by real people (owners) and by the CPU. The audience is the league's own members, so inside jokes and rivalries land; they know the league well.

You write the full script for one episode at a time. Text-to-speech voices read every line aloud while animated anchors lip-sync on screen, so write for the ear.

# The anchors

${anchors}

# Rules

Accuracy
- Every fact, score, stat, record, contract number and name must come from the LEAGUE CONTEXT or the episode's FACTS. Never invent stats, injuries, quotes, draft picks or details of a deal. If the facts don't say it, don't state it as fact.
- Opinions, predictions, jokes and banter are encouraged, as long as they are clearly the anchor's take.
- Trades: the export does not show draft picks, so never claim what else changed hands beyond the players listed.

Tone
- This is a parody news desk, not a real network. Fun, fast and confident.
- ${SPICE[settings.spice] || SPICE.medium}
- Owners are real people: tease their teams' play, never the people themselves. Mention an owner's gamer tag rarely, only when the facts include it.
- No profanity, slurs, or real-world politics. Conspiracy Corner is obviously absurd and never accuses a real person of cheating.

Writing for the voices
- Each line is one to three short sentences (under about 45 words), in that anchor's voice.
- Write words exactly as spoken: "quarterback" not "QB", "touchdowns" not "TDs", "yards" not "yds". Scores as "31 to 28". Records as "6 and 2". Spell numbers as digits.
- No stage directions, sound effects, emojis, hashtags, markdown or quotation marks around whole lines. Use emotion and gesture fields instead.
- Anchors talk to each other by first name and hand off naturally. Keep each segment's lead anchor in charge of it.

Staging
- Each segment comes with on-screen cards (graphics) identified by ids like "c4". Set a line's "card" to a card id at the moment that graphic should appear; it stays up until another card is set. Use "" otherwise. Bring each card up once, on the line that first talks about it.
- "emotion" sets the anchor's face; "gesture" a one-off move (desk_slam is Ray's, facepalm for disbelief, point when making a pick). Use gestures sparingly.
- "shot": usually "auto". Use "single" for a strong personal take, "two_shot" for back-and-forth, "graphic" when talking over a card, "full_graphic" for scoreboards and tables.

Shape
- Write every segment in the rundown, in order, using its id and only its listed cast. Hit each segment's word target within about 20 percent.
- "title": a punchy episode title under 60 characters. "summary": one or two sentences for the Discord post. "tickerItems": 6 to 10 short ticker lines under 60 characters (scores and headlines).
- "memoryUpdates": record storylines worth following, every prediction an anchor made on air (who and exactly what), and each anchor's mood after this show.`;
}

function leagueContext(league, context, { phase, hub } = {}) {
  const net = [];
  const teams = Object.values(league.teams).sort((a, b) => a.division.localeCompare(b.division) || a.abbr.localeCompare(b.abbr));
  net.push(`LEAGUE CONTEXT (current as of the latest export)`);
  net.push(`Season: ${league.calendarYear || 'unknown'} • Phase: ${phase} • Latest results: ${context.weekLabel || 'none yet'}`);
  if (league.standingsFresh === false) net.push('Note: the standings export is out of date, so team records are omitted. Do not quote records.');
  net.push('');
  net.push('Teams (abbr | team | owner | record | streak | team overall):');
  for (const t of teams) {
    const s = league.standings[t.id];
    const rec = L.recordOf(league, t.id);
    net.push(`${t.abbr} | ${t.city} ${t.nickname} | ${t.owner ? `owner: ${t.owner}` : 'CPU'} | ${rec || '-'} | ${s && league.standingsFresh !== false ? C.streakLabel(s.streak) : '-'} | ${t.ovr ?? '-'} | ${t.division}`);
  }
  if (hub?.owners?.length) {
    net.push('');
    net.push('Owner notes from the HFL Hub (a coach is the owner\'s in-league persona, the name the Chronicle uses; call them "Coach <last name>"):');
    for (const o of hub.owners.slice(0, 40)) net.push(`- ${o.teamAbbr}: ${[o.coach && `coach ${o.coach}`, o.displayName && `owner ${o.displayName}`].filter(Boolean).join(', ')}${o.note ? ` — ${o.note}` : ''}${o.titles ? ` (${o.titles} title${o.titles === 1 ? '' : 's'})` : ''}`);
  }
  if (hub?.records?.length || hub?.history?.length) {
    net.push('');
    net.push('League history and records from the HFL Hub:');
    for (const r of [...(hub.records || []), ...(hub.history || [])].slice(0, 20)) net.push(`- ${typeof r === 'string' ? r : r.text || JSON.stringify(r)}`);
  }
  if (context.seasonLeaders) {
    net.push('');
    net.push('Season leaders:');
    for (const sec of context.seasonLeaders.data.sections) net.push(`- ${sec.label}: ${sec.rows.map(r => `${r.name} (${r.team}) ${r.value}`).join(', ')}`);
  }
  return net.join('\n');
}

function compactCard(c) {
  const d = c.data;
  switch (c.type) {
    case 'scoreboard': return `scoreboard of ${d.games.length} finals`;
    case 'standings': return `${d.title} table`;
    case 'playoff_picture': return 'playoff seeds by conference';
    case 'leaders': return `${d.title}: ${d.sections.map(s => `${s.label} ${s.rows.map(r => `${r.name} ${r.value}`).join(', ')}`).join('; ')}`;
    case 'player': return `${d.tag}: ${d.name} (${d.pos}, ${d.team}) ${d.line}`;
    case 'matchups': return `${d.title}: ${d.games.map(g => `${g.away.abbr}${g.away.record ? ` (${g.away.record})` : ''} at ${g.home.abbr}${g.home.record ? ` (${g.home.record})` : ''}`).join('; ')}`;
    case 'power_rankings': return `${d.title}: ${d.rows.map(r => `${r.rank}. ${r.abbr}`).join(', ')}`;
    case 'bracket': return `${d.title}: ${d.rounds.map(r => `${r.name}: ${r.games.map(g => `${g.away.abbr} ${g.away.score ?? ''} at ${g.home.abbr} ${g.home.score ?? ''}`).join(', ')}`).join(' | ')}`;
    case 'quote': return `quote card from ${d.outlet}: "${d.title}"`;
    case 'corkboard': return `Gus's cork board: ${d.headline}`;
    case 'breaking': return `BREAKING banner: ${d.text}`;
    case 'injury': return `injury report: ${d.rows.map(r => `${r.name} (${r.team}) ${r.detail}`).join(', ')}`;
    default: return `${c.type} card${d.text ? `: ${d.text}` : ''}`;
  }
}

function episodeBrief({ rundown, storiesById, personas, memory, notes = '' }) {
  const name = id => personas.anchors.find(a => a.id === id)?.short || id;
  const out = [];
  out.push(`EPISODE: ${rundown.title}`);
  out.push(`Type: ${rundown.type} • Phase: ${rundown.phase} • ${rundown.weekLabel || 'no week'} • Target length: about ${rundown.targetWords} words in total.`);
  if (notes || rundown.notes) out.push(`Commissioner's notes for this episode: ${notes || rundown.notes}`);
  out.push('');
  out.push('SHOW MEMORY');
  out.push(promptBlock(memory, personas));
  out.push('');
  out.push('RUNDOWN AND FACTS');
  for (const seg of rundown.segments) {
    out.push('');
    out.push(`[${seg.id}] ${seg.title} (${seg.kind}) — cast: ${seg.cast.map(id => `${name(id)} ("${id}")`).join(', ')}${seg.cast.length ? ` — lead: ${name(seg.cast[0])}` : ''} — about ${seg.targetWords} words`);
    if (seg.brief) out.push(`What to cover: ${seg.brief}`);
    if (seg.cards.length) {
      out.push('Cards:');
      for (const c of seg.cards) out.push(`  ${c.id}: ${compactCard(c)}`);
    }
    const stories = seg.storyIds.map(id => storiesById[id]).filter(Boolean);
    if (stories.length) {
      out.push('Facts:');
      for (const s of stories) out.push(`  - ${s.headline} :: ${JSON.stringify(s.facts)}`);
    }
  }
  out.push('');
  out.push('Write the complete script now.');
  return out.join('\n');
}

module.exports = { showBible, leagueContext, episodeBrief, compactCard, SPICE };
