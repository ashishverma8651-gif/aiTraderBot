// =========================================
// utils.js  — FINAL FIXED VERSION
// =========================================

// Local time helper (REQUIRED!)
function nowLocal() {
  return new Date().toLocaleString("en-IN", {
    hour12: false
  });
}

// Volume trend detection
function analyzeVolume(candles = []) {
  if (candles.length < 5) return "stable";

  const last = candles.slice(-5).map(c => parseFloat(c.volume));
  const avgOld = last.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const avgNew = last.slice(-2).reduce((a, b) => a + b, 0) / 2;

  if (avgNew > avgOld * 1.15) return "up";
  if (avgNew < avgOld * 0.85) return "down";
  return "stable";
}

// Market Data with fallback providers + proxy
import axios from "axios";
import HttpsProxyAgent from "https-proxy-agent";

const proxy = process.env.PROXY_URL
  ? new HttpsProxyAgent(process.env.PROXY_URL)
  : null;

const SOURCES = [
  (symbol, tf, limit) =>
    `https://data-stream.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`,
  (symbol, tf, limit) =>
    `https://api1.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`,
  (symbol, tf, limit) =>
    `https://api2.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`
];

async function fetchMarketData(symbol, tf = "15m", limit = 200) {
  for (const buildUrl of SOURCES) {
    const url = buildUrl(symbol, tf, limit);
    try {
      const res = await axios.get(url, {
        httpsAgent: proxy || undefined,
        timeout: 5000
      });

      return res.data.map(c => ({
        openTime: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
        closeTime: c[6]
      }));
    } catch (err) {
      console.log("❗ Data source failed:", url);
      continue;
    }
  }
  throw new Error("All market-data sources failed");
}

// Simple Fibonacci calculator
function computeFibLevels(lo, hi) {
  const r = hi - lo;

  return {
    retrace: {
      "0.236": hi - r * 0.236,
      "0.382": hi - r * 0.382,
      "0.5": hi - r * 0.5,
      "0.618": hi - r * 0.618,
      "0.786": hi - r * 0.786
    },
    extensions: {
      "1.272": hi + r * 0.272,
      "1.618": hi + r * 0.618
    },
    lo,
    hi
  };
}

// =========================================
// SINGLE EXPORT (NO DUPLICATES)
// =========================================
export {
  nowLocal,
  fetchMarketData,
  analyzeVolume,
  computeFibLevels
};