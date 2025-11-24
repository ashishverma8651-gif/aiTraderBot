// ============================================================================
// utils.js — FINAL FUTURE-PROOF VERSION (NO CRASH, ALL MARKETS SUPPORTED)
// Works for: CRYPTO, INDIA (NSE), COMMODITIES, FOREX, US STOCKS
// ============================================================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ============================================================================
// BASIC CONSTANTS
// ============================================================================
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES ?? 3);
const RETRY_DELAY = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS ?? 500);

// ============================================================================
// UNIVERSAL SAFE STRING (Stops ALL undefined crash FOREVER)
// ============================================================================
function safeString(x) {
  try {
    if (x === null || x === undefined) return "";
    return String(x).trim();
  } catch {
    return "";
  }
}

// ============================================================================
// SAFE SYMBOL (no null, no undefined, always UPPERCASE)
// ============================================================================
function safeSymbol(raw) {
  let s = safeString(raw);

  if (!s) s = safeString(CONFIG.ACTIVE_SYMBOL);
  if (!s) s = safeString(CONFIG.DEFAULT_BY_MARKET?.[CONFIG.ACTIVE_MARKET]);
  if (!s) s = safeString(CONFIG.DEFAULT_SYMBOL);
  if (!s) s = "";

  return s.toUpperCase();
}

// ============================================================================
// PROXY SETUP
// ============================================================================
function parseProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: Number(u.port || 80),
      auth: u.username ? { username: u.username, password: u.password } : undefined
    };
  } catch { return null; }
}

const PARSED_PROXY = parseProxy(CONFIG.PROXY);

function axiosOptions(timeout = TIMEOUT) {
  const o = { timeout };
  if (PARSED_PROXY) {
    o.proxy = {
      host: PARSED_PROXY.host,
      port: PARSED_PROXY.port,
      auth: PARSED_PROXY.auth
    };
  }
  return o;
}

// ============================================================================
// HELPERS
// ============================================================================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function cacheFile(symbol, interval) {
  symbol = safeString(symbol).replace(/[^A-Za-z0-9_\-]/g, "_");
  interval = safeString(interval).replace(/[^A-Za-z0-9_\-]/g, "_");
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const f = cacheFile(symbol, interval);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return null; }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cacheFile(symbol, interval), JSON.stringify({ data, ts: Date.now() }, null, 2));
  } catch {}
}

// last good price from cache
function lastGoodPrice(symbol) {
  try {
    const s = safeString(symbol).toUpperCase();
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.startsWith(s + "_"))
      .sort((a, b) => fs.statSync(path.join(CACHE_DIR, b)).mtimeMs - fs.statSync(path.join(CACHE_DIR, a)).mtimeMs);

    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
      const arr = d.data;
      if (Array.isArray(arr) && arr.length && Number.isFinite(+arr.at(-1).close))
        return Number(arr.at(-1).close);
    }
  } catch {}
  return null;
}

// ============================================================================
// UNIVERSAL SAFE GET (retries + fallback + proxy)
// ============================================================================
async function safeGet(url, mirrors = [], timeout = TIMEOUT) {
  if (!url) return null;

  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await axios.get(url, axiosOptions(timeout));
      if (r?.data) return r.data;
    } catch {}
    await sleep(RETRY_DELAY);
  }

  // mirror bases
  for (const base of mirrors) {
    if (!base) continue;
    try {
      const u = new URL(url);
      const final = base.replace(/\/+$/, "") + u.pathname + u.search;

      for (let i = 0; i < RETRIES; i++) {
        try {
          const r = await axios.get(final, axiosOptions(timeout));
          if (r?.data) return r.data;
        } catch {}
        await sleep(RETRY_DELAY);
      }
    } catch {}
  }

  // external lightweight proxies
  const wrappers = [
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?"
  ];

  for (const w of wrappers) {
    try {
      const proxied = w + encodeURIComponent(url);

      for (let i = 0; i < RETRIES; i++) {
        try {
          const r = await axios.get(proxied, axiosOptions(timeout));
          if (r?.data) return r.data;
        } catch {}
        await sleep(RETRY_DELAY);
      }
    } catch {}
  }

  return null;
}

// ============================================================================
// NORMALIZERS
// ============================================================================
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({
    t: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    vol: +k[5]
  })).sort((a, b) => a.t - b.t);
}

function normalizeYahoo(res) {
  try {
    if (!res?.chart?.result?.[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};

    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) continue;

      out.push({
        t: ts[i] * 1000,
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        vol: q.volume?.[i] ?? 0
      });
    }
    return out.sort((a, b) => a.t - b.t);
  } catch { return []; }
}

// ============================================================================
// MARKET FETCHERS
// ============================================================================

// CRYPTO via Binance
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const base = CONFIG.DATA_SOURCES_BY_MARKET?.CRYPTO?.[0] || "https://api.binance.com";
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const mirrors = CONFIG.DATA_SOURCES_BY_MARKET?.CRYPTO?.slice(1) || [];

  const cache = readCache(symbol, interval);
  const raw = await safeGet(url, mirrors);

  if (Array.isArray(raw) && raw.length) {
    const k = normalizeKline(raw);
    writeCache(symbol, interval, k);
    return k;
  }
  return cache?.data || [];
}

// NSE / BSE / COMMODITIES via Yahoo
async function fetchYahooMarket(symbol, interval = "15m") {
  const mapTF = {
    "1m": ["1m", "1d"],
    "5m": ["5m", "5d"],
    "15m": ["15m", "5d"],
    "30m": ["30m", "1mo"],
    "1h": ["60m", "1mo"],
    "4h": ["240m", "3mo"],
    "1d": ["1d", "6mo"]
  };
  const [intv, range] = mapTF[interval] || ["15m", "5d"];

  const base = CONFIG.DATA_SOURCES_BY_MARKET?.YAHOO?.[0] ||
               "https://query1.finance.yahoo.com/v8/finance/chart";

  const url = `${base}/${symbol}?interval=${intv}&range=${range}`;
  const mirrors = CONFIG.DATA_SOURCES_BY_MARKET?.YAHOO?.slice(1) || [];

  const cache = readCache(symbol, interval);
  const res = await safeGet(url, mirrors);

  if (res) {
    const k = normalizeYahoo(res);
    if (k.length) {
      writeCache(symbol, interval, k);
      return k;
    }
  }

  return cache?.data || [];
}

// ============================================================================
// MASTER PRICE SAFE
// ============================================================================
export async function fetchPrice(rawSymbol) {
  const symbol = safeSymbol(rawSymbol);

  if (!symbol) return null;

  try {
    // Yahoo
    const y = await fetchYahooMarket(symbol, "1m");
    if (y?.length) return Number(y.at(-1).close);
  } catch {}

  // Crypto fallback
  if (symbol.endsWith("USDT") || symbol.endsWith("BTC")) {
    try {
      const b = await fetchCrypto(symbol, "1m");
      if (b?.length) return Number(b.at(-1).close);
    } catch {}
  }

  // Cached
  return lastGoodPrice(symbol);
}

// ============================================================================
// UNIVERSAL MARKET ROUTER
// ============================================================================
export async function fetchUniversal(inputSymbol, interval = "15m") {
  const symbol = safeSymbol(inputSymbol);
  if (!symbol) return { data: [], price: null };

  const s = symbol;

  const isCrypto = s.endsWith("USDT") || s.endsWith("BTC");
  const isIndia = CONFIG.SYMBOLS?.INDIA?.includes(s);
  const isCommodity = CONFIG.SYMBOLS?.COMMODITIES?.includes(s);

  // CRYPTO
  if (isCrypto) {
    const d = await fetchCrypto(s, interval);
    return { data: d, price: d?.at(-1)?.close || (await fetchPrice(s)) || null };
  }

  // INDIA / NSE
  if (isIndia) {
    const d = await fetchYahooMarket(s, interval);
    return { data: d, price: d?.at(-1)?.close || (await fetchPrice(s)) };
  }

  // COMMODITIES (Gold, Silver, Crude)
  if (isCommodity) {
    const d = await fetchYahooMarket(s, interval);
    return { data: d, price: d?.at(-1)?.close || (await fetchPrice(s)) };
  }

  // fallback: forex/us stocks via yahoo
  const d = await fetchYahooMarket(s, interval);
  return { data: d, price: d?.at(-1)?.close || (await fetchPrice(s)) };
}

// ============================================================================
// Multi-TF fetch (Thread-safe)
// ============================================================================
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;

  const next = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn())
      .then(v => { active--; resolve(v); next(); })
      .catch(e => { active--; reject(e); next(); });
  };

  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const s = safeSymbol(symbol);
  const out = {};
  const limit = pLimit(2);
  const tasks = tfs.map(tf =>
    limit(async () => {
      out[tf] = await fetchUniversal(s, tf);
    })
  );
  await Promise.all(tasks);
  return out;
}

// ============================================================================
// Legacy API
// ============================================================================
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  const s = safeSymbol(symbol);
  const d = await fetchCrypto(s, interval, limit);
  const price = d?.at(-1)?.close || (await fetchPrice(s)) || null;

  return {
    data: d,
    price,
    updated: new Date().toISOString()
  };
}

// ============================================================================
// EXPORT
// ============================================================================
export default {
  safeSymbol,
  fetchUniversal,
  fetchPrice,
  fetchMarketData,
  fetchMultiTF
};