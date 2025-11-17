// utils.js — multi-source fetch, caching, helpers (FIXED)
// IMPORTS OK
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// -----------------------------------------------------
// CACHE DIRECTORY
// -----------------------------------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

// -----------------------------------------------------
// TIME HELPER
// -----------------------------------------------------
export function nowLocal() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true
  });
}

// -----------------------------------------------------
// CACHE HANDLERS
// -----------------------------------------------------
export function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

export function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}

export function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch (e) {
    // ignore errors
  }
}

// -----------------------------------------------------
// SAFE AXIOS GET (with Binance-only fallback FIXED)
// -----------------------------------------------------
async function safeAxiosGet(url, bases = [], options = {}) {
  let lastErr = null;

  // try each base mirror (BINANCE ONLY)
  for (const b of bases) {
    try {
      const tryUrl = url.replace("https://api.binance.com", b);
      const res = await axios.get(tryUrl, {
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

  // fallback to original
  try {
    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      proxy: CONFIG.PROXY || false,
      ...options
    });
    if (res && res.status === 200) return res.data;
  } catch (e) {
    lastErr = e;
  }

  console.warn("safeAxiosGet failed:", lastErr?.message || lastErr);
  return null;
}

// -----------------------------------------------------
// NORMALIZE BINANCE KLINE FORMAT
// -----------------------------------------------------
function normalizeKlineArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(k => ({
      t: Number(k[0] ?? 0),
      open: Number(k[1] ?? 0),
      high: Number(k[2] ?? 0),
      low: Number(k[3] ?? 0),
      close: Number(k[4] ?? 0),
      vol: Number(k[5] ?? 0)
    }))
    .filter(c => Number.isFinite(c.close));
}

// -----------------------------------------------------
// FETCH CRYPTO OHLCV (BINANCE ONLY FOR ML ACCURACY)
// -----------------------------------------------------
export async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  // FIX: ONLY BINANCE mirrors → ML stable
  const bases = CONFIG.DATA_SOURCES.BINANCE || [];

  const raw = await safeAxiosGet(url, bases);
  if (!raw) return [];

  return normalizeKlineArray(raw);
}

// -----------------------------------------------------
// ENSURE CANDLES WITH CACHE FALLBACK
// -----------------------------------------------------
export async function ensureCandles(symbol, interval, limit = CONFIG.DEFAULT_LIMIT || 200) {
  const cached = readCache(symbol, interval) || [];
  try {
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (Array.isArray(fresh) && fresh.length) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }
    return cached;
  } catch {
    return cached;
  }
}

// -----------------------------------------------------
// WRAPPER: FETCH MARKET DATA (1 TF)
// -----------------------------------------------------
export async function fetchMarketData(symbol, interval, limit = CONFIG.DEFAULT_LIMIT || 200) {
  const candles = await ensureCandles(symbol, interval, limit);
  const last = candles.at(-1) || null;

  return {
    data: candles,
    price: last ? Number(last.close || 0) : 0,
    volume: last ? Number(last.vol || 0) : 0,
    updated: nowLocal()
  };
}

// -----------------------------------------------------
// MULTI-TF FETCH
// -----------------------------------------------------
export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m", "30m", "1h"]) {
  const out = {};
  await Promise.all(
    tfs.map(async tf => {
      try {
        out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT || 200);
      } catch (e) {
        out[tf] = { data: [], price: 0, volume: 0, error: String(e) };
      }
    })
  );
  return out;
}

// -----------------------------------------------------
// KEEP ALIVE PING
// -----------------------------------------------------
export async function keepAlive() {
  const urls = Array.from(
    new Set(
      [
        CONFIG?.SELF_PING_URL,
        ...(CONFIG?.SERVER?.KEEP_ALIVE_URLS || [])
      ].filter(Boolean)
    )
  );

  if (!urls.length) {
    return { ok: false, reason: "no_ping_url" };
  }

  for (const u of urls) {
    try {
      const res = await axios.get(u, {
        timeout: 8000,
        proxy: CONFIG?.PROXY || false
      });
      if (res && [200, 204, 302].includes(res.status)) {
        return { ok: true, url: u, status: res.status };
      }
    } catch {}
  }

  return { ok: false, reason: "all_failed" };
}

// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------
