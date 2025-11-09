// ✅ AI Trader Bot v6 — Self-Learning Accuracy + Fibonacci + Elliott + News + Confidence + Proxy + Ping
// -----------------------------------------------------------------------------------------------------

import fetch from "node-fetch";
import express from "express";
import "dotenv/config";
import fs from "fs";

// 🔑 Environment
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const ACC_FILE = "./accuracy.json"; // store accuracy data

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID in .env");
  process.exit(1);
}

// 🕒 India Time
const getIndiaTime = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

// 🧠 Accuracy Storage Helpers
function loadAcc() {
  try {
    const data = JSON.parse(fs.readFileSync(ACC_FILE, "utf8"));
    return data;
  } catch {
    return { history: [] };
  }
}
function saveAcc(data) {
  fs.writeFileSync(ACC_FILE, JSON.stringify(data, null, 2));
}

// 📩 Telegram Send
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
async function fetchData(symbol, interval = "1m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const proxy of proxies) {
    try {
      const finalUrl = proxy + encodeURIComponent(url);
      const res = await fetch(finalUrl, { timeout: 10000 });
      if (!res.ok) throw new Error(`Proxy ${proxy} failed ${res.status}`);
      const data = await res.json();
      return data.map((k) => ({
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));
    } catch (err) {
      console.warn(`⚠️ Proxy failed: ${proxy} → ${err.message}`);
    }
  }
  throw new Error("❌ All proxies failed — Binance data unavailable");
}

// 📰 Free News Fetch (CoinDesk RSS)
async function fetchNews(limit = 5) {
  try {
    const rss = "https://www.coindesk.com/arc/outboundfeeds/rss/";
    const proxy = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(rss);
    const res = await fetch(proxy);
    const txt = await res.text();
    const items = txt.split("<item>").slice(1, limit + 1);
    return items.map((i) => (i.match(/<title>(.*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "") || "");
  } catch {
    return [];
  }
}

// 🧮 Fibonacci Levels
function fibLevels(data) {
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const range = high - low;
  return {
    fib618: (high - range * 0.618).toFixed(2),
    fib382: (high - range * 0.382).toFixed(2),
  };
}

// 📈 Volume Sentiment
function volumeSentiment(data) {
  let buyVol = 0,
    sellVol = 0;
  data.forEach((d) => {
    if (d.close > d.open) buyVol += d.volume;
    else sellVol += d.volume;
  });
  const buyPct = (buyVol / (buyVol + sellVol)) * 100;
  const sellPct = 100 - buyPct;
  const bias = buyPct > sellPct ? "Bullish 🚀" : buyPct < sellPct ? "Bearish 📉" : "Neutral ⚖️";
  return { buyPct, sellPct, bias };
}

// 📉 Elliott Trend
function detectElliott(data) {
  const closes = data.map((d) => d.close);
  const slope = ((closes.at(-1) - closes[0]) / closes[0]) * 100;
  let type = "Sideways";
  let conf = 40;
  if (slope > 0.5) {
    type = "Impulse Wave (5W)";
    conf = 75;
  } else if (slope < -0.5) {
    type = "Corrective ABC";
    conf = 70;
  }
  return { type, conf, slope: slope.toFixed(3) };
}

// 🎯 Targets & SL
function getTargets(price, bias) {
  const move = price * 0.004;
  let TP1, TP2, TP3, SL;
  if (bias.includes("Bullish")) {
    TP1 = (price + move).toFixed(2);
    TP2 = (price + move * 2).toFixed(2);
    TP3 = (price + move * 3).toFixed(2);
    SL = (price - move).toFixed(2);
  } else if (bias.includes("Bearish")) {
    TP1 = (price - move).toFixed(2);
    TP2 = (price - move * 2).toFixed(2);
    TP3 = (price - move * 3).toFixed(2);
    SL = (price + move).toFixed(2);
  } else {
    TP1 = TP2 = TP3 = SL = "—";
  }
  return { TP1, TP2, TP3, SL };
}

// 🧠 Main Analyzer
async function analyzeOnce() {
  try {
    const tfs = ["1m", "5m", "15m", "1h"];
    let summary = `🤖 <b>${SYMBOL} — AI Market Summary (v6)</b>\n🕒 ${getIndiaTime()}\n\n`;
    let bull = 0,
      bear = 0,
      confidence = 0,
      lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf, 80);
      lastPrice = data.at(-1).close;
      const vol = volumeSentiment(data);
      const fib = fibLevels(data);
      const ell = detectElliott(data);
      const dp = ((data.at(-1).close - data.at(-2).close) / data.at(-2).close) * 100;
      const dv = ((data.at(-1).volume - data.at(-2).volume) / data.at(-2).volume) * 100;
      const str = Math.min(Math.abs(dp) + Math.abs(dv), 100).toFixed(1);

      if (vol.bias.includes("Bullish")) bull++;
      if (vol.bias.includes("Bearish")) bear++;
      confidence += parseFloat(str);

      summary += `⏱ <b>${tf}</b> | ${vol.bias}\nΔP: ${dp.toFixed(2)}% | ΔV: ${dv.toFixed(2)}% | Fib(0.618): ${fib.fib618}\nElliott: ${ell.type} (${ell.conf}%) | Strength: ${str}%\n\n`;
    }

    const overall = bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const avgConf = (confidence / (tfs.length * 100) * 100).toFixed(2);
    const { TP1, TP2, TP3, SL } = getTargets(lastPrice, overall);
    const news = await fetchNews();
    const impact = news.length > 0 ? (news.some((n) => /ETF|Pump|Crash|Rate/i.test(n)) ? "High" : "Moderate") : "Low";

    // Accuracy learning
    const accData = loadAcc();
    const prev = accData.history.at(-1);
    if (prev && prev.prediction) {
      const direction = lastPrice > prev.price ? "Bullish 🚀" : lastPrice < prev.price ? "Bearish 📉" : "Neutral ⚖️";
      const correct = prev.prediction === direction;
      accData.history.push({ prediction: overall, price: lastPrice, correct });
    } else {
      accData.history.push({ prediction: overall, price: lastPrice, correct: null });
    }
    if (accData.history.length > 20) accData.history.shift();
    saveAcc(accData);
    const accRate =
      accData.history.filter((x) => x.correct === true).length /
      Math.max(1, accData.history.filter((x) => x.correct !== null).length);

    // Telegram summary
    summary += `🎯 <b>Targets</b>\nTP1: ${TP1} | TP2: ${TP2} | TP3: ${TP3} | SL: ${SL}\n\n`;
    summary += `🧠 <b>Overall Bias:</b> ${overall}\n📈 Confidence: ${avgConf}%\n🔥 News Impact: ${impact}\n💰 Last Price: ${lastPrice}\n📊 Accuracy (20 trades): ${(accRate * 100).toFixed(1)}%\n\n`;
    summary += `📰 <b>Headlines:</b>\n${news.slice(0, 3).map((n) => "• " + n).join("\n")}`;

    await sendTG(summary);
    console.log("✅ Report sent", getIndiaTime());
  } catch (err) {
    console.error("Analyze Error:", err.message);
  }
}

// 🔄 Self-Ping
async function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL.startsWith("http")
      ? process.env.RENDER_EXTERNAL_URL
      : `https://${process.env.RENDER_EXTERNAL_URL}`
    : "https://ai-trader-bot.onrender.com";
  try {
    const res = await fetch(url);
    console.log("🔁 Self-ping", res.status, getIndiaTime());
  } catch (err) {
    console.warn("Ping failed:", err.message);
  }
}

// 🚀 Start
console.log("🤖 AI Trader Bot v6 running...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000);

// 🌐 Express Server
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot v6 running ✅"));
app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Web server active on port", process.env.PORT || 3000)
);