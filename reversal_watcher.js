// reversal_watcher.js — FINAL V3 (ML v8.6 + MicroML + Pattern + Feedback)

import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// ========================================
// INTERNAL STATE
// ========================================
let ACTIVE = false;
let intervalId = null;

const lastAlert = {
  bull: 0,
  bear: 0
};

function now() {
  return new Date().toLocaleString("en-IN", { hour12: true });
}

// ========================================
// SIMPLE PATTERN SCANNER
// ========================================
function candlePattern(c) {
  if (!c) return "none";

  const body = Math.abs(c.close - c.open);
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);

  if (body < (c.high - c.low) * 0.25 && lower > body * 1.5)
    return "hammer";

  if (body < (c.high - c.low) * 0.25 && upper > body * 1.5)
    return "shooting_star";

  if (c.close > c.open)
    return "bull";

  if (c.close < c.open)
    return "bear";

  return "none";
}

// ========================================
// TF SCORING
// ========================================
function tfScore(tfCandles) {
  try {
    const rsi = indicators.computeRSI(tfCandles) || 50;
    const macd = indicators.computeMACD(tfCandles)?.hist || 0;

    const p = tfCandles.at(-1);
    const prev = tfCandles.at(-2);

    const trend =
      p.close > prev.close ? 1 :
      p.close < prev.close ? -1 : 0;

    const pattern = candlePattern(tfCandles.at(-1));
    let pattScore = 0;
    if (pattern === "hammer") pattScore = +0.5;
    if (pattern === "shooting_star") pattScore = -0.5;

    return (
      ((rsi - 50) / 50) * 0.4 +
      Math.tanh(macd) * 0.4 +
      trend * 0.2 +
      pattScore
    );
  } catch {
    return 0;
  }
}

// ========================================
// COMBINE TF SCORES
// ========================================
function combineScores(scores, weights) {
  let s = 0, w = 0;
  for (const tf of Object.keys(scores)) {
    s += scores[tf] * weights[tf];
    w += weights[tf];
  }
  return s / Math.max(1, w);
}

// ========================================
// SHOULD ALERT?
// ========================================
function shouldAlert(type) {
  const nowTs = Date.now();
  const cooldown = 1000 * 60 * 3; // 3 minutes

  if (nowTs - lastAlert[type] < cooldown) return false;

  lastAlert[type] = nowTs;
  return true;
}

// ========================================
// BUILD ALERT MESSAGE
// ========================================
function buildAlert({ dir, price, conf, tfScores, ml, micro }) {
  const emoji = dir === "up" ? "🟢" : "🔴";
  const title = dir === "up" ? "BULLISH REVERSAL" : "BEARISH REVERSAL";

  return `
<b>${emoji} ${title}</b>
Price: <b>${price}</b>
Confidence: <b>${conf}%</b>

<b>TF Scores</b>
1m: ${tfScores["1m"].toFixed(2)}
5m: ${tfScores["5m"].toFixed(2)}
15m: ${tfScores["15m"].toFixed(2)}

<b>ML</b>
Label: ${ml.label}
Prob: ${ml.prob}%

<b>MicroML</b>
Label: ${micro.label}
Prob: ${micro.prob.toFixed(2)}%

⏰ ${now()}
`.trim();
}

// ========================================
// MAIN TICK LOOP
// ========================================
async function tick(symbol, config, send) {
  try {
    const multi = await fetchMultiTF(symbol, config.tfs);

    // Price
    const price = multi["1m"]?.price || multi["1m"]?.data?.at(-1)?.close || 0;

    // Score each TF
    const tfScores = {};
    for (const tf of config.tfs) {
      const c = multi[tf]?.data || [];
      tfScores[tf] = c.length ? tfScore(c) : 0;
    }

    // Combine
    const fused = combineScores(tfScores, config.weights);

    // ML
    const ml = await runMLPrediction(symbol);
    const micro = await runMicroPrediction(symbol);

    // Final confidence weight mix
    const conf =
      Math.min(
        100,
        Math.round(
          (fused * 40) +
          (ml.prob * 0.4) +
          (micro.prob * 0.2)
        )
      );

    // DECISION
    let direction = null;

    if (fused > 0.25 && ml.label === "Bullish" && micro.label === "Bullish")
      direction = "up";

    if (fused < -0.25 && ml.label === "Bearish" && micro.label === "Bearish")
      direction = "down";

    if (!direction) return;

    // Check threshold
    if (conf < config.minAlertConfidence) return;

    // Cooldown
    if (!shouldAlert(direction === "up" ? "bull" : "bear")) return;

    // Build alert
    const msg = buildAlert({
      dir: direction,
      price,
      conf,
      tfScores,
      ml,
      micro
    });

    // Send
    await send(msg);

  } catch (e) {
    console.log("ReversalWatcher TickErr:", e.message);
  }
}

// ========================================
// START / STOP
// ========================================
export async function startReversalWatcher(symbol, config, sendFn) {
  if (ACTIVE) return;
  ACTIVE = true;

  console.log("⚡ Reversal Watcher Started V3");

  intervalId = setInterval(() => {
    tick(symbol, config, sendFn);
  }, config.pollIntervalMs);
}

export async function stopReversalWatcher() {
  if (!ACTIVE) return;

  ACTIVE = false;

  if (intervalId) clearInterval(intervalId);
  intervalId = null;

  console.log("🛑 Reversal Watcher Stopped");
}

export default { startReversalWatcher, stopReversalWatcher };