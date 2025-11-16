// ======================================================
// reversal_watcher.js — FINAL STABLE NON-SPAM EDITION
// ======================================================

import axios from "axios";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";

// STATIC ML IMPORT (BEST + MOST STABLE)
import * as ML from "./ml_module_v8_6.js";

// =============================
// GLOBAL STATE
// =============================
let active = false;
let pollInterval = null;

let lastAlertSide = null;      // bullish / bearish
let lastAlertTime = 0;
let lastConfirmedID = null;
let lastPendingID = null;

const MIN_GAP_MS = 45 * 1000;  // 45 sec anti-spam
const CONFIRM_GAP_MS = 8 * 1000;

// =============================
// Multi-TF Weighted Score
// =============================
function computeScore(tfData, weights) {
  let score = 0;
  for (const tf of Object.keys(weights)) {
    if (!tfData[tf]) continue;
    score += tfData[tf].signal * weights[tf];
  }
  return Math.round(score);
}

// =============================
// Fetch TF Blocks
// =============================
async function getTFBlocks(symbol, tfs, lookback = 100) {
  const out = {};
  for (let tf of tfs) {
    try {
      const d = await fetchMarketData(symbol, tf, lookback);
      out[tf] = {
        candles: d?.data || [],
        price: d?.price || 0,
        signal: detectTFSignal(d?.data || [])
      };
    } catch {
      out[tf] = null;
    }
  }
  return out;
}

// VERY STABLE SIGNAL DETECTOR
function detectTFSignal(candles) {
  if (!candles || candles.length < 5) return 0;

  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const green = c.close > c.open;
  const red = c.close < c.open;

  const bodyRatio = Math.abs(c.close - c.open) / (c.high - c.low + 1);

  if (green && bodyRatio > 0.35 && c.close > prev.close) return +1;
  if (red && bodyRatio > 0.35 && c.close < prev.close) return -1;

  return 0;
}

// =============================
// Main Reversal Detection
// =============================
function detectReversal(score, price, zones) {
  // entry-zone based reversal
  for (const z of zones) {
    if (price >= z.low && price <= z.high) {
      return {
        detected: true,
        side: z.side,
        zone: z,
        reason: "Zone-based entry"
      };
    }
  }

  // score-based reversal
  if (score <= -60) return { detected: true, side: "Bearish", zone: null, reason: "Score Bearish" };
  if (score >= 60) return { detected: true, side: "Bullish", zone: null, reason: "Score Bullish" };

  return { detected: false };
}

// Hardcoded clean zones
function buildZones(tfBlocks) {
  const zones = [];

  const p = tfBlocks["1m"]?.price || 0;
  if (!p) return [];

  zones.push({
    tf: "1m",
    low: p * 0.9965,
    high: p * 1.0035,
    side: "Bearish"
  });

  zones.push({
    tf: "1m",
    low: p * 0.9965,
    high: p * 1.0035,
    side: "Bullish"
  });

  return zones;
}

// =============================
// FORMAT PENDING ALERT
// =============================
function formatPendingAlert(r, price, score, microML, pendingID) {
  return `
⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${r.side}</b>
Symbol: ${CONFIG.SYMBOL}
Zone: ${r.zone ? `${r.zone.tf} ${r.zone.low.toFixed(2)} - ${r.zone.high.toFixed(2)}` : "—"}
Score: ${score}% | Price: ${price}
MicroML: ${microML.label} (${microML.confidence}%)
PendingID: <code>${pendingID}</code>
`;
}

// =============================
// FORMAT CONFIRMED ALERT
// =============================
function formatConfirmAlert(r, price, microML, id) {
  return `
🟢 <b>REVERSAL CONFIRMED</b> — <b>${r.side}</b>
Symbol: ${CONFIG.SYMBOL} | Price: ${price}
MicroML: ${microML.label} (${microML.confidence}%)
ID: <code>${id}</code>
`;
}

// =============================
// START WATCHER
// =============================
export function startReversalWatcher(symbol, opts, onAlert) {
  if (active) return;
  active = true;

  const {
    pollIntervalMs,
    tfs,
    weights,
    microLookback
  } = opts;

  pollInterval = setInterval(async () => {
    try {
      // anti-spam hard cap
      const now = Date.now();
      if (now - lastAlertTime < MIN_GAP_MS) return;

      // FETCH ALL TFS
      const tfBlocks = await getTFBlocks(symbol, tfs, 80);
      const price = tfBlocks["1m"]?.price || 0;

      // SCORE
      const score = computeScore(tfBlocks, weights);

      // MICRO ML
      const microML = ML.runMicroPrediction(tfBlocks["1m"].candles, microLookback);

      // ZONES
      const zones = buildZones(tfBlocks);

      // DETECT
      const result = detectReversal(score, price, zones);
      if (!result.detected) return;

      const side = result.side;

      // block duplicates
      if (lastAlertSide === side && now - lastAlertTime < MIN_GAP_MS) return;

      const pendingID = `pend_${Date.now()}`;
      lastPendingID = pendingID;

      // SEND PENDING ALERT
      await onAlert(formatPendingAlert(result, price.toFixed(2), score, microML, pendingID));

      lastAlertSide = side;
      lastAlertTime = Date.now();

      // CONFIRM AFTER A DELAY
      setTimeout(async () => {
        const newPriceBlock = await fetchMarketData(symbol, "1m", 2);
        const newP = newPriceBlock?.price || price;

        const movedPct = ((newP - price) / price) * 100;

        const ok = (side === "Bullish" && movedPct > 0) ||
                   (side === "Bearish" && movedPct < 0);

        if (!ok) return;

        const confirmID = `conf_${Date.now()}`;

        if (lastConfirmedID === confirmID) return;

        lastConfirmedID = confirmID;

        await onAlert(formatConfirmAlert(result, newP.toFixed(2), microML, confirmID));

      }, CONFIRM_GAP_MS);

    } catch (err) {
      console.log("Watcher error:", err.message);
    }
  }, pollIntervalMs);

  console.log("📡 Reversal Watcher ON");
}

// =============================
// STOP WATCHER
// =============================
export function stopReversalWatcher() {
  active = false;
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}