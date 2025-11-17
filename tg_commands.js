// tg_commands_v9_final.js — AI Trader TG command (v9 compatible)
// Uses: elliott_module.js, ml_module_v8_6.js, core_indicators.js, utils.js, news_social.js
// Exports: buildAIReport(symbol) -> report object, formatAIReport(report) -> plain-text UI string

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
} from "./ml_module_v8_6.js"; // using your file (kept import style exactly)

import newsModule from "./news_social.js"; // default export as in your repo

// -----------------------------
// Small helpers
// -----------------------------
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";

function clamp(v, lo = -Infinity, hi = Infinity) {
  return Math.max(lo, Math.min(hi, v));
}
function pctClamp(p) { // ensure finite 0..100
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.max(0, Math.min(100, p)) * 100) / 100;
}
function safeToPct(val) {
  // Accept val in 0..1 or 0..100; return 0..100
  if (val == null || Number.isNaN(Number(val))) return null;
  const n = Number(val);
  if (n >= 0 && n <= 1) return n * 100;
  return n;
}

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
  } catch (e) {
    return String(iso || new Date());
  }
}

function fusionLabel(score) {
  if (score >= 0.70) return { label: "STRONG BUY", emoji: "🟩" };
  if (score >= 0.20) return { label: "BUY", emoji: "🟦" };
  if (score > -0.20 && score < 0.20) return { label: "NEUTRAL", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "SELL", emoji: "🟧" };
  return { label: "STRONG SELL", emoji: "🟥" };
}

// -----------------------------
// Fusion scoring per TF (kept same)
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
// TF block builder (for text UI)
function buildTFText(tfLabel, values) {
  // values: { sig, rsi, macd, vol, atr, ell, ellConf, s, r, tpArr, sl }
  const tps = Array.isArray(values.tpArr) ? values.tpArr.map(v => nf(v,2)) : [];
  // ensure placeholders per template:
  const tpA = tps[0] || "N/A";
  const tpB = tps[1] || "N/A";
  const tpC = tps[2] || "N/A";

  return [
    `🕒 ${tfLabel} — ${values.sig}`,
    `RSI ${values.rsi} | MACD ${values.macd} | Vol ${values.vol} | ATR ${values.atr}`,
    `Elliott: ${values.ell} | Conf ${values.ellConf}%`,
    `S: ${values.s} | R: ${values.r}`,
    `TP 🎯: ${tpA}${tpB !== "N/A" ? " / " + tpB : ""}${tpC !== "N/A" ? " / " + tpC : ""}  `,
    `SL: ${values.sl}`
  ].join("\n");
}

// -----------------------------
// Safely call Elliott
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false, error: ell?.error || "elliott_err" };
    const pivots = ell.pivots || [];

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
      // prefer probs object
      if (ml.probs && typeof ml.probs === "object") {
        if (typeof ml.probs.bull === "number") mlProbBull = safeToPct(ml.probs.bull);
        if (typeof ml.probs.bear === "number") mlProbBear = safeToPct(ml.probs.bear);
        if (typeof ml.probs.neutral === "number") mlProbNeutral = safeToPct(ml.probs.neutral);
      }
      // legacy fields
      if (typeof ml.probBull === "number" && mlProbBull == null) mlProbBull = safeToPct(ml.probBull);
      if (typeof ml.probBear === "number" && mlProbBear == null) mlProbBear = safeToPct(ml.probBear);
      if (typeof ml.probNeutral === "number" && mlProbNeutral == null) mlProbNeutral = safeToPct(ml.probNeutral);
      if (typeof ml.prob === "number" && mlProbMax == null) mlProbMax = safeToPct(ml.prob);
    }

    // Normalize per-class probabilities if any present
    if (mlProbBull != null || mlProbBear != null || mlProbNeutral != null) {
      mlProbBull = pctClamp(mlProbBull ?? 0);
      mlProbBear = pctClamp(mlProbBear ?? 0);
      mlProbNeutral = pctClamp(mlProbNeutral ?? 0);

      // fix rounding drift to sum 100
      let s = mlProbBull + mlProbBear + mlProbNeutral;
      if (s <= 0) { mlProbBull = mlProbBear = mlProbNeutral = 33.33; s = 100; }
      mlProbBull = Math.round((mlProbBull / s) * 10000) / 100;
      mlProbBear = Math.round((mlProbBear / s) * 10000) / 100;
      mlProbNeutral = Math.round((mlProbNeutral / s) * 10000) / 100;

      mlProbMax = Math.max(mlProbBull, mlProbBear, mlProbNeutral);
      const idx = [mlProbBull, mlProbBear, mlProbNeutral].indexOf(mlProbMax);
      mlLabel = idx === 0 ? "Bullish" : idx === 1 ? "Bearish" : "Neutral";
    } else if (mlProbMax == null && ml && typeof ml === "object") {
      // fallback: other fields that might be in 0..1 or 0..100
      const candidate = ml.predictionConfidence ?? ml.confidence ?? ml.score ?? null;
      if (candidate != null) mlProbMax = safeToPct(candidate);
    } else if (mlProbMax != null) {
      mlProbMax = pctClamp(mlProbMax);
    }

    // mlBias: +1 for bullish, -1 for bearish
    let mlBias = 0;
    if (mlLabel) {
      if (String(mlLabel).toLowerCase().includes("bull")) mlBias = +1;
      else if (String(mlLabel).toLowerCase().includes("bear")) mlBias = -1;
    }

    // nudge fusion using ML and news
    let boosted = clamp(overallFusion + mlBias * mlWeight, -1, 1);
    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5;
    const newsBias = ((newsSent - 0.5) * 2);
    boosted = clamp(boosted + newsBias * newsWeight, -1, 1);
    overallFusion = Number(boosted.toFixed(3));

    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    // -----------------------------
    // ML TP selection (simple fallback)
    // -----------------------------
    let mlSellTP = null, mlBuyTP = null, mlConf = Math.round(mlProbMax || ml.tpConfidence || ml.tp_conf || ml.maxProb || 0);
    if (ml && typeof ml === "object") {
      // try common fields
      mlSellTP = ml.shortTP || ml.tpShort || ml.tp_sell || ml.sell_tp || null;
      mlBuyTP = ml.longTP || ml.tpLong || ml.tp_buy || ml.buy_tp || null;
      if (!mlSellTP && ml.tpEstimate && String(ml.direction||"").toLowerCase().includes("bear")) mlSellTP = ml.tpEstimate;
      if (!mlBuyTP && ml.tpEstimate && String(ml.direction||"").toLowerCase().includes("bull")) mlBuyTP = ml.tpEstimate;
    }

    // -----------------------------
    // Build UI placeholders (map values)
    // -----------------------------
    // For each TF we will create signature, rsi, macd, vol, atr, ell name, ellConf, s, r, tp array, sl
    const placeholderTF = {};
    for (const block of mtf) {
      const tfName = block.tf;
      const fusion = Number(block.fusionScore ?? 0);
      const sig = fusion >= 0.2 ? (fusion >= 0.7 ? "BUY" : "BUY") : (fusion <= -0.2 ? "SELL" : "NEUTRAL");
      const rsi = isFinite(block.indicators?.RSI) ? Math.round(block.indicators.RSI) : "N/A";
      const macd = isFinite(block.indicators?.MACD?.hist) ? Math.round(block.indicators.MACD.hist) : 0;
      const volTxt = (block.vol && block.vol.status) ? block.vol.status : (block.indicators?.volumeTrend || "N/A");
      const atr = isFinite(block.indicators?.ATR) ? Math.round(block.indicators.ATR) : "N/A";
      const ellName = (block.ell && (block.ell.patterns && block.ell.patterns[0] && block.ell.patterns[0].type)) ? block.ell.patterns[0].type : ((block.ell && block.ell.summary) ? block.ell.summary : "No major");
      const ellConf = Number(block.ell?.confidence ?? block.ell?.conf ?? 0);
      const s = block.ellSummary?.support != null ? nf(block.ellSummary.support,2) : (block.fib?.lo ? nf(block.fib.lo,2) : "N/A");
      const r = block.ellSummary?.resistance != null ? nf(block.ellSummary.resistance,2) : (block.fib?.hi ? nf(block.fib.hi,2) : "N/A");
      // tps: prefer targets array, else use annotatedTargets from global
      const tps = Array.isArray(block.targets) && block.targets.length ? block.targets.map(t=>Number(t.tp||t.target||t.price||0)).filter(x=>x>0) : [];
      const sl = (block.targets && block.targets[0] && block.targets[0].suggestedSL) ? nf(block.targets[0].suggestedSL,2) : (block.indicators?.ATR ? nf((block.price - (block.indicators.ATR * 2)),2) : "N/A");

      placeholderTF[tfName] = {
        sig,
        rsi,
        macd,
        vol: volTxt,
        atr,
        ell: ellName,
        ellConf,
        s,
        r,
        tpArr: tps,
        sl
      };
    }

    // Fill missing TF keys from mtf (if some TF missing)
    const getTF = (k) => placeholderTF[k] || { sig:"NEUTRAL", rsi:"N/A", macd:0, vol:"N/A", atr:"N/A", ell:"No major", ellConf:0, s:"N/A", r:"N/A", tpArr:[], sl:"N/A" };

    // overall bias label
    const biasLabel = fusionLabel(Number(overallFusion ?? 0));
    const buyProb = Number((probsBoosted.buy ?? 50).toFixed(2));
    const sellProb = Number((probsBoosted.sell ?? 50).toFixed(2));

    // overall TP ranges (bull & bear) -> use annotatedTargets / longs / shorts
    const bullRange = longs.length ? `${nf(Math.min(...longs.map(l=>l.tp)),2)} – ${nf(Math.max(...longs.map(l=>l.tp)),2)}` : "n/a";
    const bearRange = shorts.length ? `${nf(Math.min(...shorts.map(s=>s.tp)),2)} – ${nf(Math.max(...shorts.map(s=>s.tp)),2)}` : "n/a";
    const neutralSL = nf((mtf.find(x=>x.tf==="15m")?.indicators?.ATR ? ( (mtf.find(x=>x.tf==="15m").price) - (mtf.find(x=>x.tf==="15m").indicators.ATR) ) : (mtf.find(x=>x.tf==="15m")?.price ? mtf.find(x=>x.tf==="15m").price * 0.995 : 0)), 2);

    const mlDir = mlLabel || (ml?.direction || ml?.label || "Neutral");
    const mlConfidenceVal = Math.round(mlConf || (ml?.maxProb ?? ml?.tpConfidence ?? 0));

    // top news headline
    const headline = (news && news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : "No major headline";

    // Compose UI exactly following template (plain text)
    const lines = [];

    lines.push(`🔥 ${symbol} — AI Market Intelligence`);
    lines.push(`Time (IST): ${nowIST()}`);
    lines.push(`Price: ${nf(price,2)}`);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push("");
    lines.push(`📊 MULTI-TIMEFRAME PANEL`);
    lines.push(`(Short | Clean | Cluster-Free)`);
    lines.push("");

    // 1m
    lines.push(buildTFText("1M", getTF("1m")));
    lines.push("");
    // 5m
    lines.push(buildTFText("5M", getTF("5m")));
    lines.push("");
    // 15m
    lines.push(buildTFText("15M", getTF("15m")));
    lines.push("");
    // 30m
    lines.push(buildTFText("30M", getTF("30m")));
    lines.push("");
    // 1h
    lines.push(buildTFText("1H", getTF("1h")));
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push("🧭 OVERALL BIAS");
    lines.push(`Bias: ${biasLabel.emoji} ${biasLabel.label}`);
    lines.push(`Fusion Score: ${overallFusion}`);
    lines.push(`Buy ${buyProb}% | Sell ${sellProb}%`);
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push("🎯 OVERALL TP (AI Driven)");
    lines.push(`Bullish TP: ${bullRange}`);
    lines.push(`Bearish TP: ${bearRange}`);
    lines.push(`SL (Neutral Invalidation): ${neutralSL}`);
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push("🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)");
    lines.push(`Direction: ${mlDir}`);
    lines.push(`ML Confidence: ${mlConfidenceVal}%`);
    lines.push("");
    lines.push("📌 ML Says:");
    lines.push(`“${ml?.explanation || ml?.quote || (ml?.reason || "Model forecast") }”`);
    lines.push("");
    lines.push("ML Targets:");
    lines.push(`• ML Sell TP: ${mlSellTP ? nf(Number(mlSellTP),2) : (report?.mlShortTP ? nf(report.mlShortTP.tp,2) : "N/A")}`);
    lines.push(`• ML Buy TP (Hedge): ${mlBuyTP ? nf(Number(mlBuyTP),2) : (report?.mlLongTP ? nf(report.mlLongTP.tp,2) : "N/A")}`);
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("");
    lines.push("📰 NEWS IMPACT (Connected to ML)");
    lines.push(`Impact: ${news?.impact || "Low"}`);
    lines.push(`Sentiment: ${typeof news?.sentiment === "number" ? Math.round(news.sentiment*1000)/10 + "%" : "N/A"}`);
    lines.push(`Headline: *“${headline}”*`);
    lines.push("━━━━━━━━━━━━━━━━━━");

    const ui = lines.join("\n");

    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb,
      sellProb,
      longs,
      shorts,
      ml,
      micro,
      mlAcc,
      news,
      generatedAt: new Date().toISOString(),
      uiText: ui
    };

  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// -----------------------------
// FORMAT: produce plain-text UI string (final exported function)
export async function formatAIReport(report) {
  try {
    // Accept either a report object returned from buildAIReport OR a minimal object with uiText
    if (!report) return "⚠️ Empty report";

    if (typeof report === "object" && report.uiText) {
      // buildAIReport already returned the formatted UI in uiText
      return report.uiText;
    }

    // If report looks like buildAIReport internal structure (older usage), try to reconstruct UI
    // We'll call buildAIReport to create consistent ui
    if (!report.ok) {
      // maybe user passed raw object from other source - attempt to re-build
      const rebuilt = await buildAIReport(report.symbol || CONFIG.SYMBOL);
      if (rebuilt && rebuilt.ok && rebuilt.uiText) return rebuilt.uiText;
      return `⚠️ Failed to build report: ${report.error || "unknown error"}`;
    }

    // If report.ok and no uiText, reconstruct UI using same logic as buildAIReport would.
    // For simplicity call buildAIReport fresh (ensures same formatting)
    const fresh = await buildAIReport(report.symbol || CONFIG.SYMBOL);
    if (fresh && fresh.ok && fresh.uiText) return fresh.uiText;

    return "⚠️ Unable to format report";
  } catch (e) {
    return `formatAIReport error: ${e?.message || String(e)}`;
  }
}

// -----------------------------
// default export (keeps same API)
export default { buildAIReport, formatAIReport };