// ===============================================
// 🤖 aiTraderBot.js — AI Trader v10.0 (Pro Enhanced)
// Multi-source | WebSocket Mirror | ML + Elliott + News | Auto 15m Report
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import axios from "axios";
import WebSocket from "ws";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";
import { sendTelegramMessage } from "./tg_commands.js";
import { fetchMarketData } from "./utils.js";

// ===============================================
// 🌐 Express Keep-Alive Server
// ===============================================
const app = express();
const PORT = CONFIG.SERVER.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader v10.0 running fine!"));
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
// 📊 Build Full AI Report
// ===============================================
async function buildAIReport(symbol = "BTCUSDT") {
  const data = await fetchMarketData(symbol, "15m", 200);
  const candles = data.data || data; // support both API and internal utils output

  if (!candles || !candles.length) return "⚠️ No market data fetched.";

  const last = candles.at(-1);
  const price = lastPrice || last.close;

  // Run ML + Elliott + News
  const ml = await runMLPrediction(symbol);
  const ell = await analyzeElliott(candles);
  const news = await fetchNews("BTC");

  const ellText = ell?.wave
    ? `${ell.waveLabel || "Impulse"} | Conf: ${(ell.confidence || 0).toFixed(1)}%`
    : "N/A";

  const prob = ml.prob || 0;
  const label = ml.label || "Neutral";
  const emoji = label === "Bullish" ? "🟢" : label === "Bearish" ? "🔴" : "⚪";

  const report = `
🚀 <b>${symbol} — AI Trader v10.0</b>
🕒 ${new Date().toLocaleString()}
📡 Source: ${socketAlive ? "Binance (Live WS)" : "REST (Fallback)"}
💰 <b>Price:</b> ${price.toFixed(2)}

📊 <b>Elliott Wave (15m)</b>
${ell.wave ? `🌀 ${ell.wave} | Confidence: ${(ell.confidence || 0).toFixed(1)}%` : "N/A"}

🧠 <b>AI Prediction:</b> ${emoji} ${label} (${prob.toFixed(2)}%)
━━━━━━━━━━━━━━━━━━━
🎯 TP1: ${(price * 1.03).toFixed(2)} | TP2: ${(price * 1.05).toFixed(2)} | TP3: ${(price * 1.07).toFixed(2)}  
🛑 SL: ${(price * 0.97).toFixed(2)}
━━━━━━━━━━━━━━━━━━━

📰 <b>News Impact:</b> ${news.sentiment > 0 ? "Bullish 🟢" : "Bearish 🔴"} | Score: ${news.score || 0}
🗞️ <b>Headlines:</b>
${(news.headlines || []).slice(0, 4).map((h) => `• ${h}`).join("\n")}

📈 ML Confidence: ${(prob).toFixed(2)}% | Elliott Conf: ${(ell.confidence || 0).toFixed(1)}%
━━━━━━━━━━━━━━━━━━━
<i>Data: Binance + Multi-source | v10.0</i>
  `.trim();

  return report;
}

// ===============================================
// 🔁 Auto 15m Telegram Updates
// ===============================================
async function sendAutoReport() {
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    await sendTelegramMessage(report);
    console.log(`✅ AI Report sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("❌ Auto report error:", err.message);
  }
}

setInterval(sendAutoReport, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
sendAutoReport();

// ===============================================
// ♻️ Auto Keep-Alive Ping (Render Safe)
// ===============================================
import { keepAlive } from "./utils.js";

if (CONFIG.SERVER.KEEP_ALIVE) {
  setInterval(async () => {
    try {
      const res = await keepAlive();
      if (res.ok) console.log("✅ KeepAlive success ping");
    } catch (err) {
      console.warn("⚠️ KeepAlive ping failed:", err.message);
    }
  }, 5 * 60 * 1000); // every 5 min
}


export default { buildAIReport, sendAutoReport };