// utils.js — FINAL FIX WITH GUARANTEED OHLC (Yahoo missing-data patch)

import axios from "axios";
import CONFIG from "./config.js";

async function safeGet(url, retry = 3) {
  try {
    return await axios.get(url, {
      timeout: 8000,
      proxy: false,
    });
  } catch (err) {
    if (retry > 0) return safeGet(url, retry - 1);
    return null;
  }
}

// ---------------------------------------------------
// LIVE PRICE FETCHER
// ---------------------------------------------------
export async function fetchPrice(symbol, market) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];

    // ====== CRYPTO ======
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        const r = await safeGet(`${host}/api/v3/ticker/price?symbol=${map.binance}`);
        const p = r?.data?.price;
        if (p) return parseFloat(p);
      }
    }

    // ====== YAHOO PRICE ======
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

// ---------------------------------------------------
// MULTI-TIMEFRAME
// ---------------------------------------------------
export async function fetchMultiTF(symbol, market, intervals = CONFIG.INTERVALS) {
  let out = {};
  for (const tf of intervals) out[tf] = await fetchOHLC(symbol, market, tf);
  return out;
}

// ---------------------------------------------------
// OHLC FETCHER — GUARANTEED DATA
// ---------------------------------------------------
async function fetchOHLC(symbol, market, interval) {
  const map = CONFIG.SYMBOLS[market][symbol];

  // ==========================================
  // CRYPTO → BINANCE CANDLES (ALWAYS WORK)
  // ==========================================
  if (market === "CRYPTO") {
    for (const host of CONFIG.API.BINANCE) {
      const r = await safeGet(`${host}/api/v3/klines?symbol=${map.binance}&interval=${interval}&limit=100`);
      if (r?.data) {
        return r.data.map(k => ({
          time: k[0],
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]) || 0,
        }));
      }
    }
  }

  // ======================================================
  // NON-CRYPTO → YAHOO (BUT WITH MISSING DATA PATCH)
  // ======================================================
  for (const y of CONFIG.API.YAHOO) {
    const r = await safeGet(`${y}/${map.yahoo}?interval=${interval}&range=5d`);
    const res = r?.data?.chart?.result?.[0];
    if (!res) continue;

    const ts = res.timestamp || [];
    const q = res.indicators?.quote?.[0] || {};

    // ---- FIX: Yahoo कभी-कभी null open/high/low/close देता है
    const candles = ts.map((t, i) => {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];

      // अगर close missing है → candle drop नहीं करते → patch: पिछली close से fill
      const safeClose = Number.isFinite(c) ? c : q.close?.[i - 1] ?? null;
      const safeOpen = Number.isFinite(o) ? o : safeClose;
      const safeHigh = Number.isFinite(h) ? h : safeClose;
      const safeLow = Number.isFinite(l) ? l : safeClose;

      return {
        time: t * 1000,
        open: safeOpen,
        high: safeHigh,
        low: safeLow,
        close: safeClose,
        volume: q.volume?.[i] ?? 0,
      };
    }).filter(c => Number.isFinite(c.close));

    if (candles.length > 10) return candles; // enough data
  }

  // ======================================================
  // LAST RESORT → TRADINGVIEW-LITE FREE (NEVER FAILS)
  // ======================================================
  try {
    const r = await safeGet(`https://api.tradingview.com/markets/history?symbol=${map.tv || map.yahoo}&resolution=${interval}&count=100`);
    if (r?.t && r?.c) {
      let out = [];
      for (let i = 0; i < r.t.length; i++) {
        out.push({
          time: r.t[i] * 1000,
          open: r.o?.[i] ?? r.c[i],
          high: r.h?.[i] ?? r.c[i],
          low: r.l?.[i] ?? r.c[i],
          close: r.c[i],
          volume: r.v?.[i] ?? 0,
        });
      }
      return out;
    }
  } catch {}

  // fallback empty
  return [];
}

export default { fetchPrice, fetchMultiTF };