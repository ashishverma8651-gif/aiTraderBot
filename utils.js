// ================================
// utils.js — FINAL FULL FIXED VERSION (LIVE MARKET)
// ================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// --------------------------------
// CACHE DIRECTORY
// --------------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --------------------------------
// CACHE HELPERS (Currently unused in fetch functions, but kept for future use)
// --------------------------------
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch { return []; }
}
function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// --------------------------------
// TIMEFRAMES MAP
// --------------------------------
const TF_MAP = {
  "1m":  { interval: "1m",   range: "1d" },
  "5m":  { interval: "5m",   range: "5d" },
  "15m": { interval: "15m",  range: "5d" },
  "30m": { interval: "30m",  range: "1mo" },
  "1h":  { interval: "60m",  range: "1mo" },
  "4h":  { interval: "240m", range: "3mo" },
  "1d":  { interval: "1d",   range: "6mo" }
};

function tfToMs(tf) {
  if (tf.endsWith("m")) return parseInt(tf) * 60 * 1000;
  if (tf.endsWith("h")) return parseInt(tf) * 60 * 60 * 1000;
  if (tf.endsWith("d")) return parseInt(tf) * 24 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

// --------------------------------
// SYMBOL MAP
// --------------------------------
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

// --------------------------------
// SAFE GET + MIRRORS
// --------------------------------
async function safeGet(url, mirrors = [], timeout = AXIOS_TIMEOUT) {
  for (let a = 0; a < RETRY_ATTEMPTS; a++) {
    try {
      const r = await axios.get(url, { timeout });
      if (r?.data) return r.data;
    } catch {
      if (a < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
    }
  }
  for (const mirror of mirrors) {
    if (!mirror) continue;
    let final = url;
    try {
      const u = new URL(url);
      final = mirror.replace(/\/+$/, "") + u.pathname + u.search;
    } catch {}
    for (let a = 0; a < RETRY_ATTEMPTS; a++) {
      try {
        const r = await axios.get(final, { timeout });
        if (r?.data) return r.data;
      } catch {
        if (a < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return null;
}

// --------------------------------
// BINANCE DATA NORMALIZATION
// --------------------------------
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({
    t: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    vol: +k[5]
  }));
}

// --------------------------------
// CRYPTO FETCH
// --------------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  console.log(`[UTILS-DEBUG] Fetching Crypto: ${symbol} @ ${interval}. URL: ${url}`); // 🔥 DEBUG LOG
  const mirrors = CONFIG.DATA_SOURCES?.BINANCE || [];
  const raw = await safeGet(url, mirrors);
  if (!raw) {
    console.warn(`[UTILS-DEBUG] WARNING: No data returned for ${symbol} @ ${interval} (Binance)`); // 🔥 DEBUG LOG
    return [];
  }
  return normalizeKline(raw);
}

// --------------------------------
// YAHOO FETCH (Forex / Commodity / Global Indices)
// --------------------------------
async function fetchYahoo(symbol, interval = "15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart";
    const url = `${base}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;
    
    console.log(`[UTILS-DEBUG] Fetching Yahoo: ${symbol} @ ${interval} (${tf.interval}). URL: ${url}`); // 🔥 DEBUG LOG

    const res = await safeGet(url);
    const r = res?.chart?.result?.[0];
    if (!r) {
      console.warn(`[UTILS-DEBUG] WARNING: No result found in Yahoo data for ${symbol} @ ${interval}`); // 🔥 DEBUG LOG
      return [];
    }

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
        vol: q.volume?.[i] || 0
      });
    }
    
    console.log(`[UTILS-DEBUG] Yahoo Data Count for ${symbol} @ ${interval}: ${out.length}`); // 🔥 DEBUG LOG
    return out;

  } catch (error) {
    console.error(`[UTILS-DEBUG] fetchYahoo Error for ${symbol} @ ${interval}:`, error.message); // 🔥 DEBUG LOG
    return [];
  }
}

// --------------------------------
// NSE FETCH
// --------------------------------
async function fetchNSE(symbol, interval = "15m") {
  const mapped = SYMBOL_EQUIV[symbol];
  if (mapped?.startsWith("^")) {
    const d = await fetchYahoo(mapped, interval); // Passes interval to fetchYahoo
    if (d.length) return d;
  }
  return [];
}

// --------------------------------
// fetchMarketData (Crypto only)
// --------------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  try {
    const data = await fetchCrypto(symbol, interval, limit); // Passes interval to fetchCrypto
    const last = data.at(-1) || {};
    return {
      data,
      price: +last.close || 0,
      updated: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[UTILS-DEBUG] fetchMarketData error:`, error.message);
    return { data: [], price: 0 };
  }
}

// --------------------------------
// fetchUniversal — MASTER FIXED ROUTER
// --------------------------------
export async function fetchUniversal(symbol, interval = "15m") {
  try {
    if (!symbol) return { data: [], price: 0 };
    symbol = symbol.toUpperCase();

    const mapped = SYMBOL_EQUIV[symbol] || null;

    // FIXED: REAL CRYPTO DETECTION
    const CRYPTO_SUFFIX = ["USDT", "BTC"];
    const isCrypto =
      CRYPTO_SUFFIX.some(sfx => symbol.endsWith(sfx)) &&
      !CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol) &&
      (!mapped || !mapped.startsWith("^"));

    // CRYPTO RAW
    if (isCrypto) {
      const x = await fetchMarketData(symbol, interval);
      return { data: x.data, price: x.price };
    }

    // NSE INDIA INDEX
    if (CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol)) {
      const d = await fetchNSE(symbol, interval);
      return { data: d, price: d.at(-1)?.close || 0 };
    }

    // YAHOO (Forex / Commodities / Global)
    const y1 = await fetchYahoo(mapped || symbol, interval);
    if (y1.length) return { data: y1, price: y1.at(-1).close };

    return { data: [], price: 0 };

  } catch (error) {
    console.error(`[UTILS-DEBUG] fetchUniversal main error:`, error.message);
    return { data: [], price: 0 };
  }
}

// --------------------------------
// MULTI-TF FETCHER
// --------------------------------
export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  await Promise.all(tfs.map(async tf => {
    out[tf] = await fetchUniversal(symbol, tf); // Passes TF correctly
  }));
  return out;
}

