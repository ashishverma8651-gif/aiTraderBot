// ==========================================
// ⚙️ utils.js – AI Trader v10.2
// Unified Multi-Market + Multi-Source Data Fetcher
// Cache + KeepAlive + ML-Ready Hooks
// ==========================================

import axios from "axios";
import fs from "fs";
import CONFIG from "./config.js";

// ------------------------------------------
// 🕒 Local Time Helper
// ------------------------------------------
export const nowLocal = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

// ------------------------------------------
// 🌍 KeepAlive (Render + Railway + API Ping)
// ------------------------------------------
export async function keepAlive(url = CONFIG.SELF_PING_URL) {
  const urls = [
    url,
    "https://aitraderbot.onrender.com",
    "https://web-production-f70a.up.railway.app/ping?url=https://aitraderbot.onrender.com",
    "https://api.render.com/v1/ping",
  ];

  for (const u of urls) {
    if (!u) continue;
    try {
      const res = await fetch(u, { method: "GET", timeout: 10000 });
      if (res.ok) {
        console.log(`🌐 KeepAlive OK → ${u}`);
        return;
      } else {
        console.warn(`⚠️ KeepAlive non-200: ${res.status} (${u})`);
      }
    } catch (e) {
      console.warn(`⚠️ KeepAlive failed: ${u} → ${e.message}`);
    }
  }
}

// ------------------------------------------
// 💾 Cache Handling
// ------------------------------------------
export function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE))
      cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf-8"));
    cache[symbol] = { updated: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn(`⚠️ Cache save failed for ${symbol}:`, err.message);
  }
}

export function loadCache(symbol) {
  try {
    if (!fs.existsSync(CONFIG.CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf-8"));
    return cache[symbol] || null;
  } catch {
    return null;
  }
}

// ------------------------------------------
// 🌐 Multi-Source Data Fetch Helper
// ------------------------------------------
async function trySources(urls = [], symbol, interval, limit = 500) {
  for (const base of urls) {
    try {
      const api = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const { data } = await axios.get(api, { timeout: 15000 });
      if (data && data.length) {
        console.log(`✅ Data fetched from ${base} (${interval})`);
        return data;
      }
    } catch (err) {
      console.warn(`⚠️ Source failed: ${base} (${interval}) → ${err.message}`);
    }
  }
  return [];
}

// ------------------------------------------
// 💹 Unified Market Fetcher
// ------------------------------------------
export async function fetchMarketData(symbol, interval = "1m", limit = 500) {
  let marketType = "CRYPTO";
  if (CONFIG.MARKETS.INDIAN.includes(symbol)) marketType = "INDIAN";
  else if (CONFIG.MARKETS.METALS.includes(symbol)) marketType = "METALS";
  else if (CONFIG.MARKETS.FOREX.includes(symbol)) marketType = "FOREX";

  const sources = CONFIG[`${marketType}_SOURCES`];
  let data = await trySources(sources.PRIMARY, symbol, interval, limit);

  if (!data.length) {
    console.warn(`🔁 Trying fallbacks for ${symbol} (${interval})...`);
    data = await trySources(Object.values(sources.FALLBACKS), symbol, interval, limit);
  }

  const candles = (data || [])
    .map(c => ({
      openTime: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .filter(c => !isNaN(c.close) && c.close > 0);

  if (!candles.length) {
    console.warn(`⚠️ No valid candles for ${symbol} (${interval})`);
    return [];
  }

  saveCache(`${symbol}_${interval}`, candles);
  return candles;
}

// ------------------------------------------
// 🧠 All-Phase Data Fetcher (Full 24H Spectrum)
// ------------------------------------------
export async function fetchAllPhases(symbol) {
  const intervals = {
    "1m": 1440,
    "5m": 288,
    "15m": 96,
    "30m": 48,
    "1h": 24,
    "4h": 12,
    "1d": 7,
  };

  const results = {};
  for (const [interval, limit] of Object.entries(intervals)) {
    try {
      const data = await fetchMarketData(symbol, interval, limit);
      results[interval] = data;
    } catch (err) {
      console.warn(`⚠️ Phase fetch failed (${symbol} ${interval}): ${err.message}`);
      results[interval] = [];
    }
  }

  console.log(`🌐 Multi-source data fetched for ${symbol}`);
  return results;
}

// ------------------------------------------
// 🧬 ML Data Normalizer (for ML module use)
// ------------------------------------------
export function prepareMLData(candles) {
  if (!candles || !candles.length) return [];

  // Normalize OHLCV for AI model input
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const norm = closes.map(v => (v - min) / (max - min));

  return norm.map((v, i) => ({
    x: i,
    y: v,
    close: candles[i].close,
    time: candles[i].openTime,
  }));
}

export function buildMLFeatures(candles) {
  if (!candles || candles.length < 2) return [];
  return candles.map((c, i) => ({
    close: c.close,
    change: i ? c.close - candles[i - 1].close : 0,
    volatility: c.high - c.low,
    volume: c.volume,
  }));
}