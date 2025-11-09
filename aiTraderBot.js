// ==========================================
// 🤖 AI Trader Bot v8.6 + ML (Final Stable)
// ==========================================

import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import {
  initModel,
  predictProb,
  onlineTrain,
  adjustAutoThreshold,
  loadModelSafe,
  saveModelSafe,
  defaultModel
} from "./ml_module_v8_6.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);

let MODEL = null;
let lastAlert = 0;

// ------------------------------------------
// TELEGRAM MESSAGE FUNCTION
// ------------------------------------------
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "Markdown" })
    });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// ------------------------------------------
// BINANCE API (with auto retry)
// ------------------------------------------
async function fetchWithRetry(url, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) return data;
      console.warn("⚠️ Binance returned unexpected data:", data?.code || data);
    } catch (e) {
      console.warn(`⚠️ Fetch failed (attempt ${i + 1}):`, e.message);
    }
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error("❌ Binance API failed after retries");
}

// ------------------------------------------
// REVERSAL WATCHER (pattern + ML prediction)
// ------------------------------------------
async function checkReversal() {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=10`;
    const data = await fetchWithRetry(url);

    if (!Array.isArray(data)) return;

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
        const msg = `⚡ *Reversal Alert on ${SYMBOL}*
Pattern: ${isHammer ? "🟢 Hammer" : isShootingStar ? "🔴 Shooting Star" : "⚪ Doji"}
Volume Spike: ${volSpike}
ML Confidence: ${(prob * 100).toFixed(1)}%
Threshold: ${(MODEL.threshold * 100).toFixed(1)}%`;

        await sendTelegram(msg);

        // train model with feedback
        onlineTrain(features, prob > MODEL.threshold ? 1 : 0);
        await saveModelSafe();
      }
    }
  } catch (e) {
    console.error("❌ Reversal watcher failed:", e.message);
  }
}

// ------------------------------------------
// MAIN REPORT (every 15 min default)
// ------------------------------------------
async function mainReport() {
  await adjustAutoThreshold();
  const msg = `📊 *AI Trader v8.6+ML Active*
Symbol: ${SYMBOL}
Threshold: ${(MODEL.threshold * 100).toFixed(1)}%
ML History: ${MODEL.history.length}`;
  await sendTelegram(msg);
}

// ------------------------------------------
// SERVER INIT
// ------------------------------------------
async function start() {
  MODEL = await loadModelSafe().catch(() => defaultModel());
  if (!MODEL) MODEL = defaultModel();
  console.log("🤖 AI Trader v8.6+ML initialized...");
  await sendTelegram("🤖 AI Trader v8.6+ML initialized...");

  // main cycles
  setInterval(mainReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(checkReversal, REV_CHECK_INTERVAL_SEC * 1000);

  const app = express();
  app.get("/", (req, res) => res.send("AI Trader Bot Running 🚀"));
  app.listen(10000, () => console.log("🌐 Server live on port 10000"));
}

start();