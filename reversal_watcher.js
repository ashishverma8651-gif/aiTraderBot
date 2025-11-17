// reversal_watcher.js — SIMPLE + STABLE VERSION

import { fetchMultiTF } from "./utils.js";
import { runMicroPrediction, runMLPrediction } from "./ml_module_v8_6.js";

let _timer = null;
let _running = false;
let _sendFunc = null;

const TF = "15m";

// ----------- Candle Pattern ------------
function detectReversal(c) {
  if (!c || c.length < 2) return null;

  const prev = c[c.length - 2];
  const cur = c[c.length - 1];

  // Bullish Engulfing
  if (
    prev.close < prev.open &&
    cur.close > cur.open &&
    cur.open <= prev.close &&
    cur.close >= prev.open
  ) {
    return { side: "bull", pattern: "Bullish Engulfing" };
  }

  // Bearish Engulfing
  if (
    prev.close > prev.open &&
    cur.close < cur.open &&
    cur.open >= prev.close &&
    cur.close <= prev.open
  ) {
    return { side: "bear", pattern: "Bearish Engulfing" };
  }

  return null;
}

// ----------- Formatting -------------
function fmtMsg({ side, pattern, volSpike, ml, price, symbol }) {
  const arrow = side === "bull" ? "🔥 REVERSAL DETECTED (Bullish)" : "🔥 REVERSAL DETECTED (Bearish)";

  return (
`${arrow}
Symbol: ${symbol}
Pattern: ${pattern} (${TF})
Volume: ${volSpike.toFixed(1)}× spike
ML: ${ml.label} ${ml.probMaxPercent}%
Entry: ${price}`
  );
}

// ----------- Core Scan -------------
async function scan(symbol) {
  try {
    const multi = await fetchMultiTF(symbol, [TF]);
    const data = multi[TF]?.data || [];
    if (!data.length) return;

    const det = detectReversal(data);
    if (!det) return;

    // volume
    const last = data.at(-1);
    const avg = data.slice(-20).reduce((s, c) => s + (c.vol || c.volume || 0), 0) / 20;
    const volSpike = (last.vol || last.volume || 0) / Math.max(1, avg);

    // ML
    const ml = await runMLPrediction(symbol, TF);

    // build message
    const msg = fmtMsg({
      side: det.side,
      pattern: det.pattern,
      volSpike,
      ml,
      price: last.close,
      symbol
    });

    await _sendFunc(msg);

  } catch (e) {
    console.log("scan error:", e);
  }
}

// ----------- Public Exports -------------
export function startReversalWatcher(symbol, sendFunc, intervalMs = 15000) {
  if (_running) return;

  _running = true;
  _sendFunc = sendFunc;

  _timer = setInterval(() => scan(symbol), intervalMs);

  console.log("Reversal Watcher started");
}

export function stopReversalWatcher() {
  if (_timer) clearInterval(_timer);
  _running = false;
  console.log("Reversal Watcher stopped");
}

export function getWatcherState() {
  return { running: _running };
}