// ===============================================================
// aiTraderBot.js — AI Trader v11.6 (Live Socket + Multi-Integration)
// ===============================================================

import express from "express";
import WebSocket from "ws";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// ===============================================================
// ⚙️ Core Setup
// ===============================================================
const app = express();
const PORT = process.env.PORT || 10000;
let livePrice = null;
let lastPushPrice = null;

// ===============================================================
// 📡 Live Binance Socket (btcusdt@ticker)
// ===============================================================
function startLiveSocket(symbol = "btcusdt") {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@ticker`);
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      livePrice = parseFloat(data.c).toFixed(2);
    } catch (e) {
      console.error("Socket parse error:", e.message);
    }
  });

  ws.on("open", () => console.log(`📡 Live socket connected (${symbol})`));
  ws.on("close", () => {
    console.warn("⚠️ Socket closed, reconnecting...");
    setTimeout(() => startLiveSocket(symbol), 4000);
  });
  ws.on("error", (err) => console.error("Socket error:", err.message));
}

// ===============================================================
// 🧠 Build Full Report (Telegram Format)
// ===============================================================
export async function buildReport(symbol = "BTCUSDT") {
  const intervals = ["1m", "5m", "15m", "30m", "1h"];
  const source = "Binance (Live WebSocket + Multi-source)";
  const marketData = {};

  // Historical analysis
  for (const tf of intervals) {
    try {
      const candles = await fetchMarketData(symbol, tf);
      const closes = candles.map(c => parseFloat(c.close));
      const price = closes[closes.length - 1].toFixed(2);
      const vol = candles[candles.length - 1].volume;
      const rsi = calculateRSI(closes);
      const macd = calculateMACD(closes);
      const atr = (Math.max(...closes) - Math.min(...closes)) / 20;

      let bias = "Sideways";
      if (rsi > 60) bias = "Bullish";
      else if (rsi < 40) bias = "Bearish";

      marketData[tf] = {
        bias, price, vol, rsi: rsi.toFixed(1), macd: macd.signal.toFixed(3), atr: atr.toFixed(3)
      };
    } catch (err) {
      console.warn(`⚠️ ${tf} fetch failed: ${err.message}`);
    }
  }

  // AI modules
  const elliott = analyzeElliott(symbol);
  const ml = runMLPrediction(symbol);
  const merged = mergeSignals(symbol);
  const overallBias = merged.bias || "Neutral";
  const strength = merged.strength || 0;
  const mlProb = ml.prob || 50;

  // Live price fallback
  const currentPrice = livePrice || marketData["1m"]?.price || "N/A";

  // Targets
  const TP1 = (currentPrice * 1.03).toFixed(2);
  const TP2 = (currentPrice * 1.05).toFixed(2);
  const TP3 = (currentPrice * 1.08).toFixed(2);
  const SL = (currentPrice * 0.95).toFixed(2);

  // News
  const news = await fetchNews(symbol);
  const score = news?.score || 0;
  const impact = score > 3 ? "High" : score > 0 ? "Medium" : "Low";
  const headlines = Array.isArray(news?.headlines)
    ? news.headlines.slice(0, 5).map(h => `• ${h.title || h}`).join("\n")
    : "No major headlines found.";

  // 🧾 Format Telegram message (same as v11.0 style)
  const msg = `
🚀 <b>${symbol}</b> — AI Trader v11.6 (Live)
🕒 ${nowLocal()}
🛰 Source: ${source}
💰 Price: ${currentPrice}
━━━━━━━━━━━━━━━━━━
${intervals.map(tf => {
    const d = marketData[tf];
    if (!d) return "";
    return `📊 ${tf} | ${d.bias}\n💵 Price: ${d.price} | Vol: ${d.vol}\n📈 RSI: ${d.rsi} | MACD: ${d.macd} | ATR: ${d.atr}`;
  }).join("\n━━━━━━━━━━━━━━━━━━\n")}
━━━━━━━━━━━━━━━━━━
🎯 Overall Bias: ${overallBias} | 💪 Strength: ${strength}% | 🤖 ML Prob: ${mlProb}%
🎯 TP1: ${TP1} | TP2: ${TP2} | TP3: ${TP3} | SL: ${SL}
🔍 Recommendation: <b>${overallBias}</b> (Conf: ${(strength + mlProb) / 2}%)
━━━━━━━━━━━━━━━━━━
📰 News Impact: ${impact} (score ${score})
🗞 Top headlines:
${headlines}
━━━━━━━━━━━━━━━━━━
📚 Sources: Multi-source (Live Socket + Config)
`;

  return msg;
}

// ===============================================================
// 🔄 Auto-Broadcast Every 15m + Live Spike Alerts
// ===============================================================
async function autoBroadcast() {
  try {
    const report = await buildReport("BTCUSDT");
    await sendTelegramMessage(report);
    console.log("✅ AI Report sent successfully.");
  } catch (err) {
    console.error("❌ Broadcast failed:", err.message);
  }
}

// 15 min interval loop
setInterval(autoBroadcast, 15 * 60 * 1000);

// Instant alert on >1% price change
setInterval(async () => {
  if (!livePrice || !lastPushPrice) {
    lastPushPrice = livePrice;
    return;
  }
  const change = Math.abs((livePrice - lastPushPrice) / lastPushPrice) * 100;
  if (change >= 1) {
    await sendTelegramMessage(`⚡ Live Price Alert: ${livePrice} (Δ ${change.toFixed(2)}%)`);
    lastPushPrice = livePrice;
  }
}, 20000);

// ===============================================================
// 🌐 Server KeepAlive + Start
// ===============================================================
app.get("/", (req, res) => {
  res.send(`✅ AI Trader Bot Live v11.6 | Price: ${livePrice || "Loading..."} | Source: Binance WS`);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  keepAlive();
  setupTelegramBot();
  startLiveSocket("btcusdt");
});

export default { buildReport };