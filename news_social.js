// ===========================
// 📰 news_social.js (Enhanced v2.5)
// Multi-source News + Social fetcher with Smart Sentiment + Concurrency
// ===========================
import axios from "axios";

const DEFAULT_RSS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://news.bitcoin.com/feed/",
];
const DEFAULT_SUBREDDIT = "CryptoCurrency";
const DEFAULT_NITTER = "https://nitter.net";

const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

// Word-level lexicons
const POS_WORDS = new Set(["bull", "bullish", "gain", "rally", "surge", "rise", "up", "positive", "beat", "soar", "record"]);
const NEG_WORDS = new Set(["bear", "bearish", "drop", "decline", "plunge", "crash", "down", "negative", "selloff", "slump", "loss"]);
const STRONG_NEG = new Set(["bankrupt", "hack", "exploit", "fraud", "ban", "arrest", "regulation", "bubble", "collapse"]);

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeGet(url, { timeout = 8000, asJson = false } = {}) {
  const headers = { "User-Agent": "AI-Trader-Bot/2.5", Accept: asJson ? "application/json" : "*/*" };
  for (const base of [""].concat(PROXIES)) {
    try {
      const res = await axios.get(base + encodeURIComponent(url), { timeout, headers, responseType: asJson ? "json" : "text" });
      return asJson ? res.data : res.data;
    } catch (_) { await sleep(200); continue; }
  }
  return null;
}

// ---- Light RSS parsing ----
function parseRSS(xml, limit = 6) {
  if (!xml) return [];
  const items = xml.split(/<item>|<entry>/i).slice(1).map(chunk => {
    const title = (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const desc = (chunk.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "").replace(/<[^>]+>/g, "").trim();
    const link = (chunk.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    return { title, desc, link };
  }).filter(i => i.title);
  return items.slice(0, limit);
}

// ---- Sentiment ----
function scoreSentiment(text) {
  if (!text) return { score: 0, polarity: "Neutral" };
  const t = text.toLowerCase();
  let score = 0;
  for (const w of POS_WORDS) if (t.includes(w)) score += 1;
  for (const w of NEG_WORDS) if (t.includes(w)) score -= 1;
  for (const w of STRONG_NEG) if (t.includes(w)) score -= 2.5;
  if (/moon|all-time high|record/.test(t)) score += 2;
  if (/hack|ban|arrest|crash/.test(t)) score -= 3;

  const bounded = Math.max(-10, Math.min(10, score));
  const pct = Math.round((bounded / 10) * 100);
  const polarity = pct > 15 ? "Positive" : pct < -15 ? "Negative" : "Neutral";
  return { score: pct, polarity };
}

// ---- Fetchers ----
async function fetchRSSNews(sources = DEFAULT_RSS, limit = 6) {
  const results = await Promise.allSettled(sources.map(s => safeGet(s)));
  return results.flatMap((r, i) => (r.value ? parseRSS(r.value, limit / sources.length).map(it => ({
    ...it, source: sources[i], sentiment: scoreSentiment(it.title + " " + it.desc)
  })) : []));
}

async function fetchReddit(subreddit = DEFAULT_SUBREDDIT, limit = 8) {
  const data = await safeGet(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`, { asJson: true });
  return (data?.data?.children || []).map(c => ({
    title: c.data.title,
    ups: c.data.ups,
    sentiment: scoreSentiment(c.data.title),
    link: "https://reddit.com" + c.data.permalink
  }));
}

async function fetchTweets(query = "bitcoin", nitter = DEFAULT_NITTER, limit = 6) {
  const html = await safeGet(`${nitter.replace(/\/$/, "")}/search?f=tweets&q=${encodeURIComponent(query)}`);
  if (!html) return [];
  const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  return matches.slice(0, limit).map(m => {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { text, sentiment: scoreSentiment(text) };
  });
}

// ---- Main Aggregator ----
export async function fetchNews(topic = "BTC") {
  const [rss, reddit, tweets] = await Promise.allSettled([
    fetchRSSNews(DEFAULT_RSS, 6),
    fetchReddit(DEFAULT_SUBREDDIT, 6),
    fetchTweets(topic)
  ]);

  const newsItems = rss.value || [];
  const redditItems = reddit.value || [];
  const tweetItems = tweets.value || [];

  const all = [...newsItems, ...redditItems, ...tweetItems];
  const avg = all.length ? Math.round(all.reduce((a, c) => a + c.sentiment.score, 0) / all.length) : 0;
  const polarity = avg > 15 ? "Positive" : avg < -15 ? "Negative" : "Neutral";
  const impact = Math.abs(avg) > 40 ? "High" : Math.abs(avg) > 15 ? "Moderate" : "Low";

  return {
    topic,
    fetchedAt: nowISO(),
    newsImpact: avg,
    polarity,
    impact,
    totalItems: all.length,
    top: all[0] || null,
    items: all
  };
}

export default { fetchNews };