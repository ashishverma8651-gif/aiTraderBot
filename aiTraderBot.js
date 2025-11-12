// aiTraderBot.js — Unified main control (v10.x)
// ----------------------------------------------------
// Requires:
// ./config.js, ./utils.js, ./core_indicators.js,
// ./elliott_module.js, ./ml_module_v8_6.js,
// ./merge_signals.js, ./news_social.js, ./tg_commands.js

import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import express from "express";

// =====================================================
// 🌍 KEEP ALIVE SERVER (for Render/Railway)
// =====================================================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 KeepAlive server running on port ${PORT}`));

(async () => {
  try { await keepAlive(CONFIG.SELF_PING_URL); } catch(e){ console.warn("keepAlive init:", e.message); }
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 5 * 60 * 1000);
})();

// =====================================================
// 🧩 SAFE HELPERS
// =====================================================
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function lastOf(arr) { return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null; }

// =====================================================
// 🕯️ REVERSAL WATCHER (1m updates)
// =====================================================
async function reversalWatcher() {
  try {
    const resp = await fetchMarketData(CONFIG.SYMBOL, "1m", 150);
    const candles = resp.data || [];
    if (!candles.length) return;
    const last = candles.at(-1);
    const prev = candles.at(-2) || last;

    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const isDoji = body <= range * 0.15;
    const isHammer = (last.low < last.open && last.low < last.close && (last.high - Math.max(last.open, last.close)) < range * 0.25);
    const isShooting = (last.high > last.open && last.high > last.close && (Math.min(last.open, last.close) - last.low) < range * 0.25);

    const avgVol = candles.slice(-20).reduce((s, c) => s + (c.vol || 0), 0) / 20;
    const volSpike = (last.vol || 0) > avgVol * 1.8;

    if ((isDoji || isHammer || isShooting) && volSpike) {
      const dir = isHammer ? "Bullish" : isShooting ? "Bearish" : "Neutral";
      const msg = `🚨 <b>Reversal Watcher</b>\n${nowLocal()}\nSymbol: <b>${CONFIG.SYMBOL}</b>\nPattern: <b>${dir}</b>\nPrice: ${last.close}\nVol Spike: ${Math.round(last.vol)} vs ${Math.round(avgVol)}`;
      await sendTelegramMessage(msg);
    }
  } catch (err) {
    console.warn("reversalWatcher error:", err.message);
  }
}
setInterval(reversalWatcher, 60 * 1000);

// =====================================================
// 📊 MULTI-TIMEFRAME INDICATOR BUILDER
// =====================================================
async function buildMultiTimeframeIndicators(symbol) {
  const tfs = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
  const out = {};
  for (const tf of tfs) {
    try {
      const resp = await fetchMarketData(symbol, tf, 200);
      const candles = resp.data || [];
      if (!candles.length) continue;
      const last = lastOf(candles);
      const rsiVal = calculateRSI(candles, 14);
      const macdVal = calculateMACD(candles, 12, 26, 9);
      const atr = candles.slice(-14).reduce((a, b) => a + (b.high - b.low), 0) / 14;
      let bias = "Sideways";
      if (rsiVal > 60 && macdVal > 0) bias = "Bullish";
      else if (rsiVal < 40 && macdVal < 0) bias = "Bearish";

      out[tf] = {
        price: last.close.toFixed(2),
        vol: last.vol?.toFixed(0) || "N/A",
        rsi: rsiVal?.toFixed?.(2) || "N/A",
        macd: macdVal?.toFixed?.(3) || "N/A",
        atr: atr.toFixed(3),
        bias
      };
    } catch (err) {
      console.warn("TF error:", tf, err.message);
    }
  }
  return out;
}

// =====================================================
// 🧠 MAIN REPORT BUILDER
// =====================================================
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    const resp = await fetchMarketData(symbol, interval, 500);
    const candles = resp.data || [];
    if (!candles.length) return null;

    const last = lastOf(candles);
    const rsi = calculateRSI(candles, 14);
    const macd = calculateMACD(candles, 12, 26, 9);
    const ell = await analyzeElliott(candles);
    const ml = await runMLPrediction(candles);
    const merged = mergeSignals({ rsi, macd }, ell, ml);
    const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
    const multiTF = await buildMultiTimeframeIndicators(symbol);

    let text = "━━━━━━━━━━━━━━━━━━━\n";
    text += `🚀 <b>${symbol}</b> — <b>AI Trader Report</b>\n🕒 ${nowLocal()}\n💰 Price: ${last.close.toFixed(2)}\n━━━━━━━━━━━━━━━━━━━\n`;
    for (const tf of Object.keys(multiTF)) {
      const r = multiTF[tf];
      text += `📊 <b>${tf}</b> | ${r.bias}\n💵 Price: ${r.price} | Vol: ${r.vol}\nRSI: ${r.rsi} | MACD: ${r.macd} | ATR: ${r.atr}\n━━━━━━━━━━━━━━━━━━━\n`;
    }
    text += `🧭 <b>Overall Bias:</b> ${merged.bias}\n💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${merged.mlProb ?? ml.prob ?? 50}%\n📰 News Impact: ${news.impact ?? "N/A"} (score ${news.score ?? 0})\n━━━━━━━━━━━━━━━━━━━`;

    return { text };
  } catch (err) {
    console.error("buildReport error:", err.message);
    return null;
  }
}

// =====================================================
// 🔁 REPORT LOOP RUNNER
// =====================================================
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (e) {
    console.error("Report error:", e.message);
    await sendTelegramMessage(`❌ Report generation failed: ${e.message}`);
  }
}

// =====================================================
// 🚀 AUTO UPDATE LOOP (Fixed)
// =====================================================
async function autoUpdateLoop() {
  try {
    const symbol = CONFIG.SYMBOL || "BTCUSDT";
    const resp = await fetchMarketData(symbol, "15m", 300);
    const candles = resp.data || [];
    if (!candles.length) return;

    const last = lastOf(candles);
    const rsi = calculateRSI(candles, 14);
    const macd = calculateMACD(candles, 12, 26, 9);
    const ell = await analyzeElliott(candles);
    const ml = await runMLPrediction(candles);
    const merged = mergeSignals({ rsi, macd }, ell, ml);

    const msg = `
━━━━━━━━━━━━━━━━━━━
📊 <b>${symbol}</b> — 15m Auto Update
🕒 ${nowLocal()}
━━━━━━━━━━━━━━━━━━━
📈 <b>Bias:</b> ${merged.bias}
💪 <b>Strength:</b> ${merged.strength}%
🤖 <b>ML Prob:</b> ${merged.mlProb ?? ml.prob ?? 50}%
📉 <b>RSI:</b> ${typeof rsi === "object" ? rsi.value?.toFixed(2) : rsi?.toFixed?.(2) || "N/A"}
📈 <b>MACD:</b> ${typeof macd === "object" ? macd.macd?.toFixed(3) : macd?.toFixed?.(3) || "N/A"}
💰 <b>Price:</b> ${last.close.toFixed(2)}
━━━━━━━━━━━━━━━━━━━
🕒 Next Auto Update: 15m later
━━━━━━━━━━━━━━━━━━━
`;
    await sendTelegramMessage(msg);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (err) {
    console.error("⚠️ Auto update error:", err.message);
  }
}

// =====================================================
// ⏱️ INITIALIZE BOT + LOOPS
// =====================================================
(async () => {
  try {
    await setupTelegramBot();
    console.log("🤖 Telegram bot initialized.");
  } catch (e) { console.warn("setupTelegramBot error:", e.message); }

  await generateReportLoop();
  setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);

  // Auto 15-minute updates
  await autoUpdateLoop();
  setInterval(autoUpdateLoop, 15 * 60 * 1000);
})();

// =====================================================
// EXPORTS
// =====================================================
export { buildReport, generateReportLoop, autoUpdateLoop, reversalWatcher };
export default { buildReport, generateReportLoop, autoUpdateLoop, reversalWatcher };