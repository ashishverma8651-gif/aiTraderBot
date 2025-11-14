// ===============================================
// utils.js — FINAL VERSION (Compatible with TG Option 3)
// Multi-Timeframe + Stable Indicators + Fib + Volume Trend
// ===============================================

import axios from "axios";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

// ===============================================
// SAFE AXIOS WRAPPER
// ===============================================
export async function safeAxiosGet(url, options = {}) {
  const finalURL = url.replace(
    "https://api.binance.com",
    CONFIG.BINANCE_MIRROR || "https://api1.binance.com"
  );

  try {
    const res = await axios.get(finalURL, {
      timeout: 15000,
      proxy: CONFIG.PROXY || false,
      ...options,
    });
    return res.data;
  } catch (e) {
    console.error("safeAxiosGet error:", e.message);
    return null;
  }
}

// ===============================================
// TIME
// ===============================================
export function nowLocal() {
  return new Date().toLocaleString("en-IN", { hour12: false });
}

// ===============================================
// CACHE
// ===============================================
const CACHE_DIR = "./cache";
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function loadCache(symbol, interval) {
  const p = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function saveCache(symbol, interval, data) {
  const p = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ===============================================
// FETCH CANDLES (RAW BINANCE)
// ===============================================
export async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = 200) {
  const url =
    `${CONFIG.BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const out = await safeAxiosGet(url);
  if (!out) return [];

  return out.map((k) => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

// ===============================================
// ENSURE CANDLES (CACHE + LIVE)
// ===============================================
export async function ensureCandles(symbol, interval = "15m", limit = 200) {
  const old = loadCache(symbol, interval);
  const fresh = await fetchCrypto(symbol, interval, limit);

  if (!fresh.length) return old;
  saveCache(symbol, interval, fresh);
  return fresh;
}

// ===============================================
// INDICATORS
// ===============================================
export function computeRSI(candles, length = 14) {
  if (candles.length < length + 2) return 50;

  let gains = 0, losses = 0;

  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = candles[i + 1].close - candles[i].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (gains === 0 && losses === 0) return 50;

  const avgGain = gains / length;
  const avgLoss = losses / length || 0.001;

  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

export function computeATR(candles, length = 14) {
  if (candles.length < length + 2) return 0;

  let trs = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  return +(trs.reduce((a, b) => a + b, 0) / length).toFixed(2);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  return values.map((v) => (emaPrev = v * k + emaPrev * (1 - k)));
}

export function computeMACD(candles) {
  if (candles.length < 40) return { hist: 0 };

  const closes = candles.map((c) => c.close);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);

  return {
    hist: +(macdLine.at(-1) - signalLine.at(-1)).toFixed(4),
  };
}

export function priceTrend(candles) {
  const last = candles.at(-1).close;
  const prev = candles.at(-2).close;

  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

export function volumeTrend(candles) {
  if (!candles.length) return "stable";

  const last = candles.at(-1).volume;
  const prev = candles.at(-2)?.volume ?? last;

  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

export function analyzeVolumeTrend(candles) {
  const v = volumeTrend(candles);
  if (v === "INCREASING") return "up";
  if (v === "DECREASING") return "down";
  return "stable";
}

export function calculateIndicators(candles) {
  const rsi = computeRSI(candles);
  const macd = computeMACD(candles);
  const atr = computeATR(candles);
  const pt = priceTrend(candles);
  const vt = volumeTrend(candles);

  return {
    RSI: rsi,
    MACD: macd,
    ATR: atr,
    priceTrend: pt,
    volumeTrend: vt,
  };
}

// ===============================================
// FIB LEVELS (Dual Mode)
// supports:
//    computeFibLevels(candles)
//    computeFibLevels(low, high)
// ===============================================
export function computeFibLevels(a, b) {
  let low, high;

  if (Array.isArray(a)) {
    high = Math.max(...a.map((c) => c.high));
    low = Math.min(...a.map((c) => c.low));
  } else {
    low = a;
    high = b;
  }

  const diff = high - low;

  return {
    lo: low,
    hi: high,
    retrace: {
      "0.236": high - diff * 0.236,
      "0.382": high - diff * 0.382,
      "0.5": high - diff * 0.5,
      "0.618": high - diff * 0.618,
      "0.786": high - diff * 0.786,
    },
  };
}

// ===============================================
// MASTER MARKET FETCH (NOW SUPPORTS TF)
// ===============================================
export async function fetchMarketData(symbol = "BTCUSDT", interval = "15m", limit = 200) {
  const candles = await ensureCandles(symbol, interval, limit);

  return {
    data: candles,
    price: candles.at(-1)?.close ?? 0,
    volume: candles.at(-1)?.volume ?? 0,
    indicators: candles.length ? calculateIndicators(candles) : null,
    fib: candles.length ? computeFibLevels(candles) : null,
    updated: nowLocal(),
  };
}

// ===============================================
// KEEP ALIVE
// ===============================================
export async function keepAlive() {
  try {
    await axios.get(`https://${CONFIG.RENDER_URL}`);
  } catch {}
}

export default {
  safeAxiosGet,
  nowLocal,
  fetchCrypto,
  ensureCandles,
  fetchMarketData,
  computeRSI,
  computeATR,
  computeMACD,
  computeFibLevels,
  calculateIndicators,
  analyzeVolumeTrend,
  priceTrend,
  volumeTrend,
  keepAlive,
};