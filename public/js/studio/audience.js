// The HFL Hub's channel audience, read-only, on HFL-NN's own channel page:
// emoji reactions floating over the picture, the crowd meter and the poll on
// it, and under it a "Chat says" line, the poll and the chat. Posting,
// reacting and voting happen on the Hub, where members are signed in; this
// page links there. Reads /api/audience (lib/ingest/audience.js) every few
// seconds while the page is visible. Everything is shown as text.

const POLL_MS = 4000;
const CROWD_FULL = 30;
const MAX_SHOWN = 120;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);
const clock = at => {
  const ms = Date.parse(String(at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z'));
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
};

export class Audience {
  // tv: the element the picture is in; below: where the chat goes.
  constructor(tv, below) {
    this.messages = [];
    this.lastMessage = null;
    this.lastReaction = null;
    this.timer = null;
    this.running = false;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // On the picture.
    this.overlay = el('div', 'aud-overlay');
    this.overlay.hidden = true;
    this.meter = el('span', 'aud-meter');
    this.meterFill = el('span', 'aud-meter-fill');
    this.meter.append(this.meterFill, el('span', 'aud-meter-label', 'Crowd'));
    this.pollCard = el('div', 'aud-poll-card');
    this.overlay.append(this.meter, this.pollCard);
    tv.append(this.overlay);

    // Under it.
    this.panel = el('section', 'audience');
    this.panel.setAttribute('aria-label', 'Chat from the HFL Hub');
    this.panel.hidden = true;
    const says = el('div', 'aud-says');
    says.append(el('span', 'aud-says-label', 'Chat says'));
    this.saysText = el('span', 'aud-says-text', 'Nothing yet.');
    says.append(this.saysText);
    this.crowdLine = el('p', 'aud-crowd muted');
    this.pollBox = el('div', 'aud-poll');
    const head = el('div', 'aud-head');
    head.append(el('h2', null, 'Chat'));
    this.join = el('a', 'aud-join', 'Join the chat on the HFL Hub ↗');
    this.join.target = '_blank';
    this.join.rel = 'noopener';
    head.append(this.join);
    this.list = el('ol', 'aud-messages');
    this.note = el('p', 'aud-note muted', 'Chat, reactions and polls happen on the HFL Hub, where league members sign in with Discord. They show here as they come in.');
    this.panel.append(says, this.crowdLine, this.pollBox, head, this.list, this.note);
    below.append(this.panel);

    this.says = 0;
    this.rotate = setInterval(() => { this.says++; this.renderSays(); }, 6000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.running) this.tick(); });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.overlay.hidden = true;
    this.panel.hidden = true;
  }

  async tick() {
    clearTimeout(this.timer);
    if (!this.running) return;
    if (!document.hidden) {
      try {
        const q = this.lastMessage == null ? '' : `?m=${this.lastMessage}&r=${this.lastReaction}`;
        const r = await fetch(`/api/audience${q}`, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) this.apply(await r.json());
      } catch { /* try again next time */ }
    }
    if (this.running) this.timer = setTimeout(() => this.tick(), POLL_MS);
  }

  apply(u) {
    if (!u.on) { this.overlay.hidden = true; this.panel.hidden = true; return; }
    this.overlay.hidden = false;
    this.panel.hidden = false;
    this.join.href = u.joinUrl;
    const first = this.lastMessage == null;
    const hidden = new Set(u.hidden || []);
    const known = new Set(this.messages.map(m => m.id));
    this.messages = [...this.messages.filter(m => !hidden.has(m.id)), ...(u.messages || []).filter(m => !known.has(m.id) && !hidden.has(m.id))].slice(-MAX_SHOWN);
    this.lastMessage = u.lastMessage;
    this.lastReaction = u.lastReaction;
    if (!first) (u.reactions || []).forEach((x, i) => setTimeout(() => this.float(x.emoji), Math.min(i, 20) * 90));
    this.renderMessages(first || (u.messages || []).length > 0);
    this.renderSays();
    const meter = Math.min(100, Math.round((100 * (u.crowd || 0)) / CROWD_FULL));
    this.meterFill.style.height = `${meter}%`;
    this.crowdLine.textContent = `${u.crowd || 0} ${u.crowd === 1 ? 'reaction' : 'reactions'} in the last minute${u.stale ? ' · the Hub is not answering right now' : ''}`;
    this.renderPoll(u.poll);
  }

  float(emoji) {
    if (this.reduceMotion || this.overlay.hidden) return;
    const f = el('span', 'aud-floater', emoji);
    f.style.left = `${62 + Math.random() * 30}%`;
    f.style.setProperty('--drift', `${Math.round(Math.random() * 40 - 20)}px`);
    this.overlay.append(f);
    setTimeout(() => f.remove(), 2800);
  }

  renderMessages(scroll) {
    const stick = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    this.list.replaceChildren(...(this.messages.length ? this.messages.map(m => {
      const li = el('li');
      li.append(el('span', 'aud-who', m.name), el('span', 'aud-when', clock(m.at)), el('span', 'aud-body', m.body));
      return li;
    }) : [el('li', 'muted', 'No messages yet. Start it off on the HFL Hub.')]));
    if (scroll && (stick || this.messages.length <= 60)) this.list.scrollTop = this.list.scrollHeight;
  }

  renderSays() {
    const recent = this.messages.slice(-5);
    const m = recent.length ? recent[this.says % recent.length] : null;
    this.saysText.replaceChildren();
    if (!m) { this.saysText.textContent = 'Nothing yet.'; return; }
    this.saysText.append(el('strong', null, `${m.name}: `), document.createTextNode(m.body));
  }

  renderPoll(p) {
    this.pollCard.hidden = !p;
    this.pollBox.hidden = !p;
    if (!p) return;
    const rows = box => p.options.map((o, i) => {
      const row = el('div', `${box}-row`);
      const bar = el('span', `${box}-bar`);
      bar.style.width = `${pct(p.counts[i], p.total)}%`;
      row.append(bar, el('span', `${box}-o`, o), el('span', `${box}-n`, `${pct(p.counts[i], p.total)}%`));
      return row;
    });
    this.pollCard.replaceChildren(el('div', 'aud-poll-q', `${p.open ? 'Poll' : 'Final'}: ${p.question}`), ...rows('aud-pc'));
    const head = el('p', 'aud-poll-head');
    head.append(el('span', 'aud-tag', p.open ? 'Live poll' : 'Poll closed'), el('strong', null, ` ${p.question} `), el('span', 'muted', `${p.total} ${p.total === 1 ? 'vote' : 'votes'}`));
    const vote = el('a', 'aud-vote', p.open ? 'Vote on the HFL Hub ↗' : 'See it on the HFL Hub ↗');
    vote.href = this.join.href;
    vote.target = '_blank';
    vote.rel = 'noopener';
    this.pollBox.replaceChildren(head, ...rows('aud-pb'), vote);
  }
}
