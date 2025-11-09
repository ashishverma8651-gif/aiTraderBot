// 🤖 AI Trader v8.3 — News + Sentiment + Slope Analyzer + Smart Alerts
//--------------------------------------------------------------
import fetch from "node-fetch";
import express from "express";
import "dotenv/config";

// 🔑 ENV setup
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const COMPACT_MODE = true;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing");
  process.exit(1);
}

// 🕒 India Time
function getIndiaTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

// 📩 Telegram
async function sendTG(msg) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: "HTML" }),
  });
}
async function sendLongMessage(msg) {
  const parts = msg.match(/[\s\S]{1,3900}/g) || [];
  for (const part of parts) {
    await sendTG(part);
    await new Promise((r) => setTimeout(r, 800));
  }
}

// 🌍 Proxy Rotation
const proxies = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?",
];

// 📊 Binance Fetch
async function fetchData(symbol, tf = "5m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  for (const p of proxies) {
    try {
      const r = await fetch(p + encodeURIComponent(url));
      if (!r.ok) throw new Error(r.statusText);
      const j = await r.json();
      return j.map((k) => ({
        o: +k[1],
        h: +k[2],
        l: +k[3],
        c: +k[4],
        v: +k[5],
      }));
    } catch (e) {
      console.warn("⚠️ Proxy failed:", p);
    }
  }
  throw new Error("❌ Binance fetch failed");
}

// 🧮 Analyzer
function analyzeTF(data) {
  const len = data.length;
  const last = data[len - 1];
  const prev = data[len - 2];
  const dp = ((last.c - prev.c) / prev.c) * 100;
  const dv = ((last.v - prev.v) / prev.v) * 100;
  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";
  const slope = ((last.c - data[0].c) / data[0].c) * 100;
  const slopeAngle =
    slope > 0.3 ? "Uptrend 📈" : slope < -0.3 ? "Downtrend 📉" : "Flat ➖";
  const strength = Math.min(Math.abs(dp) + Math.abs(dv), 100);
  return { signal, dp: dp.toFixed(2), dv: dv.toFixed(2), slope: slopeAngle, strength };
}

// 📰 News Fetch + Sentiment
async function fetchNewsSentiment() {
  try {
    const url = `https://api.allorigins.win/get?url=${encodeURIComponent(
      "https://cointelegraph.com/rss"
    )}`;
    const r = await fetch(url);
    const j = await r.json();
    const items = j.contents.split("<item>").slice(1, 5);
    const titles = items.map((i) =>
      (i.match(/<title>(.*?)<\/title>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, "")
        .trim()
    );
    let score = 0;
    for (const t of titles) {
      const txt = t.toLowerCase();
      if (txt.includes("rise") || txt.includes("surge") || txt.includes("gain")) score++;
      if (txt.includes("fall") || txt.includes("drop") || txt.includes("crash")) score--;
    }
    const bias = score > 0 ? "Bullish 📰" : score < 0 ? "Bearish 🗞️" : "Neutral ⚖️";
    return { bias, titles };
  } catch {
    return { bias: "Neutral ⚖️", titles: ["News unavailable"] };
  }
}

// 🎯 Target calc
function getTargets(price, bias) {
  let m = price * 0.005;
  if (bias.includes("Bullish")) {
    return {
      tp1: (price + m).toFixed(2),
      tp2: (price + m * 2).toFixed(2),
      tp3: (price + m * 3).toFixed(2),
      sl: (price - m).toFixed(2),
    };
  } else if (bias.includes("Bearish")) {
    return {
      tp1: (price - m).toFixed(2),
      tp2: (price - m * 2).toFixed(2),
      tp3: (price - m * 3).toFixed(2),
      sl: (price + m).toFixed(2),
    };
  }
  return { tp1: "N/A", tp2: "N/A", tp3: "N/A", sl: "N/A" };
}

// 📈 Analyzer & Report
async function analyzeAndReport() {
  try {
    const tfs = COMPACT_MODE ? ["5m", "15m", "1h"] : ["1m", "5m", "15m", "30m", "1h"];
    const news = await fetchNewsSentiment();
    let msg = `🤖 <b>${SYMBOL} — AI Trader v8.3</b>\n🕒 ${getIndiaTime()}\n\n`;
    let bull = 0,
      bear = 0,
      sumStr = 0,
      lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf);
      const a = analyzeTF(data);
      lastPrice = data.at(-1).c;
      msg += `⏱ ${tf} | ${a.signal} | ΔP ${a.dp}% | ΔV ${a.dv}% | ${a.slope} | Strength ${a.strength}%\n`;
      if (a.signal.includes("Bullish")) bull++;
      if (a.signal.includes("Bearish")) bear++;
      sumStr += a.strength;
    }

    const bias = bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const conf = Math.round((sumStr / (tfs.length * 100)) * 10000) / 100;
    const { tp1, tp2, tp3, sl } = getTargets(lastPrice, bias);

    msg += `\n🎯 <b>Targets:</b>\nTP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}\nSL: ${sl}\n`;
    msg += `\n🧠 Bias: ${bias} | Confidence: ${conf}% | Trend: ${
      bull > bear ? "Rising" : bear > bull ? "Falling" : "Mixed"
    }\n💰 Last Price: ${lastPrice}\n\n📰 News Sentiment: ${news.bias}\n`;

    msg += `🧾 Headlines:\n${news.titles.map((t) => "• " + t).join("\n")}\n`;

    // 🔔 Smart Alert
    if (
      conf > 70 &&
      ((bias.includes("Bullish") && news.bias.includes("Bullish")) ||
        (bias.includes("Bearish") && news.bias.includes("Bearish")))
    ) {
      msg += `\n🚨 <b>Smart Alert:</b> Strong ${bias.includes("Bullish") ? "BUY" : "SELL"} setup confirmed (${conf}%)`;
    }

    await sendLongMessage(msg);
    console.log("✅ Sent update", getIndiaTime());
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
}

// 🔄 Self Ping
async function selfPing() {
  const url =
    process.env.RENDER_EXTERNAL_URL ||
    "https://ai-trader-bot.onrender.com";
  try {
    const r = await fetch(url);
    console.log("📡 Ping:", r.status);
  } catch {
    console.warn("Ping fail");
  }
}

// 🌐 Express Server
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader v8.3 Running"));
app.listen(process.env.PORT || 3000, () => console.log("🌍 Web Server Ready"));

// 🚀 Run
console.log("🤖 AI Trader v8.3 Booting...");
analyzeAndReport();
setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000);