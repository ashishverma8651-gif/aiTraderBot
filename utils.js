// FILE: utils.js  — Updated (proxy, caching, concurrency, sorting, stability)
// - Adds: proxy parsing for axios, caching with TTL per timeframe, concurrency limit for multi-TF,
//   improved SYMBOL mapping (NSE: prefix handling, FINNIFTY), candle sorting, and safer axios options.
// - Exports: fetchMarketData, fetchUniversal, fetchMultiTF
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// -----------------------------
// Basic constants & helpers
// -----------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 2);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 400);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -----------------------------
// Cache helpers (file-based, small TTL)
// -----------------------------
// cache format: { fetchedAt: <ms>, data: [...] }
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8") || "";
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj;
  } catch {
    return null;
  }
}
function writeCache(symbol, interval, data) {
  try {
    const p = cachePath(symbol, interval);
    const obj = { fetchedAt: Date.now(), data };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  } catch {}
}

// TTL per timeframe (ms) — tuneable
const CACHE_TTL = {
  "1m": 30 * 1000,   // 30s
  "5m": 60 * 1000,   // 60s
  "15m": 2 * 60 * 1000, // 2m
  "30m": 5 * 60 * 1000, // 5m
  "1h": 10 * 60 * 1000, // 10m
  "4h": 30 * 60 * 1000,
  "1d": 60 * 60 * 1000
};
function isCacheFresh(entry, interval) {
  if (!entry || !entry.fetchedAt) return false;
  const ttl = CACHE_TTL[interval] ?? CACHE_TTL["15m"];
  return Date.now() - entry.fetchedAt <= ttl;
}

// -----------------------------
// Timeframe map & symbol equivalents
// -----------------------------
const TF_MAP = {
  "1m":  { interval: "1m",   range: "1d" },
  "5m":  { interval: "5m",   range: "5d" },
  "15m": { interval: "15m",  range: "5d" },
  "30m": { interval: "30m",  range: "1mo" },
  "1h":  { interval: "60m",  range: "1mo" },
  "4h":  { interval: "240m", range: "3mo" },
  "1d":  { interval: "1d",   range: "6mo" }
};

const SYMBOL_EQUIV = {
  GOLD: "GC=F",
  XAUUSD: "GC=F",
  SILVER: "SI=F",
  XAGUSD: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY"
};

// -----------------------------
// Axios proxy support (basic parsing)
// -----------------------------
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      auth
    };
  } catch {
    return null;
  }
}
const PROXY_CFG = parseProxy(CONFIG.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null);

function axiosOptions(timeout = AXIOS_TIMEOUT) {
  const opts = { timeout };
  if (PROXY_CFG) {
    // axios proxy config
    opts.proxy = {
      host: PROXY_CFG.host,
      port: PROXY_CFG.port,
      protocol: PROXY_CFG.protocol
    };
    if (PROXY_CFG.auth) opts.proxy.auth = { username: PROXY_CFG.auth.username, password: PROXY_CFG.auth.password };
  }
  return opts;
}

// -----------------------------
// safeGet with mirrors, retries, and axios options
// -----------------------------
async function safeGet(url, mirrors = [], timeout = AXIOS_TIMEOUT) {
  // try primary URL with retries
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(url, axiosOptions(timeout));
      if (r?.data) return r.data;
    } catch (err) {
      // transient; wait and retry (do not throw)
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
    }
  }

  // try mirrors
  for (const mirror of mirrors || []) {
    if (!mirror) continue;
    let final = url;
    try {
      const u = new URL(url);
      final = mirror.replace(/\/+$/, "") + u.pathname + u.search;
    } catch { /* ignore; fallback to raw */ }

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const r = await axios.get(final, axiosOptions(timeout));
        if (r?.data) return r.data;
      } catch {
        if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      }
    }
  }

  return null;
}

// -----------------------------
// Binance kline normalize & sort
// -----------------------------
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw.map(k => ({
    t: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    vol: +k[5]
  }));
  out.sort((a, b) => a.t - b.t);
  return out;
}

// -----------------------------
// fetchCrypto (Binance v3 klines) with caching
// -----------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  try {
    const cacheKeyInterval = interval;
    const cacheEntry = readCache(symbol, cacheKeyInterval);
    if (isCacheFresh(cacheEntry, cacheKeyInterval)) {
      return cacheEntry.data;
    }

    // build URL (binance expects interval like "15m")
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
    const mirrors = CONFIG.DATA_SOURCES?.BINANCE || [];
    const raw = await safeGet(url, mirrors);
    if (!raw) return [];
    const normalized = normalizeKline(raw);
    writeCache(symbol, cacheKeyInterval, normalized);
    return normalized;
  } catch {
    return [];
  }
}

// -----------------------------
// Yahoo fetch (chart v8) — normalized + caching
// -----------------------------
async function fetchYahoo(symbol, interval = "15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    const cacheKeyInterval = interval;
    const cacheEntry = readCache(symbol, cacheKeyInterval);
    if (isCacheFresh(cacheEntry, cacheKeyInterval)) {
      // ensure copy
      return Array.isArray(cacheEntry.data) ? cacheEntry.data.slice() : [];
    }

    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart";
    const url = `${base}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;

    const res = await safeGet(url, CONFIG.DATA_SOURCES?.YAHOO?.slice(1) || []);
    const r = res?.chart?.result?.[0];
    if (!r) return [];

    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) continue;
      out.push({
        t: Number(ts[i]) * 1000,
        open: Number(q.open?.[i] ?? close),
        high: Number(q.high?.[i] ?? close),
        low: Number(q.low?.[i] ?? close),
        close: Number(close),
        vol: Number(q.volume?.[i] || 0)
      });
    }
    out.sort((a, b) => a.t - b.t);
    writeCache(symbol, cacheKeyInterval, out);
    return out;
  } catch {
    return [];
  }
}

// -----------------------------
// NSE fetch — handle mapped prefixes and fallbacks
// -----------------------------
async function fetchNSE(symbol, interval = "15m") {
  // allow mapped keys like "^NSEI" or "NSE:FINNIFTY"
  const mapped = SYMBOL_EQUIV[symbol] || symbol;
  // If mapped starts with "NSE:" remove prefix for Yahoo
  let toFetch = mapped;
  if (typeof toFetch === "string" && toFetch.startsWith("NSE:")) {
    toFetch = toFetch.replace(/^NSE:/, "");
  }
  // Yahoo supports many index tickers (some need caret ^)
  if (typeof toFetch === "string" && toFetch.startsWith("^")) {
    const r = await fetchYahoo(toFetch, interval);
    if (r.length) return r;
  } else {
    // try plain symbol on Yahoo
    const r = await fetchYahoo(toFetch, interval);
    if (r.length) return r;
    // final fallback: try symbol as-is
    const rr = await fetchYahoo(symbol, interval);
    if (rr.length) return rr;
  }
  return [];
}

// -----------------------------
// fetchMarketData (Crypto only wrapper) — returns {data, price, updated}
// -----------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  try {
    const data = await fetchCrypto(symbol, interval, limit);
    const last = data.length ? data[data.length - 1] : null;
    return {
      data,
      price: last ? Number(last.close) : 0,
      updated: new Date().toISOString()
    };
  } catch {
    return { data: [], price: 0, updated: new Date().toISOString() };
  }
}

// -----------------------------
// fetchUniversal — main router, improved mapping & stability
// -----------------------------
export async function fetchUniversal(symbolInput, interval = "15m") {
  try {
    if (!symbolInput) return { data: [], price: 0 };
    let symbol = String(symbolInput).toUpperCase();

    // map if present
    let mapped = SYMBOL_EQUIV[symbol] || null;

    // normalize mapped strings for Yahoo
    if (mapped && mapped.startsWith("NSE:")) {
      mapped = mapped.replace(/^NSE:/, "");
    }

    // Check if symbol is one of the INDIA index names directly (case-insensitive)
    const indiaIndexes = (CONFIG.MARKETS?.INDIA?.INDEXES || []).map(s => String(s).toUpperCase());
    const isIndiaIndex = indiaIndexes.includes(symbol);

    const CRYPTO_SUFFIX = ["USDT", "BTC"];
    const isCrypto = CRYPTO_SUFFIX.some(sfx => symbol.endsWith(sfx)) && !isIndiaIndex && (!mapped || !mapped.startsWith("^"));

    if (isCrypto) {
      const x = await fetchMarketData(symbol, interval);
      return { data: x.data, price: x.price };
    }

    if (isIndiaIndex) {
      const d = await fetchNSE(symbol, interval);
      return { data: d, price: d.length ? Number(d[d.length - 1].close) : 0 };
    }

    // Yahoo path: try mapped first, then symbol
    const yahooTarget = mapped || symbol;
    const y1 = await fetchYahoo(yahooTarget, interval);
    if (y1.length) return { data: y1, price: Number(y1[y1.length - 1].close) };

    const y2 = await fetchYahoo(symbol, interval);
    if (y2.length) return { data: y2, price: Number(y2[y2.length - 1].close) };

    return { data: [], price: 0 };
  } catch {
    return { data: [], price: 0 };
  }
}

// -----------------------------
// Simple concurrency limiter (p-limit style)
// -----------------------------
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (queue.length === 0 || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn()).then((v) => {
      active--;
      resolve(v);
      next();
    }).catch((err) => {
      active--;
      reject(err);
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// -----------------------------
// fetchMultiTF — concurrency-limited multi-timeframe fetcher
// -----------------------------
export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  const limit = pLimit(2); // at most 2 concurrent requests
  // launch limited promises
  const tasks = tfs.map((tf) => limit(async () => {
    // small jitter delay to reduce burst
    await sleep(50 + Math.floor(Math.random() * 100));
    const res = await fetchUniversal(symbol, tf);
    out[tf] = res;
  }));
  await Promise.all(tasks);
  return out;
}

