// =========================================
// utils.js — FINAL STABLE (NO PROXY, NO ERRORS)
// =========================================

import axios from "axios";

// Local Time
function nowLocal() {
  return new Date().toLocaleString("en-IN", { hour12: false });
}

// Volume Trend
function analyzeVolume(candles = []) {
  if (candles.length < 5) return "stable";

  const last = candles.slice(-5).map(c => parseFloat(c.volume));
  const avgOld = (last[0] + last[1] + last[2]) / 3;
  const avgNew = (last[3] + last[4]) / 2;

  if (avgNew > avgOld * 1.15) return "up";
  if (avgNew < avgOld * 0.85) return "down";
  return "stable";
}

// Multi-source market data
const SOURCES = [
  (s, tf, l) => `https://data-stream.binance.vision/api/v3/klines?symbol=${s}&interval=${tf}&limit=${l}`,
  (s, tf, l) => `https://api1.binance.com/api/v3/klines?symbol=${s}&interval=${tf}&limit=${l}`,
  (s, tf, l) => `https://api2.binance.com/api/v3/klines?symbol=${s}&interval=${tf}&limit=${l}`
];

async function fetchMarketData(symbol, tf = "15m", limit = 200) {
  for (const build of SOURCES) {
    const url = build(symbol, tf, limit);

    try {
      const res = await axios.get(url, { timeout: 5000 });

      return res.data.map(x => ({
        openTime: x[0],
        open: x[1],
        high: x[2],
        low: x[3],
        close: x[4],
        volume: x[5],
        closeTime: x[6]
      }));
    } catch (err) {
      console.log("❗ Source failed:", url);
      continue;
    }
  }

  throw new Error("All market-data sources failed");
}

// FIB Levels
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

// EXPORTS
export {
  nowLocal,
  fetchMarketData,
  analyzeVolume,
  computeFibLevels
};