// utils.js — FINAL VERSION (NO CACHE, ALWAYS LIVE PRICE)

import axios from "axios";
import CONFIG from "./config.js";

// ---------------------------------------------------------
// Universal HTTP fetch with proxy + retry
// ---------------------------------------------------------
async function safeGet(url, retry = 3) {
  try {
    return await axios.get(url, {
      timeout: 8000,
      proxy: false,
      ...(CONFIG.PROXY
        ? { httpsAgent: new (await import("https-proxy-agent")).HttpsProxyAgent(CONFIG.PROXY) }
        : {})
    });
  } catch (e) {
    if (retry > 0) return safeGet(url, retry - 1);
    throw e;
  }
}

// ---------------------------------------------------------
// FETCH PRICE — Multi-Market Live Price
// ---------------------------------------------------------
export async function fetchPrice(symbol, market) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];
    if (!map) throw new Error("Invalid symbol-map");

    let price = null;

    // ===============================
    // 1) CRYPTO → BINANCE → YAHOO
    // ===============================
    if (market === "CRYPTO") {
      // try all binance mirrors
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/ticker/price?symbol=${map.binance}`;
          let r = await safeGet(url);
          if (r?.data?.price) return parseFloat(r.data.price);
        } catch {}
      }

      // yahoo fallback
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    // ===============================
    // 2) INDIA → YAHOO → TRADINGVIEW PROXY
    // ===============================
    if (market === "INDIA") {
      // yahoo finance index + stocks
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }

      // TradingView proxy (index only)
      if (map.tv) {
        for (const tv of CONFIG.API.TRADINGVIEW_PROXY) {
          try {
            let url = `${tv}/index/${map.tv}`;
            let r = await safeGet(url);
            if (r?.data?.price) return parseFloat(r.data.price);
          } catch {}
        }
      }
    }

    // ===============================
    // 3) FOREX → YAHOO → EXCHANGERATE
    // ===============================
    if (market === "FOREX") {
      // yahoo
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }

      // exchangerate.host fallback
      try {
        let [base, quote] = symbol.split("");
        let url = `${CONFIG.API.EXCHANGERATE}/latest?base=${base}&symbols=${quote}`;
        let r = await safeGet(url);
        let p = r?.data?.rates?.[quote];
        if (p) return parseFloat(p);
      } catch {}
    }

    // ===============================
    // 4) COMMODITIES → YAHOO ONLY
    // ===============================
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

    throw new Error(`ALL API FAILED for ${symbol} (${market})`);
  } catch (err) {
    console.error("PriceError:", err.message);
    return null;
  }
}

// ---------------------------------------------------------
// Multi-timeframe Data Fetcher (Binance + Yahoo)
// ---------------------------------------------------------
export async function fetchMultiTF(symbol, market, intervals = CONFIG.INTERVALS) {
  let data = {};

  for (const tf of intervals) {
    let candles = await fetchOHLC(symbol, market, tf);
    data[tf] = candles;
  }

  return data;
}

// ---------------------------------------------------------
// OHLC FETCHER (1m, 5m, 15m, 30m, 1h)
// ---------------------------------------------------------
async function fetchOHLC(symbol, market, interval) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];
    if (!map) throw new Error("Invalid symbol map");

    // CRYPTO OHLC from binance
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/klines?symbol=${map.binance}&interval=${interval}&limit=100`;
          let r = await safeGet(url);
          return r.data.map(c => ({
            time: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4])
          }));
        } catch {}
      }
    }

    // EVERYTHING ELSE → YAHOO OHLC
    for (const y of CONFIG.API.YAHOO) {
      try {
        let url = `${y}/${map.yahoo}?interval=${interval}&range=5d`;
        let r = await safeGet(url);

        let result = r?.data?.chart?.result?.[0];
        if (!result) continue;

        let ts = result.timestamp;
        let o = result.indicators.quote[0];

        return ts.map((t, i) => ({
          time: t * 1000,
          open: o.open[i],
          high: o.high[i],
          low: o.low[i],
          close: o.close[i]
        }));
      } catch {}
    }

    throw new Error("All OHLC sources failed");
  } catch (e) {
    console.error("OHLC error:", e.message);
    return [];
  }
}

export default { fetchPrice, fetchMultiTF };