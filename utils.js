// utils.js — Final hardened v1.1 (fixed exports + full implementation)
// Compatible with aiTraderBot.js (v10.2) + tg_commands.js (Option-3)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js"; // project uses default import

// ---------- constants ----------
const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(CONFIG?.AXIOS_TIMEOUT) || 15000;
const DEFAULT_LIMIT = Number(CONFIG?.DEFAULT_LIMIT) || 200;
const DEFAULT_INTERVAL = CONFIG?.DEFAULT_INTERVAL || "15m";

const BINANCE_MIRRORS = Array.isArray(CONFIG?.BINANCE_MIRRORS) && CONFIG.BINANCE_MIRRORS.length
  ? CONFIG.BINANCE_MIRRORS
  : [CONFIG?.BINANCE_BASE || "https://api.binance.com"];

// ---------- helpers ----------
function nowLocal() {
  return new Date().toLocaleString("en-IN", { hour12: false });
}

function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.warn("readCache error:", e?.message || e);
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    const p = cachePath(symbol, interval);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("writeCache error:", e?.message || e);
  }
}

// ---------- safe axios (mirrors + proxy + retries) ----------
async function safeAxiosGet(url, options = {}) {
  // Try a small sequence: provided mirrors -> original url
  const sources = Array.from(new Set([...(BINANCE_MIRRORS || []), url]));
  let lastErr = null;

  for (const base of sources) {
    // If base contains full URL already, use it; otherwise attempt to replace known base
    let tryUrl = url;
    try {
      if (base && base.startsWith("http") && url.includes("/api/") && CONFIG?.BINANCE_BASE) {
        // replace only if original base is present
        tryUrl = url.replace(CONFIG.BINANCE_BASE || "https://api.binance.com", base);
      } else if (base === url) {
        tryUrl = url;
      } else if (base && base.startsWith("http") && !url.includes(CONFIG?.BINANCE_BASE || "api.binance.com")) {
        tryUrl = url; // leave it - don't attempt unsafe replace
      }
    } catch (_) {
      tryUrl = url;
    }

    // Execute request with optional proxy settings
    try {
      const res = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        // proxy in config can be an object or false; axios accepts false only with http adapter - keep as is
        proxy: CONFIG?.PROXY || false,
        headers: {
          "User-Agent": CONFIG?.USER_AGENT || "aiTraderBot/1.0 (+https://example.com)",
          Accept: "application/json, text/plain, */*",
          ...(options.headers || {}),
        },
        ...options,
      });
      if (res && (res.status === 200 || res.status === 201)) return res.data;
      lastErr = new Error(`HTTP ${res?.status}`);
    } catch (err) {
      lastErr = err;
      // continue to next mirror
    }
  }

  console.warn("safeAxiosGet failed for", url, lastErr?.message || lastErr);
  return null;
}

// ---------- normalizer ----------
function normalizeKlineArray(rawKlines) {
  if (!Array.isArray(rawKlines)) return [];
  return rawKlines
    .map((k) => ({
      t: Number(k[0] ?? 0),
      open: Number(k[1] ?? k.open ?? 0),
      high: Number(k[2] ?? k.high ?? 0),
      low: Number(k[3] ?? k.low ?? 0),
      close: Number(k[4] ?? k.close ?? 0),
      vol: Number(k[5] ?? k.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.close));
}

// ---------- fetch raw candles (primary) ----------
export async function fetchCrypto(symbol = "BTCUSDT", interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT) {
  try {
    const base = CONFIG?.BINANCE_BASE || "https://api.binance.com";
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await safeAxiosGet(url);
    if (!raw) return [];
    return normalizeKlineArray(raw);
  } catch (e) {
    console.warn("fetchCrypto error:", e?.message || e);
    return [];
  }
}

// ---------- cache wrapper ----------
export async function ensureCandles(symbol = "BTCUSDT", interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT) {
  try {
    const cached = readCache(symbol, interval) || [];
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (Array.isArray(fresh) && fresh.length) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }
    // fallback to cache
    return cached;
  } catch (e) {
    console.warn("ensureCandles error:", e?.message || e);
    return readCache(symbol, interval) || [];
  }
}

// ---------- INDICATORS ----------
// RSI
export function computeRSI(candles = [], length = 14) {
  try {
    const N = length;
    if (!Array.isArray(candles) || candles.length < N + 1) return 50;
    let gains = 0,
      losses = 0;
    for (let i = candles.length - N - 1; i < candles.length - 1; i++) {
      const a = candles[i + 1];
      const b = candles[i];
      const diff = (a?.close ?? a?.c ?? 0) - (b?.close ?? b?.c ?? 0);
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    if (gains === 0 && losses === 0) return 50;
    const avgGain = gains / N;
    const avgLoss = (losses || 0.000001) / N;
    const rs = avgGain / avgLoss;
    return Number((100 - 100 / (1 + rs)).toFixed(2));
  } catch (e) {
    console.warn("computeRSI error:", e?.message || e);
    return 50;
  }
}

// ATR
export function computeATR(candles = [], length = 14) {
  try {
    if (!Array.isArray(candles) || candles.length < length + 1) return 0;
    const trs = [];
    for (let i = candles.length - length; i < candles.length; i++) {
      const cur = candles[i];
      const prev = candles[i - 1] ?? cur;
      const high = Number(cur?.high ?? 0);
      const low = Number(cur?.low ?? 0);
      const prevClose = Number(prev?.close ?? prev?.c ?? 0);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    return Number(atr.toFixed(2));
  } catch (e) {
    console.warn("computeATR error:", e?.message || e);
    return 0;
  }
}

// EMA helper
function ema(values = [], period = 12) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [];
  for (const v of values) {
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// MACD
export function computeMACD(candles = []) {
  try {
    if (!Array.isArray(candles) || candles.length < 35) return { hist: 0, line: 0, signal: 0 };
    const closes = candles.map((c) => Number(c.close ?? 0));
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12.map((v, i) => v - (ema26[i] ?? 0));
    const signalLine = ema(macdLine, 9);
    const hist = (macdLine.at(-1) ?? 0) - (signalLine.at(-1) ?? 0);
    return {
      hist: Number(hist.toFixed(6)),
      line: Number((macdLine.at(-1) ?? 0).toFixed(6)),
      signal: Number((signalLine.at(-1) ?? 0).toFixed(6)),
    };
  } catch (e) {
    console.warn("computeMACD error:", e?.message || e);
    return { hist: 0, line: 0, signal: 0 };
  }
}

// Price / Volume trends
export function priceTrend(candles = []) {
  try {
    if (!Array.isArray(candles) || candles.length < 2) return "FLAT";
    const last = Number(candles.at(-1)?.close ?? 0);
    const prev = Number(candles.at(-2)?.close ?? 0);
    if (last > prev) return "UP";
    if (last < prev) return "DOWN";
    return "FLAT";
  } catch (e) {
    return "FLAT";
  }
}

export function volumeTrend(candles = []) {
  try {
    if (!Array.isArray(candles) || candles.length < 2) return "STABLE";
    const last = Number(candles.at(-1)?.vol ?? candles.at(-1)?.volume ?? 0);
    const prev = Number(candles.at(-2)?.vol ?? candles.at(-2)?.volume ?? last);
    if (last > prev) return "INCREASING";
    if (last < prev) return "DECREASING";
    return "STABLE";
  } catch (e) {
    return "STABLE";
  }
}

export function analyzeVolumeTrend(candles = []) {
  const vt = volumeTrend(candles);
  if (vt === "INCREASING") return "up";
  if (vt === "DECREASING") return "down";
  return "stable";
}

// analyzeVolume (detailed)
export function analyzeVolume(candles = []) {
  try {
    if (!Array.isArray(candles) || !candles.length) return { avg: 0, current: 0, label: "No Data", ratio: 1 };
    const vols = candles.map((c) => Number(c.vol ?? c.volume ?? 0));
    const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
    const current = vols.at(-1) ?? 0;
    const ratio = avg ? current / avg : 1;
    let label = "Normal Volume";
    if (ratio > 2.5) label = "🚀 Ultra High Volume";
    else if (ratio > 1.5) label = "🔥 High Volume Spike";
    else if (ratio < 0.5) label = "🧊 Low Volume";
    return { avg: Number(avg.toFixed(2)), current: Number(current.toFixed(2)), label, ratio: Number(ratio.toFixed(2)) };
  } catch (e) {
    console.warn("analyzeVolume error:", e?.message || e);
    return { avg: 0, current: 0, label: "Error", ratio: 1 };
  }
}

// calculateIndicators wrapper (tg_commands compatibility)
export function calculateIndicators(candles = []) {
  try {
    const rsi = computeRSI(candles, 14);
    const macd = computeMACD(candles);
    const atr = computeATR(candles, 14);
    const pt = priceTrend(candles);
    const vt = volumeTrend(candles);
    return {
      RSI: Number(rsi),
      MACD: { hist: Number(macd.hist), line: Number(macd.line), signal: Number(macd.signal) },
      ATR: Number(atr),
      priceTrend: pt,
      volumeTrend: vt,
    };
  } catch (e) {
    console.warn("calculateIndicators error:", e?.message || e);
    return { RSI: null, MACD: { hist: null, line: null, signal: null }, ATR: null, priceTrend: "FLAT", volumeTrend: "STABLE" };
  }
}

// ---------- Fibonacci (dual signature) ----------
export function computeFibLevels(a, b) {
  try {
    let low, high;
    if (Array.isArray(a)) {
      const candles = a;
      if (!candles.length) return null;
      high = Math.max(...candles.map((c) => Number(c.high ?? 0)));
      low = Math.min(...candles.map((c) => Number(c.low ?? 0)));
    } else {
      low = Number(a);
      high = Number(b);
    }
    if (!isFinite(low) || !isFinite(high) || high <= low) return null;
    const diff = high - low;
    return {
      lo: low,
      hi: high,
      retrace: {
        "0.236": Number((high - diff * 0.236).toFixed(6)),
        "0.382": Number((high - diff * 0.382).toFixed(6)),
        "0.5": Number((high - diff * 0.5).toFixed(6)),
        "0.618": Number((high - diff * 0.618).toFixed(6)),
        "0.786": Number((high - diff * 0.786).toFixed(6)),
      },
      extensions: {
        "1.272": Number((high + diff * 0.272).toFixed(6)),
        "1.618": Number((high + diff * 0.618).toFixed(6)),
      },
    };
  } catch (e) {
    console.warn("computeFibLevels error:", e?.message || e);
    return null;
  }
}

// deriveSignal
export function deriveSignalFromIndicators(ind) {
  if (!ind) return "N/A";
  let score = 0;
  if (ind.RSI !== null && ind.RSI !== undefined) {
    if (ind.RSI < 30) score += 1;
    if (ind.RSI > 70) score -= 1;
  }
  if (ind.MACD && typeof ind.MACD.hist === "number") {
    if (ind.MACD.hist > 0) score += 1;
    else if (ind.MACD.hist < 0) score -= 1;
  }
  if (ind.priceTrend === "UP") score += 1;
  if (ind.priceTrend === "DOWN") score -= 1;
  if (ind.volumeTrend === "INCREASING") score += 1;
  if (score >= 2) return "BUY";
  if (score <= -2) return "SELL";
  return "NEUTRAL";
}

// ---------- fetchMarketData (main public) ----------
export async function fetchMarketData(symbol = "BTCUSDT", interval = DEFAULT_INTERVAL, limit = DEFAULT_LIMIT) {
  try {
    const candles = await ensureCandles(symbol, interval, limit);
    const data = Array.isArray(candles) ? candles : [];
    const price = data.at(-1)?.close ?? 0;
    const volume = data.at(-1)?.vol ?? data.at(-1)?.volume ?? 0;
    const indicators = data.length ? calculateIndicators(data) : null;
    const fib = data.length ? computeFibLevels(data) : null;
    return { data, price, volume, indicators, fib, updated: nowLocal() };
  } catch (e) {
    console.error("fetchMarketData error:", e?.message || e);
    const cached = readCache(symbol, interval) || [];
    const price = cached.at(-1)?.close ?? 0;
    return {
      data: cached,
      price,
      volume: cached.at(-1)?.vol ?? 0,
      indicators: cached.length ? calculateIndicators(cached) : null,
      fib: cached.length ? computeFibLevels(cached) : null,
      updated: nowLocal(),
    };
  }
}

// ---------- fetchMultiTF convenience ----------
export async function fetchMultiTF(symbol = "BTCUSDT", tfs = ["1m", "5m", "15m", "30m", "1h"]) {
  const out = {};
  await Promise.all(
    tfs.map(async (tf) => {
      try {
        const res = await fetchMarketData(symbol, tf, DEFAULT_LIMIT);
        out[tf] = res;
      } catch (e) {
        out[tf] = { data: [], price: 0, volume: 0, indicators: null, fib: null, updated: nowLocal(), error: String(e?.message || e) };
      }
    })
  );
  return out;
}

// ---------- keepAlive ----------
export async function keepAlive() {
  try {
    const urls = Array.from(
      new Set([CONFIG?.SELF_PING_URL, ...(CONFIG?.SERVER?.KEEP_ALIVE_URLS || []), `https://${CONFIG?.RENDER_URL || ""}`].filter(Boolean))
    );
    for (const u of urls) {
      try {
        await axios.get(u, { timeout: 8000 });
        return { ok: true };
      } catch (_) {}
    }
    return { ok: false };
  } catch (e) {
    return { ok: false };
  }
}

// ---------- exports ----------//


