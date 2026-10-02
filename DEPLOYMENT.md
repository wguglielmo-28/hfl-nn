# Deploying HFL-NN

HFL-NN is a single Node process (Express) that keeps everything in plain files under `DATA_DIR`:
league snapshots, episodes, audio, the voice model cache and settings. It has the same shape as
`hfl-draft`, so Railway works the same way.

## Railway

1. **New service → Deploy from GitHub repo** → `wguglielmo-28/hfl-nn`. Railway detects Node and
   runs `npm install` and then `npm start`.
2. **Settings → Volumes**: add a volume mounted at **`/data`**. Without it, every redeploy wipes
   the league, the episodes and the voice model.
3. **Variables**:
   - `ADMIN_PASSWORD`: the control room password.
   - `SECRET_KEY`: 32+ random characters. It encrypts the Discord webhook.
   - `ANTHROPIC_API_KEY`: optional. Enables the Claude writer.
   - `NODE_ENV=production`: turns on the HTTPS redirect and HSTS.
   - `PUBLIC_URL=https://<your-service>.up.railway.app`, or your custom domain. Discord links
     use it.
   - `HUB_PUSH_KEY`: optional, if the Hub pushes its feed.
4. **Resources**: give the service **at least 1 GB of RAM**. Kokoro uses about 300–400 MB while
   voicing. CPU spikes for a few minutes per episode and is idle otherwise.
5. Open `https://<service>/control`, log in, and copy the **Madden export URL** into Snallabot
   or the Companion App.

The first voiced episode downloads the Kokoro model (~90 MB) into `/data/models`. Later episodes
load it from disk.

### Install size
`kokoro-js` pulls in ONNX Runtime, so `node_modules` is about 850 MB. Both `kokoro-js` and
`ffmpeg-static` are *optional* dependencies. If either fails to install, HFL-NN still runs: it
falls back to silent placeholder audio or WAV output, and the control room dashboard says which
it is using.

### `npm audit`
`npm audit` reports `sharp` (libvips/libheif advisories). It comes in through
`@huggingface/transformers` → `kokoro-js`. HFL-NN never decodes images with it, so the
vulnerable paths aren't reachable. Re-check when Kokoro updates.

## Security notes

- **Export URL**: the secret in `/ingest/<key>` is the only thing guarding the export endpoint,
  and a wrong key answers 404. Treat the URL like a password. To rotate it, set `INGEST_KEY`, or
  delete `DATA_DIR/ingest-key.json` and restart.
- **Control room**:
  - The session cookie is HttpOnly, SameSite=Strict, and Secure in production.
  - Logins are rate-limited.
  - Every write also needs an `X-HFLNN` header, which a cross-site form can't send.
- **Discord webhook**: encrypted at rest (AES-256-GCM, as in hfl-draft) and never sent back to
  the browser. Mentions are disabled on every post.
- **Pages**: a strict Content Security Policy (scripts only from this origin), HSTS, and
  frame-ancestors none. Cross-origin browser requests are refused.

## Backups

Everything is under `DATA_DIR`:

| Path | What |
|---|---|
| `league/current.json`, `league/snapshots/` | League state, plus one snapshot per export batch (last 30) |
| `raw/` | Raw export payloads from the last 8 batches, for debugging |
| `wire.json`, `memory.json`, `settings.json` | News wire, show memory, settings |
| `episodes/` | One folder per episode: script, manifest, audio |
| `models/`, `tts-cache/` | Voice model and voiced lines. Safe to delete; rebuilt on demand |

To back up, copy `DATA_DIR` while the server is idle. JSON files are written atomically with a
`.bak` kept beside each one.

## Running behind a proxy

Kokoro downloads its model with Node's built-in `fetch`. Behind an HTTP(S) proxy, set
`NODE_USE_ENV_PROXY=1` (Node 22.21+) so that fetch honours `HTTPS_PROXY`.
