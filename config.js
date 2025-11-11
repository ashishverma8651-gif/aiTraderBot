// config.js
import axios from "axios";
import fs from "fs";

const CONFIG = {
  SYMBOL: "BTCUSDT",
  SELF_PING_URL: process.env.SELF_PING_URL || "https://your-render-url.onrender.com",
  CACHE_FILE: "./cache/marketData.json",
  MARKETS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    FOREX: ["USDINR", "EURINR", "GBPUSD"],
    INDIAN: ["NIFTY", "SENSEX", "RELIANCE.NS"],
    METALS: ["GOLD", "SILVER"]
  }
};

// ✅ Binance main + alternates
let BINANCE_SOURCES = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com"
];

let FALLBACK_SOURCES = {
  COINGECKO: "https://api.coingecko.com/api/v3",
  KUCOIN: "https://api.kucoin.com",
  YAHOO: "https://query1.finance.yahoo.com"
};

// Utility for rotating APIs if one fails
function rotateSource(list) {
  const failed = list.shift();
  list.push(failed);
  return list;
}

// Save data locally for 24h caching
function saveCache(data) {
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      data
    }, null, 2));
  } catch (err) {
    console.warn("⚠️ Cache write failed:", err.message);
  }
}

// Load cache if API fails
function loadCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
    if (Date.now() - cache.timestamp < 24 * 60 * 60 * 1000) {
      return cache.data;
    }
  } catch (e) {}
  return [];
}

// 🧠 Smart Multi-Source Market Fetcher
export async function fetchMarketData(symbol = CONFIG.SYMBOL) {
  let data = null;

  // --- 1️⃣ Try Binance multi-API
  for (let base of BINANCE_SOURCES) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=1m&limit=500`;
      const res = await axios.get(url);
      if (res.data && Array.isArray(res.data)) {
        data = res.data.map(c => ({
          time: c[0],
          open: +c[1],
          high: +c[2],
          low: +c[3],
          close: +c[4],
          volume: +c[5]
        }));
        saveCache(data);
        return data;
      }
    } catch (err) {
      console.warn(`⚠️ Binance ${base} failed:`, err.response?.status || err.message);
      BINANCE_SOURCES = rotateSource(BINANCE_SOURCES);
    }
  }

  // --- 2️⃣ Try CoinGecko
  try {
    const cgUrl = `${FALLBACK_SOURCES.COINGECKO}/coins/bitcoin/ohlc?vs_currency=usd&days=1`;
    const res = await axios.get(cgUrl);
    data = res.data.map(c => ({
      time: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: 0
    }));
    saveCache(data);
    return data;
  } catch (err) {
    console.warn("⚠️ CoinGecko fallback failed:", err.response?.status || err.message);
  }

  // --- 3️⃣ Try KuCoin
  try {
    const kuUrl = `${FALLBACK_SOURCES.KUCOIN}/api/v1/market/candles?type=1min&symbol=${symbol.replace("USDT","-USDT")}`;
    const res = await axios.get(kuUrl);
    data = res.data.data.map(c => ({
      time: +c[0] * 1000,
      open: +c[1],
      close: +c[2],
      high: +c[3],
      low: +c[4],
      volume: +c[5]
    }));
    saveCache(data);
    return data;
  } catch (err) {
    console.warn("⚠️ KuCoin fallback failed:", err.response?.status || err.message);
  }

  // --- 4️⃣ Try Yahoo Finance (multi-market)
  try {
    const yUrl = `${FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    const res = await axios.get(yUrl);
    const result = res.data.chart?.result?.[0];
    data = result.timestamp.map((t, i) => ({
      time: t * 1000,
      open: result.indicators.quote[0].open[i],
      high: result.indicators.quote[0].high[i],
      low: result.indicators.quote[0].low[i],
      close: result.indicators.quote[0].close[i],
      volume: result.indicators.quote[0].volume[i]
    }));
    saveCache(data);
    return data;
  } catch (err) {
    console.warn("⚠️ Yahoo fallback failed:", err.response?.status || err.message);
  }

  // --- 5️⃣ Use cache if all sources fail
  const cached = loadCache();
  if (cached.length) {
    console.log("💾 Loaded data from cache (24h)");
    return cached;
  }

  throw new Error("❌ All data sources failed");
}

export default CONFIG;