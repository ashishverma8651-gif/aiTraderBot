/**
 * main_control.js (v9.5)
 * Central orchestrator — integrates:
 *  - Multi-source market data (crypto + Indian stocks)
 *  - ML prediction module
 *  - Elliott Wave / Fibonacci analysis
 *  - Telegram bot with auto reports
 *  - Reversal watcher + keep-alive for Render
 *
 * ⚙️ Dependencies:
 *   npm install axios express dotenv
 */

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

// ====== Import Internal Modules ======
import { fetchMarketData, fetchNewsHeadlines } from "./fetch_module_v9.js";
import { mlPredict, mlTrain, mlInit } from "./ml_module_v9.js";
import { analyzeElliottWave } from "./elliott_module.js"; // optional

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

// ====== Telegram Helper ======
async function sendTelegramMessage(text, parse_mode = "HTML") {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn("Telegram send failed:", err.message);
  }
}

// ====== Keep Alive for Render ======
async function keepAlive() {
  if (!SELF_PING_URL) return;
  try {
    await axios.get(SELF_PING_URL);
    console.log("🌐 KeepAlive ping OK");
  } catch (e) {
    console.warn("KeepAlive failed:", e.message);
  }
}
setInterval(keepAlive, 3 * 60 * 1000); // every 3 mins

// ====== Core Analysis ======
async function generateReport() {
  console.log("📊 Generating report...");

  try {
    // ---- Fetch Market Data ----
    const { data: klines, source } = await fetchMarketData(SYMBOL, INTERVAL);
    if (!klines || !klines.length) {
      await sendTelegramMessage(`❌ No market data for ${SYMBOL}`);
      return;
    }

    const last = klines.at(-1);
    const lastPrice = last.close;

    // ---- Elliott Wave & Fib ----
    let ellReport = { structure: "unknown", wave: "-", confidence: 0 };
    try {
      ellReport = analyzeElliottWave(klines);
    } catch {
      console.log("Elliott module unavailable, skipping...");
    }

    // ---- ML Features ----
    mlInit(8); // ensure model ready
    const features = [
      last.close,
      last.volume,
      last.high - last.low,
      Math.random(),
      Math.random(),
      Math.random(),
      1,
      0.5,
    ];
    const mlProb = mlPredict(features);

    // ---- News Sentiment ----
    const news = await fetchNewsHeadlines();
    const sentimentCount = news.filter((n) =>
      /(rise|bull|gain|soar|rally|support|positive)/i.test(n.title)
    ).length;
    const sentimentScore = sentimentCount - (news.length - sentimentCount);

    // ---- Bias Decision ----
    const bias =
      mlProb > 0.6
        ? "Bullish"
        : mlProb < 0.4
        ? "Bearish"
        : sentimentScore > 0
        ? "Bullish"
        : "Neutral";

    // ---- Compose Message ----
    const msg = `
📊 <b>AI Trader Report v9.5</b>
🕒 ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
💱 Symbol: <b>${SYMBOL}</b> (${source})
💰 Last Price: <b>${lastPrice.toFixed(2)}</b>

📈 <b>Bias:</b> ${bias}
🤖 ML Confidence: ${(mlProb * 100).toFixed(1)}%
🌊 Elliott Wave: ${ellReport.structure} (Wave ${ellReport.wave}, ${(
      ellReport.confidence * 100
    ).toFixed(0)}%)

📰 News Impact: ${sentimentScore > 0 ? "Positive" : sentimentScore < 0 ? "Negative" : "Neutral"}

`;

    await sendTelegramMessage(msg);
  } catch (e) {
    console.error("generateReport error:", e.message);
  }
}

// ====== Reversal Watcher (every 1 min) ======
async function reversalWatcher() {
  try {
    const { data } = await fetchMarketData(SYMBOL, "1m");
    if (!data || data.length < 3) return;

    const last = data.at(-1);
    const prev = data.at(-2);
    const change = ((last.close - prev.close) / prev.close) * 100;

    if (Math.abs(change) > 0.5) {
      const dir = change > 0 ? "Bullish" : "Bearish";
      await sendTelegramMessage(`🚨 <b>${dir} Reversal Alert</b>\nPrice: ${last.close}`);
    }
  } catch (err) {
    console.warn("reversalWatcher failed:", err.message);
  }
}
setInterval(reversalWatcher, 60 * 1000);

// ====== Scheduler ======
setInterval(generateReport, 15 * 60 * 1000); // every 15 min

// ====== Express Keep-Alive Server ======
const app = express();
app.get("/", (req, res) => res.send("AI Trader v9.5 running ✅"));
app.listen(SERVER_PORT, () => console.log(`🚀 Server up on port ${SERVER_PORT}`));

// ====== Startup Trigger ======
generateReport();