// ml_module_v9_0.js  (OPTIMIZED, reversal logic REMOVED)
// Lightweight deterministic ML heuristics + improved TP/SL + logging
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome
// NOTE: replace previous ml_module file with this content.

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ---------------------------
// Config & persistence
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const DEBUG_CSV = path.join(LOG_DIR, "debug.csv");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

let memPreds = [];
let memOuts = [];

/* --- safe JSON helpers --- */
function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) { return []; }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

/* --- record helpers --- */
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);
    // append short CSV debug line (best-effort)
    try {
      const line = [
        pred.id || "",
        pred.symbol || "",
        pred.tf || "",
        pred.ml?.direction || "",
        pred.ml?.probs ? `${pred.ml.probs.bull}/${pred.ml.probs.bear}/${pred.ml.probs.neutral}` : "",
        pred.ml?.tpEstimate ?? "",
        pred.ml?.slEstimate ?? "",
        new Date().toISOString()
      ].join(",") + "\n";
      if (!fs.existsSync(DEBUG_CSV)) fs.writeFileSync(DEBUG_CSV, "id,symbol,tf,direction,probs,tp,sl,timestamp\n", "utf8");
      fs.appendFileSync(DEBUG_CSV, line, "utf8");
    } catch (e) {}
  } catch (e) { memPreds.push(pred); }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(OUT_FILE, arr)) memOuts.push(outcome);
  } catch (e) { memOuts.push(outcome); }
}

export function calculateAccuracy() {
  try {
    const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.correct).length;
    return { accuracy: Math.round((correct/total)*10000)/100, total, correct };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// ---------------------------
// Numeric helpers
// ---------------------------
const EPS = 1e-12;
function clamp(v, lo = -Infinity, hi = Infinity) { return Math.max(lo, Math.min(hi, v)); }
function isFiniteNum(n) { return typeof n === "number" && Number.isFinite(n); }
function nf(v,d=2){ return isFiniteNum(v) ? Number(v).toFixed(d) : "N/A"; }
function boundedPercent(n) { if (!isFiniteNum(n)) return 0; return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100; }

/* Stable softmax for 3 logits */
function softmax3(a,b,c) {
  // directionally-calibrated: accept raw numbers (can be negative)
  const max = Math.max(a,b,c);
  const ea = Math.exp(a - max), eb = Math.exp(b - max), ec = Math.exp(c - max);
  const s = ea + eb + ec + EPS;
  return [ea/s, eb/s, ec/s];
}

// ---------------------------
// Feature builder (fast + defensive)
// ---------------------------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n-1];
  const close = Number(last.close ?? last.adjClose ?? 0);
  // precompute arrays only once
  const closes = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  const vols = new Array(n);
  for (let i=0;i<n;i++){
    const c = candles[i];
    closes[i] = Number(c.close ?? 0);
    highs[i] = Number(c.high ?? closes[i]);
    lows[i] = Number(c.low ?? closes[i]);
    vols[i] = Number(c.volume ?? c.vol ?? 0);
  }

  // mom5/mom20 safe
  const close5 = n >= 6 ? closes[n-6] : closes[0];
  const close20 = n >= 21 ? closes[n-21] : closes[0];
  const mom5 = close5 ? (close - close5) / Math.max(1, close5) : 0;
  const mom20 = close20 ? (close - close20) / Math.max(1, close20) : 0;

  // slope (linear regression on last up to 30)
  const nSlope = Math.min(30, n);
  let num=0, den=0, xmean=0, ymean=0;
  // compute means
  for (let i=0;i<nSlope;i++){ xmean += i; ymean += closes[n - nSlope + i]; }
  xmean /= nSlope; ymean /= nSlope;
  for (let i=0;i<nSlope;i++){
    const x = i;
    const y = closes[n - nSlope + i];
    num += (x - xmean) * (y - ymean);
    den += (x - xmean) * (x - xmean);
  }
  const slope = den === 0 ? 0 : num/den;

  // ATR: use indicator if available (expect numeric)
  let atr = 0;
  try {
    if (indicators.computeATR) atr = indicators.computeATR(candles);
    else {
      const trs = [];
      for (let i=1;i<n;i++){
        const tr = Math.max(
          Math.abs(highs[i] - lows[i]),
          Math.abs(highs[i] - closes[i-1]),
          Math.abs(lows[i] - closes[i-1])
        );
        trs.push(tr);
      }
      const tail = trs.slice(-14);
      atr = tail.length ? (tail.reduce((a,b)=>a+b,0) / tail.length) : 0;
    }
  } catch (e) { atr = 0; }

  // RSI & MACD (if available)
  let rsi = null, macdHist = null;
  try {
    if (indicators.computeRSI) rsi = indicators.computeRSI(candles);
    if (indicators.computeMACD) {
      const mac = indicators.computeMACD(candles);
      macdHist = mac?.hist ?? null;
    }
  } catch (e) { rsi = rsi ?? null; macdHist = macdHist ?? null; }

  // volume averages
  const volSlice = vols.slice(-20);
  const avgVol = volSlice.length ? (volSlice.reduce((a,b)=>a+b,0) / volSlice.length) : 0;
  const lastVol = vols[n-1] || 0;

  return {
    close,
    mom5: Number(mom5 || 0),
    mom20: Number(mom20 || 0),
    slope: Number(slope || 0),
    atr: Number(atr || 0),
    rsi: isFiniteNum(rsi) ? Number(rsi) : null,
    macdHist: isFiniteNum(macdHist) ? Number(macdHist) : null,
    avgVol: Number(avgVol || 0),
    lastVol: Number(lastVol || 0),
    high: Number(highs[n-1] || close),
    low: Number(lows[n-1] || close)
  };
}

// ---------------------------
// Candidate TP generator (direction-aware + age filter)
// ---------------------------
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      const ageDays = Number(t.ageDays ?? 0);
      const conf = clamp(Number(t.confidence ?? 50), 0, 100);
      // deprioritize very old targets
      const adjConf = conf * (ageDays > 7 ? 0.6 : 1.0);
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(adjConf) });
    }
  }
  if (!out.length && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }
  // ATR-based fallbacks both sides as conservative choices
  if (!out.length) {
    out.push({ tp: Number(price + (atr || price*0.002) * 2), source: 'ATR_UP', confidence: 30 });
    out.push({ tp: Number(price - (atr || price*0.002) * 2), source: 'ATR_DOWN', confidence: 30 });
  }
  // de-dup by rounded price keep max confidence
  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// ---------------------------
// Risk-aware TP/SL selection helpers
// ---------------------------
function computeRiskMetrics(price, tp, sl) {
  if (!isFiniteNum(price) || !isFiniteNum(tp) || !isFiniteNum(sl)) return null;
  const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
  const percMove = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isFiniteNum(rr) ? rr : null, percMove: isFiniteNum(percMove) ? percMove : null };
}

/* chooseCandidateTP:
   - candidates: array of {tp, source, confidence}
   - dir: "Bullish"/"Bearish"/"Neutral"
   - price, atr
   - returns chosen {tp,source,confidence,reason}
*/
function chooseCandidateTP(candidates, dir, price, atr, feats, maxRiskRR = 10) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const multBase = clamp((feats?.atr || atr || price*0.002) / Math.max(EPS, price), 0.0005, 0.1);
  // adaptive multiplier: more volatile => wider targets allowed
  const volFactor = clamp(multBase / 0.002, 0.5, 3.0);

  // prefer candidates in the direction with higher confidence, but validate R:R and distance
  const directionCmp = dir === "Bullish" ? (t => t.tp > price) : dir === "Bearish" ? (t => t.tp < price) : (() => true);

  const filtered = candidates.filter(directionCmp);
  // if none in direction, fallback to nearest (but mark)
  const pool = filtered.length ? filtered : candidates;

  // score function: confidence * proximityFactor * volFactor
  const scored = pool.map(c => {
    const dist = Math.abs(c.tp - price);
    // proximity: prefer reasonable distances (not absurdly close or absurdly far)
    const prox = 1 / (1 + Math.log(1 + dist / Math.max(1, feats?.atr || atr || price*0.002)));
    const score = (c.confidence || 40) * prox * volFactor;
    return { ...c, score, dist };
  }).sort((a,b) => b.score - a.score);

  // pick best that passes R:R sanity (with constructed SL)
  for (const cand of scored) {
    // build conservative SL opposite side: use ATR * 2 (direction-aware)
    let sl;
    if (dir === "Bullish") sl = Number((price - (feats.atr || atr || price*0.002) * 2).toFixed(8));
    else if (dir === "Bearish") sl = Number((price + (feats.atr || atr || price*0.002) * 2).toFixed(8));
    else {
      // neutral: SL uses 1x ATR both sides
      sl = cand.tp > price ? Number((price - (feats.atr || atr || price*0.002) * 1.5).toFixed(8))
                           : Number((price + (feats.atr || atr || price*0.002) * 1.5).toFixed(8));
    }

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    // ensure RR finite and within allowed
    if (!metrics || !isFiniteNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRiskRR) {
      // if it's too large RR (meaning sl extremely close) or invalid, skip
      continue;
    }
    // ensure TP not absurdly tiny vs ATR
    const minTpDist = Math.max((feats.atr || atr || price*0.002) * 0.6, price * 0.0005);
    if (cand.dist < minTpDist) continue;

    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, reason: "best_conf_and_rr", suggestedSL: sl, rr: metrics.rr };
  }

  // if nothing passed RR check, pick top scored but generate conservative TP with ATR multiplier in direction
  const top = scored[0];
  if (!top) return null;
  const mult = dir === "Bullish" ? 2.0 : dir === "Bearish" ? 2.0 : 1.5;
  const fallbackTP = dir === "Bullish" ? Number((price + (feats.atr || atr || price*0.002) * mult).toFixed(8))
                                      : dir === "Bearish" ? Number((price - (feats.atr || atr || price*0.002) * mult).toFixed(8))
                                                           : Number(top.tp);
  const sl = dir === "Bullish" ? Number((price - (feats.atr || atr || price*0.002) * 2).toFixed(8))
                               : dir === "Bearish" ? Number((price + (feats.atr || atr || price*0.002) * 2).toFixed(8))
                                                    : null;
  const metrics = computeRiskMetrics(price, fallbackTP, sl);
  return { tp: fallbackTP, source: "AUTO_ATR", confidence: top.confidence || 40, reason: "fallback_atr", suggestedSL: sl, rr: metrics?.rr ?? null };
}

// ---------------------------
// Core predictor: runMLPrediction (optimized)
// ---------------------------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  try {
    // multi-tf fetch (main + micro) - fetchMultiTF expected to return an object keyed by tf
    const tfs = [tf, "1m"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const main = mtfRaw[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = (isFiniteNum(main.price) && main.price) ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 5 || !isFiniteNum(price) || price <= 0) {
      return {
        modelVersion: "ml_module_v9_0",
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

    // compute features (main + micro)
    const feats = buildFeaturesFromCandles(candles);
    const microCandles = (mtfRaw["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    // analyze ell (non-blocking but awaited)
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // --- scoring with ATR-adaptive weighting ---
    let bullScore = 0, bearScore = 0;
    const atr = Math.max(feats.atr || 0, price * 0.0005); // floor ATR to avoid tiny denominators

    // volatility factor: if ATR large relative to price, momentum carries more weight
    const volRatio = clamp( (atr / Math.max(EPS, price)), 0, 0.05 );
    const momWeight = clamp(1 + (volRatio * 10), 0.7, 3.0);   // 0.7 .. 3
    const slopeWeight = clamp(1 + (volRatio * 6), 0.7, 2.5);

    // slope & mom contributions (normalized)
    bullScore += clamp(feats.slope * slopeWeight * 12, -12, 12);
    bearScore -= clamp(feats.slope * slopeWeight * 12, -12, 12);
    bullScore += clamp(feats.mom5 * momWeight * 10, -12, 12);
    bearScore -= clamp(feats.mom5 * momWeight * 10, -12, 12);

    // RSI contribution (centered 50 -> 0)
    if (isFiniteNum(feats.rsi)) {
      const r = (feats.rsi - 50) / 50; // -1..1
      bullScore += clamp(r * 3.2, -4, 4);
      bearScore -= clamp(r * 3.2, -4, 4);
    }

    // MACD hist normalized by ATR
    if (isFiniteNum(feats.macdHist)) {
      const m = Math.tanh(feats.macdHist / Math.max(1, atr)) * 2.0;
      bullScore += clamp(m, -3, 3);
      bearScore -= clamp(m, -3, 3);
    }

    // micro trend nudge (short term)
    if (microFeats) {
      const mN = microFeats.slope || 0;
      bullScore += clamp(mN * 6, -2.5, 2.5);
      bearScore -= clamp(mN * 6, -2.5, 2.5);
    }

    // volume spike: direction-neutral boost to magnitude (stability -> neutral lowered)
    let volSpike = 0;
    if (feats.avgVol > 0) {
      volSpike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1;
      const vAdj = clamp(Math.min(1.5, volSpike) * 1.0, -1.2, 1.2);
      bullScore += vAdj * 0.4;
      bearScore += vAdj * 0.4;
    }

    // --- Elliott weighting (thresholded, non-linear) ---
    let ellSent = 0, ellConf = 0;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      ellSent = clamp(Number(ell.sentiment || 0), -1, 1);
      ellConf = clamp(Number(ell.confidence || 0), 0, 100);
      if (ellConf >= 35) {
        // use quadratic scaling for high confidence
        const scale = (ellConf >= 80) ? 1.6 : 1.0;
        const ellAdj = ellSent * (0.6 * (ellConf / 100) * scale);
        bullScore += ellAdj;
        bearScore -= ellAdj;
      } // else ignore low confidence Elliott
    }

    // baseline neutral score acts as stability anchor (if both bull/bear small -> neutral)
    // We'll construct logits [bull, bear, neutralStability] where neutralStability decreases when volatility high or volSpike > threshold
    const neutralityBase = 0.25; // baseline
    const neutralVolPenalty = clamp(volRatio * 6 + Math.min(0.8, Math.max(0, volSpike)) * 0.6, 0, 1.2);
    const neutralStability = neutralityBase - neutralVolPenalty; // lower stability if volatile
    // clamp stability into reasonable range
    const stabilityLogit = clamp(neutralStability, -1.0, 1.0);

    // numeric safety: clamp bull/bear into -12..12
    const a = clamp(bullScore, -12, 12);
    const b = clamp(bearScore, -12, 12);
    const c = clamp(stabilityLogit * 2.0, -6, 6); // center neutral logit

    let [pBull, pBear, pNeutral] = softmax3(a,b,c);
    // calibration (slight tilt toward ell confidence)
    if (ellConf > 0) {
      const ellAdj = ellSent * (ellConf / 100) * 0.5;
      const [pa, pb, pc] = softmax3(clamp(a + ellAdj, -12, 12), clamp(b - ellAdj, -12, 12), c);
      pBull = pa; pBear = pb; pNeutral = pc;
    }

    // convert to percent bounded
    let probBull = boundedPercent(pBull * 100);
    let probBear = boundedPercent(pBear * 100);
    let probNeutral = boundedPercent(pNeutral * 100);

    // fix rounding drift to sum 100
    const sum = probBull + probBear + probNeutral || 1;
    probBull = Math.round((probBull / sum) * 10000) / 100;
    probBear = Math.round((probBear / sum) * 10000) / 100;
    probNeutral = Math.round((probNeutral / sum) * 10000) / 100;

    const maxProb = Math.max(probBull, probBear, probNeutral);
    const dir = maxProb === probBull ? "Bullish" : maxProb === probBear ? "Bearish" : "Neutral";

    // Candidate TPs and selection
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);

    const chosen = chooseCandidateTP(candidates, dir, price, atr, feats, /*maxRR=*/ 20);

    const tpEstimate = chosen && isFiniteNum(chosen.tp) ? Number(chosen.tp) : null;
    const tpSource = chosen ? (chosen.source || "AUTO") : null;
    const tpConfidence = chosen ? Math.round(((chosen.confidence || 40) * 0.65 + maxProb * 0.35)) : Math.round(maxProb);

    // conservative SL suggestion from chosen.suggestedSL or ATR-based
    const slEstimate = chosen && isFiniteNum(chosen.suggestedSL) ? Number(chosen.suggestedSL) :
                       dir === "Bullish" ? Number((price - atr * 2).toFixed(8)) :
                       dir === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null;

    // explanation (compact)
    const explanationParts = [
      `slope:${Number(feats.slope.toFixed(6))}`,
      `mom5:${(feats.mom5*100).toFixed(2)}%`,
      isFiniteNum(feats.rsi) ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
      ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
      feats.avgVol ? `volSpike:${((feats.lastVol / Math.max(1, feats.avgVol)) - 1).toFixed(2)}x` : null,
      `atr:${Number(atr.toFixed(8))}`
    ].filter(Boolean).join(" | ");

    const mlObj = {
      modelVersion: "ml_module_v9_0",
      symbol,
      tf,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs: { bull: probBull, bear: probBear, neutral: probNeutral },
      maxProb,
      tpEstimate,
      tpSource,
      tpConfidence,
      slEstimate,
      explanation: explanationParts,
      rawScores: { bull: a, bear: b, neutralLogit: c },
      ellSummary: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null,
      features: { slope: feats.slope, mom5: feats.mom5, rsi: feats.rsi, atr: feats.atr }
    };

    // persist prediction non-blocking
    try { recordPrediction({ id:`${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch(e){}

    return mlObj;
  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (small improvement)
// ---------------------------
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];
    if (!candles || candles.length < 3) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    // combine slope and momentum, normalize by ATR
    const score = clamp((feats.mom5 * 6) + (feats.slope * 5) + ((isFiniteNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 1.5), -12, 12);
    const pBull = (1 / (1 + Math.exp(-score))) * 100;
    const pBear = 100 - pBull;
    const pb = boundedPercent(pBull);
    const pa = boundedPercent(pBear);
    const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v9_0-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
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