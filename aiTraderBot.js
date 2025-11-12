// aiTraderBot.js — v11 Pro Edition
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import express from "express";

// ---------------------------
// 🌐 KeepAlive Server
// ---------------------------
const app = express();
app.get("/", (_, res) => res.send("✅ AI Trader Bot is live"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 KeepAlive server running on port ${PORT}`));
setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 5 * 60 * 1000);

// ---------------------------
// Utility
// ---------------------------
function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}
function lastOf(a) {
  return Array.isArray(a) && a.length ? a[a.length - 1] : null;
}
function ensureCandles(raw) {
  if (!Array.isArray(raw)) return [];
  if (typeof raw[0] === "object") return raw;
  if (Array.isArray(raw[0])) {
    return raw.map(r => ({
      t: r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      vol: +r[5]
    }));
  }
  return [];
}

// ---------------------------
// 📊 Multi-timeframe Builder
// ---------------------------
async function multiTF(symbol) {
  const tfs = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
  const out = {};
  for (const tf of tfs) {
    try {
      const resp = await fetchMarketData(symbol, tf, 150);
      const candles = ensureCandles(resp.data);
      const last = lastOf(candles);
      const rsiVal = calculateRSI(candles, 14)?.value || 50;
      const macdObj = calculateMACD(candles, 12, 26, 9);
      const macdVal = macdObj?.macd || 0;
      const atr = candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14;
      const vol = safeNum(last?.vol, 0);
      const avgVol = candles.slice(-20).reduce((s, c) => s + (c.vol || 0), 0) / 20;
      const volTag =
        vol > avgVol * 1.5
          ? "🔥 High Volume"
          : vol < avgVol * 0.5
          ? "🧊 Low Volume"
          : "💠 Normal Volume";
      let bias = "Neutral ⚪";
      if (rsiVal > 60 && macdVal > 0) bias = "Bullish 🟢";
      else if (rsiVal < 40 && macdVal < 0) bias = "Bearish 🔴";

      out[tf] = {
        bias,
        price: last?.close?.toFixed(2),
        vol: vol.toFixed(0),
        volTag,
        rsi: rsiVal.toFixed(2),
        macd: macdVal.toFixed(2),
        atr: atr.toFixed(2)
      };
    } catch {
      out[tf] = { bias: "N/A", price: "-", vol: "-", volTag: "-", rsi: "-", macd: "-", atr: "-" };
    }
  }
  return out;
}

// ---------------------------
// 🎯 Full Report Builder
// ---------------------------
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  const resp = await fetchMarketData(symbol, interval, 500);
  const candles = ensureCandles(resp.data);
  const last = lastOf(candles);

  // Indicators
  const rsi = calculateRSI(candles, 14);
  const macd = calculateMACD(candles, 12, 26, 9);
  const ell = await analyzeElliott({ [interval]: candles });
  const ml = await runMLPrediction(candles);
  const merged = mergeSignals({ rsi, macd }, ell, ml);
  const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);

  // ATR
  const atr =
    candles.slice(-20).reduce((s, c, i, a) => {
      if (!i) return s;
      const p = a[i - 1];
      return s + Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }, 0) / 19;

  // Multi TF
  const tfData = await multiTF(symbol);

  // Hybrid targets
  const tp1 = (last.close * 1.007).toFixed(2);
  const tp2 = (last.close * 1.012).toFixed(2);
  const sl = (last.close * 0.992).toFixed(2);

  // ---------------------------
  // 📱 Telegram Message Format
  // ---------------------------
  let text = `━━━━━━━━━━━━━━━━━━━
🚀 <b>${symbol}</b> — <b>AI Trader Report</b>
🕒 ${nowLocal()}
🔗 Source: ${resp.source || "Binance"}
💰 Price: ${last.close.toFixed(2)}
━━━━━━━━━━━━━━━━━━━\n`;

  for (const [tf, d] of Object.entries(tfData)) {
    text += `📊 <b>${tf}</b> | ${d.bias}
💵 Price: ${d.price} | Vol: ${d.vol} (${d.volTag})
📈 RSI: ${d.rsi} | MACD: ${d.macd} | ATR: ${d.atr}\n━━━━━━━━━━━━━━━━━━━\n`;
  }

  text += `🧭 <b>Overall Bias:</b> ${merged.bias}
💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${ml.prob ?? 50}%
🎯 TP1: ${tp1} | TP2: ${tp2} | SL: ${sl}
━━━━━━━━━━━━━━━━━━━
📰 <b>News Impact:</b> ${news.impact ?? "N/A"} (score ${news.score ?? 0})
📚 Sources: Binance, CoinGecko, KuCoin
━━━━━━━━━━━━━━━━━━━`;

  return { text };
}

// ---------------------------
// 🔄 Auto 15-Minute Updates
// ---------------------------
async function autoUpdateLoop() {
  try {
    const symbol = CONFIG.SYMBOL || "BTCUSDT";
    const { text } = await buildReport(symbol, "15m");
    await sendTelegramMessage(text);
    console.log("✅ Auto 15 m update sent");
  } catch (err) {
    console.error("⚠️ AutoUpdate:", err.message);
  }
}

// ---------------------------
// 🚀 Initialize
// ---------------------------
(async () => {
  try {
    await setupTelegramBot();
    console.log("🤖 Telegram bot initialized.");
    await autoUpdateLoop(); // first run
    setInterval(autoUpdateLoop, 15 * 60 * 1000);
  } catch (e) {
    console.error("Init err:", e.message);
  }
})();

export { buildReport };