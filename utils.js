// utils.js — robust, single-export-file v2.0
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(CONFIG?.AXIOS_TIMEOUT) || 15000;
const DEFAULT_LIMIT = Number(CONFIG?.DEFAULT_LIMIT) || 200;

const BINANCE_MIRRORS = Array.isArray(CONFIG?.DATA_SOURCES?.CRYPTO?.PRIMARY) && CONFIG.DATA_SOURCES.CRYPTO.PRIMARY.length
  ? CONFIG.DATA_SOURCES.CRYPTO.PRIMARY
  : [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
  ];

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour12: true });
}
function cachePath(symbol, interval) { return path.join(CACHE_DIR, `${symbol}_${interval}.json`); }
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch (e) { console.warn("readCache:", e?.message || e); return []; }
}
function writeCache(symbol, interval, data) {
  try { fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2)); } catch (e) { console.warn("writeCache:", e?.message || e); }
}

async function safeAxiosGet(url, options = {}) {
  let lastErr = null;
  const sources = [...BINANCE_MIRRORS, url];
  for (const base of sources) {
    let tryUrl = url;
    try {
      // If base looks like full host, replace official base only
      if (base && base.startsWith("http") && url.includes("api.binance.com")) {
        tryUrl = url.replace(/https?:\/\/api\.binance\.com/, base);
      } else if (base === url) {
        tryUrl = url;
      }
    } catch (_) { tryUrl = url; }

    try {
      const res = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG?.PROXY || false,
        headers: {
          "User-Agent": CONFIG?.USER_AGENT || "aiTraderBot/1.0",
          Accept: "application/json, text/plain, */*",
          ...(options.headers || {})
        },
        ...options,
      });
      if (res && (res.status === 200 || res.status === 201)) return res.data;
      lastErr = new Error(`HTTP ${res?.status}`);
    } catch (err) { lastErr = err; }
  }
  console.warn("safeAxiosGet failed for", url, lastErr?.message || lastErr);
  return null;
}

function normalizeKlineArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({
    t: Number(k[0] ?? 0),
    open: Number(k[1] ?? 0),
    high: Number(k[2] ?? 0),
    low: Number(k[3] ?? 0),
    close: Number(k[4] ?? 0),
    vol: Number(k[5] ?? 0),
  })).filter(c => Number.isFinite(c.close));
}

export async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const baseUrl = CONFIG?.DATA_SOURCES?.CRYPTO?.PRIMARY?.[1] || "https://api.binance.com";
    const url = `${baseUrl.replace(/\/$/, "")}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await safeAxiosGet(url);
    if (!raw) return [];
    return normalizeKlineArray(raw);
  } catch (e) {
    console.warn("fetchCrypto error:", e?.message || e);
    return [];
  }
}

export async function ensureCandles(symbol = "BTCUSDT", interval = "15m", limit = DEFAULT_LIMIT) {
  const cached = readCache(symbol, interval) || [];
  try {
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (Array.isArray(fresh) && fresh.length) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }
  } catch (e) {
    console.warn("ensureCandles fetch error:", e?.message || e);
  }
  return cached;
}

// indicators (simple, defensive)
export function computeRSI(candles = [], len = 14) {
  if (!Array.isArray(candles) || candles.length < len + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - len - 1; i < candles.length - 1; i++) {
    const diff = (candles[i+1].close ?? 0) - (candles[i].close ?? 0);
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50;
  const avgGain = gains / len;
  const avgLoss = (losses || 1e-6) / len;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}
export function computeATR(candles = [], len = 14) {
  if (!Array.isArray(candles) || candles.length < len + 1) return 0;
  const trs = [];
  for (let i = candles.length - len; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i-1] ?? cur;
    const tr = Math.max((cur.high - cur.low), Math.abs(cur.high - (prev.close ?? cur.close)), Math.abs(cur.low - (prev.close ?? cur.close)));
    trs.push(tr);
  }
  return Number((trs.reduce((a,b)=>a+b,0)/trs.length).toFixed(2));
}
function ema(values = [], period = 12) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2/(period+1);
  let prev = values[0];
  const out = [];
  for (const v of values) { prev = v*k + prev*(1-k); out.push(prev); }
  return out;
}
export function computeMACD(candles = []) {
  if (!Array.isArray(candles) || candles.length < 35) return { hist: 0, line: 0, signal: 0 };
  const closes = candles.map(c => Number(c.close ?? 0));
  const ema12 = ema(closes,12);
  const ema26 = ema(closes,26);
  const macdLine = ema12.map((v,i)=> v - (ema26[i] ?? 0));
  const signal = ema(macdLine, 9);
  const hist = (macdLine.at(-1) ?? 0) - (signal.at(-1) ?? 0);
  return { hist: Number(hist.toFixed(6)), line: Number((macdLine.at(-1)||0).toFixed(6)), signal: Number((signal.at(-1)||0).toFixed(6)) };
}
export function priceTrend(candles=[]) {
  if (!Array.isArray(candles) || candles.length < 2) return "FLAT";
  const last = candles.at(-1).close; const prev = candles.at(-2).close;
  return last>prev ? "UP": last<prev ? "DOWN":"FLAT";
}
export function volumeTrend(candles=[]) {
  if (!Array.isArray(candles) || candles.length < 2) return "STABLE";
  const last = candles.at(-1).vol ?? candles.at(-1).volume ?? 0;
  const prev = candles.at(-2).vol ?? candles.at(-2).volume ?? 0;
  return last>prev ? "INCREASING": last<prev ? "DECREASING":"STABLE";
}
export function analyzeVolume(candles=[]) {
  if (!Array.isArray(candles) || candles.length < 3) return { status: "UNKNOWN", ratio: 1 };
  const v1 = candles.at(-3).vol; const v2 = candles.at(-2).vol; const v3 = candles.at(-1).vol;
  if (v3>v2 && v2>v1) return { status: "RISING", ratio: v3/v2 };
  if (v3<v2 && v2<v1) return { status: "FALLING", ratio: v3/v2 };
  return { status: "STABLE", ratio: v3/( (v1+v2+v3)/3 ) };
}
export function computeFibLevels(candles=[]) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const highs = candles.map(c => Number(c.high || 0)); const lows = candles.map(c => Number(c.low || 0));
  const hi = Math.max(...highs); const lo = Math.min(...lows); if (!isFinite(hi) || !isFinite(lo)) return null;
  const diff = hi - lo;
  return { lo, hi, retrace: { "0.236": hi - diff*0.236, "0.382": hi - diff*0.382, "0.5": hi - diff*0.5, "0.618": hi - diff*0.618, "0.786": hi - diff*0.786 }};
}

export async function fetchMarketData(symbol="BTCUSDT", interval="15m", limit=DEFAULT_LIMIT) {
  try {
    const candles = await ensureCandles(symbol, interval, limit);
    const data = Array.isArray(candles) ? candles : [];
    const last = data.at(-1) || {};
    return {
      data,
      price: Number(last.close ?? 0),
      volume: Number(last.vol ?? last.volume ?? 0),
      indicators: data.length ? { RSI: computeRSI(data), MACD: computeMACD(data), ATR: computeATR(data), priceTrend: priceTrend(data), volumeTrend: volumeTrend(data) } : null,
      fib: data.length ? computeFibLevels(data) : null,
      updated: nowLocal(),
    };
  } catch (e) {
    console.error("fetchMarketData error:", e?.message || e);
    const cached = readCache(symbol, interval) || [];
    return { data: cached, price: Number(cached.at(-1)?.close ?? 0), volume: Number(cached.at(-1)?.vol ?? 0), indicators: cached.length ? { RSI: computeRSI(cached), MACD: computeMACD(cached), ATR: computeATR(cached) } : null, fib: cached.length ? computeFibLevels(cached) : null, updated: nowLocal(), error: e?.message || String(e) };
  }
}

export async function fetchMultiTF(symbol="BTCUSDT", tfs=["1m","5m","15m","30m","1h"]) {
  const out = {};
  await Promise.all(tfs.map(async(tf)=>{ out[tf] = await fetchMarketData(symbol, tf, DEFAULT_LIMIT); }));
  return out;
}

export async function keepAlive() {
  try {
    const url = CONFIG?.SELF_PING_URL || `https://${CONFIG?.RENDER_URL || ""}`; if (!url) return { ok:false };
    await axios.get(url, { timeout: 8000 }); return { ok:true };
  } catch { return { ok:false }; }
}