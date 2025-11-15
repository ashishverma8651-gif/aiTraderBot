// reversal_watcher.js — FINAL FULL VERSION (ML + patterns + volatility + feedback)

import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";
import CONFIG from "./config.js";

let watcherTimer = null;
let lastSignal = null;
let feedbackQueue = []; // store predictions for later feedback checks

// -------------------------------------------
// SEND TELEGRAM
// -------------------------------------------
async function sendTelegram(msg) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;
    const botApi = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;

    await fetch(botApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// -------------------------------------------
// CANDLE PATTERN DETECTION
// -------------------------------------------
function detectPatterns(c1, c2) {
  const body = Math.abs(c1.close - c1.open);
  const lower = Math.abs(Math.min(c1.open, c1.close) - c1.low);
  const upper = Math.abs(c1.high - Math.max(c1.open, c1.close));

  const patterns = [];

  if (lower > body * 1.8 && upper < body * 0.5)
    patterns.push("Hammer");

  if (upper > body * 1.8 && lower < body * 0.5)
    patterns.push("Shooting Star");

  if (
    c1.close > c1.open &&
    c2.close < c2.open &&
    c1.open < c2.close &&
    c1.close > c2.open
  )
    patterns.push("Bullish Engulfing");

  if (
    c1.close < c1.open &&
    c2.close > c2.open &&
    c1.open > c2.close &&
    c1.close < c2.open
  )
    patterns.push("Bearish Engulfing");

  return patterns;
}

// -------------------------------------------
// FEEDBACK CHECKER (after reversal alert)
// -------------------------------------------
async function checkFeedback(symbol) {
  try {
    if (feedbackQueue.length === 0) return;

    const ctx = await fetchMarketData(symbol, "1m", 3);
    const data = ctx.data || [];
    if (data.length < 2) return;

    const last = data.at(-1).close;
    const prev = data.at(-2).close;

    const ret = ((last - prev) / prev) * 100;

    for (const f of feedbackQueue) {
      const correct = f.type === "Bullish" ? ret > 0 : ret < 0;
      await sendTelegram(
        `📊 *Reversal Feedback*\nSignal: *${f.type}*\nResult: *${
          correct ? "Correct ✅" : "Wrong ❌"
        }*\nMove: *${ret.toFixed(3)}%*`
      );
    }

    feedbackQueue = [];
  } catch (_) {}
}

// -------------------------------------------
// MAIN REVERSAL WATCHER
// -------------------------------------------
export function startReversalWatcher(symbol = CONFIG.SYMBOL, opts = {}) {
  const pollMs = opts.pollIntervalMs || 15000;
  const lookback = opts.microLookback || 60;
  const minProb = opts.minProb || 58;

  if (watcherTimer) clearInterval(watcherTimer);

  watcherTimer = setInterval(async () => {
    try {
      // ---------------------------
      // ML PREDICTION
      // ---------------------------
      const pred = await runMicroPrediction(symbol, "1m", lookback);
      if (!pred || pred.error) return;

      const prob = pred.prob;
      const type = pred.label;

      // ---------------------------
      // GET LAST 2 CANDLES
      // ---------------------------
      const mk = await fetchMarketData(symbol, "1m", 3);
      const cd = mk.data || [];

      if (cd.length < 2) return;

      const c1 = cd.at(-1);
      const c2 = cd.at(-2);

      // patterns
      const patterns = detectPatterns(c1, c2);

      let finalSignal = null;

      // ---------------------------
      // REVERSAL CONDITIONS
      // ---------------------------
      if (type === "Bullish" && prob >= minProb) {
        if (
          patterns.includes("Hammer") ||
          patterns.includes("Bullish Engulfing")
        ) {
          finalSignal = "Bullish Reversal";
        }
      }

      if (type === "Bearish" && prob >= minProb) {
        if (
          patterns.includes("Shooting Star") ||
          patterns.includes("Bearish Engulfing")
        ) {
          finalSignal = "Bearish Reversal";
        }
      }

      // Noise filter — avoid repeated alerts
      if (finalSignal && finalSignal !== lastSignal) {
        lastSignal = finalSignal;

        // push to feedback queue
        feedbackQueue.push({
          ts: Date.now(),
          type: finalSignal.includes("Bullish") ? "Bullish" : "Bearish"
        });

        // send alert
        await sendTelegram(
          `⚡ *${finalSignal} Detected*\nSymbol: *${symbol}*\nML: *${prob}%*\nPatterns: *${patterns.join(
            ", "
          ) || "None"}*`
        );
      }

      // perform feedback check
      checkFeedback(symbol);
    } catch (e) {
      console.log("Watcher error:", e.message);
    }
  }, pollMs);

  console.log(
    `🔎 Reversal Watcher STARTED for ${symbol} (interval ${pollMs}ms)`
  );
}

// -------------------------------------------
// STOP WATCHER
// -------------------------------------------
export function stopReversalWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  console.log("🛑 Reversal Watcher STOPPED");
}