/* ============================================================
   tg_commands.js — AI Trader (Clean UI + TP + ML restored)
   ============================================================ */

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  calculateAccuracy
} from "./ml_module_v8_6.js";

import newsModule from "./news_social.js";

// ----------------------------------------------------------------
// Telegram (used only manually, auto sending handled outside)
// ----------------------------------------------------------------
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

function clamp(v, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

function fusionLabel(score) {
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// -------------------------------------------------------------
// Fusion Scoring
// -------------------------------------------------------------
function computeFusionScore(indObj, ellObj) {
  let score = 0, weight = 0;

  try {
    const rsi = Number(indObj?.RSI ?? 50);
    score += ((rsi - 50) / 50) * 0.4;
    weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(indObj?.ATR || 1)));
    score += macdScore * 0.35;
    weight += 0.35;

    score += (indObj?.priceTrend === "UP" ? 0.15 :
             indObj?.priceTrend === "DOWN" ? -0.15 : 0);
    weight += 0.15;

    score += (indObj?.volumeTrend === "INCREASING" ? 0.08 :
             indObj?.volumeTrend === "DECREASING" ? -0.08 : 0);
    weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

    return Number((score / weight).toFixed(3));
  } catch {
    return 0;
  }
}

// -------------------------------------------------------------
// Overall fusion
// -------------------------------------------------------------
function computeOverallFusion(mtf) {
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, w = 0;

  for (const m of mtf) {
    const wtf = weights[m.tf] ?? 0.1;
    s += (m.fusionScore ?? 0) * wtf;
    w += wtf;
  }

  return Number((s / w).toFixed(3));
}

// -------------------------------------------------------------
// Buy/Sell probabilities
// -------------------------------------------------------------
function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100;
  let sell = 100 - buy;

  let ellSum = 0, ellW = 0;
  for (const m of mtf) {
    if (m.ell && m.ell.confidence) {
      ellSum += m.ell.sentiment * (m.ell.confidence / 100);
      ellW += (m.ell.confidence / 100);
    }
  }

  const ellAvg = ellW ? ellSum / ellW : 0;
  buy += ellAvg * 10;
  sell = 100 - buy;

  const bull = mtf.filter(x => x.fusionScore > 0.2).length;
  const bear = mtf.filter(x => x.fusionScore < -0.2).length;
  buy += Math.min(8, (bull - bear) * 2);
  sell = 100 - buy;

  buy = Math.min(100, Math.max(0, buy));
  sell = Math.min(100, Math.max(0, sell));

  const sum = buy + sell;
  buy = Math.round((buy / sum) * 10000) / 100;
  sell = Math.round((sell / sum) * 10000) / 100;

  return { buy, sell, ellAvg };
}

// -------------------------------------------------------------
// TF Block UI
// -------------------------------------------------------------
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib, targets = []) {
  const fuse = fusionLabel(fusionScore);

  return `
<b>${tf.toUpperCase()} — ${fuse.emoji} ${fuse.label}</b>
Price: <b>${nf(price)}</b> | Vol: ${vol?.status || "N/A"}
RSI: <b>${nf(ind.RSI,1)}</b> | MACD: <b>${nf(ind.MACD?.hist,4)}</b> | ATR: <b>${nf(ind.ATR)}</b>
Support: ${ellSummary?.support ? nf(ellSummary.support) : nf(fib?.lo)}
Resistance: ${ellSummary?.resistance ? nf(ellSummary.resistance) : nf(fib?.hi)}
Fusion Score: ${fusionScore}
  `.trim();
}

// -------------------------------------------------------------
// Heatmap
// -------------------------------------------------------------
function buildHeatmap(mtfData) {
  const order = ["1m","5m","15m","30m","1h"];
  const emoji = s =>
    s >= 0.7 ? "🟩" :
    s >= 0.2 ? "🟦" :
    s > -0.2 ? "🟨" :
    s > -0.7 ? "🟧" : "🟥";

  return "<b>Elliott Heatmap</b>\n" +
    order.map(tf => {
      const x = mtfData.find(m => m.tf === tf);
      return `${tf}:${emoji(x?.fusionScore || 0)}`;
    }).join(" | ");
}

// -------------------------------------------------------------
// Elliott safe wrapper
// -------------------------------------------------------------
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell?.ok) return { ok:false };

    const pivots = ell.pivots || [];
    const H = pivots.filter(p => p.type === "H").at(-1);
    const L = pivots.filter(p => p.type === "L").at(-1);

    return {
      ok:true,
      ell,
      support: L?.price || null,
      resistance: H?.price || null
    };
  } catch {
    return { ok:false };
  }
}

// -------------------------------------------------------------
// TARGET HELPERS (RESTORED OPTION-B)
// -------------------------------------------------------------
function sortTargets(targets, price) {
  const longs = targets
    .filter(t => Number(t.price) > price)
    .sort((a,b) => (b.confidence||0) - (a.confidence||0));

  const shorts = targets
    .filter(t => Number(t.price) < price)
    .sort((a,b) => (b.confidence||0) - (a.confidence||0));

  return { longs, shorts };
}

function pickMLTarget(ml, longs, shorts, price) {
  if (!ml || !ml.label) return null;

  const d = ml.label.toLowerCase();
  if (d.includes("bull")) return longs[0] || null;
  if (d.includes("bear")) return shorts[0] || null;

  return null;
}

// -------------------------------------------------------------
// BUILD AI REPORT
// -------------------------------------------------------------
export async function buildAIReport(symbol="BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const raw = await fetchMultiTF(symbol, tfs);

    const mtf = [];

    for (const tf of tfs) {
      const entry = raw[tf] || { data:[] };
      const candles = entry.data || [];
      const price = entry.price || candles.at(-1)?.close || 0;

      const ind = {
        RSI: indicators.computeRSI(candles),
        MACD: indicators.computeMACD(candles),
        ATR: indicators.computeATR(candles),
        priceTrend: candles.length>1 ?
          (candles.at(-1).close > candles.at(-2).close ? "UP" :
           candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT") : "FLAT",
        volumeTrend: indicators.volumeTrend(candles)
      };

      const vol = indicators.analyzeVolume(candles);
      const ell = await safeElliottForCandles(candles);

      let fib = null;
      try { fib = indicators.computeFibLevels(candles); } catch {}

      const fusionScore = computeFusionScore(ind, ell?.ell || {});
      const targets = (ell?.ell?.targets || []).slice(0,5);

      mtf.push({
        tf, price, candles,
        indicators: ind,
        vol,
        ell: ell?.ell || null,
        ellSummary: { support: ell?.support, resistance: ell?.resistance },
        fib,
        fusionScore,
        targets
      });
    }

    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);
    const price = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price;

    const allTargets = mtf.flatMap(m =>
      (m.targets || []).map(t => ({
        ...t,
        price: Number(t.price || t.tp || t.target),
        tf: m.tf,
        pattern: t.pattern || t.source || "Elliott",
        confidence: t.confidence || m.ell?.confidence || 40
      }))
    );

    let ml = null;
    try { ml = await runMLPrediction(symbol, "15m"); } catch {}

    let mlAcc = 0;
    try { mlAcc = calculateAccuracy()?.accuracy || 0; } catch {}

    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch {}

    const mlWeight = 0.25;
    const mlBias = ml?.label==="Bullish" ? 1 : ml?.label==="Bearish" ? -1 : 0;

    let boosted = clamp(overallFusion + mlBias * mlWeight);

    let newsWeight =
      news?.impact==="High" ? 0.40 :
      news?.impact==="Moderate" ? 0.25 : 0.10;

    const newsBias = ((news?.sentiment ?? 0.5) - 0.5) * 2;
    boosted = clamp(boosted + newsBias * newsWeight);

    overallFusion = boosted;
    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    return {
      ok:true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probsBoosted.buy,
      sellProb: probsBoosted.sell,
      news,
      ml,
      mlAcc,
      mlDirection: ml?.label,
      generatedAt: new Date().toISOString(),
      allTargets
    };

  } catch (e) {
    return { ok:false, error:e.message };
  }
}

// -------------------------------------------------------------
// FORMAT REPORT (WITH TP + ML RESTORED)
// -------------------------------------------------------------
export async function formatAIReport(r) {
  if (!r?.ok) return "Error: " + (r?.error || "unknown");

  const price = r.price;

  const { longs, shorts } = sortTargets(r.allTargets || [], price);
  const mlTP = pickMLTarget(r.ml, longs, shorts, price);

  const tfBlocks = r.mtf
    .map(m => buildTFBlock(
      m.tf,
      m.price,
      m.indicators,
      m.vol,
      m.ellSummary,
      m.fusionScore,
      m.fib,
      m.targets
    ))
    .join("\n\n\n");

  const fusion = fusionLabel(r.overallFusion);

  const newsTxt = r.news
    ? `Impact: ${r.news.impact} | Sentiment: ${Math.round(r.news.sentiment*100)}%`
    : "News Unavailable";

  const longTxt = longs.length
    ? longs.slice(0,3).map((t,i)=>
      `TP${i+1}: ${nf(t.price)} (${t.pattern}) [${t.confidence}%]`
    ).join(" | ")
    : "N/A";

  const shortTxt = shorts.length
    ? shorts.slice(0,3).map((t,i)=>
      `TP${i+1}: ${nf(t.price)} (${t.pattern}) [${t.confidence}%]`
    ).join(" | ")
    : "N/A";

  const mlTxt = r.ml
    ? `Label: <b>${r.ml.label}</b>
Probability: ${r.ml.probability || 0}%
Direction: <b>${r.mlDirection || "N/A"}</b>
ML Target: ${mlTP ? nf(mlTP.price) + " [" + mlTP.confidence + "%]" : "N/A"}
Accuracy: ${r.mlAcc}%`
    : `Label: <b>N/A</b>
Accuracy: 0%`;

  const html = `
<b>${r.symbol} — AI Trader Report</b>
${new Date(r.generatedAt).toLocaleString()}

Price: <b>${nf(price)}</b>

${buildHeatmap(r.mtf)}

<b>Multi-Timeframe Analysis</b>

${tfBlocks}


<b>🎯 LONG Targets</b>
${longTxt}

<b>🎯 SHORT Targets</b>
${shortTxt}


<b>Fusion Summary</b>
Bias: ${fusion.emoji} <b>${fusion.label}</b>
Fusion Score: <b>${r.overallFusion}</b>
Buy Prob: <b>${r.buyProb}%</b> | Sell Prob: <b>${r.sellProb}%</b>


<b>News Overview</b>
${newsTxt}


<b>ML Prediction</b>
${mlTxt}

<i>AI Engine v3.0 — Clean Format (TP + ML Restored)</i>
  `.trim();

  return html;
}

export default { buildAIReport, formatAIReport };