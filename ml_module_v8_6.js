// ml_module_v8_7.js
// ML Module v8.7 — enhanced, Elliott-aware, online learning, safe + robust
//
// Exports:
//   runMLPrediction(symbol, tf)
//   runMicroPrediction(symbol, windowSec)
//   recordPrediction(predObj) -> predId
//   recordOutcome(predId, outcomeObj) -> boolean
//   calculateAccuracy() -> { accuracy, samples }
//   exportModel() / importModel(obj) / resetModel()
//
// Dependencies expected in project:
//   ./utils.js -> fetchMultiTF
//   ./core_indicators.js -> indicators helpers
//   ./elliott_module.js -> analyzeElliott (for graph recognition outputs)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v8_7.json");
const TRAIN_FILE = path.join(CACHE_DIR, "ml_trainset_v8_7.json");
const PRED_STORE = path.join(CACHE_DIR, "ml_preds_v8_7.json");

// ---------- CONFIG ----------
const CONF = {
  featureNames: [
    "ret_1m","ret_5m","ret_15m","ret_1h",
    "rsi_1m","rsi_5m","rsi_15m","rsi_1h",
    "macdh_1m","macdh_5m","macdh_15m","macdh_1h",
    "atr_15m",
    "vol_ratio_1m","vol_ratio_15m",
    "pattern_bull_count","pattern_bear_count",
    "trend_15m",
    "elliott_bullness", "elliott_conf",
    "bias_fusion"
  ],
  lr: 0.015,
  l2: 1e-6,
  onlineSteps: 10,
  maxTrainSamples: 10000,
  calibrationBeta: 0.72,
  tp_base: 1.0,
  minSamplesToReportAcc: 8
};

// ---------- safe load/save ----------
function safeLoad(fp, def) {
  try { if (!fs.existsSync(fp)) return def; const raw = fs.readFileSync(fp,"utf8")||""; return raw?JSON.parse(raw):def; }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj,null,2)); return true; } catch(e){ return false; }
}

// ---------- model init ----------
let MODEL = safeLoad(MODEL_FILE, null);
const dim = CONF.featureNames.length;
if (!MODEL || !Array.isArray(MODEL.w_bull) || MODEL.w_bull.length !== dim) {
  MODEL = {
    w_bull: Array.from({length:dim}, () => (Math.random()-0.5) * 0.01),
    b_bull: 0,
    w_bear: Array.from({length:dim}, () => (Math.random()-0.5) * 0.01),
    b_bear: 0,
    tp_w: Array.from({length:dim}, () => (Math.random()-0.5) * 0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0
  };
  safeSave(MODEL_FILE, MODEL);
}

// ---------- training store ----------
let TRAIN = safeLoad(TRAIN_FILE, []);
if (!Array.isArray(TRAIN)) TRAIN = [];
let PRED_STORE_OBJ = safeLoad(PRED_STORE, []);
if (!Array.isArray(PRED_STORE_OBJ)) PRED_STORE_OBJ = [];

// ---------- helpers ----------
function dot(a,b) { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; }
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, z)))); }
function softmax3(logB, logR, logN=0) {
  const m = Math.max(logB, logR, logN);
  const eB = Math.exp(logB - m);
  const eR = Math.exp(logR - m);
  const eN = Math.exp(logN - m);
  const s = eB + eR + eN;
  return { probBull: eB/s, probBear: eR/s, probNeutral: eN/s };
}
function parseCloseFromCandle(c) {
  if (!c) return null;
  if (typeof c === "object" && c !== null) {
    if (c.close !== undefined) return Number(c.close);
    // some sources use 'c' or index mapping
    if (c[4] !== undefined) return Number(c[4]);
  }
  if (Array.isArray(c)) return Number(c[4]);
  return null;
}

// ---------- build features ----------
async function buildFeaturesFromMulti(multi) {
  // multi: { "1m": {data:[], price }, "5m":..., ... }
  const f = {};
  function computeReturn(tf, lookback=1) {
    const arr = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
    if (arr.length < lookback+1) return 0;
    const now = parseCloseFromCandle(arr.at(-1));
    const prev = parseCloseFromCandle(arr.at(-1-lookback));
    if (!now || !prev) return 0;
    return (now - prev) / Math.max(1, Math.abs(prev));
  }

  f.ret_1m = computeReturn("1m",1);
  f.ret_5m = computeReturn("5m",1);
  f.ret_15m = computeReturn("15m",1);
  f.ret_1h = computeReturn("1h",1);

  // RSI
  try {
    f.rsi_1m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(multi["1m"]?.data||[]):50)/100;
    f.rsi_5m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(multi["5m"]?.data||[]):50)/100;
    f.rsi_15m = (typeof indicators.computeRSI==="function"? indicators.computeRSI(multi["15m"]?.data||[]):50)/100;
    f.rsi_1h = (typeof indicators.computeRSI==="function"? indicators.computeRSI(multi["1h"]?.data||[]):50)/100;
  } catch(e){ f.rsi_1m=f.rsi_5m=f.rsi_15m=f.rsi_1h=0.5; }

  // MACD hist normalized by 15m magnitude
  try {
    const macd1 = typeof indicators.computeMACD==="function"? indicators.computeMACD(multi["1m"]?.data||[]) : {hist:0};
    const macd5 = typeof indicators.computeMACD==="function"? indicators.computeMACD(multi["5m"]?.data||[]) : {hist:0};
    const macd15 = typeof indicators.computeMACD==="function"? indicators.computeMACD(multi["15m"]?.data||[]) : {hist:0};
    const macd1h = typeof indicators.computeMACD==="function"? indicators.computeMACD(multi["1h"]?.data||[]) : {hist:0};
    const denom = Math.max(1, Math.abs(macd15?.hist || 1));
    f.macdh_1m = (macd1.hist||0)/denom;
    f.macdh_5m = (macd5.hist||0)/denom;
    f.macdh_15m = (macd15.hist||0)/denom;
    f.macdh_1h = (macd1h.hist||0)/denom;
  } catch(e){ f.macdh_1m=f.macdh_5m=f.macdh_15m=f.macdh_1h=0; }

  // ATR
  try { f.atr_15m = typeof indicators.computeATR==="function"? indicators.computeATR(multi["15m"]?.data||[]) : 1; } catch(e){ f.atr_15m = 1; }

  // vol ratios
  function volRatioFromArr(arr) {
    if (!Array.isArray(arr) || !arr.length) return 1;
    const n = Math.min(20, arr.length);
    const last = (arr.at(-1)?.vol ?? arr.at(-1)?.volume ?? arr.at(-1)?.v) || 0;
    const avg = arr.slice(-n).reduce((s,c)=> s + ((c?.vol||c?.volume||c?.v)||0), 0) / Math.max(1,n);
    return avg ? last / avg : 1;
  }
  f.vol_ratio_1m = volRatioFromArr(multi["1m"]?.data || []);
  f.vol_ratio_15m = volRatioFromArr(multi["15m"]?.data || []);

  // naive pattern counts on 15m (bull/bear)
  let bullCount=0, bearCount=0;
  try {
    const cand15 = multi["15m"]?.data || [];
    const recent = cand15.length >= 5 ? cand15.slice(-5) : cand15;
    for (const c of recent) {
      const o = parseCloseFromCandle({open: c.open}) || c.open; // safe guard (not used heavily)
      if (c.close > c.open) bullCount++; else if (c.close < c.open) bearCount++;
      const body = Math.max(1, Math.abs(c.close - c.open));
      const lower = Math.min(c.open,c.close) - c.low;
      const upper = c.high - Math.max(c.open,c.close);
      if (lower > body * 1.6) bullCount++;
      if (upper > body * 1.6) bearCount++;
    }
  } catch(e){}
  f.pattern_bull_count = Math.min(6, bullCount);
  f.pattern_bear_count = Math.min(6, bearCount);

  try {
    const closes = (multi["15m"]?.data || []).slice(-5).map(x=>parseCloseFromCandle(x)||0);
    if (closes.length >= 2) f.trend_15m = (closes.at(-1) - closes.at(0)) / Math.max(1, Math.abs(closes.at(0)));
    else f.trend_15m = 0;
  } catch(e){ f.trend_15m = 0; }

  // Elliott features: bullness & confidence
  let ell_bullness = 0, ell_conf = 0;
  try {
    // try to run analyzeElliott on 15m candles only (fast)
    const cand15 = multi["15m"]?.data || [];
    if (cand15 && cand15.length >= 30 && typeof analyzeElliott === "function") {
      const ell = await analyzeElliott(cand15).catch(()=>null);
      if (ell && ell.ok) {
        // derive a simple numeric bullness from ell patterns if available
        // e.g., ell.sentiment in [-1..1] or patterns list
        if (typeof ell.sentiment === "number") ell_bullness = Math.max(-1, Math.min(1, ell.sentiment));
        // confidence field may be in percent or 0..1
        ell_conf = (typeof ell.confidence === "number") ? (ell.confidence > 1 ? Math.min(100, ell.confidence) : Math.round(ell.confidence*100)) : 0;
      }
    }
  } catch(e){}

  f.elliott_bullness = ell_bullness;
  f.elliott_conf = ell_conf / 100; // scale to 0..1

  f.bias_fusion = 0;

  // build vector according to CONF.featureNames
  const x = CONF.featureNames.map(k => {
    const v = f[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return 0;
  });

  // normalize returns to percent
  x[0] = x[0]*100; x[1] = x[1]*100; x[2] = x[2]*100; x[3] = x[3]*100;
  // scale atr moderate
  x[12] = x[12] / Math.max(1, Math.abs(x[12]));
  // tanh vol
  x[13] = Math.tanh(x[13]); x[14] = Math.tanh(x[14]);
  // ensure ell_conf is 0..1 already; ell_bullness within -1..1
  return { featureVector: x, raw: f };
}

// ---------- model forward ----------
function modelPredict(x) {
  const logB = dot(MODEL.w_bull, x) + (MODEL.b_bull || 0);
  const logR = dot(MODEL.w_bear, x) + (MODEL.b_bear || 0);
  const sm = softmax3(logB, logR, 0);
  // calibration
  const probBull = CONF.calibrationBeta * sm.probBull + (1 - CONF.calibrationBeta) * (1/3);
  const probBear = CONF.calibrationBeta * sm.probBear + (1 - CONF.calibrationBeta) * (1/3);
  const probNeutral = Math.max(0, 1 - (probBull + probBear));
  const tpLinear = dot(MODEL.tp_w, x) + (MODEL.tp_b || CONF.tp_base);
  const tpMul = Math.max(0.9, 1.0 + Math.tanh(tpLinear));
  return { probBull, probBear, probNeutral, tpMul, rawSoft: sm };
}

// ---------- public: runMLPrediction ----------
export async function runMLPrediction(symbol="BTCUSDT", tf="15m") {
  try {
    const tfs = ["1m","5m","15m","1h"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = await buildFeaturesFromMulti(multi);
    const p = modelPredict(featureVector);

    // label selection with margin
    let label = "Neutral";
    const maxp = Math.max(p.probBull, p.probBear, p.probNeutral);
    if (p.probBull > p.probBear && p.probBull > (p.probNeutral + 0.06)) label = "Bullish";
    else if (p.probBear > p.probBull && p.probBear > (p.probNeutral + 0.06)) label = "Bearish";

    return {
      label,
      probMaxPercent: Math.round(maxp * 10000)/100,
      probBullPercent: Math.round(p.probBull * 10000)/100,
      probBearPercent: Math.round(p.probBear * 10000)/100,
      probNeutralPercent: Math.round(p.probNeutral * 10000)/100,
      tpMul: Number(p.tpMul.toFixed(3)),
      features: raw,
      featureVector,
      meta: { modelCreatedAt: MODEL.createdAt, trainedSamples: MODEL.trainedSamples }
    };
  } catch(e) {
    return { error: String(e) };
  }
}

// ---------- public: runMicroPrediction ----------
export async function runMicroPrediction(symbol="BTCUSDT", windowSec=60) {
  try {
    const tfs = ["1m","5m"];
    const multi = await fetchMultiTF(symbol, tfs);
    // for micro, we build features from 1m/5m only
    const sub = { "1m": multi["1m"], "5m": multi["5m"], "15m": { data: [], price: 0 }, "1h": { data: [], price: 0 } };
    const { featureVector, raw } = await buildFeaturesFromMulti(sub);
    const p = modelPredict(featureVector);
    return {
      label: p.probBull > p.probBear ? "Bullish" : p.probBear > p.probBull ? "Bearish" : "Neutral",
      probMaxPercent: Math.round(Math.max(p.probBull,p.probBear,p.probNeutral)*10000)/100,
      probBullPercent: Math.round(p.probBull*10000)/100,
      probBearPercent: Math.round(p.probBear*10000)/100,
      tpMul: p.tpMul,
      features: raw,
      featureVector
    };
  } catch(e) { return { error: String(e) }; }
}

// ---------- persist prediction (called by watcher at pending time) ----------
export async function recordPrediction(pred) {
  try {
    const id = "mlpred_v8_7_" + Date.now() + "_" + Math.floor(Math.random()*9000);
    const rec = Object.assign({ id, createdAt: new Date().toISOString(), resolved:false }, pred);
    // attempt to fill featureVector if missing
    if (!rec.featureVector && rec.symbol) {
      try {
        const micro = await runMicroPrediction(rec.symbol, 60);
        if (micro && micro.featureVector) {
          rec.featureVector = micro.featureVector;
          rec.features = rec.features || micro.features;
        }
      } catch {}
    }
    PRED_STORE_OBJ.push(rec);
    safeSave(PRED_STORE, PRED_STORE_OBJ);
    return id;
  } catch(e) { return null; }
}

// ---------- record outcome and train ----------
export async function recordOutcome(predId, outcome={}) {
  try {
    const idx = PRED_STORE_OBJ.findIndex(p => p.id === predId);
    if (idx === -1) return false;
    PRED_STORE_OBJ[idx].resolved = true;
    PRED_STORE_OBJ[idx].outcome = outcome;
    safeSave(PRED_STORE, PRED_STORE_OBJ);

    const rec = PRED_STORE_OBJ[idx];
    if (!rec.featureVector) return true;

    // If realizedReturn present, use as label
    if (typeof outcome.realizedReturn === "number") {
      const thr = 0.0006; // 0.06%
      const yBull = outcome.realizedReturn > thr ? 1 : 0;
      const yBear = outcome.realizedReturn < -thr ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, createdAt: new Date().toISOString() });

      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);

      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, CONF.onlineSteps);
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    // if only 'correct' bool provided - weak label
    if (typeof outcome.correct === "boolean") {
      const yBull = (rec.label === "Bullish" && outcome.correct) ? 1 : 0;
      const yBear = (rec.label === "Bearish" && outcome.correct) ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, createdAt: new Date().toISOString() });
      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);
      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, Math.max(4, Math.floor(CONF.onlineSteps/2)));
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    return true;
  } catch(e) {
    return false;
  }
}

// ---------- online SGD ----------
function onlineSGDUpdate(x, y, steps=6) {
  const lr = CONF.lr;
  for (let s=0; s<steps; s++) {
    const p = modelPredict(x);
    const tb = y.bull || 0;
    const tr = y.bear || 0;
    const errB = p.probBull - tb;
    const errR = p.probBear - tr;
    for (let i=0;i<MODEL.w_bull.length;i++) {
      const xi = x[i]||0;
      MODEL.w_bull[i] -= lr * (errB * xi + CONF.l2 * MODEL.w_bull[i]);
      MODEL.w_bear[i] -= lr * (errR * xi + CONF.l2 * MODEL.w_bear[i]);
      MODEL.tp_w[i] -= (lr*0.05) * (((y.bull||0) - (y.bear||0)) * xi + CONF.l2 * MODEL.tp_w[i]);
    }
    MODEL.b_bull -= lr * errB;
    MODEL.b_bear -= lr * errR;
    MODEL.tp_b -= (lr*0.01) * (((y.bull||0) - (y.bear||0)) + MODEL.tp_b * CONF.l2);
  }
  safeSave(MODEL_FILE, MODEL);
}

// ---------- accuracy ----------
export function calculateAccuracy() {
  try {
    const resolved = PRED_STORE_OBJ.filter(p => p.resolved && p.outcome);
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
  } catch(e) { return { accuracy: 0, samples: 0 }; }
}

// ---------- admin helpers ----------
export function exportModel() { return JSON.parse(JSON.stringify(MODEL)); }
export function importModel(obj) { MODEL = obj; safeSave(MODEL_FILE, MODEL); return true; }
export function resetModel() {
  MODEL = {
    w_bull: Array.from({length:dim}, () => (Math.random()-0.5) * 0.01),
    b_bull: 0,
    w_bear: Array.from({length:dim}, () => (Math.random()-0.5) * 0.01),
    b_bear: 0,
    tp_w: Array.from({length:dim}, () => (Math.random()-0.5) * 0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0
  };
  TRAIN = [];
  PRED_STORE_OBJ = [];
  safeSave(MODEL_FILE, MODEL);
  safeSave(TRAIN_FILE, TRAIN);
  safeSave(PRED_STORE, PRED_STORE_OBJ);
  return true;
}

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