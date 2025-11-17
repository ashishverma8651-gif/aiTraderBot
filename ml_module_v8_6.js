// ml_module_v9_0.js
// ML + Reversal checker for AI Trader (v9.0)
// Deterministic lightweight predictor + reversal watcher + logging
//
// Exports:
//   runMLPrediction(symbol, tf = "15m") -> Promise<mlObj>
//   runMicroPrediction(symbol, tf = "1m") -> Promise<microObj>
//   checkReversalSignal(symbol, tf = "15m", opts = {}) -> Promise<signalObj>
//   calculateAccuracy() -> { accuracy, total, correct }
//   recordPrediction(pred) -> void
//   recordOutcome(outcome) -> void
//
// Notes:
// - Requires project helpers: fetchMultiTF (./utils.js), indicators (./core_indicators.js), analyzeElliott (./elliott_module.js)
// - Behavior is deterministic (no external ML libs). Replace scoring functions with a real model later.

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
// Math helpers
// ---------------------------
function clamp(v, lo=-1, hi=1){ return Math.max(lo, Math.min(hi, v)); }
function logistic(x){ return 1/(1+Math.exp(-x)); }
function softmax(arr){
  if(!Array.isArray(arr)||!arr.length) return arr;
  const max = Math.max(...arr);
  const exps = arr.map(a=>Math.exp(a-max));
  const s = exps.reduce((a,b)=>a+b,0) || 1;
  return exps.map(e=>e/s);
}
function nf(v,d=2){ return (typeof v==='number' && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A"; }

// ---------------------------
// Feature builder
// ---------------------------
function buildFeaturesFromCandles(candles) {
  // expects oldest -> newest
  if (!Array.isArray(candles) || !candles.length) return null;
  const last = candles.at(-1);
  const close = Number(last.close || 0);
  const len = candles.length;

  // momentum: recent close vs 5 and 20 candles
  const close5 = len >= 6 ? Number(candles.at(-6).close || 0) : Number(candles[0].close || 0);
  const close20 = len >= 21 ? Number(candles.at(-21).close || 0) : Number(candles[0].close || 0);
  const mom5 = (close - close5) / Math.max(1, close5 || 1);
  const mom20 = (close - close20) / Math.max(1, close20 || 1);

  // slope via simple linear regression on last N closes
  const nSlope = Math.min(30, len);
  const closes = candles.slice(-nSlope).map(c=>Number(c.close||0));
  const xs = closes.map((_,i)=>i);
  const xmean = xs.reduce((a,b)=>a+b,0)/nSlope;
  const ymean = closes.reduce((a,b)=>a+b,0)/nSlope;
  let num=0, den=0;
  for (let i=0;i<nSlope;i++){ num += (xs[i]-xmean)*(closes[i]-ymean); den += (xs[i]-xmean)**2; }
  const slope = den===0?0: num/den;

  // volatility: ATR-like
  let atr = 0;
  try { atr = indicators.computeATR ? indicators.computeATR(candles) : (()=>{ // fallback
      let trs=[]; for (let i=1;i<candles.length;i++){
        const cur=candles[i], prev=candles[i-1];
        trs.push(Math.max(Math.abs(cur.high-cur.low), Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close)));
      } return trs.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1,trs.slice(-14).length);
    })() } catch(e){ atr = 0; }

  // RSI and MACD hist if available
  let rsi = null, macdHist = null, volSum = 0, avgVol = 0;
  try {
    if (indicators.computeRSI) rsi = indicators.computeRSI(candles);
    if (indicators.computeMACD) macdHist = indicators.computeMACD(candles)?.hist;
    volSum = candles.slice(-20).reduce((a,b)=>a + Number(b.volume || b.vol || 0),0);
    avgVol = volSum / Math.min(20, candles.length);
  } catch(e){ rsi = rsi ?? null; macdHist = macdHist ?? null; }

  return {
    close, mom5, mom20, slope, atr: Number(atr||0), rsi: Number(rsi||0), macdHist: Number(macdHist||0),
    avgVol: Number(avgVol||0), lastVol: Number(last.volume || last.vol || 0)
  };
}

// ---------------------------
// Candidate TP generator (from Elliott/fib/ATR)
// ---------------------------
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (!Number.isFinite(tp) || tp <= 0) continue;
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(t.confidence||50) });
    }
  }
  // if none, use fib ext if present
  if ((!out || !out.length) && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }
  // fallback: ATR multiples
  if (!out.length) {
    out.push({ tp: Number(price + atr * 3), source: 'ATR_MULT', confidence: 30 });
    out.push({ tp: Number(price - atr * 3), source: 'ATR_MULT', confidence: 30 });
  }
  // dedupe by rounded value
  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence||0) > (map.get(key).confidence||0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b)=>Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// ---------------------------
// Core predictor: runMLPrediction
// ---------------------------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m") {
  try {
    // fetch 15m candles + micro (1m) for features
    const tfs = [tf, "1m"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const main = mtfRaw[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = typeof main.price === "number" && main.price ? main.price : (candles?.at(-1)?.close ?? 0);

    // minimal fallback
    if (!candles || candles.length < 5) {
      return { label: "Neutral", prob: 50, probBull: 33.33, probBear: 33.33, probNeutral: 33.33, explanation: "insufficient data", tp: null };
    }

    // ell analysis (use analyzeElliott)
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // features
    const feats = buildFeaturesFromCandles(candles);
    // micro features
    const microCandles = (mtfRaw["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    // raw signals (linear combination heuristics)
    // bullishScore, bearishScore are real numbers that we'll softmax
    // we want directional tilt from: slope, mom, macd, rsi, ell.sentiment, volume change
    let bull = 0, bear = 0, neutral = 0;

    // slope & momentum
    bull += clamp(feats.slope * 50, -5, 5); // slope scaled
    bear -= clamp(feats.slope * 50, -5, 5);
    bull += clamp(feats.mom5 * 10, -5, 5);
    bear -= clamp(feats.mom5 * 10, -5, 5);

    // RSI
    if (feats.rsi) {
      const r = (feats.rsi - 50) / 50; // -1..1
      bull += clamp(r * 3, -3, 3);
      bear -= clamp(r * 3, -3, 3);
    }

    // MACD hist
    if (feats.macdHist) {
      const m = Math.tanh(feats.macdHist / Math.max(1, feats.atr || 1)) * 2;
      bull += clamp(m, -4, 4);
      bear -= clamp(m, -4, 4);
    }

    // Elliott sentiment (if present, -1..1)
    let ellSent = 0, ellConf = 0;
    if (ell && typeof ell.sentiment === "number") {
      ellSent = clamp(Number(ell.sentiment || 0), -1, 1);
      ellConf = Math.max(0, Math.min(100, Number(ell.confidence || 0)));
      bull += ellSent * (0.8 * (ellConf/100) * 4); // scaled
      bear -= ellSent * (0.8 * (ellConf/100) * 4);
    }

    // volume spike (lastVol vs avgVol)
    let volSpike = 0;
    if (feats.avgVol && feats.avgVol > 0) {
      volSpike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1; // e.g. 0.5 => 50% spike
      // if big spike with downward candle => bearish
      bull += clamp(Math.min(0.6, volSpike) * 2, -2, 2);
      bear += clamp(Math.min(0.6, volSpike) * 2, -2, 2); // both get nudged magnitude-wise; direction accounted via candle
    }

    // micro trend: if micro shows clear direction nudge final
    let microNudge = 0;
    if (microFeats) {
      microNudge = microFeats.slope || 0;
      bull += clamp(microNudge * 8, -2, 2);
      bear -= clamp(microNudge * 8, -2, 2);
    }

    // final raw array: [bullScore, bearScore, neutralScore]
    // neutral baseline depends on absence of strong signals
    neutral = 0.5 - (Math.abs(bull) + Math.abs(bear)) * 0.02;
    const raw = [bull, bear, neutral];

    // softmax to probabilities
    const probs = softmax(raw.map(x => Number(x || 0)));
    let probBull = Math.round(probs[0] * 10000)/100;
    let probBear = Math.round(probs[1] * 10000)/100;
    let probNeutral = Math.round(probs[2] * 10000)/100;

    // calibrate slightly using ellConf (trust ell a bit)
    if (ellConf > 0) {
      const ellAdj = (ellSent * (ellConf/100)) * 10; // -10..10
      // add to bull or bear pre-softmax by re-weighting
      const adjRaw = [bull + ellAdj, bear - ellAdj, neutral];
      const adjProbs = softmax(adjRaw);
      probBull = Math.round(adjProbs[0]*10000)/100;
      probBear = Math.round(adjProbs[1]*10000)/100;
      probNeutral = Math.round(adjProbs[2]*10000)/100;
    }

    // Ensure sum ~100 (rounding drift)
    const total = probBull + probBear + probNeutral;
    if (total === 0) { probBull = probBear = probNeutral = 33.33; }
    else {
      probBull = Math.round((probBull/total)*10000)/100;
      probBear = Math.round((probBear/total)*10000)/100;
      probNeutral = Math.round((probNeutral/total)*10000)/100;
    }

    // Choose direction (single side)
    const maxProb = Math.max(probBull, probBear, probNeutral);
    const dir = (maxProb === probBull) ? "Bullish" : (maxProb === probBear) ? "Bearish" : "Neutral";

    // Candidate TPs from Elliott/fib/ATR
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, feats.atr || 0);

    // Choose ML TP according to chosen direction
    let mlChosenTP = null;
    if (dir === "Bullish") {
      // pick nearest TP > price and best confidence
      const longs = candidates.filter(c => Number(c.tp) > price).sort((a,b)=> (b.confidence||0) - (a.confidence||0));
      if (longs.length) mlChosenTP = longs[0];
      else mlChosenTP = candidates[0] || null;
    } else if (dir === "Bearish") {
      const shorts = candidates.filter(c => Number(c.tp) < price).sort((a,b)=> (b.confidence||0) - (a.confidence||0));
      if (shorts.length) mlChosenTP = shorts[0];
      else mlChosenTP = candidates[0] || null;
    } else {
      // Neutral -> pick closest TP by distance
      mlChosenTP = candidates.sort((a,b)=> Math.abs(a.tp - price) - Math.abs(b.tp - price))[0] || null;
    }

    // Compute TP confidence: combine candidate confidence and maxProb
    const tpConfidence = mlChosenTP ? Math.round(((mlChosenTP.confidence || 40) * 0.6 + maxProb * 0.4)) : Math.round(maxProb);

    // Compute SL suggestion (conservative): use ATR 15m
    const sl = (dir === "Bullish") ? Number((price - (feats.atr || 0) * 2).toFixed(2)) :
               (dir === "Bearish") ? Number((price + (feats.atr || 0) * 2).toFixed(2)) :
               null;

    // Explanation / reasoning
    const reasonParts = [];
    reasonParts.push(`Slope:${Number(feats.slope.toFixed(6))}`);
    reasonParts.push(`mom5:${(feats.mom5*100).toFixed(2)}%`);
    if (feats.rsi) reasonParts.push(`RSI:${Number(feats.rsi.toFixed(1))}`);
    if (ell) reasonParts.push(`Elliott:${ell.sentiment && ell.confidence ? `${Number(ell.sentiment.toFixed(3))} (${ell.confidence}%)` : "N/A"}`);
    if (feats.avgVol) reasonParts.push(`VolSpike:${( (feats.lastVol / Math.max(1, feats.avgVol)) - 1 ).toFixed(2)}x`);
    if (microFeats) reasonParts.push(`MicroSlope:${Number(microFeats.slope.toFixed(6))}`);

    const explanation = reasonParts.join(" | ");

    // Build ML object
    const mlObj = {
      modelVersion: "ml_module_v9.0",
      symbol,
      tf,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs: { bull: probBull, bear: probBear, neutral: probNeutral },
      maxProb: maxProb,
      tpEstimate: mlChosenTP ? Number(mlChosenTP.tp) : null,
      tpSource: mlChosenTP ? mlChosenTP.source : null,
      tpConfidence,
      slEstimate: sl,
      explanation,
      rawScores: { bull, bear, neutral }
    };

    // record prediction (non-blocking)
    try { recordPrediction({ id: `${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch(e){}

    return mlObj;

  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (1m quick)
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];
    if (!candles || candles.length < 3) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    // simple micro rule
    const score = (feats.mom5 * 8) + (feats.slope * 6) + ((feats.rsi - 50)/50 * 2);
    const pBull = logistic(score) * 100;
    const pBear = 100 - pBull;
    const label = pBull > 55 ? "Bullish" : (pBear > 55 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v9.0-micro", label, prob: Math.round(Math.max(pBull,pBear)*100)/100, probBull: Math.round(pBull*100)/100, probBear: Math.round(pBear*100)/100, slope: feats.slope || 0 };
  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// ---------------------------
// Reversal watcher (simple pattern + volume + ell)
export async function checkReversalSignal(symbol="BTCUSDT", tf="1m", opts={}) {
  // opts: { lookbackCandles: 5, volSpikeThresh: 0.25, requireElliottAgree: false }
  try {
    const lookback = opts.lookbackCandles || 6;
    const volSpikeThresh = typeof opts.volSpikeThresh === "number" ? opts.volSpikeThresh : 0.2; // 20%
    const mtf = await fetchMultiTF(symbol, [tf, "15m"]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = (entry.data || []).slice(-Math.max(lookback, 6));
    if (!candles || candles.length < 3) return { detected: false, reason: "insufficient candles" };

    const last = candles.at(-1);
    const prev = candles.at(-2);
    const prev2 = candles.at(-3);

    // quick engulfing detection
    const isBearishEngulf = (prev.close > prev.open) && (last.close < last.open) &&
      (last.open >= prev.close) && (last.close <= prev.open);
    const isBullishEngulf = (prev.close < prev.open) && (last.close > last.open) &&
      (last.open <= prev.close) && (last.close >= prev.open);

    // volume spike check
    const avgVol = candles.slice(0, -1).reduce((a,b)=>a + Number(b.volume||b.vol||0),0) / Math.max(1, candles.length-1);
    const lastVol = Number(last.volume || last.vol || 0);
    const volSpike = avgVol > 0 ? (lastVol / avgVol - 1) : 0;

    // small wick reversal test (last candle has long wick relative to body)
    const lastBody = Math.abs(last.close - last.open);
    const lastUpperWick = last.high - Math.max(last.close, last.open);
    const lastLowerWick = Math.min(last.close, last.open) - last.low;
    const longUpperWick = lastUpperWick > lastBody * 1.5;
    const longLowerWick = lastLowerWick > lastBody * 1.5;

    // Elliott agreement
    let ell15 = null;
    try { ell15 = await analyzeElliott((mtf["15m"] || {}).data || []); } catch(e){ ell15 = null; }

    // final decision heuristics
    let detected = false;
    let side = null;
    let pattern = null;
    if (isBearishEngulf && volSpike > volSpikeThresh) { detected = true; side = "Bearish"; pattern = "BearishEngulfing"; }
    if (isBullishEngulf && volSpike > volSpikeThresh) { detected = true; side = "Bullish"; pattern = "BullishEngulfing"; }
    // fallback: wick based reversal if significant wick + volume
    if (!detected && longUpperWick && volSpike > volSpikeThresh) { detected = true; side = "Bearish"; pattern = "UpperWickRejection"; }
    if (!detected && longLowerWick && volSpike > volSpikeThresh) { detected = true; side = "Bullish"; pattern = "LowerWickRejection"; }

    // require ell agreement optionally
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

    // non-blocking record
    if (detected) {
      try { recordPrediction({ id: `${symbol}_reversal_${Date.now()}`, symbol, tf, type: "reversal", signal }); } catch(e){}
    }
    return signal;

  } catch (e) {
    return { detected: false, error: String(e) };
  }
}

// ---------------------------
// Export default for convenience
export default {
  runMLPrediction,
  runMicroPrediction,
  checkReversalSignal,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};