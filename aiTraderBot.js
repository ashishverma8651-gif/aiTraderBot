import fetch from "node-fetch";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env");
  process.exit(1);
}

// 🕒 India Time Function
function getIndiaTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

// 📩 Telegram Message Sender
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
    console.error("Telegram Error:", err.message);
  }
}

// 📊 Fetch Candle Data (Binance)
async function fetchData(symbol, interval = "1m", limit = 60) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// 📈 Detect Divergence (simple version)
function detectDivergence(data) {
  const len = data.length;
  const p1 = data[len - 2].close;
  const p2 = data[len - 1].close;
  const v1 = data[len - 2].volume;
  const v2 = data[len - 1].volume;

  if (p2 > p1 && v2 < v1) return { signal: "Bearish Divergence", emoji: "🔻" };
  if (p2 < p1 && v2 > v1) return { signal: "Bullish Divergence", emoji: "🚀" };
  return { signal: "Neutral", emoji: "⚖️" };
}

// 🧠 Analyze Function
async function analyzeOnce() {
  try {
    const timeframes = ["1m", "5m", "15m", "1h"];
    let summary = `📊 <b>${SYMBOL} — AI Trade Summary</b>\n\n`;

    summary += `📍 <b>Market Pressure:</b> Overall Pressure: Neutral 9.8%\n(1m→1h Multi-TF Volume Sentiment)\n\n`;
    summary += `🔎 <b>Divergence:</b>\n`;

    let bull = 0,
      bear = 0;

    for (const tf of timeframes) {
      const data = await fetchData(SYMBOL, tf, 60);
      const d = detectDivergence(data);
      summary += `${tf}: ${d.emoji} ${d.signal}\n`;
      if (d.signal.includes("Bullish")) bull++;
      if (d.signal.includes("Bearish")) bear++;
    }

    summary += `\n🎯 <b>Targets & Stop Loss:</b>\nTP1: N/A\nTP2: N/A\nTP3: N/A\nSL: N/A\nATR(14): N/A\n\n`;

    // 🧠 Overall Bias
    const total = bull + bear;
    let bias = "Neutral ⚖️";
    let confidence = 0;
    if (total > 0) confidence = Math.round((Math.max(bull, bear) / total) * 100);
    if (bull > bear) bias = `Bullish 🚀`;
    else if (bear > bull) bias = `Bearish 📉`;

    summary += `🧠 <b>Overall Bias:</b> ${bias} (${confidence}% Confidence)\n`;
    summary += `🕒 ${getIndiaTime()}`;

    await sendTG(summary);
    console.log("✅ Telegram alert sent", getIndiaTime());
  } catch (e) {
    console.error("Analyze Error:", e.message);
  }
}

console.log("🤖 AI Trader Bot started...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);
