// config.js — Multi-Market + Real NSE + Binance + Yahoo + Fallback

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO",
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  MARKETS: ["CRYPTO", "INDIA", "FOREX", "COMMODITIES"],

  SYMBOLS: {
    CRYPTO: {
      BTCUSDT: { binance: "BTCUSDT", yahoo: "BTC-USD" },
      ETHUSDT: { binance: "ETHUSDT", yahoo: "ETH-USD" },
      BNBUSDT: { binance: "BNBUSDT", yahoo: "BNB-USD" },
      SOLUSDT: { binance: "SOLUSDT", yahoo: "SOL-USD" }
    },

    // REAL NSE LIVE
    INDIA: {
      NIFTY50: { nse: "NIFTY 50" },
      BANKNIFTY: { nse: "NIFTY BANK" },
      RELIANCE: { nse: "RELIANCE" },
      TCS: { nse: "TCS" }
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

  API: {
    NSE: "https://www.nseindia.com",
    NSE_QUOTE: "https://www.nseindia.com/api/quote-equity?symbol=",
    NSE_INDEX: "https://www.nseindia.com/api/quote-index?index=",

    BINANCE: [
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://data-api.binance.vision"
    ],

    YAHOO: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart"
    ]
  },

  PATHS: { CACHE_DIR },

  FALLBACK: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 400,
    ALWAYS_SYNTHETIC_IF_ALL_FAIL: true
  },

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || "",
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID)
  }
};

export default CONFIG;