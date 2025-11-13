// utils.js — v11.1 (Stable + Named Exports Fix)
import axios from "axios";
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import EventEmitter from "events";
import CONFIG from "./config.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_FILE = CONFIG.CACHE_FILE || path.join(CACHE_DIR, "marketData.json");
const AXIOS_TIMEOUT = 10000;

// ---------------- TIME ----------------
export const nowLocal = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

// ---------------- KEEP ALIVE ----------------
export async function keepAlive(url = CONFIG.SELF_PING_URL) {
  const urls = Array.from(
    new Set(
      [
        url,
        CONFIG.SELF_PING_URL,
        ...(CONFIG.SERVER?.KEEP_ALIVE_URLS || []),
        "https://aitraderbot.onrender.com",
      ].filter(Boolean)
    )
  );

  for (const u of urls) {
    try {
      const res = await fetch(u, { method: "GET", timeout: AXIOS_TIMEOUT });
      if (res.ok) {
        console.log("🌐 KeepAlive OK ->", u);
        return { ok: true };
      }
    } catch (e) {
      console.warn("KeepAlive failed:", u, e.message);
    }
  }
  return { ok: false };
}

// ---------------- CACHE ----------------
function saveCache(sym, data) {
  try {
    let cache = {};
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8") || "{}");
    }
    cache[sym] = { ts: Date.now(), data };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e.message);
  }
}
function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

// ---------------- SAFE FETCH ----------------
async function safeAxiosGet(url, label, transform) {
  try {
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    if (res.status !== 200) throw new Error("HTTP " + res.status);
    const out = transform(res.data);
    if (Array.isArray(out) && out.length) return { ok: true, data: out, source: label };
    if (out?.data?.length) return { ok: true, data: out.data, source: label };
    throw new Error("No usable data");
  } catch (e) {
    console.warn(`❌ ${label} failed:`, e.message);
    return { ok: false };
  }
}

// ---------------- NORMALIZER ----------------
function normCandle(k) {
  if (!k) return null;
  if (Array.isArray(k)) {
    return {
      t: Number(k[0]) || 0,
      open: Number(k[1]) || 0,
      high: Number(k[2]) || 0,
      low: Number(k[3]) || 0,
      close: Number(k[4]) || 0,
      vol: Number(k[5]) || 0,
    };
  }
  if (typeof k === "object") {
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
}

// ---------------- Volume Strength Analyzer ----------------
export function analyzeVolume(candles) {
  if (!candles?.length) return { avg: 0, current: 0, label: "No Data" };

  const vols = candles.map((c) => c.vol || 0);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const current = vols.at(-1);
  const ratio = avg ? current / avg : 1;

  let label = "Normal Volume";
  if (ratio > 2.5) label = "🚀 Ultra High Volume";
  else if (ratio > 1.5) label = "🔥 High Volume Spike";
  else if (ratio < 0.5) label = "🧊 Low Volume";

  return { avg: avg.toFixed(2), current: current.toFixed(2), label, ratio: ratio.toFixed(2) };
}

// ---------------- CONVERTER ----------------
function ensureCandles(raw) {
  if (!raw) return [];
  if (raw?.chart?.result?.[0]) {
    const r = raw.chart.result[0];
    const ts = r.timestamp || [];
    const quotes = r.indicators?.quote?.[0];
    return ts
      .map((t, i) =>
        normCandle({
          t: t * 1000,
          open: quotes.open?.[i],
          high: quotes.high?.[i],
          low: quotes.low?.[i],
          close: quotes.close?.[i],
          vol: quotes.volume?.[i],
        })
      )
      .filter((c) => c && !isNaN(c.close));
  }
  if (Array.isArray(raw))
    return raw.map(normCandle).filter((c) => c && !isNaN(c.close)).sort((a, b) => a.t - b.t);
  if (typeof raw === "object") {
    const arr = Object.values(raw).flat(Infinity);
    return arr.map(normCandle).filter((c) => c && !isNaN(c.close)).sort((a, b) => a.t - b.t);
  }
  return [];
}

// ---------------- FETCHERS ----------------
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  const cryptoCfg = CONFIG.DATA_SOURCES.CRYPTO;
  const primaries = cryptoCfg.PRIMARY;

  for (const base of primaries) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const out = await safeAxiosGet(url, `Binance(${base})`, (raw) => raw);
      if (out.ok) {
        const clean = ensureCandles(out.data);
        if (clean.length) {
          const volStats = analyzeVolume(clean);
          return { ok: true, data: clean, source: `Binance(${base})`, volume: volStats };
        }
      }
    } catch (e) {
      console.warn("fetchCrypto error:", e.message);
    }
  }
  const fb = cryptoCfg.FALLBACKS;
  if (fb.COINGECKO) {
    try {
      const url = `${fb.COINGECKO}/coins/${symbol.replace(
        "USDT",
        ""
      ).toLowerCase()}/market_chart?vs_currency=usd&days=1`;
      const out = await safeAxiosGet(url, "CoinGecko", (raw) => {
        if (!raw?.prices?.length) return [];
        return raw.prices.map((p, i) => [
          p[0],
          p[1],
          p[1],
          p[1],
          p[1],
          raw.total_volumes?.[i]?.[1] || 0,
        ]);
      });
      if (out.ok) {
        const clean = ensureCandles(out.data);
        const volStats = analyzeVolume(clean);
        return { ok: true, data: clean, source: "CoinGecko", volume: volStats };
      }
    } catch (e) {
      console.warn("CoinGecko fallback failed:", e.message);
    }
  }
  return { ok: false };
}

// ---------------- LIVE STREAMER ----------------
export class LiveCryptoStream extends EventEmitter {
  constructor(symbols = ["BTCUSDT"]) {
    super();
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.ws = null;
    this.reconnectTimer = null;
    this.init();
  }

  init() {
    const url =
      CONFIG.DATA_SOURCES.CRYPTO.SOCKETS.MAIN +
      "/" +
      this.symbols.map((s) => `${s}@miniTicker`).join("/");
    console.log("🔌 Connecting WebSocket:", url);
    this.ws = new WebSocket(url);

    this.ws.on("open", () => console.log("✅ WS Connected"));
    this.ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.s && data.c) {
          const symbol = data.s.toUpperCase();
          const price = Number(data.c);
          this.emit("tick", { symbol, price, t: Date.now() });
        }
      } catch {}
    });

    this.ws.on("close", () => this.reconnect());
    this.ws.on("error", (err) => {
      console.warn("WS Error:", err.message);
      this.ws.terminate();
      this.reconnect();
    });
  }

  reconnect() {
    if (this.reconnectTimer) return;
    console.warn("🔁 Reconnecting WebSocket in 10s...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.init();
    }, CONFIG.DATA_SOURCES.CRYPTO.SOCKETS.RECONNECT_DELAY_MS || 10000);
  }

  close() {
    if (this.ws) this.ws.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }
}

// ---------------- Unified Entry ----------------
export async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 500) {
  try {
    console.log(`⏳ Fetching ${symbol}...`);
    const isCrypto = symbol.endsWith("USDT");
    const isIndian = (CONFIG.MARKETS?.INDIAN || []).includes(symbol);
    const isMetal = (CONFIG.MARKETS?.METALS || []).includes(symbol);

    let res = { ok: false };
    if (isCrypto) res = await fetchCrypto(symbol, interval, limit);
    else if (isIndian)
      res = await safeAxiosGet(
        `${CONFIG.DATA_SOURCES.INDIAN.FALLBACKS.YAHOO}/v8/finance/chart/${symbol}?interval=15m&range=1d`,
        "Yahoo(IN)",
        (raw) => raw
      );
    else if (isMetal)
      res = await safeAxiosGet(
        `${CONFIG.DATA_SOURCES.METALS.PRIMARY[0]}/v8/finance/chart/${
          symbol === "GOLD" ? "GC=F" : "SI=F"
        }?interval=15m&range=1d`,
        `Yahoo(${symbol})`,
        (raw) => raw
      );

    if (res.ok && res.data?.length) {
      const clean = ensureCandles(res.data);
      const volStats = analyzeVolume(clean);
      saveCache(symbol, clean);
      console.log(`✅ ${symbol} data OK (${clean.length} candles, ${res.source})`);
      return { data: clean, source: res.source, volume: volStats };
    }

    const cache = readCache();
    if (cache[symbol]?.data?.length) {
      console.log("♻️ Using cache for", symbol);
      const volStats = analyzeVolume(cache[symbol].data);
      return { data: cache[symbol].data, source: "cache", volume: volStats };
    }

    console.warn("⚠️ No data found for", symbol);
    return { data: [], source: "error" };
  } catch (e) {
    console.error("❌ fetchMarketData error:", e.message);
    const cache = readCache();
    if (cache[symbol]?.data)
      return { data: cache[symbol].data, source: "cache", volume: analyzeVolume(cache[symbol].data) };
    return { data: [], source: "error" };
  }
}

// ✅ Unified exports
export default {
  nowLocal,
  keepAlive,
  fetchMarketData,
  analyzeVolume,
  LiveCryptoStream,
};