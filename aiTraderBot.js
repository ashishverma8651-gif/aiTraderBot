// aiTraderBot.js — hardened main (paste over your existing file)
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";

import express from "express";

const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  setInterval(() => keepAlive(), 10 * 60 * 1000);
});

console.log("🤖 AI Trader Bot Starting...");
await keepAlive(CONFIG.SELF_PING_URL);
setInterval(async () => await keepAlive(CONFIG.SELF_PING_URL), 10 * 60 * 1000);
await setupTelegramBot();

// ----------------------
// Safe helper
// ----------------------
function isValidCandle(c) {
  return c && (typeof c.close === "number" || !isNaN(Number(c.close)));
}

// ----------------------
// Build report (safe)
// ----------------------
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log("⏳ Fetching market data for", symbol, interval);
  const resp = await fetchMarketData(symbol, interval, 500);
  const data = Array.isArray(resp.data) ? resp.data : [];

  // Normalize: ensure numeric close/high/low/open/vol
  const valid = data
    .map((c) => {
      if (!c) return null;
      const close = Number(c.close ?? c.c ?? NaN);
      const open = Number(c.open ?? c.o ?? NaN);
      const high = Number(c.high ?? c.h ?? NaN);
      const low = Number(c.low ?? c.l ?? NaN);
      const vol = Number(c.vol ?? c.v ?? c.volume ?? 0);
      if (Number.isNaN(close) || Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low)) return null;
      return { t: Number(c.t ?? c.time ?? Date.now()), open, high, low, close, vol };
    })
    .filter(Boolean)
    .sort((a,b) => a.t - b.t);

  if (!valid.length) {
    console.warn("⚠️ No valid candles after normalization for", symbol);
    return null;
  }

  const last = valid[valid.length - 1];
  const recent = valid.slice(-20);

  // Safe ATR
  let atr = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i-1];
    const k = recent[i];
    atr += Math.max(
      k.high - k.low,
      Math.abs(k.high - (prev?.close ?? k.close)),
      Math.abs(k.low - (prev?.close ?? k.close))
    );
  }
  atr = atr / Math.max(1, recent.length - 1);

  // indicators - wrap in try/catch so any indicator error doesn't crash the loop
  let rsi = null, macd = null, ell = { structure: "N/A", wave: "N/A", confidence: 0 }, ml = { prob: 50 }, merged = { bias: "Neutral", strength: 0, mlProb: 50 }, news = { impact: "N/A", score: 0, headlines: [] };
  try {
    rsi = calculateRSI(valid, 14);
  } catch (e) {
    console.warn("RSI calc failed:", e.message || e);
  }
  try {
    macd = calculateMACD(valid, 12, 26, 9);
  } catch (e) {
    console.warn("MACD calc failed:", e.message || e);
  }
  try {
    ell = await analyzeElliott(valid, { /* pass interval if needed */ });
  } catch (e) {
    console.warn("Elliott analysis failed:", e.message || e);
  }
  try {
    ml = await runMLPrediction(valid) || ml;
  } catch (e) {
    console.warn("ML prediction failed:", e.message || e);
  }

  try {
    merged = mergeSignals({ rsi, macd }, ell, ml);
  } catch (e) {
    console.warn("mergeSignals error:", e.message || e);
    merged = { bias: "Neutral", strength: 0, mlProb: ml?.prob || 50 };
  }

  try {
    news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
  } catch (e) {
    console.warn("fetchNews failed:", e.message || e);
  }

  // Safe TP/SL
  const biasSign = merged?.bias === "Buy" ? 1 : (merged?.bias === "Sell" ? -1 : 1);
  const SL = Math.round(last.close - Math.sign(biasSign) * atr * 2);
  const TP1 = Math.round(last.close + biasSign * atr * 4);
  const TP2 = Math.round(last.close + biasSign * atr * 6);

  // Compose telegram message safely (use fallback values)
  const rsiVal = (rsi && (typeof rsi === "object" ? (rsi.value ?? rsiValue) : rsi)) ?? "N/A";
  const macdSummary = macd ? (Array.isArray(macd.macd) ? macd.macd[macd.macd.length-1] : macd.macd) : "N/A";

  let text = `🚀 <b>${symbol} — AI Trader</b>\n${nowLocal()}\nSource: ${resp.source || "unknown"}\nPrice: ${last.close}\n\n`;
  text += `📊 <b>Elliott Wave (${interval})</b>\n${ell?.summary ?? ell.structure ?? "N/A"} | Wave: ${ell?.wave ?? "N/A"} | Confidence: ${ell?.confidence ?? 0}%\n\n`;
  text += `⚠️ <b>Possible Wave 5 Reversal</b> — watch for breakout confirmation.\n\n`;

  for (let tf of CONFIG.INTERVALS) {
    text += `📈 ${tf} | Price: ${last.close} | RSI: ${rsiVal} | MACD: ${typeof macdSummary === "number" ? macdSummary.toFixed(2) : macdSummary} | ATR: ${Math.round(atr)} | ML: ${ml?.prob ?? 0}%\n`;
  }

  text += `\nBias: ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb}%\n\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\nBreakout zone (est): ${Math.round(last.close - atr*3)} - ${Math.round(last.close + atr*3)}\n\n`;

  text += `📰 News Impact: ${news.impact ?? "N/A"} (score ${news.score ?? 0})\n`;
  if (news.headlines && news.headlines.length) {
    text += "News headlines:\n• " + news.headlines.join("\n• ") + "\n";
  }
  text += `\nSources: Binance, CoinGecko, KuCoin\n`;

  return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
}

// ----------------------
// Report loop
// ----------------------
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      console.warn("generateReportLoop: no report produced (no data)");
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (e) {
    console.error("Report error:", e.message || e);
    try {
      await sendTelegramMessage(`❌ Error generating report: ${e.message || e}`);
    } catch (e2) {
      console.warn("Failed to send error to Telegram:", e2.message || e2);
    }
  }
}

// start
generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);

console.log("Main loop started. Reports every", CONFIG.REPORT_INTERVAL_MS / 60000, "minutes");