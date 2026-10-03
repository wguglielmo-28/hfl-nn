# Connecting HFL-NN to the HFL's own tools

The HFL already runs three tools that HFL-NN can read from. They live in
`C:\Claude\crimson-chronicle` on the commissioner's PC.

| HFL tool | What HFL-NN gets from it | What to do |
|---|---|---|
| `ea-exporter` (the daily Madden export) | Scores, stats, standings, rosters, free agents | Have it send a copy to HFL-NN ([step 1](#1-madden-data-the-ea-exporter)) |
| The HFL Hub's Chronicle pages | Each new Crimson Chronicle issue | Paste one URL into HFL-NN ([step 2](#2-the-crimson-chronicle-the-hubs-chronicle-page)) |
| HFL Hub data | The official Game of the Week, coach names, announcements, power rankings, history | Optional: add one feed route to the Hub ([step 3](#3-optional-the-hub-feed)) |

Steps 1 and 2 are enough for a full weekly show. When you're ready to switch from the sample
league to the real one, see [Going live](#going-live-after-the-fantasy-draft).

---

## 1. Madden data: the ea-exporter

The exporter is the right source, and it is better than Snallabot or the Companion App:

- **It already speaks HFL-NN's format.** It sends the same requests as the Companion App
  (`/leagueteams`, `/standings`, `/week/reg/N/...`, `/team/N/roster`, `/freeagents/roster`) with
  EA's data untouched. HFL-NN reads exactly that, so nothing needs converting.
- **It includes free agents**, so signings and releases show up. The Companion App leaves them
  out.
- **It already runs on its own every day.**

The one thing missing: it sends to a single place, the Hub. It needs to send a copy to HFL-NN as
well. Open Claude Code in `C:\Claude\crimson-chronicle` and paste this:

> In `ea-exporter`, add an optional second delivery target, so every capture `export.js` sends to
> HFL-Hub is also sent to HFL-NN, the league's news-show app.
>
> - Read the target from `.env.local` as `HFLNN_INGEST_URL`. It is the full Madden export URL
>   from HFL-NN's control room, `https://<host>/ingest/<secret>`. The secret is part of the URL,
>   so keep it only in `.env.local`. Never put it in `config.json`, and redact it in logs.
> - For each capture, after the Hub delivery, POST the identical body and Content-Type to
>   `HFLNN_INGEST_URL` plus the same path suffix used for the Hub, for example
>   `/ps5/<leagueId>/standings` or `/ps5/<leagueId>/week/reg/<n>/schedules`.
> - If `HFLNN_INGEST_URL` is not set, skip all of this.
> - HFL-NN must never break the Hub delivery. If an HFL-NN call fails or takes longer than 30
>   seconds, log one warning and carry on. Don't change the run's exit code or the Discord status
>   message because of it. End the run with a one-line summary, such as "HFL-NN: 59/59
>   delivered".
> - Don't change anything about the Hub delivery, the schedule or the payloads.
> - Do one real run and show me the log lines for the HFL-NN deliveries.

Then copy the **Madden export URL** from HFL-NN's control room (**Dashboard**) into
`ea-exporter\.env.local`:

```
HFLNN_INGEST_URL=https://<your-hfl-nn>/ingest/<secret>
```

HFL-NN answers 200 to everything it accepts (and to paths it doesn't use). It answers 404 only
when the secret in the URL is wrong.

### How HFL-NN treats a daily export

- **A week's games are played across several days**, so most daily exports arrive mid-week. HFL-NN
  drafts a week's show only once **every game of that week is final**, which happens after the
  advance. Each week gets one show.
- **Mid-week exports are compared with the day before.** A big move becomes a Breaking News
  bulletin: a blockbuster trade, an X-Factor upgrade, a star signing, release or long injury, or a
  new owner.
- **Sending the same data twice is harmless**, and nothing is reported twice.
- **A different league ID starts a fresh league.** This happens with a new Madden year (or when
  real data replaces the sample league). HFL-NN archives the old league under
  `league/archive/`, retires its unused stories, and starts over instead of reporting hundreds of
  "trades". When the exporter moves to Madden 27, HFL-NN simply follows.

---

## 2. The Crimson Chronicle: the Hub's Chronicle page

The Hub publishes every issue at `/chronicle/week-N` and lists them all at `/chronicle`. In
HFL-NN's control room go to **Settings → Crimson Chronicle** and enter:

```
https://hfl-hub-5kc.pages.dev/chronicle
```

HFL-NN checks that page every 20 minutes. When a new issue appears, it reads:

| From the issue | HFL-NN uses it as |
|---|---|
| The **Feature Story** heading, or the cover summary when there isn't one | The headline the anchors quote |
| The byline (Jenna Tulls today, the new correspondent next) | The author they credit on air |
| The cover summary | The "gist" line and the quote card |
| Every section, shortened to its opening lines | Background the writer can draw on |

The first check only takes the newest issue. Back issues aren't news, so they never turn up later.

**Timing:** the weekly show is drafted right after the advance, and that week's Chronicle issue
may not be out yet. A draft keeps the articles it started with. If you want the show to quote the
new issue, wait until it is posted, delete the draft, and press **Produce weekly show** on the
Dashboard to draft it again. Either way, no issue is skipped: an issue the show hasn't used yet
goes into the next show.

---

## 3. Optional: the Hub feed

The Hub already knows things the exports don't, and the format for sharing them is in
[`hub-feed.md`](hub-feed.md):

- **The official Game of the Week.** The HFL names its own and never self-selects one. Without
  the Hub's pick, HFL-NN calls its top game the **Spotlight Game**, never the Game of the Week.
- **Coach names**, the ones the Chronicle uses (Coach Nottick, Big Stace...).
- League announcements, power rankings, awards, records and history.

To build it, open Claude Code in `C:\Claude\crimson-chronicle` and paste this:

> In `hfl-hub`, add a public, read-only JSON route `GET /api/hfl-nn-feed` for HFL-NN, the league's
> news-show app. Build it from data the Hub already has, and only from things that are already
> public on the site: no emails, Discord IDs, tokens or admin data. Cache it for 5 minutes and add
> a test. Shape (every section optional, unknown fields ignored, under 2 MB):
>
> ```json
> {
>   "league": { "name": "Hypnotic Football League", "season": 9, "phase": "regular", "week": 7 },
>   "owners": [ { "teamAbbr": "GB", "displayName": "<site display name>", "coach": "<coach persona name>",
>                 "since": 2024, "titles": 1, "note": "<one line on the coach's personality>" } ],
>   "gamesOfTheWeek": [ { "season": 9, "stage": "reg", "week": 7, "away": "PHI", "home": "GB" } ],
>   "announcements": [ { "id": "<stable id>", "title": "...", "body": "<plain text>", "date": "2027-10-01", "breaking": false } ],
>   "powerRankings": [ { "rank": 1, "teamAbbr": "GB", "move": 2, "note": "..." } ],
>   "awards": [ { "name": "MVP", "winner": "...", "team": "GB", "season": 8 } ],
>   "records": [ "Most rushing yards in a season: 3,126 by Jahmyr Gibbs (Season VIII)" ],
>   "history": [ "Season VIII champion: Green Bay Packers" ]
> }
> ```
>
> - `teamAbbr`, `away` and `home` are the Madden abbreviations.
> - `week` is the week number as Madden shows it, starting at 1 (Wildcard 19, Divisional 20,
>   Conference 21, Championship 23). The Hub's `week_index` columns are 0-based, so add 1.
> - `gamesOfTheWeek` lists the designated Game of the Week for each week of the current season.
> - `coach` and `note` come from the coach personas the Chronicle uses, wherever the Hub keeps
>   them (team profiles, for example). Leave them out if the Hub doesn't store them.
> - `announcements` holds the latest 20, as plain text, and each `id` must never change.
> - Deploy it to production and show me the JSON it returns.

Then in HFL-NN go to **Settings → HFL Hub feed URL** and enter:

```
https://hfl-hub-5kc.pages.dev/api/hfl-nn-feed
```

---

## Going live after the fantasy draft

1. **Remove the sample league.** In the control room, press **Remove sample league** on the
   Dashboard. This clears:
   - the sample league
   - its news stories and episodes (published ones too, so the public channel is empty)
   - the sample Chronicle article and Hub data
   - the show's memory

   Your settings, Discord webhook, export URL and voices stay. Discord posts already sent stay
   in Discord, so delete any sample posts there by hand.
2. **Wait until the fantasy draft is finished**, then connect the exporter ([step 1](#1-madden-data-the-ea-exporter)) and run it
   once, or let the daily run do it. That first export is the starting point: nothing in it is
   reported as a move.
3. **Optional first show:** go to **Episodes → New episode**, pick type *special* and phase
   *preseason*, then press **Write script**. You get a season preview built from the new rosters
   (power rankings, bold predictions).
4. From then on, each week gets its show once its games are all final, and big moves get Breaking
   News bulletins.

If an export reaches HFL-NN before the draft is finished, nothing breaks. HFL-NN recognizes a
league-wide reshuffle and reports it as one fantasy-draft story (it leads the *Draft Desk*
segment of a *draft* special) instead of hundreds of trades. To wipe it instead, use
**Settings → Start over**, which works for any league. Type RESET to confirm.
