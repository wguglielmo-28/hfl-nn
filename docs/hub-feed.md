# HFL Hub → HFL-NN feed

HFL-NN reads league context from the HFL Hub through one small JSON document.
The Hub can either **serve it at a URL** that HFL-NN polls (set *Settings → HFL
Hub feed URL* in the control room), or **push it** to HFL-NN whenever something
changes:

```
POST https://<your-hfl-nn>/api/hub/push
Authorization: Bearer <HUB_PUSH_KEY>
Content-Type: application/json
```

`HUB_PUSH_KEY` is an environment variable you set on the HFL-NN server and give
to the Hub. Polling happens every *Check feeds every (minutes)* (default 20).

Every section is optional, unknown fields are ignored, and the whole document
must be under 2 MB. Send the full current state each time (not just changes).

## Format

```json
{
  "league": { "name": "Hypnotic Football League", "season": 2027, "phase": "regular", "week": 7 },

  "owners": [
    { "teamAbbr": "BUF", "displayName": "HypnoKing", "discord": "hypnoking", "coach": "Bob Skeeter",
      "since": 2024, "titles": 2, "note": "Biggest risk-taker in the league; trusts his offense completely" }
  ],

  "gamesOfTheWeek": [
    { "season": 9, "stage": "reg", "week": 7, "away": "PHI", "home": "GB" }
  ],

  "playersOfTheWeek": [
    { "season": 9, "stage": "reg", "week": 7, "side": "offense", "conference": "NFC", "rosterId": 555220998,
      "name": "De'Von Achane", "team": "ATL", "position": "HB", "line": "16 car · 206 yds · 3 TD", "manual": true }
  ],

  "announcements": [
    { "id": "trade-deadline-2027", "title": "Trade deadline set for the Week 9 advance",
      "body": "All trades must be approved before the Week 9 advance.", "date": "2027-10-01", "breaking": false }
  ],

  "powerRankings": [
    { "rank": 1, "teamAbbr": "BUF", "move": 2, "note": "Allen is cooking" }
  ],

  "awards":    [ { "name": "MVP", "winner": "Josh Allen", "team": "BUF", "season": 2026 } ],
  "rivalries": [ { "teams": ["BUF", "KC"], "note": "Three straight playoff meetings" } ],
  "records":   [ "Most passing yards in a season: 5,102 by Josh Allen (2026)" ],
  "history":   [ "2026 champion: Buffalo Bills (HypnoKing)" ]
}
```

| Section | Used for |
|---|---|
| `owners` | The writers know who runs each team (gamer tags are used sparingly and only playfully). `coach` is the owner's in-league persona, the name the Chronicle uses, and the anchors call them by it. `teamAbbr` must match the Madden abbreviation. |
| `gamesOfTheWeek` | The league's own Game of the Week. `week` is the week number as Madden shows it, starting at 1 (Wildcard 19, Divisional 20, Conference 21, Championship 23); a database `week_index` is one less. `stage` is `reg` or `pre`; `season` is informational. Teams can be in either order. Without a pick for the week, the show's top game is called the **Spotlight Game**, never the Game of the Week. Arizona matches as `ARI` or `AZ` (Madden 27's code). |
| `playersOfTheWeek` | The league's own Players of the Week: one `offense` and one `defense` pick per `conference` per week, weeks numbered as above. `rosterId` is the export's own, so the **Week Desk** preselects the Hub's pick: of the Hub's picks for a side, the one HFL-NN's stat ranking puts highest (a `manual` commissioner pick wins a tie). A pick HFL-NN doesn't rank still airs, with the Hub's `name`, `team` and `line`. |
| `announcements` | Each new `id` becomes a story for the **League Office** segment. `breaking: true` can trigger an automatic bulletin. Announcements air once. |
| `powerRankings` | Replaces the Madden power index on the **Power Rankings** card when present. |
| `awards`, `rivalries`, `records`, `history` | Background the writers can call back to. |

## Serving it from the Hub

If the Hub already stores this information, the quickest path is one read-only
route that assembles the document, for example `GET /api/hfl-nn-feed`. Keep it
public-safe (no emails or tokens) or protect it and push instead.

## Game streams for the 24/7 channel

Separate from the feed above, HFL-NN reads the Hub's `GET /api/hfl-nn-streams` once a minute
for members' game streams. The URL is the Hub feed URL with `hfl-nn-feed` replaced by
`hfl-nn-streams`; set `HUB_STREAMS_URL` to point somewhere else.

```json
{
  "version": 1,
  "live":    [{ "platform": "twitch", "member": "…", "channel": "login", "videoId": null,
                "startedAt": "…", "game": { "away": "NE", "home": "BUF", "awayName": "Patriots",
                "homeName": "Bills", "season": 9, "stage": "reg", "week": 6, "gotw": false } }],
  "replays": [{ "platform": "twitch", "member": "…", "channel": "login", "videoId": "777",
                "startedAt": "…", "endedAt": "…", "duration": 4800, "replayExpiresAt": "…",
                "game": { … }, "clips": [{ "id": "slug", "title": "…", "duration": 28.5, "views": 40 }] }]
}
```

- Only streams tied to a league game are used. Every id is checked against the shape Twitch
  or YouTube uses before it goes anywhere near a player address; anything else is dropped.
- **Live** games cut in over the schedule (Game of the Week first). If the Hub has not
  answered for five minutes, nothing is treated as live.
- **Replays** air in the `HFL Rewind` slots and **clips** in `Top Plays` (`config/channel.json`).
  A replay is not scheduled past its `replayExpiresAt`.
- Nothing is downloaded. Footage plays in Twitch's and YouTube's own embedded players, so
  HFL-NN's pages allow frames from `player.twitch.tv`, `clips.twitch.tv` and
  `www.youtube-nocookie.com`. Twitch only plays on HTTPS pages (or `localhost`).

## From members: `fanTakes` and `segmentRequests`

Optional. Each is a list of `{ "id", "name", "team", "text", "week" }`: something a member sent through the Hub's
HFL-NN page and a commissioner approved on the Hub's `/admin/hfl-nn`. `id` is the Hub's own (`nn42`), `team` an
abbreviation or empty, `text` at most 280 characters.

HFL-NN never airs these by itself. They appear on the Week Desk under **From members**; the commissioner adds the
ones worth using, and each becomes an ordinary desk headline (category `FAN TAKE` or `VIEWER REQUEST`) credited to
the member. A take is read as that member's opinion, never as fact.

## Ask the desk: `questions`

Optional, the same shape. A member's question for the anchors, approved on the Hub's `/admin/hfl-nn`. Unlike takes,
approved questions air by themselves (the Hub review is the gate): one or two at a time in the **Ask the Desk**
segment of Morning Blitz and HFL-NN Tonight, and in The Fifth Quarter's Mailbag. Each airs once; aired ids are kept
in `sources/hub-used.json` as `q:<id>`, marked when the episode publishes.

On air, members (for questions and takes alike) are credited only by their team's HFL coach name from
`config/coaches.json` ("Hank Nottick of the Packers"), or "a viewer" for a CPU team or no team. The feed's `name`
(a Hub handle) is never read out. The same file fills in `owners[].coach` when the Hub leaves it blank.


## Record chases: `recordChases`

Optional. Up to 12 `{ player, position, team, label, scope: 'season'|'game', level: 'broken'|'close'|'watch', value,
pace, mark: { book: 'HFL Hub'|'NeonSportz', value, holder, when } }`: the Hub's record-chase board (the one on its home
page), broken records first. Each becomes a wire story when the feed arrives: `record` for a record broken, and
`record_chase` for a season total close to a mark (within 10%) or on pace past it. Each level is its own story, once, so
a chase is news when it starts, when it gets close and when the record falls. The two record books are never merged:
every headline names which one ("the HFL Hub all-time single-season Rushing Yards record").

## The sportsbook: `sportsbook`

Optional; `null` while the Hub's play-money sportsbook is switched off. `{ week, lines: [{ away, home, favorite, spread,
total, favoriteWinPct }], lastWeek, upsets: [{ winner, loser, winnerScore, loserScore, spread }], bigWins: [{ team,
profit, kind, legs }], leaders: [{ team, profit, won, lost }] }`. Members appear by team only. HFL-NN makes one story of
each kind a week: `odds` (the week's biggest favorite, with every line in its facts; the Still to Play segment quotes
it), `upset` (an underdog that won outright by the closing line), `bettor` (the week's biggest winning ticket) and
`book_leader` (the season's top profit), credited by HFL coach name or "a bettor". Everything is HFL Bucks, play money;
the anchors never give betting advice.

## The channel chat: Chat Check, Chat Check-Ins and "Read on HFL-NN"

HFL-NN reads the Hub's channel chat every minute from `GET <hub>/api/hfl-nn/chat-digest?since=` (messages at least
three minutes old; never hidden, word-filtered or muted ones). The live shows' **Chat Check** segment reads what
was said since any show last read it, so a message goes on air once.

When the chat gets busy between shows (at least 3 new messages from 2 or more people in the last half hour), the
scheduler makes a **Chat Check-In**: a 2–3 minute bulletin (`config/channel.json` → `shows.checkin.cutIn`). It airs
a minute after it is published, over whatever is on, and the block it interrupts carries on where it would have been
(`start` in `/api/channel` keeps that block's clock). It waits out a new episode's premiere, never airs as vault
filler, and is only made with the daily shows, **chat on air** and **Chat Check-Ins** switched on, inside the daily
cap, at most once an hour and 6 times a day, never while a league game is live and never when a live show that reads
the chat is due within 75 minutes.

`GET /api/chat/aired` (public, cached for a minute) lists the episodes of the last three days that read the chat:
`{ episodes: [{ episodeId, title, publishedAt, show, ids, quotes: [{ name, body }] }] }`. `ids` are the Hub message
ids put on screen; `quotes` are the quote cards themselves, for episodes made before ids were kept. The Hub turns this
into the "Read on HFL-NN" marks in its chat.
