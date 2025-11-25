// utils.js — robust universal fetcher + caching + synthetic fallback
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ---- helpers ----
const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = 12000;
const RETRIES = CONFIG.FALLBACK?.MAX_RETRIES || 3;
const RETRY_DELAY_MS = CONFIG.FALLBACK?.RETRY_DELAY_MS || 600;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safeNum = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const now = () => Date.now();

function cacheFile(symbol, interval) {
  const s = String(symbol || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9_\-]/g, "_");
  const tf = String(interval || "15m").replace(/[^a-z0-9]/gi, "_");
  return path.join(CACHE_DIR, `${s}_${tf}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cacheFile(symbol, interval);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8") || "null");
  } catch { return null; }
}
function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cacheFile(symbol, interval), JSON.stringify({ ts: Date.now(), data }, null, 2));
  } catch {}
}

// ---- synthetic fallback generator (ensures no-empty) ----
function intervalToMs(tf = "15m") {
  const s = String(tf).toLowerCase();
  if (s.endsWith("m")) return Number(s.slice(0, -1)) * 60_000;
  if (s.endsWith("h")) return Number(s.slice(0, -1)) * 60 * 60_000;
  return 60_000;
}
function generateSynthetic(symbol = "SYN", price = 100, count = 200, interval = "15m") {
  const out = [];
  const ms = intervalToMs(interval);
  let t = Date.now() - ms * (count - 1);
  let p = safeNum(price, 100);
  const baseVol = Math.max(1, Math.round(p * 10));
  for (let i = 0; i < count; i++) {
    const drift = (Math.random() - 0.5) * (p * 0.002); // small random
    const open = p;
    const close = Math.max(0.0001, p + drift);
    const high = Math.max(open, close) + Math.abs(drift) * Math.random();
    const low = Math.min(open, close) - Math.abs(drift) * Math.random();
    const vol = Math.round(baseVol * (0.5 + Math.random()));
    out.push({ t, open, high, low, close, vol });
    p = close;
    t += ms;
  }
  return out;
}

// ---- normalizers ----
function normBinanceKlines(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  const out = arr.map(k => ({
    t: Number(k[0]),
    open: safeNum(k[1]), high: safeNum(k[2]), low: safeNum(k[3]), close: safeNum(k[4]), vol: safeNum(k[5], 0)
  })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
  out.sort((a,b)=>a.t-b.t);
  return out;
}
function normYahooChart(res) {
  try {
    if (!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) continue;
      out.push({
        t: Number(ts[i]) * 1000,
        open: safeNum(q.open?.[i], close),
        high: safeNum(q.high?.[i], close),
        low: safeNum(q.low?.[i], close),
        close: safeNum(close),
        vol: safeNum(q.volume?.[i], 0)
      });
    }
    out.sort((a,b)=>a.t-b.t);
    return out;
  } catch { return []; }
}

// ---- safe GET with retries + proxies (simple) ----
async function safeGet(url, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await axios.get(url, { timeout });
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch (e) {
      // wait then retry
      await sleep(RETRY_DELAY_MS + Math.floor(Math.random()*200));
    }
  }
  // as last resort, try public proxy wrappers (text)
  const proxies = ["https://api.codetabs.com/v1/proxy?quest=", "https://api.allorigins.win/raw?url="];
  for (const p of proxies) {
    try {
      const r = await axios.get(p + encodeURIComponent(url), { timeout });
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch {}
    await sleep(RETRY_DELAY_MS);
  }
  return null;
}

// ---- market-specific fetchers ----
async function fetchCrypto(symbol = "BTCUSDT", interval = "15m", limit = 500) {
  const s = String(symbol || "").toUpperCase();
  const sources = CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO || ["https://api.binance.com"];
  const base = sources[0].replace(/\/+$/,"");
  const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
  try {
    const raw = await safeGet(url);
    if (Array.isArray(raw) && raw.length) {
      const k = normBinanceKlines(raw);
      if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close }; }
    }
  } catch {}
  // Try alternate sources (other base urls)
  for (let i=1;i<sources.length;i++){
    try {
      const alt = sources[i].replace(/\/+$/,"");
      const raw = await safeGet(`${alt}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`);
      if (Array.isArray(raw) && raw.length) {
        const k = normBinanceKlines(raw);
        if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close }; }
      }
    } catch {}
  }
  // fallback to Yahoo chart attempt (some tickers map)
  try {
    const yfSymbol = CONFIG.YAHOO_MAP[s] || s;
    const yfInterval = interval === "1m" ? "1m" : interval === "5m" ? "5m" : interval === "15m" ? "15m" : interval === "30m" ? "30m" : "60m";
    const yfUrl = `${(CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO?.[0]||"https://query1.finance.yahoo.com/v8/finance/chart")}/${encodeURIComponent(yfSymbol)}?interval=${yfInterval}&range=7d`;
    const yraw = await safeGet(yfUrl);
    const ky = normYahooChart(yraw);
    if (ky.length) { writeCache(s, interval, ky); return { data: ky, price: ky.at(-1)?.close }; }
  } catch {}
  // cache or synthetic
  const cached = readCache(s, interval);
  if (cached?.data?.length) return { data: cached.data, price: cached.data.at(-1)?.close };
  const synthetic = generateSynthetic(s, lastGoodPrice(s) || 100, Math.min(500, Number(limit||200)), interval);
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close };
}

async function fetchYahoo(symbol, interval = "15m") {
  const s = String(symbol || "").trim();
  if (!s) return { data: [], price: null };
  const base = CONFIG.DATA_SOURCES_BY_MARKET.INDIA?.[0] || (CONFIG.DATA_SOURCES_BY_MARKET.FOREX?.[0]) || "https://query1.finance.yahoo.com/v8/finance/chart";
  const tfmap = {
    "1m": { interval: "1m", range: "1d" },
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "1mo" },
    "1h": { interval: "60m", range: "1mo" }
  }[interval] || { interval: "15m", range: "5d" };
  const url = `${base.replace(/\/+$/,"")}/${encodeURIComponent(s)}?interval=${tfmap.interval}&range=${tfmap.range}`;
  try {
    const raw = await safeGet(url);
    const k = normYahooChart(raw);
    if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close }; }
  } catch {}
  const cached = readCache(s, interval);
  if (cached?.data?.length) return { data: cached.data, price: cached.data.at(-1)?.close };
  const synthetic = generateSynthetic(s, lastGoodPrice(s) || 100, 200, interval);
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close };
}

async function fetchForex(symbol, interval = "15m") {
  // try Yahoo mapping first
  const mapped = CONFIG.YAHOO_MAP[symbol] || symbol;
  const res = await fetchYahoo(mapped, interval);
  if (res && res.data && res.data.length) return res;
  // exchange rate host for single price
  try {
    const pair = symbol.replace("/", "");
    if (pair.length === 6) {
      const base = pair.slice(0,3), quote = pair.slice(3,6);
      const r = await safeGet(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
      const price = r?.rates ? r.rates[quote] : null;
      if (price) {
        const nowt = Date.now();
        const candle = [{ t: nowt - 60000, open: price, high: price, low: price, close: price, vol: 0 }];
        writeCache(symbol, interval, candle);
        return { data: candle, price };
      }
    }
  } catch {}
  const cached = readCache(symbol, interval);
  if (cached?.data?.length) return { data: cached.data, price: cached.data.at(-1)?.close };
  const synthetic = generateSynthetic(symbol, lastGoodPrice(symbol) || 1.0, 200, interval);
  writeCache(symbol, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close };
}

async function fetchCommodity(symbol, interval = "15m") {
  const mapped = CONFIG.YAHOO_MAP[symbol] || symbol;
  return await fetchYahoo(mapped, interval);
}

function lastGoodPrice(symbol) {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(String(symbol).toUpperCase().replace(/[^A-Z0-9_\-]/g,"_") + "_"));
    files.sort((a,b)=>fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR,f),"utf8")||"{}");
        const arr = raw?.data;
        if (Array.isArray(arr) && arr.length) {
          const last = arr.at(-1);
          if (last && Number.isFinite(+last.close)) return Number(last.close);
        }
      } catch {}
    }
  } catch {}
  return null;
}

// high-level universal router
export async function fetchUniversal(symbol, interval="15m") {
  const s = String(symbol || "").toUpperCase();
  if (!s) return { data: [], price: null };
  // detect markets using config lists
  if (CONFIG.SYMBOLS.CRYPTO.includes(s)) return await fetchCrypto(s, interval, CONFIG.DEFAULT_LIMIT);
  if (CONFIG.SYMBOLS.INDIA.includes(s)) return await fetchYahoo(CONFIG.YAHOO_MAP[s] || s, interval);
  if (CONFIG.SYMBOLS.FOREX.includes(s)) return await fetchForex(s, interval);
  if (CONFIG.SYMBOLS.COMMODITY.includes(s)) return await fetchCommodity(s, interval);
  // fallback guess: try crypto first then yahoo
  const c = await fetchCrypto(s, interval, CONFIG.DEFAULT_LIMIT);
  if (c && c.data && c.data.length) return c;
  return await fetchYahoo(CONFIG.YAHOO_MAP[s] || s, interval);
}

export async function fetchMultiTF(symbol, tfs = ["5m","15m","1h"]) {
  const out = {};
  const tasks = tfs.map(tf => fetchUniversal(symbol, tf).then(r => ({ tf, r })).catch(e => ({ tf, r: { data: [], price: null } })));
  const results = await Promise.all(tasks);
  for (const x of results) out[x.tf] = x.r;
  return out;
}

export async function fetchMarketData(symbol, interval="15m") {
  return await fetchUniversal(symbol, interval);
}

export async function fetchPrice(symbol) {
  try {
    const r1 = await fetchUniversal(symbol, "1m");
    if (r1 && r1.price) return r1.price;
  } catch {}
  const lg = lastGoodPrice(symbol);
  return lg || null;
}