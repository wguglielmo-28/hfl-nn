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
| `gamesOfTheWeek` | The league's own Game of the Week. `week` is the week number as Madden shows it, starting at 1 (Wildcard 19, Divisional 20, Conference 21, Championship 23); a database `week_index` is one less. `stage` is `reg` or `pre`; `season` is informational. Teams can be in either order. Without a pick for the week, the show's top game is called the **Spotlight Game**, never the Game of the Week. |
| `announcements` | Each new `id` becomes a story for the **League Office** segment. `breaking: true` can trigger an automatic bulletin. Announcements air once. |
| `powerRankings` | Replaces the Madden power index on the **Power Rankings** card when present. |
| `awards`, `rivalries`, `records`, `history` | Background the writers can call back to. |

## Serving it from the Hub

If the Hub already stores this information, the quickest path is one read-only
route that assembles the document, for example `GET /api/hfl-nn-feed`. Keep it
public-safe (no emails or tokens) or protect it and push instead.
