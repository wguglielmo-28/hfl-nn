// The Crimson Chronicle reader. Polls the Chronicle's RSS or Atom feed (or
// finds the feed from the site's <link rel="alternate">), keeps new articles,
// and fetches the article page when the feed only carries a teaser. The
// commissioner can also add a single article by URL from the control room.
//
// A page with no feed at all — like the HFL Hub's /chronicle, which lists
// every issue at /chronicle/week-N — is read as an index: new links below it
// are fetched as articles.
'use strict';
const { XMLParser } = require('fast-xml-parser');
const { sha256, asciiFold } = require('../util');

const MAX_BYTES = 3 * 1024 * 1024;
const KEEP = 100;
const TEXT_LIMIT = 6000;
const FIRST_INDEX_READ = 1;   // back issues aren't news: start from the newest
const NEW_PER_POLL = 5;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li|blockquote|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/\n\s*\n\s*(\n\s*)*/g, '\n\n').trim();
}

const text = v => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return text(v['#text'] ?? v['@_href'] ?? v.name ?? '');
};

function atomLink(link) {
  const links = Array.isArray(link) ? link : [link];
  const alt = links.find(l => l && (l['@_rel'] === 'alternate' || !l['@_rel'])) || links[0];
  return alt ? (alt['@_href'] || text(alt)) : '';
}

function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true });
  const doc = parser.parse(xml);
  const rssItems = doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item;
  const atomItems = doc?.feed?.entry;
  const items = [].concat(rssItems || atomItems || []);
  if (!rssItems && !atomItems) throw new Error('Not an RSS or Atom feed');
  return items.map(it => {
    const isAtom = !!atomItems;
    const url = isAtom ? atomLink(it.link) : text(it.link);
    const guid = text(isAtom ? it.id : it.guid) || url || text(it.title);
    const categories = [].concat(it.category || []).map(c => text(c['@_term'] ?? c)).filter(Boolean);
    const content = text(it['content:encoded'] ?? (isAtom ? it.content : null));
    const summary = text(isAtom ? it.summary : it.description);
    const title = htmlToText(text(it.title));
    return {
      guid,
      title,
      url,
      author: htmlToText(text(isAtom ? it.author : (it['dc:creator'] ?? it.author))).slice(0, 80),
      published: text(isAtom ? (it.published ?? it.updated) : (it.pubDate ?? it['dc:date'])) || null,
      excerpt: htmlToText(summary).slice(0, 800),
      body: htmlToText(content).slice(0, 8000),
      breaking: /breaking/i.test(categories.join(' ')) || /^breaking\b/i.test(title),
    };
  }).filter(i => i.title);
}

const classOf = attrs => (String(attrs).match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1] || '';

// Text of the first element whose class matches (up to its first closing tag,
// which is right for the leaf elements this looks for: bylines, decks).
function byClass(html, re) {
  for (const m of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    if (!re.test(classOf(m[2]))) continue;
    const start = m.index + m[0].length;
    const end = html.slice(start).search(new RegExp(`</${m[1]}\\s*>`, 'i'));
    const text = end < 0 ? '' : htmlToText(html.slice(start, start + end)).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

// Cut to `n` characters at a sentence end if there is one, else a word.
function clipSentences(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > n * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '...';
}

// A headline from a summary paragraph: its first sentence, or the first
// clause of a long one.
function headlineFrom(s) {
  const first = (String(s).match(/^[\s\S]*?[.!?](?=\s|$)/) || [s])[0].trim();
  if (first.length <= 100) return first.replace(/\.$/, '');
  const clause = first.split(/[,;:]\s|\s[-–—]{1,2}\s/)[0].trim();
  return clause.length >= 20 && clause.length <= 100 ? clause : '';
}

const NOISE = /\b(comments?|discussion|press-row|beat-|poll|share|related|subscribe|newsletter)/i;
const NOISE_HEADINGS = /^(discussion|comments|league poll|share|related)/i;

// Main article text from a page. Prefers <article>, then <main>; reads the
// headings and paragraphs in order (tables, forms and comment threads are
// dropped). Long multi-section pages — a whole Chronicle issue — become a
// digest: the cover summary and lede, then the start of every section, so the
// writers see the feature story and the preview, not just the scoreboard.
function extractArticle(html) {
  const meta = name => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i')) || [])[1];
  const docTitle = htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const feedLink = (html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i) || [''])[0].match(/href=["']([^"']+)["']/i)?.[1] || null;
  const scope = (html.match(/<article\b[\s\S]*<\/article>/i) || html.match(/<main\b[\s\S]*<\/main>/i) || [html])[0];

  const byline = byClass(scope, /\bbyline\b/i).replace(/^by\s+/i, '');
  const author = decodeEntities(meta('author') || meta('article:author') || '').trim() || byline.split(/,|\s[|·•]\s|\s[-–—]\s/)[0].trim();
  const cover = byClass(scope, /\bcover-label\b/i);
  const deck = byClass(scope, /\b(cover-deck|deck|dek|standfirst|subtitle|summary|excerpt)\b/i);
  const lede = byClass(scope, /\blede\b/i);
  const intro = [cover, deck, lede].filter(Boolean);

  const clean = scope
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button|table|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<section\b([^>]*)>[\s\S]*?<\/section>/gi, (m, attrs) => (NOISE.test(classOf(attrs)) ? ' ' : m));
  const sections = [];
  let cur = { heading: '', paras: [] };
  let sub = '';
  for (const m of clean.matchAll(/<(h[1-4]|p|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const text = htmlToText(m[3]).replace(/\s+/g, ' ').trim();
    if (!text || intro.includes(text) || text === byline || tag === 'h1') continue;
    if (tag === 'h2') { if (cur.heading || cur.paras.length) sections.push(cur); cur = { heading: text, paras: [] }; sub = ''; }
    else if (tag === 'h3' || tag === 'h4') sub = text;
    else { cur.paras.push(sub ? `${sub}: ${text}` : text); sub = ''; }
  }
  if (cur.heading || cur.paras.length) sections.push(cur);
  const kept = sections.filter(s => s.paras.length && !NOISE_HEADINGS.test(s.heading));

  const block = s => (s.heading ? `${s.heading}\n${s.paras.join('\n')}` : s.paras.join('\n'));
  let body = [...intro, ...kept.map(block)].join('\n\n');
  if (body.length > TEXT_LIMIT && kept.length > 1) {
    const room = TEXT_LIMIT - intro.join('\n\n').length - kept.reduce((n, s) => n + s.heading.length + 4, 0);
    const each = Math.max(160, Math.floor(room / kept.length));
    body = [...intro, ...kept.map(s => `${s.heading ? `${s.heading}\n` : ''}${clipSentences(s.paras.join(' '), each)}`)].join('\n\n');
  }
  if (body.length < 300) {
    // Not paragraph-shaped: fall back to the block with the most text.
    const blocks = html.split(/<(?:div|section|main)[^>]*>/i).map(htmlToText).sort((a, b) => b.length - a.length);
    if ((blocks[0] || '').length > body.length) body = blocks[0];
  }

  const feature = kept.map(s => s.heading).find(h => /^(feature|cover) story\s*[:–—-]/i.test(h));
  const title = decodeEntities(meta('og:title') || '').trim()
    || (feature && feature.replace(/^(feature|cover) story\s*[:–—-]\s*/i, ''))
    || headlineFrom(deck)
    || docTitle;
  return {
    title: htmlToText(title),
    author,
    body: body.slice(0, TEXT_LIMIT),
    excerpt: deck || lede || (kept[0]?.paras[0] || '').slice(0, 600),
    issue: docTitle && docTitle !== htmlToText(title) ? docTitle : null,
    feedLink,
  };
}

// Links on an index page that look like its articles: same site, one or two
// path segments below the page itself (/chronicle → /chronicle/week-19), in
// page order (newest first on the Hub).
function indexLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const prefix = base.pathname.replace(/\/+$/, '') + '/';
  if (prefix === '/') return [];
  const scope = (html.match(/<main\b[\s\S]*<\/main>/i) || [html])[0];
  const out = [];
  for (const m of scope.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    if (u.origin !== base.origin || !u.pathname.startsWith(prefix)) continue;
    const rest = u.pathname.slice(prefix.length).replace(/\/+$/, '');
    if (!rest || rest.split('/').length > 2) continue;
    u.search = ''; u.hash = '';
    if (!out.includes(u.toString())) out.push(u.toString());
  }
  return out;
}

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { 'User-Agent': 'HFL-NN (league news bot)', Accept: 'application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5' } });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('Response larger than 3 MB');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function createChronicleSource({ store, getUrl, outlet = 'The Crimson Chronicle', onNew = () => {}, fetchImpl, logger = console }) {
  let state = store.readJSON('sources/chronicle.json', { articles: [], fetchedAt: null, error: null, feedUrl: null });
  const save = () => store.writeJSON('sources/chronicle.json', state);

  function toArticle(item) {
    const body = item.body || '';
    return {
      id: `chronicle:${sha256(item.guid || item.url || item.title).slice(0, 12)}`,
      guid: item.guid || item.url,
      title: asciiFold(item.title).slice(0, 200),
      url: item.url || null,
      author: asciiFold(item.author || '').slice(0, 80),
      issue: asciiFold(item.issue || '').slice(0, 120) || null,
      published: item.published || null,
      excerpt: asciiFold(item.excerpt || body.slice(0, 600)).slice(0, 600),
      text: asciiFold(body).slice(0, TEXT_LIMIT),
      breaking: !!item.breaking,
      fetchedAt: new Date().toISOString(),
      usedIn: [],
    };
  }

  const pageItem = (url, page) => ({
    guid: url, url, title: page.title || url, author: page.author, issue: page.issue,
    body: page.body, excerpt: page.excerpt, breaking: /^breaking\b/i.test(page.title || ''),
  });

  // An index page with no feed: fetch the links we haven't read yet. The
  // first read of an index only takes the newest issue; older ones are marked
  // seen so they never turn up as "new".
  async function readIndex(links, url) {
    const firstRead = state.index?.url !== url;
    const seen = new Set(firstRead ? [] : state.index.seen);
    const known = new Set(state.articles.map(a => a.guid));
    const unseen = links.filter(u => !seen.has(u) && !known.has(u));
    const take = unseen.slice(0, firstRead ? FIRST_INDEX_READ : NEW_PER_POLL);
    const items = [];
    for (const u of take) {
      try {
        const page = extractArticle(await fetchText(u, { fetchImpl }));
        if (page.body) items.push(pageItem(u, page));
        else logger.warn(`[chronicle] no article text at ${u}`);
        seen.add(u);
      } catch (e) { logger.warn(`[chronicle] could not fetch ${u}: ${e.message}`); }
    }
    if (firstRead) for (const u of unseen.slice(take.length)) seen.add(u);
    state.index = { url, seen: [...seen].slice(-500) };
    return items;
  }

  function add(list) {
    const known = new Set(state.articles.map(a => a.id));
    const fresh = list.map(toArticle).filter(a => !known.has(a.id));
    if (fresh.length) {
      state.articles = [...fresh, ...state.articles].slice(0, KEEP);
      save();
      try { onNew(fresh); } catch (e) { logger.warn(`[chronicle] new-article hook failed: ${e.message}`); }
    }
    return fresh;
  }

  async function refresh() {
    let url = getUrl();
    if (!url) return { ok: false, error: 'No Chronicle feed URL configured' };
    try {
      let body = await fetchText(url, { fetchImpl });
      let items;
      let mode = 'feed';
      try {
        items = parseFeed(body);
      } catch {
        // A site URL instead of a feed: follow its <link rel="alternate">, or
        // read the page as a list of articles.
        const found = extractArticle(body).feedLink;
        if (found) {
          url = new URL(found, url).toString();
          body = await fetchText(url, { fetchImpl });
          items = parseFeed(body);
        } else {
          const links = indexLinks(body, url);
          if (!links.length) throw new Error('No RSS/Atom feed or list of articles found at that URL');
          items = await readIndex(links, url);
          mode = 'page';
        }
      }
      // Teaser-only feeds: fetch the full article for the newest few.
      const known = new Set(state.articles.map(a => a.guid));
      let fetched = 0;
      for (const it of items) {
        if (known.has(it.guid) || it.body.length >= 400 || !it.url || fetched >= 5) continue;
        try {
          const page = extractArticle(await fetchText(it.url, { fetchImpl }));
          if (page.body.length > it.body.length) it.body = page.body;
          if (!it.author && page.author) it.author = page.author;
          fetched++;
        } catch (e) { logger.warn(`[chronicle] could not fetch ${it.url}: ${e.message}`); }
      }
      const fresh = add(items);
      state = { ...state, fetchedAt: new Date().toISOString(), error: null, feedUrl: url, mode };
      save();
      return { ok: true, mode, found: items.length, fresh: fresh.length };
    } catch (e) {
      state = { ...state, error: e.message, errorAt: new Date().toISOString() };
      save();
      logger.warn(`[chronicle] ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function addUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Article URL must be http(s)');
    const page = extractArticle(await fetchText(u.toString(), { fetchImpl }));
    if (!page.title && !page.body) throw new Error('Could not find an article on that page');
    const fresh = add([pageItem(u.toString(), page)]);
    return fresh[0] || state.articles.find(a => a.guid === u.toString());
  }

  function addText({ title, author, body, url }) {
    if (!title || !body) throw new Error('Title and text are required');
    return add([{ guid: url || `manual:${title}`, url: url || null, title, author, body, excerpt: String(body).slice(0, 600) }])[0];
  }

  // Forget every article and which issues were seen; the next check starts
  // over from the newest issue.
  function reset() {
    state = { articles: [], fetchedAt: null, error: null, feedUrl: null };
    save();
    store.remove('sources/chronicle.json.bak');
  }

  function markUsed(ids, episodeId) {
    let changed = false;
    for (const a of state.articles) if (ids.includes(a.id) && !a.usedIn.includes(episodeId)) { a.usedIn.push(episodeId); changed = true; }
    if (changed) save();
  }

  return {
    outlet,
    refresh, addUrl, addText, markUsed, reset,
    unused: () => state.articles.filter(a => !a.usedIn.length),
    list: () => state.articles,
    status: () => ({ fetchedAt: state.fetchedAt, error: state.error, feedUrl: state.feedUrl, mode: state.mode || null, count: state.articles.length, unused: state.articles.filter(a => !a.usedIn.length).length }),
  };
}

module.exports = { createChronicleSource, parseFeed, extractArticle, indexLinks, htmlToText };
