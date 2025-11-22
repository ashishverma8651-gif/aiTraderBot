// utils.js — FIXED FINAL VERSION (same structure, no breaking changes)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 12000;

// ------------------------------------------------------------
// Helpers (unchanged)
// ------------------------------------------------------------
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}
function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ------------------------------------------------------------
// SAFE MULTI-SOURCE AXIOS
// ------------------------------------------------------------
async function safeAxiosGet(url, bases = []) {
  let tries = [];

  // direct first
  tries.push(url);

  // mirrors
  if (Array.isArray(bases)) {
    for (let b of bases) {
      if (b && b.startsWith("http")) {
        tries.push(url.replace("https://api.binance.com", b));
      }
    }
  }

  for (let u of tries) {
    try {
      const res = await axios.get(u, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "aiTraderBot/1.0" },
      });
      if (res.status === 200) return res.data;
    } catch {}
  }

  return null;
}

// ------------------------------------------------------------
// Normalize Binance Data
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// CRYPTO FETCH (Binance + mirrors)
// ------------------------------------------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const bases = [
    ...(CONFIG.DATA_SOURCES?.BINANCE || []),
    ...(CONFIG.DATA_SOURCES?.BYBIT || []),
    ...(CONFIG.DATA_SOURCES?.KUCOIN || []),
    ...(CONFIG.DATA_SOURCES?.COINBASE || []),
  ];

  const raw = await safeAxiosGet(url, bases);
  if (!raw) return [];
  return normalizeKline(raw);
}

// ------------------------------------------------------------
// NSE DATA FIX (Stable: Yahoo Finance)
// ------------------------------------------------------------
const YMAP = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY"
};

async function fetchYahoo(symbol) {
  try {
    const mapped = YMAP[symbol] || symbol;
    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0];

    const url = `${base}/${mapped}?interval=15m&range=5d`;

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    const raw = res.data?.chart?.result?.[0];

    if (!raw) return [];

    const t = raw.timestamp || [];
    const q = raw.indicators?.quote?.[0] || {};
    const open = q.open || [];
    const high = q.high || [];
    const low = q.low || [];
    const close = q.close || [];
    const vol = q.volume || [];

    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(close[i])) continue;
      out.push({
        t: t[i] * 1000,
        open: Number(open[i]),
        high: Number(high[i]),
        low: Number(low[i]),
        close: Number(close[i]),
        vol: Number(vol[i] || 0)
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------
// fetchMarketData (Crypto)
// ------------------------------------------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  symbol = symbol.toUpperCase();
  let cached = readCache(symbol, interval);

  let fresh = [];

  // Crypto ONLY here
  if (symbol.includes("USDT") || symbol.includes("USD")) {
    try {
      fresh = await fetchCrypto(symbol, interval, limit);
      if (fresh?.length) {
        writeCache(symbol, interval, fresh);
        cached = fresh;
      }
    } catch {}
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
// MULTI TIMEFRAME
// ------------------------------------------------------------
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};

  await Promise.all(
    tfs.map(async tf => {
      try {
        out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT);
      } catch {
        out[tf] = { data: [], price: 0 };
      }
    })
  );

  return out;
}

// ------------------------------------------------------------
// UNIVERSAL FETCH (Crypto + NSE + Yahoo)
// ------------------------------------------------------------
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // 1) Crypto
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return await fetchMarketData(symbol, interval, CONFIG.DEFAULT_LIMIT);
  }

  // 2) India (Nifty + BankNifty etc)
  if (CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol)) {
    const data = await fetchYahoo(symbol);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // 3) Yahoo general stocks
  const yahoo = await fetchYahoo(symbol);
  if (yahoo?.length) {
    return { data: yahoo, price: yahoo.at(-1)?.close || 0 };
  }

  return { data: [], price: 0 };
}