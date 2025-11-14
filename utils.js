import axios from "axios";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

// ==============================
// SAFE AXIOS WRAPPER
// ==============================
async function safeAxiosGet(url, options = {}) {
  try {
    const res = await axios.get(url, { timeout: 10000, ...options });
    return res.data;
  } catch (e) {
    console.error("safeAxiosGet error:", e.message);
    return null;
  }
}

// ==============================
// BASIC TIME HELPERS
// ==============================
function nowLocal() {
  return new Date().toLocaleString("en-IN", { hour12: false });
}

// ==============================
// CANDLE CACHE SYSTEM
// ==============================
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

// ==============================
// FETCH CANDLES FROM BINANCE
// ==============================
async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = 200) {
  const url =
    `${CONFIG.BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const out = await safeAxiosGet(url);
  if (!out) return [];

  return out.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ==============================
// ENSURE CANDLE DATA (CACHE + LIVE)
// ==============================
async function ensureCandles(symbol, interval = "15m", limit = 200) {
  let old = loadCache(symbol, interval);
  const fresh = await fetchCrypto(symbol, interval, limit);

  if (!fresh.length) return old;

  // replace cache with latest
  saveCache(symbol, interval, fresh);
  return fresh;
}

// ==============================
// INDICATOR FUNCTIONS
// ==============================

// -------- RSI ----------
function computeRSI(candles, length = 14) {
  let gains = 0, losses = 0;

  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = candles[i + 1].close - candles[i].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / length;
  const avgLoss = losses / length || 0.00001;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Number(rsi.toFixed(2));
}

// -------- ATR ----------
function computeATR(candles, length = 14) {
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

  return Number((trs.reduce((a, b) => a + b, 0) / length).toFixed(2));
}

// -------- MACD ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  const out = [];
  for (let v of values) {
    emaPrev = v * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}

function computeMACD(candles) {
  const closes = candles.map((c) => c.close);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine.slice(-50), 9); // last 50 candles

  return Number((macdLine.at(-1) - signalLine.at(-1)).toFixed(4));
}

// -------- PRICE TREND ----------
function priceTrend(candles) {
  const last = candles.at(-1).close;
  const prev = candles.at(-2).close;

  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

// -------- VOLUME TREND ----------
function volumeTrend(candles) {
  const last = candles.at(-1).volume;
  const prev = candles.at(-2).volume;

  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

// -------- COMBINED SIGNAL ----------
function getSignal(rsi, macd, priceT, volT) {
  let score = 0;

  if (rsi < 30) score += 1;
  if (rsi > 70) score -= 1;

  if (macd > 0) score += 1;
  else score -= 1;

  if (priceT === "UP") score += 1;
  if (priceT === "DOWN") score -= 1;

  if (volT === "INCREASING") score += 1;

  if (score >= 2) return "BUY";
  if (score <= -2) return "SELL";
  return "NEUTRAL";
}

// -------- MASTER INDICATOR WRAPPER ----------
function calculateIndicators(candles) {
  const rsi = computeRSI(candles);
  const macd = computeMACD(candles);
  const atr = computeATR(candles);
  const pt = priceTrend(candles);
  const vt = volumeTrend(candles);
  const signal = getSignal(rsi, macd, pt, vt);

  return {
    rsi,
    macd,
    atr,
    priceTrend: pt,
    volumeTrend: vt,
    signal,
  };
}

// ==============================
// FIBONACCI LEVELS
// ==============================
function computeFibLevels(candles) {
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const diff = high - low;

  return {
    level_0: high,
    level_236: high - diff * 0.236,
    level_382: high - diff * 0.382,
    level_5: high - diff * 0.5,
    level_618: high - diff * 0.618,
    level_786: high - diff * 0.786,
    level_1: low,
  };
}

// ==============================
// MARKET FETCH WRAPPER (USED IN TG UI)
// ==============================
async function fetchMarketData(symbol = "BTCUSDT") {
  const candles = await ensureCandles(symbol, "15m", 200);
  if (!candles.length) return null;

  const ind = calculateIndicators(candles);
  const fib = computeFibLevels(candles);

  return {
    symbol,
    price: candles.at(-1).close,
    volume: candles.at(-1).volume,
    indicators: ind,
    fib,
    updated: nowLocal(),
  };
}

// ==============================
// KEEP ALIVE (render.com)
// ==============================
async function keepAlive() {
  try {
    await axios.get(`https://${CONFIG.RENDER_URL}`);
  } catch {}
}

// ==============================
// WEBSOCKET (OPTIONAL)
// ==============================
class LiveCryptoStream {
  constructor(symbol = "BTCUSDT") {
    this.symbol = symbol;
    this.ws = null;
  }
  start() {}
  stop() {}
}

// ==============================
// EXPORTS
// ==============================
export {
  analyzeVolume,
  computeFibLevels,
  fetchCrypto,
  fetchMarketData,
  priceTrend,
  volumeTrend,
  calculateIndicators,
  computeATR,
  computeRSI,
  computeMACD,
  safeAxiosGet,
  LiveCryptoStream,
  nowLocal,
  keepAlive,
};

export default {
  analyzeVolume,
  computeFibLevels,
  fetchCrypto,
  fetchMarketData,
  priceTrend,
  volumeTrend,
  calculateIndicators,
  computeATR,
  computeRSI,
  computeMACD,
  LiveCryptoStream,
  nowLocal,
  keepAlive,
};