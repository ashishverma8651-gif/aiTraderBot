// =====================================================
// 🚀 AI Trader v9.6 - Modular Engine + Auto KeepAlive
// =====================================================

import { getIndicators } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { getMLBias } from "./ml_module_v8_6.js";
import { getNewsImpact } from "./news_social.js";
import { sendTelegram } from "./tg_commands.js";
import { keepAlive, nowLocal } from "./utils.js";
import CONFIG from "./config.js";

// ================================================
// ⚙️ Core Loop Function
// ================================================

async function doAnalysisAndSend(symbol = "BTCUSDT") {
  try {
    console.log(`\n🔁 Running analysis for ${symbol} @ ${nowLocal()}`);

    // ---- Step 1: Collect technical data ----
    const indicators = await getIndicators(symbol); // RSI, MACD, ATR, etc.
    console.log("📊 Indicators fetched");

    // ---- Step 2: Elliott wave analysis ----
    const elliott = await analyzeElliott(symbol);
    console.log("🌊 Elliott Wave done");

    // ---- Step 3: News & sentiment ----
    const news = await getNewsImpact(symbol);
    console.log("📰 News sentiment done");

    // ---- Step 4: ML Bias prediction ----
    const ml = await getMLBias(symbol, indicators, elliott, news);
    console.log("🤖 ML bias ready");

    // ---- Step 5: Merge everything ----
    const finalSignal = mergeSignals(indicators, elliott, ml, news);
    console.log("📈 Final Signal generated");

    // ---- Step 6: Prepare message ----
    let msg = `🚀 <b>${symbol}</b> — <b>AI Trader v9.6</b>\n` +
              `Time: ${nowLocal()}\n` +
              `Bias: <b>${finalSignal.bias}</b> (${finalSignal.confidence}%)\n` +
              `TP: ${finalSignal.tp1} / ${finalSignal.tp2} / ${finalSignal.tp3}\n` +
              `SL: ${finalSignal.sl}\n\n` +
              `🧠 ML: ${ml.bias} (${ml.confidence}%)\n` +
              `🌊 Elliott: ${elliott.structure}\n` +
              `📰 News: ${news.impactLevel} (${news.sentiment})`;

    await sendTelegram(msg);

  } catch (err) {
    console.error("❌ doAnalysisAndSend err:", err.message);
  }
}

// ================================================
// ⏰ Scheduler
// ================================================
setInterval(() => {
  doAnalysisAndSend("BTCUSDT");
}, CONFIG.ANALYSIS_INTERVAL || 1000 * 60 * 15); // default: every 15 min

// ================================================
// 🌐 Auto Keep-Alive Ping
// ================================================
keepAlive("https://aitraderbot.onrender.com");

// ================================================
// 🚀 Start Message
// ================================================
console.log("✅ AI Trader v9.6 started successfully!");