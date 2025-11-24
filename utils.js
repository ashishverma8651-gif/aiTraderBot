// utils.js — UNIVERSAL MULTI-MARKET DATA ENGINE (FINAL VERSION)
// Works for: Crypto, India/NSE, US Stocks, Forex, Commodities

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

/************************************************************
 * CONSTANTS & SETUP
 ************************************************************/
const CACHE_DIR =
  (CONFIG?.PATHS?.CACHE_DIR) || path.resolve("./cache");

if (!fs.existsSync(CACHE_DIR))
  fs.mkdirSync(CACHE_DIR, { recursive: true });

const TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES ?? 3);
const RETRY_DELAY = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS ?? 400);

const PROXY =
  CONFIG.PROXY ||
  process.env.HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  null;

/************************************************************
 * PROXY SUPPORT
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
      port: Number(u.port) || 80,
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
    opts.proxy = {
      host: PARSED_PROXY.host,
      port: PARSED_PROXY.port
    };
    if (PARSED_PROXY.auth)
      opts.proxy.auth = PARSED_PROXY.auth;
  }
  return opts;
}

/************************************************************
 * HELPERS
 ************************************************************/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeSymbol(s) {
  if (!s) return "";
  return String(s)
    .replace("NSE:", "")
    .trim()
    .toUpperCase();
}

function cacheFile(symbol, tf) {
  const s = safeSymbol(symbol).replace(/[^A-Z0-9]/g, "_");
  const t = tf.replace(/[^A-Za-z0-9]/g, "_");
  return path.join(CACHE_DIR, `${s}_${t}.json`);
}

function readCache(symbol, tf) {
  const file = cacheFile(symbol, tf);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw;
  } catch {
    return null;
  }
}

function writeCache(symbol, tf, data) {
  try {
    fs.writeFileSync(
      cacheFile(symbol, tf),
      JSON.stringify({ fetchedAt: Date.now(), data }, null, 2)
    );
  } catch {}
}

function lastGoodPrice(symbol) {
  symbol = safeSymbol(symbol);
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) =>
      f.startsWith(symbol + "_")
    );
    files.sort(
      (a, b) =>
        fs.statSync(path.join(CACHE_DIR, b)).mtimeMs -
        fs.statSync(path.join(CACHE_DIR, a)).mtimeMs
    );
    for (const f of files) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(CACHE_DIR, f), "utf8")
        );
        const data = raw?.data;
        if (Array.isArray(data) && data.length) {
          const p = Number(data.at(-1).close);
          if (!isNaN(p)) return p;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/************************************************************
 * SAFE GET (Retry + Mirrors + Public Proxy Fallbacks)
 ************************************************************/
async function safeGet(url, mirrors = []) {
  // primary
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await axios.get(url, axiosOptions());
      if (r?.data) return r.data;
    } catch {}
    await sleep(RETRY_DELAY);
  }

  // mirrors
  for (const m of mirrors) {
    const rebuilt = m + url.substring(url.indexOf("/", 8));
    for (let i = 0; i < RETRIES; i++) {
      try {
        const r = await axios.get(rebuilt, axiosOptions());
        if (r?.data) return r.data;
      } catch {}
      await sleep(RETRY_DELAY);
    }
  }

  // simple external proxy
  const FALLBACKS = [
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?"
  ];

  for (const p of FALLBACKS) {
    const final = p + encodeURIComponent(url);
    try {
      const r = await axios.get(final, axiosOptions());
      if (r?.data) return r.data;
    } catch {}
  }

  return null;
}

/************************************************************
 * NORMALIZERS
 ************************************************************/
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  const out = raw.map((k) => ({
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

function normalizeYahoo(r) {
  try {
    const res = r.chart?.result?.[0];
    if (!res) return [];

    const ts = res.timestamp;
    const qt = res.indicators?.quote?.[0];
    const out = [];

    for (let i = 0; i < ts.length; i++) {
      const close = qt.close[i];
      if (!Number.isFinite(close)) continue;

      out.push({
        t: ts[i] * 1000,
        open: qt.open[i] ?? close,
        high: qt.high[i] ?? close,
        low: qt.low[i] ?? close,
        close: close,
        vol: qt.volume[i] || 0
      });
    }

    out.sort((a, b) => a.t - b.t);
    return out;
  } catch {
    return [];
  }
}

/************************************************************
 * MARKET FETCHERS
 ************************************************************/
async function fetchCrypto(symbol, tf = "15m", limit = 200) {
  symbol = safeSymbol(symbol);
  const cfg = CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO;
  const base = cfg[0];

  const url =
    base +
    `/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;

  const mirrors = cfg.slice(1);

  const raw = await safeGet(url, mirrors);
  if (Array.isArray(raw)) {
    const k = normalizeKline(raw);
    writeCache(symbol, tf, k);
    return k;
  }

  return readCache(symbol, tf)?.data || [];
}

async function fetchYahooGeneric(symbol, tf = "15m") {
  const map = {
    "1m": { interval: "1m", range: "1d" },
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "1mo" },
    "1h": { interval: "60m", range: "1mo" },
    "4h": { interval: "240m", range: "3mo" },
    "1d": { interval: "1d", range: "6mo" }
  }[tf] || { interval: "15m", range: "5d" };

  const sources =
    CONFIG.DATA_SOURCES_BY_MARKET.US_STOCKS; // Yahoo same for all

  const base = sources[0];
  const url =
    `${base}/${encodeURIComponent(symbol)}?interval=${map.interval}&range=${map.range}`;

  const raw = await safeGet(url, sources.slice(1));
  if (raw) {
    const k = normalizeYahoo(raw);
    if (k.length) {
      writeCache(symbol, tf, k);
      return k;
    }
  }

  return readCache(symbol, tf)?.data || [];
}

async function fetchNSE(symbol, tf = "15m") {
  symbol = safeSymbol(symbol).replace("NSE:", "");

  const tries = [
    symbol,
    symbol + ".NS",
    "^" + symbol
  ];

  for (const t of tries) {
    const d = await fetchYahooGeneric(t, tf);
    if (d.length) return d;
  }

  return readCache(symbol, tf)?.data || [];
}

/************************************************************
 * MASTER PRICE (Yahoo → Binance → Cache)
 ************************************************************/
export async function fetchPrice(symbol) {
  symbol = safeSymbol(symbol);
  if (!symbol) return null;

  // Yahoo 1m
  const y = await fetchYahooGeneric(symbol, "1m");
  if (y.length) return +y.at(-1).close;

  // Crypto
  if (/USDT$|BTC$/i.test(symbol)) {
    const c = await fetchCrypto(symbol, "1m", 1);
    if (c.length) return +c.at(-1).close;
  }

  // NSE
  const n = await fetchNSE(symbol, "1m");
  if (n.length) return +n.at(-1).close;

  return lastGoodPrice(symbol);
}

/************************************************************
 * UNIVERSAL FETCHER
 ************************************************************/
export async function fetchUniversal(symbol, tf = "15m") {
  symbol = safeSymbol(symbol);
  if (!symbol) return { data: [], price: null };

  const market = CONFIG.ACTIVE_MARKET?.toUpperCase() || "AUTO";
  const isCrypto = /USDT$|BTC$/i.test(symbol);
  const isCom = CONFIG.SYMBOLS.COMMODITIES.includes(symbol);

  // Forced market
  if (market === "CRYPTO" || isCrypto)
    return {
      data: await fetchCrypto(symbol, tf),
      price: await fetchPrice(symbol)
    };

  if (market === "INDIA")
    return {
      data: await fetchNSE(symbol, tf),
      price: await fetchPrice(symbol)
    };

  if (market === "COMMODITIES" || isCom)
    return {
      data: await fetchYahooGeneric(symbol, tf),
      price: await fetchPrice(symbol)
    };

  // AUTO MODE — Detect
  if (isCrypto) {
    return {
      data: await fetchCrypto(symbol, tf),
      price: await fetchPrice(symbol)
    };
  }

  if (symbol.endsWith(".NS") || CONFIG.SYMBOLS.INDIA.includes(symbol)) {
    return {
      data: await fetchNSE(symbol, tf),
      price: await fetchPrice(symbol)
    };
  }

  // Default: Yahoo (US / Forex / Commodities)
  return {
    data: await fetchYahooGeneric(symbol, tf),
    price: await fetchPrice(symbol)
  };
}

/************************************************************
 * Multi-TF Fetcher
 ************************************************************/
function pLimit(max = 2) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;

    const { fn, resolve, reject } = queue.shift();
    active++;

    Promise.resolve(fn())
      .then((res) => {
        active--;
        resolve(res);
        next();
      })
      .catch((err) => {
        active--;
        reject(err);
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  const limit = pLimit(2);

  await Promise.all(
    tfs.map((tf) =>
      limit(async () => {
        await sleep(50 + Math.random() * 100);
        out[tf] = await fetchUniversal(symbol, tf);
      })
    )
  );

  return out;
}

/************************************************************
 * Legacy Compatible fetchMarketData()
 ************************************************************/
export async function fetchMarketData(symbol, tf = "15m", limit = 200) {
  const d = await fetchCrypto(symbol, tf, limit);
  const p = await fetchPrice(symbol);

  return {
    data: d,
    price: p,
    updated: new Date().toISOString()
  };
}