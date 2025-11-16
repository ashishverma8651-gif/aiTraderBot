// ml_module_v8_6.js
// Lightweight ML module for Reversal Watcher
// - No external dependencies
// - Uses fetchMultiTF from ./utils.js and indicators from ./core_indicators.js
// - Exports: runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v8_6.json");
const TRAIN_FILE = path.join(CACHE_DIR, "ml_trainset_v8_6.json");
const PRED_STORE = path.join(CACHE_DIR, "ml_preds_v8_6.json");

// Simple model config
const CONF = {
  featureNames: [
    // multi-tf returns & momentum
    "ret_1m", "ret_5m", "ret_15m", "ret_1h",
    "rsi_1m", "rsi_5m", "rsi_15m", "rsi_1h",
    "macdh_1m", "macdh_5m", "macdh_15m", "macdh_1h",
    "atr_15m",
    "vol_ratio_1m", "vol_ratio_15m",
    "pattern_bull_count", "pattern_bear_count",
    "trend_15m", // numeric trend indicator
    "bias_fusion" // optional, if available
  ],
  hiddenSize: 0, // use logistic regression (simple)
  lr: 0.01,
  l2: 1e-6
};

// Utility: safe load/save
function safeLoad(fp, def) {
  try { if (!fs.existsSync(fp)) return def; return JSON.parse(fs.readFileSync(fp,"utf8")||"{}"); }
  catch { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch(e){ return false; }
}

// Initialize model: simple weight vector + bias for bull and bear logits
let MODEL = safeLoad(MODEL_FILE, null);
if (!MODEL || !MODEL.w_bull || !MODEL.w_bear) {
  // init with small random weights
  const dim = CONF.featureNames.length;
  MODEL = {
    w_bull: Array.from({length: dim}, () => (Math.random()-0.5) * 0.01),
    b_bull: 0,
    w_bear: Array.from({length: dim}, () => (Math.random()-0.5) * 0.01),
    b_bear: 0,
    tp_w: Array.from({length: dim}, () => (Math.random()-0.5) * 0.005),
    tp_b: 1.8, // default TP multiplier baseline
    createdAt: new Date().toISOString()
  };
  safeSave(MODEL_FILE, MODEL);
}

// Training set: simple array of { x: [...], y: { bull:0/1, bear:0/1 }, realizedReturn }
let TRAIN = safeLoad(TRAIN_FILE, []);
if (!Array.isArray(TRAIN)) TRAIN = [];

// Prediction store
let PRED_STORE_OBJ = safeLoad(PRED_STORE, []);
if (!Array.isArray(PRED_STORE_OBJ)) PRED_STORE_OBJ = [];

// Small helpers
function dot(a,b) {
  let s = 0;
  for (let i=0;i<a.length;i++) s += (a[i]||0) * (b[i]||0);
  return s;
}
function sigmoid(z) {
  const v = 1/(1+Math.exp(-Math.max(-50,Math.min(50,z))));
  return v;
}

// Feature builder: uses multiTF candles object (1m,5m,15m,1h optional)
function buildFeaturesFromMulti(multi) {
  // multi: { "1m": { data: [...], price }, ... }
  const f = {};
  function lastClose(tf) {
    const d = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
    return d.length ? d.at(-1).close : (multi[tf]?.price || 0);
  }
  function computeReturn(tf, lookback=1) {
    const d = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
    if (d.length < lookback+1) return 0;
    const now = d.at(-1).close;
    const prev = d.at(-1-lookback).close;
    return prev ? (now - prev)/Math.abs(prev) : 0;
  }

  // returns
  f.ret_1m = computeReturn("1m", 1);
  f.ret_5m = computeReturn("5m", 1);
  f.ret_15m = computeReturn("15m", 1);
  f.ret_1h = computeReturn("1h", 1);

  // RSI, MACD hist, ATR
  const cand15 = (multi["15m"] && Array.isArray(multi["15m"].data)) ? multi["15m"].data : [];
  const cand1 = (multi["1m"] && Array.isArray(multi["1m"].data)) ? multi["1m"].data : [];
  const cand5 = (multi["5m"] && Array.isArray(multi["5m"].data)) ? multi["5m"].data : [];
  const cand1h = (multi["1h"] && Array.isArray(multi["1h"].data)) ? multi["1h"].data : [];

  try {
    f.rsi_1m = typeof indicators.computeRSI === "function" ? (indicators.computeRSI(cand1)||50)/100 : 0.5;
    f.rsi_5m = typeof indicators.computeRSI === "function" ? (indicators.computeRSI(cand5)||50)/100 : 0.5;
    f.rsi_15m = typeof indicators.computeRSI === "function" ? (indicators.computeRSI(cand15)||50)/100 : 0.5;
    f.rsi_1h = typeof indicators.computeRSI === "function" ? (indicators.computeRSI(cand1h)||50)/100 : 0.5;
  } catch(e){ f.rsi_1m=f.rsi_5m=f.rsi_15m=f.rsi_1h=0.5; }

  try {
    const macd1 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand1) : { hist:0 };
    const macd5 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand5) : { hist:0 };
    const macd15 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand15) : { hist:0 };
    const macd1h = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand1h) : { hist:0 };
    f.macdh_1m = (macd1.hist||0) / (Math.max(1, Math.abs(macd15?.hist || 1)));
    f.macdh_5m = (macd5.hist||0) / (Math.max(1, Math.abs(macd15?.hist || 1)));
    f.macdh_15m = (macd15.hist||0) / (Math.max(1, Math.abs(macd15?.hist || 1)));
    f.macdh_1h = (macd1h.hist||0) / (Math.max(1, Math.abs(macd15?.hist || 1)));
  } catch(e){ f.macdh_1m=f.macdh_5m=f.macdh_15m=f.macdh_1h=0; }

  try {
    f.atr_15m = typeof indicators.computeATR === "function" ? (indicators.computeATR(cand15)||1) : 1;
  } catch(e){ f.atr_15m = 1; }

  // volume ratio: last vs avg
  function volRatio(cand) {
    const n = Math.min(20, cand.length);
    if (!n) return 1;
    const last = cand.at(-1).volume || cand.at(-1).vol || cand.at(-1).v || 0;
    const avg = cand.slice(-n).reduce((s,c)=>s + (c.volume||c.vol||c.v||0), 0)/Math.max(1,n);
    return avg ? last / avg : 1;
  }
  f.vol_ratio_1m = volRatio(cand1);
  f.vol_ratio_15m = volRatio(cand15);

  // simple pattern counts from recent candles (uses naive rules)
  let bullCount = 0, bearCount = 0;
  const recent = (cand15.length>=5)? cand15.slice(-5) : cand15;
  for (const c of recent) {
    if (c.close > c.open) bullCount++; else if (c.close < c.open) bearCount++;
    const body = Math.abs(c.close - c.open) || 1;
    const lower = Math.min(c.open,c.close) - c.low;
    const upper = c.high - Math.max(c.open,c.close);
    if (lower > body*1.6) bullCount++;
    if (upper > body*1.6) bearCount++;
  }
  f.pattern_bull_count = Math.min(5, bullCount);
  f.pattern_bear_count = Math.min(5, bearCount);

  // trend_15m: normalized slope of last N closes
  try {
    const closes = cand15.slice(-5).map(x=>x.close);
    if (closes.length>=2) {
      const s = closes.at(-1) - closes.at(0);
      f.trend_15m = s / Math.max(1, closes.at(0));
    } else f.trend_15m = 0;
  } catch(e){ f.trend_15m=0; }

  // bias_fusion if reversal_watcher sends it later; default 0
  f.bias_fusion = 0;

  // build vector in order of CONF.featureNames
  const x = CONF.featureNames.map(k => {
    const v = f[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return 0;
  });

  // Basic normalization: scale a few known fields
  // Normalize returns to small numbers, RSI already scaled (0..1)
  x[0] = x[0]*100; x[1]=x[1]*100; x[2]=x[2]*100; x[3]=x[3]*100; // returns -> percent
  x[12] = x[12] / (Math.max(1, Math.abs(x[12]))); // atr scaled
  x[13] = Math.tanh(x[13]); x[14] = Math.tanh(x[14]);

  return { featureVector: x, raw: f };
}

// Model forward: compute probabilities and TP estimate
function modelPredict(x) {
  const wB = MODEL.w_bull, bB = MODEL.b_bull;
  const wR = MODEL.w_bear, bR = MODEL.b_bear;
  const logitB = dot(wB, x) + (bB||0);
  const logitR = dot(wR, x) + (bR||0);
  // convert logits to softmax-like probabilities (but we only need relative)
  const eB = Math.exp(Math.max(-50,Math.min(50,logitB)));
  const eR = Math.exp(Math.max(-50,Math.min(50,logitR)));
  const sum = eB + eR + 1; // +1 for neutral baseline
  const probBull = eB / sum;
  const probBear = eR / sum;
  const probNeutral = 1 - (probBull + probBear);
  // TP estimate via linear model on x
  const tpMul = Math.max(1.0, 1.0 + dot(MODEL.tp_w, x) + (MODEL.tp_b||0));
  return { probBull, probBear, probNeutral, tpMul };
}

// Public: runMLPrediction(symbol, tf)
// tries to fetch multi-TF candles, build features and predict
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m") {
  try {
    // fetch multi TFs for features
    const tfs = ["1m","5m","15m","1h"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    const pred = modelPredict(featureVector);

    let label = "Neutral";
    let prob = Math.max(pred.probBull, pred.probBear, pred.probNeutral);
    if (pred.probBull > pred.probBear && pred.probBull > pred.probNeutral) label = "Bullish";
    else if (pred.probBear > pred.probBull && pred.probBear > pred.probNeutral) label = "Bearish";

    // Compose decent output structure used by reversal_watcher
    return {
      label,
      prob: Math.round(prob * 10000)/100,         // percent e.g. 72.34
      probBull: Math.round(pred.probBull*10000)/100,
      probBear: Math.round(pred.probBear*10000)/100,
      probNeutral: Math.round(pred.probNeutral*10000)/100,
      tpMul: Number(pred.tpMul.toFixed(3)),
      tpEstimateMultiplier: Number(pred.tpMul.toFixed(3)),
      features: raw,
      featureVector
    };
  } catch(e) {
    return { error: String(e) };
  }
}

// Micro prediction (short-window micro model): same interface but uses only 1m/5m to be faster
export async function runMicroPrediction(symbol = "BTCUSDT", windowSec = 60) {
  try {
    const tfs = ["1m","5m"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    const pred = modelPredict(featureVector);
    return {
      label: pred.probBull > pred.probBear ? "Bullish" : pred.probBear > pred.probBull ? "Bearish" : "Neutral",
      prob: Math.max(pred.probBull, pred.probBear, pred.probNeutral) * 100,
      probBull: pred.probBull * 100,
      probBear: pred.probBear * 100,
      tpMul: pred.tpMul,
      features: raw
    };
  } catch(e) { return { error: String(e) }; }
}

// Persist prediction record for feedback; returns id
export async function recordPrediction(pred) {
  try {
    const id = "mlpred_" + Date.now() + "_" + Math.floor(Math.random()*9000);
    const rec = Object.assign({ id, createdAt: new Date().toISOString(), resolved:false }, pred);
    PRED_STORE_OBJ.push(rec);
    safeSave(PRED_STORE, PRED_STORE_OBJ);
    return id;
  } catch(e) { return null; }
}

// Record outcome: outcome = { correct:bool, realizedPrice, realizedReturn (pct) }
// Also will append training example (online learning) and run a few gradient steps
export async function recordOutcome(predId, outcome = {}) {
  try {
    // find prediction entry
    const recIdx = PRED_STORE_OBJ.findIndex(p => p.id === predId);
    if (recIdx === -1) {
      // nothing to update
    } else {
      PRED_STORE_OBJ[recIdx].resolved = true;
      PRED_STORE_OBJ[recIdx].outcome = outcome;
      safeSave(PRED_STORE, PRED_STORE_OBJ);
      // if we have featureVector and realizedReturn, create training sample
      const rec = PRED_STORE_OBJ[recIdx];
      if (rec.featureVector && typeof outcome.realizedReturn === "number") {
        // determine label by realizedReturn sign (tiny threshold)
        const thr = 0.0; // if positive => bull success
        const yBull = outcome.realizedReturn > thr ? 1 : 0;
        const yBear = outcome.realizedReturn < -thr ? 1 : 0;
        // training sample
        TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn });
        // cap training set
        if (TRAIN.length > 5000) TRAIN = TRAIN.slice(-5000);
        safeSave(TRAIN_FILE, TRAIN);
        // run a short SGD update
        onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, 12);
      } else if (rec.featureVector && typeof outcome.correct === "boolean") {
        // use correct boolean to create sample (weak)
        const yBull = rec.label === "Bullish" ? (outcome.correct ? 1 : 0) : 0;
        const yBear = rec.label === "Bearish" ? (outcome.correct ? 1 : 0) : 0;
        TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn || 0 });
        if (TRAIN.length > 5000) TRAIN = TRAIN.slice(-5000);
        safeSave(TRAIN_FILE, TRAIN);
        onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, 8);
      }
    }
    return true;
  } catch(e) {
    return false;
  }
}

// Quick online SGD update for logistic heads and TP linear
function onlineSGDUpdate(x, y, steps = 10) {
  const lr = CONF.lr;
  for (let s=0;s<steps;s++) {
    // predict
    const p = modelPredict(x);
    // targets
    const tb = y.bull || 0;
    const tr = y.bear || 0;
    // errors
    const errB = p.probBull - tb;
    const errR = p.probBear - tr;
    // update weights with gradient (logistic)
    for (let i=0;i<MODEL.w_bull.length;i++) {
      MODEL.w_bull[i] -= lr * (errB * x[i] + CONF.l2 * MODEL.w_bull[i]);
      MODEL.w_bear[i] -= lr * (errR * x[i] + CONF.l2 * MODEL.w_bear[i]);
      // tp linear update: if bull realized >0, increase tp weight, if bear realized <0 lower
      MODEL.tp_w[i] -= (lr*0.1) * (( (y.bull - y.bear) * x[i] ) + CONF.l2 * MODEL.tp_w[i]);
    }
    MODEL.b_bull -= lr * (errB);
    MODEL.b_bear -= lr * (errR);
    MODEL.tp_b -= (lr*0.05) * ((y.bull - y.bear) + (MODEL.tp_b*CONF.l2));
  }
  // persist model
  safeSave(MODEL_FILE, MODEL);
}

// Compute accuracy from prediction store (sliding window of last N resolved)
export function calculateAccuracy() {
  try {
    const resolved = PRED_STORE_OBJ.filter(p => p.resolved && p.outcome);
    const last = resolved.slice(-500);
    if (!last.length) return { accuracy: 0, samples: 0 };
    let correct = 0;
    for (const r of last) {
      if (typeof r.outcome.correct === "boolean") {
        if (r.outcome.correct) correct++;
      } else if (typeof r.outcome.realizedReturn === "number") {
        if (r.label === "Bullish" && r.outcome.realizedReturn > 0) correct++;
        if (r.label === "Bearish" && r.outcome.realizedReturn < 0) correct++;
      }
    }
    return { accuracy: Math.round( (correct/last.length) * 10000)/100, samples: last.length };
  } catch(e) { return { accuracy: 0, samples: 0 }; }
}

// Export default
export {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
};
