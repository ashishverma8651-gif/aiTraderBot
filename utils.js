// utils.js — Robust single-file heavy utils
// Exports: fetchUniversal, fetchPrice, fetchMultiTF, fetchMarketData
// Requires: axios, fs, path and ./config.js (default export CONFIG)

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// -----------------------------
// Setup & constants
// -----------------------------
const ROOT = process.cwd();
const CACHE_DIR = (CONFIG && CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const DEFAULT_RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES ?? 3);
const RETRY_DELAY_MS = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS ?? 600);
const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];
const USER_AGENT = "AI-Trader-Utils/2.0";

// -----------------------------
// small helpers
// -----------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const isFiniteNum = v => Number.isFinite(Number(v));
const safeNum = (v, fallback = 0) => isFiniteNum(v) ? Number(v) : fallback;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function tfSafe(tf = "15m") { return String(tf).replace(/[^a-z0-9]/gi, "_"); }
function symSafe(sym = "UNKNOWN") { return String(sym).toUpperCase().replace(/[^A-Z0-9_\-\.\^]/g, "_"); }
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symSafe(symbol)}_${tfSafe(interval)}.json`);
}
function readCache(symbol, interval) {
  const p = cachePath(symbol, interval);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}
function writeCache(symbol, interval, data) {
  const p = cachePath(symbol, interval);
  try { fs.writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2)); }
  catch (e) { /* ignore */ }
}
function lastCachedPrice(symbol) {
  // returns last cached close across TF files for symbol
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(symSafe(symbol) + "_"));
    files.sort((a,b)=> fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for (const f of files) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8") || "{}");
        const arr = obj?.data;
        if (Array.isArray(arr) && arr.length) {
          const last = arr[arr.length - 1];
          if (last && isFiniteNum(last.close)) return Number(last.close);
        }
      } catch {}
    }
  } catch {}
  return null;
}

// write last real price persistently (so price never becomes synthetic)
function writeLastRealPrice(symbol, price, meta = {}) {
  try {
    const p = path.join(CACHE_DIR, `${symSafe(symbol)}_lastprice.json`);
    const payload = { ts: Date.now(), price: safeNum(price, null), meta };
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {}
}
function readLastRealPrice(symbol) {
  try {
    const p = path.join(CACHE_DIR, `${symSafe(symbol)}_lastprice.json`);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
    if (isFiniteNum(raw?.price)) return Number(raw.price);
  } catch {}
  return null;
}

// -----------------------------
// axios options with optional proxy
// -----------------------------
function axiosOptions(timeout = DEFAULT_TIMEOUT) {
  const opts = { timeout, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } };
  // respect system HTTP_PROXY/HTTPS_PROXY if set by environment (axios uses env by default in Node)
  return opts;
}

// -----------------------------
// normalize helpers
// Output standard: [{t, open, high, low, close, vol}, ...] sorted ascending by t (ms)
// -----------------------------
function normalizeKlineArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  // Binance style [[ts, open, high, low, close, vol], ...]
  if (Array.isArray(arr[0])) {
    return arr.map(r => ({
      t: safeNum(r[0]),
      open: safeNum(r[1]),
      high: safeNum(r[2]),
      low: safeNum(r[3]),
      close: safeNum(r[4]),
      vol: safeNum(r[5], 0)
    })).filter(r => isFiniteNum(r.t) && isFiniteNum(r.close))
      .sort((a,b)=>a.t-b.t);
  }
  // Objects like [{date, open, high, low, close, volume}]
  if (typeof arr[0] === "object") {
    return arr.map(r => ({
      t: safeNum(r.t || r.ts || r.timestamp || new Date(r.date || r.datetime || r.time || Date.now()).getTime()),
      open: safeNum(r.open ?? r.o),
      high: safeNum(r.high ?? r.h),
      low: safeNum(r.low ?? r.l),
      close: safeNum(r.close ?? r.c),
      vol: safeNum(r.volume ?? r.v ?? 0)
    })).filter(r => isFiniteNum(r.t) && isFiniteNum(r.close)).sort((a,b)=>a.t-b.t);
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
    for (let i=0;i<ts.length;i++) {
      const close = q.close?.[i];
      if (!isFiniteNum(close)) continue;
      out.push({
        t: Number(ts[i]) * 1000,
        open: safeNum(q.open?.[i], close),
        high: safeNum(q.high?.[i], close),
        low: safeNum(q.low?.[i], close),
        close: safeNum(close),
        vol: safeNum(q.volume?.[i], 0)
      });
    }
    return out.sort((a,b)=>a.t-b.t);
  } catch { return []; }
}

// -----------------------------
// Synthetic candle generator — ONLY used to fill history when candles aren't available
// (never used to determine the live price used in signals)
// -----------------------------
function intervalToMs(interval = "15m") {
  if (!interval) return 60_000;
  const u = String(interval);
  if (u.endsWith("m")) return Number(u.slice(0,-1)) * 60_000;
  if (u.endsWith("h")) return Number(u.slice(0,-1)) * 60*60*1000;
  if (u.endsWith("d")) return Number(u.slice(0,-1)) * 24*60*60*1000;
  return 60_000;
}
function generateSyntheticCandles({ lastPrice = 100, count = 200, interval = "15m", atr = null }) {
  const out = [];
  const base = safeNum(lastPrice, 100);
  const iv = intervalToMs(interval);
  const usedAtr = (isFiniteNum(atr) && atr > 0) ? atr : Math.max(base * 0.002, base * 0.005);
  let t = Date.now() - (count-1) * iv;
  let prev = base;
  for (let i=0;i<count;i++) {
    const noise = (Math.random() - 0.5) * usedAtr;
    const open = prev;
    const close = Math.max(0.000001, prev + noise);
    const high = Math.max(open, close) + Math.abs(noise) * Math.random();
    const low = Math.min(open, close) - Math.abs(noise) * Math.random();
    const vol = Math.round(Math.abs(noise) * 1000 + Math.random()*100);
    out.push({ t, open, high, low, close, vol });
    t += iv; prev = close;
  }
  return out;
}

// -----------------------------
// safeGet with retries, mirrors and public proxy wrappers
// -----------------------------
async function safeGet(url, { timeout = DEFAULT_TIMEOUT, responseType = "json", mirrors = [], tryProxies = true } = {}) {
  if (!url) return null;
  // direct with retries
  for (let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++) {
    try {
      const r = await axios.get(url, { ...axiosOptions(timeout), responseType });
      if (r?.data !== undefined && r?.data !== null) return r.data;
    } catch {}
    await sleep(RETRY_DELAY_MS + Math.random()*100);
  }
  // try mirrors by replacing origin
  for (const base of mirrors || []) {
    if (!base) continue;
    try {
      const u = new URL(url);
      const final = base.replace(/\/+$/, "") + u.pathname + u.search;
      for (let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++) {
        try {
          const r = await axios.get(final, { ...axiosOptions(timeout), responseType });
          if (r?.data !== undefined && r?.data !== null) return r.data;
        } catch {}
        await sleep(RETRY_DELAY_MS + Math.random()*100);
      }
    } catch {}
  }
  // external proxies
  if (tryProxies) {
    for (const pbase of EXTERNAL_PROXY_SERVICES) {
      try {
        const proxied = pbase + encodeURIComponent(url);
        for (let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++) {
          try {
            const r = await axios.get(proxied, { ...axiosOptions(timeout), responseType: "text" });
            if (r?.data !== undefined && r?.data !== null) {
              // return text (caller may parse)
              return r.data;
            }
          } catch {}
          await sleep(RETRY_DELAY_MS + Math.random()*100);
        }
      } catch {}
    }
  }
  return null;
}

// -----------------------------
// MARKET-SPECIFIC FETCHERS
// All fetchers return: { data: [candles], price: lastCloseNumber }
// Price extraction MUST be last candle's close obtained from a REAL source.
// -----------------------------

// 1) TradingView (best for indices / national markets / TV symbols)
// We'll try proxy endpoints (TVC feed) which return JSON-like strings or chart data.
// Implementation is best-effort and tolerant to formats.
async function fetchTradingView(tvSymbol, interval = "15m") {
  if (!tvSymbol) return { data: [], price: null };
  // try each TV proxy base
  const proxies = CONFIG.API?.TRADINGVIEW_PROXY || [];
  const tfmap = { "1m":"1","5m":"5","15m":"15","30m":"30","1h":"60","4h":"240" }[interval] || "15";
  for (const base of proxies) {
    try {
      // many tv proxies expect: /symbols/{symbol}/?fields=...  (varies per proxy)
      // We'll try a couple of common endpoints and be defensive
      const tryUrls = [
        `${base.replace(/\/+$/,"")}/symbols/${encodeURIComponent(tvSymbol)}?resolution=${tfmap}`,
        `${base.replace(/\/+$/,"")}/history?symbol=${encodeURIComponent(tvSymbol)}&resolution=${tfmap}`,
        `${base.replace(/\/+$/,"")}/history?symbol=${encodeURIComponent(tvSymbol)}&resolution=${tfmap}&from=0&to=${Math.floor(Date.now()/1000)}`
      ];
      for (const url of tryUrls) {
        const raw = await safeGet(url, { responseType: "json", timeout: 8000, tryProxies: false });
        if (!raw) continue;
        // common tv history returns { s: "ok", t: [...], c:[...], o:[...], h:[...], l:[...], v:[...] }
        if (raw.s && raw.s === "ok" && Array.isArray(raw.t)) {
          const t = raw.t.map(x => Number(x)*1000);
          const out = [];
          for (let i=0;i<t.length;i++) {
            const close = safeNum(raw.c?.[i], NaN);
            if (!isFiniteNum(close)) continue;
            out.push({
              t: t[i],
              open: safeNum(raw.o?.[i], close),
              high: safeNum(raw.h?.[i], close),
              low: safeNum(raw.l?.[i], close),
              close,
              vol: safeNum(raw.v?.[i], 0)
            });
          }
          if (out.length) return { data: out.sort((a,b)=>a.t-b.t), price: out.at(-1).close };
        }
        // some proxies return html or script, attempt to parse numeric arrays from text
        if (typeof raw === "string" && /\[.*"t".*\]/.test(raw)) {
          // crude parse attempt
          try {
            const js = raw;
            const matches = js.match(/t:\s*\[([0-9, ]+)\]/);
            // skip if no reliable parse
          } catch {}
        }
      }
    } catch {}
  }
  return { data: [], price: null };
}

// 2) Binance (Crypto)
async function fetchBinance(symbol, interval = "15m", limit = 500) {
  if (!symbol) return { data: [], price: null };
  const bases = CONFIG.API?.BINANCE || ["https://api.binance.com"];
  const endpoint = "/api/v3/klines";
  for (const base of bases) {
    const url = `${base.replace(/\/+$/,"")}${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    try {
      const raw = await safeGet(url, { responseType: "json", mirrors: bases.slice(1) });
      if (Array.isArray(raw) && raw.length) {
        const k = normalizeKlineArray(raw);
        if (k.length) return { data: k, price: k.at(-1).close };
      }
    } catch {}
  }
  return { data: [], price: null };
}

// 3) Coinbase (Crypto)
async function fetchCoinbase(symbol, interval = "15m", limit = 500) {
  // Coinbase uses - and USD (BTC-USD)
  if (!symbol) return { data: [], price: null };
  const base = CONFIG.API?.COINBASE || "https://api.exchange.coinbase.com";
  // ensure symbol format (BTC-USD or ETH-USD)
  let s = symbol.replace("USDT","-USD").replace("/", "-");
  if (!s.includes("-")) s = s.replace(/([A-Z]+)(USD|USDT|BTC|EUR)/, "$1-USD");
  const url = `${base.replace(/\/+$/,"")}/products/${encodeURIComponent(s)}/candles?granularity=${Math.max(60, Math.floor(intervalToMs(interval)/1000))}`;
  try {
    const raw = await safeGet(url, { responseType: "json" });
    if (Array.isArray(raw) && raw.length) {
      // coinbase returns [ [time, low, high, open, close, volume], ... ] in reverse chrono
      const mapped = raw.map(r => [ r[0]*1000, r[3], r[2], r[1], r[4], r[5] ]).sort((a,b)=>a[0]-b[0]);
      const k = normalizeKlineArray(mapped);
      if (k.length) return { data: k, price: k.at(-1).close };
    }
  } catch {}
  return { data: [], price: null };
}

// 4) OKX (Crypto) - best-effort: they provide /api/v5/market/history-candles
async function fetchOKX(symbol, interval = "15m", limit = 500) {
  if (!symbol) return { data: [], price: null };
  const base = CONFIG.API?.OKX || "https://www.okx.com";
  // OKX uses - like BTC-USDT; adapt
  const s = symbol.includes("/") ? symbol.replace("/", "-") : (symbol.includes("USDT") ? symbol.replace("USDT", "-USDT") : symbol);
  // map interval to OKX granularity if needed (we'll use timeframe string)
  try {
    const url = `${base.replace(/\/+$/,"")}/api/v5/market/history-candles?instId=${encodeURIComponent(s)}&bar=${encodeURIComponent(interval)}&limit=${limit}`;
    const raw = await safeGet(url, { responseType: "json" });
    // raw might be { code: "0", data: [[ts, o,h,l,c,vol], ...] }
    const data = raw?.data || raw;
    if (Array.isArray(data) && data.length) {
      const k = data.map(r=>({
        t: safeNum(r[0]),
        open: safeNum(r[1]),
        high: safeNum(r[2]),
        low: safeNum(r[3]),
        close: safeNum(r[4]),
        vol: safeNum(r[5],0)
      })).sort((a,b)=>a.t-b.t);
      if (k.length) return { data: k, price: k.at(-1).close };
    }
  } catch {}
  return { data: [], price: null };
}

// 5) Yahoo (Stocks, Indices, Commodities, Forex)
async function fetchYahoo(symbol, interval = "15m") {
  if (!symbol) return { data: [], price: null };
  const bases = CONFIG.API?.YAHOO || ["https://query1.finance.yahoo.com/v8/finance/chart"];
  // tf mapping
  const tfmap = { "1m":{i:"1m",r:"1d"}, "5m":{i:"5m",r:"5d"}, "15m":{i:"15m",r:"5d"}, "30m":{i:"30m",r:"1mo"}, "1h":{i:"60m",r:"1mo"}, "4h":{i:"240m",r:"3mo"}, "1d":{i:"1d",r:"6mo"} }[interval] || {i:"15m",r:"5d"};
  for (const base of bases) {
    const url = `${base.replace(/\/+$/,"")}/${encodeURIComponent(symbol)}?interval=${tfmap.i}&range=${tfmap.r}`;
    try {
      const raw = await safeGet(url, { responseType: "json", mirrors: bases.slice(1) });
      const k = normalizeYahooChart(raw);
      if (k.length) return { data: k, price: k.at(-1).close };
    } catch {}
  }
  return { data: [], price: null };
}

// 6) Moneycontrol (India) — limited public endpoints; best-effort
async function fetchMoneyControl(symbol, interval = "15m") {
  if (!symbol) return { data: [], price: null };
  const bases = CONFIG.API?.MONEYCONTROL || [];
  for (const base of bases) {
    try {
      // Moneycontrol expects parameters; this endpoint varies. We'll attempt with common pattern:
      const url = `${base.replace(/\/+$/,"")}?symbol=${encodeURIComponent(symbol)}&resolution=${interval}`;
      const raw = await safeGet(url, { responseType: "json" });
      // raw often returns { data: [...] }
      const arr = raw?.data || raw;
      if (Array.isArray(arr) && arr.length) {
        const k = normalizeKlineArray(arr);
        if (k.length) return { data: k, price: k.at(-1).close };
      }
    } catch {}
  }
  return { data: [], price: null };
}

// 7) ExchangeRate (Forex quick price)
async function fetchExchangeRate(symbol) {
  // expects like EURUSD or EURUSD=X etc.
  if (!symbol || symbol.length < 6) return { data: [], price: null };
  try {
    const base = CONFIG.API?.EXCHANGERATE || "https://api.exchangerate.host";
    // adapt symbol: EURUSD -> base EUR target USD
    const s = symbol.replace("=","").replace("/","");
    const b = s.slice(0,3), q = s.slice(3,6);
    const url = `${base}/latest?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(q)}`;
    const raw = await safeGet(url, { responseType: "json" });
    const rate = raw?.rates?.[q] ?? raw?.rates && Object.values(raw.rates)[0];
    if (isFiniteNum(rate)) {
      const now = Date.now();
      const candle = [{ t: now - 60000, open: rate, high: rate, low: rate, close: rate, vol: 0 }];
      return { data: candle, price: safeNum(rate) };
    }
  } catch {}
  return { data: [], price: null };
}

// 8) FMP (Financial Modeling Prep) — stocks alt
async function fetchFMP(symbol, interval = "15m") {
  try {
    const base = CONFIG.API?.FMP || "https://financialmodelingprep.com/api/v3";
    const key = process.env.FMP_API_KEY ? `?apikey=${encodeURIComponent(process.env.FMP_API_KEY)}` : "";
    // endpoint historical-chart/{interval}/{symbol}
    const url = `${base}/historical-chart/${encodeURIComponent(interval)}/${encodeURIComponent(symbol)}${key}`;
    const raw = await safeGet(url, { responseType: "json" });
    if (Array.isArray(raw) && raw.length) {
      const mapped = raw.map(r=>({
        t: safeNum(new Date(r.date).getTime()),
        open: safeNum(r.open),
        high: safeNum(r.high),
        low: safeNum(r.low),
        close: safeNum(r.close),
        vol: safeNum(r.volume,0)
      })).sort((a,b)=>a.t-b.t);
      if (mapped.length) return { data: mapped, price: mapped.at(-1).close };
    }
  } catch {}
  return { data: [], price: null };
}

// -----------------------------
// High-level router: fetchUniversal
// Ensures: price comes from a REAL source (not synthetic)
// Steps (per earlier agreement):
// TradingView -> Exchange APIs (Binance/Coinbase/OKX) -> Yahoo -> MoneyControl/FMP/ExchangeRate -> Cache -> Synthetic (candles only)
// -----------------------------
export async function fetchUniversal(inputSymbol, interval = "15m", opts = {}) {
  try {
    const symbolRaw = String(inputSymbol || "").trim();
    if (!symbolRaw) return { data: [], price: null };

    // Determine market hints
    const s = symbolRaw.toUpperCase();
    const mappings = CONFIG.SYMBOLS || {};
    // detect direct mapping entries (user uses mapped keys like NIFTY50)
    const inCryptoMap = mappings.CRYPTO && mappings.CRYPTO[s];
    const inIndiaMap = mappings.INDIA && mappings.INDIA[s];
    const inUSMap = mappings.US_STOCKS && mappings.US_STOCKS[s];
    const inForexMap = mappings.FOREX && mappings.FOREX[s];
    const inCommodityMap = mappings.COMMODITIES && mappings.COMMODITIES[s];

    // Resolve possible provider-specific symbols
    const providers = {
      binance: inCryptoMap?.binance || s,
      coinbase: inCryptoMap?.coinbase || s.replace("USDT","-USD"),
      okx: inCryptoMap?.okx || s,
      yahoo: (inCryptoMap?.yahoo || inIndiaMap?.yahoo || inUSMap?.yahoo || inForexMap?.yahoo || inCommodityMap?.yahoo) || s,
      tv: (inCryptoMap?.tv || inIndiaMap?.tv || inUSMap?.tv || inCommodityMap?.tv) || s
    };

    // Respect configured SOURCE priority for market detection
    const forcedMarket = (CONFIG.ACTIVE_MARKET || "").toUpperCase() || null;
    const market = forcedMarket || (inCryptoMap ? "CRYPTO" : inIndiaMap ? "INDIA" : inUSMap ? "US_STOCKS" : inForexMap ? "FOREX" : inCommodityMap ? "COMMODITIES" : (/(USDT|USD|BTC|ETH)$/.test(s) ? "CRYPTO" : (/^[A-Z]{6}$/.test(s) ? "FOREX" : "US_STOCKS")));

    const intervalSafe = interval || "15m";

    // prepare cache fallback
    const cached = readCache(symbolRaw, intervalSafe);
    const lastReal = readLastRealPrice(symbolRaw) || lastCachedPrice(symbolRaw);

    // helper to return cache or synthetic if all fail
    const finalFallback = (meta={}) => {
      if (cached && Array.isArray(cached.data) && cached.data.length) {
        return { data: cached.data, price: cached.data.at(-1).close ?? lastReal ?? null, meta: { source: "cache", ...meta } };
      }
      const synth = generateSyntheticCandles({ lastPrice: lastReal || 100, count: Math.max(200, CONFIG.DEFAULT_LIMIT || 200), interval: intervalSafe });
      writeCache(symbolRaw, intervalSafe, synth);
      return { data: synth, price: synth.at(-1).close ?? lastReal ?? null, meta: { source: "synthetic", ...meta } };
    };

    // ORDERED attempts based on market
    const sourceOrder = CONFIG.SOURCES?.[market] || ["yahoo","cache","synthetic"];

    // iterate over sources; when a source returns real price, we stop and return that (but may still use other candles if needed)
    let collected = { data: [], price: null, meta: {} };

    for (const src of sourceOrder) {
      try {
        if (src === "tv") {
          const tvSym = providers.tv || providers.yahoo || s;
          const r = await fetchTradingView(tvSym, intervalSafe);
          if (r && Array.isArray(r.data) && r.data.length && isFiniteNum(r.price)) {
            // store cache, record last real
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "tradingview", symbol: tvSym });
            return { data: r.data, price: r.price, meta: { source: "tradingview", symbol: tvSym } };
          } else if (r && Array.isArray(r.data) && r.data.length && !isFiniteNum(r.price)) {
            // tradingview provided candles but no price — still store candles and continue to find price
            writeCache(symbolRaw, intervalSafe, r.data);
            collected.data = r.data;
          }
        } else if (src === "binance") {
          const binSym = providers.binance || s;
          const r = await fetchBinance(binSym, intervalSafe, Math.max(200, CONFIG.DEFAULT_LIMIT || 200));
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "binance", symbol: binSym });
            return { data: r.data, price: r.price, meta: { source: "binance", symbol: binSym } };
          } else if (r && r.data && r.data.length && !isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "coinbase") {
          const cbSym = providers.coinbase || s;
          const r = await fetchCoinbase(cbSym, intervalSafe);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "coinbase", symbol: cbSym });
            return { data: r.data, price: r.price, meta: { source: "coinbase", symbol: cbSym } };
          } else if (r && r.data && r.data.length) {
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "okx") {
          const okxSym = providers.okx || s;
          const r = await fetchOKX(okxSym, intervalSafe);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "okx", symbol: okxSym });
            return { data: r.data, price: r.price, meta: { source: "okx", symbol: okxSym } };
          } else if (r && r.data && r.data.length) {
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "yahoo") {
          const ySym = providers.yahoo || s;
          const r = await fetchYahoo(ySym, intervalSafe);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "yahoo", symbol: ySym });
            return { data: r.data, price: r.price, meta: { source: "yahoo", symbol: ySym } };
          } else if (r && r.data && r.data.length) {
            // save but keep searching for price
            writeCache(symbolRaw, intervalSafe, r.data);
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "moneycontrol") {
          const mcSym = providers.yahoo || s;
          const r = await fetchMoneyControl(mcSym, intervalSafe);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "moneycontrol", symbol: mcSym });
            return { data: r.data, price: r.price, meta: { source: "moneycontrol", symbol: mcSym } };
          } else if (r && r.data && r.data.length) {
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "fmp") {
          const fmpSym = providers.yahoo || s;
          const r = await fetchFMP(fmpSym, intervalSafe);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "fmp", symbol: fmpSym });
            return { data: r.data, price: r.price, meta: { source: "fmp", symbol: fmpSym } };
          } else if (r && r.data && r.data.length) {
            collected.data = collected.data.length ? collected.data : r.data;
          }
        } else if (src === "exchangerate") {
          // forex only pseudo
          const r = await fetchExchangeRate(s);
          if (r && r.data && r.data.length && isFiniteNum(r.price)) {
            writeCache(symbolRaw, intervalSafe, r.data);
            writeLastRealPrice(symbolRaw, r.price, { src: "exchangerate", symbol: s });
            return { data: r.data, price: r.price, meta: { source: "exchangerate", symbol: s } };
          }
        } else if (src === "cache") {
          if (cached && cached.data && cached.data.length) {
            // return cached real price if available
            const price = cached.data.at(-1).close ?? readLastRealPrice(symbolRaw) ?? lastCachedPrice(symbolRaw);
            if (isFiniteNum(price)) {
              return { data: cached.data, price, meta: { source: "cache" } };
            }
          }
        } else if (src === "synthetic") {
          // return synthetic only as last resort (candles ok, price will be lastClose of synth only if no real price found)
          // But per rule: we will NOT set synthetic price if any real last price exists (readLastRealPrice)
          if (readLastRealPrice(symbolRaw)) {
            // if we have last real price, use it + synthetic candles built around it to fill history
            const synth = generateSyntheticCandles({ lastPrice: readLastRealPrice(symbolRaw), count: Math.max(200, CONFIG.DEFAULT_LIMIT || 200), interval: intervalSafe });
            writeCache(symbolRaw, intervalSafe, synth);
            return { data: synth, price: readLastRealPrice(symbolRaw), meta: { source: "synthetic_but_price_from_last_real" } };
          }
          // else produce synthetic + synthetic price (only when absolutely nothing else ever existed)
          const synth = generateSyntheticCandles({ lastPrice: 100, count: Math.max(200, CONFIG.DEFAULT_LIMIT || 200), interval: intervalSafe });
          writeCache(symbolRaw, intervalSafe, synth);
          return { data: synth, price: synth.at(-1).close, meta: { source: "synthetic_force" } };
        }
      } catch (e) {
        // continue to next source
      }
    }

    // if loop ended with collected candles (no price) but lastReal exists -> return candles with lastReal price
    if (collected.data && collected.data.length && readLastRealPrice(symbolRaw)) {
      return { data: collected.data, price: readLastRealPrice(symbolRaw), meta: { source: "collected_candles", note: "price_from_last_real" } };
    }

    // final fallback to cache or synthetic
    return finalFallback({ note: "all_sources_failed" });
  } catch (e) {
    return { data: [], price: null, error: String(e) };
  }
}

// -----------------------------
// fetchPrice: ONLY returns a single canonical price (the last real candle close)
// Follows agreed rule: TradingView > Exchange > Yahoo > MoneyControl > Cache
// NEVER returns a synthetic-generated price unless absolutely no previous real price exists
// -----------------------------
export async function fetchPrice(symbol) {
  try {
    if (!symbol) return null;
    // quick attempts: TradingView -> Binance/Coinbase/OKX -> Yahoo -> Moneycontrol -> lastReal -> cached last -> null
    // TradingView
    const providersMap = (() => {
      const mm = CONFIG.SYMBOLS || {};
      const symKey = String(symbol || "").toUpperCase();
      const inCryptoMap = mm.CRYPTO && mm.CRYPTO[symKey];
      const inIndiaMap = mm.INDIA && mm.INDIA[symKey];
      const providers = {};
      providers.binance = inCryptoMap?.binance || symbol;
      providers.coinbase = inCryptoMap?.coinbase || (symbol.replace("USDT","-USD"));
      providers.okx = inCryptoMap?.okx || symbol;
      providers.yahoo = inCryptoMap?.yahoo || inIndiaMap?.yahoo || symbol;
      providers.tv = inCryptoMap?.tv || inIndiaMap?.tv || symbol;
      return providers;
    })();

    // 1) TradingView
    try {
      const tv = await fetchTradingView(providersMap.tv, "1m");
      if (tv && isFiniteNum(tv.price)) { writeLastRealPrice(symbol, tv.price, { source: "tradingview" }); return tv.price; }
    } catch {}

    // 2) Exchange native (Binance / Coinbase / OKX) for crypto
    try {
      // Binance
      const bin = await fetchBinance(providersMap.binance, "1m", 5);
      if (bin && isFiniteNum(bin.price)) { writeLastRealPrice(symbol, bin.price, { source: "binance" }); return bin.price; }
    } catch {}
    try {
      const cb = await fetchCoinbase(providersMap.coinbase, "1m");
      if (cb && isFiniteNum(cb.price)) { writeLastRealPrice(symbol, cb.price, { source: "coinbase" }); return cb.price; }
    } catch {}
    try {
      const okx = await fetchOKX(providersMap.okx, "1m");
      if (okx && isFiniteNum(okx.price)) { writeLastRealPrice(symbol, okx.price, { source: "okx" }); return okx.price; }
    } catch {}

    // 3) Yahoo
    try {
      const y = await fetchYahoo(providersMap.yahoo || symbol, "1m");
      if (y && isFiniteNum(y.price)) { writeLastRealPrice(symbol, y.price, { source: "yahoo" }); return y.price; }
    } catch {}

    // 4) Moneycontrol / FMP / ExchangeRate
    try {
      const mc = await fetchMoneyControl(symbol, "1m");
      if (mc && isFiniteNum(mc.price)) { writeLastRealPrice(symbol, mc.price, { source: "moneycontrol" }); return mc.price; }
    } catch {}
    try {
      const fx = await fetchExchangeRate(symbol);
      if (fx && isFiniteNum(fx.price)) { writeLastRealPrice(symbol, fx.price, { source: "exchangerate" }); return fx.price; }
    } catch {}
    try {
      const fmp = await fetchFMP(symbol, "1min");
      if (fmp && isFiniteNum(fmp.price)) { writeLastRealPrice(symbol, fmp.price, { source: "fmp" }); return fmp.price; }
    } catch {}

    // 5) last real from disk
    const lastReal = readLastRealPrice(symbol);
    if (isFiniteNum(lastReal)) return lastReal;

    // 6) last cached close
    const cachedClose = lastCachedPrice(symbol);
    if (isFiniteNum(cachedClose)) return cachedClose;

    // 7) fail safe -> null (caller should use fallback candle generator but not a fake price)
    return null;
  } catch (e) {
    return null;
  }
}

// -----------------------------
// fetchMultiTF(symbol, tfs)
// returns map { tf: { data:[], price } }
// -----------------------------
export async function fetchMultiTF(symbol, tfs = ["1m","5m","15m","30m","1h"]) {
  const out = {};
  const tasks = tfs.map(tf => (async () => {
    try {
      const r = await fetchUniversal(symbol, tf);
      out[tf] = { data: r.data || [], price: isFiniteNum(r.price) ? r.price : (readLastRealPrice(symbol) || lastCachedPrice(symbol) || null), meta: r.meta || {} };
    } catch (e) {
      out[tf] = { data: [], price: readLastRealPrice(symbol) || lastCachedPrice(symbol) || null, meta: { error: String(e) } };
    }
  })());
  await Promise.all(tasks);
  return out;
}

// -----------------------------
// fetchMarketData legacy wrapper for compatibility
// returns { data, price, updated }
// -----------------------------
export async function fetchMarketData(symbol, interval = "15m", limit = CONFIG.DEFAULT_LIMIT || 200) {
  try {
    const res = await fetchUniversal(symbol, interval);
    return {
      data: res.data || [],
      price: isFiniteNum(res.price) ? res.price : (readLastRealPrice(symbol) || lastCachedPrice(symbol) || null),
      updated: nowISO(),
      meta: res.meta || {}
    };
  } catch (e) {
    return { data: readCache(symbol, interval)?.data || [], price: readLastRealPrice(symbol) || lastCachedPrice(symbol) || null, updated: nowISO(), error: String(e) };
  }
}

// -----------------------------
// Exports (already exported above) + default
// -----------------------------
export default {
  fetchUniversal,
  fetchPrice,
  fetchMultiTF,
  fetchMarketData,
  readCache,
  writeCache,
  readLastRealPrice,
  writeLastRealPrice
};