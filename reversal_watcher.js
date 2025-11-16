// reversal_watcher.js — Full merged v3.2 (single file)
// ML-gated, multi-TF, cooldown, multi-candle confirmation, pending queue, feedback loop.
// Exports: startReversalWatcher, stopReversalWatcher, getWatcherState, evaluateSymbol

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

// Safe JSON helpers
function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; const txt = fs.readFileSync(fp,"utf8"); return txt ? JSON.parse(txt) : def; }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { try { fs.writeFileSync(fp, JSON.stringify(obj)); return true; } catch{} return false; }
}
function log(...args) {
  const line = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}] ${args.join(" ")}`;
  try { fs.appendFileSync(WATCHER_LOG, line + "\n"); } catch {}
  console.log(line);
}

// -------------------------
// Global defaults (merge with CONFIG.REVERSAL_WATCHER)
// -------------------------
const GLOBAL_DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20000,
  minAlertConfidence: 65,
  mlWeight: 0.18,
  debounceSeconds: 180,           // cooldown window for identical key (seconds)
  confirmationCandles: 3,         // how many candles to wait for confirmation
  confirmationTF: "1m",           // TF used for confirmation candle checks
  requireMLGate: true,
  mlAgreementThreshold: 55,       // ML prob threshold that counts as agreement (pct)
  feedbackWindowsSec: [60,300],   // windows to check outcomes (1m, 5m)
  maxSavedAlerts: 2000,
  allowNeutral: false,
  maxAlertsPerHour: 6,            // soft rate limit
  enablePatternBoost: true,
  patternBoostPoints: 45,
  microMlGateDelta: 2,            // small delta for micro-ML gating (pct)
  confirmTimeoutMs: 25 * 1000,    // max wait for confirmation loop
  cooldownAfterConfirmSec: 300,   // after confirmed alert, silence same-key
  pendingCheckIntervalMs: 15 * 1000, // check pending every 15s
  maxPendingWaits: 6,
  microLookback: 60,
  patternScoreBoost: 50
}, CONFIG.REVERSAL_WATCHER || {});

// -------------------------
// Internal state
// -------------------------
let _watcherTimers = new Map(); // symbol -> { idMain, idPend }
let _running = false;
let _store = safeLoad(ALERT_STORE, { alerts: [], pending: [], hourly: [] });

// normalize store arrays and trim
_store.alerts = Array.isArray(_store.alerts) ? _store.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts) : [];
_store.pending = Array.isArray(_store.pending) ? _store.pending : [];
_store.hourly = Array.isArray(_store.hourly) ? _store.hourly : [];

// helper to record hourly counters (soft rate limit)
function recordHourlyAlert() {
  const now = Date.now();
  _store.hourly.push({ ts: now });
  const cutoff = now - (1000 * 60 * 60);
  _store.hourly = _store.hourly.filter(h => h.ts >= cutoff);
  safeSave(ALERT_STORE, _store);
}
function hourlyCount() { return (_store.hourly || []).length; }

// -------------------------
// Cheap pattern detectors (last 3 candles)
// -------------------------
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);

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
    const pscore = Math.min(90, p.strength || GLOBAL_DEFAULTS.patternScoreBoost);
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
    // ignore indicator problems
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
    // convert mlMain.prob (0..100) into a modest influence scaled by mlWeight
    boost = ((mlMain.prob - 50) / 50) * (GLOBAL_DEFAULTS.mlWeight * 100 / 2);
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";

  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlMainLabel: mlMain?.label || null };
}

// -------------------------
// Debounce + cooldown helpers (improved key + rate-limit)
// -------------------------
function makeDebounceKey(symbol, side, perTfResults = []) {
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
  _store.alerts = (_store.alerts || []).filter(a => a.ts >= cutoff);
}
function recentlyAlerted(key) {
  cleanupRecentAlerts();
  return (_store.alerts || []).some(a => a.key === key);
}
function recordSentAlert(key, meta = {}) {
  _store.alerts = _store.alerts || [];
  _store.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  _store.alerts = _store.alerts.slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
  safeSave(ALERT_STORE, _store);
  // hourly
  recordHourlyAlert();
}

// Pending helpers
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

// Assess confirmation based on N subsequent candles
function assessConfirmation(side, recentCandles) {
  // recentCandles: array oldest->newest of length >= required
  const N = recentCandles.length;
  let directionalCount = 0;
  let movedPct = 0;
  const start = recentCandles[0];
  const last = recentCandles.at(-1);
  if (!start || !last) return { ok:false, reason:"no_candles" };

  movedPct = start.close ? ((last.close - start.close) / Math.max(1, Math.abs(start.close))) * 100 : 0;
  for (const c of recentCandles) {
    if (side === "Bullish" && c.close > c.open) directionalCount++;
    if (side === "Bearish" && c.close < c.open) directionalCount++;
    // also support by wicks
    const body = Math.max(1e-6, Math.abs(c.close - c.open));
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    if (side === "Bullish" && lowerWick > body * 1.6) directionalCount++;
    if (side === "Bearish" && upperWick > body * 1.6) directionalCount++;
  }

  const majority = directionalCount >= Math.ceil(N * 0.6);
  const moveThresholdPct = 0.15; // 0.15%
  const movedEnough = side === "Bullish" ? (movedPct > moveThresholdPct) : (movedPct < -moveThresholdPct);

  return { ok: majority || movedEnough, directionalCount, movedPct };
}

// Outcome check (records to ML module if predId present)
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec) {
  try {
    const resp = await fetchMarketData(symbol, "1m", Math.max(3, Math.ceil(windowSec / 60) + 2));
    const newPrice = resp?.price ?? priceAtSend;
    const movedUp = newPrice > priceAtSend;
    const success = (side === "Bullish") ? movedUp : (!movedUp);
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend)/Math.max(1,Math.abs(priceAtSend))) * 100 : null;
    if (predId && typeof recordOutcome === "function") {
      try { recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice }); } catch (e) {}
    }
    return { ok: true, predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Main evaluateSymbol (candidate detection -> pending confirmation entry)
export async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    opts = Object.assign({}, GLOBAL_DEFAULTS, opts || {});
    const tfs = opts.tfs || GLOBAL_DEFAULTS.tfs;

    // fetch multi-TF
    const multi = await fetchMultiTF(symbol, tfs);

    // ML main (15m) best-effort
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

      // micro ML for 1m/5m
      let mlMicro = null;
      if (["1m","5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || GLOBAL_DEFAULTS.microLookback); } catch (e) { mlMicro = null; }
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

    const consensus = buildConsensus(perTfResults, opts.weights || GLOBAL_DEFAULTS.weights, mlMain);

    // quick trend detection (1h or 15m fallback)
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

    // ML gating: if mlMain exists and is too neutral/contradictory, skip early
    if (mlMain && typeof mlMain.prob === "number" && opts.requireMLGate !== false) {
      if (mlMain.prob < (opts.mlGateMinProb || GLOBAL_DEFAULTS.mlAgreementThreshold) && finalScore < 95) {
        // ML sees neutral/contradictory market — block candidate unless consensus very high
        log("ML gate blocked candidate", symbol, "mlProb:", mlMain.prob, "consensus:", finalScore);
        return { alerted: false, reason: "ml_gate", finalScore, mlMain };
      }
    }

    // candidate threshold to start pending confirmation (slightly lower than alert threshold)
    const pendingThreshold = opts.pendingThreshold || Math.max(0, (opts.minAlertConfidence || GLOBAL_DEFAULTS.minAlertConfidence) - 5);
    if (finalScore >= pendingThreshold) {
      // decide side by pattern majority or mlMain
      const bullCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
      const bearCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
      let side = "Bullish";
      if (bullCount > bearCount) side = "Bullish";
      else if (bearCount > bullCount) side = "Bearish";
      else if (mlMain && mlMain.label) side = mlMain.label;
      else side = finalScore >= 50 ? "Bullish" : "Bearish";

      // do not create pending for neutral if disabled
      if (!opts.allowNeutral && consensus.label === "NONE") {
        return { alerted: false, reason: "neutral_skipped", finalScore };
      }

      const key = makeDebounceKey(symbol, side, perTfResults);

      // rate-limit hourly
      if (hourlyCount() >= (opts.maxAlertsPerHour || GLOBAL_DEFAULTS.maxAlertsPerHour)) {
        log("rate limit hit — skipping pending creation", symbol);
        return { alerted: false, reason: "rate_limited" };
      }

      // if already fully sent recently, skip
      if (recentlyAlerted(key)) {
        log("candidate suppressed by recent alert (debounce)", key, "score:", finalScore);
        return { alerted: false, reason: "debounce_full", key };
      }

      // if already pending same key, skip
      const existingPending = (_store.pending || []).find(p => p.key === key && p.status === "pending");
      if (existingPending) {
        log("already pending", key);
        return { alerted: false, reason: "already_pending", key };
      }

      // record ML prediction entry
      let predId = null;
      try {
        predId = await recordPrediction({
          symbol,
          predictedAt: new Date().toISOString(),
          label: side,
          prob: finalScore,
          features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
          meta: { source: "reversal_watcher_v3_2", mlMain }
        });
      } catch (e) { predId = null; }

      const pendingId = `pending_${Date.now()}_${Math.floor(Math.random()*10000)}`;
      addPendingAlert({
        id: pendingId,
        key,
        symbol,
        side,
        createdAt: new Date().toISOString(),
        ts: Date.now(),
        confirmedCandlesObserved: 0,
        requiredCandles: opts.confirmationCandles || GLOBAL_DEFAULTS.confirmationCandles,
        confirmTf: opts.confirmationTF || GLOBAL_DEFAULTS.confirmationTF,
        priceAtDetect: perTfResults[0]?.price || 0,
        perTfResults,
        predId,
        status: "pending",
        consensusScore: finalScore
      });

      log("pending alert queued", symbol, side, "key:", key, "pendingId:", pendingId, "needCandles:", opts.confirmationCandles || GLOBAL_DEFAULTS.confirmationCandles);
      return { alerted: false, reason: "pending", pendingId, key, finalScore };
    }

    return { alerted: false, score: finalScore, reason: "below_threshold" };

  } catch (e) {
    log("evaluateSymbol error:", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Process pending alerts (confirmation -> send -> feedback)
// -------------------------
async function processPendingAlerts(sendAlert = null, opts = {}) {
  opts = Object.assign({}, GLOBAL_DEFAULTS, opts || {});
  const pending = Array.isArray(_store.pending) ? _store.pending.slice() : [];
  for (const p of pending) {
    try {
      if (!p || p.status !== "pending") continue;

      const tf = p.confirmTf || opts.confirmationTF || GLOBAL_DEFAULTS.confirmationTF;
      const len = p.requiredCandles || opts.confirmationCandles || GLOBAL_DEFAULTS.confirmationCandles;
      // fetch last len candles (+ a bit)
      const resp = await fetchMarketData(p.symbol, tf, len + 5);
      const candles = (resp?.data || []);
      if (!candles || candles.length < len) {
        // wait for more candles
        continue;
      }
      const recent = candles.slice(-len); // oldest->newest
      const conf = assessConfirmation(p.side, recent);

      if (conf.ok) {
        // micro-ML re-check to avoid obvious contradictions
        let mlMicroAvg = null;
        try {
          const microPromises = (p.perTfResults || []).filter(r => r.tf === "1m" || r.tf === "5m").map(async r => {
            if (r.mlMicro) return r.mlMicro;
            try { return await runMicroPrediction(p.symbol, r.tf, opts.microLookback || GLOBAL_DEFAULTS.microLookback); } catch (e){ return null; }
          });
          const microRes = await Promise.all(microPromises);
          const probs = microRes.filter(Boolean).map(m => (m.prob || 50));
          if (probs.length) mlMicroAvg = probs.reduce((a,b)=>a+b,0)/probs.length;
        } catch (e) { mlMicroAvg = null; }

        // block if micro ML strongly opposes
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

        // Compose alert message (TPs/SL fallback)
        const ellTargets = (p.perTfResults && p.perTfResults.length) ? (p.perTfResults[0].ell?.targets || []) : [];
        const atr = (p.perTfResults && p.perTfResults.length) ? indicators.computeATR(p.perTfResults[0].candles || []) : 0;
        const price = p.priceAtDetect || (p.perTfResults && p.perTfResults[0]?.price) || 0;
        const tps = (ellTargets && ellTargets.length) ? ellTargets.slice(0,3).map(t=>Number(t.tp || t.target || t.price || 0)) : [(price + Math.max(1,atr)*2), (price + Math.max(1,atr)*4)];
        const slLong = Number((price - Math.max(1,atr) * 2).toFixed(2));
        const slShort = Number((price + Math.max(1,atr) * 2).toFixed(2));

        const msgLines = [
          `⚡ <b>REVERSED (CONFIRMED)</b> — <b>${p.side}</b>`,
          `Symbol: <b>${p.symbol}</b> | Confidence: <b>${Math.round(p.consensusScore || 0)}%</b>`,
          `PriceAtDetect: ${Number(price).toFixed(2)} | TP(s): ${tps.map(x=>Number(x).toFixed(2)).join(" / ")}`,
          `SLs: LONG:${slLong} / SHORT:${slShort}`,
          `Observed: ${conf.directionalCount}/${recent.length} candles in direction | movePct: ${conf.movedPct.toFixed(3)}%`,
          `ID: ${p.predId || "none"}`
        ];
        const text = msgLines.join("\n");

        // send alert
        try {
          if (typeof sendAlert === "function") {
            await sendAlert(text);
          } else {
            log("Would send confirmed alert:", text);
          }
        } catch (e) {
          log("Error sending confirmed alert:", e?.message || e);
        }

        // mark sent and record cooldown/debounce
        recordSentAlert(p.key, { symbol: p.symbol, side: p.side, predId: p.predId, score: p.consensusScore, sentAt: Date.now() });
        updatePendingAlert(p.id, { status: "sent", sentAt: new Date().toISOString() });

        // schedule feedback checks
        (opts.feedbackWindowsSec || GLOBAL_DEFAULTS.feedbackWindowsSec).forEach((win) => {
          setTimeout(async () => {
            try {
              const outcome = await checkOutcome(p.predId, p.symbol, p.side, price, win);
              log("feedback result", p.symbol, p.side, "win:", win, JSON.stringify(outcome));
              updatePendingAlert(p.id, { status: outcome.success ? "done" : "failed", closedAt: new Date().toISOString(), outcome });
              // remove pending after record (non-blocking)
              setTimeout(()=> removePendingAlert(p.id), 2000);
            } catch (e) { log("feedback scheduling error:", e?.message || e); }
          }, win * 1000);
        });

        // apply cooldown (avoid duplicate same-key alerts for cooldownAfterConfirmSec)
        // we already recorded the sent alert (which affects recentlyAlerted)
      } else {
        // not confirmed: update observed count and maybe fail after too many cycles
        const observed = (p.confirmedCandlesObserved || 0) + 1;
        updatePendingAlert(p.id, { confirmedCandlesObserved: observed, lastCheck: new Date().toISOString() });
        const maxWaitWindows = (opts.maxPendingWaits || GLOBAL_DEFAULTS.maxPendingWaits);
        if (observed >= (p.requiredCandles || GLOBAL_DEFAULTS.confirmationCandles) + maxWaitWindows) {
          updatePendingAlert(p.id, { status: "failed", closedAt: new Date().toISOString(), note: "no_confirm" });
          removePendingAlert(p.id);
          log("pending failed (no confirm)", p.id, p.key);
        } else {
          log("pending still waiting", p.id, "observed", observed, "needed", p.requiredCandles);
        }
      }
    } catch (e) {
      log("processPendingAlerts error:", e?.message || e);
    }
  }
  // persist store after processing loop
  safeSave(ALERT_STORE, _store);
}

// -------------------------
// Public API: start/stop
// -------------------------
export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_watcherTimers.has(symbol)) {
    log("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, GLOBAL_DEFAULTS, options || {});
  log("Starting Reversal Watcher v3.2 for", symbol, "opts:", JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs, minAlertConfidence: opts.minAlertConfidence }));

  // main candidate tick
  const tick = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {
      log("Watcher tick error:", e?.message || e);
    }
  };

  // pending processor tick
  const pendTick = async () => {
    try {
      await processPendingAlerts(sendAlert, opts);
      // prune old alerts and pending
      _store.alerts = (_store.alerts || []).slice(-GLOBAL_DEFAULTS.maxSavedAlerts);
      _store.pending = (_store.pending || []).filter(p => p && p.ts && (Date.now() - p.ts) < (24 * 60 * 60 * 1000));
      safeSave(ALERT_STORE, _store);
    } catch (e) {
      log("pendTick exception:", e?.message || e);
    }
  };

  // start intervals
  tick(); // run immediately
  const idMain = setInterval(tick, opts.pollIntervalMs || GLOBAL_DEFAULTS.pollIntervalMs);
  const idPend = setInterval(pendTick, opts.pendingCheckIntervalMs || GLOBAL_DEFAULTS.pendingCheckIntervalMs);

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
  } catch (e) {
    log("stopReversalWatcher error:", e?.message || e);
    return false;
  }
}

export function getWatcherState() {
  return {
    running: _running,
    symbols: Array.from(_watcherTimers.keys()),
    pending: (_store.pending || []).slice(-50),
    recentAlerts: (_store.alerts || []).slice(-50),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

// default export
export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState,
  evaluateSymbol
};
