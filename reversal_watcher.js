// reversal_watcher.js — FULL PATCHED (patterns, volume, multi-TF, micro-ML live alerts, confirmation, feedback)
// Compatible with utils.js exports: fetchMarketData, fetchMultiTF, nowLocal
// Depends on: ./config.js, ./utils.js, ./core_indicators.js, ./elliott_module.js, ./ml_module_v8_6.js
//
// Exports: startReversalWatcher(symbol, options, sendAlert), stopReversalWatcher(symbol), getWatcherState(), default export object
//
// Notes:
// - sendAlert should be an async function (text) that forwards to Telegram (or console).
// - This file intentionally avoids referencing non-existent utils functions (no nowISO).
// - Micro-ML will trigger "LIVE" alerts if micro confidence is high and not contradictory to main gating.
// - Debounce + per-key cooldown + hourly rate limiting to avoid spam.

import fs from "fs";
import path from "path";

import CONFIG from "./config.js";
import { fetchMarketData, fetchMultiTF, nowLocal } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -------------------- Storage / Defaults --------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");

function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; const txt = fs.readFileSync(fp,"utf8") || "{}"; return JSON.parse(txt); }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch (e) { return false; }
}

const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 60,
  minAlertConfidence: 65,
  confirmCandles: 2,
  confirmationTF: "1m",
  confirmTimeoutMs: 30 * 1000,
  debounceSeconds: 180,          // cooldown for identical key (seconds)
  cooldownAfterConfirmSec: 600,  // cooldown after confirm (seconds)
  maxSavedAlerts: 2000,
  mlMainGateMinProb: 55,
  microMlGateProb: 75,           // micro-ML threshold to trigger immediate live alert
  microMlMinDeltaPct: 6,
  maxPendingAgeMs: 24 * 60 * 60 * 1000,
  maxAlertsPerHour: 6,
  volumeMultiplier: 1.0,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2,4],
  allowNeutral: false,
  feedbackWindowsSec: [60, 300],
  enableMicroMLLive: true
}, CONFIG.REVERSAL_WATCHER || {});

// persistent store
let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// -------------------- helpers for store & throttling --------------------
function recordHourly() {
  const now = Date.now();
  STORE.hourly.push(now);
  const cutoff = now - (60*60*1000);
  STORE.hourly = STORE.hourly.filter(t => t >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() { return STORE.hourly.length; }

function pruneRecent() {
  const cutoff = Date.now() - (DEFAULTS.debounceSeconds * 1000);
  STORE.recent = (STORE.recent || []).filter(r => r.ts >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function addRecent(key) {
  STORE.recent = STORE.recent || [];
  STORE.recent.push({ key, ts: Date.now() });
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
  recordHourly();
  safeSave(STORE_FILE, STORE);
}
function recentlyAlerted(key) {
  pruneRecent();
  return (STORE.recent || []).some(r => r.key === key);
}

// pending helpers
function addPending(p) { STORE.pending = STORE.pending || []; STORE.pending.push(p); safeSave(STORE_FILE, STORE); }
function removePending(id) { STORE.pending = (STORE.pending||[]).filter(x => x.id !== id); safeSave(STORE_FILE, STORE); }
function updatePending(id, patch) {
  STORE.pending = STORE.pending || [];
  for (let i=0;i<STORE.pending.length;i++) {
    if (STORE.pending[i].id === id) {
      STORE.pending[i] = Object.assign({}, STORE.pending[i], patch);
      break;
    }
  }
  safeSave(STORE_FILE, STORE);
}

// -------------------- pattern detection --------------------
function detectPatterns(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return [];
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);
  const patterns = [];

  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;

  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open) patterns.push({ name: "Hammer", side: "Bullish", strength: 70 });
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open) patterns.push({ name: "ShootingStar", side: "Bearish", strength: 70 });

  if (prev && prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) patterns.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
  if (prev && prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open) patterns.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });

  if (prev && Math.abs(prev.high - last.high) / Math.abs(prev.high || 1) < 0.0006 && last.close < last.open) patterns.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (prev && Math.abs(prev.low - last.low) / Math.abs(prev.low || 1) < 0.0006 && last.close > last.open) patterns.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  if (body / (Math.max(1, last.high - last.low)) < 0.2) patterns.push({ name: "Doji", side: "Neutral", strength: 40 });

  if (prev2 && prev2.close < prev2.open && last.close > last.open && last.close > prev.close) patterns.push({ name: "MorningStar", side: "Bullish", strength: 72 });
  if (prev2 && prev2.close > prev2.open && last.close < last.open && last.close < prev.close) patterns.push({ name: "EveningStar", side: "Bearish", strength: 72 });

  return patterns;
}

// -------------------- per-TF scoring --------------------
function computeTFScore({ candles = [], tf = "15m", weight = 1 }) {
  const out = { score: 50, patterns: [], reasons: [] };
  if (!Array.isArray(candles) || candles.length < 3) return out;

  const pats = detectPatterns(candles);
  if (pats.length) {
    const p = pats[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength/2 : -p.strength/2);
    out.reasons.push(`pattern:${p.name}`);
  }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : null;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : null;
    const atr = typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : null;

    const lastVol = candles.at(-1).vol ?? candles.at(-1).v ?? candles.at(-1).volume ?? 0;
    const window = Math.min(20, candles.length);
    const avgVol = candles.slice(-window).reduce((s,c)=> s + (c.vol ?? c.v ?? c.volume ?? 0), 0) / Math.max(1, window);

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
      if (lastVol < avgVol * 0.6) { out.score -= 6; out.reasons.push("vol_drop"); }
    }
  } catch (e) {
    // indicator failures ignored
  }

  out.score = Math.round(Math.max(0, Math.min(100, out.score)));
  out.score = Math.round(out.score * weight);
  return out;
}

// -------------------- consensus builder --------------------
function buildConsensus(perTf, weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTf) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += (r.score ?? 50) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    // mlMain.prob is percent 0..100, nudge scaled
    boost = ((mlMain.prob - 50) / 50) * 8; // smaller influence
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";
  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlLabel: mlMain?.label || null };
}

// -------------------- targets and SL builder --------------------
function buildTargets({ ellObj = null, price = 0, atr = 0 }) {
  const tps = [];
  try {
    if (ellObj && Array.isArray(ellObj.targets) && ellObj.targets.length) {
      for (const t of ellObj.targets.slice(0,3)) {
        const tp = Number(t.tp || t.target || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
  } catch(e){}

  if (!tps.length) {
    const p = Number(price) || 0;
    const a = Math.max(1, atr || 1);
    for (const m of DEFAULTS.tpAtrMultipliers) tps.push({ source: `ATR_x${m}`, tp: Number((p + a * m).toFixed(2)), confidence: 30 });
  }

  const sls = [];
  sls.push({ side: "LONG", sl: Number((price - (atr * DEFAULTS.slAtrMultiplier)).toFixed(2)) });
  sls.push({ side: "SHORT", sl: Number((price + (atr * DEFAULTS.slAtrMultiplier)).toFixed(2)) });

  return { tps, sls };
}

// -------------------- debounce key maker --------------------
function makeKey(symbol, side, patternName, price) {
  const bucket = Math.round((price || 0) / (Math.max(1, price) * 0.002 + 1));
  return `${symbol}_${side}_${patternName}_${bucket}`;
}

// -------------------- confirmation routine --------------------
async function confirmPending(pending, opts = {}) {
  try {
    const tf = pending.confirmationTF || opts.confirmationTF || DEFAULTS.confirmationTF;
    const req = pending.requiredCandles || opts.confirmCandles || DEFAULTS.confirmCandles;
    const resp = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = (resp?.data || []);
    if (!candles || candles.length < req + 1) return { ok:false, reason: "not_enough_candles" };

    const closed = candles.slice(- (req + 1), -1);
    if (closed.length < req) return { ok:false, reason: "not_enough_closed" };

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

// -------------------- evaluateSymbol (main tick) --------------------
async function evaluateSymbol(symbol, opts = {}, sendAlert = async () => {}) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs);

    // main ML prediction (best effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch {}

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (candles.at(-1)?.close ?? 0);
      const tfWeight = opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1;

      const res = computeTFScore({ candles, tf, weight: tfWeight });
      perTfResults.push({ tf, score: res.score, reasons: res.reasons, patterns: res.patterns, price, candles });
    }

    // consensus object
    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    if (finalScore < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      // not strong enough to consider pending
      // however allow micro-ML immediate live alert if enabled
      if (DEFAULTS.enableMicroMLLive) {
        try {
          const micro = await runMicroPrediction(symbol, opts.microLookback || 60);
          if (micro && typeof micro.prob === "number") {
            const microProb = micro.prob; // 0..100
            const microLabel = (micro.probBull > micro.probBear) ? "Bullish" : (micro.probBear > micro.probBull) ? "Bearish" : "Neutral";
            if (microProb >= (opts.microMlGateProb || DEFAULTS.microMlGateProb)) {
              // create live micro alert but still check debounce & mlMain contradiction
              let side = microLabel === "Bullish" ? "Bullish" : microLabel === "Bearish" ? "Bearish" : null;
              if (side) {
                const priceRef = perTfResults[0]?.price ?? 0;
                const patternName = (perTfResults.flatMap(r=>r.patterns||[]).at(0) || { name: "micro" }).name;
                const key = makeKey(symbol, side, patternName, priceRef);
                // check debouncing
                if (!recentlyAlerted(key) && hourlyCount() < (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) {
                  // also check mlMain contradiction (relaxed)
                  if (mlMain && typeof mlMain.prob === "number") {
                    const mlSide = mlMain.prob > 55 ? "Bullish" : mlMain.prob < 45 ? "Bearish" : "Neutral";
                    if (mlSide !== "Neutral" && mlSide !== side && mlMain.prob > (opts.mlMainGateMinProb || DEFAULTS.mlMainGateMinProb)) {
                      // contradictory -> skip micro live
                    } else {
                      // send immediate live micro alert
                      const preview = `⚡ <b>MICRO-ML ALERT (LIVE)</b> — <b>${side}</b>\nSym: <b>${symbol}</b> | Prob: ${microProb.toFixed(2)}%\nPrice: ${Number(priceRef).toFixed(2)}\nSource: micro-ml\nTime: ${nowLocal()}`;
                      await sendAlert(preview);
                      addRecent(key);
                      // record prediction to ML store (best-effort)
                      try { await recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: side, prob: microProb, features: micro.features || micro.featureVector }); } catch(){}
                      return { alerted: true, reason: "micro_live", micro };
                    }
                  } else {
                    // no mlMain — allow micro live
                    const preview = `⚡ <b>MICRO-ML ALERT (LIVE)</b> — <b>${microLabel}</b>\nSym: <b>${symbol}</b> | Prob: ${microProb.toFixed(2)}%\nPrice: ${Number(perTfResults[0]?.price||0).toFixed(2)}\nSource: micro-ml\nTime: ${nowLocal()}`;
                    await sendAlert(preview);
                    addRecent(key);
                    try { await recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: microLabel, prob: microProb, features: micro.features || micro.featureVector }); } catch(){}
                    return { alerted: true, reason: "micro_live_no_main", micro };
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore micro errors
        }
      }

      return { alerted: false, reason: "below_threshold", score: finalScore };
    }

    // Decide majority pattern side
    let bull = 0, bear = 0;
    for (const r of perTfResults) {
      for (const p of (r.patterns || [])) {
        if (p.side === "Bullish") bull++;
        if (p.side === "Bearish") bear++;
      }
    }

    let side = "Bullish";
    if (bear > bull) side = "Bearish";
    else if (bull === bear) side = (mlMain && typeof mlMain.prob === "number") ? (mlMain.prob >= 50 ? "Bullish" : "Bearish") : (finalScore >= 50 ? "Bullish" : "Bearish");

    const topPattern = (perTfResults.flatMap(r=>r.patterns || []).at(0)) || { name: "Pattern" };
    const priceRef = perTfResults[0]?.price ?? 0;
    const key = makeKey(symbol, side, topPattern.name, priceRef);

    // cooldowns & rate limits
    if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };
    if (hourlyCount() >= (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) return { alerted: false, reason: "rate_limit_hour" };

    // ML main gating: block only if ML strongly opposite
    if (mlMain && typeof mlMain.prob === "number") {
      const mlSide = mlMain.prob > 55 ? "Bullish" : mlMain.prob < 45 ? "Bearish" : "Neutral";
      if (mlSide !== "Neutral" && mlSide !== side && (mlMain.prob > (opts.mlMainGateMinProb || DEFAULTS.mlMainGateMinProb))) {
        return { alerted: false, reason: "ml_contradict", mlProb: mlMain.prob };
      }
    }

    // create pending record
    const id = `pend_${Date.now()}_${Math.floor(Math.random()*9000)}`;
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
        meta: { source: "reversal_watcher_vpatched" }
      });
    } catch (e) {
      pending.predId = null;
    }

    addPending(pending);

    const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
    let ell = null;
    try { ell = await analyzeElliott(perTfResults[0].candles); } catch (e) {}
    const targets = buildTargets({ ellObj: ell && ell.ok ? ell : null, price: priceRef, atr });

    const preview = [
      `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
      `Sym: <b>${symbol}</b> | Pattern: ${pending.pattern} | Score: <b>${Math.round(finalScore)}%</b>`,
      `Price: ${Number(priceRef).toFixed(2)} | TF-weights: ${JSON.stringify(opts.weights || DEFAULTS.weights)}`,
      `Top TP(s): ${targets.tps.slice(0,2).map(t=>`${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
      `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
      `Waiting for ${pending.requiredCandles} x ${pending.confirmationTF} candle(s) to confirm...`,
      `ID: ${pending.predId || "none"}`
    ].join("\n");

    try { await sendAlert(preview); } catch (e) {}
    return { alerted: true, pendingId: id, key, score: finalScore };

  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------- processAllPending --------------------
async function processAllPending(sendAlert = async () => {}, opts = {}) {
  const list = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of list) {
    try {
      // expired
      if (Date.now() - (p.createdAt || 0) > (opts.maxPendingAgeMs || DEFAULTS.maxPendingAgeMs)) {
        updatePending(p.id, { status: "expired", closedAt: Date.now() });
        removePending(p.id);
        continue;
      }

      const conf = await confirmPending(p, opts);
      if (!conf.ok) {
        if (conf.reason === "not_enough_closed" || conf.reason === "not_enough_candles") continue;
        // failed confirmation
        updatePending(p.id, { status: "failed", note: conf.reason, closedAt: Date.now() });
        try {
          await sendAlert(`🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\nPattern: ${p.pattern}\nReason: ${conf.reason || "invalidated"}\nID: ${p.predId || "none"}`);
        } catch (e) {}
        if (p.predId) { try { await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch(e){} }
        removePending(p.id);
        continue;
      }

      // confirmed
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch (e) {}
      const targets = buildTargets({ ellObj: ell && ell.ok ? ell : null, price, atr });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Sym: <b>${p.symbol}</b> | Pattern: ${p.pattern} | Confidence: <b>${Math.round(p.consensusScore || 0)}%</b>`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${targets.tps.map(t=>`${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
        `Observed support: ${conf.support}/${conf.needed} | movePct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.predId || "none"}`
      ].join("\n");

      try { await sendAlert(msg); } catch (e) {}

      updatePending(p.id, { status: "sent", sentAt: Date.now() });
      addRecent(p.key);

      // schedule feedback checks
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            updatePending(p.id, outcome.success ? { status: "done", outcome } : { status: "failed", outcome });
            if (p.predId) {
              try { await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch(e) {}
            }
            setTimeout(()=> removePending(p.id), 2000);
          } catch (e) { /* ignore */ }
        }, win * 1000);
      });

    } catch (e) {
      // keep processing others
    }
  }
}

// -------------------- checkPostOutcome helper --------------------
async function checkPostOutcome(pending, windowSec) {
  try {
    const resp = await fetchMarketData(pending.symbol, "1m", Math.max(3, Math.ceil(windowSec/60) + 2));
    const newPrice = resp?.price ?? null;
    const priceAtSend = pending.priceAtDetect || (pending.perTfResults && pending.perTfResults[0]?.price) || 0;
    const movedUp = newPrice > priceAtSend;
    const success = (pending.side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100 : null;
    return { ok: true, predId: pending.predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) { return { ok:false, error: e?.message || String(e) }; }
}

// -------------------- public API: start/stop --------------------
let _timers = new Map();
let _running = false;

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = async () => {}) {
  if (_timers.has(symbol)) return false;
  const opts = Object.assign({}, DEFAULTS, options || {});

  // main tick
  const tickFn = async () => {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch (e) {}
  };

  // pending processor
  const pendFn = async () => {
    try { await processAllPending(sendAlert, opts); } catch (e) {}
  };

  // immediate run then intervals
  tickFn();
  const mainId = setInterval(tickFn, Math.max(1000, opts.pollIntervalMs || DEFAULTS.pollIntervalMs));
  const pendId = setInterval(pendFn, Math.max(5*1000, Math.floor((opts.confirmCandles || DEFAULTS.confirmCandles) * 15 * 1000)));

  _timers.set(symbol, { mainId, pendId });
  _running = true;
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) {
        clearInterval(rec.mainId); clearInterval(rec.pendId);
        _timers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _timers.entries()) {
        clearInterval(rec.mainId); clearInterval(rec.pendId);
        _timers.delete(s);
      }
    }
    _running = _timers.size > 0;
    return true;
  } catch (e) { return false; }
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

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};