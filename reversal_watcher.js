// reversal_watcher.js — LIGHTWEIGHT + ML + patterns + feedback safe for Render FREE

import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";
import CONFIG from "./config.js";

let watcherTimer = null;
let lastSignal = null;

// feedback storage (max 3)
let feedbackQueue = [];

// =====================================================
// TELEGRAM SENDER (very lightweight)
// =====================================================
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;

    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// =====================================================
// VERY LIGHT CANDLE PATTERN DETECTOR
// =====================================================
function detectPatterns(c1, c2) {
  const patterns = [];

  const body = Math.abs(c1.close - c1.open);
  const lower = Math.min(c1.open, c1.close) - c1.low;
  const upper = c1.high - Math.max(c1.open, c1.close);

  // Hammer
  if (lower > body * 1.6 && upper < body * 0.4) patterns.push("Hammer");

  // Shooting Star
  if (upper > body * 1.6 && lower < body * 0.4) patterns.push("Shooting Star");

  // Bullish Engulfing
  if (
    c1.close > c1.open &&
    c2.close < c2.open &&
    c1.open <= c2.close &&
    c1.close >= c2.open
  )
    patterns.push("Bullish Engulfing");

  // Bearish Engulfing
  if (
    c1.close < c1.open &&
    c2.close > c2.open &&
    c1.open >= c2.close &&
    c1.close <= c2.open
  )
    patterns.push("Bearish Engulfing");

  return patterns;
}

// =====================================================
// FEEDBACK CHECK (very small memory usage)
// =====================================================
async function checkFeedback(symbol) {
  if (feedbackQueue.length === 0) return;

  try {
    const mk = await fetchMarketData(symbol, "1m", 2);
    const cd = mk.data || [];
    if (cd.length < 2) return;

    const last = cd[1].close;
    const prev = cd[0].close;
    const move = ((last - prev) / prev) * 100;

    for (const f of feedbackQueue) {
      const correct = f.type === "Bullish" ? move > 0 : move < 0;

      await sendTelegram(
        `📊 *Reversal Feedback*\n` +
          `Signal: *${f.type}*\n` +
          `Accuracy: *${correct ? "Correct ✅" : "Wrong ❌"}*\n` +
          `Move: *${move.toFixed(3)}%*`
      );
    }

    // purge queue
    feedbackQueue = [];
  } catch (e) {
    console.log("Feedback error:", e.message);
  }
}

// =====================================================
// MAIN WATCHER (SUPER OPTIMIZED)
// =====================================================
export function startReversalWatcher(symbol = CONFIG.SYMBOL, opts = {}) {
  if (watcherTimer) clearInterval(watcherTimer);

  const pollMs = opts.pollIntervalMs || 15000;
  const lookback = opts.microLookback || 40;          // reduced from 60 → faster & lighter
  const minProb = opts.minProb || 58;

  watcherTimer = setInterval(async () => {
    try {
      // -------------------------------------
      // 1) ML Prediction (Single API call)
      // -------------------------------------
      const pred = await runMicroPrediction(symbol, "1m", lookback);
      if (!pred || pred.error) return;

      const type = pred.label;
      const prob = pred.prob;

      if (prob < minProb) return; // skip weak signals

      // -------------------------------------
      // 2) Fetch ONLY 2 candles (lightweight)
      // -------------------------------------
      const mk = await fetchMarketData(symbol, "1m", 3);
      const cd = mk.data || [];

      if (cd.length < 2) return;

      const c1 = cd[cd.length - 1];
      const c2 = cd[cd.length - 2];

      // pattern match
      const patterns = detectPatterns(c1, c2);
      if (patterns.length === 0) return;

      // -------------------------------------
      // 3) Confirm reversal
      // -------------------------------------
      let signal = null;

      if (
        type === "Bullish" &&
        (patterns.includes("Hammer") || patterns.includes("Bullish Engulfing"))
      ) {
        signal = "Bullish Reversal";
      }

      if (
        type === "Bearish" &&
        (patterns.includes("Shooting Star") ||
          patterns.includes("Bearish Engulfing"))
      ) {
        signal = "Bearish Reversal";
      }

      if (!signal || signal === lastSignal) return;

      lastSignal = signal;

      // Store feedback (max 3 items)
      feedbackQueue.push({
        type: signal.includes("Bullish") ? "Bullish" : "Bearish",
        time: Date.now()
      });
      if (feedbackQueue.length > 3) feedbackQueue.shift();

      // -------------------------------------
      // 4) Send Telegram Alert
      // -------------------------------------
      await sendTelegram(
        `⚡ *${signal} Detected*\n` +
          `Symbol: *${symbol}*\n` +
          `ML: *${prob}%*\n` +
          `Patterns: *${patterns.join(", ")}*`
      );

      // -------------------------------------
      // 5) Check feedback after alert
      // -------------------------------------
      checkFeedback(symbol);
    } catch (e) {
      console.log("Reversal watcher error:", e.message);
    }
  }, pollMs);

  console.log(`🔎 Reversal Watcher STARTED (${pollMs}ms, lightweight mode)`);
}

// =====================================================
// STOP WATCHER
// =====================================================
export function stopReversalWatcher() {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = null;
  console.log("🛑 Reversal Watcher STOPPED");
}