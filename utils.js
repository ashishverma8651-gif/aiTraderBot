// ===============================
// utils.js — FINAL FIXED v1.2
// ===============================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ===============================
// CONSTANTS
// ===============================

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;
const DEFAULT_LIMIT = 200;
const DEFAULT_INTERVAL = "15m";

const BINANCE_MIRRORS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

// ===============================
// HELPERS
// ===============================

function nowLocal() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ===============================
// SAFE AXIOS (proxy + failover)
// ===============================

async function safeAxiosGet(url, options = {}) {
  const sources = [...BINANCE_MIRRORS, url];
  let lastErr = null;

  for (const base of sources) {
    let tryUrl = url;

    try {
      if (base.startsWith("http")) {
        tryUrl = url.replace("https://api.binance.com", base);
      }
    } catch {}

    try {
      const res = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG?.PROXY || false,
        headers: {
          "User-Agent": CONFIG?.USER_AGENT || "aiTraderBot",
          Accept: "application/json",
        },
        ...options,
      });

      if (res && res.status === 200) return res.data;
    } catch (e) {
      lastErr = e;
    }
  }

  console.warn("safeAxiosGet failed:", lastErr?.message);
  return null;
}

// ===============================
// NORMALIZER
// ===============================

function normalizeKlineArray(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((k) => ({
      t: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      vol: Number(k[5]),
    }))
    .filter((c) => Number.isFinite(c.close));
}

// ===============================
// FETCH CRYPTO
// ===============================

async function fetchCrypto(symbol = "BTCUSDT", interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT) {
  const base = "https://api.binance.com";
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeAxiosGet(url);
  return raw ? normalizeKlineArray(raw) : [];
}

// ===============================
// CACHE HANDLER
// ===============================

async function ensureCandles(symbol, interval, limit) {
  const cached = readCache(symbol, interval);
  const fresh = await fetchCrypto(symbol, interval, limit);

  if (fresh?.length) {
    writeCache(symbol, interval, fresh);
    return fresh;
  }

  return cached;
}

// ===============================
// INDICATORS
// ===============================

function computeRSI(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 50;
  let gains = 0,
    losses = 0;

  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = candles[i + 1].close - candles[i].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / length;
  const avgLoss = (losses || 0.000001) / length;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeATR(candles, length = 14) {
  if (candles.length < length + 1) return 0;
  const trs = [];

  for (let i = candles.length - length; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1] ?? cur;

    const high = cur.high;
    const low = cur.low;
    const prevClose = prev.close;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  return Number((trs.reduce((a, b) => a + b, 0) / trs.length).toFixed(2));
}

function ema(values, period = 12) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [];

  for (const v of values) {
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function computeMACD(candles) {
  if (candles.length < 35) return { hist: 0, line: 0, signal: 0 };

  const closes = candles.map((c) => c.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macd, 9);

  return {
    hist: Number((macd.at(-1) - signal.at(-1)).toFixed(6)),
    line: Number(macd.at(-1).toFixed(6)),
    signal: Number(signal.at(-1).toFixed(6)),
  };
}

function priceTrend(candles) {
  if (candles.length < 2) return "FLAT";
  return candles.at(-1).close > candles.at(-2).close ? "UP" : candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT";
}

function volumeTrend(candles) {
  if (candles.length < 2) return "STABLE";
  const v1 = candles.at(-1).vol;
  const v2 = candles.at(-2).vol;
  return v1 > v2 ? "INCREASING" : v1 < v2 ? "DECREASING" : "STABLE";
}

// ===============================
// OPTION-B: FINAL analyzeVolume()
// ===============================

function analyzeVolume(candles) {
  if (!Array.isArray(candles) || candles.length < 3)
    return { status: "UNKNOWN", strength: 0 };

  const v1 = candles.at(-3).vol;
  const v2 = candles.at(-2).vol;
  const v3 = candles.at(-1).vol;

  if (v3 > v2 && v2 > v1) return { status: "RISING", strength: 3 };
  if (v3 < v2 && v2 < v1) return { status: "FALLING", strength: -3 };
  if (v3 > v2) return { status: "SLIGHT_UP", strength: 1 };
  if (v3 < v2) return { status: "SLIGHT_DOWN", strength: -1 };

  return { status: "STABLE", strength: 0 };
}

// ===============================
// CALCULATE INDICATORS
// ===============================

function calculateIndicators(candles) {
  return {
    RSI: computeRSI(candles),
    MACD: computeMACD(candles),
    ATR: computeATR(candles),
    priceTrend: priceTrend(candles),
    volumeTrend: volumeTrend(candles),
  };
}

// ===============================
// FIB LEVELS
// ===============================

function computeFibLevels(candles) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const diff = high - low;

  return {
    lo: low,
    hi: high,
    retrace: {
      0.236: high - diff * 0.236,
      0.382: high - diff * 0.382,
      0.5: high - diff * 0.5,
      0.618: high - diff * 0.618,
      0.786: high - diff * 0.786,
    },
  };
}

// ===============================
// MARKET DATA WRAPPER
// ===============================

async function fetchMarketData(symbol, interval, limit) {
  const candles = await ensureCandles(symbol, interval, limit);

  return {
    data: candles,
    price: candles.at(-1)?.close || 0,
    volume: candles.at(-1)?.vol || 0,
    indicators: calculateIndicators(candles),
    fib: computeFibLevels(candles),
    updated: nowLocal(),
  };
}

// ===============================
// MULTI-TF FETCH
// ===============================

async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};

  await Promise.all(
    tfs.map(async (tf) => {
      out[tf] = await fetchMarketData(symbol, tf, DEFAULT_LIMIT);
    })
  );

  return out;
}

// ===============================
// KEEP ALIVE
// ===============================

async function keepAlive() {
  try {
    await axios.get(CONFIG.SELF_PING_URL);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ===============================
// FINAL EXPORTS (single block)
// ===============================

export {
  nowLocal,
  safeAxiosGet,
  fetchCrypto,
  ensureCandles,
  fetchMarketData,
  fetchMultiTF,
  computeRSI,
  computeATR,
  computeMACD,
  computeFibLevels,
  priceTrend,
  volumeTrend,
  analyzeVolume,
  calculateIndicators,
  keepAlive,
};