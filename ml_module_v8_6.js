// ml_module_v9_9.js
// Backwards-compatible improved ML module
// - Multi-TF fusion + micro-filter to avoid micro false signals
// - MA + MACD confirmation before strong calls
// - EMA smoothing of probabilities (state file)
// - Volatility-aware TP/SL chooser and RR checks
// - Same exports as previous modules

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const STATE_FILE = path.join(LOG_DIR, "state_ml_v9_9.json");

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

function readJsonSafe(file, defaultVal = null) {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    const txt = fs.readFileSync(file, "utf8");
    return txt ? JSON.parse(txt) : defaultVal;
  } catch (e) { return defaultVal; }
}
function writeJsonSafe(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
}

// State for smoothing / stats
let STATE = readJsonSafe(STATE_FILE, { smooth: {}, stats: {} }) || { smooth: {}, stats: {} };
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2), "utf8"); } catch (e) {} }

// persistence helpers
function safeAppendJSON(file, entry) {
  try {
    const cur = readJsonSafe(file, { list: [] });
    if (!Array.isArray(cur.list)) cur.list = [];
    cur.list.push(entry);
    writeJsonSafe(file, cur);
    return true;
  } catch (e) { return false; }
}

// Exported persistence helpers
export function recordPrediction(pred) {
  try {
    safeAppendJSON(PRED_FILE, { ...pred, t: Date.now() });
  } catch (e) {}
}
export function recordOutcome(outcome) {
  try {
    safeAppendJSON(OUT_FILE, { ...outcome, t: Date.now() });
  } catch (e) {}
}

export function calculateAccuracy() {
  try {
    const outs = (readJsonSafe(OUT_FILE, { list: [] }).list) || [];
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.correct).length;
    return { accuracy: Number(((correct/total)*100).toFixed(2)), total, correct };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// numeric helpers
const EPS = 1e-12;
function clamp(v, lo=-Infinity, hi=Infinity) { return Math.max(lo, Math.min(hi, v)); }
function isNum(n) { return typeof n === "number" && Number.isFinite(n); }
function pctRound(n) { return Math.round(n * 100) / 100; } // two decimal pct

function softmax3(a,b,c) {
  const m = Math.max(a,b,c);
  const ea = Math.exp(a - m), eb = Math.exp(b - m), ec = Math.exp(c - m);
  const s = ea + eb + ec + EPS;
  return [ea/s, eb/s, ec/s];
}

/* --- feature extraction (safe) --- */
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n-1];
  const close = Number(last.close ?? last.adjClose ?? 0);
  const closes = candles.map(c => Number(c.close ?? 0));
  const highs = candles.map(c => Number(c.high ?? c.close ?? 0));
  const lows = candles.map(c => Number(c.low ?? c.close ?? 0));
  const vols = candles.map(c => Number(c.volume ?? c.vol ?? 0));

  const mom = (lookback) => {
    if (n > lookback) return (close - closes[n-1-lookback]) / Math.max(1, closes[n-1-lookback]);
    return 0;
  };

  // slope (linear regression) over last up to 30
  const len = Math.min(30, n);
  let sx=0, sy=0;
  for (let i=0;i<len;i++){ sx += i; sy += closes[n-len+i]; }
  sx /= len; sy /= len;
  let num=0, den=0;
  for (let i=0;i<len;i++){ const x=i, y=closes[n-len+i]; num += (x-sx)*(y-sy); den += (x-sx)*(x-sx); }
  const slope = den === 0 ? 0 : num/den;

  // ATR
  let atr = 0;
  try { if (typeof indicators.computeATR === "function") atr = indicators.computeATR(candles); } catch(e){ atr = 0; }
  if (!isNum(atr) || atr <= 0) {
    // fallback TR-based
    const trs = [];
    for (let i=1;i<n;i++){
      const tr = Math.max(Math.abs(highs[i]-lows[i]), Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      trs.push(tr);
    }
    const tail = trs.slice(-14);
    atr = tail.length ? (tail.reduce((a,b)=>a+b,0)/tail.length) : Math.max(1, Math.abs(highs[n-1]-lows[n-1]));
  }

  // RSI, MACD hist
  let rsi = null, macdHist = null;
  try { if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(candles); } catch(e){ rsi = null; }
  try { if (typeof indicators.computeMACD === "function") macdHist = indicators.computeMACD(candles)?.hist ?? null; } catch(e) { macdHist = null; }

  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(20, vols.length));
  const lastVol = vols[n-1] || 0;

  return {
    close,
    mom5: mom(5),
    mom20: mom(20),
    slope,
    atr,
    rsi: isNum(rsi) ? rsi : null,
    macdHist: isNum(macdHist) ? macdHist : null,
    avgVol,
    lastVol,
    high: highs[n-1],
    low: lows[n-1]
  };
}

// candidate TP builder (Elliott-first, fibs, then ATR fallback)
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isNum(tp) || tp <= 0) continue;
      const age = Number(t.ageDays ?? 0);
      const conf = clamp(Number(t.confidence ?? ell.confidence ?? 40), 0, 100);
      const adj = conf * (age > 7 ? 0.6 : 1.0);
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(adj) });
    }
  }
  if (!out.length && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }
  if (!out.length) {
    const up = Number((price + (atr || price*0.002) * 2).toFixed(8));
    const down = Number((price - (atr || price*0.002) * 2).toFixed(8));
    out.push({ tp: up, source: 'ATR_UP', confidence: 30 });
    out.push({ tp: down, source: 'ATR_DOWN', confidence: 30 });
  }
  // dedupe by rounded price (keep highest conf)
  const m = new Map();
  for (const t of out) {
    const k = Math.round(t.tp);
    if (!m.has(k) || (t.confidence || 0) > (m.get(k).confidence || 0)) m.set(k, t);
  }
  return Array.from(m.values()).sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// risk metrics helper
function computeRiskMetrics(price, tp, sl) {
  if (!isNum(price) || !isNum(tp) || !isNum(sl)) return null;
  const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
  const perc = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isNum(rr) ? rr : null, percMove: isNum(perc) ? perc : null };
}

// choose candidate TP: direction strict, RR safe, volatility adaptive
function chooseCandidateTP(candidates, dir, price, atr, feats, maxRiskRR = 12) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const multBase = clamp((feats?.atr || atr || price*0.002) / Math.max(EPS, price), 0.0005, 0.1);
  const volFactor = clamp(multBase / 0.002, 0.5, 3.0);
  const directionCmp = dir === "Bullish" ? (t => t.tp > price) : dir === "Bearish" ? (t => t.tp < price) : (() => true);
  const filtered = candidates.filter(directionCmp);
  const pool = filtered.length ? filtered : candidates;

  const scored = pool.map(c => {
    const dist = Math.abs(c.tp - price);
    const prox = 1 / (1 + Math.log(1 + dist / Math.max(1, feats?.atr || atr || price*0.002)));
    const score = (c.confidence || 40) * prox * volFactor;
    return { ...c, score, dist };
  }).sort((a,b) => b.score - a.score);

  for (const cand of scored) {
    // conservative SL
    let sl;
    if (dir === "Bullish") sl = Number((price - (feats?.atr || atr || price*0.002) * 2).toFixed(8));
    else if (dir === "Bearish") sl = Number((price + (feats?.atr || atr || price*0.002) * 2).toFixed(8));
    else sl = cand.tp > price ? Number((price - (feats?.atr || atr || price*0.002) * 1.5).toFixed(8))
                             : Number((price + (feats?.atr || atr || price*0.002) * 1.5).toFixed(8));

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    if (!metrics || !isNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRiskRR) continue;
    const minTpDist = Math.max((feats?.atr || atr || price*0.002) * 0.6, price * 0.0005);
    if (cand.dist < minTpDist) continue;
    if (Math.abs(cand.tp - price) < (price * 1e-9)) continue;

    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, suggestedSL: sl, rr: metrics.rr, reason: "best_conf_and_rr" };
  }

  const top = scored[0];
  if (!top) return null;
  const mult = dir === "Bullish" ? 2.0 : dir === "Bearish" ? 2.0 : 1.5;
  const fallbackTP = dir === "Bullish" ? Number((price + (feats?.atr || atr || price*0.002) * mult).toFixed(8))
                                      : dir === "Bearish" ? Number((price - (feats?.atr || atr || price*0.002) * mult).toFixed(8))
                                                           : Number(top.tp);
  const sl = dir === "Bullish" ? Number((price - (feats?.atr || atr || price*0.002) * 2).toFixed(8))
                               : dir === "Bearish" ? Number((price + (feats?.atr || atr || price*0.002) * 2).toFixed(8))
                                                    : null;
  const metrics = computeRiskMetrics(price, fallbackTP, sl);
  return { tp: fallbackTP, source: "AUTO_ATR", confidence: top.confidence || 40, suggestedSL: sl, rr: metrics?.rr ?? null, reason: "fallback_atr" };
}

// EMA smoothing on probs stored in STATE.smooth
function smoothProbs(key, probs, alpha = 0.25) {
  if (!STATE.smooth) STATE.smooth = {};
  const prev = STATE.smooth[key] || null;
  if (!prev) {
    STATE.smooth[key] = { bull: probs.bull, bear: probs.bear, neutral: probs.neutral };
  } else {
    STATE.smooth[key] = {
      bull: prev.bull * (1 - alpha) + (probs.bull * alpha),
      bear: prev.bear * (1 - alpha) + (probs.bear * alpha),
      neutral: prev.neutral * (1 - alpha) + (probs.neutral * alpha)
    };
  }
  saveState();
  const s = STATE.smooth[key];
  const sum = (s.bull + s.bear + s.neutral) || 1;
  return {
    bull: pctRound((s.bull / sum) * 100),
    bear: pctRound((s.bear / sum) * 100),
    neutral: pctRound((s.neutral / sum) * 100)
  };
}

// small helper: confirm trend using MA and MACD
function trendConfirmation(candles, direction) {
  try {
    const closes = candles.map(c => Number(c.close ?? 0));
    const n = closes.length;
    if (n < 3) return { maOk: false, macdOk: false };
    const ma5 = closes.slice(-5).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(5, closes.length));
    const ma30 = closes.slice(-30).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(30, closes.length));
    const maOk = direction === "Bullish" ? (ma5 > ma30) : (ma5 < ma30);

    let macdHist = null;
    if (typeof indicators.computeMACD === "function") {
      macdHist = indicators.computeMACD(candles)?.hist ?? null;
    }
    const macdOk = direction === "Bullish" ? (isNum(macdHist) ? macdHist > 0 : false) : (isNum(macdHist) ? macdHist < 0 : false);
    return { maOk, macdOk };
  } catch (e) {
    return { maOk: false, macdOk: false };
  }
}

// ---------------------------
// Core: runMLPrediction (improved but compatible)
// ---------------------------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  try {
    const tfs = [tf, "1m", "5m"];
    const mtf = await fetchMultiTF(symbol, tfs);

    const main = mtf[tf] || { data: [], price: 0 };
    const candles = Array.isArray(main.data) ? main.data : [];
    const price = isNum(main.price) && main.price ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 8 || !isNum(price) || price <= 0) {
      return {
        modelVersion: "ml_module_v9_9",
        symbol,
        tf,
        direction: "Neutral",
        probs: { bull: 33.33, bear: 33.33, neutral: 33.33 },
        maxProb: 33.33,
        tpEstimate: null,
        tpSource: null,
        tpConfidence: 33,
        slEstimate: null,
        explanation: "insufficient data"
      };
    }

    // features
    const feats = buildFeaturesFromCandles(candles);
    const micro1m = (mtf["1m"] || {}).data || [];
    const micro5m = (mtf["5m"] || {}).data || [];
    const microFeats1m = buildFeaturesFromCandles(micro1m);
    const microFeats5m = buildFeaturesFromCandles(micro5m);

    // elliott
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // base scoring
    let bullScore = 0, bearScore = 0;
    const atr = Math.max(feats.atr || 0, price * 0.0006);
    const volRatio = clamp(atr / price, 0, 0.06);

    // slope & momentum contributions (kept conservative)
    bullScore += clamp(feats.slope * 10, -12, 12);
    bearScore -= clamp(feats.slope * 10, -12, 12);
    bullScore += clamp(feats.mom5 * 8 * 100, -12, 12);
    bearScore -= clamp(feats.mom5 * 8 * 100, -12, 12);

    // rsi
    if (isNum(feats.rsi)) {
      const r = (feats.rsi - 50)/50;
      bullScore += clamp(r * 3.5, -4, 4);
      bearScore -= clamp(r * 3.5, -4, 4);
    }

    // macd hist normalized by atr
    if (isNum(feats.macdHist)) {
      const m = Math.tanh(feats.macdHist / Math.max(1, atr)) * 2.0;
      bullScore += clamp(m, -3, 3);
      bearScore -= clamp(m, -3, 3);
    }

    // micro trend nudges but not decisive
    if (microFeats1m) {
      bullScore += clamp((microFeats1m.slope||0) * 6, -3, 3) * 0.6;
      bearScore -= clamp((microFeats1m.slope||0) * 6, -3, 3) * 0.6;
    }
    if (microFeats5m) {
      bullScore += clamp((microFeats5m.slope||0) * 6, -3, 3) * 0.9;
      bearScore -= clamp((microFeats5m.slope||0) * 6, -3, 3) * 0.9;
    }

    // volume spike: add stability (not directional heavy)
    if (feats.avgVol > 0) {
      const spike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1;
      const vAdj = clamp(spike, -1.2, 2.0) * 0.3;
      bullScore += vAdj;
      bearScore += vAdj * 0.3;
    }

    // elliott
    if (ell && isNum(ell.sentiment) && isNum(ell.confidence)) {
      const eAdj = ell.sentiment * (ell.confidence / 100) * 0.6;
      bullScore += eAdj;
      bearScore -= eAdj;
    }

    // neutral stability logit lower when volatile
    const neutralBase = 0.25;
    const neutralPenalty = clamp(volRatio * 6, 0, 1.2);
    const neutralLogit = clamp(neutralBase - neutralPenalty, -2.0, 1.0);

    // logits -> softmax
    const a = clamp(bullScore, -12, 12);
    const b = clamp(bearScore, -12, 12);
    const c = clamp(neutralLogit * 2.0, -6, 6);
    let [pBull, pBear, pNeutral] = softmax3(a,b,c);

    // convert to pct and smooth via EMA
    const rawProbs = { bull: pctRound(pBull*100), bear: pctRound(pBear*100), neutral: pctRound(pNeutral*100) };
    const smooth = smoothProbs(`${symbol}_${tf}`, rawProbs, /*alpha=*/0.25);

    const maxP = Math.max(smooth.bull, smooth.bear, smooth.neutral);
    let dir = maxP === smooth.bull ? "Bullish" : maxP === smooth.bear ? "Bearish" : "Neutral";

    // --- Micro-TF safety filter: if micro TF strongly opposite, reduce confidence or flip to Neutral
    if (dir === "Bullish") {
      const microBear1 = microFeats1m && microFeats1m.slope < 0 && (microFeats1m.mom5 < 0);
      const microBear5 = microFeats5m && microFeats5m.slope < 0 && (microFeats5m.mom5 < 0);
      if (microBear1 && microBear5) {
        if (smooth.bull - smooth.bear < 8) dir = "Neutral";
      }
    } else if (dir === "Bearish") {
      const microBull1 = microFeats1m && microFeats1m.slope > 0 && (microFeats1m.mom5 > 0);
      const microBull5 = microFeats5m && microFeats5m.slope > 0 && (microFeats5m.mom5 > 0);
      if (microBull1 && microBull5) {
        if (smooth.bear - smooth.bull < 8) dir = "Neutral";
      }
    }

    // trend confirmation using MA & MACD on main candles - if unconfirmed, reduce confidence by moving toward Neutral
    const confirm = trendConfirmation(candles, dir);
    if (!confirm.maOk || !confirm.macdOk) {
      const pull = 0.18;
      const nb = smooth.bull*(1-pull) + (100/3)*pull;
      const nr = smooth.bear*(1-pull) + (100/3)*pull;
      const nn = smooth.neutral*(1-pull) + (100/3)*pull;
      const s = nb + nr + nn || 1;
      // store raw backing values (not normalized) for next smoothing
      STATE.smooth[`${symbol}_${tf}`] = { bull: nb, bear: nr, neutral: nn };
      saveState();
      const newSmooth = { bull: pctRound((nb/s)*100), bear: pctRound((nr/s)*100), neutral: pctRound((nn/s)*100) };
      smooth.bull = newSmooth.bull; smooth.bear = newSmooth.bear; smooth.neutral = newSmooth.neutral;
      const maxNew = Math.max(smooth.bull, smooth.bear, smooth.neutral);
      dir = maxNew === smooth.bull ? "Bullish" : maxNew === smooth.bear ? "Bearish" : "Neutral";
    }

    // Candidates & TP selection
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);
    const chosen = chooseCandidateTP(candidates, dir, price, atr, feats, /*maxRR=*/ 20);

    const tpEstimate = chosen && isNum(chosen.tp) ? chosen.tp : null;
    const tpSource = chosen ? chosen.source : null;
    const tpConfidence = chosen ? Math.round((chosen.confidence * 0.55) + (Math.max(smooth.bull, smooth.bear, smooth.neutral) * 0.45)) : Math.round(Math.max(smooth.bull, smooth.bear, smooth.neutral));

    const slEstimate = chosen && isNum(chosen.suggestedSL) ? chosen.suggestedSL :
                       dir === "Bullish" ? Number((price - atr * 2).toFixed(8)) :
                       dir === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null;

    // final object
    const mlObj = {
      modelVersion: "ml_module_v9_9",
      symbol,
      tf,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs: smooth,
      maxProb: Math.max(smooth.bull, smooth.bear, smooth.neutral),
      tpEstimate,
      tpSource,
      tpConfidence,
      slEstimate,
      explanation: `slope:${Number(feats.slope.toFixed(6))} | mom5:${(feats.mom5*100).toFixed(2)}% | rsi:${isNum(feats.rsi)?feats.rsi.toFixed(1):"N/A"} | atr:${Number(atr.toFixed(4))}`
    };

    // record prediction non-blocking
    try { recordPrediction({ id:`${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch (e) {}

    return mlObj;

  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (keeps old style but improved)
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = Array.isArray(entry.data) ? entry.data : [];
    if (!candles || candles.length < 5) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };

    const feats = buildFeaturesFromCandles(candles);
    const score = clamp((feats.mom5 * 8 * 100 * 0.22) + (feats.slope * 10) + ((isNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 2.0), -12, 12);
    const pBull = (1 / (1 + Math.exp(-score))) * 100;
    const pb = pctRound(pBull);
    const pa = pctRound(100 - pBull);
    const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v9_9-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// default export
export default {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};