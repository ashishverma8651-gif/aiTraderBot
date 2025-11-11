// config.js
import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m","5m","15m","30m","1h"],
  SELF_PING_URL: process.env.SELF_PING_URL || "",
  CACHE_FILE: path.join(CACHE_DIR, "marketData.json"),
  BINANCE_SOURCES: [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com"
  ],
  FALLBACK_SOURCES: {
    COINGECKO: "https://api.coingecko.com/api/v3",
    KUCOIN: "https://api.kucoin.com",
    YAHOO: "https://query1.finance.yahoo.com"
  },
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || ""
  },
  REPORT_INTERVAL_MS: (parseInt(process.env.REPORT_INTERVAL_MIN || "15") || 15) * 60 * 1000,
  CACHE_RETENTION_MS: 24 * 60 * 60 * 1000 // 1 day
};

export default CONFIG;