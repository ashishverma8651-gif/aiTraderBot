// reversal_watcher_v3_2.js — PART 1 of 3
// Premium v3.2 — ML-gated, cooldown (multi-candle confirmation), feedback loop, improved debounce
// NOTE: This file is split into 3 parts for safe delivery. Combine parts in order to recreate the full file.

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
// Storage & logs
// -------------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ALERT_STORE = path.join(DATA_DIR, "reversal_alerts_v3_2.json");
const WATCHER_LOG = path.join(DATA_DIR, "reversal_watcher_v3_2_log.txt");

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
// Global defaults (tunable)
// -------------------------
const GLOBAL_DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20000,
  minAlertConfidence: 65,
  mlWeight: 0.18,
  debounceSeconds: 180,           // cooldown window for identical key
  confirmationCandles: 3,         // wait N candles (on shortest TF) for confirmation before final alert
  confirmationTF: "1m",           // TF to use for candle confirmation
  requireMLGate: true,            // require ML main to agree (configurable)
  mlAgreementThreshold: 55,       // ML prob threshold that counts as agreement (pct)
  feedbackWindowsSec: [60,300],   // windows to check outcomes
  maxSavedAlerts: 2000,
  allowNeutral: false,            // do not alert on Neutral consensus
  maxAlertsPerHour: 6,            // soft rate limit
  enablePatternBoost: true,
  patternBoostPoints: 45
}, CONFIG.REVERSAL_WATCHER || {});

// -------------------------
// Internal state
// -------------------------
let _watcherTimers = new Map(); // symbol -> intervalId
let _running = false;
let _recentAlerts = safeLoad(ALERT_STORE, { alerts: [], hourly: [] }); // store objects { key, ts, symbol, side, predId, score }

_recentAlerts.alerts = (_recentAlerts.alerts || []).slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
_recentAlerts.hourly = (_recentAlerts.hourly || []).slice(-100);

// helper to record hourly counters (soft rate limit)
function recordHourlyAlert() {
  const now = Date.now();
  _recentAlerts.hourly.push({ ts: now });
  const cutoff = now - (1000 * 60 * 60);
  _recentAlerts.hourly = _recentAlerts.hourly.filter(h => h.ts >= cutoff);
  safeSave(ALERT_STORE, _recentAlerts);
}
function hourlyCount() { return (_recentAlerts.hourly || []).length; }

// -------------------------
// Cheap pattern detectors (last 3 candles)
// -------------------------
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const body = Math.max(1e-6, Math.abs(last.close - last.open));
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  // Hammer-like
  if (GLOBAL_DEFAULTS.enablePatternBoost && lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) {
    out.push({ name: "Hammer", side: "Bullish", strength: Math.min(95, 30 + (lowerWick/body) * 12) });
  }
  // Shooting Star
  if (GLOBAL_DEFAULTS.enablePatternBoost && upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) {
    out.push({ name: "ShootingStar", side: "Bearish", strength: Math.min(95, 30 + (upperWick/body) * 12) });
  }
  // Engulfing
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 60 });

  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 60 });

  // Tweezer top/bottom (simple equality tolerance)
  if (Math.abs(prev.high - last.high) < (Math.max(1, Math.abs(prev.high)) * 0.0005) && last.close < last.open) out.push({ name: "TweezerTop", side: "Bearish", strength: 45 });
  if (Math.abs(prev.low - last.low) < (Math.max(1, Math.abs(prev.low)) * 0.0005) && last.close > last.open) out.push({ name: "TweezerBottom", side: "Bullish", strength: 45 });

  return out;
}

// -------------------------
// TF score builder
// -------------------------
function computeTFScore({ candles = [], ell = null, mlMicro = null, tf = "15m", tfWeight = 1 }) {
  let score = 0;
  const reasons = [];
  const patterns = detectSimplePatternsFromCandles(candles);

  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(90, p.strength || GLOBAL_DEFAULTS.patternBoostPoints);
    score += pscore;
    reasons.push(`pattern:${p.name}(${p.side})`);
  }

  try {
    const rsi = indicators.computeRSI(candles);
    const macd = indicators.computeMACD(candles);
    const atr = indicators.computeATR(candles);
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { score += 6; reasons.push("macd_pos"); }
      else if (macd.hist < 0) { score -= 6; reasons.push("macd_neg"); }
    }
    if (typeof rsi === "number") {
      if (rsi < 30) { score += 6; reasons.push("rsi_oversold"); }
      if (rsi > 70) { score -= 6; reasons.push("rsi_overbought"); }
    }
    if (typeof atr === "number") reasons.push(`atr:${Math.round(atr)}`);
  } catch (e) {
    // indicator failures are non-fatal
  }

  if (ell && typeof ell.sentiment === "number") {
    const s = (ell.sentiment * 10);
    score += s;
    reasons.push(`ell_sent:${ell.sentiment.toFixed(2)}`);
  }

  if (mlMicro && typeof mlMicro.prob === "number") {
    const p = (mlMicro.prob - 50) / 100 * 20; // ±10
    score += p;
    reasons.push(`mlMicro:${mlMicro.label || ""}:${mlMicro.prob}`);
  }

  // clamp raw and normalize
  const raw = Math.max(-100, Math.min(100, score));
  const norm = Math.round((raw + 100) / 2); // 0..100
  const weighted = norm * (tfWeight || 1);

  return { score: norm, weighted, reasons, patterns };
}

// -------------------------
// Consensus builder (ML main can nudge)
// -------------------------
function buildConsensus(perTfResults = [], weights = GLOBAL_DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTfResults) {
    const w = weights[r.tf] || 0.1;
    sumW += w;
    sumS += (r.score || 0) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  // ML main boost/shrink
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    // convert mlMain.prob (0..100) into -10..10 influence scaled by mlWeight
    boost = ((mlMain.prob - 50) / 50) * (GLOBAL_DEFAULTS.mlWeight * 100 / 2); // approximate
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";

  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlMainLabel: mlMain?.label || null };
}

// -------------------------
// TP/SL builder (Elliott preferred, ATR fallback)
// -------------------------
function makeTPsAndSLs({ ellSummary = null, ellTargets = [], atr = 0, price = 0 }) {
  const tps = [];
  const sls = [];
  try {
    if (Array.isArray(ellTargets) && ellTargets.length) {
      for (const t of ellTargets.slice(0,4)) {
        const tp = Number(t.tp || t.target || t.price || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
    if ((!tps || tps.length === 0) && ellSummary && ellSummary.support && ellSummary.resistance) {
      tps.push({ source: "ElliottZoneHi", tp: ellSummary.resistance, confidence: 40 });
      tps.push({ source: "ElliottZoneLo", tp: ellSummary.support, confidence: 40 });
    }
    if (!tps || tps.length === 0) {
      // fallback to ATR multiples
      tps.push({ source: "ATR_x2", tp: Number((price + Math.max(1, atr) * 2).toFixed(2)), confidence: 30 });
      tps.push({ source: "ATR_x4", tp: Number((price + Math.max(1, atr) * 4).toFixed(2)), confidence: 25 });
    }

    // SLs, both sides for reference
    const slLong = Number((price - Math.max(1, atr) * 2).toFixed(2));
    const slShort = Number((price + Math.max(1, atr) * 2).toFixed(2));
    sls.push({ side: "LONG", sl: slLong });
    sls.push({ side: "SHORT", sl: slShort });

  } catch (e) {
    // ignore
  }
  return { tps, sls };
}

// -------------------------
// Debounce + cooldown helpers (improved key + rate-limit)
// -------------------------
function makeDebounceKey(symbol, side, perTfResults = []) {
  // deterministic key using tf patterns and rounded scores + price zone
  const patterns = perTfResults
    .flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`))
    .sort()
    .join("|") || "NOPAT";

  const scores = perTfResults
    .map(r => `${r.tf}:${Math.round(r.score||0)}`)
    .sort()
    .join("|") || "NOSCORE";

  const priceZone = perTfResults[0] && perTfResults[0].price ? Math.round(perTfResults[0].price / 10) : "P0";

  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}

function cleanupRecentAlerts() {
  const now = Date.now();
  const cutoff = now - (GLOBAL_DEFAULTS.debounceSeconds * 1000);
  _recentAlerts.alerts = (_recentAlerts.alerts || []).filter(a => a.ts >= cutoff);
}

function recentlyAlerted(key) {
  cleanupRecentAlerts();
  return (_recentAlerts.alerts || []).some(a => a.key === key);
}

function recordAlert(key, meta = {}) {
  _recentAlerts.alerts = _recentAlerts.alerts || [];
  _recentAlerts.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  _recentAlerts.alerts = _recentAlerts.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
  try { safeSave(ALERT_STORE, _recentAlerts); } catch (e) {}
  // also record hourly count for soft rate limit
  recordHourlyAlert();
}

// -------------------------
// Outcome check (feedback) — records into ML module
// -------------------------
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec) {
  try {
    const resp = await fetchMarketData(symbol, "1m", Math.max(5, Math.ceil(windowSec/60)+2));
    const newPrice = resp?.price || priceAtSend;
    const movedUp = newPrice > priceAtSend;
    // for bearish side, success if price falls
    const success = (side === "Bullish") ? movedUp : (!movedUp);
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100 : null;

    if (predId && typeof recordOutcome === "function") {
      try {
        recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice });
      } catch (e) {
        // ignore
      }
    }

    return { ok: true, predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Confirmations: wait N candles logic
// - This function samples the confirmationTF (e.g. 1m) and ensures
//   the reversal side still holds after 'confirmationCandles' closes.
// - Returns true if confirmed, false if invalidated or timed-out
// -------------------------
async function confirmAcrossCandles(symbol, side, confirmationCandles = GLOBAL_DEFAULTS.confirmationCandles, confirmationTF = GLOBAL_DEFAULTS.confirmationTF, timeoutMs = 20000) {
  // timeoutMs: max time to wait for this check (overall)
  const start = Date.now();
  try {
    // read last confirmationCandles+1 candles to check progression
    // we'll poll until we have enough closed candles or timeout
    while ((Date.now() - start) < timeoutMs) {
      const resp = await fetchMarketData(symbol, confirmationTF, confirmationCandles + 2);
      const candles = resp?.data || [];
      if (!Array.isArray(candles) || candles.length < confirmationCandles + 1) {
        // wait a bit and retry (non-blocking)
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      // take last N closed candles (exclude currently open candle)
      // candles assumed oldest->newest
      const closed = candles.slice(- (confirmationCandles + 1), -1); // last N closed
      if (closed.length < confirmationCandles) {
        await new Promise(r => setTimeout(r, 800));
        continue;
      }

      // Evaluate whether candles support the 'side'
      // simple heuristic: majority of closed candles move in expected direction OR have confirming patterns
      let supportCount = 0;
      for (const c of closed) {
        const movedUp = (c.close > c.open);
        if (side === "Bullish" && movedUp) supportCount++;
        if (side === "Bearish" && !movedUp) supportCount++;
        // also check long lower/upper wicks as supportive signals
        const body = Math.max(1e-6, Math.abs(c.close - c.open));
        const upperWick = c.high - Math.max(c.close, c.open);
        const lowerWick = Math.min(c.close, c.open) - c.low;
        if (side === "Bullish" && lowerWick > body * 1.6) supportCount++;
        if (side === "Bearish" && upperWick > body * 1.6) supportCount++;
      }

      // require at least >50% support (strict) or custom rule
      const supportNeeded = Math.ceil(closed.length * 0.6);
      if (supportCount >= supportNeeded) return { confirmed: true, supportCount, closed: closed.map(c => ({ o: c.open, c: c.close })) };
      else return { confirmed: false, supportCount, closed: closed.map(c => ({ o: c.open, c: c.close })) };
    }
    return { confirmed: false, reason: "timeout" };
  } catch (e) {
    return { confirmed: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Main evaluateSymbol (part 1) — begins the per-symbol tick
// Note: this function continues in Part-2 where alert composition & send happen
// -------------------------
export async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || GLOBAL_DEFAULTS.tfs;
    // fetch multi-timeframe candles/prices
    const multi = await fetchMultiTF(symbol, tfs);

    // try main ML prediction (15m) best-effort
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];

    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      // ell
      let ell = null;
      try { const er = await analyzeElliott(candles); ell = (er && er.ok) ? er : null; } catch (e) { ell = null; }

      // micro ML nudges for 1m/5m
      let mlMicro = null;
      if (["1m","5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || 60); } catch (e) { mlMicro = null; }
      }

      const weight = (opts.weights && opts.weights[tf]) ? opts.weights[tf] : (GLOBAL_DEFAULTS.weights[tf] || 0.1);
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

    // trend detection (use higher TF if available)
    let trend = "FLAT";
    try {
      const hc = multi["1h"] || multi["15m"];
      const closes = (hc?.data || []).map(c => c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        if (last > prev) trend = "UP";
        else if (last < prev) trend = "DOWN";
      }
    } catch (e) {}

    // continue in Part-2 -> decision logic, gating, confirmation, send, feedback scheduling.
    return { status: "ready", symbol, consensus, perTfResults, mlMain, trend };

  } catch (e) {
    log("evaluateSymbol error (part1):", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// End of Part-1

// reversal_watcher_part2.js — Part 2 (Confirmed Alerts + ML gating + cooldown + feedback)
// Replaces previous reversal_watcher. Keep existing auxiliary modules (ml_module_v8_6, elliott_module, utils, etc.)

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

// Storage
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ALERT_STORE = path.join(DATA_DIR, "reversal_alerts.json");        // historical alerts + pending
const WATCHER_LOG = path.join(DATA_DIR, "reversal_watcher_log.txt");

// Safe JSON helpers
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

// Config / defaults (merge with CONFIG.REVERSAL_WATCHER)
const GLOBAL_DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20000,
  patternScoreBoost: 50,
  minAlertConfidence: 65,
  mlWeight: 0.18,
  requireVolumeConfirm: false,
  volumeMultiplierThreshold: 1.0,
  debounceSeconds: 120,
  feedbackWindowsSec: [60, 300],
  maxSavedAlerts: 2000,

  // New confirmation settings:
  confirmCandles: 3,            // number of subsequent candles to observe for confirmation
  confirmTfToCheck: "1m",       // which TF to use for confirmation monitoring (must be among tfs)
  mlGateMinProb: 55,            // if ML main prob < this, do not alert
  microMlGateDelta: 2,          // require micro ML average move >= this percent to boost
  cooldownAfterConfirmSec: 300, // after a confirmed alert, avoid same-key alerts for this many seconds
}, CONFIG.REVERSAL_WATCHER || {});

// Internal state
let _watcherTimers = new Map();
let _running = false;
let _store = safeLoad(ALERT_STORE, { alerts: [], pending: [] });
// normalize arrays
_store.alerts = Array.isArray(_store.alerts) ? _store.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts) : [];
_store.pending = Array.isArray(_store.pending) ? _store.pending : [];

// Helpers: patterns (kept intentionally small and cheap)
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const body = Math.abs(last.close - last.open) || 1;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  if (lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) {
    out.push({ name: "Hammer", side: "Bullish", strength: Math.min(90, 40 + (lowerWick/body)*10) });
  }
  if (upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) {
    out.push({ name: "ShootingStar", side: "Bearish", strength: Math.min(90, 40 + (upperWick/body)*10) });
  }
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 60 });
  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 60 });

  return out;
}

// Per-TF scoring (similar to your previous computeTFScore but returns structured reasons)
function computeTFScore({ candles, ell, mlMicro, tf, tfWeight }) {
  let score = 0;
  const reasons = [];
  const patterns = detectSimplePatternsFromCandles(candles);
  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(80, p.strength || GLOBAL_DEFAULTS.patternScoreBoost);
    score += pscore;
    reasons.push(`pattern:${p.name}(${p.side})`);
  }

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

  if (ell && typeof ell.sentiment === "number") {
    const s = ell.sentiment * 10;
    score += s;
    reasons.push(`ell_sent:${ell.sentiment.toFixed(2)}`);
  }

  if (mlMicro && typeof mlMicro.prob === "number") {
    const p = (mlMicro.prob - 50) / 100 * 20;
    score += p;
    reasons.push(`ml:${mlMicro.label || ""}:${mlMicro.prob}`);
  }

  let raw = Math.max(-100, Math.min(100, score));
  const norm = Math.round((raw + 100) / 2);
  const weighted = norm * (tfWeight || 1);

  return { score: norm, weighted, reasons, patterns };
}

// Consensus builder (same idea)
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
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    boost = ((mlMain.prob - 50) / 100) * (GLOBAL_DEFAULTS.mlWeight * 100);
  }
  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 75 ? "STRONG" : final >= 60 ? "MODERATE" : final >= 45 ? "WEAK" : "NONE";
  return { final, label, breakdown, mlBoost: boost };
}

// Debounce key builder — deterministic & includes price zone + patterns
function makeDebounceKey(symbol, side, perTfResults) {
  const patterns = perTfResults
    .flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`))
    .sort()
    .join("|") || "NOPAT";

  const scores = perTfResults
    .map(r => `${r.tf}:${Math.round(r.score)}`)
    .sort()
    .join("|") || "NOSCORE";

  const priceZone = perTfResults[0] && perTfResults[0].price ? Math.round(perTfResults[0].price / 10) : "P0";

  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}

// recently alerted / record (uses _store.alerts and _store.pending)
function pruneStore() {
  _store.alerts = (_store.alerts || []).slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
  _store.pending = (_store.pending || []).filter(p => p && p.ts && (Date.now() - p.ts) < (24 * 60 * 60 * 1000)); // keep pending < 24h
}
function recentlyAlerted(key) {
  const now = Date.now();
  const cutoff = now - (GLOBAL_DEFAULTS.debounceSeconds * 1000);
  _store.alerts = (_store.alerts || []).filter(a => a.ts >= cutoff);
  return (_store.alerts || []).some(a => a.key === key);
}
function recordSentAlert(key, meta = {}) {
  _store.alerts = _store.alerts || [];
  _store.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  _store.alerts = _store.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
  safeSave(ALERT_STORE, _store);
}

// Pending alerts: structure
// { id, key, symbol, side, createdAt, ts, confirmedCandlesObserved, requiredCandles, priceAtDetect, perTfResults, predId, status }
// status: "pending" -> "confirmed" -> "sent" -> "done"/"failed"
function addPendingAlert(p) {
  _store.pending = _store.pending || [];
  _store.pending.push(Object.assign({ status: "pending", ts: Date.now() }, p));
  safeSave(ALERT_STORE, _store);
}
function updatePendingAlert(id, patch) {
  _store.pending = _store.pending || [];
  for (let i=0;i<_store.pending.length;i++) {
    if (_store.pending[i].id === id) {
      _store.pending[i] = Object.assign({}, _store.pending[i], patch);
      break;
    }
  }
  safeSave(ALERT_STORE, _store);
}
function removePendingAlert(id) {
  _store.pending = (_store.pending || []).filter(p => p.id !== id);
  safeSave(ALERT_STORE, _store);
}

// Confirm logic: decide if the subsequent candles confirm reversal
function assessConfirmation(side, recentCandles) {
  // recentCandles: array oldest->newest of length >= confirmCandles
  // side: "Bullish" or "Bearish"
  // simple rule: majority of next N candles close in expected direction OR price moved X% in direction
  const N = recentCandles.length;
  let directionalCount = 0;
  let movedPct = 0;
  const start = recentCandles[0];
  const last = recentCandles.at(-1);
  if (!start || !last) return { ok:false, reason:"no_candles" };
  // % move from start.close to last.close
  movedPct = start.close ? ((last.close - start.close) / Math.max(1, Math.abs(start.close))) * 100 : 0;
  for (const c of recentCandles) {
    if (side === "Bullish" && c.close > c.open) directionalCount++;
    if (side === "Bearish" && c.close < c.open) directionalCount++;
  }
  const majority = directionalCount >= Math.ceil(N*0.6); // 60% candles in direction
  // or price move threshold (relative)
  const moveThresholdPct = 0.15; // configurable if you want (0.15%); keep small
  const movedEnough = side === "Bullish" ? (movedPct > moveThresholdPct) : (movedPct < -moveThresholdPct);

  return { ok: majority || movedEnough, directionalCount, movedPct };
}

// Outcome check: once confirmed/sent, we will evaluate after windows; uses recordOutcome if predId present
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec) {
  try {
    const resp = await fetchMarketData(symbol, "1m", Math.max(3, Math.ceil(windowSec / 60) + 2));
    const newPrice = resp?.price ?? priceAtSend;
    const movedUp = newPrice > priceAtSend;
    const success = (side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend)/Math.max(1,Math.abs(priceAtSend))) * 100 : null;
    if (predId && typeof recordOutcome === "function") {
      try { recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice }); } catch (e) {}
    }
    return { ok: true, predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Main evaluation tick
async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || GLOBAL_DEFAULTS.tfs;
    // fetch multi-TF
    const multi = await fetchMultiTF(symbol, tfs);

    // ML main (15m) gating (best-effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];

    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      // ell for TF (cheap)
      let ell = null;
      try { const er = await analyzeElliott(candles); ell = er && er.ok ? er : null; } catch(e){ ell = null; }

      // micro ML for 1m/5m
      let mlMicro = null;
      if (["1m","5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || 60); } catch (e) { mlMicro = null; }
      }

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

    const consensus = buildConsensus(perTfResults, opts.weights || GLOBAL_DEFAULTS.weights, mlMain);

    // quick trend (1h or 15m fallback)
    let trend = "FLAT";
    try {
      const hc = multi["1h"] || multi["15m"];
      const closes = (hc?.data || []).map(c => c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        if (last > prev) trend = "UP";
        else if (last < prev) trend = "DOWN";
      }
    } catch(e){}

    const finalScore = consensus.final;

    // ML gating: if mlMain exists and is too neutral/contradictory, skip
    if (mlMain && typeof mlMain.prob === "number") {
      if (mlMain.prob < (opts.mlGateMinProb || GLOBAL_DEFAULTS.mlGateMinProb) && finalScore < 95) {
        // low ML prob and not super-high consensus — skip raising pending
        log("ML gate blocked candidate (mlMain prob too low)", symbol, "mlProb:", mlMain.prob, "consensus:", finalScore);
        return { alerted: false, reason: "ml_gate", finalScore, mlMain };
      }
    }

    // candidate detection threshold to start *pending* confirmation
    if (finalScore >= (opts.pendingThreshold || (GLOBAL_DEFAULTS.minAlertConfidence - 5))) {
      // decide side by pattern majority or mlMain
      const bullCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
      const bearCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
      let side = "Bullish";
      if (bullCount > bearCount) side = "Bullish";
      else if (bearCount > bullCount) side = "Bearish";
      else if (mlMain && mlMain.label) side = mlMain.label;
      else side = finalScore >= 50 ? "Bullish" : "Bearish";

      // create debounce key
      const key = makeDebounceKey(symbol, side, perTfResults);

      // if recently fully confirmed/sent, skip
      if (recentlyAlerted(key)) {
        log("candidate suppressed by recent alert (debounce)", key, "score:", finalScore);
        return { alerted: false, reason: "debounce_full", key };
      }

      // If already pending similar key, skip double-pending
      const existingPending = (_store.pending || []).find(p => p.key === key && p.status === "pending");
      if (existingPending) {
        log("already pending", key);
        return { alerted: false, reason: "already_pending", key };
      }

      // record prediction via ML storage for later feedback
      let predId = null;
      try {
        predId = await recordPrediction({
          symbol,
          predictedAt: new Date().toISOString(),
          label: side,
          prob: finalScore,
          features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
          meta: { source: "reversal_watcher_part2", mlMain }
        });
      } catch (e) { predId = null; }

      // push pending alert: wait confirmCandles in the confirmation TF
      const pendingId = `pending_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      addPendingAlert({
        id: pendingId,
        key,
        symbol,
        side,
        createdAt: new Date().toISOString(),
        ts: Date.now(),
        confirmedCandlesObserved: 0,
        requiredCandles: opts.confirmCandles || GLOBAL_DEFAULTS.confirmCandles,
        confirmTf: opts.confirmTfToCheck || GLOBAL_DEFAULTS.confirmTfToCheck,
        priceAtDetect: perTfResults[0]?.price || 0,
        perTfResults,
        predId,
        status: "pending",
        consensusScore: finalScore
      });

      log("pending alert queued", symbol, side, "key:", key, "pendingId:", pendingId, "needCandles:", opts.confirmCandles || GLOBAL_DEFAULTS.confirmCandles);
      return { alerted: false, reason: "pending", pendingId, key, finalScore };
    }

    return { alerted: false, score: finalScore, reason: "below_threshold" };
  } catch (e) {
    log("evaluateSymbol error:", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// Periodic checker for pending alerts: this reads pending queue and checks confirmation candles
async function processPendingAlerts(sendAlert = null, opts = {}) {
  const pending = Array.isArray(_store.pending) ? _store.pending.slice() : [];
  for (const p of pending) {
    try {
      if (!p || p.status !== "pending") continue;
      // fetch confirmTf candles (we need requiredCandles after p.ts moment)
      const tf = p.confirmTf || (opts.confirmTfToCheck || GLOBAL_DEFAULTS.confirmTfToCheck);
      // fetch last requiredCandles candles
      const len = p.requiredCandles || GLOBAL_DEFAULTS.confirmCandles;
      const resp = await fetchMarketData(p.symbol, tf, len + 5);
      const candles = (resp?.data || []);
      if (!candles || candles.length < len) {
        // not enough candles yet; skip
        continue;
      }
      // take the last `len` candles
      const recent = candles.slice(-len);
      const conf = assessConfirmation(p.side, recent);
      if (conf.ok) {
        // confirmed -> send alert (if ML gating still ok)
        // Recompute ml micro if available to further reduce false positives
        let mlMicroAvg = null;
        try {
          const microPromises = (p.perTfResults || []).filter(r => r.tf === "1m" || r.tf === "5m").map(async r => {
            if (r.mlMicro) return r.mlMicro;
            try { return await runMicroPrediction(p.symbol, r.tf, opts.microLookback || GLOBAL_DEFAULTS.microLookback || 60); } catch (e){ return null; }
          });
          const microRes = await Promise.all(microPromises);
          const probs = microRes.filter(Boolean).map(m => (m.prob || 50));
          if (probs.length) mlMicroAvg = probs.reduce((a,b)=>a+b,0)/probs.length;
        } catch (e) { mlMicroAvg = null; }

        // small micro ML gating: if average micro prob is strongly opposite, block
        if (mlMicroAvg && p.side === "Bullish" && mlMicroAvg < (50 - (opts.microMlGateDelta || GLOBAL_DEFAULTS.microMlGateDelta))) {
          log("micro-ml blocked confirmed candidate (contradictory micro preds)", p.symbol, p.side, "microAvg:", mlMicroAvg);
          updatePendingAlert(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "micro_ml_block" });
          removePendingAlert(p.id);
          continue;
        }
        if (mlMicroAvg && p.side === "Bearish" && mlMicroAvg > (50 + (opts.microMlGateDelta || GLOBAL_DEFAULTS.microMlGateDelta))) {
          log("micro-ml blocked confirmed candidate (contradictory micro preds)", p.symbol, p.side, "microAvg:", mlMicroAvg);
          updatePendingAlert(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "micro_ml_block" });
          removePendingAlert(p.id);
          continue;
        }

        // Send alert
        const tps = (p.perTfResults && p.perTfResults.length) ? (p.perTfResults[0].ell?.targets || []) : [];
        const atr = (p.perTfResults && p.perTfResults.length) ? indicators.computeATR(p.perTfResults[0].candles || []) : 0;
        const price = p.priceAtDetect || (p.perTfResults && p.perTfResults[0]?.price) || 0;
        // simple TP/SL fallback
        const tpTxt = (tps && tps.length) ? tps.slice(0,3).map(t=>`${t.tp||t.target}`).join(" / ") : `${(price + Math.max(1,atr)*2).toFixed(2)} / ${(price + Math.max(1,atr)*4).toFixed(2)}`;
        const slLong = Number((price - Math.max(1,atr) * 2).toFixed(2));
        const slShort = Number((price + Math.max(1,atr) * 2).toFixed(2));

        const msgLines = [
          `⚡ <b>REVERSED (CONFIRMED)</b> — <b>${p.side}</b>`,
          `Symbol: <b>${p.symbol}</b> | Confidence: <b>${Math.round(p.consensusScore || 0)}%</b>`,
          `PriceAtDetect: ${Number(price).toFixed(2)} | TP(s): ${tpTxt}`,
          `SLs: LONG:${slLong} / SHORT:${slShort}`,
          `Observed: ${conf.directionalCount}/${recent.length} candles in direction | movePct: ${conf.movedPct.toFixed(3)}%`,
          `ID: ${p.predId || "none"}`
        ];
        const text = msgLines.join("\n");

        // send
        try {
          if (typeof sendAlert === "function") {
            await sendAlert(text);
          } else {
            log("Would send confirmed alert:", text);
          }
        } catch (e) {
          log("Error sending confirmed alert:", e?.message || e);
        }

        // record sent alert and update pending->sent
        recordSentAlert(p.key, { symbol: p.symbol, side: p.side, predId: p.predId, score: p.consensusScore });
        updatePendingAlert(p.id, { status: "sent", sentAt: new Date().toISOString() });

        // schedule feedback checks (windows)
        (opts.feedbackWindowsSec || GLOBAL_DEFAULTS.feedbackWindowsSec).forEach((win) => {
          setTimeout(async () => {
            try {
              const outcome = await checkOutcome(p.predId, p.symbol, p.side, price, win);
              log("feedback result", p.symbol, p.side, "win:", win, JSON.stringify(outcome));
              // mark done/failed in pending store
              updatePendingAlert(p.id, { status: outcome.success ? "done" : "failed", closedAt: new Date().toISOString(), outcome });
              // optionally remove pending after record
              setTimeout(()=> removePendingAlert(p.id), 2000);
            } catch (e) {
              log("feedback scheduling error:", e?.message || e);
            }
          }, win * 1000);
        });

        // apply cooldown: avoid sending same-key alerts for cooldownAfterConfirmSec
        const cooldownKey = p.key;
        const cooldownMeta = { symbol: p.symbol, side: p.side, ts: Date.now(), note: "cooldown_after_confirm" };
        recordSentAlert(cooldownKey, cooldownMeta);
      } else {
        // not confirmed: increase observed counter and keep pending (or mark failed after a timeout)
        const observed = (p.confirmedCandlesObserved || 0) + 1;
        updatePendingAlert(p.id, { confirmedCandlesObserved: observed, lastCheck: new Date().toISOString() });
        // if we've observed many windows and never confirmed, mark failed (guard)
        const maxWaitWindows = (opts.maxPendingWaits || 6);
        if (observed >= (p.requiredCandles || GLOBAL_DEFAULTS.confirmCandles) + maxWaitWindows) {
          updatePendingAlert(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "no_confirm" });
          removePendingAlert(p.id);
          log("pending failed (no confirm)", p.id, p.key);
        } else {
          // still pending — leave it
          log("pending still waiting", p.id, "observed", observed, "needed", p.requiredCandles);
        }
      }
    } catch (e) {
      log("processPendingAlerts error:", e?.message || e);
    }
  }
}

// Public API: start/stop
export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_watcherTimers.has(symbol)) {
    log("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, GLOBAL_DEFAULTS, options);
  log("Starting Reversal Watcher PART2 for", symbol, "opts:", JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs, minAlertConfidence: opts.minAlertConfidence }));

  // main tick (candidate detection)
  const tick = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {
      log("Watcher tick error:", e?.message || e);
    }
  };

  // pending processor tick (checks confirmations)
  const pendTick = async () => {
    try {
      await processPendingAlerts(sendAlert, opts);
      pruneStore();
    } catch (e) { log("pendTick exception:", e?.message || e); }
  };

  // start both intervals
  tick(); // immediate candidate run
  const idMain = setInterval(tick, opts.pollIntervalMs || GLOBAL_DEFAULTS.pollIntervalMs);
  // process pending every confirmTf candle length — we use shorter regular interval
  const pendingIntervalMs = Math.max(5*1000, (opts.pendingCheckIntervalMs || 15 * 1000));
  const idPend = setInterval(pendTick, pendingIntervalMs);

  _watcherTimers.set(symbol, { idMain, idPend });
  _running = true;
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _watcherTimers.get(symbol);
      if (rec) {
        if (rec.idMain) clearInterval(rec.idMain);
        if (rec.idPend) clearInterval(rec.idPend);
        _watcherTimers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _watcherTimers.entries()) {
        if (rec.idMain) clearInterval(rec.idMain);
        if (rec.idPend) clearInterval(rec.idPend);
        _watcherTimers.delete(s);
      }
    }
    _running = _watcherTimers.size > 0;
    log("Stopped watcher for", symbol || "ALL");
    return true;
  } catch (e) { log("stopReversalWatcher error:", e?.message || e); return false; }
}

// debug / metrics
export function getWatcherState() {
  return {
    running: _running,
    symbols: Array.from(_watcherTimers.keys()),
    pending: (_store.pending || []).slice(-50),
    recentAlerts: (_store.alerts || []).slice(-50),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};