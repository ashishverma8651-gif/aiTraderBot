// ==================================================================
// AI Trader – Universal Market Utils (FINAL BUILD)
// Compatible with merge_signals.js IMPORTS
// ==================================================================

import axios from "axios";
import qs from "querystring";
import CONFIG from "./config.js";

// -------------------------
// Helper
// -------------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// -------------------------
// MARKET SYMBOL RESOLVER
// -------------------------
export function resolveSymbol(market, symbol) {
  const map = CONFIG.SYMBOLS[market];

  if (!map) throw new Error(`Unknown market: ${market}`);

  if (Array.isArray(map)) return symbol;       // Crypto simple list
  if (map[symbol]) return map[symbol];         // Dictionary markets

  throw new Error(`Symbol ${symbol} missing in ${market} mapping`);
}

// -------------------------
// FETCH OHLC WITH FALLBACK
// -------------------------
export async function fetchOHLC(market, symbol, tf, limit = CONFIG.DEFAULT_LIMIT) {
  const sources = CONFIG.DATA_SOURCES_BY_MARKET[market];
  const remote = resolveSymbol(market, symbol);

  let lastErr = null;

  for (const src of sources) {
    for (let i = 0; i < CONFIG.FALLBACK.MAX_RETRIES; i++) {
      try {
        const res = await fetchFromSource(market, src, remote, tf, limit);
        return res;
      } catch (err) {
        lastErr = err;
        await sleep(CONFIG.FALLBACK.RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`All sources failed: ${lastErr?.message}`);
}

// -------------------------
// SELECT SOURCE
// -------------------------
async function fetchFromSource(market, base, symbol, tf, limit) {
  if (market === "CRYPTO") return fetchBinance(base, symbol, tf, limit);
  return fetchYahoo(base, symbol, tf, limit);
}

// -------------------------
// BINANCE (Crypto)
// -------------------------
async function fetchBinance(base, symbol, tf, limit) {
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 8000 });

  if (!Array.isArray(r.data)) throw new Error("Invalid Binance data");

  return r.data.map((c) => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  }));
}

// -------------------------
// YAHOO FINANCE (India, Forex, US Stocks)
// -------------------------
function tfToYahoo(tf) {
  return tf.toLowerCase(); // 1m, 5m, 15m, 30m, 60m
}

async function fetchYahoo(base, symbol, tf, limit) {
  const interval = tfToYahoo(tf);
  const url = `${base}/${symbol}?${qs.stringify({ interval, range: "7d" })}`;

  const r = await axios.get(url, {
    timeout: 9000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json"
    }
  });

  const res = r.data?.chart?.result?.[0];
  if (!res) throw new Error("Yahoo empty result");

  const ts = res.timestamp;
  const q = res.indicators.quote[0];
  const out = [];

  for (let i = 0; i < ts.length; i++) {
    if (!q.open[i] || !q.close[i]) continue;
    out.push({
      time: ts[i] * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] ?? 0
    });
  }

  return out.slice(-limit);
}

// ==================================================================
// EXTRA UTILITIES REQUIRED BY merge_signals.js
// ==================================================================

// -------------------------
// fetchPrice (last close)
// -------------------------
export async function fetchPrice(symbolOverride = null) {
  const market = CONFIG.ACTIVE_MARKET;
  const symbol = symbolOverride || CONFIG.ACTIVE_SYMBOL;

  const data = await fetchOHLC(market, symbol, "1m", 2);
  const last = data[data.length - 1];
  return last.close;
}

// -------------------------
// fetchMultiTF → returns { tf: ohlc[] }
// Used by merge_signals.js
// -------------------------
export async function fetchMultiTF(symbolOverride = null) {
  const market = CONFIG.ACTIVE_MARKET;
  const symbol = symbolOverride || CONFIG.ACTIVE_SYMBOL;

  const out = {};

  for (const tf of CONFIG.INTERVALS) {
    try {
      const data = await fetchOHLC(market, symbol, tf);
      out[tf] = { ok: true, data };
    } catch (err) {
      out[tf] = { ok: false, error: err.message };
    }
  }

  return out;
}

// -------------------------
// loadMarketData (telegram)
// -------------------------
export async function loadMarketData(symbolOverride = null) {
  return await fetchMultiTF(symbolOverride);
}

// EXPORT ALL
export default {
  resolveSymbol,
  fetchOHLC,
  fetchMultiTF,
  fetchPrice,
  loadMarketData
};