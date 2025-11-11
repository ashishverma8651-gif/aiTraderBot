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

// fetchMarketData: try Binance endpoints in order, then fallbacks
export async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 500) {
  // Binance klines endpoint: /api/v3/klines?symbol=BTCUSDT&interval=15m&limit=500
  const binancePaths = CONFIG.BINANCE_SOURCES.map(base => `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const fallback = CONFIG.FALLBACK_SOURCES;

  // Try Binance alternate hosts sequentially
  for (let url of binancePaths) {
    try {
      const res = await axios.get(url, { timeout: 7000 });
      if (res && res.data && Array.isArray(res.data) && res.data.length) {
        // convert to standard klines array of objects: { t, open, high, low, close, vol }
        const klines = res.data.map(k => ({
          t: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          vol: parseFloat(k[5])
        }));
        writeCache(symbol, klines);
        return { data: klines, source: url };
      }
    } catch (e) {
      console.warn("Binance source failed:", url, e.message);
      // try next
    }
  }

  // Fallback: CoinGecko (historical market chart)
  try {
    // CoinGecko uses ids and vs_currency; mapping BTCUSDT -> bitcoin/usd
    const id = symbol.toUpperCase().startsWith("BTC") ? "bitcoin" : null;
    if (id) {
      const url = `${fallback.COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=1&interval=hourly`;
      const r = await axios.get(url, { timeout: 7000 });
      if (r.data && r.data.prices) {
        // build klines rough from price points
        const prices = r.data.prices; // [ [ts, price], ... ]
        const klines = prices.map((p, i) => ({
          t: p[0],
          open: p[1],
          high: p[1],
          low: p[1],
          close: p[1],
          vol: 0
        }));
        writeCache(symbol, klines);
        return { data: klines, source: "coingecko" };
      }
    }
  } catch (e) { console.warn("CoinGecko fallback failed", e.message); }

  // KuCoin / Yahoo simple fallback tries (best-effort)
  try {
    const url = `${fallback.KUCOIN}/api/v1/market/candles?symbol=${symbol}&type=1min&limit=${limit}`;
    const r = await axios.get(url, { timeout: 7000 });
    if (r.data && r.data.data) {
      const klines = r.data.data.map(k => ({
        t: parseInt(k[0]) * 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        vol: parseFloat(k[5])
      }));
      writeCache(symbol, klines);
      return { data: klines, source: "kucoin" };
    }
  } catch (e) { console.warn("KuCoin fallback failed", e.message); }

  // Last resort: read cache
  const cache = readCache();
  if (cache[symbol] && (Date.now() - cache[symbol].ts) < CONFIG.CACHE_RETENTION_MS) {
    console.log("Using cached market data");
    return { data: cache[symbol].data, source: "cache" };
  }

  // nothing
  return { data: [], source: "none" };
}