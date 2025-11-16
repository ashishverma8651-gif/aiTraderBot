// ======================================================
// reversal_watcher.js — FINAL STABLE VERSION
// Fully compatible with aiTraderBot.js
// ======================================================

import { fetchMultiTF, nowLocal } from "./utils.js";
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";   // <-- YOUR ML FILE NAME


// INTERNAL STATE
let _running = false;
let _timer = null;

let _pending = new Map(); // pendingID → object
let _lastSent = new Map(); // symbol → timestamp
let _lastGlobal = 0;

let CONFIG_DEFAULTS = {
  pollIntervalMs: 20000,
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  minAlertConfidence: 65,

  // ML tuning
  microLookback: 60,
  feedbackWindowsSec: [60, 300],

  // rate limit
  maxAlertsPerMinutePerSymbol: 3,
  symbolCooldownSec: 20
};


// UTILS
function genID(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.floor(Math.random() * 99999);
}

function rateLimited(symbol) {
  const now = Date.now();

  // global throttle
  if (now - _lastGlobal < 6000) return true;

  // per symbol throttle
  const last = _lastSent.get(symbol) || 0;
  if (now - last < CONFIG_DEFAULTS.symbolCooldownSec * 1000) return true;

  return false;
}

function markSent(symbol) {
  const now = Date.now();
  _lastGlobal = now;
  _lastSent.set(symbol, now);
}


// ENTRY ZONE BUILDER
function buildEntryZone(tfCandles) {
  const lows = [];
  const highs = [];

  for (const tf of Object.values(tfCandles)) {
    if (!tf.data || !tf.data.length) continue;

    const arr = tf.data.slice(-40);
    const lo = Math.min(...arr.map(c => c.low));
    const hi = Math.max(...arr.map(c => c.high));

    lows.push(lo);
    highs.push(hi);
  }

  if (!lows.length || !highs.length) return null;

  return {
    low: Math.min(...lows),
    high: Math.max(...highs)
  };
}


// ENTRY ZONE ALERT MESSAGE
function formatEntryZone(symbol, zone, price, score) {
  return `🔔 ENTRY ZONE ALERT
Symbol: ${symbol}
Zone: ${zone.low.toFixed(2)} - ${zone.high.toFixed(2)}
Score: ${score}% | Price: ${price}
Instant entry zone touch`;
}


// REVERSAL MESSAGE
function formatPending(symbol, zone, side, score, price, micro) {
  return `⚡ REVERSAL DETECTED (PENDING) — ${side}
Symbol: ${symbol}
Zone: ${zone.low.toFixed(2)} - ${zone.high.toFixed(2)}
Score: ${score}% | Price: ${price}
MicroML: ${micro?.label || "NA"} (${micro?.prob || 0}%)
PendingID: ${genID("pend")}`;
}

function formatConfirmed(symbol, side, price, micro) {
  return `🟢 REVERSAL CONFIRMED — ${side}
Symbol: ${symbol} | Price: ${price}
MicroML: ${micro?.label || "NA"} (${micro?.prob || 0}%)
ID: ${genID("conf")}`;
}


// MAIN LOGIC
async function scan(symbol, USER_CFG, sendFn) {
  const CFG = { ...CONFIG_DEFAULTS, ...USER_CFG };

  const tfs = await fetchMultiTF(symbol, CFG.tfs);
  const price = tfs["1m"]?.price || 0;
  if (!price) return;

  const zone = buildEntryZone(tfs);
  if (!zone) return;

  // compute position inside zone
  const zoneSize = zone.high - zone.low;
  const pos = ((price - zone.low) / zoneSize);
  const score = Math.round(pos * 100);

  // ENTRY ZONE TOUCH
  if (price >= zone.low && price <= zone.high) {

    if (!rateLimited(symbol)) {
      await sendFn(formatEntryZone(symbol, zone, price, score));
      markSent(symbol);
    }
  }

  // Check REVERSAL direction
  let side = null;
  if (price > zone.high) side = "Bullish";   // breakout up
  else if (price < zone.low) side = "Bearish"; // breakout down
  else return;

  const micro = await runMicroPrediction(symbol, CFG.microLookback);
  const microProb = Math.round(micro?.prob || 0);

  const weightedScore = Math.round(
    score * CFG.weights["1m"] +
    score * CFG.weights["5m"] +
    score * CFG.weights["15m"]
  );

  if (weightedScore < CFG.minAlertConfidence) return;

  // CREATE PENDING
  const pendID = genID("pend");
  _pending.set(pendID, {
    id: pendID,
    symbol,
    side,
    createdAt: Date.now(),
    entryZone: zone,
    priceAtTrigger: price,
    micro
  });

  if (!rateLimited(symbol)) {
    await sendFn(formatPending(symbol, zone, side, weightedScore, price, micro));
    markSent(symbol);
  }

  // CONFIRMATION after breakout follows through
  if ((side === "Bullish" && price > zone.high * 1.001) ||
      (side === "Bearish" && price < zone.low * 0.999)) {

    const confMsg = formatConfirmed(symbol, side, price, micro);

    if (!rateLimited(symbol)) {
      await sendFn(confMsg);
      markSent(symbol);
    }

    // ML FEEDBACK
    try {
      await recordPrediction({
        symbol,
        predictedAt: new Date().toISOString(),
        label: side,
        prob: microProb,
        features: micro.features || micro.featureVector
      });
    } catch (e) {}

    try {
      const acc = await calculateAccuracy(symbol, CFG.feedbackWindowsSec);
      console.log("ML Accuracy:", acc);
    } catch (e) {}

    _pending.delete(pendID);
  }
}


// START
export function startReversalWatcher(symbol, cfg, sendFn) {
  if (_running) return;
  _running = true;

  console.log("🚀 Reversal Watcher STARTED");

  _timer = setInterval(() => {
    scan(symbol, cfg, sendFn).catch(e => console.log("RevScan error:", e.message));
  }, (cfg.pollIntervalMs || 20000));
}


// STOP
export function stopReversalWatcher() {
  return new Promise(resolve => {
    if (_timer) clearInterval(_timer);
    _running = false;
    resolve();
  });
}

export default {
  startReversalWatcher,
  stopReversalWatcher
};