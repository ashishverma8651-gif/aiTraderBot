// ================================
// utils.js — FIXED v2.6 (OHLC synth + Yahoo/NSE fallbacks)
// ================================

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ----------------------------------------------------------------
// CONFIG / CACHE
// ----------------------------------------------------------------
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const AXIOS_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch { return []; }
}
function writeCache(symbol, interval, data) {
  try { fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2)); }
  catch {}
}

// ----------------------------------------------------------------
// TF map
// ----------------------------------------------------------------
const TF_MAP = {
  "1m":  { interval: "1m",   range: "1d" },
  "5m":  { interval: "5m",   range: "5d" },
  "15m": { interval: "15m",  range: "5d" },
  "30m": { interval: "30m",  range: "1mo" },
  "1h":  { interval: "60m",  range: "1mo" },
  "4h":  { interval: "240m", range: "3mo" },
  "1d":  { interval: "1d",   range: "6mo" }
};

// ----------------------------------------------------------------
// SYMBOL EQUIV (Yahoo friendly)
// ----------------------------------------------------------------
const SYMBOL_EQUIV = {
  GOLD: "GC=F",
  XAUUSD: "GC=F",
  SILVER: "SI=F",
  XAGUSD: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY"
};

// ----------------------------------------------------------------
// SAFE GET with retries
// ----------------------------------------------------------------
async function safeGet(url, timeout = AXIOS_TIMEOUT) {
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      const res = await axios.get(url, { timeout, headers: { "User-Agent": "aiTrader/1.0" } });
      return res.data;
    } catch (e) {
      if (i < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      else break;
    }
  }
  return null;
}

// ----------------------------------------------------------------
// Helpers: create synthetic OHLC when only close or flat OHLC present
// ----------------------------------------------------------------
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// small jitter based on price and a tiny fraction
function jitterPct(price, maxPct = 0.0009) {
  const pct = (Math.random() * maxPct);
  return price * pct;
}

// If we only have close series (array of {t, close}) create OHLC sequence
function synthesizeOHLCFromCloses(closeArr) {
  // closeArr: array of objects { t, close } or [t, close]
  const out = [];
  for (let i = 0; i < closeArr.length; i++) {
    const item = closeArr[i];
    const close = safeNum(item.close ?? (Array.isArray(item) ? item[1] : undefined), 0);
    const prevClose = i > 0 ? safeNum(closeArr[i - 1].close ?? (Array.isArray(closeArr[i - 1]) ? closeArr[i - 1][1] : undefined), close) : close;

    const open = prevClose;
    // create tiny high/low around max/min of open/close with jitter
    const highBase = Math.max(open, close);
    const lowBase = Math.min(open, close);

    const high = highBase + Math.abs(jitterPct(highBase, 0.0012)); // up to ~0.12%
    const low = Math.max(0, lowBase - Math.abs(jitterPct(lowBase, 0.0012)));

    out.push({
      t: item.t ?? (Array.isArray(item) ? item[0] : Date.now()),
      open,
      high,
      low,
      close,
      vol: Math.floor(Math.random() * 1000)
    });
  }
  return out;
}

// Ensure each candle has OHLC realistic values; mutate in-place defensive
function ensureOHLC(candles) {
  if (!Array.isArray(candles)) return [];
  if (!candles.length) return [];

  // if objects with only 'close' or open==high==low==close, generate synthetic
  let needSynthetic = false;
  for (const c of candles) {
    const o = safeNum(c.open ?? c.o ?? NaN, NaN);
    const h = safeNum(c.high ?? c.h ?? NaN, NaN);
    const l = safeNum(c.low ?? c.l ?? NaN, NaN);
    const cl = safeNum(c.close ?? c.c ?? NaN, NaN);

    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l)) {
      needSynthetic = true;
      break;
    }

    // If OHLC all identical (flat candle) and many candles are flat -> synthetic
    if (o === h && h === l && l === cl) {
      needSynthetic = true;
      break;
    }
  }

  if (!needSynthetic) {
    // normalize keys to {t,open,high,low,close,vol}
    return candles.map(c => ({
      t: c.t ?? c.timestamp ?? Date.now(),
      open: safeNum(c.open ?? c.o ?? c.openPrice ?? c[1] ?? c.close ?? 0),
      high: safeNum(c.high ?? c.h ?? c.highPrice ?? c[2] ?? c.close ?? 0),
      low:  safeNum(c.low  ?? c.l ?? c.lowPrice ?? c[3] ?? c.close ?? 0),
      close: safeNum(c.close ?? c.c ?? c[4] ?? c[1] ?? 0),
      vol: Math.floor(safeNum(c.vol ?? c.v ?? c.volume ?? 0))
    }));
  }

  // Build from closes if possible
  const closes = candles.map(c => {
    if (c && Number.isFinite(safeNum(c.close))) return { t: c.t ?? c.timestamp ?? Date.now(), close: safeNum(c.close) };
    // some Yahoo formats have arrays; try to extract
    if (Array.isArray(c) && Number.isFinite(safeNum(c[4]))) return { t: c[0], close: safeNum(c[4]) };
    // fallback: attempt indicator like c.close?
    return { t: c.t ?? Date.now(), close: safeNum(c[1] ?? c.close ?? 0) };
  });

  return synthesizeOHLCFromCloses(closes);
}

// ----------------------------------------------------------------
// Binance klines normalize
// ----------------------------------------------------------------
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(k => ({
    t: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    vol: +k[5]
  })).filter(x => Number.isFinite(x.close));
}

// ----------------------------------------------------------------
// fetchCrypto (Binance)
// ----------------------------------------------------------------
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeGet(url);
  if (!raw) return [];
  return normalizeKline(raw);
}

// ----------------------------------------------------------------
// fetchYahoo (dynamic TF); includes synthetic OHLC fallback
// ----------------------------------------------------------------
async function fetchYahoo(symbol, interval = "15m") {
  try {
    const tf = TF_MAP[interval] || TF_MAP["15m"];
    const base = CONFIG.DATA_SOURCES?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart";
    const url = `${base}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;

    const res = await safeGet(url);
    const r = res?.chart?.result?.[0];
    if (!r) return [];

    const t = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];
    const volumes = q.volume || [];

    const out = [];
    for (let i = 0; i < t.length; i++) {
      const ts = t[i] * 1000;
      const close = safeNum(closes[i], NaN);
      // if close not finite skip
      if (!Number.isFinite(close)) continue;

      let open = safeNum(opens[i], NaN);
      let high = safeNum(highs[i], NaN);
      let low = safeNum(lows[i], NaN);
      let vol = Math.floor(safeNum(volumes[i], 0));

      // if yahoo returns flat (open/high/low undefined or equal to close) -> synthesize small jitter
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || (open === high && high === low && low === close)) {
        // build from prev close if available
        const prevClose = (i > 0 && Number.isFinite(safeNum(closes[i - 1], NaN))) ? safeNum(closes[i - 1]) : close;
        open = prevClose;
        const highBase = Math.max(open, close);
        const lowBase = Math.min(open, close);

        high = highBase + Math.abs(jitterPct(highBase, 0.0012));
        low = Math.max(0, lowBase - Math.abs(jitterPct(lowBase, 0.0012)));
        vol = vol || Math.floor(Math.abs((close - prevClose) * 1000)) || Math.floor(Math.random() * 500);
      }

      out.push({
        t: ts,
        open,
        high,
        low,
        close,
        vol
      });
    }

    // If output empty but chart indicators present as arrays of objects, try synthesize from timestamps + closes
    if (!out.length && r.timestamp?.length && (r.indicators?.quote?.[0]?.close?.length)) {
      const arr = (r.timestamp || []).map((tt, idx) => ({ t: tt * 1000, close: safeNum(r.indicators.quote[0].close[idx], NaN) }));
      return synthesizeOHLCFromCloses(arr);
    }

    return out;
  } catch (err) {
    return [];
  }
}

// ----------------------------------------------------------------
// Official NSE intraday fetch — often provides grapthData with [time, price]
// We'll synthesize OHLC from that close-only feed
// ----------------------------------------------------------------
async function fetchNSEOfficial(symbol, interval = "15m") {
  try {
    const base = CONFIG.DATA_SOURCES?.NSE?.[0] || "https://www.nseindia.com";
    const url = `${base}/api/chart-databyindex?index=${symbol}`;
    const res = await axios.get(url, { timeout: AXIOS_TIMEOUT, headers: { "User-Agent": "aiTrader/1.0" } });

    // grapthData may be array of arrays or array of objects depending on source
    const raw = res?.data?.grapthData || res?.data?.data || [];

    // normalize: possible shapes:
    // - [[timestamp, price], ...]
    // - [{time: ts, price: p}, ...]
    const normalized = raw.map(item => {
      if (Array.isArray(item) && item.length >= 2) return { t: item[0], close: item[1] };
      if (item && typeof item === "object") {
        // some responses might have 'time' or 'timestamp' and 'price' or 'close'
        return { t: item.time ?? item.timestamp ?? Date.now(), close: item.price ?? item.close ?? item.value ?? 0 };
      }
      return { t: Date.now(), close: 0 };
    }).filter(x => Number.isFinite(safeNum(x.close)));

    if (!normalized.length) return [];

    // Build OHLC from closes (synthesize)
    return synthesizeOHLCFromCloses(normalized);
  } catch (e) {
    // fallback empty
    return [];
  }
}

// ----------------------------------------------------------------
// fetchMarketData (crypto primary) — returns {data, price, updated}
// ----------------------------------------------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  try {
    const s = String(symbol || "").toUpperCase();
    let data = readCache(s, interval) || [];

    if (s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BTC")) {
      try {
        const fresh = await fetchCrypto(s, interval, limit);
        if (Array.isArray(fresh) && fresh.length) {
          writeCache(s, interval, fresh);
          data = fresh;
        }
      } catch {}
    }

    const last = data.at(-1) || {};
    return { data, price: safeNum(last.close, 0), updated: new Date().toISOString() };
  } catch {
    return { data: [], price: 0, updated: new Date().toISOString() };
  }
}

// ----------------------------------------------------------------
// fetchMultiTF - wrapper calling fetchUniversal for each TF
// ----------------------------------------------------------------
export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const out = {};
  await Promise.all(tfs.map(async (tf) => {
    try {
      out[tf] = await fetchUniversal(symbol, tf);
    } catch (e) {
      out[tf] = { data: [], price: 0, updated: new Date().toISOString() };
    }
  }));
  return out;
}

// ----------------------------------------------------------------
// fetchUniversal - master router (crypto, nse, yahoo fallback)
// returns { data: [], price: num }
// ----------------------------------------------------------------
export async function fetchUniversal(symbol, interval = "15m") {
  try {
    if (!symbol) return { data: [], price: 0 };

    const s = String(symbol).toUpperCase();

    // Resolve known equivalents for Yahoo/NSE usage
    const mapped = SYMBOL_EQUIV[s] || s;

    // CRYPTO detection
    if (s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BTC") || s.endsWith("ETH")) {
      const res = await fetchMarketData(s, interval);
      // ensure OHLC
      const data = ensureOHLC(res.data || []);
      return { data, price: safeNum(data.at(-1)?.close, res.price || 0) };
    }

    // INDIA index special handling (NIFTY/BANKNIFTY/FINNIFTY)
    const indiaIndexes = ["NIFTY50", "BANKNIFTY", "FINNIFTY", "NIFTY", "BANKNIFTY"];
    if (indiaIndexes.includes(s)) {
      // 1) try official NSE
      let d = await fetchNSEOfficial(s);
      // 2) fallback to yahoo mapped symbol (e.g. ^NSEI)
      if (!d.length) {
        const ySym = SYMBOL_EQUIV[s] || mapped;
        d = await fetchYahoo(ySym, interval);
      }
      const data = ensureOHLC(d || []);
      return { data, price: safeNum(data.at(-1)?.close, 0) };
    }

    // GENERAL: Yahoo first with mapped symbol, then raw symbol fallback
    let yahooData = await fetchYahoo(mapped, interval);
    if (!yahooData.length) yahooData = await fetchYahoo(s, interval);

    const data = ensureOHLC(yahooData || []);
    return { data, price: safeNum(data.at(-1)?.close, 0) };

  } catch (e) {
    return { data: [], price: 0 };
  }
}

// ----------------------------------------------------------------
// default export not used; named exports above are used by rest of app
// ----------------------------------------------------------------
export default {
  fetchUniversal,
  fetchMarketData,
  fetchMultiTF
};