// ================================
// utils.js — FINAL FIXED VERSION (FOREX + COMMODITIES WORKING)
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
// SAFE MULTI-SOURCE GET
// =====================================================
async function safeAxiosGet(url, mirrors = []) {
  let lastErr = null;
  if (!mirrors || mirrors.length === 0) mirrors = [url];

  for (const base of mirrors) {
    try {
      const finalUrl = base.startsWith("http")
        ? url.replace("https://api.binance.com", base)
        : url;

      const res = await axios.get(finalUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "aiTrader/1.0" }
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
// TF MAP
// =====================================================
const TF_MAP = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "60m", range: "3mo" },
  "1d": { interval: "1d", range: "6mo" }
};

// =====================================================
// TF BUILD FROM RAW NSE DATA
// =====================================================
function tfToMs(tf) {
  const n = parseInt(tf);
  if (tf.endsWith("m")) return n * 60 * 1000;
  if (tf.endsWith("h")) return n * 60 * 60 * 1000;
  if (tf.endsWith("d")) return n * 24 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function buildTF(candles, tfMs) {
  if (!candles.length) return [];

  const out = [];
  let bucketStart = Math.floor(candles[0].t / tfMs) * tfMs;
  let bucket = {
    t: bucketStart,
    open: candles[0].open,
    high: -999999,
    low: 999999,
    close: candles[0].close,
    vol: 0
  };

  for (const c of candles) {
    const ts = Math.floor(c.t / tfMs) * tfMs;

    if (ts !== bucketStart) {
      out.push({ ...bucket });
      bucketStart = ts;
      bucket = { t: ts, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol };
      continue;
    }

    bucket.high = Math.max(bucket.high, c.high);
    bucket.low = Math.min(bucket.low, c.low);
    bucket.close = c.close;
    bucket.vol += Number(c.vol || 0);
  }

  out.push(bucket);
  return out;
}

// =====================================================
// CRYPTO FETCH
// =====================================================
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeAxiosGet(url, CONFIG.DATA_SOURCES.BINANCE || []);
  if (!raw) return [];
  return normalizeKline(raw);
}

// =====================================================
// NSE FETCH
// =====================================================
async function fetchNSE(symbol, interval = "15m") {
  const tfMs = tfToMs(interval);

  try {
    const yahoo = await fetchYahoo(symbol, interval);
    if (yahoo.length > 0) return yahoo.map(c => ({ ...c, t: c.t }));
  } catch {}

  return [];
}

// =====================================================
// YAHOO FETCH (FIXED URL)
// =====================================================
async function fetchYahoo(symbol, interval = "15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
      `?interval=${tf.interval}&range=${tf.range}`;

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    const result = res.data?.chart?.result?.[0];
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
  } catch (err) {
    return [];
  }
}

// =====================================================
// EXPORT: fetchMarketData
// =====================================================
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
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
export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  await Promise.all(
    tfs.map(async (tf) => {
      const d = await fetchUniversal(symbol, tf);
      out[tf] = d;
    })
  );
  return out;
}

// =====================================================
// EXPORT: fetchUniversal (AUTO ROUTER)
// =====================================================
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // CRYPTO
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return await fetchMarketData(symbol, interval);
  }

  // YAHOO (FOREX / COMMODITY / US STOCKS)
  const yahoo = await fetchYahoo(symbol, interval);
  if (yahoo.length > 0) {
    return {
      data: yahoo,
      price: yahoo.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}