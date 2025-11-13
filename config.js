// ===============================
// 📁 config.js — AI Trader v11.0
// Multi-Market + WebSocket + Multi-Source + AI Integration + Auto-Failover
// ===============================
import fs from "fs";
import path from "path";

// ===============================
// 🗂️ Cache Directory Setup
// ===============================
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ===============================
// ⚙️ Environment Mode Detection
// ===============================
const ENV = process.env.NODE_ENV || "development";
const IS_PROD = ENV === "production";
const IS_DEV = ENV === "development";

// ===============================
// 🧩 CONFIG OBJECT
// ===============================
export const CONFIG = {
  VERSION: "v11.0",
  MODE: ENV,
  IS_PROD,
  IS_DEV,

  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],

  // ===============================
  // 🌐 Ping & Keep-Alive URLs
  // ===============================
  

SERVER: {
  PORT: process.env.PORT || 10000,
  KEEP_ALIVE: true,
  KEEP_ALIVE_URLS: [
    "https://aitraderbot.onrender.com" // your Render URL
  ]
}


  // ===============================
  // 🗂️ Cache & Model Paths
  // ===============================
  PATHS: {
    CACHE_DIR,
    CACHE_FILE: path.join(CACHE_DIR, "marketData.json"),
    MODEL_FILE: path.join(CACHE_DIR, "ml_model.json"),
    METRICS_FILE: path.join(CACHE_DIR, "ml_metrics.json"),
    ERROR_LOG_FILE: path.join(CACHE_DIR, "error.log"),
  },

  // ===============================
  // 💱 Market Categories
  // ===============================
  MARKETS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    INDIAN: ["NIFTY", "BANKNIFTY", "RELIANCE.NS", "TCS.NS"],
    METALS: ["GOLD", "SILVER"],
  },

  // ===============================
  // 🌐 Market Data Sources + WebSocket
  // ===============================
  DATA_SOURCES: {
    CRYPTO: {
      PRIMARY: [
        "https://data-api.binance.vision",
        "https://api.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
        "https://api3.binance.com",
      ],
      FALLBACKS: {
        COINGECKO: "https://api.coingecko.com/api/v3",
        KUCOIN: "https://api.kucoin.com",
        COINBASE: "https://api.exchange.coinbase.com",
      },
      SOCKETS: {
        MAIN: "wss://stream.binance.com:9443/ws",
        BACKUP: "wss://data-stream.binance.vision/ws",
        ENABLED: true,
        AUTO_RECONNECT: true,
        RECONNECT_DELAY_MS: 10000,
        SOCKET_TIMEOUT_MS: 15000, // ✅ added timeout detection
        FALLBACK_HTTP: true,
      },
    },

    INDIAN: {
      PRIMARY: [
        "https://www.nseindia.com",
        "https://nse-api.vercel.app",
        "https://api1.nseindia.com",
      ],
      FALLBACKS: {
        YAHOO: "https://query1.finance.yahoo.com",
        ECONOMICTIMES: "https://economictimes.indiatimes.com/markets/api",
        MONEYCONTROL: "https://priceapi.moneycontrol.com",
      },
    },

    METALS: {
      PRIMARY: [
        "https://query1.finance.yahoo.com",
        "https://query2.finance.yahoo.com",
      ],
      FALLBACKS: {
        INVESTING: "https://api.investing.com/api/financialdata",
        KITCO: "https://www.kitco.com/market",
      },
    },
  },

  // ===============================
  // 🧠 ML + Elliott Configuration
  // ===============================
  ML: {
    ENABLED: true,
    MODULE_PATH: "./ml_module_v8_6.js",
    LOOKBACK: 500,
    LEARNING_RATE: 0.02,
    EPOCHS: 25,
    SAVE_MODEL: true,
    AUTO_RETRAIN_HOURS: 12, // ✅ retrain automatically
  },

  ELLIOTT: {
    ENABLED: true,
    MAX_PIVOTS: 12,
    FIB_RATIOS: [0.236, 0.382, 0.5, 0.618, 0.786],
    CHANNEL_SLOPE_SENSITIVITY: 1.25,
  },

  // ===============================
  // 🕒 Scheduler / Cache
  // ===============================
  TIMERS: {
    REPORT_INTERVAL_MIN: parseInt(process.env.REPORT_INTERVAL_MIN || "15"),
    CACHE_RETENTION_MS: 24 * 60 * 60 * 1000, // 1 day
    DATA_REFRESH_INTERVAL_MS: 10000, // ✅ live ticker interval
    CLEANUP_INTERVAL_HOURS: 6, // ✅ clears stale cache periodically
  },

  // ===============================
  // 📡 Telegram Bot
  // ===============================
  TELEGRAM: {
    ENABLED: !!process.env.BOT_TOKEN,
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null,
    ADMIN_ONLY: true,
  },

  // ===============================
  // 🌍 Server + Keep Alive
  // ===============================
  SERVER: {
    PORT: process.env.PORT || 10000,
    KEEP_ALIVE: true,
    SOCKET_LOG: process.env.SOCKET_LOG === "true" || IS_DEV,
    ENABLE_EXPRESS: true,
    ENABLE_PING: true,
  },

  // ===============================
  // 🧾 Logging & Diagnostics
  // ===============================
  LOGGING: {
    LEVEL: process.env.LOG_LEVEL || (IS_DEV ? "debug" : "info"),
    SAVE_ERRORS: true,
    SAVE_TICKS: false,
    MAX_LOG_SIZE_KB: 5120, // 5MB per file
  },
};

export default CONFIG;

// ===============================
// 💡 Enhancement Summary
// ===============================
// ✅ Added MODE detection (prod/dev)
// ✅ Added SOCKET_TIMEOUT_MS for faster WS recovery
// ✅ Added TIMERS + cleanup intervals
// ✅ Added logging configuration & file paths
// ✅ Added auto-ML retraining option
// ✅ Added flexibility for enabling/disabling features per env
// ✅ Backward compatible with your v10.0 structure