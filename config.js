// ===== CONFIGURATION MODULE =====
// 📦 Handles environment setup, multi-market logic, and feature toggles.

import dotenv from "dotenv";
dotenv.config();

/*  
========================================
🧩 ENV FILE TEMPLATE (Paste in your .env)
========================================
BOT_TOKEN=123456789:ABC-your-bot-token
CHAT_ID=987654321
RENDER_EXTERNAL_URL=https://aiTraderBot.onrender.com
PORT=3000
SYMBOL=BTCUSDT
INTERVAL=15m
TIMEZONE=Asia/Kolkata
DATA_REFRESH=900000
========================================
*/

// ====== MAIN CONFIGURATION ======
export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  SELF_PING_URL: process.env.RENDER_EXTERNAL_URL || "",
  SERVER_PORT: process.env.PORT || 3000,
  DEFAULT_SYMBOL: process.env.SYMBOL || "BTCUSDT",
  DEFAULT_INTERVAL: process.env.INTERVAL || "15m",
  TIMEZONE: process.env.TIMEZONE || "Asia/Kolkata",
  DATA_REFRESH: process.env.DATA_REFRESH || 900000, // 15m
};

// ====== MULTI-MARKET SETTINGS ======
export const MARKET_CONFIG = {
  crypto: {
    defaultPair: "BTCUSDT",
    backupPair: "ETHUSDT",
    currency: "USD",
    source: "Binance",
  },
  indian: {
    defaultPair: "GOLD1!",
    backupPair: "BANKNIFTY",
    currency: "INR",
    source: "NSE",
  },
  forex: {
    defaultPair: "USDINR",
    backupPair: "EURINR",
    currency: "INR",
    source: "FXCM",
  },
};

// ====== FEATURE TOGGLES ======
export const FEATURES = {
  ENABLE_NEWS: true,
  ENABLE_ML: true,
  ENABLE_ELLIOTT: true,
  ENABLE_TP_SL: true,
  ENABLE_AUTO_PING: true,
};

// ====== VALIDATION ======
if (!CONFIG.BOT_TOKEN || !CONFIG.CHAT_ID) {
  console.warn("⚠️ Warning: BOT_TOKEN or CHAT_ID missing in .env file!");
}

// ====== EXPORT DEFAULT ======
export default { CONFIG, MARKET_CONFIG, FEATURES };