// tg_commands.js — ML-connected detailed report (style B)
// AI Trader: Elliott + Fusion + ML (fixed + hardened)
// Exports: buildAIReport(symbol) -> report object, formatAIReport(report) -> HTML string

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
} from "./ml_module_v8_6.js"; // keep v8_6 import (your file name). If you use v9, rename accordingly.

import newsModule from "./news_social.js";

// -----------------------------
// Small helpers
// -----------------------------
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

// -----------------------------
// Fusion scoring per TF
// -----------------------------
function computeFusionScore(indObj = {}, ellObj = {}) {
  try {
    let score = 0;
    let weight = 0;

    const rsi = Number(indObj?.RSI ?? 50);
    score += ((rsi - 50) / 50) * 0.4; weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const atr = Math.max(1, Number(indObj?.ATR ?? 1));
    const macdScore = Math.tanh(macdh / atr);
    score += macdScore * 0.35; weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf); weight += 0.25 * ellConf;

    const normalized = Math.max(-1, Math.min(1, score / Math.max(1e-6, weight)));
    return Number(normalized.toFixed(3));
  } catch (e) {
    return 0;
  }
}

function computeOverallFusion(mtf) {
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, wsum = 0;
  for (const m of mtf) {
    const score = Number(m.fusionScore ?? 0);
    const w = weights[m.tf] ?? 0.1;
    s += score * w; wsum += w;
  }
  const overall = wsum ? s / wsum : 0;
  return Number(Math.max(-1, Math.min(1, overall)).toFixed(3));
}

function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100;
  let sell = 100 - buy;

  let ellSum = 0, ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      const conf = Math.max(0, Math.min(100, ell.confidence));
      ellSum += ell.sentiment * (conf / 100);
      ellW += (conf / 100);
    }
  }
  const ellAvg = ellW ? (ellSum / ellW) : 0;
  buy += ellAvg * 10; sell = 100 - buy;

  const bullishTFs = mtf.filter(m => (m.fusionScore ?? 0) > 0.2).length;
  const bearishTFs = mtf.filter(m => (m.fusionScore ?? 0) < -0.2).length;
  const biasDiff = bullishTFs - bearishTFs;
  if (biasDiff > 0) buy += Math.min(8, biasDiff * 2);
  else if (biasDiff < 0) sell += Math.min(8, Math.abs(biasDiff) * 2);

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  const sum = buy + sell;
  if (sum > 0) {
    buy = Math.round((buy / sum) * 10000) / 100;
    sell = Math.round((sell / sum) * 10000) / 100;
  } else { buy = 50; sell = 50; }

  return { buy, sell, ellAvg: Number(ellAvg.toFixed(3)) };
}

// -----------------------------
// Pretty TF block builder (HTML text)
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  const rsi = (typeof ind.RSI === "number") ? Number(ind.RSI).toFixed(1) : "N/A";
  const macd = (typeof ind.MACD?.hist === "number") ? Number(ind.MACD.hist).toFixed(4) : "N/A";
  const atr = (typeof ind.ATR === "number") ? Number(ind.ATR).toFixed(2) : "N/A";
  const volTxt = vol?.status || "N/A";
  const support = ellSummary?.support ? nf(ellSummary.support, 2) : (fib?.retrace?.['0.618'] ? nf(fib.retrace['0.618'],2) : "N/A");
  const resistance = ellSummary?.resistance ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi,2) : "N/A");

  return `
<b>${tf.toUpperCase()} — ${fusion.emoji} ${fusion.label}</b>
Price: <b>${nf(price,2)}</b> | Vol: ${volTxt}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Support: ${support}
Resistance: ${resistance}
Fusion Score: ${fusionScore}
`.trim();
}

function buildHeatmap(mtfData) {
  const tfOrder = ["1m","5m","15m","30m","1h"];
  const mapEmoji = (s) => {
    if (s >= 0.7) return "🟩";
    if (s >= 0.2) return "🟦";
    if (s > -0.2 && s < 0.2) return "🟨";
    if (s <= -0.2 && s > -0.7) return "🟧";
    return "🟥";
  };
  const parts = tfOrder.map(tf => {
    const blk = mtfData.find(x => x.tf === tf);
    const score = blk ? blk.fusionScore ?? 0 : 0;
    return `${tf.toUpperCase()}:${mapEmoji(score)}`;
  });
  return `<b>Elliott Heatmap</b>\n` + parts.join(" | ");
}

// -----------------------------
// Safely call Elliott
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false, error: ell?.error || "elliott_err" };
    const pivots = ell.pivots || [];
    const lastHigh = pivots.filter(p=>p.type==='H').slice(-1)[0];
    const lastLow = pivots.filter(p=>p.type==='L').slice(-1)[0];
    const support = lastLow ? lastLow.price : null;
    const resistance = lastHigh ? lastHigh.price : null;
    return { ok:true, ell, support, resistance };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// -----------------------------
// Utilities for targets
function resolveTargetConfidence(t, ell) {
  if (t && typeof t.confidence === "number") return Math.max(0, Math.min(100, t.confidence));
  if (ell && typeof ell.confidence === "number") return Math.max(0, Math.min(100, ell.confidence));
  return null;
}
function getTPval(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// -----------------------------
// ML output compatibility helper
function normalizeML(ml) {
  // Accept multiple shapes: v8_6/v9 etc.
  // Return normalized object with: label, probMax, probBull, probBear, probNeutral, tpMul
  if (!ml || typeof ml !== "object") return null;
  const out = {};
  out.label = ml.label || ml.predictedLabel || ml.mlLabel || null;

  // try numeric probabilities (percent or fraction)
  out.probMax = (ml.probMaxPercent ?? ml.probMax ?? ml.prob ?? ml.probability ?? null);
  // sometimes prob fields are 0..1 or 0..100. Normalize to 0..100 where possible
  if (typeof out.probMax === "number") {
    if (out.probMax <= 1) out.probMax = out.probMax * 100;
  }

  out.probBull = (ml.probBullPercent ?? ml.probBull ?? ml.bull ?? ml.probabilityBull ?? null);
  out.probBear = (ml.probBearPercent ?? ml.probBear ?? ml.bear ?? ml.probabilityBear ?? null);
  out.probNeutral = (ml.probNeutralPercent ?? ml.probNeutral ?? ml.neutral ?? ml.probabilityNeutral ?? null);
  // normalize individual probs if in 0..1
  ["probBull","probBear","probNeutral"].forEach(k=>{
    if (typeof out[k] === "number" && out[k] <= 1) out[k] = out[k]*100;
  });

  // fallback compute from whatever we have
  if ((!out.probBull || !out.probBear || !out.probNeutral) && Array.isArray(ml.rawSoft)) {
    // nothing
  }

  out.tpMul = (ml.tpMul ?? ml.tpMul ?? ml.tpEstimateMultiplier ?? ml.tpEstimate ?? ml.tp ?? null);
  if (typeof out.tpMul === "string") {
    const n = Number(out.tpMul);
    if (!Number.isNaN(n)) out.tpMul = n;
  }
  return out;
}

// -----------------------------
// MAIN: buildAIReport(symbol)
// -----------------------------
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    for (const tf of tfs) {
      const entry = (mtfRaw && mtfRaw[tf]) ? mtfRaw[tf] : { data: [], price: 0 };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && entry.price) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
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
        else if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles);
      } catch (e) { fib = null; }

      const fusionScore = computeFusionScore(ind, ell || { sentiment: 0, confidence: 0 });

      const rawTargets = (ell && Array.isArray(ell.targets)) ? ell.targets.slice(0,6) : [];
      const targets = rawTargets.map(t => {
        const conf = resolveTargetConfidence(t, ell);
        return Object.assign({}, t, { tp: getTPval(t), confidence: conf ?? null, source: t.source || (t.type || "Elliott") });
      });

      mtf.push({
        tf, price, candles,
        indicators: ind, vol,
        ell, ellSummary: { support: ellRes?.support || null, resistance: ellRes?.resistance || null },
        fib, fusionScore, targets
      });
    }

    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const price = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0;

    const allTargets = mtf.flatMap(m => (m.targets || []).map(t => ({ ...t, tf: m.tf })));
    const uniqMap = new Map();
    for (const t of allTargets) {
      const key = Math.round(Number(t.tp || 0));
      if (!uniqMap.has(key)) uniqMap.set(key, t);
      else {
        const prev = uniqMap.get(key);
        const best = (t.confidence || 0) > (prev.confidence || 0) ? t : prev;
        uniqMap.set(key, best);
      }
    }
    const uniqTargets = Array.from(uniqMap.values()).slice(0, 8);

    const annotatedTargets = uniqTargets.map(t => {
      let conf = t.confidence;
      if (conf == null) {
        const ellConfAvg = mtf.reduce((acc,m)=>acc + (m.ell?.confidence||0),0) / Math.max(1, mtf.length);
        conf = Math.round(Math.max(10, Math.min(99, 40 + Math.abs(overallFusion) * 40 + (ellConfAvg * 0.2))));
      }
      return Object.assign({}, t, { confidence: Math.round(conf) });
    });

    const longs = annotatedTargets.filter(t => Number(t.tp) > price).sort((a,b)=>b.confidence - a.confidence);
    const shorts = annotatedTargets.filter(t => Number(t.tp) < price).sort((a,b)=>b.confidence - a.confidence);

    // -----------------------------
    // ML: main + micro (safe)
    // -----------------------------
    let mlRaw = null;
    try { mlRaw = await runMLPrediction(symbol, "15m"); } catch (e) { mlRaw = { error: String(e) }; }
    const ml = normalizeML(mlRaw) || null;

    let microRaw = null;
    try { microRaw = await runMicroPrediction(symbol, 60); } catch (e) { microRaw = null; }
    const micro = microRaw && (typeof microRaw === "object") ? microRaw : null;

    let mlAcc = 0;
    try { const acc = calculateAccuracy(); mlAcc = acc?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"Low", items:[] }; }

    // Adaptive weighting
    const mlWeight = 0.25;
    let newsWeight = 0.10;
    const impact = (news && news.impact) ? (""+news.impact).toLowerCase() : "low";
    if (impact === "high") newsWeight = 0.40;
    else if (impact === "moderate") newsWeight = 0.25;
    else newsWeight = 0.10;

    let mlBias = 0;
    if (ml && ml.label && /bull/i.test(ml.label)) mlBias = +1;
    else if (ml && ml.label && /bear/i.test(ml.label)) mlBias = -1;

    let boosted = clamp(overallFusion + mlBias * mlWeight, -1, 1);
    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5;
    const newsBias = ((newsSent - 0.5) * 2);
    boosted = clamp(boosted + newsBias * newsWeight, -1, 1);
    overallFusion = Number(boosted.toFixed(3));

    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    // ML-driven TP selection
    function pickMLTP(list, mode) {
      if (!Array.isArray(list) || !list.length) return null;
      const mlProb = (ml && typeof ml.probMax === "number") ? ml.probMax : null;
      let best = null; let bestScore = -Infinity;
      for (const t of list) {
        const sideMatch = mode === "long" ? (Number(t.tp) > price) : (Number(t.tp) < price);
        if (!sideMatch) continue;
        const tConf = Number(t.confidence || 0);
        const score = (mlProb !== null) ? ( (mlProb/100) * 0.6 + (tConf/100) * 0.4 ) : (tConf/100);
        if (score > bestScore) { bestScore = score; best = t; }
      }
      return best || null;
    }

    const mlLongTP = pickMLTP(annotatedTargets, "long");
    const mlShortTP = pickMLTP(annotatedTargets, "short");

    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probsBoosted.buy,
      sellProb: probsBoosted.sell,
      ellConsensus: probsBoosted.ellAvg,
      annotatedTargets,
      longs,
      shorts,
      ml: mlRaw,           // raw ML object (full)
      mlNorm: ml,          // normalized ML view
      micro,
      mlAcc,
      mlDirection: ml?.label || "Neutral",
      mlLongTP,
      mlShortTP,
      news,
      newsWeight,
      mlWeight,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// -----------------------------
// FORMAT: Detailed HTML for Telegram (Style B)
// -----------------------------
export async function formatAIReport(report) {
  try {
    if (!report || !report.ok) {
      return `Error building report: ${report?.error || "unknown"}`;
    }

    const price = Number(report.price || 0);
    const mtf = report.mtf || [];

    const heat = buildHeatmap(mtf);

    const tfBlocks = mtf
      .map(m =>
        buildTFBlock(
          m.tf,
          m.price,
          m.indicators || {},
          m.vol || {},
          m.ellSummary || {},
          m.fusionScore || 0,
          m.fib || null
        )
      )
      .join("\n\n");

    let ellSummaryText = "Elliott: N/A";
    const firstEll = mtf.find(
      m =>
        m.ell &&
        ((m.ell.patterns && m.ell.patterns.length) ||
          (m.ell.targets && m.ell.targets.length))
    );
    if (firstEll && firstEll.ell) {
      const conf = firstEll.ell.confidence ?? firstEll.ell.conf ?? 0;
      ellSummaryText = `Elliott (best): Conf ${conf}% | Patterns: ${firstEll.ell.patterns?.length || 0} | Targets: ${firstEll.ell.targets?.length || 0}`;
    }

    const topLongs =
      (report.longs || [])
        .slice(0, 3)
        .map(
          (t, i) =>
            `TP${i + 1}: ${nf(Number(t.tp), 2)} (${t.source || t.tf || "Elliott"}) [${t.confidence}%]`
        )
        .join(" | ") || "n/a";

    const topShorts =
      (report.shorts || [])
        .slice(0, 3)
        .map(
          (t, i) =>
            `TP${i + 1}: ${nf(Number(t.tp), 2)} (${t.source || t.tf || "Elliott"}) [${t.confidence}%]`
        )
        .join(" | ") || "n/a";

    // ML text
    const mlNorm = report.mlNorm || null;
    let mlLabel = (mlNorm && mlNorm.label) ? mlNorm.label : (report.mlDirection || "Neutral");
    let mlProbMax = (mlNorm && typeof mlNorm.probMax === "number") ? Number(mlNorm.probMax) : (report.ml && report.ml.probMaxPercent ? report.ml.probMaxPercent : 0);
    if (mlProbMax !== null && mlProbMax <= 1) mlProbMax = mlProbMax * 100;
    mlProbMax = (typeof mlProbMax === "number") ? Math.round(mlProbMax*100)/100 : "N/A";

    const mlBull = (mlNorm && typeof mlNorm.probBull === "number") ? Math.round(mlNorm.probBull*100)/100 : (report.ml && report.ml.probBullPercent ? report.ml.probBullPercent : "N/A");
    const mlBear = (mlNorm && typeof mlNorm.probBear === "number") ? Math.round(mlNorm.probBear*100)/100 : (report.ml && report.ml.probBearPercent ? report.ml.probBearPercent : "N/A");
    const mlNeutral = (mlNorm && typeof mlNorm.probNeutral === "number") ? Math.round(mlNorm.probNeutral*100)/100 : (report.ml && report.ml.probNeutralPercent ? report.ml.probNeutralPercent : "N/A");

    // ML-chosen TP text
    let mlTPtxt = "N/A";
    const mlLabelLower = (String(mlLabel || "")).toLowerCase();
    if (/bull/i.test(mlLabelLower)) {
      if (report.mlLongTP) mlTPtxt = `${nf(Number(report.mlLongTP.tp), 2)} [${report.mlLongTP.confidence}%]`;
      else if ((report.longs && report.longs.length)) mlTPtxt = `${nf(Number(report.longs[0].tp),2)} [${report.longs[0].confidence}%]`;
    } else if (/bear/i.test(mlLabelLower)) {
      if (report.mlShortTP) mlTPtxt = `${nf(Number(report.mlShortTP.tp), 2)} [${report.mlShortTP.confidence}%]`;
      else if ((report.shorts && report.shorts.length)) mlTPtxt = `${nf(Number(report.shorts[0].tp),2)} [${report.shorts[0].confidence}%]`;
    } else {
      const longTxt = report.mlLongTP ? `Long: ${nf(Number(report.mlLongTP.tp),2)} [${report.mlLongTP.confidence}%]` : "Long: N/A";
      const shortTxt = report.mlShortTP ? `Short: ${nf(Number(report.mlShortTP.tp),2)} [${report.mlShortTP.confidence}%]` : "Short: N/A";
      mlTPtxt = `${longTxt} | ${shortTxt}`;
    }

    let newsTxt = "News: N/A";
    if (report.news) {
      const n = report.news;
      const sentPct = (typeof n.sentiment === "number") ? Math.round(n.sentiment * 1000) / 10 : "N/A";
      newsTxt = `📰 Impact: ${n.impact || "N/A"} | Sentiment: ${sentPct}% | Items: ${n.items?.length || 0}\nTop: ${ n.items && n.items[0] ? (n.items[0].title || n.items[0].text || n.items[0].link || "—") : "—" }`;
    }

    const tf15 = mtf.find(x => x.tf === "15m");
    const atr15 = tf15?.indicators?.ATR || (tf15?.price ? Number(tf15.price) * 0.005 : null);
    let slLong = "n/a", slShort = "n/a";
    if (atr15) {
      slLong = nf(price - atr15 * 2, 2);
      slShort = nf(price + atr15 * 2, 2);
    }

    const fusionLbl = fusionLabel(Number(report.overallFusion ?? 0));

    const html = `
<b>${report.symbol} — AI Trader Report (Detailed)</b>
${new Date(report.generatedAt).toLocaleString('en-IN', { hour12: true })}
Price: <b>${nf(price,2)}</b>

${heat}

<b>Multi-Timeframe Analysis</b>

${tfBlocks}

<b>Fusion Summary</b>
Bias: ${fusionLbl.emoji} <b>${fusionLbl.label}</b>
Fusion Score: <b>${report.overallFusion}</b>
Buy: <b>${report.buyProb}%</b> | Sell: <b>${report.sellProb}%</b>

<b>Elliott Overview</b>
${ellSummaryText}

<b>LONG Targets</b>
${topLongs}
SL (long): ${slLong}

<b>SHORT Targets</b>
${topShorts}
SL (short): ${slShort}

📐 Fib Zone (15m): ${ tf15?.fib ? nf(tf15.fib.lo,2) + " - " + nf(tf15.fib.hi,2) : "N/A" }

<b>ML Prediction</b>
Label: <b>${mlLabel}</b>
Probability (max): ${mlProbMax}%
Bull: ${mlBull}% | Bear: ${mlBear}% | Neutral: ${mlNeutral}%
TP Multiplier (model): ${ (report.ml && (report.ml.tpMul || report.ml.tpEstimateMultiplier)) ? (report.ml.tpMul ?? report.ml.tpEstimateMultiplier) : (report.mlNorm?.tpMul ?? "N/A") }
ML-chosen TP: ${mlTPtxt}
ML Accuracy (historic): ${report.mlAcc ?? "N/A"}%

<b>Micro ML</b>
1m/5m micro: ${report.micro?.label || "N/A"} (${ report.micro?.prob ? (Number(report.micro.prob) * 100).toFixed(2) + "%" : "N/A" }) — fast nudge

<b>News Overview</b>
${newsTxt}

<i>AI Engine — Detailed (Elliott + Fusion + ML integrated)</i>
`.trim();

    return html;
  } catch (e) {
    const err = `formatAIReport error: ${e.message || e}`;
    console.error(err);
    return err;
  }
}

export default { buildAIReport, formatAIReport };