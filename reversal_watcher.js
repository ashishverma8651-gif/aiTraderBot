// reversal_watcher.js — FULL (All features: patterns, volume, multi-TF, ML gating, confirm, SL/TP, feedback)
// Single-file, drop-in for aiTraderBot.js (startReversalWatcher / stopReversalWatcher exports)
//
// Notes:
// - Depends on: ./config.js, ./utils.js (fetchMarketData, fetchMultiTF), ./core_indicators.js (computeRSI, computeMACD, computeATR),
//   ./elliott_module.js (analyzeElliott) and ./ml_module_v8_6.js (runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy)
// - Designed for low memory usage, simple JSON persistence in ./cache/reversal_watcher_store.json

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
// Storage / Defaults
// =====================
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");
function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; return JSON.parse(fs.readFileSync(fp,"utf8") || "{}"); }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch (e) { return false; }
}

const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 60,           // start pending if consensus >= this-5 (candidate)
  minAlertConfidence: 65,         // final send threshold
  confirmCandles: 3,              // N closed candles to confirm (on confirmationTF)
  confirmationTF: "1m",
  confirmTimeoutMs: 30 * 1000,    // max wait inside single confirmation check loop
  debounceSeconds: 300,           // cooldown for identical key
  cooldownAfterConfirmSec: 600,   // cooldown after confirmed send
  maxSavedAlerts: 2000,
  mlMainGateMinProb: 50,          // if ML main prob lower than this, don't block (set >50 to require ML agreement)
  microMlGateDeltaPct: 6,         // micro average must not be more than this percent opposite
  maxPendingAgeMs: 24 * 60 * 60 * 1000, // pending expiry
  maxAlertsPerHour: 8,
  enablePatterns: true,
  volumeConfirm: true,
  volumeMultiplier: 1.0,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2, 4],
  allowNeutral: false
}, CONFIG.REVERSAL_WATCHER || {});

// load persistent store
let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// housekeeping helpers
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
  STORE.recent = STORE.recent.filter(r => r.ts >= cutoff);
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
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
  return STORE.recent.some(r => r.key === key);
}

// =====================
// Pattern detectors (many)
// =====================
function detectPatterns(candles) {
  // expects oldest -> newest, length >= 3 (for many patterns)
  if (!Array.isArray(candles) || candles.length < 3) return [];
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);
  const patterns = [];

  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;

  // Hammer / Pin bar bullish
  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open) patterns.push({ name: "Hammer", side: "Bullish", strength: 70 });

  // Hanging man (similar shape but after uptrend) — treat as bearish warning (we still can include)
  // Shooting star
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open) patterns.push({ name: "ShootingStar", side: "Bearish", strength: 70 });

  // Engulfing
  if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) patterns.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
  if (prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open) patterns.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });

  // Tweezer top/bottom (approx)
  if (Math.abs(prev.high - last.high) / Math.max(1, Math.abs(prev.high)) < 0.0006 && last.close < last.open) patterns.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (Math.abs(prev.low - last.low) / Math.max(1, Math.abs(prev.low)) < 0.0006 && last.close > last.open) patterns.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  // Doji (indecision) — possible reversal if combined
  if (body / (Math.max(1, last.high - last.low)) < 0.2) patterns.push({ name: "Doji", side: "Neutral", strength: 40 });

  // Morning star / Evening star (three-candle)
  // Morning star bullish: prev2 large down, prev small body, last up big
  const bigDown = prev2.close < prev2.open && Math.abs(prev2.close - prev2.open) > Math.abs(prev.open - prev.open || 0) * 1.5;
  if (prev2 && prev && last && prev2.close < prev2.open && Math.abs(prev2.close - prev2.open) > Math.abs(prev.open - prev.close || 0) * 0.8 && last.close > last.open && last.close > prev.close) {
    // crude morning star
    patterns.push({ name: "MorningStar", side: "Bullish", strength: 72 });
  }
  if (prev2 && prev && last && prev2.close > prev2.open && last.close < last.open && last.close < prev.close) {
    patterns.push({ name: "EveningStar", side: "Bearish", strength: 72 });
  }

  return patterns;
}

// =====================
// Score builder per TF
// =====================
function computeTFScore({ candles = [], tf = "15m", weight = 1 }) {
  // returns {score(0..100), reasons, patterns}
  const out = { score: 50, reasons: [], patterns: [] }; // neutral 50 base
  if (!Array.isArray(candles) || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength/2 : -p.strength/2);
    out.reasons.push(`pattern:${p.name}:${p.side}`);
  }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : null;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : null;
    const atr = typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : null;
    const lastVol = candles.at(-1).vol ?? candles.at(-1).v ?? candles.at(-1).volume ?? 0;
    const avgVol = candles.slice(-20).reduce((s,c)=> s + (c.vol ?? c.v ?? c.volume ?? 0), 0) / Math.max(1, Math.min(20, candles.length));

    if (rsi !== null) {
      if (rsi < 30) { out.score += 8; out.reasons.push("rsi_oversold"); }
      if (rsi > 70) { out.score -= 8; out.reasons.push("rsi_overbought"); }
    }
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { out.score += 6; out.reasons.push("macd_pos"); }
      else if (macd.hist < 0) { out.score -= 6; out.reasons.push("macd_neg"); }
    }
    if (avgVol && lastVol) {
      if (lastVol > avgVol * DEFAULTS.volumeMultiplier) { out.score += 6; out.reasons.push("vol_spike"); }
      if (lastVol < avgVol * 0.6) { out.score -= 6; out.reasons.push("vol_drop"); }
    }
    // normalize to 0..100
    out.score = Math.round(Math.max(0, Math.min(100, out.score)));
  } catch (e) {
    // ignore indicator failures
  }

  out.score = Math.round(out.score * weight);
  return out;
}

// =====================
// Multi-TF consensus
// =====================
function buildConsensus(perTf, weights = DEFAULTS.weights, mlMain = null) {
  // perTf: [{tf, score, patterns, price, candles}]
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTf) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += (r.score ?? 50) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  // ML main nudge (scaled)
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    boost = ((mlMain.prob - 50) / 50) * 10 * (DEFAULTS.mlMainGateMinProb > 50 ? 1 : 0.5);
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";

  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlLabel: mlMain?.label || null };
}

// =====================
// Targets & SL builder
// =====================
function buildTargets({ ellObj = null, price = 0, atr = 0 }) {
  const tps = [];
  // use Elliott targets first if present
  try {
    if (ellObj && Array.isArray(ellObj.targets) && ellObj.targets.length) {
      for (const t of ellObj.targets.slice(0,3)) {
        const tp = Number(t.tp || t.target || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
  } catch (e) {}

  // fallback to fib ext if ellObj.fib ext exists
  try {
    if (!tps.length && ellObj && ellObj.fib && ellObj.fib.ext) {
      const ext = ellObj.fib.ext;
      if (ext["1.272"]) tps.push({ source: "FIB_1.272", tp: ext["1.272"], confidence: 40 });
      if (ext["1.618"]) tps.push({ source: "FIB_1.618", tp: ext["1.618"], confidence: 35 });
    }
  } catch (e) {}

  // ATR fallback (both sides)
  if (!tps.length) {
    const p = Number(price) || 0;
    const a = Math.max(1, atr || 1);
    for (const m of DEFAULTS.tpAtrMultipliers) tps.push({ source: `ATR_x${m}`, tp: Number((p + a * m).toFixed(2)), confidence: 30 });
  }

  // SL: use ATR multiples opposite side
  const sls = [];
  const slLong = Number((price - (atr * DEFAULTS.slAtrMultiplier)).toFixed(2));
  const slShort = Number((price + (atr * DEFAULTS.slAtrMultiplier)).toFixed(2));
  sls.push({ side: "LONG", sl: slLong });
  sls.push({ side: "SHORT", sl: slShort });

  return { tps, sls };
}

// =====================
// Debounce / Pending helpers
// =====================
function makeKey(symbol, side, patternName, price) {
  // coarse price bucket to reduce duplicates
  const bucket = Math.round((price || 0) / (Math.max(1, price) * 0.002 + 1)); // gentle bucket
  return `${symbol}_${side}_${patternName}_${bucket}`;
}

function addPendingRecord(rec) {
  STORE.pending = STORE.pending || [];
  STORE.pending.push(rec);
  safeSave(STORE_FILE, STORE);
}
function removePendingRecord(id) {
  STORE.pending = (STORE.pending || []).filter(p => p.id !== id);
  safeSave(STORE_FILE, STORE);
}
function updatePendingRecord(id, patch) {
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
// Confirmation routine
// =====================
async function confirmPending(pending, sendAlert, opts = {}) {
  // pending: item with { id, symbol, side, priceAtDetect, patternName, predId, createdAt, requiredCandles }
  // We'll fetch 'requiredCandles' closed candles on confirmationTF and apply rules.
  try {
    const tf = pending.confirmationTF || opts.confirmationTF || DEFAULTS.confirmationTF;
    const req = pending.requiredCandles || opts.confirmCandles || DEFAULTS.confirmCandles;
    const resp = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = (resp?.data || []);
    if (!candles || candles.length < req + 1) return { ok:false, reason: "not_enough_candles" };

    // pick the last 'req' closed candles (exclude currently open)
    const closed = candles.slice(- (req + 1), -1);
    if (closed.length < req) return { ok:false, reason: "not_enough_closed" };

    // evaluate direction support
    let support = 0;
    for (const c of closed) {
      const movedUp = c.close > c.open;
      if (pending.side === "Bullish" && movedUp) support++;
      if (pending.side === "Bearish" && !movedUp) support++;
      // wicks supportive
      const body = Math.abs(c.close - c.open) || 1;
      const lower = Math.min(c.open, c.close) - c.low;
      const upper = c.high - Math.max(c.open, c.close);
      if (pending.side === "Bullish" && lower > body * 1.6) support++;
      if (pending.side === "Bearish" && upper > body * 1.6) support++;
    }

    const needed = Math.ceil(closed.length * 0.6); // 60%
    const ok = support >= needed;

    // compute movement %
    const start = closed[0].close;
    const last = closed.at(-1).close;
    const movedPct = start ? ((last - start) / Math.max(1, Math.abs(start))) * 100 : 0;

    return { ok, support, needed, movedPct, closedLast: closed.at(-1) };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// =====================
// Main evaluateSymbol tick
// =====================
async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    // fetch MT candes/prices
    const multi = await fetchMultiTF(symbol, tfs);
    // ML main best-effort
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch {}

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);
      const tfWeight = opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1;

      const res = computeTFScore({ candles, tf, weight: tfWeight });
      perTfResults.push({ tf, score: res.score, reasons: res.reasons, patterns: res.patterns, price, candles });
    }

    // consensus
    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);

    // quick trend from 1h/15m
    let trend = "FLAT";
    try {
      const hc = multi["1h"] || multi["15m"];
      const closes = (hc?.data || []).map(c=>c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        if (last > prev) trend = "UP"; else if (last < prev) trend = "DOWN";
      }
    } catch(e){}

    // gating: require at least pendingThreshold to consider pending
    const finalScore = consensus.final;
    if (finalScore >= (opts.pendingThreshold || DEFAULTS.pendingThreshold)) {
      // decide majority side using patterns across TFs
      let bull = 0, bear = 0;
      for (const r of perTfResults) {
        for (const p of (r.patterns || [])) {
          if (p.side === "Bullish") bull++;
          if (p.side === "Bearish") bear++;
        }
      }
      let side = "Bullish";
      if (bear > bull) side = "Bearish';
      else if (bull === bear) side = consensus.mlLabel || (finalScore >= 50 ? "Bullish" : "Bearish");

      // choose top pattern name if exists
      const topPattern = perTfResults.flatMap(r=>r.patterns || []).at(0) || { name: "Pattern", side };

      // debounce key
      const priceRef = perTfResults[0]?.price || 0;
      const key = makeKey(symbol, side, topPattern.name, priceRef);

      // hourly rate limit
      if (hourlyCount() >= (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) {
        // too many recently
        return { alerted: false, reason: "rate_limit_hour" };
      }

      // if already recently alerted same key — ignore
      if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };

      // ML main gating: if ML main exists and is strongly opposite -> block
      if (mlMain && typeof mlMain.prob === "number") {
        // mlMain.prob is pct 0..100 where >50 bullish
        const mlSide = mlMain.prob > 55 ? "Bullish" : mlMain.prob < 45 ? "Bearish" : "Neutral";
        if (mlSide === "Neutral" && DEFAULTS.allowNeutral === false) {
          // do not block, only nudge
        } else if (mlSide !== "Neutral" && mlSide !== side) {
          // contradictory ML main -> skip pending
          return { alerted: false, reason: "ml_contradict" };
        }
      }

      // create pending detection record, push to store
      const id = `pend_${Date.now()}_${Math.floor(Math.random()*9000)}`;
      const entry = {
        id,
        key,
        symbol,
        side,
        pattern: topPattern.name || "pattern",
        createdAt: Date.now(),
        priceAtDetect: priceRef,
        perTfResults,
        predId: null,
        status: "pending",
        requiredCandles: opts.confirmCandles || DEFAULTS.confirmCandles,
        confirmationTF: opts.confirmationTF || DEFAULTS.confirmationTF,
        consensusScore: finalScore
      };

      // record pred via ML storage (best-effort)
      try {
        entry.predId = await recordPrediction({
          symbol,
          predictedAt: new Date().toISOString(),
          label: side,
          prob: finalScore,
          features: {
            perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })),
            trend
          },
          meta: { source: "reversal_watcher_vfull" }
        });
      } catch (e) { entry.predId = null; }

      addPendingRecord(entry);

      // send preliminary alert (detected)
      const price = priceRef;
      const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
      const ell = (perTfResults[0] && perTfResults[0].candles) ? (await (async ()=> { try { const a=await analyzeElliott(perTfResults[0].candles); return a && a.ok ? a : null; } catch(e){return null;} })()) : null;
      const targets = buildTargets({ ellObj: ell, price, atr });

      const preview = [
        `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
        `Sym: <b>${symbol}</b> | Pattern: ${entry.pattern} | Score: <b>${finalScore}%</b>`,
        `Price: ${Number(price).toFixed(2)} | TF-weights: ${JSON.stringify(opts.weights || DEFAULTS.weights)}`,
        `Top TP: ${targets.tps.slice(0,2).map(t=>`${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
        `Waiting for ${entry.requiredCandles} x ${entry.confirmationTF} candle(s) to confirm...`,
        `ID: ${entry.predId || "none"}`
      ].join("\n");

      try {
        if (typeof sendAlert === "function") await sendAlert(preview);
      } catch (e) {}

      return { alerted: true, pendingId: id, key };
    }

    return { alerted: false, score: finalScore, reason: "below_threshold" };
  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// =====================
// Periodic pending processor
// =====================
async function processAllPending(sendAlert, opts = {}) {
  const pendingList = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of pendingList) {
    try {
      // expired check
      if (Date.now() - (p.createdAt || 0) > (DEFAULTS.maxPendingAgeMs)) {
        // mark failed
        updatePendingRecord(p.id, { status: "expired", closedAt: Date.now() });
        removePendingRecord(p.id);
        continue;
      }

      // confirm
      const conf = await confirmPending(p, sendAlert, opts);
      if (!conf.ok) {
        // if not enough data yet, skip
        if (conf.reason === "not_enough_candles" || conf.reason === "not_enough_closed") continue;
        // invalidated -> fail
        updatePendingRecord(p.id, { status: "failed", closedAt: Date.now(), note: conf.reason || conf.error });
        // notify failure (optional)
        try {
          if (typeof sendAlert === "function") {
            await sendAlert(
              `🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\n` +
              `Pattern: ${p.pattern}\n` +
              `Reason: ${conf.reason || conf.error}\n` +
              `ID: ${p.predId || "none"}`
            );
          }
        } catch(e){}
        // record outcome
        try { if (p.predId) await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch(e){}
        removePendingRecord(p.id);
        continue;
      }

      // confirmed -> send final alert and feedback wiring
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      const ell = p.perTfResults && p.perTfResults[0]?.candles ? (await (async ()=>{ try { const a=await analyzeElliott(p.perTfResults[0].candles); return a && a.ok ? a : null; } catch(e){return null;} })()) : null;
      const targets = buildTargets({ ellObj: ell, price, atr });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Sym: <b>${p.symbol}</b> | Pattern: ${p.pattern} | Confidence: <b>${Math.round(p.consensusScore||0)}%</b>`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${targets.tps.map(t=>`${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
        `Observed support: ${conf.support}/${conf.needed} | movePct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.predId || "none"}`
      ].join("\n");

      try { if (typeof sendAlert === "function") await sendAlert(msg); } catch(e){}

      // mark as sent / record cooldown
      updatePendingRecord(p.id, { status: "sent", sentAt: Date.now() });
      addRecent(p.key);

      // schedule feedback outcome checks
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec || [60,300]).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            // update pending record with outcome
            updatePendingRecord(p.id, { status: outcome.success ? "done" : "failed", closedAt: Date.now(), outcome });
            // record outcome to ML
            try { if (p.predId) await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch(e){}
            // remove pending after small delay
            setTimeout(()=> removePendingRecord(p.id), 2000);
          } catch(e) {}
        }, win * 1000);
      });

    } catch (e) {
      // log but keep loop alive
      // console.log("pending processing error", e?.message || e);
    }
  }
}

// helper used by processAllPending scheduling to compute final move after X seconds
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

// =====================
// Public API start/stop
// =====================
let _timers = new Map(); // symbol -> { mainId, pendingId }
let _running = false;

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_timers.has(symbol)) return false;
  const opts = Object.assign({}, DEFAULTS, options || {});
  // main tick: evaluate candidate detection
  const tickFn = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {}
  };
  // pending processor tick
  const pendFn = async () => {
    try { await processAllPending(sendAlert, opts); } catch (e) {}
  };

  // immediate run then intervals
  tickFn();
  const mainId = setInterval(tickFn, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  // pending check every ~15s (adjustable)
  const pendId = setInterval(pendFn, Math.max(10*1000, Math.min(60*1000, Math.floor((opts.confirmCandles || DEFAULTS.confirmCandles) * 15 * 1000))));
  _timers.set(symbol, { mainId, pendId });
  _running = true;
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
    _running = _timers.size > 0;
    return true;
  } catch (e) { return false; }
}

export function getWatcherState() {
  return {
    running: _running,
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