// merge_signals.js
// Merge core indicators + Elliott + ML + volume + news into a single signal
// ES module

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const FEEDBACK_FILE = path.resolve("./cache/merge_signals_feedback.json");

// safe helpers
const safeNum = (v) => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "object") {
    // try to extract numeric value
    if ("value" in v && typeof v.value === "number") return v.value;
    if (Array.isArray(v) && v.length) {
      const last = v.at(-1);
      return typeof last === "number" ? last : (typeof last?.macd === "number" ? last.macd : NaN);
    }
    // last resort: try numeric conversion
    const n = Number(Object.values(v).at(-1));
    return Number.isFinite(n) ? n : NaN;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

function clamp(val, min = 0, max = 100) {
  if (Number.isNaN(val) || val === null || val === undefined) return 0;
  return Math.max(min, Math.min(max, val));
}

// load/save feedback (very small, file-backed)
function readFeedback() {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return { entries: [], summary: {} };
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf8") || "{}");
  } catch (e) {
    return { entries: [], summary: {} };
  }
}
function saveFeedback(obj) {
  try {
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn("merge_signals: feedback save failed", e && e.message);
  }
}

/**
 * recordFeedback(id, correct:boolean)
 * id should be the prediction id returned in the merged signal (optional).
 */
export function recordFeedback(predictionId, correct = true) {
  try {
    const fb = readFeedback();
    const entry = { id: predictionId ?? `pred_${Date.now()}`, correct: !!correct, ts: Date.now() };
    fb.entries.push(entry);

    // update summary
    const total = fb.entries.length;
    const correctCount = fb.entries.filter((e) => e.correct).length;
    fb.summary = {
      total,
      correct: correctCount,
      accuracy: total ? +(correctCount / total * 100).toFixed(2) : 0,
      lastUpdated: Date.now()
    };

    saveFeedback(fb);
    return fb.summary;
  } catch (e) {
    console.warn("recordFeedback failed", e && e.message);
    return null;
  }
}

/**
 * mergeSignals(indicators, ell, ml, opts = {})
 * indicators: object possibly containing rsi, macd, atr, vol (numbers or objects)
 * ell: output from elliott module (may contain direction/wave/confidence)
 * ml: output from ML module (prob, label, details)
 * opts: optional weights override { weights: { rsi:.., macd:.., volume:.., ell:.., news:.., ml:.. } }
 *
 * returns:
 * {
 *   bias: "Buy"|"Sell"|"Neutral",
 *   strength: 0-100,
 *   mlProb,
 *   signals: { rsiScore, macdScore, volumeScore, ellScore, newsScore },
 *   rationale: [string],
 *   id: prediction id (for feedback)
 * }
 */
export function mergeSignals(indicators = {}, ell = {}, ml = {}, opts = {}) {
  const weights = Object.assign({
    rsi: 0.20,
    macd: 0.25,
    volume: 0.15,
    atr: 0.05,
    elliott: 0.15,
    news: 0.10,
    ml: 0.10   // ML acts as an additive confidence input (not dominant)
  }, opts.weights || {});

  // extract values safely
  const rsiVal = safeNum(indicators.rsi);
  const macdVal = safeNum(indicators.macd);
  const atrVal = safeNum(indicators.atr);
  const volVal = safeNum(indicators.vol);
  // ml expected shape: { prob: 0-100, label: "Buy"/"Sell"/"Neutral", details: {...} }
  const mlProb = ml?.prob ?? safeNum(ml?.prob) ?? (typeof ml === "number" ? ml : NaN);
  const mlLabel = (ml && ml.label) ? String(ml.label) : null;

  // Elliott: try to extract directional bias and confidence
  const ellBias = (ell && (ell.bias || ell.direction || ell.structure)) ? String(ell.bias || ell.direction || ell.structure).toLowerCase() : null;
  const ellConf = Number(ell?.confidence ?? ell?.conf ?? 0);

  // News impact: could be numeric score -1..1 or -100..100
  let newsScoreRaw = NaN;
  if (ell && typeof ell.newsImpact !== "undefined") newsScoreRaw = safeNum(ell.newsImpact);
  if (indicators && typeof indicators.newsImpact !== "undefined") newsScoreRaw = safeNum(indicators.newsImpact);
  // try ml.news?
  if (typeof ml?.newsImpact !== "undefined") newsScoreRaw = safeNum(ml.newsImpact);

  // --- scoring rules ---
  // RSI score: below 30 -> buy signal strength, above 70 -> sell signal strength
  let rsiScore = 0;
  if (!Number.isNaN(rsiVal)) {
    if (rsiVal <= 30) rsiScore = clamp((30 - rsiVal) / 30 * 100); // stronger as it goes lower
    else if (rsiVal >= 70) rsiScore = clamp((rsiVal - 70) / 30 * 100) * -1; // negative => sell
    else rsiScore = 0;
  }

  // MACD score: positive => buy, negative => sell. weight by magnitude normalized to ATR
  let macdScore = 0;
  if (!Number.isNaN(macdVal)) {
    // Normalize by a moving scale: if ATR available use that, else use an empirical denom
    const denom = Math.max(1, Math.abs(atrVal) || Math.abs(indicators.price || 1) * 0.002 || 1);
    macdScore = clamp((macdVal / denom) * 10); // scale factor
  }

  // Volume/volatility score: high volume spike => confirm direction
  let volumeScore = 0;
  if (!Number.isNaN(volVal)) {
    // simple rule: if vol > historical avg (if provided) then positive confirmation
    const avgVol = Number(indicators.avgVol ?? indicators.volumeAvg ?? 0);
    if (avgVol && avgVol > 0) {
      if (volVal > avgVol * 1.5) volumeScore = 30;
      else if (volVal > avgVol * 1.2) volumeScore = 15;
      else if (volVal < avgVol * 0.5) volumeScore = -10;
    } else {
      // fallback using absolute thresholds (best-effort)
      volumeScore = 0;
    }
  }

  // News score: positive (buy) or negative (sell)
  let newsScore = 0;
  if (!Number.isNaN(newsScoreRaw)) {
    // assume newsScoreRaw in range -1..1 or -100..100
    if (Math.abs(newsScoreRaw) <= 1) newsScore = clamp(newsScoreRaw * 100, -100, 100);
    else newsScore = clamp(newsScoreRaw, -100, 100);
  }

  // Elliott score: try to interpret
  let ellScore = 0;
  if (ellBias) {
    const b = ellBias.toLowerCase();
    if (b.includes("buy") || b.includes("bull") || b.includes("up")) ellScore = Math.min(100, ellConf || 50);
    else if (b.includes("sell") || b.includes("bear") || b.includes("down")) ellScore = -(Math.min(100, ellConf || 50));
  }

  // ML contribution: mlProb positive boosts consensus if label matches; otherwise small adjustment
  let mlScore = 0;
  if (!Number.isNaN(mlProb)) {
    const normalized = clamp(Number(mlProb));
    if (mlLabel) {
      if (/buy/i.test(mlLabel)) mlScore = normalized * 0.6;
      else if (/sell/i.test(mlLabel)) mlScore = -normalized * 0.6;
      else mlScore = (normalized - 50) * 0.2; // neutral-ish
    } else {
      mlScore = (normalized - 50) * 0.4;
    }
  }

  // Compose weighted score
  // convert rsiScore/macdScore/ellScore/newsScore etc to -100..100 scale if needed
  const rsiScaled = clamp(rsiScore, -100, 100);
  const macdScaled = clamp(macdScore, -100, 100);
  const volumeScaled = clamp(volumeScore, -100, 100);
  const ellScaled = clamp(ellScore, -100, 100);
  const newsScaled = clamp(newsScore, -100, 100);
  const mlScaled = clamp(mlScore, -100, 100);

  // weighted sum
  const numerator =
    (rsiScaled * weights.rsi) +
    (macdScaled * weights.macd) +
    (volumeScaled * weights.volume) +
    (ellScaled * weights.elliott) +
    (newsScaled * weights.news) +
    (mlScaled * weights.ml);

  const denom =
    weights.rsi + weights.macd + weights.volume + weights.elliott + weights.news + weights.ml;

  const rawScore = denom ? numerator / denom : 0; // -100..100-ish

  // map rawScore to bias + strength
  let bias = "Neutral";
  if (rawScore > 10) bias = "Buy";
  else if (rawScore < -10) bias = "Sell";

  const strength = clamp(Math.round(Math.abs(rawScore)), 0, 100);

  // Build rationale (human readable)
  const rationale = [];
  if (!Number.isNaN(rsiVal)) {
    if (rsiVal <= 30) rationale.push(`RSI ${rsiVal.toFixed(2)} oversold → buy bias`);
    else if (rsiVal >= 70) rationale.push(`RSI ${rsiVal.toFixed(2)} overbought → sell bias`);
    else rationale.push(`RSI ${rsiVal.toFixed(2)} neutral`);
  } else {
    rationale.push("RSI: no data");
  }

  if (!Number.isNaN(macdVal)) rationale.push(`MACD ${macdVal.toFixed(2)}`);
  else rationale.push("MACD: no data");

  if (!Number.isNaN(volVal)) rationale.push(`Vol ${Math.round(volVal)} (${indicators.avgVol ? `avg ${Math.round(indicators.avgVol)}` : "no avg"})`);
  else rationale.push("Vol: no data");

  if (!Number.isNaN(newsScore)) rationale.push(`News impact ${newsScore}`);
  if (ellBias) rationale.push(`Elliott: ${ellBias} (${ellConf || 0}%)`);
  if (!Number.isNaN(mlProb)) rationale.push(`ML: ${mlProb}% ${mlLabel ? `(${mlLabel})` : ""}`);

  // Compose final object
  const id = `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  const out = {
    id,
    bias,
    strength,
    score: rawScore,
    mlProb: Number.isNaN(mlProb) ? null : Number(mlProb),
    signals: {
      rsi: Number.isNaN(rsiVal) ? null : rsiVal,
      macd: Number.isNaN(macdVal) ? null : macdVal,
      atr: Number.isNaN(atrVal) ? null : atrVal,
      vol: Number.isNaN(volVal) ? null : volVal,
      rsiScore: rsiScaled,
      macdScore: macdScaled,
      volumeScore: volumeScaled,
      ellScore: ellScaled,
      newsScore: newsScaled,
      mlScore: mlScaled
    },
    rationale,
    timestamp: Date.now()
  };

  return out;
}

export default mergeSignals;