// ml_module_v9.js
// ML Module v9 — online logistic + calibration + safeguards
// Exports:
//   runMLPrediction(symbol, tf)
//   runMicroPrediction(symbol, windowSec)
//   recordPrediction(predObj) -> predId
//   recordOutcome(predId, outcomeObj) -> boolean
//   calculateAccuracy() -> {accuracy, samples}
//   exportModel() / importModel(obj) / resetModel()
// Additional helpers: predictRaw(featureVector), batchTrain(), getModelSummary()
// - uses fetchMultiTF from ./utils.js and indicators from ./core_indicators.js
// - no external deps

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v9.json");
const TRAIN_FILE = path.join(CACHE_DIR, "ml_trainset_v9.json");
const PRED_STORE = path.join(CACHE_DIR, "ml_preds_v9.json");

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
    "bias_fusion"
  ],
  lr: 0.02,
  l2: 1e-6,
  onlineSteps: 8,
  maxTrainSamples: 5000,
  minSamplesToReportAcc: 10,
  calibrationBeta: 0.7, // smoothing with neutral baseline
  tp_base: 0.9, // baseline TP multiplier offset
  probFloor: 1e-4, // avoid exact zeros
  emaAlpha: 0.15, // EMA smoothing for cold-start probabilities
  lrDecay: 0.999, // small decay per online update
  debug: !!process.env.ML_DEBUG // set env ML_DEBUG=1 for console logs
};

// ---------- safe load/save (atomic-ish) ----------
function safeLoad(fp, def) {
  try {
    if (!fs.existsSync(fp)) return def;
    const raw = fs.readFileSync(fp, "utf8") || "";
    return raw ? JSON.parse(raw) : def;
  } catch (e) {
    if (CONF.debug) console.warn("safeLoad err", fp, e.message);
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, fp);
    return true;
  } catch (e) {
    if (CONF.debug) console.warn("safeSave err", fp, e.message);
    try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch(e2){ return false; }
  }
}

// ---------- model init ----------
let MODEL = safeLoad(MODEL_FILE, null);
const dim = CONF.featureNames.length;
if (!MODEL || !Array.isArray(MODEL.w_bull) || MODEL.w_bull.length !== dim || !Array.isArray(MODEL.w_bear) || MODEL.w_bear.length !== dim) {
  MODEL = {
    w_bull: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01),
    b_bull: 0,
    w_bear: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01),
    b_bear: 0,
    tp_w: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0,
    // EMA smoothing state so early predictions are not all-zero
    probEMA: { bull: 0.33, bear: 0.33, neutral: 0.34 }
  };
  safeSave(MODEL_FILE, MODEL);
}

// ---------- training store ----------
let TRAIN = safeLoad(TRAIN_FILE, []);
if (!Array.isArray(TRAIN)) TRAIN = [];
let PRED_STORE_OBJ = safeLoad(PRED_STORE, []);
if (!Array.isArray(PRED_STORE_OBJ)) PRED_STORE_OBJ = [];

// ---------- helpers ----------
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0); return s; }
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, z)))); }
function softmax3(logits) {
  // logits: [logB, logR, logN]
  const m = Math.max(...logits, 0);
  const exps = logits.map(v => Math.exp(v - m));
  const sum = exps.reduce((s, x) => s + x, 0) || 1;
  return exps.map(e => e / sum);
}
function clamp(v, lo = -1e9, hi = 1e9) { if (isNaN(v) || !isFinite(v)) return 0; return Math.max(lo, Math.min(hi, v)); }
function percent(x) { return Math.round(x * 10000) / 100; }

// ---------- feature builder ----------
function buildFeaturesFromMulti(multi) {
  const f = {};
  function computeReturn(tf, lookback = 1) {
    const d = multi[tf] && Array.isArray(multi[tf].data) ? multi[tf].data : [];
    if (d.length < lookback + 1) return 0;
    const now = d.at(-1).close || 0;
    const prev = d.at(-1 - lookback).close || 0;
    if (!prev || !isFinite(prev)) return 0;
    return (now - prev) / Math.abs(prev);
  }
  f.ret_1m = computeReturn("1m", 1);
  f.ret_5m = computeReturn("5m", 1);
  f.ret_15m = computeReturn("15m", 1);
  f.ret_1h = computeReturn("1h", 1);

  const cand1 = (multi["1m"] && Array.isArray(multi["1m"].data)) ? multi["1m"].data : [];
  const cand5 = (multi["5m"] && Array.isArray(multi["5m"].data)) ? multi["5m"].data : [];
  const cand15 = (multi["15m"] && Array.isArray(multi["15m"].data)) ? multi["15m"].data : [];
  const cand1h = (multi["1h"] && Array.isArray(multi["1h"].data)) ? multi["1h"].data : [];

  try {
    f.rsi_1m = (typeof indicators.computeRSI === "function" ? indicators.computeRSI(cand1) : 50) / 100;
    f.rsi_5m = (typeof indicators.computeRSI === "function" ? indicators.computeRSI(cand5) : 50) / 100;
    f.rsi_15m = (typeof indicators.computeRSI === "function" ? indicators.computeRSI(cand15) : 50) / 100;
    f.rsi_1h = (typeof indicators.computeRSI === "function" ? indicators.computeRSI(cand1h) : 50) / 100;
  } catch (e) { f.rsi_1m = f.rsi_5m = f.rsi_15m = f.rsi_1h = 0.5; }

  try {
    const macd1 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand1) : { hist: 0 };
    const macd5 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand5) : { hist: 0 };
    const macd15 = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand15) : { hist: 0 };
    const macd1h = typeof indicators.computeMACD === "function" ? indicators.computeMACD(cand1h) : { hist: 0 };
    const denom = Math.max(1, Math.abs(macd15?.hist || 1));
    f.macdh_1m = (macd1.hist || 0) / denom;
    f.macdh_5m = (macd5.hist || 0) / denom;
    f.macdh_15m = (macd15.hist || 0) / denom;
    f.macdh_1h = (macd1h.hist || 0) / denom;
  } catch (e) { f.macdh_1m = f.macdh_5m = f.macdh_15m = f.macdh_1h = 0; }

  try { f.atr_15m = typeof indicators.computeATR === "function" ? indicators.computeATR(cand15) : 1; } catch (e) { f.atr_15m = 1; }

  function volRatio(cand) {
    const n = Math.min(20, cand.length);
    if (!n) return 1;
    const last = cand.at(-1).vol || cand.at(-1).volume || cand.at(-1).v || 0;
    const avg = cand.slice(-n).reduce((s, c) => s + (c.vol || c.volume || c.v || 0), 0) / Math.max(1, n);
    return avg ? last / avg : 1;
  }
  f.vol_ratio_1m = volRatio(cand1);
  f.vol_ratio_15m = volRatio(cand15);

  // naive pattern counts
  let bullCount = 0, bearCount = 0;
  const recent = (cand15.length >= 5) ? cand15.slice(-5) : cand15;
  for (const c of recent) {
    if (!c) continue;
    if (c.close > c.open) bullCount++; else if (c.close < c.open) bearCount++;
    const body = Math.max(1, Math.abs(c.close - c.open));
    const lower = Math.min(c.open, c.close) - c.low;
    const upper = c.high - Math.max(c.open, c.close);
    if (lower > body * 1.6) bullCount++;
    if (upper > body * 1.6) bearCount++;
  }
  f.pattern_bull_count = Math.min(5, bullCount);
  f.pattern_bear_count = Math.min(5, bearCount);

  try {
    const closes = cand15.slice(-5).map(x => x.close);
    if (closes.length >= 2) f.trend_15m = (closes.at(-1) - closes.at(0)) / Math.max(1, closes.at(0));
    else f.trend_15m = 0;
  } catch (e) { f.trend_15m = 0; }

  f.bias_fusion = 0;

  // build vector in CONF order and normalize
  const x = CONF.featureNames.map(k => {
    const v = f[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return 0;
  });

  // normalize returns -> percents, scale ATR to [0..1], tanh volume ratios
  x[0] = x[0] * 100; x[1] = x[1] * 100; x[2] = x[2] * 100; x[3] = x[3] * 100;
  x[12] = x[12] / (Math.max(1, Math.abs(x[12])));
  x[13] = Math.tanh(x[13]); x[14] = Math.tanh(x[14]);

  // ensure length
  for (let i = 0; i < dim; i++) if (!isFinite(x[i])) x[i] = 0;

  return { featureVector: x, raw: f };
}

// ---------- model forward ----------
function modelPredict(x) {
  try {
    if (!Array.isArray(x) || x.length !== dim) {
      // zero-vector fallback
      x = Array.from({ length: dim }, () => 0);
    }
    const logB = clamp(dot(MODEL.w_bull, x) + (MODEL.b_bull || 0), -1e6, 1e6);
    const logR = clamp(dot(MODEL.w_bear, x) + (MODEL.b_bear || 0), -1e6, 1e6);
    const logN = 0;
    const [pB_raw, pR_raw, pN_raw] = softmax3([logB, logR, logN]);

    // smooth with EMA to avoid cold-start zeros and keep probabilities reasonable
    MODEL.probEMA = MODEL.probEMA || { bull: 0.33, bear: 0.33, neutral: 0.34 };
    MODEL.probEMA.bull = CONF.emaAlpha * pB_raw + (1 - CONF.emaAlpha) * (MODEL.probEMA.bull || 0.33);
    MODEL.probEMA.bear = CONF.emaAlpha * pR_raw + (1 - CONF.emaAlpha) * (MODEL.probEMA.bear || 0.33);
    MODEL.probEMA.neutral = CONF.emaAlpha * pN_raw + (1 - CONF.emaAlpha) * (MODEL.probEMA.neutral || 0.34);

    // calibrated smoothing: blend model softmax with EMA-neutral baseline
    let probBull = CONF.calibrationBeta * pB_raw + (1 - CONF.calibrationBeta) * MODEL.probEMA.bull;
    let probBear = CONF.calibrationBeta * pR_raw + (1 - CONF.calibrationBeta) * MODEL.probEMA.bear;
    let probNeutral = Math.max(0, 1 - probBull - probBear);

    // floor + normalize
    probBull = Math.max(CONF.probFloor, probBull);
    probBear = Math.max(CONF.probFloor, probBear);
    probNeutral = Math.max(CONF.probFloor, probNeutral);
    const s = probBull + probBear + probNeutral || 1;
    probBull = probBull / s;
    probBear = probBear / s;
    probNeutral = probNeutral / s;

    // TP estimate
    const tpLinear = clamp(dot(MODEL.tp_w, x) + (MODEL.tp_b || CONF.tp_base), -50, 50);
    const tpMul = Math.max(1.0, 1.0 + Math.tanh(tpLinear));

    // return numeric stable object
    return {
      probBull: clamp(probBull, 0, 1),
      probBear: clamp(probBear, 0, 1),
      probNeutral: clamp(probNeutral, 0, 1),
      tpMul,
      rawSoft: { pB_raw, pR_raw, pN_raw },
      logits: { logB, logR, logN }
    };
  } catch (e) {
    if (CONF.debug) console.warn("modelPredict err:", e?.message || e);
    return { probBull: 0.33, probBear: 0.33, probNeutral: 0.34, tpMul: 1.0, rawSoft: {}, logits: {} };
  }
}

// ---------- public: runMLPrediction ----------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m") {
  try {
    const tfs = ["1m", "5m", "15m", "1h"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    if (!featureVector || featureVector.length !== dim) {
      if (CONF.debug) console.warn("runMLPrediction: invalid feature vector", featureVector && featureVector.length);
    }
    const p = modelPredict(featureVector);

    // label choose with threshold to avoid flipflop for weak signals
    let label = "Neutral";
    const maxp = Math.max(p.probBull, p.probBear, p.probNeutral);
    if (p.probBull >= p.probBear && p.probBull > (p.probNeutral + 0.08)) label = "Bullish";
    else if (p.probBear > p.probBull && p.probBear > (p.probNeutral + 0.08)) label = "Bearish";

    const out = {
      label,
      probMaxPercent: percent(maxp),
      probBullPercent: percent(p.probBull),
      probBearPercent: percent(p.probBear),
      probNeutralPercent: percent(p.probNeutral),
      tpMul: Number(p.tpMul.toFixed(3)),
      tpEstimateMultiplier: Number(p.tpMul.toFixed(3)),
      features: raw,
      featureVector,
      meta: { modelCreatedAt: MODEL.createdAt, trainedSamples: MODEL.trainedSamples }
    };
    // persist EMA occasionally
    safeSave(MODEL_FILE, MODEL);
    return out;
  } catch (e) {
    if (CONF.debug) console.warn("runMLPrediction err", e?.message || e);
    return { error: String(e) };
  }
}

// ---------- public: runMicroPrediction ----------
export async function runMicroPrediction(symbol = "BTCUSDT", windowSec = 60) {
  try {
    const tfs = ["1m", "5m"];
    const multi = await fetchMultiTF(symbol, tfs);
    const { featureVector, raw } = buildFeaturesFromMulti(multi);
    const p = modelPredict(featureVector);
    return {
      label: p.probBull > p.probBear ? "Bullish" : p.probBear > p.probBull ? "Bearish" : "Neutral",
      probMaxPercent: percent(Math.max(p.probBull, p.probBear, p.probNeutral)),
      probBullPercent: percent(p.probBull),
      probBearPercent: percent(p.probBear),
      tpMul: p.tpMul,
      features: raw,
      featureVector
    };
  } catch (e) {
    if (CONF.debug) console.warn("runMicroPrediction err", e?.message || e);
    return { error: String(e) };
  }
}

// ---------- persist prediction (called by watcher at pending time) ----------
export async function recordPrediction(pred) {
  // pred should include: symbol, directionCandidate (Bullish/Bearish/Neutral), predictedAt (opt), featureVector, features (raw), prob... etc
  try {
    const id = "mlpred_v9_" + Date.now() + "_" + Math.floor(Math.random() * 9000);
    const rec = Object.assign({
      id, createdAt: new Date().toISOString(), resolved: false
    }, pred);

    // ensure featureVector exists - if not, attempt to build a small micro one
    if ((!rec.featureVector || rec.featureVector.length !== dim) && rec.symbol) {
      try {
        const micro = await runMicroPrediction(rec.symbol, 60);
        if (micro && micro.featureVector) {
          rec.featureVector = micro.featureVector;
          rec.features = rec.features || micro.features;
        }
      } catch (e) { /* ignore */ }
    }

    PRED_STORE_OBJ.push(rec);
    safeSave(PRED_STORE, PRED_STORE_OBJ);
    return id;
  } catch (e) {
    if (CONF.debug) console.warn("recordPrediction err", e?.message || e);
    return null;
  }
}

// ---------- record outcome and train ----------
export async function recordOutcome(predId, outcome = {}) {
  // outcome should include:
  //  - realizedReturn (float), realizedPrice, correct (bool), exitAt (ISOString)
  try {
    const idx = PRED_STORE_OBJ.findIndex(p => p.id === predId);
    if (idx === -1) return false;
    PRED_STORE_OBJ[idx].resolved = true;
    PRED_STORE_OBJ[idx].outcome = outcome;
    safeSave(PRED_STORE, PRED_STORE_OBJ);

    const rec = PRED_STORE_OBJ[idx];
    if (!rec.featureVector || !Array.isArray(rec.featureVector) || rec.featureVector.length !== dim) return true; // nothing to train on

    // If realizedReturn available, create train sample
    if (typeof outcome.realizedReturn === "number") {
      const thr = 0.0005; // 0.05% tolerance
      const yBull = outcome.realizedReturn > thr ? 1 : 0;
      const yBear = outcome.realizedReturn < -thr ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn, createdAt: new Date().toISOString() });

      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);

      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, CONF.onlineSteps);
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      // small lr decay
      CONF.lr = Math.max(1e-5, CONF.lr * CONF.lrDecay);
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    // If only correct bool provided, use weak label
    if (typeof outcome.correct === "boolean") {
      const yBull = (rec.label === "Bullish" && outcome.correct) ? 1 : 0;
      const yBear = (rec.label === "Bearish" && outcome.correct) ? 1 : 0;
      TRAIN.push({ x: rec.featureVector, y: { bull: yBull, bear: yBear }, realizedReturn: outcome.realizedReturn || 0, createdAt: new Date().toISOString() });

      if (TRAIN.length > CONF.maxTrainSamples) TRAIN = TRAIN.slice(-CONF.maxTrainSamples);
      safeSave(TRAIN_FILE, TRAIN);

      onlineSGDUpdate(rec.featureVector, { bull: yBull, bear: yBear }, Math.max(4, Math.floor(CONF.onlineSteps / 2)));
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
      CONF.lr = Math.max(1e-5, CONF.lr * CONF.lrDecay);
      safeSave(MODEL_FILE, MODEL);
      return true;
    }

    return true;
  } catch (e) {
    if (CONF.debug) console.warn("recordOutcome err", e?.message || e);
    return false;
  }
}

// ---------- online SGD ----------
function onlineSGDUpdate(x, y, steps = 6) {
  const lrBase = CONF.lr;
  for (let s = 0; s < steps; s++) {
    const p = modelPredict(x);
    const tb = y.bull || 0;
    const tr = y.bear || 0;
    const errB = p.probBull - tb;
    const errR = p.probBear - tr;
    for (let i = 0; i < MODEL.w_bull.length; i++) {
      const xi = x[i] || 0;
      // gradient step with L2 regularization
      MODEL.w_bull[i] -= lrBase * (errB * xi + CONF.l2 * MODEL.w_bull[i]);
      MODEL.w_bear[i] -= lrBase * (errR * xi + CONF.l2 * MODEL.w_bear[i]);
      MODEL.tp_w[i] -= (lrBase * 0.05) * (((y.bull || 0) - (y.bear || 0)) * xi + CONF.l2 * MODEL.tp_w[i]);
    }
    MODEL.b_bull -= lrBase * errB;
    MODEL.b_bear -= lrBase * errR;
    MODEL.tp_b -= (lrBase * 0.01) * (((y.bull || 0) - (y.bear || 0)) + MODEL.tp_b * CONF.l2);
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
      if (!r || !r.outcome) continue;
      if (typeof r.outcome.correct === "boolean") {
        if (r.outcome.correct) correct++;
      } else if (typeof r.outcome.realizedReturn === "number") {
        if (r.label === "Bullish" && r.outcome.realizedReturn > 0) correct++;
        if (r.label === "Bearish" && r.outcome.realizedReturn < 0) correct++;
      }
    }
    return { accuracy: Math.round((correct / last.length) * 10000) / 100, samples: last.length };
  } catch (e) {
    if (CONF.debug) console.warn("calculateAccuracy err", e?.message || e);
    return { accuracy: 0, samples: 0 };
  }
}

// ---------- utility: batch train from TRAIN file ----------
export async function batchTrain(stepsPerSample = 4, maxSamples = 1000) {
  try {
    const samples = TRAIN.slice(-maxSamples);
    for (const s of samples) {
      onlineSGDUpdate(s.x, s.y, stepsPerSample);
      MODEL.trainedSamples = (MODEL.trainedSamples || 0) + 1;
    }
    safeSave(MODEL_FILE, MODEL);
    return { ok: true, trained: samples.length };
  } catch (e) {
    if (CONF.debug) console.warn("batchTrain err", e?.message || e);
    return { ok: false, error: String(e) };
  }
}

// ---------- admin helpers ----------
export function exportModel() { return JSON.parse(JSON.stringify(MODEL)); }
export function importModel(obj) { MODEL = obj; safeSave(MODEL_FILE, MODEL); return true; }
export function resetModel() {
  MODEL = {
    w_bull: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01),
    b_bull: 0,
    w_bear: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01),
    b_bear: 0,
    tp_w: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.002),
    tp_b: CONF.tp_base,
    createdAt: new Date().toISOString(),
    trainedSamples: 0,
    probEMA: { bull: 0.33, bear: 0.33, neutral: 0.34 }
  };
  TRAIN = [];
  PRED_STORE_OBJ = [];
  safeSave(MODEL_FILE, MODEL);
  safeSave(TRAIN_FILE, TRAIN);
  safeSave(PRED_STORE, PRED_STORE_OBJ);
  return true;
}


// ---------- debug helpers ----------
export function getModelSummary() {
  return {
    createdAt: MODEL.createdAt,
    trainedSamples: MODEL.trainedSamples || 0,
    probEMA: MODEL.probEMA || {},
    lr: CONF.lr,
    dim
  };
}

export function predictRaw(featureVector) {
  try {
    if (!Array.isArray(featureVector) || featureVector.length !== dim) return null;
    return modelPredict(featureVector);
  } catch (e) {
    return null;
  }
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
  resetModel,
  batchTrain,
  predictRaw,
  getModelSummary
};