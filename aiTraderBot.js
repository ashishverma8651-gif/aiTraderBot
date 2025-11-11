// ===== aiTraderBot.js =====
// ✅ Core Dependencies
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

// ===== Internal Modules (Exact Repo Names) =====
import CONFIG from "./config.js";
import indicators from './core_indicators.js';
const { calculateRSI, calculateMACD } = indicators;
import elliott from './elliott_module.js';
const { analyzeElliott } = elliott;
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot } from "./tg_commands.js";
import { keepAlive, nowLocal } from './utils.js';
import { fetchMarketData } from './ml_module_v8_6.js';

// ====== ENV + CONFIG ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL;
const SERVER_PORT = process.env.PORT || 3000;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "15m";

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn("⚠️ BOT_TOKEN or CHAT_ID missing in .env!");
}

// ===== Telegram Helper =====
async function sendTelegramMessage(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn("❌ Telegram send failed:", err.message);
  }
}

// ===== Core Analysis =====
async function generateReport() {
  console.log(`📊 Generating report for ${SYMBOL} (${INTERVAL}) at ${nowLocal()}`);

  try {
    // Fetch Market Data
    const { data: klines, source } = await fetchMarketData(SYMBOL, INTERVAL);

    // Run Technical + ML + News Analysis
    const rsi = calculateRSI(klines);
    const macd = calculateMACD(klines);
    const elliott = analyzeElliott(klines);
    const mlSignal = await runMLPrediction(klines);
    const news = await fetchNews(SYMBOL);

    // Merge All Signals
    const merged = mergeSignals({ rsi, macd, elliott, mlSignal, news });

    // Final Message
    const msg = `
<b>🧠 AI Trader Report</b> (${nowLocal()})
<b>Symbol:</b> ${SYMBOL}
<b>Interval:</b> ${INTERVAL}
<b>RSI:</b> ${rsi.status} (${rsi.value})
<b>MACD:</b> ${macd.trend}
<b>Elliott:</b> ${elliott.structure}
<b>ML Prediction:</b> ${mlSignal.trend} (${(mlSignal.confidence * 100).toFixed(1)}%)
<b>News:</b> ${news.sentiment}
<b>📊 Final Bias:</b> ${merged.label} (${(merged.strength * 100).toFixed(1)}%)
Source: ${source}
`;

    await sendTelegramMessage(msg);
    console.log("✅ Report sent successfully!");
  } catch (err) {
    console.error("❌ Report generation failed:", err.message);
  }
}

// ===== Auto Ping (Render keep-alive) =====
if (SELF_PING_URL) keepAlive(SELF_PING_URL);

// ===== Express Server =====
const app = express();
app.get("/", (req, res) => res.send("🤖 AI Trader Bot is live and healthy!"));
app.listen(SERVER_PORT, () => console.log(`🚀 Server running on port ${SERVER_PORT}`));

// ===== Auto Report Interval =====
setInterval(generateReport, 15 * 60 * 1000); // every 15 mins
generateReport();