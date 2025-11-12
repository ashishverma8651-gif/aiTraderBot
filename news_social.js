// news_social.js
// News & Social fetcher + lightweight sentiment scorer
// ES module. Usage: import { fetchNews } from "./news_social.js";

import axios from "axios";

/**
 * Configurable list of RSS / social endpoints.
 * You can change/add sources or pass overrides to fetchNews.
 */
const DEFAULT_RSS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  // optional mainstream business / crypto feeds:
  "https://news.bitcoin.com/feed/",
];

const DEFAULT_SUBREDDIT = "Bitcoin";
const DEFAULT_NITTER = "https://nitter.net"; // can replace with another public instance if needed

// Simple proxy fallbacks for RSS/HTML fetches (free proxies; may be slower)
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// Basic sentiment lexicon (small, extendable)
const POS_WORDS = new Set([
  "bull", "bullish", "gain", "rally", "surge", "rise", "up", "positive", "beat", "beats", "soar", "record"
]);
const NEG_WORDS = new Set([
  "bear", "bearish", "drop", "decline", "plunge", "crash", "down", "negative", "miss", "misses", "selloff", "slump"
]);
const STRONG_WORDS = new Set([
  "bankrupt", "hack", "exploit", "fraud", "arrest", "criminal", "bubble", "collapse"
]);

// ----- Utilities -----
function nowISO() { return new Date().toISOString(); }

async function safeGetText(url, timeout = 10000) {
  // try direct first
  try {
    const r = await axios.get(url, { timeout, responseType: "text", headers: { "User-Agent": "AI-Trader-Bot/1.0" } });
    if (r.status === 200 && r.data) return r.data;
  } catch (e) {}
  // try proxies
  for (const p of PROXIES) {
    try {
      const proxyUrl = p + encodeURIComponent(url);
      const r = await axios.get(proxyUrl, { timeout, responseType: "text", headers: { "User-Agent": "AI-Trader-Bot/1.0" } });
      if (r.status === 200 && r.data) return r.data;
    } catch (e) {}
  }
  throw new Error("fetch failed: " + url);
}

async function safeGetJson(url, timeout = 10000) {
  try {
    const r = await axios.get(url, { timeout, headers: { "User-Agent": "AI-Trader-Bot/1.0", Accept: "application/json" } });
    if (r.status === 200) return r.data;
  } catch (e) {}
  throw new Error("json fetch failed: " + url);
}

// ----- Parsers -----
function parseRSSItems(xmlText, max = 6) {
  const items = [];
  if (!xmlText) return items;
  // very light XML scraping: split on <item> or <entry> (Atom)
  const chunks = (xmlText.split(/<item>|<entry>/i) || []).slice(1);
  for (const c of chunks) {
    if (items.length >= max) break;
    const titleMatch = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = c.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const guidMatch = c.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const descMatch = c.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || c.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
    const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null;
    const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : (guidMatch ? guidMatch[1].trim() : null);
    const desc = descMatch ? descMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    if (title) items.push({ title, link, desc });
  }
  return items.slice(0, max);
}

function parseRedditListing(json, max = 8) {
  try {
    const children = json?.data?.children || [];
    return children.slice(0, max).map(c => ({
      title: c.data.title || "",
      ups: c.data.ups || 0,
      link: "https://reddit.com" + (c.data.permalink || ""),
      created_utc: c.data.created_utc || 0
    }));
  } catch (e) { return []; }
}

function parseNitterHtml(html, max = 8) {
  // best-effort: find tweet text blocks
  if (!html) return [];
  const out = [];
  // tweets often inside <div class="tweet-content"> ... </div>
  const re = /class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    let txt = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (txt) out.push({ text: txt });
  }
  return out;
}

// ----- Sentiment (very small & fast) -----
function scoreTextSentiment(text) {
  if (!text || !text.length) return { score: 0, polarity: "Neutral", details: {} };
  const s = text.toLowerCase();
  let score = 0;
  const words = s.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (POS_WORDS.has(w)) score += 1;
    if (NEG_WORDS.has(w)) score -= 1;
    if (STRONG_WORDS.has(w)) score -= 3;
  }
  // amplify when exclamation or "surge", reduce if question-y
  if (/[!]+/.test(text)) score += 0.5;
  // simple normalization
  const norm = Math.max(-10, Math.min(10, score));
  const pct = Math.round((norm / 10) * 100); // -100..100
  const polarity = pct > 15 ? "Positive" : pct < -15 ? "Negative" : "Neutral";
  return { score: pct, polarity, details: { rawScore: score } };
}

// ----- Public fetch functions -----
/**
 * fetchHeadlines(rssList, limit)
 * returns array of { title, link, desc, sentiment }
 */
export async function fetchHeadlines(rssList = DEFAULT_RSS, limit = 6) {
  const out = [];
  for (const url of rssList) {
    try {
      const text = await safeGetText(url);
      const items = parseRSSItems(text, limit);
      for (const it of items) {
        const sent = scoreTextSentiment(it.title + " " + (it.desc || ""));
        out.push({ source: url, title: it.title, link: it.link, desc: it.desc, sentiment: sent });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    } catch (e) {
      // continue to next rss
      continue;
    }
  }
  return out.slice(0, limit);
}

/**
 * fetchReddit(subreddit, limit)
 * returns array of posts
 */
export async function fetchReddit(subreddit = DEFAULT_SUBREDDIT, limit = 8) {
  try {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limit}`;
    const json = await safeGetJson(url);
    return parseRedditListing(json, limit);
  } catch (e) {
    // fallback empty
    return [];
  }
}

/**
 * fetchTweetsNitter(query, instance, limit)
 * Uses Nitter public instance to scrape tweets. Query is simple string.
 */
export async function fetchTweetsNitter(query = "bitcoin", instance = DEFAULT_NITTER, limit = 6) {
  try {
    const q = `/search?f=tweets&q=${encodeURIComponent(query)}`;
    const url = instance.replace(/\/$/, "") + q;
    const html = await safeGetText(url);
    const tweets = parseNitterHtml(html, limit);
    return tweets;
  } catch (e) {
    return [];
  }
}

/**
 * aggregateNews(symbolOrTopic, opts)
 * High-level function that fetches news + reddit + tweets and scores impact
 * returns { impact: "Low|Moderate|High", score: -100..100, polarity, headlines, reddit, tweets, top }
 */
export async function fetchNews(symbolOrTopic = "BTC", opts = {}) {
  const topic = (symbolOrTopic || "BTC").replace(/\W+/g, " ").trim();
  const rssList = opts.rss || DEFAULT_RSS;
  const subreddit = opts.subreddit || DEFAULT_SUBREDDIT;
  const nitter = opts.nitter || DEFAULT_NITTER;

  // concurrently fetch
  const [headlines, reddit, tweets] = await Promise.allSettled([
    fetchHeadlines(rssList, opts.headlineLimit || 6),
    fetchReddit(subreddit, opts.redditLimit || 8),
    fetchTweetsNitter(topic, nitter, opts.tweetLimit || 6)
  ]);

  const H = headlines.status === "fulfilled" ? headlines.value : [];
  const R = reddit.status === "fulfilled" ? reddit.value : [];
  const T = tweets.status === "fulfilled" ? tweets.value : [];

  // score headlines
  let totalScore = 0;
  let count = 0;
  const scoredHeadlines = H.map(h => {
    const s = scoreTextSentiment(h.title + " " + (h.desc || ""));
    totalScore += s.score;
    count++;
    return { ...h, sentiment: s };
  });

  // score reddit titles
  const scoredReddit = R.map(r => {
    const s = scoreTextSentiment(r.title || "");
    totalScore += s.score * 0.6; // social slightly lower weight
    count += 0.6;
    return { ...r, sentiment: s };
  });

  // score tweets
  const scoredTweets = T.map(t => {
    const text = t.text || t.content || "";
    const s = scoreTextSentiment(text);
    totalScore += s.score * 0.7;
    count += 0.7;
    return { ...t, sentiment: s };
  });

  const avg = count ? Math.round(totalScore / count) : 0;
  const impact = Math.abs(avg) > 40 ? "High" : Math.abs(avg) > 15 ? "Moderate" : "Low";
  const polarity = avg > 10 ? "Positive" : avg < -10 ? "Negative" : "Neutral";

  // choose top item (headline > reddit > tweet)
  const top = (scoredHeadlines[0] || scoredReddit[0] || scoredTweets[0] || null);

  return {
    topic,
    fetchedAt: nowISO(),
    impact,
    score: avg,
    polarity,
    headlines: scoredHeadlines,
    reddit: scoredReddit,
    tweets: scoredTweets,
    top
  };
}

// default export
export default { fetchNews, fetchHeadlines, fetchReddit, fetchTweetsNitter };