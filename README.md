# 📺 HFL-NN — the HFL News Network

**Pixel-art AI anchors who report on the Hypnotical Football League.**

HFL-NN turns the league's Madden 27 exports, the HFL Hub and the Crimson Chronicle into short,
animated, fully voiced news broadcasts. A weekly show goes up after each advance; breaking-news
bulletins and offseason, draft, preseason and playoff specials go up as news happens. Five
anchors with their own personalities (and one running feud) read every line aloud while their
pixel mouths flap in sync, with on-screen scoreboards, trade cards, standings and a ticker.
Each new episode can be announced in Discord.

It's the idea behind [PNN](https://pnn.watch/), but built for one league and run on episodes
instead of a 24/7 stream.

---

## ⚡ Quick start

You need **Node.js 22 or newer** ([nodejs.org](https://nodejs.org), LTS).

```bash
npm install
npm run demo        # builds a sample league and produces two voiced episodes
npm start           # http://localhost:3000  ·  control room: http://localhost:3000/control
```

On Windows, double-click **`start.bat`**.

`npm run demo` uses the sample league in `test/fixtures/madden`. The first voiced run downloads
the Kokoro voice model (~90 MB) once. Options:

- `-- --writer template` skips Claude.
- `-- --tts silent` skips voices, which makes it quick.
- `-- --data ./somewhere` writes somewhere other than `./data`.

The control room password comes from `ADMIN_PASSWORD`. If that's not set, the server prints a
temporary password when it starts.

---

## 🔌 Connecting the HFL

**HFL setup:** [`docs/hfl-setup.md`](docs/hfl-setup.md) connects HFL-NN to the league's own tools:
the daily `ea-exporter`, the Hub's Chronicle pages and the Hub feed. It includes copy-paste
instructions for the changes on the exporter and Hub side.

### Madden 27 exports
Open the control room. The **Dashboard** shows your private export URL:

```
https://<your-hfl-nn>/ingest/<secret>
```

Anything that speaks the Madden Companion App export protocol can send to it:
- **The HFL's `ea-exporter`** (recommended). It pulls straight from EA every day and includes
  free agents. It needs one small change to send HFL-NN a copy (see the setup guide).
- **Snallabot**: dashboard → export → add a custom export URL.
- **The Madden Companion App's** export screen. It leaves out free agents.

Each export arrives as a burst of requests. HFL-NN applies them as they land, waits 90 seconds
after the last one, and treats the burst as one **batch**. It compares each batch with the previous
one and writes up what changed:
- **A week whose games are all final** (after the advance) gets the weekly show. With automation
  on, it is drafted then, once per week.
- **A mid-week export** (the daily exporter sends plenty) can produce a Breaking News bulletin when
  something big changed since the day before.
- **An export for a different league** (a new Madden year, or real data replacing the sample)
  starts a fresh league. The old one is archived.

You can also upload export JSON files by hand (**Sources → Madden exports**).

### The Crimson Chronicle
In **Settings**, enter the Hub's Chronicle page, `https://hfl-hub-5kc.pages.dev/chronicle`. HFL-NN
reads each new issue as it is posted. It takes the headline from the Feature Story, the author
from the byline, and a short summary of every section for the writers. An RSS or Atom feed (or
a site that advertises one) works too. New issues are picked up every 20 minutes.

On air, the anchors credit the Chronicle and the author by name, and the **Sources** panel under
the player links to the issue. Posts tagged "Breaking" can trigger a bulletin. You can also add a
single article by URL or paste one in (**Sources**).

### The HFL Hub
The Hub provides the official Game of the Week, coach names, announcements, power rankings, awards
and league history through one small JSON document. HFL-NN either polls it at a URL or receives it
as a push. The format is in [`docs/hub-feed.md`](docs/hub-feed.md).

The HFL never self-selects a Game of the Week. Until the Hub names one for the week, the show's
top game is called the **Spotlight Game**.

### Discord
**Settings → Discord**: paste a channel webhook and send a test message. Every published episode
then posts with a link to watch. The webhook is stored encrypted and is never shown again.

---

## 🎬 How an episode gets made

```
export batch ──▶ story engine ──▶ rundown ──▶ script ──▶ voices + mix ──▶ review ──▶ publish
```

1. **Story engine** (`lib/stories.js`) compares this batch with the last one. It finds:
   - upsets, blowouts and nail-biters
   - big games and milestones
   - streaks, division-lead changes, clinches and power-index moves
   - trades, signings, releases, retirements and injuries
   - dev-trait upgrades, rating jumps, rookie classes and owner changes

   Every number is computed here, and each story gets a score and an on-screen card.
2. **Rundown** (`lib/rundown.js`) picks the segments for the episode type and season phase and
   decides who's in each one. Segments with nothing to say are dropped.
3. **Script**: either **Claude** or the free **template writer** writes the lines. Claude
   (`claude-opus-5-5`) is constrained to a JSON script format, told to use only the supplied
   facts, and kept in character by the show bible. A validator then:
   - checks speakers, cards and length
   - flags any number that isn't in the facts
   - blocks profanity

   A failed check gets one automatic repair attempt.
4. **Voices and mix**: **Kokoro** voices each line in a background thread. Chiptune stings go
   between segments. Out comes one MP3 plus a timeline of who speaks when, which cards come up,
   and how open each mouth is in every frame.
5. **Review**: in the control room you can read every line and:
   - edit a line, or change its speaker, emotion, gesture, camera shot or card
   - rewrite one segment
   - preview the episode, then publish it

The browser player uses the audio as its clock, so lips never drift from the voice.

---

## 🎙 The show

| Anchor | Role | Schtick | Voice |
|---|---|---|---|
| **Hal Huxley** | Lead anchor | Smooth veteran host; signs off with "Stay Hypnotical." | `am_michael` |
| **Sasha Sterling** | League insider | "My sources tell me…": trades, signings, injuries | `af_bella` |
| **Big Ray Mobley** | Ex-lineman analyst | Old-school hot takes and desk slams | `am_onyx` |
| **Nate "The Numbers" Okafor** | Analytics desk | Precise, dry, feuds with Ray | `bm_george` |
| **Gus Grimley** | Conspiracy Corner | "The sim is rigged" (for laughs) | `am_puck` |

Names, voices and speed are editable in **Settings**. Looks, bios, styles and catchphrases live
in `config/personas.json`.

| Episode | When | Length |
|---|---|---|
| **HFL-NN Tonight** (weekly) | After each preseason or regular-season advance | 5–9 min |
| **Breaking News** | Big trades or signings, an X-Factor upgrade, owner changes, a Chronicle "breaking" post, or a commissioner announcement | under 1.5 min |
| **Playoff / Championship** | Wild Card through the title game (weeks 19–23) | 5–9 min |
| **Offseason / Draft / Free Agency / Preseason specials** | Set the phase in Settings, then produce a special | 4–8 min |
| **Custom** | Pick any segments and add notes | any |

Segments: Cold Open, Around the League, Game of the Week (the Spotlight Game until the Hub names
one), Players of the Week, Standings and Playoff Race, The Wire (transactions), Injury Report,
From the Chronicle, League Office, Hot Take Hotline, Conspiracy Corner, Up Next, Power Rankings,
Bold Predictions, Draft Desk, Free Agency Frenzy, The Bracket, Season in Review, and the sign-off.
They're defined in `config/show.json`.

**Show memory** (`memory.json`) carries persona moods, feuds, on-air predictions, running
storylines and recent episodes from show to show. When a prediction comes true or falls flat,
grade it in **Show Memory** and the anchors will bring it up.

---

## 🧠 Claude or the template writer

| | Claude | Template writer |
|---|---|---|
| Setup | `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com), billed per use, separate from a Claude subscription | Nothing |
| Quality | Real banter, callbacks, arguments and jokes | Plain but accurate |
| Cost | About $0.15–0.40 per weekly show and a few cents per bulletin (prompt cached) | Free |

With `writer: auto` (the default), Claude is used when a key is set. If Claude fails or declines,
the template writer takes over so the show still goes out. Requests use server-side refusal
fallback (`fallbacks: "default"`), and the control room shows the token count and estimated
cost of each script. To use a different model, set `HFLNN_MODEL`.

## 🔊 Voices

[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) runs on the server, free:
28 American and British English voices, about real time on a modern CPU. Voiced lines are
cached, so editing one line and re-voicing only re-synthesizes that line.

**Settings → Pronunciations** fixes names the voices get wrong (`Ja'Marr = Juh Mar`).

A premium provider such as OpenAI or ElevenLabs can be added in `lib/tts/index.js`. All it needs
is a `synth(text, voice, speed)` function.

---

## ⚙️ Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | random per run | Control room password. **Set it.** |
| `ANTHROPIC_API_KEY` | — | Enables the Claude writer |
| `HFLNN_MODEL` | `claude-opus-5-5` | Claude model for scripts |
| `INGEST_KEY` | generated, saved in `DATA_DIR` | The secret in the export URL |
| `HUB_PUSH_KEY` | — | Bearer token the Hub uses for `POST /api/hub/push` |
| `HUB_FEED_URL`, `CHRONICLE_FEED_URL`, `PUBLIC_URL` | — | Starting values for the same Settings fields |
| `DATA_DIR` | `/data` if writable, else `./data` | Where everything is stored |
| `SECRET_KEY` | derived per install | Encrypts the Discord webhook at rest |
| `TTS_PROVIDER` | `auto` | `kokoro`, `silent` or `auto` |
| `EXPORT_DEBOUNCE_SECONDS` | `90` | How long after the last export request a batch closes |
| `FFMPEG_PATH` | auto | ffmpeg for MP3 output. Falls back to `ffmpeg-static`, then WAV |
| `PORT` | `3000` | |

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for hosting on Railway.

## 🗂 Project layout

```
server.js               Express app: channel, export receiver, control room API
config/                 personas.json (the anchors), show.json (segments and rundowns)
lib/league.js           normalized league model built from Madden exports
lib/ingest/             madden.js (export receiver), hub.js, chronicle.js
lib/stories.js          story engine (diffs → ranked stories with facts and cards)
lib/rundown.js          segment selection per episode type and season phase
lib/writer/             schema, validator, template writer, Claude writer, prompts
lib/tts/, lib/audio/    Kokoro worker, text prep, jingles, mixer, MP3 encoding
lib/producer.js         news wire, episodes, jobs and automation
public/                 channel page, control room, js/studio/ (pixel-art renderer)
tools/                  demo.js, snap.js (screenshots), record.js (MP4 clips), make-fixtures.js
test/                   node --test suites + trimmed sample exports
```

```bash
npm test                 # all suites (no network, no API key needed)
node tools/snap.js       # screenshots of the latest episode (needs Playwright and a running server)
node tools/record.js --id <episode> --from 0 --to 60 --out clip.mp4   # MP4 clip for Discord/YouTube (Playwright + ffmpeg)
```

## 📜 Credits

- Kokoro TTS model and `kokoro-js`: Apache-2.0.
- Sample Madden export payloads used in tests and the demo are trimmed from
  [snallabot-service](https://github.com/snallabot/snallabot-service) (MIT). See
  `test/fixtures/madden/README.md`.
- Fonts: Silkscreen and Atkinson Hyperlegible (SIL Open Font License), via Google Fonts.
- HFL-NN is a parody desk for a private league. It isn't affiliated with EA, the NFL or any news
  outlet, and team badges are drawn from the export's colors rather than real logos.
