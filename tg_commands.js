// =============================================================
// tg_commands.js — FINAL FULL VERSION
// Old-Style Imports EXACTLY like Your Repo
// No TelegramBot imports
// Works with aiTraderBot.js auto-report
// =============================================================

// -------------------------
// OLD IMPORT STYLE (Correct)
// -------------------------
import ML from "./ml_module_v8_6.js";      // ✔ EXACT as your repo
import News from "./news_social.js";       // ✔ EXACT as your repo

import CONFIG from "./config.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// -------------------------
// Extract ML Functions
// -------------------------
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordOutcome,
  recordPrediction
} = ML;

// -------------------------
// Extract News Functions
// -------------------------
const { fetchNewsBundle } = News;

// -------------------------
// Generic helpers
// -------------------------
const NF = (n, d = 2) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "N/A";

function nowIST() {
  return new Date().toLocaleString("en-IN", {
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

// =============================================================
// TIMEFRAME BLOCK (EXACT UI YOU PROVIDED)
// =============================================================
function tfBlock(tf, o) {
  return `
🕒 ${tf} — ${o.sig}
RSI ${o.rsi} | MACD ${o.macd} | Vol ${o.vol} | ATR ${o.atr}
Elliott: ${o.ell} | Conf ${o.ellConf}%
S: ${o.s} | R: ${o.r}
TP 🎯: ${o.tpLine}
SL: ${o.sl}
`.trim();
}

// =============================================================
// BUILD AI REPORT (RAW DATA GENERATOR)
// =============================================================
export async function buildAIReport(symbol = CONFIG.SYMBOL) {
  try {
    const multi = await fetchMultiTF(symbol);

    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    let tfObj = {};

    for (const tf of tfs) {
      const d = multi[tf];

      const rsi = indicators.calcRSI(d);
      const macd = indicators.calcMACD(d);
      const atr = indicators.calcATR(d);
      const vol = indicators.volSignal(d);
      const ell = analyzeElliott(d);

      tfObj[tf] = {
        sig: ell.signalIcon || "⚪",
        rsi: NF(rsi),
        macd: NF(macd),
        atr: NF(atr),
        vol: vol || "N/A",
        ell: ell.pattern || "-",
        ellConf: ell.confidence || 0,
        s: NF(d.support),
        r: NF(d.resistance),
        tps: d.tpList || [],
        sl: NF(d.sl || 0),
      };
    }

    // ML + Micro
    const ml = await runMLPrediction(symbol);
    const micro = await runMicroPrediction(symbol);

    // News
    const news = await fetchNewsBundle(symbol);

    return {
      symbol,
      price: multi.price,
      time: nowIST(),
      tf: tfObj,
      ml,
      micro,
      news
    };

  } catch (err) {
    console.log("buildAIReport ERROR:", err.message);
    return null;
  }
}

// =============================================================
// FORMAT AI REPORT → EXACT FINAL UI (Your Saved Version)
// =============================================================
export async function formatAIReport(raw) {
  if (!raw) return "<b>⚠️ Empty Report</b>";

  const { symbol, price, time, tf, ml, news } = raw;

  // Helper to format TP line
  function tpJoin(list) {
    if (!list || !list.length) return "N/A";
    return list.map(v => NF(v)).join(" / ");
  }

  // ---------------------------------------------------------
  //  MULTI-TF BLOCKS (EXACT STYLE YOU GAVE)
  // ---------------------------------------------------------
  const block1m = tfBlock("1M", {
    sig: tf["1m"].sig,
    rsi: tf["1m"].rsi,
    macd: tf["1m"].macd,
    atr: tf["1m"].atr,
    vol: tf["1m"].vol,
    ell: tf["1m"].ell,
    ellConf: tf["1m"].ellConf,
    s: tf["1m"].s,
    r: tf["1m"].r,
    tpLine: tpJoin(tf["1m"].tps),
    sl: tf["1m"].sl
  });

  const block5m = tfBlock("5M", {
    sig: tf["5m"].sig,
    rsi: tf["5m"].rsi,
    macd: tf["5m"].macd,
    atr: tf["5m"].atr,
    vol: tf["5m"].vol,
    ell: tf["5m"].ell,
    ellConf: tf["5m"].ellConf,
    s: tf["5m"].s,
    r: tf["5m"].r,
    tpLine: tpJoin(tf["5m"].tps),
    sl: tf["5m"].sl
  });

  const block15m = tfBlock("15M", {
    sig: tf["15m"].sig,
    rsi: tf["15m"].rsi,
    macd: tf["15m"].macd,
    atr: tf["15m"].atr,
    vol: tf["15m"].vol,
    ell: tf["15m"].ell,
    ellConf: tf["15m"].ellConf,
    s: tf["15m"].s,
    r: tf["15m"].r,
    tpLine: tpJoin(tf["15m"].tps),
    sl: tf["15m"].sl
  });

  const block30m = tfBlock("30M", {
    sig: tf["30m"].sig,
    rsi: tf["30m"].rsi,
    macd: tf["30m"].macd,
    atr: tf["30m"].atr,
    vol: tf["30m"].vol,
    ell: tf["30m"].ell,
    ellConf: tf["30m"].ellConf,
    s: tf["30m"].s,
    r: tf["30m"].r,
    tpLine: tpJoin(tf["30m"].tps),
    sl: tf["30m"].sl
  });

  const block1h = tfBlock("1H", {
    sig: tf["1h"].sig,
    rsi: tf["1h"].rsi,
    macd: tf["1h"].macd,
    atr: tf["1h"].atr,
    vol: tf["1h"].vol,
    ell: tf["1h"].ell,
    ellConf: tf["1h"].ellConf,
    s: tf["1h"].s,
    r: tf["1h"].r,
    tpLine: tpJoin(tf["1h"].tps),
    sl: tf["1h"].sl
  });

  // ---------------------------------------------------------
  // OVERALL BIAS (Fusion score derive)
  // ---------------------------------------------------------
  let fs = 0;
  const sigMap = { "🟢 BUY": 1, "🔴 SELL": -1, "🟡 NEUTRAL": 0, "⚪": 0 };

  for (const key of ["1m", "5m", "15m", "30m", "1h"]) {
    fs += sigMap[tf[key].sig] || 0;
  }

  let finalBias = "⚪ Neutral";
  if (fs > 1) finalBias = "🟢 BUY";
  if (fs < -1) finalBias = "🔴 SELL";

  const total = 5;
  const buyProb = ((fs + 2.5) / 5) * 100;
  const sellProb = 100 - buyProb;

  // ---------------------------------------------------------
  // AI DRIVEN TP (simple aggregation)
  // ---------------------------------------------------------
  const bullTP1 = NF(tf["1h"].r);
  const bullTP2 = NF(tf["30m"].r);

  const bearTP1 = NF(tf["1m"].s);
  const bearTP2 = NF(tf["5m"].s);

  const neutralSL = NF(tf["15m"].sl);

  // ---------------------------------------------------------
  // MACHINE LEARNING FORECAST (RAW ML)
  // ---------------------------------------------------------
  const mlDir = ml.direction || "Neutral";
  const mlConf = NF(ml.confidence || 0);

  const mlSellTP = NF(ml.sell_tp || 0);
  const mlBuyTP = NF(ml.buy_tp || 0);

  const mlQuote = ml.quote || "AI forecast active";

  // ---------------------------------------------------------
  // NEWS BUNDLE
  // ---------------------------------------------------------
  const newsImpact = news.impact || "Low";
  const newsSentiment = NF(news.sentiment || 0);
  const headline = news.headline || "No major events";

  // ---------------------------------------------------------
  // FINAL MASTER UI — EXACTLY SAME AS YOU SAVED
  // ---------------------------------------------------------
  const ui = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${NF(price)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Free)

${block1m}

${block5m}

${block15m}

${block30m}

${block1h}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${finalBias}
Fusion Score: ${fs}
Buy ${NF(buyProb)}% | Sell ${NF(sellProb)}%
━━━━━━━━━━━━━━━━━━

🎯 OVERALL TP (AI Driven)
Bullish TP: ${bullTP1} – ${bullTP2}
Bearish TP: ${bearTP1} – ${bearTP2}
SL (Neutral Invalidation): ${neutralSL}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)
Direction: ${mlDir}
ML Confidence: ${mlConf}%

📌 ML Says:
“${mlQuote}”

ML Targets:
• ML Sell TP: <b>${mlSellTP}</b>
• ML Buy TP (Hedge): <b>${mlBuyTP}</b>
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}
Sentiment: ${newsSentiment}%
Headline: *“${headline}”*
━━━━━━━━━━━━━━━━━━
`;

  return ui.trim();
}

// =============================================================
// TELEGRAM COMMAND HANDLERS
// =============================================================

// Main manual command: /report
bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    await safeSend(chatId, "⏳ Generating AI report...");
    const raw = await buildAIReport("BTCUSDT");   // default symbol
    const html = await formatAIReport(raw);

    await safeSend(chatId, html);
  } catch (e) {
    await safeSend(chatId, "❌ Error generating report:\n" + e.message);
  }
});

// Simple ping command
bot.onText(/\/ping/, async (msg) => {
  await safeSend(msg.chat.id, "🏓 Pong! Bot is alive.");
});

// Help command
bot.onText(/\/help/, async (msg) => {
  const txt = `
<b>📘 AI Trader Commands</b>

<b>/report</b> → Full AI Market Intelligence report  
<b>/ping</b> → Bot check  
<b>/help</b> → Help Menu  

System: ML v8.6 • News Engine v3.0 • Elliott v4.1
  `.trim();

  await safeSend(msg.chat.id, txt);
});


// =============================================================
// BUILD AI REPORT (Central brain for assembling data)
// =============================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    // 1. MULTI-TF MARKET DATA
    const multi = await fetchMultiTF(symbol);

    // 2. ML FORECAST
    const mlPred = await runMLPrediction(symbol);

    // 3. NEWS BUNDLE
    const news = await fetchNewsBundle(symbol);

    // 4. Timestamp
    const time = new Date().toLocaleString("en-IN", {
      hour12: true,
      timeZone: "Asia/Kolkata"
    });

    return {
      symbol,
      price: multi.price,
      time,
      tf: multi.tframes,  // 1m,5m,15m,30m,1h blocks
      ml: mlPred,
      news: {
        sentiment: news.sentiment || 0.5,
        impact: news.impact || "Low",
        headline: news.items?.[0]?.title || "No major headline"
      }
    };

  } catch (e) {
    return {
      error: true,
      message: e.message,
      symbol,
      time: new Date().toISOString()
    };
  }
}


// =============================================================
// EXPORT for aiTraderBot.js
// =============================================================
export default {
  bot,
  buildAIReport,
  formatAIReport
};

// tg_commands.js — FINAL CLEAN VERSION
// ---------------------------------------------------
// ONLY ONE IMPORT BLOCK — NOTHING REPEATED

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";

import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";

import newsModule from "./news_social.js";


// =============================================================
// TELEGRAM BOT (OLD STYLE — EXACTLY LIKE YOUR PROJECT)
// =============================================================
export const bot = new TelegramBot(
  CONFIG.TELEGRAM.BOT_TOKEN,
  { polling: true }
);


// =============================================================
// SAFE TELEGRAM SENDER (AUTO SPLIT)
// =============================================================
async function safeSend(chatId, text) {
  if (!text) return;

  const MAX = 3900;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }

  for (let i = 0; i < text.length; i += MAX) {
    await bot.sendMessage(chatId, text.substring(i, i + MAX), {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}


// =============================================================
// SMALL HELPERS
// =============================================================
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v))
    ? Number(v).toFixed(d)
    : "N/A";

function shortSig(score) {
  if (score >= 0.7) return "🟩 Strong Buy";
  if (score >= 0.2) return "🟦 Buy";
  if (score > -0.2 && score < 0.2) return "🟨 Neutral";
  if (score <= -0.2 && score > -0.7) return "🟧 Sell";
  return "🟥 Strong Sell";
}


// =============================================================
// BUILD AI REPORT
// =============================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const multi = await fetchMultiTF(symbol);

    const ml = await runMLPrediction(symbol);
    const micro = await runMicroPrediction(symbol);
    const news = await newsModule.fetchNewsBundle(symbol);

    const time = new Date().toLocaleString("en-IN", {
      hour12: true,
      timeZone: "Asia/Kolkata"
    });

    return {
      ok: true,
      symbol,
      price: multi.price,
      tf: multi.tframes,
      time,
      ml,
      micro,
      news,
      mlAcc: calculateAccuracy().accuracy
    };

  } catch (e) {
    return { ok: false, error: e.message };
  }
}


// =============================================================
// FORMAT AI REPORT — EXACT YOUR UI
// =============================================================
export async function formatAIReport(r) {
  if (!r || !r.ok) return "❌ Failed to generate report.";

  const S = r.symbol;
  const P = nf(r.price, 2);
  const T = r.time;

  const tf = r.tf;

  function makeTF(tfKey, label) {
    const d = tf[tfKey];
    if (!d) return "";

    return `
🕒 ${label} — ${shortSig(d.fusion)}

RSI ${nf(d.rsi)} | MACD ${nf(d.macd)} | Vol ${d.vol} | ATR ${nf(d.atr)}
Elliott: ${d.ellLabel} | Conf ${nf(d.ellConf)}%
S: ${nf(d.support)} | R: ${nf(d.resistance)}
TP 🎯: ${d.tpA || "—"}${d.tpB ? " / " + d.tpB : ""}${d.tpC ? " / " + d.tpC : ""}
SL: ${nf(d.sl)}
`.trim();
  }

  const N = r.news || {};
  const newsImpact = N.impact || "Low";
  const newsSentiment = Math.round((N.sentiment || 0.5) * 1000) / 10;
  const headline = N.items?.[0]?.title || "No major headline";

  const ml = r.ml || {};
  const mlDir = ml.label || "Neutral";
  const mlConf = nf(ml.maxProb || ml.prob || 0, 2);

  const mlSellTP = ml.shortTP || "—";
  const mlBuyTP = ml.longTP || "—";
  const mlQuote = ml.quote || "Model aligned with market volatility.";

  const f15 = tf["15m"]?.fusion || 0;
  const fusion = shortSig(f15);

  let buyProb = Math.min(100, Math.max(0, Math.round(((f15 + 1) / 2) * 100)));
  const sellProb = 100 - buyProb;


  // =================== COMPLETE UI ===================
  return `
🔥 <b>${S} — AI Market Intelligence</b>
Time (IST): ${T}
Price: <b>${P}</b>
━━━━━━━━━━━━━━━━━━

<b>📊 MULTI-TIMEFRAME PANEL</b>
(Short | Clean | Cluster-Free)

${makeTF("1m", "1M")}
${makeTF("5m", "5M")}
${makeTF("15m", "15M")}
${makeTF("30m", "30M")}
${makeTF("1h", "1H")}
━━━━━━━━━━━━━━━━━━

<b>🧭 OVERALL BIAS</b>
Bias: <b>${fusion}</b>
Fusion Score: ${f15}
Buy ${buyProb}% | Sell ${sellProb}%
━━━━━━━━━━━━━━━━━━

<b>🤖 MACHINE LEARNING FORECAST</b>
Direction: <b>${mlDir}</b>  
ML Confidence: <b>${mlConf}%</b>

📌 ML Says:  
“${mlQuote}”

ML Targets:
• ML Sell TP: <b>${mlSellTP}</b>  
• ML Buy TP (Hedge): <b>${mlBuyTP}</b>
━━━━━━━━━━━━━━━━━━

<b>📰 NEWS IMPACT</b>
Impact: <b>${newsImpact}</b>  
Sentiment: <b>${newsSentiment}%</b>
Headline: “${headline}”
━━━━━━━━━━━━━━━━━━

<i>AI Engine v9 — Market, ML, Elliott, News Unified</i>
  `.trim();
}


// =============================================================
// TG COMMANDS
// =============================================================
bot.onText(/\/report/, async (msg) => {
  const id = msg.chat.id;

  await safeSend(id, "⏳ Generating AI Market Intelligence...");

  const raw = await buildAIReport("BTCUSDT");
  const html = await formatAIReport(raw);

  await safeSend(id, html);
});

bot.onText(/\/help/, (msg) =>
  safeSend(msg.chat.id, `
<b>📘 Commands</b>
/report → Full AI Report  
/ping → Check bot  
/help → Help  
`)
);

bot.onText(/\/ping/, (msg) =>
  safeSend(msg.chat.id, "🏓 Pong!")
);


// =============================================================
// EXPORT
// =============================================================
export default {
  bot,
  buildAIReport,
  formatAIReport
};