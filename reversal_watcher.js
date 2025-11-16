// reversal_watcher.js — Optimized Multi-TF Reversal Watcher (memory-friendly, consensus-driven)
// Exports: startReversalWatcher(symbol, options, sendAlert), stopReversalWatcher, getWatcherState
// Designed to be dropped into your project and used with aiTraderBot.sendTelegram as sendAlert.

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js"; // used only on 15m (opt-in)
import * as indicators from "./core_indicators.js";
import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -------------- small helpers --------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ALERT_STORE = path.join(DATA_DIR, "reversal_alerts.json");
const STATE_STORE = path.join(DATA_DIR, "reversal_state.json");

function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    const s = fs.readFileSync(fp, "utf8");
    if (!s) return def;
    return JSON.parse(s);
  } catch (e) {
    return def;
  }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
}
function slog(...args) {
  // Minimal logging so Render logs don't explode
  console.log(`[Reverser ${nowIST()}]`, ...args);
}

// -------------- defaults (tunable via options) --------------
const DEFAULTS = Object.assign({
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20_000,
  minAlertConfidence: 65,
  debounceSeconds: 120,
  maxAlertsSaved: 300,
  requireElliottOn15m: true,   // run Elliott only on 15m (saves memory)
  mlWeight: 0.18,              // main ml boost weight
  microML: true,               // run micro ML on 1m/5m
  volumeConfirm: false,        // optional volume confirmation
  allowBothSideTPs: true,      // generate both-side tps if no pattern based
}, CONFIG.REVERSAL_WATCHER || {});

// -------------- internal state --------------
let _watchers = new Map(); // symbol -> intervalId
let _running = false;

// Load recent alerts and trim
const _store = safeLoad(ALERT_STORE, { alerts: [] });
_store.alerts = (_store.alerts || []).slice(-DEFAULTS.maxAlertsSaved);

// Persist state occasionally
function persistState() {
  safeSave(STATE_STORE, { running: _running, symbols: Array.from(_watchers.keys()), savedAt: new Date().toISOString() });
}

// -------------- cheap pattern detections (keep tiny) --------------
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);
  const body = Math.abs(last.close - last.open) || 1;
  const upperWick = (last.high - Math.max(last.close, last.open)) || 0;
  const lowerWick = (Math.min(last.close, last.open) - last.low) || 0;

  // Hammer-like
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

  // Tweezer approximate
  if (prev.high === last.high && last.close < last.open) out.push({ name: "TweezerTop", side: "Bearish", strength: 45 });
  if (prev.low === last.low && last.close > last.open) out.push({ name: "TweezerBottom", side: "Bullish", strength: 45 });

  return out;
}

// -------------- core scoring per TF (lightweight) --------------
function computeTFScore({ candles, tf, weight, ell }) {
  // Score 0..100
  let score = 50; // neutral starting point
  const reasons = [];
  const patterns = detectSimplePatternsFromCandles(candles);

  if (patterns.length) {
    const p = patterns[0];
    // pattern pushes score up/down proportional to strength
    const delta = Math.round((p.strength || 50) / 2);
    score += (p.side === "Bullish") ? delta : -delta;
    reasons.push(`pattern:${p.name}`);
  }

  // indicators (cheap)
  try {
    const rsi = indicators.computeRSI(candles);
    if (rsi && rsi < 30) { score += 6; reasons.push("rsi_oversold"); }
    if (rsi && rsi > 70) { score -= 6; reasons.push("rsi_overbought"); }
    const macd = indicators.computeMACD(candles);
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { score += 4; reasons.push("macd_pos"); }
      else if (macd.hist < 0) { score -= 4; reasons.push("macd_neg"); }
    }
  } catch (e) { /* ignore indicator errors */ }

  // Elliott sentiment if present (15m typically)
  if (ell && typeof ell.sentiment === "number") {
    // ell.sentiment is -1..1, scale to ±10
    score += Math.round(ell.sentiment * 10);
    reasons.push("elliott");
  }

  // clamp 0..100
  score = Math.max(0, Math.min(100, score));
  const weighted = Math.round(score * (weight || 1));
  return { tf, score, weighted, reasons, patterns };
}

// -------------- consensus builder --------------
function buildConsensus(results, mlMain = null, weights = DEFAULTS.weights) {
  // results: [{tf, score, weighted, patterns, reasons}]
  let weightedSum = 0, weightTotal = 0;
  const breakdown = [];
  for (const r of results) {
    const w = weights[r.tf] || 0.1;
    weightedSum += (r.score || 50) * w;
    weightTotal += w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  let avg = weightTotal ? (weightedSum / weightTotal) : 50;
  // apply mlMain boost (if available)
  if (mlMain && typeof mlMain.prob === "number") {
    const boost = ((mlMain.prob - 50) / 100) * (DEFAULTS.mlWeight * 100);
    avg = avg + boost;
  }
  const final = Math.round(Math.max(0, Math.min(100, avg)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";
  return { final, label, breakdown };
}

// -------------- TP/SL suggestions (safe and symmetric) --------------
function suggestTPsAndSLs({ ellResult15 = null, price = 0, atr = 0 }) {
  const tps = [];
  const sls = [];
  try {
    // If Elliott provided pattern targets (structured), use them; else create symmetric targets both sides
    if (ellResult15 && Array.isArray(ellResult15.targets) && ellResult15.targets.length) {
      for (const t of ellResult15.targets.slice(0, 4)) {
        const tpVal = Number(t.tp || t.target || t.price || 0);
        if (tpVal) tps.push({ source: "Elliott", tp: tpVal, confidence: t.confidence || 50 });
      }
    }

    if (!tps.length) {
      // fallback: symmetric ATR-based picks
      const a = Math.max(1, atr || 1);
      tps.push({ source: "ATR", tp: Number((price + a * 2).toFixed(2)), confidence: 30 });
      tps.push({ source: "ATR", tp: Number((price - a * 2).toFixed(2)), confidence: 30 });
    }

    // stops: simple ATR stops
    sls.push({ side: "LONG", sl: Number((price - Math.max(1, atr) * 2).toFixed(2)) });
    sls.push({ side: "SHORT", sl: Number((price + Math.max(1, atr) * 2).toFixed(2)) });
  } catch (e) { /* ignore */ }
  return { tps, sls };
}

// -------------- debounce helpers --------------
function trimmedAlerts() {
  _store.alerts = (_store.alerts || []).slice(-DEFAULTS.maxAlertsSaved);
  return _store.alerts;
}
function recentlyAlerted(symbol, side) {
  const cutoff = Date.now() - DEFAULTS.debounceSeconds * 1000;
  _store.alerts = (_store.alerts || []).filter(a => a.ts >= cutoff);
  return (_store.alerts || []).some(a => a.symbol === symbol && a.side === side);
}
function recordAlert(symbol, side, meta = {}) {
  _store.alerts = _store.alerts || [];
  _store.alerts.push({ symbol, side, ts: Date.now(), meta });
  _store.alerts = _store.alerts.slice(-DEFAULTS.maxAlertsSaved);
  safeSave(ALERT_STORE, _store);
}

// -------------- outcome check (lightweight) --------------
async function checkOutcomeAndRecord(predId, symbol, side, sentPrice, windowSec = 60) {
  try {
    const resp = await fetchMarketData(symbol, "1m", 3);
    const newPrice = resp?.price || sentPrice;
    const success = (side === "Bullish") ? (newPrice > sentPrice) : (newPrice < sentPrice);
    const realizedReturn = sentPrice ? ((newPrice - sentPrice) / Math.max(1, Math.abs(sentPrice))) * 100 : null;
    if (typeof recordOutcome === "function" && predId) {
      try { recordOutcome(predId, { correct: !!success, realizedReturn, realizedPrice: newPrice }); } catch {}
    }
    return { ok: true, predId, windowSec, sentPrice, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------- main evaluator (single tick for a symbol) --------------
async function evaluateSymbol(symbol, options = {}, sendAlert = null) {
  try {
    const opts = Object.assign({}, DEFAULTS, options);
    const tfs = opts.tfs || DEFAULTS.tfs;

    // fetch all TFs in one go (fetchMultiTF should return { "1m":{data,price}, ... })
    const multi = await fetchMultiTF(symbol, tfs);

    // run main ML (15m) best-effort
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch {}

    const perTf = [];

    // iterate TFs
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      // cheap ell only for 15m if enabled
      let ell = null;
      if (tf === "15m" && opts.requireElliottOn15m) {
        try {
          const er = await analyzeElliott(candles, { pivotLeft: 3, pivotRight: 3 });
          if (er && er.ok) ell = er;
        } catch (e) { ell = null; }
      }

      // compute TF score (light)
      const w = (opts.weights && opts.weights[tf]) ? opts.weights[tf] : DEFAULTS.weights[tf] || 0.1;
      const sc = computeTFScore({ candles, tf, weight: w, ell });
      perTf.push({ tf, candles, price, ell, score: sc.score, weighted: sc.weighted, reasons: sc.reasons, patterns: sc.patterns });
    }

    // build consensus
    const consensus = buildConsensus(perTf, mlMain, opts.weights);

    // if below threshold -> no alert
    if (consensus.final < (opts.minAlertConfidence || DEFAULTS.minAlertConfidence)) {
      return { alerted: false, score: consensus.final, reason: "below_threshold" };
    }

    // decide side: majority of TF pattern sides, else mlMain, else based on avg score
    const bullPatternCount = perTf.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
    const bearPatternCount = perTf.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
    let side = "Bullish";
    if (bullPatternCount > bearPatternCount) side = "Bullish";
    else if (bearPatternCount > bullPatternCount) side = "Bearish";
    else if (mlMain && mlMain.label) side = mlMain.label;
    else side = (consensus.final >= 50) ? "Bullish" : "Bearish";

    // debounce duplicates
    if (recentlyAlerted(symbol, side)) {
      slog("debounced duplicate alert", symbol, side, "score:", consensus.final);
      return { alerted: false, reason: "debounced" };
    }

    // prepare TPs/SLs from 15m ell or ATR fallback
    const tf15 = perTf.find(p => p.tf === "15m") || perTf[perTf.length - 1];
    const price = tf15.price || perTf[0].price || 0;
    const atr = (tf15.candles && tf15.candles.length) ? indicators.computeATR(tf15.candles) : 0;
    const ell15 = tf15.ell && tf15.ell.ok ? tf15.ell : null;
    const { tps, sls } = suggestTPsAndSLs({ ellResult15: ell15, price, atr });

    // compose message (clean)
    const breakdownTxt = consensus.breakdown.map(b => `${b.tf.toUpperCase()}:${Math.round(b.score)}${(b.patterns && b.patterns.length) ? `(${b.patterns.map(p=>p.name).join(",")})` : ""}`).join(" | ");
    const mlMainTxt = mlMain ? `${mlMain.label} ${mlMain.prob}%` : "N/A";

    const lines = [
      `⚡ <b>REVERSAL ALERT</b> — <b>${side}</b> (${consensus.label})`,
      `Symbol: <b>${symbol}</b> | Confidence: <b>${consensus.final}%</b> | ML(15m): ${mlMainTxt}`,
      `Trend: ${tf15 ? "15m-based" : "n/a"} | Time: ${nowIST()}`,
      `Breakdown: ${breakdownTxt}`,
      `TPs: ${tps.map(x => `${Number(x.tp).toFixed(2)} (${x.source})`).join(" / ")}`,
      `SLs: ${sls.map(x => `${x.side}:${Number(x.sl).toFixed(2)}`).join(" / ")}`,
      `Patterns: ${perTf.flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`)).join(" , ") || "N/A"}`,
      `ID: pending`
    ];

    const message = lines.join("\n");

    // recordPrediction if available
    let predId = null;
    try {
      if (typeof recordPrediction === "function") {
        predId = await recordPrediction({
          source: "reversal_watcher_opt",
          symbol,
          predictedAt: new Date().toISOString(),
          label: side,
          prob: consensus.final,
          meta: { perTf: perTf.map(p => ({ tf: p.tf, score: p.score })) }
        });
      }
    } catch (e) { predId = null; }

    // attach predId to message
    const msgWithId = message.replace("ID: pending", `ID: ${predId || "none"}`);

    // send alert (callback) or log
    if (typeof sendAlert === "function") {
      try {
        await sendAlert(msgWithId);
      } catch (e) {
        slog("sendAlert failed:", e?.message || e);
      }
    } else {
      slog("ALERT (no sendAlert):", msgWithId);
    }

    // record local alert and persist
    recordAlert(symbol, side, { score: consensus.final, predId, price, t: new Date().toISOString() });

    // schedule lightweight feedback windows (only if predId and recordOutcome exist)
    if (predId && typeof recordOutcome === "function") {
      const windows = opts.feedbackWindowsSec || [60, 300]; // 1m, 5m
      for (const w of windows) {
        setTimeout(async () => {
          const out = await checkOutcomeAndRecord(predId, symbol, side, price, w);
          slog("feedback:", symbol, "window", w, out.ok ? `success:${out.success}` : `err:${out.error}`);
        }, w * 1000);
      }
    }

    persistState();
    return { alerted: true, score: consensus.final, predId };

  } catch (err) {
    slog("evaluateSymbol error:", err?.message || err);
    return { alerted: false, error: err?.message || String(err) };
  }
}

// -------------- start / stop --------------
export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_watchers.has(symbol)) {
    slog("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, DEFAULTS, options);

  slog(`Starting Reversal Watcher for ${symbol} tfs:${JSON.stringify(opts.tfs)} interval:${opts.pollIntervalMs}ms minConf:${opts.minAlertConfidence}`);

  // tick wrapper
  const tick = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {
      slog("Tick error:", e?.message || e);
    }
  };

  // initial immediate run, then interval
  tick();
  const id = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  _watchers.set(symbol, { id, opts });
  _running = true;
  persistState();
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  if (symbol) {
    const st = _watchers.get(symbol);
    if (st) {
      clearInterval(st.id);
      _watchers.delete(symbol);
      slog("Stopped watcher for", symbol);
    }
  } else {
    for (const [s, st] of _watchers.entries()) {
      clearInterval(st.id);
      _watchers.delete(s);
      slog("Stopped watcher for", s);
    }
  }
  _running = _watchers.size > 0;
  persistState();
  return true;
}

export function getWatcherState() {
  return {
    running: _running,
    symbols: Array.from(_watchers.keys()),
    recentAlerts: (_store.alerts || []).slice(-20),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

export default { startReversalWatcher, stopReversalWatcher, getWatcherState };