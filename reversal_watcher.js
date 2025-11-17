// reversal_watcher.js — FINAL (ML v8.7 + Elliott Fusion + Anti-Spam)

import { fetchMarketData, fetchMultiTF } from "./utils.js";
import { runMicroPrediction, runMLPrediction, recordPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";

let _interval = null;
let _lastAlertTime = 0;
let _lastSignature = "";
let _send = null;

const WAIT_AFTER_ALERT_MS = 90_000;  // anti-spam
const MIN_CONFIDENCE = 65;

/*---------------------------------------------------------------------------
   Core Pattern Detector (15m / 5m / 1m)
---------------------------------------------------------------------------*/

function detectReversal(candle) {
  if (!candle) return null;
  const { open, close, high, low } = candle;

  const body = Math.abs(close - open);
  const range = high - low;
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;

  // Hammer
  if (lower > body * 2 && upper < body * 0.3)
    return { pattern: "Hammer", side: "Bullish" };

  // Inverted Hammer
  if (upper > body * 2 && lower < body * 0.3)
    return { pattern: "InvertedHammer", side: "Bearish" };

  // Engulfing
  if (close > open && body > range * 0.5)
    return { pattern: "BullishEngulfing", side: "Bullish" };

  if (open > close && body > range * 0.5)
    return { pattern: "BearishEngulfing", side: "Bearish" };

  return null;
}

/*---------------------------------------------------------------------------
   Build Final Alert Message
---------------------------------------------------------------------------*/
function buildAlert({ side, pattern, volSpike, ml, micro, ell, price }) {
  const arrow = side === "Bullish" ? "🟢" : "🔴";

  return (
`${arrow} REVERSAL DETECTED (${side})
Symbol: BTCUSDT
Pattern: ${pattern}
Volume: ${volSpike}× spike
ML: ${ml.label} ${ml.probMaxPercent}%
MicroML: ${micro.label}
Elliott: ${ell.sentiment >= 0 ? "Bullish" : "Bearish"} (${ell.confidence}%)
Entry: ${price}`
  );
}

/*---------------------------------------------------------------------------
   Main Engine
---------------------------------------------------------------------------*/
async function scan(symbol, options) {
  try {
    const now = Date.now();

    // Anti-spam global cooldown
    if (now - _lastAlertTime < 8000) return;

    const tfs = ["1m", "5m", "15m"];
    const multi = await fetchMultiTF(symbol, tfs);

    const c1 = multi["1m"]?.data?.at(-1);
    const c5 = multi["5m"]?.data?.at(-1);
    const c15 = multi["15m"]?.data?.at(-1);
    if (!c1 || !c5 || !c15) return;

    // Volume spike
    const vols15 = multi["15m"].data.slice(-20);
    const lastVol = vols15.at(-1).vol || 0;
    const avgVol = vols15.slice(0, -1).reduce((s, x) => s + (x.vol || 0), 0) / Math.max(1, vols15.length - 1);
    const volSpike = avgVol ? (lastVol / avgVol).toFixed(2) : "1.0";

    // Pattern (15m priority → 5m → 1m)
    const pt15 = detectReversal(c15);
    const pt5 = detectReversal(c5);
    const pt1 = detectReversal(c1);

    const finalPattern = pt15 || pt5 || pt1;
    if (!finalPattern) return;

    const side = finalPattern.side;
    const pattern = finalPattern.pattern;

    // Elliott sentiment (extra confirmation)
    let ell = { sentiment: 0, confidence: 0 };
    try {
      const ellRes = await analyzeElliott(multi["15m"].data);
      if (ellRes?.ok) ell = { sentiment: ellRes.sentiment, confidence: ellRes.confidence };
    } catch {}

    // ML (main)
    const ml = await runMLPrediction(symbol, "15m");
    if (!ml || ml.error) return;

    if (ml.probMaxPercent < MIN_CONFIDENCE) return;

    // MicroML
    const micro = await runMicroPrediction(symbol, 60);

    // Elliott gating (optional)
    if (ell.confidence > 40) {
      if (side === "Bullish" && ell.sentiment < 0) return;
      if (side === "Bearish" && ell.sentiment > 0) return;
    }

    const price = multi["15m"].price || 0;

    // Deduplication by signature
    const signature = `${side}_${pattern}_${ml.label}_${Math.floor(price)}`;
    if (signature === _lastSignature) return;
    _lastSignature = signature;

    // Anti-spam after alert
    if (now - _lastAlertTime < WAIT_AFTER_ALERT_MS) return;
    _lastAlertTime = now;

    const msg = buildAlert({ side, pattern, volSpike, ml, micro, ell, price });

    // Store prediction for learning
    await recordPrediction({
      symbol,
      label: side,
      ml,
      micro,
      ell,
      price,
      pattern,
      confidence: ml.probMaxPercent
    });

    // Send
    if (_send) await _send(msg);

  } catch (err) {
    console.log("scan error:", err.message);
  }
}

/*---------------------------------------------------------------------------
   Start / Stop API
---------------------------------------------------------------------------*/
export function startReversalWatcher(symbol, opts, sendFunc) {
  stopReversalWatcher();

  _send = sendFunc;
  const interval = opts.pollIntervalMs || 20000;

  console.log("⚡ Reversal Watcher started");

  _interval = setInterval(() => scan(symbol, opts), interval);
  setTimeout(() => scan(symbol, opts), 3000); // first run
}

export function stopReversalWatcher() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}