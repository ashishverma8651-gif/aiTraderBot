// utils.js — FINAL CLEAN VERSION (NO duplicate exports)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ---------------------------------------------
// CONSTANTS + SETUP
// ---------------------------------------------
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;
const DEFAULT_LIMIT = 200;

const BINANCE_MIRRORS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

// ---------------------------------------------
// TIME
// ---------------------------------------------
function nowLocal() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

// ---------------------------------------------
// SAFE AXIOS (FAILOVER + MIRROR ROTATION)
// ---------------------------------------------
async function safeAxiosGet(url) {
  const list = [...BINANCE_MIRRORS];
  let lastErr = null;

  for (const base of list) {
    const tryUrl = url.replace("https://api.binance.com", base);

    try {
      const r = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "aiTraderBot" },
      });

      if (r?.status === 200) return r.data;
    } catch (e) {
      lastErr = e;
    }
  }

  return null;
}

// ---------------------------------------------
// CACHE
// ---------------------------------------------
function cachePath(symbol, tf) {
  return path.join(CACHE_DIR, `${symbol}_${tf}.json`);
}

function readCache(symbol, tf) {
  try {
    const p = cachePath(symbol, tf);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}

function writeCache(symbol, tf, data) {
  try {
    fs.writeFileSync(cachePath(symbol, tf), JSON.stringify(data));
  } catch {}
}

// ---------------------------------------------
// DATA NORMALIZATION
// ---------------------------------------------
function normalizeKlines(raw) {
  if (!Array.isArray(raw)) return [];

  return raw.map((k) => ({
    t: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    vol: Number(k[5]),
  }));
}

// ---------------------------------------------
// FETCH BINANCE CANDLES
// ---------------------------------------------
async function fetchCrypto(symbol, tf, limit = DEFAULT_LIMIT) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;

  const raw = await safeAxiosGet(url);

  if (!raw) return [];

  return normalizeKlines(raw);
}

// ---------------------------------------------
// ENSURE CANDLES (FETCH + CACHE)
// ---------------------------------------------
async function ensureCandles(symbol, tf, limit = DEFAULT_LIMIT) {
  const fresh = await fetchCrypto(symbol, tf, limit);
  if (fresh.length) {
    writeCache(symbol, tf, fresh);
    return fresh;
  }
  return readCache(symbol, tf);
}

// ---------------------------------------------
// INDICATORS
// ---------------------------------------------
function computeRSI(c, len = 14) {
  if (c.length < len + 1) return 50;

  let gains = 0,
    losses = 0;

  for (let i = c.length - len - 1; i < c.length - 1; i++) {
    const diff = c[i + 1].close - c[i].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const rs = (gains / len) / ((losses || 0.0001) / len);
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function ema(arr, p) {
  const k = 2 / (p + 1);
  let prev = arr[0];
  return arr.map((v) => (prev = v * k + prev * (1 - k)));
}

function computeMACD(c) {
  if (c.length < 35) return { hist: 0, line: 0, signal: 0 };
  const closes = c.map((x) => x.close);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = ema(line, 9);
  const hist = line.at(-1) - sig.at(-1);

  return {
    hist: Number(hist.toFixed(6)),
    line: Number(line.at(-1).toFixed(6)),
    signal: Number(sig.at(-1).toFixed(6)),
  };
}

function computeATR(c, len = 14) {
  if (c.length < len + 1) return 0;

  let trs = [];
  for (let i = c.length - len; i < c.length; i++) {
    const cur = c[i];
    const prev = c[i - 1];

    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }

  return Number((trs.reduce((a, b) => a + b) / trs.length).toFixed(2));
}

function priceTrend(c) {
  if (c.length < 2) return "FLAT";
  if (c.at(-1).close > c.at(-2).close) return "UP";
  if (c.at(-1).close < c.at(-2).close) return "DOWN";
  return "FLAT";
}

function volumeTrend(c) {
  if (c.length < 2) return "STABLE";
  if (c.at(-1).vol > c.at(-2).vol) return "INCREASING";
  if (c.at(-1).vol < c.at(-2).vol) return "DECREASING";
  return "STABLE";
}

// ---------------------------------------------
// FULL INDICATOR BUNDLE
// ---------------------------------------------
function calculateIndicators(c) {
  return {
    RSI: computeRSI(c),
    MACD: computeMACD(c),
    ATR: computeATR(c),
    priceTrend: priceTrend(c),
    volumeTrend: volumeTrend(c),
  };
}

// ---------------------------------------------
// FIB LEVELS
// ---------------------------------------------
function computeFibLevels(c) {
  if (!c.length) return null;

  const high = Math.max(...c.map((x) => x.high));
  const low = Math.min(...c.map((x) => x.low));
  const diff = high - low;

  return {
    high,
    low,
    levels: {
      "0.236": high - diff * 0.236,
      "0.382": high - diff * 0.382,
      "0.5": high - diff * 0.5,
      "0.618": high - diff * 0.618,
      "0.786": high - diff * 0.786,
    },
  };
}

// ---------------------------------------------
// SIGNAL
// ---------------------------------------------
function deriveSignalFromIndicators(i) {
  let score = 0;

  if (i.RSI < 30) score++;
  if (i.RSI > 70) score--;
  if (i.MACD.hist > 0) score++;
  if (i.MACD.hist < 0) score--;
  if (i.priceTrend === "UP") score++;
  if (i.priceTrend === "DOWN") score--;

  if (score >= 2) return "BUY";
  if (score <= -2) return "SELL";
  return "NEUTRAL";
}

// ---------------------------------------------
// FETCH MARKET DATA (1 TF)
// ---------------------------------------------
async function fetchMarketData(symbol, tf, limit = DEFAULT_LIMIT) {
  const c = await ensureCandles(symbol, tf, limit);

  return {
    data: c,
    indicators: calculateIndicators(c),
    fib: computeFibLevels(c),
    price: c.at(-1)?.close || 0,
    volume: c.at(-1)?.vol || 0,
    updated: nowLocal(),
  };
}

// ---------------------------------------------
// MULTI TF
// ---------------------------------------------
async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m", "30m", "1h"]) {
  const out = {};
  for (const tf of tfs) {
    out[tf] = await fetchMarketData(symbol, tf);
  }
  return out;
}

// ---------------------------------------------
// FINAL EXPORT (ONLY ONE PLACE) 🔥
// ---------------------------------------------
export {
  nowLocal,
  safeAxiosGet,
  fetchCrypto,
  ensureCandles,
  fetchMarketData,
  fetchMultiTF,
  computeRSI,
  computeMACD,
  computeATR,
  priceTrend,
  volumeTrend,
  calculateIndicators,
  computeFibLevels,
  deriveSignalFromIndicators,
};