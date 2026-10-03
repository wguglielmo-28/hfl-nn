// HFL-NN control room: the commissioner's console for data sources, the news
// wire, producing/reviewing/publishing episodes, settings and show memory.
// Plain DOM, no framework; every write sends the X-HFLNN header the server
// requires.

const app = document.getElementById('app');
const state = { tab: 'dashboard', status: null, settings: null, episode: null, poll: null };

// ── Helpers ───────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-HFLNN': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { renderLogin(); throw new Error(data.error || 'Please log in'); }
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function toast(msg, bad = false) {
  const t = h('div', { class: 'notice', role: 'status', style: `position:fixed;right:16px;bottom:16px;z-index:9;max-width:420px;border-left-color:${bad ? 'var(--red)' : 'var(--teal)'}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}
async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); return null; }
}

const when = iso => (iso ? new Date(iso).toLocaleString() : '—');
const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
const statusPill = s => pill(s, { published: 'ok', ready: 'ok', draft: '', needs_fixes: 'bad', failed: 'bad', writing: 'warn', voicing: 'warn' }[s] || '');
const fmtDur = t => (t ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : '—');

// ── Login ─────────────────────────────────────────────────────────────────
function renderLogin() {
  clearInterval(state.poll);
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password' });
  const form = h('form', { class: 'panel login', on: { submit: async e => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { password: pw.value } }); boot(); } catch (err) { toast(err.message, true); }
  } } },
  h('h2', {}, 'Control room login'),
  h('label', { for: 'pw' }, 'Commissioner password'), pw,
  h('p', { class: 'muted' }, 'Set ADMIN_PASSWORD on the server. If it is not set, the server prints a temporary password in its log at startup.'),
  h('button', { class: 'btn primary', type: 'submit' }, 'Log in'));
  app.replaceChildren(form);
  pw.focus();
}

// ── Shell ─────────────────────────────────────────────────────────────────
const TABS = [['dashboard', 'Dashboard'], ['wire', 'News Wire'], ['episodes', 'Episodes'], ['sources', 'Sources'], ['settings', 'Settings'], ['memory', 'Show Memory']];

function shell(content) {
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(state.tab === id),
    on: { click: () => { state.tab = id; state.episode = null; render(); } },
  }, label)), h('button', { type: 'button', on: { click: async () => { await api('/api/logout', { method: 'POST' }); renderLogin(); } } }, 'Log out'));
  app.replaceChildren(tabs, content);
}

async function render() {
  clearInterval(state.poll);
  try {
    const view = { dashboard: viewDashboard, wire: viewWire, episodes: state.episode ? viewEpisode : viewEpisodes, sources: viewSources, settings: viewSettings, memory: viewMemory }[state.tab];
    shell(await view());
  } catch (e) {
    if (!/log in/i.test(e.message)) shell(h('p', { class: 'error' }, e.message));
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────
function removeSample() {
  if (!confirm('Remove the sample league?\n\nThis deletes the sample league, its news stories and episodes, the sample Chronicle article and Hub data, and resets the show\'s memory. Your settings, Discord webhook and export URL stay.')) return;
  act(() => api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' } }), 'Sample league removed').then(render);
}

async function viewDashboard() {
  const s = await api('/api/admin/status');
  state.status = s;
  const lg = s.league;
  const empty = !lg.teams;
  const copyBtn = text => h('button', { class: 'btn', type: 'button', on: { click: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) } }, 'Copy');

  const cards = h('div', { class: 'grid2' },
    h('section', { class: 'panel' }, h('h2', {}, 'League'),
      empty ? h('p', {}, 'No league data yet. Point your Madden export at the URL below, or load the sample league to try things out.')
        : h('table', {}, h('tbody', {},
          row('Season', lg.calendarYear || '—'),
          row('Latest results', lg.latestWeek ? `${lg.latestWeek}${lg.latestWeekFinal ? ' (final)' : ' (still being played)'}` : 'none'),
          !lg.latestWeekFinal && lg.lastFinalWeek && row('Last finished week', lg.lastFinalWeek),
          row('Phase', `${lg.phase}${lg.phase !== lg.detectedPhase ? ` (override; detected ${lg.detectedPhase})` : ''}`),
          row('Teams / players', `${lg.teams} / ${lg.players}`),
          row('Standings', lg.standingsFresh ? 'current' : 'out of date — re-export League Info'),
          row('Updated', when(lg.updatedAt)))),
      empty && h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/sample-data', { method: 'POST', body: {} }), 'Sample league loaded').then(render) } }, 'Load sample league'),
      lg.leagueId === 'demo' && h('div', {},
        h('p', { class: 'muted' }, 'This is the sample league. Remove it before your real league\'s first export arrives.'),
        h('button', { class: 'btn danger', type: 'button', on: { click: removeSample } }, 'Remove sample league'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Newsroom'),
      h('table', {}, h('tbody', {},
        row('Script writer', s.writer.claude && s.writer.mode !== 'template' ? `Claude (${s.writer.model})` : 'Template writer'),
        row('Voices', `${s.tts.provider}${s.tts.status ? ` — ${s.tts.status}` : ''}${s.tts.error ? ` (${s.tts.error})` : ''}`),
        row('Audio', s.tts.ffmpeg ? 'MP3 (ffmpeg)' : 'WAV (no ffmpeg found)'),
        row('News wire', `${s.wire.unused} unused of ${s.wire.total} stories`),
        row('Chronicle', s.chronicle.fetchedAt ? `${s.chronicle.unused} new of ${s.chronicle.count}` : (s.chronicle.error || 'not configured')),
        row('HFL Hub', s.hub.fetchedAt ? `updated ${when(s.hub.fetchedAt)}` : (s.hub.error || 'not configured')),
        row('Storage', `${s.dataDir}${s.persistentVolume ? ' (volume)' : ''}`))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', disabled: empty, on: { click: () => newEpisode({ type: 'weekly' }) } }, 'Produce weekly show'),
        h('button', { class: 'btn', type: 'button', on: { click: () => { state.tab = 'episodes'; render(); } } }, 'Breaking bulletin / special'))));

  const setup = h('section', { class: 'panel' }, h('h2', {}, 'Madden export URL'),
    h('p', {}, 'Give this to the HFL\'s ea-exporter (see docs/hfl-setup.md), or paste it into Snallabot (dashboard → export → custom URL) or the Madden Companion App export screen. Exports land here automatically; the weekly show is drafted once a week\'s games are all final.'),
    h('div', { class: 'row' }, h('code', { class: 'mono' }, s.ingestUrl), copyBtn(s.ingestUrl)),
    h('p', { class: 'muted' }, 'Keep this URL private — anyone with it can send data. The ea-exporter and Snallabot also export free agents, which the Companion App does not.'),
    s.ingest.open && h('p', { class: 'notice' }, `Export in progress (${Object.values(s.ingest.open.parts).reduce((a, b) => a + b, 0)} payloads so far)…`));

  const jobs = h('section', { class: 'panel' }, h('h2', {}, 'Recent jobs'), jobsTable(s.jobs));
  const batches = h('section', { class: 'panel' }, h('h2', {}, 'Recent exports'),
    s.batches.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Batch'), h('th', {}, 'Source'), h('th', {}, 'Contents'))),
      h('tbody', {}, s.batches.map(b => h('tr', {}, h('td', {}, when(b.finishedAt)), h('td', {}, b.source), h('td', {}, Object.entries(b.parts).map(([k, v]) => `${k}×${v}`).join(', ')))))) : h('p', { class: 'muted' }, 'No exports yet.'));

  if (s.jobs.some(j => ['queued', 'running'].includes(j.status)) || s.ingest.open) state.poll = setInterval(render, 3000);
  return h('div', {}, cards, setup, jobs, batches);
}

const row = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v));

function jobsTable(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'Nothing has run yet.');
  return h('table', {}, h('tbody', {}, list.map(j => h('tr', {},
    h('td', {}, j.kind), h('td', {}, statusPill(j.status)),
    h('td', {}, j.progress ? (j.progress.stage === 'voicing' ? `voicing ${j.progress.done}/${j.progress.total} lines` : `writing… ${j.progress.chars || 0} chars`) : ''),
    h('td', {}, j.episodeId ? h('a', { href: '#', on: { click: e => { e.preventDefault(); openEpisode(j.episodeId); } } }, j.episodeId) : ''),
    h('td', { class: 'muted' }, j.error || when(j.finishedAt || j.startedAt || j.createdAt))))));
}

// ── Wire ──────────────────────────────────────────────────────────────────
async function viewWire() {
  const list = await api('/api/admin/wire');
  const onlyUnused = h('input', { type: 'checkbox', id: 'unused', checked: true });
  const tbody = h('tbody');
  const draw = () => {
    tbody.replaceChildren(...list.filter(s => !onlyUnused.checked || !s.usedIn.length).map(s => h('tr', {},
      h('td', {}, String(s.score)), h('td', {}, pill(s.category || s.type, s.breaking ? 'bad' : '')),
      h('td', {}, s.headline, h('div', { class: 'muted' }, Object.entries(s.facts || {}).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 220))),
      h('td', {}, s.usedIn.length ? pill('used', 'ok') : ''),
      h('td', {},
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.pinned, on: { change: e => act(() => api(`/api/admin/wire/${encodeURIComponent(s.id)}`, { method: 'POST', body: { pinned: e.target.checked } })) } }), 'pin'),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.excluded, on: { change: e => act(() => api(`/api/admin/wire/${encodeURIComponent(s.id)}`, { method: 'POST', body: { excluded: e.target.checked } })) } }), 'skip')))));
  };
  onlyUnused.addEventListener('change', draw);
  draw();
  return h('section', { class: 'panel' }, h('h2', {}, 'News wire'),
    h('p', { class: 'muted' }, 'Every story the engine found in your exports, best first. Pinned stories make the next show even if used before; skipped stories never air.'),
    h('label', { class: 'row' }, onlyUnused, 'Unused only'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Score'), h('th', {}, 'Type'), h('th', {}, 'Story'), h('th', {}, ''), h('th', {}, ''))), tbody));
}

// ── Episodes ──────────────────────────────────────────────────────────────
async function newEpisode(body) {
  const ep = await act(() => api('/api/admin/episodes', { method: 'POST', body }), 'Writing the script…');
  if (ep) openEpisode(ep.id);
}
function openEpisode(id) { state.tab = 'episodes'; state.episode = id; render(); }

async function viewEpisodes() {
  const [list, settings, wire] = await Promise.all([api('/api/admin/episodes'), api('/api/admin/settings'), api('/api/admin/wire')]);
  const type = h('select', {}, ['weekly', 'special', 'custom'].map(t => h('option', { value: t }, t)));
  const phase = h('select', {}, h('option', { value: '' }, 'current phase'), settings.phases.map(p => h('option', { value: p }, p)));
  const writer = h('select', {}, ['auto', 'claude', 'template'].map(t => h('option', { value: t }, t)));
  const notes = h('textarea', { placeholder: 'Anything the anchors should mention, a running joke, a correction…' });
  const KINDS = ['cold_open', 'scoreboard', 'game_of_week', 'top_performers', 'standings', 'playoff_race', 'transactions', 'injuries', 'press_review', 'league_office', 'debate', 'conspiracy_corner', 'preview', 'power_rankings', 'predictions', 'draft_desk', 'free_agency', 'bracket', 'season_review', 'signoff'];
  const kindBoxes = KINDS.map(k => h('label', { class: 'row' }, h('input', { type: 'checkbox', value: k, checked: ['cold_open', 'debate', 'signoff'].includes(k) }), k.replace(/_/g, ' ')));
  const customBox = h('div', { class: 'grid2', hidden: true }, kindBoxes);
  type.addEventListener('change', () => { customBox.hidden = type.value !== 'custom'; });

  const create = h('section', { class: 'panel' }, h('h2', {}, 'New episode'),
    h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Type'), type), h('div', {}, h('label', {}, 'Phase'), phase), h('div', {}, h('label', {}, 'Writer'), writer)),
    customBox, h('label', {}, 'Notes for the writers'), notes,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: () => newEpisode({
      type: type.value, phase: phase.value || undefined, writer: writer.value, notes: notes.value,
      customKinds: type.value === 'custom' ? kindBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) : undefined,
    }) } }, 'Write script')));

  const headline = h('input', { type: 'text', placeholder: 'e.g. League approves expansion of the playoff field' });
  const details = h('textarea', { placeholder: 'Details the insider should report (optional)' });
  const candidates = wire.filter(s => !s.usedIn.length && s.type !== 'game').slice(0, 25);
  const storyBoxes = candidates.map(s => h('label', { class: 'row' }, h('input', { type: 'checkbox', value: s.id, checked: s.breaking }), `${s.headline} (${s.score})`));
  const bulletin = h('section', { class: 'panel' }, h('h2', {}, 'Breaking bulletin'),
    h('p', { class: 'muted' }, 'A 45–90 second interruption. Type an announcement, pick stories from the wire, or both.'),
    h('label', {}, 'Headline'), headline, h('label', {}, 'Details'), details,
    storyBoxes.length ? h('div', {}, h('label', {}, 'Stories'), storyBoxes) : null,
    h('button', { class: 'btn primary', type: 'button', on: { click: () => newEpisode({
      type: 'breaking', writer: writer.value,
      bulletin: headline.value.trim() ? { headline: headline.value.trim(), details: details.value } : undefined,
      breakingStoryIds: storyBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value),
    }) } }, 'Write bulletin'));

  const table = h('section', { class: 'panel' }, h('h2', {}, 'Episodes'),
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Title', 'Type', 'Status', 'Length', 'Writer', 'Created'].map(t => h('th', {}, t)))),
      h('tbody', {}, list.map(e => h('tr', {},
        h('td', {}, h('a', { href: '#', on: { click: ev => { ev.preventDefault(); openEpisode(e.id); } } }, e.title)),
        h('td', {}, e.type), h('td', {}, statusPill(e.status)), h('td', {}, fmtDur(e.duration)), h('td', {}, e.writer || '—'), h('td', {}, when(e.createdAt))))))
      : h('p', { class: 'muted' }, 'No episodes yet.'));
  if (list.some(e => ['writing', 'voicing'].includes(e.status))) state.poll = setInterval(render, 4000);
  return h('div', {}, table, create, bulletin);
}

async function viewEpisode() {
  const [ep, settings, jobs] = await Promise.all([api(`/api/admin/episodes/${state.episode}`), api('/api/admin/settings'), api('/api/admin/jobs')]);
  const busy = ['writing', 'voicing'].includes(ep.status);
  if (busy) state.poll = setInterval(render, 3000);
  const personas = settings.personas;
  const job = jobs.find(j => j.episodeId === ep.id && ['queued', 'running'].includes(j.status));

  const header = h('section', { class: 'panel' },
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', on: { click: () => { state.episode = null; render(); } } }, '← Episodes'), statusPill(ep.status)),
    h('h2', {}, ep.title), h('p', { class: 'muted' }, `${ep.type} • ${ep.phase} • ${ep.weekLabel || ''} • created ${when(ep.createdAt)}`),
    ep.summary && h('p', {}, ep.summary),
    ep.error && h('p', { class: 'error' }, ep.error),
    job && h('p', { class: 'notice' }, job.progress ? (job.progress.stage === 'voicing' ? `Voicing line ${job.progress.done} of ${job.progress.total}…` : `Writing… ${job.progress.chars || 0} characters so far`) : `${job.kind} ${job.status}…`),
    writerInfo(ep.writer),
    ep.audio && h('p', {}, `Audio: ${fmtDur(ep.audio.duration)} ${ep.audio.format.toUpperCase()} (${Math.round(ep.audio.bytes / 1024)} KB, ${ep.audio.provider} voices)${ep.audio.stale ? ' — script changed since, re-voice it' : ''}`),
    ep.discordError && h('p', { class: 'error' }, `Discord: ${ep.discordError}`),
    actions(ep, busy));

  const val = ep.validation && (ep.validation.errors.length || ep.validation.warnings.length) ? h('section', { class: 'panel' }, h('h2', {}, 'Checks'),
    h('ul', { class: 'flags' }, ep.validation.errors.map(e => h('li', { class: 'err' }, e)), ep.validation.warnings.map(w => h('li', {}, w)))) : null;

  return h('div', {}, header, val, ep.script ? scriptEditor(ep, personas, busy) : h('p', { class: 'muted' }, 'The script is being written…'));
}

function writerInfo(w) {
  if (!w) return null;
  const bits = [w.kind === 'claude' ? `Written by ${w.model}` : 'Written by the template writer'];
  if (w.costUsd != null) bits.push(`about $${w.costUsd.toFixed(3)}`);
  if (w.usage) bits.push(`${w.usage.reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)} in / ${w.usage.reduce((n, u) => n + u.output, 0)} out tokens${w.usage.some(u => u.cacheRead) ? ' (cache hit)' : ''}`);
  if (w.repaired) bits.push('needed one repair pass');
  if (w.fallbackFrom) bits.push(`Claude failed: ${w.fallbackReason}`);
  return h('p', { class: 'muted' }, bits.join(' • '));
}

function actions(ep, busy) {
  const discord = h('input', { type: 'checkbox', checked: true });
  const notes = h('input', { type: 'text', placeholder: 'Notes for a rewrite (optional)' });
  const run = (path, body, ok) => act(() => api(`/api/admin/episodes/${ep.id}/${path}`, { method: 'POST', body }), ok).then(render);
  return h('div', {},
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', disabled: busy || !ep.script || ep.validation?.errors.length, on: { click: () => run('voice', {}, 'Voicing started') } }, ep.audio ? 'Re-voice' : 'Voice it'),
      h('a', { class: 'btn', href: `/?preview=${ep.id}`, target: '_blank', rel: 'noopener', 'aria-disabled': String(!ep.audio) }, 'Preview'),
      ep.status === 'published'
        ? h('button', { class: 'btn', type: 'button', on: { click: () => run('unpublish', {}, 'Unpublished') } }, 'Unpublish')
        : h('button', { class: 'btn primary', type: 'button', disabled: busy || !ep.audio || ep.audio?.stale, on: { click: () => run('publish', { discord: discord.checked }, 'Published!') } }, 'Publish'),
      h('label', { class: 'row' }, discord, 'Announce on Discord'),
      ep.status === 'published' && h('a', { class: 'btn', href: `/watch/${ep.id}`, target: '_blank', rel: 'noopener' }, 'Watch'),
      h('button', { class: 'btn danger', type: 'button', disabled: busy, on: { click: async () => {
        if (!confirm('Delete this episode and its audio?')) return;
        await act(() => api(`/api/admin/episodes/${ep.id}`, { method: 'DELETE' }), 'Deleted');
        state.episode = null; render();
      } } }, 'Delete')),
    h('div', { class: 'row', style: 'margin-top:8px' }, notes,
      h('button', { class: 'btn', type: 'button', disabled: busy, on: { click: () => run('rewrite', { notes: notes.value || null }, 'Rewriting…') } }, 'Rewrite whole script')));
}

const EMOTIONS = ['neutral', 'happy', 'excited', 'angry', 'smug', 'shocked', 'sad', 'laughing', 'suspicious', 'serious'];
const GESTURES = ['none', 'point', 'shrug', 'desk_slam', 'facepalm', 'lean_in', 'thumbs_up', 'arms_crossed'];
const SHOTS = ['auto', 'wide', 'single', 'two_shot', 'graphic', 'full_graphic'];

function scriptEditor(ep, personas, busy) {
  const segs = ep.script.segments.map(seg => ({ ...seg, lines: seg.lines.map(l => ({ ...l })) }));
  const rseg = id => ep.rundown.segments.find(s => s.id === id) || {};
  const sel = (opts, value, onChange, labels = {}) => {
    const s = h('select', { on: { change: e => onChange(e.target.value) } }, opts.map(o => h('option', { value: o }, labels[o] || o)));
    s.value = value;
    return s;
  };
  const root = h('section', { class: 'panel' }, h('h2', {}, 'Script'),
    h('p', { class: 'muted' }, 'Edit any line, then save. Saving marks the audio stale; voice it again before publishing.'));
  const body = h('div');
  const draw = () => {
    body.replaceChildren(...segs.map(seg => {
      const r = rseg(seg.id);
      const cards = r.cards || [];
      const cardLabels = Object.fromEntries(cards.map(c => [c.id, `${c.id} ${c.type}`]));
      return h('div', { class: 'seg' },
        h('h3', {}, `${seg.id} · ${r.title || seg.kind} `, h('span', { class: 'muted' }, `(${(r.cast || []).join(', ')}; ~${r.targetWords || '?'} words)`)),
        r.brief && h('p', { class: 'muted' }, r.brief),
        seg.lines.map((ln, i) => h('div', { class: 'line' },
          sel(personas.map(p => p.id), ln.speaker, v => { ln.speaker = v; }, Object.fromEntries(personas.map(p => [p.id, p.short || p.name]))),
          sel(EMOTIONS, ln.emotion, v => { ln.emotion = v; }),
          h('textarea', { value: ln.text, on: { input: e => { ln.text = e.target.value; } } }),
          h('button', { class: 'btn', type: 'button', title: 'Delete line', on: { click: () => { seg.lines.splice(i, 1); draw(); } } }, '✕'),
          sel(GESTURES, ln.gesture, v => { ln.gesture = v; }),
          sel(SHOTS, ln.shot, v => { ln.shot = v; }),
          sel(['', ...cards.map(c => c.id)], ln.card, v => { ln.card = v; }, { '': 'no card', ...cardLabels }))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', on: { click: () => { seg.lines.push({ speaker: r.cast?.[0] || personas[0].id, text: '', emotion: 'neutral', gesture: 'none', shot: 'auto', card: '' }); draw(); } } }, '+ Line'),
          h('button', { class: 'btn', type: 'button', disabled: busy, on: { click: () => act(() => api(`/api/admin/episodes/${ep.id}/rewrite`, { method: 'POST', body: { segmentId: seg.id } }), 'Rewriting segment…').then(render) } }, 'Rewrite this segment')));
    }));
  };
  draw();
  root.append(body, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', disabled: busy, on: { click: () => act(() => api(`/api/admin/episodes/${ep.id}/script`, {
    method: 'PUT', body: { ...ep.script, segments: segs.map(s => ({ id: s.id, lines: s.lines })) },
  }), 'Script saved').then(render) } }, 'Save script')));
  return root;
}

// ── Sources ───────────────────────────────────────────────────────────────
async function viewSources() {
  const [s, articles, settings] = await Promise.all([api('/api/admin/status'), api('/api/admin/chronicle'), api('/api/admin/settings')]);
  const files = h('input', { type: 'file', multiple: true, accept: '.json,application/json' });
  const upload = h('section', { class: 'panel' }, h('h2', {}, 'Madden exports'),
    h('p', {}, 'Exports normally arrive by themselves at the export URL on the Dashboard. You can also upload export JSON files here (one payload per file, e.g. from maddenexporter.com).'),
    files,
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn primary', type: 'button', on: { click: async () => {
        const payloads = [];
        for (const f of files.files) { try { payloads.push(JSON.parse(await f.text())); } catch { toast(`${f.name} is not valid JSON`, true); } }
        if (!payloads.length) return;
        const r = await act(() => api('/api/admin/upload', { method: 'POST', body: { payloads } }));
        if (r) toast(`${r.results.filter(x => x.ok && !x.ignored).length} of ${payloads.length} files applied. Process the batch when you're done.`);
      } } }, 'Upload'),
      h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/batch/flush', { method: 'POST', body: {} }), 'Batch processed — check the News Wire').then(render) } }, 'Process batch now')));

  const url = h('input', { type: 'url', placeholder: 'https://… article URL' });
  const title = h('input', { type: 'text', placeholder: 'Title' });
  const author = h('input', { type: 'text', placeholder: 'Author' });
  const text = h('textarea', { placeholder: 'Article text' });
  const chron = h('section', { class: 'panel' }, h('h2', {}, 'The Crimson Chronicle'),
    h('p', {}, settings.chronicleFeedUrl ? `${s.chronicle.mode === 'page' ? 'Issue list' : 'Feed'}: ${settings.chronicleFeedUrl} — checked every ${settings.pollMinutes} minutes. ` : 'Set the Chronicle URL in Settings: the HFL Hub\'s Chronicle page (…/chronicle), an RSS/Atom feed, or a site that advertises one. ',
      s.chronicle.error ? h('span', { class: 'error' }, s.chronicle.error) : `Last check: ${when(s.chronicle.fetchedAt)}`),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/chronicle/refresh', { method: 'POST', body: {} })).then(r => { if (r) toast(r.ok ? `${r.fresh} new article(s)` : r.error, !r.ok); render(); }) } }, 'Check now')),
    h('label', {}, 'Add one article by URL'), h('div', { class: 'row' }, url, h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/chronicle/add', { method: 'POST', body: { url: url.value } }), 'Article added').then(render) } }, 'Add')),
    h('details', {}, h('summary', {}, 'Or paste an article'), title, author, text,
      h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/chronicle/add', { method: 'POST', body: { title: title.value, author: author.value, body: text.value } }), 'Article added').then(render) } }, 'Add article')),
    articles.length ? h('table', {}, h('tbody', {}, articles.slice(0, 30).map(a => h('tr', {},
      h('td', {}, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.title) : a.title, a.breaking ? ' ' : '', a.breaking ? pill('breaking', 'bad') : ''),
      h('td', {}, a.author || ''), h('td', {}, `${a.words} words`), h('td', {}, a.usedIn.length ? pill('aired', 'ok') : pill('new')))))) : h('p', { class: 'muted' }, 'No articles yet.'));

  const hub = h('section', { class: 'panel' }, h('h2', {}, 'HFL Hub'),
    h('p', {}, 'HFL-NN reads a JSON feed from the Hub: the official Game of the Week, coach names, announcements, power rankings, awards and history. See docs/hfl-setup.md for adding it to the Hub, and docs/hub-feed.md for the format. Either set the feed URL in Settings, or have the Hub POST to /api/hub/push with the HUB_PUSH_KEY bearer token.'),
    h('p', {}, s.hub.error ? h('span', { class: 'error' }, s.hub.error) : s.hub.fetchedAt ? `Last update ${when(s.hub.fetchedAt)} (${s.hub.source})` : 'No Hub data yet.'),
    h('button', { class: 'btn', type: 'button', on: { click: () => act(() => api('/api/admin/hub/refresh', { method: 'POST', body: {} })).then(r => { if (r) toast(r.ok ? 'Hub updated' : r.error, !r.ok); render(); }) } }, 'Fetch now'));
  return h('div', {}, upload, chron, hub);
}

// ── Settings ──────────────────────────────────────────────────────────────
async function viewSettings() {
  const st = await api('/api/admin/settings');
  const f = {};
  const check = (k, label) => h('label', { class: 'row' }, f[k] = h('input', { type: 'checkbox', checked: st[k] }), label);
  const sel = (k, opts, labels = {}) => { const s = h('select', {}, opts.map(o => h('option', { value: o }, labels[o] || o))); s.value = st[k] ?? opts[0]; f[k] = s; return s; };
  const text = (k, type = 'text', ph = '') => (f[k] = h('input', { type, value: st[k] ?? '', placeholder: ph }));
  const webhook = h('input', { type: 'url', placeholder: st.hasWebhook ? `${st.discordWebhook} (paste a new URL to replace)` : 'https://discord.com/api/webhooks/…' });
  const pron = h('textarea', { value: Object.entries(st.pronunciations || {}).map(([k, v]) => `${k} = ${v}`).join('\n'), placeholder: "Ja'Marr = Juh Mar" });

  const personaRows = st.personas.map(p => {
    const name = h('input', { type: 'text', value: p.name });
    const voice = h('select', {}, st.voices.map(v => h('option', { value: v }, v)));
    voice.value = p.voice;
    const speed = h('input', { type: 'number', min: '0.8', max: '1.25', step: '0.01', value: p.speed || 1 });
    const play = h('button', { class: 'btn', type: 'button', on: { click: async () => {
      play.disabled = true;
      try {
        const res = await api('/api/admin/tts/preview', { method: 'POST', raw: true, body: { voice: voice.value, speed: Number(speed.value), text: `${p.catchphrases?.[0] || 'Hello'} I'm ${name.value}, and this is HFL-NN.` } });
        if (!res.ok) throw new Error((await res.json()).error);
        new Audio(URL.createObjectURL(await res.blob())).play();
      } catch (e) { toast(`Voice preview failed: ${e.message}`, true); } finally { play.disabled = false; }
    } } }, '▶ Hear');
    return { id: p.id, name, voice, speed, el: h('tr', {}, h('td', {}, p.role), h('td', {}, name), h('td', {}, voice), h('td', {}, speed), h('td', {}, play)) };
  });

  const save = async () => {
    const patch = {
      phaseOverride: f.phaseOverride.value || null, writer: f.writer.value, claudeModel: f.claudeModel.value, spice: f.spice.value,
      autoProduce: f.autoProduce.checked, autoPublish: f.autoPublish.checked, autoBreaking: f.autoBreaking.checked, autoPublishBreaking: f.autoPublishBreaking.checked,
      publicUrl: f.publicUrl.value, chronicleFeedUrl: f.chronicleFeedUrl.value, hubFeedUrl: f.hubFeedUrl.value, pollMinutes: Number(f.pollMinutes.value),
      pronunciations: Object.fromEntries(pron.value.split('\n').map(l => l.split('=')).filter(p => p.length === 2).map(([a, b]) => [a.trim(), b.trim()])),
      personaOverrides: Object.fromEntries(personaRows.map(r => [r.id, { name: r.name.value, voice: r.voice.value, speed: Number(r.speed.value) }])),
    };
    if (webhook.value.trim()) patch.discordWebhook = webhook.value.trim();
    await act(() => api('/api/admin/settings', { method: 'PUT', body: patch }), 'Settings saved');
    render();
  };

  return h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Show'),
      h('div', { class: 'grid2' },
        h('div', {}, h('label', {}, 'Season phase'), sel('phaseOverride', ['', ...st.phases], { '': 'Detect from exports' }),
          h('p', { class: 'muted' }, 'Offseason sub-phases (re-signing, free agency, draft) can only be set here.')),
        h('div', {}, h('label', {}, 'Script writer'), sel('writer', ['auto', 'claude', 'template'], { auto: 'Claude if configured, else template', claude: 'Claude only', template: 'Template only (free)' })),
        h('div', {}, h('label', {}, 'Claude model'), sel('claudeModel', st.claudeModels.map(m => m.id), Object.fromEntries(st.claudeModels.map(m => [m.id, m.label]))),
          h('p', { class: 'muted' }, 'Sonnet 5.5 costs about half as much per script. If it declines a script, Opus 5.5 gets one try.')),
        h('div', {}, h('label', {}, 'Spice level'), sel('spice', ['mild', 'medium', 'spicy']))),
      check('autoProduce', 'Draft the weekly show automatically once a week\'s games are all final'),
      check('autoPublish', '…and publish it without review'),
      check('autoBreaking', 'Draft breaking bulletins for big moves and Chronicle "breaking" posts'),
      check('autoPublishBreaking', '…and publish bulletins without review')),
    h('section', { class: 'panel' }, h('h2', {}, 'Sources & links'),
      h('label', {}, 'Public URL of this site (for Discord links)'), text('publicUrl', 'url', 'https://hfl-nn.up.railway.app'),
      h('label', {}, 'Crimson Chronicle (the Hub\'s Chronicle page, or an RSS/Atom feed)'), text('chronicleFeedUrl', 'url', 'https://hfl-hub-5kc.pages.dev/chronicle'),
      h('label', {}, 'HFL Hub feed URL'), text('hubFeedUrl', 'url', 'https://…/api/hfl-nn-feed'),
      h('label', {}, 'Check feeds every (minutes)'), text('pollMinutes', 'number')),
    h('section', { class: 'panel' }, h('h2', {}, 'Discord'),
      h('label', {}, 'Channel webhook (stored encrypted; never shown again)'), webhook,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn', type: 'button', disabled: !st.hasWebhook, on: { click: () => act(() => api('/api/admin/discord/test', { method: 'POST', body: {} }), 'Test message sent') } }, 'Send test message'),
        h('button', { class: 'btn danger', type: 'button', disabled: !st.hasWebhook, on: { click: () => act(() => api('/api/admin/settings', { method: 'PUT', body: { clearWebhook: true } }), 'Webhook removed').then(render) } }, 'Remove webhook'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Anchors'),
      h('p', { class: 'muted' }, 'Names and voices. Looks, bios and personalities live in config/personas.json.'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Role', 'Name', 'Voice', 'Speed', ''].map(t => h('th', {}, t)))), h('tbody', {}, personaRows.map(r => r.el)))),
    h('section', { class: 'panel' }, h('h2', {}, 'Pronunciations'),
      h('p', { class: 'muted' }, 'One per line: how a name is written = how the voices should say it.'), pron),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', on: { click: save } }, 'Save settings')),
    startOverPanel());
}

function startOverPanel() {
  const typed = h('input', { type: 'text', placeholder: 'Type RESET', autocomplete: 'off' });
  const go = h('button', { class: 'btn danger', type: 'button', disabled: true, on: { click: () => act(() => api('/api/admin/reset', { method: 'POST', body: { confirm: typed.value.trim() } }), 'Started over').then(r => { if (r) { state.tab = 'dashboard'; render(); } }) } }, 'Start over');
  typed.addEventListener('input', () => { go.disabled = typed.value.trim() !== 'RESET'; });
  return h('section', { class: 'panel' }, h('h2', {}, 'Start over'),
    h('p', {}, 'Removes the league and everything made from it: news stories, every episode (published ones too), Chronicle articles, Hub data and the show\'s memory. Use it to clear the sample league, or exports from before a fantasy draft. The next export starts the league fresh.'),
    h('p', { class: 'muted' }, 'Kept: these settings, the Discord webhook, the export URL and the voices. A real league is saved to league/archive first. Discord posts already sent stay in Discord.'),
    h('div', { class: 'row' }, typed, go));
}

// ── Memory ────────────────────────────────────────────────────────────────
async function viewMemory() {
  const [m, st] = await Promise.all([api('/api/admin/memory'), api('/api/admin/settings')]);
  const name = id => st.personas.find(p => p.id === id)?.short || id;
  const grade = (p, status) => act(() => api('/api/admin/memory/prediction', { method: 'POST', body: { id: p.id, status } }), 'Saved').then(render);
  return h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Predictions made on air'),
      m.predictions.length ? h('table', {}, h('tbody', {}, m.predictions.slice().reverse().map(p => h('tr', {},
        h('td', {}, name(p.persona)), h('td', {}, p.text, h('div', { class: 'muted' }, p.madeIn)), h('td', {}, statusPill(p.status)),
        h('td', {}, h('button', { class: 'btn', type: 'button', on: { click: () => grade(p, 'right') } }, 'Right'), ' ',
          h('button', { class: 'btn', type: 'button', on: { click: () => grade(p, 'wrong') } }, 'Wrong')))))) : h('p', { class: 'muted' }, 'None yet. Graded predictions get called back on air.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Moods and feuds'),
      h('ul', {}, Object.entries(m.moods).map(([id, v]) => h('li', {}, `${name(id)}: ${v.mood}`)), m.feuds.map(f => h('li', {}, `${name(f.a)} vs. ${name(f.b)}: ${f.topic}`)))),
    h('section', { class: 'panel' }, h('h2', {}, 'Running storylines'),
      m.storylines.length ? h('ul', {}, m.storylines.map(s => h('li', {}, s.text))) : h('p', { class: 'muted' }, 'None yet.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Recent episodes'),
      m.episodes.length ? h('ul', {}, m.episodes.slice().reverse().map(e => h('li', {}, `${e.title}: ${e.summary}`))) : h('p', { class: 'muted' }, 'None yet.')));
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await api('/api/admin/me');
    render();
  } catch { /* renderLogin() already shown */ }
}
boot();
