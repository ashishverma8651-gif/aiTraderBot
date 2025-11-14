// config.js — central settings
import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const ENV = process.env.NODE_ENV || "production";

export const CONFIG = {
  MODE: ENV,
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m","5m","15m","30m","1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 200),
  REPORT_INTERVAL_MS: Number(process.env.REPORT_INTERVAL_MS || 15 * 60 * 1000),

  // Multi-source endpoints (priority order)
  DATA_SOURCES: {
    BINANCE: [
      "https://data-api.binance.vision",
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com"
    ],
    BYBIT: ["https://api.bytick.com", "https://api.bybit.com"],
    KUCOIN: ["https://api.kucoin.com"],
    COINBASE: ["https://api.exchange.coinbase.com"]
  },

  // WebSocket mirrors (for price tick)
  WS_MIRRORS: [
    "wss://data-stream.binance.vision/ws",
    "wss://stream.binance.com:9443/ws"
  ],

  // Optional HTTP proxy (set to null or full proxy object for axios)
  PROXY: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null,

  // Telegram
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null
  },

  // Keep-alive
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  PATHS: {
    CACHE_DIR
  }
};

export default CONFIG;