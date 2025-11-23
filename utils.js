// ================================
// utils.js — FINAL FIXED VERSION (FOREX + COMMODITIES WORKING)
// ================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

// -------------------------------
// Helpers
// -------------------------------
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------------------
// Timeframe helpers
// -------------------------------
const TF_MAP = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "60m", range: "3mo" },
  "1d": { interval: "1d", range: "6mo" }
};
function tfToMs(tf) {
  if (!tf || typeof tf !== "string") return 15 * 60 * 1000;
  const n = parseInt(tf, 10) || 15;
  if (tf.endsWith("m")) return n * 60 * 1000;
  if (tf.endsWith("h")) return n * 60 * 60 * 1000;
  if (tf.endsWith("d")) return n * 24 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}
function buildTF(candles, tfMs) {
  if (!candles || !candles.length) return [];
  const out = [];
  let bucketStart = Math.floor(candles[0].t / tfMs) * tfMs;
  let bucket = {
    t: bucketStart,
    open: candles[0].open,
    high: candles[0].high ?? candles[0].open,
    low: candles[0].low ?? candles[0].open,
    close: candles[0].close,
    vol: candles[0].vol || 0
  };
  for (const c of candles) {
    const ts = Math.floor(c.t / tfMs) * tfMs;
    if (ts !== bucketStart) {
      out.push({ ...bucket });
      bucketStart = ts;
      bucket = { t: ts, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol || 0 };
      continue;
    }
    bucket.high = Math.max(bucket.high, c.high);
    bucket.low = Math.min(bucket.low, c.low);
    bucket.close = c.close;
    bucket.vol = (bucket.vol || 0) + (c.vol || 0);
  }
  out.push(bucket);
  return out;
}

// -------------------------------
// Symbol mapping for Yahoo etc.
// -------------------------------
const SYMBOL_EQUIV = {
  // Commodities (Yahoo)
  GOLD: "GC=F",
  XAUUSD: "GC=F",
  SILVER: "SI=F",
  XAGUSD: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",
  // Forex / FX pairs on Yahoo
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  // Indices (Yahoo)
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY"
};

// -------------------------------
// Safe GET with retries + mirror support
// - tries url first, then tries mirrors (if provided).
// - for binance endpoints, mirrors replace host
// -------------------------------
async function safeGet(url, mirrors = [], timeout = AXIOS_TIMEOUT) {
  // try direct first
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get(url, { timeout });
      if (res && res.data) return res.data;
    } catch (e) {
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      else break;
    }
  }

  // try mirrors
  for (const base of mirrors || []) {
    if (!base) continue;
    // if original url contains binance host, replace
    try {
      let final = url;
      try {
        const u = new URL(url);
        const path = u.pathname + (u.search || "");
        if (base.startsWith("http")) {
          // if base looks like a host+protocol, try base + path
          final = base.replace(/\/+$/, "") + path;
        } else {
          final = url;
        }
      } catch {
        final = url;
      }

      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        try {
          const res = await axios.get(final, { timeout });
          if (res && res.data) return res.data;
        } catch (e) {
          if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
        }
      }
    } catch (e) {
      // continue to next mirror
    }
  }

  return null;
}

// -------------------------------
// Binance klines normalizer
// -------------------------------
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

// -------------------------------
// Fetch crypto klines (Binance + mirrors from config)
// -------------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const mirrors = CONFIG.DATA_SOURCES?.BINANCE || [];
  const raw = await safeGet(url, mirrors);
  if (!raw) return [];
  return normalizeKline(raw);
}

// -------------------------------
// Fetch Yahoo (dynamic TF support)
// - symbol should be Yahoo-style (e.g. EURUSD=X, GC=F, ^NSEI)
// -------------------------------
async function fetchYahoo(symbol, interval = "15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    // Yahoo endpoint accepts symbol directly
    const url = `${CONFIG.DATA_SOURCES?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart"}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;
    const res = await safeGet(url, [], AXIOS_TIMEOUT);
    if (!res) return [];
    const result = res?.chart?.result?.[0];
    if (!result) return [];

    const t = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) continue;
      out.push({
        t: t[i] * 1000,
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        vol: q.volume?.[i] || 0
      });
    }
    return out;
  } catch {
    return [];
  }
}

// -------------------------------
// NSE fetch helper (NIFTY / BANKNIFTY)
// - prefer Yahoo mapped symbols.
// - optionally RapidAPI rapid fallback if configured.
// -------------------------------
async function fetchNSE(symbol, interval = "15m") {
  const mapped = SYMBOL_EQUIV[symbol] || null;
  if (mapped && mapped.startsWith("^")) {
    // use Yahoo
    const out = await fetchYahoo(mapped, interval);
    if (out.length > 0) return out;
  }

  // RapidAPI fallback (if API key present)
  try {
    if (process.env.RAPIDAPI_KEY) {
      const url = `https://latest-stock-price.p.rapidapi.com/price?Indices=${symbol}`;
      const res = await axios.get(url, {
        timeout: AXIOS_TIMEOUT,
        headers: {
          "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
          "X-RapidAPI-Host": "latest-stock-price.p.rapidapi.com"
        }
      });
      const raw = res.data || [];
      if (Array.isArray(raw) && raw.length) {
        const p = Number(raw[0].lastPrice || raw[0].ltp);
        if (Number.isFinite(p)) {
          return [{ t: Date.now(), open: p, high: p, low: p, close: p, vol: 0 }];
        }
      }
    }
  } catch {}

  // last-resort: return empty
  return [];
}

// -------------------------------
// Main exported: fetchMarketData (crypto, cached) — unchanged shape
// -------------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  try {
    symbol = String(symbol || "").toUpperCase();
    let data = readCache(symbol, interval) || [];

    // only attempt crypto fetch for binance-style symbols (USDT/USDC etc)
    if (symbol.endsWith("USDT") || symbol.endsWith("BTC") || symbol.endsWith("USD")) {
      try {
        const fresh = await fetchCrypto(symbol, interval, limit);
        if (Array.isArray(fresh) && fresh.length > 0) {
          writeCache(symbol, interval, fresh);
          data = fresh;
        }
      } catch {}
    }

    const last = data.at(-1) || {};
    return {
      data,
      price: +last.close || 0,
      volume: +last.vol || 0,
      updated: new Date().toISOString()
    };
  } catch {
    return { data: [], price: 0, volume: 0, updated: new Date().toISOString() };
  }
}

// -------------------------------
// fetchMultiTF - returns object with TF keys
// -------------------------------
export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  await Promise.all(tfs.map(async (tf) => {
    try {
      out[tf] = await fetchUniversal(symbol, tf);
    } catch {
      out[tf] = { data: [], price: 0, updated: new Date().toISOString() };
    }
  }));
  return out;
}

// -------------------------------
// fetchUniversal - routes symbol to appropriate fetcher
// returns { data: [], price: num, updated }
// -------------------------------
export async function fetchUniversal(symbol, interval = "15m") {
  try {
    if (!symbol) return { data: [], price: 0, updated: new Date().toISOString() };
    symbol = String(symbol).toUpperCase();

    // Resolve known equivalents
    const mapped = SYMBOL_EQUIV[symbol] || symbol;

    // CRYPTO detection (simple heuristic)
    if (symbol.endsWith("USDT") || symbol.endsWith("BTC") || symbol.endsWith("ETH")) {
      const res = await fetchMarketData(symbol, interval, CONFIG.DEFAULT_LIMIT);
      return { data: res.data || [], price: res.price || 0, updated: res.updated || new Date().toISOString() };
    }

    // NSE indices (NIFTY/BANKNIFTY) - use fetchNSE
    if (Array.isArray(CONFIG.MARKETS?.INDIA?.INDEXES) && CONFIG.MARKETS.INDIA.INDEXES.includes(symbol)) {
      const data = await fetchNSE(symbol, interval);
      return { data, price: data.at(-1)?.close || 0, updated: new Date().toISOString() };
    }

    // Yahoo-capable (Forex, Commodities, Stocks, Indices)
    // Use mapped symbol if available (e.g. GOLD -> GC=F)
    const yahooSymbol = mapped;
    const yahooData = await fetchYahoo(yahooSymbol, interval);
    if (yahooData && yahooData.length) {
      return { data: yahooData, price: yahooData.at(-1)?.close || 0, updated: new Date().toISOString() };
    }

    // fallback: try raw symbol on Yahoo too
    const rawYahoo = await fetchYahoo(symbol, interval);
    if (rawYahoo && rawYahoo.length) {
      return { data: rawYahoo, price: rawYahoo.at(-1)?.close || 0, updated: new Date().toISOString() };
    }

    return { data: [], price: 0, updated: new Date().toISOString() };
  } catch {
    return { data: [], price: 0, updated: new Date().toISOString() };
  }
}