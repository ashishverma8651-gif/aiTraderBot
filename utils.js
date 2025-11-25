// utils.js — FIXED FULL VERSION (LIVE PRICE + FULL OHLC)
import axios from "axios";
import CONFIG from "./config.js";

// ---------------------------------------------------------
// SAFE HTTP GET (Proxy + retry + timeout)
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
// FETCH PRICE — MULTI-MARKET
// ---------------------------------------------------------
export async function fetchPrice(symbol, market) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];
    if (!map) throw new Error("Invalid symbol map");

    // --------------------
    // CRYPTO
    // --------------------
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/ticker/price?symbol=${map.binance}`;
          let r = await safeGet(url);
          if (r?.data?.price) return parseFloat(r.data.price);
        } catch {}
      }

      // fallback yahoo
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }
    }

    // --------------------
    // INDIA
    // --------------------
    if (market === "INDIA") {
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }

      // TradingView proxy
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

    // --------------------
    // FOREX
    // --------------------
    if (market === "FOREX") {
      for (const y of CONFIG.API.YAHOO) {
        try {
          let url = `${y}/${map.yahoo}?interval=1m&range=1d`;
          let r = await safeGet(url);
          let p = r?.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (p) return parseFloat(p);
        } catch {}
      }

      // Fix: base / quote splitting
      try {
        let base = symbol.slice(0, 3);
        let quote = symbol.slice(3);

        let url = `${CONFIG.API.EXCHANGERATE}/latest?base=${base}&symbols=${quote}`;
        let r = await safeGet(url);
        let p = r?.data?.rates?.[quote];
        if (p) return parseFloat(p);
      } catch {}
    }

    // --------------------
    // COMMODITIES
    // --------------------
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

    throw new Error(`ALL PRICE SOURCES FAILED for ${symbol}`);
  } catch (e) {
    console.error("PriceError:", e.message);
    return null;
  }
}

// ---------------------------------------------------------
// MULTI-TF FETCHER (RSI/ATR USES THIS)
// ---------------------------------------------------------
export async function fetchMultiTF(symbol, market, intervals = CONFIG.INTERVALS) {
  let result = {};

  for (const tf of intervals) {
    let candles = await fetchOHLC(symbol, market, tf);
    result[tf] = candles;
  }

  return result;
}

// ---------------------------------------------------------
// UNIVERSAL OHLC FETCHER
// ---------------------------------------------------------
async function fetchOHLC(symbol, market, interval) {
  try {
    const map = CONFIG.SYMBOLS[market][symbol];
    if (!map) throw new Error("Invalid symbol map");

    // --------------------
    // CRYPTO → BINANCE
    // --------------------
    if (market === "CRYPTO") {
      for (const host of CONFIG.API.BINANCE) {
        try {
          let url = `${host}/api/v3/klines?symbol=${map.binance}&interval=${interval}&limit=200`;
          let r = await safeGet(url);

          return r.data.map(c => ({
            time: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));
        } catch {}
      }
    }

    // --------------------
    // STOCK / INDEX / FOREX / COMMODITY → YAHOO
    // --------------------
    for (const y of CONFIG.API.YAHOO) {
      try {
        let url = `${y}/${map.yahoo}?interval=${interval}&range=5d`;
        let r = await safeGet(url);

        let res = r?.data?.chart?.result?.[0];
        if (!res || !res.timestamp) continue;

        let ts = res.timestamp;
        let q = res.indicators?.quote?.[0];

        return ts.map((t, i) => ({
          time: t * 1000,
          open: q.open[i],
          high: q.high[i],
          low: q.low[i],
          close: q.close[i],
          volume: q.volume[i]
        })).filter(x => Number.isFinite(x.close));
      } catch {}
    }

    throw new Error("All OHLC sources failed");
  } catch (e) {
    console.error("OHLC error:", e.message);
    return [];
  }
}

export default { fetchPrice, fetchMultiTF };