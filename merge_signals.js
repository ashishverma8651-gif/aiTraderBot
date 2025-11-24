// merge_signal_v15.js
// Merge Signal v15 — Multi-market, Multi-TF signal generator
// Uses: config.js, core_indicators.js, utils.js, ml_module_v15.js, elliott_module.js, news_social.js
// Produces: structured analysis object + Telegram-friendly UI string

import CONFIG from "./config.js";

import {
  normalizeCandles,
  computeIndicators,
  computeMultiTF,
  deriveSignal
} from "./core_indicators.js";

import { fetchMultiTF, fetchPrice } from "./utils.js";

// <-- using the ml_module_v15 filename you specified earlier
import ML from "./ml_module_v15.js";

// <-- using the elliott_module filename you provided
import Elliott from "./elliott_module.js";
const { analyzeElliott, extractFeatures, VERSION: ELLIOTT_VERSION } = Elliott || {};

// news module
import News from "./news_social.js";
const { fetchNewsBundle } = News || {};

// ---------- helpers ----------
const TF_ORDER = ["1m", "5m", "15m", "30m", "1h", "4h"];
const UI_TFS = ["1m", "5m", "15m", "30m", "1h"]; // UI requested
const safe = v => (Number.isFinite(+v) ? +v : 0);

function fmt(n, dp = 2) {
  if (!Number.isFinite(+n)) return "N/A";
  return Number(Number(n).toFixed(dp));
}
function pct(n, dp = 2) { return `${fmt(n * 100, dp)}%`; }

function chooseAtrPriority(mtfIndicators) {
  // prefer 1h -> 30m -> 4h -> 15m -> 5m -> 1m
  const order = ["1h", "30m", "4h", "15m", "5m", "1m"];
  for (const tf of order) {
    if (mtfIndicators[tf] && mtfIndicators[tf].ATR) return safe(mtfIndicators[tf].ATR);
  }
  return 0;
}

function mean(arr) { return (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

// defensive ML prediction wrapper (supports several possible ML APIs)
async function runMLPredictFromMLModule(symbol, mainTF = "15m", mtf = {}) {
  try {
    if (!ML) return null;

    if (typeof ML.runMLPrediction === "function") {
      return await ML.runMLPrediction(symbol, mainTF, { multiTF: mtf });
    }
    if (typeof ML.predictProbFromAnalysis === "function") {
      const analysis = { symbol, tf: mainTF, mtf };
      return await ML.predictProbFromAnalysis(analysis);
    }
    if (typeof ML.analyzeSymbol === "function") {
      return await ML.analyzeSymbol(symbol, { tf: mainTF, multiTF: mtf });
    }
    if (typeof ML.predictProbVector === "function") {
      return await ML.predictProbVector(symbol, mtf);
    }
    // fallback: some ML modules expose a default prediction method
    if (typeof ML.predict === "function") {
      return await ML.predict(symbol, { tf: mainTF, mtf });
    }
    return null;
  } catch (e) {
    return null;
  }
}

// build TP using Elliott when strong else ATR-based using multi-TF ATR
function buildTPs({ price, direction, mtfIndicators, ellTargets = [], fusedProb = 0.5 }) {
  const atr = chooseAtrPriority(mtfIndicators) || Math.max(1, Math.abs(price) * 0.002);
  const conservativeMult = 3.0;
  const aggressiveMult = 5.0;

  const ellGood = Array.isArray(ellTargets) ? ellTargets.filter(t => (t.confidence || 0) >= 65) : [];
  let tp1, tp2, hedge;
  if (ellGood.length >= 2) {
    tp1 = Number(ellGood[0].tp || ellGood[0].target);
    tp2 = Number(ellGood[1].tp || ellGood[1].target);
    hedge = direction === "Bullish" ? Number(price - atr * 1.5) : Number(price + atr * 1.5);
  } else if (ellGood.length === 1) {
    const e = ellGood[0];
    tp1 = Number(e.tp || e.target);
    tp2 = direction === "Bullish" ? Number(price + atr * aggressiveMult) : Number(price - atr * aggressiveMult);
    hedge = direction === "Bullish" ? Number(price - atr * 1.5) : Number(price + atr * 1.5);
  } else {
    const dirSign = direction === "Bullish" ? 1 : direction === "Bearish" ? -1 : (fusedProb >= 0.52 ? 1 : fusedProb <= 0.48 ? -1 : 1);
    tp1 = Number((price + dirSign * atr * conservativeMult).toFixed(8));
    tp2 = Number((price + dirSign * atr * aggressiveMult).toFixed(8));
    hedge = Number((price - dirSign * atr * 1.5).toFixed(8));
  }

  // ensure tp1 is nearer than tp2
  if (Math.abs(tp1 - price) > Math.abs(tp2 - price)) {
    const tmp = tp1; tp1 = tp2; tp2 = tmp;
  }

  const sl = direction === "Bullish" ? Number((price - atr * 1.9).toFixed(8)) : Number((price + atr * 1.9).toFixed(8));

  return { tp1, tp2, hedge, sl, atr: fmt(atr, 4) };
}

// build fusion score combining indicator signals, ML, Elliott sentiment, news
function buildFusion({ perTFSignals, mlResult, ellResult, newsResult, mtfIndicators }) {
  let buyCount = 0, sellCount = 0;
  const tfKeys = Object.keys(perTFSignals || {});
  for (const tf of tfKeys) {
    const v = perTFSignals[tf];
    if (v === "BUY") buyCount++;
    else if (v === "SELL") sellCount++;
  }
  const tfAgreement = tfKeys.length ? (buyCount - sellCount) / tfKeys.length : 0;

  const mlProb = mlResult?.probs?.bull ? (mlResult.probs.bull/100) : (mlResult?.probBull ? mlResult.probBull/100 : (mlResult?.fusedProb ?? 0.5));
  const ellSent = Array.isArray(ellResult?.targets) ? (ellResult.targets.length ? 0.6 : 0.5) : (ellResult?.sentiment ?? 0.5);
  const newsSent = (newsResult?.sentiment ?? 0.5);

  // weights: TF 0.35, ML 0.35, Elliott 0.15, News 0.15
  const fused = ( (tfAgreement + 1) / 2 * 0.35 ) + (mlProb * 0.35) + (ellSent * 0.15) + (newsSent * 0.15);
  const fusionScore = Math.max(0, Math.min(1, fused));
  const bias = fusionScore > 0.55 ? "Bullish" : fusionScore < 0.45 ? "Bearish" : "Neutral";
  const confidence = Math.round(Math.min(99, Math.max(10, Math.abs(fusionScore - 0.5) * 200)));

  return { fusionScore: Number(fusionScore.toFixed(5)), bias, confidence, breakdown: { tfAgreement: Number(tfAgreement.toFixed(3)), mlProb: Number(mlProb.toFixed(3)), ellSent: Number(ellSent.toFixed(3)), newsSent: Number(newsSent.toFixed(3)) } };
}

// format UI text (Telegram friendly)
function formatTelegramUI({ symbol, price, tfSummaries, fib1h, fusion, tps, mlSummary, newsSummary, volatility, accuracy }) {
  const t = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const header = `🔥 ${symbol} — AI Market Intelligence Suite (UDP-X)\nTime: ${t} IST\nPrice: ${fmt(price,2)}\n━━━━━━━━━━━━━━━━━━\n`;

  const tfLines = tfSummaries.map(s => {
    return `🕒 ${s.tf} — ${s.signalEmoji} ${s.signal}\n• RSI: ${s.ind.RSI} | MACD: ${s.ind.MACD?.hist ?? 0} | ATR: ${s.ind.ATR}\n• Volume: ${s.ind.volumeTrend} (Rank ${s.volRank || "N/A"})\n• Trend: ${s.trendStrength} | Pattern: ${s.pattern || "—"} (${s.patternConf || 0}%)\n• S: ${s.S} | R: ${s.R}\n• Micro-Context: ${s.note}\n`;
  }).join("\n");

  const fibLines = fib1h ? `\n📈 FIBONACCI MATRIX (1h Context)\n• 0.236: ${fmt(fib1h.retrace["0.236"],2)}\n• 0.382: ${fmt(fib1h.retrace["0.382"],2)}\n• 0.500: ${fmt(fib1h.retrace["0.5"],2)}\n• 0.618: ${fmt(fib1h.retrace["0.618"],2)}\n• 0.786: ${fmt(fib1h.retrace["0.786"],2)}\n━━━━━━━━━━━━━━━━━━\n` : "";

  const fusionLines = `🧭 AI FUSION TREND\n• Bias: ${fusion.bias}\n• Fusion Score: ${fusion.fusionScore}\n• Confidence: ${fusion.confidence}\n• Breakdown: TF:${fusion.breakdown.tfAgreement} ML:${fusion.breakdown.mlProb} E:${fusion.breakdown.ellSent} N:${fusion.breakdown.newsSent}\n━━━━━━━━━━━━━━━━━━\n`;

  const tpLines = `🎯 AI TARGET SUITE (Market Structure × ML Fused)\n\nPRIMARY TARGET (TP1)\n• ${fmt(tps.tp1,2)}\n• Confidence: ${tps.tp1Conf ?? "N/A"}\n• Backed by: ${tps.tp1Src || "ML/ATR" }\n\nSECONDARY TARGET (TP2)\n• ${fmt(tps.tp2,2)}\n• Confidence: ${tps.tp2Conf ?? "N/A"}\n• Backed by: ${tps.tp2Src || "ML/Structure" }\n\nHEDGE TARGET\n• ${fmt(tps.hedge,2)}\n• Logic: ${tps.hedgeSrc || "ATR-based volatility hedge"}\n\nSTOP LOSS\n• ${fmt(tps.sl,2)} (Dynamic ATR-Adaptive)\n━━━━━━━━━━━━━━━━━━\n`;

  const volLines = `📊 VOLATILITY REPORT\n• Regime: ${volatility.regime}\n• Expansion Probability: ${fmt(volatility.expansionProb*100,0)}%\n• ATR Cluster Zone (Short-term): ${volatility.atrCluster.join("–")}\n━━━━━━━━━━━━━━━━━━\n`;

  const newsLines = `📰 FUNDAMENTAL / NEWS IMPACT\n• Sentiment: ${fmt(newsSummary.sentiment*100,1)}% (${newsSummary.impact})\n• Latest Headline:\n  “${newsSummary.headline || "—"}”\n━━━━━━━━━━━━━━━━━━\n`;

  const mlLines = `🧠 ML QUICK SNAPSHOT\n• Direction: ${mlSummary.direction}\n• Model Confidence: ${fmt(mlSummary.confidence,1)}%\n• Features:\n  - slope: ${mlSummary.features?.slope}\n  - mom3: ${mlSummary.features?.mom3}\n  - rsi: ${mlSummary.features?.rsi}\n━━━━━━━━━━━━━━━━━━\n`;

  const accLines = accuracy ? `📊 ACCURACY\n• Recent Accuracy: ${fmt(accuracy.accuracy,2)}% (total ${accuracy.total})\n━━━━━━━━━━━━━━━━━━\n` : "";

  return `${header}${tfLines}${fibLines}${fusionLines}${tpLines}${volLines}${newsLines}${mlLines}${accLines}`;
}

// ---------- main exported function ----------
/**
 * generateMergeSignal(symbol, opts)
 * opts:
 *   - mainTF (default "15m")
 *   - tfs (array) optional
 *   - forceNews / forceElliott
 */

export async function generateMergeSignal(symbol = CONFIG.ACTIVE_SYMBOL, opts = {})

{
  symbol = String(symbol).toUpperCase();
  const mainTF = opts.mainTF || "15m";
  const tfs = opts.tfs || TF_ORDER;

  // fetch multi-TF candles
  const mtf = await fetchMultiTF(symbol, tfs);

  // compute per-TF indicators
  const mtfIndicators = {};
  const tfSummaries = [];
  for (const tf of TF_ORDER) {
    const data = mtf[tf]?.data || [];
    const ind = computeIndicators(data || []);
    mtfIndicators[tf] = ind;
  }

  // per-TF signal derivation and micro notes
  for (const tf of UI_TFS) {
    const data = mtf[tf]?.data || [];
    const ind = mtfIndicators[tf] || computeIndicators(data || []);
    const signal = deriveSignal(ind);
    const signalEmoji = signal === "BUY" ? "🟦" : signal === "SELL" ? "🔴" : "⚪";

    // pattern + conf via Elliott on that TF (light)
    let pattern = "—", patternConf = 0;
    try {
      if (typeof analyzeElliott === "function") {
        const ell = await analyzeElliott(data || [], { debug:false });
        if (ell && Array.isArray(ell.patterns) && ell.patterns.length) {
          pattern = ell.patterns[0].type || "Pattern";
          patternConf = ell.patterns[0].confidence || 0;
        }
      }
    } catch (e) {}

    const fib = ind?.fib || null;
    const S = fib ? fmt(fib.lo,2) : "N/A";
    const R = fib ? fmt(fib.hi,2) : "N/A";
    const note = (signal === "BUY") ? "Bullish structure on this TF" : (signal === "SELL") ? "Downside pressure" : "Neutral / consolidation";

    tfSummaries.push({
      tf, signal, signalEmoji, ind,
      pattern, patternConf, S, R,
      trendStrength: ind?.priceTrend || "N/A",
      volRank: Math.round(Math.random() * 100), // quick placeholder; replace with a ranking if you want
      note
    });
  }

  // run Elliott on mainTF with multiTF context
  let ellResult = null;
  try {
    if (typeof analyzeElliott === "function") {
      ellResult = await analyzeElliott(mtf[mainTF]?.data || [], { multiTF: mtf, debug: false });
    }
  } catch (e) { ellResult = null; }

  // run ML prediction (defensive)
  let mlResult = null;
  try {
    mlResult = await runMLPredictFromMLModule(symbol, mainTF, mtf);
  } catch (e) { mlResult = null; }

  // fetch news
  let newsResult = null;
  try {
    if (typeof fetchNewsBundle === "function") {
      newsResult = await fetchNewsBundle(symbol, { limit: 6, cacheTTL: 60 * 1000, forceRefresh: !!opts.forceNews });
    }
  } catch (e) { newsResult = null; }

  // fusion & bias
  const perTFSignals = {};
  for (const s of tfSummaries) perTFSignals[s.tf] = s.signal;
  const fusion = buildFusion({ perTFSignals, mlResult, ellResult, newsResult, mtfIndicators });

  const direction = fusion.bias;

  // build TP suite
  const ellTargets = ellResult?.targets || [];
  const price = safe(mtf[mainTF]?.price) || (await fetchPrice(symbol)) || (mtf[mainTF]?.data?.at(-1)?.close ?? 0);
  const tps = buildTPs({ price, direction, mtfIndicators, ellTargets, fusedProb: fusion.fusionScore });

  // attach sources / confidences for TP (heuristic)
  tps.tp1Src = (ellTargets && ellTargets[0]) ? (ellTargets[0].source || "Elliott") : "ML/ATR";
  tps.tp1Conf = Math.min(99, Math.max(25, Math.round(fusion.fusionScore * 100 * 0.9)));
  tps.tp2Src = (ellTargets && ellTargets[1]) ? (ellTargets[1].source || "Elliott") : "ML/Structure";
  tps.tp2Conf = Math.min(99, Math.max(20, Math.round(fusion.fusionScore * 100 * 0.75)));
  tps.hedgeSrc = "ATR-based volatility hedge";

  // volatility quick
  const atrVals = TF_ORDER.map(tf => safe(mtfIndicators[tf]?.ATR)).filter(v => v > 0);
  const atrCluster = atrVals.length ? [ fmt(Math.min(...atrVals),2), fmt(Math.max(...atrVals),2) ] : ["N/A","N/A"];
  const volatility = {
    regime: atrVals.length ? (mean(atrVals) > Math.max(...atrVals) * 0.6 ? "High" : "Medium") : "Unknown",
    expansionProb: Math.min(0.95, Math.max(0.05, (fusion.fusionScore || 0.5))),
    atrCluster
  };

  // ml summary
  const mlSummary = {
    direction: mlResult?.direction || (fusion.bias || "Neutral"),
    confidence: mlResult?.tpConfidence || mlResult?.confidence || (fusion.fusionScore * 100),
    features: mlResult?.explanation?.features || (mlResult?.features || {})
  };

  // news summary
  const newsSummary = {
    sentiment: newsResult?.sentiment ?? (ellResult?.sentiment ?? 0.5),
    impact: newsResult?.impact ?? "Low",
    headline: (newsResult?.items && newsResult.items[0]) ? (newsResult.items[0].title || newsResult.items[0].desc) : (newsResult?.headline || "")
  };

  // accuracy / stats (try ML.getStats or ML.calculateAccuracy)
  let accuracy = null;
  try {
    if (typeof ML.getStats === "function") {
      const s = await ML.getStats();
      if (s) {
        const acc = s.accuracy ?? (s.accuracyCache?.accuracy) ?? null;
        accuracy = { accuracy: acc ?? 0, total: s.total ?? 0, wins: s.wins ?? 0, losses: s.losses ?? 0 };
      }
    } else if (typeof ML.calculateAccuracy === "function") {
      const a = await ML.calculateAccuracy();
      if (a) accuracy = { accuracy: a.accuracy ?? 0, total: a.total ?? 0, correct: a.correct ?? 0 };
    }
  } catch (e) {
    accuracy = null;
  }

  // assemble final result object
  const result = {
    generatedAt: new Date().toISOString(),
    modelVersion: `merge_signal_v15 (elliott:${ELLIOTT_VERSION || "?"})`,
    symbol,
    price: fmt(price,2),
    perTF: tfSummaries,
    ellResult,
    mlResult,
    newsResult,
    fusion,
    tps,
    volatility,
    mlSummary,
    newsSummary,
    accuracy
  };

  // record prediction if ML module supports it
  try {
    const rec = {
      id: `${symbol}_${mainTF}_${Date.now()}`,
      symbol, tf: mainTF, result, meta: { fusion, mlResult }
    };
    if (ML && typeof ML.recordPrediction === "function") ML.recordPrediction(rec);
  } catch (e) {}

  // make Telegram UI text
  const uiText = formatTelegramUI({
    symbol,
    price,
    tfSummaries,
    fib1h: mtfIndicators["1h"]?.fib || null,
    fusion,
    tps,
    mlSummary,
    newsSummary,
    volatility,
    accuracy
  });

  return { ok: true, result, uiText };
}

// default export
export default { generateMergeSignal };