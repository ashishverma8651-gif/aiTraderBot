// ===========================
// 📰 news_social.js (AI-Trader News Engine v3.0)
// Multi-source News + Social fetcher + Smart Weighted Sentiment
// Output format is 100% compatible with tg_commands.js
// ===========================

import axios from "axios";

// -------------------------------------
// SOURCES
// -------------------------------------
const DEFAULT_RSS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://news.bitcoin.com/feed/"
];
const DEFAULT_SUBREDDIT = "CryptoCurrency";
const DEFAULT_NITTER = "https://nitter.net";

const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// -------------------------------------
// SENTIMENT lexicons
// -------------------------------------
const POS = ["bull", "bullish", "rally", "gain", "surge", "soar", "pump", "up", "record"];
const NEG = ["bear", "bearish", "drop", "crash", "selloff", "plunge", "down", "fear", "loss"];
const STRONG_NEG = ["bankrupt", "hack", "ban", "fraud", "exploit", "arrest", "collapse"];

// -------------------------------------
// SAFE HTTP GET
// -------------------------------------
async function safeGet(url, { timeout = 8000, asJson = false } = {}) {
  const headers = { "User-Agent": "AI-Trader/3.0", Accept: asJson ? "application/json" : "*/*" };

  for (const base of [""].concat(PROXIES)) {
    try {
      const res = await axios.get(base + encodeURIComponent(url), {
        timeout,
        headers,
        responseType: asJson ? "json" : "text"
      });
      return res.data;
    } catch (_) {
      await sleep(150);
      continue;
    }
  }
  return null;
}

// -------------------------------------
// RSS PARSER
// -------------------------------------
function parseRSS(xml, limit = 6) {
  if (!xml) return [];
  const chunks = xml.split(/<item>|<entry>/i).slice(1);
  return chunks.slice(0, limit).map(chunk => ({
    title: (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
    desc: (chunk.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || "")
      .replace(/<[^>]+>/g, "").trim(),
    link: (chunk.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").trim()
  }));
}

// -------------------------------------
// SENTIMENT SCORE (-10 to +10 → normalized 0-1)
// -------------------------------------
function analyzeSentiment(text) {
  if (!text) return { score: 0, prob: 0.5, label: "Neutral" };

  const t = text.toLowerCase();
  let s = 0;

  POS.forEach(w => { if (t.includes(w)) s += 1; });
  NEG.forEach(w => { if (t.includes(w)) s -= 1; });
  STRONG_NEG.forEach(w => { if (t.includes(w)) s -= 2.5; });

  if (/all-time high|ath|moon/.test(t)) s += 2;
  if (/ban|hack|crash|arrest/.test(t)) s -= 3;

  const bounded = Math.max(-10, Math.min(10, s));         // clamp
  const prob = (bounded + 10) / 20;                       // convert to 0–1
  const label = prob > 0.6 ? "Positive" : prob < 0.4 ? "Negative" : "Neutral";

  return { score: bounded, prob, label };
}

// -------------------------------------
// SOURCE FETCHERS
// -------------------------------------
async function fetchRSSNews() {
  const res = await Promise.allSettled(DEFAULT_RSS.map(r => safeGet(r)));
  return res.flatMap((r, i) =>
    !r.value ? [] :
      parseRSS(r.value).map(it => ({
        ...it,
        source: DEFAULT_RSS[i],
        sentiment: analyzeSentiment(it.title + " " + it.desc)
      }))
  );
}

async function fetchReddit() {
  const data = await safeGet(`https://www.reddit.com/r/${DEFAULT_SUBREDDIT}/hot.json?limit=8`, { asJson: true });
  return (data?.data?.children || []).map(c => ({
    title: c.data.title,
    ups: c.data.ups,
    link: "https://reddit.com" + c.data.permalink,
    sentiment: analyzeSentiment(c.data.title)
  }));
}

async function fetchTweets(topic = "bitcoin") {
  const html = await safeGet(`${DEFAULT_NITTER}/search?f=tweets&q=${encodeURIComponent(topic)}`);
  if (!html) return [];
  const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  return matches.slice(0, 6).map(m => {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { text, sentiment: analyzeSentiment(text) };
  });
}

// -------------------------------------
// MAIN AGGREGATOR (Unified Output)
// -------------------------------------
export async function fetchNewsBundle(symbol = "BTCUSDT") {
  try {
    const topic = symbol.replace("USDT", "").replace("USD", "").toLowerCase();

    const [rss, reddit, tweets] = await Promise.allSettled([
      fetchRSSNews(),
      fetchReddit(),
      fetchTweets(topic)
    ]);

    const items = [
      ...(rss.value || []),
      ...(reddit.value || []),
      ...(tweets.value || [])
    ];

    if (!items.length) {
      return { ok: false, sentiment: 0.5, impact: "Low", items: [] };
    }

    // Weighted sentiment
    const avg =
      items.reduce((a, c) => a + (c.sentiment?.prob ?? 0.5), 0) / items.length;

    const sentiment = Number(avg.toFixed(3));        // 0–1
    const impact =
      sentiment > 0.65 || sentiment < 0.35 ? "High"
        : sentiment > 0.55 || sentiment < 0.45 ? "Moderate"
          : "Low";

    return {
      ok: true,
      symbol,
      sentiment,   // 0–1
      impact,      // Low / Moderate / High
      items,       // array (rss + reddit + tweets)
      fetchedAt: nowISO()
    };

  } catch (e) {
    return { ok: false, error: e.message, sentiment: 0.5, impact: "Low", items: [] };
  }
}

export default { fetchNewsBundle };