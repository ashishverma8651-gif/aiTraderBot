// config.js — FIXED MULTI-SOURCE CONFIG

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO",
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  // SYMBOL MAPS — FIXED
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
      RELIANCE: { yahoo: "RELI.NS" },
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

  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],

  // FIXED — utils.js SE MATCHED NAMES
  API: {
    BINANCE_URLS: [
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://data-api.binance.vision"
    ],

    YAHOO_URLS: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart"
    ],

    TV_PROXY: [
      "https://tvc4.forexfeed.net",
      "https://tvc5.forexfeed.net"
    ]
  },

  PATHS: { CACHE_DIR }
};

export default CONFIG;