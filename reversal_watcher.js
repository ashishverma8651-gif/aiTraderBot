// reversal_watcher.js
// Standalone Reversal Watcher + ML v16 + News + Feedback Loop + Telegram Alerts

import fs from "fs";
import path from "path";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { runMicroPrediction } from "./ml_module_v8_6.js";

const FEEDBACK_STORE = path.resolve("./cache/reversal_feedback.json");
if (!fs.existsSync(FEEDBACK_STORE)) fs.writeFileSync(FEEDBACK_STORE, JSON.stringify({ signals: [] }, null, 2));

// -----------------------------
// Telegram Sender
// -----------------------------
async function sendTelegram(msg) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    });
  } catch (e) {
    console.log("Telegram Send Error:", e.message);
  }
}

// -----------------------------
// Pattern Detection (Strong Only)
// -----------------------------
function detectReversalPatterns(data) {
  if (!data || data.length < 3) return [];

  const p1 = data[data.length - 3];
  const p2 = data[data.length - 2];
  const p3 = data[data.length - 1];

  const patterns = [];

  // Hammers
  const body3 = Math.abs(p3.close - p3.open);
  const lowerWick3 = Math.abs(Math.min(p3.open, p3.close) - p3.low);
  const upperWick3 = Math.abs(p3.high - Math.max(p3.open, p3.close));
  if (lowerWick3 > body3 * 1.8 && upperWick3 < body3 * 0.5) {
    patterns.push("Hammer");
  }

  // Shooting Star
  if (upperWick3 > body3 * 1.8 && lowerWick3 < body3 * 0.5) {
    patterns.push("Shooting Star");
  }

  // Engulfing
  if (p3.close > p3.open && p2.close < p2.open && p3.open < p2.close && p3.close > p2.open) {
    patterns.push("Bullish Engulfing");
  }
  if (p3.close < p3.open && p2.close > p2.open && p3.open > p2.close && p3.close < p2.open) {
    patterns.push("Bearish Engulfing");
  }

  return patterns;
}

// -----------------------------
// Save Signal for Feedback
// -----------------------------
function saveSignal(data) {
  const store = JSON.parse(fs.readFileSync(FEEDBACK_STORE, "utf8"));
  store.signals.push(data);
  fs.writeFileSync(FEEDBACK_STORE, JSON.stringify(store, null, 2));
}

// -----------------------------
// Feedback Evaluator
// -----------------------------
async function checkFeedback(symbol) {
  const store = JSON.parse(fs.readFileSync(FEEDBACK_STORE, "utf8"));
  let updated = false;

  for (const s of store.signals) {
    if (s.checked) continue;

    const candles = await fetchMarketData(symbol, "15m", 10);
    const last = candles?.data?.at(-1)?.close ?? null;

    if (!last) continue;
    if (Date.now() - s.ts < 15 * 60 * 1000 * 2) continue; // wait 2 candles

    let correct = false;
    const ret = (last - s.price) / s.price;

    if (s.direction === "Bullish" && ret > 0) correct = true;
    if (s.direction === "Bearish" && ret < 0) correct = true;

    s.checked = true;
    s.correct = correct;
    s.realized = ret;

    const emoji = correct ? "✅" : "❌";

    await sendTelegram(
      `${emoji} <b>Reversal Feedback</b>\n` +
      `Pattern: <b>${s.pattern}</b>\n` +
      `Direction: ${s.direction}\n` +
      `Actual Return: <b>${(ret * 100).toFixed(2)}%</b>`
    );

    updated = true;
  }

  if (updated) {
    fs.writeFileSync(FEEDBACK_STORE, JSON.stringify(store, null, 2));
  }
}

// -----------------------------
// Main Loop
// -----------------------------
export async function runReversalWatcher(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", 50);
    const candles = m15?.data || [];
    if (candles.length < 30) return;

    const price = candles.at(-1).close;

    const patterns = detectReversalPatterns(candles);
    if (!patterns.length) {
      await checkFeedback(symbol);
      return;
    }

    const ml = await runMicroPrediction(symbol);

    const dir = ml.label;
    const prob = ml.prob;

    const msg =
      `🚨 <b>Reversal Watcher Alert</b>\n` +
      `Pattern: <b>${patterns.join(", ")}</b>\n` +
      `Direction: <b>${dir}</b>\n` +
      `ML Prob: <b>${prob}%</b>\n` +
      `Price: <b>${price}</b>`;

    await sendTelegram(msg);

    saveSignal({
      ts: Date.now(),
      symbol,
      pattern: patterns.join(","),
      direction: dir,
      prob,
      price,
      checked: false
    });

    await checkFeedback(symbol);

  } catch (e) {
    console.log("Reversal Watcher Err:", e.message);
  }
}

// Run every 1 minute
setInterval(() => runReversalWatcher(CONFIG.SYMBOL), 60 * 1000);

console.log("🔄 Reversal Watcher Started…");