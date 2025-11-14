// ml_module_v16.js — ML Engine v16 (for main 15m reports + 1m micro reversal watcher)
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMarketData, nowLocal } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import * as indicators from "./core_indicators.js"; // safe usage with feature detection

// ---------------------------
// Storage paths
// ---------------------------
const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v16.json");
const PREDICTIONS_FILE = path.join(CACHE_DIR, "ml_predictions_v16.json");
const FEEDBACK_FILE = path.join(CACHE_DIR, "ml_feedback_v16.json");
const HISTORY_FILE = path.join(CACHE_DIR, "ml_history_v16.json");

// ---------------------------
// Defaults & options
// ---------------------------
const DEFAULTS = {
  epochs: CONFIG.ML?.EPOCHS ?? 25,
  lr: CONFIG.ML?.LEARNING_RATE ?? 0.02,
  lookback: CONFIG.ML?.LOOKBACK ?? 200, // for feature extraction
  microLookback: 100, // for 1m watcher
  horizon: 3, // label horizon in candles for training
  maxSamples: 300
};

// ---------------------------
// Helpers: JSON save/load
// ---------------------------
function safeJSONLoad(fp, fallback = null) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    const txt = fs.readFileSync(fp, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.warn("ml_v16: safeJSONLoad err", e.message);
    return fallback;
  }
}
function safeJSONSave(fp, data) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("ml_v16: safeJSONSave err", e.message);
    return false;
  }
}

// ---------------------------
// Math utils
// ---------------------------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const nowISO = () => new Date().toISOString();

// ---------------------------
// Model (logistic regression with SGD) — simple, explainable
// Model shape: { w: [...], b, dim, trainedAt }
// ---------------------------
function initModel(dim) {
  const w = Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01);
  const b = 0;
  return { w, b, dim, trainedAt: nowISO() };
}
function predictRaw(model, x) {
  if (!model || !Array.isArray(model.w)) return 0.5;
  let s = model.b || 0;
  for (let i = 0; i < model.w.length && i < x.length; i++) s += (model.w[i] || 0) * (x[i] || 0);
  return sigmoid(s);
}
function updateSGD(model, x, y, lr = 0.02) {
  const p = predictRaw(model, x);
  const e = p - y; // prediction - label
  for (let i = 0; i < model.w.length && i < x.length; i++) {
    model.w[i] -= lr * e * (x[i] || 0);
  }
  model.b -= lr * e;
}

// ---------------------------
// Feature extraction (single-window)
// returns { symbol, interval, features: [], close, vol, ell, fetchedAt }
// ---------------------------
export async function extractFeatures(symbol, interval = "15m", lookback = DEFAULTS.lookback) {
  try {
    const resp = await fetchMarketData(symbol, interval, Math.max(lookback, 50));
    const data = resp?.data || [];
    if (!Array.isArray(data) || data.length < 30) return null;

    // close & vol arrays
    const closes = data.map((c) => Number(c.close ?? c.c ?? 0));
    const vols = data.map((c) => Number(c.vol ?? c.v ?? c.volume ?? 0));
    const lastClose = closes.at(-1) ?? 0;
    const lastVol = vols.at(-1) ?? 0;

    // basic stats
    const avgClose = closes.reduce((a, b) => a + b, 0) / Math.max(1, closes.length);
    const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const volChange = avgVol ? (lastVol - avgVol) / avgVol : 0;

    // returns - recent
    const returns = [];
    for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / Math.max(1, Math.abs(closes[i - 1])));
    const avgRet = returns.length ? returns.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, returns.length)) : 0;

    // indicators via core_indicators (safe)
    let rsi = 50, macdHist = 0, atr = 0;
    try {
      if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(data, 14);
      if (typeof indicators.computeMACD === "function") {
        const mac = indicators.computeMACD(data);
        macdHist = (mac && typeof mac.hist === "number") ? mac.hist : 0;
      }
      if (typeof indicators.computeATR === "function") atr = indicators.computeATR(data, 14);
    } catch (e) {
      // ignore and use defaults
    }

    // elliott summary (non-blocking)
    let ell = null;
    try { ell = await analyzeElliott(data); } catch (e) { ell = null; }
    const ellSent = ell?.sentiment ?? 0;
    const ellConf = (ell?.confidence ?? 0) / 100; // 0..1

    // feature vector (order matters)
    const features = [
      avgRet || 0,
      volChange || 0,
      (rsi || 50) / 100,         // 0..1
      (macdHist || 0),          // raw scaled later by model
      (atr || 0),
      ellSent || 0,
      ellConf || 0
    ];

    return {
      symbol,
      interval,
      features,
      close: lastClose,
      vol: lastVol,
      ell,
      fetchedAt: nowISO()
    };
  } catch (e) {
    console.warn("ml_v16.extractFeatures err", e?.message || e);
    return null;
  }
}

// ---------------------------
// Sliding dataset builder (for training)
// returns { X:[], Y:[], meta:[] }
// ---------------------------
export async function buildSlidingDataset(symbol, interval = "15m", window = 60, horizon = DEFAULTS.horizon, maxSamples = DEFAULTS.maxSamples) {
  try {
    const resp = await fetchMarketData(symbol, interval, window + horizon + 10);
    const data = resp?.data || [];
    if (!Array.isArray(data) || data.length < window + horizon) return null;

    const X = [], Y = [], meta = [];

    for (let start = 0; start + window + horizon <= data.length; start++) {
      const windowCandles = data.slice(start, start + window);
      const futureCandles = data.slice(start + window, start + window + horizon);

      // derive features from windowCandles directly (avoid fetching)
      const closes = windowCandles.map((c) => Number(c.close ?? 0));
      const vols = windowCandles.map((c) => Number(c.vol ?? 0));
      const lastClose = closes.at(-1) ?? 0;
      const lastVol = vols.at(-1) ?? 0;
      const avgClose = closes.reduce((a, b) => a + b, 0) / Math.max(1, closes.length);
      const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);

      const returns = [];
      for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / Math.max(1, Math.abs(closes[i - 1])));
      const avgRet = returns.length ? returns.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, returns.length)) : 0;
      const volChange = avgVol ? (lastVol - avgVol) / avgVol : 0;

      // indicators (safe)
      let rsi = 50, macdHist = 0, atr = 0;
      try {
        if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(windowCandles, 14);
        if (typeof indicators.computeMACD === "function") macdHist = indicators.computeMACD(windowCandles).hist ?? 0;
        if (typeof indicators.computeATR === "function") atr = indicators.computeATR(windowCandles, 14);
      } catch (e) {}

      // ell (best-effort, synchronous on small window)
      let ell = null;
      try { ell = await analyzeElliott(windowCandles); } catch (e) { ell = null; }
      const ellSent = ell?.sentiment ?? 0;
      const ellConf = (ell?.confidence ?? 0) / 100;

      const features = [
        avgRet || 0,
        volChange || 0,
        (rsi || 50) / 100,
        (macdHist || 0),
        (atr || 0),
        ellSent || 0,
        ellConf || 0
      ];

      // label from futureCandles (binary: up/down)
      const futureClose = Number(futureCandles.at(-1)?.close ?? futureCandles.at(0)?.close ?? lastClose);
      const futureRet = lastClose ? (futureClose - lastClose) / Math.max(1, Math.abs(lastClose)) : 0;
      const label = futureRet > 0 ? 1 : 0;

      X.push(features);
      Y.push(label);
      meta.push({ symbol, interval, index: start, lastClose, futureClose, futureRet });

      if (X.length >= maxSamples) break;
    }

    return { X, Y, meta };
  } catch (e) {
    console.warn("ml_v16.buildSlidingDataset err", e?.message || e);
    return null;
  }
}

// ---------------------------
// Training API
// trainModel(symbols, options)
// ---------------------------
export async function trainModel(symbols = [CONFIG.SYMBOL || "BTCUSDT"], options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const allX = [], allY = [];

  for (const s of symbols) {
    try {
      if (opts.useSlidingDataset) {
        const ds = await buildSlidingDataset(s, opts.interval || "15m", opts.window || 60, opts.horizon || DEFAULTS.horizon, opts.maxSamples || DEFAULTS.maxSamples);
        if (ds && ds.X && ds.X.length) {
          allX.push(...ds.X);
          allY.push(...ds.Y);
        }
      } else {
        const f = await extractFeatures(s, opts.interval || "15m", opts.lookback || DEFAULTS.lookback);
        if (f && f.features) {
          allX.push(f.features);
          allY.push(f.features[0] > 0 ? 1 : 0);
        }
      }
    } catch (e) {
      console.warn("ml_v16.trainModel sample build failed for", s, e?.message || e);
    }
  }

  if (!allX.length) throw new Error("No training samples available. Try useSlidingDataset=true or increase markets.");

  const dim = allX[0].length;
  let model = safeJSONLoad(MODEL_FILE, null);
  if (!model || model.dim !== dim) model = initModel(dim);

  const epochs = opts.epochs || DEFAULTS.epochs;
  const lr = opts.lr || DEFAULTS.lr;

  // training loop (simple SGD)
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = 0; i < allX.length; i++) {
      const idx = Math.floor(Math.random() * allX.length);
      updateSGD(model, allX[idx], allY[idx], lr);
    }
  }

  model.trainedAt = nowISO();
  model.dim = dim;
  safeJSONSave(MODEL_FILE, model);
  return model;
}

// ---------------------------
// Prediction API (main) - for 15m contextual predictions
// runMLPrediction(symbol)
// returns { id, symbol, label, prob, features, ell, meta }
// ---------------------------
export async function runMLPrediction(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "15m") {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model) return { error: "model_not_found" };

    const f = await extractFeatures(symbol, interval, DEFAULTS.lookback);
    if (!f) return { error: "no_features" };

    const p = predictRaw(model, f.features);
    const pct = Math.round(p * 10000) / 100; // 2 decimals
    const label = pct > 55 ? "Bullish" : pct < 45 ? "Bearish" : "Neutral";

    const predId = await recordPrediction({
      symbol,
      predictedAt: nowISO(),
      label,
      prob: pct,
      features: f.features,
      meta: { interval, ell: f.ell }
    });

    return { id: predId, symbol, label, prob: pct, features: f.features, ell: f.ell };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------------------------
// Micro prediction for 1m watcher
// runMicroPrediction(symbol, interval = '1m', lookback = 100)
// returns lightweight object suitable for watcher
// ---------------------------
export async function runMicroPrediction(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "1m", lookback = DEFAULTS.microLookback) {
  try {
    const model = safeJSONLoad(MODEL_FILE, null); // micro uses same model but features from 1m
    // optional: if model missing, still compute heuristics
    const f = await extractFeatures(symbol, interval, lookback);
    if (!f) return { error: "no_features" };

    const p = model ? predictRaw(model, f.features) : 0.5;
    const pct = Math.round(p * 10000) / 100;
    // also compute quick candlestick pattern heuristics for reversal
    // basic pattern detection: last 3 candles
    const resp = await fetchMarketData(symbol, interval, 10);
    const candles = resp?.data || [];
    const last = candles.at(-1) || null, prev = candles.at(-2) || null;
    const patterns = [];
    try {
      if (last && prev) {
        // hammer: small body near top with long lower wick (bullish)
        const body = Math.abs(last.close - last.open);
        const lowerWick = Math.abs(last.open < last.close ? last.open - last.low : last.close - last.low);
        const upperWick = Math.abs(last.high - Math.max(last.open, last.close));
        if (lowerWick > body * 1.8 && upperWick < body * 0.5) patterns.push("Hammer");
        // shooting star
        if (upperWick > body * 1.8 && lowerWick < body * 0.5) patterns.push("Shooting Star");
        // bullish engulfing
        if ((last.close > last.open) && (prev.close < prev.open) && (last.open < prev.close) && (last.close > prev.open)) patterns.push("Bullish Engulfing");
        if ((last.close < last.open) && (prev.close > prev.open) && (last.open > prev.close) && (last.close < prev.open)) patterns.push("Bearish Engulfing");
      }
    } catch (e) {}

    // include ell micro-summary (best-effort)
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // assemble micro result
    return {
      symbol,
      interval,
      prob: pct,
      label: pct > 55 ? "Bullish" : pct < 45 ? "Bearish" : "Neutral",
      features: f.features,
      patterns,
      ell,
      fetchedAt: nowISO()
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------------------------
// Prediction recording + feedback
// ---------------------------
export async function recordPrediction(obj = {}) {
  try {
    const store = safeJSONLoad(PREDICTIONS_FILE, { preds: [] }) || { preds: [] };
    const id = `mlpred_v16_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const entry = Object.assign({ id, ts: Date.now() }, obj);
    store.preds = store.preds || [];
    store.preds.push(entry);
    if (store.preds.length > 5000) store.preds = store.preds.slice(-5000);
    safeJSONSave(PREDICTIONS_FILE, store);
    return id;
  } catch (e) {
    console.warn("ml_v16.recordPrediction err", e?.message || e);
    return null;
  }
}
export function recordOutcome(predictionId, outcome = {}) {
  try {
    const preds = safeJSONLoad(PREDICTIONS_FILE, { preds: [] });
    const pred = (preds.preds || []).find((x) => x.id === predictionId) || null;
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    const rec = {
      predictionId,
      ts: Date.now(),
      predicted: pred,
      outcome: {
        correct: !!outcome.correct,
        realizedReturn: typeof outcome.realizedReturn === "number" ? outcome.realizedReturn : null,
        realizedPrice: typeof outcome.realizedPrice === "number" ? outcome.realizedPrice : null,
        note: outcome.note || null
      }
    };
    fb.outcomes.push(rec);
    if (fb.outcomes.length > 10000) fb.outcomes = fb.outcomes.slice(-10000);
    safeJSONSave(FEEDBACK_FILE, fb);
    return { ok: true, rec };
  } catch (e) {
    console.warn("ml_v16.recordOutcome err", e?.message || e);
    return { ok: false, message: e?.message || String(e) };
  }
}

// ---------------------------
// Accuracy / reporting
// ---------------------------
export function calculateAccuracy() {
  try {
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    if (!Array.isArray(fb.outcomes) || !fb.outcomes.length) return { total: 0, accuracy: 0, lastUpdated: nowISO() };
    const total = fb.outcomes.length;
    const correct = fb.outcomes.filter(o => o.outcome && o.outcome.correct).length;
    const accuracy = Math.round((correct / total) * 10000) / 100;
    const summary = { total, correct, accuracy, time: nowISO() };
    safeJSONSave(HISTORY_FILE, summary);
    return summary;
  } catch (e) {
    console.warn("ml_v16.calculateAccuracy err", e?.message || e);
    return { total: 0, accuracy: 0, lastUpdated: nowISO() };
  }
}

// ---------------------------
// Quick evaluate model on array of symbols
// ---------------------------
export async function evaluateModelOnSymbols(symbols = [CONFIG.SYMBOL || "BTCUSDT"], interval = "15m") {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model) return { error: "model_missing" };
    const out = [];
    for (const s of symbols) {
      try {
        const f = await extractFeatures(s, interval);
        if (!f) { out.push({ symbol: s, error: "no_features" }); continue; }
        const p = predictRaw(model, f.features);
        out.push({ symbol: s, prob: Math.round(p * 10000) / 100, features: f.features, ell: f.ell });
      } catch (e) {
        out.push({ symbol: s, error: e.message || String(e) });
      }
    }
    return out;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------------------------
// Auto retrain (dailyRetrain) — wrapper that triggers trainModel
// ---------------------------
export async function dailyRetrain() {
  try {
    const markets = [
      ...(CONFIG.MARKETS?.CRYPTO || []),
      ...(CONFIG.MARKETS?.INDIAN || []),
      ...(CONFIG.MARKETS?.METALS || [])
    ].filter(Boolean);
    if (!markets.length) markets.push(CONFIG.SYMBOL || "BTCUSDT");
    try {
      const model = await trainModel(markets, { useSlidingDataset: true, epochs: CONFIG.ML?.EPOCHS || DEFAULTS.epochs, lr: CONFIG.ML?.LEARNING_RATE || DEFAULTS.lr, window: 60, horizon: DEFAULTS.horizon, maxSamples: 300 });
      const acc = calculateAccuracy();
      return { ok: true, modelMeta: { trainedAt: model.trainedAt, dim: model.dim }, accuracy: acc };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------
// Dashboard
// ---------------------------
export function getMLDashboard() {
  try {
    const model = safeJSONLoad(MODEL_FILE, {}) || {};
    const acc = safeJSONLoad(HISTORY_FILE, {}) || {};
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    return {
      modelAge: model.trainedAt || "never",
      modelDim: model.dim || 0,
      accuracy: acc.accuracy ?? 0,
      feedbackSamples: (fb.outcomes || []).length,
      lastUpdated: acc.time || nowISO()
    };
  } catch (e) {
    return { modelAge: "err", modelDim: 0, accuracy: 0, feedbackSamples: 0, lastUpdated: nowISO() };
  }
}

// ---------------------------
// Exports
// ---------------------------
export default {
  extractFeatures,
  buildSlidingDataset,
  trainModel,
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy,
  evaluateModelOnSymbols,
  dailyRetrain,
  getMLDashboard
};