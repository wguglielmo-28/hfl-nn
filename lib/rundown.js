// Rundown builder: decides which segments an episode has, who's in each, what
// material (stories + on-screen cards) each covers, and how long it should
// run. The writer (Claude or the template writer) only writes the words.
'use strict';
const C = require('./cards');

const TRANSACTION_TYPES = ['roster_rebuild', 'trade', 'signing', 'release', 'extension', 'retirement', 'departure', 'owner_change', 'bulk', 'dev_change', 'rating_change'];
const STANDINGS_TYPES = ['streak', 'division_lead', 'rank_move', 'clinch', 'playoff_position'];

// Map cast roles in show.json to persona ids, falling back to the host so a
// trimmed lineup still produces a show.
function castResolver(anchors) {
  const byKind = k => anchors.filter(a => a.kind === k).map(a => a.id);
  const host = byKind('host')[0] || anchors[0]?.id;
  const analysts = byKind('analyst');
  const roles = {
    host,
    insider: byKind('insider')[0] || host,
    analyst: analysts[0] || host,
    analyst2: analysts[1] || analysts[0] || host,
    wildcard: byKind('wildcard')[0] || analysts[0] || host,
  };
  return list => [...new Set(list.map(r => roles[r] || host))];
}

function rundownName({ type, phase, show, context, customKinds }) {
  if (type === 'breaking') return 'breaking';
  if (type === 'premiere') return 'premiere';
  if (type === 'custom') return customKinds?.length ? 'custom' : 'weekly';
  const wk = context?.focusWeek;
  let name = show.phases[phase] || 'weekly';
  if (name === 'weekly' && wk && wk.stage === 'reg' && wk.week >= 12) name = 'weekly_late';
  if (name === 'weekly' && wk && wk.stage === 'pre') name = 'preseason';
  if (name === 'playoffs' && wk && wk.week >= 23) name = 'championship';
  return name;
}

function titleFor(name, context, breakingStories, network) {
  const wl = context?.weekLabel || '';
  switch (name) {
    case 'breaking': return `Breaking: ${breakingStories[0]?.headline || 'Developing story'}`;
    case 'weekly': case 'weekly_late': return `${network.name} Tonight: ${wl}`;
    case 'playoffs': return `${network.name} Playoff Edition: ${wl}`;
    case 'championship': return `${network.name} Championship Special`;
    case 'preseason': return `${network.name} Preseason Special`;
    case 'premiere': return `${network.name} Season Premiere`;
    case 'draft': return `${network.name} Draft Desk Special`;
    case 'free_agency': return `${network.name} Free Agency Special`;
    case 'offseason': return `${network.name} Offseason Report`;
    default: return `${network.name} Special Report`;
  }
}

function buildRundown({
  type = 'weekly', phase = 'regular', show, personas, league, context = {}, stories = [],
  chronicle = [], hub = [], customKinds = null, breakingStories = [], title = null, notes = '',
}) {
  const anchors = personas.anchors;
  const cast = castResolver(anchors);
  const name = rundownName({ type, phase, show, context, customKinds });
  const kinds = name === 'custom' ? customKinds : show.rundowns[name];
  const network = personas.network;

  let cardSeq = 0;
  const card = (c, storyId = null) => (c ? { id: `c${++cardSeq}`, type: c.type, data: c.data, storyId } : null);
  const used = new Set();
  const pickStories = (types, max, filter = () => true) => {
    const out = stories.filter(s => types.includes(s.type) && !used.has(s.id) && filter(s)).slice(0, max);
    out.forEach(s => used.add(s.id));
    return out;
  };
  const storyCards = list => list.map(s => card(s.card, s.id)).filter(Boolean);

  // Pre-pick the stories two segments compete for, so the order of segments
  // doesn't decide who gets the best one.
  const games = stories.filter(s => s.type === 'game');
  // The HFL names its own Game of the Week (the Hub feed, else Madden's flag)
  // and never self-selects one. Without a named game, the best game still
  // gets the segment, under another name; the title game is the title game.
  const named = games.find(s => s.facts.flags?.includes('game-of-the-week'));
  const gotw = named || games[0] || null;
  const gotwName = named ? null
    : name === 'championship' ? { title: 'The Title Game', lowerThird: String(network.championshipName || 'the Championship').toUpperCase() }
      : { title: 'Spotlight Game', lowerThird: 'SPOTLIGHT GAME' };
  const debateTopic = stories.find(s => s.id !== gotw?.id && ['trade', 'game', 'streak', 'performance', 'dev_change', 'signing', 'milestone', 'team_preview'].includes(s.type)) || gotw;
  // Season-preview stories have segments of their own; Gus only gets them
  // when nothing else in the episode looks suspicious.
  const ownSegment = s => ['talent', 'division_preview'].includes(s.type);
  const suspicious = stories.find(s => s.id !== debateTopic?.id && (
    (s.type === 'game' && (s.facts.flags?.includes('upset') || s.facts.flags?.includes('blowout'))) ||
    ['trade', 'injury', 'rank_move', 'owner_change', 'dev_change', 'roster_quirk'].includes(s.type)))
    || stories.find(s => s.id !== debateTopic?.id && !ownSegment(s))
    || stories.find(s => s.id !== debateTopic?.id) || null;

  const segments = [];
  for (const kind of kinds) {
    const def = show.segments[kind] || show.segments.custom;
    const seg = {
      id: `s${segments.length + 1}`,
      kind,
      title: def.title,
      lowerThird: def.lowerThird,
      set: def.set || 'desk',
      cast: cast(def.cast || ['host']),
      targetSeconds: def.seconds,
      storyIds: [],
      cards: [],
      brief: '',
    };
    const add = list => { for (const s of list) seg.storyIds.push(s.id); seg.cards.push(...storyCards(list)); };

    switch (kind) {
      case 'cold_open': {
        const top = (breakingStories.length ? breakingStories : stories).slice(0, 3);
        seg.storyIds = top.map(s => s.id);
        seg.cards = top.map(s => card(C.headline(s.category || 'TONIGHT', s.headline.toUpperCase(), s.teams, league), s.id));
        seg.brief = name === 'premiere'
          ? `This is the first episode ${network.name} has ever aired, and the start of a new season. Welcome viewers to the premiere, say what the network is in a line, tease the top stories in one punchy line each (details come later), and toss to the desk introductions.`
          : 'Open the show: welcome viewers, tease the top stories in one punchy line each (details come later), and toss to the first segment.';
        break;
      }
      case 'meet_the_desk':
        for (const a of seg.cast.map(id => anchors.find(x => x.id === id)).filter(Boolean)) seg.cards.push(card(C.headline('MEET THE DESK', `${a.name} • ${a.role}`.toUpperCase())));
        seg.brief = `The anchors introduce themselves, in the order of the cast list, one card each. The host goes first and introduces ${network.name}. Each anchor gives their name, what they cover on the show and one line of personality drawn from their bio, then hands to the next by name. Let one rivalry from the show bible surface in a single friendly jab. No league facts here; this segment is about the people.`;
        break;
      case 'talent_report': {
        const list = pickStories(['talent'], 1);
        add(list);
        for (const s of list) for (const c of s.extraCards || []) seg.cards.push(card(c, s.id));
        seg.brief = `Where the stars landed: the league's top-rated players and which teams have them, then the best by position group. Bring up each top-rated player card as you name that player. Use only the players, teams and ratings in the facts.`;
        break;
      }
      case 'division_preview':
        add(pickStories(['division_preview'], 4));
        seg.targetSeconds = Math.max(seg.targetSeconds, seg.storyIds.length * 50);
        seg.brief = 'Go around the league one conference at a time, division by division: who looks strongest on paper by team overall, a star or two on each contender, and one team per conference the analysts think is better or worse than its rating. Ratings are preseason; no games have been played, so never quote records or results.';
        break;
      case 'scoreboard':
        if (context.scoreboard) {
          seg.cards.push(card(context.scoreboard));
          seg.storyIds = games.map(s => s.id);
          seg.targetSeconds += Math.max(0, games.length - 8) * 4;
          seg.brief = `Quick-hit every final score on the board, a few words each, louder for upsets and blowouts. Save the deep dive for the ${gotwName ? gotwName.title.replace(/^The /, 'the ') : 'Game of the Week'}.`;
        }
        break;
      case 'game_of_week':
        if (gotwName) Object.assign(seg, gotwName);
        if (gotw) {
          used.add(gotw.id);
          add([gotw]);
          seg.brief = named
            ? 'Break down the Game of the Week: how it was won, the top performers, what it means. The analysts disagree about something.'
            : `Break down ${gotwName.title === 'Spotlight Game' ? 'the Spotlight Game, the best game of the week' : 'the title game'}: how it was won, the top performers, what it means. The league has not named an official Game of the Week, so never call it that. The analysts disagree about something.`;
        }
        break;
      case 'top_performers': {
        const pw = context.playersOfWeek || {};
        const potw = [pw.offense, pw.defense].filter(p => p?.card);
        for (const p of potw) seg.cards.push(card(p.card));
        // Don't repeat a player of the week as a separate "big game" story.
        add(pickStories(['performance', 'milestone'], 3, s => !potw.some(p => p.name === s.facts.player)));
        if (context.weekLeaders?.data.sections.length) seg.cards.push(card(context.weekLeaders));
        seg.brief = 'Name the offensive and defensive players of the week with their stat lines, then any big individual games or milestones.';
        break;
      }
      case 'standings':
        add(pickStories(STANDINGS_TYPES, 3));
        for (const c of context.standings || []) seg.cards.push(card(c));
        seg.brief = 'Walk through the standings: division leaders, hot and cold streaks, and the biggest risers and fallers.';
        break;
      case 'playoff_race':
        add(pickStories(STANDINGS_TYPES, 4));
        if (context.playoffPicture) seg.cards.push(card(context.playoffPicture));
        seg.brief = 'Lay out the playoff picture: who is in, who is chasing, who clinched, and which games matter next.';
        break;
      case 'transactions':
        add(pickStories(TRANSACTION_TYPES, 5));
        seg.targetSeconds += Math.max(0, seg.storyIds.length - 2) * 8;
        seg.brief = 'The insider reports each move with the confirmed details only; the analyst reacts to who won the deal.';
        break;
      case 'injuries':
        add(pickStories(['injury', 'return'], 4));
        if (!seg.storyIds.length && context.injuries) seg.cards.push(card(context.injuries));
        seg.brief = 'Report the key injuries and returns: who, how long, and what it means for the team.';
        break;
      case 'press_review':
        for (const a of chronicle.slice(0, 3)) { seg.storyIds.push(a.id); seg.cards.push(card(a.card, a.id)); used.add(a.id); }
        seg.brief = `React to the latest from ${network.chronicleName}. Credit the outlet and author by name, summarize each piece fairly, then give the desk's take.`;
        break;
      case 'league_office':
        for (const a of hub.slice(0, 3)) { seg.storyIds.push(a.id); seg.cards.push(card(a.card, a.id)); used.add(a.id); }
        seg.brief = 'Relay the official announcements from the league office accurately; keep jokes light.';
        break;
      case 'debate':
        if (debateTopic) {
          seg.storyIds.push(debateTopic.id);
          seg.cards.push(card(debateTopic.card, debateTopic.id));
          seg.brief = `A heated but friendly debate about: "${debateTopic.headline}". The two analysts take opposite sides; the host referees and gets the last word.`;
        }
        break;
      case 'conspiracy_corner':
        if (suspicious) {
          seg.storyIds.push(suspicious.id);
          const pins = suspicious.teams.map(id => C.teamRef(league, id));
          const words = [suspicious.category, ...(suspicious.headline.match(/\d+-\d+|\d+/g) || []).slice(0, 2)].filter(Boolean);
          seg.cards.push(card(C.corkboard(suspicious.headline.toUpperCase(), pins, words), suspicious.id));
          seg.brief = `Gus "investigates" this: "${suspicious.headline}". Absurd, harmless theories (the sim, the schedule, the dice) using only the real facts; the host is unconvinced. Never accuse a real person of cheating.`;
        }
        break;
      case 'preview':
        if (context.matchups) {
          seg.cards.push(card(context.matchups));
          seg.brief = `Preview the best matchups of ${context.nextWeek.label}. Each analyst makes a pick; picks are saved as predictions.`;
        }
        break;
      case 'power_rankings':
        if (context.powerRankings) {
          seg.cards.push(card(context.powerRankings));
          seg.brief = 'Count down the top of the power rankings with a sentence of reasoning per team; the analysts argue about one placement.';
        }
        break;
      case 'predictions':
        if (context.powerRankings) seg.cards.push(card(context.powerRankings));
        seg.brief = name === 'premiere'
          ? `Everyone makes one bold, specific prediction for the new season, ideally about a team or player from tonight's facts, with a clear way to tell later whether it came true. Predictions are saved and will be revisited on air.`
          : 'Everyone makes one bold prediction for the season ahead. Predictions are saved and will be revisited on air.';
        break;
      case 'draft_desk':
        add(pickStories(['roster_rebuild', 'rookies'], 6));
        seg.brief = seg.storyIds.some(id => id.startsWith('rebuild:'))
          ? 'The fantasy draft is done: where the biggest names landed, which rosters look strongest, and who won the draft. Grade any rookie classes too.'
          : 'Grade the incoming rookie classes: top picks, steals, and which team won the draft.';
        break;
      case 'free_agency':
        add(pickStories(['signing', 'release', 'extension'], 6));
        seg.brief = 'Run through the biggest free-agent signings and departures and who is still available.';
        break;
      case 'bracket':
        if (context.bracket) {
          seg.cards.push(card(context.bracket));
          seg.brief = 'Walk the playoff bracket: results so far and the road to the championship.';
        }
        break;
      case 'season_review':
        if (context.seasonLeaders) seg.cards.push(card(context.seasonLeaders));
        add(pickStories(['streak', 'milestone', 'performance', 'trade'], 3));
        seg.brief = 'Look back on the season: the champion, the stat leaders, the storylines from the show memory, and what is next.';
        break;
      case 'breaking':
        for (const s of breakingStories.slice(0, 2)) {
          used.add(s.id);
          seg.storyIds.push(s.id);
          seg.cards.push(card(C.breaking(s.headline.toUpperCase(), s.category || 'BREAKING NEWS'), s.id));
          if (s.card) seg.cards.push(card(s.card, s.id));
        }
        seg.brief = 'A breaking news bulletin: the host interrupts with urgency, the insider reports the confirmed details, an analyst gives a quick reaction, back to regular programming.';
        break;
      case 'signoff':
        seg.brief = name === 'premiere'
          ? `Thank the viewers for watching the first ${network.name}, say when the show is back (after each advance, plus breaking news as it happens), one last callback, and sign off with "${network.tagline}"`
          : `Thank the viewers, one last joke or callback, and sign off with "${network.tagline}"`;
        break;
      default:
        seg.brief = notes || 'A special report.';
    }

    const optional = show.optional.includes(kind);
    if (optional && !seg.storyIds.length && !seg.cards.length) continue;
    if (!optional && !['cold_open', 'signoff', 'predictions', 'custom', 'meet_the_desk'].includes(kind) && !seg.storyIds.length && !seg.cards.length) continue;
    seg.cards = seg.cards.filter(Boolean);
    seg.targetWords = Math.round(seg.targetSeconds * (show.wordsPerSecond || 2.5));
    segments.push(seg);
  }
  segments.forEach((s, i) => { s.id = `s${i + 1}`; });

  return {
    type, phase, name,
    title: title || titleFor(name, context, breakingStories, network),
    weekLabel: context.weekLabel || '',
    focusWeek: context.focusWeek || null,
    notes,
    segments,
    storyIds: [...new Set(segments.flatMap(s => s.storyIds))],
    targetWords: segments.reduce((n, s) => n + s.targetWords, 0),
    createdAt: new Date().toISOString(),
  };
}

// Cut at a word boundary, with an ellipsis.
function clipWords(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, '') + '...';
}

// Chronicle articles and Hub announcements as story-like items for the rundown.
function chronicleItem(a, outlet) {
  return {
    id: a.id, type: 'chronicle', category: 'THE CHRONICLE', score: a.breaking ? 70 : 40,
    headline: a.title, teams: [], players: [],
    facts: { outlet, title: a.title, author: a.author || null, issue: a.issue || null, published: a.published || null, url: a.url || null, excerpt: a.excerpt || '' },
    card: C.quote(outlet.toUpperCase(), a.title, a.pullQuote || clipWords(a.excerpt || '', 170), a.author),
  };
}

function hubItem(a) {
  return {
    id: `hub:${a.id}`, type: 'hub', category: 'LEAGUE OFFICE', score: a.breaking ? 70 : 45,
    headline: a.title, teams: [], players: [],
    facts: { title: a.title, body: String(a.body || '').slice(0, 800), date: a.date || null },
    card: C.headline('LEAGUE OFFICE', a.title.toUpperCase()),
  };
}

module.exports = { buildRundown, castResolver, rundownName, chronicleItem, hubItem, TRANSACTION_TYPES, STANDINGS_TYPES };
