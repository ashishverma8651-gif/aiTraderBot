// reversal_watcher.js — Advanced + Lightweight Reversal Watcher
// Uses micro ML signals + candle pattern + micro trend + volume spike

import { runMicroPrediction } from "./ml_module_v8_6.js";
import CONFIG from "./config.js";
import { fetchMarketData, nowLocal } from "./utils.js";

// -------------------
// State
// -------------------
let lastLabel = null;
let lastProb = 0;
let lastAlertTs = 0;

const SYMBOL = CONFIG.SYMBOL || "BTCUSDT";

// Dynamic cooldown:
// Higher confidence = shorter cooldown
function getDynamicCooldown(prob) {
  if (prob >= 70) return 25 * 1000;  // 25s
  if (prob >= 65) return 40 * 1000;
  if (prob >= 60) return 60 * 1000;
  return 90 * 1000;
}

// -------------------
// Candle pattern detection (very lightweight)
// -------------------
function detectCandlePatterns(candle, prev) {
  const result = [];
  if (!candle || !prev) return result;

  const body = Math.abs(candle.close - candle.open);
  const lower = Math.abs((candle.open < candle.close ? candle.open : candle.close) - candle.low);
  const upper = Math.abs(candle.high - (candle.open > candle.close ? candle.open : candle.close));

  if (lower > body * 1.8 && upper < body * 0.5) result.push("Hammer");
  if (upper > body * 1.8 && lower < body * 0.5) result.push("Shooting Star");

  // engulfing
  if (
    candle.close > candle.open &&
    prev.close < prev.open &&
    candle.open < prev.close &&
    candle.close > prev.open
  ) result.push("Bullish Engulfing");

  if (
    candle.close < candle.open &&
    prev.close > prev.open &&
    candle.open > prev.close &&
    candle.close < prev.open
  ) result.push("Bearish Engulfing");

  return result;
}

// -------------------
// Micro trend slope (very light!)
// -------------------
function microSlope(candles) {
  if (!candles || candles.length < 5) return 0;
  const closes = candles.slice(-6).map(c => Number(c.close));
  const slope = closes[5] - closes[0];
  return slope;
}

// -------------------
// Volume spike detection
// -------------------
function detectVolSpike(candles) {
  if (!candles || candles.length < 10) return false;
  const vols = candles.map(c => Number(c.vol || c.volume || 0));
  const avg = vols.slice(0, -1).reduce((a,b)=>a+b,0) / Math.max(1, vols.length - 1);
  return vols.at(-1) > avg * 1.6;
}

// -------------------
// Main reversal logic
// -------------------
function shouldTriggerReversal(oldLabel, newLabel, prob, patterns, slopeValue, volSpike) {
  if (!oldLabel || oldLabel === newLabel) return false;
  if (prob < 58) return false;

  // require at least one confirmation for safety
  if (patterns.length > 0) return true;
  if (volSpike) return true;

  // slope reversing strongly
  if (newLabel === "Bullish" && slopeValue > 0) return true;
  if (newLabel === "Bearish" && slopeValue < 0) return true;

  return false;
}

// -------------------
// Telegram
// -------------------
function sendAlert(msg) {
  try {
    if (CONFIG.TELEGRAM?.sendAlert) {
      CONFIG.TELEGRAM.sendAlert(msg);
    }
  } catch(e) {
    console.warn("Telegram error", e);
  }
}

// -------------------
// Watcher loop
// -------------------
export async function startReversalWatcher() {
  console.log("⚡ Reversal Watcher (Advanced Lightweight) STARTED...");

  setInterval(async () => {
    try {
      const ml = await runMicroPrediction(SYMBOL, "1m", 100);
      if (!ml || ml.error) return;

      const label = ml.label;
      const prob = ml.prob;

      // fetch only 10 candles — extremely lightweight
      const resp = await fetchMarketData(SYMBOL, "1m", 12);
      const candles = resp?.data || [];
      const last = candles.at(-1);
      const prev = candles.at(-2);

      const patterns = detectCandlePatterns(last, prev);
      const slopeValue = microSlope(candles);
      const volSpike = detectVolSpike(candles);

      const cooldown = getDynamicCooldown(prob);
      const now = Date.now();

      if (shouldTriggerReversal(lastLabel, label, prob, patterns, slopeValue, volSpike)) {
        if (now - lastAlertTs > cooldown) {
          const msg =
            `⚡ *Reversal Detected*\n` +
            `Symbol: ${SYMBOL}\n` +
            `Trend: *${lastLabel} → ${label}*\n\n` +
            `📊 Probability: *${prob}%*\n` +
            `📈 Patterns: ${patterns.join(", ") || "None"}\n` +
            `📉 Slope: ${slopeValue.toFixed(2)}\n` +
            `🔥 Volume Spike: ${volSpike ? "Yes" : "No"}\n\n` +
            `⏳ Cooldown: ${cooldown/1000}s\n` +
            `🕒 ${nowLocal()}`;

          sendAlert(msg);
          lastAlertTs = now;
        }
      }

      lastLabel = label;
      lastProb = prob;

    } catch (e) {
      console.warn("Reversal watcher error:", e);
    }
  }, 20 * 1000);  // 20s — safe & lightweight
}

export default { startReversalWatcher };