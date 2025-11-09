// AI Trader Bot v7 — Smart Alerts + Weighted Confidence + Accuracy learning
// -----------------------------------------------------------------------
// Save as bot-v7.js, install deps: node-fetch@2, express, dotenv
// npm i node-fetch@2 express dotenv
// Run: BOT_TOKEN=... CHAT_ID=... node bot-v7.js

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import "dotenv/config";

/* --------- Config / Env --------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const DEFAULT_CHAT = process.env.CHAT_ID; // fallback single chat
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const ACC_FILE = "./accuracy.json";
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?",
];
const SELF_PING_URL =
  process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.startsWith("http")
    ? process.env.RENDER_EXTERNAL_URL
    : process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : process.env.SELF_PING_URL || null;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing. Put in .env");
  process.exit(1);
}

/* --------- Utilities --------- */
const nowIndia = () =>
  new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

function safeParseJSON(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, "utf8") || "null") || fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

/* --------- Telegram sender (simple) --------- */
async function sendTG(chatId, text, opts = {}) {
  const target = chatId || DEFAULT_CHAT;
  if (!target) {
    console.warn("No chatId available to send message to.");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target, text, parse_mode: "HTML", ...opts }),
    });
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

/* --------- Data fetchers --------- */
async function fetchKlines(symbol = SYMBOL, interval = "15m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const proxy of PROXIES) {
    try {
      const final = proxy + encodeURIComponent(url);
      const res = await fetch(final, { timeout: 10000 });
      if (!res.ok) throw new Error(`proxy ${proxy} status ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j) || j.length === 0) throw new Error("empty klines");
      return j.map((k) => ({
        time: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));
    } catch (e) {
      // try next proxy
      console.warn("fetchKlines proxy failed:", proxy, e.message);
      continue;
    }
  }
  throw new Error("All proxies failed for klines");
}

async function fetchNews(limit = 5) {
  try {
    const rss = "https://www.coindesk.com/arc/outboundfeeds/rss/";
    const proxy = PROXIES[0] + encodeURIComponent(rss);
    const r = await fetch(proxy);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit + 1);
    return items.map((it) => (it.match(/<title>(.*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, "") || "");
  } catch (e) {
    console.warn("fetchNews fail", e.message);
    return [];
  }
}

/* --------- Analysis primitives --------- */
function fibLevels(klines) {
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const range = high - low || 1;
  return {
    high,
    low,
    fib382: +(high - range * 0.382).toFixed(2),
    fib618: +(high - range * 0.618).toFixed(2),
  };
}

function volumeSentiment(klines) {
  let buy = 0,
    sell = 0;
  for (const k of klines) {
    if (k.close > k.open) buy += k.volume;
    else sell += k.volume;
  }
  const tot = buy + sell || 1;
  const buyPct = (buy / tot) * 100;
  const sellPct = (sell / tot) * 100;
  const bias = buyPct > sellPct ? "Bullish" : buyPct < sellPct ? "Bearish" : "Neutral";
  return { buyPct: +buyPct.toFixed(2), sellPct: +sellPct.toFixed(2), bias };
}

function detectElliott(klines) {
  const closes = klines.map((k) => k.close);
  const slopePct = ((closes.at(-1) - closes[0]) / closes[0]) * 100;
  if (slopePct > 0.6) return { type: "Impulse (likely up)", conf: 75, slope: +slopePct.toFixed(3) };
  if (slopePct < -0.6) return { type: "Correction (ABC?)", conf: 70, slope: +slopePct.toFixed(3) };
  return { type: "Sideways", conf: 40, slope: +slopePct.toFixed(3) };
}

function getTargets(price, bias) {
  const step = price * 0.004; // 0.4%
  if (bias === "Bullish") {
    return { tp1: +(price + step).toFixed(2), tp2: +(price + step * 2).toFixed(2), tp3: +(price + step * 3).toFixed(2), sl: +(price - step).toFixed(2) };
  }
  if (bias === "Bearish") {
    return { tp1: +(price - step).toFixed(2), tp2: +(price - step * 2).toFixed(2), tp3: +(price - step * 3).toFixed(2), sl: +(price + step).toFixed(2) };
  }
  return { tp1: "—", tp2: "—", tp3: "—", sl: "—" };
}

/* --------- Accuracy / Learning --------- */
function loadAccuracy() {
  return safeParseJSON(ACC_FILE, { history: [] });
}
function saveAccuracy(data) {
  saveJSON(ACC_FILE, data);
}
function getAccuracyRate(history = [], lastN = 20) {
  const arr = history.filter((x) => x.correct === true || x.correct === false).slice(-lastN);
  if (!arr.length) return null;
  const wins = arr.filter((x) => x.correct).length;
  return +( (wins / arr.length) * 100 ).toFixed(1);
}

/* --------- Weighted confidence helper --------- */
function weightConfidence(rawPercent, accuracyPercent) {
  // rawPercent in 0-100, accuracyPercent maybe null
  if (accuracyPercent == null) return rawPercent;
  // if accuracy > 60 add boost; if <40 penalize
  if (accuracyPercent >= 65) return Math.min(99, rawPercent * (1 + (accuracyPercent - 60) / 200)); // small boost
  if (accuracyPercent <= 40) return Math.max(1, rawPercent * (0.9 - (40 - accuracyPercent) / 200)); // small penalty
  return rawPercent;
}

/* --------- Smart Alerts --------- */
let lastSentBias = null;

async function smartAlerts(context) {
  // context: { overallBias, weightedConfidence, lastPrice, fib382, fib618, dp, dv, headlines }
  const alerts = [];
  const { overallBias, weightedConfidence, lastPrice, fib382, fib618, dp, dv, headlines } = context;

  // 1) flip detection
  if (lastSentBias && overallBias !== lastSentBias && overallBias !== "Neutral") {
    alerts.push(`🚨 <b>Signal Flip</b>\n${lastSentBias} → ${overallBias}`);
  }

  // 2) confidence thresholds
  if (weightedConfidence >= 80) alerts.push(`💪 <b>High Confidence</b>: ${Math.round(weightedConfidence)}%`);
  else if (weightedConfidence <= 30) alerts.push(`⚠️ <b>Low Confidence</b>: ${Math.round(weightedConfidence)}% — caution`);

  // 3) fib breakout/breakdown
  if (typeof fib618 === "number" && typeof fib382 === "number") {
    if (lastPrice >= fib618) alerts.push(`🚀 <b>Bullish Breakout</b> above Fib 0.618 (${fib618})`);
    else if (lastPrice <= fib382) alerts.push(`📉 <b>Bearish Breakdown</b> below Fib 0.382 (${fib382})`);
    else alerts.push(`🔁 <b>In Fib channel</b> ${fib382} → ${fib618}`);
  }

  // 4) spike alert
  if (Math.abs(dp) >= 2 || Math.abs(dv) >= 50) {
    alerts.push(`⚡ <b>Price/Volume Spike</b> ΔP: ${dp.toFixed(2)}% | ΔV: ${dv.toFixed(2)}%`);
  }

  // 5) news jumpers (simple heuristic)
  const headText = (headlines || []).join(" ");
  if (/ETF|pump|soar|crash|hack|selloff|liquidation/i.test(headText)) alerts.push(`📰 <b>News Alert</b>: Relevant headline detected`);

  // send alerts chunked
  if (alerts.length) {
    const message = `🔔 <b>Smart Alerts</b>\n${alerts.join("\n")}\n\n🕒 ${nowIndia()}`;
    await sendTG(DEFAULT_CHAT, message);
    console.log("Smart Alerts sent:", alerts.join(" | "));
  }

  lastSentBias = overallBias;
}

/* --------- Main analyzer flow --------- */
async function analyzeAndReport() {
  try {
    const timeframes = ["1m", "5m", "15m", "30m", "1h"];
    let bull = 0, bear = 0;
    let rawStrengthSum = 0;
    let lastPrice = null;
    const lines = [];

    for (const tf of timeframes) {
      const kl = await fetchKlines(SYMBOL, tf, 80);
      if (!kl || !kl.length) throw new Error(`No klines for ${tf}`);
      lastPrice = kl.at(-1).close;

      const vol = volumeSentiment(kl);
      const fib = fibLevels(kl);
      const ell = detectElliott(kl);
      const dp = ((kl.at(-1).close - kl.at(-2).close) / kl.at(-2).close) * 100;
      const dv = ((kl.at(-1).volume - kl.at(-2).volume) / kl.at(-2).volume) * 100;
      const strength = Math.min(Math.abs(dp) + Math.abs(dv), 100);

      if (vol.bias === "Bullish") bull++;
      if (vol.bias === "Bearish") bear++;
      rawStrengthSum += strength;

      lines.push({
        tf, bias: vol.bias, buyPct: vol.buyPct, sellPct: vol.sellPct, fib, ell, dp, dv, strength
      });
    }

    // overall
    let overallBias = "Neutral";
    if (bull > bear) overallBias = "Bullish";
    else if (bear > bull) overallBias = "Bearish";

    const rawConfidence = +( (rawStrengthSum / (timeframes.length * 100)) * 100 ).toFixed(2); // 0-100
    // load accuracy and compute accuracy %
    const accStore = loadAccuracy();
    const accRate = getAccuracyRate(accStore.history, 20); // percent or null
    const weightedConf = weightConfidence(rawConfidence, accRate); // adjust by accuracy

    // news headlines
    const news = await fetchNews(5);

    // put together message
    let message = `🤖 <b>${SYMBOL} — AI Trader v7</b>\n🕒 ${nowIndia()}\n\n`;
    lines.forEach(l => {
      message += `⏱ <b>${l.tf}</b> | ${l.bias} | ΔP ${l.dp.toFixed(2)}% | ΔV ${l.dv.toFixed(2)}% | Strength ${Math.round(l.strength)}%\nElliott: ${l.ell.type} (${l.ell.conf}%) | Fib0.618: ${l.fib.fib618}\n\n`;
    });

    const targets = getTargets(lastPrice, overallBias);
    message += `🎯 <b>Targets</b>\nTP1: ${targets.tp1} | TP2: ${targets.tp2} | TP3: ${targets.tp3} | SL: ${targets.sl}\n\n`;
    message += `🧠 <b>Overall Bias:</b> ${overallBias} | Confidence: ${Math.round(weightedConf)}% (raw ${rawConfidence}%)\n🔥 News Impact: ${news.length ? "Some" : "Low"}\n💰 Last Price: ${lastPrice}\n📊 Accuracy (20): ${accRate == null ? "N/A" : accRate + "%"}\n\n`;
    message += `📰 <b>Headlines:</b>\n${news.length ? news.map(n => "• " + n).join("\n") : "No recent headlines"}\n`;

    // send summary
    await sendTG(DEFAULT_CHAT, message);

    // update accuracy store: push last prediction record to be validated next run
    // We'll store latest predicted bias + price; later runs will check movement and mark correct
    const accObj = accStore || { history: [] };
    accObj.history = accObj.history || [];
    // push placeholder with correct=null; evaluate next run using price movement
    accObj.history.push({ timestamp: Date.now(), prediction: overallBias, price: lastPrice, correct: null });
    if (accObj.history.length > 200) accObj.history.shift();
    saveAccuracy(accObj);

    // prepare context for smart alerts:
    const lastLine = lines[lines.length - 1]; // use 1h or last tf
    await smartAlerts({
      overallBias,
      weightedConfidence: weightedConf,
      lastPrice,
      fib382: lastLine.fib.fib382,
      fib618: lastLine.fib.fib618,
      dp: lastLine.dp,
      dv: lastLine.dv,
      headlines: news,
    });

    // evaluate previous prediction accuracy: mark previous record's 'correct' if exists
    // (we can evaluate using change between last two recorded prices)
    try {
      const store = loadAccuracy();
      const hist = store.history || [];
      if (hist.length >= 2) {
        const prev = hist[hist.length - 2];
        const last = hist[hist.length - 1];
        if (prev && prev.correct === null && prev.price && last.price) {
          const actual = last.price > prev.price ? "Bullish" : last.price < prev.price ? "Bearish" : "Neutral";
          prev.correct = prev.prediction === actual;
          // save
          saveAccuracy(store);
        }
      }
    } catch (e) {
      console.warn("accuracy eval error", e.message);
    }

    console.log("Report sent:", nowIndia());
  } catch (err) {
    console.error("analyzeAndReport error:", err.message);
    // send minimal error to chat if you want (commented out to avoid spam)
    // await sendTG(DEFAULT_CHAT, `❌ Bot error: ${err.message}`);
  }
}

/* --------- Self-ping to keep platform awake --------- */
async function selfPing() {
  if (!SELF_PING_URL) return;
  try {
    const r = await fetch(SELF_PING_URL);
    console.log("Self-ping", r.status, nowIndia());
  } catch (e) {
    console.warn("selfPing failed", e.message);
  }
}

/* --------- Start intervals --------- */
console.log("🤖 AI Trader Bot v7 starting...");
analyzeAndReport(); // initial run
setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(selfPing, 3 * 60 * 1000);

/* --------- Express keepalive --------- */
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot v7 running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Web server listening on port", PORT));