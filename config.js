// config.js — FINAL FULLY COMPATIBLE WITH utils.js

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  ACTIVE_MARKET: "CRYPTO",
  ACTIVE_SYMBOL: "BTCUSDT",

  // ================= SYMBOL MAP (ALL 100% FIXED) =================
  SYMBOLS: {
    CRYPTO: {
      BTCUSDT: { binance: "BTCUSDT", yahoo: "BTC-USD" },
      ETHUSDT: { binance: "ETHUSDT", yahoo: "ETH-USD" },
      BNBUSDT: { binance: "BNBUSDT", yahoo: "BNB-USD" },
      SOLUSDT: { binance: "SOLUSDT", yahoo: "SOL-USD" }
    },

    INDIA: {
      NIFTY50: { yahoo: "^NSEI" },
      BANKNIFTY: { yahoo: "^NSEBANK" },
      RELIANCE: { yahoo: "RELIANCE.NS" },
      TCS: { yahoo: "TCS.NS" }
    },

    FOREX: {
      EURUSD: { yahoo: "EURUSD=X" },
      GBPUSD: { yahoo: "GBPUSD=X" },
      USDJPY: { yahoo: "JPY=X" },
      AUDUSD: { yahoo: "AUDUSD=X" }
    },

    COMMODITIES: {
      GOLD: { yahoo: "GC=F" },
      SILVER: { yahoo: "SI=F" },
      CRUDEOIL: { yahoo: "CL=F" },
      NATGAS: { yahoo: "NG=F" }
    }
  },

  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    COMMODITIES: "GOLD"
  },

  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  DEFAULT_LIMIT: 500,

  // ================= API SOURCES =================
  API: {
    BINANCE: [
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://data-api.binance.vision"
    ],

    YAHOO: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart",
      "https://query3.finance.yahoo.com/v8/finance/chart"
    ]
  },

  PATHS: { CACHE_DIR },

  PROXY:
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.PROXY ||
    null,

  FALLBACK: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 400,
    ALWAYS_SYNTHETIC_IF_ALL_FAIL: true
  },

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || "",
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID)
  },

  REPORT_INTERVAL_MS: 10 * 60 * 1000
};

export default CONFIG;