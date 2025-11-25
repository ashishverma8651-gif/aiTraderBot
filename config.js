// config.js — final lightweight config for multi-market bot
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const CONFIG = {
  MODE: process.env.NODE_ENV || "production",
  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO",
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  SYMBOLS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    INDIA: ["NIFTY50", "BANKNIFTY", "RELIANCE", "TCS"],
    FOREX: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"],
    COMMODITY: ["GOLD", "SILVER", "CRUDEOIL", "NATGAS"]
  },

  // default pick per market
  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    COMMODITY: "GOLD"
  },

  // data source priorities (used by utils)
  DATA_SOURCES_BY_MARKET: {
    CRYPTO: ["https://api.binance.com", "https://data-api.binance.vision"],
    INDIA: ["https://query1.finance.yahoo.com/v8/finance/chart"],
    FOREX: ["https://query1.finance.yahoo.com/v8/finance/chart", "https://api.exchangerate.host"],
    COMMODITY: ["https://query1.finance.yahoo.com/v8/finance/chart"]
  },

  // Yahoo mappings for indices/commodities/forex
  YAHOO_MAP: {
    NIFTY50: "^NSEI",
    BANKNIFTY: "^NSEBANK",
    RELIANCE: "RELIANCE.NS",
    TCS: "TCS.NS",
    GOLD: "GC=F",
    SILVER: "SI=F",
    CRUDEOIL: "CL=F",
    NATGAS: "NG=F",
    EURUSD: "EURUSD=X",
    GBPUSD: "GBPUSD=X",
    USDJPY: "JPY=X",
    AUDUSD: "AUDUSD=X"
  },

  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 300),

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null
  },

  FALLBACK: {
    MAX_RETRIES: Number(process.env.FALLBACK_MAX_RETRIES || 3),
    RETRY_DELAY_MS: Number(process.env.FALLBACK_RETRY_DELAY_MS || 600)
  },

  PATHS: { CACHE_DIR }
};

export default CONFIG;