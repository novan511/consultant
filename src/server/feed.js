// Feed scanner — pulls items from arxiv + Reddit + RSS to feed the 24/7 loop.
// We use a polite, anonymous HTML/RSS fetch. No API keys required.
import { supabase } from './supabase.js';

const ARXIV = (q) => `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=10&sortBy=submittedDate&sortOrder=desc`;
const REDDIT = (sub) => `https://www.reddit.com/r/${sub}/top.json?limit=10`;
const HN     = `https://hnrss.org/frontpage?count=20`;

async function safeJson(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'ProfessorSenate/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function safeText(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'ProfessorSenate/1.0' } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

export async function fetchArxiv() {
  const xml = await safeText(ARXIV('AI OR science OR research'));
  if (!xml) return [];
  // very small XML parser
  const entries = xml.split('<entry>').slice(1);
  return entries.map(e => {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim();
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, ' ').trim();
    const link = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim();
    return { source: 'arxiv', title, summary, url: link };
  }).filter(x => x.title);
}

export async function fetchReddit() {
  const subs = ['science', 'technology', 'MachineLearning', 'Futurology', 'philosophy', 'economics'];
  const all = [];
  for (const s of subs) {
    const j = await safeJson(REDDIT(s));
    if (!j?.data?.children) continue;
    for (const c of j.data.children) {
      const d = c.data;
      all.push({
        source: `reddit/${s}`,
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

// Cache so we don't re-fetch constantly.
let cache = { items: [], at: 0 };
export async function getFeed() {
  const now = Date.now();
  if (cache.items.length && now - cache.at < 5 * 60 * 1000) return cache.items;
  const [ax, rd, hn] = await Promise.all([fetchArxiv(), fetchReddit(), fetchHackerNews()]);
  cache = { items: [...ax, ...rd, ...hn], at: now };
  return cache.items;
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
