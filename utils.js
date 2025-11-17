// utils.js — STABLE WORKING VERSION (Bybit → Kucoin → Coinbase → Binance)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

// ======================
// Cache Helpers
// ======================
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

// ======================
// safeAxiosGet — multi-source
// ======================
async function safeAxiosGet(url, bases = [], options = {}) {
  let lastErr = null;

  for (const base of bases) {
    try {
      const fixedURL = url.replace("https://api.binance.com", base);

      const res = await axios.get(fixedURL, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG.PROXY || false,
        headers: {
          "User-Agent": "aiTraderBot/1.0",
          Accept: "application/json"
        },
        ...options
      });

      if (res && res.status === 200) return res.data;

    } catch (e) {
      lastErr = e;
    }
  }

  return null;
}

// ======================
// Normalizer
// ======================
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

// ======================
// FETCH WRAPPER
// ======================
export async function fetchCrypto(symbol, interval, limit = 200) {

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  // 👉 WORKING PRIORITY ORDER
  const bases = [
    ...CONFIG.DATA_SOURCES.BYBIT,
    ...CONFIG.DATA_SOURCES.KUCOIN,
    ...CONFIG.DATA_SOURCES.COINBASE,
    ...CONFIG.DATA_SOURCES.BINANCE  // Binance always last
  ];

  const raw = await safeAxiosGet(url, bases);

  if (!raw) return [];
  return normalizeKline(raw);
}

// ======================
// Candle Fetcher
// ======================
export async function ensureCandles(symbol, interval, limit = 200) {
  const cached = readCache(symbol, interval);

  try {
    const fresh = await fetchCrypto(symbol, interval, limit);

    if (fresh && fresh.length > 0) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }

    return cached;

  } catch {
    return cached;
  }
}

export async function fetchMarketData(symbol, interval, limit = 200) {
  const data = await ensureCandles(symbol, interval, limit);
  const last = data.at(-1) || {};

  return {
    data,
    price: Number(last.close || 0),
    volume: Number(last.vol || 0),
    updated: new Date().toISOString()
  };
}

export async function fetchMultiTF(symbol, tfs) {
  const out = {};

  await Promise.all(tfs.map(async (tf) => {
    try {
      out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT);
    } catch {
      out[tf] = { data: [], price: 0 };
    }
  }));

  return out;
}