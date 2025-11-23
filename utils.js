// ================================
// utils.js — FINAL FULL VERSION
// ================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 12000;

// =====================================================
// CACHE HELPERS
// =====================================================
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

// =====================================================
// SAFE MULTI-SOURCE GET (CRYPTO MIRRORS)
// =====================================================
async function safeAxiosGet(url, mirrors = []) {
  let lastErr = null;

  if (!mirrors || mirrors.length === 0) mirrors = [url];

  for (const base of mirrors) {
    try {
      let finalUrl = url;

      if (base.startsWith("http") && url.includes("api.binance.com")) {
        finalUrl = url.replace("https://api.binance.com", base);
      }

      const res = await axios.get(finalUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "aiTrader/1.0" },
        proxy: CONFIG.PROXY ? false : undefined
      });

      if (res && res.data) return res.data;
    } catch (e) {
      lastErr = e;
    }
  }

  return null;
}

// =====================================================
// NORMALIZE BINANCE KLINES
// =====================================================
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(k => ({
      t: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      vol: +k[5]
    }))
    .filter(x => Number.isFinite(x.close));
}

// =====================================================
// 1) CRYPTO FETCH (BINANCE + MIRRORS)
// =====================================================
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const mirrors = [
    ...(CONFIG.DATA_SOURCES.BINANCE || []),
    ...(CONFIG.DATA_SOURCES.BYBIT || []),
    ...(CONFIG.DATA_SOURCES.KUCOIN || []),
    ...(CONFIG.DATA_SOURCES.COINBASE || [])
  ];

  const raw = await safeAxiosGet(url, mirrors);
  if (!raw) return [];
  return normalizeKline(raw);
}

// =====================================================
// 2) NSE MULTI-SOURCE FETCH  (BEST + FALLBACK CHAIN)
// =====================================================
async function fetchNSE(symbol = "") {
  symbol = symbol.toUpperCase();

  const sources = [
    // 1) RAPIDAPI (BEST LIVE PRICE)
    async () => {
      if (!process.env.RAPIDAPI_KEY) return [];
      const url = `https://latest-stock-price.p.rapidapi.com/price?Indices=${symbol}`;
      const res = await axios.get(url, {
        timeout: AXIOS_TIMEOUT,
        headers: {
          "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
          "X-RapidAPI-Host": "latest-stock-price.p.rapidapi.com",
        }
      });
      const raw = res.data || [];
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const p = Number(raw[0].lastPrice || raw[0].ltp);
      if (!p) return [];

      return [{
        t: Date.now(),
        open: p,
        high: p,
        low: p,
        close: p,
        vol: 0
      }];
    },

    // 2) YAHOO FINANCE
    async () => {
      const yahooSymbol =
        symbol === "NIFTY50" ? "^NSEI" :
        symbol === "BANKNIFTY" ? "^NSEBANK" : null;

      if (!yahooSymbol) return [];

      const url = `${CONFIG.DATA_SOURCES.YAHOO[0]}/${yahooSymbol}?interval=15m&range=1d`;
      const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

      const result = res.data?.chart?.result?.[0];
      if (!result) return [];

      const t = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const close = q.close || [];

      const out = [];
      for (let i = 0; i < t.length; i++) {
        if (!Number.isFinite(close[i])) continue;
        out.push({
          t: t[i] * 1000,
          open: close[i],
          high: close[i],
          low: close[i],
          close: close[i],
          vol: 0
        });
      }
      return out;
    },

    // 3) ORIGINAL NSE API
    async () => {
      try {
        const base = CONFIG.DATA_SOURCES.NSE?.[0];
        if (!base) return [];

        const url = `${base}/chart-databyindex?index=${symbol}`;
        const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

        const raw = res.data?.grapthData || [];
        if (!Array.isArray(raw)) return [];

        return raw.map(c => ({
          t: c.time * 1000,
          open: +c.open,
          high: +c.high,
          low: +c.low,
          close: +(c.price || c.close),
          vol: Number(c.volume || 0)
        }));
      } catch {
        return [];
      }
    }
  ];

  for (const fn of sources) {
    try {
      const data = await fn();
      if (data.length > 0) return data;
    } catch {}
  }

  return [];
}

// =====================================================
// 3) YAHOO FETCH
// =====================================================
async function fetchYahoo(symbol = "") {
  try {
    const url = `${CONFIG.DATA_SOURCES.YAHOO[0]}/${symbol}?interval=15m&range=5d`;
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

    const result = res.data?.chart?.result?.[0];
    if (!result) return [];

    const t = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};

    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(q.close?.[i])) continue;
      out.push({
        t: t[i] * 1000,
        open: +q.open[i],
        high: +q.high[i],
        low: +q.low[i],
        close: +q.close[i],
        vol: Number(q.volume[i] || 0)
      });
    }
    return out;
  } catch {
    return [];
  }
}

// =====================================================
// EXPORT: fetchMarketData (CRYPTO + CACHE)
// =====================================================
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  symbol = String(symbol || "").toUpperCase();
  let data = readCache(symbol, interval);

  try {
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (fresh.length > 0) {
      writeCache(symbol, interval, fresh);
      data = fresh;
    }
  } catch {}

  const last = data.at(-1) || {};
  return {
    data,
    price: +last.close || 0,
    volume: +last.vol || 0,
    updated: new Date().toISOString()
  };
}

// =====================================================
// EXPORT: fetchMultiTF
// =====================================================
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};
  await Promise.all(
    tfs.map(async tf => {
      try {
        out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT);
      } catch {
        out[tf] = { data: [], price: 0 };
      }
    })
  );
  return out;
}

// =====================================================
// EXPORT: fetchUniversal (AUTO ROUTING)
// =====================================================
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // CRYPTO
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return await fetchMarketData(symbol, interval, CONFIG.DEFAULT_LIMIT);
  }

  // NSE INDICES
  if (CONFIG.MARKETS.INDIA.INDEXES.includes(symbol)) {
    const data = await fetchNSE(symbol);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // YAHOO STOCKS / FOREX
  const yahoo = await fetchYahoo(symbol);
  if (yahoo.length > 0) {
    return {
      data: yahoo,
      price: yahoo.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}