// ml_module_v16.js — ML Engine v16 (Elliott-aware, tg_commands-friendly)
// Exports:
//   extractFeatures, buildSlidingDataset, trainModel, runMLPrediction,
//   recordPrediction, recordOutcome, calculateAccuracy, evaluateModelOnSymbols,
//   dailyRetrain, getMLDashboard
//
// Designed to work with:
//  - core_indicators.js exports: computeRSI, computeMACD, computeATR, analyzeVolume, computeFibLevels
//  - elliott_module.js export: analyzeElliott
//  - utils.js exports: fetchMarketData, nowLocal
//  - news_social.js (optional): fetchNews

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import {
  computeRSI,
  computeMACD,
  computeATR,
  analyzeVolume,
  computeFibLevels,

} from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchMarketData, nowLocal } from "./utils.js";
import { fetchNews } from "./news_social.js";

import { computeFibLevelsFromCandles as computeFibLevels } from "./core_indicators.js";

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v16.json");
const PREDICTIONS_FILE = path.join(CACHE_DIR, "ml_predictions_v16.json");
const FEEDBACK_FILE = path.join(CACHE_DIR, "ml_feedback_v16.json");
const HISTORY_FILE = path.join(CACHE_DIR, "ml_accuracy_v16.json");

const defaultOptions = {
  epochs: CONFIG.ML?.EPOCHS ?? 30,
  lr: CONFIG.ML?.LEARNING_RATE ?? 0.02,
  lookback: CONFIG.ML?.LOOKBACK ?? 300,
  horizon: CONFIG.ML?.HORIZON ?? 3,
  window: CONFIG.ML?.WINDOW ?? 60,
  useSlidingDataset: true,
  maxSamplesPerSymbol: 300,
};

// ------------------ Utility I/O ------------------
function safeLoadJSON(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.warn("ml_v16.safeLoadJSON:", e.message);
    return fallback;
  }
}
function safeSaveJSON(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.warn("ml_v16.safeSaveJSON:", e.message);
    return false;
  }
}
const nowISO = () => new Date().toISOString();

// ------------------ Math Helpers ------------------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ------------------ Feature Extraction ------------------
/**
 * extractFeatures(symbol, interval="1h", lookback=defaultOptions.lookback)
 * Returns: { symbol, interval, features: Number[], close, vol, ell, news, meta }
 */
export async function extractFeatures(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "1h", lookback = defaultOptions.lookback) {
  try {
    const resp = await fetchMarketData(symbol, interval, Math.max(lookback, 50));
    const data = resp?.data || resp || [];
    if (!Array.isArray(data) || data.length < 30) return null;

    // base arrays
    const closes = data.map((c) => Number(c.close || 0));
    const vols = data.map((c) => Number(c.vol || 0));
    const n = closes.length;

    // basic stats
    const lastClose = closes.at(-1);
    const avgClose = closes.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1] || 1;
      returns.push((closes[i] - prev) / Math.max(1, Math.abs(prev)));
    }
    const recentReturn = returns.slice(-10).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, returns.length));
    const volAvg = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const volChange = (vols.at(-1) - volAvg) / Math.max(1, volAvg);

    // indicators (use core_indicators)
    const rsi = Number(computeRSI(data, 14) || 50); // 0..100
    const macdObj = computeMACD(data); // expects {hist, line, signal}
    const macdHist = Number(macdObj?.hist ?? 0);
    const atr = Number(computeATR(data, 14) || 0);

    // volume analysis
    const volAnalysis = analyzeVolume(data);

    // elliott (get sentiment/confidence)
    let ell = null;
    try {
      ell = await analyzeElliott(data);
    } catch (e) {
      ell = null;
    }
    const ellSent = typeof ell?.sentiment === "number" ? ell.sentiment : 0; // -1..1
    const ellConf = Number(ell?.confidence ?? 0) / 100; // 0..1

    // news (optional)
    let news = null;
    try {
      news = await fetchNews ? await fetchNews(symbol.replace("USDT","")) : null;
    } catch (e) {
      news = null;
    }
    const newsScore = Number(news?.score ?? news?.newsImpact ?? 0) / 100; // normalized -1..1 or 0

    // multi-tf heat features: quick fetch small tf to capture momentum (5m,15m)
    let heat_rsi_5 = rsi, heat_rsi_15 = rsi;
    try {
      const r5 = await fetchMarketData(symbol, "5m", 50);
      heat_rsi_5 = Number(computeRSI(r5?.data || [], 14) || rsi);
      const r15 = await fetchMarketData(symbol, "15m", 100);
      heat_rsi_15 = Number(computeRSI(r15?.data || [], 14) || rsi);
    } catch (e) {}

    // features vector (order matters)
    const features = [
      recentReturn || 0,           // 0: recent return
      volChange || 0,              // 1: relative vol change
      (rsi || 50) / 100,           // 2: rsi normalized 0..1
      (macdHist || 0) / Math.max(1, Math.abs(avgClose) || 1) / 0.01, // 3: scaled macd hist (heuristic)
      (atr || 0) / Math.max(1, avgClose || 1), // 4: atr normalized to price
      (ellSent || 0),              // 5: ell sentiment (-1..1)
      (ellConf || 0),              // 6: ell confidence 0..1
      (newsScore || 0),            // 7: news sentiment (-1..1)
      (heat_rsi_5 || 50)/100,      // 8: short heat rsi
      (heat_rsi_15 || 50)/100      // 9: 15m rsi heat
    ];

    return {
      symbol,
      interval,
      features,
      close: lastClose,
      vol: vols.at(-1),
      ell,
      news,
      meta: { fetchedAt: nowISO(), avgClose, atr }
    };
  } catch (e) {
    console.warn("ml_v16.extractFeatures err:", e?.message || e);
    return null;
  }
}

// ------------------ Sliding dataset builder ------------------
/**
 * buildSlidingDataset(symbol, interval="1h", window=60, horizon=3, maxSamples=200)
 * Returns { X:[], Y:[], meta:[] }
 */
export async function buildSlidingDataset(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "1h", window = defaultOptions.window, horizon = defaultOptions.horizon, maxSamples = defaultOptions.maxSamplesPerSymbol) {
  try {
    const resp = await fetchMarketData(symbol, interval, window + horizon + 20);
    const data = resp?.data || [];
    if (!Array.isArray(data) || data.length < window + horizon) return null;

    const X = [], Y = [], meta = [];
    for (let start = 0; start + window + horizon <= data.length; start++) {
      const windowCandles = data.slice(start, start + window);
      const futureCandles = data.slice(start + window, start + window + horizon);
      // extract local features (avoid heavy network calls)
      const closes = windowCandles.map(c => Number(c.close || 0));
      const vols = windowCandles.map(c => Number(c.vol || 0));
      const avgClose = closes.reduce((a,b)=>a+b,0)/Math.max(1, closes.length);
      const returns = [];
      for (let i=1;i<closes.length;i++) returns.push((closes[i]-closes[i-1]) / Math.max(1, Math.abs(closes[i-1])));
      const recentReturn = returns.slice(-10).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(10, returns.length));
      const volAvg = vols.reduce((a,b)=>a+b,0)/Math.max(1, vols.length);
      const volChange = (vols.at(-1)-volAvg)/Math.max(1, volAvg);
      const rsiVal = Number(computeRSI(windowCandles, 14) || 50);
      const macdObj = computeMACD(windowCandles);
      const macdHist = Number(macdObj?.hist ?? 0);
      const atr = Number(computeATR(windowCandles, 14) || 0);
      // lightweight Elliott summary (sync-ish using analyzeElliott may be async heavy; call but catch)
      let ell = null;
      try { ell = await analyzeElliott(windowCandles); } catch (e) { ell = null; }
      const ellSent = ell ? (ell.sentiment || 0) : 0;
      const ellConf = ell ? (Number(ell.confidence || 0)/100) : 0;
      // features
      const features = [
        recentReturn || 0,
        volChange || 0,
        (rsiVal || 50) / 100,
        (macdHist || 0) / Math.max(1, Math.abs(avgClose) || 1) / 0.01,
        (atr || 0) / Math.max(1, avgClose || 1),
        ellSent,
        ellConf
      ];
      // label from future close: up or not
      const lastClose = closes.at(-1);
      const futureClose = Number(futureCandles.at(-1)?.close || 0);
      const futRet = lastClose ? (futureClose - lastClose) / Math.max(1, Math.abs(lastClose)) : 0;
      const label = futRet > 0 ? 1 : 0;
      X.push(features);
      Y.push(label);
      meta.push({ symbol, index: start, lastClose, futureClose, futRet });
      if (X.length >= maxSamples) break;
    }

    return { X, Y, meta };
  } catch (e) {
    console.warn("ml_v16.buildSlidingDataset err:", e?.message || e);
    return null;
  }
}

// ------------------ Model (logistic regression via SGD) ------------------
function initModel(dim) {
  return { w: Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01), b: 0, dim, trainedAt: nowISO() };
}
function predictRaw(model, x) {
  let s = model.b || 0;
  for (let i = 0; i < model.w.length && i < x.length; i++) s += (model.w[i] || 0) * (x[i] || 0);
  return sigmoid(s);
}
function updateSGD(model, x, y, lr = 0.02) {
  const p = predictRaw(model, x);
  const e = p - y;
  for (let i = 0; i < model.w.length && i < x.length; i++) model.w[i] -= lr * e * (x[i] || 0);
  model.b -= lr * e;
}

// ------------------ Training Entry ------------------
/**
 * trainModel(symbols = [CONFIG.SYMBOL], options = {})
 * options: { epochs, lr, useSlidingDataset, window, horizon, interval }
 */
export async function trainModel(symbols = [CONFIG.SYMBOL || "BTCUSDT"], options = {}) {
  const opts = Object.assign({}, defaultOptions, options);
  const allX = [], allY = [];
  for (const s of symbols) {
    try {
      if (opts.useSlidingDataset) {
        const ds = await buildSlidingDataset(s, opts.interval || "1h", opts.window, opts.horizon, opts.maxSamplesPerSymbol);
        if (ds && ds.X && ds.X.length) { allX.push(...ds.X); allY.push(...ds.Y); }
      } else {
        const f = await extractFeatures(s, opts.interval || "1h", opts.lookback);
        if (f && f.features) {
          allX.push(f.features);
          allY.push(f.features[0] > 0 ? 1 : 0);
        }
      }
    } catch (e) {
      console.warn("ml_v16.trainModel sample build failed for", s, e.message);
    }
  }

  if (!allX.length) throw new Error("ml_v16.trainModel: no samples");

  const dim = allX[0].length;
  let model = safeLoadJSON(MODEL_FILE, null);
  if (!model || model.dim !== dim) model = initModel(dim);

  const epochs = opts.epochs || defaultOptions.epochs;
  const lr = opts.lr || defaultOptions.lr;

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = 0; i < allX.length; i++) {
      const idx = Math.floor(Math.random() * allX.length);
      updateSGD(model, allX[idx], allY[idx], lr);
    }
  }

  model.trainedAt = nowISO();
  model.dim = dim;
  safeSaveJSON(MODEL_FILE, model);
  return model;
}

// ------------------ Prediction API ------------------
/**
 * runMLPrediction(symbol)
 * returns { id?, symbol, label, prob, features, ell, newsImpact }
 */
export async function runMLPrediction(symbol = CONFIG.SYMBOL || "BTCUSDT") {
  try {
    const model = safeLoadJSON(MODEL_FILE, null);
    if (!model) return { error: "model_not_found" };

    const f = await extractFeatures(symbol, "1h", defaultOptions.lookback);
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
      meta: { ell: f.ell, newsImpact: f.news?.score ?? f.news?.newsImpact ?? 0 }
    });

    return {
      id: predId,
      symbol,
      label,
      prob: pct,
      features: f.features,
      ell: f.ell,
      newsImpact: f.news?.score ?? f.news?.newsImpact ?? 0
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ------------------ Persistence ------------------
export async function recordPrediction(obj = {}) {
  try {
    const store = safeLoadJSON(PREDICTIONS_FILE, { preds: [] });
    const id = `mlpred_v16_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const entry = Object.assign({ id, ts: Date.now() }, obj);
    store.preds = store.preds || [];
    store.preds.push(entry);
    if (store.preds.length > 2000) store.preds = store.preds.slice(-2000);
    safeSaveJSON(PREDICTIONS_FILE, store);
    return id;
  } catch (e) {
    console.warn("ml_v16.recordPrediction err:", e.message);
    return null;
  }
}

export function recordOutcome(predictionId, outcome = {}) {
  try {
    const preds = safeLoadJSON(PREDICTIONS_FILE, { preds: [] });
    const p = (preds.preds || []).find(x => x.id === predictionId);
    const fb = safeLoadJSON(FEEDBACK_FILE, { outcomes: [] });
    const rec = {
      predictionId,
      ts: Date.now(),
      predicted: p || null,
      outcome: {
        correct: !!outcome.correct,
        realizedReturn: typeof outcome.realizedReturn === "number" ? outcome.realizedReturn : null,
        realizedPrice: typeof outcome.realizedPrice === "number" ? outcome.realizedPrice : null,
        note: outcome.note || null
      }
    };
    fb.outcomes.push(rec);
    if (fb.outcomes.length > 5000) fb.outcomes = fb.outcomes.slice(-5000);
    safeSaveJSON(FEEDBACK_FILE, fb);
    return { ok: true, rec };
  } catch (e) {
    console.warn("ml_v16.recordOutcome err:", e.message);
    return { ok: false, message: e.message };
  }
}

// ------------------ Accuracy & Eval ------------------
export function calculateAccuracy() {
  const fb = safeLoadJSON(FEEDBACK_FILE, { outcomes: [] });
  if (!fb || !fb.outcomes || !fb.outcomes.length) return { total: 0, accuracy: 0, lastUpdated: nowISO() };
  const total = fb.outcomes.length;
  const correct = fb.outcomes.filter(o => o.outcome?.correct).length;
  const accuracy = Math.round((correct / total) * 10000) / 100;
  const summary = { total, correct, accuracy, time: nowISO() };
  safeSaveJSON(HISTORY_FILE, summary);
  return summary;
}

export async function evaluateModelOnSymbols(symbols = [CONFIG.SYMBOL || "BTCUSDT"], interval = "1h") {
  const model = safeLoadJSON(MODEL_FILE, null);
  if (!model) return { error: "model_missing" };
  const out = [];
  for (const s of symbols) {
    try {
      const f = await extractFeatures(s, interval);
      if (!f) { out.push({ symbol: s, error: "no_features" }); continue; }
      const p = predictRaw(model, f.features);
      out.push({ symbol: s, prob: Math.round(p * 10000) / 100, features: f.features, ell: f.ell });
    } catch (e) {
      out.push({ symbol: s, error: e.message });
    }
  }
  return out;
}

// ------------------ Auto retrain ------------------
export async function dailyRetrain() {
  try {
    const symbols = CONFIG.MARKETS?.CRYPTO || [CONFIG.SYMBOL || "BTCUSDT"];
    await trainModel(symbols, { useSlidingDataset: true, epochs: CONFIG.ML?.EPOCHS || 20, lr: CONFIG.ML?.LEARNING_RATE || 0.02, window: 60, horizon: defaultOptions.horizon, maxSamplesPerSymbol: 200 });
    const acc = calculateAccuracy();
    return acc;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ------------------ Dashboard ------------------
export function getMLDashboard() {
  const model = safeLoadJSON(MODEL_FILE, { dim: 0, trainedAt: null });
  const acc = safeLoadJSON(HISTORY_FILE, {});
  const fb = safeLoadJSON(FEEDBACK_FILE, { outcomes: [] });
  return {
    modelAge: model.trainedAt || "never",
    modelDim: model.dim || 0,
    accuracy: acc.accuracy ?? acc.acc ?? 0,
    feedbackSamples: fb.outcomes?.length || 0,
    lastUpdated: acc.time || nowISO()
  };
}

// default export
export default {
  extractFeatures,
  buildSlidingDataset,
  trainModel,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy,
  evaluateModelOnSymbols,
  dailyRetrain,
  getMLDashboard
};