// ml_module_v9.1.js — Self-Learning Market Prediction Engine
import fs from "fs";
import path from "path";
import * as tf from "@tensorflow/tfjs-node";
import CONFIG from "./config.js";

const MODEL_PATH = path.resolve("./cache/ml_model.json");
const METRICS_PATH = path.resolve("./cache/ml_metrics.json");

let model = null;
let metrics = { total: 0, correct: 0, accuracy: 0 };

// ===========================
// 🔧 Load or Init Model + Metrics
// ===========================
export async function initMLModel(inputSize = 5) {
  try {
    if (fs.existsSync(METRICS_PATH)) {
      metrics = JSON.parse(fs.readFileSync(METRICS_PATH, "utf8"));
    }

    if (fs.existsSync(MODEL_PATH)) {
      model = await tf.loadLayersModel(`file://${MODEL_PATH}`);
      console.log("✅ Loaded trained ML model");
      return model;
    }
  } catch (e) {
    console.warn("⚠️ Model/metrics load failed:", e.message);
  }

  model = tf.sequential({
    layers: [
      tf.layers.dense({ units: 8, activation: "relu", inputShape: [inputSize] }),
      tf.layers.dense({ units: 4, activation: "relu" }),
      tf.layers.dense({ units: 1, activation: "sigmoid" })
    ]
  });

  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: "binaryCrossentropy",
    metrics: ["accuracy"]
  });

  console.log("🆕 New ML model created");
  return model;
}

// ===========================
// 📊 Train on Cached Market Data (1-day)
// ===========================
export async function trainModelFromData(marketData) {
  if (!marketData || marketData.length < 50) return;
  if (!model) await initMLModel();

  const features = [];
  const labels = [];

  for (let i = 20; i < marketData.length - 1; i++) {
    const prev = marketData.slice(i - 20, i);
    const next = marketData[i + 1];
    const closeChange = (next.close - marketData[i].close) / marketData[i].close;

    const feat = extractFeatures(prev);
    features.push(feat);
    labels.push(closeChange > 0 ? 1 : 0);
  }

  const xs = tf.tensor2d(features);
  const ys = tf.tensor2d(labels, [labels.length, 1]);

  console.log(`📈 Training model on ${features.length} samples...`);
  await model.fit(xs, ys, { epochs: 10, batchSize: 32, verbose: 0 });
  await model.save(`file://${MODEL_PATH}`);

  console.log("💾 Model retrained & saved");
}

// ===========================
// 🤖 Predict + Learn from Outcome
// ===========================
export async function runMLPrediction(featureArray, actualChange = null) {
  if (!model) await initMLModel(featureArray.length);

  const input = tf.tensor2d([featureArray]);
  const output = model.predict(input);
  const prob = (await output.data())[0];
  tf.dispose([input, output]);

  let label = "Neutral";
  if (prob > 0.55) label = "Bullish";
  else if (prob < 0.45) label = "Bearish";

  // ✅ Learn from actual result if provided
  if (actualChange !== null) updateAccuracy(prob, actualChange);

  return { prob, label, accuracy: metrics.accuracy };
}

// ===========================
// 🧠 Feature Extractor (RSI + MACD + Volume Trend + Random Regularizer)
// ===========================
function extractFeatures(data) {
  const closeChange = (data[data.length - 1].close - data[0].close) / data[0].close;
  const volChange = (data[data.length - 1].vol - data[0].vol) / (data[0].vol || 1);
  const rsi = calcRSI(data, 14);
  const macd = calcMACD(data, 12, 26, 9);

  return [
    closeChange * 10,
    (rsi - 50) / 50,
    macd.hist / (data[data.length - 1].close || 1),
    volChange,
    Math.random() * 0.2
  ];
}

// ===========================
// 📊 Accuracy Tracker + Save Metrics
// ===========================
function updateAccuracy(prob, actualChange) {
  const predictedUp = prob > 0.5;
  const actualUp = actualChange > 0;

  metrics.total++;
  if (predictedUp === actualUp) metrics.correct++;

  metrics.accuracy = ((metrics.correct / metrics.total) * 100).toFixed(2);

  fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));
  console.log(`🎯 ML Accuracy: ${metrics.accuracy}% (${metrics.correct}/${metrics.total})`);
}

// ===========================
// 🔢 RSI + MACD mini functions
// ===========================
function calcRSI(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

function calcMACD(data, shortP = 12, longP = 26, signalP = 9) {
  if (data.length < longP + signalP) return { hist: 0 };
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    return arr.reduce((acc, v, i) => {
      if (i === 0) return [v.close];
      acc.push(v.close * k + acc[i - 1] * (1 - k));
      return acc;
    }, []);
  };
  const emaShort = ema(data, shortP);
  const emaLong = ema(data, longP);
  const macdLine = emaShort.slice(-signalP).map((v, i) => v - emaLong[i]);
  const signal = ema(macdLine.map(v => ({ close: v })), signalP).pop();
  const hist = macdLine.pop() - signal;
  return { hist };
}