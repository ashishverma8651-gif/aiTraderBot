// config.js
export default {
  SYMBOL: "BTCUSDT",
  INTERVAL: "15m",
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  SELF_PING_URL: process.env.RENDER_EXTERNAL_URL || "",
  PORT: process.env.PORT || 3000
};