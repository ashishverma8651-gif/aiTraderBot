// aiTraderBot.js – v8.6 + ML + Binance failover

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
  saveModelSafe
} from "./ml_module_v8_6.js";

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);

// ✅ Binance fallback endpoints
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// pick the first working endpoint
async function fetchWithFailover(path) {
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const res = await fetch(`${base}${path}`);
      if (res.ok) {
        return await res.json();
      }
      console.warn(`⚠️ ${base} returned ${res.status}`);
    } catch (err) {
      console.warn(`⚠️ ${base} unreachable:`, err.message);
    }
  }
  throw new Error("All Binance endpoints failed");
}

// ---------------- MAIN ----------------
const app = express();
const PORT = process.env.PORT || 10000;

let MODEL = await loadModelSafe("./ml_model.json").catch(() => initModel());

async function fetchMarketData(symbol = SYMBOL, interval = "15m") {
  const url = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`;
  const data = await fetchWithFailover(url);
  if (!Array.isArray(data)) throw new Error("Unexpected Binance response");
  return data.map(k => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

async function analyze() {
  try {
    const candles = await fetchMarketData(SYMBOL);
    const last = candles[candles.length - 1];
    const change = ((last.close - last.open) / last.open) * 100;

    const features = {
      techDiff: change,
      volSpike: last.volume,
      slope: last.close - candles[candles.length - 2].close,
    };

    const prob = predictProb(features);
    const threshold = adjustAutoThreshold();
    console.log(`📊 ML Prob=${(prob * 100).toFixed(2)}% | Threshold=${(threshold * 100).toFixed(1)}%`);
  } catch (err) {
    console.error("❌ Analysis failed:", err.message);
  }
}

setInterval(analyze, CHECK_INTERVAL_MIN * 60 * 1000);

app.listen(PORT, () =>
  console.log(`🌍 Server running on port ${PORT} | AI Trader v8.6+ML Stable initialized...`)
);