// ✅ AI Trader v8.1 — Smart Alerts + Help Menu + Live Query Mode
// ----------------------------------------------------------

import fetch from "node-fetch";
import express from "express";
import "dotenv/config";

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

// 📊 Binance Fetch
async function fetchData(symbol, interval = "1m", limit = 60) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  for (const proxy of proxies) {
    try {
      const finalUrl = proxy + encodeURIComponent(url);
      const res = await fetch(finalUrl, { timeout: 10000 });
      if (!res.ok) throw new Error(`Proxy ${proxy} failed`);
      const data = await res.json();
      return data.map((k) => ({
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));
    } catch (err) {
      console.warn(`⚠️ Proxy failed: ${proxy} (${err.message})`);
    }
  }
  throw new Error("❌ All proxies failed");
}

// 📈 Technical Analysis
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
  const move = price * 0.005;
  let tp1, tp2, tp3, sl;
  if (signal.includes("Bullish")) {
    tp1 = (price + move).toFixed(2);
    tp2 = (price + move * 2).toFixed(2);
    tp3 = (price + move * 3).toFixed(2);
    sl = (price - move).toFixed(2);
  } else if (signal.includes("Bearish")) {
    tp1 = (price - move).toFixed(2);
    tp2 = (price - move * 2).toFixed(2);
    tp3 = (price - move * 3).toFixed(2);
    sl = (price + move).toFixed(2);
  } else tp1 = tp2 = tp3 = sl = "N/A";
  return { tp1, tp2, tp3, sl };
}

// 🧠 Main Analyzer
async function analyzeOnce(customTF = null) {
  try {
    const tfs = customTF ? [customTF] : ["1m", "5m", "15m", "30m", "1h"];
    let summary = `🤖 <b>${SYMBOL} — AI Trader v8.1</b>\n🕒 ${getIndiaTime()}\n\n`;

    let bull = 0,
      bear = 0,
      totalStrength = 0,
      lastPrice = 0;

    for (const tf of tfs) {
      const data = await fetchData(SYMBOL, tf, 60);
      const d = analyzeTF(data);
      lastPrice = data[data.length - 1].close;
      summary += `🕓 <b>${tf}</b> | ${d.signal} | ΔP ${d.dp}% | ΔV ${d.dv}% | Strength ${d.strength}%\n`;
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

    summary += `\n🎯 <b>Targets</b>\nTP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}\n\n`;
    summary += `🧠 <b>Overall Bias:</b> ${bias} | Confidence: ${confidence}%\n💰 Last Price: ${lastPrice}`;

    await sendTG(summary);

    if (!customTF && confidence > 65) {
      const alertType = bias.includes("Bullish")
        ? "🚀 Bullish breakout"
        : bias.includes("Bearish")
        ? "⚠️ Bearish breakdown"
        : "";
      if (alertType) await sendTG(`🔔 Smart Alert: ${alertType} (Conf ${confidence}%)`);
    }

    console.log("✅ Report sent:", getIndiaTime());
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
    : "https://ai-trader-v81.onrender.com";
  try {
    const res = await fetch(url);
    if (res.ok) console.log("🔄 Self-ping OK", getIndiaTime());
  } catch {}
}

// 🚀 Start Bot
console.log("🤖 AI Trader v8.1 started...");
analyzeOnce();
setInterval(analyzeOnce, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000);

// 🌐 Express Server
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("✅ AI Trader v8.1 Running"));

// 🧩 Telegram Webhook — Help + Live Query
async function sendHelpMenu() {
  const msg = `
📘 <b>AI Trader v8.1 — Help Menu</b>

Commands:
/help — Show this menu
/check [tf] — Instant analysis (e.g. /check 15m)
/check all — Full multi-timeframe scan
`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🧭 Overview", callback_data: "help_overview" },
        { text: "⚙️ Commands", callback_data: "help_cmds" },
      ],
      [
        { text: "⚡ Smart Alerts", callback_data: "help_alerts" },
        { text: "🎯 Targets", callback_data: "help_targets" },
      ],
    ],
  };

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }),
  });
}

async function handleHelpCallback(data) {
  const textMap = {
    help_overview:
      "🧭 Overview:\nBot analyzes Binance data (1m–1h), finds divergences, predicts bias.",
    help_cmds:
      "⚙️ Commands:\n/check [tf] → Instant check\n/help → Show guide\nAuto mode runs every 15m.",
    help_alerts:
      "⚡ Smart Alerts:\nTriggered when bias >65% confidence. Uses Fibonacci 0.618 for confirmation.",
    help_targets:
      "🎯 Targets:\nTP1–TP3 for profits, SL for safety. Based on direction of main bias.",
  };
  await sendTG(textMap[data] || "❓ Unknown section.");
}

app.post("/webhook", async (req, res) => {
  const msg = req.body.message?.text?.trim();
  if (!msg) return res.sendStatus(200);

  if (msg.startsWith("/help")) await sendHelpMenu();
  else if (msg.startsWith("/check")) {
    const tf = msg.split(" ")[1];
    if (tf === "all") await analyzeOnce();
    else await analyzeOnce(tf || "15m");
  } else if (req.body.callback_query) {
    await handleHelpCallback(req.body.callback_query.data);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🌐 Server active on port", process.env.PORT || 3000)
);