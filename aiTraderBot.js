// aiTraderBot.js — safe main (replace your current one)
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
  setInterval(() => keepAlive(), 5 * 60 * 1000);
});

console.log("🤖 AI Trader Bot Starting...");
if (CONFIG.SELF_PING_URL) keepAlive(CONFIG.SELF_PING_URL);
await setupTelegramBot().catch(err => console.warn("Telegram init failed:", err?.message || err));

async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log("⏳ Fetching market data for", symbol, interval);
  const out = await fetchMarketData(symbol, interval, 500);
  const data = Array.isArray(out?.data) ? out.data : [];
  const source = out?.source || "unknown";

  // Safety checks
  if (!data || !Array.isArray(data) || data.length < 5) {
    console.warn("⚠️ Not enough market data for", symbol, "len:", data?.length);
    return null;
  }

  // ensure every candle has numeric close
  const safeData = data.filter(c => c && typeof c.close === "number" && !Number.isNaN(c.close));
  if (!safeData || safeData.length < 5) {
    console.warn("⚠️ No valid candles after filtering for", symbol, "len:", safeData?.length);
    return null;
  }

  // use safeData for all calculations
  const last = safeData[safeData.length - 1];
  const recent = safeData.slice(-20);

  // ATR approx (safe)
  let atr = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const k = recent[i];
    const trueRange = Math.max(
      k.high - k.low,
      Math.abs(k.high - (prev.close ?? k.close)),
      Math.abs(k.low - (prev.close ?? k.close))
    );
    atr += Number.isFinite(trueRange) ? trueRange : 0;
  }
  atr = atr / Math.max(1, recent.length - 1);

  // indicators (core functions expect array of candles with close)
  const rsi = calculateRSI(safeData, 14) ?? { value: null, summary: "NoData" };
  const macd = calculateMACD(safeData, 12, 26, 9) ?? { macd: null, signal: null, histogram: [], summary: "NoData" };

  // elliott can accept safeData directly (module handles normalization)
  const ell = await (async () => {
    try { return await analyzeElliott(safeData, { verbose: false }); }
    catch (e) { console.warn("Elliott analysis failed:", e?.message || e); return { ok: false, summary: "error" }; }
  })();

  // ML prediction: guard with try/catch
  let ml = { prob: 50, label: "N/A" };
  try {
    const mlr = await runMLPrediction(safeData);
    if (mlr && typeof mlr.prob === "number") ml = mlr;
  } catch (e) {
    console.warn("ML prediction failed:", e?.message || e);
  }

  // Merge signals
  const merged = mergeSignals({ rsi: rsi?.value ?? null, macd }, ell, ml);

  // News (best-effort)
  let news = { impact: "N/A", score: 0, headlines: [] };
  try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol); } catch (e) { /* ignore */ }

  // TP/SL
  const sign = merged.bias === "Buy" ? 1 : merged.bias === "Sell" ? -1 : 1;
  const SL = Math.round(last.close - Math.sign(sign) * atr * 2);
  const TP1 = Math.round(last.close + sign * atr * 4);
  const TP2 = Math.round(last.close + sign * atr * 6);

  // build message
  let text = `🚀 <b>${symbol} — AI Trader v9.6 (patched)</b>\n${nowLocal()}\nSource: ${source}\nPrice: ${last.close}\n\n`;
  text += `📊 <b>Elliott Wave (${interval})</b>\n${ell?.summary ?? "N/A"}\n\n`;
  text += `⚠️ <b>Possible Wave reversal checks — validate before trading</b>\n\n`;

  for (const tf of CONFIG.INTERVALS || ["15m"]) {
    text += `📈 ${tf} | Price: ${last.close} | RSI: ${rsi?.value ? Math.round(rsi.value) : "N/A"} | MACD: ${Array.isArray(macd.macd) ? (macd.histogram?.slice(-1)[0] ?? "N/A") : "N/A"} | ATR: ${Math.round(atr)} | ML: ${ml?.prob ?? 50}%\n`;
  }

  text += `\nBias: ${merged.bias} | Strength: ${merged.strength ?? 0}% | ML Prob: ${merged.mlProb ?? (ml?.prob ?? 50)}%\n\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\nBreakout zone (est): ${Math.round(last.close - atr * 3)} - ${Math.round(last.close + atr * 3)}\n\n`;
  text += `📰 News Impact: ${news?.impact ?? "N/A"} (score ${news?.score ?? 0})\n`;
  if (news?.headlines?.length) text += "News headlines:\n• " + news.headlines.join("\n• ") + "\n";

  text += `\nSources: Binance, Yahoo, KuCoin (fallbacks)\n`;

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
    console.error("Report error:", e?.message || e);
    try { await sendTelegramMessage(`❌ Error generating report: ${e?.message || e}`); } catch {}
  }
}

// start
generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
console.log("Main loop started. Reports every", (CONFIG.REPORT_INTERVAL_MS || 900000) / 60000, "minutes");