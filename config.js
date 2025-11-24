// ===============================
//  AI Trader - Multi-Market Config
//  Lightweight REST + Multi-Source Fallback
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
  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO", // CRYPTO / INDIA / FOREX / US_STOCKS
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT", // Market-wise overridden

  // ---------------------------------
  // MULTI-MARKET SYMBOL SETS
  // ---------------------------------
  SYMBOLS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"],
    INDIA: ["NIFTY50", "BANKNIFTY", "FINNIFTY", "SENSEX", "RELIANCE", "TCS"],
    FOREX: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"],
    US_STOCKS: ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN"]
  },

  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    US_STOCKS: "AAPL"
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
  // MULTI-SOURCE FALLBACK PRICE FETCHING (NO WS)
  // =====================================================
  DATA_SOURCES_BY_MARKET: {
    CRYPTO: [
      "https://data-api.binance.vision",
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com"
    ],

    INDIA: [
      "https://www.nseindia.com/api",
      "https://query1.finance.yahoo.com/v8/finance/chart"
    ],

    FOREX: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://api.exchangerate.host"
    ],

    US_STOCKS: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://api.financialmodelingprep.com/api/v3"
    ]
  },

  // ---------------------------------
  // NSE SPECIAL HEADERS
  // ---------------------------------
  NSE_HEADERS: {
    "User-Agent": "Mozilla/5.0",
    Accept: "*/*",
    Referer: "https://www.nseindia.com/"
  },

  // ---------------------------------
  // PROXY SUPPORT (Auto)
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
    MAX_RETRIES: 4,             // 4 retries per source
    RETRY_DELAY_MS: 500,        // 0.5s delay between tries
    SWITCH_SOURCE_AFTER_FAIL: true,
    SWITCH_MARKET_IF_ALL_FAIL: false // rare but optional
  },

  // =====================================================
  // KEEP-ALIVE PING FOR RENDER
  // =====================================================
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  PATHS: { CACHE_DIR }
};

export default CONFIG;