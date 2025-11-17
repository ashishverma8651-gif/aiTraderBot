// =============================================================
// tg_commands.js — FINAL CLEAN VERSION (NO DUPLICATES)
// =============================================================

// -------------------------
// OLD IMPORT STYLE (Correct)
// -------------------------
import ML from "./ml_module_v8_6.js";      
import News from "./news_social.js";       
import CONFIG from "./config.js";

import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// -------------------------
// Extract ML functions
// -------------------------
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordOutcome,
  recordPrediction
} = ML;

// -------------------------
// Extract news functions
// -------------------------
const { fetchNewsBundle } = News;


// =============================================================
// SAFE TELEGRAM SENDER WILL BE IMPORTED FROM main BOT FILE
// (NO TELEGRAM IMPORT HERE — EXACTLY LIKE YOUR PROJECT)
// =============================================================

let bot = null;
export function attachBot(instance) {
  bot = instance;
}


// =============================================================
// HELPERS
// =============================================================
const NF = (n, d = 2) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "N/A";

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
// ⭐ BUILD AI REPORT  — SINGLE CLEAN VERSION
// =============================================================
export async function buildAIReport(symbol = CONFIG.SYMBOL) {
  try {
    // MULTI TF MARKET DATA
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

    // ML Forecast
    const ml = await runMLPrediction(symbol);

    // Micro ML
    const micro = await runMicroPrediction(symbol);

    // News
    const news = await fetchNewsBundle(symbol);

    return {
      symbol,
      price: multi.price,
      time: new Date().toLocaleString("en-IN", {
        hour12: true,
        timeZone: "Asia/Kolkata"
      }),
      tf: tfObj,
      ml,
      micro,
      news
    };

  } catch (err) {
    console.log("buildAIReport ERROR:", err);
    return null;
  }
}


// =============================================================
// ⭐ FORMAT AI REPORT — EXACT UI YOU SAVED
// =============================================================
export async function formatAIReport(raw) {
  if (!raw) return "<b>⚠️ Empty Report</b>";

  const { symbol, price, time, tf, ml, news } = raw;

  function tpJoin(list) {
    if (!list || !list.length) return "N/A";
    return list.map(v => NF(v)).join(" / ");
  }

  // TF BLOCKS
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

  // Overall bias calc
  const sigScore = { "🟢 BUY": 1, "🔴 SELL": -1, "🟡 NEUTRAL": 0, "⚪": 0 };

  let fs = 0;
  ["1m", "5m", "15m", "30m", "1h"].forEach(tfid => {
    fs += sigScore[tf[tfid].sig] || 0;
  });

  let bias = "⚪ Neutral";
  if (fs > 1) bias = "🟢 BUY";
  if (fs < -1) bias = "🔴 SELL";

  const buyProb = ((fs + 2.5) / 5) * 100;
  const sellProb = 100 - buyProb;

  // ML summary
  const mlDir = ml.direction || "Neutral";
  const mlConf = NF(ml.confidence || 0);
  const mlSellTP = NF(ml.sell_tp || 0);
  const mlBuyTP = NF(ml.buy_tp || 0);
  const mlQuote = ml.quote || "AI forecast active";

  // News
  const newsImpact = news.impact || "Low";
  const newsSentiment = NF(news.sentiment || 0);
  const headline = news.headline || "No major events";

  // FINAL UI
  return `
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
Bias: ${bias}
Fusion Score: ${fs}
Buy ${NF(buyProb)}% | Sell ${NF(sellProb)}%
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

📰 NEWS IMPACT
Impact: ${newsImpact}
Sentiment: ${newsSentiment}%
Headline: *“${headline}”*
━━━━━━━━━━━━━━━━━━
`;
}


// =============================================================
// EXPORT CLEAN
// =============================================================
export default {
  attachBot,
  buildAIReport,
  formatAIReport
};