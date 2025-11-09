// ======================================================
// ML MODULE v8.6 — Lightweight Online Logistic Regression
// ======================================================

import fs from "fs/promises";

let MODEL = null;
let MODEL_PATH = "./ml_model.json";

export function defaultModel() {
  return {
    version: "v1",
    weights: { bias: 0, techDiff: 0, volSpike: 0, dojiHammer: 0 },
    lr: 0.05,
    history: [],
    threshold: 0.7,
    meta: { created: Date.now() }
  };
}

export async function loadModelSafe(path = MODEL_PATH) {
  try {
    const raw = await fs.readFile(path, "utf-8");
    MODEL = JSON.parse(raw);
    console.log("✅ Loaded ML model");
  } catch {
    MODEL = defaultModel();
    console.log("⚙️ Created new ML model");
  }
  return MODEL;
}

export async function saveModelSafe(path = MODEL_PATH) {
  try {
    await fs.writeFile(path, JSON.stringify(MODEL, null, 2));
  } catch (e) {
    console.warn("⚠️ Failed to save model:", e.message);
  }
}

export function predictProb(features = {}) {
  if (!MODEL) MODEL = defaultModel();
  const w = MODEL.weights;
  const z =
    w.bias +
    Object.keys(features).reduce((sum, k) => sum + (w[k] || 0) * features[k], 0);
  return 1 / (1 + Math.exp(-z));
}

export function onlineTrain(features, label) {
  if (!MODEL) MODEL = defaultModel();
  const pred = predictProb(features);
  const err = label - pred;
  for (const key of Object.keys(MODEL.weights)) {
    if (key in features) MODEL.weights[key] += MODEL.lr * err * features[key];
  }
  MODEL.weights.bias += MODEL.lr * err;
  MODEL.history.push({ pred, label, time: Date.now() });
  if (MODEL.history.length > 200) MODEL.history.shift();
}

export function autoTuneThreshold(targetPrecision = 0.7) {
  const hist = MODEL.history;
  if (hist.length < 50) return MODEL.threshold;
  let best = MODEL.threshold;
  let bestScore = 0;

  for (let t = 0.3; t <= 0.95; t += 0.01) {
    const preds = hist.filter(h => h.pred >= t);
    const tp = preds.filter(p => p.label === 1).length;
    const prec = preds.length ? tp / preds.length : 0;
    const coverage = preds.length / hist.length;
    const score =
      (prec >= targetPrecision ? 1 : prec / targetPrecision) *
      (0.6 * prec + 0.4 * coverage);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  MODEL.threshold = best;
  return best;
}

export function adjustAutoThreshold() {
  if (!MODEL) MODEL = defaultModel();
  if (MODEL.history.length > 80) autoTuneThreshold(0.7);
  return MODEL.threshold;
}

export function initModel(path = MODEL_PATH) {
  MODEL_PATH = path;
  if (!MODEL) MODEL = defaultModel();
  return MODEL;
}