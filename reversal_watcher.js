// reversal_watcher.js — PATCHED FINAL (v3)
// Drop-in replacement for aiTraderBot.js usage of startReversalWatcher / stopReversalWatcher.
// Features: multi-TF, patterns, RSI/MACD/ATR, volume check, micro-ML immediate signal, ML main gating,
// confirmation candles, tp/sl building, feedback -> ml_module_v8_6.recordOutcome

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

// -------------------------
// Persistence
// -------------------------
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

// -------------------------
// Defaults (can be tuned via CONFIG.REVERSAL_WATCHER)
// -------------------------
const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 52,           // start pending
  minAlertConfidence: 55,         // final minimal confidence
  confirmCandles: 2,              // quick confirm candles
  confirmationTF: "1m",
  debounceSeconds: 60,
  cooldownAfterConfirmSec: 600,
  maxSavedAlerts: 2000,
  microImmediateProbPct: 70,      // micro-ML prob threshold to fire immediate micro-alert (0..100)
  microRequirePattern: true,      // require pattern to be present for micro immediate alerts (recommended)
  volumeMultiplier: 0.8,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2,4],
  maxPendingAgeMs: 12 * 60 * 60 * 1000,
  feedbackWindowsSec: [60, 300],
  maxAlertsPerHour: 9999,
  allowNeutral: true
}, (CONFIG && CONFIG.REVERSAL_WATCHER) || {});

// load store
let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// -------------------------
// Helpers: recent/ hourly
// -------------------------
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
  STORE.recent = (STORE.recent || []).filter(r => r.ts >= cutoff).slice(-DEFAULTS.maxSavedAlerts);
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

// -------------------------
// Pattern detection (robust, cheap)
// -------------------------
function detectPatterns(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const body = Math.max(1e-6, Math.abs(last.close - last.open));
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  // Hammer / Pin bar
  if (lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) out.push({ name: "Hammer", side: "Bullish", strength: 70 });
  // Shooting star
  if (upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) out.push({ name: "ShootingStar", side: "Bearish", strength: 70 });
  // Engulfing
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });
  // Tweezer
  if (Math.abs(prev.high - last.high) < (Math.max(1, Math.abs(prev.high)) * 0.0005) && last.close < last.open) out.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (Math.abs(prev.low - last.low) < (Math.max(1, Math.abs(prev.low)) * 0.0005) && last.close > last.open) out.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });
  // Doji
  if (body / Math.max(1e-6, (last.high - last.low)) < 0.18) out.push({ name: "Doji", side: "Neutral", strength: 40 });
  // Morning/Evening star (crude)
  if (prev2 && prev && last && prev2.close < prev2.open && last.close > last.open && last.close > prev.close) out.push({ name: "MorningStar", side: "Bullish", strength: 72 });
  if (prev2 && prev && last && prev2.close > prev2.open && last.close < last.open && last.close < prev.close) out.push({ name: "EveningStar", side: "Bearish", strength: 72 });

  return out;
}

// -------------------------
// TF scoring (pattern + indicators + volume)
// returns { score: 0..100, patterns, reasons }
// -------------------------
function computeTFScore({ candles = [], tf = "15m", tfWeight = 1 }) {
  const out = { score: 50, patterns: [], reasons: [] };
  if (!Array.isArray(candles) || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength/2 : -p.strength/2);
    out.reasons.push(`pattern:${p.name}`);
  }

  try {
    const rsi = (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : null;
    const macd = (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : null;
    const atr = (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : null;
    // volume detection (last vs avg)
    const lastVol = candles.at(-1).volume ?? candles.at(-1).vol ?? candles.at(-1).v ?? 0;
    const volWindow = Math.min(20, candles.length);
    const avgVol = candles.slice(-volWindow).reduce((s,c) => s + (c.volume||c.vol||c.v||0), 0) / Math.max(1, volWindow);

    if (typeof rsi === "number") {
      if (rsi < 30) { out.score += 8; out.reasons.push("rsi_oversold"); }
      if (rsi > 70) { out.score -= 8; out.reasons.push("rsi_overbought"); }
    }
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { out.score += 6; out.reasons.push("macd_pos"); }
      else if (macd.hist < 0) { out.score -= 6; out.reasons.push("macd_neg"); }
    }
    if (avgVol && lastVol) {
      if (lastVol > avgVol * DEFAULTS.volumeMultiplier) { out.score += 6; out.reasons.push("vol_spike"); }
      if (lastVol < avgVol * 0.6) { out.score -= 3; out.reasons.push("vol_drop"); }
    }
  } catch (e) {
    // ignore indicator errors
  }

  out.score = Math.round(Math.max(0, Math.min(100, out.score)) * (tfWeight || 1));
  return out;
}

// -------------------------
// Consensus builder
// -------------------------
function buildConsensus(perTfResults = [], weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  for (const r of perTfResults) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += (r.score ?? 50) * w;
  }
  const avg = sumW ? (sumS / sumW) : 50;

  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    // mlMain.prob in percent e.g. 72 -> convert to -10..10
    boost = ((mlMain.prob - 50) / 50) * 10;
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";

  return { final, label, breakdown: perTfResults.map(r => ({ tf: r.tf, score: r.score, patterns: r.patterns })) , mlBoost: Math.round(boost*100)/100, mlLabel: mlMain?.label || null };
}

// -------------------------
// TP/SL builder
// -------------------------
function makeTPsAndSLs({ ellSummary = null, ellTargets = [], atr = 0, price = 0 }) {
  const tps = [];
  try {
    if (Array.isArray(ellTargets) && ellTargets.length) {
      for (const t of ellTargets.slice(0,4)) {
        const tp = Number(t.tp || t.target || t.price || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
    if (!tps.length && ellSummary && ellSummary.resistance) {
      tps.push({ source: "ElliottZoneHi", tp: ellSummary.resistance, confidence: 40 });
    }
    if (!tps.length) {
      const a = Math.max(1, atr || 1);
      tps.push({ source: "ATR_x2", tp: Number((price + a * DEFAULTS.tpAtrMultipliers[0]).toFixed(2)), confidence: 30 });
      tps.push({ source: "ATR_x4", tp: Number((price + a * DEFAULTS.tpAtrMultipliers[1]).toFixed(2)), confidence: 25 });
    }
    const sls = [
      { side: "LONG", sl: Number((price - Math.max(1, atr) * DEFAULTS.slAtrMultiplier).toFixed(2)) },
      { side: "SHORT", sl: Number((price + Math.max(1, atr) * DEFAULTS.slAtrMultiplier).toFixed(2)) }
    ];
    return { tps, sls };
  } catch (e) { return { tps: [], sls: [] }; }
}

// -------------------------
// Debounce key
// -------------------------
function makeDebounceKey(symbol, side, perTfResults = []) {
  const patterns = perTfResults.flatMap(r => (r.patterns||[]).map(p => `${r.tf}:${p.name}`)).sort().join("|") || "NOPAT";
  const scores = perTfResults.map(r => `${r.tf}:${Math.round(r.score||0)}`).sort().join("|") || "NOSCORE";
  const priceZone = perTfResults[0] && perTfResults[0].price ? Math.round(perTfResults[0].price / 10) : "P0";
  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}

// -------------------------
// Confirmation: wait N closed candles on confirmationTF
// -------------------------
async function confirmAcrossCandles(symbol, side, requiredCandles = DEFAULTS.confirmCandles, confirmationTF = DEFAULTS.confirmationTF, timeoutMs = 20 * 1000) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const resp = await fetchMarketData(symbol, confirmationTF, requiredCandles + 3);
      const candles = resp?.data || [];
      if (!Array.isArray(candles) || candles.length < requiredCandles + 1) {
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
      const closed = candles.slice(- (requiredCandles + 1), -1); // last N closed
      if (closed.length < requiredCandles) {
        await new Promise(r => setTimeout(r, 700));
        continue;
      }
      let supportCount = 0;
      for (const c of closed) {
        const movedUp = (c.close > c.open);
        if (side === "Bullish" && movedUp) supportCount++;
        if (side === "Bearish" && !movedUp) supportCount++;
        const body = Math.abs(c.close - c.open) || 1;
        const upper = c.high - Math.max(c.close, c.open);
        const lower = Math.min(c.close, c.open) - c.low;
        if (side === "Bullish" && lower > body * 1.6) supportCount++;
        if (side === "Bearish" && upper > body * 1.6) supportCount++;
      }
      const needed = Math.ceil(closed.length * 0.6);
      return { confirmed: supportCount >= needed, supportCount, needed, closedLast: closed.at(-1), closed };
    } catch (e) {
      await new Promise(r => setTimeout(r, 700));
    }
  }
  return { confirmed: false, reason: "timeout" };
}

// -------------------------
// Outcome check (used for feedback scheduling)
// -------------------------
async function checkPostOutcome(pending, windowSec) {
  try {
    const resp = await fetchMarketData(pending.symbol, "1m", Math.max(3, Math.ceil(windowSec/60) + 2));
    const newPrice = resp?.price ?? null;
    const priceAtSend = pending.priceAtDetect ?? (pending.perTfResults && pending.perTfResults[0]?.price) || 0;
    const movedUp = newPrice > priceAtSend;
    const success = (pending.side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100 : null;
    return { ok: true, predId: pending.predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) { return { ok:false, error: e?.message || String(e) }; }
}

// -------------------------
// Main evaluateSymbol
// - Does multi-TF scoring, ML main gating, micro-ML immediate triggers,
//   creates pending, previews alert (pending) and returns result
// -------------------------
async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs.concat(["1h"])); // include 1h optionally
    // run ML main (best effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (candles.at(-1)?.close ?? 0);
      const tfWeight = (opts.weights && typeof opts.weights[tf] === "number") ? opts.weights[tf] : (DEFAULTS.weights[tf] || 1);
      const sc = computeTFScore({ candles, tf, tfWeight });
      perTfResults.push({
        tf,
        price,
        candles,
        score: sc.score,
        reasons: sc.reasons,
        patterns: sc.patterns
      });
    }

    // micro-ML (fast) check for immediate micro-alerts
    let micro = null;
    try { micro = await runMicroPrediction(symbol, opts.microLookback || 60); } catch (e) { micro = null; }

    // If micro-ML strongly indicates a direction and pattern present (if required), raise immediate micro alert
    if (micro && typeof micro.prob === "number") {
      const microProb = micro.prob; // percent-ish value in runMicroPrediction implementation
      let microLabel = (micro.probBull && micro.probBull > micro.probBear) ? "Bullish" : (micro.probBear && micro.probBear > micro.probBull) ? "Bearish" : micro.label || "Neutral";
      const microStrong = microProb >= (opts.microImmediateProbPct || DEFAULTS.microImmediateProbPct);
      // check pattern presence across TFs
      const anyPattern = perTfResults.some(r => Array.isArray(r.patterns) && r.patterns.length);
      if (microStrong && (DEFAULTS.microRequirePattern ? anyPattern : true)) {
        // immediate micro alert - we still record pred & schedule feedback but mark as micro
        const side = microLabel === "Bullish" ? "Bullish" : microLabel === "Bearish" ? "Bearish" : null;
        if (side) {
          const key = makeDebounceKey(symbol, side, perTfResults);
          if (!recentlyAlerted(key)) {
            // record prediction
            let predId = null;
            try {
              predId = await recordPrediction({
                symbol,
                predictedAt: new Date().toISOString(),
                label: side,
                prob: microProb,
                features: micro.features || micro.featureVector || {},
                meta: { source: "micro_ml_immediate" }
              });
            } catch(e){ predId = null; }
            // build small immediate alert
            const price = perTfResults[0]?.price ?? 0;
            const atr = perTfResults[0]?.candles ? indicators.computeATR(perTfResults[0].candles) : 0;
            const tpsAndSls = makeTPsAndSLs({ ellSummary: null, ellTargets: [], atr, price });
            const txt = [
              `⚡ <b>MICRO-ML ALERT (IMMEDIATE)</b> — <b>${side}</b>`,
              `Symbol: <b>${symbol}</b> | Prob: <b>${Math.round(microProb)}%</b>`,
              `Price: ${Number(price).toFixed(2)} | TP: ${tpsAndSls.tps.map(t=>t.tp).slice(0,2).join(" / ")}`,
              `SLs: LONG:${tpsAndSls.sls.find(s=>s.side==="LONG")?.sl || "n/a"} | SHORT:${tpsAndSls.sls.find(s=>s.side==="SHORT")?.sl || "n/a"}`,
              `ID: ${predId || "none"}`
            ].join("\n");
            try { if (typeof sendAlert === "function") await sendAlert(txt); } catch(e){}
            addRecent(key);
            // schedule feedback checks similar to pending alerts (so micro predictions train ML)
            (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
              setTimeout(async () => {
                try {
                  const outcome = await checkPostOutcome({ symbol, side, priceAtDetect: price, predId }, win);
                  if (predId) await recordOutcome(predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice });
                } catch(e){}
              }, win * 1000);
            });
            // return early — micro alert sent
            return { alerted: true, type: "micro", side, score: microProb };
          }
        }
      }
    }

    // build consensus from per-TF
    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    // gating: require pendingThreshold
    if (finalScore < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      return { alerted: false, reason: "below_threshold", score: finalScore, consensus };
    }

    // decide side by pattern majority then mlMain fallback
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

    const key = makeDebounceKey(symbol, side, perTfResults);

    if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };
    if (hourlyCount() >= (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) return { alerted: false, reason: "rate_limit" };

    // ML main contradiction check: only block if ML strongly opposite
    if (mlMain && typeof mlMain.prob === "number") {
      const mlSide = mlMain.prob > 55 ? "Bullish" : mlMain.prob < 45 ? "Bearish" : "Neutral";
      if (mlSide !== "Neutral" && mlSide !== side && (mlMain.prob > (opts.mlMainGateMinProb || DEFAULTS.mlMainGateMinProb))) {
        return { alerted: false, reason: "ml_contradict", mlProb: mlMain.prob, mlSide };
      }
    }

    // create pending
    const id = `pend_${Date.now()}_${Math.floor(Math.random()*9000)}`;
    const pending = {
      id,
      key,
      symbol,
      side,
      createdAt: Date.now(),
      priceAtDetect: perTfResults[0]?.price ?? 0,
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
        features: { perTf: perTfResults.map(r=>({ tf: r.tf, score: r.score })) },
        meta: { source: "reversal_watcher_v3", mlMain }
      });
    } catch (e) { pending.predId = null; }

    // push pending
    STORE.pending = STORE.pending || [];
    STORE.pending.push(pending);
    safeSave(STORE_FILE, STORE);

    // send preview pending alert
    const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
    let ell = null;
    try { ell = await analyzeElliott(perTfResults[0].candles); } catch(e){ ell = null; }
    const targets = makeTPsAndSLs({ ellSummary: ell && ell.ok ? { support: ell.support, resistance: ell.resistance } : null, ellTargets: ell?.targets || [], atr, price: pending.priceAtDetect });

    const preview = [
      `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
      `Symbol: <b>${symbol}</b> | Confidence: <b>${Math.round(finalScore)}%</b>`,
      `PriceAtDetect: ${Number(pending.priceAtDetect).toFixed(2)} | TP(s): ${targets.tps.map(t => Number(t.tp).toFixed(2)).slice(0,2).join(" / ")}`,
      `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} / SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
      `Waiting for ${pending.requiredCandles} x ${pending.confirmationTF} candle(s) to confirm...`,
      `ID: ${pending.predId || "none"}`
    ].join("\n");

    try { if (typeof sendAlert === "function") await sendAlert(preview); } catch(e){}

    return { alerted: true, type: "pending", pendingId: id, key, score: finalScore };
  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Process pending queue: confirm each pending & send final alert
// -------------------------
async function processPendingQueue(sendAlert = null, opts = {}) {
  const pendingList = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  const now = Date.now();
  for (const p of pendingList) {
    try {
      // stale expiry
      if (now - (p.createdAt || 0) > (opts.maxPendingAgeMs || DEFAULTS.maxPendingAgeMs)) {
        // mark expired & remove
        STORE.pending = STORE.pending.filter(x => x.id !== p.id);
        safeSave(STORE_FILE, STORE);
        continue;
      }

      // confirm
      const conf = await confirmAcrossCandles(p.symbol, p.side, p.requiredCandles || DEFAULTS.confirmCandles, p.confirmationTF || DEFAULTS.confirmationTF, (opts.confirmTimeoutMs || DEFAULTS.confirmTimeoutMs));
      if (!conf.confirmed) {
        // if timed out / not enough closed candles -> skip waiting
        if (conf.reason === "timeout") continue;
        // else if explicitly not confirmed, mark failed
        if (conf.confirmed === false && typeof conf.supportCount === "number") {
          // invalidated
          try { if (typeof sendAlert === "function") await sendAlert(`🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\nID: ${p.predId || "none"}`); } catch(e){}
          if (p.predId) {
            try { await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch(e){}
          }
          STORE.pending = STORE.pending.filter(x => x.id !== p.id);
          safeSave(STORE_FILE, STORE);
          continue;
        }
        continue;
      }

      // confirmed -> final alert
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch(e){ ell = null; }
      const targets = makeTPsAndSLs({ ellSummary: ell && ell.ok ? { support: ell.support, resistance: ell.resistance } : null, ellTargets: ell?.targets || [], atr, price });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Symbol: <b>${p.symbol}</b> | Confidence: <b>${Math.round(p.consensusScore||0)}%</b>`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${targets.tps.map(t => `${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
        `Observed support: ${conf.supportCount}/${conf.needed} | movePct: ${Number(conf.movedPct??0).toFixed(3)}%`,
        `ID: ${p.predId || "none"}`
      ].join("\n");

      try { if (typeof sendAlert === "function") await sendAlert(msg); } catch (e){}

      // mark sent & cooldown
      addRecent(p.key);
      // record outcome after feedback windows
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            if (p.predId) {
              try { await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch(e){}
            }
            // update store (mark done/failed)
            STORE.pending = STORE.pending.filter(x => x.id !== p.id);
            safeSave(STORE_FILE, STORE);
          } catch(e){}
        }, win * 1000);
      });
    } catch (e) {
      // keep loop alive
    }
  }
}

// -------------------------
// Public API: start/stop
// -------------------------
let _timers = new Map(); // symbol -> { mainId, pendId }
let _running = false;

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = null) {
  if (_timers.has(symbol)) {
    // already running
    return false;
  }
  const opts = Object.assign({}, DEFAULTS, options || {});
  // main detection tick
  const tick = async () => {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch (e) {}
  };
  // pending processor tick
  const pend = async () => {
    try { await processPendingQueue(sendAlert, opts); } catch (e) {}
  };

  // immediate run then schedule
  tick();
  const mainId = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  // pend every ~10-15s
  const pendInterval = Math.max(7*1000, Math.min(30*1000, Math.floor((opts.confirmCandles||DEFAULTS.confirmCandles) * 12 * 1000)));
  const pendId = setInterval(pend, pendInterval);

  _timers.set(symbol, { mainId, pendId });
  _running = true;
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) {
        if (rec.mainId) clearInterval(rec.mainId);
        if (rec.pendId) clearInterval(rec.pendId);
        _timers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _timers.entries()) {
        if (rec.mainId) clearInterval(rec.mainId);
        if (rec.pendId) clearInterval(rec.pendId);
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

