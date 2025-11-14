// ===============================
// utils.js — FINAL FIXED v9
// ===============================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = 15000;
const DEFAULT_LIMIT = 200;

const BINANCE_MIRRORS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

const FALLBACK_APIS = [
  (symbol, interval, limit) =>
    `https://api.coinstats.app/public/v1/charts?period=${interval}&coinId=${symbol.toLowerCase()}`,
  (symbol, interval, limit) =>
    `https://api.cryptorank.io/v0/coins/${symbol.toLowerCase()}/charts?period=${interval}&limit=${limit}`,
];

// ===============================
// HELPERS
// ===============================

export function nowLocal() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch {}
}

// ===============================
// SAFE AXIOS with MULTI fallback
// ===============================

async function safeAxiosGet(url) {
  let lastErr = null;

  for (const base of BINANCE_MIRRORS) {
    const tryUrl = url.replace("https://api.binance.com", base);

    try {
      const res = await axios.get(tryUrl, {
        timeout: AXIOS_TIMEOUT,
        proxy: CONFIG?.PROXY || false,
        headers: {
          "User-Agent": CONFIG?.USER_AGENT || "aiTraderBot",
          Accept: "application/json",
        },
      });

      if (res?.status === 200) return res.data;
    } catch (e) {
      lastErr = e;
    }
  }

  console.warn("⚠ Binance blocked → using fallback");
  return null;
}

// ===============================
// NORMALIZER
// ===============================

function normalizeBinance(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((k) => ({
      t: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      vol: Number(k[5]),
    }))
    .filter((c) => Number.isFinite(c.close));
}

function normalizeFallback(raw) {
  if (!raw || !raw.chart) return [];

  return raw.chart.map((c) => ({
    t: c[0],
    open: c[1],
    high: c[1],
    low: c[1],
    close: c[1],
    vol: c[2] || 0,
  }));
}

// ===============================
// FETCH (BINANCE + FALLBACKS)
// ===============================

async function fetchAny(symbol, interval, limit) {
  // First try Binance
  const binanceURL = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeAxiosGet(binanceURL);

  if (raw) {
    const norm = normalizeBinance(raw);
    if (norm.length) return norm;
  }

  // Try fallbacks
  for (const api of FALLBACK_APIS) {
    try {
      const url = api(symbol, interval, limit);
      const res = await axios.get(url, { timeout: AXIOS_TIMEOUT });
      const norm = normalizeFallback(res.data);
      if (norm.length) return norm;
    } catch {}
  }

  return [];
}

// ===============================
// CACHE
// ===============================

async function ensureCandles(symbol, interval, limit) {
  const fresh = await fetchAny(symbol, interval, limit);

  if (fresh?.length) {
    writeCache(symbol, interval, fresh);
    return fresh;
  }

  const cached = readCache(symbol, interval);
  if (cached?.length) return cached;

  return [];
}

// ===============================
// INDICATORS
// ===============================

function computeRSI(c, length = 14) {
  if (c.length < length + 1) return 50;

  let g = 0,
    l = 0;

  for (let i = c.length - length - 1; i < c.length - 1; i++) {
    const d = c[i + 1].close - c[i].close;
    if (d > 0) g += d;
    else l -= d;
  }

  const rs = (g / length) / ((l || 0.00001) / length);
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeATR(c, length = 14) {
  if (c.length < length + 1) return 0;

  const t = [];

  for (let i = c.length - length; i < c.length; i++) {
    const cur = c[i];
    const prev = c[i - 1] ?? cur;

    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );

    t.push(tr);
  }

  return Number((t.reduce((a, b) => a + b, 0) / t.length).toFixed(2));
}

function ema(v, p) {
  const k = 2 / (p + 1);
  let prev = v[0];
  return v.map((x) => (prev = x * k + prev * (1 - k)));
}

function computeMACD(c) {
  if (c.length < 35) return { hist: 0, line: 0, signal: 0 };

  const close = c.map((x) => x.close);
  const e12 = ema(close, 12);
  const e26 = ema(close, 26);

  const macd = e12.map((v, i) => v - e26[i]);
  const signal = ema(macd, 9);

  return {
    hist: Number((macd.at(-1) - signal.at(-1)).toFixed(6)),
    line: Number(macd.at(-1).toFixed(6)),
    signal: Number(signal.at(-1).toFixed(6)),
  };
}

function priceTrend(c) {
  if (c.length < 2) return "FLAT";
  const a = c.at(-1).close;
  const b = c.at(-2).close;
  return a > b ? "UP" : a < b ? "DOWN" : "FLAT";
}

function volumeTrend(c) {
  if (c.length < 2) return "STABLE";
  const a = c.at(-1).vol;
  const b = c.at(-2).vol;
  return a > b ? "INCREASING" : a < b ? "DECREASING" : "STABLE";
}

export function analyzeVolume(c) {
  if (!Array.isArray(c) || c.length < 3)
    return { status: "UNKNOWN", strength: 0 };

  const v1 = c.at(-3).vol;
  const v2 = c.at(-2).vol;
  const v3 = c.at(-1).vol;

  if (v3 > v2 && v2 > v1) return { status: "RISING", strength: 3 };
  if (v3 < v2 && v2 < v1) return { status: "FALLING", strength: -3 };
  if (v3 > v2) return { status: "SLIGHT_UP", strength: 1 };
  if (v3 < v2) return { status: "SLIGHT_DOWN", strength: -1 };

  return { status: "STABLE", strength: 0 };
}

// ===============================
// FIB LEVELS
// ===============================

export function computeFibLevels(c) {
  const hi = Math.max(...c.map((x) => x.high));
  const lo = Math.min(...c.map((x) => x.low));
  const d = hi - lo;

  return {
    lo,
    hi,
    retrace: {
      0.236: hi - d * 0.236,
      0.382: hi - d * 0.382,
      0.5: hi - d * 0.5,
      0.618: hi - d * 0.618,
      0.786: hi - d * 0.786,
    },
  };
}

// ===============================
// MARKET DATA
// ===============================

export async function fetchMarketData(symbol, interval, limit = DEFAULT_LIMIT) {
  const c = await ensureCandles(symbol, interval, limit);

  return {
    data: c,
    price: c.at(-1)?.close || 0,
    volume: c.at(-1)?.vol || 0,
    indicators: {
      RSI: computeRSI(c),
      MACD: computeMACD(c),
      ATR: computeATR(c),
      priceTrend: priceTrend(c),
      volumeTrend: volumeTrend(c),
    },
    fib: computeFibLevels(c),
    updated: nowLocal(),
  };
}

export async function fetchMultiTF(symbol, tfs = ["1m", "5m", "15m"]) {
  const out = {};

  await Promise.all(
    tfs.map(async (tf) => {
      out[tf] = await fetchMarketData(symbol, tf);
    })
  );

  return out;
}

// ===============================
// KEEP ALIVE
// ===============================

export async function keepAlive() {
  try {
    await axios.get(CONFIG.SELF_PING_URL);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}