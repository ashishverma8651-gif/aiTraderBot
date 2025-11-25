// utils.js — FINAL STABLE VERSION

import axios from "axios";
import CONFIG from "./config.js";

// Universal GET with retry
async function safeGet(url, retry = 2) {
  try {
    return await axios.get(url, { timeout: 7000 });
  } catch (e) {
    if (retry > 0) return safeGet(url, retry - 1);
    return null;
  }
}

// -------------------------------
// FETCH PRICE
// -------------------------------
export async function fetchPrice(symbol, market) {
  try {
    const sym = CONFIG.SYMBOLS[market]?.[symbol];

    if (!sym) {
      console.log("❌ Symbol missing:", market, symbol);
      return null;
    }

    // CRYPTO → Binance first
    if (market === "CRYPTO" && sym.binance) {
      for (const host of CONFIG.API.BINANCE) {
        let r = await safeGet(`${host}/api/v3/ticker/price?symbol=${sym.binance}`);
        if (r?.data?.price) return parseFloat(r.data.price);
      }
    }

    // Yahoo fallback (Crypto + India + Forex + Commodities)
    for (const y of CONFIG.API.YAHOO) {
      let r = await safeGet(`${y}/${sym.yahoo}?interval=1m&range=1d`);
      let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p) return parseFloat(p);
    }

    return null;
  } catch {
    return null;
  }
}

// -------------------------------
// FETCH OHLC (for multi-TF)
// -------------------------------
async function fetchOHLC(symbol, market, interval) {
  const sym = CONFIG.SYMBOLS[market]?.[symbol];
  if (!sym) return [];

  // CRYPTO → Binance OHLC
  if (market === "CRYPTO" && sym.binance) {
    for (const host of CONFIG.API.BINANCE) {
      let r = await safeGet(
        `${host}/api/v3/klines?symbol=${sym.binance}&interval=${interval}&limit=100`
      );
      if (r?.data) {
        return r.data.map(k => ({
          time: k[0],
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
          volume: +k[5]
        }));
      }
    }
  }

  // Yahoo OHLC
  for (const y of CONFIG.API.YAHOO) {
    let r = await safeGet(`${y}/${sym.yahoo}?interval=${interval}&range=5d`);
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
      volume: q.volume?.[i] ?? 0
    })).filter(c => Number.isFinite(c.close));
  }

  return [];
}

// -------------------------------
// MULTI-TF WRAPPER
// -------------------------------
export async function fetchMultiTF(symbol, market) {
  const intervals = ["1m", "5m", "15m", "30m", "1h"];
  let out = {};

  for (const tf of intervals) {
    out[tf] = await fetchOHLC(symbol, market, tf);
  }

  return out;
}

export default { fetchPrice, fetchMultiTF };