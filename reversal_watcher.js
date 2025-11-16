// reversal_watcher.js — ULTRA-PRO (vA) — Multi-TF + ML(v8.6) + MicroML + Live Alerts + Feedback
// Drop-in for aiTraderBot.js usage of startReversalWatcher / stopReversalWatcher.
//
// Depends on:
//  ./config.js
//  ./utils.js (fetchMarketData, fetchMultiTF)
//  ./core_indicators.js (computeRSI, computeMACD, computeATR, analyzeVolume optional)
//  ./elliott_module.js (analyzeElliott)
//  ./ml_module_v8_6.js (runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy)
//
// Persistence file: ./cache/reversal_watcher_store.json

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
// Storage & Defaults
// =====================
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");

function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    const s = fs.readFileSync(fp, "utf8") || "{}";
    return JSON.parse(s);
  } catch (e) {
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error("safeSave error:", e && e.message);
    return false;
  }
}

const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 52,         // relaxed pending threshold (0..100)
  minAlertConfidence: 55,       // minimum to send final (if used)
  confirmCandles: 2,
  confirmationTF: "1m",
  confirmTimeoutMs: 30 * 1000,
  debounceSeconds: 60,
  cooldownAfterConfirmSec: 600,
  maxSavedAlerts: 2000,
  mlMainGateMinProb: 55,        // block if ML strongly contradictory
  microMlGateDeltaPct: 6,
  maxPendingAgeMs: 24 * 60 * 60 * 1000,
  maxAlertsPerHour: 500,
  volumeMultiplier: 0.8,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2,4],
  allowNeutral: true,
  feedbackWindowsSec: [60, 300],
  liveMicroThresholdPct: 60,    // micro-ML percent to trigger live immediate alert (0-100)
  liveMicroCooldownSec: 30
}, CONFIG.REVERSAL_WATCHER || {});

let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// =====================
// Helpers: housekeeping
// =====================
function nowTs() { return Date.now(); }
function recordHourly() {
  const now = nowTs();
  STORE.hourly.push(now);
  const cutoff = now - (60*60*1000);
  STORE.hourly = STORE.hourly.filter(t => t >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() { return STORE.hourly.length; }

function pruneRecent() {
  const cutoff = nowTs() - (DEFAULTS.debounceSeconds * 1000);
  STORE.recent = (STORE.recent || []).filter(r => r.ts >= cutoff).slice(-DEFAULTS.maxSavedAlerts);
  safeSave(STORE_FILE, STORE);
}
function addRecent(key) {
  STORE.recent = STORE.recent || [];
  STORE.recent.push({ key, ts: nowTs() });
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
  recordHourly();
  safeSave(STORE_FILE, STORE);
}
function recentlyAlerted(key) {
  pruneRecent();
  return (STORE.recent || []).some(r => r.key === key);
}

// =====================
// Pattern detection (simple but robust)
// =====================
function detectPatterns(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return [];
  const last = candles.at(-1), prev = candles.at(-2), prev2 = candles.at(-3);
  const patt = [];
  const body = Math.max(1e-8, Math.abs(last.close - last.open));
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;

  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open) patt.push({ name: "Hammer", side: "Bullish", strength: 70 });
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open) patt.push({ name: "ShootingStar", side: "Bearish", strength: 70 });

  // Engulfing
  try {
    if (prev && prev2) {
      if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close)
        patt.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
      if (prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open)
        patt.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });
    }
  } catch(e){}

  // Tweezer approx
  if (prev && Math.abs(prev.high - last.high) / Math.max(1, Math.abs(prev.high)) < 0.0006 && last.close < last.open) patt.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (prev && Math.abs(prev.low - last.low) / Math.max(1, Math.abs(prev.low)) < 0.0006 && last.close > last.open) patt.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  // Doji
  if (body / Math.max(1e-8, (last.high - last.low)) < 0.2) patt.push({ name: "Doji", side: "Neutral", strength: 30 });

  // Morning/Evening (crude)
  try {
    if (prev2 && prev && last) {
      if (prev2.close < prev2.open && last.close > last.open && last.close > prev.close) patt.push({ name: "MorningStar", side: "Bullish", strength: 72 });
      if (prev2.close > prev2.open && last.close < last.open && last.close < prev.close) patt.push({ name: "EveningStar", side: "Bearish", strength: 72 });
    }
  } catch(e){}

  return patt;
}

// =====================
// TF scoring
// =====================
function computeTFScore({ candles = [], tf = "15m", weight = 1 }) {
  const out = { score: 50, reasons: [], patterns: [] };
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength/2 : -p.strength/2);
    out.reasons.push(`pattern:${p.name}:${p.side}`);
  }

  try {
    const rsi = (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : null;
    const macd = (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : null;
    const atr = (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : null;

    const lastVol = candles.at(-1).vol ?? candles.at(-1).v ?? candles.at(-1).volume ?? 0;
    const volWindow = Math.min(20, candles.length);
    const avgVol = candles.slice(-volWindow).reduce((s,c)=> s + (c.vol ?? c.v ?? c.volume ?? 0), 0) / Math.max(1,volWindow);

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
      if (lastVol < avgVol * 0.6) { out.score -= 3; out.reasons.push("vol_drop"); }
    }
  } catch(e){ /* ignore indicator failures */ }

  out.score = Math.max(0, Math.min(100, Math.round(out.score)));
  // apply weight (weights should be <=1 ideally)
  out.score = Math.round(out.score * (weight || 1));
  return out;
}

// =====================
// Multi-TF consensus builder (returns 0..100)
// =====================
function buildConsensus(perTf, weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTf) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += (r.score ?? 50) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    // mlMain.prob is percent 0..100; scale to [-10..10]
    boost = ((mlMain.prob - 50) / 50) * 8;
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  return { final, breakdown, mlBoost: Math.round(boost*100)/100 };
}

// =====================
// Targets & SL builder
// =====================
function buildTargets({ ellObj = null, price = 0, atr = 0 }) {
  const tps = [];
  if (ellObj && Array.isArray(ellObj.targets) && ellObj.targets.length) {
    for (const t of ellObj.targets.slice(0,3)) {
      const tpv = Number(t.tp || t.target || t.price || 0);
      if (tpv) tps.push({ source: "Elliott", tp: tpv, confidence: t.confidence || 50 });
    }
  }
  if (!tps.length) {
    const p = Number(price) || 0;
    const a = Math.max(1, atr || 1);
    for (const m of DEFAULTS.tpAtrMultipliers) tps.push({ source: `ATR_x${m}`, tp: Number((p + a * m).toFixed(2)), confidence: 30 });
  }
  const sls = [
    { side: "LONG", sl: Number((price - (atr || 1) * DEFAULTS.slAtrMultiplier).toFixed(2)) },
    { side: "SHORT", sl: Number((price + (atr || 1) * DEFAULTS.slAtrMultiplier).toFixed(2)) }
  ];
  return { tps, sls };
}

// =====================
// Debounce keys
// =====================
function makeKey(symbol, side, patternName, price) {
  const bucket = Math.round((price || 0) / (Math.max(1, Math.abs(price)) * 0.002 + 1));
  return `${symbol}_${side}_${patternName}_${bucket}`;
}

// =====================
// Confirmation routine
// =====================
async function confirmPending(pending, opts = {}) {
  try {
    const tf = pending.confirmationTF || opts.confirmationTF || DEFAULTS.confirmationTF;
    const req = pending.requiredCandles || opts.confirmCandles || DEFAULTS.confirmCandles;
    const resp = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = (resp && Array.isArray(resp.data)) ? resp.data : [];
    if (!candles || candles.length < req + 1) return { ok:false, reason:"not_enough_candles" };
    // closed candles exclude current open
    const closed = candles.slice(-(req + 1), -1);
    if (closed.length < req) return { ok:false, reason:"not_enough_closed" };
    let support = 0;
    for (const c of closed) {
      const movedUp = c.close > c.open;
      if (pending.side === "Bullish" && movedUp) support++;
      if (pending.side === "Bearish" && !movedUp) support++;
      const body = Math.abs(c.close - c.open) || 1;
      const lower = Math.min(c.open, c.close) - c.low;
      const upper = c.high - Math.max(c.open, c.close);
      if (pending.side === "Bullish" && lower > body * 1.6) support++;
      if (pending.side === "Bearish" && upper > body * 1.6) support++;
    }
    const needed = Math.ceil(closed.length * 0.6);
    const ok = support >= needed;
    const start = closed[0].close;
    const last = closed.at(-1).close;
    const movedPct = start ? ((last - start) / Math.max(1, Math.abs(start))) * 100 : 0;
    return { ok, support, needed, movedPct, closedLast: closed.at(-1) };
  } catch (e) {
    return { ok:false, reason: e?.message || String(e) };
  }
}

// =====================
// checkPostOutcome: used after confirmation to evaluate outcome after windowSec
// =====================
async function checkPostOutcome(pending, windowSec) {
  try {
    const resp = await fetchMarketData(pending.symbol, "1m", Math.max(3, Math.ceil(windowSec/60) + 2));
    const newPrice = resp?.price ?? null;
    const priceAtSend = pending.priceAtDetect || (pending.perTfResults && pending.perTfResults[0]?.price) || 0;
    if (newPrice === null) return { ok:false, error:"no_price" };
    const movedUp = newPrice > priceAtSend;
    const success = (pending.side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100 : null;
    return { ok:true, predId: pending.predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// =====================
// Pending store helpers
// =====================
function addPendingRecord(rec) {
  STORE.pending = STORE.pending || [];
  STORE.pending.push(rec);
  safeSave(STORE_FILE, STORE);
}
function removePendingRecord(id) {
  STORE.pending = (STORE.pending || []).filter(p => p.id !== id);
  safeSave(STORE_FILE, STORE);
}
function updatePendingRecord(id, patch = {}) {
  STORE.pending = STORE.pending || [];
  for (let i=0;i<STORE.pending.length;i++) {
    if (STORE.pending[i].id === id) {
      STORE.pending[i] = Object.assign({}, STORE.pending[i], patch);
      break;
    }
  }
  safeSave(STORE_FILE, STORE);
}

// =====================
// MAIN evaluateSymbol: detect -> pending -> preview alert -> record pred
// =====================
async function evaluateSymbol(symbol, opts = {}, sendAlert = async ()=>{}) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    // fetch multi-TF
    const multi = await fetchMultiTF(symbol, tfs);
    // run ML main (best-effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch(e){ mlMain = null; }
    // run micro ML (fast) for live nudges
    let micro = null;
    try { micro = await runMicroPrediction(symbol, "micro"); } catch(e){ micro = null; }

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (typeof entry.price === "number" && entry.price) ? entry.price : (candles.at(-1)?.close ?? 0);
      const weight = opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1;
      const res = computeTFScore({ candles, tf, weight });
      perTfResults.push({ tf, score: res.score, reasons: res.reasons, patterns: res.patterns, price, candles });
    }

    // consensus
    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    // quick gate
    if (finalScore < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      // but still allow micro fast alert if strong micro signal
      if (micro && typeof micro.prob === "number" && (micro.prob >= (opts.liveMicroThresholdPct || DEFAULTS.liveMicroThresholdPct))) {
        // send fast micro alert
        const mlLabel = micro.label || "Neutral";
        const msg = `⚡ <b>MICRO-ML NUDGE</b> — ${mlLabel}\nSym: <b>${symbol}</b> | Prob: ${Number(micro.prob).toFixed(2)}%\nFast micro model indicates quick ${mlLabel} move.`;
        try { await sendAlert(msg); } catch(e) {}
        // apply micro cooldown (store as recent)
        const keym = makeKey(symbol, mlLabel, "micro", perTfResults[0]?.price || 0);
        addRecent(keym);
        return { alerted: true, type: "micro_nudge" };
      }
      return { alerted: false, reason: "below_threshold", score: finalScore };
    }

    // decide majority side from patterns and scores
    let bull = 0, bear = 0;
    for (const r of perTfResults) {
      for (const p of (r.patterns || [])) {
        if (p.side === "Bullish") bull++;
        if (p.side === "Bearish") bear++;
      }
      // also use score tilt
      if ((r.score || 50) >= 60) bull += 0.5;
      if ((r.score || 50) <= 40) bear += 0.5;
    }
    let side = "Bullish";
    if (bear > bull) side = "Bearish";
    else if (bull === bear) {
      if (mlMain && typeof mlMain.prob === "number") side = (mlMain.prob >= 50) ? "Bullish" : "Bearish";
    }

    const topPattern = perTfResults.flatMap(r => r.patterns || [])[0] || { name: "Pattern", side };
    const priceRef = perTfResults[0]?.price ?? 0;
    const key = makeKey(symbol, side, topPattern.name, priceRef);

    // rate-limits & debounce
    if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };
    if (hourlyCount() >= (opts.maxAlertsPerHour ?? DEFAULTS.maxAlertsPerHour)) return { alerted: false, reason: "rate_limit_hour" };

    // ML gating (relaxed): if mlMain strongly opposite -> skip
    if (mlMain && typeof mlMain.prob === "number") {
      const mlProb = mlMain.prob; // 0..100
      const mlSide = mlProb > 55 ? "Bullish" : mlProb < 45 ? "Bearish" : "Neutral";
      if (mlSide !== "Neutral" && mlSide !== side && (mlProb >= (opts.mlMainGateMinProb ?? DEFAULTS.mlMainGateMinProb))) {
        return { alerted: false, reason: "ml_contradict", mlProb, side };
      }
    }

    // create pending
    const id = `pend_${Date.now()}_${Math.floor(Math.random()*9000)}`;
    const pending = {
      id, key, symbol, side, pattern: topPattern.name, createdAt: Date.now(),
      priceAtDetect: priceRef, perTfResults, predId: null, status: "pending",
      requiredCandles: opts.confirmCandles ?? DEFAULTS.confirmCandles,
      confirmationTF: opts.confirmationTF ?? DEFAULTS.confirmationTF,
      consensusScore: finalScore
    };

    // record prediction
    try {
      pending.predId = await recordPrediction({
        symbol,
        predictedAt: new Date().toISOString(),
        label: side,
        prob: finalScore,
        features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
        meta: { source: "reversal_watcher_ultraA" }
      });
    } catch(e) { pending.predId = null; }

    addPendingRecord(pending);

    // preview / pending alert
    const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
    let ell = null;
    try { ell = await analyzeElliott(perTfResults[0].candles); } catch(e) { ell = null; }
    const targets = buildTargets({ ellObj: ell && ell.ok ? ell : null, price: priceRef, atr });

    const preview = [
      `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
      `Sym: <b>${symbol}</b> | Pattern: ${pending.pattern} | Score: <b>${Math.round(finalScore)}%</b>`,
      `Price: ${Number(priceRef).toFixed(2)} | TF-weights: ${JSON.stringify(opts.weights || DEFAULTS.weights)}`,
      `Top TP(s): ${targets.tps.slice(0,2).map(t => `${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
      `SLs: LONG:${targets.sls.find(s => s.side === "LONG")?.sl || "n/a"} | SHORT:${targets.sls.find(s => s.side === "SHORT")?.sl || "n/a"}`,
      `Waiting for ${pending.requiredCandles} x ${pending.confirmationTF} candle(s) to confirm...`,
      `ID: ${pending.predId || "none"}`
    ].join("\n");

    try { await sendAlert(preview); } catch(e) { /* ignore */ }

    return { alerted: true, pendingId: id, key, score: finalScore };
  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// =====================
// processAllPending: confirms pending entries and send final alerts
// =====================
async function processAllPending(sendAlert = async ()=>{}, opts = {}) {
  const list = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  const now = Date.now();
  for (const p of list) {
    try {
      // expire
      if (now - (p.createdAt || 0) > (opts.maxPendingAgeMs ?? DEFAULTS.maxPendingAgeMs)) {
        updatePendingRecord(p.id, { status: "expired", closedAt: Date.now() });
        removePendingRecord(p.id);
        continue;
      }

      const conf = await confirmPending(p, opts);
      if (!conf.ok) {
        if (conf.reason === "not_enough_candles" || conf.reason === "not_enough_closed") continue;
        
// invalidated
        try { await sendAlert(`🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\nPattern: ${p.pattern}\nReason: ${conf.reason || "invalidated"}\nID: ${p.predId || "none"}`); } catch(e){}
        if (p.predId) {
          try { await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch(e){}
        }
        updatePendingRecord(p.id, { status: "failed", closedAt: Date.now(), note: conf.reason || "" });
        removePendingRecord(p.id);
        continue;
      }

      // confirmed
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = (p.perTfResults && p.perTfResults[0] && p.perTfResults[0].candles) ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch(e){ ell = null; }
      const targets = buildTargets({ ellObj: ell && ell.ok ? ell : null, price, atr });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Sym: <b>${p.symbol}</b> | Pattern: ${p.pattern} | Confidence: <b>${Math.round(p.consensusScore||0)}%</b>`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${targets.tps.map(t => `${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s => s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s => s.side==='SHORT')?.sl || "n/a"}`,
        `Observed support: ${conf.support}/${conf.needed} | movePct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.predId || "none"}`
      ].join("\n");

      try { await sendAlert(msg); } catch(e) {}

      updatePendingRecord(p.id, { status: "sent", sentAt: Date.now() });
      addRecent(p.key);

      // schedule feedback windows
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            if (outcome.ok) {
              updatePendingRecord(p.id, { status: outcome.success ? "done" : "failed", closedAt: Date.now(), outcome });
              if (p.predId) {
                try { await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch(e){}
              }
            } else {
              updatePendingRecord(p.id, { status: "feedback_error", closedAt: Date.now(), note: outcome.error || "no_data" });
            }
          } catch(e){}
          // cleanup small delay
          setTimeout(()=> removePendingRecord(p.id), 2000);
        }, win * 1000);
      });

    } catch (e) {
      // continue loop on single failure
      // console.error("pending process error", e && e.message);
    }
  }
}

// =====================
// Live micro-ML monitor: separate fast check to emit intrabar micro alerts
// (optional, fires independent micro nudges) 
// =====================
let _microCooldowns = new Map(); // symbol -> lastTs

async function microMonitor(symbol, sendAlert = async ()=>{}, opts = {}) {
  try {
    const micro = await runMicroPrediction(symbol, "fast");
    if (!micro) return;
    const prob = (typeof micro.prob === "number") ? micro.prob : (micro.prob ?? 0);
    const label = micro.label || "Neutral";
    const threshold = opts.liveMicroThresholdPct ?? DEFAULTS.liveMicroThresholdPct;
    const last = _microCooldowns.get(symbol) || 0;
    if (prob >= threshold && (Date.now() - last) > ((opts.liveMicroCooldownSec ?? DEFAULTS.liveMicroCooldownSec) * 1000)) {
      const msg = `⚡ <b>LIVE MICRO ALERT</b> — ${label}\nSym: <b>${symbol}</b> | Prob: ${Number(prob).toFixed(2)}%\nMicro-ML fast model expects a quick ${label} move.`;
      try { await sendAlert(msg); } catch(e){}
      _microCooldowns.set(symbol, Date.now());
      // record a brief recent entry to debounce
      addRecent(makeKey(symbol, label, "micro_live", 0));
    }
  } catch(e){}
}

// =====================
// Public API: start/stop watcher
// =====================
let _timers = new Map(); // symbol -> { mainId, pendingId, microId }
let _running = false;

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = async ()=>{}) {
  if (_timers.has(symbol)) return false;
  const opts = Object.assign({}, DEFAULTS, options || {});
  // main scan interval
  const tickFn = async () => {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch(e) {}
  };
  // pending processor
  const pendFn = async () => {
    try { await processAllPending(sendAlert, opts); } catch(e) {}
  };
  // micro monitor
  const microFn = async () => {
    try { await microMonitor(symbol, sendAlert, opts); } catch(e) {}
  };

  // immediate run then intervals
  tickFn();
  const mainId = setInterval(tickFn, Math.max(1000, opts.pollIntervalMs || DEFAULTS.pollIntervalMs));
  // pending processor every 10-20s
  const pendingInterval = Math.max(7*1000, Math.min(30*1000, (opts.confirmCandles || DEFAULTS.confirmCandles) * 12000));
  const pendingId = setInterval(pendFn, pendingInterval);
  // micro monitor every 7-12s
  const microId = setInterval(microFn, opts.microPollMs || 8000);

  _timers.set(symbol, { mainId, pendingId, microId });
  _running = true;
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) {
        clearInterval(rec.mainId);
        clearInterval(rec.pendingId);
        clearInterval(rec.microId);
        _timers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _timers.entries()) {
        clearInterval(rec.mainId);
        clearInterval(rec.pendingId);
        clearInterval(rec.microId);
        _timers.delete(s);
      }
    }
    _running = _timers.size > 0;
    return true;
  } catch(e){ return false; }
}

export function getWatcherState() {
  return {
    running: _running,
    symbols: Array.from(_timers.keys()),
    pending: (STORE.pending || []).slice(-50),
    recent: (STORE.recent || []).slice(-50),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

