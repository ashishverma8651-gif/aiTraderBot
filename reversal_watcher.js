// reversal_watcher.js — FINAL NO-ENTRY-ZONE VERSION
//--------------------------------------------------

import { fetchMarketData } from "./utils.js";
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";  // EXACT ML MODULE

//--------------------------------------------------
// INTERNAL STATE
//--------------------------------------------------
let _running = false;
let _loop = null;

let _pending = new Map();          // pendingID → object
let _lastAlertTime = 0;
let _rateLimitGlobal = 6;          // seconds

//--------------------------------------------------
// HELPERS
//--------------------------------------------------

function nowIST() {
  return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
}

function rateLimited() {
  return (Date.now() - _lastAlertTime) < _rateLimitGlobal * 1000;
}

function send(onAlert, msg) {
  if (typeof onAlert === "function") onAlert(msg);
}

//--------------------------------------------------
// MAIN DETECTION LOGIC
//--------------------------------------------------

async function analyze(symbol, cfg, onAlert) {

  const m = await fetchMarketData(symbol, "1m", 60);
  const f = await fetchMarketData(symbol, "5m", 60);
  const t = await fetchMarketData(symbol, "15m", 60);

  const price = m.price;

  if (!m.data.length || !f.data.length || !t.data.length) return;

  // basic directional score
  const dir1 = m.price > m.data[m.data.length - 2].close ? 1 : -1;
  const dir5 = f.price > f.data[f.data.length - 2].close ? 1 : -1;
  const dir15 = t.price > t.data[t.data.length - 2].close ? 1 : -1;

  const score =
    dir1 * cfg.weights["1m"] +
    dir5 * cfg.weights["5m"] +
    dir15 * cfg.weights["15m"];

  let direction = score > 0 ? "Bullish" : "Bearish";
  let absScore = Math.round(Math.abs(score) * 100);

  // MICRO ML
  const micro = await runMicroPrediction(symbol, { price, tf: "1m" });
  const ml = await runMLPrediction(symbol, { price });

  const microProb = Math.round((micro?.prob || 0) * 100);
  const mlProb = Math.round((ml?.prob || 0) * 100);

  // FEEDBACK ACCURACY
  const acc1 = await calculateAccuracy(symbol, 60);
  const acc5 = await calculateAccuracy(symbol, 300);

  // ------------------------------------------------------
  // TRIGGER PENDING REVERSAL
  // ------------------------------------------------------
  if (absScore >= cfg.minAlertConfidence) {
    const id = "pend_" + Date.now();
    _pending.set(id, {
      id,
      symbol,
      direction,
      createdAt: Date.now(),
      price,
      score: absScore,
      microProb,
      mlProb,
      acc1,
      acc5
    });

    if (!rateLimited()) {
      _lastAlertTime = Date.now();

      send(onAlert,
`⚡ <b>REVERSAL DETECTED — Pending</b>
Symbol: ${symbol}
Direction: <b>${direction}</b>
Price: ${price}

Score: ${absScore}%
Micro-ML: ${microProb}%
Historical Accuracy (1m/5m): ${acc1}% / ${acc5}%

Pending ID: <code>${id}</code>
⏳ Waiting for confirmation…`);
    }
  }

  // ------------------------------------------------------
  // CONFIRMATION CHECK
  // ------------------------------------------------------
  for (const [pid, p] of _pending.entries()) {
    if (Date.now() - p.createdAt < 8000) continue;

    // confirmation rule
    if (p.microProb >= cfg.confirmThreshold || p.mlProb >= cfg.confirmThreshold) {

      _pending.delete(pid);

      if (!rateLimited()) {
        _lastAlertTime = Date.now();

        const cid = "conf_" + Date.now();

        send(onAlert,
`${p.direction === "Bullish" ? "🟢" : "🔴"} <b>REVERSAL CONFIRMED — ${p.direction}</b>
Symbol: ${symbol}
Entry Price: ${p.price}

Strength Score: ${p.score}%
Micro-ML: ${p.microProb}%
Signal Reliability: ${Math.round((p.acc1 + p.acc5) / 2)}%

ID: <code>${cid}</code>`);

      }
    }
  }

}

//--------------------------------------------------
// START / STOP
//--------------------------------------------------

export function startReversalWatcher(symbol, cfg = {}, onAlert) {
  if (_running) return;

  const config = {
    pollIntervalMs: cfg.pollIntervalMs || 20000,
    tfs: cfg.tfs || ["1m", "5m", "15m"],
    weights: cfg.weights || { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
    minAlertConfidence: cfg.minAlertConfidence || 65,
    confirmThreshold: cfg.confirmThreshold || 70
  };

  console.log("🔥 Reversal Watcher STARTED for", symbol, "CFG:", config);

  _running = true;

  _loop = setInterval(() => {
    analyze(symbol, config, onAlert);
  }, config.pollIntervalMs);
}

export function stopReversalWatcher() {
  if (!_running) return;
  _running = false;
  if (_loop) clearInterval(_loop);
  _loop = null;
  console.log("🛑 Reversal Watcher STOPPED");
}