// ===============================
// 🤖 aiTraderBot.js — AI Trader v10.0 (Config Connected)
// ===============================

import express from "express";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// ===============================
// 🌍 KeepAlive / Server
// ===============================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader v10.0 is live"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 KeepAlive server active on port ${PORT}`);
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 5 * 60 * 1000);
});

// ===============================
// 🚀 Startup
// ===============================
console.log(`🤖 AI Trader ${CONFIG.VERSION} Starting...`);
if (CONFIG.SELF_PING_URL) keepAlive(CONFIG.SELF_PING_URL);
await setupTelegramBot();

// ===============================
// 📊 Build Market Report
// ===============================
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log(`\n⏳ Fetching ${symbol} data (${interval})`);
  const { data, source } = await fetchMarketData(symbol, interval, 500);

  if (!data || !data.length) {
    console.warn("⚠️ No market data!");
    return null;
  }

  // Safe normalization
  const validData = data.filter(c => c && typeof c.close === "number");
  if (validData.length < 20) {
    console.warn("⚠️ Not enough candles for analysis");
    return null;
  }

  // --- Indicators ---
  const rsi = calculateRSI(validData, 14);
  const macd = calculateMACD(validData, 12, 26, 9);
  const ell = analyzeElliott(validData, interval);
  const ml = await runMLPrediction(validData);
  const merged = mergeSignals({ rsi, macd }, ell, ml);
  const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);

  // --- ATR Calculation ---
  const recent = validData.slice(-20);
  let atr = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const k = recent[i];
    atr += Math.max(
      k.high - k.low,
      Math.abs(k.high - (prev?.close ?? k.close)),
      Math.abs(k.low - (prev?.close ?? k.close))
    );
  }
  atr = atr / Math.max(1, recent.length - 1);

  const last = validData[validData.length - 1];
  const SL = Math.round(last.close - Math.sign(merged.bias === "Buy" ? 1 : -1) * atr * 2);
  const TP1 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr * 4);
  const TP2 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr * 6);

  // --- Telegram Message ---
  let text = `🚀 <b>${symbol} — AI Trader ${CONFIG.VERSION}</b>\n${nowLocal()}\nSource: ${source}\nPrice: ${last.close}\n\n`;
  text += `📊 <b>Elliott Wave (${interval})</b>\n${ell.structure || "N/A"} | Pattern: ${ell.pattern || "N/A"} | Confidence: ${ell.confidence || 0}%\n\n`;
  text += `⚙️ RSI: ${rsi?.value?.toFixed(2) || "N/A"} | MACD: ${macd?.summary || "N/A"} | ML: ${ml?.label || "N/A"} (${ml?.prob || 0}%)\n\n`;
  text += `🎯 Bias: ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb}%\n\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\n\n`;
  text += `📰 News Impact: ${news.impact} (score ${news.score})\n`;
  if (news.headlines?.length) {
    text += "🗞 Headlines:\n• " + news.headlines.join("\n• ") + "\n";
  }
  text += `\nSources: Binance, KuCoin, CoinGecko, Yahoo Finance\n`;

  return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
}

// ===============================
// 🔁 Report Loop
// ===============================
async function generateReportLoop() {
  try {
    const report = await buildReport(CONFIG.SYMBOL, "15m");
    if (!report) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(report.text);
  } catch (err) {
    console.error("Report error:", err.message || err);
    await sendTelegramMessage(`❌ Error: ${err.message || err}`);
  }
}

// ===============================
// 🕒 Scheduler
// ===============================
generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);

console.log(
  `✅ Main loop started — Reports every ${CONFIG.REPORT_INTERVAL_MS / 60000} min`
);