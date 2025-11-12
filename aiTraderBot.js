// aiTraderBot.js — AI Trader v9.6 (stable fixed)
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";

import express from "express";

// ============================
// 🌍 KeepAlive Server
// ============================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  setInterval(() => keepAlive(), 5 * 60 * 1000);
});

// ============================
// 🤖 Bot Startup
// ============================
console.log("🤖 AI Trader Bot Starting...");
if (CONFIG.SELF_PING_URL) keepAlive(CONFIG.SELF_PING_URL);
await setupTelegramBot();

// ============================
// 📊 Build Market Report
// ============================
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log("⏳ Fetching market data for", symbol, interval);
  const { data, source } = await fetchMarketData(symbol, interval, 500);

  if (!data || !data.length) {
    console.warn("⚠️ No market data!");
    return null;
  }

  // --- 🔧 Safe Data Normalization ---
  const validData = data.filter(c => c && typeof c.close === "number");
  if (validData.length === 0) {
    console.warn(`⚠️ No valid candle found for ${symbol}`);
    return { text: `⚠️ ${symbol} — Invalid candle data.` };
  }

  const last = validData[validData.length - 1];
  const recent = validData.slice(-20);

  // --- 📈 ATR Calculation (safe version) ---
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

  // --- 🧮 Indicators ---
  const rsi = calculateRSI(validData, 14);
  const macd = calculateMACD(validData, 12, 26, 9);
  const ell = analyzeElliott(validData, interval);
  const ml = await runMLPrediction(validData);
  const merged = mergeSignals({ rsi, macd }, ell, ml);
  const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);

  // --- 🎯 TP / SL Calculation ---
  const SL = Math.round(last.close - Math.sign(merged.bias === "Buy" ? 1 : -1) * atr * 2);
  const TP1 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr * 4);
  const TP2 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr * 6);

  // --- 🧾 Telegram Message ---
  let text = `🚀 <b>${symbol} — AI Trader v9.6</b>\n${nowLocal()}\nSource: ${source}\nPrice: ${last.close}\n\n`;
  text += `📊 <b>Elliott Wave (${interval})</b>\n${ell.structure} | Wave: ${ell.wave} | Confidence: ${ell.confidence}%\n\n`;
  text += `⚠️ <b>Possible Wave 5 Reversal</b> — watch for breakout confirmation.\n\n`;

  for (let tf of CONFIG.INTERVALS) {
    text += `📈 ${tf} | Price: ${last.close} | RSI: ${rsi || "N/A"} | MACD: ${
      macd ? macd.macd.toFixed(2) : "N/A"
    } | ATR: ${Math.round(atr)} | ML: ${ml?.prob || 0}%\n`;
  }

  text += `\nBias: ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb}%\n\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\nBreakout zone (est): ${Math.round(
    last.close - atr * 3
  )} - ${Math.round(last.close + atr * 3)}\n\n`;

  text += `📰 News Impact: ${news.impact} (score ${news.score})\n`;
  if (news.headlines && news.headlines.length) {
    text += "News headlines:\n• " + news.headlines.join("\n• ") + "\n";
  }
  text += `\nSources: Binance, CoinGecko, KuCoin\n`;

  return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
}

// ============================
// 🔁 Report Loop
// ============================
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (e) {
    console.error("Report error:", e.message || e);
    await sendTelegramMessage(`❌ Error generating report: ${e.message || e}`);
  }
}

// ============================
// 🚀 Start Loop
// ============================
generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);

console.log(
  "Main loop started. Reports every",
  CONFIG.REPORT_INTERVAL_MS / 60000,
  "minutes"
);