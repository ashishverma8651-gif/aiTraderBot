// utils.js — FINAL MULTI-MARKET + MULTI-SOURCE VERSION
// Supports: Crypto (Binance/Bybit/Kucoin/Coinbase) + NSE + Yahoo (Stocks)
// Export only: fetchMarketData, fetchMultiTF, fetchUniversal

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 12000;

// =====================================================================
// INTERNAL HELPERS
// =====================================================================

// Cache paths
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// MULTI-SOURCE SAFE REQUEST (Crypto)
async function safeAxiosGet(url, bases) {
  let lastError = null;

  for (const base of bases) {
    try {
      const fixed = url.replace("https://api.binance.com", base);

      const res = await axios.get(fixed, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG.PROXY ? false : undefined,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json"
        }
      });

      if (res.status === 200) return res.data;

    } catch (e) {
      lastError = e;
    }
  }

  return null;
}

// Format Binance candles
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map(k => ({
      t: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      vol: Number(k[5])
    }))
    .filter(c => Number.isFinite(c.close));
}

// =====================================================================
// INTERNAL — Crypto (Binance/Bybit/Kucoin/Coinbase)
// =====================================================================
async function fetchCrypto(symbol, interval, limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const bases = [
    ...CONFIG.DATA_SOURCES.BYBIT,
    ...CONFIG.DATA_SOURCES.KUCOIN,
    ...CONFIG.DATA_SOURCES.COINBASE,
    ...CONFIG.DATA_SOURCES.BINANCE
  ];

  const raw = await safeAxiosGet(url, bases);
  if (!raw) return [];

  return normalizeKline(raw);
}

// =====================================================================
// INTERNAL — NSE (NIFTY / BankNifty)
// =====================================================================
async function fetchNSE(symbol) {
  try {
    const url = `${CONFIG.DATA_SOURCES.NSE[0]}/chart-databyindex?index=${symbol}`;
    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const raw = res.data?.grapthData || [];
    if (!Array.isArray(raw)) return [];

    return raw.map(c => ({
      t: Number(c.time) * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.price,
      vol: c.volume ?? 0
    }));
  } catch {
    return [];
  }
}

// =====================================================================
// INTERNAL — Yahoo (Stocks & Index)
// =====================================================================
async function fetchYahoo(symbol) {
  try {
    const url = `${CONFIG.DATA_SOURCES.YAHOO[0]}/${symbol}?interval=15m&range=5d`;

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    const raw = res.data?.chart?.result?.[0];

    if (!raw) return [];

    const t = raw.timestamp;
    const q = raw.indicators?.quote?.[0];

    return t.map((ti, i) => ({
      t: ti * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      vol: q.volume[i] || 0
    })).filter(c => c.close);
  } catch {
    return [];
  }
}

// =====================================================================
// EXPORT #1 — fetchMarketData (Crypto Only)
// =====================================================================
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  let data = readCache(symbol, interval);

  try {
    const fresh = await fetchCrypto(symbol, interval, limit);

    if (fresh.length > 0) {
      writeCache(symbol, interval, fresh);
      data = fresh;
    }
  } catch {}

  const last = data.at(-1) || {};
  return {
    data,
    price: Number(last.close || 0),
    volume: Number(last.vol || 0),
    updated: new Date().toISOString()
  };
}

// =====================================================================
// EXPORT #2 — fetchMultiTF (Crypto Only)
// =====================================================================
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};

  await Promise.all(
    tfs.map(async (tf) => {
      try {
        out[tf] = await fetchMarketData(symbol, tf);
      } catch {
        out[tf] = { data: [], price: 0 };
      }
    })
  );

  return out;
}

// =====================================================================
// EXPORT #3 — UNIVERSAL (Crypto + NSE + Yahoo)
// =====================================================================
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // Crypto symbols (BTCUSDT, ETHUSDT, SOLUSDT...)
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return fetchMarketData(symbol, interval);
  }

  // NSE Index
  if (CONFIG.MARKETS.INDIA.INDEXES.includes(symbol)) {
    const data = await fetchNSE(symbol);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // Stocks → Yahoo
  const y = await fetchYahoo(symbol);
  if (y.length > 0) {
    return {
      data: y,
      price: y.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // Fallback
  return { data: [], price: 0, updated: new Date().toISOString() };
}