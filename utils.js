// utils.js — Robust multi-source fetch + KeepAlive + cache
// Place this at src/utils.js (ES module)
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// default cache file (from CONFIG or fallback)
const CACHE_FILE = CONFIG.CACHE_FILE || path.join(CACHE_DIR, "marketData.json");
const AXIOS_TIMEOUT = 10000;

// helper: localized now
export const nowLocal = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

// ---------------- KeepAlive (fallback ping list) ----------------
export async function keepAlive(url = CONFIG.SELF_PING_URL) {
  if (!url && !Array.isArray(CONFIG.KEEP_ALIVE_URLS)) return;
  // prepare URL list (dedupe)
  const urls = Array.from(
    new Set(
      [
        ...(url ? [url] : []),
        CONFIG.SELF_PING_URL,
        ...(CONFIG.KEEP_ALIVE_URLS || []),
        "https://aitraderbot.onrender.com",
        "https://api.render.com/v1/ping"
      ].filter(Boolean)
    )
  );

  for (const u of urls) {
    try {
      const res = await fetch(u, { method: "GET", timeout: AXIOS_TIMEOUT });
      if (res && res.ok) {
        console.log("🌐 KeepAlive OK ->", u);
        return { ok: true, url: u, status: res.status };
      } else {
        console.warn("⚠️ KeepAlive non-200:", u, res && res.status);
      }
    } catch (e) {
      // continue to next URL silently (but log)
      console.warn("KeepAlive failed for", u, e && e.message);
    }
  }
  return { ok: false };
}

// ---------------- Cache helpers ----------------
function saveCache(sym, data) {
  try {
    let cache = {};
    if (fs.existsSync(CACHE_FILE)) {
      const txt = fs.readFileSync(CACHE_FILE, "utf8");
      cache = txt ? JSON.parse(txt) : {};
    }
    cache[sym] = { ts: Date.now(), data };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e && e.message);
  }
}
function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const txt = fs.readFileSync(CACHE_FILE, "utf8");
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    return {};
  }
}

// ---------------- Safe fetch wrapper ----------------
async function safeAxiosGet(url, label, transform) {
  try {
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    const out = transform(res.data);
    if (Array.isArray(out) && out.length > 0) return { ok: true, data: out, source: label };
    // some transforms might return object -> still accept if normalized by caller
    if (out && Array.isArray(out.data)) return { ok: true, data: out.data, source: label };
    throw new Error("No usable data");
  } catch (e) {
    // don't spam the logs — warn
    console.warn(`❌ ${label} failed:`, e && e.message);
    return { ok: false };
  }
}

// ---------------- Normalizer ----------------
function normCandle(k) {
  if (!k) return null;
  if (Array.isArray(k)) {
    // Binance Kline format: [t, open, high, low, close, vol, ...]
    return {
      t: Number(k[0]) || 0,
      open: Number(k[1]) || 0,
      high: Number(k[2]) || 0,
      low: Number(k[3]) || 0,
      close: Number(k[4]) || 0,
      vol: Number(k[5]) || 0
    };
  }
  if (typeof k === "object") {
    return {
      t: Number(k.t ?? k.time ?? k.timestamp ?? 0),
      open: Number(k.open ?? k.o ?? k.c ?? 0),
      high: Number(k.high ?? k.h ?? k.c ?? 0),
      low: Number(k.low ?? k.l ?? k.c ?? 0),
      close: Number(k.close ?? k.c ?? 0),
      vol: Number(k.vol ?? k.v ?? k.volume ?? 0)
    };
  }
  return null;
}

function ensureCandles(raw) {
  if (!raw) return [];
  // If raw has chart.result (Yahoo)
  if (raw?.chart?.result?.[0]) {
    const r = raw.chart.result[0];
    const ts = r.timestamp || [];
    const quotes = r.indicators?.quote?.[0];
    if (!ts.length || !quotes) return [];
    return ts.map((t, i) => normCandle({
      t: t * 1000,
      open: quotes.open?.[i],
      high: quotes.high?.[i],
      low: quotes.low?.[i],
      close: quotes.close?.[i],
      vol: quotes.volume?.[i]
    })).filter(c => c && !Number.isNaN(c.close));
  }

  // If raw is Binance array of arrays or similar
  if (Array.isArray(raw)) {
    return raw.map(normCandle).filter(c => c && !Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }

  // fallback: try to flatten object values
  if (typeof raw === "object") {
    const arr = Object.values(raw).flat(Infinity);
    const mapped = arr.map(normCandle).filter(c => c && !Number.isNaN(c.close));
    return mapped.sort((a,b)=>a.t-b.t);
  }
  return [];
}

// ---------------- Source resolvers ----------------
function getCryptoPrimaries() {
  if (CONFIG.CRYPTO_SOURCES && Array.isArray(CONFIG.CRYPTO_SOURCES.PRIMARY))
    return CONFIG.CRYPTO_SOURCES.PRIMARY;
  if (Array.isArray(CONFIG.BINANCE_SOURCES)) return CONFIG.BINANCE_SOURCES;
  return ["https://data-api.binance.vision", "https://api.binance.com"];
}
function getCryptoFallbacks() {
  if (CONFIG.CRYPTO_SOURCES && CONFIG.CRYPTO_SOURCES.FALLBACKS) return CONFIG.CRYPTO_SOURCES.FALLBACKS;
  return CONFIG.FALLBACK_SOURCES || {};
}

// ---------------- Fetchers ----------------
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  const primaries = getCryptoPrimaries();
  for (const base of primaries) {
    try {
      // use Binance kline endpoint form
      const url = `${base.replace(/\/$/, "")}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const out = await safeAxiosGet(url, `Binance(${base})`, raw => {
        // Binance returns array of arrays
        if (Array.isArray(raw)) return raw;
        // some mirrors wrap result
        if (raw && raw.code === 200 && Array.isArray(raw.data)) return raw.data;
        return [];
      });
      if (out.ok) {
        const clean = ensureCandles(out.data);
        if (clean.length) return { ok: true, data: clean, source: `Binance(${base})` };
      }
    } catch (e) {
      console.warn("fetchCrypto error for", base, e && e.message);
    }
  }

  // try fallbacks (CoinGecko doesn't provide klines in same format, but attempt)
  const fallbacks = getCryptoFallbacks();
  if (fallbacks.COINGECKO) {
    try {
      const url = `${fallbacks.COINGECKO.replace(/\/$/, "")}/coins/${symbol.replace("USDT","").toLowerCase()}/market_chart?vs_currency=usd&days=1`; // best-effort
      const out = await safeAxiosGet(url, "CoinGecko", raw => {
        // coingecko returns: prices [[ts, price], ...], total_volumes etc
        if (!raw || !Array.isArray(raw.prices)) return [];
        return raw.prices.map(p => [p[0], p[1], p[1], p[1], p[1], 0]);
      });
      if (out.ok) {
        const clean = ensureCandles(out.data);
        if (clean.length) return { ok: true, data: clean, source: "CoinGecko" };
      }
    } catch (e) {}
  }

  return { ok: false };
}

async function fetchIndian(symbol) {
  // use Yahoo chart as fallback (format handled in ensureCandles)
  const yahoo = CONFIG.FALLBACK_SOURCES?.YAHOO || "https://query1.finance.yahoo.com";
  const url = `${yahoo}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=15m&range=1d`;
  return safeAxiosGet(url, "Yahoo(IN)", raw => raw);
}

async function fetchMetals(symbol) {
  const yahoo = CONFIG.METAL_SOURCES?.PRIMARY?.[0] || CONFIG.FALLBACK_SOURCES?.YAHOO || "https://query1.finance.yahoo.com";
  const tick = symbol === "GOLD" ? "GC=F" : "SI=F";
  const url = `${yahoo}/v8/finance/chart/${encodeURIComponent(tick)}?interval=15m&range=1d`;
  return safeAxiosGet(url, `Yahoo(${symbol})`, raw => raw);
}

// ---------------- Unified Entry ----------------
/**
 * fetchMarketData(symbol, interval = "15m", limit = 500)
 * Always returns object: { data: [candles], source: "string" }
 * Never throws.
 */
export async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 500) {
  try {
    console.log(`⏳ Fetching ${symbol}...`);

    // Determine which market list exists safely
    const isCrypto = Array.isArray(CONFIG.MARKETS?.CRYPTO) && CONFIG.MARKETS.CRYPTO.includes(symbol)
      || Array.isArray(CONFIG.MARKETS?.CRYPTO) === false && String(symbol).toUpperCase().endsWith("USDT");

    const isIndian = Array.isArray(CONFIG.MARKETS?.INDIAN) && CONFIG.MARKETS.INDIAN.includes(symbol);
    const isMetal = Array.isArray(CONFIG.MARKETS?.METALS) && CONFIG.MARKETS.METALS.includes(symbol);

    let res = { ok: false };

    if (isCrypto) res = await fetchCrypto(symbol, interval, limit);
    else if (isIndian) res = await fetchIndian(symbol);
    else if (isMetal) res = await fetchMetals(symbol);
    else {
      // try crypto first for anything else (safe default)
      res = await fetchCrypto(symbol, interval, limit);
    }

    if (res.ok && res.data) {
      const clean = ensureCandles(res.data);
      if (clean && clean.length) {
        saveCache(symbol, clean);
        console.log("✅ Market data fetched from", res.source, `(${clean.length} candles)`);
        return { data: clean, source: res.source || "remote" };
      } else {
        console.warn("⚠️ No valid candles after normalization");
      }
    }

    // fallback to cache if available
    const cache = readCache();
    if (cache[symbol] && Array.isArray(cache[symbol].data) && cache[symbol].data.length) {
      console.log("♻️ Using cache for", symbol);
      return { data: cache[symbol].data, source: "cache" };
    }

    console.warn("No market data available (remote failed + no cache)");
    return { data: [], source: "error" };
  } catch (e) {
    console.error("❌ fetchMarketData error:", e && e.message);
    const cache = readCache();
    if (cache[symbol] && cache[symbol].data) return { data: cache[symbol].data, source: "cache" };
    return { data: [], source: "error" };
  }
}
export default { nowLocal, keepAlive, fetchMarketData };