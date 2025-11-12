// utils.js — robust fetch + normalizer (drop-in)
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const nowLocal = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export async function keepAlive(url = CONFIG.SELF_PING_URL) {
  if (!url) return;
  try {
    // use fetch if available; axios otherwise
    const res = await fetch ? await fetch(url) : await axios.get(url);
    const ok = res?.ok ?? (res?.status === 200);
    if (ok) console.log("🌐 KeepAlive OK");
    else console.warn("⚠️ KeepAlive non-200:", res?.status);
  } catch (e) {
    console.warn("KeepAlive failed:", e?.message || e);
  }
}

/* ---------------- Cache ---------------- */
export function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const txt = fs.readFileSync(CONFIG.CACHE_FILE, "utf8");
      cache = txt ? JSON.parse(txt) : {};
    }
    cache[symbol] = { ts: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e?.message || e);
  }
}
export function readCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const txt = fs.readFileSync(CONFIG.CACHE_FILE, "utf8");
      return txt ? JSON.parse(txt) : {};
    }
  } catch {}
  return {};
}

/* ---------------- safeFetch ---------------- */
async function safeFetch(url, label, transform) {
  try {
    const res = await axios.get(url, {
      timeout: 9000,
      headers: {
        "User-Agent": "AI-TraderBot/1.0 (+https://example)",
        Accept: "application/json, text/plain, */*"
      }
    });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    const out = transform(res.data);
    if (Array.isArray(out) && out.length > 0) {
      console.log(`✅ ${label} OK (${out.length} candles)`);
      return { ok: true, data: out, source: label };
    }
    // if transform returned an object map (multi-tf), accept if any array present
    if (out && typeof out === "object") {
      const any = Object.values(out).some(v => Array.isArray(v) && v.length > 0);
      if (any) {
        console.log(`✅ ${label} OK (multi)`);
        return { ok: true, data: out, source: label };
      }
    }
    throw new Error("No usable data");
  } catch (e) {
    console.warn(`❌ ${label} failed: ${e?.message || e}`);
    return { ok: false };
  }
}

/* ---------------- Crypto (Binance + mirrors) ---------------- */
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  for (const base of CONFIG.BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await safeFetch(url, `Binance(${new URL(base).hostname})`, raw =>
      Array.isArray(raw)
        ? raw.map(k => ({
            t: Number(k?.[0] ?? 0),
            open: Number(k?.[1] ?? 0),
            high: Number(k?.[2] ?? 0),
            low: Number(k?.[3] ?? 0),
            close: Number(k?.[4] ?? 0),
            vol: Number(k?.[5] ?? 0),
          }))
        : []
    );
    if (res.ok) return res;
    await new Promise(r => setTimeout(r, 900));
  }

  // fallback minimal: coinGecko or KuCoin not implemented here (already in your config)
  return { ok: false };
}

/* ---------------- Indian (Yahoo) ---------------- */
async function fetchIndian(symbol) {
  const url = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${symbol}?region=IN&interval=15m&range=1d`;
  return safeFetch(url, "Yahoo.IN", raw => {
    const r = raw?.chart?.result?.[0];
    if (!r) return [];
    return (r.timestamp || []).map((t, i) => {
      const q = r.indicators?.quote?.[0];
      return {
        t: Number(t) * 1000,
        open: Number(q?.open?.[i] ?? 0),
        high: Number(q?.high?.[i] ?? 0),
        low: Number(q?.low?.[i] ?? 0),
        close: Number(q?.close?.[i] ?? 0),
        vol: Number(q?.volume?.[i] ?? 0),
      };
    });
  });
}

/* ---------------- Metals (Yahoo) ---------------- */
async function fetchMetals(symbol) {
  const tick = symbol === "GOLD" ? "GC=F" : "SI=F";
  const url = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${tick}?interval=15m&range=1d`;
  return safeFetch(url, `Yahoo.${symbol}`, raw => {
    const r = raw?.chart?.result?.[0];
    if (!r) return [];
    return (r.timestamp || []).map((t, i) => {
      const q = r.indicators?.quote?.[0];
      return {
        t: Number(t) * 1000,
        open: Number(q?.open?.[i] ?? 0),
        high: Number(q?.high?.[i] ?? 0),
        low: Number(q?.low?.[i] ?? 0),
        close: Number(q?.close?.[i] ?? 0),
        vol: Number(q?.volume?.[i] ?? 0),
      };
    });
  });
}

/* ---------------- Normalizer: ensures close exists + adds 'volume' key for older code ---------------- */
function ensureCandles(raw) {
  if (!raw) return [];

  const normOne = (k) => {
    if (!k) return null;
    if (Array.isArray(k)) {
      return {
        t: Number(k[0] ?? 0),
        open: Number(k[1] ?? 0),
        high: Number(k[2] ?? 0),
        low: Number(k[3] ?? 0),
        close: Number(k[4] ?? 0),
        vol: Number(k[5] ?? 0),
        volume: Number(k[5] ?? 0),
      };
    }
    if (typeof k === "object") {
      const t = Number(k.t ?? k.time ?? k.timestamp ?? 0);
      const close = Number(k.close ?? k.c ?? k.last ?? 0);
      const vol = Number(k.vol ?? k.v ?? k.volume ?? 0);
      return {
        t,
        open: Number(k.open ?? k.o ?? 0),
        high: Number(k.high ?? k.h ?? 0),
        low: Number(k.low ?? k.l ?? 0),
        close,
        vol,
        volume: vol,
      };
    }
    return null;
  };

  // if raw is object with timeframes -> flatten to array (keep timestamps)
  const arr = Array.isArray(raw) ? raw : Object.values(raw).flat();

  const cleaned = arr
    .map(normOne)
    .filter(x => x && Number.isFinite(x.close))
    .sort((a,b) => a.t - b.t);

  return cleaned;
}

/* ---------------- Unified Fetch Entry ---------------- */
export async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 500) {
  console.log(`\n⏳ Fetching data for ${symbol} (${interval})...`);
  try {
    let res = { ok: false };

    if (CONFIG.MARKETS.CRYPTO.includes(symbol)) {
      res = await fetchCrypto(symbol, interval, limit);
    } else if (CONFIG.MARKETS.INDIAN.includes(symbol)) {
      res = await fetchIndian(symbol);
    } else if (CONFIG.MARKETS.METALS.includes(symbol)) {
      res = await fetchMetals(symbol);
    } else {
      console.warn("Unknown market for symbol:", symbol);
    }

    // If we have response data, normalize and validate
    if (res.ok && res.data) {
      const cleaned = ensureCandles(res.data);
      if (!cleaned || cleaned.length === 0) {
        console.warn("⚠️ Candle normalization returned 0 candles");
      } else {
        saveCache(symbol, cleaned);
        return { data: cleaned, source: res.source || "remote" };
      }
    }

    // try cache fallback
    const cache = readCache();
    if (cache[symbol] && Array.isArray(cache[symbol].data) && cache[symbol].data.length) {
      const age = Date.now() - (cache[symbol].ts || 0);
      console.log("♻️ Using cached data for", symbol, "age_ms:", age);
      return { data: cache[symbol].data, source: "cache" };
    }

    console.error("⛔ No market data available for", symbol);
    return { data: [], source: "none" };
  } catch (e) {
    console.error("❌ fetchMarketData error:", e?.message || e);
    return { data: [], source: "error" };
  }
}