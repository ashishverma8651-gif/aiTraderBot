// aiTraderBot.js — hardened + extended main
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
// Extended Multi-Timeframe Builder
// ----------------------
async function buildMultiTimeframeIndicators(symbol) {
  const timeframes = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
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
        }))
        .filter((x) => !isNaN(x.close));

      if (!valid.length) {
        result[tf] = { rsi: "N/A", macd: "N/A", atr: "N/A", price: "N/A" };
        continue;
      }

      const price = valid.at(-1)?.close ?? 0;

// --- Normalize RSI safely ---
let rsiRaw = calculateRSI(valid, 14);
if (Array.isArray(rsiRaw)) rsiRaw = rsiRaw.at(-1);
if (typeof rsiRaw === "object" && rsiRaw !== null)
  rsiRaw = rsiRaw.value ?? Object.values(rsiRaw).at(-1);
const rsi = typeof rsiRaw === "number" && !isNaN(rsiRaw) ? rsiRaw : NaN;


// --- Normalize MACD safely ---
let macdRaw = calculateMACD(valid, 12, 26, 9);
let macdVal = NaN;

if (macdRaw) {
  if (typeof macdRaw === "number") {
    macdVal = macdRaw;
  } else if (Array.isArray(macdRaw)) {
    const last = macdRaw.at(-1);
    macdVal = typeof last === "object" ? last.macd ?? NaN : last ?? NaN;
  } else if (typeof macdRaw === "object") {
    if (Array.isArray(macdRaw.macd)) macdVal = macdRaw.macd.at(-1) ?? NaN;
    else if (typeof macdRaw.macd === "number") macdVal = macdRaw.macd;
  }
}


// --- Compute ATR ---
const atr =
  valid.slice(-14).reduce((a, b) => a + (b.high - b.low), 0) /
  Math.max(1, valid.slice(-14).length - 1);

// --- Save results safely ---
result[tf] = {
  price: price.toFixed(2),
  rsi: !isNaN(rsi) ? rsi.toFixed(2) : "N/A",
  macd: !isNaN(macdVal) ? macdVal.toFixed(2) : "N/A",
  atr: !isNaN(atr) ? atr.toFixed(2) : "N/A",
};

    } catch (err) {
      console.warn(`❌ ${tf} failed:`, err.message);
      result[tf] = { rsi: "N/A", macd: "N/A", atr: "N/A", price: "N/A" };
    }
  }

  return result;
}

// ----------------------
// Build report (safe)
// ----------------------
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  console.log("⏳ Fetching market data for", symbol, interval);
  const resp = await fetchMarketData(symbol, interval, 500);
  const data = Array.isArray(resp.data) ? resp.data : [];

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
    .sort((a, b) => a.t - b.t);

  if (!valid.length) {
    console.warn("⚠️ No valid candles after normalization for", symbol);
    return null;
  }

  const last = valid[valid.length - 1];
  const recent = valid.slice(-20);

  // Safe ATR
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

  // indicators
  let rsi = null,
    macd = null,
    ell = { structure: "N/A", wave: "N/A", confidence: 0 },
    ml = { prob: 50 },
    merged = { bias: "Neutral", strength: 0, mlProb: 50 },
    news = { impact: "N/A", score: 0, headlines: [] };

  try {
    rsi = calculateRSI(valid, 14);
  } catch (e) {
    console.warn("RSI calc failed:", e.message);
  }

  try {
    macd = calculateMACD(valid, 12, 26, 9);
  } catch (e) {
    console.warn("MACD calc failed:", e.message);
  }

  try {
    ell = await analyzeElliott(valid);
  } catch (e) {
    console.warn("Elliott analysis failed:", e.message);
  }

  try {
    ml = await runMLPrediction(valid);
  } catch (e) {
    console.warn("ML prediction failed:", e.message);
  }

  try {
    merged = mergeSignals({ rsi, macd }, ell, ml);
  } catch (e) {
    console.warn("mergeSignals error:", e.message);
  }

  try {
    news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
  } catch (e) {
    console.warn("fetchNews failed:", e.message);
  }

  const multiTF = await buildMultiTimeframeIndicators(symbol);

  // Safe TP/SL
  const biasSign = merged?.bias === "Buy" ? 1 : merged?.bias === "Sell" ? -1 : 1;
  const SL = Math.round(last.close - Math.sign(biasSign) * atr * 2);
  const TP1 = Math.round(last.close + biasSign * atr * 4);
  const TP2 = Math.round(last.close + biasSign * atr * 6);


  // 🧠 Build Telegram Report (Professional Dashboard Style)
let text = `━━━━━━━━━━━━━━━━━━━
🚀 <b>${symbol}</b> — <b>AI Trader Report</b>
🕒 ${nowLocal()}
📡 Source: ${resp.source || "multi-source"}
💰 <b>Price:</b> ${last.close.toFixed(2)}
━━━━━━━━━━━━━━━━━━━\n`;

for (const tf of Object.keys(multiTF)) {
  const r = multiTF[tf];
  const rsi = r.rsi ?? "N/A";
  const macd = r.macd ?? "N/A";
  const atr = r.atr ?? "N/A";

  // Dynamic bias estimation
  let bias = "Sideways";
  if (Number(rsi) > 60 && Number(macd) > 0) bias = "Bullish";
  else if (Number(rsi) < 40 && Number(macd) < 0) bias = "Bearish";

  const emoji =
    bias === "Bullish" ? "🟢" :
    bias === "Bearish" ? "🔴" :
    "⚪";

  text += `📈 <b>${tf}</b> | <b>${bias}</b> ${emoji}
💵 Price: ${r.price} | 📊 Vol: ${r.vol ?? "—"}
📊 RSI: ${rsi} | MACD: ${macd} | ATR: ${atr} | 🤖 ML: ${ml?.prob ?? 0}%
━━━━━━━━━━━━━━━━━━━\n`;
}

text += `🧭 <b>Overall Bias:</b> ${merged.bias}
💪 Strength: ${merged.strength}% | 🤖 ML Prob: ${merged.mlProb}% | 📈 Accuracy(10): ${ml?.accuracy ?? "N/A"}%

🎯 <b>Targets</b>
TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}
💥 Breakout Zone: ${Math.round(last.close - atr * 3)} – ${Math.round(last.close + atr * 3)}

📰 <b>News Impact:</b> ${news.impact ?? "N/A"} (score ${news.score ?? 0})
`;

if (news.headlines && news.headlines.length) {
  text += "🗞️ <b>Top Headlines:</b>\n• " + news.headlines.slice(0, 5).join("\n• ") + "\n";
}

text += `\n📊 <i>Sources:</i> Binance, CoinGecko, KuCoin
━━━━━━━━━━━━━━━━━━━`;


  return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
}

// ----------------------
// Report loop
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
    try {
      await sendTelegramMessage(`❌ Error generating report: ${e.message}`);
    } catch (e2) {
      console.warn("Failed to send error to Telegram:", e2.message);
    }
  }
}

// start
generateReportLoop();
setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);
console.log("Main loop started. Reports every", CONFIG.REPORT_INTERVAL_MS / 60000, "minutes");