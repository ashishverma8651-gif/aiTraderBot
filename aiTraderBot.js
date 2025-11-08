// ✅ AI Trader Bot — Final v2 (Fixed Confidence + Targets + Stoploss)
// -------------------------------------------------------------------

import fetch from "node-fetch";
import express from "express";
import "dotenv/config";

// 🔑 Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in environment variables");
  process.exit(1);
}

// 🕒 India Time
function getIndiaTime() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// 📩 Telegram Message
async function sendTG(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML" }),
    });
  } catch (err) {
    console.error("Telegram Error:", err.message);
  }
}

// 📊 Binance Fetch (proxy safe)
async function fetchData(symbol, interval = "1m", limit = 60) {
  const proxy = "https://api.allorigins.win/raw?url=";
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(proxy + encodeURIComponent(url));
  if (!res.ok) throw new Error(`Binance fetch failed ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// 📈 Divergence + Δ Calculation
function analyzeTF(data) {
  const len = data.length;
  const last = data[len - 1];
  const prev = data[len - 2];

  const dp = ((last.close - prev.close) / prev.close) * 100;
  const dv = ((last.volume - prev.volume) / prev.volume) * 100;

  let signal = "Neutral ⚖️";
  let strength = Math.min(Math.abs(dp) + Math.abs(dv), 100);

  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";

  return { signal, dp: dp.toFixed(2), dv: dv.toFixed(2), strength };
}

// 🎯 Target & Stoploss Generator
function getTargetsAndSL(lastPrice, bias) {
  let tp1, tp2, tp3, sl;
  const move = lastPrice * 0.005; // 0.5% base move
  if (bias.includes("Bullish")) {
    tp1 = (lastPrice + move).toFixed(2);
    tp2 = (lastPrice + move * 2).toFixed(2);
    tp3 = (lastPrice + move * 3).toFixed(2);
    sl = (lastPrice - move).toFixed(2);
  } else if (bias.includes("Bearish")) {
    tp1 = (lastPrice - move).toFixed(2);
    tp2 = (lastPrice - move * 2).toFixed(2);
    tp3 = (lastPrice - move * 3).toFixed(2);
    sl = (lastPrice + move).toFixed(2);
  } else {
    tp1 = tp2 = tp3 = sl = "N/A";
  }
  return { tp1, tp2, tp3, sl };
}

// 🧠 Main Analysis Function
async function analyzeOnce() {
  try {
    const tfs = ["1m", "5m", "15m", "1h"];
    let summary = `📊 <b>${SYMBOL} — AI Trade Summary</b>\n\n📍 <b>Market Pressure:</b> Overall Volume Sentiment\n(1m → 1h)\n\n🔎 <b>Divergence:</b>\n`;

    let bull = 0, bear = 0, totalStrength = 0;
    let lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf, 60);
      const d = analyzeTF(data);
      lastPrice = data[data.length - 1].close;
      summary += `${tf}: ${d.signal}\nΔP ${d.dp}% | ΔV ${d.dv}% | Strength ${d.strength.toFixed(1)}%\n\n`;

      if (d.signal.includes("Bullish")) bull++;
      if (d.signal.includes("Bearish")) bear++;
      totalStrength += d.strength;
    }

    // 🧠 Overall Bias
    let bias = "Neutral ⚖️";
    let confidence = (totalStrength / (tfs.length * 100)) * 100;
    confidence = Math.round(confidence * 100) / 100;
    if (bull > bear) bias = "Bullish 🚀";
    else if (bear > bull) bias = "Bearish 📉";

    // 🎯 Targets & Stoploss
    const { tp1, tp2, tp3, sl } = getTargetsAndSL(lastPrice, bias);

    summary += `🎯 <b>Targets & Stop Loss:</b>\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}\nSL: ${sl}\n\n`;
    summary += `🧠 <b>Overall Bias:</b> ${bias} (${confidence}% Confidence)\n`;
    summary += `💰 Last Price: ${lastPrice}\n`;
    summary += `🕒 ${getIndiaTime()}`;

    await sendTG(summary);
    console.log("✅ Telegram Report Sent", getIndiaTime());
  } catch (err) {
    console.error("Analyze Error:", err.message);
  }
}

// 🚀 Run & Schedule
console.log("🤖 AI Trader Bot started...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);

// 🌐 Keep Render Alive
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server active"));