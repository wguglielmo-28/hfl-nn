# HFL-NN roadmap

The goal: a league news network that follows every HFL update, in the spirit of
[PNN](https://pnn.watch/) (a 24/7 AI channel with a schedule, recurring shows,
anchors with memories, viewer questions on air, and a public record of every
story and its source).

This file is the spec book. The scoreboard (vision, goals, quests, decisions,
history) is the Realm charter: `C:\Claude\realm\data\charters\hfl-nn.md`.

## How we work

- **Brainstorm.** Any idea goes in the [Backlog](#backlog) with a one-line why.
  Nothing in the backlog is built until a review moves it into a pillar.
- **Plan.** Each release gets a short spec here (scope, cost, tests) before any
  code. A release is about one PR and 1–3 sessions.
- **Build.** One release per approval: branch → PR (the owner merges) →
  Railway deploys → confirmed on production (boot log + the new route or
  segment).
- **Oversee.** Each session starts by reading the charter and this file and
  names the next release. Each finished release ticks its charter quest, adds a
  chronicle line, and updates the status table below. Monthly: compare the
  control room's writer $ and ElevenLabs characters with the budget.

### Budget rule

About **$60 a month**: the `dailyCapUsd` $2/day writing cap, ElevenLabs
Starter (30k characters) for The Fifth Quarter only, Kokoro for everything
else. Every release states what it adds. Raising the cap or the ElevenLabs
plan is a charter decree the owner decides, never a side effect of a release.

## Where HFL-NN stands against PNN

| PNN has | HFL-NN today | Plan |
|---|---|---|
| 24/7 channel, program guide, recurring shows | Yes: `config/channel.json`, guide, 9 shows | — |
| Anchors with moods, feuds, memory | Yes: `lib/memory.js`, receipts, storylines | — |
| Talk/sports show | Yes: The Fifth Quarter | — |
| Live chat on the stream | Yes: Hub chat, Chat Check-Ins | — |
| Replays of every segment, 7 days | Whole episodes only | **B2** |
| "Every story we covered today" with sources | Sources panel under the player only | **B1** |
| Ask the desk (questions read on air) | Fan takes via the Week Desk only | **A1–A2** |
| Reacts to everything within minutes | Scheduled shows + breaking bulletins | Parked (**D**) |
| Many data feeds | Exports, Hub feed, Chronicle, chat, streams | **C1–C5** |
| Fire TV, socials, 3D world | — | Backlog |

## Status

| Release | Pillar | Status | Cost added |
|---|---|---|---|
| N0 Roadmap | — | done | $0 |
| B1 Today on HFL-NN | Sources & replays | done (PR #41, 2026-11-26) | $0 |
| B2 Segment replays | Sources & replays | built (claude/replays) | $0 |
| A1 Ask the desk (Hub) | Ask the desk | next | $0 |
| A2 Ask the desk (on air) | Ask the desk | planned | within the $2/day cap |
| C1 Player stats | More sources in | planned | $0 |
| C2 Sportsbook | More sources in | planned | $0 |
| C3 Drafts | More sources in | planned | $0 (special: within cap) |
| C4 Hub polls | More sources in | planned | $0 |
| C5 Discord | More sources in | decree first | $0 |
| D Live wire | — | parked | needs a bigger budget |

## Pillar B: Sources & replays

### B1. Today on HFL-NN (`/today`)
Every story that aired today, grouped by episode and segment, each credited to
its source: the Madden export (game, team), a Crimson Chronicle article (with
its link), a Hub announcement, or the commissioner's desk.
- Data: published episodes from `producer.list()`, their `stories` and
  manifest `segments`. Reuse the source labels from the sources panel in
  `public/js/channel.js`.
- Files: `server.js` (route + `GET /api/today`), `public/today.html`,
  `public/js/today.js`.
- Tests: an aired story shows with its source; a draft or unpublished episode
  shows nothing; a day boundary in league time (America/New_York).

### B2. Segment replays (`/replays`)
Every segment from the last 7 days as its own entry that starts the episode
audio at the segment's start (`t0` from the manifest). No new audio.
- Files: `server.js` (`GET /api/replays`), `public/replays.html`,
  `public/js/replays.js`, `/watch/:id?t=` deep link in `public/js/channel.js`.
- Link it from the Hub's `/hfl-nn` page (hfl-hub, separate deploy).
- Tests: segments older than 7 days drop off; `t` lands on the segment.

## Pillar A: Ask the desk

### A1. Hub side (hfl-hub)
Signed-in members send a question (and an optional longer letter). A moderation
queue in Hub admin approves or rejects. Approved questions go out on
`/api/hfl-nn-feed` as `questions: [{ id, coach, team, text, letter, at }]`, the
same pattern as `fanTakes`.
- Coaches are named by their HFL names only, never Discord/Twitch/Hub handles.
- Deploy: `npm run deploy` after `git status` (other sessions edit hfl-hub).

### A2. On air (hfl-nn)
- `lib/ingest/hub.js` reads `questions`; the Week Desk and the channel desk list
  them.
- New "Ask the Desk" segment (1–2 questions) in Morning Blitz and HFL-NN
  Tonight; The Fifth Quarter's Mailbag uses them too (`lib/talk.js`).
- Each question airs once (the `hubUsed()` tracking). The answer is opinion;
  any number comes from the facts, never from the question.
- Files: `lib/ingest/hub.js`, `lib/desk.js`, `lib/rundown.js`,
  `config/show.json`, `config/channel.json`, `lib/writer/prompt.js`.

## Pillar C: More sources in

New story types in `lib/stories.js`, each with tests.

- **C1. Player stats.** Per-game passing, rushing, receiving and defensive lines
  from the ea-exporter's stats capture → richer `performance` / `milestone`
  stories and Stat Lab material. Files: ea-exporter delivery,
  `lib/ingest/madden.js`, `lib/stories.js`.
- **C2. Sportsbook.** Hub feed `sportsbook`: the week's lines, upsets against
  the spread, biggest play-money wins → `odds`, `upset`, `bettor` stories.
  Upbeat, play-money only, never advice.
- **C3. Drafts.** Rookie and fantasy draft picks from the Hub drafts →
  `draft_pick` stories and a "Draft Desk" special.
- **C4. Hub polls.** Poll results → `poll_result` stories. Tone stays
  positive and fun.
- **C5. Discord.** Reading the league Discord needs a bot and a privacy
  decision (which channels, opt-in or not). Decree before any spec.

## Parked

- **D. Live wire.** Every update airs within minutes as a short live hit, not
  only in scheduled shows. Needs more than $2/day of writing; revisit with a
  budget decree.

## Backlog

Ideas waiting for a review. Format: `- idea — why`.

- Program guide page with every show's description — PNN's Shows page makes the channel easy to browse.
- Fire TV / TV app — watch on the couch.
- Clips to socials (TikTok, YouTube Shorts) — growth outside the league.
- Anchor bio pages — the cast is the brand.
- Weather-style "Standings Center" live map — PNN's Weather Center equivalent for the playoff race.
