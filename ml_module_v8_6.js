// ml_module_v10_3.js — ML Engine (AI Trader v10.3)
// Integrated with Elliott, RSI, MACD, Volume, ATR

import fs from "fs";
import path from "path";
import { calculateRSI, calculateMACD } from "./core_indicators.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model.json");
const METRICS_FILE = path.join(CACHE_DIR, "ml_metrics.json");

const sigmoid = x => 1 / (1 + Math.exp(-x));
const nowISO = () => new Date().toISOString();

// -------------------- I/O Helpers --------------------
function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } 
  catch (e) { console.warn("ML save error:", e.message); }
}
function loadJSON(file, def = null) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return def;
}

// -------------------- Feature Extraction --------------------
function extractFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;

  const closes = candles.map(c => +c.close);
  const highs = candles.map(c => +c.high);
  const lows = candles.map(c => +c.low);
  const vols = candles.map(c => +c.vol || 0);

  const recent = candles.slice(-20);
  const prev = closes.slice(-21, -1);

  const priceChange = (closes.at(-1) - closes.at(-10)) / closes.at(-10);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const lastVol = vols.at(-1);
  const volTrend = avgVol ? (lastVol - avgVol) / avgVol : 0;

  const atr = recent.reduce((a, c, i) => {
    if (i === 0) return 0;
    const prevC = recent[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevC.close),
      Math.abs(c.low - prevC.close)
    );
    return a + tr;
  }, 0) / Math.max(1, recent.length - 1);

  const rsiObj = calculateRSI(candles, 14);
  const rsi = typeof rsiObj === "object" ? rsiObj.value ?? 50 : +rsiObj || 50;

  const macdObj = calculateMACD(candles, 12, 26, 9);
  const macdHist = Array.isArray(macdObj.histogram)
    ? macdObj.histogram.at(-1)
    : macdObj?.histogram ?? 0;

  const atrRatio = atr / closes.at(-1);

  return [
    rsi / 100,          // 0–1 normalized RSI
    macdHist || 0,      // histogram value
    priceChange || 0,   // momentum
    volTrend || 0,      // volume shift
    atrRatio || 0       // volatility ratio
  ];
}

// -------------------- Model Core --------------------
function initModel(dim = 5) {
  const w = Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.2);
  return { w, b: 0, dim, trainedAt: nowISO() };
}

function predictRaw(model, x) {
  let s = model.b;
  for (let i = 0; i < model.dim; i++) s += (model.w[i] || 0) * (x[i] || 0);
  return sigmoid(s);
}

function updateSGD(model, x, y, lr = 0.02) {
  const p = predictRaw(model, x);
  const e = p - y;
  for (let i = 0; i < model.dim; i++) model.w[i] -= lr * e * (x[i] || 0);
  model.b -= lr * e;
}

// -------------------- Dataset Builder --------------------
function buildSamples(candles, windowSize = 30) {
  const samples = [];
  for (let i = 0; i + windowSize < candles.length; i++) {
    const window = candles.slice(i, i + windowSize);
    const next = candles[i + windowSize];
    const feat = extractFeatures(window);
    if (!feat) continue;
    const label = +next.close > +window.at(-1).close ? 1 : 0;
    samples.push({ x: feat, y: label });
  }
  return samples;
}

// -------------------- Training --------------------
export async function trainModelFromData(candles, opts = {}) {
  const cfg = { epochs: 25, lr: 0.02, testSplit: 0.2, ...opts };
  const samples = buildSamples(candles);
  if (!samples.length) throw new Error("No valid training samples");

  // Split train/test
  const split = Math.floor(samples.length * (1 - cfg.testSplit));
  const train = samples.slice(0, split);
  const test = samples.slice(split);

  let model = loadJSON(MODEL_FILE, null);
  if (!model || model.dim !== train[0].x.length) model = initModel(train[0].x.length);

  for (let e = 0; e < cfg.epochs; e++) {
    for (const s of train) updateSGD(model, s.x, s.y, cfg.lr);
  }

  // Evaluate
  let correct = 0;
  for (const s of test) {
    const p = predictRaw(model, s.x);
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.y) correct++;
  }
  const acc = test.length ? Math.round((correct / test.length) * 10000) / 100 : 0;

  saveJSON(MODEL_FILE, model);
  const hist = loadJSON(METRICS_FILE, { history: [] });
  hist.history.push({ acc, samples: samples.length, trainedAt: nowISO() });
  saveJSON(METRICS_FILE, hist);

  return { ok: true, acc, model };
}

// -------------------- Prediction --------------------
export function runMLPrediction(candles) {
  const model = loadJSON(MODEL_FILE, null);
  if (!model) return { error: "model_not_found", prob: 50 };

  const feat = extractFeatures(candles);
  if (!feat) return { error: "invalid_features", prob: 50 };

  const p = predictRaw(model, feat);
  const label = p >= 0.5 ? "Bullish" : "Bearish";

  return {
    prob: Math.round(p * 10000) / 100,
    label,
    features: feat,
    modelVersion: model.trainedAt
  };
}

// -------------------- Info + Feedback --------------------
export function getModelInfo() {
  const model = loadJSON(MODEL_FILE, null);
  const metrics = loadJSON(METRICS_FILE, { history: [] });
  return { model, metrics };
}

export function reportPredictionOutcome(correct) {
  const data = loadJSON(METRICS_FILE, { history: [], feedback: [] });
  data.feedback.push({ time: nowISO(), correct });
  saveJSON(METRICS_FILE, data);
  return { ok: true };
}

export default {
  trainModelFromData,
  runMLPrediction,
  getModelInfo,
  reportPredictionOutcome
};