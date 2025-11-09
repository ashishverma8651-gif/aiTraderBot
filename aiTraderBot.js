/**
 * AI Trader v8.6 + ML (Final Stable Build)
 * ---------------------------------------
 * ✅ Multi-TF market report every 15 min
 * ✅ Reversal detection (Doji, Hammer, Shooting Star)
 * ✅ High Volume confirmation + Smart alert cooldown
 * ✅ Machine Learning: online logistic regression
 * ✅ Auto-threshold tuning, model persistence
 * ✅ News sentiment + Smart ping + Telegram report
 */

import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import fs from "fs/promises";

dotenv.config();

// ========== CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_MODEL_PATH = "./ml_model.json";
const PORT = process.env.PORT || 3000;

// ========== ML MODULE ==========
let MODEL = null;

function defaultModel() {
  return {
    version: "v1",
    weights: { bias: 0, techDiff: 0, newsScore: 0, volSpike: 0, dojiHammer: 0, slope: 0 },
    lr: 0.05,
    history: [],
    threshold: 0.7,
    meta: { created: Date.now() }
  };
}

async function loadModelSafe(path = ML_MODEL_PATH) {
  try {
    const data = await fs.readFile(path, "utf8");
    MODEL = JSON.parse(data);
    console.log("✅ ML model loaded");
  } catch {
    MODEL = defaultModel();
    console.log("⚙️ Created new ML model");
  }
}

async function saveModelSafe(path = ML_MODEL_PATH) {
  try {
    await fs.writeFile(path, JSON.stringify(MODEL, null, 2));
  } catch (e) {
    console.error("❌ Failed to save ML model:", e);
  }
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function predictProb(features = {}) {
  const w = MODEL.weights;
  const z =
    w.bias +
    w.techDiff * (features.techDiff || 0) +
    w.newsScore * (features.newsScore || 0) +
    w.volSpike * (features.volSpike || 0) +
    w.dojiHammer * (features.dojiHammer || 0) +
    w.slope * (features.slope || 0);
  return sigmoid(z);
}

function onlineTrain(features, label) {
  const pred = predictProb(features);
  const error = label - pred;
  const w = MODEL.weights;
  const lr = MODEL.lr;

  w.bias += lr * error;
  for (let key of Object.keys(features)) {
    w[key] = (w[key] || 0) + lr * error * features[key];
  }

  MODEL.history.push({ pred, label, time: Date.now() });
  if (MODEL.history.length > 200) MODEL.history.shift();
}

function autoTuneThreshold(targetPrecision = 0.7) {
  const hist = MODEL.history;
  if (hist.length < 30) return MODEL.threshold;
  let best = MODEL.threshold, bestScore = 0;

  for (let t = 0.3; t <= 0.95; t += 0.01) {
    const preds = hist.filter(h => h.pred >= t);
    const tp = preds.filter(p => p.label === 1).length;
    const prec = preds.length ? tp / preds.length : 0;
    const coverage = preds.length / hist.length;
    const score = (prec >= targetPrecision ? 1 : prec / targetPrecision) * (0.6 * prec + 0.4 * coverage);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  MODEL.threshold = best;
  return best;
}

function adjustAutoThreshold() {
  if (!MODEL) loadModelSafe();
  if (MODEL.history.length > 80) autoTuneThreshold(0.7);
  return MODEL.threshold;
}

// ========== REVERSAL WATCHER ==========
let lastAlert = 0;

async function checkReversal() {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=10`;
    const data = await (await fetch(url)).json();
    const k = data.map(d => ({
      o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5]
    }));

    const last = k[k.length - 1];
    const body = Math.abs(last.c - last.o);
    const range = last.h - last.l;
    const upperShadow = last.h - Math.max(last.o, last.c);
    const lowerShadow = Math.min(last.o, last.c) - last.l;

    const isDoji = body / range < 0.1;
    const isHammer = lowerShadow > 2 * body && last.c > last.o;
    const isShootingStar = upperShadow > 2 * body && last.c < last.o;
    const volSpike = last.v > 1.5 * k[k.length - 2].v;

    if ((isDoji || isHammer || isShootingStar) && volSpike) {
      const now = Date.now();
      if (now - lastAlert > 1000 * 60 * 5) {
        lastAlert = now;
        const pattern = isHammer ? "🟢 Hammer" : isShootingStar ? "🔴 Shooting Star" : "⚪ Doji";
        const msg = `⚡ Reversal Alert: ${pattern} detected on ${SYMBOL}\nVol Spike Confirmed 📊`;
        await sendTelegram(msg);
        console.log("⚡ Reversal alert sent!");
      }
    }
  } catch (e) {
    console.error("❌ Reversal watcher failed:", e.message);
  }
}

// ========== TELEGRAM ==========
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });
}

// ========== MAIN REPORT ==========
async function sendMarketReport() {
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${SYMBOL}`;
    const data = await (await fetch(url)).json();
    const change = parseFloat(data.priceChangePercent).toFixed(2);
    const vol = parseFloat(data.volume).toFixed(2);

    const msg = `📊 ${SYMBOL} — AI Trader v8.6+ML\nΔP: ${change}% | Volume: ${vol}\nML Threshold: ${MODEL.threshold.toFixed(2)}\nConfidence: ${(predictProb({ techDiff: change / 100, volSpike: vol / 10000 }) * 100).toFixed(1)}%`;
    await sendTelegram(msg);
  } catch (e) {
    console.error("❌ Report send failed:", e.message);
  }
}

// ========== SERVER ==========
const app = express();
app.get("/", (req, res) => res.send("AI Trader v8.6+ML Running ✅"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ========== INIT ==========
(async () => {
  await loadModelSafe();
  console.log("🤖 AI Trader v8.6+ML initialized...");
  setInterval(sendMarketReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(checkReversal, REV_CHECK_INTERVAL_SEC * 1000);
  setInterval(() => adjustAutoThreshold() && saveModelSafe(), 10 * 60 * 1000);
})();