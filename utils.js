// utils.js — multi-source fetch, caching, helpers
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour12: true });
}

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
  } catch (e) {
    // ignore
  }
}

// Try a list of base URLs until one works
async function safeAxiosGet(url, bases = [], options = {}) {
  let lastErr = null;
  // try with provided bases first
  for (const b of bases) {
    try {
      // replace default binance host with base when appropriate
      const tryUrl = url.replace("https://api.binance.com", b);
      const res = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG.PROXY || false,
        headers: { "User-Agent": "aiTraderBot/1.0", Accept: "application/json" },
        ...options
      });
      if (res && res.status === 200) return res.data;
    } catch (e) {
      lastErr = e;
    }
  }

  // fall back to original url
  try {
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT, proxy: CONFIG.PROXY || false, ...options });
    if (res && res.status === 200) return res.data;
  } catch (e) {
    lastErr = e;
  }

  console.warn("safeAxiosGet failed:", lastErr?.message || lastErr);
  return null;
}

// normalize Binance klines -> {t, open, high, low, close, vol}
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

// fetchCrypto: tries multiple binance mirrors and fallback sources (only OHLCV endp)
export async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = 200) {
  // primary binance endpoint form
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  // create composite bases array from config (Binance -> Bybit -> KuCoin -> Coinbase)
  const bases = [
    ...(CONFIG.DATA_SOURCES.BINANCE || []),
    ...(CONFIG.DATA_SOURCES.BYBIT || []),
    ...(CONFIG.DATA_SOURCES.KUCOIN || []),
    ...(CONFIG.DATA_SOURCES.COINBASE || [])
  ];

  const raw = await safeAxiosGet(url, bases);
  if (!raw) return [];
  return normalizeKlineArray(raw);
}

// Ensure candles with cache fallback
export async function ensureCandles(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT || 200) {
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

// fetchMarketData wrapper
export async function fetchMarketData(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT || 200) {
  const candles = await ensureCandles(symbol, interval, limit);
  const last = candles.at(-1) || null;
  return {
    data: candles,
    price: last ? Number(last.close || 0) : 0,
    volume: last ? Number(last.vol || 0) : 0,
    updated: nowLocal()
  };
}

// fetch multiple TFs
export async function fetchMultiTF(symbol = "BTCUSDT", tfs = ["1m","5m","15m","30m","1h"]) {
  const out = {};
  await Promise.all(tfs.map(async tf => {
    try {
      out[tf] = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT || 200);
    } catch (e) {
      out[tf] = { data: [], price: 0, volume: 0, error: String(e) };
    }
  }));
  return out;
}

// near top already: import axios from "axios"; import CONFIG from "./config.js";
// Add this function anywhere in utils.js (prefer near other helper/exports)

export async function keepAlive() {
  // If user provided SELF_PING_URL, try that; otherwise try a few fallback urls from config
  const urls = Array.from(new Set([
    CONFIG?.SELF_PING_URL,
    ...(CONFIG?.SERVER?.KEEP_ALIVE_URLS || []),
    // you can add more fallback urls here if you want:
    // `https://${process.env.RENDER_INTERNAL_URL || ""}`
  ].filter(Boolean)));

  if (!urls.length) {
    // nothing to ping — return false but not fatal
    return { ok: false, reason: "no_ping_url" };
  }

  for (const u of urls) {
    try {
      const res = await axios.get(u, { timeout: 8000, proxy: CONFIG?.PROXY || false });
      if (res && (res.status === 200 || res.status === 204 || res.status === 302)) {
        return { ok: true, url: u, status: res.status };
      }
    } catch (e) {
      // try next url
    }
  }
  return { ok: false, reason: "all_failed" };
}
export { nowLocal, readCache, writeCache, cachePath };