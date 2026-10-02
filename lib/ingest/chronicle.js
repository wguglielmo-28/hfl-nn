// The Crimson Chronicle reader. Polls the Chronicle's RSS or Atom feed (or
// finds the feed from the site's <link rel="alternate">), keeps new articles,
// and fetches the article page when the feed only carries a teaser. The
// commissioner can also add a single article by URL from the control room.
'use strict';
const { XMLParser } = require('fast-xml-parser');
const { sha256, asciiFold } = require('../util');

const MAX_BYTES = 3 * 1024 * 1024;
const KEEP = 100;

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

// Main article text from a page: <article>, else the block with the most text.
function extractArticle(html) {
  const meta = name => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i')) || [])[1];
  const title = decodeEntities(meta('og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const author = decodeEntities(meta('author') || meta('article:author') || '').trim();
  let body = '';
  const article = html.match(/<article[\s\S]*?<\/article>/i);
  if (article) body = htmlToText(article[0]);
  if (body.length < 300) {
    const blocks = html.split(/<(?:div|section|main)[^>]*>/i).map(htmlToText).sort((a, b) => b.length - a.length);
    if ((blocks[0] || '').length > body.length) body = blocks[0];
  }
  return { title: htmlToText(title), author, body: body.slice(0, 8000), feedLink: (html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i) || [''])[0].match(/href=["']([^"']+)["']/i)?.[1] || null };
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
      published: item.published || null,
      excerpt: asciiFold(item.excerpt || body.slice(0, 600)).slice(0, 600),
      text: asciiFold(body).slice(0, 6000),
      breaking: !!item.breaking,
      fetchedAt: new Date().toISOString(),
      usedIn: [],
    };
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
      try {
        items = parseFeed(body);
      } catch {
        // A site URL instead of a feed: follow its <link rel="alternate">.
        const found = extractArticle(body).feedLink;
        if (!found) throw new Error('No RSS/Atom feed found at that URL');
        url = new URL(found, url).toString();
        body = await fetchText(url, { fetchImpl });
        items = parseFeed(body);
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
      state = { ...state, fetchedAt: new Date().toISOString(), error: null, feedUrl: url };
      save();
      return { ok: true, found: items.length, fresh: fresh.length };
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
    const fresh = add([{ guid: u.toString(), url: u.toString(), title: page.title || u.toString(), author: page.author, body: page.body, excerpt: page.body.slice(0, 600) }]);
    return fresh[0] || state.articles.find(a => a.guid === u.toString());
  }

  function addText({ title, author, body, url }) {
    if (!title || !body) throw new Error('Title and text are required');
    return add([{ guid: url || `manual:${title}`, url: url || null, title, author, body, excerpt: String(body).slice(0, 600) }])[0];
  }

  function markUsed(ids, episodeId) {
    let changed = false;
    for (const a of state.articles) if (ids.includes(a.id) && !a.usedIn.includes(episodeId)) { a.usedIn.push(episodeId); changed = true; }
    if (changed) save();
  }

  return {
    outlet,
    refresh, addUrl, addText, markUsed,
    unused: () => state.articles.filter(a => !a.usedIn.length),
    list: () => state.articles,
    status: () => ({ fetchedAt: state.fetchedAt, error: state.error, feedUrl: state.feedUrl, count: state.articles.length, unused: state.articles.filter(a => !a.usedIn.length).length }),
  };
}

module.exports = { createChronicleSource, parseFeed, extractArticle, htmlToText };
