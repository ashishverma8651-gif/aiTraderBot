// config.js — unified settings for AI Trader
import fs from "fs";
import path from "path";

// ensure cache folder exists
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const ENV = process.env.NODE_ENV || "production";

export const CONFIG = {
  MODE: ENV,

  // Trading symbol (BTC auto-report)
  SYMBOL: process.env.SYMBOL || "BTCUSDT",

  // Timeframes used across all modules
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],

  // Candle history limit
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 200),

  // Auto-report interval (default: 15m)
  REPORT_INTERVAL_MS: Number(
    process.env.REPORT_INTERVAL_MS || 15 * 60 * 1000
  ),

  // =====================================================
  // PRICE + CANDLE FETCHING ENDPOINTS  (ORIGINAL)
  // =====================================================
  DATA_SOURCES: {
    BINANCE: [
      "https://data-api.binance.vision",
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com"
    ],
    BYBIT: ["https://api.bybit.com", "https://api.bytick.com"],
    KUCOIN: ["https://api.kucoin.com"],
    COINBASE: ["https://api.exchange.coinbase.com"],

    // ⭐ ADDED (no original key touched)
    NSE: ["https://www.nseindia.com/api"],
    YAHOO: ["https://query1.finance.yahoo.com/v8/finance/chart"]
  },

  // =====================================================
  // WEBSOCKET MIRRORS (live price)
  // =====================================================
  WS_MIRRORS: [
    "wss://stream.binance.com:9443/ws",
    "wss://data-stream.binance.vision/ws"
  ],

  // Optional proxy
  PROXY:
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    null,

  // =====================================================
  // TELEGRAM BOT
  // =====================================================
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null
  },

  // =====================================================
  // KEEP-ALIVE PING (Render/Hosting)
  // =====================================================
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  // =====================================================
  // ⭐ ADDED: MULTI-MARKET SUPPORT (safe extensions)
  // =====================================================
  MARKETS: {
    CRYPTO: {
      ENABLED: true,
      DEFAULT: "BTCUSDT"
    },
    INDIA: {
  ENABLED: true,
  INDEXES: ["NIFTY50", "BANKNIFTY", "FINNIFTY", "SENSEX"]
    },
    STOCKS: {
      ENABLED: true
    },
    FOREX: {
      ENABLED: true
    }
  },

  PATHS: {
    CACHE_DIR
  }
};

export default CONFIG;