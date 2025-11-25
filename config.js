// config.js
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  ACTIVE_MARKET: "CRYPTO",
  ACTIVE_SYMBOL: "BTCUSDT",

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

  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    COMMODITIES: "GOLD"
  },

  // Free and fast mirror APIs
  API: {
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

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || ""
  }
};

export default CONFIG;