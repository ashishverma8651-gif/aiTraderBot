// ml_module_v10_pro.js
// ML Module v10 PRO - single-file upgrade
// Exports:
//   runMLPrediction(symbol, tf, opts)
//   runMicroPrediction(symbol, tf, opts)
//   calculateAccuracy()
//   recordPrediction(pred)
//   recordOutcome(outcome)
//   getAccuracyReport()
//   getAccuracyByTF(tf)
//   getRRStats()
//   markPredictionOutcome(id, outcome)   // mark win/loss and update tracker
//
// Usage: replace previous ml_module file with this content.
// Dependencies: fs, path, fetchMultiTF (from ./utils.js), indicators (./core_indicators.js), analyzeElliott (./elliott_module.js)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// --------------------------- CONFIG & PERSISTENCE ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");         // stored predictions
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");            // stored outcomes
const STATS_FILE = path.join(LOG_DIR, "accuracy_stats.json");    // aggregated stats
const DEBUG_CSV = path.join(LOG_DIR, "debug.csv");

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

let memPreds = [];
let memOuts = [];
let _stats = { total:0, wins:0, losses:0, byTF:{}, byRegime:{}, lastUpdated: null, predictions: [] };

// helper file read/write (safe)
function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt || "null");
  } catch (e) { return null; }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}
(function loadStats() {
  try {
    const s = readJsonSafe(STATS_FILE);
    if (s) _stats = s;
  } catch (e) {}
})();

// --------------------------- NUMERIC HELPERS ---------------------------
const EPS = 1e-12;
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const nf = (v,d=2) => (isFiniteNum(v) ? Number(v).toFixed(d) : "N/A");
const avg = a => (Array.isArray(a) && a.length) ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const boundedPercent = n => { if (!isFiniteNum(n)) return 0; return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100; };

// stable softmax 3
function softmax3(a,b,c) {
  const m = Math.max(a,b,c);
  const ea = Math.exp(a-m), eb = Math.exp(b-m), ec = Math.exp(c-m);
  const s = ea+eb+ec+EPS; return [ea/s, eb/s, ec/s];
}

// --------------------------- RECORD HELPERS ---------------------------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE) || [];
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);
    // debug csv
    try {
      if (!fs.existsSync(DEBUG_CSV)) fs.writeFileSync(DEBUG_CSV, "id,symbol,tf,direction,probs,tp,sl,timestamp\n","utf8");
      const line = [
        pred.id || "",
        pred.symbol || "",
        pred.tf || "",
        pred.ml?.direction || pred.direction || "",
        pred.ml?.probs ? `${pred.ml.probs.bull}/${pred.ml.probs.bear}/${pred.ml.probs.neutral}` : "",
        pred.ml?.tpEstimate ?? pred.tp ?? "",
        pred.ml?.slEstimate ?? pred.sl ?? "",
        new Date().toISOString()
      ].join(",") + "\n";
      fs.appendFileSync(DEBUG_CSV, line, "utf8");
    } catch(e){}
    // also push into running stats partial
    try { _stats.predictions = _stats.predictions || []; _stats.predictions.push({ id: pred.id, symbol: pred.symbol, tf: pred.tf, direction: pred.ml?.direction || pred.direction || null, prob: pred.ml?.maxProb || (pred.ml?.probs ? Math.max(pred.ml.probs.bull, pred.ml.probs.bear, pred.ml.probs.neutral) : null), tp: pred.ml?.tpEstimate || pred.tp || null, sl: pred.ml?.slEstimate || pred.sl || null, ts: new Date().toISOString() }); if (_stats.predictions.length>500) _stats.predictions.shift(); } catch(e){}
    saveStats();
  } catch (e) { memPreds.push(pred); }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE) || [];
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(OUT_FILE, arr)) memOuts.push(outcome);
    // update aggregated stats
    try {
      _stats.total = (_stats.total||0) + 1;
      if (outcome.success) _stats.wins = (_stats.wins||0) + 1;
      else _stats.losses = (_stats.losses||0) + 1;
      // byTF
      if (outcome.tf) { _stats.byTF[outcome.tf] = _stats.byTF[outcome.tf] || { wins:0, losses:0, total:0 }; _stats.byTF[outcome.tf].total++; if (outcome.success) _stats.byTF[outcome.tf].wins++; else _stats.byTF[outcome.tf].losses++; }
      saveStats();
    } catch(e){}
  } catch (e) { memOuts.push(outcome); }
}

export function calculateAccuracy() {
  try {
    const outs = (readJsonSafe(OUT_FILE) || []).concat(memOuts || []);
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.success).length;
    return { accuracy: Math.round((correct/total)*10000)/100, total, correct };
  } catch (e) { return { accuracy: 0, total: 0, correct: 0 }; }
}

// markPredictionOutcome - convenience: link a recorded prediction id to an outcome and update stats.
export function markPredictionOutcome(id, success=true, info={}) {
  try {
    // append to outcomes file
    const out = { alertId: id, success, info, ts: new Date().toISOString() };
    recordOutcome(out);
    // update prediction entry if exists
    const preds = readJsonSafe(PRED_FILE) || [];
    const idx = preds.findIndex(p => p.id === id);
    if (idx >= 0) { preds[idx].outcome = success ? "win" : "loss"; writeJsonSafe(PRED_FILE, preds); }
    return true;
  } catch (e) { return false; }
}

// save aggregated stats
function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
  } catch (e) {}
}

// --------------------------- FEATURE BUILDERS ---------------------------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n-1];
  const closes = candles.map(c=>Number(c.close||0));
  const highs = candles.map(c=>Number(c.high||c.close||0));
  const lows = candles.map(c=>Number(c.low||c.close||0));
  const vols = candles.map(c=>Number(c.volume||c.vol||0));
  const close = Number(last.close || 0);

  const close5 = n >= 6 ? closes[n-6] : closes[0];
  const close20 = n >= 21 ? closes[n-21] : closes[0];
  const mom5 = close5 ? (close - close5) / Math.max(1, close5) : 0;
  const mom20 = close20 ? (close - close20) / Math.max(1, close20) : 0;

  // slope (linear regress)
  const len = Math.min(30, n);
  let num = 0, den = 0, xm = 0, ym = 0;
  for (let i=0;i<len;i++){ xm += i; ym += closes[n-len+i]; }
  xm /= len; ym /= len;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xm)*(y-ym); den += (x-xm)*(x-xm); }
  const slope = den === 0 ? 0 : num/den;

  // ATR
  let atr = 0;
  try {
    if (indicators.computeATR) atr = indicators.computeATR(candles);
    else {
      const trs = [];
      for (let i=1;i<n;i++){
        const tr = Math.max(Math.abs(highs[i]-lows[i]), Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
        trs.push(tr);
      }
      const tail = trs.slice(-14);
      atr = tail.length ? tail.reduce((a,b)=>a+b,0)/tail.length : 0;
    }
  } catch(e) { atr = 0; }

  // RSI / MACD
  let rsi = null, macdHist = null;
  try { if (indicators.computeRSI) rsi = indicators.computeRSI(candles); if (indicators.computeMACD) macdHist = indicators.computeMACD(candles)?.hist ?? null; } catch(e){}

  const avgVol = avg(vols.slice(-20));
  const lastVol = vols[n-1] || 0;

  return { close, mom5, mom20, slope, atr, rsi: isFiniteNum(rsi) ? rsi : null, macdHist: isFiniteNum(macdHist) ? macdHist : null, avgVol, lastVol, high: highs[n-1], low: lows[n-1] };
}

// regime detection (ADX / Bollinger squeeze / ATR vs price)
function detectRegime(candles) {
  // lightweight — use ATR/price ratio and RSI dispersion as proxy + optional indicators if available
  if (!Array.isArray(candles) || candles.length < 20) return "unknown";
  const feats = buildFeaturesFromCandles(candles);
  const volRatio = feats.atr / Math.max(1, feats.close);
  if (volRatio > 0.01) return "volatile";
  if (volRatio > 0.003) return "trend";
  // check price movement small -> range
  const closes = candles.map(c=>c.close);
  const change = (closes.at(-1) - closes.at(0)) / Math.max(1, Math.abs(closes.at(0)));
  if (Math.abs(change) < 0.01) return "range";
  return "trend";
}

// --------------------------- VOLUME / MICROSTRUCTURE ---------------------------
function computeVolumeSignals(candles) {
  // return volume spike, last/avg ratio, CVD-like delta
  if (!Array.isArray(candles) || candles.length < 6) return { volSpike: 1, volRatio:1, cvd:0 };
  const vols = candles.map(c=>Number(c.volume||0));
  const last = vols.at(-1);
  const avgPast = avg(vols.slice(0, -1)) || 1;
  const volRatio = last / avgPast;
  // simplistic CVD: sum((close>open)?vol:-vol)
  let cvd = 0;
  for (const c of candles) { cvd += ((c.close > c.open) ? (c.volume||0) : - (c.volume||0)); }
  return { volSpike: volRatio, volRatio, cvd };
}

// --------------------------- CANDIDATE TP / HEDGE ENGINE ---------------------------
function buildCandidateTPsFromElliott(ell, price, atr) {
  // reuse earlier heuristic but keep small and safe
  const out = [];
  if (ell?.targets?.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      const age = Number(t.ageDays ?? 0);
      const conf = clamp(Number(t.confidence ?? 50), 0, 100);
      const adj = conf * (age > 7 ? 0.6 : 1.0);
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(adj) });
    }
  }
  if (!out.length && ell?.fib?.ext) {
    if (ell.fib.ext["1.272"]) out.push({ tp: Number(ell.fib.ext["1.272"]), source: "FIB_1.272", confidence:40 });
    if (ell.fib.ext["1.618"]) out.push({ tp: Number(ell.fib.ext["1.618"]), source: "FIB_1.618", confidence:35 });
  }
  // ATR fallback
  if (!out.length) {
    out.push({ tp: price + (atr || price*0.002)*2, source: "ATR_UP", confidence:30 });
    out.push({ tp: price - (atr || price*0.002)*2, source: "ATR_DOWN", confidence:30 });
  }
  // dedupe keep highest confidence
  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b)=>Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// risk metrics
function computeRiskMetrics(price, tp, sl) {
  if (!isFiniteNum(price) || !isFiniteNum(tp) || !isFiniteNum(sl)) return null;
  const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
  const perc = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isFiniteNum(rr) ? rr : null, percMove: isFiniteNum(perc) ? perc : null };
}

// choose candidate TP with RR sanity and ATR fallback
function chooseCandidateTP(candidates, dir, price, atr, feats, maxRR=20) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const baseATR = feats?.atr || atr || price*0.002;
  const volFactor = clamp((baseATR/price)/0.002, 0.5, 3);

  const dirFilter = dir === "Bullish" ? t => t.tp > price : dir === "Bearish" ? t => t.tp < price : ()=>true;
  const pool = candidates.filter(dirFilter).length ? candidates.filter(dirFilter) : candidates;

  const scored = pool.map(t => {
    const dist = Math.abs(t.tp - price);
    const prox = 1 / (1 + Math.log(1 + dist/Math.max(1, baseATR)));
    return { ...t, dist, score: (t.confidence||40)*prox*volFactor };
  }).sort((a,b)=>b.score-a.score);

  for (const cand of scored) {
    let sl;
    if (dir === "Bullish") sl = price - baseATR*2;
    else if (dir === "Bearish") sl = price + baseATR*2;
    else sl = cand.tp > price ? price - baseATR*1.5 : price + baseATR*1.5;

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    if (!metrics || !isFiniteNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRR) continue;
    const minDist = Math.max(baseATR*0.6, price*0.0005);
    if (cand.dist < minDist) continue;
    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, suggestedSL: Number(sl.toFixed(8)), rr: metrics.rr, reason:"best_conf_and_rr" };
  }
  // fallback
  const top = scored[0];
  const fallbackTP = dir === "Bullish" ? price + baseATR*2 : dir === "Bearish" ? price - baseATR*2 : (top ? top.tp : price + baseATR*2);
  const sl = dir === "Bullish" ? price - baseATR*2 : dir === "Bearish" ? price + baseATR*2 : price - baseATR*2;
  return { tp: Number(fallbackTP.toFixed(8)), source: "AUTO_ATR", confidence: top?.confidence||40, suggestedSL: Number(sl.toFixed(8)), rr:null, reason:"fallback" };
}

// hedge logic: returns hedgeTP (opposite-side protective) if required
function computeHedgeTP(price, dir, atr, opts={mode:"confidence", confThreshold:70}) {
  // modes: "always", "confidence", "trendOnly"
  const base = price;
  const mult = 1.2;
  if (opts.mode === "always") {
    if (dir === "Bullish") return price - atr * mult;
    if (dir === "Bearish") return price + atr * mult;
  } else if (opts.mode === "confidence") {
    if ((opts.conf ?? 70) >= opts.confThreshold) {
      if (dir === "Bullish") return price - atr * mult;
      if (dir === "Bearish") return price + atr * mult;
    }
  } else {
    // trendOnly fallthrough: same as always for now
    if (dir === "Bullish") return price - atr * mult;
    if (dir === "Bearish") return price + atr * mult;
  }
  return null;
}

// --------------------------- ADAPTIVE / SELF-TUNER (Lightweight) ---------------------------
function selfTuneAdjustments(recentOutcomes = []) {
  // recentOutcomes: array of { success:bool, regime, prob, rr }
  // compute winrate and return small weight adjustments
  if (!Array.isArray(recentOutcomes) || !recentOutcomes.length) return { biasAdj:0, volAdj:1 };
  const wins = recentOutcomes.filter(r=>r.success).length;
  const winRate = wins / recentOutcomes.length;
  // biasAdj: if winRate > 0.6, slightly favor current logic; if <0.4, tighten threshold
  const biasAdj = (winRate - 0.5) * 0.3; // -0.15..+0.15
  const volAdj = 1 + (winRate - 0.5) * 0.5; // ~0.75..1.25
  return { biasAdj, volAdj };
}

// --------------------------- MULTI-TF FUSION ---------------------------
async function fetchMultiFeatures(symbol, tfs = ["1m","5m","15m","30m","1h"]) {
  const mtf = await fetchMultiTF(symbol, tfs);
  const features = {};
  for (const tf of tfs) {
    const entry = mtf[tf] || { data: [], price: 0 };
    features[tf] = { price: entry.price || entry.data?.at(-1)?.close || 0, feats: buildFeaturesFromCandles(entry.data || []), candles: entry.data || [] };
  }
  return features;
}

// build "consensus" trend score across TFs
function buildConsensusScore(multiFeatures) {
  // weight higher TFs more (user-tunable)
  const weights = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
  let s=0, ws=0;
  for (const tf in multiFeatures) {
    const f = multiFeatures[tf].feats;
    if (!f) continue;
    const w = weights[tf] ?? 0.1;
    // score from slope + mom + rsi
    let sc = 0;
    sc += clamp((f.slope||0) * 10, -5, 5);
    sc += clamp((f.mom5||0) * 10, -5, 5);
    if (isFiniteNum(f.rsi)) sc += (f.rsi - 50) / 10;
    s += sc * w; ws += w;
  }
  return ws ? (s/ws) : 0;
}

// --------------------------- MAIN ML PREDICTOR (v10 PRO) ---------------------------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  // opts: { useMultiTF:true, hedgeMode:"confidence", hedgeConf:70, selfTune:true }
  try {
    const cfg = { useMultiTF: true, hedgeMode: "confidence", hedgeConf:70, selfTune:true, ...opts };
    const tfs = cfg.useMultiTF ? [tf, "1m","5m","30m","1h"] : [tf, "1m"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const main = mtfRaw[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isFiniteNum(main.price) ? main.price : candles?.at(-1)?.close ?? 0;

    if (!candles?.length || candles.length < 5 || price <= 0) {
      return { modelVersion:"ml_module_v10_pro", symbol, tf, direction:"Neutral", probs:{bull:33.33,bear:33.33,neutral:33.33}, maxProb:33.33, tpEstimate:null, tpSource:null, tpConfidence:33, slEstimate:null, explanation:"insufficient data" };
    }

    // multi features
    const multi = await fetchMultiFeatures(symbol, tfs);
    const feats = buildFeaturesFromCandles(candles);
    const microFeats = multi["1m"]?.feats ?? null;

    // regime
    const regime = detectRegime(candles);

    // volume signals
    const volSig = computeVolumeSignals(candles);

    // ell
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch(e) { ell = null; }

    // consensus
    const consensus = buildConsensusScore(multi);

    // core scoring: adjustable small weights
    let bullScore = 0, bearScore = 0;
    const atr = Math.max(feats.atr || 0, price*0.0005);
    const volRatio = clamp(atr / price, 0, 0.05);

    const momWeight = clamp(1 + volRatio * 10, 0.7, 3);
    const slopeWeight = clamp(1 + volRatio * 6, 0.7, 2.5);

    bullScore += clamp(feats.slope * slopeWeight * 12, -12, 12);
    bearScore -= clamp(feats.slope * slopeWeight * 12, -12, 12);
    bullScore += clamp(feats.mom5 * momWeight * 10, -12, 12);
    bearScore -= clamp(feats.mom5 * momWeight * 10, -12, 12);

    if (isFiniteNum(feats.rsi)) { const r=(feats.rsi-50)/50; bullScore += clamp(r * 3.2, -4, 4); bearScore -= clamp(r * 3.2, -4, 4); }

    if (isFiniteNum(feats.macdHist)) { const m = Math.tanh(feats.macdHist/Math.max(1,atr)) * 2; bullScore += clamp(m, -3, 3); bearScore -= clamp(m, -3, 3); }

    if (microFeats) { const mN = microFeats.slope || 0; bullScore += clamp(mN * 6, -2.5, 2.5); bearScore -= clamp(mN * 6, -2.5, 2.5); }

    // volume spike increases magnitude but not direction
    let volSpike = 0;
    if (feats.avgVol > 0) {
      volSpike = feats.lastVol / Math.max(1, feats.avgVol) - 1;
      const adj = clamp(Math.min(1.5, volSpike), -1.2, 1.2);
      bullScore += 0.4 * adj;
      bearScore += 0.4 * adj;
    }

    // ell weighting (if credible)
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      const ellSent = clamp(Number(ell.sentiment || 0), -1, 1);
      const ellConf = clamp(Number(ell.confidence || 0), 0, 100);
      if (ellConf >= 35) {
        const scale = ellConf >= 80 ? 1.6 : 1;
        const ellAdj = ellSent * (0.6 * (ellConf / 100) * scale);
        bullScore += ellAdj; bearScore -= ellAdj;
      }
    }

    // consensus boost
    bullScore += clamp(consensus, -2, 2);
    bearScore -= clamp(consensus, -2, 2);

    // Neutral stability logit
    const neutralityBase = 0.25;
    const neutralPenalty = clamp(volRatio * 6 + Math.max(0, volSpike) * 0.6, 0, 1.2);
    const neutralLogit = clamp((neutralityBase - neutralPenalty) * 2, -6, 6);

    // softmax
    const [pBullRaw, pBearRaw, pNeutralRaw] = softmax3(clamp(bullScore,-12,12), clamp(bearScore,-12,12), neutralLogit);
    let pBull = boundedPercent(pBullRaw*100), pBear = boundedPercent(pBearRaw*100), pNeutral = boundedPercent(pNeutralRaw*100);
    const sum = pBull + pBear + pNeutral || 1;
    pBull = Math.round((pBull/sum)*10000)/100; pBear = Math.round((pBear/sum)*10000)/100; pNeutral = Math.round((pNeutral/sum)*10000)/100;
    const probs = { bull: pBull, bear: pBear, neutral: pNeutral };
    const maxProb = Math.max(pBull, pBear, pNeutral);
    const direction = maxProb === pBull ? "Bullish" : maxProb === pBear ? "Bearish" : "Neutral";

    // candidate TPs & choice
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);
    const chosen = chooseCandidateTP(candidates, direction, price, atr, feats, 20);
    const tpEstimate = chosen?.tp ?? null;
    const slEstimate = chosen?.suggestedSL ?? null;
    const tpConfidence = chosen ? Math.round((chosen.confidence||40)*0.65 + maxProb*0.35) : Math.round(maxProb);

    // hedge
    const hedge = computeHedgeTP(price, direction, atr, { mode: cfg.hedgeMode, conf: Math.round(maxProb), confThreshold: cfg.hedgeConf });

    // explanation
    const explanation = [
      `slope:${Number(feats.slope.toFixed(6))}`,
      `mom5:${(feats.mom5*100).toFixed(2)}%`,
      isFiniteNum(feats.rsi) ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
      ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
      `volSpike:${Number((feats.lastVol/Math.max(1,feats.avgVol)-1).toFixed(2))}x`,
      `atr:${Number(atr.toFixed(8))}`,
      `regime:${regime}`
    ].filter(Boolean).join(" | ");

    const mlObj = {
      modelVersion: "ml_module_v10_pro",
      symbol, tf, generatedAt: new Date().toISOString(),
      direction, probs, maxProb, tpEstimate, tpSource: chosen?.source ?? null, tpConfidence, slEstimate, hedgeTP: hedge || null,
      explanation, rawScores: { bull: bullScore, bear: bearScore, neutralLogit }, ellSummary: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null, features: { ...feats, consensus }, regime, volSig
    };

    // record prediction (non-blocking)
    try { recordPrediction({ id:`${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch(e){}

    return mlObj;
  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// --------------------------- MICRO PREDICTOR ---------------------------
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m", opts={}) {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const candles = mtf[tf]?.data || [];
    if (candles.length < 3) return { label:"Neutral", prob:33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    const score = clamp(feats.mom5 * 6 + feats.slope * 5 + ((isFiniteNum(feats.rsi) ? (feats.rsi - 50)/50 : 0)*1.5), -12, 12);
    const pBull = 100 / (1 + Math.exp(-score));
    const pBear = 100 - pBull;
    const pb = boundedPercent(pBull), pa = boundedPercent(pBear);
    const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v10_pro-micro", label, prob: Math.max(pb,pa), probBull:pb, probBear:pa, slope: feats.slope };
  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// --------------------------- ACCURACY REPORTS ---------------------------
export function getAccuracyReport() {
  const acc = calculateAccuracy();
  const byTF = _stats.byTF || {};
  const res = { global: acc, stats: _stats, byTF };
  return res;
}

export function getAccuracyByTF(tf) {
  if (!_stats.byTF || !_stats.byTF[tf]) return { total:0, wins:0, losses:0, accuracy:0 };
  const o = _stats.byTF[tf];
  const acc = o.total ? Math.round((o.wins / o.total) * 10000) / 100 : 0;
  return { ...o, accuracy: acc };
}

export function getRRStats() {
  // compute from outcomes file (best-effort)
  try {
    const outs = readJsonSafe(OUT_FILE) || [];
    const rrs = outs.map(o=>o.rr).filter(isFiniteNum);
    if (!rrs.length) return { avgRR: null, medianRR: null, count:0 };
    const avgRR = rrs.reduce((a,b)=>a+b,0)/rrs.length;
    const sorted = rrs.slice().sort((a,b)=>a-b);
    const mid = Math.floor(sorted.length/2);
    const median = sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
    return { avgRR, medianRR: median, count: rrs.length };
  } catch (e) { return { avgRR:null, medianRR:null, count:0 }; }
}

// --------------------------- DEFAULT EXPORT ---------------------------
export default {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome,
  getAccuracyReport,
  getAccuracyByTF,
  getRRStats,
  markPredictionOutcome
};