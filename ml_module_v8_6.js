// ml_module_v8_6.js — AI Trader v9.6 Final Stable
// Machine Learning Engine (Self-Learning Logistic Model)
// Provides: training, prediction, accuracy tracking & persistence

import fs from "fs";
import path from "path";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model.json");
const METRICS_FILE = path.join(CACHE_DIR, "ml_metrics.json");

// ========== Utilities ==========
const sigmoid = x => 1 / (1 + Math.exp(-x));
const nowISO = () => new Date().toISOString();

function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch (e) { console.warn("ML save error:", e.message); }
}
function loadJSON(file, def = null) {
  try {
    if (fs.existsSync(file))
      return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.warn("ML load error:", e.message); }
  return def;
}

// ========== Feature Extraction ==========
function extractFeatures(window) {
  const n = window.length;
  if (n < 2 || !window.every(c => c && typeof c.close === "number")) return null;

  const closes = window.map(c => +c.close);
  const vols = window.map(c => +c.vol || 0);

  const rets = [];
  for (let i = 1; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);

  const avgRet = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sma = closes.reduce((a, b) => a + b, 0) / n;
  const smaDiff = (closes[n - 1] - sma) / sma;
  const volAvg = vols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, n - 1);
  const volChange = volAvg ? (vols[n - 1] - volAvg) / volAvg : 0;
  const lastRet = rets[rets.length - 1];
  const sumRet = rets.reduce((a, b) => a + b, 0);

  return [avgRet, lastRet, sumRet, smaDiff, volChange];
}

// ========== Model Core ==========
function initModel(dim = 5) {
  const w = new Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.1);
  return { w, b: 0, dim, trainedAt: nowISO() };
}

function predictRaw(model, x) {
  let s = model.b;
  for (let i = 0; i < model.dim; i++) s += (model.w[i] || 0) * (x[i] || 0);
  return sigmoid(s);
}

function updateSGD(model, x, y, lr = 0.01) {
  const p = predictRaw(model, x);
  const e = p - y;
  for (let i = 0; i < model.dim; i++) model.w[i] -= lr * e * (x[i] || 0);
  model.b -= lr * e;
}

// ========== Training Sample Builder ==========
function buildSamples(candles, windowSize = 8) {
  const samples = [];
  if (!Array.isArray(candles) || candles.length < windowSize + 1) return samples;

  for (let i = 0; i + windowSize < candles.length; i++) {
    const win = candles.slice(i, i + windowSize);
    const next = candles[i + windowSize];
    if (!win.length || !next || next.close == null || win[win.length - 1].close == null)
      continue;

    const feat = extractFeatures(win);
    if (!feat || feat.some(isNaN)) continue;

    const label = Number(next.close) > Number(win[win.length - 1].close) ? 1 : 0;
    samples.push({ x: feat, y: label });
  }

  return samples;
}

// ========== Training ==========
export async function trainModelFromData(candles, opts = {}) {
  const cfg = { windowSize: 8, epochs: 25, lr: 0.02, testSplit: 0.2, ...opts };
  if (!Array.isArray(candles) || candles.length < cfg.windowSize + 2)
    throw new Error("Not enough candles for ML training");

  const samples = buildSamples(candles, cfg.windowSize);
  if (!samples.length) throw new Error("No valid samples built");

  // Shuffle
  for (let i = samples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [samples[i], samples[j]] = [samples[j], samples[i]];
  }

  const split = Math.floor(samples.length * (1 - cfg.testSplit));
  const train = samples.slice(0, split);
  const test = samples.slice(split);

  let model = loadJSON(MODEL_FILE, null);
  if (!model || model.dim !== train[0].x.length)
    model = initModel(train[0].x.length);

  for (let e = 0; e < cfg.epochs; e++)
    for (const s of train) updateSGD(model, s.x, s.y, cfg.lr);

  // Evaluate
  let correct = 0, total = test.length, avgProb = 0;
  for (const s of test) {
    const p = predictRaw(model, s.x);
    if ((p >= 0.5 ? 1 : 0) === s.y) correct++;
    avgProb += p;
  }

  const acc = total ? (correct / total) * 100 : 0;
  const metrics = {
    samples: samples.length,
    train: train.length,
    test: test.length,
    accuracy: Math.round(acc * 100) / 100,
    avgProb: Math.round((avgProb / (total || 1)) * 10000) / 10000,
    trainedAt: nowISO()
  };

  saveJSON(MODEL_FILE, model);
  const hist = loadJSON(METRICS_FILE, { trains: [] });
  hist.trains.push(metrics);
  saveJSON(METRICS_FILE, hist);

  return { ok: true, model, metrics };
}

// ========== Prediction ==========
export function runMLPrediction(window) {
  const model = loadJSON(MODEL_FILE, null);
  if (!model) return { error: "model_not_found" };

  const feat = extractFeatures(window);
  if (!feat || feat.length !== model.dim) return { error: "invalid_features" };

  const p = predictRaw(model, feat);
  const label = p >= 0.5 ? "Bullish" : "Bearish";
  return { prob: Math.round(p * 10000) / 100, label, features: feat };
}

// ========== Metrics & Feedback ==========
export function getModelInfo() {
  const model = loadJSON(MODEL_FILE, null);
  const metrics = loadJSON(METRICS_FILE, { trains: [] });
  return { model, metrics };
}

export function reportPredictionOutcome(correct) {
  const file = loadJSON(METRICS_FILE, { trains: [], feedback: [] });
  file.feedback.push({ time: nowISO(), correct });
  saveJSON(METRICS_FILE, file);
  return { ok: true };
}

// ========== Default Export ==========
export default {
  trainModelFromData,
  runMLPrediction,
  getModelInfo,
  reportPredictionOutcome
};