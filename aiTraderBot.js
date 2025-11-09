// ✅ AI Trader Bot v4 — Auto Proxy Rotation + Self-Ping + Telegram Alerts (Render Optimized)
// -----------------------------------------------------------------------------------------

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

// 🌍 Proxy List
const proxies = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?",
];

// 📊 Binance Fetch (Auto Fallback)
async function fetchData(symbol, interval = "1m", limit = 60) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  for (const proxy of proxies) {
    try {
      const finalUrl = proxy + encodeURIComponent(url);
      const res = await fetch(finalUrl, { timeout: 10000 }); // 10s timeout
      if (!res.ok) throw new Error(`Proxy ${proxy} failed ${res.status}`);
      const data = await res.json();
      return data.map((k) => ({
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (err) {
      console.warn(`⚠️ Proxy failed: ${proxy} → ${err.message}`);
      continue;
    }
  }

  throw new Error("❌ All proxies failed — Binance data unavailable");
}

// 📈 Analyze divergence + signal
function analyzeTF(data) {
  const len = data.length;
  const last = data[len - 1];
  const prev = data[len - 2];

  const dp = ((last.close - prev.close) / prev.close) * 100;
  const dv = ((last.volume - prev.volume) / prev.volume) * 100;

  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";

  const strength = Math.min(Math.abs(dp) + Math.abs(dv), 100);
  return { signal, dp: dp.toFixed(2), dv: dv.toFixed(2), strength };
}

// 🎯 Target & SL
function getTargetsAndSL(price, signal) {
  let tp1, tp2, tp3, sl;
  const move = price * 0.005;

  if (signal.includes("Bullish") || signal.includes("Buy")) {
    tp1 = (price + move).toFixed(2);
    tp2 = (price + move * 2).toFixed(2);
    tp3 = (price + move * 3).toFixed(2);
    sl = (price - move).toFixed(2);
  } else if (signal.includes("Bearish") || signal.includes("Sell")) {
    tp1 = (price - move).toFixed(2);
    tp2 = (price - move * 2).toFixed(2);
    tp3 = (price - move * 3).toFixed(2);
    sl = (price + move).toFixed(2);
  } else {
    tp1 = tp2 = tp3 = sl = "N/A";
  }

  return { tp1, tp2, tp3, sl };
}

// 🧠 Analyzer
async function analyzeOnce() {
  try {
    const tfs = ["1m", "5m", "15m", "1h"];
    let summary = `📊 <b>${SYMBOL} — AI Trade Summary</b>\n\n`;
    summary += `📍 <b>Market Pressure:</b> Multi-TF Sentiment\n(1m → 1h)\n\n🔎 <b>Divergence:</b>\n`;

    let bull = 0, bear = 0, totalStrength = 0, lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf, 60);
      const d = analyzeTF(data);
      lastPrice = data[data.length - 1].close;
      summary += `${tf}: ${d.signal}\nΔP ${d.dp}% | ΔV ${d.dv}% | Strength ${d.strength}%\n\n`;

      if (d.signal.includes("Bullish")) bull++;
      if (d.signal.includes("Bearish")) bear++;
      totalStrength += d.strength;
    }

    const total = bull + bear;
    let bias = "Neutral ⚖️";
    if (bull > bear) bias = "Bullish 🚀";
    else if (bear > bull) bias = "Bearish 📉";

    const confidence = Math.round((totalStrength / (tfs.length * 100)) * 10000) / 100;
    const { tp1, tp2, tp3, sl } = getTargetsAndSL(lastPrice, bias);

    summary += `🎯 <b>Targets & Stop Loss:</b>\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}\nSL: ${sl}\n\n`;
    summary += `🧠 <b>Overall Bias:</b> ${bias} (${confidence}% Confidence)\n💰 Last Price: ${lastPrice}\n🕒 ${getIndiaTime()}`;

    await sendTG(summary);
    console.log("✅ Telegram report sent", getIndiaTime());
  } catch (err) {
    console.error("Analyze Error:", err.message);
  }
}

// 🔄 Self-Ping to prevent Render sleep (optimized)
async function selfPing() {
  const url = `https://${process.env.RENDER_EXTERNAL_URL || "ai-trader-bot.onrender.com"}`; // ⚠️ Replace with your actual Render URL
  try {
    const res = await fetch(url);
    if (res.ok) {
      console.log("🔄 Self-ping OK →", getIndiaTime());
    } else {
      console.warn("⚠️ Self-ping got non-OK response:", res.status);
    }
  } catch (err) {
    console.error("⚠️ Self-ping failed:", err.message);
  }
}

// 🚀 Start Everything
console.log("🤖 AI Trader Bot started...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000); // ping every 3 min (safe)

// 🌐 Keep Alive HTTP Server
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✅"));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Web server active on port", process.env.PORT || 3000);
});