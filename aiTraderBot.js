// ===========================================================
// aiTraderBot.js — Unified AI Trader Core (Final Render-Safe v10.5)
// ===========================================================

import express from "express";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import MLModule, { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// ===========================================================
// ⚙️ Server KeepAlive
// ===========================================================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
});

// Keep pinging itself
(async () => {
  try {
    await keepAlive(CONFIG.SELF_PING_URL);
  } catch (e) {
    console.warn("keepAlive init:", e.message);
  }
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 5 * 60 * 1000);
})();

// ===========================================================
// 🧮 Helper Utilities
// ===========================================================
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function lastOf(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
}
function ensureArray(a) {
  return Array.isArray(a) ? a : [];
}

// ===========================================================
// 📈 Core Data Aggregation
// ===========================================================
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    // --- Fetch recent market data ---
    const resp = await fetchMarketData(symbol, interval, 300);
    const candles = resp?.data || [];
    if (!candles.length) throw new Error("No candle data found");

    const last = lastOf(candles);
    const closePrice = safeNum(last.close);

    // --- Calculate Indicators ---
    const rsi = calculateRSI(candles, 14);
    const macd = calculateMACD(candles, 12, 26, 9);
    const ell = await analyzeElliott({ [interval]: candles });
    const ml = await runMLPrediction(candles);
    const merged = mergeSignals({ rsi, macd }, ell, ml);
    const news = await fetchNews(symbol);

    // --- ATR Calculation ---
    const atr = candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14;

    // --- Build Text Output ---
    let text = "━━━━━━━━━━━━━━━━━━━\n";
    text += `🚀 <b>${symbol}</b> — <b>AI Trader Report</b>\n`;
    text += `🕒 ${nowLocal()}\n`;
    text += `🔗 Source: ${resp.source || "Binance"}\n`;
    text += `💰 <b>Price:</b> ${closePrice}\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n`;

    const tfList = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
    for (const tf of tfList) {
      try {
        const tfData = await fetchMarketData(symbol, tf, 150);
        const c = tfData.data || [];
        const l = lastOf(c);
        const rsiVal = calculateRSI(c, 14);
        const macdVal = calculateMACD(c, 12, 26, 9);
        text += `\n📊 <b>${tf}</b> | ${rsiVal > 60 ? "Bullish 🟢" : rsiVal < 40 ? "Bearish 🔴" : "Sideways ⚪"}\n`;
        text += `💵 Price: ${l?.close ?? "-"} | Vol: ${l?.vol ?? "-"}\n📈 RSI: ${rsiVal?.toFixed?.(2) ?? "-"} | MACD: ${macdVal?.macd?.toFixed?.(2) ?? "-"} | ATR: ${atr.toFixed(2)}\n━━━━━━━━━━━━━━━━━━━\n`;
      } catch (err) {
        text += `\n📊 <b>${tf}</b> | Data N/A\n━━━━━━━━━━━━━━━━━━━\n`;
      }
    }

    text += `\n🧭 <b>Overall Bias:</b> ${merged.bias}\n`;
    text += `💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${ml?.prob ?? 50}%\n`;
    text += `🎯 TP1: ${(closePrice * 1.01).toFixed(2)} | TP2: ${(closePrice * 1.02).toFixed(2)} | SL: ${(closePrice * 0.99).toFixed(2)}\n`;
    text += `📰 News Impact: ${news?.impact ?? "Low"} (score ${news?.score ?? 0})\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n📊 Sources: Binance, CoinGecko, KuCoin`;

    return { text, data: { rsi, macd, ell, ml, merged, news } };
  } catch (err) {
    console.error("buildReport error:", err.message);
    return { text: `❌ Failed to build report for ${symbol}: ${err.message}` };
  }
}

// ===========================================================
// 🕒 Auto 15-Minute Telegram Update
// ===========================================================
async function autoUpdateLoop() {
  try {
    const symbol = CONFIG.SYMBOL || "BTCUSDT";
    const { text } = await buildReport(symbol, "15m");
    await sendTelegramMessage(text);
    console.log(`✅ Auto 15m update sent to Telegram for ${symbol}`);
  } catch (err) {
    console.error("⚠️ Auto update error:", err.message);
  }
}

// ===========================================================
// 🤖 Initialize Telegram Bot & Loops
// ===========================================================
(async () => {
  try {
    await setupTelegramBot();
    console.log("🤖 Telegram bot initialized.");
  } catch (e) {
    console.warn("setupTelegramBot error:", e.message);
  }

  // Initial send
  await autoUpdateLoop();

  // Schedule every 15m
  setInterval(autoUpdateLoop, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
})();

// ===========================================================
// ✅ Export for other modules
// ===========================================================
export { buildReport, autoUpdateLoop };
export default { buildReport, autoUpdateLoop };