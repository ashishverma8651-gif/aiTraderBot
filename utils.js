// utils.js — AI Trader v9.6 (Final Stable)
import axios from "axios";
import fs from "fs";
import CONFIG from "./config.js";

// ===========================
// 🕒 Time + KeepAlive
// ===========================
export function nowLocal() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export async function keepAlive(selfPingUrl = CONFIG.SELF_PING_URL) {
  if (!selfPingUrl) return;
  try {
    const res = await fetch(selfPingUrl);
    if (res.ok) console.log("🌐 KeepAlive OK");
    else console.warn("⚠️ KeepAlive non-200:", res.status);
  } catch (e) {
    console.warn("KeepAlive failed:", e.message);
  }
}

// ===========================
// 💾 Cache System
// ===========================
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

// ===========================
// 🌍 Safe Fetch Utility
// ===========================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeFetch(url, label, transform) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (AI-TraderBot-v9.6)",
        Accept: "application/json,text/plain,*/*"
      }
    });

    if (res.status === 200) {
      const data = transform(res.data);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ ${label} OK (${data.length} candles)`);
        return { ok: true, data, source: label };
      }
    }
    throw new Error(`Bad response ${res.status}`);
  } catch (e) {
    console.warn(`❌ ${label} failed: ${e.message}`);
    return { ok: false };
  }
}

// ===========================
// 🟢 Crypto (Binance + Vision + Fallbacks)
// ===========================
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  // Try all Binance sources
  for (const base of CONFIG.BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await safeFetch(url, `Binance(${base.split("/")[2]})`, (raw) =>
      Array.isArray(raw)
        ? raw.map(k => ({
            t: k[0],
            open: +k[1],
            high: +k[2],
            low: +k[3],
            close: +k[4],
            vol: +k[5],
          }))
        : []
    );
    if (res.ok) return res;
    await delay(1200);
  }

  // CoinGecko fallback
  const cg = await safeFetch(
    `${CONFIG.FALLBACK_SOURCES.COINGECKO}/coins/bitcoin/market_chart?vs_currency=usd&days=1`,
    "CoinGecko",
    (raw) =>
      Array.isArray(raw?.prices)
        ? raw.prices.map(p => ({
            t: p[0],
            open: p[1],
            high: p[1],
            low: p[1],
            close: p[1],
            vol: 0
          }))
        : []
  );
  if (cg.ok) return cg;

  // KuCoin fallback
  const ku = await safeFetch(
    `${CONFIG.FALLBACK_SOURCES.KUCOIN}/api/v1/market/candles?symbol=${symbol}&type=15min`,
    "KuCoin",
    (raw) =>
      Array.isArray(raw?.data)
        ? raw.data.map(k => ({
            t: +k[0] * 1000,
            open: +k[1],
            high: +k[2],
            low: +k[3],
            close: +k[4],
            vol: +k[5],
          }))
        : []
  );
  if (ku.ok) return ku;

  console.warn("⚠️ All crypto sources failed, switching to cache...");
  return { ok: false };
}

// ===========================
// 🇮🇳 Indian Market
// ===========================
async function fetchIndian(symbol) {
  const nseUrl = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
  const yahooUrl = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${symbol}?region=IN&interval=15m&range=1d`;

  const nse = await safeFetch(nseUrl, "NSE India", (raw) => {
    const price = raw?.priceInfo?.lastPrice;
    if (!price) return [];
    return [{ t: Date.now(), open: price, high: price, low: price, close: price, vol: 0 }];
  });
  if (nse.ok) return nse;

  const yahoo = await safeFetch(yahooUrl, "Yahoo Finance (IN)", (raw) => {
    const res = raw?.chart?.result?.[0];
    if (!res) return [];
    return res.timestamp.map((t, i) => ({
      t: t * 1000,
      open: res.indicators.quote[0].open[i],
      high: res.indicators.quote[0].high[i],
      low: res.indicators.quote[0].low[i],
      close: res.indicators.quote[0].close[i],
      vol: res.indicators.quote[0].volume[i],
    }));
  });
  if (yahoo.ok) return yahoo;

  return { ok: false };
}

// ===========================
// 🟡 Metals (Gold, Silver)
// ===========================
async function fetchMetals(symbol) {
  const tick = symbol === "GOLD" ? "GC=F" : "SI=F";
  const url = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${tick}?interval=15m&range=1d`;
  const yahoo = await safeFetch(url, `Yahoo ${symbol}`, (raw) => {
    const res = raw?.chart?.result?.[0];
    if (!res) return [];
    return res.timestamp.map((t, i) => ({
      t: t * 1000,
      open: res.indicators.quote[0].open[i],
      high: res.indicators.quote[0].high[i],
      low: res.indicators.quote[0].low[i],
      close: res.indicators.quote[0].close[i],
      vol: res.indicators.quote[0].volume[i],
    }));
  });
  if (yahoo.ok) return yahoo;

  return { ok: false };
}

// =====================================================
// 🕯️ Candle Normalizer (handles arrays and objects)
// =====================================================
function ensureCandles(raw) {
  if (!raw) return [];

  const normalizeOne = (k) => {
    if (!k) return null;
    if (Array.isArray(k)) {
      // Binance / generic OHLC array [t, o, h, l, c, v]
      return {
        t: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        vol: Number(k[5] ?? 0),
      };
    } else if (typeof k === "object") {
      // Object format { open, high, low, close, volume, time }
      return {
        t: Number(k.t ?? k.time ?? k.timestamp ?? 0),
        open: Number(k.open ?? k.o ?? 0),
        high: Number(k.high ?? k.h ?? 0),
        low: Number(k.low ?? k.l ?? 0),
        close: Number(k.close ?? k.c ?? 0),
        vol: Number(k.vol ?? k.v ?? k.volume ?? 0),
      };
    }
    return null;
  };

  if (Array.isArray(raw)) {
    return raw
      .map(normalizeOne)
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  }

  if (typeof raw === "object") {
    const out = {};
    for (const [tf, arr] of Object.entries(raw)) {
      if (Array.isArray(arr)) {
        out[tf] = arr
          .map(normalizeOne)
          .filter(Boolean)
          .sort((a, b) => a.t - b.t);
      }
    }
    return out;
  }

  return [];
}

// =====================================================
// 🌍 Unified Fetch Entry
// =====================================================
export async function fetchMarketData(symbol = CONFIG.SYMBOL) {
  let result = { ok: false };
  console.log(`\n⏳ Fetching data for ${symbol}...`);

  try {
    // Select market source dynamically
    if (CONFIG.MARKETS.CRYPTO.includes(symbol)) {
      result = await fetchCrypto(symbol);
    } else if (CONFIG.MARKETS.INDIAN.includes(symbol)) {
      result = await fetchIndian(symbol);
    } else if (CONFIG.MARKETS.METALS.includes(symbol)) {
      result = await fetchMetals(symbol);
    }

    // Validate and normalize response
    if (result.ok && result.data) {
      let normalized;
      try {
        normalized = ensureCandles(result.data);
      } catch (e) {
        console.warn("⚠️ Candle normalization failed:", e.message);
        normalized = result.data;
      }

      if (Array.isArray(normalized) && normalized.length === 0) {
        console.warn("⚠️ No valid candle data for", symbol);
      }

      saveCache(symbol, normalized);
      return { data: normalized, source: result.source };
    }

    // Try cached data fallback
    const cache = readCache();
    if (cache[symbol] && Date.now() - cache[symbol].ts < CONFIG.CACHE_RETENTION_MS) {
      console.log("♻️ Using cached data for", symbol);
      return { data: cache[symbol].data, source: "cache" };
    }

    // If nothing works
    console.error("⛔ No market data available for", symbol);
    return { data: [], source: "none" };
  } catch (err) {
    console.error("❌ fetchMarketData error:", err.message);
    return { data: [], source: "error" };
  }
}