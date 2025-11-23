// FILE: news_social.js (v4.0) — Multi-market News + Social Engine (drop-in replacement)
// Exports: fetchNewsBundle(symbol, opts = {})  (default export included at bottom)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js"; // re-use config for cache path / proxies if set

// ---------------------------
// Basic config & helpers
// ---------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];
const USER_AGENT = "AI-Trader-News/4.0";

const DEFAULT_LIMIT = 6;
const DEFAULT_TIMEOUT = Number(process.env.NS_TIMEOUT_MS || 8000);
const RETRY_ATTEMPTS = Number(process.env.NS_RETRY || 2);

const nowISO = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeNum = v => Number.isFinite(+v) ? +v : 0;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// ---------------------------
// Source lists (multi-source & reliable picks)
// Chosen options: India A, Stocks A, Forex/Commodity A
// ---------------------------

// CRYPTO sources (fast & reliable)
const CRYPTO_RSS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://news.bitcoin.com/feed/",
  "https://decrypt.co/feed"
];
const CRYPTO_SUBREDDITS = ["CryptoCurrency", "Bitcoin", "ethtrader"];
const CRYPTO_NITTER = "https://nitter.net"; // used for lightweight HTML scrape

// STOCKS sources (Google News + Yahoo + Reuters + MarketWatch)
const STOCKS_RSS = [
  "https://news.google.com/rss/search?q=", // + encodeURIComponent("<ticker> stock")
  "https://finance.yahoo.com/rss/headline?s=", // + symbol (e.g., AAPL)
  "https://www.reuters.com/rssFeed/wealth",
  "https://www.marketwatch.com/rss" // not perfect but adds coverage
];
const STOCKS_SUBREDDITS = ["stocks", "investing"];

// FOREX & COMMODITIES sources
const FOREX_RSS = [
  "https://www.fxstreet.com/rss",
  "https://www.investing.com/rss/news.rss",
  "https://www.reuters.com/finance/markets/foreign-exchange" // fallback
];
const COMMODITY_RSS = [
  "https://oilprice.com/rss/main.xml",
  "https://www.kitco.com/rss/index.xml",
  "https://www.reuters.com/markets/commodities"
];
const FX_SUBREDDITS = ["Forex", "gold"]; // generic

// INDIA (NSE/BSE) sources — Option A (recommended)
const INDIA_RSS = [
  "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "https://www.moneycontrol.com/rss/MC-TopStories.xml",
  "https://www.business-standard.com/rss/markets-xml.xml",
  "https://www.livemint.com/rss/market"
];
const INDIA_SUBREDDITS = ["IndianStockMarket", "investing"];

// INDEX / GLOBAL
const INDEX_RSS = [
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://www.reuters.com/markets/us"
];

// Universal fallback RSS (crypto + markets)
const GENERAL_RSS = [
  "https://news.google.com/rss/search?q=" // plus query
];

// ---------------------------
// Proxies: use CONFIG.PROXY if set else built-in PROXIES
// ---------------------------
const EXTERNAL_PROXIES = (CONFIG.PROXY ? [CONFIG.PROXY] : []).concat(PROXIES);

// ---------------------------
// Caching helpers (file-based)
// ---------------------------
function cachePath(symbol) {
  return path.join(CACHE_DIR, `news_${symbol.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}
function readCache(symbol) {
  try {
    const p = cachePath(symbol);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8") || null);
  } catch { return null; }
}
function writeCache(symbol, payload) {
  try {
    fs.writeFileSync(cachePath(symbol), JSON.stringify({ ts: Date.now(), payload }, null, 2));
  } catch {}
}

// ---------------------------
// Market detection helper
// ---------------------------
function detectMarket(symbol = "") {
  if (!symbol) return "GENERAL";
  const s = String(symbol).toUpperCase();
  // India indexes
  const indiaIdx = (CONFIG.MARKETS?.INDIA?.INDEXES || []).map(x => String(x).toUpperCase());
  if (indiaIdx.includes(s) || /NIFTY|BANKNIFTY|SENSEX|FINNIFTY/.test(s)) return "INDIA";
  // Crypto heuristic: ends with USDT / USD / BTC and has letters
  if (/(USDT|USD|BTC|ETH)$/.test(s) || s.length > 3 && /[A-Z]{3,6}(USDT|USD|BTC)?$/.test(s)) {
    // Common tickers like AAPL, MSFT could be mistaken; disambiguate: contains digits? indices usually contain digits (NIFTY50)
    if (/[0-9]/.test(s)) {
      // index/other; fallback to INDEX
      return "INDEX";
    }
    // treat as CRYPTO if symbol contains USDT or ends with USD or is known exchange pair pattern
    if (/(USDT|USD|BTC|ETH)$/.test(s)) return "CRYPTO";
  }
  // Commodities common tickers mapping (allow GC=F etc.)
  if (/^(GC=F|CL=F|NG=F|SI=F|XAU|XAG|OIL|GOLD|SILVER)$/.test(s)) return "COMMODITY";
  // Forex pairs like EURUSD, GBPUSD
  if (/^[A-Z]{6}$/.test(s) && (s.endsWith("USD") || s.startsWith("USD") || s.includes("JPY"))) return "FOREX";
  // Stocks (default for 1-5 chars uppercase)
  if (/^[A-Z]{1,5}$/.test(s)) return "STOCK";
  // Index names
  if (/^(SP|DJI|NDX|S&P|NIFTY|BANKNIFTY|SENSEX)/.test(s)) return "INDEX";
  return "GENERAL";
}

// ---------------------------
// safeGet: attempts direct request, then proxies
// - returns text or JSON depending on responseType
// ---------------------------
async function safeGet(rawUrl, { timeout = DEFAULT_TIMEOUT, responseType = "text", tryProxies = true } = {}) {
  const headers = { "User-Agent": USER_AGENT, Accept: responseType === "json" ? "application/json" : "*/*" };

  // Try direct
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(rawUrl, { timeout, headers, responseType });
      return r.data;
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(120 + Math.random() * 120);
    }
  }

  if (tryProxies) {
    for (const proxyBase of EXTERNAL_PROXIES) {
      try {
        // Many proxies want full URL encoded
        const proxied = proxyBase + encodeURIComponent(rawUrl);
        for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
          try {
            const r = await axios.get(proxied, { timeout, headers, responseType });
            return r.data;
          } catch (err) {
            if (attempt < RETRY_ATTEMPTS - 1) await sleep(120 + Math.random() * 150);
          }
        }
      } catch {}
    }
  }
  return null;
}

// ---------------------------
// Lightweight RSS/HTML parser (robust for common feeds)
// returns array of { title, desc, link, pubDate }
// ---------------------------
function parseRSS(xml, limit = DEFAULT_LIMIT) {
  if (!xml || typeof xml !== "string") return [];
  // unify: try common <item> and <entry>
  const items = xml.split(/<item\b|<entry\b/i).slice(1).slice(0, limit);
  const out = items.map(chunk => {
    const title = (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = (chunk.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").trim() ||
                 (chunk.match(/href=['"]([^'"]+)['"]/i)?.[1] || "").trim();
    const desc = (chunk.match(/<(?:description|summary)[^>]*>([\s\S]*?)<\/(?:description|summary)>/i)?.[1] || "")
      .replace(/<[^>]+>/g, " ").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const pub = (chunk.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || (chunk.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] || "")).trim();
    return { title: title || desc.slice(0, 80), desc: desc || "", link: link || "", pubDate: pub || "" };
  }).filter(Boolean);
  return out;
}

// ---------------------------
// Tweet/Nitter quick parse — returns text snippets (no auth)
// ---------------------------
function parseNitterHtml(html, limit = 6) {
  if (!html) return [];
  const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)];
  return matches.slice(0, limit).map(m => {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { title: text.slice(0, 120), desc: text, link: "" };
  });
}

// ---------------------------
// Reddit JSON parse
// ---------------------------
function parseRedditJson(json, limit = 6) {
  if (!json || !json.data || !Array.isArray(json.data.children)) return [];
  return json.data.children.slice(0, limit).map(c => {
    const d = c.data || {};
    return {
      title: d.title || "",
      desc: d.selftext ? d.selftext.slice(0, 300) : "",
      link: `https://reddit.com${d.permalink || ""}`,
      pubDate: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : ""
    };
  });
}

// ---------------------------
// Sentiment lexicons (base + market-specific)
 // score range: -10 .. +10  → normalized to prob 0..1
// ---------------------------
const BASE_POS = ["bull", "bullish", "rally", "gain", "surge", "pump", "moon", "soar", "record", "beat", "beat expectations", "upgrade"];
const BASE_NEG = ["bear", "bearish", "drop", "crash", "selloff", "plunge", "down", "fear", "loss", "downgrade"];
const BASE_STRONG_NEG = ["bankrupt", "hack", "ban", "fraud", "exploit", "arrest", "collapse", "lawsuit", "scandal"];

// Market-specific boosters/terms
const MARKET_TERMS = {
  CRYPTO: {
    pos: ["halving", "layer2", "ethereum merge", "onchain", "whale buy"],
    neg: ["rug pull", "exchange hack", "smart contract exploit"]
  },
  STOCK: {
    pos: ["beat", "beats", "earnings", "upgrade", "dividend", "buyback"],
    neg: ["miss", "missed", "downgrade", "layoff", "restructure", "profit warning"]
  },
  FOREX: {
    pos: ["rate cut", "dovish", "weaker dollar", "economic data beat"],
    neg: ["rate hike", "hawkish", "strong dollar", "inflation"]
  },
  COMMODITY: {
    pos: ["supply tight", "drawdown", "inventory drop"],
    neg: ["oversupply", "inventory build", "weak demand"]
  },
  INDIA: {
    pos: ["rbi", "govt stimulus", "policy support", "rbi repo cut", "capex"],
    neg: ["rbi hike", "inflation", "demonetization", "scam"]
  }
};

// ---------------------------
// Market-aware sentiment analyzer
// returns { score, prob (0..1), label }
// ---------------------------
function analyzeSentiment(text = "", market = "GENERAL") {
  if (!text || typeof text !== "string") return { score: 0, prob: 0.5, label: "Neutral" };
  const t = text.toLowerCase();

  let s = 0;
  // base lists
  BASE_POS.forEach(w => { if (t.includes(w)) s += 1; });
  BASE_NEG.forEach(w => { if (t.includes(w)) s -= 1; });
  BASE_STRONG_NEG.forEach(w => { if (t.includes(w)) s -= 2.5; });

  // market-specific
  const ms = MARKET_TERMS[market];
  if (ms) {
    (ms.pos || []).forEach(w => { if (t.includes(w)) s += 1.1; });
    (ms.neg || []).forEach(w => { if (t.includes(w)) s -= 1.1; });
  }

  // numeric boosters
  if (/\ball[- ]?time high|ath\b/.test(t)) s += 2;
  if (/\bearnings|quarterly results|q[1-4]/.test(t)) s += 0.8;
  if (/\bhack|exploit|fraud|bankrupt|arrest\b/.test(t)) s -= 3;

  // sentiment bound & normalization
  const bounded = clamp(Math.round(s * 10) / 10, -10, 10); // keep one decimal
  const prob = Number(((bounded + 10) / 20).toFixed(3)); // map -10..10 to 0..1
  const label = prob > 0.6 ? "Positive" : prob < 0.4 ? "Negative" : "Neutral";
  return { score: bounded, prob, label };
}

// ---------------------------
// Source fetchers (market-specific aggregator functions)
// Each returns array of items { title, desc, link, pubDate, source, weight, sentiment }
// weight = source reliability weight (0..1)
// ---------------------------

async function fetchRssList(list, query = "", limit = DEFAULT_LIMIT, market = "GENERAL") {
  const out = [];
  for (const src of list) {
    try {
      let url = src;
      // allow templates (like Google News search)
      if (src.endsWith("rss?q=") || src.endsWith("rss/search?q=") || src.includes("news.google.com/rss")) {
        // google news style
        url = src + encodeURIComponent(query);
      } else if (src.endsWith("s=")) {
        // yahoo finance style
        url = src + encodeURIComponent(query);
      }
      const xml = await safeGet(url, { timeout: DEFAULT_TIMEOUT });
      const parsed = parseRSS(xml, limit);
      parsed.forEach(it => {
        const text = (it.title || "") + " " + (it.desc || "");
        const sentiment = analyzeSentiment(text, market);
        out.push({ ...it, source: src, weight: 0.85, sentiment });
      });
      // small delay to avoid bursting
      await sleep(80 + Math.random()*100);
    } catch (err) {
      // ignore source failure
    }
  }
  return out;
}

async function fetchSubredditList(subreddits = [], limit = DEFAULT_LIMIT, market = "GENERAL") {
  const out = [];
  for (const s of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${s}/hot.json?limit=${limit}`;
      const json = await safeGet(url, { timeout: 7000, responseType: "json" });
      const parsed = parseRedditJson(json, limit);
      parsed.forEach(it => {
        const sentiment = analyzeSentiment(it.title + " " + it.desc, market);
        out.push({ ...it, source: `reddit/${s}`, weight: 0.75, sentiment });
      });
      await sleep(60 + Math.random()*80);
    } catch {}
  }
  return out;
}

async function fetchNitterSearch(topic = "", limit = DEFAULT_LIMIT, market = "GENERAL") {
  const url = `${CRYPTO_NITTER}/search?f=tweets&q=${encodeURIComponent(topic)}`;
  try {
    const html = await safeGet(url, { timeout: 7000 });
    const parsed = parseNitterHtml(html, limit);
    return parsed.map(it => ({ ...it, source: `nitter/search:${topic}`, weight: 0.6, sentiment: analyzeSentiment(it.desc, market) }));
  } catch {
    return [];
  }
}

// Generic quick fetch for any text page (fallback)
async function fetchGenericText(url) {
  try {
    const text = await safeGet(url, { timeout: 7000 });
    if (!text) return null;
    // strip html to brief text
    const brief = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600);
    return brief;
  } catch { return null; }
}

// ---------------------------
// Unified fetch per market
// ---------------------------
async function fetchForMarket(symbol, market, opts) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const q = (symbol || "").replace(/USDT|USD|BTC|ETH/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  const items = [];

  // choose sources & subreddits per market
  if (market === "CRYPTO") {
    const rss = await fetchRssList(CRYPTO_RSS, q || symbol, limit, market);
    const reddit = await fetchSubredditList(CRYPTO_SUBREDDITS, limit, market);
    const tweets = await fetchNitterSearch(q || symbol, limit, market);
    items.push(...rss, ...reddit, ...tweets);
  } else if (market === "STOCK") {
    const rss = await fetchRssList(STOCKS_RSS, q || symbol, limit, market);
    const reddit = await fetchSubredditList(STOCKS_SUBREDDITS, limit, market);
    items.push(...rss, ...reddit);
  } else if (market === "FOREX") {
    const rss = await fetchRssList(FOREX_RSS, q || symbol, limit, market);
    const reddit = await fetchSubredditList(FX_SUBREDDITS, limit, market);
    items.push(...rss, ...reddit);
  } else if (market === "COMMODITY") {
    const rss = await fetchRssList(COMMODITY_RSS, q || symbol, limit, market);
    items.push(...rss);
  } else if (market === "INDIA") {
    const rss = await fetchRssList(INDIA_RSS, q || symbol, limit, market);
    const reddit = await fetchSubredditList(INDIA_SUBREDDITS, limit, market);
    items.push(...rss, ...reddit);
  } else if (market === "INDEX") {
    const rss = await fetchRssList(INDEX_RSS, q || symbol, limit, market);
    items.push(...rss);
  } else {
    // GENERAL: google news + crypto as fallback
    const rss = await fetchRssList(GENERAL_RSS, q || symbol, limit, market);
    const crypto = await fetchRssList(CRYPTO_RSS, q || symbol, limit, market);
    items.push(...rss, ...crypto);
  }

  return items;
}

// ---------------------------
// Aggregation & weighted sentiment
// ---------------------------
function aggregateItems(items, opts = {}) {
  // Normalize items
  const normalized = items.map(it => {
    const title = (it.title || "").trim();
    const desc = (it.desc || "").trim();
    const link = (it.link || "").trim();
    const pubDate = it.pubDate || it.pubdate || "";
    const source = it.source || "unknown";
    const weight = clamp(safeNum(it.weight) || 0.6, 0.2, 1);
    const sentiment = it.sentiment || analyzeSentiment(title + " " + desc, opts.market || "GENERAL");
    return { title, desc, link, pubDate, source, weight, sentiment };
  });

  if (!normalized.length) return { items: [], sentiment: 0.5, impact: "Low" };

  // Weighted average of sentiment.prob
  let wsum = 0, total = 0;
  for (const n of normalized) {
    const w = n.weight;
    const p = clamp(n.sentiment?.prob ?? 0.5, 0, 1);
    wsum += w * p;
    total += w;
  }
  const avg = total ? wsum / total : 0.5;

  const sentiment = Number(avg.toFixed(3));
  const impact = sentiment > 0.65 || sentiment < 0.35 ? "High"
    : sentiment > 0.55 || sentiment < 0.45 ? "Moderate" : "Low";

  return { items: normalized.slice(0, opts.limit || DEFAULT_LIMIT * 3), sentiment, impact };
}

// ---------------------------
// Main Exported Function
// ---------------------------
export async function fetchNewsBundle(symbol = "BTCUSDT", opts = {}) {
  try {
    if (!symbol) return { ok: false, error: "symbol_required" };
    symbol = String(symbol).trim();
    const market = detectMarket(symbol);
    const cacheEntry = readCache(symbol);
    const cacheTTL = opts.cacheTTL ?? 60 * 1000; // 1 minute default
    const force = !!opts.forceRefresh;

    if (!force && cacheEntry && (Date.now() - (cacheEntry.ts || 0) < cacheTTL) && !opts.debug) {
      // return cached payload (still include fetchedAt)
      return { ok: true, symbol, ...cacheEntry.payload, fetchedAt: nowISO(), cached: true };
    }

    // fetch per market concurrently but keep some throttling
    const items = await fetchForMarket(symbol, market, opts);

    // As fallback, if no items and not crypto, try general crypto/news sources
    if ((!items || items.length === 0) && market !== "CRYPTO") {
      const fallback = await fetchForMarket(symbol, "GENERAL", opts);
      items.push(...fallback);
    }

    const aggregated = aggregateItems(items, { market, limit: opts.limit });

    const payload = {
      ok: true,
      symbol,
      sentiment: aggregated.sentiment,
      impact: aggregated.impact,
      items: aggregated.items,
      fetchedAt: nowISO()
    };

    // write cache
    writeCache(symbol, payload);

    if (opts.debug) {
      payload.debug = {
        marketDetected: market,
        sourceCount: items.length,
        cacheTTL,
        ts: Date.now()
      };
    }

    return payload;
  } catch (err) {
    return { ok: false, error: err?.message || String(err), symbol, sentiment: 0.5, impact: "Low", items: [] };
  }
}

export default { fetchNewsBundle };