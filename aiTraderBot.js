// =====================================================================
// 🚀 aiTraderBot.js — Unified AI Trader Full Core v11.5 (Render-Safe)
// =====================================================================

import express from "express";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD, calculateATR } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import MLModule, { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// =====================================================================
// ⚙️ Express + KeepAlive
// =====================================================================

const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot v11.5 is live and running!"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
keepAlive();

// =====================================================================
// 📊 Data Fetch & Indicator Analysis
// =====================================================================

async function analyzeSymbol(symbol = "BTCUSDT") {
  const data = await fetchMarketData(symbol);
  const price = data?.price || 0;

  const rsi = calculateRSI(data);
  const macd = calculateMACD(data);
  const atr = calculateATR(data);
  const elliott = analyzeElliott(data);
  const ml = await runMLPrediction(symbol);

  return { price, rsi, macd, atr, elliott, ml };
}

// =====================================================================
// 🧠 Build Telegram Report UI
// =====================================================================

async function buildReport(symbol = "BTCUSDT") {
  try {
    const time = nowLocal();
    const source = CONFIG.DATA_SOURCES[0];
    const market = await analyzeSymbol(symbol);
    const news = await fetchNews(symbol);

    // Merge signal logic
    const merged = mergeSignals({
      rsi: market.rsi,
      macd: market.macd,
      elliott: market.elliott,
      ml: market.ml,
    });

    const report = `
🚀 ${symbol} — AI Trader v11.5
🕒 ${time}
🛰️ Source: ${source.name} (${source.url})
💰 Price: ${market.price}

📊 1m | ${merged.trend1m || "Sideways"} | Vol: ${merged.vol1m || "N/A"}
💵 RSI: ${market.rsi.m1} | MACD: ${market.macd.m1} | ATR: ${market.atr.m1}

📊 5m | ${merged.trend5m || "Sideways"} | Vol: ${merged.vol5m || "N/A"}
💵 RSI: ${market.rsi.m5} | MACD: ${market.macd.m5} | ATR: ${market.atr.m5}

📊 15m | ${merged.trend15m || "Sideways"} | Vol: ${merged.vol15m || "N/A"}
💵 RSI: ${market.rsi.m15} | MACD: ${market.macd.m15} | ATR: ${market.atr.m15}

📊 30m | ${merged.trend30m || "Sideways"} | Vol: ${merged.vol30m || "N/A"}
💵 RSI: ${market.rsi.m30} | MACD: ${market.macd.m30} | ATR: ${market.atr.m30}

📊 1h | ${merged.trend1h || "Sideways"} | Vol: ${merged.vol1h || "N/A"}
💵 RSI: ${market.rsi.h1} | MACD: ${market.macd.h1} | ATR: ${market.atr.h1}

───────────────────────────────
⚙️ Overall Bias: ${merged.bias}
💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${market.ml?.probability || "N/A"}%
🎯 TP1: ${merged.tp1} | TP2: ${merged.tp2} | TP3: ${merged.tp3} | SL: ${merged.sl}

📰 News Impact: ${news?.impact || "Low"} (score: ${news?.score || 0})
🗞️ Headlines:
${news?.headlines?.map((h) => `• ${h}`).join("\n") || "N/A"}

📡 Sources: Multi-market (config)
───────────────────────────────
`;

    return report;
  } catch (err) {
    console.error("❌ buildReport error:", err);
    return "Error while generating AI report.";
  }
}

// =====================================================================
// 🤖 Telegram Integration (Auto + Command Mode)
// =====================================================================

setupTelegramBot(async (msg, symbol) => {
  const report = await buildReport(symbol || "BTCUSDT");
  sendTelegramMessage(report);
});

// =====================================================================
// ✅ Exports
// =====================================================================

export { buildReport, analyzeSymbol };
export default { buildReport, analyzeSymbol };