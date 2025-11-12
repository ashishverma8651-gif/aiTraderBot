// aiTraderBot.js — v10.2 (Enhanced Dashboard + Volume + RSI Zones)
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";

import express from "express";

// ----------------------
// 🌍 KeepAlive Server
// ----------------------
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

// ----------------------
// 📊 Multi-Timeframe Indicator Builder
// ----------------------
async function buildMultiTimeframeIndicators(symbol) {
  const timeframes = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
  const result = {};

  for (const tf of timeframes) {
    try {
      const resp = await fetchMarketData(symbol, tf, 200);
      const candles = Array.isArray(resp.data) ? resp.data : [];
      const valid = candles
        .map((c) => ({
          open: +c.o || +c.open,
          high: +c.h || +c.high,
          low: +c.l || +c.low,
          close: +c.c || +c.close,
          vol: +c.v || +c.volume || 0,
        }))
        .filter((x) => !isNaN(x.close));

      if (!valid.length) {
        result[tf] = { price: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", vol: "N/A" };
        continue;
      }

      const price = valid.at(-1)?.close ?? 0;
      const vol = valid.at(-1)?.vol ?? 0;
      const avgVol = valid.reduce((a, b) => a + (b.vol || 0), 0) / valid.length;

      // RSI
      let rsiRaw = calculateRSI(valid, 14);
      if (Array.isArray(rsiRaw)) rsiRaw = rsiRaw.at(-1);
      if (typeof rsiRaw === "object") rsiRaw = rsiRaw.value ?? Object.values(rsiRaw).at(-1);
      const rsi = typeof rsiRaw === "number" && !isNaN(rsiRaw) ? rsiRaw : NaN;

      // MACD
      let macdRaw = calculateMACD(valid, 12, 26, 9);
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
        valid.slice(-14).reduce((a, b) => a + (b.high - b.low), 0) /
        Math.max(1, valid.slice(-14).length - 1);

      // Bias + RSI condition
      let bias = "Sideways";
      if (rsi > 60 && macdVal > 0) bias = "Bullish";
      else if (rsi < 40 && macdVal < 0) bias = "Bearish";

      const emoji =
        bias === "Bullish" ? "🟢" :
        bias === "Bearish" ? "🔴" :
        "⚪";

      // RSI labels
      let rsiLabel = "Neutral";
      if (rsi <= 25) rsiLabel = "Deep Oversold";
      else if (rsi < 40) rsiLabel = "Oversold";
      else if (rsi > 70) rsiLabel = "Overbought";

      // Trend direction
      const direction = macdVal > 0 ? "⬆️" : macdVal < 0 ? "⬇️" : "↔️";
      const volTrend = vol > avgVol * 1.2 ? "⬆️" : vol < avgVol * 0.8 ? "⬇️" : "↔️";

      result[tf] = {
        price: price.toFixed(2),
        vol: vol.toFixed(0),
        rsi: !isNaN(rsi) ? rsi.toFixed(2) : "N/A",
        macd: !isNaN(macdVal) ? macdVal.toFixed(2) : "N/A",
        atr: !isNaN(atr) ? atr.toFixed(2) : "N/A",
        bias,
        emoji,
        direction,
        volTrend,
        rsiLabel,
      };
    } catch (err) {
      console.warn(`❌ ${tf} failed:`, err.message);
      result[tf] = { price: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", vol: "N/A" };
    }
  }

  return result;
}

// ----------------------
// 📈 Build AI Report
// ----------------------
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  const resp = await fetchMarketData(symbol, interval, 500);
  const data = Array.isArray(resp.data) ? resp.data : [];

  const valid = data
    .map((c) => ({
      t: +c.t || +c.time || Date.now(),
      open: +c.o || +c.open,
      high: +c.h || +c.high,
      low: +c.l || +c.low,
      close: +c.c || +c.close,
      vol: +c.v || +c.volume || 0,
    }))
    .filter((x) => !isNaN(x.close))
    .sort((a, b) => a.t - b.t);

  if (!valid.length) return null;

  const last = valid.at(-1);
  const recent = valid.slice(-20);
  let atr = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const k = recent[i];
    atr += Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
  }
  atr = atr / Math.max(1, recent.length - 1);

  let rsi, macd, ell, ml, merged, news;
  try { rsi = calculateRSI(valid, 14); } catch { rsi = "N/A"; }
  try { macd = calculateMACD(valid, 12, 26, 9); } catch { macd = "N/A"; }
  try { ell = await analyzeElliott(valid); } catch { ell = { wave: "N/A", confidence: 0 }; }
  try { ml = await runMLPrediction(valid); } catch { ml = { prob: 50 }; }
  try { merged = mergeSignals({ rsi, macd }, ell, ml); } catch { merged = { bias: "Neutral", strength: 0 }; }
  try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol); } catch { news = {}; }

  const multiTF = await buildMultiTimeframeIndicators(symbol);
  const SL = Math.round(last.close - atr * 2);
  const TP1 = Math.round(last.close + atr * 4);
  const TP2 = Math.round(last.close + atr * 6);

  // 🧠 Telegram Report Format
  let text = `━━━━━━━━━━━━━━━━━━━
🚀 <b>${symbol}</b> — <b>AI Trader Report</b>
🕒 ${nowLocal()}
📡 Source: ${resp.source || "multi-source"}
💰 <b>Price:</b> ${last.close.toFixed(2)}
━━━━━━━━━━━━━━━━━━━\n`;

  for (const tf of Object.keys(multiTF)) {
    const r = multiTF[tf];
    text += `📈 <b>${tf}</b> | <b>${r.bias}</b> ${r.emoji}
💵 Price: ${r.price} (${r.direction}) | 📊 Vol: ${r.vol} ${r.volTrend}
📊 RSI: ${r.rsi} (${r.rsiLabel}) | MACD: ${r.macd} | ATR: ${r.atr} | 🤖 ML: ${ml?.prob ?? 0}%
━━━━━━━━━━━━━━━━━━━\n`;
  }

  text += `🧭 <b>Overall Bias:</b> ${merged.bias}
💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${merged.mlProb ?? ml?.prob ?? 50}%
🎯 <b>Targets</b>
TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}
💥 Breakout Zone: ${Math.round(last.close - atr * 3)} – ${Math.round(last.close + atr * 3)}

📰 <b>News Impact:</b> ${news.impact ?? "N/A"} (score ${news.score ?? 0})
`;

  if (news.headlines?.length) {
    text += "🗞️ <b>Top Headlines:</b>\n• " + news.headlines.slice(0, 3).join("\n• ") + "\n";
  }

  text += `\n📊 <i>Sources:</i> Binance, CoinGecko, KuCoin
━━━━━━━━━━━━━━━━━━━`;

  return { text };
}

// ----------------------
// 🔁 Report Loop
// ----------------------
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