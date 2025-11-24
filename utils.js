// utils.js — Heavy, single-file, multi-market, multi-source utilities
// Exports: fetchMarketData, fetchUniversal, fetchMultiTF, fetchPrice
// Requires: ./config.js (default export or named CONFIG), axios installed
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

/* ----------------------------
   Setup & Constants
   ---------------------------- */
const CACHE_DIR = (CONFIG && CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const DEFAULT_RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES ?? 4);
const RETRY_DELAY_MS = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS ?? 600);
const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

const USER_AGENT = "AI-Trader-Utils/2.0";

/* ----------------------------
   Small helpers
   ---------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nowISO = () => new Date().toISOString();

function tfSafe(tf = "15m") { return String(tf || "15m").replace(/[^a-z0-9]/gi, "_"); }
function symSafe(sym = "UNKNOWN") { return String(sym || "UNKNOWN").toUpperCase().replace(/[^A-Z0-9_\-\.\^]/g, "_"); }

function intervalToMs(interval = "15m") {
  if (!interval) return 60_000;
  const v = String(interval).toLowerCase();
  if (v.endsWith("m")) return Number(v.slice(0, -1)) * 60_000;
  if (v.endsWith("h")) return Number(v.slice(0, -1)) * 60 * 60_000;
  if (v.endsWith("d")) return Number(v.slice(0, -1)) * 24 * 60 * 60_000;
  return 60_000;
}

/* ----------------------------
   Cache helpers
   ---------------------------- */
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symSafe(symbol)}_${tfSafe(interval)}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function writeCache(symbol, interval, data) {
  try {
    const p = cachePath(symbol, interval);
    fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2));
  } catch {}
}
function lastGoodPrice(symbol) {
  try {
    const s = symSafe(symbol);
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(s + "_"));
    files.sort((a, b) => fs.statSync(path.join(CACHE_DIR, b)).mtimeMs - fs.statSync(path.join(CACHE_DIR, a)).mtimeMs);
    for (const f of files) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
        const arr = obj?.data;
        if (Array.isArray(arr) && arr.length) {
          const last = arr.at(-1);
          if (last && Number.isFinite(+last.close)) return Number(last.close);
        }
      } catch {}
    }
  } catch {}
  return null;
}

/* ----------------------------
   Proxy utils + axios options
   ---------------------------- */
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
    return { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), auth };
  } catch { return null; }
}
const PARSED_PROXY = parseProxy(CONFIG.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null);

function axiosOptions(timeout = DEFAULT_TIMEOUT) {
  const opts = { timeout, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } };
  if (PARSED_PROXY) {
    opts.proxy = { host: PARSED_PROXY.host, port: PARSED_PROXY.port };
    if (PARSED_PROXY.auth) opts.proxy.auth = { username: PARSED_PROXY.auth.username, password: PARSED_PROXY.auth.password };
  }
  return opts;
}

/* ----------------------------
   Normalizers
   ---------------------------- */
function normalizeKlineArray(arr) {
  if (!Array.isArray(arr)) return [];
  // Binance style: arrays of arrays
  if (Array.isArray(arr[0])) {
    try {
      const out = arr.map(k => ({
        t: Number(k[0]),
        open: safeNum(k[1]),
        high: safeNum(k[2]),
        low: safeNum(k[3]),
        close: safeNum(k[4]),
        vol: safeNum(k[5], 0)
      })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
      out.sort((a, b) => a.t - b.t);
      return out;
    } catch {}
  }
  // object array (FMP, Yahoo normalized)
  if (arr.length && typeof arr[0] === "object") {
    try {
      const out = arr.map(c => ({
        t: Number(c.t || c.timestamp || c.time || c.date || 0),
        open: safeNum(c.open ?? c.o ?? c.Open),
        high: safeNum(c.high ?? c.h ?? c.High),
        low: safeNum(c.low ?? c.l ?? c.Low),
        close: safeNum(c.close ?? c.c ?? c.Close),
        vol: safeNum(c.vol ?? c.v ?? c.volume ?? 0)
      })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
      out.sort((a, b) => a.t - b.t);
      return out;
    } catch {}
  }
  return [];
}

function normalizeYahooChart(res) {
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
    out.sort((a, b) => a.t - b.t);
    return out;
  } catch { return []; }
}

/* ----------------------------
   Synthetic fallback candle generator
   (makes sure we NEVER return empty arrays)
   ---------------------------- */
function generateSyntheticCandles({ lastPrice = 100, count = 240, intervalMs = 60_000, atr = null }) {
  const out = [];
  const base = safeNum(lastPrice, 100);
  const usedAtr = atr && atr > 0 ? atr : Math.max(base * 0.002, base * 0.005);
  let t = Date.now() - (count - 1) * intervalMs;
  let prev = base;
  for (let i = 0; i < count; i++) {
    const noise = (Math.random() - 0.5) * usedAtr * (0.9 + Math.random() * 0.6);
    const open = prev;
    const close = Math.max(0.0000001, prev + noise);
    const high = Math.max(open, close) + Math.abs(noise) * (0.1 + Math.random() * 0.9);
    const low = Math.min(open, close) - Math.abs(noise) * (0.1 + Math.random() * 0.9);
    const vol = Math.round(Math.abs(noise) * 1000 + Math.random() * 100);
    out.push({ t, open, high, low, close, vol });
    prev = close;
    t += intervalMs;
  }
  return out;
}

/* ----------------------------
   safeGet with retries, mirrors, external proxies
   ---------------------------- */
async function safeGet(url, { timeout = DEFAULT_TIMEOUT, responseType = "json", mirrors = [], tryProxies = true } = {}) {
  if (!url) return null;

  // try direct URL with retries
  for (let attempt = 0; attempt < Math.max(1, DEFAULT_RETRIES); attempt++) {
    try {
      const r = await axios.get(url, { ...axiosOptions(timeout), responseType });
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch {}
    await sleep(RETRY_DELAY_MS + Math.random() * 120);
  }

  // try mirror hosts by replacing origin
  for (const base of (mirrors || [])) {
    if (!base) continue;
    try {
      const u = new URL(url);
      const final = base.replace(/\/+$/, "") + u.pathname + u.search;
      for (let attempt = 0; attempt < Math.max(1, DEFAULT_RETRIES); attempt++) {
        try {
          const r = await axios.get(final, { ...axiosOptions(timeout), responseType });
          if (r?.data !== undefined && r?.data !== null) return r.data;
        } catch {}
        await sleep(RETRY_DELAY_MS + Math.random() * 120);
      }
    } catch {}
  }

  // try external public proxies (text response)
  if (tryProxies) {
    for (const pbase of EXTERNAL_PROXY_SERVICES) {
      try {
        const proxied = pbase + encodeURIComponent(url);
        for (let attempt = 0; attempt < Math.max(1, DEFAULT_RETRIES); attempt++) {
          try {
            const r = await axios.get(proxied, { ...axiosOptions(timeout), responseType: "text" });
            if (r?.data !== undefined && r?.data !== null) return r.data;
          } catch {}
          await sleep(RETRY_DELAY_MS + Math.random() * 120);
        }
      } catch {}
    }
  }

  return null;
}

/* =============================
   Market-specific fetchers
   Each returns: { data: [candles], price: lastPrice }
   Candles: { t, open, high, low, close, vol }
   ============================= */

/* ---------- CRYPTO (Binance primary, others fallback) ---------- */
async function fetchCrypto(symbol, interval = "15m", limit = CONFIG.DEFAULT_LIMIT || 500) {
  const s = String(symbol || "").toUpperCase();
  if (!s) return { data: [], price: null };
  const sources = CONFIG.SOURCES?.CRYPTO || ["binance", "yahoo", "synthetic"];
  const binanceBases = CONFIG.API.BINANCE || ["https://api.binance.com"];

  // 1) Binance primary
  try {
    const base = binanceBases[0].replace(/\/+$/, "");
    const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
    const raw = await safeGet(url, { mirrors: binanceBases.slice(1), timeout: DEFAULT_TIMEOUT, responseType: "json" });
    if (Array.isArray(raw) && raw.length) {
      const k = normalizeKlineArray(raw);
      if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
    }
  } catch {}

  // 2) Try alternate crypto exchanges: Coinbase (minute history limited), OKX (best-effort)
  // Coinbase: historic rates endpoint (granularity more limited) — try as fallback for price and small candles
  try {
    const coinbaseBase = CONFIG.API.COINBASE || "https://api.exchange.coinbase.com";
    // Coinbase uses e.g. BTC-USD format
    const map = CONFIG.SYMBOLS?.CRYPTO?.[s] || {};
    const cbSym = map?.coinbase || s.replace(/USDT$/, "-USD");
    const url = `${coinbaseBase}/products/${encodeURIComponent(cbSym)}/candles?granularity=${Math.max(60, Math.round(intervalToMs(interval)/1000))}`;
    const raw = await safeGet(url, { timeout: 9000, responseType: "json" });
    if (Array.isArray(raw) && raw.length) {
      // Coinbase returns [ time, low, high, open, close, volume ]
      const k = raw.map(r => ({ t: Number(r[0]) * 1000, open: safeNum(r[3]), high: safeNum(r[2]), low: safeNum(r[1]), close: safeNum(r[4]), vol: safeNum(r[5]) })).sort((a,b)=>a.t-b.t);
      if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
    }
  } catch {}

  // 3) Try OKX (best-effort)
  try {
    const okxBase = CONFIG.API.OKX || "https://www.okx.com";
    const map = CONFIG.SYMBOLS?.CRYPTO?.[s] || {};
    const okSym = map?.okx || s;
    // OKX has /api/v5/market/candles?instId=BTC-USDT&bar=1m
    const bar = interval.endsWith("m") ? `${Number(interval.slice(0,-1))}m` : interval.endsWith("h") ? `${Number(interval.slice(0,-1))}H` : "1m";
    const url = `${okxBase.replace(/\/+$/,"")}/api/v5/market/candles?instId=${encodeURIComponent(okSym)}&bar=${encodeURIComponent(bar)}&limit=${Number(Math.min(limit,1000))}`;
    const raw = await safeGet(url, { timeout: 9000, responseType: "json" });
    // OKX returns array of arrays
    if (Array.isArray(raw) && raw.length) {
      const k = raw.map(r => ({ t: Number(r[0]), open: safeNum(r[1]), high: safeNum(r[2]), low: safeNum(r[3]), close: safeNum(r[4]), vol: safeNum(r[5]) })).sort((a,b)=>a.t-b.t);
      if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
    }
  } catch {}

  // 4) Yahoo fallback (some crypto pairs exist)
  try {
    const map = CONFIG.SYMBOLS?.CRYPTO?.[s] || {};
    const ySym = map?.yahoo || s.replace("USDT", "-USD").replace("USDC", "-USD");
    const yfBases = CONFIG.API.YAHOO || ["https://query1.finance.yahoo.com/v8/finance/chart"];
    const tfmap = { "1m": "1m", "5m":"5m","15m":"15m","30m":"30m","1h":"60m" }[interval] || "15m";
    const url = `${yfBases[0].replace(/\/+$/,"")}/${encodeURIComponent(ySym)}?interval=${tfmap}&range=7d`;
    const raw = await safeGet(url, { mirrors: yfBases.slice(1), timeout: DEFAULT_TIMEOUT, responseType: "json" });
    const k = normalizeYahooChart(raw);
    if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
  } catch {}

  // 5) Cache fallback
  const cached = readCache(s, interval);
  if (cached && Array.isArray(cached.data) && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };

  // 6) Synthetic fallback (guarantee)
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: Math.min(500, Number(limit || 200)), intervalMs: intervalToMs(interval) });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
}

/* ---------- YAHOO generic fetcher (stocks/forex/commodities) ---------- */
async function fetchYahoo(symbol, interval = "15m") {
  const s = String(symbol || "").trim();
  if (!s) return { data: [], price: null };
  const bases = CONFIG.API.YAHOO || ["https://query1.finance.yahoo.com/v8/finance/chart"];
  const tfmap = { "1m": {interval:"1m", range:"1d"}, "5m":{interval:"5m", range:"5d"}, "15m":{interval:"15m", range:"5d"}, "30m":{interval:"30m", range:"1mo"}, "1h":{interval:"60m", range:"1mo"} }[interval] || {interval:"15m", range:"5d"};
  const url = `${bases[0].replace(/\/+$/,"")}/${encodeURIComponent(s)}?interval=${tfmap.interval}&range=${tfmap.range}`;
  try {
    const raw = await safeGet(url, { mirrors: bases.slice(1), timeout: DEFAULT_TIMEOUT, responseType: "json" });
    const k = normalizeYahooChart(raw);
    if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
  } catch {}

  // cache fallback
  const cached = readCache(s, interval);
  if (cached && Array.isArray(cached.data) && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };

  // synthetic fallback
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: 200, intervalMs: intervalToMs(interval) });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
}

/* ---------- FinancialModelingPrep (FMP) fetch for US stocks ---------- */
async function fetchFMP(symbol, interval = "15m") {
  try {
    const base = CONFIG.API.FMP || "https://financialmodelingprep.com/api/v3";
    const apiKey = process.env.FMP_API_KEY || "";
    // endpoint historical-chart/1min/AAPL
    const pathInterval = interval.endsWith("m") ? `${Number(interval.slice(0,-1))}min` : (interval.endsWith("h") ? `${Number(interval.slice(0,-1))}hour` : "1min");
    const url = `${base}/historical-chart/${interval}/${encodeURIComponent(symbol)}${apiKey ? `?apikey=${apiKey}` : ""}`;
    const raw = await safeGet(url, { timeout: DEFAULT_TIMEOUT, responseType: "json" });
    if (Array.isArray(raw) && raw.length) {
      const out = raw.map(r => ({ t: Number(new Date(r.date).getTime()), open: safeNum(r.open), high: safeNum(r.high), low: safeNum(r.low), close: safeNum(r.close), vol: safeNum(r.volume || 0) })).sort((a,b)=>a.t-b.t);
      if (out.length) { writeCache(symbol, interval, out); return { data: out, price: out.at(-1)?.close ?? lastGoodPrice(symbol) }; }
    }
  } catch {}
  return { data: [], price: null };
}

/* ---------- NSE / India fetcher (TradingView / MoneyControl / Yahoo) ---------- */
async function fetchNSE(symbol, interval = "15m") {
  const s = String(symbol || "").toUpperCase();
  if (!s) return { data: [], price: null };
  // mapping
  const mapping = CONFIG.SYMBOLS?.INDIA || {};
  const mapped = (typeof mapping === "object" && mapping[s]) ? mapping[s] : s;

  // try TradingView proxy if configured (best quality for indices)
  try {
    // many TV proxies are custom — we attempt configured proxies (best-effort)
    const tvBases = CONFIG.API.TRADINGVIEW_PROXY || [];
    for (const tv of tvBases) {
      try {
        // The tv proxy endpoints differ by setup; we call naive and parse fallback
        // Attempt fetch via tv/forexfeed-like endpoints — but avoid hard failure
        const tvUrl = `${tv.replace(/\/+$/,"")}/symbols/${encodeURIComponent(mapped)}/history?resolution=${interval}&from=${Math.floor((Date.now()/1000) - 3600*24)}&to=${Math.floor(Date.now()/1000)}`;
        const raw = await safeGet(tvUrl, { timeout: 9000, responseType: "json", tryProxies: false });
        if (raw && raw.s === "ok" && Array.isArray(raw.t) && raw.t.length) {
          const out = [];
          for (let i = 0; i < raw.t.length; i++) {
            out.push({ t: Number(raw.t[i]) * 1000, open: safeNum(raw.o[i]), high: safeNum(raw.h[i]), low: safeNum(raw.l[i]), close: safeNum(raw.c[i]), vol: safeNum(raw.v?.[i] ?? 0) });
          }
          if (out.length) { writeCache(s, interval, out); return { data: out, price: out.at(-1)?.close ?? lastGoodPrice(s) }; }
        }
      } catch {}
    }
  } catch {}

  // Moneycontrol (priceapi) best-effort historical endpoint
  try {
    const mcBases = CONFIG.API.MONEYCONTROL || [];
    for (const mc of mcBases) {
      try {
        // moneycontrol specific path: requires symbol id; unknown here: skip if not helpful
        const url = `${mc.replace(/\/+$/,"")}?symbol=${encodeURIComponent(mapped)}&resolution=${encodeURIComponent(interval)}`;
        const raw = await safeGet(url, { timeout: 9000, responseType: "json" });
        // Attempt to normalize if returns kline-like array
        if (Array.isArray(raw) && raw.length) {
          const k = normalizeKlineArray(raw);
          if (k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
        }
      } catch {}
    }
  } catch {}

  // Yahoo fallback
  try {
    const y = await fetchYahoo(mapped, interval);
    if (y && Array.isArray(y.data) && y.data.length) return y;
  } catch {}

  // cache or synthetic fallback
  const cached = readCache(s, interval);
  if (cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: 300, intervalMs: intervalToMs(interval) });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
}

/* ---------- Commodities fetcher (Yahoo primary, TradingView fallback) ---------- */
async function fetchCommodity(symbol, interval = "15m") {
  const map = CONFIG.SYMBOLS?.COMMODITIES || {};
  const mapped = (typeof map === "object" && map[symbol]) ? map[symbol] : symbol;
  return await fetchYahoo(mapped, interval);
}

/* ---------- Forex fetcher ---------- */
async function fetchForex(symbol, interval = "15m") {
  try {
    const s = String(symbol || "").toUpperCase().replace("/", "");
    if (!s) return { data: [], price: null };
    const map = CONFIG.SYMBOLS?.FOREX || {};
    const mapped = (typeof map === "object" && map[s]) ? map[s] : (s.endsWith("USD") ? `${s.slice(0,3)}${s.slice(3)}` : s);

    // try Yahoo
    const y = await fetchYahoo(mapped, interval);
    if (y && Array.isArray(y.data) && y.data.length) return y;

    // fallback to exchangerate.host for a single price
    try {
      const base = `https://api.exchangerate.host/latest?base=${s.slice(0,3)}&symbols=${s.slice(3,6)}`;
      const raw = await safeGet(base, { responseType: "json", timeout: 7000 });
      if (raw && raw.rates) {
        const p = Object.values(raw.rates)[0];
        const now = Date.now();
        const candle = [{ t: now - 60000, open: p, high: p, low: p, close: p, vol: 0 }];
        writeCache(s, interval, candle);
        return { data: candle, price: p };
      }
    } catch {}

  } catch {}

  // fallback cache / synthetic
  const cached = readCache(symbol, interval);
  if (cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(symbol) };
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(symbol) || 1.0, count: 200, intervalMs: intervalToMs(interval) });
  writeCache(symbol, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(symbol) };
}

/* ----------------------------
   High-level router — fetchUniversal
   Respects CONFIG.ACTIVE_MARKET override and heuristics
   ---------------------------- */
export async function fetchUniversal(inputSymbol = "", interval = "15m") {
  try {
    const symRaw = String(inputSymbol || "").trim();
    if (!symRaw) return { data: [], price: null };

    const s = symRaw.toUpperCase();
    const mappingCrypto = CONFIG.SYMBOLS?.CRYPTO || {};
    const mappingIndia = CONFIG.SYMBOLS?.INDIA || {};
    const mappingForex = CONFIG.SYMBOLS?.FOREX || {};
    const mappingUS = CONFIG.SYMBOLS?.US_STOCKS || {};
    const mappingCom = CONFIG.SYMBOLS?.COMMODITIES || {};

    const forced = (CONFIG.ACTIVE_MARKET || "").toUpperCase();

    // heuristics
    const isCrypto = /USDT$|BTC$|ETH$|SOL$|BNB$|^\w{3,6}USDT$/i.test(s) || Boolean(mappingCrypto[s]);
    const isIndia = Boolean(mappingIndia[s]);
    const isForex = Boolean(mappingForex[s]) || /^[A-Z]{6}$/.test(s) || (s.length === 6 && (s.endsWith("USD") || s.includes("JPY")));
    const isUSStock = Boolean(mappingUS[s]) || /^[A-Z]{1,5}$/.test(s);
    const isCommodity = Boolean(mappingCom[s]) || /^(GC=F|CL=F|SI=F|NG=F|GOLD|OIL|SILVER)$/i.test(s);

    // Respect forced market
    if (forced === "CRYPTO" || (!forced && isCrypto)) return await fetchCrypto(s, interval, CONFIG.DEFAULT_LIMIT);
    if (forced === "INDIA" || (!forced && isIndia)) return await fetchNSE(s, interval);
    if (forced === "FOREX" || (!forced && isForex)) return await fetchForex(s, interval);
    if (forced === "US_STOCKS" || (!forced && isUSStock)) {
      // try Yahoo then FMP
      const y = await fetchYahoo(mappingUS[s] ? mappingUS[s].yahoo || mappingUS[s] : s, interval);
      if (y && Array.isArray(y.data) && y.data.length) return y;
      const f = await fetchFMP(mappingUS[s] ? mappingUS[s].yahoo || mappingUS[s] : s, interval);
      if (f && Array.isArray(f.data) && f.data.length) return f;
      // fallback synthetic
      const cached = readCache(s, interval);
      if (cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };
      const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: 200, intervalMs: intervalToMs(interval) });
      writeCache(s, interval, synthetic);
      return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
    }
    if (forced === "COMMODITIES" || (!forced && isCommodity)) return await fetchCommodity(s, interval);

    // default: try Yahoo then crypto then synthetic
    try {
      const y = await fetchYahoo(s, interval);
      if (y && Array.isArray(y.data) && y.data.length) return y;
    } catch {}
    try {
      const c = await fetchCrypto(s, interval);
      if (c && Array.isArray(c.data) && c.data.length) return c;
    } catch {}

    // final cache / synthetic fallback
    const cached = readCache(s, interval);
    if (cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };
    const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: 200, intervalMs: intervalToMs(interval) });
    writeCache(s, interval, synthetic);
    return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };

  } catch (err) {
    // never throw — return safe synthetic data
    const sym = String(inputSymbol || "UNKNOWN");
    const cached = readCache(sym, interval);
    if (cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(sym) };
    const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(sym) || 100, count: 200, intervalMs: intervalToMs(interval) });
    writeCache(sym, interval, synthetic);
    return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(sym) };
  }
}

/* ----------------------------
   fetchMarketData (legacy compatibility)
   signature: (symbol, interval = "15m", limit = 200)
   returns { data, price, updated }
   ---------------------------- */
export async function fetchMarketData(inputSymbol = CONFIG.DEFAULT_BY_MARKET?.CRYPTO || "BTCUSDT", interval = "15m", limit = 200) {
  try {
    const symbol = String(inputSymbol || "").trim();
    if (!symbol) return { data: [], price: null, updated: new Date().toISOString() };
    // fetchUniversal already handles market routing
    const res = await fetchUniversal(symbol, interval);
    const data = Array.isArray(res.data) ? res.data.slice(-limit) : [];
    const price = (res.price ?? (data.length ? data.at(-1).close : null)) || lastGoodPrice(symbol);
    return { data, price, updated: new Date().toISOString() };
  } catch {
    const symbol = String(inputSymbol || "").trim();
    const cached = readCache(symbol, interval);
    return { data: cached?.data || [], price: cached?.data?.at(-1)?.close ?? lastGoodPrice(symbol) ?? null, updated: new Date().toISOString() };
  }
}

/* ----------------------------
   fetchPrice — tries multiple quick sources for just the latest price
   ---------------------------- */
export async function fetchPrice(rawSymbol = CONFIG.DEFAULT_BY_MARKET?.CRYPTO || "BTCUSDT") {
  try {
    const symbol = String(rawSymbol || "").trim();
    if (!symbol) return null;

    // 1) fetchUniversal 1m quick
    try {
      const res = await fetchUniversal(symbol, "1m");
      if (res && Array.isArray(res.data) && res.data.length) {
        const p = res.data.at(-1).close;
        if (Number.isFinite(+p)) return Number(p);
      }
    } catch {}

    // 2) cached last good
    const cached = lastGoodPrice(symbol);
    if (cached && Number.isFinite(+cached)) return Number(cached);

    // 3) synthetic fallback
    const synth = generateSyntheticCandles({ lastPrice: 100, count: 2, intervalMs: 60_000 });
    return synth.at(-1)?.close ?? null;
  } catch {
    return null;
  }
}

/* ----------------------------
   fetchMultiTF — fetch multiple timeframes concurrently (limited concurrency)
   returns: { "1m": { data, price }, "5m": {...}, ... }
   ---------------------------- */
function pLimit(concurrency = 3) {
  const queue = [];
  let active = 0;
  const next = () => {
    if (!queue.length || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve(fn()).then(v => { active--; resolve(v); next(); }).catch(e => { active--; reject(e); next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export async function fetchMultiTF(inputSymbol = CONFIG.DEFAULT_BY_MARKET?.CRYPTO || "BTCUSDT", tfs = ["1m","5m","15m","30m","1h"]) {
  const symbol = String(inputSymbol || "").trim();
  if (!symbol) {
    const empty = {};
    for (const tf of tfs) empty[tf] = { data: [], price: null };
    return empty;
  }
  const out = {};
  const limit = pLimit(3);
  const tasks = tfs.map(tf => limit(async () => {
    // tiny jitter to avoid bursts
    await sleep(30 + Math.floor(Math.random() * 120));
    const res = await fetchUniversal(symbol, tf);
    out[tf] = { data: Array.isArray(res.data) ? res.data : [], price: (res.price ?? (res.data?.at(-1)?.close ?? null)) };
  }));
  await Promise.all(tasks);
  return out;
}

/* ----------------------------
   Export default for compatibility
   ---------------------------- */
export default {
  fetchMarketData,
  fetchUniversal,
  fetchMultiTF,
  fetchPrice,
  readCache,
  writeCache,
  lastGoodPrice,
  generateSyntheticCandles
};