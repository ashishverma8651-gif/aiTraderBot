// ml_module_v15.js — Upgraded Self-Learning AI Engine (v15.1)
// Integrates: multi-market + indicators + Elliott + news + volume + feedback
// Exports: trainModel, runMLPrediction, recordPrediction, recordOutcome, calculateAccuracy,
//          buildSlidingDataset, evaluateModelOnSymbols, dailyRetrain, getMLDashboard

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import analyzeElliott from "./elliott_module.js";
import { fetchMarketData, nowLocal } from "./utils.js";
import { fetchNews } from "./news_social.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v15.json");
const PREDICTIONS_FILE = path.join(CACHE_DIR, "ml_predictions_v15.json"); // store predictions before outcome
const FEEDBACK_FILE = path.join(CACHE_DIR, "ml_feedback_v15.json"); // store outcomes (isCorrect)
const HISTORY_FILE = path.join(CACHE_DIR, "ml_accuracy_v15.json");

const defaultOptions = {
  epochs: CONFIG.ML?.EPOCHS ?? 25,
  lr: CONFIG.ML?.LEARNING_RATE ?? 0.02,
  lookback: CONFIG.ML?.LOOKBACK ?? 500,
  horizon: 3 // prediction horizon in candles (for label generation when using sliding windows)
};

// --------- Utilities ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

function safeJSONLoad(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const txt = fs.readFileSync(filePath, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.warn("ml_module_v15: safeJSONLoad err", e.message);
    return fallback;
  }
}

function safeJSONSave(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("ml_module_v15: safeJSONSave err", e.message);
    return false;
  }
}

// sigmoid / logistic helpers
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// --------- Feature Extraction (single window) ----------
// Returns { features: Number[], close, vol, ell, news } or null
export async function extractFeatures(symbol, interval = "1h", lookback = defaultOptions.lookback) {
  try {
    const resp = await fetchMarketData(symbol, interval, lookback);
    const data = resp?.data;
    if (!Array.isArray(data) || data.length < 30) return null;

    // basic arrays
    const closes = data.map((c) => Number(c.close || c.c || 0));
    const vols = data.map((c) => Number(c.vol || c.v || c.volume || 0));

    // statistics
    const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const volChange = (vols.at(-1) - avgVol) / (avgVol || 1);

    // returns: use last window returns average
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      const prev = closes[i - 1] || 1;
      returns.push((closes[i] - prev) / prev);
    }
    const avgRet = returns.length ? returns.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, returns.length)) : 0;

    // indicators
    const rsiObj = calculateRSI(data, 14);
    const rsiVal = typeof rsiObj === "number" ? rsiObj : (rsiObj?.value ?? null);
    const macdObj = calculateMACD(data, 12, 26, 9);
    const macdVal = macdObj?.latest?.macd ?? (Array.isArray(macdObj?.macd) ? macdObj.macd.at(-1) : null);

    // elliott
    const ell = await analyzeElliott(data, { depth: 5 });
    const waveBias = /[345]/.test(String(ell?.wave ?? "")) ? 1 : -1;
    const waveConf = Number(ell?.confidence ?? 0) / 100;

    // news
    const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
    const sentiment = (news?.score ?? news?.newsImpact ?? 0) / 100; // -1..1

    // normalized feature vector (important: keep order and scale consistent)
    const features = [
      avgRet || 0,                 // recent average return
      volChange || 0,              // relative vol change
      (rsiVal || 50) / 100,        // rsi normalized 0..1 (fallback 0.5)
      (macdVal || 0) / Math.max(1, Math.abs(avgClose) || 1) / 0.01, // scaled macd (heuristic)
      waveBias,                    // ±1
      waveConf || 0,               // 0..1
      sentiment || 0               // -1..1
    ];

    return {
      symbol,
      interval,
      features,
      close: closes.at(-1),
      vol: vols.at(-1),
      ell,
      news,
      fetchedAt: nowISO()
    };
  } catch (e) {
    console.warn("ml_module_v15.extractFeatures error:", e && e.message);
    return null;
  }
}

// --------- Sliding dataset builder (useful for training many samples) ---------
// Builds labeled samples by sliding a window over historical candles.
// horizon = number of candles ahead to compute label (e.g., 3)
// label rule: if (future_return > threshold) label = 1 else 0
export async function buildSlidingDataset(symbol, interval = "1h", window = 60, horizon = defaultOptions.horizon, maxSamples = 200) {
  // Returns { X: [features...], Y: [0/1], meta: [...] }
  try {
    const resp = await fetchMarketData(symbol, interval, window + horizon + 10);
    const data = resp?.data;
    if (!Array.isArray(data) || data.length < window + horizon) return null;

    const X = [];
    const Y = [];
    const meta = [];

    // For each slide position compute features and label using future horizon
    for (let start = 0; start + window + horizon <= data.length; start++) {
      const windowCandles = data.slice(start, start + window);
      const futureCandles = data.slice(start + window, start + window + horizon);
      // features from windowCandles
      const tmp = await (async () => {
        // We call local extraction on this window by building a minimal fetch wrapper:
        // reuse calculateRSI & calculateMACD on windowCandles directly
        const closes = windowCandles.map((c) => Number(c.close || c.c || 0));
        const vols = windowCandles.map((c) => Number(c.vol || c.v || c.volume || 0));
        const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
        const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
        const volChange = (vols.at(-1) - avgVol) / (avgVol || 1);
        const returns = [];
        for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / (closes[i - 1] || 1));
        const avgRet = returns.length ? returns.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, returns.length)) : 0;
        const rsiObj = calculateRSI(windowCandles, 14);
        const rsiVal = typeof rsiObj === "number" ? rsiObj : (rsiObj?.value ?? 50);
        const macdObj = calculateMACD(windowCandles, 12, 26, 9);
        const macdVal = macdObj?.latest?.macd ?? (Array.isArray(macdObj?.macd) ? macdObj.macd.at(-1) : 0);
        const ell = await analyzeElliott(windowCandles, { depth: 5 });
        const waveBias = /[345]/.test(String(ell?.wave ?? "")) ? 1 : -1;
        const waveConf = Number(ell?.confidence ?? 0) / 100;
        // news (light) - don't await remote fetch per-sample to save time; set 0
        const sentiment = 0;
        const features = [
          avgRet || 0,
          volChange || 0,
          (rsiVal || 50) / 100,
          (macdVal || 0) / Math.max(1, Math.abs(avgClose) || 1) / 0.01,
          waveBias,
          waveConf || 0,
          sentiment || 0
        ];
        return { features, lastClose: closes.at(-1) };
      })();

      // compute label from futureCandles
      const futureClose = Number(futureCandles.at(-1)?.close || futureCandles.at(0)?.close || 0);
      const lastClose = tmp.lastClose || 0;
      const futureRet = lastClose ? (futureClose - lastClose) / lastClose : 0;
      const label = futureRet > 0 ? 1 : 0; // simple label: future up or not
      X.push(tmp.features);
      Y.push(label);
      meta.push({ symbol, interval, index: start, lastClose, futureClose, futureRet });
      if (X.length >= maxSamples) break;
    }

    return { X, Y, meta };
  } catch (e) {
    console.warn("ml_module_v15.buildSlidingDataset err:", e.message);
    return null;
  }
}

// --------- Model helpers (logistic regression w/ SGD) ----------
function initModel(dim) {
  const w = Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01);
  const b = 0;
  return { w, b, dim, trainedAt: nowISO() };
}
function predictRaw(model, x) {
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

// --------- Training ----------
/**
 * trainModel(symbols, options)
 * options: { epochs, lr, useSlidingDataset: true/false, window, horizon }
 */
export async function trainModel(symbols = [CONFIG.SYMBOL], options = {}) {
  const opts = Object.assign({}, defaultOptions, options);
  const allX = [];
  const allY = [];

  // Build dataset: preferred method is sliding windows to increase samples
  for (const s of symbols) {
    try {
      if (opts.useSlidingDataset) {
        const ds = await buildSlidingDataset(s, opts.interval || "1h", opts.window || 60, opts.horizon || opts.horizon || defaultOptions.horizon, opts.maxSamples || 200);
        if (ds && ds.X && ds.X.length) {
          allX.push(...ds.X);
          allY.push(...ds.Y);
        }
      } else {
        // fallback: single-window feature per symbol
        const f = await extractFeatures(s, opts.interval || "1h", opts.lookback);
        if (f && f.features) {
          allX.push(f.features);
          // label: avg recent return positive?
          allY.push(f.features[0] > 0 ? 1 : 0);
        }
      }
    } catch (e) {
      console.warn("ml_module_v15.trainModel sample build failed for", s, e.message);
    }
  }

  if (!allX.length) throw new Error("No training samples. Try enabling sliding dataset or add symbols.");

  const dim = allX[0].length;
  let model = safeJSONLoad(MODEL_FILE, null);
  if (!model || model.dim !== dim) model = initModel(dim);

  const epochs = opts.epochs || defaultOptions.epochs;
  const lr = opts.lr || defaultOptions.lr;

  // simple training loop
  for (let ep = 0; ep < epochs; ep++) {
    // optional shuffle
    for (let i = 0; i < allX.length; i++) {
      const idx = Math.floor(Math.random() * allX.length);
      const x = allX[idx], y = allY[idx];
      updateSGD(model, x, y, lr);
    }
  }

  model.trainedAt = nowISO();
  safeJSONSave(MODEL_FILE, model);
  return model;
}

// --------- Prediction API ----------
/**
 * runMLPrediction(symbol)
 * returns { symbol, prob(0..100), label, features, meta }
 */
export async function runMLPrediction(symbol = CONFIG.SYMBOL) {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model) return { error: "model_not_found" };

    const f = await extractFeatures(symbol, "1h", defaultOptions.lookback);
    if (!f) return { error: "no_features" };

    const p = predictRaw(model, f.features);
    const pct = Math.round(p * 10000) / 100; // 0..100 with 2 decimals
    const label = pct > 55 ? "Bullish" : pct < 45 ? "Bearish" : "Neutral";

    // record prediction (so we can attach outcome later)
    const predId = await recordPrediction({
      symbol,
      predictedAt: nowISO(),
      label,
      prob: pct,
      features: f.features,
      meta: { ell: f.ell, newsImpact: f.news?.score ?? f.news?.newsImpact }
    });

    return {
      id: predId,
      symbol,
      label,
      prob: pct,
      features: f.features,
      ell: f.ell,
      newsImpact: f.news?.score ?? f.news?.newsImpact,
    };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// --------- Prediction storage & outcome recording ----------
/**
 * recordPrediction(obj)
 * obj should contain at least: { symbol, label, prob, predictedAt, features, meta }
 * returns predictionId
 */
export async function recordPrediction(obj = {}) {
  try {
    const store = safeJSONLoad(PREDICTIONS_FILE, { preds: [] });
    const id = `mlpred_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const entry = Object.assign({ id, ts: Date.now() }, obj);
    store.preds = store.preds || [];
    store.preds.push(entry);
    // keep size bounded
    if (store.preds.length > 2000) store.preds = store.preds.slice(-2000);
    safeJSONSave(PREDICTIONS_FILE, store);
    return id;
  } catch (e) {
    console.warn("ml_module_v15.recordPrediction err:", e.message);
    return null;
  }
}

/**
 * recordOutcome(predictionId, outcome)
 * outcome: { correct: boolean, realizedReturn?: number, realizedPrice?: number, note?: string }
 */
export function recordOutcome(predictionId, outcome = {}) {
  try {
    const preds = safeJSONLoad(PREDICTIONS_FILE, { preds: [] });
    const p = (preds.preds || []).find((x) => x.id === predictionId);
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] });
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
    safeJSONSave(FEEDBACK_FILE, fb);
    return { ok: true, rec };
  } catch (e) {
    console.warn("ml_module_v15.recordOutcome err:", e.message);
    return { ok: false, message: e.message };
  }
}

// --------- Accuracy / reporting ----------
export function calculateAccuracy() {
  const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] });
  if (!fb.outcomes.length) return { total: 0, accuracy: 0, lastUpdated: nowISO() };
  const total = fb.outcomes.length;
  const correct = fb.outcomes.filter((o) => o.outcome?.correct).length;
  const accuracy = Math.round((correct / total) * 10000) / 100;
  const summary = { total, correct, accuracy, time: nowISO() };
  safeJSONSave(HISTORY_FILE, summary);
  return summary;
}

// --------- Evaluate model quickly on a set of symbols (report) ----------
export async function evaluateModelOnSymbols(symbols = [CONFIG.SYMBOL], interval = "1h") {
  const res = [];
  const model = safeJSONLoad(MODEL_FILE, null);
  if (!model) return { error: "model_missing" };
  for (const s of symbols) {
    try {
      const f = await extractFeatures(s, interval);
      if (!f) { res.push({ symbol: s, error: "no_features" }); continue; }
      const p = predictRaw(model, f.features);
      res.push({ symbol: s, prob: Math.round(p * 10000) / 100, features: f.features, ell: f.ell });
    } catch (e) {
      res.push({ symbol: s, error: e.message });
    }
  }
  return res;
}

// --------- Auto retrain job ----------
export async function dailyRetrain() {
  console.log("ml_module_v15: daily retrain started...");
  const markets = [...(CONFIG.MARKETS?.CRYPTO || []), ...(CONFIG.MARKETS?.INDIAN || []), ...(CONFIG.MARKETS?.METALS || [])];
  try {
    await trainModel(markets, { useSlidingDataset: true, epochs: CONFIG.ML?.EPOCHS || 25, lr: CONFIG.ML?.LEARNING_RATE || 0.02, window: 60, horizon: 3, maxSamples: 300 });
    const acc = calculateAccuracy();
    console.log("ml_module_v15: retrain complete. accuracy:", acc);
    return acc;
  } catch (e) {
    console.warn("ml_module_v15.dailyRetrain failed:", e.message);
    return { error: e.message };
  }
}

// --------- dashboard ----------
export function getMLDashboard() {
  const model = safeJSONLoad(MODEL_FILE, {});
  const acc = safeJSONLoad(HISTORY_FILE, {});
  const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] });
  return {
    modelAge: model.trainedAt || "never",
    modelDim: model.dim || 0,
    accuracy: acc.accuracy ?? acc.acc ?? 0,
    feedbackSamples: fb.outcomes.length,
    lastUpdated: acc.time || nowISO()
  };
}

// --------- default export ----------
export default {
  buildSlidingDataset,
  extractFeatures,
  trainModel,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy,
  evaluateModelOnSymbols,
  dailyRetrain,
  getMLDashboard
};