// utils.js — RESTORED + PROXY + MULTI-SOURCE (FULLY WORKING)

import axios from "axios";
import CONFIG from "./config.js";

// ----------------------------------------------------------
// GLOBAL SETTINGS
// ----------------------------------------------------------
const TIMEOUT = 12000;
const RETRIES = 4;

// Free proxy (safe for trading data)
const PROXY = "https://api.allorigins.win/raw?url=";

// Binance sources (Render free IP sometimes blocks 1-2)
const BINANCE_SOURCES = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://data-api.binance.vision"
];

// ----------------------------------------------------------
// SAFE AXIOS GET — retries + proxy + multi-endpoint backup
// ----------------------------------------------------------
async function safeAxiosGet(url) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await axios.get(url, { timeout: TIMEOUT });
      return res.data;
    } catch (e) {
      // if blocked or timeout → try proxy
      try {
        const resP = await axios.get(PROXY + encodeURIComponent(url), {
          timeout: TIMEOUT
        });
        return resP.data;
      } catch {}

      // last retry
      if (attempt === RETRIES) {
        console.log("safeAxiosGet FAILED:", url);
        throw e;
      }
    }
  }
}

// ----------------------------------------------------------
// FETCH FROM MULTIPLE SOURCES (Binance fallback system)
// ----------------------------------------------------------
async function fetchFromBinance(path) {
  for (const base of BINANCE_SOURCES) {
    const url = base + path;
    try {
      const data = await safeAxiosGet(url);
      return data;
    } catch (e) {
      console.log("❌ Failed:", url.substring(0, 40), "… trying next");
    }
  }
  throw new Error("All Binance endpoints failed");
}

// ----------------------------------------------------------
// SINGLE TF FETCH
// ----------------------------------------------------------
export async function fetchMarketData(symbol, interval, limit = 200) {
  try {
    const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchFromBinance(path);

    const candles = raw.map(k => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      vol: Number(k[5]),
      closeTime: k[6]
    }));

    return { symbol, interval, data: candles, price: candles.at(-1)?.close || 0 };
  } catch (e) {
    console.log("fetchMarketData error:", e.message);
    return { symbol, interval, data: [], price: 0 };
  }
}

// ----------------------------------------------------------
// MULTI-TF FETCH
// ----------------------------------------------------------
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};

  for (const tf of tfs) {
    out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT);
  }

  return out;
}

export default {
  fetchMarketData,
  fetchMultiTF
};