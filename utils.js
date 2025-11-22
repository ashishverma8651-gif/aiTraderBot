// utils.js — Final Stable Version (Crypto + Yahoo + Indices + Stocks + Forex)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

// Yahoo symbol mapping
const NSE_INDEX_MAP = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK"
};

// ----------------------------------------------
// Cache system
// ----------------------------------------------
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    if (!fs.existsSync(cachePath(symbol, interval))) return [];
    return JSON.parse(fs.readFileSync(cachePath(symbol, interval), "utf8"));
  } catch {
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ----------------------------------------------
// Crypto Kline Normalizer
// ----------------------------------------------
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];

  return raw.map(k => ({
    t: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    vol: Number(k[5])
  }));
}

// ----------------------------------------------
// Crypto Fetch (Binance)
// ----------------------------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    return normalizeKline(res.data);
  } catch {
    return [];
  }
}

// ----------------------------------------------
// Yahoo Finance Fetcher
// ----------------------------------------------
async function fetchYahoo(symbol, interval = "15m", range = "5d") {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

    const raw = res.data?.chart?.result?.[0];
    if (!raw) return [];

    const ts = raw.timestamp;
    const q = raw.indicators.quote[0];

    return ts.map((t, i) => ({
      t: t * 1000,
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

// ----------------------------------------------
// Universal Fetcher
// ----------------------------------------------
async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // Crypto (BTCUSDT etc)
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    const data = await fetchCrypto(symbol, interval);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // NSE Indices via Yahoo
  if (NSE_INDEX_MAP[symbol]) {
    const mapped = NSE_INDEX_MAP[symbol];
    const data = await fetchYahoo(mapped, interval);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // Stocks / Forex via Yahoo
  const stock = await fetchYahoo(symbol, interval);
  if (stock.length > 0) {
    return {
      data: stock,
      price: stock.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}

// ----------------------------------------------
// Market Data Wrapper (For bot)
// ----------------------------------------------
async function fetchMarketData(symbol, interval = "15m") {
  return fetchUniversal(symbol, interval);
}

// ----------------------------------------------
// Multi-Timeframe Fetcher
// ----------------------------------------------
async function fetchMultiTF(symbol, tfs) {
  const out = {};

  await Promise.all(
    tfs.map(async tf => {
      out[tf] = await fetchUniversal(symbol, tf);
    })
  );

  return out;
}

// ----------------------------------------------
// EXPORTS — VERY IMPORTANT
// ----------------------------------------------
export {
  fetchCrypto,
  fetchYahoo,
  fetchUniversal,
  fetchMarketData,
  fetchMultiTF
};