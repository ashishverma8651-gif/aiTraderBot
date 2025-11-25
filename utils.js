// utils.js — FIXED FOR INDICATOR ENGINE COMPATIBILITY

import axios from "axios";
import CONFIG from "./config.js";

async function safeGet(url, retry = 3) {
  try {
    return await axios.get(url, { timeout: 8000, proxy: false });
  } catch (err) {
    if (retry > 0) return safeGet(url, retry - 1);
    return null;
  }
}

// ===========================================
// LIVE PRICE
// ===========================================
export async function fetchPrice(symbol, market) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];

    // CRYPTO → Binance → Yahoo
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        const r = await safeGet(`${host}/api/v3/ticker/price?symbol=${map.binance}`);
        if (r?.data?.price) return parseFloat(r.data.price);
      }
    }

    // Others (NIFTY / FOREX / COMMOD)
    for (const y of CONFIG.API.YAHOO) {
      const r = await safeGet(`${y}/${map.yahoo}?interval=1m&range=1d`);
      const p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p) return Number(p);
    }

    return null;
  } catch {
    return null;
  }
}

// ===========================================
// MULTI-TF FETCH
// ===========================================
export async function fetchMultiTF(symbol, market, intervals = CONFIG.INTERVALS) {
  const out = {};

  for (const tf of intervals) {
    out[tf] = { tf, data: await fetchOHLC(symbol, market, tf) };
  }

  return out;
}

// ===========================================
// OHLC FETCHER (BINANCE + YAHOO)
// NORMALIZED to indicator engine format:
// { t, open, high, low, close, vol }
// ===========================================
async function fetchOHLC(symbol, market, interval) {
  const map = CONFIG.SYMBOLS[market][symbol];

  // -------- CRYPTO: Binance --------
  if (market === "CRYPTO") {
    for (const host of CONFIG.API.BINANCE) {
      try {
        const r = await safeGet(
          `${host}/api/v3/klines?symbol=${map.binance}&interval=${interval}&limit=200`
        );
        if (!r?.data) continue;

        return r.data.map(k => ({
          t: k[0],
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          vol: Number(k[5])
        }));
      } catch {}
    }
  }

  // -------- Yahoo (NIFTY, Forex, Commodities) --------
  for (const y of CONFIG.API.YAHOO) {
    try {
      const r = await safeGet(`${y}/${map.yahoo}?interval=${interval}&range=5d`);
      const res = r?.data?.chart?.result?.[0];
      if (!res) continue;

      const ts = res.timestamp || [];
      const q = res.indicators?.quote?.[0];

      return ts.map((t, i) => ({
        t: t * 1000,
        open: Number(q.open?.[i]),
        high: Number(q.high?.[i]),
        low: Number(q.low?.[i]),
        close: Number(q.close?.[i]),
        vol: Number(q.volume?.[i] ?? 0)
      })).filter(c => Number.isFinite(c.close));
    } catch {}
  }

  return [];
}

export default { fetchPrice, fetchMultiTF };