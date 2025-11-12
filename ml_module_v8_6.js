// ml_module_v15.js — Self-Learning AI Engine (Full Version)
// integrates: multi-market + indicators + Elliott + news + volume + feedback accuracy
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchMarketData, nowLocal } from "./utils.js";
import { fetchNews } from "./news_social.js";

const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v15.json");
const FEEDBACK_FILE = path.join(CACHE_DIR, "ml_feedback_v15.json");
const HISTORY_FILE = path.join(CACHE_DIR, "ml_accuracy.json");

// --------------------------
// Core Helpers
// --------------------------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const loadJSON = (f, d = {}) => {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { }
  return d;
};
const saveJSON = (f, d) => {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.warn("⚠️ save failed:", e.message); }
};

// --------------------------
// 🔍 Feature Extraction
// --------------------------
async function extractFeatures(symbol, interval = "1h") {
  const { data } = await fetchMarketData(symbol, interval, 300);
  if (!Array.isArray(data) || data.length < 30) return null;

  const closes = data.map(c => +c.close);
  const vols = data.map(c => +c.vol || 0);
  const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const volChange = (vols.at(-1) - avgVol) / (avgVol || 1);

  const returns = closes.slice(1).map((v, i) => (v - closes[i]) / closes[i]);
  const avgRet = returns.reduce((a, b) => a + b, 0) / returns.length;

  const rsi = calculateRSI(data, 14);
  const macd = calculateMACD(data, 12, 26, 9);
  const rsiVal = typeof rsi === "number" ? rsi : rsi.value || Object.values(rsi).at(-1);
  const macdVal = typeof macd === "object"
    ? (Array.isArray(macd.macd) ? macd.macd.at(-1) : macd.macd)
    : macd;

  const ell = await analyzeElliott(data);
  const waveBias = /[345]/.test(ell?.wave || "") ? 1 : -1;
  const waveConf = ell?.confidence || 0;

  const news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
  const sentiment = (news.score || 0) / 100;

  return {
    symbol,
    interval,
    features: [
      avgRet,
      volChange,
      rsiVal / 100,
      macdVal / 10,
      waveBias,
      waveConf / 100,
      sentiment,
    ],
    close: closes.at(-1),
    vol: vols.at(-1),
    ell,
    news,
  };
}

// --------------------------
// 🤖 Model Core
// --------------------------
function initModel(dim) {
  return { w: Array(dim).fill(0).map(() => Math.random() * 0.05), b: 0, trainedAt: nowLocal() };
}
function predictRaw(model, x) {
  let s = model.b;
  for (let i = 0; i < model.w.length; i++) s += model.w[i] * x[i];
  return sigmoid(s);
}
function updateSGD(model, x, y, lr = 0.02) {
  const p = predictRaw(model, x);
  const e = p - y;
  for (let i = 0; i < model.w.length; i++) model.w[i] -= lr * e * x[i];
  model.b -= lr * e;
}

// --------------------------
// 🧠 Training Engine
// --------------------------
export async function trainModel(symbols = [CONFIG.SYMBOL]) {
  const feats = [];
  for (const s of symbols) {
    const f = await extractFeatures(s);
    if (f) feats.push(f);
  }
  if (!feats.length) throw new Error("No training features");

  const dim = feats[0].features.length;
  let model = loadJSON(MODEL_FILE, null);
  if (!model || model.w.length !== dim) model = initModel(dim);

  const lr = CONFIG.ML?.LEARNING_RATE || 0.02;
  for (let epoch = 0; epoch < 30; epoch++) {
    for (const f of feats) {
      const label = f.features[0] > 0 ? 1 : 0;
      updateSGD(model, f.features, label, lr);
    }
  }
  saveJSON(MODEL_FILE, model);

  console.log(`🧠 Model retrained on ${feats.length} symbols`);
  return model;
}

// --------------------------
// 📊 Prediction
// --------------------------
export async function runMLPrediction(symbol = CONFIG.SYMBOL) {
  const model = loadJSON(MODEL_FILE, null);
  if (!model) return { error: "model_not_found" };

  const f = await extractFeatures(symbol);
  if (!f) return { error: "no_features" };

  const prob = predictRaw(model, f.features);
  const percent = Math.round(prob * 10000) / 100;
  const label = percent > 55 ? "Bullish" : percent < 45 ? "Bearish" : "Neutral";

  recordFeedback(symbol, label, f.close);

  return {
    symbol,
    label,
    prob: percent,
    features: f.features,
    ell: f.ell,
    newsImpact: f.news?.impact,
    confidence: f.ell?.confidence,
  };
}

// --------------------------
// 📈 Feedback + Accuracy
// --------------------------
export function recordFeedback(symbol, prediction, price) {
  const data = loadJSON(FEEDBACK_FILE, { records: [] });
  data.records.push({ time: nowLocal(), symbol, prediction, price });
  if (data.records.length > 1000) data.records = data.records.slice(-1000);
  saveJSON(FEEDBACK_FILE, data);
}

// Calculate model accuracy
export function calculateAccuracy() {
  const fb = loadJSON(FEEDBACK_FILE, { records: [] });
  if (!fb.records.length) return { total: 0, acc: 0 };

  let correct = 0;
  for (const r of fb.records) {
    if ((r.prediction === "Bullish" && r.price > 0) || (r.prediction === "Bearish" && r.price < 0)) correct++;
  }
  const acc = Math.round((correct / fb.records.length) * 10000) / 100;
  const result = { total: fb.records.length, acc, time: nowLocal() };
  saveJSON(HISTORY_FILE, result);
  return result;
}

// --------------------------
// 🔁 Auto Retrain Scheduler
// --------------------------
export async function dailyRetrain() {
  console.log("⏳ Daily retrain started...");
  const mkts = [
    ...CONFIG.MARKETS.CRYPTO,
    ...CONFIG.MARKETS.INDIAN,
    ...CONFIG.MARKETS.METALS,
  ];
  await trainModel(mkts);
  const acc = calculateAccuracy();
  console.log(`✅ Retrain complete | Accuracy: ${acc.acc}% (${acc.total} samples)`);
  return acc;
}

// --------------------------
// 📊 Dashboard Summary
// --------------------------
export function getMLDashboard() {
  const model = loadJSON(MODEL_FILE, {});
  const acc = loadJSON(HISTORY_FILE, {});
  const fb = loadJSON(FEEDBACK_FILE, { records: [] });
  return {
    modelAge: model.trainedAt || "unknown",
    accuracy: acc.acc || 0,
    samples: fb.records.length,
    lastUpdate: acc.time || "N/A",
  };
}

// --------------------------
// Export
// --------------------------
export default {
  trainModel,
  runMLPrediction,
  recordFeedback,
  calculateAccuracy,
  dailyRetrain,
  getMLDashboard,
};