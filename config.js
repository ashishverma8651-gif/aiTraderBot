// ===============================
//  AI Trader - Multi-Market Config (FINAL FIXED)
//  Supports: Crypto / India / Forex / US Stocks / Commodities
// ===============================

import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  // ---------------------------------
  // MARKET SELECTION
  // ---------------------------------
  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO", 
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  // ---------------------------------
  // CORRECTED MULTI-MARKET SYMBOL SETS
  // ---------------------------------
  SYMBOLS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],

    // 🔥 FIXED — Yahoo requires correct mapped symbols
    INDIA: {
      NIFTY50: "^NSEI",
      BANKNIFTY: "^NSEBANK",
      FINNIFTY: "^CNXFIN",
      SENSEX: "^BSESN",
      RELIANCE: "RELIANCE.NS",
      TCS: "TCS.NS"
    },

    FOREX: {
      EURUSD: "EURUSD=X",
      GBPUSD: "GBPUSD=X",
      USDJPY: "JPY=X",
      AUDUSD: "AUDUSD=X"
    },

    US_STOCKS: {
      AAPL: "AAPL",
      TSLA: "TSLA",
      NVDA: "NVDA",
      MSFT: "MSFT",
      AMZN: "AMZN"
    },

    // 🔥 Added COMMODITIES
    COMMODITIES: {
      GOLD: "GC=F",
      SILVER: "SI=F",
      CRUDEOIL: "CL=F",
      NATGAS: "NG=F"
    }
  },

  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    US_STOCKS: "AAPL",
    COMMODITIES: "GOLD"
  },

  // ---------------------------------
  // TIMEFRAMES
  // ---------------------------------
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 200),

  // ---------------------------------
  // AUTO REPORTING
  // ---------------------------------
  REPORT_INTERVAL_MS: Number(process.env.REPORT_INTERVAL_MS || 15 * 60 * 1000),

  // =====================================================
  // MULTI-SOURCE FETCHERS (Correct Priority)
  // =====================================================
  DATA_SOURCES_BY_MARKET: {
    CRYPTO: [
      "https://api.binance.com",
      "https://data-api.binance.vision",
      "https://api1.binance.com",
      "https://api2.binance.com"
    ],

    INDIA: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart"
    ],

    FOREX: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://api.exchangerate.host"
    ],

    US_STOCKS: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://financialmodelingprep.com/api/v3"
    ],

    COMMODITIES: [
      "https://query1.finance.yahoo.com/v8/finance/chart"
    ]
  },

  // ---------------------------------
  // NSE HEADERS (if used later)
  // ---------------------------------
  NSE_HEADERS: {
    "User-Agent": "Mozilla/5.0",
    Accept: "*/*",
    Referer: "https://www.nseindia.com/"
  },

  // ---------------------------------
  // PROXY SUPPORT
  // ---------------------------------
  PROXY:
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.PROXY ||
    null,

  // =====================================================
  // TELEGRAM BOT
  // =====================================================
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null,
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID)
  },

  // =====================================================
  // FALLBACK SETTINGS
  // =====================================================
  FALLBACK: {
    MAX_RETRIES: 4,
    RETRY_DELAY_MS: 500,
    SWITCH_SOURCE_AFTER_FAIL: true,
    SWITCH_MARKET_IF_ALL_FAIL: false
  },

  // =====================================================
  // Keep Alive
  // =====================================================
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  PATHS: { CACHE_DIR }
};

export default CONFIG;