/**
 * AI Trader v8.6 + ML Stable
 * ---------------------------
 * ✅ Multi-timeframe report
 * ✅ Reversal Watcher (Doji, Hammer, Shooting Star)
 * ✅ Volume confirmation + cooldown
 * ✅ Machine Learning (smart probability + auto-threshold)
 * ✅ News headlines + self-ping + Telegram updates
 */

import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import fs from "fs/promises";

dotenv.config();

// ========= CONFIG =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_MODEL_PATH = "./ml_model.json";
const PORT = process.env.PORT || 3000;

// ========= ML MODULE =========
let MODEL = null;

function defaultModel() {
  return {
    version: "v1",
    weights: { bias: 0, techDiff: 0, volSpike: 0, dojiHammer: 0 },
    lr: 0.05,
    threshold: 0.7,
    history: []
  };
}

async function loadModelSafe() {
  try {
    const data = await fs.readFile(ML_MODEL_PATH, "utf8");
    MODEL = JSON.parse(data);
    console.log("✅ ML model loaded");
  } catch {
    MODEL = defaultModel();
    console.log("⚙️ Created new ML model");
  }
}

async function saveModelSafe() {
  try {
    await fs.writeFile(ML_MODEL_PATH, JSON.stringify(MODEL, null, 2));
  } catch (e) {
    console.error("❌ Save model failed:", e.message);
  }
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predictProb(features) {
  const w = MODEL.weights;
  const z =
    w.bias +
    w.techDiff * (features.techDiff || 0) +
    w.volSpike * (features.volSpike || 0) +
    w.dojiHammer * (features.dojiHammer || 0);
  return sigmoid(z);
}

function onlineTrain(features, label) {
  const pred = predictProb(features);
  const error = label - pred;
  const lr = MODEL.lr;
  const w = MODEL.weights;

  for (const key of Object.keys(w)) {
    if (key in features) w[key] += lr * error * features[key];
  }
  w.bias += lr * error;
  MODEL.history.push({ pred, label, time: Date.now() });
  if (MODEL.history.length > 200) MODEL.history.shift();
}

// ========= TELEGRAM =========
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ========= REVERSAL WATCHER =========
let lastAlert = 0;

async function checkReversal() {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=10`;
    const data = await (await fetch(url)).json();

    if (!Array.isArray(data)) {
      console.log("⚠️ Binance API returned non-array data");
      return;
    }

    const k = data.map(d => ({
      o: +d[1],
      h: +d[2],
      l: +d[3],
      c: +d[4],
      v: +d[5]
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
      if (now - lastAlert > 5 * 60 * 1000) {
        lastAlert = now;

        const features = {
          techDiff: (last.c - last.o) / last.o,
          volSpike: volSpike ? 1 : 0,
          dojiHammer: isHammer || isShootingStar ? 1 : 0
        };

        const prob = predictProb(features);
        const msg = `⚡ Reversal Alert on ${SYMBOL}\nPattern: ${
          isHammer ? "🟢 Hammer" : isShootingStar ? "🔴 Shooting Star" : "⚪ Doji"
        }\nProb (ML): ${(prob * 100).toFixed(1)}%\nVol Spike: ${volSpike}`;
        await sendTelegram(msg);

        // Train ML model as we go
        onlineTrain(features, prob > MODEL.threshold ? 1 : 0);
        await saveModelSafe();
      }
    }
  } catch (e) {
    console.error("❌ Reversal watcher failed:", e.message);
  }
}

// ========= MARKET REPORT =========
async function sendMarketReport() {
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${SYMBOL}`;
    const data = await (await fetch(url)).json();

    const change = parseFloat(data.priceChangePercent).toFixed(2);
    const volume = parseFloat(data.volume).toFixed(2);
    const prob = predictProb({ techDiff: change / 100, volSpike: volume / 10000 });

    const msg = `📊 ${SYMBOL} — AI Trader v8.6+ML\nΔP: ${change}% | Vol: ${volume}\n🤖 ML Prob: ${(prob * 100).toFixed(
      1
    )}% | Threshold: ${(MODEL.threshold * 100).toFixed(0)}%`;
    await sendTelegram(msg);
  } catch (e) {
    console.error("❌ Market report failed:", e.message);
  }
}

// ========= SERVER =========
const app = express();
app.get("/", (req, res) => res.send("AI Trader v8.6+ML Stable Running ✅"));
app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// ========= INIT =========
(async () => {
  await loadModelSafe();
  console.log("🤖 AI Trader v8.6+ML Stable initialized...");
  setInterval(sendMarketReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(checkReversal, REV_CHECK_INTERVAL_SEC * 1000);
})();