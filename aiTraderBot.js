// ===============================================
// 🤖 aiTraderBot.js — AI Trader v10.1 (Pro Enhanced)
// Multi-source | WebSocket Mirror | ML + Elliott + News | Auto 15m Report
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, keepAlive } from "./utils.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";
import { buildAIReport, formatAIReport }; from "./tg_commands.js";

// ===============================================
// 🌐 Express Keep-Alive Server
// ===============================================
const app = express();
const PORT = CONFIG.SERVER.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader v10.1 running fine!"));
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// ===============================================
// 📡 Binance WebSocket + Multi-Mirror + Fallback
// ===============================================
let lastPrice = null;
let ws = null;
let socketAlive = false;

const BINANCE_WS_MIRRORS = [
  "wss://stream.binance.com:9443/ws/",
  "wss://data-stream.binance.vision/ws/",
  "wss://stream.binance.us:9443/ws/"
];

function connectLiveSocket(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;
  let mirrorIndex = 0;

  const connect = () => {
    const url = BINANCE_WS_MIRRORS[mirrorIndex] + stream;
    console.log(`🔄 Connecting WebSocket: ${url}`);
    ws = new WebSocket(url);

    ws.on("open", () => {
      socketAlive = true;
      console.log(`✅ Live WebSocket connected (${url})`);
    });

    ws.on("message", (data) => {
      try {
        const json = JSON.parse(data);
        if (json?.c) lastPrice = parseFloat(json.c);
      } catch (_) {}
    });

    ws.on("close", () => {
      socketAlive = false;
      console.warn("🔴 WS closed — retrying mirror...");
      mirrorIndex = (mirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
      setTimeout(connect, 8000);
    });

    ws.on("error", (err) => {
      console.warn("⚠️ WS error:", err.message);
      ws.close();
    });
  };

  connect();
}

connectLiveSocket(CONFIG.SYMBOL);

// ===============================================
// 📊 Build Data Context (for tg_commands.js)
// ===============================================
async function getDataContext(symbol = CONFIG.SYMBOL) {
  const candles = await fetchMarketData(symbol, "15m", 200);
  const cleanCandles = candles.data || candles;
  if (!cleanCandles?.length) throw new Error("No candle data fetched");

  const last = cleanCandles.at(-1);
  const price = lastPrice || last.close;

  const ml = await runMLPrediction(symbol);
  const ell = await analyzeElliott(cleanCandles);
  const news = await fetchNews(symbol.replace("USDT", ""));

  return { price, candles: cleanCandles, ml, ell, news, socketAlive };
}

// ===============================================
// 🔁 Auto 15m Telegram Updates (uses tg_commands.js UI)
// ===============================================
async function sendAutoReport() {
  try {
    const data = await getDataContext(CONFIG.SYMBOL);

    // tg_commands.js handles UI formatting
    const report = await buildTelegramUIReport(CONFIG.SYMBOL, data);

    await sendTelegramMessage(report);
    console.log(`✅ [${CONFIG.SYMBOL}] Report sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("❌ Auto report error:", err.message);
  }
}

// Interval: every 15 minutes
setInterval(sendAutoReport, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
sendAutoReport();

// ===============================================
// ♻️ Auto Keep-Alive Ping (Render Safe)
// ===============================================
if (CONFIG.SERVER.KEEP_ALIVE) {
  setInterval(async () => {
    try {
      const res = await keepAlive();
      if (res.ok) console.log("✅ KeepAlive success ping");
    } catch (err) {
      console.warn("⚠️ KeepAlive ping failed:", err.message);
    }
  }, 5 * 60 * 1000);
}

// ===============================================
// 🧠 Export for modular use
// ===============================================
export default { sendAutoReport, getDataContext };