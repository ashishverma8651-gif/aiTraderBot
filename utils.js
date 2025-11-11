// utils.js
import axios from "axios";
import fs from "fs";
import CONFIG from "./config.js";

export function nowLocal() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export async function keepAlive(selfPingUrl = CONFIG.SELF_PING_URL) {
  if (!selfPingUrl) return;
  try {
    await axios.get(selfPingUrl, { timeout: 5000 });
    console.log("🌐 KeepAlive ping OK");
  } catch (e) {
    console.warn("KeepAlive failed:", e.message || e);
  }
}

function saveCache(obj) {
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn("Cache write failed:", e.message || e);
  }
}
function loadCache() {
  try {
    if (!fs.existsSync(CONFIG.CACHE_FILE)) return {};
    const raw = fs.readFileSync(CONFIG.CACHE_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
}

export function readCache() {
  const c = loadCache();
  return c;
}
export function writeCache(symbol, klines) {
  const c = loadCache();
  c[symbol] = { ts: Date.now(), data: klines };
  saveCache(c);
}

// ===========================
// utils.js — AI Trader v9.6 Unified Fetch
// ===========================
import axios from "axios";
import fs from "fs";
import CONFIG from "./config.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeFetch(url, label, transform) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (AI-TraderBot-v9.6)",
        "Accept": "application/json,text/plain,*/*"
      }
    });
    if (res.status === 200) {
      const data = transform(res.data);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`✅ ${label} OK (${data.length} candles)`);
        return { ok: true, data, source: label };
      }
    }
    throw new Error(`Bad response ${res.status}`);
  } catch (e) {
    console.warn(`❌ ${label} failed: ${e.message}`);
    return { ok: false };
  }
}

// --------------
// 🟢 Crypto fetcher (Binance + alt + fallback)
// --------------
async function fetchCrypto(symbol, interval = "15m", limit = 500) {
  for (const base of CONFIG.BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await safeFetch(url, `Binance(${base.split("/")[2]})`, (raw) =>
      raw.map(k => ({
        t: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        vol: +k[5],
      }))
    );
    if (res.ok) return res;
    await delay(1500);
  }

  // CoinGecko fallback
  const cg = await safeFetch(`${CONFIG.FALLBACK_SOURCES.COINGECKO}/coins/bitcoin/market_chart?vs_currency=usd&days=1`, "CoinGecko", (raw) =>
    raw.prices.map(p => ({
      t: p[0],
      open: p[1],
      high: p[1],
      low: p[1],
      close: p[1],
      vol: 0
    }))
  );
  if (cg.ok) return cg;

  // KuCoin fallback
  const ku = await safeFetch(`${CONFIG.FALLBACK_SOURCES.KUCOIN}/api/v1/market/candles?symbol=${symbol}&type=15min`, "KuCoin", (raw) =>
    raw.data.map(k => ({
      t: +k[0] * 1000,
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      vol: +k[5],
    }))
  );
  if (ku.ok) return ku;

  return { ok: false };
}

// --------------
// 🇮🇳 Indian Market (NSE + Yahoo + backup)
// --------------
async function fetchIndian(symbol) {
  const nseUrl = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
  const yahooUrl = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${symbol}?region=IN&interval=15m&range=1d`;

  const nse = await safeFetch(nseUrl, "NSE India", (raw) => {
    const price = raw.priceInfo?.lastPrice;
    if (!price) return [];
    return [{ t: Date.now(), open: price, high: price, low: price, close: price, vol: 0 }];
  });
  if (nse.ok) return nse;

  const yahoo = await safeFetch(yahooUrl, "Yahoo Finance (IN)", (raw) => {
    const res = raw.chart?.result?.[0];
    if (!res) return [];
    return res.timestamp.map((t, i) => ({
      t: t * 1000,
      open: res.indicators.quote[0].open[i],
      high: res.indicators.quote[0].high[i],
      low: res.indicators.quote[0].low[i],
      close: res.indicators.quote[0].close[i],
      vol: res.indicators.quote[0].volume[i],
    }));
  });
  if (yahoo.ok) return yahoo;

  return { ok: false };
}

// --------------
// 🟡 Metals (Gold, Silver) via Yahoo / backup
// --------------
async function fetchMetals(symbol) {
  const tick = symbol === "GOLD" ? "GC=F" : "SI=F";
  const url = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${tick}?interval=15m&range=1d`;
  const yahoo = await safeFetch(url, `Yahoo ${symbol}`, (raw) => {
    const res = raw.chart?.result?.[0];
    if (!res) return [];
    return res.timestamp.map((t, i) => ({
      t: t * 1000,
      open: res.indicators.quote[0].open[i],
      high: res.indicators.quote[0].high[i],
      low: res.indicators.quote[0].low[i],
      close: res.indicators.quote[0].close[i],
      vol: res.indicators.quote[0].volume[i],
    }));
  });
  if (yahoo.ok) return yahoo;

  return { ok: false };
}

// --------------
// 🌍 Unified Fetch Entry
// --------------
export async function fetchMarketData(symbol = CONFIG.SYMBOL) {
  let result = { ok: false };
  console.log(`\n⏳ Fetching data for ${symbol}...`);

  if (CONFIG.MARKETS.CRYPTO.includes(symbol)) {
    result = await fetchCrypto(symbol);
  } else if (CONFIG.MARKETS.INDIAN.includes(symbol)) {
    result = await fetchIndian(symbol);
  } else if (CONFIG.MARKETS.METALS.includes(symbol)) {
    result = await fetchMetals(symbol);
  }

  if (result.ok && result.data?.length) {
    saveCache(symbol, result.data);
    return { data: result.data, source: result.source };
  }

  const cache = readCache();
  if (cache[symbol] && Date.now() - cache[symbol].ts < CONFIG.CACHE_RETENTION_MS) {
    console.log("♻️ Using cached data for", symbol);
    return { data: cache[symbol].data, source: "cache" };
  }

  console.error("🚫 No market data available for", symbol);
  return { data: [], source: "none" };
}

// --------------
// 💾 Cache System (1-day retention)
// --------------
function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE))
      cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
    cache[symbol] = { ts: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e.message);
  }
}

function readCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE))
      return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
  } catch {}
  return {};
}