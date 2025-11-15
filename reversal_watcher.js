// reversal_watcher.js — Option D (Multi-TF Reversal Watcher + ML + Feedback)
// Usage: startReversalWatcher(symbol, options)
// Exports: startReversalWatcher, stopReversalWatcher

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import * as indicators from "./core_indicators.js";
import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -------------------------
// Storage & defaults
// -------------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ALERT_STORE = path.join(DATA_DIR, "reversal_alerts.json");
const WATCHER_LOG = path.join(DATA_DIR, "reversal_watcher_log.txt");

function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; return JSON.parse(fs.readFileSync(fp,"utf8") || "{}"); }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { return false; }
}
function log(...args) {
  const line = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}] ${args.join(" ")}`;
  try { fs.appendFileSync(WATCHER_LOG, line + "\n"); } catch {}
  console.log(line);
}

// -------------------------
// Configuration (tunable via options or CONFIG.REVERSAL_WATCHER)
// -------------------------
const GLOBAL_DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20000,
  patternScoreBoost: 50,   // base score for detected pattern
  minAlertConfidence: 65,  // threshold to send alert
  mlWeight: 0.18,
  requireVolumeConfirm: false,
  volumeMultiplierThreshold: 1.0, // vol/current > avg*X
  debounceSeconds: 120, // don't repeat same-side alert within this for same symbol
  feedbackWindowsSec: [60, 300], // windows to check outcomes (1m, 5m)
  maxSavedAlerts: 1000
}, CONFIG.REVERSAL_WATCHER || {});

// -------------------------
// Internal state
// -------------------------
let _watcherTimers = new Map(); // symbol->intervalId
let _running = false;
let _recentAlerts = safeLoad(ALERT_STORE, { alerts: [] });

// prune recent alerts on load
_recentAlerts.alerts = (_recentAlerts.alerts || []).slice(-GLOBAL_DEFAULTS.maxSavedAlerts);

// -------------------------
// Helpers: simple pattern detectors
// (uses last 3 candles per TF; cheap heuristics)
// -------------------------
function detectSimplePatternsFromCandles(candles = []) {
  // expects candles sorted oldest->newest
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  // Hammer-like (long lower wick)
  if (lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) {
    out.push({ name: "Hammer", side: "Bullish", strength: Math.min(90, 40 + (lowerWick/body)*10) });
  }
  // Shooting star
  if (upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) {
    out.push({ name: "ShootingStar", side: "Bearish", strength: Math.min(90, 40 + (upperWick/body)*10) });
  }
  // Engulfing
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 60 });

  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 60 });

  // Tweezer tops/bottoms (simple)
  if (prev.high === last.high && last.close < last.open) out.push({ name: "TweezerTop", side: "Bearish", strength: 45 });
  if (prev.low === last.low && last.close > last.open) out.push({ name: "TweezerBottom", side: "Bullish", strength: 45 });

  return out;
}

// -------------------------
// Score builder per TF
// -------------------------
function computeTFScore({ candles, ell, mlMicro, tf, tfWeight }) {
  // base 0..100
  let score = 0;
  let reasons = [];

  // pattern
  const patterns = detectSimplePatternsFromCandles(candles);
  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(80, p.strength || GLOBAL_DEFAULTS.patternScoreBoost);
    score += pscore;
    reasons.push(`pattern:${p.name}(${p.side})`);
  }

  // indicators
  try {
    const rsi = indicators.computeRSI(candles);
    const macd = indicators.computeMACD(candles);
    const atr = indicators.computeATR(candles);
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { score += 6; reasons.push("macd_pos"); }
      else if (macd.hist < 0) { score -= 6; reasons.push("macd_neg"); }
    }
    if (rsi && rsi < 30) { score += 6; reasons.push("rsi_oversold"); }
    if (rsi && rsi > 70) { score -= 6; reasons.push("rsi_overbought"); }
  } catch (e) {}

  // ell sentiment
  if (ell && typeof ell.sentiment === "number") {
    const s = ell.sentiment * 10; // -10..10
    score += s;
    reasons.push(`ell_sent:${ell.sentiment.toFixed(2)}`);
  }

  // micro ML nudge (1m/5m predictions) -> mlMicro.prob is percent number
  if (mlMicro && typeof mlMicro.prob === "number") {
    const p = (mlMicro.prob - 50) / 100 * 20; // ±10 points max
    score += p;
    reasons.push(`ml:${mlMicro.label || ""}:${mlMicro.prob}`);
  }

  // clamp 0..100
  let raw = Math.max(-100, Math.min(100, score));
  // normalize to 0..100 by shifting
  const norm = Math.round((raw + 100) / 2); // -100..100 -> 0..100
  // weighted by tfWeight
  const weighted = norm * (tfWeight || 1);

  return { score: norm, weighted, reasons, patterns };
}

// -------------------------
// Consensus builder
// -------------------------
function buildConsensus(perTfResults, weights = GLOBAL_DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTfResults) {
    const w = weights[r.tf] || 0.1;
    sumW += w;
    sumS += (r.score || 0) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;
  // ML main boost
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    boost = ((mlMain.prob - 50) / 100) * (GLOBAL_DEFAULTS.mlWeight * 100); // convert to points
  }
  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  // label mapping
  const label = final >= 75 ? "STRONG" : final >= 60 ? "MODERATE" : final >= 45 ? "WEAK" : "NONE";
  return { final, label, breakdown, mlBoost: boost };
}

// -------------------------
// TP/SL suggestions (use ell targets & ATR fallback)
// -------------------------
function makeTPsAndSLs({ ellSummary, ellTargets, atr, price }) {
  const tps = [];
  const sls = [];
  try {
    // Use Elliott targets first
    if (Array.isArray(ellTargets) && ellTargets.length) {
      for (const t of ellTargets.slice(0,4)) {
        const tp = Number(t.tp || t.target || t.price || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
    // If none, fallback to fib ext or ATR multiples
    if (!tps.length && ellSummary && ellSummary.support && ellSummary.resistance) {
      // create both side TPs (conservative)
      tps.push({ source: "fibZone_hi", tp: ellSummary.resistance, confidence: 40 });
      tps.push({ source: "fibZone_lo", tp: ellSummary.support, confidence: 40 });
    }
    if (!tps.length) {
      tps.push({ source: "ATR1", tp: price + Math.max(1, atr) * 2, confidence: 30 });
      tps.push({ source: "ATR2", tp: price + Math.max(1, atr) * 4, confidence: 25 });
    }

    // SL: use ATR
    const slLong = Number((price - Math.max(1, atr) * 2).toFixed(2));
    const slShort = Number((price + Math.max(1, atr) * 2).toFixed(2));
    sls.push({ side: "LONG", sl: slLong });
    sls.push({ side: "SHORT", sl: slShort });
  } catch (e) {}
  return { tps, sls };
}

// -------------------------
// Debounce check (avoid duplicate alerts)
// -------------------------
function recentlyAlerted(symbol, side) {
  const now = Date.now();
  const cutoff = now - (GLOBAL_DEFAULTS.debounceSeconds * 1000);
  _recentAlerts.alerts = (_recentAlerts.alerts || []).filter(a => a.ts >= cutoff);
  return (_recentAlerts.alerts || []).some(a => a.symbol === symbol && a.side === side);
}
function recordAlert(symbol, side, payload) {
  _recentAlerts.alerts = _recentAlerts.alerts || [];
  _recentAlerts.alerts.push({ symbol, side, ts: Date.now(), payload });
  // trim
  _recentAlerts.alerts = _recentAlerts.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
  safeSave(ALERT_STORE, _recentAlerts);
}

// -------------------------
// Outcome check (feedback) - will call recordOutcome from ml module if predictionId present
// -------------------------
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec) {
  try {
    const resp = await fetchMarketData(symbol, "1m", 5);
    const newPrice = resp?.price || priceAtSend;
    const movedUp = newPrice > priceAtSend;
    const success = (side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend)/Math.max(1,Math.abs(priceAtSend)))*100 : null;
    // call ml_module.recordOutcome if predId exists
    if (predId && typeof recordOutcome === "function") {
      try {
        recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice });
      } catch (e) {}
    }
    // return summary
    return { ok: true, predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Main tick (per symbol)
// -------------------------
async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    // fetch multi-TF candles
    const tfs = opts.tfs || GLOBAL_DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs);

    // run ML main pred for 15m (best-effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];

    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      // ell for TF (cheap)
      let ell = null;
      try { const er = await analyzeElliott(candles); ell = er && er.ok ? er : null; } catch (e) { ell = null; }

      // micro ML (1m/5m) for TFs shorter than or equal 5m
      let mlMicro = null;
      if (["1m","5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || 60); } catch (e) { mlMicro = null; }
      }

      // compute score
      const weight = opts.weights && opts.weights[tf] ? opts.weights[tf] : GLOBAL_DEFAULTS.weights[tf] || 0.1;
      const sc = computeTFScore({ candles, ell, mlMicro, tf, tfWeight: weight });
      perTfResults.push({
        tf,
        price,
        candles,
        ell,
        mlMicro,
        score: sc.score,
        weighted: sc.weighted,
        reasons: sc.reasons,
        patterns: sc.patterns
      });
    }

    // consensus
    const consensus = buildConsensus(perTfResults, opts.weights || GLOBAL_DEFAULTS.weights, mlMain);

    // trend context detection (use 1h/4h if available else 15m)
    let trendTF = "15m";
    const higherTF = "1h";
    let trend = "FLAT";
    try {
      const hc = multi[higherTF] || multi["15m"];
      const closes = (hc?.data || []).map(c => c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        if (last > prev) trend = "UP";
        else if (last < prev) trend = "DOWN";
      }
    } catch (e) {}

    // build alert payload if final confidence >= threshold
    const finalScore = consensus.final; // 0..100
    if (finalScore >= (opts.minAlertConfidence || GLOBAL_DEFAULTS.minAlertConfidence)) {
      // decide side: majority of TFs patterns
      const bullCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
      const bearCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
      const side = bullCount > bearCount ? "Bullish" : (bearCount > bullCount ? "Bearish" : (mlMain && mlMain.label ? mlMain.label : "Bullish"));

      // debounce
      if (recentlyAlerted(symbol, side)) {
        log("debounced duplicate alert", symbol, side, finalScore);
        return { alerted: false, reason: "debounced" };
      }

      // prepare TP/SL using best 15m ell or average ATR
      const tf15 = perTfResults.find(r => r.tf === "15m") || perTfResults[perTfResults.length-1];
      const price = tf15.price || perTfResults[0].price || 0;
      const atr = tf15 && tf15.candles ? indicators.computeATR(tf15.candles) : 0;
      const ellSummary = tf15.ell && tf15.ell.ok ? { support: tf15.ell.support, resistance: tf15.ell.resistance } : null;
      const ellTargets = (tf15.ell && tf15.ell.targets) ? tf15.ell.targets : (tf15.ell && tf15.ell.targets) ? tf15.ell.targets : [];

      const { tps, sls } = makeTPsAndSLs({ ellSummary, ellTargets, atr, price });

      // Compose message
      const breakdownTxt = consensus.breakdown.map(b => `${b.tf.toUpperCase()}:${Math.round(b.score)}${(b.patterns && b.patterns.length) ? `(${b.patterns.map(p=>p.name).join(",")})` : ""}`).join(" | ");

      const mlMainTxt = mlMain ? `${mlMain.label} ${mlMain.prob}%` : "N/A";

      const msgLines = [
        `⚡ <b>REVERSAL ALERT</b> — <b>${side}</b> (${consensus.label})`,
        `Symbol: <b>${symbol}</b> | Confidence: <b>${finalScore}%</b> | ML(15m): ${mlMainTxt}`,
        `Trend: ${trend} | Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}`,
        `Breakdown: ${breakdownTxt}`,
        `TPs: ${tps.map(tp=>`${tp.tp ? Number(tp.tp).toFixed(2) : "n/a"} (${tp.source})`).join(" / ")}`,
        `SLs: ${sls.map(s=>`${s.side}:${s.sl ? Number(s.sl).toFixed(2) : "n/a"}`).join(" / ")}`,
        `Patterns: ${perTfResults.flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`)).join(" , ") || "N/A"}`,
        `ID: pending`
      ];

      const text = msgLines.join("\n");

      // send via sendAlert if provided else fallback to console.log
      let sendRes = null;
      try {
        if (typeof sendAlert === "function") {
          // include meta with recordPrediction
          const predMeta = {
            source: "reversal_watcher_vD",
            consensusScore: finalScore,
            consensusLabel: consensus.label,
            perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score, patterns: (r.patterns||[]).map(p=>p.name) })),
            mlMain
          };
          // record prediction in ML store to allow feedback linking
          let predId = null;
          try { predId = await recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: side, prob: finalScore, features: predMeta }); } catch (e) { predId = null; }
          // attach predId to message
          const withIdText = msgLines.slice(0, -1).concat([`ID: ${predId || "none"}`]).join("\n");
          sendRes = await sendAlert(withIdText); // user code will sanitize/send to Telegram
          // record to recent alerts store
          recordAlert(symbol, side, { ts: Date.now(), score: finalScore, predId, payload: perTfResults });
          log("alert sent", symbol, side, finalScore, "predId:", predId);
          // schedule feedback checks
          (opts.feedbackWindowsSec || GLOBAL_DEFAULTS.feedbackWindowsSec).forEach(async (win) => {
            setTimeout(async () => {
              const outcome = await checkOutcome(predId, symbol, side, price, win);
              log("feedback", symbol, side, "windowSec", win, "outcome:", JSON.stringify(outcome));
            }, win * 1000);
          });
        } else {
          log("No sendAlert provided — would send:", text);
          recordAlert(symbol, side, { ts: Date.now(), score: finalScore, payload: perTfResults });
        }
      } catch (e) {
        log("Error sending alert:", e?.message || e);
      }

      return { alerted: true, score: finalScore, predId: (sendRes && sendRes.predId) || null };
    }

    // nothing to alert
    return { alerted: false, score: finalScore, reason: "below_threshold" };

  } catch (e) {
    log("evaluateSymbol error:", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Public API: start/stop
// -------------------------
/**
 * startReversalWatcher(symbol, options, sendAlert)
 * options: { tfs, pollIntervalMs, weights, minAlertConfidence, microLookback, feedbackWindowsSec }
 * sendAlert: async function(text) -> should send (e.g. via aiTraderBot.sendTelegram wrapper)
 */
export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_watcherTimers.has(symbol)) {
    log("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, GLOBAL_DEFAULTS, options);
  log("Starting Reversal Watcher for", symbol, "opts:", JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs, minAlertConfidence: opts.minAlertConfidence }));

  // tick function
  const tick = async () => {
    try {
      const res = await evaluateSymbol(symbol, opts, sendAlert);
      if (res && res.error) log("Watcher tick error:", res.error);
    } catch (e) {
      log("Watcher tick exception:", e?.message || e);
    }
  };

  // immediate run + interval
  tick();
  const id = setInterval(tick, opts.pollIntervalMs || GLOBAL_DEFAULTS.pollIntervalMs);
  _watcherTimers.set(symbol, id);
  _running = true;
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const id = _watcherTimers.get(symbol);
      if (id) { clearInterval(id); _watcherTimers.delete(symbol); }
    } else {
      for (const [s, id] of _watcherTimers.entries()) {
        clearInterval(id);
        _watcherTimers.delete(s);
      }
    }
    _running = _watcherTimers.size > 0;
    log("Stopped watcher for", symbol || "ALL");
    return true;
  } catch (e) {
    log("stopReversalWatcher error:", e?.message || e);
    return false;
  }
}

// -------------------------
// small export for debug/metrics
// -------------------------
export function getWatcherState() {
  return {
    running: _running,
    symbols: Array.from(_watcherTimers.keys()),
    recentAlerts: (_recentAlerts.alerts || []).slice(-30),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};