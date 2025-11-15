// tg_commands.js — Final (Clean, ML+TP restored, single-blank-line, IST 12-hour time)

// PART 1 - imports
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  calculateAccuracy
} from "./ml_module_v8_6.js";

import newsModule from "./news_social.js";

// Helper formatting
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";

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

// compute fusion score per TF
function computeFusionScore(indObj = {}, ellObj = {}) {
  let score = 0, weight = 0;
  try {
    const rsi = Number(indObj?.RSI ?? 50);
    score += ((rsi - 50) / 50) * 0.4;
    weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(indObj?.ATR || 1)));
    score += macdScore * 0.35;
    weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

    const normalized = weight ? (score / weight) : 0;
    return Number(Math.max(-1, Math.min(1, normalized)).toFixed(3));
  } catch {
    return 0;
  }
}

// overall fusion
function computeOverallFusion(mtf) {
  const wmap = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, wsum = 0;
  for (const m of mtf) {
    const w = wmap[m.tf] ?? 0.1;
    s += (Number(m.fusionScore) || 0) * w;
    wsum += w;
  }
  const overall = wsum ? s / wsum : 0;
  return Number(Math.max(-1, Math.min(1, overall)).toFixed(3));
}

// buy/sell probability
function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100;
  let sell = 100 - buy;

  let ellSum = 0, ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      ellSum += ell.sentiment * (Math.max(0, Math.min(100, ell.confidence)) / 100);
      ellW += (Math.max(0, Math.min(100, ell.confidence)) / 100);
    }
  }
  const ellAvg = ellW ? ellSum / ellW : 0;
  buy += ellAvg * 10;
  sell = 100 - buy;

  const bullish = mtf.filter(m => (m.fusionScore ?? 0) > 0.2).length;
  const bearish = mtf.filter(m => (m.fusionScore ?? 0) < -0.2).length;
  const diff = bullish - bearish;
  if (diff > 0) buy += Math.min(8, diff * 2);
  else if (diff < 0) sell += Math.min(8, Math.abs(diff) * 2);

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  const sum = buy + sell;
  if (sum > 0) {
    buy = Math.round((buy / sum) * 10000) / 100;
    sell = Math.round((sell / sum) * 10000) / 100;
  } else { buy = 50; sell = 50; }

  return { buy, sell, ellAvg: Number((ellAvg || 0).toFixed(3)) };
}

// build TF block (single blank line between blocks)
function buildTFBlock(tf, price, ind = {}, vol = {}, ellSummary = {}, fusionScore = 0, fib = null) {
  const fusion = fusionLabel(fusionScore);
  const rsi = typeof ind.RSI === "number" ? ind.RSI.toFixed(1) : "N/A";
  const macd = typeof ind.MACD?.hist === "number" ? ind.MACD.hist.toFixed(4) : "N/A";
  const atr = typeof ind.ATR === "number" ? ind.ATR.toFixed(2) : "N/A";
  const volTxt = vol?.status || "N/A";
  const support = ellSummary?.support ? nf(ellSummary.support, 2) : (fib?.lo ? nf(fib.lo, 2) : "N/A");
  const resistance = ellSummary?.resistance ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi, 2) : "N/A");

  return `
<b>${tf.toUpperCase()} — ${fusion.emoji} ${fusion.label}</b>
Price: <b>${nf(price,2)}</b> | Vol: ${volTxt}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Support: ${support}
Resistance: ${resistance}
Fusion Score: ${fusionScore}
`.trim();
}

// heatmap
function buildHeatmap(mtf) {
  const order = ["1m","5m","15m","30m","1h"];
  const mapEmoji = (s) => {
    if (s >= 0.7) return "🟩";
    if (s >= 0.2) return "🟦";
    if (s > -0.2 && s < 0.2) return "🟨";
    if (s <= -0.2 && s > -0.7) return "🟧";
    return "🟥";
  };
  return "<b>Elliott Heatmap</b>\n" + order.map(tf => {
    const blk = mtf.find(m => m.tf === tf);
    const score = blk ? blk.fusionScore ?? 0 : 0;
    return `${tf.toUpperCase()}:${mapEmoji(score)}`;
  }).join(" | ");
}

// safe elliott
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false };
    const pivots = ell.pivots || [];
    const lastH = pivots.filter(p=>p.type==='H').slice(-1)[0];
    const lastL = pivots.filter(p=>p.type==='L').slice(-1)[0];
    return { ok:true, ell, support: lastL?.price || null, resistance: lastH?.price || null };
  } catch {
    return { ok:false };
  }
}

// helper: numeric TP value
function getTPval(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// =========================================================
// buildAIReport
// =========================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && entry.price) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : (indicators.computeRSI_fromCandles ? indicators.computeRSI_fromCandles(candles) : 50),
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0, line:0, signal:0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "UNKNOWN", strength: 0 };

      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes.ok ? ellRes.ell : null;

      let fib = null;
      try {
        if (typeof indicators.computeFibLevels === "function") fib = indicators.computeFibLevels(candles);
      } catch { fib = null; }

      const fusionScore = computeFusionScore(ind, ell || { sentiment: 0, confidence: 0 });
      const rawTargets = (ell && Array.isArray(ell.targets)) ? ell.targets.slice(0,6) : [];

      // annotate confidence
      const targets = rawTargets.map(t => {
        const conf = (typeof t.confidence === "number") ? Math.round(Math.max(0, Math.min(100, t.confidence))) : null;
        return Object.assign({}, t, { confidence: conf });
      });

      mtf.push({
        tf, price, candles,
        indicators: ind,
        vol,
        ell,
        ellSummary: { support: ellRes?.support || null, resistance: ellRes?.resistance || null },
        fib,
        fusionScore,
        targets
      });
    }

    // overall fusion + probs
    let overallFusion = computeOverallFusion(mtf);

    // ML prediction (15m)
    let ml = null;
    try { ml = await runMLPrediction(symbol, "15m"); } catch { ml = null; }

    let mlAcc = 0;
    try { mlAcc = (calculateAccuracy() || {}).accuracy || 0; } catch { mlAcc = 0; }

    // news
    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch { news = null; }

    // adaptive boost
    const mlWeight = 0.25;
    const mlBias = (ml && ml.label === "Bullish") ? 1 : (ml && ml.label === "Bearish") ? -1 : 0;
    let boosted = clamp(overallFusion + mlBias * mlWeight);

    let newsWeight = 0.10;
    const impact = (news && news.impact) ? String(news.impact).toLowerCase() : "low";
    if (impact === "high") newsWeight = 0.40;
    else if (impact === "moderate") newsWeight = 0.25;

    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5;
    const newsBias = ((newsSent - 0.5) * 2);
    boosted = clamp(boosted + newsBias * newsWeight);

    overallFusion = Number(boosted.toFixed(3));
    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    // aggregate all targets and dedupe by rounded price (keep highest confidence)
    const allTargets = mtf.flatMap(m => (m.targets || []).map(t => ({ ...t, tf: m.tf })));
    const uniq = new Map();
    for (const t of allTargets) {
      const key = Math.round(getTPval(t));
      if (!uniq.has(key)) uniq.set(key, t);
      else {
        const a = uniq.get(key);
        const best = ((t.confidence || 0) > (a.confidence || 0)) ? t : a;
        uniq.set(key, best);
      }
    }
    const uniqTargets = Array.from(uniq.values());

    // annotate missing confidence
    const annotatedTargets = uniqTargets.map(t => {
      let conf = t.confidence;
      if (conf == null) {
        const ellConfAvg = mtf.reduce((acc,m)=>acc + (m.ell?.confidence || 0), 0) / Math.max(1, mtf.length);
        conf = Math.round(Math.max(10, Math.min(99, 40 + Math.abs(overallFusion) * 40 + (ellConfAvg * 0.2))));
      }
      return Object.assign({}, t, { confidence: Math.round(conf) });
    });

    // split longs/shorts relative to 15m price
    const price15 = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0;
    const longs = annotatedTargets.filter(t => getTPval(t) > price15).sort((a,b)=>b.confidence - a.confidence);
    const shorts = annotatedTargets.filter(t => getTPval(t) < price15).sort((a,b)=>b.confidence - a.confidence);

    // ML-driven TP selection: if ML bullish choose top long else top short
    function pickMLTP(sideList, mode) {
      if (!Array.isArray(sideList) || sideList.length === 0) return null;
      return sideList[0] || null;
    }
    const mlLongTP = pickMLTP(longs, "long");
    const mlShortTP = pickMLTP(shorts, "short");

    return {
      ok: true,
      symbol,
      price: price15,
      mtf,
      overallFusion,
      buyProb: probsBoosted.buy,
      sellProb: probsBoosted.sell,
      ellConsensus: probsBoosted.ellAvg,
      annotatedTargets,
      longs,
      shorts,
      ml,
      mlAcc,
      mlDirection: ml?.label || "Neutral",
      mlLongTP,
      mlShortTP,
      news,
      mlWeight,
      newsWeight,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// =========================================================
// formatAIReport (returns HTML string) — single blank line only
// =========================================================
export async function formatAIReport(report) {
  try {
    if (!report || !report.ok) return `Error building report: ${report?.error || "unknown"}`;

    const price = Number(report.price || 0);
    const mtf = report.mtf || [];

    // heatmap
    const heat = buildHeatmap(mtf);

    // TF Blocks (single blank line between blocks)
    const tfBlocks = mtf.map(m =>
      buildTFBlock(m.tf, m.price, m.indicators || {}, m.vol || {}, m.ellSummary || {}, m.fusionScore || 0, m.fib || null)
    ).join("\n\n"); // single blank line

    // organize top targets text
    const topLongs = (report.longs || []).slice(0,3).map((t,i) => `TP${i+1}: ${nf(getTPval(t),2)} (${t.source || t.tf || "Elliott"}) [${t.confidence}%]`).join(" | ") || "n/a";
    const topShorts = (report.shorts || []).slice(0,3).map((t,i) => `TP${i+1}: ${nf(getTPval(t),2)} (${t.source || t.tf || "Elliott"}) [${t.confidence}%]`).join(" | ") || "n/a";

    // ML TP text
    let mlTPtxt = "N/A";
    if ((report.mlDirection || "").toLowerCase().includes("bull")) {
      mlTPtxt = report.mlLongTP ? `${nf(getTPval(report.mlLongTP),2)} [${report.mlLongTP.confidence}%]` : "N/A";
    } else if ((report.mlDirection || "").toLowerCase().includes("bear")) {
      mlTPtxt = report.mlShortTP ? `${nf(getTPval(report.mlShortTP),2)} [${report.mlShortTP.confidence}%]` : "N/A";
    }

    // News
    const newsTxt = report.news ? `Impact: ${report.news.impact || "N/A"} | Sentiment: ${typeof report.news.sentiment === "number" ? Math.round(report.news.sentiment*100) + "%" : "N/A"}` : "News: N/A";

    // Time formatting — IST 12-hour
    const dt = new Date(report.generatedAt || Date.now());
    const timeStr = dt.toLocaleString("en-IN", { hour12: true });

    const fusionLbl = fusionLabel(Number(report.overallFusion || 0));

    const html = `
<b>${report.symbol} — AI Trader Report</b>
${timeStr}

Price: <b>${nf(price,2)}</b>

${heat}

<b>Multi-Timeframe Analysis</b>

${tfBlocks}

<b>Fusion Summary</b>
Bias: ${fusionLbl.emoji} <b>${fusionLbl.label}</b>
Fusion Score: <b>${report.overallFusion}</b>
Buy: <b>${report.buyProb}%</b> | Sell: <b>${report.sellProb}%</b>

<b>News Overview</b>
${newsTxt}

<b>LONG Targets</b>
${topLongs}

<b>SHORT Targets</b>
${topShorts}

<b>ML Prediction</b>
Label: <b>${report.ml?.label || "N/A"}</b>
Probability: ${report.ml?.prob || 0}%
Direction: <b>${report.mlDirection}</b>
ML Target: ${mlTPtxt}
Accuracy: ${report.mlAcc}%

<i>AI Engine v3.0 — Clean Format (TP + ML Restored)</i>
`.trim();

    return html;
  } catch (e) {
    const err = `formatAIReport error: ${e?.message || e}`;
    console.error(err);
    return err;
  }
}

export default { buildAIReport, formatAIReport };