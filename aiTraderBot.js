// =====================================================================
// 🚀 aiTraderBot.js — Unified AI Trader Core (Final Render-Safe v11.0)
// =====================================================================

import express from "express";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import MLModule, { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// =====================================================================
// ⚙️ Server KeepAlive
// =====================================================================

const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running!"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
keepAlive();

// =====================================================================
// 📊 Core Report Builder
// =====================================================================

async function buildReport(symbol = "BTCUSDT") {
  try {
    const time = nowLocal();
    const source = CONFIG.DATA_SOURCES[0]; // from config.js (multi-source)
    const marketData = await fetchMarketData(symbol);
    const price = marketData?.price || "N/A";

    // Indicators
    const rsi = calculateRSI(marketData);
    const macd = calculateMACD(marketData);
    const elliott = analyzeElliott(marketData);

    // ML Prediction
    const mlResult = await runMLPrediction(symbol);

    // News Fetch
    const news = await fetchNews(symbol);

    // Merge signals
    const merged = mergeSignals({
      rsi,
      macd,
      elliott,
      mlResult,
    });

    // 🧠 Final structured message (Telegram UI)
    const report = `
🚀 ${symbol} — AI Trader v11.0
🕒 ${time}
🛰️ Source: ${source.name} (${source.url})
💰 Price: ${price}

📊 1m | ${merged.trend1m}
💵 RSI: ${rsi?.m1} | MACD: ${macd?.m1} | ATR: ${merged?.atr1m}

📊 5m | ${merged.trend5m}
💵 RSI: ${rsi?.m5} | MACD: ${macd?.m5} | ATR: ${merged?.atr5m}

📊 15m | ${merged.trend15m}
💵 RSI: ${rsi?.m15} | MACD: ${macd?.m15} | ATR: ${merged?.atr15m}

📊 30m | ${merged.trend30m}
💵 RSI: ${rsi?.m30} | MACD: ${macd?.m30} | ATR: ${merged?.atr30m}

📊 1h | ${merged.trend1h}
💵 RSI: ${rsi?.h1} | MACD: ${macd?.h1} | ATR: ${merged?.atr1h}

⚙️ Overall Bias: ${merged.bias} | Strength: ${merged.strength}% | 🤖 ML Prob: ${mlResult?.probability || "N/A"}%

🎯 TP1: ${merged.tp1} | TP2: ${merged.tp2} | TP3: ${merged.tp3} | SL: ${merged.sl}

📰 News Impact: ${news?.impact || "Low"} (score ${news?.score || 0})
🗞️ Headlines:
${news?.headlines?.map(h => `• ${h}`).join("\n") || "N/A"}

📡 Sources: Multi-source (config)
────────────────────────────
    `;
    return report;
  } catch (err) {
    console.error("❌ buildReport error:", err);
    return "Error generating report.";
  }
}

// =====================================================================
// 🤖 Telegram Auto-Sync
// =====================================================================

setupTelegramBot();
sendTelegramMessage("🚀 AI Trader Bot v11.0 initialized successfully!");

// =====================================================================
// ✅ Exports (Cleaned — no duplicates)
// =====================================================================

export { buildReport };
export { mergeSignals as generateMergedSignal };
export { runMLPrediction as computeHybridTargets };

export default {
  buildReport,
  generateMergedSignal: mergeSignals,
  computeHybridTargets: runMLPrediction,
};