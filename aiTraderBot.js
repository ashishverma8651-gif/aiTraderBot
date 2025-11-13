// =====================================================================
// 🤖 aiTraderBot.js — Unified AI Trader Core (Render-Safe v11.2)
// Includes: Live sync, multi-source data, Telegram auto 15m updates
// =====================================================================

import express from "express";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import MLModule, { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals, generateMergedSignal, computeHybridTargets } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// =====================================================================
// ⚙️ Server KeepAlive
// =====================================================================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running."));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
keepAlive();

// =====================================================================
// 📊 Core Report Generator (Main Function)
// =====================================================================
export async function buildReport(symbol = "BTCUSDT") {
  try {
    const marketData = await fetchMarketData(symbol);
    const price = marketData?.price || 0;
    const volume = marketData?.volume || 0;

    // Timeframes
    const timeframes = ["1m", "5m", "15m", "30m", "1h"];
    const tfReports = [];

    for (const tf of timeframes) {
      const data = await fetchMarketData(symbol, tf);
      const rsi = calculateRSI(data);
      const macd = calculateMACD(data);
      const atr = data.atr || 0;

      const bias =
        rsi > 70 ? "Bearish 🔴" :
        rsi < 30 ? "Bullish 🟢" : "Sideways";

      tfReports.push(`
📊 ${tf.toUpperCase()} | ${bias}
💰 Price: ${data.price.toFixed(2)} | Vol: ${data.volume.toFixed(2)}
📈 RSI: ${rsi?.toFixed(1) || "N/A"} | MACD: ${macd?.toFixed(3) || "0.000"} | ATR: ${atr?.toFixed(3) || "0"}
`);
    }

    // AI & Elliott + ML fusion
    const elliott = await analyzeElliott(symbol);
    const mlResult = await runMLPrediction(symbol);
    const merged = generateMergedSignal(elliott, mlResult);
    const targets = computeHybridTargets(price, merged.bias);

    // News
    const news = await fetchNews(symbol);

    // 🧩 Final Report (Telegram Format)
    const report = `
🚀 <b>${symbol}</b> — <b>AI Trader v11.2</b>
🕒 ${nowLocal()}
🔗 Source: ${marketData.source || "Multi-source (config)"}
💵 Price: <b>${price.toFixed(2)}</b>

━━━━━━━━━━━━━━━
${tfReports.join("\n━━━━━━━━━━━━━━━\n")}
━━━━━━━━━━━━━━━

🧭 Overall Bias: <b>${merged.bias}</b>
💪 Strength: ${merged.confidence}% | 🤖 ML Prob: ${mlResult.confidence || 50}%
🎯 TP1: ${targets.tp1} | TP2: ${targets.tp2} | SL: ${targets.sl}

🧠 Recommendation: <b>${merged.bias}</b> (Conf: ${merged.confidence}%)

🗞 News Impact: <b>${news.impact}</b> (score ${news.score})
📰 Top headlines:
${news.headlines?.slice(0, 5).map((n) => `• ${n.title || n}`).join("\n")}

Sources: ${marketData.sources?.join(", ") || "Config-based multisource"}
`;

    return { text: report };
  } catch (err) {
    console.error("❌ buildReport error:", err.message);
    return { text: `⚠️ Error generating report: ${err.message}` };
  }
}

// =====================================================================
// 🔁 Auto 15-Minute Telegram Updates
// =====================================================================
async function autoUpdateLoop() {
  try {
    const { text } = await buildReport("BTCUSDT");
    await sendTelegramMessage(text);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (err) {
    console.error("⚠️ Auto update error:", err.message);
  }
  setTimeout(autoUpdateLoop, 15 * 60 * 1000); // repeat every 15 min
}

// =====================================================================
// 🚀 Initialize Bot & Start Loops
// =====================================================================
(async () => {
  try {
    await setupTelegramBot();
    console.log("📱 Telegram bot initialized.");

    await autoUpdateLoop();
    console.log("♻️ Auto-update loop started.");

  } catch (err) {
    console.error("❌ Initialization error:", err.message);
  }
})();

// =====================================================================
// ✅ Final Exports
// =====================================================================
export { buildReport, computeHybridTargets, generateMergedSignal };
export default { buildReport, computeHybridTargets, generateMergedSignal };