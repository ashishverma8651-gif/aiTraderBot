/*
  tg_commands_v9_final.js — AI Trader TG Command (v9 Compatible)
  Uses: elliott_module.js, ml_module_v9_0.js, core_indicators.js, utils.js, news_social.js
  Exports:
     buildAIReport(symbol) -> report object
     formatAIReport(report) -> formatted HTML
*/

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

// ----------------------------------
// Helpers
// ----------------------------------
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
    score += ((rsi - 50) / 50) * 0.4;
    weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const atr = Math.max(1, Number(indObj?.ATR ?? 1));
    const macdScore = Math.tanh(macdh / atr);
    score += macdScore * 0.35;
    weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

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
    s += score * w;
    wsum += w;
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
  buy += ellAvg * 10;
  sell = 100 - buy;

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
// TF block builder
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  const rsi = (typeof ind.RSI === "number") ? Number(ind.RSI).toFixed(1) : "N/A";
  const macd = (typeof ind.MACD?.hist === "number") ? Number(ind.MACD.hist).toFixed(4) : "N/A";
  const atr = (typeof ind.ATR === "number") ? Number(ind.ATR).toFixed(2) : "N/A";
  const volTxt = vol?.status || "N/A";
  const support = (ellSummary && ellSummary.support != null) ? nf(ellSummary.support, 2) : (fib?.retrace?.['0.618'] ? nf(fib.retrace['0.618'],2) : "N/A");
  const resistance = (ellSummary && ellSummary.resistance != null) ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi,2) : "N/A");

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
// Safely call Elliott (IMPROVED support/resistance extraction)
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false, error: ell?.error || "elliott_err" };
    const pivots = ell.pivots || [];

    // pick most recent Low and High pivot independently
    const lastLow = [...pivots].reverse().find(p => p.type === 'L') || null;
    const lastHigh = [...pivots].reverse().find(p => p.type === 'H') || null;

    const support = lastLow ? lastLow.price : null;
    const resistance = lastHigh ? lastHigh.price : null;
    return { ok:true, ell, support, resistance };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// -----------------------------
// Targets helpers
function resolveTargetConfidence(t, ell) {
  if (t && typeof t.confidence === "number") return Math.max(0, Math.min(100, t.confidence));
  if (ell && typeof ell.confidence === "number") return Math.max(0, Math.min(100, ell.confidence));
  return null;
}
function getTPval(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// -----------------------------
// MAIN: buildAIReport(symbol)
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
    // ML: main prediction (15m) + micro (optional)
    // -----------------------------
    let ml = null;
    try { ml = await runMLPrediction(symbol, "15m"); } catch (e) { ml = { error: e?.message || "ml_err" }; }

    let micro = null;
    try { micro = await runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // accuracy
    let mlAcc = 0;
    try { const acc = calculateAccuracy(); mlAcc = acc?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    // News
    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"Low", items:[] }; }

    // Adaptive weighting: nudge fusion using ML & News
    const mlWeight = 0.25;
    let newsWeight = 0.10;
    const impact = (news && news.impact) ? (""+news.impact).toLowerCase() : "low";
    if (impact === "high") newsWeight = 0.40;
    else if (impact === "moderate") newsWeight = 0.25;
    else newsWeight = 0.10;

    // --- ML bias computation (do NOT force 33/33/33)
    let mlLabel = null;
    let mlProbMax = null;
    let mlProbBull = null, mlProbBear = null, mlProbNeutral = null;

    if (ml && typeof ml === "object") {
      if (typeof ml.label === "string") mlLabel = ml.label;
      if (typeof ml.prob === "number") mlProbMax = Number(ml.prob);
      if (typeof ml.probBull === "number") mlProbBull = Number(ml.probBull);
      if (typeof ml.probBear === "number") mlProbBear = Number(ml.probBear);
      if (typeof ml.probNeutral === "number") mlProbNeutral = Number(ml.probNeutral);
      if (ml.probs && typeof ml.probs === "object") {
        if (typeof ml.probs.bull === "number") mlProbBull = ml.probs.bull * 100;
        if (typeof ml.probs.bear === "number") mlProbBear = ml.probs.bear * 100;
        if (typeof ml.probs.neutral === "number") mlProbNeutral = ml.probs.neutral * 100;
      }
    }

    if (mlProbBull != null || mlProbBear != null || mlProbNeutral != null) {
      mlProbBull = mlProbBull ?? 0;
      mlProbBear = mlProbBear ?? 0;
      mlProbNeutral = mlProbNeutral ?? 0;
      if (mlProbBull <= 1 && mlProbBear <= 1 && mlProbNeutral <= 1) {
        mlProbBull *= 100; mlProbBear *= 100; mlProbNeutral *= 100;
      }
      mlProbMax = Math.max(mlProbBull, mlProbBear, mlProbNeutral);
      const idx = [mlProbBull, mlProbBear, mlProbNeutral].indexOf(mlProbMax);
      mlLabel = idx === 0 ? "Bullish" : idx === 1 ? "Bearish" : "Neutral";
    } else if (mlProbMax == null && ml && typeof ml === "object") {
      if (typeof ml.predictionConfidence === "number") mlProbMax = Number(ml.predictionConfidence);
      else if (typeof ml.confidence === "number") mlProbMax = Number(ml.confidence);
      else if (typeof ml.score === "number") mlProbMax = Number(ml.score);
    }

    let mlBias = 0;
    if (mlLabel) {
      if (String(mlLabel).toLowerCase().includes("bull")) mlBias = +1;
      else if (String(mlLabel).toLowerCase().includes("bear")) mlBias = -1;
    }

    let boosted = clamp(overallFusion + mlBias * mlWeight, -1, 1);
    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5;
    const newsBias = ((newsSent - 0.5) * 2);
    boosted = clamp(boosted + newsBias * newsWeight, -1, 1);
    overallFusion = Number(boosted.toFixed(3));

    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    // -----------------------------
    // ML TP selection
    // -----------------------------
    function pickMLTPFromModel(mlObj) {
      if (!mlObj || typeof mlObj !== "object") return null;
      const directTp = mlObj.tp || mlObj.tpEstimate || mlObj.tpEstimateValue || mlObj.tpValue || mlObj.tp_estimate;
      const directSide = mlObj.tpSide || mlObj.side || mlObj.direction || mlObj.tpSide?.toString?.();
      if (directTp != null && !Number.isNaN(Number(directTp))) {
        return {
          tp: Number(directTp),
          confidence: Math.round( (mlObj.tpConfidence ?? mlObj.tp_conf ?? (mlProbMax ?? 0)) ),
          side: (directSide ? String(directSide) : (String(mlLabel || "Neutral")))
        };
      }
      return null;
    }

    function scoreTargetWithML(t, mlObj) {
      const tConf = Number(t.confidence || 0) / 100;
      let mlScore = 0.0;
      if (mlProbMax != null) mlScore = (Number(mlProbMax) / 100);
      return mlScore * 0.7 + tConf * 0.3;
    }

    let mlChosenTP = null;
    const directMlTP = pickMLTPFromModel(ml);
    if (directMlTP) {
      const s = String(directMlTP.side || "").toLowerCase();
      const side = s.includes("bull") || s.includes("long") ? "long" : s.includes("bear") || s.includes("short") ? "short" : null;
      mlChosenTP = { tp: directMlTP.tp, confidence: directMlTP.confidence || Math.round(mlProbMax || 0), side: side || "both" };
    } else {
      let bestLong = null, bestLongScore = -Infinity;
      let bestShort = null, bestShortScore = -Infinity;
      for (const t of annotatedTargets) {
        const score = scoreTargetWithML(t, ml);
        if (Number(t.tp) > price) {
          if (score > bestLongScore) { bestLongScore = score; bestLong = t; }
        } else if (Number(t.tp) < price) {
          if (score > bestShortScore) { bestShortScore = score; bestShort = t; }
        }
      }
      if (bestLong) mlChosenTP = { tp: Number(bestLong.tp), confidence: bestLong.confidence || Math.round((mlProbMax||0)), side: "long" };
      if (bestShort && (!mlChosenTP || (bestShort.confidence || 0) > (mlChosenTP.confidence || 0))) {
        // keep bestShort separate if needed later
      }
    }

    let mlLongTP = null, mlShortTP = null;
    if (ml && typeof ml === "object") {
      if (ml.longTP || ml.tpLong) {
        const v = ml.longTP || ml.tpLong;
        if (!Number.isNaN(Number(v))) mlLongTP = { tp: Number(v), confidence: Math.round(ml.longTPConfidence ?? ml.tpLongConf ?? (mlProbMax || 0)) };
      }
      if (ml.shortTP || ml.tpShort) {
        const v = ml.shortTP || ml.tpShort;
        if (!Number.isNaN(Number(v))) mlShortTP = { tp: Number(v), confidence: Math.round(ml.shortTPConfidence ?? ml.tpShortConf ?? (mlProbMax || 0)) };
      }
    }

    if (!mlLongTP) {
      if (mlChosenTP && mlChosenTP.side === "long") mlLongTP = { tp: mlChosenTP.tp, confidence: mlChosenTP.confidence || Math.round(mlProbMax || 0) };
      else {
        mlLongTP = (mlChosenTP && mlChosenTP.side === "both" && Number(mlChosenTP.tp) > price) ? { tp: mlChosenTP.tp, confidence: mlChosenTP.confidence } : (longs[0] ? { tp: Number(longs[0].tp), confidence: longs[0].confidence } : null);
      }
    }
    if (!mlShortTP) {
      if (mlChosenTP && mlChosenTP.side === "short") mlShortTP = { tp: mlChosenTP.tp, confidence: mlChosenTP.confidence || Math.round(mlProbMax || 0) };
      else {
        mlShortTP = (mlChosenTP && mlChosenTP.side === "both" && Number(mlChosenTP.tp) < price) ? { tp: mlChosenTP.tp, confidence: mlChosenTP.confidence } : (shorts[0] ? { tp: Number(shorts[0].tp), confidence: shorts[0].confidence } : null);
      }
    }

    // Build final report object
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
      ml,
      micro,
      mlAcc,
      mlDirection: mlLabel || "Neutral",
      mlLongTP,
      mlShortTP,
      mlProbs: {
        max: mlProbMax,
        bull: mlProbBull,
        bear: mlProbBear,
        neutral: mlProbNeutral
      },
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

    let mlProbDisplay = "N/A";
    if (report.mlProbs) {
      const mp = report.mlProbs;
      if (mp.bull != null && mp.bear != null && mp.neutral != null) {
        mlProbDisplay = `Bull: ${nf(mp.bull,2)}% | Bear: ${nf(mp.bear,2)}% | Neutral: ${nf(mp.neutral,2)}%`;
      } else if (mp.max != null) {
        mlProbDisplay = `${nf(mp.max,2)}% (max)`;
      }
    } else if (report.ml && typeof report.ml.prob === "number") {
      mlProbDisplay = `${nf(report.ml.prob,2)}% (max)`;
    }

    const mlLongTxt = report.mlLongTP ? `${nf(Number(report.mlLongTP.tp), 2)} [${report.mlLongTP.confidence}%]` : "N/A";
    const mlShortTxt = report.mlShortTP ? `${nf(Number(report.mlShortTP.tp), 2)} [${report.mlShortTP.confidence}%]` : "N/A";

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
Label: <b>${report.mlDirection || (report.ml?.label || "N/A")}</b>
Probability (max / breakdown): ${mlProbDisplay}
TP (ML): Long: ${mlLongTxt} | Short: ${mlShortTxt}
ML Accuracy (historic): ${report.mlAcc ?? "N/A"}%

<b>Micro ML</b>
1m/5m micro: ${report.micro?.label || "N/A"} (${report.micro?.prob ? Math.round(report.micro.prob*100)/100 + "%" : "N/A"}) — fast nudge

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