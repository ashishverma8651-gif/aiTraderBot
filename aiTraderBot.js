import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import express from "express";

// ===============================
// 🌍 KeepAlive Server
// ===============================
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 10 * 60 * 1000);
});

console.log("🤖 AI Trader Bot Starting...");
await keepAlive(CONFIG.SELF_PING_URL);
await setupTelegramBot();

// ===============================
// 📊 Multi-Timeframe Indicators
// ===============================
async function buildMultiTimeframeIndicators(symbol) {
  const tfs = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
  const res = {};

  for (const tf of tfs) {
    try {
      const resp = await fetchMarketData(symbol, tf, 200);
      const candles = resp.data || [];
      if (!candles.length) {
        res[tf] = { rsi: "N/A", macd: "N/A", atr: "N/A", vol: "N/A", bias: "N/A" };
        continue;
      }

      const price = candles.at(-1)?.close ?? 0;
      const vol = candles.at(-1)?.vol ?? 0;
      const avgVol = candles.reduce((a, b) => a + (b.vol || 0), 0) / candles.length;
      const volLabel = resp.volume?.label || (vol > avgVol * 1.5 ? "🔥 High Volume" : "Normal");

      // RSI
      let rsiVal = calculateRSI(candles, 14);
      if (Array.isArray(rsiVal)) rsiVal = rsiVal.at(-1);
      if (typeof rsiVal === "object") rsiVal = rsiVal.value ?? Object.values(rsiVal).at(-1);

      // MACD
      let macdRaw = calculateMACD(candles, 12, 26, 9);
      let macdVal = NaN;
      if (macdRaw) {
        if (typeof macdRaw === "number") macdVal = macdRaw;
        else if (Array.isArray(macdRaw)) macdVal = macdRaw.at(-1)?.macd ?? macdRaw.at(-1);
        else if (typeof macdRaw === "object")
          macdVal = Array.isArray(macdRaw.macd)
            ? macdRaw.macd.at(-1)
            : macdRaw.macd ?? NaN;
      }

      // ATR
      const atr =
        candles.slice(-14).reduce((a, b) => a + (b.high - b.low), 0) /
        Math.max(1, candles.slice(-14).length - 1);

      // Bias
      let bias = "Sideways";
      if (rsiVal > 60 && macdVal > 0) bias = "Bullish";
      else if (rsiVal < 40 && macdVal < 0) bias = "Bearish";

      const emoji =
        bias === "Bullish" ? "🟢" :
        bias === "Bearish" ? "🔴" : "⚪";

      // RSI Zone
      let rsiZone = "Neutral";
      if (rsiVal <= 25) rsiZone = "Deep Oversold";
      else if (rsiVal < 40) rsiZone = "Oversold";
      else if (rsiVal > 70) rsiZone = "Overbought";

      res[tf] = {
        price: price.toFixed(2),
        rsi: rsiVal.toFixed(2),
        macd: macdVal.toFixed(2),
        atr: atr.toFixed(2),
        vol: vol.toFixed(0),
        volLabel,
        bias,
        emoji,
        rsiZone
      };
    } catch (err) {
      console.warn(`❌ ${tf} failed:`, err.message);
      res[tf] = { rsi: "N/A", macd: "N/A", atr: "N/A", vol: "N/A", bias: "N/A" };
    }
  }

  return res;
}

// ===============================
// 🧠 Main Report Builder
// ===============================
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  const resp = await fetchMarketData(symbol, interval, 500);
  const candles = resp.data || [];
  if (!candles.length) return null;

  const last = candles.at(-1);
  const atr =
    candles.slice(-14).reduce((a, b) => a + (b.high - b.low), 0) /
    Math.max(1, candles.slice(-14).length - 1);

  let rsi, macd, ell, ml, merged, news;
  try { rsi = calculateRSI(candles, 14); } catch { rsi = "N/A"; }
  try { macd = calculateMACD(candles, 12, 26, 9); } catch { macd = "N/A"; }
  try { ell = await analyzeElliott(candles); } catch { ell = {}; }
  try { ml = await runMLPrediction(candles); } catch { ml = { prob: 50 }; }
  try { merged = mergeSignals({ rsi, macd }, ell, ml); } catch { merged = { bias: "Neutral" }; }
  try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol); } catch { news = {}; }

  const multiTF = await buildMultiTimeframeIndicators(symbol);
  const SL = Math.round(last.close - atr * 2);
  const TP1 = Math.round(last.close + atr * 4);
  const TP2 = Math.round(last.close + atr * 6);

  // 🧠 REVERSAL WATCHER ALERT
  let reversalMsg = "";
  const rsiVal = typeof rsi === "number" ? rsi : (rsi?.value ?? 50);
  if (rsiVal < 30 && merged.bias === "Buy") reversalMsg = "📈 Possible Oversold Reversal (Watch Long Entry)";
  else if (rsiVal > 70 && merged.bias === "Sell") reversalMsg = "📉 Possible Overbought Reversal (Watch Short Entry)";

  // Telegram Dashboard
  let text = `━━━━━━━━━━━━━━━━━━━
🚀 <b>${symbol}</b> — <b>AI Trader Report</b>
🕒 ${nowLocal()}
📡 Source: ${resp.source}
💰 Price: ${last.close.toFixed(2)}
📦 Volume: ${resp.volume?.label || "Normal"} (${resp.volume?.current}/${resp.volume?.avg})
━━━━━━━━━━━━━━━━━━━\n`;

  for (const tf of Object.keys(multiTF)) {
    const r = multiTF[tf];
    text += `📊 <b>${tf}</b> | ${r.bias} ${r.emoji}
💵 Price: ${r.price} | Vol: ${r.vol} (${r.volLabel})
📈 RSI: ${r.rsi} (${r.rsiZone}) | MACD: ${r.macd} | ATR: ${r.atr}
━━━━━━━━━━━━━━━━━━━\n`;
  }

  text += `🧭 <b>Overall Bias:</b> ${merged.bias}
💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${merged.mlProb ?? ml.prob ?? 50}%
🎯 TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}

${reversalMsg ? "⚠️ <b>Reversal Alert:</b> " + reversalMsg + "\n\n" : ""}
📰 News Impact: ${news.impact ?? "N/A"} (score ${news.score ?? 0})
📊 Sources: Binance, CoinGecko, KuCoin
━━━━━━━━━━━━━━━━━━━`;

  return { text };
}

// ===============================
// 🔁 Loop Runner
// ===============================
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (e) {
    console.error("Report error:", e.message);
    await sendTelegramMessage(`❌ Error generating report: ${e.message}`);
  }
}

generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);
console.log("Main loop started. Reports every", CONFIG.REPORT_INTERVAL_MS / 60000, "minutes");