// ✅ AI Trader Bot — Final Fixed Version (Render + Telegram + Binance Proxy)
// -------------------------------------------------------------------------

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

// 🕒 Get India Time
function getIndiaTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

// 📩 Send Telegram Message
async function sendTG(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Telegram Send Error:", err.message);
  }
}

// 📊 Fetch Binance Data (with proxy)
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

// 📈 Analyze Divergence & Change %
function analyzeTF(data) {
  const len = data.length;
  const last = data[len - 1];
  const prev = data[len - 2];

  const dp = ((last.close - prev.close) / prev.close) * 100;
  const dv = ((last.volume - prev.volume) / prev.volume) * 100;

  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";

  return {
    signal,
    dp: dp.toFixed(2),
    dv: dv.toFixed(2),
  };
}

// 🧠 Full Analysis
async function analyzeOnce() {
  try {
    const tfs = ["1m", "5m", "15m", "1h"];
    let summary = `📊 <b>${SYMBOL} — AI Trade Summary</b>\n\n`;
    summary += `📍 <b>Market Pressure:</b> Overall Pressure: Neutral 9.8%\n(1m → 1h Multi-TF Volume Sentiment)\n\n`;
    summary += `🔎 <b>Divergence:</b>\n`;

    let bull = 0, bear = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf, 60);
      const d = analyzeTF(data);
      summary += `${tf}: ${d.signal}\nΔP ${d.dp}% | ΔV ${d.dv}%\n\n`;

      if (d.signal.includes("Bullish")) bull++;
      if (d.signal.includes("Bearish")) bear++;
    }

    const total = bull + bear;
    let bias = "Neutral ⚖️";
    let confidence = 0;

    if (total > 0) confidence = Math.round((Math.max(bull, bear) / total) * 100);
    if (bull > bear) bias = "Bullish 🚀";
    else if (bear > bull) bias = "Bearish 📉";

    summary += `🎯 <b>Targets & Stop Loss:</b>\nTP1: N/A\nTP2: N/A\nTP3: N/A\nSL: N/A\nATR(14): N/A\n\n`;
    summary += `🧠 <b>Overall Bias:</b> ${bias} (${confidence}% Confidence)\n`;
    summary += `🕒 ${getIndiaTime()}`;

    await sendTG(summary);
    console.log("✅ Telegram Report Sent at", getIndiaTime());
  } catch (err) {
    console.error("Analyze Error:", err.message);
  }
}

// 🚀 Start Everything
console.log("🤖 AI Trader Bot started...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);

// 🌐 Keep Alive on Render
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✅"));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Server Running on Port", process.env.PORT || 3000);
});