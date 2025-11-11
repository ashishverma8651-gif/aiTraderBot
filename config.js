// ================== CONFIGURATION & DATA FETCH CENTER ==================
import axios from "axios";

// ----- System & Bot Configuration -----
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  SELF_URL: process.env.RENDER_EXTERNAL_URL || "https://your-app.onrender.com",

  // ---- Multi-source API Endpoints ----
  CRYPTO_SOURCES: [
    "https://api.binance.com/api/v3/klines",
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.exchange.coinbase.com/products",
    "https://api.coingecko.com/api/v3"
  ],

  INDIAN_MARKET_SOURCES: [
    "https://priceapi.moneycontrol.com",
    "https://api.nseindia.com/api",
    "https://api.bseindia.com",
    "https://api.tickertape.in"
  ],

  METAL_SOURCES: [
    "https://metals-api.com/api/latest",
    "https://api.goldapi.io/v1/latest",
    "https://commodities-api.com/api/latest"
  ],
};

// ================== MULTI-SOURCE FETCH FUNCTION ==================
async function fetchMarketData(symbol = CONFIG.SYMBOL, type = "crypto", interval = "15m", limit = 80) {
  // --- CRYPTO DATA FETCH ---
  if (type === "crypto") {
    for (const base of CONFIG.CRYPTO_SOURCES) {
      try {
        if (base.includes("binance")) {
          const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
          const res = await axios.get(url, { timeout: 8000 });
          if (Array.isArray(res.data)) {
            return res.data.map(k => ({
              open: +k[1],
              high: +k[2],
              low: +k[3],
              close: +k[4],
              volume: +k[5],
              source: "Binance"
            }));
          }
        }
        if (base.includes("coinbase")) {
          const coin = symbol.replace("USDT", "-USD");
          const url = `${base}/${coin}/candles?granularity=900`;
          const res = await axios.get(url, { timeout: 8000 });
          if (Array.isArray(res.data)) {
            const sorted = res.data.sort((a, b) => a[0] - b[0]);
            return sorted.map(k => ({
              time: k[0] * 1000,
              low: +k[1],
              high: +k[2],
              open: +k[3],
              close: +k[4],
              volume: +k[5],
              source: "Coinbase"
            }));
          }
        }
        if (base.includes("coingecko")) {
          const id = symbol.startsWith("BTC") ? "bitcoin" : "ethereum";
          const url = `${base}/coins/${id}/ohlc?vs_currency=usd&days=1`;
          const res = await axios.get(url, { timeout: 8000 });
          if (Array.isArray(res.data)) {
            return res.data.map(k => ({
              time: +k[0],
              open: +k[1],
              high: +k[2],
              low: +k[3],
              close: +k[4],
              source: "CoinGecko"
            }));
          }
        }
      } catch (err) {
        console.warn(`⚠️ Crypto source failed (${base}): ${err.message}`);
      }
    }
  }

  // --- INDIAN MARKET DATA ---
  if (type === "indian") {
    for (const base of CONFIG.INDIAN_MARKET_SOURCES) {
      try {
        const res = await axios.get(`${base}/market/indices`, { timeout: 8000 });
        if (res.data) return res.data;
      } catch (err) {
        console.warn(`⚠️ Indian source failed (${base}): ${err.message}`);
      }
    }
  }

  // --- METALS DATA ---
  if (type === "metal") {
    for (const base of CONFIG.METAL_SOURCES) {
      try {
        const res = await axios.get(`${base}?access_key=YOUR_API_KEY`, { timeout: 8000 });
        if (res.data?.rates) return res.data.rates;
      } catch (err) {
        console.warn(`⚠️ Metal source failed (${base}): ${err.message}`);
      }
    }
  }

  console.error(`❌ All sources failed for ${type}`);
  return [];
}

// ================== EXPORTS ==================
export { CONFIG, fetchMarketData };
export default CONFIG;