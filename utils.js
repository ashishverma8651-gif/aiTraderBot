import axios from "axios";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

// ==============================
// SAFE AXIOS WRAPPER (with proxy + mirror)
// ==============================
async function safeAxiosGet(url, options = {}) {
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

  saveCache(symbol, interval, fresh);
  return fresh;
}

// ==============================
// INDICATORS
// ==============================
function computeRSI(candles, length = 14) {
  if (candles.length < length + 2) return 50;

  let gains = 0,
    losses = 0;

  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = candles[i + 1].close - candles[i].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (gains === 0 && losses === 0) return 50;

  const avgGain = gains / length;
  const avgLoss = losses / length || 0.00001;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return Number(rsi.toFixed(2));
}

function computeATR(candles, length = 14) {
  if (candles.length < length + 1) return 0;

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
  if (candles.length < 40) return 0;

  const closes = candles.map((c) => c.close);

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);

  return Number((macdLine.at(-1) - signalLine.at(-1)).toFixed(4));
}

function priceTrend(candles) {
  const last = candles.at(-1).close;
  const prev = candles.at(-2).close;

  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

function volumeTrend(candles) {
  const last = candles.at(-1).volume;
  const prev = candles.at(-2).volume;

  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

function analyzeVolume(candles) {
  const vt = volumeTrend(candles);
  if (vt === "INCREASING") return "Smart money activity possible";
  if (vt === "DECREASING") return "Weak market interest";
  return "Stable volume";
}

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

function calculateIndicators(candles) {
  const rsi = computeRSI(candles);
  const macd = computeMACD(candles);
  const atr = computeATR(candles);
  const pt = priceTrend(candles);
  const vt = volumeTrend(candles);

  return {
    rsi,
    macd,
    atr,
    priceTrend: pt,
    volumeTrend: vt,
    volumeNote: analyzeVolume(candles),
    signal: getSignal(rsi, macd, pt, vt),
  };
}

// ==============================
// FIB LEVELS
// ==============================
function computeFibLevels(candles) {
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const diff = high - low;

  return {
    high,
    low,
    level_236: high - diff * 0.236,
    level_382: high - diff * 0.382,
    level_5: high - diff * 0.5,
    level_618: high - diff * 0.618,
    level_786: high - diff * 0.786,
  };
}

// ==============================
// MASTER MARKET FETCH
// ==============================
async function fetchMarketData(symbol = "BTCUSDT") {
  const candles = await ensureCandles(symbol, "15m", 200);
  if (!candles.length) return null;

  return {
    symbol,
    price: candles.at(-1).close,
    volume: candles.at(-1).volume,
    indicators: calculateIndicators(candles),
    fib: computeFibLevels(candles),
    updated: nowLocal(),
  };
}

// ==============================
// KEEP ALIVE
// ==============================
async function keepAlive() {
  try {
    await axios.get(`https://${CONFIG.RENDER_URL}`);
  } catch {}
}

// ==============================
// EXPORT
// ==============================
export {
  computeFibLevels,
  fetchCrypto,
  fetchMarketData,
  priceTrend,
  volumeTrend,
  calculateIndicators,
  computeATR,
  computeRSI,
  computeMACD,
  analyzeVolume,
  safeAxiosGet,
  nowLocal,
  keepAlive,
};

export default {
  computeFibLevels,
  fetchCrypto,
  fetchMarketData,
  priceTrend,
  volumeTrend,
  calculateIndicators,
  computeATR,
  computeRSI,
  computeMACD,
  analyzeVolume,
  safeAxiosGet,
  nowLocal,
  keepAlive,
};