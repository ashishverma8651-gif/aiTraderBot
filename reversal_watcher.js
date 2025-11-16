// reversal_watcher.js — FINAL (Cleaned + tuned thresholds + ML gating relaxed + faster confirmation)
// All features preserved: patterns, volume, RSI, MACD, ATR, Elliott, ML, feedback
//
// Drop-in replacement for aiTraderBot.js usage of startReversalWatcher / stopReversalWatcher.
//
// Dependencies (must exist):
// ./config.js
// ./utils.js -> fetchMarketData, fetchMultiTF
// ./core_indicators.js -> computeRSI, computeMACD, computeATR
// ./elliott_module.js -> analyzeElliott
// ./ml_module_v8_6.js -> runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy

import fs from "fs";
import path from "path";

import CONFIG from "./config.js";
import { fetchMarketData, fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// =====================
// Storage
// =====================
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");

function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    return JSON.parse(fs.readFileSync(fp, "utf8") || "{}");
  } catch {
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

const DEFAULTS = Object.assign({
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  pollIntervalMs: 20000,
  // Tuned thresholds (relaxed so alerts actually appear)
  pendingThreshold: 52,        // start pending if consensus >= this
  minAlertConfidence: 55,      // final send threshold when used (kept slightly above pending)
  confirmCandles: 2,           // fewer candles to confirm on short TFs
  confirmationTF: "1m",
  confirmTimeoutMs: 30 * 1000,
  debounceSeconds: 60,         // cooldown for identical key (reduced)
  cooldownAfterConfirmSec: 600,
  maxSavedAlerts: 2000,
  // ML gating relaxed
  mlMainGateMinProb: 45,       // don't aggressively block unless ML strongly contradicts
  microMlGateDeltaPct: 6,
  maxPendingAgeMs: 24 * 60 * 60 * 1000,
  maxAlertsPerHour: 9999,      // effectively disabled rate-limit
  // volume handling relaxed
  volumeMultiplier: 0.8,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2, 4],
  allowNeutral: true,
  feedbackWindowsSec: [60, 300]
}, CONFIG.REVERSAL_WATCHER || {});

let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// =====================
// Record keeping
// =====================
function recordHourly() {
  const now = Date.now();
  STORE.hourly.push(now);
  STORE.hourly = STORE.hourly.filter(t => t >= now - 3600000);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() {
  return STORE.hourly.length;
}
function pruneRecent() {
  const cutoff = Date.now() - DEFAULTS.debounceSeconds * 1000;
  STORE.recent = STORE.recent.filter(x => x.ts >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function addRecent(key) {
  STORE.recent.push({ key, ts: Date.now() });
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
  recordHourly();
  safeSave(STORE_FILE, STORE);
}
function recentlyAlerted(key) {
  pruneRecent();
  return STORE.recent.some(x => x.key === key);
}

// =====================
// Pattern detection
// =====================
function detectPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return [];

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const patterns = [];
  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.close, last.open);
  const lower = Math.min(last.close, last.open) - last.low;

  // Hammer
  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open)
    patterns.push({ name: "Hammer", side: "Bullish", strength: 70 });

  // Shooting Star
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open)
    patterns.push({ name: "ShootingStar", side: "Bearish", strength: 70 });

  // Engulfing
  if (
    prev.close < prev.open &&
    last.close > last.open &&
    last.close > prev.open &&
    last.open < prev.close
  )
    patterns.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });

  if (
    prev.close > prev.open &&
    last.close < last.open &&
    last.open > prev.close &&
    last.close < prev.open
  )
    patterns.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });

  // Tweezer top/bottom
  if (
    Math.abs(prev.high - last.high) / Math.abs(prev.high || 1) < 0.0006 &&
    last.close < last.open
  )
    patterns.push({ name: "TweezerTop", side: "Bearish", strength: 55 });

  if (
    Math.abs(prev.low - last.low) / Math.abs(prev.low || 1) < 0.0006 &&
    last.close > last.open
  )
    patterns.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  // Doji
  if (body / (last.high - last.low || 1) < 0.2)
    patterns.push({ name: "Doji", side: "Neutral", strength: 40 });

  // Morning Star (crude)
  if (
    prev2 &&
    prev &&
    last &&
    prev2.close < prev2.open &&
    last.close > last.open &&
    last.close > prev.close
  )
    patterns.push({ name: "MorningStar", side: "Bullish", strength: 72 });

  // Evening Star
  if (
    prev2 &&
    prev &&
    last &&
    prev2.close > prev2.open &&
    last.close < last.open &&
    last.close < prev.close
  )
    patterns.push({ name: "EveningStar", side: "Bearish", strength: 72 });

  return patterns;
}

// =====================
// TF Score
// =====================
function computeTFScore({ candles, tf, weight }) {
  const out = { score: 50, patterns: [], reasons: [] };
  if (!candles || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += p.side === "Bullish" ? p.strength / 2 : -p.strength / 2;
    out.reasons.push("pattern:" + p.name);
  }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : null;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : null;
    const atr = typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : null;

    const lastVol =
      candles.at(-1).vol ||
      candles.at(-1).v ||
      candles.at(-1).volume ||
      0;

    const volWindow = Math.min(20, candles.length);
    const avgVol =
      candles
        .slice(-volWindow)
        .reduce(
          (s, c) =>
            s +
            (c.vol || c.v || c.volume || 0),
          0
        ) / Math.max(1, volWindow);

    if (rsi !== null) {
      if (rsi < 30) { out.score += 8; out.reasons.push("rsi_oversold"); }
      if (rsi > 70) { out.score -= 8; out.reasons.push("rsi_overbought"); }
    }

    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { out.score += 6; out.reasons.push("macd_pos"); }
      if (macd.hist < 0) { out.score -= 6; out.reasons.push("macd_neg"); }
    }

    if (avgVol && lastVol) {
      if (lastVol > avgVol * DEFAULTS.volumeMultiplier) { out.score += 6; out.reasons.push("vol_spike"); }
      if (lastVol < avgVol * 0.6) { out.score -= 3; out.reasons.push("vol_drop"); } // relaxed penalty
    }

    out.score = Math.min(100, Math.max(0, out.score));
  } catch {}

  out.score = Math.round(out.score * (weight || 1));
  return out;
}

// =====================
// Consensus
// =====================
function buildConsensus(perTf, weights, mlMain) {
  let sumW = 0,
    sumS = 0;
  for (const r of perTf) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += r.score * w;
  }
  const avg = sumW ? sumS / sumW : 50;

  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number")
    boost = ((mlMain.prob - 50) / 50) * 10;

  return Math.round(Math.min(100, Math.max(0, avg + boost)));
}

// =====================
// Targets
// =====================
function buildTargets({ ellObj, price, atr }) {
  const tps = [];
  if (ellObj?.targets?.length) {
    ellObj.targets.slice(0, 3).forEach(t => {
      const tpVal = Number(t.tp || t.target || t.price || 0);
      if (tpVal) tps.push({ source: t.source || "Elliott", tp: tpVal, confidence: t.confidence || 50 });
    });
  } else {
    DEFAULTS.tpAtrMultipliers.forEach(m => {
      tps.push({ source: "ATR", tp: Number((price + (atr || 1) * m).toFixed(2)), confidence: 30 });
    });
  }

  const sls = [
    { side: "LONG", sl: Number((price - (atr || 1) * DEFAULTS.slAtrMultiplier).toFixed(2)) },
    { side: "SHORT", sl: Number((price + (atr || 1) * DEFAULTS.slAtrMultiplier).toFixed(2)) }
  ];

  return { tps, sls };
}

// =====================
// Keys
// =====================
function makeKey(symbol, side, pattern, price) {
  return `${symbol}_${side}_${pattern}_${Math.round(price)}`;
}

// =====================
// Confirmation
// =====================
async function confirmPending(pending, opts) {
  try {
    const tf = pending.confirmationTF || opts.confirmationTF || DEFAULTS.confirmationTF;
    const req = pending.requiredCandles || opts.confirmCandles || DEFAULTS.confirmCandles;
    const data = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = data?.data || [];

    const closed = candles.slice(-(req + 1), -1);

    if (closed.length < req)
      return { ok: false, reason: "not_enough_closed" };

    let support = 0;
    closed.forEach(c => {
      const body = Math.abs(c.close - c.open) || 1;
      const up = c.close > c.open;
      const lowWick = Math.min(c.open, c.close) - c.low;
      const upWick = c.high - Math.max(c.open, c.close);

      if (pending.side === "Bullish" && up) support++;
      if (pending.side === "Bearish" && !up) support++;

      if (pending.side === "Bullish" && lowWick > body * 1.6) support++;
      if (pending.side === "Bearish" && upWick > body * 1.6) support++;
    });

    const need = Math.ceil(closed.length * 0.6);
    const ok = support >= need;

    const start = closed[0].close;
    const last = closed.at(-1).close;
    const movedPct = start ? ((last - start) / Math.max(1, Math.abs(start))) * 100 : 0;

    return {
      ok,
      support,
      need,
      closedLast: closed.at(-1),
      movedPct
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// =====================
// Symbol evaluation (main logic)
// =====================
async function evaluateSymbol(symbol, opts = {}, sendAlert = async () => {}) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;

    const multi = await fetchMultiTF(symbol, tfs);

    let mlMain = null;
    try {
      mlMain = await runMLPrediction(symbol, "15m");
    } catch {}

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const c = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (c.at(-1)?.close ?? 0);

      const score = computeTFScore({
        candles: c,
        tf,
        weight: opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1
      });

      perTfResults.push({
        tf,
        score: score.score,
        patterns: score.patterns,
        reasons: score.reasons,
        price,
        candles: c
      });
    }

    const finalScore = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);

    if (finalScore < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      return { alerted: false, reason: "below_threshold", score: finalScore };
    }

    // majority pattern side
    let bull = 0, bear = 0;
    for (const r of perTfResults) {
      for (const p of (r.patterns || [])) {
        if (p.side === "Bullish") bull++;
        if (p.side === "Bearish") bear++;
      }
    }

    let side = "Bullish";
    if (bear > bull) side = "Bearish";
    else if (bull === bear) {
      if (mlMain && typeof mlMain.prob === "number") side = mlMain.prob >= 50 ? "Bullish" : "Bearish";
    }

    const topPattern = (perTfResults.flatMap(r => r.patterns).at(0)) || { name: "Pattern" };
    const priceRef = perTfResults[0]?.price ?? 0;
    const key = makeKey(symbol, side, topPattern.name, priceRef);

    if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };
    if (hourlyCount() >= (opts.maxAlertsPerHour ?? DEFAULTS.maxAlertsPerHour)) return { alerted: false, reason: "rate_limit" };

    // ML main gating (relaxed): only block if strongly opposite and exceeding threshold
    if (mlMain && typeof mlMain.prob === "number") {
      const mlProb = mlMain.prob; // 0..100
      const mlSide = mlProb > 55 ? "Bullish" : mlProb < 45 ? "Bearish" : "Neutral";
      if (mlSide !== "Neutral" && mlSide !== side && (mlProb > (opts.mlMainGateMinProb ?? DEFAULTS.mlMainGateMinProb))) {
        // contradictory ML main -> skip creating pending (log reason)
        return { alerted: false, reason: "ml_contradict", mlProb, side };
      }
    }

    // Create pending entry
    const id = "pend_" + Date.now() + "_" + Math.floor(Math.random() * 9000);
    const pending = {
      id,
      key,
      symbol,
      side,
      pattern: topPattern.name,
      createdAt: Date.now(),
      priceAtDetect: priceRef,
      perTfResults,
      predId: null,
      status: "pending",
      requiredCandles: opts.confirmCandles ?? DEFAULTS.confirmCandles,
      confirmationTF: opts.confirmationTF ?? DEFAULTS.confirmationTF,
      consensusScore: finalScore
    };

    try {
      pending.predId = await recordPrediction({
        symbol,
        predictedAt: new Date().toISOString(),
        label: side,
        prob: finalScore,
        features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
        meta: { source: "reversal_watcher" }
      });
    } catch {
      pending.predId = null;
    }

    addPendingRecord(pending);

    // Build preview alert
    const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
    let ell = null;
    try { ell = await analyzeElliott(perTfResults[0].candles); } catch {}
    const targets = buildTargets({ ellObj: ell?.ok ? ell : null, price: priceRef, atr });

    const preview = [
      `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
      `Symbol: <b>${symbol}</b> | Pattern: ${pending.pattern} | Score: <b>${Math.round(finalScore)}%</b>`,
      `Price: ${Number(priceRef).toFixed(2)} | TF weights: ${JSON.stringify(opts.weights || DEFAULTS.weights)}`,
      `Top TP(s): ${targets.tps.slice(0,2).map(t => `${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
      `SLs: LONG:${targets.sls.find(s => s.side === "LONG")?.sl || "n/a"} | SHORT:${targets.sls.find(s => s.side === "SHORT")?.sl || "n/a"}`,
      `Waiting for ${pending.requiredCandles} x ${pending.confirmationTF} candle(s) to confirm...`,
      `ID: ${pending.predId || "none"}`
    ].join("\n");

    try { await sendAlert(preview); } catch {}

    return { alerted: true, pendingId: id, key, score: finalScore };
  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// =====================
// Pending checker
// =====================
async function processAllPending(sendAlert = async () => {}, opts = {}) {
  const now = Date.now();
  const copy = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of copy) {
    try {
      // expire old pending
      if (now - (p.createdAt || 0) > (opts.maxPendingAgeMs ?? DEFAULTS.maxPendingAgeMs)) {
        updatePendingRecordStatus(p.id, "expired");
        removePendingRecord(p.id);
        continue;
      }

      const conf = await confirmPending(p, opts);

      if (!conf.ok) {
        // if not enough candles, keep waiting
        if (conf.reason === "not_enough_closed") continue;
        // invalidated -> send failure & record outcome
        const failMsg = `🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\nPattern: ${p.pattern}\nReason: ${conf.reason || "invalidated"}\nID: ${p.predId || "none"}`;
        try { await sendAlert(failMsg); } catch {}
        if (p.predId) {
          try { await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch {}
        }
        updatePendingRecordStatus(p.id, "failed");
        removePendingRecord(p.id);
        continue;
      }

      // confirmed -> build final alert
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch {}
      const targets = buildTargets({ ellObj: ell?.ok ? ell : null, price, atr });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Symbol: <b>${p.symbol}</b> | Pattern: ${p.pattern} | Confidence: <b>${Math.round(p.consensusScore||0)}%</b>`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${targets.tps.map(t => `${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s => s.side === 'LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s => s.side === 'SHORT')?.sl || "n/a"}`,
        `Observed support: ${conf.support}/${conf.need} | movePct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.predId || "none"}`
      ].join("\n");

      try { await sendAlert(msg); } catch {}

      // record sent, cooldown, and schedule feedback
      updatePendingRecordStatus(p.id, "sent");
      addRecent(p.key);

      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            updatePendingRecordStatus(p.id, outcome.success ? "done" : "failed", outcome);
            if (p.predId) {
              try { await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch {}
            }
            // remove after small delay
            setTimeout(() => removePendingRecord(p.id), 2000);
          } catch {}
        }, win * 1000);
      });

    } catch (e) {
      // keep loop alive on single error
    }
  }
}

// helper functions for pending store
function addPendingRecord(rec) {
  STORE.pending = STORE.pending || [];
  STORE.pending.push(rec);
  safeSave(STORE_FILE, STORE);
}
function removePendingRecord(id) {
  STORE.pending = (STORE.pending || []).filter(p => p.id !== id);
  safeSave(STORE_FILE, STORE);
}
function updatePendingRecordStatus(id, status, extra = {}) {
  STORE.pending = STORE.pending || [];
  for (let i = 0; i < STORE.pending.length; i++) {
    if (STORE.pending[i].id === id) {
      STORE.pending[i].status = status;
      if (extra) STORE.pending[i].outcome = extra;
      STORE.pending[i].closedAt = Date.now();
      break;
    }
  }
  safeSave(STORE_FILE, STORE);
}

// =====================
// checkPostOutcome — FIXED & COMPLETE
// =====================
async function checkPostOutcome(pending, windowSec) {
  try {
    // fetch recent 1m candles to measure price after window
    const resp = await fetchMarketData(
      pending.symbol,
      "1m",
      Math.max(5, Math.ceil(windowSec / 60) + 5)
    );

    const candles = resp?.data || [];
    if (!candles.length) {
      return { success: false, reason: "no_candles", realizedReturn: 0, newPrice: null };
    }

    // use last closed price in fetched candles
    const newPrice = candles.at(-1).close;

    const priceAtSend =
      pending.priceAtDetect ||
      (pending.perTfResults &&
        pending.perTfResults[0] &&
        (pending.perTfResults[0].price ?? null)) ||
      newPrice;

    const movePct =
      priceAtSend !== 0
        ? ((newPrice - priceAtSend) / Math.abs(priceAtSend)) * 100
        : 0;

    const success = pending.side === "Bullish" ? (movePct > 0) : (movePct < 0);

    return {
      success,
      realizedReturn: movePct,
      newPrice
    };
  } catch (e) {
    return {
      success: false,
      reason: e?.message || String(e),
      realizedReturn: 0,
      newPrice: null
    };
  }
}

// =====================
// Public API start/stop
// =====================
let _timers = new Map();

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = async () => {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  if (_timers.has(symbol)) return false;

  // immediate tick then intervals
  const tickFn = async () => { try { await evaluateSymbol(symbol, opts, sendAlert); } catch (e) {} };
  const pendFn = async () => { try { await processAllPending(sendAlert, opts); } catch (e) {} };

  tickFn();
  const mainId = setInterval(tickFn, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  const pendId = setInterval(pendFn, Math.max(8*1000, Math.min(60*1000, Math.floor((opts.confirmCandles || DEFAULTS.confirmCandles) * 15 * 1000))));
  _timers.set(symbol, { mainId, pendId });
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) {
        clearInterval(rec.mainId);
        clearInterval(rec.pendId);
        _timers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _timers.entries()) {
        clearInterval(rec.mainId);
        clearInterval(rec.pendId);
        _timers.delete(s);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function getWatcherState() {
  return {
    running: _timers.size > 0,
    symbols: Array.from(_timers.keys()),
    pending: STORE.pending.slice(-50),
    recent: STORE.recent.slice(-50),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};