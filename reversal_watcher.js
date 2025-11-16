// reversal_watcher.js — FINAL single-file (Clean alerts + confirmation + ML feedback)
// Requires: config.js, utils.js (fetchMultiTF, fetchMarketData), elliott_module.js, core_indicators.js, ml_module_v8_6.js

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
// Storage & logging
// -------------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");
const LOG_FILE = path.join(DATA_DIR, "reversal_watcher_log.txt");

function log(...args) {
  const line = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}] ${args.join(" ")}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
  // also print to console for dev
  console.log(line);
}

function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; const txt = fs.readFileSync(fp,"utf8"); return txt ? JSON.parse(txt) : def; }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch (e) { log("safeSave err", e?.message || e); return false; }
}

// -------------------------
// Defaults (tunable via CONFIG.REVERSAL_WATCHER)
// -------------------------
const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20000,
  pendingThreshold: 60,         // candidate threshold to enter pending (slightly below final alert threshold)
  minAlertConfidence: 70,       // final confidence threshold for first quick alert (if you want immediate)
  confirmCandles: 3,            // number of subsequent closed candles needed for confirmation
  confirmTF: "1m",              // confirmation TF
  debounceSeconds: 180,         // cooldown for duplicate key
  cooldownAfterConfirmSec: 300, // cooldown after a confirmed sent alert
  mlGateMinProb: 40,            // if ML main prob < this and consensus weak, block candidate
  microMlGateDelta: 6,          // micro ml contradictory delta percent
  maxSaved: 2000,
  maxAlertsPerHour: 6,
  enablePatternBoost: true,
  patternBoostPoints: 45,
  feedbackWindowsSec: [60, 300]
}, CONFIG.REVERSAL_WATCHER || {});

// -------------------------
// Persistent store in cache
// -------------------------
const STORE = safeLoad(STORE_FILE, { alerts: [], pending: [], hourly: [] });
STORE.alerts = Array.isArray(STORE.alerts) ? STORE.alerts.slice(-DEFAULTS.maxSaved) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

function recordHourly() {
  const now = Date.now();
  STORE.hourly.push(now);
  const cutoff = now - (60*60*1000);
  STORE.hourly = STORE.hourly.filter(ts => ts >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() { return STORE.hourly.length; }

// -------------------------
// Utilities: patterns (cheap)
// -------------------------
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 2) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const body = Math.max(1e-8, Math.abs(last.close - last.open));
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  if (DEFAULTS.enablePatternBoost && lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) {
    out.push({ name: "Hammer", side: "Bullish", strength: Math.min(95, 30 + (lowerWick/body) * 12) });
  }
  if (DEFAULTS.enablePatternBoost && upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) {
    out.push({ name: "ShootingStar", side: "Bearish", strength: Math.min(95, 30 + (upperWick/body) * 12) });
  }
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 60 });

  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 60 });

  return out;
}

// -------------------------
// Scoring & consensus (compact)
// -------------------------
function computeTFScore({ candles = [], ell = null, mlMicro = null, tf = "15m", tfWeight = 1 }) {
  let score = 0;
  const reasons = [];
  const patterns = detectSimplePatternsFromCandles(candles);
  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(90, p.strength || DEFAULTS.patternBoostPoints);
    score += pscore;
    reasons.push(`pattern:${p.name}`);
  }

  try {
    const rsi = indicators.computeRSI(candles);
    const macd = indicators.computeMACD(candles);
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { score += 6; reasons.push("macd_pos"); }
      else if (macd.hist < 0) { score -= 6; reasons.push("macd_neg"); }
    }
    if (typeof rsi === "number") {
      if (rsi < 30) { score += 6; reasons.push("rsi_oversold"); }
      if (rsi > 70) { score -= 6; reasons.push("rsi_overbought"); }
    }
  } catch (e) {}

  if (ell && typeof ell.sentiment === "number") {
    score += ell.sentiment * 10;
    reasons.push("elliott");
  }

  if (mlMicro && typeof mlMicro.prob === "number") {
    score += ((mlMicro.prob - 50) / 100) * 20; // small micro nudge
    reasons.push("mlMicro");
  }

  const raw = Math.max(-100, Math.min(100, score));
  const norm = Math.round((raw + 100) / 2); // 0..100
  return { score: norm, reasons, patterns };
}

function buildConsensus(perTfResults = [], weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTfResults) {
    const w = weights[r.tf] || 0.1;
    sumW += w;
    sumS += (r.score || 50) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  // mlMain nudging (small)
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    boost = ((mlMain.prob - 50) / 50) * (DEFAULTS.mlWeight || 0.18) * 50; // scaled
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";
  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlMainLabel: mlMain?.label || null };
}

// -------------------------
// Debounce key (stable)
// -------------------------
function makeDebounceKey(symbol, side, perTfResults = []) {
  const patterns = perTfResults.flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`)).sort().join("|") || "NOPAT";
  const scores = perTfResults.map(r => `${r.tf}:${Math.round(r.score||50)}`).sort().join("|") || "NOSCORE";
  const priceZone = perTfResults[0] && perTfResults[0].price ? Math.round(perTfResults[0].price / 10) : "P0";
  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}

// -------------------------
// Pending management
// -------------------------
function persistStore() { safeSave(STORE_FILE, STORE); }
function recentlyAlerted(key) {
  const now = Date.now();
  const cutoff = now - (DEFAULTS.debounceSeconds * 1000);
  STORE.alerts = (STORE.alerts || []).filter(a => a.ts >= cutoff);
  return (STORE.alerts || []).some(a => a.key === key);
}
function recordSent(key, meta = {}) {
  STORE.alerts = STORE.alerts || [];
  STORE.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  STORE.alerts = STORE.alerts.slice(-DEFAULTS.maxSaved);
  recordHourly();
  persistStore();
}
function addPending(p) {
  STORE.pending = STORE.pending || [];
  STORE.pending.push(Object.assign({ status: "pending", ts: Date.now() }, p));
  persistStore();
}
function updatePending(id, patch) {
  STORE.pending = STORE.pending || [];
  for (let i=0;i<STORE.pending.length;i++) {
    if (STORE.pending[i].id === id) { STORE.pending[i] = Object.assign({}, STORE.pending[i], patch); break; }
  }
  persistStore();
}
function removePending(id) {
  STORE.pending = (STORE.pending || []).filter(x => x.id !== id);
  persistStore();
}

// -------------------------
// Confirmation helper (wait for closed candles)
// -------------------------
async function assessConfirmationByCandles(symbol, side, requiredCandles = DEFAULTS.confirmCandles, tf = DEFAULTS.confirmTF) {
  try {
    // fetch requiredCandles + 1 so we get closed candles (exclude currently open)
    const resp = await fetchMarketData(symbol, tf, requiredCandles + 2);
    const candles = resp?.data || [];
    if (!Array.isArray(candles) || candles.length < requiredCandles + 1) {
      return { ok: false, reason: "not_enough_candles", have: candles.length };
    }
    // take last N closed (exclude last open)
    const closed = candles.slice(-(requiredCandles+1), -1);
    // count directional candles
    let dirCount = 0;
    for (const c of closed) {
      const movedUp = (c.close > c.open);
      if (side === "Bullish" && movedUp) dirCount++;
      if (side === "Bearish" && !movedUp) dirCount++;
      // also consider wick confirmation
      const body = Math.max(1e-8, Math.abs(c.close - c.open));
      const lowerWick = Math.min(c.close, c.open) - c.low;
      const upperWick = c.high - Math.max(c.close, c.open);
      if (side === "Bullish" && lowerWick > body * 1.6) dirCount++;
      if (side === "Bearish" && upperWick > body * 1.6) dirCount++;
    }
    const need = Math.ceil(closed.length * 0.6); // 60% supportive
    const movedPct = closed.length ? ((closed.at(-1).close - closed[0].close) / Math.max(1, Math.abs(closed[0].close))) * 100 : 0;
    return { ok: dirCount >= need, dirCount, need, closedCount: closed.length, movedPct };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Outcome / feedback (calls recordOutcome for ML)
// -------------------------
async function scheduleFeedbackChecks(predId, symbol, side, priceAtDetect, opts = {}) {
  const windows = opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec;
  for (const w of windows) {
    setTimeout(async () => {
      try {
        const resp = await fetchMarketData(symbol, "1m", Math.max(3, Math.ceil(w/60)+2));
        const newPrice = resp?.price ?? priceAtDetect;
        const movedUp = newPrice > priceAtDetect;
        const success = (side === "Bullish") ? movedUp : (!movedUp);
        const realizedReturn = priceAtDetect ? ((newPrice - priceAtDetect)/Math.max(1,Math.abs(priceAtDetect))) * 100 : null;
        if (predId && typeof recordOutcome === "function") {
          try { recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice }); }
          catch(e) { log("recordOutcome err", e?.message || e); }
        }
        log("feedback", symbol, side, "windowSec", w, "success", success, "newPrice", newPrice);
      } catch (e) {
        log("feedback check err", e?.message || e);
      }
    }, w * 1000);
  }
}

// -------------------------
// Main evaluateSymbol (detection + pending queuing)
// -------------------------
async function evaluateSymbol(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  try {
    const opts = Object.assign({}, DEFAULTS, options);
    const tfs = opts.tfs;
    const multi = await fetchMultiTF(symbol, tfs);

    // main ML prediction (15m)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    // build per-TF results
    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);
      let ell = null;
      try { const er = await analyzeElliott(candles); ell = (er && er.ok) ? er : null; } catch (e) { ell = null; }
      let mlMicro = null;
      if (["1m","5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || 60); } catch(e){ mlMicro = null; }
      }
      const scoreObj = computeTFScore({ candles, ell, mlMicro, tf, tfWeight: opts.weights?.[tf] || DEFAULTS.weights[tf] || 0.1 });
      perTfResults.push(Object.assign({ tf, price, candles, ell, mlMicro }, scoreObj));
    }

    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    // soft ML gate: if mlMain prob very low and consensus is not extremely high, skip
    if (mlMain && typeof mlMain.prob === "number" && mlMain.prob < (opts.mlGateMinProb || DEFAULTS.mlGateMinProb) && finalScore < 95) {
      log("ML gate blocked candidate", symbol, "mlProb:", mlMain.prob, "consensus:", finalScore);
      return { alerted: false, reason: "ml_gate", finalScore, mlMain };
    }

    // decide side by pattern majority or mlMain fallback
    const bullCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
    const bearCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
    let side = "Bullish";
    if (bullCount > bearCount) side = "Bullish";
    else if (bearCount > bullCount) side = "Bearish";
    else if (mlMain && mlMain.label) side = mlMain.label;
    else side = finalScore >= 50 ? "Bullish" : "Bearish";

    // very simple first quick alert (clean) if score high enough and not recently sent
    const key = makeDebounceKey(symbol, side, perTfResults);
    if (finalScore >= (opts.minAlertConfidence || DEFAULTS.minAlertConfidence)) {
      if (!recentlyAlerted(key) && hourlyCount() < (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) {
        // record quick-first alert (simple format)
        const firstMsg = [
          `🚨 Reversal Watcher`,
          `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}`,
          `Symbol: ${symbol}`,
          `Pattern: ${ (perTfResults.flatMap(r=>r.patterns||[])[0]?.name) || "N/A" }`,
          `Volume: ${ (perTfResults[0] && perTfResults[0].candles && perTfResults[0].candles.at(-1)?.v) || "n/a" }`,
          `Price: ${Number(perTfResults[0]?.price || 0).toFixed(2)}`,
          `ML Prob: ${ mlMain && typeof mlMain.prob === "number" ? (Math.round(mlMain.prob*100)/100) + "%" : "N/A" }`
        ].join("\n");

        try { if (typeof sendAlert === "function") await sendAlert(firstMsg); else log("Would send (first):", firstMsg); }
        catch(e){ log("sendAlert err (first)", e?.message || e); }

        // record a prediction entry (so ML can get feedback later)
        let predId = null;
        try {
          predId = await recordPrediction({
            symbol, predictedAt: new Date().toISOString(), label: side, prob: finalScore,
            features: { perTf: perTfResults.map(r=>({tf:r.tf,score:r.score})) },
            meta: { source: "reversal_watcher_first" }
          });
        } catch(e){ predId = null; }

        // mark as pending to confirm across next N candles
        const pendingId = `pend_${Date.now()}_${Math.floor(Math.random()*9999)}`;
        addPending({
          id: pendingId,
          key,
          symbol,
          side,
          predId,
          consensusScore: finalScore,
          requiredCandles: opts.confirmCandles || DEFAULTS.confirmCandles,
          confirmTF: opts.confirmTF || DEFAULTS.confirmTF,
          priceAtDetect: perTfResults[0]?.price || 0,
          perTfResults
        });

        // record initial first-alert to prevent duplicates in debounce window
        recordSent(key, { symbol, side, predId, score: finalScore, note: "first_alert" });

        return { alerted: true, type: "first", key, pendingId, predId };
      } else {
        log("first alert suppressed by debounce/hourly", key);
      }
    }

    // otherwise, if score is high enough to queue pending even without first alert threshold:
    if (finalScore >= (opts.pendingThreshold || DEFAULTS.pendingThreshold)) {
      if (!recentlyAlerted(key) && hourlyCount() < (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) {
        // create pending without sending first immediate message (user asked first alert + confirmation; this branch still queues pending)
        let predId = null;
        try {
          predId = await recordPrediction({
            symbol, predictedAt: new Date().toISOString(), label: side, prob: finalScore,
            features: { perTf: perTfResults.map(r=>({tf:r.tf,score:r.score})) },
            meta: { source: "reversal_watcher_pending" }
          });
        } catch(e){ predId = null; }

        const pendingId = `pend_${Date.now()}_${Math.floor(Math.random()*9999)}`;
        addPending({
          id: pendingId,
          key,
          symbol,
          side,
          predId,
          consensusScore: finalScore,
          requiredCandles: opts.confirmCandles || DEFAULTS.confirmCandles,
          confirmTF: opts.confirmTF || DEFAULTS.confirmTF,
          priceAtDetect: perTfResults[0]?.price || 0,
          perTfResults
        });
        recordSent(key, { symbol, side, predId, score: finalScore, note: "pending_only" });
        log("queued pending (no first alert)", pendingId);
        return { alerted: false, reason: "pending_queued", pendingId };
      }
    }

    return { alerted: false, reason: "none", finalScore };
  } catch (e) {
    log("evaluateSymbol err", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Pending processor — called periodically to check pending items and send confirmation/fail
// -------------------------
async function processPending(sendAlert = null, options = {}) {
  try {
    const pend = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
    for (const p of pend) {
      if (!p || p.status && p.status !== "pending") continue;
      try {
        const required = p.requiredCandles || DEFAULTS.confirmCandles;
        const tf = p.confirmTF || DEFAULTS.confirmTF;
        // assess confirmation using the recent candles
        const conf = await assessConfirmationByCandles(p.symbol, p.side, required, tf);
        if (conf.ok) {
          // Before sending, micro-ML gating: recompute micro ML average
          let microAvg = null;
          try {
            const microList = [];
            if (Array.isArray(p.perTfResults)) {
              for (const r of p.perTfResults) {
                if (r.tf === "1m" || r.tf === "5m") {
                  if (r.mlMicro && typeof r.mlMicro.prob === "number") microList.push(r.mlMicro.prob);
                  else {
                    try {
                      const mm = await runMicroPrediction(p.symbol, r.tf, options.microLookback || 60);
                      if (mm && typeof mm.prob === "number") microList.push(mm.prob);
                    } catch(e){}
                  }
                }
              }
            }
            if (microList.length) microAvg = microList.reduce((a,b)=>a+b,0)/microList.length;
          } catch(e){ microAvg = null; }

          // block if micro ml strongly contradicts p.side
          if (microAvg !== null) {
            if (p.side === "Bullish" && microAvg < (50 - (options.microMlGateDelta || DEFAULTS.microMlGateDelta))) {
              updatePending(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "micro_ml_contradict" });
              removePending(p.id);
              log("pending blocked by micro-ml contradiction", p.id, p.symbol, microAvg);
              continue;
            }
            if (p.side === "Bearish" && microAvg > (50 + (options.microMlGateDelta || DEFAULTS.microMlGateDelta))) {
              updatePending(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "micro_ml_contradict" });
              removePending(p.id);
              log("pending blocked by micro-ml contradiction", p.id, p.symbol, microAvg);
              continue;
            }
          }

          // Prepare confirmation message (clean)
          const price = p.priceAtDetect || (p.perTfResults && p.perTfResults[0]?.price) || 0;
          const ellTargets = (p.perTfResults && p.perTfResults[0] && p.perTfResults[0].ell && p.perTfResults[0].ell.targets) || [];
          const tpTxt = (ellTargets && ellTargets.length) ? ellTargets.slice(0,3).map(t => Number(t.tp || t.target || t.price || 0).toFixed(2)).join(" / ") : `${(price + 1).toFixed(2)} / ${(price + 2).toFixed(2)}`;
          const slLong = Number((price - 1).toFixed(2));
          const slShort = Number((price + 1).toFixed(2));

          const confirmMsg = [
            `⚡ Reversed (CONFIRMED) — ${p.side}`,
            `Symbol: ${p.symbol} | Confidence: ${Math.round(p.consensusScore || 0)}%`,
            `PriceAtDetect: ${Number(price).toFixed(2)} | TP(s): ${tpTxt}`,
            `SLs: LONG:${slLong} / SHORT:${slShort}`,
            `Observed: ${conf.dirCount}/${conf.closedCount} supportive signals | movePct: ${conf.movedPct.toFixed(3)}%`,
            `ID: ${p.predId || "none"}`
          ].join("\n");

          try { if (typeof sendAlert === "function") await sendAlert(confirmMsg); else log("Would send confirm:", confirmMsg); }
          catch (e) { log("sendAlert err (confirm)", e?.message || e); }

          // mark pending sent and apply cooldown
          updatePending(p.id, { status: "sent", sentAt: new Date().toISOString(), confirmed: true });
          recordSent(p.key, { symbol: p.symbol, side: p.side, predId: p.predId, score: p.consensusScore, note: "confirmed" });

          // schedule ML feedback
          try { await scheduleFeedbackChecks(p.predId, p.symbol, p.side, p.priceAtDetect); } catch(e){ log("scheduleFeedback err", e?.message || e); }

          // remove pending after small delay
          setTimeout(()=> removePending(p.id), 2000);
        } else {
          // not confirmed: increase observed count or fail after long wait
          const observed = (p.observedChecks || 0) + 1;
          updatePending(p.id, { observedChecks: observed, lastCheck: new Date().toISOString() });
          // if too many checks without confirm, mark failed
          if (observed > Math.max(4, (p.requiredCandles || DEFAULTS.confirmCandles) * 3)) {
            // send fail message cleanly so user knows
            const price = p.priceAtDetect || (p.perTfResults && p.perTfResults[0]?.price) || 0;
            const failMsg = [
              `⚠️ Reversal FAILED — ${p.side}`,
              `Symbol: ${p.symbol} | Score: ${Math.round(p.consensusScore || 0)}%`,
              `Reason: Not confirmed in expected candles`,
              `PriceAtDetect: ${Number(price).toFixed(2)}`,
              `ID: ${p.predId || "none"}`
            ].join("\n");
            try { if (typeof sendAlert === "function") await sendAlert(failMsg); else log("Would send fail:", failMsg); } catch(e){ log("sendAlert err (fail)", e?.message || e); }

            updatePending(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "no_confirm" });
            // schedule feedback (failed)
            try { await scheduleFeedbackChecks(p.predId, p.symbol, p.side, p.priceAtDetect); } catch(e){ }
            removePending(p.id);
            recordSent(p.key, { symbol: p.symbol, side: p.side, predId: p.predId, score: p.consensusScore, note: "failed_no_confirm" });
          } else {
            log("pending still waiting", p.id, "observed", observed);
          }
        }
      } catch (e) {
        log("processPending item err", e?.message || e);
      }
    }
  } catch (e) {
    log("processPending error", e?.message || e);
  }
}

// -------------------------
// Public API: start/stop
// -------------------------
let _timers = new Map();

export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", options = {}, sendAlert = null) {
  if (_timers.has(symbol)) {
    log("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, DEFAULTS, options);
  log("Starting Reversal Watcher for", symbol, "opts:", JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs }));

  // main scan tick
  const tick = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {
      log("tick err", e?.message || e);
    }
  };
  // pending processor tick (short interval)
  const pendTick = async () => {
    try { await processPending(sendAlert, opts); } catch(e) { log("pendTick err", e?.message || e); }
  };

  // immediate run then intervals
  tick();
  const idMain = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  const idPend = setInterval(pendTick, Math.max(5000, Math.floor((opts.pollIntervalMs || DEFAULTS.pollIntervalMs) / 2)));

  _timers.set(symbol, { idMain, idPend });
  log("Watcher started:", symbol);
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) {
        clearInterval(rec.idMain); clearInterval(rec.idPend);
        _timers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _timers.entries()) {
        clearInterval(rec.idMain); clearInterval(rec.idPend);
        _timers.delete(s);
      }
    }
    persistStore();
    log("Watcher stopped", symbol || "ALL");
    return true;
  } catch (e) { log("stop err", e?.message || e); return false; }
}

export function getWatcherState() {
  return {
    running: _timers.size > 0,
    symbols: Array.from(_timers.keys()),
    pending: STORE.pending.slice(-50),
    recentAlerts: STORE.alerts.slice(-50),
    hourlyCount: hourlyCount(),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

// If module loaded and configured to auto-start
if (CONFIG?.REVERSE_WATCHER?.AUTO_START && CONFIG.SYMBOL) {
  try { startReversalWatcher(CONFIG.SYMBOL, CONFIG.REVERSE_WATCHER?.OPTIONS || {}, async (msg) => { 
      // if you have a global telegram sender function, replace this or pass on start
      if (typeof global.sendTelegram === "function") await global.sendTelegram(msg); else console.log("ALERT:", msg);
    }); 
  } catch (e) { log("autostart err", e?.message || e); }
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};