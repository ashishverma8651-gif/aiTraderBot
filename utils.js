// utils.js — FINAL MULTI-MARKET + MULTI-SOURCE VERSION
// Exports: fetchMarketData, fetchMultiTF, fetchUniversal

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 12000;

// ================= Helpers =================
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
  try { fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2)); } catch {}
}

// Multi-source safe GET (try different bases)
async function safeAxiosGet(url, bases = []) {
  let lastErr = null;

  if (!Array.isArray(bases) || bases.length === 0) bases = [url];

  for (const base of bases) {
    try {
      let finalUrl = url;

      // If base is an alternate exchange mirror
      if (url.includes("https://api.binance.com") && base.startsWith("http")) {
        finalUrl = url.replace("https://api.binance.com", base);
      }

      const res = await axios.get(finalUrl, {
        timeout: AXIOS_TIMEOUT,
        headers: { "User-Agent": "aiTraderBot/1.0", Accept: "application/json" },
        proxy: CONFIG.PROXY ? false : undefined
      });

      if (res?.status === 200) return res.data;
    } catch (e) {
      lastErr = e;
    }
  }
  return null;
}

// Normalize Binance klines
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

// ================= Crypto (Binance + mirrors) =================
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const bases = [
    ...(CONFIG.DATA_SOURCES?.BYBIT || []),
    ...(CONFIG.DATA_SOURCES?.KUCOIN || []),
    ...(CONFIG.DATA_SOURCES?.COINBASE || []),
    ...(CONFIG.DATA_SOURCES?.BINANCE || [])
  ];

  const raw = await safeAxiosGet(url, bases);
  if (!raw) return [];
  return normalizeKline(raw);
}

// ================= NSE (Nifty / BankNifty) =================
async function fetchNSE(symbol = "") {
  try {
    const base = CONFIG.DATA_SOURCES?.NSE?.[0];
    if (!base) return [];

    const url = `${base}/chart-databyindex?index=${symbol}`;
    const res = await axios.get(url, {
      timeout: AXIOS_TIMEOUT,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const raw = res.data?.grapthData || res.data?.data || [];
    if (!Array.isArray(raw)) return [];

    return raw
      .map(c => ({
        t: Number(c.time) * 1000,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.price ?? c.close),
        vol: Number(c.volume ?? 0)
      }))
      .filter(x => Number.isFinite(x.close));
  } catch {
    return [];
  }
}

// ================= Yahoo Finance (stocks / indexes / forex) =================
async function fetchYahoo(symbol = "") {
  try {
    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0];
    if (!base) return [];

    // Remove accidental double slashes
    const url = `${base}/${symbol}?interval=15m&range=5d`.replace(/([^:]\/)\/+/g, "$1");

    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });

    const raw = res.data?.chart?.result?.[0];
    if (!raw) return [];

    const timestamps = raw.timestamp || [];
    const q = raw.indicators?.quote?.[0] || {};

    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) continue;

      out.push({
        t: timestamps[i] * 1000,
        open: Number(q.open?.[i]),
        high: Number(q.high?.[i]),
        low: Number(q.low?.[i]),
        close: Number(close),
        vol: Number(q.volume?.[i] || 0)
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ================== fetchMarketData (cached) ==================
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  symbol = String(symbol || "").toUpperCase();

  let data = readCache(symbol, interval) || [];

  try {
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (fresh?.length > 0) {
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

// ================== fetchMultiTF ==================
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

// ================== fetchUniversal ==================
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = String(symbol || "").toUpperCase();

  // Crypto (BTCUSDT / EURUSD / etc)
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    return await fetchMarketData(symbol, interval, CONFIG.DEFAULT_LIMIT);
  }

  // Indian NSE
  if (CONFIG.MARKETS?.INDIA?.INDEXES?.includes(symbol)) {
    const data = await fetchNSE(symbol);
    return {
      data,
      price: data.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  // Yahoo fallback
  const yahoo = await fetchYahoo(symbol);
  if (yahoo?.length > 0) {
    return {
      data: yahoo,
      price: yahoo.at(-1)?.close || 0,
      updated: new Date().toISOString()
    };
  }

  return { data: [], price: 0, updated: new Date().toISOString() };
}