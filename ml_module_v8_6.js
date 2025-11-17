// ml_module_v8_6.js — Hybrid ML v9.0 (drop-in replacement)
// - Exports: runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy, exportModel, importModel, resetModel
// - Persistent model & train store in ./cache
// - Designed to be compatible with existing reversal_watcher / tg_commands imports

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v8_6.json");
const TRAIN_FILE = path.join(CACHE_DIR, "ml_trainset_v8_6.json");
const PRED_STORE_FILE = path.join(CACHE_DIR, "ml_preds_v8_6.json");

// ---------------- CONFIG ----------------
const CONF = {
  featureNames: [
    "ret_1m","ret_5m","ret_15m","ret_1h",
    "rsi_1m","rsi_5m","rsi_15m","rsi_1h",
    "macdh_1m","macdh_5m","macdh_15m","macdh_1h",
    "atr_15m",
    "vol_ratio_1m","vol_ratio_15m",
    "pattern_bull_count","pattern_bear_count",
    "trend_15m",
    "bias_fusion"
  ],
  lr: 0.018,
  l2: 1e-6,
  onlineSteps: 8,
  maxTrainSamples: 6000,
  minSamplesToReportAcc: 8,
  calibrationBeta: 0.75,
  tp_base: 0.9
};

// ---------------- safe IO ----------------
function safeLoad(fp, def) {
  try { if (!fs.existsSync(fp)) return def; const txt = fs.readFileSync(fp,"utf8")||""; return txt?JSON.parse(txt):def; }
  catch { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch (e) { return false; }
}

// ---------------- model init ----------------
const DIM = CONF.featureNames.length;
let MODEL = safeLoad(MODEL_FILE, null);
if (!MODEL || !Array.isArray(MODEL.w_bull) || !Array.isArray(MODEL.w_bear)) {
  MODEL = {
    w_bull: Array.from({length:DIM}, () => (Math.random()-0.5)*0.01),
    b_bull: 0,
    w_bear: Array.from({length:DIM}, () => (Math.random()-0.5)*0.01),
    b_bear: 0,
    tp_w: Array.from({length:DIM}, () => (Math.random()-0.5)*0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0
  };
  safeSave(MODEL_FILE, MODEL);
}

// ---------- stores ----------
let TRAIN = safeLoad(TRAIN_FILE, []);
if (!Array.isArray(TRAIN)) TRAIN = [];
let PRED_STORE = safeLoad(PRED_STORE_FILE, []);
if (!Array.isArray(PRED_STORE)) PRED_STORE = [];

// ---------- math helpers ----------
function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s+= (a[i]||0)*(b[i]||0); return s; }
function softmax2(logB, logR){
  const m = Math.max(logB, logR, 0);
  const eB = Math.exp(logB - m), eR = Math.exp(logR - m), eN = Math.exp(0 - m);
  const sum = eB + eR + eN;
  return { probBull: eB/sum, probBear: eR/sum, probNeutral: eN/sum };
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

// ---------- feature builder ----------
function buildFeaturesFromMulti(multi) {
  const f = {};
  function computeReturn(tf, lookback=1) {
    const d = multi[tf] && Array.isArray(multi[tf].data) ? multi[tf].data : [];
    if (d.length < lookback+1) return 0;
    const now = d.at(-1).close; const prev = d.at(-1-lookback).close;
    return prev ? (now - prev) / Math.abs(prev) : 0;
  }
  f.ret_1m = computeReturn("1m",1);
  f.ret_5m = computeReturn("5m",1);
  f.ret_15m = computeReturn("15m",1);
  f.ret_1h = computeReturn("1h",1);

  const cand1 = (multi["1m"]&&Array.isArray(multi["1m"].data))?multi["1m"].data:[];
  const cand5 = (multi["5m"]&&Array.isArray(multi["5m"].data))?multi["5m"].data:[];
  const cand15 = (multi["15m"]&&Array.isArray(multi["15m"].data))?multi["15m"].data:[];
  const cand1h = (multi["1h"]&&Array.isArray(multi["1h"].data))?multi["1h"].data:[];

  try {
    f.rsi_1m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(cand1):50)/100;
    f.rsi_5m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(cand5):50)/100;
    f.rsi_15m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(cand15):50)/100;
    f.rsi_1h = (typeof indicators.computeRSI==="function"? indicators.computeRSI(cand1h):50)/100;
  } catch { f.rsi_1m=f.rsi_5m=f.rsi_15m=f.rsi_1h=0.5; }

  try {
    const macd1 = typeof indicators.computeMACD==="function"? indicators.computeMACD(cand1):{hist:0};
    const macd5 = typeof indicators.computeMACD==="function"? indicators.computeMACD(cand5):{hist:0};
    const macd15 = typeof indicators.computeMACD==="function"? indicators.computeMACD(cand15):{hist:0};
    const macd1h = typeof indicators.computeMACD==="function"? indicators.computeMACD(cand1h):{hist:0};
    const denom = Math.max(1, Math.abs(macd15?.hist||1));
    f.macdh_1m = (macd1.hist||0)/denom;
    f.macdh_5m = (macd5.hist||0)/denom;
    f.macdh_15m = (macd15.hist||0)/denom;
    f.macdh_1h = (macd1h.hist||0)/denom;
  } catch { f.macdh_1m=f.macdh_5m=f.macdh_15m=f.macdh_1h=0; }

  try { f.atr_15m = typeof indicators.computeATR==="function"? indicators.computeATR(cand15):1; } catch { f.atr_15m = 1; }

  function volRatio(cand){
    const n = Math.min(20, cand.length); if (!n) return 1;
    const last = cand.at(-1).vol ?? cand.at(-1).volume ?? 0;
    const avg = cand.slice(-n).reduce((s,c)=>s + (c.vol??c.volume??0),0)/Math.max(1,n);
    return avg? last/avg : 1;
  }
  f.vol_ratio_1m = volRatio(cand1);
  f.vol_ratio_15m = volRatio(cand15);

  // naive pattern counts (15m)
  let bullCount=0, bearCount=0;
  const recent = (cand15.length>=5)?cand15.slice(-5):cand15;
  for (const c of recent){
    if (c.close > c.open) bullCount++; else if (c.close < c.open) bearCount++;
    const body = Math.max(1, Math.abs(c.close - c.open));
    const lower = Math.min(c.open,c.close) - c.low;
    const upper = c.high - Math.max(c.open,c.close);
    if (lower > body*1.6) bullCount++;
    if (upper > body*1.6) bearCount++;
  }
  f.pattern_bull_count = Math.min(5, bullCount);
  f.pattern_bear_count = Math.min(5, bearCount);

  try {
    const closes = cand15.slice(-5).map(x=>x.close);
    f.trend_15m = (closes.length >= 2) ? (closes.at(-1) - closes.at(0)) / Math.max(1, closes.at(0)) : 0;
  } catch { f.trend_15m = 0; }

  f.bias_fusion = 0;

  // construct feature vector in CONF order and normalize
  const x = CONF.featureNames.map(k => {
    const v = f[k]; return (typeof v==="number" && Number.isFinite(v))? v : 0;
  });

  // normalize returns -> percent; ATR bounded; vol ratios tanh
  x[0] = x[0]*100; x[1] = x[1]*100; x[2] = x[2]*100; x[3] = x[3]*100;
  x[12] = x[12] / Math.max(1, Math.abs(x[12]));
  x[13] = Math.tanh(x[13]); x[14] = Math.tanh(x[14]);

  return { featureVector: x, raw: f };
}

// ---------- model forward ----------
function modelPredict(x) {
  const logB = dot(MODEL.w_bull, x) + (MODEL.b_bull||0);
  const logR = dot(MODEL.w_bear, x) + (MODEL.b_bear||0);
  const sm = softmax2(logB, logR);
  // calibration smoothing towards neutral
  const probBull = CONF.calibrationBeta * sm.probBull + (1 - CONF.calibrationBeta) * 0.33;
  const probBear = CONF.calibrationBeta * sm.probBear + (1 - CONF.calibrationBeta) * 0.33;
  const probNeutral = 1 - (probBull + probBear);
  const tpLinear = dot(MODEL.tp_w, x) + (MODEL.tp_b || CONF.tp_base);
  const tpMul = Math.max(1.0, 1.0 + Math.tanh(tpLinear));
  return { probBull, probBear, probNeutral, tpMul, rawSoft: sm };
}

// ---------- public: runMLPrediction ----------
export async function runMLPrediction(symbol="BTCUSDT", tf="15m") {
  try {
    const tfs = ["1m","5m","15m","1h"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    const p = modelPredict(featureVector);

    // robust thresholding to avoid flip-flop
    let label = "Neutral";
    const maxp = Math.max(p.probBull, p.probBear, p.probNeutral);
    if (p.probBull >= p.probBear && p.probBull > (p.probNeutral + 0.07)) label = "Bullish";
    else if (p.probBear > p.probBull && p.probBear > (p.probNeutral + 0.07)) label = "Bearish";

    return {
      ok: true,
      label,
      probMaxPercent: Math.round(maxp*10000)/100,
      probBullPercent: Math.round(p.probBull*10000)/100,
      probBearPercent: Math.round(p.probBear*10000)/100,
      probNeutralPercent: Math.round(p.probNeutral*10000)/100,
      tpMul: Number(p.tpMul.toFixed(3)),
      tpEstimateMultiplier: Number(p.tpMul.toFixed(3)),
      features: raw,
      featureVector,
      meta: { modelCreatedAt: MODEL.createdAt, trainedSamples: MODEL.trainedSamples }
    };
  } catch(e) {
    return { ok:false, error: String(e) };
  }
}

// ---------- public: runMicroPrediction ----------
export async function runMicroPrediction(symbol="BTCUSDT", windowSec=60) {
  try {
    // fast: only 1m & 5m
    const tfs = ["1m","5m"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    const p = modelPredict(featureVector);
    return {
      ok: true,
      label: p.probBull > p.probBear ? "Bullish" : p.probBear > p.probBull ? "Bearish" : "Neutral",
      probMaxPercent: Math.round(Math.max(p.probBull,p.probBear,p.probNeutral)*10000)/100,
      probBullPercent: Math.round(p.probBull*10000)/100,
      probBearPercent: Math.round(p.probBear*10000)/100,
      tpMul: p.tpMul,
      features: raw,
      featureVector
    };
  } catch(e) { return { ok:false, error: String(e) }; }
}

// ---------- persist prediction ----------
export async function recordPrediction(pred) {
  try {
    const id = "mlpred_v8_6_" + Date.now() + "_" + Math.floor(Math.random()*9000);
    const rec = Object.assign({ id, createdAt: new Date().toISOString(), resolved:false }, pred);
    // try to ensure featureVector exists — if not, attempt micro
    if (!rec.featureVector && rec.symbol) {
      try {
        const micro = await runMicroPrediction(rec.symbol, 60);
        if (micro && micro.featureVector) { rec.featureVector = micro.featureVector; rec.features = rec.features || micro.features; }
      } catch {}
    }
    PRED_STORE.push(rec);
    safeSave(PRED_STORE_FILE, PRED_STORE);
    return id;
  } catch { return null; }
}

// ---------- record outcome & online training ----------
export async function recordOutcome(predId, outcome={}) {
  try {
    const idx = PRED_STORE.findIndex(p => p.id === predId);
    if (idx === -1) return false;
    PRED_STORE[idx].resolved = true;
    PRED_STORE[idx].outcome = outcome;
    safeSave(PRED_STORE_FILE, PRED_STORE);

    const rec = PRED_STORE[idx];
    if (!rec.featureVector) return true; // nothing to train

    if (typeof outcome.realizedReturn === "number") {
      const thr = 0.0006; // 0.06% tolerance
      const yBull = outcome.realizedReturn > thr ? 1 : 0;
      const yBear = outcome.realizedReturn < -thr ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn, createdAt: new Date().toISOString() });

      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);

      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, CONF.onlineSteps);
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    if (typeof outcome.correct === "boolean") {
      const yBull = (rec.label === "Bullish" && outcome.correct) ? 1 : 0;
      const yBear = (rec.label === "Bearish" && outcome.correct) ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn || 0, createdAt: new Date().toISOString() });
      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);

      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, Math.max(4, CONF.onlineSteps/2|0));
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    return true;
  } catch (e) {
    return false;
  }
}

// ---------- online SGD ----------
function onlineSGDUpdate(x, y, steps=6) {
  const lr = CONF.lr;
  for (let s=0;s<steps;s++){
    const p = modelPredict(x);
    const tb = y.bull || 0, tr = y.bear || 0;
    const errB = p.probBull - tb, errR = p.probBear - tr;
    for (let i=0;i<MODEL.w_bull.length;i++){
      const xi = x[i]||0;
      MODEL.w_bull[i] -= lr * (errB * xi + CONF.l2 * MODEL.w_bull[i]);
      MODEL.w_bear[i] -= lr * (errR * xi + CONF.l2 * MODEL.w_bear[i]);
      MODEL.tp_w[i] -= (lr*0.05) * (((y.bull||0)-(y.bear||0)) * xi + CONF.l2 * MODEL.tp_w[i]);
    }
    MODEL.b_bull -= lr * errB;
    MODEL.b_bear -= lr * errR;
    MODEL.tp_b -= (lr*0.01) * (((y.bull||0)-(y.bear||0)) + MODEL.tp_b * CONF.l2);
  }
  safeSave(MODEL_FILE, MODEL);
}

// ---------- accuracy ----------
export function calculateAccuracy() {
  try {
    const resolved = PRED_STORE.filter(p => p.resolved && p.outcome);
    const last = resolved.slice(-1000);
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
    return { accuracy: Math.round((correct/last.length)*10000)/100, samples: last.length };
  } catch { return { accuracy: 0, samples: 0 }; }
}

// ---------- admin helpers ----------
export function exportModel() { return JSON.parse(JSON.stringify(MODEL)); }
export function importModel(obj) { MODEL = obj; safeSave(MODEL_FILE, MODEL); return true; }
export function resetModel() {
  MODEL = {
    w_bull: Array.from({length:DIM}, () => (Math.random()-0.5)*0.01),
    b_bull: 0,
    w_bear: Array.from({length:DIM}, () => (Math.random()-0.5)*0.01),
    b_bear: 0,
    tp_w: Array.from({length:DIM}, () => (Math.random()-0.5)*0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0
  };
  TRAIN = []; PRED_STORE = [];
  safeSave(MODEL_FILE, MODEL); safeSave(TRAIN_FILE, TRAIN); safeSave(PRED_STORE_FILE, PRED_STORE);
  return true;
}

// ---------- done ----------
export default {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy,
  exportModel,
  importModel,
  resetModel
};