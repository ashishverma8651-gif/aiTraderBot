// ml_v12_precision_pro.js
// Ultra-Pro single-file merge:
// - ML v12 Precision core (runMLPrediction, runMicroPrediction, accuracy, record/mark outcomes, trainAdaptive, resetStats)
// - Pro meters: computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure
// - Fusion & stable target helpers (fuseMLTFs, buildStableTargets, chooseStablePrimaryHedge, etc.)
// - Convenience: buildAIReport(symbol, opts) to produce full report object for TG formatting
//
// Requires (available in your repo):
//  - fetchMultiTF(symbol, tfsArray) -> { "1m":{data,price}, "15m":{...}, ... }
//  - analyzeElliott(candles) -> { targets: [{tp,confidence,source}], pivots, patterns, confidence }
//  - news_social.js export with fetchNewsBundle(symbol)
//  - optional: core_indicators.js exports (computeRSI, computeATR, computeMACD, volumeTrend)
//
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
//          markOutcome, getStats, trainAdaptive, resetStats,
//          computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
//          fuseMLTFs, buildStableTargets, buildAIReport
//
// Ultra-Pro mode: extra guards, throttling, robust persistence, small online adaptive trainer.
//
// Author: Generated for you (ml_v12_precision_pro)
// Date: 2025-11-21

// ---------- Imports ----------
import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";          // must exist
import { analyzeElliott } from "./elliott_module.js"; // must exist
import News from "./news_social.js";
import * as indicators from "./core_indicators.js"; // optional but used if present

// safe news accessor
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// ---------- Persistence & configuration ----------
const ML_LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v12_precision_pro_logs");
const PRED_FILE = path.join(ML_LOG_DIR, "predictions.json");
const OUT_FILE = path.join(ML_LOG_DIR, "outcomes.json");
const STATS_FILE = path.join(ML_LOG_DIR, "stats.json");
const DEFAULT_THROTTLE_MS = Number(process.env.ML_THROTTLE_MS || 250); // avoid rapid calls

try { if (!fs.existsSync(ML_LOG_DIR)) fs.mkdirSync(ML_LOG_DIR, { recursive: true }); } catch (e) {}

const readJsonSafe = (f, fallback = []) => {
  try { if (!fs.existsSync(f)) return fallback; const s = fs.readFileSync(f, "utf8"); return JSON.parse(s || "[]"); } catch (e) { return fallback; }
};
const writeJsonSafe = (f, obj) => {
  try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
};

// ---------- Utilities ----------
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const nf = (v,d=2) => isNum(v) ? Number(v).toFixed(d) : "N/A";
const nowISO = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let _lastCall = 0;

// ---------- Stats & adaptive weights ----------
let _stats = {
  total: 0, wins: 0, losses: 0,
  accuracyCache: null,
  adaptiveWeights: { w_ind: 0.45, w_cnn: 0.25, w_of: 0.2, w_news: 0.1, lr: 0.02 },
  alerts: [],
  lastUpdated: null,
  meta: { version: "v12_precision_pro" }
};
try {
  const raw = readJsonSafe(STATS_FILE, null);
  if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw);
} catch (e) {}

// ---------- Recording functions ----------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []);
    arr.push({ ...pred, recordedAt: nowISO() });
    writeJsonSafe(PRED_FILE, arr);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id || null, symbol: pred.symbol || pred?.ml?.symbol || null, ts: nowISO(), meta: pred.meta || pred.ml || null });
    if (_stats.alerts.length > 5000) _stats.alerts.shift();
    _stats.lastUpdated = nowISO();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []);
    arr.push({ ...outcome, recordedAt: nowISO() });
    writeJsonSafe(OUT_FILE, arr);
    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1; else _stats.losses = (_stats.losses || 0) + 1;
    _stats.accuracyCache = null;
    _stats.lastUpdated = nowISO();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function calculateAccuracy() {
  try {
    if (_stats.accuracyCache) return _stats.accuracyCache;
    const outs = readJsonSafe(OUT_FILE, []);
    const total = outs.length || (_stats.total || 0);
    if (!total) {
      const res = { accuracy: 0, total: 0, correct: 0 };
      _stats.accuracyCache = res;
      return res;
    }
    const correct = outs.filter(o => o && o.success).length || 0;
    const acc = Math.round((correct / total) * 10000) / 100;
    const res = { accuracy: acc, total, correct };
    _stats.accuracyCache = res;
    return res;
  } catch (e) { return { accuracy: 0, total: 0, correct: 0 }; }
}

export function getStats() { return { ..._stats, accuracy: calculateAccuracy() }; }
export function resetStats() {
  _stats = { total:0, wins:0, losses:0, accuracyCache:null, adaptiveWeights: { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1,lr:0.02 }, alerts: [], lastUpdated: null, meta: { version: "v12_precision_pro" } };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// markOutcome: record outcome and optionally update adaptive weights if trueLabel provided
export function markOutcome(symbol, alertId, success=true, trueLabel=null) {
  try {
    recordOutcome({ alertId, symbol, success, ts: nowISO() });
    if (typeof trueLabel === "string") {
      const preds = readJsonSafe(PRED_FILE, []);
      const p = preds.find(px => px.id === alertId);
      if (p && p.meta && p.meta.scores) {
        const fused = fuseScores(p.meta.scores, _stats.adaptiveWeights);
        updateAdaptiveWeights(trueLabel, fused.fused, { breakdown: fused.breakdown });
        writeJsonSafe(STATS_FILE, _stats);
      }
    }
    return true;
  } catch (e) { return false; }
}

// ---------- Candle heuristics & feature builder ----------
function candleVisionHeuristic(candles, lookback = 8) {
  if (!Array.isArray(candles) || candles.length === 0) return { label: "Neutral", probs: { bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c => c.close > c.open).length;
  const down = last.filter(c => c.close < c.open).length;
  const momentum = (last.at(-1).close - last[0].close) / Math.max(EPS, last[0].close);
  const vol = mean(last.map(c => Number(c.volume||0)));
  let score = 0.5 + clamp(momentum * 5, -0.45, 0.45);
  const lc = last.at(-1);
  const body = Math.abs(lc.close - lc.open) || 1;
  const upper = lc.high - Math.max(lc.open, lc.close);
  const lower = Math.min(lc.open, lc.close) - lc.low;
  if (lower > body * 1.6 && upper < body * 0.6) score += 0.12;
  if (upper > body * 1.6 && lower < body * 0.6) score -= 0.12;
  score = clamp(score, 0.01, 0.99);
  const bull = Math.round(score * 10000) / 100;
  const bear = Math.round((1 - score) * 10000) / 100;
  const label = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";
  return { label, probs: { bull, bear, neutral: Math.round((100 - bull - bear) * 100) / 100 }, score, features: { momentum, up, down, vol } };
}

function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const closes = candles.map(c => Number(c.close||0));
  const last = candles[n-1];
  const close = Number(last.close || 0);
  const len = Math.min(20, n);
  let xmean=0, ymean=0;
  for (let i=0;i<len;i++){ xmean += i; ymean += closes[n-len+i]; }
  xmean /= len; ymean /= len;
  let num=0, den=0;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den === 0 ? 0 : num/den;
  const trs = [];
  for (let i=1;i<n;i++) {
    const h = Number(candles[i].high||0), l = Number(candles[i].low||0), pc = Number(candles[i-1].close||0);
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  const atr = trs.length ? mean(trs.slice(-14)) : 0;
  const mom3 = n >= 4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n-11]) / Math.max(EPS, closes[n-11]) : 0;
  const vols = candles.map(c => Number(c.volume||0));
  const avgVol = mean(vols.slice(-20));
  let gains=0, losses=0;
  for (let i=Math.max(1,n-14); i<n; i++) {
    const d = closes[i] - closes[i-1]; if (d>0) gains += d; else losses += Math.abs(d);
  }
  const avgGain = gains/14 || 0; const avgLoss = losses/14 || 0;
  const rsi = (avgGain+avgLoss) ? 100 - (100 / (1 + avgGain/Math.max(EPS, avgLoss))) : 50;
  const of = (() => {
    if (n < 2) return {};
    const lastVol = Number(last.volume||0);
    const prev = candles[n-2];
    const delta = (last.close - last.open) * (last.volume || 1);
    const vel = last.close - prev.close;
    return { delta, vel, lastVol, avgVol, swingHigh: Math.max(...candles.slice(-8).map(c=>c.high)), swingLow: Math.min(...candles.slice(-8).map(c=>c.low)) };
  })();
  return { close, slope, mom3, mom10, atr, rsi, avgVol, lastVol: (last.volume||0), of, candles };
}

// ---------- Indicator scoring layers ----------
function indicatorLayer(feats) {
  if (!feats) return { score: 0.5, details: {} };
  const { slope, mom3, rsi, avgVol, lastVol } = feats;
  let s = 0.5;
  s += clamp(Math.tanh(slope / Math.max(1, Math.abs(feats.close||1))) * 0.5, -0.25, 0.25);
  s += clamp((Math.tanh(mom3 * 6) || 0) * 0.25, -0.2, 0.2);
  if (isNum(rsi)) { const rn = clamp((rsi - 50) / 50, -1, 1); s += rn * 0.15; }
  if (avgVol && lastVol) { s += clamp((lastVol / Math.max(EPS, avgVol) - 1) * 0.05, -0.05, 0.05); }
  s = clamp(s, 0.01, 0.99);
  return { score: s, details: { slope, mom3, rsi } };
}

async function cnnLayer(candles) {
  // Deterministic fallback - candle vision heuristic
  const cv = candleVisionHeuristic(candles, 8);
  const score = (cv.score || 0.5);
  return { score, probs: cv.probs, features: cv.features };
}

function orderFlowScore(of) {
  if (!of) return 0.5;
  let s = 0.5;
  if (isNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, of.avgVol || 1)) * 0.2, -0.2, 0.2);
  if (isNum(of.vel)) s += clamp(Math.tanh(of.vel / Math.max(1, (of.avgVol || 1) / 100)) * 0.15, -0.15, 0.15);
  return clamp(s, 0.01, 0.99);
}

// ---------- Adaptive weights helpers ----------
function fuseScores(scores, weights) {
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind ?? 0.5, 0, 1);
  const cnn = clamp(scores.cnn ?? 0.5, 0, 1);
  const of = clamp(scores.of ?? 0.5, 0, 1);
  const news = clamp(scores.news ?? 0.5, 0, 1);
  const fused = ind * (w.w_ind || 0.45) + cnn * (w.w_cnn || 0.25) + of * (w.w_of || 0.2) + news * (w.w_news || 0.1);
  return { fused: clamp(fused, 0.01, 0.99), breakdown: { ind, cnn, of, news }, weights: w };
}
function updateAdaptiveWeights(trueLabel, predProb, features = {}) {
  try {
    const w = _stats.adaptiveWeights;
    if (!w) return;
    const lr = w.lr || 0.02;
    const y = trueLabel === "Bullish" ? 1 : trueLabel === "Bearish" ? 0 : 0.5;
    const err = y - predProb;
    const contrib = features.breakdown || { ind:0.5, cnn:0.5, of:0.5, news:0.5 };
    w.w_ind = clamp(w.w_ind + lr * err * (contrib.ind - 0.5), 0.05, 0.8);
    w.w_cnn = clamp(w.w_cnn + lr * err * (contrib.cnn - 0.5), 0.05, 0.6);
    w.w_of = clamp(w.w_of + lr * err * (contrib.of - 0.5), 0.05, 0.6);
    w.w_news = clamp(w.w_news + lr * err * (contrib.news - 0.5), 0.01, 0.3);
    const s = w.w_ind + w.w_cnn + w.w_of + w.w_news;
    w.w_ind /= s; w.w_cnn /= s; w.w_of /= s; w.w_news /= s;
    _stats.adaptiveWeights = w;
    writeJsonSafe(STATS_FILE, _stats);
  } catch (e) {}
}

// ---------- TP/SL helpers (stable) ----------
function buildCandidateTPsFromElliott(ell) {
  if (!ell || !Array.isArray(ell.targets)) return [];
  const out = [];
  for (const t of ell.targets) {
    const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
    if (!isNum(tp) || tp <= 0) continue;
    out.push({ tp, source: t.source || t.type || "elliott", confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)) });
  }
  return out;
}
function buildATRFallbackTPs(price, atr) {
  atr = Math.max(atr || 0, Math.abs(price) * 0.0005, 1);
  return [
    { tp: Number((price + atr * 2.5).toFixed(8)), source: "ATR_UP", confidence: 30 },
    { tp: Number((price - atr * 2.5).toFixed(8)), source: "ATR_DOWN", confidence: 30 }
  ];
}
function dedupeAndSortCandidates(candidates, price) {
  const map = new Map();
  for (const c of candidates) {
    const key = Math.round(c.tp);
    if (!map.has(key) || (c.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, c);
  }
  const arr = Array.from(map.values());
  arr.sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
  return arr;
}
function chooseStablePrimaryHedge(candidates, dir, price, feats, config) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  const minDist = config.MIN_TP_DISTANCE || (atr * (config.MIN_TP_DISTANCE_ATR_MULT || 1.2));
  const meaningful = candidates.filter(c => Math.abs(c.tp - price) >= minDist);
  const pool = meaningful.length ? meaningful : candidates;
  if (!pool.length) {
    const primary = (dir === "Bullish") ? price + atr * 2.5 : (dir === "Bearish") ? price - atr * 2.5 : price + atr * 2.5;
    const hedge = (dir === "Bullish") ? price - atr * 1.2 : (dir === "Bearish") ? price + atr * 1.2 : price - atr * 1.2;
    return { primary: Number(primary), hedge: Number(hedge), primarySource: "ATR_FALLBACK", hedgeSource: "ATR_HEDGE", confidence: 40 };
  }
  let primary = null;
  if (dir === "Bullish") primary = pool.find(p => p.tp > price) || pool[0];
  else if (dir === "Bearish") primary = pool.find(p => p.tp < price) || pool[0];
  else primary = pool[0];
  const opp = pool.find(p => (dir === "Bullish" ? p.tp < price : p.tp > price));
  const atrH = Math.max(feats?.atr || atr, Math.abs(price) * 0.0005);
  const hedge = opp || { tp: Number((price + (dir === "Bullish" ? -atrH * 1.2 : atrH * 1.2)).toFixed(8)), source: "HEDGE_ATR", confidence: 30 };
  const pconf = Math.round(Math.min(100, (primary.confidence || 40) * 0.6 + 40));
  return {
    primary: Number(primary.tp),
    hedge: Number(hedge.tp),
    primarySource: primary.source || "CAND",
    hedgeSource: hedge.source || "CAND",
    confidence: pconf
  };
}
function pickSLForPrimary(dir, price, feats) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  if (feats && Array.isArray(feats.candles) && feats.candles.length >= 3) {
    const window = feats.candles.slice(-12);
    const swingLow = Math.min(...window.map(c => c.low));
    const swingHigh = Math.max(...window.map(c => c.high));
    if (dir === "Bullish") return Number(Math.min(swingLow, price - atr * 1.2).toFixed(8));
    if (dir === "Bearish") return Number(Math.max(swingHigh, price + atr * 1.2).toFixed(8));
  }
  return dir === "Bullish" ? Number((price - atr * 1.5).toFixed(8)) : dir === "Bearish" ? Number((price + atr * 1.5).toFixed(8)) : Number((price - atr * 1.5).toFixed(8));
}

// ---------- Precision decision core (improved) ----------
function buildDecisionFeaturesForPrecision(featsPrimary, newsObj, systemProb) {
  const slope = featsPrimary.slope || 0;
  const mom3 = featsPrimary.mom3 || 0;
  const rsi = featsPrimary.rsi || 50;
  const vol = (featsPrimary.lastVol || 0) - (featsPrimary.avgVol || 0);
  const atrNorm = featsPrimary.atr ? (featsPrimary.atr / Math.max(EPS, Math.abs(featsPrimary.close || 1))) : 0.001;
  const newsImpact = (newsObj && newsObj.impact) ? String(newsObj.impact).toLowerCase() : "low";
  const sentiment = (newsObj && typeof newsObj.sentiment === "number") ? (newsObj.sentiment * 100) : 50;
  return { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb: systemProb || 0.5, featsPrimary };
}

function featsApprox(v) { return Math.abs(v || 0); }
function featsApproxAbsAvg(v) { return Math.max(1, Math.abs(v || 1)); }

function getMLDirectionPrecision(features) {
  const { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb } = features;

  const momStrength = mom3 * (rsi / 50);
  const slopeSign = Math.sign(slope || 0);
  const slopeMag = Math.abs(slope || 0);
  const smoothedSlope = (slope * 0.55) + (slopeSign * Math.sqrt(slopeMag) * 0.25) + (slope * atrNorm * 0.20);

  // safe approx for vol scaling
  const volBase = featsApproxAbsAvg(vol || 1);
  const S_slope = clamp(smoothedSlope * 0.45 / Math.max(1, volBase*0.0001), -5, 5);
  const S_mom = clamp(momStrength * 0.33, -4, 4);
  const S_rsi = clamp((rsi - 50) * 0.06, -3, 3);
  const sentAdj = (sentiment - 50) / 50;
  const newsMultiplier = (newsImpact === "high") ? 1.6 : (newsImpact === "moderate") ? 1.0 : 0.4;
  const S_news = clamp(sentAdj * 1.2 * newsMultiplier, -3, 3);
  const S_vol = clamp(Math.sign(vol) * Math.min(1, Math.abs(vol) / Math.max(1, volBase)) * 0.4, -1, 1);
  const S_system = (systemProb - 0.5) * 2 * 1.1;

  const raw = S_slope + S_mom + S_rsi + S_news + S_vol + S_system;
  const probBull = 1 / (1 + Math.exp(-raw / 3.5));
  const confidence = Math.round(probBull * 100);
  const direction = (confidence >= 60) ? "Bullish" : (confidence <= 40) ? "Bearish" : "Neutral";
  return { direction, confidence: Math.max(0, Math.min(100, confidence)), probBull: Math.round(probBull * 10000)/100 };
}

// ---------- MAIN runMLPrediction (precision) ----------
export async function runMLPrediction(symbol="BTCUSDT", tfc="15m", opts={}) {
  try {
    // throttle friendly
    const now = Date.now();
    if (now - _lastCall < DEFAULT_THROTTLE_MS) await sleep(DEFAULT_THROTTLE_MS - (now - _lastCall));
    _lastCall = Date.now();

    const DEFAULT_CONFIG = { fusedTFs: ["15m","30m","1h"], minTFsForFusion: 2, MIN_TP_DISTANCE_ATR_MULT: 1.2, MAX_PER_TF_SNAPS:1 };
    const CONFIG = Object.assign({}, DEFAULT_CONFIG, opts.config || {});

    const tfsToFetch = Array.from(new Set([tfc, ...CONFIG.fusedTFs, "1m", "5m", "30m", "1h"])).slice(0,12);
    const mtfRaw = await fetchMultiTF(symbol, tfsToFetch);
    const primaryRaw = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = Array.isArray(primaryRaw.data) ? primaryRaw.data : [];
    const price = isNum(primaryRaw.price) && primaryRaw.price > 0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_v12_precision_pro",
        symbol, tf: tfc, direction: "Neutral",
        probs: { bull:33.33, bear:33.33, neutral:33.33 }, maxProb:33.33,
        tpEstimate: null, tpSource: null, tpConfidence: 0, slEstimate: null, perTf: []
      };
    }

    // primary features & base layers
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment, 0, 1) : 0.5;

    // per-TF snapshots for fusedTFs
    const perTfSnapshots = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      const p = isNum(raw.price) && raw.price > 0 ? raw.price : (c?.at(-1)?.close ?? price);
      if (!c || c.length < 6) {
        perTfSnapshots.push({ tf, direction: "Neutral", tp: null, maxProb: 33 });
        continue;
      }
      const f = buildFeaturesFromCandles(c);
      const indL = indicatorLayer(f);
      const cnnL = await cnnLayer(c);
      const ofL = orderFlowScore(f?.of || {});
      const scores = { ind: indL.score, cnn: (cnnL.score || 0.5), of: ofL, news: newsScore };
      const fused = fuseScores(scores, _stats.adaptiveWeights);
      const bullP = fused.fused;
      const pb = Math.round(bullP * 10000) / 100;
      const pr = Math.round((1 - bullP) * 10000) / 100;
      const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
      let ell = null;
      try { ell = await analyzeElliott(c); } catch (e) { ell = null; }
      let candidates = buildCandidateTPsFromElliott(ell);
      if (!candidates.length) candidates = buildATRFallbackTPs(p, f?.atr);
      candidates = dedupeAndSortCandidates(candidates, p);
      const top = candidates[0] || null;
      perTfSnapshots.push({ tf, direction: dir, tp: top ? Number(top.tp) : null, maxProb: Math.round(Math.max(pb, pr)) });
    }

    // multi-TF weighted fusion
    const TF_WEIGHTS = Object.assign({ "1m":0.05, "5m":0.10, "15m":0.40, "30m":0.20, "1h":0.25 }, opts.tfWeights || {});
    let fusedSum = 0, wsum = 0;
    for (const tf of CONFIG.fusedTFs) {
      const entry = perTfSnapshots.find(x=>x.tf===tf);
      if (!entry) continue;
      const s = entry.direction === "Bullish" ? 1 : entry.direction === "Bearish" ? -1 : 0;
      const w = TF_WEIGHTS[tf] ?? 0.1;
      fusedSum += s * w; wsum += w;
    }
    const overallFusion = wsum ? clamp(fusedSum / wsum, -1, 1) : 0;

    // main fusion
    const scoresMain = { ind: ind.score, cnn: (cnn.score || 0.5), of: ofScore, news: newsScore };
    const fusionMain = fuseScores(scoresMain, _stats.adaptiveWeights);
    const bullP_main = fusionMain.fused;
    const overallTF0to1 = (overallFusion + 1) / 2;
    const fusedProb = clamp(bullP_main * 0.55 + overallTF0to1 * 0.35 + newsScore * 0.10, 0.01, 0.99);
    const pb = Math.round(fusedProb * 10000) / 100;
    const pr = Math.round((1 - fusedProb) * 10000) / 100;
    const pn = Math.round(Math.max(0, 100 - pb - pr) * 100) / 100;
    const directionGuess = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
    const maxProb = Math.max(pb, pr, pn);

    // Build candidate TPs from fusedTFs + primary + ATR
    let combinedCandidates = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      if (!c || c.length < 6) continue;
      try {
        const ell = await analyzeElliott(c);
        if (ell && Array.isArray(ell.targets) && ell.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ell));
      } catch (e) {}
    }
    try {
      const ellP = await analyzeElliott(candles);
      if (ellP && Array.isArray(ellP.targets) && ellP.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ellP));
    } catch (e) {}
    combinedCandidates.push(...buildATRFallbackTPs(price, feats?.atr));
    combinedCandidates = dedupeAndSortCandidates(combinedCandidates, price);

    // precision decision
    const decisionFeatures = buildDecisionFeaturesForPrecision(feats, newsObj, fusedProb);
    const prec = getMLDirectionPrecision(decisionFeatures);
    const chosen = chooseStablePrimaryHedge(combinedCandidates, prec.direction === "Neutral" ? directionGuess : prec.direction, price, feats, {
      MIN_TP_DISTANCE_ATR_MULT: CONFIG.MIN_TP_DISTANCE_ATR_MULT,
      MIN_TP_DISTANCE: Math.max(feats?.atr || 0, Math.abs(price) * 0.0005) * CONFIG.MIN_TP_DISTANCE_ATR_MULT
    });

    const slEstimate = pickSLForPrimary(prec.direction === "Neutral" ? directionGuess : prec.direction, price, feats);
    const tpConfidence = Math.round(Math.min(100, ((chosen.confidence || 40) * 0.45) + (prec.confidence * 0.35) + (maxProb * 0.15) + 5));
    const perTfClean = perTfSnapshots.map(p => ({ tf: p.tf, direction: p.direction, tp: p.tp ? Number(p.tp) : null, maxProb: p.maxProb }));

    const mlObj = {
      modelVersion: "ml_v12_precision_pro",
      symbol, tf: tfc, generatedAt: nowISO(),
      direction: (prec.direction === "Neutral" ? directionGuess : prec.direction),
      probs: { bull: pb, bear: pr, neutral: pn }, maxProb,
      tpEstimate: Number(chosen.primary),
      tpSource: chosen.primarySource || "composite",
      tpConfidence,
      hedgeTP: Number(chosen.hedge),
      hedgeSource: chosen.hedgeSource || "composite",
      slEstimate: Number(slEstimate),
      perTf: perTfClean,
      adaptiveWeights: _stats.adaptiveWeights,
      raw: { fusionMain: Math.round(fusionMain.fused * 10000) / 10000, overallTF: Math.round(overallFusion * 10000) / 10000, newsScore, precisionCore: prec }
    };

    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores: scoresMain, fusedProb } });

    return mlObj;

  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e), symbol, tf: tfc };
  }
}

// ---------- Micro predictor ----------
export async function runMicroPrediction(symbol="BTCUSDT", tfc="1m") {
  try {
    const now = Date.now();
    if (now - _lastCall < DEFAULT_THROTTLE_MS) await sleep(DEFAULT_THROTTLE_MS - (now - _lastCall));
    _lastCall = Date.now();

    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = Array.isArray(mtf[tfc]?.data) ? mtf[tfc].data : [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_v12_precision_pro-micro", label: "Neutral", prob: 33.33, reason: "insufficient" };
    const f = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(f);
    const cnn = await cnnLayer(candles);
    const of = orderFlowScore(f?.of || {});
    const scores = { ind: ind.score, cnn: cnn.score || 0.5, of, news: 0.5 };
    const fused = fuseScores(scores, _stats.adaptiveWeights);
    const probBull = Math.round(fused.fused * 10000) / 100;
    const probBear = Math.round((1 - fused.fused) * 10000) / 100;
    const label = probBull > probBear ? "Bullish" : probBear > probBull ? "Bearish" : "Neutral";
    return { modelVersion: "ml_v12_precision_pro-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn.score, of } };
  } catch (e) { return { error: (e && e.message) ? e.message : String(e), label: "Neutral" }; }
}

// ---------- training adaptor ----------
export async function trainAdaptive(batch=[]) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok: false, message: "no data" };
    for (const b of batch) {
      const trueVal = b.trueLabel === "Bullish" ? 1 : (b.trueLabel === "Bearish" ? 0 : 0.5);
      const err = trueVal - (b.fusedProb || 0.5);
      const lr = _stats.adaptiveWeights.lr || 0.02;
      const contrib = b.breakdown || { ind:0.5, cnn:0.5, of:0.5, news:0.5 };
      _stats.adaptiveWeights.w_ind = clamp(_stats.adaptiveWeights.w_ind + lr * err * (contrib.ind - 0.5), 0.05, 0.8);
      _stats.adaptiveWeights.w_cnn = clamp(_stats.adaptiveWeights.w_cnn + lr * err * (contrib.cnn - 0.5), 0.05, 0.6);
      _stats.adaptiveWeights.w_of = clamp(_stats.adaptiveWeights.w_of + lr * err * (contrib.of - 0.5), 0.05, 0.6);
      _stats.adaptiveWeights.w_news = clamp(_stats.adaptiveWeights.w_news + lr * err * (contrib.news - 0.5), 0.01, 0.3);
      const s = _stats.adaptiveWeights.w_ind + _stats.adaptiveWeights.w_cnn + _stats.adaptiveWeights.w_of + _stats.adaptiveWeights.w_news;
      _stats.adaptiveWeights.w_ind /= s; _stats.adaptiveWeights.w_cnn /= s; _stats.adaptiveWeights.w_of /= s; _stats.adaptiveWeights.w_news /= s;
    }
    writeJsonSafe(STATS_FILE, _stats);
    return { ok: true, weights: _stats.adaptiveWeights };
  } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
}

// ---------- FUSION helpers (exported for TG integration) ----------
export function fuseMLTFs(mlList = []) {
  const WEIGHTS = { "15m": 0.40, "30m": 0.35, "1h": 0.25 };
  const available = mlList.filter(m => m && m.tf);
  if (!available.length) return null;
  let bullScore=0, bearScore=0, neutralScore=0;
  const tps = [];
  for (const m of available) {
    const w = WEIGHTS[m.tf] ?? 0.2;
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0));
    const dir = (m.direction || m.label || "Neutral");
    if (String(dir).toLowerCase().includes("bull")) bullScore += (maxProb/100) * w;
    else if (String(dir).toLowerCase().includes("bear")) bearScore += (maxProb/100) * w;
    else neutralScore += (maxProb/100) * w;
    tps.push({ tf: m.tf, tp: Number(m.tpEstimate ?? m.tp ?? 0), hedge: Number(m.hedgeTP ?? m.hedge ?? 0), tpConfidence: Number(m.tpConfidence ?? m.tpConfidence ?? (m.tpConfidence ?? 0)), maxProb });
  }
  const finalDir = (bullScore > bearScore && bullScore > neutralScore) ? "Bullish" : (bearScore > bullScore && bearScore > neutralScore) ? "Bearish" : "Neutral";
  let wSum=0, tpSum=0, hedgeSum=0, confSum=0;
  for (const t of tps) {
    const w = WEIGHTS[t.tf] ?? 0.2;
    const mdir = (() => {
      const m = available.find(x => x.tf === t.tf);
      if (!m) return "Neutral";
      const d = m.direction || m.label || "Neutral";
      return String(d).toLowerCase().includes("bull") ? "Bullish" : String(d).toLowerCase().includes("bear") ? "Bearish" : "Neutral";
    })();
    let includeWeight = w;
    if (finalDir === "Bullish" && mdir === "Bearish" && t.maxProb > 60) includeWeight *= 0.15;
    if (finalDir === "Bearish" && mdir === "Bullish" && t.maxProb > 60) includeWeight *= 0.15;
    if (isNum(t.tp) && t.tp > 0) { tpSum += t.tp * includeWeight; wSum += includeWeight; }
    if (isNum(t.hedge) && t.hedge > 0) { hedgeSum += t.hedge * includeWeight; confSum += (t.tpConfidence || t.maxProb) * includeWeight; }
  }
  const primaryTP = (wSum > 0) ? (tpSum / wSum) : (tps[0] ? tps[0].tp : null);
  const hedgeTP = (confSum > 0) ? (hedgeSum / wSum) : (tps[0] ? tps[0].hedge : null);
  const avgConfidence = (wSum > 0) ? (confSum / wSum) : (available.reduce((a,b)=>a + (b.maxProb||0),0) / available.length || 0);
  return { direction: finalDir, primaryTP: isNum(primaryTP) ? Number(primaryTP) : null, hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null, confidence: Math.round(clamp(avgConfidence,0,100)) };
}

export function buildStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  const sorted = (Array.isArray(clusterTargets) ? clusterTargets.slice() : []).sort((a,b) => b.confidence - a.confidence);
  const dir = mlFusion?.direction || "Neutral";
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  let primary=null, hedge=null;
  if (sorted.length) {
    const bulls = sorted.filter(s => s.tp > price);
    const bears = sorted.filter(s => s.tp < price);
    if (dir === "Bullish") primary = (bulls.length ? bulls[0] : sorted[0]);
    else if (dir === "Bearish") primary = (bears.length ? bears[0] : sorted[0]);
    else primary = sorted[0];
    if (dir === "Bullish") hedge = (bears.length ? bears[0] : (mlFusion?.hedgeTP ? { tp: mlFusion.hedgeTP, source: "ML" } : { tp: price - atr * 1.2, source: "HEDGE_ATR" }));
    else if (dir === "Bearish") hedge = (bulls.length ? bulls[0] : (mlFusion?.hedgeTP ? { tp: mlFusion.hedgeTP, source: "ML" } : { tp: price + atr * 1.2, source: "HEDGE_ATR" }));
    else { primary = primary || sorted[0]; hedge = (sorted.length > 1 ? sorted[1] : { tp: (primary.tp > price ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR" }); }
  } else {
    if (mlFusion && isNum(mlFusion.primaryTP)) {
      primary = { tp: mlFusion.primaryTP, source: "ML", confidence: mlFusion.confidence };
      hedge = isNum(mlFusion.hedgeTP) ? { tp: mlFusion.hedgeTP, source: "ML", confidence: mlFusion.confidence } : { tp: (dir === "Bullish" ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence: 30 };
    } else {
      primary = { tp: (dir === "Bullish" ? price + atr * 2.5 : dir === "Bearish" ? price - atr * 2.5 : price + atr * 2.5), source: "ATR", confidence: 30 };
      hedge = { tp: (dir === "Bullish" ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence: 30 };
    }
  }
  const primaryTP = Number(primary.tp);
  const hedgeTP = Number(hedge.tp);
  const primarySource = primary.source || "Cluster";
  const hedgeSource = hedge.source || "Cluster";
  const primaryConf = Math.round(primary.confidence ?? mlFusion?.confidence ?? 40);
  return { primaryTP, hedgeTP, primarySource, hedgeSource, primaryConf, direction: dir };
}

// ---------- Pro Meters (exported) ----------
// Rebound probability, Trend exhaustion, Vol crush, 30-min pressure
// Inputs: snapshot object or explicit arrays

function wickRatio(candles, lookback=6){
  if(!Array.isArray(candles) || candles.length===0) return 1;
  const lastN = candles.slice(-Math.min(lookback, candles.length));
  const r = lastN.map(c => {
    const body = Math.max(Math.abs(c.close - c.open), 1e-8);
    const lower = (Math.min(c.open, c.close) - c.low);
    const upper = (c.high - Math.max(c.open, c.close));
    return (lower + 1e-8) / body;
  });
  return mean(r);
}
function emaDistancePct(candles, period=20){
  if(!Array.isArray(candles) || candles.length < period) return 0;
  const len = candles.length;
  const alpha = 2/(period+1);
  let ema = candles[0].close;
  for(let i=1;i<len;i++){ ema = alpha * candles[i].close + (1-alpha) * ema; }
  const lastClose = candles[len-1].close;
  return (lastClose - ema)/Math.max(EPS, ema);
}
function rsiSimple(candles, period=14){
  if(!Array.isArray(candles) || candles.length < period+1) return 50;
  let gains=0, losses=0;
  for(let i=candles.length-period;i<candles.length;i++){
    const d = candles[i].close - candles[i-1].close;
    if(d>0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains/period, avgL = losses/period;
  if(avgG+avgL === 0) return 50;
  const rs = avgG / Math.max(EPS, avgL);
  return 100 - (100 / (1 + rs));
}
function atrCalc(candles, period=14){
  if(!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for(let i=1;i<candles.length;i++){
    const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close;
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  return mean(trs.slice(-period));
}

export function computeReboundProbability({candles1m=[], candles5m=[], candles15m=[], orderbook=null, tickerPrice=null, news=null}){
  let score = 30;
  const rsi1 = rsiSimple(candles1m,7), rsi5 = rsiSimple(candles5m,14), rsi15 = rsiSimple(candles15m,14);
  if(rsi1 < 30) score += 18;
  if(rsi5 < 30) score += 22;
  if(rsi15 < 35) score += 10;
  const wr1 = wickRatio(candles1m,6), wr5 = wickRatio(candles5m,6);
  if(wr1 > 1.6) score += 12;
  if(wr5 > 1.4) score += 8;
  const ed15 = emaDistancePct(candles15m,20);
  if(ed15 < -0.012) score += clamp(Math.abs(ed15)*1000,0,12);
  const volSpike = (() => {
    if(!Array.isArray(candles1m) || candles1m.length < 6) return false;
    const last = candles1m.slice(-6);
    const avg = mean(last.slice(0,4).map(c=>c.volume||0));
    const tail = last.slice(-2);
    return (mean(tail.map(c=>c.volume||0)) > avg * 1.8);
  })();
  if(volSpike) score += 12;
  if(orderbook && orderbook.bids && orderbook.asks){
    const topBidSize = (orderbook.bids[0] && orderbook.bids[0].size) || 0;
    const topAskSize = (orderbook.asks[0] && orderbook.asks[0].size) || 0;
    if(topBidSize > topAskSize * 2.5 && topBidSize > 100) score += 10;
  }
  if(news && typeof news.sentiment === 'number'){
    if(news.sentiment >= 0.65) score -= 8;
    if(news.sentiment <= 0.35) score += 6;
  }
  return { reboundProb: Math.round(clamp(score,0,100)), breakdown: { rsi1, rsi5, rsi15, wr1, wr5, ed15, volSpike } };
}

export function computeTrendExhaustion({candles15m=[], candles30m=[]}){
  let score = 0;
  function slope(c){ if(!Array.isArray(c) || c.length < 4) return 0; const l = c.slice(-6); let s=0; for(let i=1;i<l.length;i++){ s += l[i].close - l[i-1].close; } return s / Math.max(1, l.length-1); }
  const sl15 = slope(candles15m), sl30 = slope(candles30m);
  const atr15 = atrCalc(candles15m,14), atr30 = atrCalc(candles30m,14);
  const atrDrop15 = (() => {
    if(!Array.isArray(candles15m) || candles15m.length < 30) return false;
    const left = atrCalc(candles15m.slice(0, -10), 14);
    return atr15 < left * 0.85;
  })();
  const rsi15 = rsiSimple(candles15m,14);
  const llPrice = (candles15m && candles15m.slice(-3).map(c=>c.close).sort((a,b)=>a-b)[0]) || 0;
  const priorLow = (candles15m && candles15m.slice(-10, -6).map(c=>c.close).sort((a,b)=>a-b)[0]) || 0;
  const rsiDivergence = (llPrice < priorLow && rsi15 > rsiSimple(candles15m.slice(-10, -6), 14));
  if(Math.abs(sl15) < Math.max(1, Math.abs(sl30)*0.6)) score += 18;
  if(atrDrop15) score += 20;
  if(rsiDivergence) score += 30;
  const volTaper = (() => {
    if(!Array.isArray(candles15m) || candles15m.length < 20) return false;
    const last8 = candles15m.slice(-8);
    const left = candles15m.slice(-20, -8);
    if(!left.length) return false;
    return mean(last8.map(c=>c.volume||0)) < mean(left.map(c=>c.volume||0)) * 0.85;
  })();
  if(volTaper) score += 12;
  return { exhaustionPct: Math.round(clamp(score,0,100)), breakdown: { sl15, sl30, atr15, atr30, atrDrop15, rsi15, rsiDivergence, volTaper } };
}

export function computeVolatilityCrush({candles30m=[], candles15m=[]}) {
  const atrNow = atrCalc(candles30m,14);
  const atrPrev = (() => {
    if(!Array.isArray(candles30m) || candles30m.length < 40) return atrNow;
    return atrCalc(candles30m.slice(0, -10), 14);
  })();
  const atrDropPct = atrPrev > 0 ? (atrPrev - atrNow)/atrPrev : 0;
  const bodySizes = (candles15m || []).slice(-8).map(c => Math.abs(c.close - c.open) || 0);
  const bodyNow = mean(bodySizes);
  const bodyPrev = (candles15m && candles15m.length > 20) ? mean(candles15m.slice(-28, -8).map(c=>Math.abs(c.close - c.open)||0)) : bodyNow;
  const bodyShrink = bodyPrev > 0 ? (bodyPrev - bodyNow)/Math.max(EPS, bodyPrev) : 0;
  const squeeze = atrDropPct > 0.15 && bodyShrink > 0.25;
  const score = Math.round(clamp((atrDropPct*100)*0.6 + (bodyShrink*100)*0.4, 0, 100));
  return { volCrush: squeeze ? score : Math.round(score*0.4), breakdown: { atrNow, atrPrev, atrDropPct, bodyNow, bodyPrev, bodyShrink, squeeze } };
}

export function compute30minPressure({candles1m=[], candles5m=[], candles30m=[], orderflow=null, orderbook=null}) {
  const recent1 = (candles1m||[]).slice(-30);
  const recent5 = (candles5m||[]).slice(-12);
  function sideVolume(arr) {
    let buy=0, sell=0;
    for(const c of arr){
      const delta = (c.close - c.open) * (c.volume||0);
      if(delta >= 0) buy += Math.abs(delta); else sell += Math.abs(delta);
    }
    return { buy, sell, total: buy+sell };
  }
  const v1 = sideVolume(recent1), v5 = sideVolume(recent5);
  const buyRatio1 = v1.total ? v1.buy / v1.total : 0.5;
  const buyRatio5 = v5.total ? v5.buy / v5.total : 0.5;
  let cvdScore = 0;
  if(orderflow && typeof orderflow.cvd === 'number') cvdScore = clamp(orderflow.cvd / 100000, -1, 1);
  const emaShort = (() => { if(!Array.isArray(candles5m) || candles5m.length < 10) return 0; return mean(candles5m.slice(-10).map(c=>c.close)); })();
  const emaLong = (() => { if(!Array.isArray(candles30m) || candles30m.length < 6) return emaShort; return mean(candles30m.slice(-6).map(c=>c.close)); })();
  const emaAlignBear = emaShort < emaLong ? 1 : 0;
  let obPressure = 0;
  if(orderbook && orderbook.bids && orderbook.asks){
    const bidSum = orderbook.bids.slice(0,10).reduce((a,b)=>a + (b.size||0),0);
    const askSum = orderbook.asks.slice(0,10).reduce((a,b)=>a + (b.size||0),0);
    obPressure = bidSum > askSum ? - (askSum/bidSum) : (bidSum/askSum);
    obPressure = clamp(obPressure, -3, 3);
  }
  let sellPct = 50;
  if(buyRatio1 < 0.45) sellPct += (0.5 - buyRatio1) * 100 * 0.7;
  if(buyRatio5 < 0.48) sellPct += (0.5 - buyRatio5) * 100 * 0.4;
  sellPct += clamp(-cvdScore * 30, -30, 30);
  if(emaAlignBear) sellPct += 8;
  sellPct += clamp(obPressure * 3, -20, 20);
  const final = Math.round(clamp(sellPct, 0, 100));
  return { sellPressurePct: final, buyRatio1, buyRatio5, cvdScore, emaAlignBear, obPressure, breakdown: { v1, v5 } };
}

// ---------- Convenience report builder (so tg_commands can import this module directly) ----------
export async function buildAIReport(symbol="BTCUSDT", opts={}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : (candles.length ? (candleVisionHeuristic(candles).features.rsi || 50) : 50),
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : (candles.length ? atrCalc(candles) : 0),
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p => p.type === "L") || null;
          const lastHigh = [...pivots].reverse().find(p => p.type === "H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null };
        } catch { return { support: null, resistance: null, confidence: null }; }
      })();
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 };
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0,w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh / atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0); w += 0.15;
      s += (indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0); w += 0.08;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w === 0) return 0;
      return Number(clamp(s / w, -1, 1).toFixed(3));
    };

    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });
    let sTotal=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += (b.fusionScore || 0) * w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal / ws, -1, 1).toFixed(3)) : 0;

    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets || [])) {
        const tp = Number(t.tp || 0); if (!isNum(tp) || tp <= 0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence || 0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b) => b.confidence - a.confidence);
    const price = blocks.find(x => x.tf === "15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0,4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0,4);

    const mlTFs = ["15m","30m","1h"];
    const mlResults = [];
    for (const mt of mlTFs) {
      try { const mlr = await runMLPrediction(symbol, mt); if (mlr) mlResults.push(mlr); } catch (e) {}
    }

    let micro1m = null, micro5m = null;
    try { micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    const mlFusion = fuseMLTFs(mlResults);
    const feat15 = blocks.find(b => b.tf === "15m") ? { atr: blocks.find(b => b.tf === "15m").indicators.ATR, candles: blocks.find(b => b.tf === "15m").candles } : {};
    const stableTargets = buildStableTargets(allTargets, mlFusion, price, feat15);

    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);

    overallFusion = clamp(overallFusion + (mlFusion?.confidence ? (mlFusion.confidence/100) * 0.18 : 0) + newsBoost * 0.12, -1, 1);

    const biasLabel = (() => {
      if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
      if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
      if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
      return { emoji:"🟥", label:"Strong Sell" };
    })();

    let mlAccObj = { accuracy:0, total:0, correct:0 };
    try { mlAccObj = calculateAccuracy() || mlAccObj; } catch (e) {}

    const atr15 = blocks.find(x => x.tf === "15m")?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    return {
      ok: true, symbol, generatedAt: nowISO(), nowIST: (new Date()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      blocks, price, atr15, overallFusion, biasLabel, longs, shorts, allTargets,
      ml: { perTF: mlResults, fusion: mlFusion }, micro: { "1m": micro1m, "5m": micro5m },
      stableTargets, mlAcc: mlAccObj, news, buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)), defaultSLLong, defaultSLShort
    };

  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// ---------- Default export ----------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
  markOutcome, getStats, trainAdaptive, resetStats,
  computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
  fuseMLTFs, buildStableTargets, buildAIReport
};
export default defaultExport;