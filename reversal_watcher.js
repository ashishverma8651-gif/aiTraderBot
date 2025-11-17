// reversal_watcher.js — FINAL (MACD/RSI Cooldown + Anti-Spam + ML v8.7)

import { fetchMultiTF } from "./utils.js";
import { runMicroPrediction, runMLPrediction, recordPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";

let _interval = null;
let _send = null;

const MIN_CONFIDENCE = 65;
const COOLDOWN_MS = 90_000;

// Market state memory
let _lastState = {
  macdSign: null,
  rsiZone: null,
  lastSwingHigh: null,
  lastSwingLow: null,
  lastAlertTime: 0,
  lastSignature: ""
};

/* ---------------------------------------------------------------------------
    Helper — Determine RSI Zone
--------------------------------------------------------------------------- */
function getRSIZone(rsi) {
  if (rsi > 60) return "HIGH";
  if (rsi < 40) return "LOW";
  if (rsi >= 45 && rsi <= 55) return "MID";
  return "NEUTRAL";
}

/* ---------------------------------------------------------------------------
    Simple Price Swings (small, safe)
--------------------------------------------------------------------------- */
function calculateSwing(candles) {
  const last = candles.slice(-5);
  const highs = last.map(c => c.high);
  const lows = last.map(c => c.low);
  return {
    high: Math.max(...highs),
    low: Math.min(...lows)
  };
}

/* ---------------------------------------------------------------------------
    Pattern Detector
--------------------------------------------------------------------------- */
function detectReversal(c) {
  if (!c) return null;
  const { open, close, high, low } = c;

  const body = Math.abs(close - open);
  const range = high - low;
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;

  if (lower > body * 2 && upper < body * 0.3)
    return { pattern: "Hammer", side: "Bullish" };

  if (upper > body * 2 && lower < body * 0.3)
    return { pattern: "InvertedHammer", side: "Bearish" };

  if (close > open && body > range * 0.5)
    return { pattern: "BullishEngulfing", side: "Bullish" };

  if (open > close && body > range * 0.5)
    return { pattern: "BearishEngulfing", side: "Bearish" };

  return null;
}

/* ---------------------------------------------------------------------------
    MACD & RSI Cool-down Logic (Critical Anti-Spam)
--------------------------------------------------------------------------- */
function allowAlert(macdSign, rsiZone, swing, price) {
  // 1) MACD must change sign after last alert
  if (_lastState.macdSign !== null && macdSign === _lastState.macdSign)
    return false;

  // 2) RSI must cross zone
  if (_lastState.rsiZone !== null && rsiZone === _lastState.rsiZone)
    return false;

  // 3) Price must break last swing (optional but safe)
  if (_lastState.lastSwingHigh && price < _lastState.lastSwingHigh &&
      _lastState.lastSwingLow && price > _lastState.lastSwingLow)
    return false;

  return true;
}

/* ---------------------------------------------------------------------------
    Build Alert Message
--------------------------------------------------------------------------- */
function buildAlert({ side, pattern, volSpike, ml, micro, ell, price }) {
  const emoji = side === "Bullish" ? "🟢" : "🔴";

  return `${emoji} REVERSAL DETECTED (${side})
Pattern: ${pattern}
Volume: ${volSpike}×
ML: ${ml.label} (${ml.probMaxPercent}%)
MicroML: ${micro.label}
Elliott: ${ell.sentiment >= 0 ? "Bullish" : "Bearish"} (${ell.confidence}%)
Entry: ${price}`;
}

/* ---------------------------------------------------------------------------
    SCAN ENGINE
--------------------------------------------------------------------------- */
async function scan(symbol) {
  try {
    const now = Date.now();
    const tf = ["1m", "5m", "15m"];
    const multi = await fetchMultiTF(symbol, tf);

    const c15 = multi["15m"]?.data?.at(-1);
    const candles15 = multi["15m"]?.data || [];
    if (!c15 || candles15.length < 25) return;

    const price = c15.close;

    // Indicators
    const highs = candles15.slice(-10).map(c => c.high);
    const lows = candles15.slice(-10).map(c => c.low);

    // MACD
    const macdHist = (() => {
      try {
        const dif = c15.close - candles15.at(-2).close;
        return dif / Math.max(1, price * 0.01);
      } catch {
        return 0;
      }
    })();
    const macdSign = macdHist >= 0 ? 1 : -1;

    // RSI (simple)
    const gains = [], losses = [];
    for (let i = candles15.length - 14; i < candles15.length; i++) {
      const diff = candles15[i].close - candles15[i - 1].close;
      if (diff > 0) gains.push(diff); else losses.push(Math.abs(diff));
    }
    const avgGain = (gains.reduce((a,b)=>a+b,0)/14) || 1;
    const avgLoss = (losses.reduce((a,b)=>a+b,0)/14) || 1;
    const rsi = 100 - (100 / (1 + avgGain / avgLoss));
    const rsiZone = getRSIZone(rsi);

    // Swing
    const swing = calculateSwing(candles15);

    // Volume spike
    const vols = candles15.slice(-20);
    const lastVol = vols.at(-1).volume || 0;
    const avgVol = vols.slice(0, -1).reduce((s, x) => s + (x.volume || 0), 0) / Math.max(1, vols.length - 1);
    const volSpike = avgVol ? (lastVol / avgVol).toFixed(2) : "1.0";

    // Pattern
    const pt = detectReversal(c15);
    if (!pt) return;

    const side = pt.side;
    const pattern = pt.pattern;

    // ML
    const ml = await runMLPrediction(symbol, "15m");
    if (!ml || ml.error) return;
    if (ml.probMaxPercent < MIN_CONFIDENCE) return;

    // Micro ML
    const micro = await runMicroPrediction(symbol, "1m");

    // Elliott confirmation
    let ell = { sentiment: 0, confidence: 0 };
    try {
      const e15 = await analyzeElliott(candles15);
      if (e15?.ok) ell = e15;
    } catch {}

    // Cool-down gating
    if (!allowAlert(macdSign, rsiZone, swing, price)) return;

    // Global anti-spam
    if (now - _lastState.lastAlertTime < COOLDOWN_MS) return;

    // Dedup
    const signature = `${side}_${pattern}_${Math.floor(price)}`;
    if (_lastState.lastSignature === signature) return;

    // If passed all checks → ALERT
    const msg = buildAlert({ side, pattern, volSpike, ml, micro, ell, price });

    await recordPrediction({
      symbol,
      pattern,
      side,
      price,
      ml,
      micro,
      ell,
      confidence: ml.probMaxPercent,
      time: new Date().toISOString()
    });

    if (_send) await _send(msg);

    // Update memory
    _lastState = {
      macdSign,
      rsiZone,
      lastSwingHigh: swing.high,
      lastSwingLow: swing.low,
      lastAlertTime: now,
      lastSignature: signature
    };

  } catch (err) {
    console.log("Reversal scan error:", err.message);
  }
}

/* ---------------------------------------------------------------------------
    START / STOP
--------------------------------------------------------------------------- */
export function startReversalWatcher(symbol, opts, sendFunc) {
  stopReversalWatcher();
  _send = sendFunc;

  const interval = opts.pollIntervalMs || 20000;

  console.log("⚡ Reversal Watcher Started with Cooldown Filters");

  _interval = setInterval(() => scan(symbol), interval);
  setTimeout(() => scan(symbol), 2000);
}

export function stopReversalWatcher() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}