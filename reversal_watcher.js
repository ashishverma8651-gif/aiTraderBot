// simple_reversal_watcher.js
// Ultra simple, clean, accurate reversal detector

import { fetchMultiTF } from "./utils.js";
// ML (v8_6) — stable
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";


let _timer = null;
let _running = false;

// ---------- Pattern Detection ----------
function isBullishEngulfing(prev, cur) {
  return prev.close < prev.open &&
         cur.close > cur.open &&
         cur.open <= prev.close &&
         cur.close >= prev.open;
}
function isBearishEngulfing(prev, cur) {
  return prev.close > prev.open &&
         cur.close < cur.open &&
         cur.open >= prev.close &&
         cur.close <= prev.open;
}
function isHammer(c) {
  const body = Math.abs(c.close - c.open) || 1;
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return lower > body * 1.6 && upper < body * 0.5;
}
function isShootingStar(c) {
  const body = Math.abs(c.close - c.open) || 1;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper > body * 1.6 && lower < body * 0.5;
}

// ---------- Volume Spike ----------
function volumeSpike(candles) {
  if (!candles.length) return 1;
  const last = candles.at(-1).vol ?? candles.at(-1).volume ?? 0;
  const avg = candles.slice(-20).reduce((s, c) => s + (c.vol ?? c.volume ?? 0), 0) / 20;
  return avg ? last / avg : 1;
}

// ---------- Core Logic ----------
async function scan(symbol, sendAlert) {
  try {
    const multi = await fetchMultiTF(symbol, ["1m", "5m", "15m"]);
    const c15 = multi["15m"].data;

    if (c15.length < 2) return;

    const prev = c15.at(-2);
    const cur = c15.at(-1);

    let pattern = null;
    let side = null;

    if (isBullishEngulfing(prev, cur)) {
      pattern = "Bullish Engulfing";
      side = "bull";
    } else if (isBearishEngulfing(prev, cur)) {
      pattern = "Bearish Engulfing";
      side = "bear";
    } else if (isHammer(cur)) {
      pattern = "Hammer";
      side = "bull";
    } else if (isShootingStar(cur)) {
      pattern = "Shooting Star";
      side = "bear";
    }

    if (!pattern) return;

    // Volume check
    const spike = volumeSpike(c15);
    if (spike < 1.2) return; // reject weak volume

    // ML Confirmation (main ML)
    const ml = await runMLPrediction(symbol, "15m");
    const probBull = ml.probBullPercent;
    const probBear = ml.probBearPercent;

    let mlSide = probBull > probBear ? "bull" : "bear";
    const mlProb = Math.max(probBull, probBear);

    // ML final confirmation
    if (mlSide !== side) return;
    if (mlProb < 60) return; // must be strong

    const price = cur.close;

    // ---------- Final OUTPUT ----------
    const msg = [
      `🔥 REVERSAL DETECTED (${side === "bull" ? "Bullish" : "Bearish"})`,
      `Symbol: ${symbol}`,
      `Pattern: ${pattern} (15m)`,
      `Volume: ${spike.toFixed(1)}× spike`,
      `ML: ${mlSide === "bull" ? "Bullish" : "Bearish"} ${mlProb.toFixed(1)}%`,
      `Entry: ${price}`
    ].join("\n");

    await sendAlert(msg);

  } catch (err) {
    console.log("reversal watcher error:", err);
  }
}

// ---------- Public API ----------
export function startSimpleWatcher(symbol, sendAlert, intervalMs = 20000) {
  if (_running) return;
  _running = true;

  _timer = setInterval(() => scan(symbol, sendAlert), intervalMs);
  console.log("Simple Reversal Watcher started for", symbol);
}

export function stopSimpleWatcher() {
  if (_timer) clearInterval(_timer);
  _running = false;
  console.log("Simple Reversal Watcher stopped.");
}