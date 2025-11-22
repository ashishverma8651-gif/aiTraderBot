// utils.js — MULTI-MARKET VERSION (Crypto + NSE + Yahoo + Forex)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

// ======================================================
// Cache Helpers
// ======================================================
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ======================================================
// safeAxiosGet — multi-source
// ======================================================
async function safeAxiosGet(url, bases = [], options = {}) {
  let lastErr = null;

  for (const base of bases) {
    try {
      const fixedURL = url.replace("https://api.binance.com", base);

      const res = await axios.get(fixedURL, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG.PROXY || false,
        headers: {
          "User-Agent": "aiTraderBot/1.0",
          Accept: "application/json"
        },
        ...options
      });

      if (res && res.status === 200) return res.data;

    } catch (e) {
      lastErr = e;
    }
  }

  return null;
}

// ======================================================
// Normalizer (Crypto Klines)
// ======================================================
function normalizeKline(raw) {
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
    .filter(c => Number.isFinite(c.close));
}

// ======================================================
// CRYPTO FETCH
// ======================================================
export async function fetchCrypto(symbol, interval, limit = 200) {

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const bases = [
    ...CONFIG.DATA_SOURCES.BINANCE,
    ...CONFIG.DATA_SOURCES.BYBIT,
    ...CONFIG.DATA_SOURCES.KUCOIN
  ];

  const raw = await safeAxiosGet(url, bases);

  if (!raw) return [];
  return normalizeKline(raw);
}

// ======================================================
// UPDATED NSE FETCH (NEW WORKING ENDPOINT)
// ======================================================
async function fetchNSE(symbol) {
  try {
    const url = `https://www.nseindia.com/api/market-data-pre-open?key=${symbol}`;

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        Referer: "https://www.nseindia.com"
      },
      timeout: AXIOS_TIMEOUT
    });

    const arr = res.data?.data || [];
    if (!arr.length) return [];

    return arr.map(x => ({
      t: Date.now(),
      open: x.iOpen,
      high: x.iHigh,
      low: x.iLow,
      close: x.iClose,
      vol: x.totalTradedVolume || 0
    }));

  } catch {
    return [];
  }
}

// ======================================================
// YAHOO FINANCE (Index + US Stocks + Indian Stocks)
// ======================================================
async function fetchYahoo(symbol, interval = "15m", range = "5d") {
  try {
    const url = `${CONFIG.DATA_SOURCES.YAHOO[0]}/${symbol}?interval=${interval}&range=${range}`;

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

    const raw = res.data?.chart?.result?.[0];
    if (!raw) return [];

    const { timestamp, indicators } = raw;
    const ohlc = indicators?.quote?.[0] || {};

    return timestamp.map((t, i) => ({
      t: t * 1000,
      open: ohlc.open[i],
      high: ohlc.high[i],
      low: ohlc.low[i],
      close: ohlc.close[i],
      vol: ohlc.volume[i] || 0
    })).filter(x => x.close);

  } catch {
    return [];
  }
}

// ======================================================
// UNIVERSAL FETCHER — FIXED MARKET DETECTION
// ======================================================
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // 1) NSE FIRST (fix)
  if (CONFIG.MARKETS.INDIA.INDEXES.includes(symbol)) {
    const data = await fetchNSE(symbol);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // 2) Crypto
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    const data = await fetchCrypto(symbol, interval);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // 3) Yahoo (stocks + indices)
  const yahoo = await fetchYahoo(symbol, interval);
  if (yahoo.length) {
    return {
      data: yahoo,
      price: yahoo.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}

// ======================================================
// CACHING (Crypto-only)
// ======================================================
export async function ensureCandles(symbol, interval, limit = 200) {
  const cached = readCache(symbol, interval);

  try {
    const fresh = await fetchCrypto(symbol, interval, limit);

    if (fresh && fresh.length > 0) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }

    return cached;

  } catch {
    return cached;
  }
}

// ======================================================
// Multi-Timeframe
// ======================================================
export async function fetchMultiTF(symbol, tfs) {
  const out = {};

  await Promise.all(
    tfs.map(async (tf) => {
      const m = await fetchUniversal(symbol, tf);
      out[tf] = m;
    })
  );

  return out;
}