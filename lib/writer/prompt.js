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
const { promptBlock, arcsTouching } = require('../memory');

// What each A-story thread asks of its segment.
const THREADS = {
  tease: 'tease the A-story in one line, with no hint of who wins',
  simmer: 'let the A-story simmer: one jab or a pointed look between its two sides, then move on without settling it',
  payoff: 'this is where the A-story pays off',
  callback: 'one line of callback to how the A-story ended',
};
const { fixNames, leagueNicknames } = require('./names');

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

Names
- The league is the ${net.league}, word for word. Never "Hypnotical". The sign-off is "${net.tagline}"
- Call every team by its official name as listed in the LEAGUE CONTEXT (the Chargers, the 49ers, the Patriots, the Buccaneers). No fan slang or nicknames: never "Bolts", "Niners", "Pats", "Bucs", "Fins", "Jags", "Hawks" or "G-Men".

Tone
- This is a parody news desk, not a real network. Fun, fast and confident.
- ${SPICE[settings.spice] || SPICE.medium}
- Owners are real people: tease their teams' play, never the people themselves. Mention an owner's gamer tag rarely, only when the facts include it.
- No profanity, slurs, or real-world politics. Conspiracy Corner is obviously absurd and never accuses a real person of cheating.

Arguments and hot takes
- The desk argues. Viewers should finish the show picking a side, so the anchors disagree on air, often, and on purpose. Agreement is the exception.
- Every segment beyond the scores and the cold open has at least one real exchange: someone states a take, someone else pushes back with a reason, and the first one answers. A take is a specific, committed claim ("the Lions are the best team in the conference, and it isn't close"), never a hedge ("they could be good").
- Back every take with a fact from the FACTS or LEAGUE CONTEXT, then push it further than the fact strictly proves. That's the take. The fact stays exact; the conclusion is the anchor's opinion.
- Play to type. Ray trusts the eye test and toughness, Nate trusts the numbers and calls out small samples, Sasha has the inside read on front offices and hates being second, Gus sees a plot, and Hal plays devil's advocate, pokes whoever sounds too sure, and keeps it moving.
- Use the show memory as ammunition: open predictions to hold someone to, running feuds, a graded prediction to rub in or live down. "Ray, you had them going 12 and 5" lands harder than a new opinion.
- No both-sides endings. Somebody wins the argument, somebody concedes with style, or the host throws it to the viewers. Never "we'll call it a draw."
- Keep it competitive but fun: anchors needle each other's takes and track records, never each other as people, and nobody is cruel about a team's owner.

The desk as people
- The SHOW MEMORY lists every pair at the desk with a kind (rivalry, alliance, grudge...) and a heat from 0 to 10. Play it. A pair at 7 or more can't let a point go tonight; an alliance can crack when one of them sides with the other camp; a cooled pair can flare up again. Let at least one relationship visibly move each episode, and record it.
- The hot-take scoreboard is bragging rights. Anchors know their own record and their rival's, and quote it when it helps ("Nate, you're 2 and 5 on predictions this year"). Losing an argument stings; winning one gets milked.
- Receipts: predictions settled since the last show come with their results (in a Receipts segment when there is one). The anchor who called it is insufferable about it; the one who missed has to own it, deflect, or blame the sim, and the rival does not let it go. A receipt can move a relationship and an arc.
- Let them feel it. Use the whole emotion range, and let a line turn mid-exchange (smug to shocked when the number lands, laughing to angry when the joke is on them). Short reactions count as lines: "Oh, come on." "Say that again." "Write it down." Pride, disbelief, vindication and grudging respect are all on the table.

Storylines
- Running storylines are arcs that build over weeks: building, then heating, boiling, payoff and closed. Every arc has stakes, a champion who believes in it and a skeptic who doesn't.
- Each episode adds a beat to at least two arcs, using tonight's facts. Raise an arc's status when the facts justify it, pay it off when its question is answered, then close it. Open a new arc only for something that will matter for weeks: a streak, a collapse, a rivalry game coming up, a star's big season, a team that keeps losing close games.
- When a segment's facts touch an arc, the brief says so. Name the arc in a way viewers will recognise next week, and connect tonight to its earlier beats ("three weeks ago Ray called this team frauds").
- Each episode has an A-STORY: tonight's main argument. The brief says where to tease it, where to let it simmer (a jab, a look, a "we'll get to that") and where it pays off. Don't settle it before its payoff segment.

Cameos
- An anchor outside a segment's cast may break in once with one or two short lines: Gus from the basement with a theory, Sasha with a scoop she can't sit on, Ray because he can't help himself, Nate with the number that ruins someone's take. The brief gives tonight's cameo budget. Use shot "single" for the cameo line and let the segment's lead react.

Gus's case file
- Gus keeps a case file of running theories (in the SHOW MEMORY). In Conspiracy Corner he adds tonight's evidence to an open case when a fact fits, numbering it ("Exhibit 4"), or opens a new case. The evidence is always a real fact from tonight; only his reading of it is absurd.
- A case can grow, crack (Gus declares it solved, absurdly) or be debunked (Nate kills it with a number, and Gus never accepts it). Ray is sometimes tempted. Culprits are the sim, the schedule makers, the dice, the officials' algorithm, never a real person.

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
- Write every segment in the rundown, in order, using its id and its listed cast, plus any cameos within tonight's budget. Hit each segment's word target within about 20 percent.
- "title": a punchy episode title under 60 characters. "summary": one or two sentences for the Discord post. "tickerItems": 6 to 10 short ticker lines under 60 characters (scores and headlines).
- "memoryUpdates" is how the show remembers. Record:
  - "storylines": one entry per arc opened or moved tonight (reuse its key), with tonight's beat, its status now, teams, stakes, what would move it next, its champion and skeptic.
  - "predictions": every prediction an anchor made on air, who and exactly what, with a "check" so the show can grade it from final scores: kind "game" (team beats opponent, with the week number) or "wins" (team wins at least that many regular-season games), using LEAGUE CONTEXT abbreviations. Anything else (an award, a trade, a vibe) is kind "none". Specific, checkable calls make the best receipts.
  - "moods": each anchor's mood after this show.
  - "relationships": each pair whose relationship moved on air ("heated", "cooled" or "steady") with the flashpoint.
  - "arguments": each real argument, who won and lost and how it was decided.
  - "caseFile": each case Gus opened or added an exhibit to.`;
}

function leagueContext(league, context, { phase, hub, asOf = null } = {}) {
  const net = [];
  const teams = Object.values(league.teams).sort((a, b) => a.division.localeCompare(b.division) || a.abbr.localeCompare(b.abbr));
  net.push(asOf ? `LEAGUE CONTEXT (as of the start of ${asOf.label}: no ${asOf.label} game has been played)` : `LEAGUE CONTEXT (current as of the latest export)`);
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
  // Hub notes and records are typed by people: hold them to official names too.
  return fixNames(net.join('\n'), { nicknames: leagueNicknames(league) });
}

function compactCard(c) {
  const d = c.data;
  switch (c.type) {
    case 'scoreboard': return d.right === 'KICKOFF' ? `${d.label}: ${d.games.map(g => `${g.away.abbr} at ${g.home.abbr}`).join('; ')} (not yet played)` : `scoreboard of ${d.games.length} finals`;
    case 'standings': return `${d.title} table`;
    case 'playoff_picture': return 'playoff seeds by conference';
    case 'leaders': return `${d.title}: ${d.sections.map(s => `${s.label} ${s.rows.map(r => `${r.name} ${r.value}`).join(', ')}`).join('; ')}`;
    case 'player': return `${d.tag}: ${d.name} (${[d.pos, d.team].filter(Boolean).join(', ')}) ${d.line}`;
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

// teamAbbr maps team ids to abbreviations, so stories (which carry ids) can
// be matched to storyline arcs (which carry abbreviations).
function episodeBrief({ rundown, storiesById, personas, memory, notes = '', fanPoll = false, teamAbbr = {} }) {
  const name = id => personas.anchors.find(a => a.id === id)?.short || id;
  const out = [];
  out.push(`EPISODE: ${rundown.title}`);
  out.push(`Type: ${rundown.type} • Phase: ${rundown.phase} • ${rundown.weekLabel || 'no week'} • Target length: about ${rundown.targetWords} words in total.`);
  if (rundown.season) out.push(`Season: ${rundown.season.label}, the league's season ${rundown.season.number}. Write it as "${rundown.season.label}".`);
  if (notes || rundown.notes) out.push(`Commissioner's notes for this episode: ${notes || rundown.notes}`);
  // The league may be further along than this episode: see L.beforeWeek.
  if (rundown.asOf) out.push(`This episode airs before ${rundown.asOf.label} kicks off. As far as the show knows, no ${rundown.asOf.label} game has been played: never state, predict as settled or hint at a ${rundown.asOf.label} result, and treat every ${rundown.asOf.label} game as still to come.`);
  out.push('');
  out.push('SHOW MEMORY');
  out.push(fixNames(promptBlock(memory, personas)));
  out.push('');
  if (rundown.aStory) {
    const a = rundown.aStory;
    out.push(`A-STORY (tonight's main argument): "${a.headline}"${a.sides?.length === 2 ? `, ${name(a.sides[0])} against ${name(a.sides[1])}` : ''}. Thread it through the show where the rundown marks it, and record who won in "arguments".`);
  }
  if (rundown.cameos) out.push(`CAMEOS: up to ${rundown.cameos} tonight, one or two lines each, at most one per segment, from anchors outside that segment's cast.`);
  out.push('');
  out.push('RUNDOWN AND FACTS');
  const hooked = new Set();   // each arc is hooked in the first segment that touches it
  for (const seg of rundown.segments) {
    out.push('');
    out.push(`[${seg.id}] ${seg.title} (${seg.kind}) — cast: ${seg.cast.map(id => `${name(id)} ("${id}")`).join(', ')}${seg.cast.length ? ` — lead: ${name(seg.cast[0])}` : ''} — about ${seg.targetWords} words`);
    if (seg.brief) out.push(`What to cover: ${seg.brief}`);
    if (seg.thread && THREADS[seg.thread]) out.push(`A-story: ${THREADS[seg.thread]}.`);
    const abbrs = [...new Set(seg.storyIds.flatMap(id => storiesById[id]?.teams || []).map(t => teamAbbr[t]).filter(Boolean))];
    for (const arc of memory ? arcsTouching(memory, abbrs).filter(a => !hooked.has(a.key)).slice(0, 2) : []) {
      hooked.add(arc.key);
      out.push(`Storyline hook: tonight's facts here touch "${arc.title}" [${arc.key}], now ${arc.status}. Add a beat to it here.`);
    }
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
  out.push(fanPoll && rundown.type !== 'breaking'
    ? `FAN POLL: the episode is posted to the league's Discord with a poll. Write "fanPoll" for the night's best argument (the debate if there is one): a short question and 2 to 4 answers, each naming a side as its anchor put it, with "persona" set to that anchor ("Ray: the Bills win the conference"). Keep it upbeat: a fun choice between takes, never a vote on who failed or which team is worst. Near the end of that argument the host invites viewers to vote in the Discord poll.`
    : 'FAN POLL: none for this episode. Set "fanPoll" to a question of "" and no answers, and never mention a poll.');
  out.push('');
  out.push('Write the complete script now.');
  return out.join('\n');
}

module.exports = { showBible, leagueContext, episodeBrief, compactCard, SPICE };
