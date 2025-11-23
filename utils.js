// ================================
// utils.js — FINAL FIXED v2.5
// ================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ----------------------------------------------------------------
// CACHE SYSTEM
// ----------------------------------------------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 12000;
const RETRY_ATTEMPTS = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const file = cachePath(symbol, interval);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, "utf8") || "[]");
  } catch { return []; }
}
function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ----------------------------------------------------------------
// TF MAP
// ----------------------------------------------------------------
const TF_MAP = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "30m": { interval: "30m", range: "1mo" },
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "240m", range: "3mo" },
  "1d": { interval: "1d", range: "6mo" }
};

// ----------------------------------------------------------------
// SYMBOL MAP
// ----------------------------------------------------------------
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

  NIFTY50: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "FINNIFTY",
};

// ----------------------------------------------------------------
// safeGet
// ----------------------------------------------------------------
async function safeGet(url, timeout = AXIOS_TIMEOUT) {
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      const r = await axios.get(url, {
        timeout,
        headers: { "User-Agent": "Mozilla" }
      });
      return r.data;
    } catch {
      if (i < RETRY_ATTEMPTS - 1) await sleep(300);
    }
  }
  return null;
}

// ----------------------------------------------------------------
// Crypto fetch (Binance)
// ----------------------------------------------------------------
function normalizeKline(raw) {
  return raw.map(k => ({
    t: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    vol: +k[5]
  }));
}

async function fetchCrypto(symbol, interval="15m", limit=200) {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const raw = await safeGet(url);
  if (!raw || !Array.isArray(raw)) return [];

  return normalizeKline(raw);
}

// ----------------------------------------------------------------
// Yahoo fetch
// ----------------------------------------------------------------
async function fetchYahoo(symbol, interval="15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${tf.interval}&range=${tf.range}`;

    const data = await safeGet(url);
    const r = data?.chart?.result?.[0];
    if (!r) return [];

    const t = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};

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

// ----------------------------------------------------------------
// ✔ Official NSE Live Intraday (Real fix for BANKNIFTY, NIFTY, FINNIFTY)
// ----------------------------------------------------------------
async function fetchNSEOfficial(symbol) {
  try {
    const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;
    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      headers: { "User-Agent": "Mozilla" }
    });

    const raw = res.data.grapthData || [];

    return raw.map(([t, close]) => ({
      t,
      open: close,
      high: close,
      low: close,
      close,
      vol: 0
    }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------
// UNIVERSAL ROUTER
// ----------------------------------------------------------------
export async function fetchUniversal(symbol, interval="15m") {
  try {
    if (!symbol) return { data: [], price: 0 };
    symbol = symbol.toUpperCase();

    // Crypto
    if (symbol.endsWith("USDT") || symbol.endsWith("USD") || symbol.endsWith("BTC")) {
      const data = await fetchCrypto(symbol, interval);
      return { data, price: data.at(-1)?.close || 0 };
    }

    // INDIA INDEXES — OFFICIAL NSE FIRST
    if (["NIFTY50", "BANKNIFTY", "FINNIFTY"].includes(symbol)) {
      let d = await fetchNSEOfficial(symbol);

      // fallback yahoo if empty
      if (!d.length) {
        const yahooSymbol = SYMBOL_EQUIV[symbol];
        d = await fetchYahoo(yahooSymbol, interval);
      }

      return { data: d, price: d.at(-1)?.close || 0 };
    }

    // Forex + Commodities + Global
    const mapped = SYMBOL_EQUIV[symbol] || symbol;
    let yd = await fetchYahoo(mapped, interval);

    if (!yd.length) yd = await fetchYahoo(symbol, interval);

    return { data: yd, price: yd.at(-1)?.close || 0 };

  } catch {
    return { data: [], price: 0 };
  }
}

// ----------------------------------------------------------------
// Multi-timeframe
// ----------------------------------------------------------------
export async function fetchMultiTF(symbol, tfs=["5m","15m","1h"]) {
  const out = {};
  for (const tf of tfs) {
    out[tf] = await fetchUniversal(symbol, tf);
  }
  return out;
}