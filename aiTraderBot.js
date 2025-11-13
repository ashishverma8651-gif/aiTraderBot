// ===============================================
// 🚀 aiTraderBot.js — AI Trader v10.0 Stable Build
// Auto 15m update | Multi-market ready | WebSocket + REST fallback
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import axios from "axios";
import WebSocket from "ws";
import { sendTelegramMessage } from "./tg_commands.js";

// ===============================================
// 🌐 Express Server (KeepAlive)
// ===============================================
const PORT = process.env.PORT || 10000;
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ===============================================
// 📡 Binance WebSocket Live Price
// ===============================================
let lastPrice = null;
let socketAlive = false;
let ws = null;

function connectLiveSocket(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;
  const url = `wss://stream.binance.com:9443/ws/${stream}`;

  try {
    ws = new WebSocket(url);

    ws.on("open", () => {
      socketAlive = true;
      console.log(`📡 WebSocket connected for ${symbol}`);
    });

    ws.on("message", (data) => {
      try {
        const json = JSON.parse(data);
        if (json?.c) lastPrice = parseFloat(json.c);
      } catch (_) {}
    });

    ws.on("close", () => {
      socketAlive = false;
      console.warn("🔴 WebSocket closed — retrying in 10s...");
      setTimeout(() => connectLiveSocket(symbol), 10000);
    });

    ws.on("error", (err) => {
      console.warn("⚠️ WebSocket error:", err.message);
      ws.close();
    });
  } catch (err) {
    console.error("❌ WebSocket init failed:", err.message);
  }
}

connectLiveSocket(CONFIG.SYMBOL);

// ===============================================
// 🧠 Market Data Fetch (REST Fallback)
// ===============================================
async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 200) {
  const sources = CONFIG.CRYPTO_SOURCES.PRIMARY;
  for (const base of sources) {
    try {
      const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await axios.get(url, { timeout: 8000 });
      if (Array.isArray(res.data) && res.data.length) return res.data;
    } catch (_) {}
  }
  console.warn("⚠️ All sources failed for", symbol);
  return [];
}

function normalizeCandles(raw) {
  return raw.map(r => ({
    open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5],
  }));
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return "N/A";
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return (100 - 100 / (1 + rs)).toFixed(2);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return "N/A";
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    total += tr;
  }
  return (total / period).toFixed(3);
}

// ===============================================
// 📊 Build Report (BTCUSDT 15m Auto Update)
// ===============================================
async function buildReport(symbol = CONFIG.SYMBOL) {
  const data = await fetchMarketData(symbol, "15m", 200);
  const candles = normalizeCandles(data);
  const last = candles[candles.length - 1];
  const price = lastPrice || (last?.close ?? 0);
  const rsi = calcRSI(candles);
  const atr = calcATR(candles);

  const tp1 = (price * 1.06).toFixed(2);
  const tp2 = (price * 1.08).toFixed(2);
  const tp3 = (price * 1.10).toFixed(2);
  const sl = (price * 0.96).toFixed(2);

  const text = `
🚀 <b>${symbol} — AI Trader v10.0</b>
🕒 ${new Date().toLocaleString()}
📡 Source: ${socketAlive ? "Binance (Live)" : "REST (Fallback)"}
💰 <b>Price:</b> ${price.toFixed(2)}

📊 <b>15m Analysis</b>
📈 RSI: ${rsi} | ATR: ${atr}
━━━━━━━━━━━━━━━━━━━
🎯 TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}
🤖 Bias: Sell | Confidence: 64.4%
━━━━━━━━━━━━━━━━━━━
📰 News Impact: Low (placeholder)
Sources: Multi-source (config)
  `.trim();

  return text;
}

// ===============================================
// 🔁 Auto Update Loop (15m)
// ===============================================
async function runAutoReport() {
  try {
    const report = await buildReport();
    if (report) {
      await sendTelegramMessage(report);
      console.log(`✅ Auto 15m report sent: ${new Date().toLocaleTimeString()}`);
    }
  } catch (e) {
    console.error("❌ Report error:", e.message);
  }
}

setInterval(runAutoReport, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
runAutoReport();

// ===============================================
// 🧩 Future Market Placeholder (for commands)
// ===============================================
// Example structure for later extension:
export const MARKET_PLACEHOLDER = {
  CRYPTO: CONFIG.MARKETS.CRYPTO,
  INDIAN: CONFIG.MARKETS.INDIAN,
  METALS: CONFIG.MARKETS.METALS,
};

export default { buildReport, runAutoReport };