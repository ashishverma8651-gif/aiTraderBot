// utils.js — Fully Synced With New Multi-Market CONFIG
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

/************************************************************
 *  CONSTANTS & SETUP
 ************************************************************/
const CACHE_DIR = CONFIG.PATHS.CACHE_DIR;
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES || 3);
const RETRY_DELAY = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS || 500);

const PROXY = CONFIG.PROXY;
const ACTIVE_MARKET = CONFIG.ACTIVE_MARKET.toUpperCase();
const ACTIVE_SYMBOL = CONFIG.ACTIVE_SYMBOL;


/************************************************************
 *  PROXY SUPPORT
 ************************************************************/
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const auth = u.username
      ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      : undefined;

    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
      auth
    };
  } catch {
    return null;
  }
}

const PARSED_PROXY = parseProxy(PROXY);

function axiosOptions(timeout = TIMEOUT) {
  const opts = { timeout };
  if (PARSED_PROXY) {
    opts.proxy = {
      host: PARSED_PROXY.host,
      port: PARSED_PROXY.port
    };
    if (PARSED_PROXY.auth) {
      opts.proxy.auth = {
        username: PARSED_PROXY.auth.username,
        password: PARSED_PROXY.auth.password
      };
    }
  }
  return opts;
}


/************************************************************
 *  INTERNAL HELPERS
 ************************************************************/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCache(symbol, interval) {
  const p = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(symbol, interval, data) {
  const p = path.join(CACHE_DIR, `${symbol}_${interval}.json`);
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({ fetchedAt: Date.now(), data }, null, 2)
    );
  } catch {}
}

function lastGoodPrice(symbol) {
  try {
    const files = fs
      .readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(symbol.toUpperCase() + "_"));

    files.sort(
      (a, b) =>
        fs.statSync(path.join(CACHE_DIR, b)).mtimeMs -
        fs.statSync(path.join(CACHE_DIR, a)).mtimeMs
    );

    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
      const arr = j.data;
      if (Array.isArray(arr) && arr.length) {
        const close = arr.at(-1).close;
        if (Number.isFinite(close)) return close;
      }
    }
  } catch {}
  return null;
}


/************************************************************
 *  SAFE GET (retries + multi-source + proxy)
 ************************************************************/
async function safeGet(url, sources = []) {
  // main URL
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await axios.get(url, axiosOptions());
      if (r?.data) return r.data;
    } catch {}
    await sleep(RETRY_DELAY);
  }

  // fallback sources
  for (const base of sources) {
    let final = url;
    try {
      const u = new URL(url);
      final = base.replace(/\/+$/, "") + u.pathname + u.search;
    } catch {}

    for (let i = 0; i < RETRIES; i++) {
      try {
        const r = await axios.get(final, axiosOptions());
        if (r?.data) return r.data;
      } catch {}
      await sleep(RETRY_DELAY);
    }
  }

  return null;
}


/************************************************************
 *  NORMALIZERS
 ************************************************************/
function normalizeKline(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((k) => ({
    t: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    vol: Number(k[5])
  }));
}

function normalizeYahoo(res) {
  try {
    const r = res.chart.result[0];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];

    const out = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q.close[i];
      if (!Number.isFinite(close)) continue;

      out.push({
        t: ts[i] * 1000,
        open: q.open[i] ?? close,
        high: q.high[i] ?? close,
        low: q.low[i] ?? close,
        close,
        vol: q.volume[i] ?? 0
      });
    }

    return out;
  } catch {
    return [];
  }
}


/************************************************************
 *  MARKET SPECIFIC FETCHERS
 ************************************************************/
async function fetchCrypto(symbol, interval = "15m", limit = 200) {
  const cache = readCache(symbol, interval);
  const base = "https://api.binance.com/api/v3/klines";
  const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const sources = CONFIG.DATA_SOURCES_BY_MARKET.CRYPTO;

  const raw = await safeGet(url, sources);
  if (Array.isArray(raw) && raw.length) {
    const k = normalizeKline(raw);
    writeCache(symbol, interval, k);
    return k;
  }
  return cache?.data || [];
}

async function fetchYahoo(symbol, interval = "15m") {
  const tf = {
    "1m": { interval: "1m", range: "1d" },
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "1mo" },
    "1h": { interval: "60m", range: "1mo" }
  }[interval] || { interval: "15m", range: "5d" };

  const base = CONFIG.DATA_SOURCES_BY_MARKET.US_STOCKS[0];
  const url = `${base}/${encodeURIComponent(symbol)}?interval=${tf.interval}&range=${tf.range}`;

  const cache = readCache(symbol, interval);
  const res = await safeGet(url, CONFIG.DATA_SOURCES_BY_MARKET.US_STOCKS);

  if (res) {
    const k = normalizeYahoo(res);
    if (k.length) {
      writeCache(symbol, interval, k);
      return k;
    }
  }

  return cache?.data || [];
}

async function fetchNSE(symbol, interval = "15m") {
  // uses Yahoo behind the scenes
  return await fetchYahoo(symbol, interval);
}


/************************************************************
 *  MASTER PRICE (Yahoo → Binance → Cache)
 ************************************************************/
export async function fetchPrice(symbol) {
  symbol = symbol.toUpperCase();

  // Yahoo
  const y = await fetchYahoo(symbol, "1m");
  if (y.length) return y.at(-1).close;

  // Binance (if crypto)
  if (symbol.endsWith("USDT") || symbol.endsWith("BTC")) {
    const c = await fetchCrypto(symbol, "1m", 2);
    if (c.length) return c.at(-1).close;
  }

  // Cache
  return lastGoodPrice(symbol);
}


/************************************************************
 *  UNIVERSAL FETCHER — FINAL ROUTER
 ************************************************************/
export async function fetchUniversal(symbol, interval = "15m") {
  symbol = symbol.toUpperCase();

  // AUTO CRYPTO DETECTION
  const isCrypto = symbol.endsWith("USDT") || symbol.endsWith("BTC");

  if (ACTIVE_MARKET === "CRYPTO" || isCrypto) {
    const d = await fetchCrypto(symbol, interval);
    return { data: d, price: d.at(-1)?.close || (await fetchPrice(symbol)) };
  }

  if (ACTIVE_MARKET === "INDIA") {
    const d = await fetchNSE(symbol, interval);
    return { data: d, price: d.at(-1)?.close || (await fetchPrice(symbol)) };
  }

  // Forex & US stocks → Yahoo
  const d = await fetchYahoo(symbol, interval);
  return { data: d, price: d.at(-1)?.close || (await fetchPrice(symbol)) };
}


/************************************************************
 *  MULTI TF WRAPPER
 ************************************************************/
function pLimit(concurrency = 2) {
  const queue = [];
  let active = 0;

  const next = () => {
    if (!queue.length || active >= concurrency) return;

    active++;
    const { fn, resolve } = queue.shift();

    Promise.resolve(fn()).then((v) => {
      active--;
      resolve(v);
      next();
    });
  };

  return (fn) =>
    new Promise((resolve) => {
      queue.push({ fn, resolve });
      next();
    });
}

export async function fetchMultiTF(symbol, tfs = ["5m", "15m", "1h"]) {
  const limit = pLimit(2);
  const out = {};

  await Promise.all(
    tfs.map((tf) =>
      limit(async () => {
        await sleep(100);
        out[tf] = await fetchUniversal(symbol, tf);
      })
    )
  );

  return out;
}


/************************************************************
 *  Legacy export for compatibility
 ************************************************************/
export async function fetchMarketData(symbol, interval = "15m", limit = 200) {
  const d = await fetchCrypto(symbol, interval, limit);
  const price =
    d.at(-1)?.close || (await fetchPrice(symbol)) || lastGoodPrice(symbol);

  return {
    data: d,
    price,
    updated: new Date().toISOString()
  };
}