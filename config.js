// ===============================
// 📁 config.js — AI Trader v10.0 (Multi-Market + Multi-Source)
// ===============================
import fs from "fs";
import path from "path";

// Ensure cache directory exists
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ===============================
// 🧩 CONFIG OBJECT
// ===============================
export const CONFIG = {
  VERSION: "v10.0",
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],

  SELF_PING_URL:
  process.env.SELF_PING_URL ||
  "https://aitraderbot.onrender.com/ping" || // direct self
  "https://web-production-f70a.up.railway.app/ping?url=https://aitraderbot.onrender.com",

  // File Paths
  CACHE_FILE: path.join(CACHE_DIR, "marketData.json"),
  MODEL_FILE: path.join(CACHE_DIR, "ml_model.json"),
  METRICS_FILE: path.join(CACHE_DIR, "ml_metrics.json"),

  // =========================
  // 💱 Market Categories
  // =========================
  MARKETS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    INDIAN: ["NIFTY", "BANKNIFTY", "RELIANCE.NS", "TCS.NS"],
    METALS: ["GOLD", "SILVER"]
  },

  // =========================
  // 🌐 Market Data Sources
  // =========================

  // 🔹 Crypto Market (Binance + Mirrors + Fallbacks)
  CRYPTO_SOURCES: {
    PRIMARY: [
      "https://data-api.binance.vision", // official mirror
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com"
    ],
    FALLBACKS: {
      COINGECKO: "https://api.coingecko.com/api/v3",
      KUCOIN: "https://api.kucoin.com",
      COINBASE: "https://api.exchange.coinbase.com"
    }
  },

  // 🔹 Indian Market (NSE + Yahoo + Backup)
  INDIAN_SOURCES: {
    PRIMARY: [
      "https://www.nseindia.com",
      "https://nse-api.vercel.app",
      "https://api1.nseindia.com"
    ],
    FALLBACKS: {
      YAHOO: "https://query1.finance.yahoo.com",
      ECONOMICTIMES: "https://economictimes.indiatimes.com/markets/api",
      MONEYCONTROL: "https://priceapi.moneycontrol.com"
    }
  },

  // 🔹 Metals Market (Yahoo + Investing + Backup)
  METAL_SOURCES: {
    PRIMARY: [
      "https://query1.finance.yahoo.com",
      "https://query2.finance.yahoo.com"
    ],
    FALLBACKS: {
      INVESTING: "https://api.investing.com/api/financialdata",
      KITCO: "https://www.kitco.com/market"
    }
  },

  // =========================
  // 🤖 ML + Elliott Config
  // =========================
  ML: {
    ENABLED: true,
    MODULE_PATH: "./ml_module_v8_6.js",
    LOOKBACK: 500,
    LEARNING_RATE: 0.02,
    EPOCHS: 25
  },

  ELLIOTT: {
    ENABLED: true,
    MAX_PIVOTS: 12,
    FIB_RATIOS: [0.236, 0.382, 0.5, 0.618, 0.786],
    CHANNEL_SLOPE_SENSITIVITY: 1.25
  },

  // =========================
  // 🕒 Timers
  // =========================
  REPORT_INTERVAL_MIN: parseInt(process.env.REPORT_INTERVAL_MIN || "15"),
  REPORT_INTERVAL_MS:
    (parseInt(process.env.REPORT_INTERVAL_MIN || "15") || 15) * 60 * 1000,
  CACHE_RETENTION_MS: 24 * 60 * 60 * 1000, // 1 day

  // =========================
// 📡 Telegram Bot
// =========================
TELEGRAM: {
  BOT_TOKEN: process.env.BOT_TOKEN || null,
  CHAT_ID: process.env.CHAT_ID || null,
},

};

export default CONFIG;