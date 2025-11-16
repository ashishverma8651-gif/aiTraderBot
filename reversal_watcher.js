// reversal_watcher_v3.js — Reversal Watcher v3 (MicroML + MainML + Patterns + Feedback)
// Single-file drop-in. Exports: startReversalWatcher, stopReversalWatcher, getWatcherState

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
// Storage & defaults
// -------------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_v3_store.json");

function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; return JSON.parse(fs.readFileSync(fp,"utf8") || "{}"); }
  catch (e) { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { return false; }
}

const DEFAULTS = Object.assign({
  tfs: ["1m","5m","15m"],
  weights: { "1m": 0.2, "5m": 0.3, "15m": 0.5 },
  pollIntervalMs: 20 * 1000,
  microImmediateProbPct: 70,      // micro-ML immediate alert threshold (percent)
  microPatternRequire: true,      // require pattern + micro-ML for immediate
  pendingThreshold: 55,           // consensus to create pending
  minAlertConfidence: 60,         // final can use to gate if desired
  confirmCandles: 2,
  confirmationTF: "1m",
  debounceSeconds: 60,
  cooldownAfterConfirmSec: 300,
  feedbackWindowsSec: [60, 300],
  maxSavedAlerts: 2000,
  volumeMultiplier: 0.9,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2,4],
  maxAlertsPerHour: 20,
  allowNeutral: true
}, CONFIG.REVERSAL_WATCHER || {});

let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-DEFAULTS.maxSavedAlerts) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// -------------------------
// Helpers: record keeping
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
  STORE.recent = (STORE.recent || []).filter(r => r.ts >= cutoff);
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
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

// -------------------------
// Pattern detection (comprehensive-ish, cheap)
// -------------------------
function detectPatterns(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return [];
  const last = candles.at(-1), prev = candles.at(-2), prev2 = candles.at(-3);
  const out = [];
  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.close, last.open);
  const lower = Math.min(last.close, last.open) - last.low;

  // Hammer / Pin
  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open) out.push({ name: "Hammer", side: "Bullish", strength: 70 });
  // Shooting star
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open) out.push({ name: "ShootingStar", side: "Bearish", strength: 70 });
  // Engulfing
  if (prev && prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
  if (prev && prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });
  // Tweezer
  if (prev && Math.abs(prev.high - last.high) / Math.max(1, Math.abs(prev.high)) < 0.0006 && last.close < last.open) out.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (prev && Math.abs(prev.low - last.low) / Math.max(1, Math.abs(prev.low)) < 0.0006 && last.close > last.open) out.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });
  // Doji
  if (body / Math.max(1, (last.high - last.low)) < 0.2) out.push({ name: "Doji", side: "Neutral", strength: 40 });
  // Morning/Evening star (crude)
  if (prev2 && prev && prev2.close < prev2.open && last.close > last.open && last.close > prev.close) out.push({ name: "MorningStar", side: "Bullish", strength: 72 });
  if (prev2 && prev && prev2.close > prev2.open && last.close < last.open && last.close < prev.close) out.push({ name: "EveningStar", side: "Bearish", strength: 72 });

  return out;
}

// -------------------------
// TF scoring
// -------------------------
function computeTFScore({ candles = [], tf = "15m", weight = 1 }) {
  const out = { score: 50, reasons: [], patterns: [] };
  if (!Array.isArray(candles) || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength/2 : -p.strength/2);
    out.reasons.push(`pattern:${p.name}`);
  }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : null;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : null;
    const atr = typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : null;

    const lastVol = candles.at(-1).vol ?? candles.at(-1).v ?? candles.at(-1).volume ?? 0;
    const volWindow = Math.min(20, candles.length);
    const avgVol = candles.slice(-volWindow).reduce((s,c)=>s + (c.vol ?? c.v ?? c.volume ?? 0),0) / Math.max(1,volWindow);

    if (typeof rsi === "number") {
      if (rsi < 30) { out.score += 8; out.reasons.push("rsi_oversold"); }
      if (rsi > 70) { out.score -= 8; out.reasons.push("rsi_overbought"); }
    }
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { out.score += 6; out.reasons.push("macd_pos"); }
      if (macd.hist < 0) { out.score -= 6; out.reasons.push("macd_neg"); }
    }
    if (avgVol && lastVol) {
      if (lastVol > avgVol * DEFAULTS.volumeMultiplier) { out.score += 6; out.reasons.push("vol_spike"); }
      if (lastVol < avgVol * 0.6) { out.score -= 4; out.reasons.push("vol_drop"); }
    }
  } catch (e) {
    // ignore
  }

  out.score = Math.round(Math.max(0, Math.min(100, out.score)) * (weight || 1));
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
    boost = ((mlMain.prob - 50) / 50) * 10 * (DEFAULTS.allowNeutral ? 0.8 : 1);
  }
  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 80 ? "STRONG" : final >= 65 ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";
  return { final, label, breakdown: perTfResults.map(r=>({tf:r.tf,score:r.score,patterns:r.patterns})) , mlBoost: Math.round(boost*100)/100 };
}

// -------------------------
// TP/SL builder
// -------------------------
function buildTPsAndSLs({ ellObj = null, price = 0, atr = 0 }) {
  const tps = [];
  if (ellObj && Array.isArray(ellObj.targets) && ellObj.targets.length) {
    for (const t of ellObj.targets.slice(0,4)) {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (tp) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
    }
  }
  if (!tps.length) {
    for (const m of DEFAULTS.tpAtrMultipliers) {
      tps.push({ source: `ATR_x${m}`, tp: Number((price + Math.max(1,atr) * m).toFixed(2)), confidence: 30 });
    }
  }
  const sls = [
    { side: "LONG", sl: Number((price - Math.max(1,atr) * DEFAULTS.slAtrMultiplier).toFixed(2)) },
    { side: "SHORT", sl: Number((price + Math.max(1,atr) * DEFAULTS.slAtrMultiplier).toFixed(2)) }
  ];
  return { tps, sls };
}

// -------------------------
// Debounce key generator
// -------------------------
function makeKey(symbol, side, perTfResults = []) {
  const pat = perTfResults.flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`)).sort().join("|") || "NOPAT";
  const scores = perTfResults.map(r => `${r.tf}:${Math.round(r.score||0)}`).sort().join("|") || "NOSCORE";
  const price = Math.round((perTfResults[0]?.price || 0));
  return `${symbol}_${side}_${pat}_${scores}_${price}`;
}

// -------------------------
// Pending storage helpers
// -------------------------
function addPending(p) { STORE.pending = STORE.pending || []; STORE.pending.push(p); safeSave(STORE_FILE, STORE); }
function updatePending(id, patch) { STORE.pending = STORE.pending || []; for (let i=0;i<STORE.pending.length;i++){ if (STORE.pending[i].id===id){ STORE.pending[i] = Object.assign({}, STORE.pending[i], patch); break; } } safeSave(STORE_FILE, STORE); }
function removePending(id) { STORE.pending = (STORE.pending || []).filter(x => x.id !== id); safeSave(STORE_FILE, STORE); }

// -------------------------
// Confirm N closed candles routine
// -------------------------
async function confirmAcrossCandles(symbol, side, confirmationCandles = DEFAULTS.confirmCandles, confirmationTF = DEFAULTS.confirmationTF) {
  try {
    const resp = await fetchMarketData(symbol, confirmationTF, confirmationCandles + 3);
    const candles = resp?.data || [];
    if (!Array.isArray(candles) || candles.length < confirmationCandles + 1) return { confirmed:false, reason:"not_enough" };
    const closed = candles.slice(-(confirmationCandles + 1), -1); // last N closed
    if (closed.length < confirmationCandles) return { confirmed:false, reason:"not_enough_closed" };

    let support = 0;
    for (const c of closed) {
      const movedUp = (c.close > c.open);
      if (side === "Bullish" && movedUp) support++;
      if (side === "Bearish" && !movedUp) support++;
      const body = Math.max(1e-6, Math.abs(c.close - c.open));
      const lowerWick = Math.min(c.close, c.open) - c.low;
      const upperWick = c.high - Math.max(c.close, c.open);
      if (side === "Bullish" && lowerWick > body * 1.6) support++;
      if (side === "Bearish" && upperWick > body * 1.6) support++;
    }
    const needed = Math.ceil(closed.length * 0.6);
    const ok = support >= needed;
    const start = closed[0].close;
    const last = closed.at(-1).close;
    const movedPct = start ? ((last - start) / Math.max(1, Math.abs(start))) * 100 : 0;
    return { confirmed: ok, support, needed, movedPct, closedLast: closed.at(-1) };
  } catch (e) {
    return { confirmed:false, error: e?.message || String(e) };
  }
}

// -------------------------
// Outcome check helper (post-send)
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec) {
  try {
    const resp = await fetchMarketData(symbol, "1m", Math.max(3, Math.ceil(windowSec/60) + 2));
    const newPrice = resp?.price ?? priceAtSend;
    const movedUp = newPrice > priceAtSend;
    const success = (side === "Bullish") ? movedUp : !movedUp;
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100 : null;
    if (predId) {
      try { await recordOutcome(predId, { correct: !!success, realizedReturn, realizedPrice: newPrice }); } catch (e) {}
    }
    return { ok:true, predId, windowSec, priceAtSend, newPrice, success, realizedReturn };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// -------------------------
// Main evaluateSymbol: detect candidates, micro immediate, pending creation
// -------------------------
async function evaluateSymbol(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs.concat(["1h"])); // include 1h if available
    // main ML prediction (best-effort)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (candles.at(-1)?.close ?? 0);
      const tfWeight = opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1;
      const sc = computeTFScore({ candles, tf, weight: tfWeight });
      perTfResults.push({ tf, price, candles, score: sc.score, reasons: sc.reasons, patterns: sc.patterns });
    }

    // micro ML (1m/5m) - average if both present
    let micro = null;
    try {
      const m1 = await runMicroPrediction(symbol, 60).catch(()=>null);
      micro = m1;
    } catch {}

    // consensus
    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    // quick trend (15m/1h)
    let trend = "FLAT";
    try {
      const hc = multi["1h"] || multi["15m"];
      const closes = (hc?.data || []).map(c => c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        trend = last > prev ? "UP" : last < prev ? "DOWN" : "FLAT";
      }
    } catch {}

    // 1) Micro immediate alert: when micro ML is strong + pattern agreement
    try {
      if (micro && typeof micro.prob === "number") {
        // micro.prob is percent (in runMicroPrediction we returned as 0..100)
        const microProb = micro.prob;
        const microLabel = micro.label || (microProb > 50 ? "Bullish" : "Bearish");
        const microStrong = microProb >= (opts.microImmediateProbPct ?? DEFAULTS.microImmediateProbPct);
        // require micro pattern present in 1m TF if configured
        const patterns1m = perTfResults.find(r=>r.tf==="1m")?.patterns || [];
        const patternAgreement = patterns1m.some(p => (p.side === "Bullish" && microLabel === "Bullish") || (p.side === "Bearish" && microLabel === "Bearish"));
        if (microStrong && (!DEFAULTS.microPatternRequire || patternAgreement)) {
          // immediate micro alert (but still create pending confirmation so feedback happens)
          const side = microLabel;
          const key = makeKey(symbol, side, perTfResults);
          if (!recentlyAlerted(key)) {
            // build preview
            const price = perTfResults[0]?.price || 0;
            const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
            let ell = null;
            try { ell = await analyzeElliott(perTfResults[0].candles); } catch {}
            const targets = buildTPsAndSLs({ ellSummary: ell && ell.ok ? ell : null, ellObj: ell && ell.ok ? ell : null, price, atr });
            const text = [
              `⚡ <b>MICRO-REVERSAL (IMMEDIATE)</b> — <b>${side}</b>`,
              `Symbol: <b>${symbol}</b> | MicroProb: <b>${Math.round(microProb)}%</b> | PatternAgree: ${patternAgreement}`,
              `Price: ${Number(price).toFixed(2)} | TP(s): ${targets.tps.map(t=>t.tp).slice(0,2).join(" / ")}`,
              `SLs: LONG:${targets.sls.find(s=>s.side==='LONG')?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==='SHORT')?.sl || "n/a"}`,
              `Note: Confirmation pending on ${opts.confirmationTF || DEFAULTS.confirmationTF} x ${opts.confirmCandles || DEFAULTS.confirmCandles}`
            ].join("\n");
            try { if (typeof sendAlert === "function") await sendAlert(text); } catch(e){}
            addRecent(key);
          }
          // also create a pending entry (if not already)
          const side = microLabel;
          const key = makeKey(symbol, side, perTfResults);
          const existsPending = (STORE.pending || []).some(p => p.key === key && p.status === "pending");
          if (!existsPending) {
            const pend = {
              id: `p_${Date.now()}_${Math.floor(Math.random()*9000)}`,
              key,
              symbol,
              side,
              createdAt: Date.now(),
              priceAtDetect: perTfResults[0]?.price || 0,
              perTfResults,
              predId: null,
              status: "pending",
              requiredCandles: opts.confirmCandles ?? DEFAULTS.confirmCandles,
              confirmationTF: opts.confirmationTF ?? DEFAULTS.confirmationTF,
              consensusScore: finalScore,
              source: "micro_immediate"
            };
            try {
              pend.predId = await recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: pend.side, prob: finalScore, features: { micro } }).catch(()=>null);
            } catch {}
            addPending(pend);
          }
        }
      }
    } catch (e) {
      // micro block shouldn't abort main flow
    }

    // 2) Candidate pending creation from consensus (main)
    if (finalScore >= (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      // decide side by pattern majority or mlMain
      let bull = 0, bear = 0;
      for (const r of perTfResults) for (const p of (r.patterns||[])) { if (p.side==="Bullish") bull++; if (p.side==="Bearish") bear++; }
      let side = "Bullish";
      if (bear > bull) side = "Bearish';
      else if (bull === bear && mlMain && typeof mlMain.prob === "number") side = (mlMain.prob >= 50 ? "Bullish" : "Bearish");

      const key = makeKey(symbol, side, perTfResults);
      if (recentlyAlerted(key)) return { alerted:false, reason:"debounce" };
      if (hourlyCount() >= (opts.maxAlertsPerHour ?? DEFAULTS.maxAlertsPerHour)) return { alerted:false, reason:"rate_limit" };

      // ML main gating to avoid contradiction
      if (mlMain && typeof mlMain.prob === "number") {
        const mlSide = mlMain.prob > 55 ? "Bullish" : mlMain.prob < 45 ? "Bearish" : "Neutral";
        if (mlSide !== "Neutral" && mlSide !== side && !DEFAULTS.allowNeutral) {
          return { alerted:false, reason:"ml_contradict" };
        }
      }

      // create pending
      const pend = {
        id: `p_${Date.now()}_${Math.floor(Math.random()*9000)}`,
        key,
        symbol,
        side,
        createdAt: Date.now(),
        priceAtDetect: perTfResults[0]?.price || 0,
        perTfResults,
        predId: null,
        status: "pending",
        requiredCandles: opts.confirmCandles ?? DEFAULTS.confirmCandles,
        confirmationTF: opts.confirmationTF ?? DEFAULTS.confirmationTF,
        consensusScore: finalScore,
        source: "consensus"
      };
      try { pend.predId = await recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: pend.side, prob: finalScore, features: { perTfResults } }).catch(()=>null); } catch {}
      addPending(pend);

      // send preview
      const price = pend.priceAtDetect;
      const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(perTfResults[0].candles); } catch {}
      const { tps, sls } = buildTPsAndSLs({ ellObj: ell && ell.ok ? ell : null, price, atr });
      const preview = [
        `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${pend.side}</b>`,
        `Symbol: <b>${symbol}</b> | Score: <b>${finalScore}%</b> | Source: ${pend.source}`,
        `Price: ${Number(price).toFixed(2)} | TP(s): ${tps.map(x=>x.tp).slice(0,2).join(" / ")}`,
        `SLs: LONG:${sls.find(s=>s.side==='LONG')?.sl} | SHORT:${sls.find(s=>s.side==='SHORT')?.sl}`,
        `Confirming in next ${pend.requiredCandles} x ${pend.confirmationTF} closed candle(s).`,
        `ID: ${pend.predId || "none"}`
      ].join("\n");
      try { if (typeof sendAlert === "function") await sendAlert(preview); } catch(e){}
      return { alerted:true, pendingId: pend.id, key };
    }

    return { alerted:false, reason:"below_threshold", score: finalScore };
  } catch (e) {
    return { alerted:false, error: e?.message || String(e) };
  }
}

// -------------------------
// Process pending queue: confirmations, final send, feedback schedule
// -------------------------
async function processPending(sendAlert = null, opts = {}) {
  const list = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of list) {
    try {
      // skip non-pending
      if (!p || p.status !== "pending") continue;
      // confirm
      const conf = await confirmAcrossCandles(p.symbol, p.side, p.requiredCandles ?? DEFAULTS.confirmCandles, p.confirmationTF ?? DEFAULTS.confirmationTF);
      if (!conf.confirmed) {
        // not enough candles yet, skip; if invalidated (confirmed === false but with support < needed) treat as failed
        if (conf.reason === "not_enough" || conf.reason === "not_enough_closed") continue;
        // invalidated
        updatePending(p.id, { status:"failed", closedAt: Date.now(), note: conf.reason || conf.error });
        // send fail alert & record outcome
        try { if (typeof sendAlert === "function") await sendAlert(`🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\nReason: ${conf.reason || conf.error}\nID: ${p.predId || 'none'}`); } catch(e){}
        if (p.predId) try { await recordOutcome(p.predId, { correct:false, realizedPrice: conf.closedLast?.close ?? null }); } catch(e){}
        removePending(p.id);
        continue;
      }
      // confirmed -> final send
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch {}
      const { tps, sls } = buildTPsAndSLs({ ellObj: ell && ell.ok ? ell : null, price, atr });

      const msg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Symbol: <b>${p.symbol}</b> | Score: <b>${Math.round(p.consensusScore||0)}%</b> | Source: ${p.source || 'consensus'}`,
        `DetectedAt: ${Number(p.priceAtDetect).toFixed(2)} | Now: ${Number(lastClose).toFixed(2)}`,
        `TPs: ${tps.map(t=>`${Number(t.tp).toFixed(2)}(${t.source})`).join(" / ")}`,
        `SLs: LONG:${sls.find(s=>s.side==='LONG')?.sl || 'n/a'} | SHORT:${sls.find(s=>s.side==='SHORT')?.sl || 'n/a'}`,
        `Observed support: ${conf.support}/${conf.needed} | movePct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.predId || 'none'}`
      ].join("\n");
      try { if (typeof sendAlert === "function") await sendAlert(msg); } catch(e){}
      // mark & cooldown
      updatePending(p.id, { status:"sent", sentAt: Date.now() });
      addRecent(p.key);

      // schedule feedback checks
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const out = await checkOutcome(p.predId, p.symbol, p.side, price, win);
            // store result in pending record & ML
            updatePending(p.id, { status: out.success ? "done" : "failed", closedAt: Date.now(), outcome: out });
            if (p.predId) {
              try { await recordOutcome(p.predId, { correct: !!out.success, realizedReturn: out.realizedReturn, realizedPrice: out.newPrice }); } catch(e){}
            }
            // remove pending entry after a short delay
            setTimeout(() => removePending(p.id), 2000);
          } catch (e) {}
        }, win * 1000);
      });

    } catch (e) {
      // keep loop alive
    }
  }
}

// -------------------------
// Public API: start/stop/get state
// -------------------------
let _timers = new Map();

export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", options = {}, sendAlert = null) {
  if (_timers.has(symbol)) return false;
  const opts = Object.assign({}, DEFAULTS, options || {});
  // main detect tick
  const tick = async () => {
    try {
      await evaluateSymbol(symbol, opts, sendAlert);
    } catch (e) {}
  };
  // pending processor tick
  const pendTick = async () => {
    try {
      await processPending(sendAlert, opts);
    } catch (e) {}
  };
  // run immediately then schedule
  tick();
  const idMain = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  const idPend = setInterval(pendTick, Math.max(5000, Math.floor((opts.confirmCandles||DEFAULTS.confirmCandles) * 10 * 1000)));
  _timers.set(symbol, { idMain, idPend });
  return true;
}

export async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) { clearInterval(rec.idMain); clearInterval(rec.idPend); _timers.delete(symbol); }
    } else {
      for (const [s, rec] of _timers.entries()) { clearInterval(rec.idMain); clearInterval(rec.idPend); _timers.delete(s); }
    }
    return true;
  } catch (e) { return false; }
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