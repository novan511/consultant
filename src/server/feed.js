// Feed scanner — pulls items from arxiv + Reddit + RSS to feed the 24/7 loop.
// Rate-limited, cached, with exponential backoff on failures.
import { supabase } from './supabase.js';
import { log } from './lib/logger.js';
import { FEED_CACHE_TTL_MS, FEED_MAX_RETRIES, FEED_RETRY_DELAY_MS, REDDIT_SUBS } from './lib/constants.js';

const ARXIV = (q) => `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=10&sortBy=submittedDate&sortOrder=desc`;
const REDDIT = (sub) => `https://www.reddit.com/r/${sub}/top.json?limit=10`;
const HN     = `https://hnrss.org/frontpage?count=20`;

// Per-URL failure tracking for backoff
const failureCounts = new Map(); // url -> { count, lastFailure }

function shouldSkip(url) {
  const f = failureCounts.get(url);
  if (!f) return false;
  const backoffMs = FEED_RETRY_DELAY_MS * Math.pow(2, Math.min(f.count, 5));
  if (Date.now() - f.lastFailure < backoffMs) return true;
  return false;
}

function recordFailure(url) {
  const f = failureCounts.get(url) || { count: 0, lastFailure: 0 };
  f.count++;
  f.lastFailure = Date.now();
  failureCounts.set(url, f);
}

function recordSuccess(url) {
  failureCounts.delete(url);
}

async function safeJson(url) {
  if (shouldSkip(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ProfessorSenate/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) {
      recordFailure(url);
      return null;
    }
    recordSuccess(url);
    return await r.json();
  } catch {
    recordFailure(url);
    return null;
  }
}

async function safeText(url) {
  if (shouldSkip(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ProfessorSenate/1.0' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!r.ok) {
      recordFailure(url);
      return null;
    }
    recordSuccess(url);
    return await r.text();
  } catch {
    recordFailure(url);
    return null;
  }
}

export async function fetchArxiv() {
  const xml = await safeText(ARXIV('AI OR science OR research'));
  if (!xml) return [];
  const entries = xml.split('<entry>').slice(1);
  return entries.map(e => {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim();
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, ' ').trim();
    const link = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim();
    return { source: 'arxiv', title, summary, url: link };
  }).filter(x => x.title);
}

export async function fetchReddit() {
  const all = [];
  // Fetch Reddit in parallel with individual failure isolation
  const results = await Promise.allSettled(
    REDDIT_SUBS.map(s => safeJson(REDDIT(s)).then(j => ({ sub: s, j })))
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.j?.data?.children) continue;
    const { sub, j } = r.value;
    for (const c of j.data.children) {
      const d = c.data;
      all.push({
        source: `reddit/${sub}`,
        title: d.title,
        summary: d.selftext?.slice(0, 400) || d.url,
        url: `https://reddit.com${d.permalink}`
      });
    }
  }
  return all;
}

export async function fetchHackerNews() {
  const xml = await safeText(HN);
  if (!xml) return [];
  const items = xml.split('<item>').slice(1);
  return items.map(it => {
    const title = (it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim();
    const link  = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim();
    return { source: 'hackernews', title, summary: title, url: link };
  }).filter(x => x.title);
}

// Cache with configurable TTL
let cache = { items: [], at: 0 };
let fetchInProgress = null; // dedup concurrent fetches

export async function getFeed() {
  const now = Date.now();
  if (cache.items.length && now - cache.at < FEED_CACHE_TTL_MS) return cache.items;

  // Dedup: if a fetch is already in progress, wait for it
  if (fetchInProgress) return fetchInProgress;

  fetchInProgress = (async () => {
    const [ax, rd, hn] = await Promise.allSettled([fetchArxiv(), fetchReddit(), fetchHackerNews()]);
    const items = [
      ...(ax.status === 'fulfilled' ? ax.value : []),
      ...(rd.status === 'fulfilled' ? rd.value : []),
      ...(hn.status === 'fulfilled' ? hn.value : [])
    ];
    cache = { items, at: Date.now() };
    log('info', 'feed', `Fetched ${items.length} items (arxiv:${ax.status === 'fulfilled' ? ax.value.length : 0} reddit:${rd.status === 'fulfilled' ? rd.value.length : 0} hn:${hn.status === 'fulfilled' ? hn.value.length : 0})`);
    fetchInProgress = null;
    return items;
  })();

  return fetchInProgress;
}

export function matchFeedToProfessor(prof, items) {
  const hay = [
    ...(prof.expertise || []),
    ...(prof.subfields || []),
    prof.title || '',
    prof.university || ''
  ].join(' ').toLowerCase();
  const scored = [];
  for (const it of items) {
    const text = `${it.title} ${it.summary}`.toLowerCase();
    let score = 0;
    for (const e of (prof.expertise || [])) {
      const token = e.toLowerCase().split(' ')[0];
      if (text.includes(token)) score += 2;
    }
    for (const s of (prof.subfields || [])) {
      if (text.includes(s.toLowerCase())) score += 1;
    }
    if (score > 0) scored.push({ score, item: it });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.item);
}
