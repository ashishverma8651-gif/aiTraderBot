// utils.js — Multi-Market Live Data Engine (NSE + Binance + Yahoo + Fallback)
// NOW includes fetchMultiTF + fetchPrice EXACT signature used in aiTraderBot

import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// ---------- Setup ----------
const CACHE_DIR = CONFIG.PATHS.CACHE_DIR;
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const TIMEOUT = 10000;
const RETRIES = CONFIG.FALLBACK.MAX_RETRIES;

// ---------- Helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v, d=0)=>Number.isFinite(Number(v))?Number(v):d;

// ---------- CACHE ----------
function cachePath(symbol, tf) {
  return path.join(CACHE_DIR, `${symbol}_${tf}.json`);
}
function writeCache(symbol, tf, data) {
  fs.writeFileSync(cachePath(symbol, tf), JSON.stringify({data, t: Date.now()},null,2));
}
function readCache(symbol, tf) {
  try { return JSON.parse(fs.readFileSync(cachePath(symbol, tf)))?.data; } catch { return null; }
}

// ---------- safeGet() with mirrors + proxy ----------
async function safeGet(url, {mirrors=[], responseType="json"}={}) {
  let tries = [...[url], ...mirrors];

  for (const link of tries) {
    for (let i=0;i<RETRIES;i++){
      try {
        const res = await axios.get(link, {
          timeout: TIMEOUT,
          responseType,
          headers: { "User-Agent": USER_AGENT, "Accept": "*/*" }
        });
        return res.data;
      } catch {}
      await sleep(200);
    }
  }
  return null;
}

// ===============================================================
//                     1) NSE LIVE FETCHER
// ===============================================================
export async function fetchNSE(symbol) {
  const map = CONFIG.SYMBOLS.INDIA[symbol];
  if (!map) return {price:null};

  const indexName = encodeURIComponent(map.nse);
  const url = `${CONFIG.API.NSE_INDEX}${indexName}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": "https://www.nseindia.com"
      }
    });

    const d = res.data?.data;
    return {
      price: safe(d?.last),
      open: safe(d?.open),
      high: safe(d?.dayHigh),
      low: safe(d?.dayLow),
      prev: safe(d?.previousClose)
    };
  } catch {
    return { price: null };
  }
}

// ===============================================================
//                     2) CRYPTO — BINANCE
// ===============================================================
export async function fetchCrypto(symbol, interval="15m", limit=500) {
  const s = CONFIG.SYMBOLS.CRYPTO[symbol]?.binance || symbol;

  const base = CONFIG.API.BINANCE[0];
  const mirrors = CONFIG.API.BINANCE.slice(1);

  const url = `${base}/api/v3/klines?symbol=${s}&interval=${interval}&limit=${limit}`;

  const raw = await safeGet(url, {mirrors});
  if (Array.isArray(raw)) {
    const kl = raw.map(k => ({
      t: k[0],
      open: safe(k[1]),
      high: safe(k[2]),
      low: safe(k[3]),
      close: safe(k[4]),
      vol: safe(k[5])
    }));
    writeCache(symbol, interval, kl);
    return {data: kl, price: kl.at(-1)?.close};
  }

  const c = readCache(symbol, interval);
  return {data: c || [], price: c?.at(-1)?.close || null};
}

// ===============================================================
//           3) Yahoo — Forex & Commodities fallback
// ===============================================================
export async function fetchYahoo(symbol, interval="15m") {
  const y = CONFIG.SYMBOLS.FOREX[symbol]?.yahoo
         || CONFIG.SYMBOLS.COMMODITIES[symbol]?.yahoo;

  if (!y) return {data:[], price:null};

  const base = CONFIG.API.YAHOO[0];
  const url = `${base}/${encodeURIComponent(y)}?interval=${interval}&range=5d`;

  const raw = await safeGet(url, {mirrors:CONFIG.API.YAHOO});
  try {
    const r = raw.chart.result[0];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];

    const arr = ts.map((t,i)=>({
      t: t*1000,
      open: safe(q.open[i], q.close[i]),
      high: safe(q.high[i], q.close[i]),
      low: safe(q.low[i], q.close[i]),
      close: safe(q.close[i]),
      vol: safe(q.volume[i])
    }));

    writeCache(symbol, interval, arr);
    return {data:arr, price: arr.at(-1).close};
  }
  catch {
    const c = readCache(symbol, interval);
    return {data:c||[], price:c?.at(-1)?.close};
  }
}

// ===============================================================
//                    UNIVERSAL FETCHER
// ===============================================================
export async function fetchUniversal(symbol, interval="15m") {
  const market =
    CONFIG.SYMBOLS.CRYPTO[symbol] ? "CRYPTO" :
    CONFIG.SYMBOLS.INDIA[symbol] ? "INDIA" :
    CONFIG.SYMBOLS.FOREX[symbol] ? "FOREX" :
    CONFIG.SYMBOLS.COMMODITIES[symbol] ? "COMMODITIES" :
    "CRYPTO";

  if (market === "INDIA") return await fetchNSE(symbol);
  if (market === "CRYPTO") return await fetchCrypto(symbol, interval);
  if (market === "COMMODITIES") return await fetchYahoo(symbol, interval);
  if (market === "FOREX") return await fetchYahoo(symbol, interval);

  return {price:null, data:[]};
}

// ===============================================================
//            💥 REQUIRED BY AI TRADER BOT: fetchMultiTF
// ===============================================================
export async function fetchMultiTF(symbol, tfs=["1m","5m","15m","30m","1h"]) {
  const out = {};

  await Promise.all(
    tfs.map(async (tf) => {
      const d = await fetchUniversal(symbol, tf);
      out[tf] = d;
    })
  );

  return out;
}

// ===============================================================
//      💥 REQUIRED BY AI TRADER BOT: fetchPrice(symbol)
// ===============================================================
export async function fetchPrice(symbol) {
  const r = await fetchUniversal(symbol, "1m");
  return r.price;
}

export default {
  fetchMultiTF,
  fetchPrice,
  fetchUniversal,
  fetchCrypto,
  fetchNSE,
  fetchYahoo
};