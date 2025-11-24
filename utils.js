// utils.js — Robust, multi-market, multi-source, cached fetcher
// Exports: fetchMarketData, fetchUniversal, fetchMultiTF, fetchPrice
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

/* ===========================
   Basic setup & constants
   =========================== */
const CACHE_DIR = (CONFIG && CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRIES = Number((CONFIG && CONFIG.FALLBACK && CONFIG.FALLBACK.MAX_RETRIES) || 3);
const RETRY_DELAY = Number((CONFIG && CONFIG.FALLBACK && CONFIG.FALLBACK.RETRY_DELAY_MS) || 500);

const GLOBAL_PROXY = CONFIG.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null;
const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

/* ===========================
   Helpers
   =========================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      protocol: (u.protocol || "").replace(":", ""),
      host: u.hostname,
      port: u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80),
      auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined
    };
  } catch {
    return null;
  }
}
const PARSED_PROXY = parseProxy(GLOBAL_PROXY);

function axiosOptions(timeout = DEFAULT_TIMEOUT) {
  const opts = { timeout, headers: {} };
  if (PARSED_PROXY) {
    opts.proxy = { host: PARSED_PROXY.host, port: PARSED_PROXY.port };
    if (PARSED_PROXY.auth) opts.proxy.auth = { username: PARSED_PROXY.auth.username, password: PARSED_PROXY.auth.password };
  }
  return opts;
}

function safeSymbol(raw) {
  const s = (raw ?? CONFIG.ACTIVE_SYMBOL ?? CONFIG.DEFAULT_BY_MARKET?.CRYPTO ?? "").toString().trim();
  return s ? s.toUpperCase() : "";
}

function cacheFileName(symbol, interval) {
  const s = (symbol || "").toString().toUpperCase().replace(/[^A-Z0-9_\-\.]/g, "_");
  const tf = String(interval || "15m").replace(/[^a-z0-9]/gi, "_");
  return path.join(CACHE_DIR, `${s}_${tf}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cacheFileName(symbol, interval);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // backward-compat: old format might be { fetchedAt, data } or { data }
    if (obj && obj.data) return obj.data;
    return obj;
  } catch {
    return null;
  }
}

function writeCache(symbol, interval, data) {
  try {
    const p = cacheFileName(symbol, interval);
    fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2));
  } catch (e) {
    /* ignore */
  }
}

function lastGoodPrice(symbol) {
  try {
    const s = (symbol || "").toString().toUpperCase();
    if (!s) return null;
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(s + "_")).sort((a, b) => {
      const A = fs.statSync(path.join(CACHE_DIR, a)).mtimeMs;
      const B = fs.statSync(path.join(CACHE_DIR, b)).mtimeMs;
      return B - A;
    });
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CACHE_DIR, f), "utf8");
        const obj = JSON.parse(raw || "{}");
        const arr = obj?.data || obj;
        if (Array.isArray(arr) && arr.length) {
          const last = arr.at(-1);
          if (last && Number.isFinite(+last.close)) return Number(last.close);
        }
      } catch {}
    }
  } catch {}
  return null;
}

/* ===========================
   SAFE GET (multi-source + retries + proxy fallback)
   Returns response.data or null
   =========================== */
async function safeGet(url, mirrors = [], timeout = DEFAULT_TIMEOUT, responseType = "json") {
  if (!url) return null;

  // try direct with retries
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await axios.get(url, { ...axiosOptions(timeout), responseType, headers: { "User-Agent": "AI-Trader/1.0" } });
      if (res && res.data !== undefined && res.data !== null) return res.data;
    } catch (e) { /* swallow */ }
    await sleep(RETRY_DELAY + Math.random() * 100);
  }

  // try mirrors using same path + search
  for (const base of (mirrors || [])) {
    if (!base) continue;
    try {
      const u = new URL(url);
      const candidate = base.replace(/\/+$/, "") + u.pathname + u.search;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const res = await axios.get(candidate, { ...axiosOptions(timeout), responseType, headers: { "User-Agent": "AI-Trader/1.0" } });
          if (res && res.data !== undefined && res.data !== null) return res.data;
        } catch (e) {}
        await sleep(RETRY_DELAY);
      }
    } catch {}
  }

  // try external simple proxy services
  for (const pbase of EXTERNAL_PROXY_SERVICES) {
    try {
      const prox = pbase + encodeURIComponent(url);
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const res = await axios.get(prox, { ...axiosOptions(timeout), responseType, headers: { "User-Agent": "AI-Trader/1.0" } });
          if (res && res.data !== undefined && res.data !== null) return res.data;
        } catch (e) {}
        await sleep(RETRY_DELAY);
      }
    } catch {}
  }

  return null;
}

/* ===========================
   Normalizers for common providers
   =========================== */
function normalizeKline(raw) {
  // Binance style: array of arrays
  if (!Array.isArray(raw)) return [];
  return raw
    .map(k => ({
      t: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      vol: Number(k[5])
    }))
    .filter(c => Number.isFinite(c.t) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .sort((a, b) => a.t - b.t);
}

function normalizeYahooChart(res) {
  try {
    if (!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];
    const vols = q.volume || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const close = closes[i];
      if (!Number.isFinite(close)) continue;
      out.push({
        t: Number(ts[i]) * 1000,
        open: Number(opens[i] ?? close),
        high: Number(highs[i] ?? close),
        low: Number(lows[i] ?? close),
        close: Number(close),
        vol: Number(vols[i] ?? 0)
      });
    }
    return out.sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/* ===========================
   MARKET-SPECIFIC FETCHERS
   - fetchCrypto (Binance)
   - fetchYahoo (Stocks/Forex)
   - fetchNSE (India)
   =========================== */

async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  symbol = safeSymbol(symbol);
  if (!symbol) return [];

  // try cache first
  const cache = readCache(symbol, interval);

  // primary base from config or default
  const bases = Array.isArray(CONFIG.DATA_SOURCES_BY_MARKET?.CRYPTO) && CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO.length ? CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO : ["https://data-api.binance.vision", "https://api.binance.com"];
  const pathQuery = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;

  // try each base
  for (const base of bases) {
    if (!base) continue;
    const url = base.replace(/\/+$/, "") + pathQuery;
    try {
      const raw = await safeGet(url, bases.slice(1));
      if (Array.isArray(raw) && raw.length) {
        const k = normalizeKline(raw);
        if (k.length) {
          writeCache(symbol, interval, k);
          return k;
        }
      }
    } catch {}
  }

  // fallback to cache
  if (cache && Array.isArray(cache) && cache.length) return cache;
  return [];
}

async function fetchYahoo(symbol, interval = "15m") {
  symbol = safeSymbol(symbol);
  if (!symbol) return [];

  const tfMap = {
    "1m": { interval: "1m", range: "1d" },
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "1mo" },
    "1h": { interval: "60m", range: "1mo" },
    "4h": { interval: "240m", range: "3mo" },
    "1d": { interval: "1d", range: "6mo" }
  };
  const tf = tfMap[interval] || tfMap["15m"];

  const base = (CONFIG.DATA_SOURCES_BY_MARKET?.US_STOCKS?.[0]) || (CONFIG.DATA_SOURCES_BY_MARKET?.FOREX?.[0]) || "https://query1.finance.yahoo.com/v8/finance/chart";
  const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;

  const cache = readCache(symbol, interval);
  try {
    const res = await safeGet(url, (CONFIG.DATA_SOURCES_BY_MARKET?.US_STOCKS || []).slice(1));
    const k = normalizeYahooChart(res);
    if (k.length) {
      writeCache(symbol, interval, k);
      return k;
    }
  } catch {}

  if (cache && Array.isArray(cache) && cache.length) return cache;
  return [];
}

async function fetchNSE(symbol, interval = "15m") {
  symbol = safeSymbol(symbol);
  if (!symbol) return [];

  // Try direct Yahoo forms for India-first mapping (NSE may block often)
  const tries = [
    symbol,
    symbol + ".NS",
    symbol.replace(/^NSE:/i, ""),
    `^${symbol}`
  ];

  for (const t of tries) {
    try {
      const k = await fetchYahoo(t, interval);
      if (k && k.length) return k;
    } catch {}
  }

  // If all fails, try NSE API basic page with headers (best-effort)
  const base = CONFIG.DATA_SOURCES_BY_MARKET?.INDIA?.[0] || "https://www.nseindia.com/api";
  const headers = { ...(CONFIG.NSE_HEADERS || {}) };

  try {
    const url = base.replace(/\/+$/, "") + `/historical/cm/equity/${encodeURIComponent(symbol)}/?series=EQ&from=01-01-2020&to=01-01-2025`;
    // try safeGet with text (some endpoints return html)
    const raw = await safeGet(url, [], DEFAULT_TIMEOUT, "text");
    // we intentionally do not parse NSE proprietary responses here; prefer Yahoo fallback
  } catch {}

  // fallback to cache
  const cache = readCache(symbol, interval);
  return cache || [];
}

/* ===========================
   MASTER PRICE (tries Yahoo 1m -> Binance 1m -> NSE -> cache)
   =========================== */
export async function fetchPrice(rawSymbol) {
  try {
    const symbol = safeSymbol(rawSymbol);
    if (!symbol) return null;

    // 1. yahoo 1m
    try {
      const y = await fetchYahoo(symbol, "1m");
      if (Array.isArray(y) && y.length) {
        const p = y.at(-1)?.close;
        if (Number.isFinite(+p)) return Number(p);
      }
    } catch {}

    // 2. binance
    if (/USDT$|BTC$|USD$/.test(symbol)) {
      try {
        const b = await fetchCrypto(symbol, "1m", 2);
        if (Array.isArray(b) && b.length) {
          const p = b.at(-1)?.close;
          if (Number.isFinite(+p)) return Number(p);
        }
      } catch {}
    }

    // 3. nse
    try {
      if (CONFIG.SYMBOLS?.INDIA?.includes(symbol) || /^NIFTY|BANKNIFTY|SENSEX|NSE:/.test(symbol)) {
        const n = await fetchNSE(symbol, "1m");
        if (Array.isArray(n) && n.length) {
          const p = n.at(-1)?.close;
          if (Number.isFinite(+p)) return Number(p);
        }
      }
    } catch {}

    // 4. last cached
    const cached = lastGoodPrice(symbol);
    if (cached && Number.isFinite(+cached)) return Number(cached);

    return null;
  } catch {
    return null;
  }
}

/* ===========================
   UNIVERSAL ROUTER — returns { data:[], price:null }
   Respects CONFIG.ACTIVE_MARKET when set
   =========================== */
export async function fetchUniversal(inputSymbol, interval = "15m") {
  try {
    const symbol = safeSymbol(inputSymbol);
    if (!symbol) return { data: [], price: null };

    // detect market heuristics
    const isCrypto = /USDT$|USD$|BTC$|ETH$/.test(symbol) || /[A-Z]{3,6}USDT$/.test(symbol);
    const isForex = /^[A-Z]{6}$/.test(symbol) && (symbol.endsWith("USD") || symbol.includes("JPY") || symbol.includes("EUR"));
    const isCommodity = /^(GC=F|CL=F|NG=F|SI=F|XAU|XAG|OIL|GOLD|SILVER)$/.test(symbol);
    const marketForced = (CONFIG.ACTIVE_MARKET || "").toUpperCase();

    const market = marketForced || (CONFIG.SYMBOLS?.INDIA?.includes(symbol) ? "INDIA" : isCrypto ? "CRYPTO" : isForex ? "FOREX" : isCommodity ? "COMMODITY" : "US_STOCKS");

    if (market === "CRYPTO" || isCrypto) {
      const d = await fetchCrypto(symbol, interval);
      const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
      return { data: d || [], price };
    }

    if (market === "INDIA") {
      const d = await fetchNSE(symbol, interval);
      const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
      return { data: d || [], price };
    }

    // FOREX / COMMODITY / US_STOCKS -> Yahoo
    const d = await fetchYahoo(symbol, interval);
    const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
    return { data: d || [], price };
  } catch {
    const s = safeSymbol(inputSymbol);
    return { data: readCache(s, interval) || [], price: lastGoodPrice(s) || null };
  }
}

/* ===========================
   fetchMarketData (legacy) — returns { data, price, updated }
   For backward compatibility with existing code
   =========================== */
export async function fetchMarketData(inputSymbol, interval = "15m", limit = 200) {
  try {
    const symbol = safeSymbol(inputSymbol);
    if (!symbol) {
      return { data: [], price: lastGoodPrice("") || null, updated: new Date().toISOString() };
    }

    // detect market & pick appropriate fetcher
    const isCrypto = /USDT$|USD$|BTC$|ETH$/.test(symbol);
    let d = [];
    if (CONFIG.ACTIVE_MARKET === "INDIA" || CONFIG.SYMBOLS?.INDIA?.includes(symbol)) {
      d = await fetchNSE(symbol, interval);
    } else if (isCrypto) {
      d = await fetchCrypto(symbol, interval, limit);
    } else {
      d = await fetchYahoo(symbol, interval);
    }

    const price = (Array.isArray(d) && d.length) ? Number(d.at(-1).close) : (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;

    return { data: d, price, updated: new Date().toISOString() };
  } catch {
    const symbol = safeSymbol(inputSymbol);
    return { data: readCache(symbol, interval) || [], price: lastGoodPrice(symbol) || null, updated: new Date().toISOString() };
  }
}

/* ===========================
   Concurrency limiter + fetchMultiTF
   fetchMultiTF(symbol, tfs = ["5m","15m","1h"])
   returns map { "1m": {data:[], price}, ... }
   =========================== */
function pLimit(concurrency = 3) {
  const queue = [];
  let active = 0;
  const runNext = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn()).then(v => {
      active--;
      resolve(v);
      runNext();
    }).catch(err => {
      active--;
      reject(err);
      runNext();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

export async function fetchMultiTF(inputSymbol, tfs = ["5m", "15m", "1h"]) {
  const symbol = safeSymbol(inputSymbol);
  const out = {};
  if (!symbol) {
    for (const tf of tfs) out[tf] = { data: [], price: null };
    return out;
  }

  const limit = pLimit(3);
  const tasks = tfs.map(tf => limit(async () => {
    // small jitter to avoid rate spike
    await sleep(40 + Math.floor(Math.random() * 120));
    try {
      out[tf] = await fetchUniversal(symbol, tf);
    } catch (e) {
      out[tf] = { data: readCache(symbol, tf) || [], price: lastGoodPrice(symbol) || null };
    }
  }));

  await Promise.all(tasks);

  // ensure we provide price for each TF (fallback to main price)
  const mainPrice = out[tfs[0]]?.price || lastGoodPrice(symbol) || null;
  for (const tf of tfs) {
    if (!out[tf]) out[tf] = { data: readCache(symbol, tf) || [], price: lastGoodPrice(symbol) || mainPrice };
    if (out[tf].price == null) out[tf].price = mainPrice;
    if (!Array.isArray(out[tf].data)) out[tf].data = [];
  }

  return out;
}

/* ===========================
   Exports default / named
   =========================== */
export default {
  fetchMarketData,
  fetchUniversal,
  fetchMultiTF,
  fetchPrice
};