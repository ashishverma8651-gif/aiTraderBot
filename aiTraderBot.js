// aiTraderBot.js — FINAL STABLE VERSION
import CONFIG from "./config.js";
import { fetchMarketData, calculateIndicators } from "./core_indicator.js";
import { generateMergedSignal } from "./merge_signals.js";
import { analyzeWithElliott } from "./elliott_module.js";
import { analyzeWithML, getMLConfidence } from "./ml_model.js";
import { analyzeNewsImpact } from "./background_utils.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { recordFeedback } from "./merge_signals.js";
import { nowLocal } from "./utils.js";

global.botInstance = null;

// 📊 Build full AI report
export async function buildReport(symbol = "BTCUSDT", tf = "15m") {
  try {
    const marketData = await fetchMarketData(symbol, tf);
    const indicators = await calculateIndicators(marketData);
    const merged = await generateMergedSignal(symbol, indicators);
    const elliott = await analyzeWithElliott(symbol, marketData);
    const ml = await analyzeWithML(symbol, indicators);
    const news = await analyzeNewsImpact(symbol);

    const bias = merged.bias || "Neutral";
    const tp1 = merged.tp1 || ml.tp1 || elliott.tp1 || 0;
    const tp2 = merged.tp2 || ml.tp2 || elliott.tp2 || 0;
    const sl = merged.sl || ml.sl || elliott.sl || 0;
    const price = marketData?.currentPrice || 0;

    // final formatted message
    const text = `
🚀 <b>${symbol}</b> — AI Trader Report
🕒 ${nowLocal()}
🔗 Source: ${CONFIG.SOURCE}

💰 <b>Price:</b> ${price.toFixed(2)}
━━━━━━━━━━━━━━━
📈 <b>${tf} | ${bias}</b> ${bias === "Bullish" ? "🟢" : bias === "Bearish" ? "🔴" : "⚪"}
💵 Price: ${price.toFixed(2)} | Vol: ${indicators.volumeLevel}
📊 RSI: ${indicators.rsi} | MACD: ${indicators.macd.toFixed(2)} | ATR: ${indicators.atr.toFixed(2)}

━━━━━━━━━━━━━━━
🧭 <b>Overall Bias:</b> ${bias}
💪 Strength: ${merged.strength || 0}% | 🤖 ML Prob: ${getMLConfidence(ml)}
🎯 TP1: ${tp1} | TP2: ${tp2} | SL: ${sl}

━━━━━━━━━━━━━━━
📰 <b>News Impact:</b> ${news.sentimentText} (score ${news.score})
📚 Sources: Binance, CoinGecko, KuCoin, AI Feeds
━━━━━━━━━━━━━━━
`;
    return { text, bias };
  } catch (err) {
    console.error("❌ buildReport error:", err.message);
    return { text: `❌ Error generating report for ${symbol}: ${err.message}` };
  }
}

// 🕒 Periodic Auto Updates
async function autoUpdateLoop() {
  try {
    const { text } = await buildReport(CONFIG.DEFAULT_SYMBOL || "BTCUSDT", "15m");
    await sendTelegramMessage(text);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (err) {
    console.error("⚠️ Auto update error:", err.message);
  }
}

// 🧠 Initialize Bot + Loops
(async () => {
  try {
    if (!global.botInstance) {
      global.botInstance = await setupTelegramBot();
      console.log("🤖 Telegram bot initialized.");
    }
  } catch (e) {
    console.warn("⚠️ setupTelegramBot error:", e.message);
  }

  // periodic update
  await autoUpdateLoop();
  setInterval(autoUpdateLoop, 15 * 60 * 1000); // every 15m
})();