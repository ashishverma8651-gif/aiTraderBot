// FILE: utils.js — Enhanced NON-BREAKING version (keeps same exports & behavior)
// Exports: fetchMarketData, fetchUniversal, fetchMultiTF
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
const DEFAULT_LIMIT = Number(process.env.DEFAULT_LIMIT || 200);

const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeNum = v => (Number.isFinite(+v) ? +v : 0);
const last = (arr, n = 1) => (Array.isArray(arr) && arr.length ? arr[arr.length - n] : null);

// -----------------------------
// Cache helpers
// -----------------------------
function cachePath(symbol, interval) {
  const key = `${String(symbol).toUpperCase()}_${String(interval)}`;
  return path.join(CACHE_DIR, `${key}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8") || "";
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeCache(symbol, interval, data) {
  try {
    const p = cachePath(symbol, interval);
    const obj = { fetchedAt: now(), data };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  } catch {}
}
// Return last known close from any cache file for symbol (fallback)
function lastGoodPrice(symbol) {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(String(symbol).toUpperCase() + "_"));
    files.sort((a, b) => fs.statSync(path.join(CACHE_DIR, b)).mtimeMs - fs.statSync(path.join(CACHE_DIR, a)).mtimeMs);
    for (const f of files) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
        const arr = obj?.data;
        if (Array.isArray(arr) && arr.length) {
          const lc = arr[arr.length - 1];
          if (lc && Number.isFinite(+lc.close)) return Number(lc.close);
        }
      } catch {}
    }
  } catch {}
  return 0;
}

// -----------------------------
// Timeframes map & symbol map (preserved)
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
// Proxy parsing & axios options
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
    opts.proxy = { host: PROXY_CFG.host, port: PROXY_CFG.port };
    if (PROXY_CFG.auth) opts.proxy.auth = { username: PROXY_CFG.auth.username, password: PROXY_CFG.auth.password };
  }
  return opts;
}

// -----------------------------
// safeGet with retries + mirrors + external proxies
// (keeps silent failures but tries many fallbacks)
// -----------------------------
async function safeGet(url, mirrors = [], timeout = AXIOS_TIMEOUT) {
  // try direct with retries
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(url, axiosOptions(timeout));
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch {
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
    }
  }

  // try mirrors (mirror bases in mirrors array)
  for (const m of mirrors || []) {
    if (!m) continue;
    let final = url;
    try {
      const u = new URL(url);
      final = m.replace(/\/+$/, "") + u.pathname + u.search;
    } catch {}
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const r = await axios.get(final, axiosOptions(timeout));
        if (r?.data !== undefined && r?.data !== null) return r.data;
      } catch {
        if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      }
    }
  }

  // try external proxy services
  for (const pbase of EXTERNAL_PROXY_SERVICES) {
    try {
      const proxied = pbase + encodeURIComponent(url);
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        try {
          const r = await axios.get(proxied, axiosOptions(timeout));
          if (r?.data !== undefined && r?.data !== null) return r.data;
        } catch {
          if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
        }
      }
    } catch {}
  }

  return null; // silent fail
}

// -----------------------------
// Normalizers
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
function normalizeYahooChart(res) {
  if (!res || !res.chart || !Array.isArray(res.chart.result)) return [];
  const r = res.chart.result[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (!Number.isFinite(close)) continue; // skip nulls
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
  return out;
}

// -----------------------------
// fetchCrypto — Binance klines only, with cache fallback
// -----------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  try {
    symbol = String(symbol).toUpperCase();
    const cacheEntry = readCache(symbol, interval);
    // build URL
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
    const mirrors = CONFIG.DATA_SOURCES?.BINANCE || [];
    const raw = await safeGet(url, mirrors);
    if (!raw || !Array.isArray(raw) || !raw.length) {
      // fallback to cache if exists
      if (cacheEntry && Array.isArray(cacheEntry.data) && cacheEntry.data.length) return cacheEntry.data;
      return [];
    }
    const normalized = normalizeKline(raw);
    writeCache(symbol, interval, normalized);
    return normalized;
  } catch {
    return readCache(symbol, interval)?.data || [];
  }
}

// -----------------------------
// fetchYahoo — robust + cache fallback
// -----------------------------
async function fetchYahoo(symbol, interval = "15m") {
  try {
    symbol = String(symbol);
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    const cacheEntry = readCache(symbol, interval);
    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart";
    const url = `${base}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;

    const res = await safeGet(url, CONFIG.DATA_SOURCES?.YAHOO?.slice(1) || []);
    const arr = normalizeYahooChart(res);
    if (arr && arr.length) {
      writeCache(symbol, interval, arr);
      return arr;
    }
    // if clean result not available, fall back to cache to avoid empty returns
    if (cacheEntry && Array.isArray(cacheEntry.data) && cacheEntry.data.length) return cacheEntry.data;
    return [];
  } catch {
    return readCache(symbol, interval)?.data || [];
  }
}

// -----------------------------
// fetchNSE — handle mapped prefixes and fallbacks
// -----------------------------
async function fetchNSE(symbol, interval = "15m") {
  try {
    const mapped = SYMBOL_EQUIV[symbol] || symbol;
    let toFetch = mapped;
    if (typeof toFetch === "string" && toFetch.startsWith("NSE:")) toFetch = toFetch.replace(/^NSE:/, "");
    // try caret form first
    const cand1 = typeof toFetch === "string" && !toFetch.startsWith("^") ? `^${toFetch}` : toFetch;
    const r1 = await fetchYahoo(cand1, interval);
    if (r1 && r1.length) return r1;
    const r2 = await fetchYahoo(toFetch, interval);
    if (r2 && r2.length) return r2;
    const r3 = await fetchYahoo(symbol, interval);
    if (r3 && r3.length) return r3;
    // final: cache fallback
    return readCache(toFetch, interval)?.data || readCache(symbol, interval)?.data || [];
  } catch {
    return readCache(symbol, interval)?.data || [];
  }
}

// -----------------------------
// fetchPrice helper (tries Yahoo -> Binance -> NSE) and returns null if none.
// Returns latest close or null (do not return 0 directly)
// -----------------------------
export async function fetchPrice(symbol) {
  try {
    if (!symbol) return null;
    symbol = String(symbol).toUpperCase();
    const mapped = SYMBOL_EQUIV[symbol] || symbol;

    // 1) try Yahoo 1m
    try {
      const y = await fetchYahoo(mapped, "1m");
      if (Array.isArray(y) && y.length) {
        const p = y.at(-1).close;
        if (Number.isFinite(+p)) return Number(p);
      }
    } catch {}

    // 2) if crypto, try Binance 1m
    try {
      const suffixes = ["USDT", "BTC"];
      if (suffixes.some(s => symbol.endsWith(s))) {
        const b = await fetchCrypto(symbol, "1m", 2);
        if (Array.isArray(b) && b.length) {
          const p = b.at(-1).close;
          if (Number.isFinite(+p)) return Number(p);
        }
      }
    } catch {}

    // 3) if India index, try NSE
    try {
      if (CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol)) {
        const n = await fetchNSE(symbol, "1m");
        if (Array.isArray(n) && n.length) {
          const p = n.at(-1).close;
          if (Number.isFinite(+p)) return Number(p);
        }
      }
    } catch {}

    // 4) fallback to last cached price (if any)
    const lastCached = lastGoodPrice(symbol);
    if (lastCached && Number.isFinite(+lastCached)) return Number(lastCached);

    return null;
  } catch {
    return null;
  }
}

// -----------------------------
// fetchMarketData (Crypto only wrapper)
// -----------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  try {
    const data = await fetchCrypto(symbol, interval, limit);
    const lastC = data.at(-1) || {};
    const price = Number(lastC?.close || (await fetchPrice(symbol)) || 0);
    return {
      data,
      price,
      updated: new Date().toISOString()
    };
  } catch {
    return { data: [], price: lastGoodPrice(symbol) || 0, updated: new Date().toISOString() };
  }
}

// -----------------------------
// fetchUniversal — MASTER ROUTER (keeps your original logic but uses fetchPrice fallback)
// -----------------------------
export async function fetchUniversal(symbolInput, interval = "15m") {
  try {
    if (!symbolInput) return { data: [], price: 0 };
    let symbol = String(symbolInput).toUpperCase();

    const mapped = SYMBOL_EQUIV[symbol] || null;

    const CRYPTO_SUFFIX = ["USDT", "BTC"];
    const isCrypto =
      CRYPTO_SUFFIX.some(sfx => symbol.endsWith(sfx)) &&
      !CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol) &&
      (!mapped || !mapped.startsWith("^"));

    // CRYPTO RAW
    if (isCrypto) {
      const x = await fetchMarketData(symbol, interval);
      // ensure price fallback
      const price = x.price || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || 0;
      return { data: x.data, price };
    }

    // NSE INDIA INDEX
    if (CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol)) {
      const d = await fetchNSE(symbol, interval);
      const price = (d?.length ? Number(d.at(-1).close) : null) ?? (await fetchPrice(symbol)) ?? lastGoodPrice(symbol) ?? 0;
      return { data: d, price };
    }

    // YAHOO (mapped or symbol)
    const target = mapped || symbol;
    const y1 = await fetchYahoo(target, interval);
    if (y1 && y1.length) {
      const price = Number(y1.at(-1).close) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || 0;
      return { data: y1, price };
    }

    // second attempt with raw symbol
    const y2 = await fetchYahoo(symbol, interval);
    if (y2 && y2.length) {
      const price = Number(y2.at(-1).close) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || 0;
      return { data: y2, price };
    }

    // fallback: cached data or fetchPrice
    const cached = readCache(target, interval)?.data || readCache(symbol, interval)?.data || [];
    const cachedPrice = (cached?.length ? Number(cached.at(-1).close) : 0) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || 0;
    return { data: cached, price: cachedPrice };
  } catch {
    return { data: [], price: lastGoodPrice(String(symbolInput).toUpperCase()) || 0 };
  }
}

// -----------------------------
// Simple concurrency limiter
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
  const limit = pLimit(2);
  const tasks = tfs.map(tf => limit(async () => {
    await sleep(50 + Math.floor(Math.random() * 120));
    const res = await fetchUniversal(symbol, tf);
    out[tf] = res;
  }));
  await Promise.all(tasks);
  return out;
}

