// ===============================
// ⚙️ utils.js — AI Trader v10.0
// Unified Multi-Market Data Fetcher + Cache + KeepAlive
// ===============================

import axios from "axios";
import fs from "fs";
import CONFIG from "./config.js";

export const nowLocal = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

// ===============================
// 🌍 KeepAlive (Render prevention)
// ===============================
export async function keepAlive(url = CONFIG.SELF_PING_URL) {
  if (!url) return;
  try {
    const res = await fetch(url);
    if (res.ok) console.log("🌐 KeepAlive OK");
    else console.warn("⚠️ KeepAlive non-200:", res.status);
  } catch (e) {
    console.warn("KeepAlive failed:", e.message);
  }
}

// ===============================
// 💾 Cache Handling
// ===============================
function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE))
      cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
    cache[symbol] = { ts: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e.message);
  }
}

function readCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE))
      return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
  } catch {}
  return {};
}

// ===============================
// 🔄 Generic Fetch Wrapper
// ===============================
async function safeFetch(url, label, transform) {
  try {
    const res = await axios.get(url, { timeout: 8000 });
    if (res.status !== 200) throw new Error(res.status);
    const data = transform(res.data);
    if (Array.isArray(data) && data.length > 0)
      return { ok: true, data, source: label };
    throw new Error("No valid data");
  } catch (e) {
    console.warn(`❌ ${label} failed:`, e.message);
    return { ok: false };
  }
}

// ===============================
// 💱 Market Data Fetchers
// ===============================

// ---- Crypto ----
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  for (const base of CONFIG.CRYPTO_SOURCES.PRIMARY) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const out = await safeFetch(url, `Binance(${base})`, (raw) =>
      Array.isArray(raw)
        ? raw.map((k) => ({
            t: +k[0],
            open: +k[1],
            high: +k[2],
            low: +k[3],
            close: +k[4],
            vol: +k[5],
          }))
        : []
    );
    if (out.ok) return out;
  }

  // fallback
  for (const [label, url] of Object.entries(CONFIG.CRYPTO_SOURCES.FALLBACKS)) {
    console.log(`🔁 Trying fallback: ${label}`);
    const fb = await safeFetch(url, label, () => []);
    if (fb.ok) return fb;
  }
  return { ok: false };
}

// ---- Indian ----
async function fetchIndian(symbol) {
  for (const base of CONFIG.INDIAN_SOURCES.PRIMARY) {
    const url = `${base}/v8/finance/chart/${symbol}?region=IN&interval=15m&range=1d`;
    const out = await safeFetch(url, `Indian(${base})`, (raw) => {
      const r = raw?.chart?.result?.[0];
      if (!r) return [];
      return r.timestamp.map((t, i) => ({
        t: t * 1000,
        open: +r.indicators.quote[0].open[i],
        high: +r.indicators.quote[0].high[i],
        low: +r.indicators.quote[0].low[i],
        close: +r.indicators.quote[0].close[i],
        vol: +r.indicators.quote[0].volume[i],
      }));
    });
    if (out.ok) return out;
  }

  // fallback
  for (const [label, url] of Object.entries(CONFIG.INDIAN_SOURCES.FALLBACKS)) {
    console.log(`🔁 Trying fallback: ${label}`);
    const fb = await safeFetch(url, label, () => []);
    if (fb.ok) return fb;
  }
  return { ok: false };
}

// ---- Metals ----
async function fetchMetals(symbol) {
  const tick = symbol === "GOLD" ? "GC=F" : "SI=F";
  for (const base of CONFIG.METAL_SOURCES.PRIMARY) {
    const url = `${base}/v8/finance/chart/${tick}?interval=15m&range=1d`;
    const out = await safeFetch(url, `Metal(${base})`, (raw) => {
      const r = raw?.chart?.result?.[0];
      if (!r) return [];
      return r.timestamp.map((t, i) => ({
        t: t * 1000,
        open: +r.indicators.quote[0].open[i],
        high: +r.indicators.quote[0].high[i],
        low: +r.indicators.quote[0].low[i],
        close: +r.indicators.quote[0].close[i],
        vol: +r.indicators.quote[0].volume[i],
      }));
    });
    if (out.ok) return out;
  }

  // fallback
  for (const [label, url] of Object.entries(CONFIG.METAL_SOURCES.FALLBACKS)) {
    console.log(`🔁 Trying fallback: ${label}`);
    const fb = await safeFetch(url, label, () => []);
    if (fb.ok) return fb;
  }
  return { ok: false };
}

// ===============================
// 🧮 Normalization Helper
// ===============================
function ensureCandles(raw) {
  if (!raw) return [];
  const norm = (k) => {
    if (!k) return null;
    if (Array.isArray(k))
      return {
        t: +k[0],
        open: +k[1] || 0,
        high: +k[2] || 0,
        low: +k[3] || 0,
        close: +k[4] || 0,
        vol: +k[5] || 0,
      };
    if (typeof k === "object")
      return {
        t: +(k.t ?? k.time ?? 0),
        open: +k.open || +k.o || 0,
        high: +k.high || +k.h || 0,
        low: +k.low || +k.l || 0,
        close: +k.close || +k.c || 0,
        vol: +k.vol || +k.v || 0,
      };
    return null;
  };
  const arr = Array.isArray(raw) ? raw : Object.values(raw).flat();
  return arr.map(norm).filter((x) => x && !isNaN(x.close));
}

// ===============================
// 🧠 Unified Market Data Fetcher
// ===============================
export async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log(`⏳ Fetching data for ${symbol} (${interval})...`);
  let res = { ok: false };

  try {
    if (CONFIG.MARKETS.CRYPTO.includes(symbol)) res = await fetchCrypto(symbol, interval);
    else if (CONFIG.MARKETS.INDIAN.includes(symbol)) res = await fetchIndian(symbol);
    else if (CONFIG.MARKETS.METALS.includes(symbol)) res = await fetchMetals(symbol);

    if (res.ok && res.data?.length) {
      const clean = ensureCandles(res.data);
      if (clean.length === 0) throw new Error("No valid candles");
      saveCache(symbol, clean);
      console.log(`✅ Market data fetched from ${res.source} (${clean.length} candles)`);
      return { data: clean, source: res.source };
    }

    // fallback to cache
    const cache = readCache();
    if (cache[symbol]) {
      console.log(`♻️ Using cached data for ${symbol}`);
      return { data: cache[symbol].data, source: "cache" };
    }

    throw new Error("No valid data available");
  } catch (e) {
    console.error("❌ fetchMarketData error:", e.message);
    return { data: [], source: "error" };
  }
}