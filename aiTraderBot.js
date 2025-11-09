/**
 * 🤖 AI Trader v8.6+ML — Smart Version
 * - Multi-TF analysis (1m → 1h)
 * - Machine learning inspired smart alerts
 * - Reversal detection (Doji, Hammer, Shooting Star)
 * - Proxy fallback for Binance API
 * - News sentiment, accuracy tracking
 * - 15-min report + standalone ML alerts
 * - Self-ping keepalive for Render
 */

import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID");
  process.exit(1);
}

function getIndiaTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

// 🔄 Telegram sender (chunked)
async function sendTG(text) {
  try {
    const chunks = text.match(/[\s\S]{1,3800}/g) || [];
    for (const c of chunks) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: c, parse_mode: "HTML" }),
      });
    }
  } catch (err) {
    console.error("Telegram Error:", err.message);
  }
}

// 🌍 Proxy-based Binance fetch
async function fetchKlines(symbol = SYMBOL, interval = "1m", limit = 50) {
  const proxies = [
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://thingproxy.freeboard.io/fetch/",
    "https://corsproxy.io/?",
  ];

  const endpoint = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  for (const proxy of proxies) {
    try {
      const url = proxy + encodeURIComponent(endpoint);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Proxy ${proxy} failed (${res.status})`);
      const data = await res.json();
      return data.map((d) => ({
        open: +d[1],
        high: +d[2],
        low: +d[3],
        close: +d[4],
        volume: +d[5],
      }));
    } catch (err) {
      console.warn(`⚠️ Proxy failed: ${proxy} → ${err.message}`);
    }
  }

  console.log("❌ All proxies failed → Binance unreachable");
  return [];
}

// 🧩 Pattern + Sentiment Analysis
function analyzeTF(data) {
  if (data.length < 3) return { signal: "Neutral ⚖️", dp: 0, dv: 0, strength: 0 };
  const last = data.at(-1);
  const prev = data.at(-2);

  const dp = ((last.close - prev.close) / prev.close) * 100;
  const dv = ((last.volume - prev.volume) / prev.volume) * 100;
  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";
  const strength = Math.min(Math.abs(dp) + Math.abs(dv), 100);
  return { signal, dp: dp.toFixed(2), dv: dv.toFixed(2), strength };
}

// 🧠 ML-Inspired Smart Alert
function mlSmartAlert(data) {
  const last = data.at(-1);
  const prev = data.at(-2);
  const body = Math.abs(last.close - last.open);
  const candle = last.high - last.low;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const volumeSpike = last.volume > 1.5 * prev.volume;
  let pattern = null;

  if (candle > 0 && body / candle < 0.2 && volumeSpike)
    pattern = "Doji ✳️ (Potential Reversal)";
  else if (lowerWick > 2 * body && volumeSpike)
    pattern = "Hammer 🪓 (Bullish Reversal)";
  else if (upperWick > 2 * body && volumeSpike)
    pattern = "Shooting Star 🌠 (Bearish Reversal)";

  if (pattern) {
    return `🚨 <b>Smart ML Alert:</b> ${pattern}\nVolume Spike: ${volumeSpike ? "Yes ✅" : "No ❌"}\n🕒 ${getIndiaTime()}`;
  }
  return null;
}

// 🎯 Target Calculation
function getTargets(price, bias) {
  const m = price * 0.005;
  if (bias.includes("Bullish"))
    return {
      tp1: (price + m).toFixed(2),
      tp2: (price + m * 2).toFixed(2),
      tp3: (price + m * 3).toFixed(2),
      sl: (price - m).toFixed(2),
    };
  if (bias.includes("Bearish"))
    return {
      tp1: (price - m).toFixed(2),
      tp2: (price - m * 2).toFixed(2),
      tp3: (price - m * 3).toFixed(2),
      sl: (price + m).toFixed(2),
    };
  return { tp1: "N/A", tp2: "N/A", tp3: "N/A", sl: "N/A" };
}

// 📰 Dummy News Sentiment Fetch
async function fetchNews() {
  try {
    const res = await fetch("https://cryptopanic.com/api/v1/posts/?auth_token=demo&public=true");
    const data = await res.json();
    const headlines = (data.results || []).slice(0, 3).map((n) => `• ${n.title}`).join("\n");
    return headlines || "No news fetched";
  } catch {
    return "News unavailable";
  }
}

// 🔁 Main Analyzer
async function analyzeOnce() {
  try {
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    let report = `🤖 <b>${SYMBOL} — AI Trader v8.6+ML</b>\n🕒 ${getIndiaTime()}\n\n`;
    let bull = 0,
      bear = 0,
      totalStrength = 0,
      lastPrice = 0;

    for (const tf of tfs) {
      const d = await fetchKlines(SYMBOL, tf, 50);
      if (!d.length) continue;
      const a = analyzeTF(d);
      const ml = mlSmartAlert(d);
      if (ml) await sendTG(ml);
      lastPrice = d.at(-1).close;
      report += `⏱ ${tf} | ${a.signal} | ΔP ${a.dp}% | ΔV ${a.dv}% | Strength ${a.strength}%\n`;
      if (a.signal.includes("Bullish")) bull++;
      if (a.signal.includes("Bearish")) bear++;
      totalStrength += a.strength;
    }

    const bias =
      bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const conf = ((totalStrength / (tfs.length * 100)) * 100).toFixed(2);
    const { tp1, tp2, tp3, sl } = getTargets(lastPrice, bias);
    const news = await fetchNews();

    report += `\n🎯 <b>Targets:</b>\nTP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}\n\n`;
    report += `🧠 <b>Overall Bias:</b> ${bias} | Confidence: ${conf}%\n💰 <b>Last Price:</b> ${lastPrice}\n📰 <b>Headlines:</b>\n${news}`;

    await sendTG(report);
    console.log("✅ Report sent", getIndiaTime());
  } catch (e) {
    console.error("Analyze Error:", e.message);
  }
}

// 🔄 Self-Ping (Render Keep-Alive)
async function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL.startsWith("http")
      ? process.env.RENDER_EXTERNAL_URL
      : `https://${process.env.RENDER_EXTERNAL_URL}`
    : "https://ai-trader-bot.onrender.com";
  try {
    const res = await fetch(url);
    console.log("📡 Self-ping:", res.status);
  } catch (err) {
    console.log("⚠️ Self-ping failed:", err.message);
  }
}

// 🚀 Initialize
console.log("⚙️ AI Trader v8.6+ML initialized...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000);

const app = express();
app.get("/", (req, res) => res.send("🤖 AI Trader v8.6+ML Running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Server on 3000"));