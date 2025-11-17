// ml_module_v8_6.js  (FIXED)
// Lightweight deterministic ML heuristics + reversal watcher + logging
// Exports: runMLPrediction, runMicroPrediction, checkReversalSignal, calculateAccuracy, recordPrediction, recordOutcome
// NOTE: replace the existing ml_module_v8_6.js file with this content.

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ---------------------------
// Config & persistence
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

let memPreds = [];
let memOuts = [];

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) { return []; }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);
  } catch (e) { memPreds.push(pred); }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(OUT_FILE, arr)) memOuts.push(outcome);
  } catch (e) { memOuts.push(outcome); }
}

export function calculateAccuracy() {
  try {
    const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.correct).length;
    return { accuracy: Math.round((correct/total)*10000)/100, total, correct };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// ---------------------------
// Helpers (stable softmax / clamp)
function clamp(v, lo = -Infinity, hi = Infinity) { return Math.max(lo, Math.min(hi, v)); }
function softmaxStable(arr) {
  if (!Array.isArray(arr) || !arr.length) return arr;
  // numeric stable softmax
  const max = Math.max(...arr);
  const exps = arr.map(a => Math.exp(a - max));
  const s = exps.reduce((a,b) => a + b, 0) || 1;
  return exps.map(e => e / s);
}
function boundedPercent(n) { // ensure 0..100 and finite
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100;
}
function nf(v,d=2){ return (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A"; }

// ---------------------------
// Feature builder (same as earlier but defensive)
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles.at(-1);
  const close = Number(last.close || 0);
  const len = candles.length;

  const close5 = len >= 6 ? Number(candles.at(-6).close || 0) : Number(candles[0].close || 0);
  const close20 = len >= 21 ? Number(candles.at(-21).close || 0) : Number(candles[0].close || 0);
  const mom5 = close5 ? (close - close5) / Math.max(1, close5) : 0;
  const mom20 = close20 ? (close - close20) / Math.max(1, close20) : 0;

  const nSlope = Math.min(30, len);
  const closes = candles.slice(-nSlope).map(c => Number(c.close || 0));
  const xs = closes.map((_, i) => i);
  const xmean = xs.reduce((a,b)=>a+b,0) / nSlope;
  const ymean = closes.reduce((a,b)=>a+b,0) / nSlope;
  let num = 0, den = 0;
  for (let i=0;i<nSlope;i++){ num += (xs[i]-xmean)*(closes[i]-ymean); den += (xs[i]-xmean)**2; }
  const slope = den === 0 ? 0 : num / den;

  let atr = 0;
  try {
    atr = indicators.computeATR ? indicators.computeATR(candles) : (() => {
      const trs = [];
      for (let i=1;i<candles.length;i++){
        const cur=candles[i], prev=candles[i-1];
        trs.push(Math.max(Math.abs(cur.high-cur.low), Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close)));
      }
      const tail = trs.slice(-14);
      return tail.length ? (tail.reduce((a,b)=>a+b,0) / tail.length) : 0;
    })();
  } catch (e) { atr = 0; }

  let rsi = null, macdHist = null, avgVol = 0;
  try {
    if (indicators.computeRSI) rsi = indicators.computeRSI(candles);
    if (indicators.computeMACD) macdHist = indicators.computeMACD(candles)?.hist;
    const volArr = candles.slice(-20).map(c=>Number(c.volume || c.vol || 0));
    avgVol = volArr.length ? (volArr.reduce((a,b)=>a+b,0) / volArr.length) : 0;
  } catch (e) { rsi = rsi ?? null; macdHist = macdHist ?? null; }

  return {
    close,
    mom5: Number(mom5||0),
    mom20: Number(mom20||0),
    slope: Number(slope||0),
    atr: Number(atr||0),
    rsi: Number(rsi||0),
    macdHist: Number(macdHist||0),
    avgVol: Number(avgVol||0),
    lastVol: Number(last.volume || last.vol || 0)
  };
}

// ---------------------------
// Candidate TP generator (direction-aware)
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (!Number.isFinite(tp) || tp <= 0) continue;
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(t.confidence || 50) });
    }
  }
  if (!out.length && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }
  if (!out.length) {
    // add ATR-based fallback both sides
    out.push({ tp: Number(price + (atr || price*0.002) * 2), source: 'ATR_UP', confidence: 30 });
    out.push({ tp: Number(price - (atr || price*0.002) * 2), source: 'ATR_DOWN', confidence: 30 });
  }
  // dedupe by rounded value (keep highest confidence)
  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence||0) > (map.get(key).confidence||0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// ---------------------------
// Core predictor: runMLPrediction (fixed)
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m") {
  try {
    const tfs = [tf, "1m"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const main = mtfRaw[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = (typeof main.price === "number" && main.price) ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 5) {
      return {
        modelVersion: "ml_module_v8_6_fixed",
        symbol,
        tf,
        direction: "Neutral",
        probs: { bull: 33.33, bear: 33.33, neutral: 33.33 },
        maxProb: 33.33,
        tpEstimate: null,
        tpSource: null,
        tpConfidence: 33,
        slEstimate: null,
        explanation: "insufficient data"
      };
    }

    // analyze ell
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    const feats = buildFeaturesFromCandles(candles);
    const microCandles = (mtfRaw["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    // raw scores (small magnitudes)
    let bull = 0, bear = 0;

    // slope & momentum (small scaling)
    bull += clamp(feats.slope * 20, -6, 6);
    bear -= clamp(feats.slope * 20, -6, 6);
    bull += clamp(feats.mom5 * 8, -5, 5);
    bear -= clamp(feats.mom5 * 8, -5, 5);

    // RSI (centered)
    if (feats.rsi) {
      const r = (feats.rsi - 50) / 50;
      bull += clamp(r * 2.5, -3, 3);
      bear -= clamp(r * 2.5, -3, 3);
    }

    // MACD hist / ATR normalization
    if (feats.macdHist) {
      const m = Math.tanh(feats.macdHist / Math.max(1, feats.atr || 1)) * 1.8;
      bull += clamp(m, -3, 3);
      bear -= clamp(m, -3, 3);
    }

    // Elliott
    let ellSent = 0, ellConf = 0;
    if (ell && typeof ell.sentiment === "number") {
      ellSent = clamp(Number(ell.sentiment || 0), -1, 1);
      ellConf = Math.max(0, Math.min(100, Number(ell.confidence || 0)));
      // modest nudge
      bull += ellSent * (0.8 * (ellConf / 100) * 2);
      bear -= ellSent * (0.8 * (ellConf / 100) * 2);
    }

    // volume spike: direction-neutral magnitude nudge, rely on candle direction later
    let volSpike = 0;
    if (feats.avgVol && feats.avgVol > 0) {
      volSpike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1;
      const vAdj = clamp(Math.min(1, volSpike) * 1.2, -1.2, 1.2);
      bull += vAdj * 0.5;
      bear += vAdj * 0.5;
    }

    // micro slope nudge
    if (microFeats) {
      const mN = microFeats.slope || 0;
      bull += clamp(mN * 6, -2, 2);
      bear -= clamp(mN * 6, -2, 2);
    }

    // Compose raw vector and apply stable softmax
    // small regularizer to keep neutral possibility
    const neutralBase = 0.2; // baseline neutral score
    const raw = [bull, bear, neutralBase];

    // numeric stability + scaling
    const scaled = raw.map(x => clamp(x, -12, 12));
    let probs = softmaxStable(scaled);

    // slight calibration with ell confidence
    if (ellConf > 0) {
      const ellAdj = ellSent * (ellConf / 100) * 0.6; // -0.6..0.6
      const adjRaw = [scaled[0] + ellAdj, scaled[1] - ellAdj, scaled[2]];
      probs = softmaxStable(adjRaw.map(x => clamp(x, -12, 12)));
    }

    // convert to percentages and ensure sum ~100 and bounded
    let probBull = boundedPercent(probs[0] * 100);
    let probBear = boundedPercent(probs[1] * 100);
    let probNeutral = boundedPercent(probs[2] * 100);

    // fix rounding drift
    const sum = probBull + probBear + probNeutral;
    if (sum <= 0) { probBull = probBear = probNeutral = 33.33; }
    else {
      probBull = Math.round((probBull / sum) * 10000) / 100;
      probBear = Math.round((probBear / sum) * 10000) / 100;
      probNeutral = Math.round((probNeutral / sum) * 10000) / 100;
    }

    const maxProb = Math.max(probBull, probBear, probNeutral);
    const dir = maxProb === probBull ? "Bullish" : maxProb === probBear ? "Bearish" : "Neutral";

    // Candidate TPs
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, feats.atr || (price * 0.002));

    // DIRECTION-ALIGNED TP SELECTION (FIX)
    let chosen = null;
    if (dir === "Bullish") {
      const longs = candidates.filter(c => Number(c.tp) > price).sort((a,b) => (b.confidence||0) - (a.confidence||0));
      if (longs.length) chosen = longs[0];
      else {
        // fallback: nearest above (if none, use auto ATR)
        const nearestAbove = candidates.find(c => Number(c.tp) > price);
        if (nearestAbove) chosen = nearestAbove;
      }
    } else if (dir === "Bearish") {
      const shorts = candidates.filter(c => Number(c.tp) < price).sort((a,b) => (b.confidence||0) - (a.confidence||0));
      if (shorts.length) chosen = shorts[0];
      else {
        const nearestBelow = candidates.find(c => Number(c.tp) < price);
        if (nearestBelow) chosen = nearestBelow;
      }
    } else {
      // Neutral: pick closest target by distance
      chosen = candidates.sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price))[0];
    }

    // AUTO FIX: if chosen exists but is opposite side, override with ATR-based conservative TP
    if (chosen) {
      if (dir === "Bullish" && Number(chosen.tp) <= price) {
        chosen = null;
      }
      if (dir === "Bearish" && Number(chosen.tp) >= price) {
        chosen = null;
      }
    }
    if (!chosen) {
      // auto ATR-based conservative TP in direction
      const mult = 2.0;
      if (dir === "Bullish") {
        chosen = { tp: Number((price + (feats.atr || price*0.002) * mult).toFixed(2)), source: "AUTO_ATR_UP", confidence: 40 };
      } else if (dir === "Bearish") {
        chosen = { tp: Number((price - (feats.atr || price*0.002) * mult).toFixed(2)), source: "AUTO_ATR_DOWN", confidence: 40 };
      } else {
        // neutral: nearest by distance
        chosen = candidates.sort((a,b)=>Math.abs(a.tp - price) - Math.abs(b.tp - price))[0] || { tp: null, source: "NONE", confidence: 0 };
      }
    }

    const tpEstimate = chosen && Number.isFinite(Number(chosen.tp)) ? Number(chosen.tp) : null;
    const tpSource = chosen ? (chosen.source || "Elliott") : null;
    const tpConfidence = chosen ? Math.round(((chosen.confidence || 40) * 0.6 + maxProb * 0.4)) : Math.round(maxProb);

    // conservative SL suggestion
    const slEstimate = dir === "Bullish" ? Number((price - (feats.atr || price*0.002) * 2).toFixed(2)) :
                       dir === "Bearish" ? Number((price + (feats.atr || price*0.002) * 2).toFixed(2)) : null;

    // explanation
    const explanationParts = [
      `slope:${Number(feats.slope.toFixed(6))}`,
      `mom5:${(feats.mom5*100).toFixed(2)}%`,
      feats.rsi ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
      ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
      feats.avgVol ? `volSpike:${( (feats.lastVol / Math.max(1, feats.avgVol) ) - 1).toFixed(2)}x` : null
    ].filter(Boolean).join(" | ");

    const mlObj = {
      modelVersion: "ml_module_v8_6_fixed",
      symbol,
      tf,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs: { bull: probBull, bear: probBear, neutral: probNeutral },
      maxProb,
      tpEstimate,
      tpSource,
      tpConfidence,
      slEstimate,
      explanation: explanationParts,
      rawScores: { bull, bear }
    };

    // persist (non-blocking)
    try { recordPrediction({ id:`${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch(e){}

    return mlObj;
  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (unchanged but bounded)
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];
    if (!candles || candles.length < 3) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    const score = (feats.mom5 * 6) + (feats.slope * 5) + ((feats.rsi - 50)/50 * 1.5);
    const pBull = (1 / (1 + Math.exp(-score))) * 100;
    const pBear = 100 - pBull;
    const pb = boundedPercent(pBull);
    const pa = boundedPercent(pBear);
    const label = pb > 55 ? "Bullish" : (pa > 55 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v8_6_fixed-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// ---------------------------
// Check reversal signal (kept similar)
export async function checkReversalSignal(symbol="BTCUSDT", tf="1m", opts={}) {
  try {
    const lookback = opts.lookbackCandles || 6;
    const volSpikeThresh = typeof opts.volSpikeThresh === "number" ? opts.volSpikeThresh : 0.2;
    const mtf = await fetchMultiTF(symbol, [tf, "15m"]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = (entry.data || []).slice(-Math.max(lookback, 6));
    if (!candles || candles.length < 3) return { detected: false, reason: "insufficient candles" };

    const last = candles.at(-1);
    const prev = candles.at(-2);

    const isBearishEngulf = (prev.close > prev.open) && (last.close < last.open) &&
      (last.open >= prev.close) && (last.close <= prev.open);
    const isBullishEngulf = (prev.close < prev.open) && (last.close > last.open) &&
      (last.open <= prev.close) && (last.close >= prev.open);

    const avgVol = candles.slice(0, -1).reduce((a,b)=>a + Number(b.volume||b.vol||0),0) / Math.max(1, candles.length-1);
    const lastVol = Number(last.volume || last.vol || 0);
    const volSpike = avgVol > 0 ? (lastVol / avgVol - 1) : 0;

    const lastBody = Math.abs(last.close - last.open);
    const lastUpperWick = last.high - Math.max(last.close, last.open);
    const lastLowerWick = Math.min(last.close, last.open) - last.low;
    const longUpperWick = lastUpperWick > lastBody * 1.5;
    const longLowerWick = lastLowerWick > lastBody * 1.5;

    let ell15 = null;
    try { ell15 = await analyzeElliott((mtf["15m"] || {}).data || []); } catch(e){ ell15 = null; }

    let detected = false, side = null, pattern = null;
    if (isBearishEngulf && volSpike > volSpikeThresh) { detected = true; side = "Bearish"; pattern = "BearishEngulfing"; }
    if (isBullishEngulf && volSpike > volSpikeThresh) { detected = true; side = "Bullish"; pattern = "BullishEngulfing"; }
    if (!detected && longUpperWick && volSpike > volSpikeThresh) { detected = true; side = "Bearish"; pattern = "UpperWickRejection"; }
    if (!detected && longLowerWick && volSpike > volSpikeThresh) { detected = true; side = "Bullish"; pattern = "LowerWickRejection"; }

    if (detected && opts.requireElliottAgree && ell15 && typeof ell15.sentiment === "number") {
      if (side === "Bearish" && ell15.sentiment > 0.15) detected = false;
      if (side === "Bullish" && ell15.sentiment < -0.15) detected = false;
    }

    const entryPrice = Number(last.close || 0);
    const signal = {
      detected,
      pattern,
      side,
      entry: entryPrice,
      volSpike: Number(volSpike.toFixed(3)),
      micro: await runMicroPrediction(symbol, tf).catch(()=>({ label: "Neutral" })),
      ell15: ell15 ? { sentiment: ell15.sentiment, confidence: ell15.confidence } : null,
      generatedAt: new Date().toISOString(),
      explanation: `pattern:${pattern} | volSpike:${Number(volSpike.toFixed(3))} | wickU:${longUpperWick} wickL:${longLowerWick}`
    };

    if (detected) {
      try { recordPrediction({ id: `${symbol}_reversal_${Date.now()}`, symbol, tf, type: "reversal", signal }); } catch(e){}
    }
    return signal;
  } catch (e) {
    return { detected: false, error: String(e) };
  }
}

// default export for convenience
export default {
  runMLPrediction,
  runMicroPrediction,
  checkReversalSignal,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};