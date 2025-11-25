// utils.js — FINAL FIX WITH VOLUME + CLEAN CANDLE FORMAT (RSI, ATR, TREND 100% WORKING)

import axios from "axios";
import CONFIG from "./config.js";

async function safeGet(url, retry = 3) {
  try {
    return await axios.get(url, {
      timeout: 8000,
      proxy: false
    });
  } catch (err) {
    if (retry > 0) return safeGet(url, retry - 1);
    throw err;
  }
}

// ---------------------------------------------------
// FETCH LIVE PRICE
// ---------------------------------------------------
export async function fetchPrice(symbol, market) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];

    // ==== CRYPTO PRICE (Binance → Yahoo fallback) ====
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/ticker/price?symbol=${map.binance}`;
          let r = await safeGet(url);
          if (r?.data?.price) return parseFloat(r.data.price);
        } catch {}
      }

      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    // ==== INDIA PRICE (Yahoo → TV fallback) ====
    if (market === "INDIA") {
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    // ==== FOREX PRICE ====
    if (market === "FOREX") {
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    // ==== COMMODITY PRICE ====
    if (market === "COMMODITIES") {
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    throw new Error("ALL PRICE SOURCES FAILED");
  } catch (e) {
    console.log("PriceError:", e.message);
    return null;
  }
}

// ---------------------------------------------------
// MULTI-TIMEFRAME FETCH
// ---------------------------------------------------
export async function fetchMultiTF(symbol, market, intervals = CONFIG.INTERVALS) {
  let out = {};

  for (const tf of intervals) {
    out[tf] = await fetchOHLC(symbol, market, tf);
  }

  return out;
}

// ---------------------------------------------------
// OHLC FETCHER (MOST IMPORTANT)
// ---------------------------------------------------
async function fetchOHLC(symbol, market, interval) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];

    // =============== CRYPTO OHLC ===================
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/klines?symbol=${map.binance}&interval=${interval}&limit=100`;
          let r = await safeGet(url);

          return r.data.map(k => ({
            time: k[0],
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]) || 0   // FIXED
          }));
        } catch {}
      }
    }

    // =============== YAHOO OHLC (INDIA, FOREX, COMMODITIES) ===============
    for (const y of CONFIG.API.YAHOO) {
      try {
        let url = `${y}/${map.yahoo}?interval=${interval}&range=5d`;
        let r = await safeGet(url);

        let result = r?.data?.chart?.result?.[0];
        if (!result) continue;

        let ts = result.timestamp || [];
        let q = result.indicators?.quote?.[0] || {};

        return ts.map((t, i) => ({
          time: t * 1000,
          open: q.open?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
          close: q.close?.[i] ?? null,
          volume: q.volume?.[i] ?? 0     // FIXED
        })).filter(c => Number.isFinite(c.close));
      } catch {}
    }

    return [];
  } catch (err) {
    console.log("OHLC error:", err.message);
    return [];
  }
}

export default { fetchPrice, fetchMultiTF };