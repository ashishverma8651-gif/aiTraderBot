// 🤖 AI Trader Bot v8.5 — Smart Pro Mode
//--------------------------------------------------------------
import fetch from "node-fetch";
import express from "express";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID");
  process.exit(1);
}

function getIndiaTime() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

async function sendMessage(text) {
  const chunks = text.match(/[\s\S]{1,3900}/g) || [];
  for (const chunk of chunks) {
    await fetch(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: chunk, parse_mode: "HTML" }),
    });
    await new Promise((r) => setTimeout(r, 800));
  }
}

// 🧩 Proxy Fallback
const proxies = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?",
];

async function fetchData(symbol, tf = "5m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
  for (const proxy of proxies) {
    try {
      const r = await fetch(proxy + encodeURIComponent(url));
      if (!r.ok) throw new Error(`Proxy ${proxy} failed`);
      const j = await r.json();
      return j.map((k) => ({
        o: +k[1],
        h: +k[2],
        l: +k[3],
        c: +k[4],
        v: +k[5],
      }));
    } catch {
      continue;
    }
  }
  throw new Error("All proxies failed");
}

function analyzeTF(data) {
  const last = data.at(-1);
  const prev = data.at(-2);
  const dp = ((last.c - prev.c) / prev.c) * 100;
  const dv = ((last.v - prev.v) / prev.v) * 100;
  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";

  const slope = ((last.c - data[0].c) / data[0].c) * 100;
  const slopeAngle =
    slope > 0.5 ? "Uptrend 📈" : slope < -0.5 ? "Downtrend 📉" : "Flat ➖";

  return { signal, dp: dp.toFixed(2), dv: dv.toFixed(2), slope: slopeAngle };
}

// 📰 News + Sentiment
async function fetchNews() {
  try {
    const url = `https://api.allorigins.win/get?url=${encodeURIComponent("https://cointelegraph.com/rss")}`;
    const r = await fetch(url);
    const j = await r.json();
    const items = j.contents.split("<item>").slice(1, 4);
    const titles = items.map((i) =>
      (i.match(/<title>(.*?)<\/title>/) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "")
    );
    let score = 0;
    for (const t of titles) {
      const l = t.toLowerCase();
      if (l.includes("rise") || l.includes("gain") || l.includes("bull")) score++;
      if (l.includes("fall") || l.includes("drop") || l.includes("bear")) score--;
    }
    const bias = score > 0 ? "Bullish 📰" : score < 0 ? "Bearish 🗞️" : "Neutral ⚖️";
    return { bias, titles };
  } catch {
    return { bias: "Neutral ⚖️", titles: ["No news fetched"] };
  }
}

// 🎯 Targets & Breakout
function getTargets(price, bias) {
  const move = price * 0.004;
  if (bias.includes("Bullish"))
    return {
      tp1: (price + move).toFixed(2),
      tp2: (price + move * 2).toFixed(2),
      tp3: (price + move * 3).toFixed(2),
      sl: (price - move).toFixed(2),
      zone: `${(price - move * 0.5).toFixed(2)} - ${(price + move * 0.5).toFixed(2)}`,
    };
  if (bias.includes("Bearish"))
    return {
      tp1: (price - move).toFixed(2),
      tp2: (price - move * 2).toFixed(2),
      tp3: (price - move * 3).toFixed(2),
      sl: (price + move).toFixed(2),
      zone: `${(price - move * 0.5).toFixed(2)} - ${(price + move * 0.5).toFixed(2)}`,
    };
  return { tp1: "N/A", tp2: "N/A", tp3: "N/A", sl: "N/A", zone: "N/A" };
}

// 📊 Accuracy tracker
const KEY = "ai_pred_acc";
function storePrediction(ok) {
  const arr = JSON.parse(process.env[KEY] || "[]");
  arr.push(ok ? 1 : 0);
  if (arr.length > 10) arr.shift();
  process.env[KEY] = JSON.stringify(arr);
}
function getAccuracy() {
  const arr = JSON.parse(process.env[KEY] || "[]");
  if (!arr.length) return "N/A";
  const pct = (arr.reduce((a, b) => a + b, 0) / arr.length) * 100;
  return pct.toFixed(1) + "%";
}

// 🧠 Analyzer
async function analyzeAndReport() {
  try {
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const news = await fetchNews();

    let report = `🤖 <b>${SYMBOL} — AI Trader v8.5</b>\n🕒 ${getIndiaTime()}\n\n`;
    let bull = 0, bear = 0, lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf);
      const a = analyzeTF(data);
      lastPrice = data.at(-1).c;
      report += `⏱ ${tf} | ${a.signal} | ΔP ${a.dp}% | ΔV ${a.dv}% | ${a.slope}\n`;
      if (a.signal.includes("Bullish")) bull++;
      if (a.signal.includes("Bearish")) bear++;
    }

    const bias = bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const conf = ((Math.abs(bull - bear) / tfs.length) * 100).toFixed(2);
    const { tp1, tp2, tp3, sl, zone } = getTargets(lastPrice, bias);
    const acc = getAccuracy();

    report += `\n🎯 Targets:\nTP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}\nSL: ${sl}\n📊 Breakout Range: ${zone}\n\n`;
    report += `🧠 Overall Bias: ${bias} | Confidence: ${conf}%\n💰 Last Price: ${lastPrice}\n📈 Accuracy (Last10): ${acc}\n📰 News Sentiment: ${news.bias}\n\n🧾 Headlines:\n${news.titles.map(t => "• " + t).join("\n")}\n`;

    if (conf > 70 && news.bias.includes(bias.includes("Bullish") ? "Bullish" : "Bearish")) {
      report += `\n🚨 Smart Alert: Strong ${bias.includes("Bullish") ? "BUY" : "SELL"} confirmation (${conf}%)`;
    }

    await sendMessage(report);
    console.log("✅ Telegram Report Sent", getIndiaTime());
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// 🧾 Help Command
async function handleHelp() {
  const msg = `
📘 <b>AI Trader Bot — Help Menu</b>

Commands:
/help → Show this help message
/now → Force run analysis instantly
/status → Show current accuracy + sentiment
/tf → List timeframes used

ℹ️ Updates every ${CHECK_INTERVAL_MIN} minutes automatically.
`;
  await sendMessage(msg);
}

// 🌐 Express Server
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.send("✅ AI Trader v8.5 Running"));
app.post(`/webhook`, async (req, res) => {
  const text = req.body?.message?.text || "";
  if (text === "/help") await handleHelp();
  else if (text === "/now") await analyzeAndReport();
  else if (text === "/status") await sendMessage(`Current Accuracy: ${getAccuracy()}`);
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log("🌍 Server active"));

// ⏳ Schedule
console.log("🤖 AI Trader v8.5 Online...");
analyzeAndReport();
setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);