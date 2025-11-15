// reversal_watcher.js
// Standalone Reversal Detector + ML + Sentiment + Telegram Alert + Feedback Tracker

import axios from "axios";
import { fetchMarketData } from "./utils.js";
import CONFIG from "./config.js";
import { getMLScore } from "./ml_module_v8_6.js";
import { getNewsSentimentScore } from "./news_social.js";
import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(CONFIG.TELEGRAM.BOT_TOKEN, { polling: false });

let intervalHandle = null;
let lastSignal = null;     // store last reversal call
let feedbackQueue = [];    // store predictions for later validation

// =============== CORE MATH UTIL ===============
function calcSlope(a, b) {
  if (!a || !b) return 0;
  return (b.close - a.close) / (b.open || a.open || 1);
}

// =============== REVERSAL DETECTOR ===============
function detectReversal(candles) {
  if (!candles || candles.length < 4) return null;

  const c1 = candles[candles.length - 1];
  const c2 = candles[candles.length - 2];
  const c3 = candles[candles.length - 3];

  const s1 = calcSlope(c3, c2);
  const s2 = calcSlope(c2, c1);

  if (s1 < 0 && s2 > 0) {
    return { type: "BULLISH", price: c1.close };
  }
  if (s1 > 0 && s2 < 0) {
    return { type: "BEARISH", price: c1.close };
  }
  return null;
}

// =============== REVERSAL CONFIRMATION ===============
async function buildReversalSignal(symbol, reversal, candles) {
  let mlScore = 0;
  let sentiment = 0;

  try {
    mlScore = await getMLScore(symbol, candles);
  } catch {}

  try {
    sentiment = await getNewsSentimentScore(symbol);
  } catch {}

  const confidence =
    (mlScore * 0.6) +
    (sentiment * 0.4) +
    (reversal.type === "BULLISH" ? 0.3 : -0.3);

  return {
    symbol,
    type: reversal.type,
    price: reversal.price,
    mlScore,
    sentiment,
    confidence: Number(confidence.toFixed(3)),
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
  };
}

// =============== TELEGRAM ALERT ===============
async function sendReversalAlert(report) {
  const emoji = report.type === "BULLISH" ? "🟢" : "🔴";

  const msg = `
${emoji} *REVERSAL DETECTED* ${emoji}
Symbol: *${report.symbol}*
Type: *${report.type}*
Price: *${report.price}*
ML Score: *${report.mlScore}*
News Sentiment: *${report.sentiment}*
Confidence: *${report.confidence}*
Time: ${report.time}
  `.trim();

  try {
    await bot.sendMessage(CONFIG.TELEGRAM.CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

// =============== FEEDBACK ENGINE ===============
async function checkFeedback() {
  if (feedbackQueue.length === 0) return;

  const now = Date.now();

  for (let f of feedbackQueue) {
    if (now - f.ts >= 10 * 60 * 1000) { // 10 min later
      const data = await fetchMarketData(f.symbol, "5m", 3);
      const last = data?.data?.slice(-1)[0];
      if (!last) continue;

      const actual = last.close;
      let result = "❓ Uncertain";

      if (f.type === "BULLISH") {
        result = actual > f.price ? "✅ Correct" : "❌ Wrong";
      }
      if (f.type === "BEARISH") {
        result = actual < f.price ? "✅ Correct" : "❌ Wrong";
      }

      const msg = `
📊 *Reversal Feedback*
Prediction: ${f.type}
Entry Price: ${f.price}
Now: ${actual}
Result: *${result}*
      `.trim();

      try {
        await bot.sendMessage(CONFIG.TELEGRAM.CHAT_ID, msg, { parse_mode: "Markdown" });
      } catch {}

      // remove from queue
      feedbackQueue = feedbackQueue.filter(x => x !== f);
    }
  }
}

// =============== RUNNER ===============
async function pollReversal(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", 50);
    const candles = m15.data;

    if (!candles?.length) return;

    const rev = detectReversal(candles);
    if (!rev) return;

    if (lastSignal && lastSignal.type === rev.type) return; // avoid duplicates
    lastSignal = rev;

    const report = await buildReversalSignal(symbol, rev, candles);

    await sendReversalAlert(report);

    // feedback entry
    feedbackQueue.push({
      symbol,
      type: rev.type,
      price: rev.price,
      ts: Date.now()
    });

  } catch (e) {
    console.log("Reversal Watcher error:", e.message);
  }
}

// =============== START + STOP EXPORTS ===============
export function startReversalWatcher() {
  if (intervalHandle) return;

  intervalHandle = setInterval(pollReversal, 15000); // every 15 sec
  setInterval(checkFeedback, 20000); // feedback check

  console.log("✅ Reversal Watcher started");
}

export function stopReversalWatcher() {
  try {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("🛑 Reversal Watcher stopped");
  } catch {}
}