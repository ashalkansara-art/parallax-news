#!/usr/bin/env node
// Builds public/data.json: fetches every feed in config/sources.json, filters out
// tabloid and off-topic items, and clusters articles from different outlets into stories.
//
//   node scripts/build.mjs                         live feeds
//   node scripts/build.mjs --fixture fixtures/sample.json   offline sample data
//
// No dependencies: Node 18+ (built-in fetch).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));

const NEWS_MAX_AGE_H = 72;
const F1_MAX_AGE_H = 24 * 7;
const JOIN_THRESHOLD = 0.3;    // similarity to a story's centre needed to join it
const LINK_THRESHOLD = 0.45;   // ...or to any single article already in it
const MERGE_THRESHOLD = 0.5;   // similarity between two stories' centres to merge them
const MIN_SHARED = 2;          // headline words or names an article must share with a story
const SAME_SOURCE_PENALTY = 0.08;
const SUMMARY_WORDS = 40;
const SUMMARY_WEIGHT = 0.4;
const JOIN_WINDOW_H = 48;

// ---------- feed parsing ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€' };
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const stripTags = (s) => decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const alt = links.find((a) => !/rel=/.test(a) || /rel=["']alternate["']/.test(a)) ?? links[0];
  return alt?.match(/href=["']([^"']+)["']/)?.[1] ?? '';
}

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const isAtom = /^<entry/i.test(b);
    const title = stripTags(tag(b, 'title'));
    const link = isAtom ? atomLink(b) : stripTags(tag(b, 'link')) || stripTags(tag(b, 'guid'));
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'));
    const date = stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    if (title && link) items.push({ title, link, summary, published: date ? new Date(date) : null });
  }
  return items;
}

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; ParallaxNews/1.0; personal RSS reader)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

// ---------- text helpers ----------

const STOP = new Set(`a an the and or but if of to in on at by for with from as is are was were be been being has have had do does did it its this that these those he she they them his her their our we you your i not no yes over under after before about into than then there here what which who whom whose when where why how all any some more most new says said say will would could should may might can just also up down out off again amid against via per vs v live latest update updates news report reports week day today year years first last two three one us`.split(' '));

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (list) => new RegExp(`(?:^|[^a-z0-9])(?:${list.map((p) => escapeRe(norm(p))).join('|')})(?=$|[^a-z0-9])`, 'i');
const countMatches = (text, list) => list.reduce((n, p) => n + (phraseRe([p]).test(text) ? 1 : 0), 0);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(item) {
  const weights = new Map();
  const add = (w, n) => weights.set(w, (weights.get(w) ?? 0) + n);
  // Capitalised words inside a headline are usually names: weight them up.
  item.title.split(/\s+/).forEach((raw, i) => {
    const w = stem(norm(raw).replace(/[^a-z0-9]/g, ''));
    if (w.length < 2 || STOP.has(w)) return;
    add(w, i > 0 && /^[A-Z]/.test(raw) ? 3 : 2);
  });
  for (const raw of norm(item.summary).split(/[^a-z0-9]+/).slice(0, SUMMARY_WORDS)) {
    const w = stem(raw);
    if (w.length < 3 || STOP.has(w)) continue;
    add(w, SUMMARY_WEIGHT);
  }
  return weights;
}

// Headline words for the "do these share enough?" check. A run of capitalised words
// ("Elon Musk", "Nobel Peace Prize") counts as one name, so a single shared name isn't enough.
const GENERIC = new Set('f1 gp grand prix formula race football fc league premier cup uk us bbc'.split(' '));
function titleUnits(title) {
  const word = (r) => stem(norm(r).replace(/[^a-z0-9]/g, ''));
  const keep = (w) => w.length >= 2 && !STOP.has(w) && !GENERIC.has(w);
  const isCap = (r) => /^[A-Z]/.test(r);
  const clean = title.replace(/[‘’“”"]+/g, ' ');
  const all = clean.split(/\s+/).filter(Boolean);
  const titleCase = all.filter(isCap).length > all.length * 0.6;
  const units = [];
  // Punctuation ends a name, so "Microsoft, Adobe" is two names.
  for (const seg of clean.split(/[,:;|()?!–—]|\s-\s/)) {
    const raw = seg.split(/\s+/).filter(Boolean);
    let run = [];
    const flush = () => { const u = run.map(word).filter(keep); if (u.length) units.push(u); run = []; };
    raw.forEach((r, i) => {
      if (!titleCase && isCap(r) && (i > 0 || isCap(raw[1] ?? ''))) { run.push(r); return; }
      flush(); run.push(r); flush();
    });
    flush();
  }
  return units;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const o = b.get(k); if (o) dot += v * o; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Sport stays in its own section: an F1 or football article never joins a news story.
const desk = (topic) => (topic === 'f1' || topic === 'football' ? topic : 'news');

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);

// ---------- pipeline ----------

function classify(item, feedTopic, filters) {
  const text = norm(`${item.title} ${item.summary}`);
  if (phraseRe(filters.block).test(text)) return null;
  if (feedTopic === 'f1' || feedTopic === 'football') return feedTopic;
  const scores = Object.fromEntries(Object.entries(filters.topics).map(([t, kw]) => [t, countMatches(text, kw)]));
  if (scores.f1 >= 2 && phraseRe(['formula 1', 'formula one', 'f1', 'grand prix']).test(text)) return 'f1';
  if (scores.football >= 2 && phraseRe(['football', 'premier league', 'champions league', 'fa cup']).test(text)) return 'football';
  if (feedTopic) return feedTopic === 'world' && scores.uk >= 3 && scores.uk > scores.world ? 'uk' : feedTopic;
  const order = ['uk', 'environment', 'tech', 'world'];
  const best = order.reduce((a, b) => (scores[b] > scores[a] ? b : a));
  return scores[best] >= 2 ? best : null; // general feeds need real evidence of a topic
}

function cluster(items) {
  // Inverse document frequency so words like "government" count less than names.
  const df = new Map();
  for (const it of items) for (const w of it.vec.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const n = items.length;
  for (const it of items) for (const [w, v] of it.vec) it.vec.set(w, v * Math.log(1 + n / df.get(w)));

  const clusters = [];
  for (const it of [...items].sort((a, b) => a.published - b.published)) {
    let best = null, bestSim = 0;
    for (const c of clusters) {
      if (desk(it.topic) !== desk(c.topic)) continue;
      if (it.published - c.latest > JOIN_WINDOW_H * 3.6e6) continue;
      const link = Math.max(...c.items.map((o) => cosine(it.vec, o.vec)));
      let sim = Math.max(cosine(it.vec, c.centroid), link >= LINK_THRESHOLD ? link : 0);
      if (c.items.some((o) => o.source === it.source)) sim -= SAME_SOURCE_PENALTY;
      const shared = it.units.filter((u) => u.some((w) => c.titleWords.has(w))).length;
      if (shared < MIN_SHARED) continue;
      sim += 0.02 * Math.min(shared, 4);
      if (sim > bestSim) { best = c; bestSim = sim; }
    }
    if (best && bestSim >= JOIN_THRESHOLD) {
      best.items.push(it);
      for (const [w, v] of it.vec) best.centroid.set(w, (best.centroid.get(w) ?? 0) + v);
      best.latest = Math.max(best.latest, it.published);
      for (const w of it.titleWords) best.titleWords.add(w);
    } else {
      clusters.push({ topic: it.topic, items: [it], centroid: new Map(it.vec), latest: +it.published, titleWords: new Set(it.titleWords) });
    }
  }
  // Second pass: one-at-a-time joining can split a story in two when the first articles
  // differ. Merge clusters whose centres are close and whose headlines share names.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) for (let j = i + 1; j < clusters.length && !merged; j++) {
      const a = clusters[i], b = clusters[j];
      if (desk(a.topic) !== desk(b.topic)) continue;
      if (cosine(a.centroid, b.centroid) < MERGE_THRESHOLD) continue;
      const small = a.items.length <= b.items.length ? a : b, big = small === a ? b : a;
      const keys = new Set(small.items.flatMap((it) => it.units.filter((u) => u.some((w) => big.titleWords.has(w))).map((u) => u.join(' '))));
      if (keys.size < MIN_SHARED + 1) continue;
      for (const it of small.items) { big.items.push(it); for (const [w, v] of it.vec) big.centroid.set(w, (big.centroid.get(w) ?? 0) + v); for (const w of it.titleWords) big.titleWords.add(w); }
      big.latest = Math.max(big.latest, small.latest);
      clusters.splice(clusters.indexOf(small), 1);
      merged = true;
    }
  }
  return clusters;
}

function toStory(c, sourcesById, now) {
  const bySource = new Map();
  for (const it of c.items.sort((a, b) => a.published - b.published)) if (!bySource.has(it.source)) bySource.set(it.source, it);
  const articles = [...bySource.values()];
  const topicVotes = {};
  for (const a of articles) topicVotes[a.topic] = (topicVotes[a.topic] ?? 0) + 1;
  const topic = Object.entries(topicVotes).sort((a, b) => b[1] - a[1])[0][0];

  // Headline: the article closest to the cluster centre, preferring centre-rated outlets.
  const lead = [...articles].sort((a, b) => {
    const s = (x) => cosine(x.vec, c.centroid) + (sourcesById[x.source].lean === 0 ? 0.08 : 0) + (x.summary ? 0.02 : 0) - (/[:?]/.test(x.title) ? 0.05 : 0);
    return s(b) - s(a);
  })[0];

  const lean = { left: 0, centre: 0, right: 0, unrated: 0 };
  for (const a of articles) {
    const l = sourcesById[a.source].lean;
    if (l == null) lean.unrated++; else if (l < 0) lean.left++; else if (l > 0) lean.right++; else lean.centre++;
  }
  const rated = lean.left + lean.centre + lean.right;
  let blindspot = null;
  if (desk(topic) === 'news' && rated >= 3) {
    if (lean.left / rated <= 0.15 && lean.right / rated >= 0.5) blindspot = 'left';
    if (lean.right / rated <= 0.15 && lean.left / rated >= 0.5) blindspot = 'right';
  }
  const ageH = (now - c.latest) / 3.6e6;
  const diversity = [lean.left, lean.centre, lean.right].filter(Boolean).length;
  const score = articles.length * (1 + 0.25 * Math.max(0, diversity - 1)) * (0.4 + 0.6 * Math.exp(-ageH / 24));

  return {
    id: hash(articles.map((a) => a.link).sort()[0]),
    topic,
    title: lead.title,
    summary: lead.summary.slice(0, 320),
    first: new Date(articles[0].published).toISOString(),
    updated: new Date(c.latest).toISOString(),
    lean,
    blindspot,
    score: Math.round(score * 100) / 100,
    articles: articles.map((a) => ({ source: a.source, title: a.title, link: a.link, summary: a.summary.slice(0, 240), published: a.published.toISOString() })),
  };
}

async function main() {
  const fixtureArg = process.argv.indexOf('--fixture');
  const fixture = fixtureArg > -1 ? process.argv[fixtureArg + 1] : null;
  const [{ sources }, filters, calendar] = await Promise.all([readJson('config/sources.json'), readJson('config/filters.json'), readJson('config/f1-calendar.json')]);
  const sourcesById = Object.fromEntries(sources.map((s) => [s.id, s]));
  const now = Date.now();
  const raw = [];
  const feedStatus = [];

  if (fixture) {
    const fx = await readJson(fixture);
    for (const it of fx.items) raw.push({ ...it, link: it.link ?? `https://example.org/${it.source}/${hash(it.title)}`, summary: it.summary ?? '', published: new Date(now - it.hoursAgo * 3.6e6), feedTopic: it.topic ?? null });
  } else {
    const jobs = sources.flatMap((s) => s.feeds.map((f) => ({ s, f })));
    await Promise.all(jobs.map(async ({ s, f }) => {
      try {
        const items = await fetchFeed(f.url);
        for (const it of items) raw.push({ ...it, source: s.id, feedTopic: f.topic });
        feedStatus.push({ source: s.id, url: f.url, ok: true, items: items.length });
      } catch (e) {
        feedStatus.push({ source: s.id, url: f.url, ok: false, error: String(e.message ?? e) });
      }
    }));
  }

  if (!fixture && !feedStatus.some((f) => f.ok)) {
    console.error('No feeds could be reached; keeping the previous data.json.');
    process.exit(1);
  }

  const seen = new Set();
  const items = [];
  for (const it of raw) {
    if (!it.published || isNaN(it.published) || it.published > now + 3.6e6) continue;
    const key = it.link.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const topic = classify(it, it.feedTopic, filters);
    if (!topic) continue;
    if ((now - it.published) / 3.6e6 > (topic === 'f1' ? F1_MAX_AGE_H : NEWS_MAX_AGE_H)) continue;
    const units = titleUnits(it.title);
    items.push({ ...it, topic, vec: tokens(it), units, titleWords: new Set(units.flat()) });
  }

  const stories = cluster(items).map((c) => toStory(c, sourcesById, now)).sort((a, b) => b.score - a.score);

  const out = {
    generatedAt: new Date(now).toISOString(),
    sample: Boolean(fixture),
    sources: Object.fromEntries(sources.map(({ id, name, lean, factuality, owner }) => [id, { name, lean, factuality, owner }])),
    f1: { calendar: calendar.races, spoilerWords: filters.f1Spoiler },
    football: { spoilerWords: filters.footballSpoiler },
    stories,
    feeds: feedStatus,
  };
  await mkdir(path.join(ROOT, 'public'), { recursive: true });
  await writeFile(path.join(ROOT, 'public/data.json'), JSON.stringify(out));
  const ok = feedStatus.filter((f) => f.ok).length;
  console.log(`${stories.length} stories from ${items.length} articles` + (fixture ? ' (sample)' : `; ${ok}/${feedStatus.length} feeds ok`));
  const multi = stories.filter((s) => s.articles.length > 1);
  console.log(`${multi.length} stories covered by 2+ outlets`);
}

main().catch((e) => { console.error(e); process.exit(1); });
