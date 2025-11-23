// FILE: utils.js  (Option C - Enhanced Multi-Vendor, Fault-Tolerant, Cache-Warm, Proxy-Safe)
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
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 450);
const DEFAULT_LIMIT = 200;

const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY || CONFIG.ALPHA_VANTAGE_KEY || null;

const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeNum = v => Number.isFinite(+v) ? +v : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const last = (arr, n = 1) => (Array.isArray(arr) && arr.length ? arr[arr.length - n] : null);

// -----------------------------
// Cache helpers & lastGoodPrice
// -----------------------------
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}__${interval}.json`);
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
// search caches for a last known close (across intervals)
function lastGoodPrice(symbol) {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(symbol + "__"));
    // prefer newest file
    files.sort((a,b) => fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for (const f of files) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
        const arr = obj?.data;
        if (Array.isArray(arr) && arr.length) {
          const lastc = arr[arr.length - 1];
          if (lastc && Number.isFinite(+lastc.close)) return Number(lastc.close);
        }
      } catch {}
    }
  } catch {}
  return 0;
}

// -----------------------------
// Timeframes map
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

// -----------------------------
// Symbol equivalences (kept + extended)
// -----------------------------
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
    return { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), auth };
  } catch { return null; }
}
const PROXY_CFG = parseProxy(CONFIG.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null);
function axiosOptions(timeout = AXIOS_TIMEOUT) {
  const opts = { timeout, validateStatus: s => s >= 200 && s < 500 }; // treat 4xx as handled
  if (PROXY_CFG) {
    opts.proxy = { host: PROXY_CFG.host, port: PROXY_CFG.port, protocol: PROXY_CFG.protocol };
    if (PROXY_CFG.auth) opts.proxy.auth = { username: PROXY_CFG.auth.username, password: PROXY_CFG.auth.password };
  }
  return opts;
}

// -----------------------------
// safeGet: primary tries + mirror/proxy fallbacks
// -----------------------------
const GLOBAL_MIRRORS = CONFIG.DATA_SOURCES?.BINANCE || [];
const EXTERNAL_PROXIES = (CONFIG.PROXY ? [CONFIG.PROXY] : []).concat([
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
]);

async function safeGet(url, mirrors = [], timeout = AXIOS_TIMEOUT) {
  // primary direct attempts
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get(url, axiosOptions(timeout));
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS + Math.random() * 120);
    }
  }
  // try mirrors (mirror includes vendor fallback domains)
  for (const m of (mirrors || []).concat(GLOBAL_MIRRORS || [])) {
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
      } catch (err) {
        if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS + Math.random()*120);
      }
    }
  }
  // try external proxy services
  for (const pbase of EXTERNAL_PROXIES) {
    try {
      const prox = pbase + encodeURIComponent(url);
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        try {
          const r = await axios.get(prox, axiosOptions(timeout));
          if (r?.data !== undefined && r?.data !== null) return r.data;
        } catch (err) {
          if (attempt < RETRY_ATTEMPTS - 1) await sleep(120 + Math.random()*120);
        }
      }
    } catch {}
  }
  return null;
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
  out.sort((a,b) => a.t - b.t);
  return out;
}
function normalizeYahooChart(res) {
  if (!res || !res.chart || !Array.isArray(res.chart.result)) return [];
  const r = res.chart.result[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i=0;i<ts.length;i++) {
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
  out.sort((a,b) => a.t - b.t);
  return out;
}
function normalizeAlphaCsv(csvText) {
  // attempt to parse AlphaVantage CSV daily or intraday (fallback)
  // basic parsing - returns array of candles with t in ms
  if (!csvText || typeof csvText !== "string") return [];
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 5) continue;
    // header may be timestamp,open,high,low,close,volume
    const ts = new Date(cols[0]).getTime();
    if (!Number.isFinite(ts)) continue;
    out.push({
      t: ts,
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      vol: Number(cols[5] || 0)
    });
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}

// -----------------------------
// Vendor fetchers
// -----------------------------
// 1) Binance klines
async function fetchBinanceKlines(symbol, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
    const mirrors = CONFIG.DATA_SOURCES?.BINANCE || [];
    const raw = await safeGet(url, mirrors);
    if (!raw) return [];
    return normalizeKline(raw);
  } catch {
    return [];
  }
}
// 2) Bybit klines (mirror)
async function fetchBybitKlines(symbol, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    // Bybit API shape: /public/linear/kline?symbol=BTCUSDT&interval=1
    const mapInterval = interval.replace("m","").replace("h","60"); // keep simple; Bybit may use other naming in some endpoints
    const url = `https://api.bybit.com/public/linear/kline?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(mapInterval)}&limit=${Number(limit)}`;
    const raw = await safeGet(url, CONFIG.DATA_SOURCES?.BYBIT || []);
    // Bybit wraps data inside result?.list sometimes
    const list = raw?.result?.list || raw?.result || raw;
    if (!Array.isArray(list)) return [];
    // convert if Bybit returns arrays
    if (Array.isArray(list) && list.length && Array.isArray(list[0])) return normalizeKline(list);
    // else try to map object entries
    try {
      return list.map(r => ({
        t: safeNum(r.open_time || r.t || r[0]) * (r.open_time ? 1000 : 1),
        open: safeNum(r.open || r[1]),
        high: safeNum(r.high || r[2]),
        low: safeNum(r.low || r[3]),
        close: safeNum(r.close || r[4]),
        vol: safeNum(r.volume || r[5])
      }));
    } catch { return []; }
  } catch { return []; }
}
// 3) KuCoin (mirror)
async function fetchKucoinKlines(symbol, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const url = `https://api.kucoin.com/api/v1/market/candles?type=${encodeURIComponent(interval)}&symbol=${encodeURIComponent(symbol)}&limit=${Number(limit)}`;
    const raw = await safeGet(url, CONFIG.DATA_SOURCES?.KUCOIN || []);
    // Kucoin returns array of arrays: [time, open, close, high, low, volume, turnover]
    if (!Array.isArray(raw)) return [];
    const mapped = raw.map(k => {
      // map to Binance-like order: time, open, high, low, close, vol
      const t = Number(k[0]);
      return { t: t * (t < 9999999999 ? 1000 : 1), open: Number(k[1]), high: Number(k[3]), low: Number(k[4]), close: Number(k[2]), vol: Number(k[5]) };
    });
    mapped.sort((a,b)=>a.t-b.t);
    return mapped;
  } catch { return []; }
}

// 4) Yahoo chart v8
async function fetchYahoo(symbol, interval = "15m") {
  try {
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
    // fallback to cache instead of returning empty
    if (cacheEntry && Array.isArray(cacheEntry.data) && cacheEntry.data.length) return cacheEntry.data;
    return [];
  } catch {
    return readCache(symbol, interval)?.data || [];
  }
}

// 5) AlphaVantage (optional) - CSV endpoint (TIME_SERIES_INTRADAY or DAILY)
async function fetchAlpha(symbol, interval = "15m") {
  try {
    if (!ALPHAVANTAGE_KEY) return [];
    // choose function
    const func = interval === "1d" ? "TIME_SERIES_DAILY" : "TIME_SERIES_INTRADAY";
    const intradayInterval = (interval === "1m" || interval === "5m" || interval === "15m" || interval === "30m") ? interval : "60min";
    const apiUrl = func === "TIME_SERIES_DAILY"
      ? `https://www.alphavantage.co/query?function=${func}&symbol=${encodeURIComponent(symbol)}&apikey=${ALPHAVANTAGE_KEY}&datatype=csv`
      : `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${intradayInterval}&apikey=${ALPHAVANTAGE_KEY}&datatype=csv`;
    const csv = await safeGet(apiUrl, [], 12000);
    const normalized = normalizeAlphaCsv(csv);
    return normalized;
  } catch { return []; }
}

// -----------------------------
// fetchCrypto: multi-vendor & cache with fallback
// -----------------------------
async function fetchCrypto(symbol, interval = "15m", limit = DEFAULT_LIMIT) {
  symbol = String(symbol).toUpperCase();
  const cacheKeyInterval = interval;
  const cacheEntry = readCache(symbol, cacheKeyInterval);
  if (cacheEntry && (now() - cacheEntry.fetchedAt) < (CACHE_TTL(interval) || 60000)) {
    // warm cache
    return cacheEntry.data.slice();
  }

  // vendor order: Binance -> Bybit -> Kucoin -> Yahoo -> Alpha (if key)
  let data = [];
  data = await fetchBinanceKlines(symbol, interval, limit);
  if (!data.length) data = await fetchBybitKlines(symbol, interval, limit);
  if (!data.length) data = await fetchKucoinKlines(symbol, interval, limit);
  if (!data.length) data = await fetchYahoo(symbol, interval);
  if (!data.length && ALPHAVANTAGE_KEY) data = await fetchAlpha(symbol, interval);

  // if all vendors fail, fallback to cache
  if (!data.length && cacheEntry && Array.isArray(cacheEntry.data)) return cacheEntry.data;

  if (data.length) writeCache(symbol, cacheKeyInterval, data);
  return data;
}

// -----------------------------
// fetchNSE: robust NSE / India ticker fetch with multiple trials
// -----------------------------
async function fetchNSE(symbol, interval = "15m") {
  const mapped = SYMBOL_EQUIV[symbol] || symbol;
  let toFetch = mapped;
  if (typeof toFetch === "string" && toFetch.startsWith("NSE:")) toFetch = toFetch.replace(/^NSE:/, "");
  // try prefixed caret
  const tryPref = toFetch.startsWith("^") ? toFetch : `^${toFetch}`;
  const c1 = await fetchYahoo(tryPref, interval);
  if (c1.length) return c1;
  // try non-caret
  const c2 = await fetchYahoo(toFetch, interval);
  if (c2.length) return c2;
  // try original symbol
  const c3 = await fetchYahoo(symbol, interval);
  if (c3.length) return c3;
  // try alpha if available
  if (ALPHAVANTAGE_KEY) {
    const ca = await fetchAlpha(symbol, interval);
    if (ca.length) return ca;
  }
  // fallback to cache
  return readCache(toFetch, interval)?.data || readCache(symbol, interval)?.data || [];
}

// -----------------------------
// helper: returns TTL per interval
// -----------------------------
function CACHE_TTL(interval) {
  const map = {
    "1m": 30 * 1000,
    "5m": 60 * 1000,
    "15m": 2 * 60 * 1000,
    "30m": 5 * 60 * 1000,
    "1h": 10 * 60 * 1000,
    "4h": 30 * 60 * 1000,
    "1d": 60 * 60 * 1000
  };
  return map[interval] || map["15m"];
}

// -----------------------------
// fetchMarketData — crypto wrapper (returns source tag)
 // returns { data, price, updated, source }
// -----------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const data = await fetchCrypto(symbol, interval, limit);
    const lastc = last(data);
    const price = lastc ? Number(lastc.close) : lastGoodPrice(symbol) || 0;
    return { data, price: safeNum(price), updated: new Date().toISOString(), source: "multi-vendor-crypto" };
  } catch {
    return { data: [], price: lastGoodPrice(symbol) || 0, updated: new Date().toISOString(), source: "error" };
  }
}

// -----------------------------
// Market detection helper
// -----------------------------
function detectMarket(symbol = "") {
  if (!symbol) return "GENERAL";
  const s = String(symbol).toUpperCase();
  const indiaIdx = (CONFIG.MARKETS?.INDIA?.INDEXES || []).map(x => String(x).toUpperCase());
  if (indiaIdx.includes(s) || /NIFTY|BANKNIFTY|SENSEX|FINNIFTY/.test(s)) return "INDIA";
  if (/(USDT|USD|BTC|ETH)$/.test(s)) return "CRYPTO";
  if (/^(GC=F|CL=F|NG=F|SI=F|XAU|XAG|OIL|GOLD|SILVER)$/.test(s)) return "COMMODITY";
  if (/^[A-Z]{6}$/.test(s) && (s.endsWith("USD") || s.includes("JPY"))) return "FOREX";
  if (/^[A-Z]{1,5}$/.test(s)) return "STOCK";
  if (/^(SP|DJI|NDX|NIFTY|BANKNIFTY|SENSEX)/.test(s)) return "INDEX";
  return "GENERAL";
}

// -----------------------------
// lastPriceFromData helper
// -----------------------------
function lastPriceFromData(data) {
  if (!Array.isArray(data) || !data.length) return 0;
  const c = last(data);
  return safeNum(c.close || c.price || 0);
}

// -----------------------------
// fetchUniversal — main router (multi-vendor + fallbacks)
// returns { data, price }
// -----------------------------
export async function fetchUniversal(symbolInput, interval = "15m") {
  try {
    if (!symbolInput) return { data: [], price: 0 };
    let symbol = String(symbolInput).toUpperCase();
    const market = detectMarket(symbol);

    // apply mapping
    let mapped = SYMBOL_EQUIV[symbol] || null;
    if (mapped && mapped.startsWith("NSE:")) mapped = mapped.replace(/^NSE:/, "");

    // CRYPTO path
    if (market === "CRYPTO") {
      const x = await fetchMarketData(symbol, interval);
      return { data: x.data, price: x.price };
    }

    // INDIA (indices)
    if (market === "INDIA") {
      // try NSE-specific fetch
      const d = await fetchNSE(symbol, interval);
      const price = lastPriceFromData(d) || lastGoodPrice(symbol) || lastGoodPrice(mapped || symbol);
      return { data: d, price: safeNum(price) };
    }

    // STOCK/FOREX/COMMODITY/INDEX: try mapped then symbol then alpha then cache
    const yahooTarget = mapped || symbol;
    const y1 = await fetchYahoo(yahooTarget, interval);
    if (y1.length) return { data: y1, price: safeNum(lastPriceFromData(y1) || lastGoodPrice(yahooTarget) || lastGoodPrice(symbol)) };

    const y2 = await fetchYahoo(symbol, interval);
    if (y2.length) return { data: y2, price: safeNum(lastPriceFromData(y2) || lastGoodPrice(symbol)) };

    // try Alpha if present
    if (ALPHAVANTAGE_KEY) {
      const a1 = await fetchAlpha(symbol, interval);
      if (a1.length) return { data: a1, price: safeNum(lastPriceFromData(a1) || lastGoodPrice(symbol)) };
    }

    // final fallback: search cache
    const cached = readCache(yahooTarget, interval)?.data || readCache(symbol, interval)?.data || [];
    const cachedPrice = safeNum(lastPriceFromData(cached) || lastGoodPrice(symbol) || lastGoodPrice(yahooTarget) || 0);
    return { data: cached, price: cachedPrice };
  } catch {
    return { data: [], price: lastGoodPrice(symbolInput) || 0 };
  }
}

// -----------------------------
// pLimit concurrency helper
// -----------------------------
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn()).then(v => {
      active--;
      resolve(v);
      next();
    }).catch(err => {
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
export async function fetchMultiTF(symbol, tfs = ["5m","15m","1h"]) {
  const out = {};
  const limit = pLimit(2);
  const tasks = tfs.map(tf => limit(async () => {
    await sleep(40 + Math.floor(Math.random()*120));
    const res = await fetchUniversal(symbol, tf);
    out[tf] = res;
  }));
  await Promise.all(tasks);
  return out;
}

// -----------------------------
// Keep default export null (compat)
export default null;