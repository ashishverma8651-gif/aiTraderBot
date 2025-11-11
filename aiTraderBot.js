// aiTraderBot.js (main control)
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { nowLocal, fetchMarketData } from "./utils.js";

// ====== KeepAlive / Express Server (v9.5 style) ======
import express from "express";
import { keepAlive } from "./utils.js";

const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  // Ping every 5 min — same as v9.5
  setInterval(() => keepAlive(), 5 * 60 * 1000);
});

console.log("🤖 AI Trader Bot Starting...");
if (CONFIG.SELF_PING_URL) keepAlive(CONFIG.SELF_PING_URL);
await setupTelegramBot();

async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log("⏳ Fetching market data for", symbol, interval);
  const { data, source } = await fetchMarketData(symbol, interval, 500);
  if (!data || !data.length) {
    console.warn("⚠️ No market data!");
    return null;
  }

  // Compute indicators
  const rsi = calculateRSI(data, 14);
  const macd = calculateMACD(data, 12, 26, 9);
  const ell = analyzeElliott(data, interval);
  const ml = await runMLPrediction(data);
  const merged = mergeSignals({ rsi, macd }, ell, ml);
  const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);

  // simple TP/SL calculation based on ATR approx (use high-low)
  const last = data[data.length-1];
  const recent = data.slice(-20);
  const atr = recent.reduce((acc, k, i, arr) => {
    if (i===0) return acc;
    return acc + Math.max(k.high - k.low, Math.abs(k.high - arr[i-1].close), Math.abs(k.low - arr[i-1].close));
  }, 0) / Math.max(1, recent.length-1);
  const SL = Math.round(last.close - Math.sign(merged.bias === "Buy" ? 1 : -1) * atr*2);
  const TP1 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr*4);
  const TP2 = Math.round(last.close + (merged.bias === "Buy" ? 1 : -1) * atr*6);

  // Compose telegram message (HTML)
  let text = `🚀 <b>${symbol} — AI Trader v9.5</b>\n${nowLocal()}\nSource: ${source}\nPrice: ${last.close}\n\n`;
  text += `📊 <b>Elliott Wave (${interval})</b>\n${ell.structure} | Wave: ${ell.wave} | Confidence: ${ell.confidence}%\n\n`;
  text += `⚠️ <b>Possible Wave 5 Reversal</b> — watch for breakout confirmation.\n\n`;
  for (let tf of CONFIG.INTERVALS) {
    // show simple per-timeframe summary (reuse same data for now)
    text += `📈 ${tf} | Price: ${last.close} | RSI: ${rsi || "N/A"} | MACD: ${macd ? macd.macd : "N/A"} | ATR: ${Math.round(atr)} | ML: ${ml.prob}%\n`;
  }
  text += `\nBias: ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb}%\n\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\nBreakout zone (est): ${Math.round(last.close - atr*3)} - ${Math.round(last.close + atr*3)}\n\n`;
  text += `📰 News Impact: ${news.impact} (score ${news.score})\n`;
  if (news.headlines && news.headlines.length) {
    text += "News headlines:\n• " + news.headlines.join("\n• ") + "\n";
  }
  text += `\nSources: Binance, CoinGecko, KuCoin\n`;
  return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
}

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

// start now
generateReportLoop();
// schedule repeating every REPORT_INTERVAL_MS
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);

console.log("Main loop started. Reports every", CONFIG.REPORT_INTERVAL_MS / 60000, "minutes");