// ml_module_v8_7.js
// ML + Reversal checker for AI Trader
// v8.7 — lightweight, deterministic model + reversal signal checker
//
// Exports:
//   runMLPrediction(symbol, tf = "15m") -> Promise<mlObj>
//   runMicroPrediction(symbol, tf = "1m") -> Promise<microObj>
//   checkReversalSignal(symbol, tf = "15m", opts = {}) -> Promise<signalObj>
//   calculateAccuracy() -> { accuracy, total, correct }
//   recordPrediction(pred) -> void
//   recordOutcome(outcome) -> void
//   helpers: buildFeaturesFromCandles, softmax, logistic, clamp

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ---------------------------
// Config / persistence paths
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");

// ensure log dir exists (best effort)
try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // ignore, fallback to memory
}

// in-memory fallback storage
let memPreds = [];
let memOuts = [];

// ---------------------------
// Helpers
// ---------------------------
function clamp(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
function logistic(x) { return 1 / (1 + Math.exp(-x)); }
function softmax(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return arr;
  const max = Math.max(...arr);
  const exps = arr.map(a => Math.exp(a - max));
  const s = exps.reduce((a,b)=>a+b, 0);
  return exps.map(e => e / Math.max(1e-12, s));
}
function nf(v, d = 2) { return (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A"; }

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) {
    return [];
  }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------
// Persistence API
// ---------------------------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push(Object.assign({}, pred, { recordedAt: new Date().toISOString() }));
    if (!writeJsonSafe(PRED_FILE, arr)) {
      memPreds.push(pred);
    }
  } catch (e) {
    memPreds.push(pred);
  }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE);
    arr.push(Object.assign({}, outcome, { recordedAt: new Date().toISOString() }));
    if (!writeJsonSafe(OUT_FILE, arr)) {
      memOuts.push(outcome);
    }
  } catch (e) {
    memOuts.push(outcome);
  }
}

// ---------------------------
// Accuracy calculator
// ---------------------------
export function calculateAccuracy() {
  try {
    const preds = readJsonSafe(PRED_FILE).concat(memPreds || []);
    const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
    if (!preds.length || !outs.length) return { accuracy: 0, total: 0, correct: 0 };

    // match by id if provided, else symbol+tf+closest time (best-effort)
    let correct = 0, total = 0;
    const outByPredId = new Map();
    outs.forEach(o => { if (o.predictionId) outByPredId.set(o.predictionId, o); });

    for (const p of preds) {
      let match = null;
      if (p.id && outByPredId.has(p.id)) match = outByPredId.get(p.id);
      else {
        // best-effort: find outcomes with same symbol & tf
        match = outs.find(o => o.symbol === p.symbol && o.tf === p.tf && Math.abs(new Date(o.ts || o.recordedAt || 0) - new Date(p.generatedAt || p.recordedAt || 0)) < 1000 * 60 * 60 * 24) || null;
      }
      if (match) {
        total++;
        // determine if prediction matches outcome: if predicted bull & outcome 'TP' on bullish side or predicted bear & 'TP' on bearish side
        const predLabel = (p.label || p.modelLabel || "").toString().toLowerCase();
        const outStr = (match.outcome || "").toString().toUpperCase();
        if (predLabel.includes("bull") && outStr === "TP_BULL" || predLabel.includes("bear") && outStr === "TP_BEAR") correct++;
        // if predLabel neutral, treat TP as not matching
      }
    }
    const acc = total ? Math.round((correct / total) * 10000) / 100 : 0;
    return { accuracy: acc, total, correct };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// ---------------------------
// Feature builder
// - consumes candles (oldest->newest) and returns numeric features
// ---------------------------
function buildFeaturesFromCandles(candles) {
  // safe checks
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      rsi: 50, macdHist: 0, atr: 0, priceMomentum: 0, volTrend: 0, lastClose: 0, closeOpenDiff: 0
    };
  }

  // rsi
  let rsi = 50;
  try { if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(candles); } catch (e) { rsi = 50; }

  // macd hist
  let macdHist = 0;
  try { if (typeof indicators.computeMACD === "function") macdHist = indicators.computeMACD(candles).hist || 0; } catch (e) { macdHist = 0; }

  // atr
  let atr = 0;
  try { if (typeof indicators.computeATR === "function") atr = indicators.computeATR(candles); } catch (e) { atr = 0; }

  // simple momentum: last close vs close N bars ago
  const lastClose = Number(candles.at(-1)?.close || candles.at(-1)?.c || 0);
  const prevClose = Number(candles.at(-5)?.close || candles.at(-5)?.c || candles.at(-2)?.close || 0);
  const priceMomentum = prevClose ? (lastClose - prevClose) / prevClose : 0;

  // volume trend: -1..1
  let volTrend = 0;
  try {
    if (typeof indicators.volumeTrend === "function") {
      const vt = indicators.volumeTrend(candles);
      if (typeof vt === "string") {
        if (vt.toUpperCase().includes("INCREAS")) volTrend = 1;
        else if (vt.toUpperCase().includes("DECREAS")) volTrend = -1;
        else volTrend = 0;
      } else if (typeof vt === "number") volTrend = clamp(vt, -1, 1);
    }
  } catch (e) {
    volTrend = 0;
  }

  const closeOpenDiff = (Number(candles.at(-1)?.close || 0) - Number(candles.at(-1)?.open || 0));

  return { rsi: Number(rsi), macdHist: Number(macdHist), atr: Number(atr), priceMomentum: Number(priceMomentum), volTrend: Number(volTrend), lastClose: Number(lastClose), closeOpenDiff: Number(closeOpenDiff) };
}

// ---------------------------
// Deterministic model scoring
// - returns raw scores for [bull, bear, neutral]
// ---------------------------
function scoreFromFeatures(feat, ell = null) {
  // base transforms
  const r = (feat.rsi - 50) / 50; // -1..1
  const m = Math.tanh(feat.macdHist / Math.max(1, feat.atr || 1)); // -1..1
  const pm = clamp(feat.priceMomentum * 4, -1, 1); // scaled
  const v = clamp(feat.volTrend, -1, 1);
  const body = clamp(feat.closeOpenDiff / Math.max(1, Math.abs(feat.lastClose || 1)), -1, 1);

  // Elliott sentiment adds nudges if available
  let ellSent = 0, ellConf = 0;
  if (ell && typeof ell === "object") {
    ellSent = typeof ell.sentiment === "number" ? clamp(ell.sentiment, -1, 1) : 0;
    ellConf = typeof ell.confidence === "number" ? Math.max(0, Math.min(100, ell.confidence)) / 100 : 0;
  }

  // Compose bullish score
  // weights tuned to be sensible; you can tune further:
  const bullRaw = (r * 0.35) + (m * 0.3) + (pm * 0.15) + (v * 0.05) + (body * 0.05) + (ellSent * (0.1 * ellConf));
  const bearRaw = (-r * 0.35) + (-m * 0.3) + (-pm * 0.15) + (-v * 0.05) + (-body * 0.05) + (-ellSent * (0.1 * ellConf));
  // neutral is inverse magnitude of directional conviction
  const neutralRaw = 1 - Math.abs(bullRaw - bearRaw); // higher when bull/bear similar

  // small temperature scaling
  const temp = 1.0;
  const scores = [bullRaw / temp, bearRaw / temp, neutralRaw / temp];
  return scores;
}

// ---------------------------
// runMLPrediction
// - symbol: e.g. "BTCUSDT"
// - tf: timeframe string, default "15m"
// returns promise resolving to { label, prob, probBull, probBear, probNeutral, tpEstimate?, tpSide?, tpConfidence?, meta: {features,...} }
// ---------------------------
export async function runMLPrediction(symbol, tf = "15m") {
  try {
    // fetch candles for this TF (request some extra bars)
    const tfs = [tf];
    const multi = await fetchMultiTF(symbol, tfs); // expects utils.fetchMultiTF to return { [tf]: { data: [candles], price } }
    const entry = multi[tf] || {};
    const candles = entry.data || [];
    if (!candles || !candles.length) {
      return { label: "Neutral", prob: 0, probBull: null, probBear: null, probNeutral: null, error: "no_candles" };
    }

    // build features
    const feat = buildFeaturesFromCandles(candles);

    // call Elliott for the same candle window (best-effort)
    let ell = null;
    try {
      const ellRes = await analyzeElliott(candles);
      if (ellRes && ellRes.ok) ell = { sentiment: ellRes.sentiment, confidence: ellRes.confidence, patterns: ellRes.patterns || [], targets: ellRes.targets || [] };
    } catch (e) {
      ell = null;
    }

    // score
    const raw = scoreFromFeatures(feat, ell);
    const probs = softmax(raw);
    // convert to percent
    const probBull = Math.round(probs[0] * 10000) / 100;
    const probBear = Math.round(probs[1] * 10000) / 100;
    const probNeutral = Math.round(probs[2] * 10000) / 100;
    const maxProb = Math.max(probBull, probBear, probNeutral);
    const label = maxProb === probBull ? "Bullish" : maxProb === probBear ? "Bearish" : "Neutral";

    // TP estimate: prefer Elliott targets if present (closest high-confidence), else simple ATR multiple
    let tpEstimate = null, tpSide = null, tpConfidence = null;
    if (ell && Array.isArray(ell.targets) && ell.targets.length) {
      // choose best confidence target - map to bull/bear relative to last close
      const lastClose = feat.lastClose;
      const candidates = ell.targets.map(t => ({ tp: Number(t.tp || t.target || t.price || 0), confidence: Number(t.confidence || 50), source: t.source || t.type || "Elliott" }));
      // choose highest confidence where tp != lastClose
      candidates.sort((a,b)=> (b.confidence || 0) - (a.confidence || 0));
      const chosen = candidates.find(c => Math.abs(Number(c.tp || 0) - lastClose) > Math.max(1, feat.atr * 0.5));
      if (chosen) {
        tpEstimate = chosen.tp;
        tpSide = tpEstimate > lastClose ? "Long" : "Short";
        tpConfidence = Math.round(chosen.confidence || Math.max(20, maxProb));
      }
    }
    if (!tpEstimate) {
      // fallback ATR-based
      const last = feat.lastClose || (candles.at(-1)?.close || 0);
      const atr = Math.max(1, feat.atr || 1);
      const longTP = last + atr * 3;
      const shortTP = last - atr * 3;
      if (probBull >= probBear) {
        tpEstimate = Number(longTP.toFixed(2));
        tpSide = "Long";
        tpConfidence = Math.round(Math.max(20, probBull));
      } else {
        tpEstimate = Number(shortTP.toFixed(2));
        tpSide = "Short";
        tpConfidence = Math.round(Math.max(20, probBear));
      }
    }

    // assemble result
    const out = {
      model: "v8.7-det",
      symbol,
      tf,
      label,
      prob: maxProb,
      probBull,
      probBear,
      probNeutral,
      tp: tpEstimate,
      tpSide,
      tpConfidence,
      generatedAt: new Date().toISOString(),
      meta: { features: feat, ell }
    };

    // record prediction with an id
    try {
      const id = `${symbol}_${tf}_${Date.now()}`;
      const pred = Object.assign({}, out, { id });
      recordPrediction(pred);
      out.id = id;
    } catch (e) {
      // ignore
    }

    return out;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------------------------
// runMicroPrediction
// - quick lighter version for 1m/5m nudges
// ---------------------------
export async function runMicroPrediction(symbol, tf = "1m") {
  try {
    const tfs = [tf];
    const multi = await fetchMultiTF(symbol, tfs);
    const entry = multi[tf] || {};
    const candles = entry.data || [];
    if (!candles || candles.length < 3) {
      return { label: "Neutral", prob: 0, reason: "no_data" };
    }
    const feat = buildFeaturesFromCandles(candles);
    // simple rule: RSI > 60 -> bullish nudge, <40 bearish, else neutral; include last body sign
    let label = "Neutral";
    let prob = 33.33;
    if (feat.rsi >= 60 || feat.priceMomentum > 0.003) {
      label = "Bullish";
      prob = Math.min(90, 40 + Math.min(60, Math.round((feat.rsi - 50) * 1.5)));
    } else if (feat.rsi <= 40 || feat.priceMomentum < -0.003) {
      label = "Bearish";
      prob = Math.min(90, 40 + Math.min(60, Math.round((50 - feat.rsi) * 1.5)));
    } else {
      label = "Neutral";
      prob = 33.33;
    }
    return { model: "micro-v8.7", symbol, tf, label, prob, generatedAt: new Date().toISOString(), meta: { features: feat } };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------------------------
// checkReversalSignal
// - watches for "safe" reversal entry points using Elliott pivots + trend confirmation
// - returns object: { signal: 'long'|'short'|null, safeEntry: bool, entryPrice, sl, tp, lastPivot, reason, generatedAt }
// - opts: { lookbackBars: 200, atrMultSL:2, atrMultTP:3, requireMicroConfirm: true }
// ---------------------------
export async function checkReversalSignal(symbol, tf = "15m", opts = {}) {
  try {
    const lookbackBars = opts.lookbackBars || 200;
    const atrMultSL = opts.atrMultSL || 2;
    const atrMultTP = opts.atrMultTP || 3;
    const requireMicroConfirm = opts.requireMicroConfirm === undefined ? true : !!opts.requireMicroConfirm;

    // fetch candles
    const multi = await fetchMultiTF(symbol, [tf, "1m"]);
    const entry = multi[tf] || {};
    const candles = (entry.data || []).slice(-Math.max(lookbackBars, 50));
    const price = entry.price || candles.at(-1)?.close || 0;

    if (!candles || candles.length < 10) {
      return { signal: null, safeEntry: false, reason: "insufficient_candles", generatedAt: new Date().toISOString() };
    }

    // analyze Elliott
    let ellRes = null;
    try {
      ellRes = await analyzeElliott(candles);
    } catch (e) {
      ellRes = null;
    }
    if (!ellRes || !ellRes.ok) {
      // fallback: no ell => use pivot-like check from simple highs/lows
    }

    const pivots = (ellRes && ellRes.pivots) ? ellRes.pivots : [];
    const lastPivot = pivots && pivots.length ? pivots[pivots.length - 1] : null;
    const prevPivot = pivots && pivots.length > 1 ? pivots[pivots.length - 2] : null;

    // compute ATR
    const atr = ellRes && typeof ellRes.atr === "number" ? ellRes.atr : (typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : 0.0);
    const lastClose = Number(candles.at(-1)?.close || 0);
    const lastOpen = Number(candles.at(-1)?.open || 0);

    // micro confirmation if requested
    let microConfirm = true;
    if (requireMicroConfirm) {
      try {
        const micro = await runMicroPrediction(symbol, "1m");
        microConfirm = micro && micro.label && micro.label.toLowerCase().includes("bull") ? true : micro && micro.label && micro.label.toLowerCase().includes("bear") ? true : true;
        // keep it permissive: micro must not strongly contradict
        if (micro && micro.label) {
          if (micro.label.toLowerCase().includes("bull") && lastClose < lastOpen) microConfirm = false;
          if (micro.label.toLowerCase().includes("bear") && lastClose > lastOpen) microConfirm = false;
        }
      } catch (e) {
        microConfirm = true;
      }
    }

    // logic for reversal: detect Swing Failure (SFP) or pivot bounce
    let signal = null;
    let safeEntry = false;
    let entryPrice = null;
    let sl = null;
    let tp = null;
    let reason = "";

    // if there is a last pivot and it's a low and price bounced above it -> possible long
    if (lastPivot && lastPivot.type === "L") {
      // bounce if recent close is > pivot price and previous close dipped below pivot (sfp style)
      const prevClose = Number(candles.at(-2)?.close || 0);
      if (prevClose < lastPivot.price && lastClose > lastPivot.price && microConfirm) {
        signal = "long";
        entryPrice = lastClose;
        sl = Math.max(1, lastPivot.price - atr * 0.5);
        tp = Number((entryPrice + atr * atrMultTP).toFixed(2));
        safeEntry = true;
        reason = "pivot_bounce_sfp";
      } else if (Math.abs(lastClose - lastPivot.price) / Math.max(1, lastPivot.price) < 0.005 && microConfirm) {
        // price near pivot and momentum small => possible mean-reversion long
        signal = "long";
        entryPrice = lastClose;
        sl = Number((entryPrice - atr * atrMultSL).toFixed(2));
        tp = Number((entryPrice + atr * atrMultTP).toFixed(2));
        safeEntry = true;
        reason = "pivot_near_mean_reversion";
      }
    }

    // if last pivot is a high and price failed and fell below -> short
    if (!signal && lastPivot && lastPivot.type === "H") {
      const prevClose = Number(candles.at(-2)?.close || 0);
      if (prevClose > lastPivot.price && lastClose < lastPivot.price && microConfirm) {
        signal = "short";
        entryPrice = lastClose;
        sl = Math.min(1, lastPivot.price + atr * 0.5);
        tp = Number((entryPrice - atr * atrMultTP).toFixed(2));
        safeEntry = true;
        reason = "pivot_breach_sfp";
      } else if (Math.abs(lastClose - lastPivot.price) / Math.max(1, lastPivot.price) < 0.005 && microConfirm) {
        signal = "short";
        entryPrice = lastClose;
        sl = Number((entryPrice + atr * atrMultSL).toFixed(2));
        tp = Number((entryPrice - atr * atrMultTP).toFixed(2));
        safeEntry = true;
        reason = "pivot_near_mean_reversion_short";
      }
    }

    // fallback: if market structure shows BOS and last wave reversal, mark signal
    if (!signal && ellRes && ellRes.marketStructure && ellRes.marketStructure.length) {
      const ms = ellRes.marketStructure.slice(-1)[0];
      if (ms && ms.type === "BOS") {
        if (ms.side === "Bullish") {
          // if price pulled back near local fib 0.618, suggest long (safe check)
          const fib = ellRes.fib;
          if (fib && fib.retrace && lastClose <= fib.retrace['0.618'] && microConfirm) {
            signal = "long";
            entryPrice = lastClose;
            sl = Number((entryPrice - atr * atrMultSL).toFixed(2));
            tp = Number((entryPrice + atr * atrMultTP).toFixed(2));
            safeEntry = true;
            reason = "BOS_pullback_fib";
          }
        } else {
          const fib = ellRes.fib;
          if (fib && fib.retrace && lastClose >= fib.retrace['0.618'] && microConfirm) {
            signal = "short";
            entryPrice = lastClose;
            sl = Number((entryPrice + atr * atrMultSL).toFixed(2));
            tp = Number((entryPrice - atr * atrMultTP).toFixed(2));
            safeEntry = true;
            reason = "BOS_pullback_fib_short";
          }
        }
      }
    }

    // if a signal found, create output with last pivot and whether TP/SL already hit historically
    const out = {
      symbol,
      tf,
      signal,
      safeEntry,
      entryPrice,
      sl,
      tp,
      lastPivot,
      reason,
      microConfirm,
      atr,
      price: lastClose,
      generatedAt: new Date().toISOString()
    };

    return out;
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

