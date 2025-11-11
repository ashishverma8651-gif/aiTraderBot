// config.js
import fs from "fs";
import path from "path";

// Make sure cache folder exists
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  // ===== Core Settings =====
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  SELF_PING_URL: process.env.SELF_PING_URL || "https://aitraderbot.onrender.com/",
  CACHE_FILE: path.join(CACHE_DIR, "marketData.json"),

  // ===== Market Categories =====
  MARKETS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    INDIAN: ["NIFTY", "SENSEX", "RELIANCE.NS"],
    METALS: ["GOLD", "SILVER"]
  },

  // ===== Binance Main + Mirrors =====
  BINANCE_SOURCES: [
    "https://data-api.binance.vision", // ✅ Reliable global public API
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com"
  ],

  // ===== Fallback APIs =====
  FALLBACK_SOURCES: {
    COINGECKO: "https://api.coingecko.com/api/v3",
    COINGLASS: "https://open-api.coinglass.com/api/pro/v1",
    KUCOIN: "https://api.kucoin.com",
    YAHOO: "https://query1.finance.yahoo.com"
  },

  // ===== Telegram Bot =====
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || ""
  },

  // ===== Report Timing =====
  REPORT_INTERVAL_MS:
    (parseInt(process.env.REPORT_INTERVAL_MIN || "15") || 15) * 60 * 1000,

  // ===== Cache Retention =====
  CACHE_RETENTION_MS: 24 * 60 * 60 * 1000 // 1 day
};

export default CONFIG;