// reversal_watcher_v9.js (FINAL)
// Fully compatible with ml_module_v8_6.js

import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";

import { fetchCandleData1m } from "./utils.js";
import { sendTelegram } from "./telegram.js";

// Memory
let lastPending = null;
let lastSignalTime = 0;

// ----------- Trend Detector (SUPER IMPORTANT) ----------- //
function detectTrend(candles) {
  const closes = candles.slice(-20).map(c => c.close);
  const slope = closes.at(-1) - closes[0];
  const pct = slope / closes[0];

  if (pct > 0.003) return "UP";
  if (pct < -0.003) return "DOWN";
  return "FLAT";
}

// ----------- Pattern Detector (Stronger than your old one) ----------- //
function detectReversalPattern(candles) {
  const c = candles.slice(-3);

  const c1 = c[0];
  const c2 = c[1];
  const c3 = c[2];

  const bullEngulf = (c2.close < c2.open) &&
                     (c3.close > c3.open) &&
                     (c3.close > c2.open);

  const bearEngulf = (c2.close > c2.open) &&
                     (c3.close < c3.open) &&
                     (c3.close < c2.open);

  if (bullEngulf) return "Bullish";
  if (bearEngulf) return "Bearish";

  return null;
}

// ----------- VALID REVERSAL FILTERS ----------- //
function allowReversal(pattern, mlLabel, trend) {
  if (!pattern) return false;

  // Trend conflict protection (BIG FIX)
  if (pattern === "Bullish" && trend === "UP") return false;
  if (pattern === "Bearish" && trend === "DOWN") return false;

  // ML conflict protection
  if (mlLabel && mlLabel !== pattern && mlLabel !== "Neutral") return false;

  return true;
}

// ----------- Reversal Watcher Start ----------- //
export async function runReversalWatcher(symbol = "BTCUSDT") {
  try {
    const now = Date.now();

    // TOO FAST LIMITER (NO SPAM)
    if (now - lastSignalTime < 4000) return;

    // 1m candles
    const candles = await fetchCandleData1m(symbol, 30);
    if (!candles || candles.length < 5) return;

    const trend = detectTrend(candles);
    const pattern = detectReversalPattern(candles);

    // ML CALL SAFE
    let ml = await runMLPrediction(symbol);
    if (!ml || ml.error) {
      ml = { label: "Neutral", prob: 0 };
    }

    // Combine
    const ok = allowReversal(pattern, ml.label, trend);

    if (!ok) return; // reject low quality signals

    // Build message
    const price = candles.at(-1).close;

    const msg = 
`⚡ *REVERSAL DETECTED* (${pattern})
Symbol: ${symbol}
Price: ${price}
Trend: ${trend}
Pattern: ${pattern}
MicroML: ${ml.label} (${ml.prob || 0}%)
`;

    lastSignalTime = now;
    lastPending = { id: "pend_" + now };

    await sendTelegram(msg);
  } catch (err) {
    console.log("Watcher error:", err);
  }
}