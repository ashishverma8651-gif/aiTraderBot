// config.js — HEAVY CONFIG (final)
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  // Active market/symbol (can be changed by bot panel)
  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO",
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  // Symbol maps (used by utils to route to correct external source)
  SYMBOLS: {
    CRYPTO: {
      BTCUSDT: { binance: "BTCUSDT", yahoo: "BTC-USD", tv: "BINANCE:BTCUSDT" },
      ETHUSDT: { binance: "ETHUSDT", yahoo: "ETH-USD", tv: "BINANCE:ETHUSDT" },
      SOLUSDT: { binance: "SOLUSDT", yahoo: "SOL-USD", tv: "BINANCE:SOLUSDT" },
      XRPUSDT: { binance: "XRPUSDT", yahoo: "XRP-USD", tv: "BINANCE:XRPUSDT" }
    },
    INDIA: {
      NIFTY50: { tv: "NSE:NIFTY", yahoo: "^NSEI" },
      BANKNIFTY: { tv: "NSE:BANKNIFTY", yahoo: "^NSEBANK" },
      RELIANCE: { tv: "NSE:RELIANCE", yahoo: "RELI.NS" },
      TCS: { tv: "NSE:TCS", yahoo: "TCS.NS" }
    },
    FOREX: {
      EURUSD: { yahoo: "EURUSD=X" },
      GBPUSD: { yahoo: "GBPUSD=X" },
      USDJPY: { yahoo: "JPY=X" },
      XAUUSD: { yahoo: "GC=F" } // gold as forex/commodity pair
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

  INTERVALS: ["1m","5m","15m","30m","1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 500),

  // API endpoints / mirrors you can modify to add more mirrors
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
    ],
    EXCHANGERATE: "https://api.exchangerate.host",
    FMP: "https://financialmodelingprep.com/api/v3"
  },

  // Fallback / caching
  FALLBACK: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 500,
    ALWAYS_SYNTHETIC_IF_ALL_FAIL: true
  },

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null,
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID)
  },

  PATHS: { CACHE_DIR }
};

export default CONFIG;