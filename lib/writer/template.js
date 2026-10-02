// The offline writer: builds a complete, valid script from the rundown with
// phrase templates — no API key needed. Used for tests, the demo, and as the
// fallback when Claude isn't configured. It is deliberately plainer than the
// Claude writer, but every line is grounded in the same facts.
'use strict';
const { seededRandom, pick } = require('../util');

function writeTemplateScript({ rundown, storiesById, personas, league = null, context = {}, seed = rundown.title }) {
  const rand = seededRandom(`${seed}`);
  const anchors = Object.fromEntries(personas.anchors.map(a => [a.id, a]));
  // Say "the Bills", not "B U F": cards carry abbreviations.
  const nickByAbbr = Object.fromEntries(Object.values(league?.teams || {}).map(t => [t.abbr, t.nickname]));
  const nick = abbr => nickByAbbr[abbr] || abbr;
  const net = personas.network;
  const segments = [];
  const predictions = [];
  const storylines = [];
  const moods = [];
  const usedCatch = new Set();

  // A persona's catchphrase, at most once per episode.
  const catchphrase = id => {
    const a = anchors[id];
    if (!a || usedCatch.has(id) || !a.catchphrases?.length) return '';
    usedCatch.add(id);
    return ' ' + pick(rand, a.catchphrases);
  };

  for (const seg of rundown.segments) {
    const [lead, second = lead, third = second] = seg.cast;
    const lines = [];
    const say = (speaker, text, emotion = 'neutral', gesture = 'none', card = '', shot = 'auto') =>
      lines.push({ speaker, text: text.replace(/\s+/g, ' ').trim(), emotion, gesture, shot, card });
    const stories = seg.storyIds.map(id => storiesById[id]).filter(Boolean);
    const cardFor = id => seg.cards.find(c => c.storyId === id)?.id || '';
    const firstCard = type => seg.cards.find(c => c.type === type)?.id || '';

    switch (seg.kind) {
      case 'cold_open': {
        say(lead, `Good evening, and welcome to ${net.name} Tonight. I'm ${anchors[lead].name}.`, 'happy', 'none', '', 'wide');
        stories.forEach((s, i) => {
          const who = i === stories.length - 1 && stories.length > 1 ? second : lead;
          const intro = i === 0 ? 'Tonight: ' : i === stories.length - 1 ? 'And ' : '';
          say(who, `${intro}${s.headline}.`, i === 0 ? 'excited' : 'neutral', 'none', seg.cards[i]?.id || '');
        });
        say(lead, rundown.weekLabel ? `${rundown.weekLabel} is in the books. Let's get to it.` : `Plenty to get to. Let's go.`, 'happy');
        break;
      }
      case 'scoreboard': {
        const games = stories.slice().sort((a, b) => b.score - a.score);
        say(lead, pick(rand, ["Let's go around the league.", "Let's run through the board.", "Here's how it all shook out."]), 'neutral', 'none', firstCard('scoreboard'), 'full_graphic');
        // The host reads the board two games at a time; the analyst only
        // jumps in on upsets and blowouts.
        let reactions = 0;
        for (let i = 0; i < games.length; i += 2) {
          const pair = games.slice(i, i + 2);
          say(lead, pair.map(gameSentence).join(' '), 'neutral', 'none', '', 'full_graphic');
          const flagged = pair.find(g => g.facts.flags.includes('upset') || g.facts.flags.includes('blowout'));
          if (flagged && reactions < 3) {
            reactions++;
            const upset = flagged.facts.flags.includes('upset');
            say(second, upset ? pick(rand, [`Upset alert on that ${flagged.facts.winner} win. Nobody saw that coming.`, `The ${flagged.facts.winner}? Really? I did not have that one.`])
              : pick(rand, ['That one was over early. Ugly.', 'Somebody check on that defense.']), upset ? 'shocked' : 'laughing', upset ? 'none' : 'facepalm');
          }
        }
        break;
      }
      case 'game_of_week': {
        const g = stories[0];
        if (!g) break;
        const f = g.facts;
        say(lead, `${seg.title === 'The Title Game' ? 'The title game' : `Our ${seg.title}`}: the ${f.away.team} at the ${f.home.team}.`, 'excited', 'none', cardFor(g.id), 'graphic');
        const winAbbr = f.winner ? (f.home.score > f.away.score ? f.home.abbr : f.away.abbr) : null;
        const perfs = f.topPerformers.slice().sort((a, b) => (b.includes(`(${winAbbr})`) ? 1 : 0) - (a.includes(`(${winAbbr})`) ? 1 : 0));
        say(lead, f.winner ? `Final score: ${scoreText(f)}.${f.flags.includes('upset') ? ' And yes, that is an upset.' : ''}` : `It ended in a ${f.home.score}-${f.away.score} tie.`);
        if (perfs[0]) say(third, `Look at ${performer(perfs[0])}. That's the story of this game.`, 'smug', 'point');
        say(second, f.flags.includes('nail-biter') ? `This came down to who wanted it more in the fourth quarter.${catchphrase(second)}` : `It was won in the trenches, plain and simple.${catchphrase(second)}`, 'excited', 'desk_slam', '', 'single');
        if (perfs[1]) say(third, `And don't sleep on ${performer(perfs[1])}.`);
        say(lead, `A statement win for the ${f.winner || 'both teams'}. We'll see if it carries over.`);
        break;
      }
      case 'top_performers': {
        // Players of the week are the cards with no story behind them.
        for (const c of seg.cards.filter(c => c.type === 'player' && !c.storyId)) {
          const d = c.data;
          say(lead, `${titleCase(d.tag)}: ${d.name} of the ${nick(d.team)}. ${capitalize(spokenLine(d.line))}.`, 'excited', 'point', c.id, 'graphic');
        }
        for (const s of stories) {
          say(second, `${s.headline}${s.facts.seasonTotal ? `, now at ${s.facts.seasonTotal} on the season` : ''}.`, 'happy', 'none', cardFor(s.id), 'graphic');
        }
        if (!lines.length) say(lead, 'A quiet week for individual numbers. Somebody step up next week.');
        if (firstCard('leaders')) say(lead, 'Here are your weekly leaders.', 'neutral', 'none', firstCard('leaders'), 'full_graphic');
        break;
      }
      case 'standings': case 'playoff_race': {
        const tableCards = seg.cards.filter(c => c.type === 'standings' || c.type === 'playoff_picture');
        say(lead, seg.kind === 'playoff_race' ? `Let's look at the playoff picture.` : `Let's check the standings.`, 'neutral', 'none', tableCards[0]?.id || '', 'full_graphic');
        for (const s of stories) say(second, `${s.headline}${s.facts.record ? `, sitting at ${s.facts.record}` : ''}.`, s.type === 'streak' && /lose|winless/.test(s.headline) ? 'sad' : 'neutral', 'none', cardFor(s.id));
        if (tableCards[1]) say(lead, `And on the other side of the bracket.`, 'neutral', 'none', tableCards[1].id, 'full_graphic');
        say(second, `${pick(rand, ['It is still early, but the table is starting to tell a story.', 'Somebody on this board is due for regression.', 'Some of these teams are not as good as their record.'])}${catchphrase(second)}`, 'smug');
        break;
      }
      case 'transactions': case 'free_agency': {
        say(lead, `${pick(rand, ['Busy day on the wire.', 'The phones have been ringing.', 'Plenty of movement around the league.'])}${catchphrase(lead)}`, 'excited', 'none', '', 'single');
        for (const s of stories) {
          say(lead, transactionSentence(s), 'serious', 'none', cardFor(s.id), 'graphic');
          if (s.type === 'trade' || (s.facts.player?.overall || 0) >= 85) {
            say(second, pick(rand, ['I love this move. That is how you build a contender.', 'I hate it. They just got fleeced.', 'Bold. Very bold. We will find out soon if it was smart.']), pick(rand, ['excited', 'angry', 'smug']), pick(rand, ['desk_slam', 'shrug', 'point']));
          }
        }
        break;
      }
      case 'injuries': {
        if (!stories.length && seg.cards[0]) say(lead, `Here is the current injury report.`, 'serious', 'none', seg.cards[0].id, 'full_graphic');
        for (const s of stories) {
          const p = s.facts.player;
          say(lead, s.type === 'return'
            ? `Good news for the ${teamNick(s.facts.team)}: ${p.name} is back.`
            : `${p.name} of the ${teamNick(s.facts.team)} is ${s.facts.injuredReserve ? 'headed to injured reserve' : `out ${s.facts.weeksOut} week${s.facts.weeksOut === 1 ? '' : 's'}`}.`,
          s.type === 'return' ? 'happy' : 'serious', 'none', cardFor(s.id), 'graphic');
        }
        say(second, pick(rand, ['Tough break. Next man up.', 'Depth gets tested now.', 'That changes the outlook for that whole roster.']), 'sad');
        break;
      }
      case 'press_review': {
        for (const s of stories) {
          const f = s.facts;
          say(lead, `Over at ${f.outlet}${f.author ? `, ${f.author} writes` : ''}: "${f.title}".`, 'neutral', 'none', cardFor(s.id), 'graphic');
          const first = firstSentence(f.excerpt);
          if (first) say(lead, `The gist: ${first}`);
          say(second, pick(rand, ['Strong take. I am with them on that one.', 'Respectfully, I could not disagree more.', 'Required reading this week. Go check it out.']), pick(rand, ['smug', 'angry', 'happy']));
        }
        break;
      }
      case 'league_office': {
        for (const s of stories) {
          say(lead, `From the league office: ${s.facts.title}.`, 'serious', 'none', cardFor(s.id), 'graphic');
          const first = firstSentence(s.facts.body);
          if (first) say(second, first);
        }
        break;
      }
      case 'debate': {
        const s = stories[0];
        if (!s) break;
        say(third, `Time for the Hot Take Hotline. Tonight: ${s.headline}.`, 'excited', 'none', cardFor(s.id), 'graphic');
        say(lead, `${pick(rand, ['This is a big deal and I will die on this hill.', 'I have seen this movie before, and I know how it ends.', 'Everybody is overreacting except me.'])}${catchphrase(lead)}`, 'angry', 'desk_slam', '', 'single');
        const num = firstFactNumber(s.facts);
        say(second, num ? `Hold on. The number that matters here is ${num}. Context, people.${catchphrase(second)}` : `The numbers tell a very different story.${catchphrase(second)}`, 'smug', 'point', '', 'single');
        say(lead, `The numbers didn't play the game!`, 'angry', 'arms_crossed', '', 'two_shot');
        say(third, `And on that note, we'll call it a draw. For now.`, 'laughing', 'shrug', '', 'wide');
        moods.push({ persona: lead, mood: 'fired up' }, { persona: second, mood: 'smug' });
        break;
      }
      case 'conspiracy_corner': {
        const s = stories[0];
        if (!s) break;
        say(lead, `Welcome back to Conspiracy Corner. I've been looking into something.`, 'suspicious', 'lean_in', cardFor(s.id), 'single');
        say(lead, `${s.headline}. ${pick(rand, ['The sim engine wanted this.', 'Check the schedule makers. Check them.', 'Someone rolled those dice twice.'])}${catchphrase(lead)}`, 'suspicious', 'point', '', 'graphic');
        say(second, pick(rand, ['Gus, it is a football game.', 'Thank you, Gus. I think.', 'We have talked about the red string, Gus.']), 'laughing', 'facepalm', '', 'two_shot');
        say(lead, pick(rand, ['Wake up, HFL.', 'Follow the red string.', 'Just asking questions.']), 'suspicious', 'none', '', 'single');
        break;
      }
      case 'preview': {
        const m = seg.cards.find(c => c.type === 'matchups');
        if (!m) break;
        say(lead, `Looking ahead to ${context.nextWeek?.label || 'next week'}, here are the matchups to watch.`, 'excited', 'none', m.id, 'full_graphic');
        m.data.games.slice(0, 3).forEach((g, i) => {
          const picker = i % 2 === 0 ? second : third;
          const choice = pick(rand, [g.away, g.home]);
          say(lead, `The ${g.away.nick || nick(g.away.abbr)} at the ${g.home.nick || nick(g.home.abbr)}.`);
          say(picker, `I'm taking the ${choice.nick || choice.abbr}. Write it down.`, 'smug', 'point');
          predictions.push({ persona: picker, text: `${choice.nick || choice.abbr} win (${g.away.abbr} at ${g.home.abbr}, ${context.nextWeek?.label || 'next week'})` });
        });
        break;
      }
      case 'power_rankings': case 'predictions': {
        const pr = seg.cards.find(c => c.type === 'power_rankings');
        const rows = pr?.data.rows || [];
        if (seg.kind === 'predictions') {
          // The rankings card stays up for reference; the countdown was its own segment.
          if (pr) say(lead, `Bold predictions time. Everybody gets one.`, 'excited', 'none', pr.id, 'full_graphic');
          for (const id of seg.cast.slice(0, 4)) {
            const team = pick(rand, rows.length ? rows : [{ abbr: 'the champs' }]);
            const text = `The ${nick(team.abbr)} make a deep playoff run.`;
            say(id, `Bold prediction: ${text}${catchphrase(id)}`, 'excited', 'point');
            predictions.push({ persona: id, text });
          }
          break;
        }
        if (pr) say(lead, `Let's run the power rankings.`, 'neutral', 'none', pr.id, 'full_graphic');
        // Before a game is played every record is 0-0, which isn't worth saying.
        rows.slice(0, 5).reverse().forEach(r => say(lead, `Number ${r.rank}: the ${nick(r.abbr)}${r.rec && !/^0-0(-0)?$/.test(r.rec) ? `, at ${r.rec}` : ''}.`));
        if (rows[0]) say(second, `The ${nick(rows[0].abbr)} at the top? I have questions.`, 'angry', 'shrug');
        break;
      }
      case 'draft_desk': {
        for (const s of stories) {
          say(lead, `${s.headline}.`, 'excited', 'none', cardFor(s.id), 'graphic');
          if (s.facts.picks?.[0]) say(second, `Top pick: ${s.facts.picks[0]}. ${pick(rand, ['Grade: A.', 'Grade: B plus.', 'Grade: incomplete.'])}`, 'smug');
        }
        break;
      }
      case 'bracket': {
        say(lead, `Here is the road to ${net.championshipName}.`, 'excited', 'none', firstCard('bracket'), 'full_graphic');
        say(second, `Every game from here is win or go home.`, 'serious');
        break;
      }
      case 'season_review': {
        say(lead, `What a season it has been.`, 'happy', 'none', firstCard('leaders'), 'full_graphic');
        for (const s of stories) say(second, `${s.headline}.`, 'neutral', 'none', cardFor(s.id));
        say(third, `We will be talking about this one for a long time.`, 'happy');
        break;
      }
      case 'breaking': {
        const s = stories[0];
        if (!s) break;
        const bc = seg.cards.find(c => c.type === 'breaking');
        say(lead, `We interrupt this program with breaking news.`, 'serious', 'none', bc?.id || '', 'single');
        say(second, `${anchors[second].kind === 'insider' ? 'My sources tell me: ' : ''}${transactionSentence(s)}`, 'excited', 'none', seg.cards.find(c => c.storyId === s.id && c.type !== 'breaking')?.id || '', 'graphic');
        if (stories[1]) say(second, `Also developing: ${stories[1].headline}.`, 'serious');
        say(third, pick(rand, ['This changes everything.', 'I did not see that coming.', 'Big, big move.']), 'shocked', 'desk_slam', '', 'single');
        say(lead, `We'll have more on this story as it develops. ${net.tagline}`, 'serious', 'none', '', 'wide');
        storylines.push({ key: s.id, text: s.headline });
        break;
      }
      case 'signoff': {
        const others = personas.anchors.filter(a => a.id !== lead).map(a => a.short);
        say(lead, `That's all for tonight. For ${listText(others)}, I'm ${anchors[lead].name}. ${net.tagline}`, 'happy', 'none', '', 'wide');
        break;
      }
      default:
        say(lead, rundown.notes || 'We have a special report tonight.', 'serious');
        for (const s of stories) say(second, `${s.headline}.`, 'neutral', 'none', cardFor(s.id));
    }
    if (!lines.length) say(lead, `${seg.title}. More on this next time.`);
    segments.push({ id: seg.id, lines });
  }

  const top = rundown.storyIds.map(id => storiesById[id]).filter(Boolean).sort((a, b) => b.score - a.score);
  if (top[0] && !storylines.length) storylines.push({ key: top[0].id, text: top[0].headline });
  return {
    title: rundown.title,
    summary: top.slice(0, 2).map(s => s.headline).join('. ') + (top.length ? '.' : `${rundown.title}.`),
    tickerItems: top.slice(0, 8).map(s => s.headline.toUpperCase()),
    segments,
    memoryUpdates: { storylines, predictions, moods },
  };
}

// ─── Phrasing helpers ──────────────────────────────────────────────────────
function scoreText(f) {
  const [w, l] = f.home.score >= f.away.score ? [f.home, f.away] : [f.away, f.home];
  return `${teamNick(w.team)} ${w.score}, ${teamNick(l.team)} ${l.score}`;
}

function gameSentence(s) {
  const f = s.facts;
  if (!f.winner) return `The ${teamNick(f.away.team)} and ${teamNick(f.home.team)} played to a ${f.home.score}-${f.away.score} tie.`;
  const [w, l] = f.home.score > f.away.score ? [f.home, f.away] : [f.away, f.home];
  const verb = f.flags.includes('upset') ? 'stunned' : f.flags.includes('shutout') ? 'shut out' : f.flags.includes('blowout') ? 'blew out'
    : f.margin <= 3 ? 'edged' : f.margin >= 17 ? 'rolled past' : 'beat';
  return `The ${teamNick(w.team)} ${verb} the ${teamNick(l.team)}, ${w.score} to ${l.score}.`;
}

function transactionSentence(s) {
  const f = s.facts;
  const p = f.player;
  switch (s.type) {
    case 'trade': {
      const recv = Object.entries(f).filter(([k]) => k.endsWith(' receive'));
      const parts = recv.filter(([, list]) => list.length).map(([k, list]) => `the ${k.replace(' receive', '')} get ${listText(list.map(x => x.replace(/ \(.*\)$/, '')))}`);
      return `Trade alert: ${listText(f.teams.map(teamNick))} have made a deal. ${capitalize(parts.join(', and '))}.`;
    }
    case 'signing': return `The ${teamNick(f.team)} have signed ${p.position} ${p.name}, a ${p.overall} overall${p.devTrait !== 'Normal' ? ` ${p.devTrait}` : ''}${f.years ? ` on a ${f.years}-year deal${f.contractTotal ? ` worth ${spokenMoney(f.contractTotal)}` : ''}` : ''}.`;
    case 'release': return `The ${teamNick(f.team)} have released ${p.position} ${p.name}, a ${p.overall} overall.`;
    case 'extension': return `The ${teamNick(f.team)} have locked up ${p.position} ${p.name}${f.years ? ` for ${f.years} more years` : ''}${f.contractTotal ? `, ${spokenMoney(f.contractTotal)} in total` : ''}.`;
    case 'retirement': return `${p.name} is hanging it up. The ${p.position} retires from the ${teamNick(f.team)}${f.yearsPro ? ` after ${f.yearsPro} seasons` : ''}.`;
    case 'departure': return `${p.name} is no longer on the ${teamNick(f.team)} roster.`;
    case 'dev_change': return `${p.name} of the ${teamNick(f.team)} has gone from ${f.from} to ${f.to}.`;
    case 'rating_change': return `${p.name} of the ${teamNick(f.team)} moves from ${f.from} to ${f.to} overall.`;
    case 'owner_change': return `${s.headline}. The ${teamNick(f.team)} have new leadership.`;
    case 'roster_rebuild': return `The rosters have been rebuilt: ${f.playersMoved} players are on new teams.${f.headliners?.length ? ` The biggest names: ${listText(f.headliners.slice(0, 3).map(x => x.replace(/ \(.*?\)/, '')))}.` : ''}`;
    case 'injury': return `${p.name} of the ${teamNick(f.team)} is ${f.injuredReserve ? 'headed to injured reserve' : `out ${f.weeksOut} weeks`}.`;
    default: return `${s.headline}.`;
  }
}

const teamNick = full => String(full || '').split(' ').pop();
const listText = arr => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = s => String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const firstSentence = s => (String(s || '').match(/[^.!?]+[.!?]/) || [''])[0].trim().slice(0, 220);
const spokenMoney = m => String(m).replace(/^\$([\d.]+)M$/, '$1 million dollars').replace(/^\$([\d.]+)K$/, '$1 thousand dollars');

function spokenLine(line) {
  return String(line || '')
    .replace(/(\d+)\/(\d+)/, '$1 of $2')
    .replace(/\byds\b/g, 'yards').replace(/\bcar\b/g, 'carries').replace(/\brec\b/g, 'catches')
    .replace(/\btkl\b/g, 'tackles').replace(/\bFF\b/g, 'forced fumbles')
    .replace(/(\d+) TD\b/g, (m, n) => `${n} touchdown${n === '1' ? '' : 's'}`)
    .replace(/(\d+) INT\b/g, (m, n) => `${n} interception${n === '1' ? '' : 's'}`);
}

// "Josh Allen (BUF): 24/31, 308 yds, 5 TD, 1 INT" → "Josh Allen: 24 of 31, 308 yards, 5 touchdowns, 1 interception"
function performer(str) {
  const m = String(str).match(/^(.*) \(([A-Z0-9]+)\): (.*)$/);
  return m ? `${m[1]}: ${spokenLine(m[3])}` : spokenLine(str);
}

function firstFactNumber(facts) {
  const s = JSON.stringify(facts || {});
  const m = s.match(/\b(\d{2,4})\b/);
  return m ? m[1] : null;
}

module.exports = { writeTemplateScript, gameSentence, transactionSentence, spokenLine };
