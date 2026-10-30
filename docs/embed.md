# HFL-NN in the HFL Hub

The HFL Hub shows episodes on its own pages. It uses three things from HFL-NN, and
nothing else on HFL-NN may be framed or loaded from another site.

## 1. The episode list

```
GET /api/episodes
```

Published episodes, newest first. The Hub fetches it server-side (a Worker sends no
`Origin` header, so it isn't refused).

```json
[{ "id": "20271012-031500-weekly", "type": "weekly", "phase": "regular",
   "title": "…", "summary": "…", "weekLabel": "Week 6",
   "publishedAt": "2027-10-12T03:15:00.000Z", "duration": 642.3,
   "audioFile": "audio.mp3" }]
```

`type` is `weekly`, `breaking`, `premiere`, `kickoff` or `special`. `audioFile` can be
`null` on very old episodes; fall back to `audio.mp3`. From these the Hub builds:

| Link | URL |
|---|---|
| Watch on HFL-NN | `/watch/:id` |
| Embedded player | `/embed/:id` |
| Audio | `/media/:id/:audioFile` |

`GET /api/episodes/:id` is the full manifest (segments with `title` and `t0`, every
transcript line with `speaker`, `text` and `t0`) for chapters and transcripts.

## 2. The embedded player

```html
<iframe src="https://<hfl-nn>/embed/<id>" allow="fullscreen; autoplay" allowfullscreen
        style="aspect-ratio:16/9;width:100%;border:0"></iframe>
```

- `/embed/:id` is the episode player with its controls: play/pause, previous/next segment,
  scrub, captions, volume, full screen. It has no guide, lineup or ticker. It never
  autoplays; the viewer presses ▶.
- `?t=<seconds>` starts playback there.
- A "Watch on HFL-NN ↗" link opens `/watch/:id` in a new tab.
- `/embed/<id>` answers **404** for an episode that isn't published.
- `/embed/latest` plays the newest episode and always answers **200** (it shows "No
  broadcasts yet" when nothing is published). The Hub probes it to tell whether embedding
  is deployed: 200 with no `X-Frame-Options` means yes.

Only `/embed/*` may be framed. It sends `Content-Security-Policy: frame-ancestors 'self'
<EMBED_ORIGINS>` and no `X-Frame-Options`. Every other page sends `frame-ancestors 'none'`
and `X-Frame-Options: DENY`.

`EMBED_ORIGINS` is an environment variable on HFL-NN, comma-separated. The default is
`https://hfl-hub-5kc.pages.dev,https://*.hfl-hub-5kc.pages.dev` (production and preview
deploys). Add a custom Hub domain there if it gets one.

## 3. Audio

`/media/:id/:audioFile` sends `Cross-Origin-Resource-Policy: cross-origin` and supports
`Range` requests, so a plain `<audio src>` on the Hub can play and seek it.

Don't set `crossorigin` on that `<audio>`: it makes the browser send an `Origin` header, and
HFL-NN refuses cross-origin requests that carry one (only `ALLOWED_ORIGINS` get through).
