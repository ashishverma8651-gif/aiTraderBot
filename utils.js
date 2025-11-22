// utils.js — FINAL MULTI-MARKET FIXED VERSION
// Crypto (Binance/Bybit/Kucoin/Coinbase) + NSE (header fix + fallback) + Yahoo
// CLEAN EXPORTS: fetchMarketData, fetchMultiTF, fetchUniversal

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS.CACHE_DIR;
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
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

function normalize(c) {
  return c.filter(x => x && Number.isFinite(Number(x.close)));
}

// ------------------------------------------------------------
// MULTI-SOURCE HTTP fallback
// ------------------------------------------------------------
async function safeGet(url, baseHosts = []) {
  for (const base of baseHosts) {
    try {
      const newUrl = url.replace("https://api.binance.com", base);

      const res = await axios.get(newUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        proxy: CONFIG.PROXY || false,
      });

      if (res.status === 200) return res.data;

    } catch (e) {}
  }
  return null;
}

// ------------------------------------------------------------
// CRYPTO (Binance → fallback chain)
// ------------------------------------------------------------
async function fetchCrypto(symbol, interval, limit = 300) {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const sources = [
    ...CONFIG.DATA_SOURCES.BINANCE,
    ...CONFIG.DATA_SOURCES.BYBIT,
    ...CONFIG.DATA_SOURCES.KUCOIN,
    ...CONFIG.DATA_SOURCES.COINBASE
  ];

  const raw = await safeGet(url, sources);
  if (!raw || !Array.isArray(raw)) return [];

  return raw.map(k => ({
    t: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    vol: Number(k[5]),
  }));
}

// ------------------------------------------------------------
// NSE — FULL FIX (Header spoof + fallback → Yahoo)
// ------------------------------------------------------------
async function fetchNSE(symbol) {
  try {
    const url = `${CONFIG.DATA_SOURCES.NSE[0]}/api/chart-databyindex?index=${symbol}`;

    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*",
        "Referer": "https://www.nseindia.com",
        "Origin": "https://www.nseindia.com"
      },
      proxy: CONFIG.PROXY || false,
    });

    const arr = res.data?.grapthData || [];
    if (!arr.length) return [];

    return arr.map(x => ({
      t: Number(x.time) * 1000,
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.price),
      vol: Number(x.volume || 0),
    }));

  } catch (e) {
    // Fallback to Yahoo
    return await fetchYahoo(symbol + ".NS");
  }
}

// ------------------------------------------------------------
// Yahoo
// ------------------------------------------------------------
async function fetchYahoo(symbol) {
  try {
    const url =
      `${CONFIG.DATA_SOURCES.YAHOO[0]}/${symbol}?interval=15m&range=7d`;

    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const d = res.data.chart?.result?.[0];

    if (!d) return [];

    const t = d.timestamp;
    const q = d.indicators.quote[0];

    return t.map((ts, i) => ({
      t: ts * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      vol: q.volume[i] || 0
    })).filter(x => x.close);

  } catch {
    return [];
  }
}

// ------------------------------------------------------------
// EXPORT #1 — fetchMarketData (crypto only primary)
// ------------------------------------------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  let cached = readCache(symbol, interval);

  const fresh = await fetchCrypto(symbol, interval, limit);

  if (fresh.length) {
    writeCache(symbol, interval, fresh);
    cached = fresh;
  }

  const last = cached.at(-1) || {};

  return {
    data: cached,
    price: Number(last.close || 0),
    volume: Number(last.vol || 0),
    updated: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// EXPORT #2 — fetchMultiTF
// ------------------------------------------------------------
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m", "30m", "1h"]) {
  const out = {};

  await Promise.all(
    tfs.map(async tf => {
      try {
        out[tf] = await fetchMarketData(symbol, tf);
      } catch {
        out[tf] = { data: [], price: 0 };
      }
    })
  );

  return out;
}

// ------------------------------------------------------------
// EXPORT #3 — UNIVERSAL (Crypto + NSE + Yahoo)
// ------------------------------------------------------------
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // crypto
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return await fetchMarketData(symbol, interval);
  }

  // NSE
  if (CONFIG.MARKETS.INDIA.INDEXES.includes(symbol)) {
    const n = await fetchNSE(symbol);
    return {
      data: n,
      price: n.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // STOCKS → Yahoo
  const y = await fetchYahoo(symbol);
  if (y.length) {
    return {
      data: y,
      price: y.at(-1).close,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}