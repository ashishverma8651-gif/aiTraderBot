// utils.js — Robust, multi-market, non-breaking utilities
// Exports: fetchMarketData, fetchUniversal, fetchMultiTF, fetchPrice
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

/************************************************************
 *  CONSTANTS & SETUP
 ************************************************************/
const CACHE_DIR = (CONFIG && CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES ?? 3);
const RETRY_DELAY = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS ?? 500);

const PROXY = CONFIG.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null;
const ACTIVE_MARKET = String(CONFIG.ACTIVE_MARKET || "CRYPTO").toUpperCase();
const ACTIVE_SYMBOL = String(CONFIG.ACTIVE_SYMBOL || CONFIG.DEFAULT_BY_MARKET?.CRYPTO || "").trim();

/************************************************************
 *  PROXY SUPPORT
 ************************************************************/
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const auth = u.username
      ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      : undefined;
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

const PARSED_PROXY = parseProxy(PROXY);

function axiosOptions(timeout = TIMEOUT) {
  const opts = { timeout };
  if (PARSED_PROXY) {
    opts.proxy = { host: PARSED_PROXY.host, port: PARSED_PROXY.port };
    if (PARSED_PROXY.auth) opts.proxy.auth = { username: PARSED_PROXY.auth.username, password: PARSED_PROXY.auth.password };
  }
  return opts;
}

/************************************************************
 *  HELPERS
 ************************************************************/
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function safeSymbol(raw) {
  // Prefer passed symbol -> CONFIG.ACTIVE_SYMBOL -> DEFAULT_BY_MARKET -> empty
  const s = (raw ?? CONFIG.ACTIVE_SYMBOL ?? CONFIG.DEFAULT_BY_MARKET?.[CONFIG.ACTIVE_MARKET] ?? "").toString().trim();
  return s ? s.toUpperCase() : "";
}

function cacheFileName(symbol, interval) {
  const s = (symbol || "").toString().toUpperCase().replace(/[^A-Z0-9_\-\.^]/g, "_");
  const tf = String(interval || "15m").replace(/[^a-z0-9]/gi, "_");
  return path.join(CACHE_DIR, `${s}_${tf}.json`);
}

function readCache(symbol, interval) {
  const p = cacheFileName(symbol, interval);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(symbol, interval, data) {
  const p = cacheFileName(symbol, interval);
  try {
    fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2));
  } catch {}
}

function lastGoodPrice(symbol) {
  try {
    const s = (symbol || "").toString().toUpperCase();
    if (!s) return null;
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith(s + "_"));
    files.sort((a, b) => fs.statSync(path.join(CACHE_DIR, b)).mtimeMs - fs.statSync(path.join(CACHE_DIR, a)).mtimeMs);
    for (const f of files) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
        const arr = obj?.data;
        if (Array.isArray(arr) && arr.length) {
          const last = arr.at(-1);
          if (last && Number.isFinite(+last.close)) return Number(last.close);
        }
      } catch {}
    }
  } catch {}
  return null;
}

/************************************************************
 *  SAFE GET (retries + multi-source + proxy)
 ************************************************************/
async function safeGet(url, sources = [], timeout = TIMEOUT) {
  if (!url) return null;

  // primary
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await axios.get(url, axiosOptions(timeout));
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch {}
    await sleep(RETRY_DELAY);
  }

  // mirrors/base sources
  for (const base of sources || []) {
    if (!base) continue;
    let final = url;
    try {
      const u = new URL(url);
      final = base.replace(/\/+$/, "") + u.pathname + u.search;
    } catch {}
    for (let i = 0; i < RETRIES; i++) {
      try {
        const r = await axios.get(final, axiosOptions(timeout));
        if (r?.data !== undefined && r?.data !== null) return r.data;
      } catch {}
      await sleep(RETRY_DELAY);
    }
  }

  // external simple proxy services (lightweight)
  const EXTERNAL_PROXY_SERVICES = [
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?"
  ];
  for (const pbase of EXTERNAL_PROXY_SERVICES) {
    try {
      const proxied = pbase + encodeURIComponent(url);
      for (let i = 0; i < RETRIES; i++) {
        try {
          const r = await axios.get(proxied, axiosOptions(timeout));
          if (r?.data !== undefined && r?.data !== null) return r.data;
        } catch {}
        await sleep(RETRY_DELAY);
      }
    } catch {}
  }

  return null;
}

/************************************************************
 *  NORMALIZERS
 ************************************************************/
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw.map(k => ({
    t: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    vol: Number(k[5])
  }));
  out.sort((a, b) => a.t - b.t);
  return out;
}

function normalizeYahoo(res) {
  try {
    if (!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
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
    return out;
  } catch {
    return [];
  }
}

/************************************************************
 *  MARKET-SPECIFIC FETCHERS (use CONFIG.DATA_SOURCES_BY_MARKET)
 ************************************************************/
async function fetchCrypto(sym, interval = "15m", limit = 200) {
  const symbol = safeSymbol(sym);
  if (!symbol) return [];
  const cache = readCache(symbol, interval);
  const base = (CONFIG.DATA_SOURCES_BY_MARKET?.CRYPTO?.[0]) || "https://api.binance.com";
  const url = `${base.replace(/\/+$/, "")}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
  const mirrors = CONFIG.DATA_SOURCES_BY_MARKET?.CRYPTO?.slice(1) || [];
  const raw = await safeGet(url, mirrors);
  if (Array.isArray(raw) && raw.length) {
    const k = normalizeKline(raw);
    writeCache(symbol, interval, k);
    return k;
  }
  return cache?.data || [];
}

async function fetchYahoo(sym, interval = "15m") {
  const symbol = safeSymbol(sym);
  if (!symbol) return [];
  const tf = {
    "1m": { interval: "1m", range: "1d" },
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "1mo" },
    "1h": { interval: "60m", range: "1mo" },
    "4h": { interval: "240m", range: "3mo" },
    "1d": { interval: "1d", range: "6mo" }
  }[interval] || { interval: "15m", range: "5d" };

  const base = CONFIG.DATA_SOURCES_BY_MARKET?.US_STOCKS?.[0] || CONFIG.DATA_SOURCES_BY_MARKET?.FOREX?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart";
  const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;
  const mirrors = (CONFIG.DATA_SOURCES_BY_MARKET?.US_STOCKS || CONFIG.DATA_SOURCES_BY_MARKET?.FOREX || []).slice(1);

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

async function fetchNSE(sym, interval = "15m") {
  // Primary approach: attempt Yahoo variants first (caret symbol etc)
  const symbol = safeSymbol(sym);
  if (!symbol) return [];
  const mapped = CONFIG.SYMBOLS?.INDIA?.includes(symbol) ? symbol : symbol;
  const tries = [
    `^${mapped}`,
    mapped,
    symbol
  ].map(s => s.replace(/^NSE:/i, ""));

  for (const t of tries) {
    const res = await fetchYahoo(t, interval);
    if (res && res.length) return res;
  }
  return readCache(symbol, interval)?.data || [];
}

/************************************************************
 *  MASTER PRICE (Yahoo -> Binance -> Cache)
 ************************************************************/
export async function fetchPrice(rawSymbol) {
  try {
    const symbol = safeSymbol(rawSymbol);
    if (!symbol) return null;

    // 1) Yahoo 1m
    try {
      const y = await fetchYahoo(symbol, "1m");
      if (Array.isArray(y) && y.length) {
        const p = y.at(-1)?.close;
        if (Number.isFinite(+p)) return Number(p);
      }
    } catch {}

    // 2) Binance (crypto)
    if (symbol.endsWith("USDT") || symbol.endsWith("BTC")) {
      try {
        const b = await fetchCrypto(symbol, "1m", 2);
        if (Array.isArray(b) && b.length) {
          const p = b.at(-1)?.close;
          if (Number.isFinite(+p)) return Number(p);
        }
      } catch {}
    }

    // 3) NSE specific
    try {
      if (CONFIG.SYMBOLS?.INDIA?.includes(symbol) || String(symbol).toUpperCase().startsWith("^")) {
        const n = await fetchNSE(symbol, "1m");
        if (Array.isArray(n) && n.length) {
          const p = n.at(-1)?.close;
          if (Number.isFinite(+p)) return Number(p);
        }
      }
    } catch {}

    // 4) last cached
    const cached = lastGoodPrice(symbol);
    if (cached && Number.isFinite(+cached)) return Number(cached);

    return null;
  } catch {
    return null;
  }
}

/************************************************************
 *  UNIVERSAL FETCHER — FINAL ROUTER
 ************************************************************/
export async function fetchUniversal(inputSymbol, interval = "15m") {
  try {
    const symbol = safeSymbol(inputSymbol);
    if (!symbol) {
      // nothing to fetch — return safe empty
      return { data: [], price: null };
    }

    // detect crypto-ish
    const isCrypto = /USDT$|BTC$/i.test(symbol);

    // If ACTIVE_MARKET forces a market, respect it
    const market = (CONFIG.ACTIVE_MARKET || ACTIVE_MARKET || "").toUpperCase();

    if (market === "CRYPTO" || isCrypto) {
      const d = await fetchCrypto(symbol, interval);
      const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
      return { data: d, price };
    }

    if (market === "INDIA") {
      const d = await fetchNSE(symbol, interval);
      const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
      return { data: d, price };
    }

    // FOREX or US_STOCKS or default -> use Yahoo
    const d = await fetchYahoo(symbol, interval);
    const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
    return { data: d, price };
  } catch {
    const s = safeSymbol(inputSymbol);
    return { data: readCache(s, interval)?.data || [], price: lastGoodPrice(s) || null };
  }
}

/************************************************************
 *  fetchMarketData (legacy compatibility)
 ************************************************************/
export async function fetchMarketData(inputSymbol, interval = "15m", limit = 200) {
  try {
    const symbol = safeSymbol(inputSymbol);
    if (!symbol) {
      return { data: [], price: lastGoodPrice("") || null, updated: new Date().toISOString() };
    }
    const d = await fetchCrypto(symbol, interval, limit);
    const price = (d?.length ? Number(d.at(-1).close) : null) || (await fetchPrice(symbol)) || lastGoodPrice(symbol) || null;
    return {
      data: d,
      price,
      updated: new Date().toISOString()
    };
  } catch {
    const symbol = safeSymbol(inputSymbol);
    return { data: readCache(symbol, interval)?.data || [], price: lastGoodPrice(symbol) || null, updated: new Date().toISOString() };
  }
}

/************************************************************
 *  CONCURRENCY LIMITER + fetchMultiTF
 ************************************************************/
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn()).then((v) => {
      active--;
      resolve(v);
      next();
    }).catch((e) => {
      active--;
      reject(e);
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

export async function fetchMultiTF(inputSymbol, tfs = ["5m", "15m", "1h"]) {
  const symbol = safeSymbol(inputSymbol);
  if (!symbol) {
    // return empty map for each tf
    const empty = {};
    for (const tf of tfs) empty[tf] = { data: [], price: null };
    return empty;
  }
  const out = {};
  const limit = pLimit(2);
  const tasks = tfs.map((tf) => limit(async () => {
    await sleep(50 + Math.floor(Math.random() * 120));
    out[tf] = await fetchUniversal(symbol, tf);
  }));
  await Promise.all(tasks);
  return out;
}