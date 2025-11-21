// ml_module_v15.js
// ML v15 — Single-file, drop-in replacement for v12 exports
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
// markOutcome, getStats, trainAdaptive, resetStats,
// computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
// fuseMLTFs, buildStableTargets, buildAIReport
//
// Node ESM file. Relies on ./utils.js (fetchMultiTF), ./elliott_module.js (analyzeElliott), ./news_social.js (optional)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async () => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// --- Persistence (like v12) ---
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v15_logs");
const PRED_FILE = path.join(LOG_DIR, "predictions_v15.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes_v15.json");
const STATS_FILE = path.join(LOG_DIR, "stats_v15.json");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const readJsonSafe = (f, fallback = []) => {
  try { if (!fs.existsSync(f)) return fallback; const s = fs.readFileSync(f,"utf8"); return JSON.parse(s||"[]"); } catch (e) { return fallback; }
};
const writeJsonSafe = (f, obj) => {
  try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
};

// --- small helpers ---
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

// --- Stats memory ---
let _stats = {
  total:0, wins:0, losses:0, accuracyCache: null,
  adaptiveWeights: { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1, lr:0.02 },
  alerts: [], lastUpdated: null
};
try {
  const raw = readJsonSafe(STATS_FILE, null);
  if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw);
} catch (e) {}

// --- record / accuracy functions (v12-compatible) ---
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    writeJsonSafe(PRED_FILE, arr);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id || null, symbol: pred.symbol || pred?.ml?.symbol || null, ts: new Date().toISOString(), meta: pred.meta || pred.ml || null });
    if (_stats.alerts.length > 3000) _stats.alerts.shift();
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
  } catch(e) {}
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    writeJsonSafe(OUT_FILE, arr);
    _stats.total = (_stats.total||0)+1;
    if (outcome.success) _stats.wins = (_stats.wins||0)+1; else _stats.losses = (_stats.losses||0)+1;
    _stats.accuracyCache = null;
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
  } catch(e) {}
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
    const correct = outs.filter(o=>o && o.success).length || 0;
    const acc = Math.round((correct/total)*10000)/100;
    const res = { accuracy: acc, total, correct };
    _stats.accuracyCache = res;
    return res;
  } catch (e) { return { accuracy:0, total:0, correct:0 }; }
}

export function markOutcome(symbol, alertId, success = true, trueLabel = null) {
  try {
    recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() });
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

export function getStats() {
  return { ..._stats, accuracy: calculateAccuracy() };
}
export function resetStats() {
  _stats = { total:0, wins:0, losses:0, accuracyCache:null, adaptiveWeights:{ w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1, lr:0.02 }, alerts: [], lastUpdated: null };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// ---------------- Features & small engines (improved v15) ----------------
function candleVisionHeuristic(candles, lookback=8) {
  if (!Array.isArray(candles) || candles.length === 0) return { label:"Neutral", probs:{ bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c => c.close > c.open).length;
  const down = last.filter(c => c.close < c.open).length;
  const momentum = (last.at(-1).close - last[0].close)/Math.max(EPS, last[0].close);
  let score = 0.5 + clamp(momentum * 4, -0.45, 0.45);
  score = clamp(score, 0.01, 0.99);
  const bull = Math.round(score*10000)/100;
  const bear = Math.round((1-score)*10000)/100;
  const label = bull>bear ? "Bullish" : bear>bull ? "Bearish" : "Neutral";
  return { label, probs:{ bull, bear, neutral: Math.round(Math.max(0,100-bull-bear)*100)/100 }, score, features:{ momentum, up, down } };
}

function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const closes = candles.map(c => Number(c.close||0));
  const last = candles[n-1];
  const close = Number(last.close || 0);
  const len = Math.min(20, n);
  let xmean=0,ymean=0;
  for (let i=0;i<len;i++){ xmean += i; ymean += closes[n-len+i]; }
  xmean /= len; ymean /= len;
  let num=0,den=0;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den===0 ? 0 : num/den;
  const trs = [];
  for (let i=1;i<n;i++) {
    const h = Number(candles[i].high||0), l = Number(candles[i].low||0), pc = Number(candles[i-1].close||0);
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  const atr = trs.length ? mean(trs.slice(-14)) : 0;
  const mom3 = n>=4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const vols = candles.map(c=>Number(c.volume||0)); const avgVol = mean(vols.slice(-20));
  let gains=0,losses=0;
  for (let i=Math.max(1,n-14); i<n; i++) { const d = closes[i]-closes[i-1]; if (d>0) gains+=d; else losses += Math.abs(d); }
  const avgGain = gains/14 || 0, avgLoss = losses/14 || 0;
  const rsi = (avgGain+avgLoss) ? 100 - (100/(1 + avgGain/Math.max(EPS, avgLoss))) : 50;
  const of = (() => {
    if (n < 2) return {};
    const lastVol = Number(last.volume||0);
    const prev = candles[n-2];
    const delta = (last.close - last.open) * (last.volume || 1);
    const vel = last.close - prev.close;
    return { delta, vel, lastVol, avgVol, swingHigh: Math.max(...candles.slice(-8).map(c=>c.high)), swingLow: Math.min(...candles.slice(-8).map(c=>c.low)) };
  })();
  return { close, slope, mom3, atr, rsi, avgVol, lastVol: (last.volume||0), of, candles };
}

function indicatorLayer(feats) {
  if (!feats) return { score:0.5, details:{} };
  let s = 0.5;
  s += clamp(Math.tanh((feats.slope||0)/Math.max(1, Math.abs(feats.close||1))) * 0.5, -0.25, 0.25);
  s += clamp((Math.tanh((feats.mom3||0)*6) || 0) * 0.25, -0.2, 0.2);
  if (isNum(feats.rsi)) { const rn = clamp((feats.rsi - 50)/50, -1, 1); s += rn * 0.15; }
  if (feats.avgVol && feats.lastVol) s += clamp((feats.lastVol/Math.max(EPS, feats.avgVol) - 1) * 0.05, -0.05, 0.05);
  s = clamp(s, 0.01, 0.99);
  return { score: s, details: { slope: feats.slope, mom3: feats.mom3, rsi: feats.rsi } };
}

async function cnnLayer(candles) {
  const cv = candleVisionHeuristic(candles, 8);
  const score = (cv.score || 0.5);
  return { score, probs: cv.probs, features: cv.features };
}

function orderFlowScore(of) {
  if (!of) return 0.5;
  let s = 0.5;
  if (isNum(of.delta)) s += clamp(Math.tanh(of.delta/Math.max(1, of.avgVol||1)) * 0.2, -0.2, 0.2);
  if (isNum(of.vel)) s += clamp(Math.tanh(of.vel/Math.max(1, (of.avgVol||1)/100)) * 0.15, -0.15, 0.15);
  return clamp(s, 0.01, 0.99);
}

function fuseScores(scores, weights) {
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind ?? 0.5, 0, 1);
  const cnn = clamp(scores.cnn ?? 0.5, 0, 1);
  const of = clamp(scores.of ?? 0.5, 0, 1);
  const news = clamp(scores.news ?? 0.5, 0, 1);
  const fused = ind*(w.w_ind||0.45) + cnn*(w.w_cnn||0.25) + of*(w.w_of||0.2) + news*(w.w_news||0.1);
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
  } catch(e) {}
}

// --- TP/SL helpers (improved v15) ---
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
function chooseStablePrimaryHedge(candidates, dir, price, feats, config={}) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  const MIN_MULT = config.MIN_TP_DISTANCE_ATR_MULT ?? 1.2;
  const minDist = config.MIN_TP_DISTANCE ?? atr * MIN_MULT;
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
  const hed = opp || { tp: Number((price + (dir === "Bullish" ? -atr * 1.2 : atr * 1.2)).toFixed(8)), source: "HEDGE_ATR", confidence: 30 };
  const pconf = Math.round(Math.min(100, (primary.confidence || 40) * 0.6 + 40));
  return { primary: Number(primary.tp), hedge: Number(hed.tp), primarySource: primary.source||"CAND", hedgeSource: hed.source||"CAND", confidence: pconf };
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

// ---------------- Precision core (improved decision)
function buildDecisionFeaturesForPrecision(featsPrimary, newsObj, systemProb) {
  const slope = featsPrimary.slope || 0;
  const mom3 = featsPrimary.mom3 || 0;
  const rsi = featsPrimary.rsi || 50;
  const vol = (featsPrimary.lastVol || 0) - (featsPrimary.avgVol || 0);
  const atrNorm = featsPrimary.atr ? (featsPrimary.atr / Math.max(EPS, Math.abs(featsPrimary.close || 1))) : 0.001;
  const newsImpact = (newsObj && newsObj.impact) ? String(newsObj.impact).toLowerCase() : "low";
  const sentiment = (newsObj && typeof newsObj.sentiment === "number") ? (newsObj.sentiment * 100) : 50;
  return { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb: systemProb || 0.5, candles: featsPrimary.candles || [] };
}
function getMLDirectionPrecision(features) {
  const { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb } = features;
  const momStrength = mom3 * (rsi / 50);
  const slopeSign = Math.sign(slope || 0);
  const slopeMag = Math.abs(slope || 0);
  const smoothedSlope = (slope * 0.55) + (slopeSign * Math.sqrt(slopeMag) * 0.25) + (slope * atrNorm * 0.20);
  const sentAdj = (sentiment - 50) / 50;
  const newsMultiplier = (newsImpact === "high") ? 1.6 : (newsImpact === "moderate") ? 1.0 : 0.4;
  const S_slope = clamp(smoothedSlope * 0.45, -5, 5);
  const S_mom = clamp(momStrength * 0.33, -4, 4);
  const S_rsi = clamp((rsi - 50) * 0.06, -3, 3);
  const S_news = clamp(sentAdj * 1.2 * newsMultiplier, -3, 3);
  const S_vol = clamp(Math.sign(vol) * Math.min(1, Math.abs(vol) / Math.max(1, Math.abs(vol) || 1)) * 0.4, -1, 1);
  const S_system = (systemProb - 0.5) * 2 * 1.1;
  const raw = S_slope + S_mom + S_rsi + S_news + S_vol + S_system;
  const probBull = 1 / (1 + Math.exp(-raw / 3.5));
  const confidence = Math.round(probBull * 100);
  const direction = (confidence >= 60) ? "Bullish" : (confidence <= 40) ? "Bearish" : "Neutral";
  return { direction, confidence: confidence, probBull: Math.round(probBull*10000)/100 };
}

// ---------------- Utilities: pro-meters (v15) ----------------
export function computeReboundProbability(symbol, blocks) {
  // simple heuristic: if short-term oversold + buy pressure rising -> rebound
  try {
    const b1 = (blocks||[]).find(b=>b.tf==="1m");
    const b5 = (blocks||[]).find(b=>b.tf==="5m");
    const rsi1 = b1?.indicators?.RSI ?? 50;
    const rsi5 = b5?.indicators?.RSI ?? 50;
    let base = 20;
    if (rsi1 < 30) base += 30;
    if (rsi5 < 35) base += 20;
    const volUp = (b1?.indicators?.volumeTrend==="INCREASING") ? 10 : 0;
    return clamp(base + volUp, 0, 100);
  } catch(e) { return 0; }
}

export function computeTrendExhaustion(symbol, blocks) {
  try {
    const b15 = (blocks||[]).find(b=>b.tf==="15m");
    const macd = b15?.indicators?.MACD?.hist ?? 0;
    const atr = Math.max(1, b15?.indicators?.ATR ?? 1);
    const exhaustion = clamp(Math.max(0, Math.min(100, Math.round((Math.abs(macd)/atr) * 5))), 0, 100);
    return exhaustion;
  } catch(e) { return 0; }
}

export function computeVolatilityCrush(symbol, blocks) {
  try {
    const vols = (blocks||[]).map(b => Number(b.indicators?.ATR || 0));
    if (!vols.length) return 0;
    const ratio = vols[vols.length-1] / Math.max(EPS, mean(vols));
    return Math.round(clamp((1 - Math.min(ratio,2))*100, 0, 100));
  } catch(e) { return 0; }
}

export function compute30minPressure(symbol, blocks) {
  try {
    // crude: use 1m & 5m buy ratios and compute pressure
    const b1 = (blocks||[]).find(b=>b.tf==="1m");
    const b5 = (blocks||[]).find(b=>b.tf==="5m");
    const buy1 = (b1 && b1.indicators && b1.indicators.priceTrend==="UP") ? 0.6 : 0.4;
    const buy5 = (b5 && b5.indicators && b5.indicators.priceTrend==="UP") ? 0.6 : 0.4;
    const sellPressurePct = Math.round((1 - ((buy1 + buy5) / 2)) * 100);
    return { sellPressurePct, buyRatio1: buy1, buyRatio5: buy5, cvdScore:0, emaAlignBear:0, obPressure:0 };
  } catch(e) { return { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0 }; }
}

// ----------------- fuseMLTFs (v15 robust) -----------------
export function fuseMLTFs(mlList = []) {
  // Accept array of objects or object keyed by tf
  const arr = Array.isArray(mlList) ? mlList.filter(Boolean) : Object.values(mlList || {}).filter(Boolean);
  if (!arr.length) return null;
  // weights: prefer higher TFs (15m:0.4 30m:0.35 1h:0.25)
  const WEIGHTS = { "1m":0.03, "5m":0.07, "15m":0.40, "30m":0.30, "1h":0.20 };
  let bull=0,bear=0,neutral=0,confSum=0,wSum=0;
  const tps = [];
  for (const m of arr) {
    const tf = m.tf || m.tfc || m.tfName || "15m";
    const w = WEIGHTS[tf] ?? 0.1;
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0));
    const dir = String(m.direction || m.label || "Neutral").toLowerCase();
    if (dir.includes("bull")) bull += (maxProb/100)*w;
    else if (dir.includes("bear")) bear += (maxProb/100)*w;
    else neutral += (maxProb/100)*w;
    if (isNum(m.tpEstimate) && m.tpEstimate > 0) tps.push({ tf, tp: Number(m.tpEstimate), hedge: Number(m.hedgeTP||m.hedge||0), tpConfidence: Number(m.tpConfidence||m.tpConfidence||maxProb), maxProb });
    confSum += (maxProb || 0) * w;
    wSum += w;
  }
  const direction = (bull > bear && bull > neutral) ? "Bullish" : (bear > bull && bear > neutral) ? "Bearish" : "Neutral";
  const avgConf = wSum ? Math.round(clamp(confSum / wSum, 0, 100)) : 0;
  // pick average tp (weighted)
  let tpSum=0, tpW=0, hedgeSum=0, hedgeW=0;
  for (const t of tps) {
    const w = WEIGHTS[t.tf] ?? 0.1;
    if (isNum(t.tp) && t.tp>0) { tpSum += t.tp * w; tpW += w; }
    if (isNum(t.hedge) && t.hedge>0) { hedgeSum += t.hedge * w; hedgeW += w; }
  }
  const primaryTP = tpW ? tpSum/tpW : (tps[0]?.tp || null);
  const hedgeTP = hedgeW ? hedgeSum/hedgeW : (tps[0]?.hedge || null);
  return { direction, confidence: avgConf, primaryTP: isNum(primaryTP)?Number(primaryTP):null, hedgeTP: isNum(hedgeTP)?Number(hedgeTP):null, details:{ tps } };
}

// ----------------- buildStableTargets (v15) -----------------
export function buildStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  // If ML provides buildStableTargets (compatibility) use it — otherwise local logic
  // clusterTargets: array of {tp,confidence,source}
  // mlFusion: { direction, primaryTP, hedgeTP, confidence }
  // Ensure primary/hedge on opposite sides when possible
  const dir = (mlFusion && mlFusion.direction) ? String(mlFusion.direction) : "Neutral";
  const sorted = Array.isArray(clusterTargets) ? clusterTargets.slice().sort((a,b)=> (b.confidence||0)-(a.confidence||0)) : [];
  const priceNum = Number(price || 0);
  const atr = Math.max(feats?.atr || 0, Math.abs(priceNum) * 0.0005 || 1);

  // try cluster candidates
  if (sorted.length) {
    const bulls = sorted.filter(s => s.tp > priceNum);
    const bears = sorted.filter(s => s.tp < priceNum);
    let primary = null, hedge = null;
    if (dir.toLowerCase().includes("bull")) primary = (bulls.length ? bulls[0] : sorted[0]);
    else if (dir.toLowerCase().includes("bear")) primary = (bears.length ? bears[0] : sorted[0]);
    else primary = sorted[0];
    if (dir.toLowerCase().includes("bull")) hedge = (bears.length ? bears[0] : { tp: priceNum - atr*1.2, source:"HEDGE_ATR" });
    else if (dir.toLowerCase().includes("bear")) hedge = (bulls.length ? bulls[0] : { tp: priceNum + atr*1.2, source:"HEDGE_ATR" });
    else hedge = (sorted.length>1 ? sorted[1] : { tp: primary.tp>priceNum? priceNum - atr*1.2 : priceNum + atr*1.2, source:"HEDGE_ATR" });
    return {
      primaryTP: Number(primary.tp),
      hedgeTP: Number(hedge.tp),
      primarySource: primary.source || "Cluster",
      hedgeSource: hedge.source || "Cluster",
      primaryConf: Math.round(primary.confidence ?? (mlFusion?.confidence ?? 40)),
      direction: dir
    };
  }

  // fallback to ML suggested or ATR
  if (mlFusion && (isNum(mlFusion.primaryTP) || isNum(mlFusion.hedgeTP))) {
    const p = isNum(mlFusion.primaryTP) ? Number(mlFusion.primaryTP) : (dir.toLowerCase().includes("bull") ? priceNum + atr*2.5 : priceNum - atr*2.5);
    const h = isNum(mlFusion.hedgeTP) ? Number(mlFusion.hedgeTP) : (dir.toLowerCase().includes("bull") ? priceNum - atr*1.2 : priceNum + atr*1.2);
    // ensure opposite sides
    if (p === h) {
      const shift = Math.max(priceNum*0.002, atr);
      return { primaryTP: p, hedgeTP: (p>priceNum? priceNum - shift : priceNum + shift), primarySource: "ML", hedgeSource: "ML_ADJ", primaryConf: Math.round(mlFusion.confidence ?? 50), direction: dir };
    }
    return { primaryTP: p, hedgeTP: h, primarySource: "ML", hedgeSource: "ML", primaryConf: Math.round(mlFusion.confidence ?? 50), direction: dir };
  }

  // last fallback: ATR
  const p = priceNum + atr*2.5;
  const h = priceNum - atr*1.2;
  return { primaryTP: Number(p), hedgeTP: Number(h), primarySource: "ATR", hedgeSource: "HEDGE_ATR", primaryConf: 30, direction: dir };
}

// ----------------- runMLPrediction (v15) -----------------
export async function runMLPrediction(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    const DEFAULT_CONFIG = {
      fusedTFs: ["15m","30m","1h"],
      MIN_TP_DISTANCE_ATR_MULT: 1.2
    };
    const CONFIG = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    const tfsToFetch = Array.from(new Set([tfc, ...CONFIG.fusedTFs, "1m", "5m"])).slice(0, 12);
    const mtfRaw = await fetchMultiTF(symbol, tfsToFetch);
    const primaryRaw = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = primaryRaw.data || [];
    const price = isNum(primaryRaw.price) && primaryRaw.price > 0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_module_v15",
        symbol, tf: tfc, direction: "Neutral",
        probs: { bull:33.33, bear:33.33, neutral:33.33 }, maxProb:33.33,
        tpEstimate: null, tpSource: null, tpConfidence: 0, slEstimate: null, perTf:[]
      };
    }

    // features
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment, 0, 1) : 0.5;

    // per-TF snapshots for fusion
    const perTfSnapshots = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = raw.data || [];
      const p = isNum(raw.price) && raw.price > 0 ? raw.price : (c?.at(-1)?.close ?? price);
      if (!c || c.length < 6) { perTfSnapshots.push({ tf, direction:"Neutral", tp:null, maxProb:33 }); continue; }
      const f = buildFeaturesFromCandles(c);
      const indL = indicatorLayer(f);
      const cnnL = await cnnLayer(c);
      const ofL = orderFlowScore(f?.of || {});
      const scores = { ind: indL.score, cnn: (cnnL.score||0.5), of: ofL, news: newsScore };
      const fused = fuseScores(scores, _stats.adaptiveWeights);
      const bullP = fused.fused;
      const pb = Math.round(bullP*10000)/100;
      const pr = Math.round((1-bullP)*10000)/100;
      const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
      // candidate TP from ell or ATR fallback
      let ell = null;
      try { ell = await analyzeElliott(c); } catch(e){}
      let candidates = buildCandidateTPsFromElliott(ell);
      if (!candidates.length) candidates = buildATRFallbackTPs(p, f?.atr);
      candidates = dedupeAndSortCandidates(candidates, p);
      const top = candidates[0] || null;
      perTfSnapshots.push({ tf, direction: dir, tp: top ? Number(top.tp) : null, maxProb: Math.round(Math.max(pb, pr)) });
    }

    // multi-TF weighted fusion (prefer 15m/30m/1h)
    const TF_WEIGHTS = Object.assign({ "1m":0.03, "5m":0.07, "15m":0.40, "30m":0.30, "1h":0.20 }, opts.tfWeights || {});
    let fusedSum=0, wsum=0;
    for (const tf of CONFIG.fusedTFs) {
      const e = perTfSnapshots.find(x=>x.tf===tf);
      if (!e) continue;
      const s = e.direction === "Bullish" ? 1 : e.direction === "Bearish" ? -1 : 0;
      const w = TF_WEIGHTS[tf] ?? 0.1;
      fusedSum += s * w; wsum += w;
    }
    const overallFusion = wsum ? clamp(fusedSum/wsum, -1, 1) : 0;

    // main fusion
    const scoresMain = { ind: ind.score, cnn: (cnn.score||0.5), of: ofScore, news: newsScore };
    const fusionMain = fuseScores(scoresMain, _stats.adaptiveWeights);
    const bullP_main = fusionMain.fused;

    const overallTF0to1 = (overallFusion + 1)/2;
    const fusedProb = clamp(bullP_main*0.55 + overallTF0to1*0.35 + newsScore*0.10, 0.01, 0.99);
    const pb = Math.round(fusedProb*10000)/100;
    const pr = Math.round((1-fusedProb)*10000)/100;
    const pn = Math.round(Math.max(0,100 - pb - pr) * 100)/100;
    const directionGuess = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
    const maxProb = Math.max(pb, pr, pn);

    // combined candidate TPs: gather ell targets across fusedTFs + primary + ATR fallback
    let combinedCandidates = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 }; const c = raw.data || [];
      if (!c || c.length < 6) continue;
      try { const ell = await analyzeElliott(c); if (ell && Array.isArray(ell.targets) && ell.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ell)); } catch(e){}
    }
    try { const ellP = await analyzeElliott(candles); if (ellP && Array.isArray(ellP.targets) && ellP.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ellP)); } catch(e){}
    combinedCandidates.push(...buildATRFallbackTPs(price, feats?.atr));
    combinedCandidates = dedupeAndSortCandidates(combinedCandidates, price);

    // precision core decision
    const decisionFeatures = buildDecisionFeaturesForPrecision(feats, newsObj, fusedProb);
    const prec = getMLDirectionPrecision(decisionFeatures);
    const chosen = chooseStablePrimaryHedge(combinedCandidates, (prec.direction==="Neutral"?directionGuess:prec.direction), price, feats, { MIN_TP_DISTANCE_ATR_MULT: CONFIG.MIN_TP_DISTANCE_ATR_MULT });

    const slEstimate = pickSLForPrimary((prec.direction==="Neutral"?directionGuess:prec.direction), price, feats);
    const tpConfidence = Math.round(Math.min(100, ((chosen.confidence||40)*0.45) + (prec.confidence*0.35) + (maxProb*0.15) + 5));

    const perTfClean = perTfSnapshots.map(p => ({ tf: p.tf, direction: p.direction, tp: p.tp?Number(p.tp):null, maxProb: p.maxProb }));

    const mlObj = {
      modelVersion: "ml_module_v15",
      symbol, tf: tfc, generatedAt: new Date().toISOString(),
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
      raw: { fusionMain: Math.round(fusionMain.fused*10000)/10000, overallTF: Math.round(overallFusion*10000)/10000, newsScore, precisionCore: prec }
    };

    // record
    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores: scoresMain, fusedProb } });

    return mlObj;
  } catch (e) {
    return { error: e?.toString?.() ?? String(e), symbol, tf: tfc };
  }
}

// ----------------- runMicroPrediction (v15) -----------------
export async function runMicroPrediction(symbol="BTCUSDT", tfc="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = mtf[tfc]?.data || [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_module_v15-micro", label: "Neutral", prob:33.33, reason:"insufficient" };
    const f = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(f);
    const cnn = await cnnLayer(candles);
    const of = orderFlowScore(f?.of || {});
    const scores = { ind: ind.score, cnn: cnn.score || 0.5, of, news: 0.5 };
    const fused = fuseScores(scores, _stats.adaptiveWeights);
    const probBull = Math.round(fused.fused * 10000)/100;
    const probBear = Math.round((1 - fused.fused) * 10000)/100;
    const label = probBull > probBear ? "Bullish" : probBear > probBull ? "Bearish" : "Neutral";
    return { modelVersion: "ml_module_v15-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn.score, of } };
  } catch (e) { return { error: e?.toString?.() ?? String(e), label:"Neutral" }; }
}

// ----------------- buildAIReport convenience (v15) -----------------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = {
        RSI: (() => {
          const f = buildFeaturesFromCandles(candles);
          return f?.rsi ?? 50;
        })(),
        MACD: { hist: 0 },
        ATR: (() => { const f = buildFeaturesFromCandles(candles); return f?.atr ?? 0; })(),
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: "STABLE"
      };
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch(e){ ell = null; }
      const ellSummary = { support: ell?.pivots?.filter(p=>p.type==="L").at(-1)?.price ?? null, resistance: ell?.pivots?.filter(p=>p.type==="H").at(-1)?.price ?? null, confidence: ell?.confidence ?? 0 };
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp>0);
      } else {
        const fallbackAtr = Math.max(ind.ATR||0, price*0.002 || 1);
        targets = [{ tp: Number((price + fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_UP" }, { tp: Number((price - fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_DOWN" }];
      }
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // compute fusionScores quick
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0,w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50)/50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh/atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0); w += 0.15;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w===0) return 0;
      return Number(clamp(s/w, -1, 1).toFixed(3));
    };
    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    const TF_WEIGHTS = { "1m":0.03, "5m":0.07, "15m":0.40, "30m":0.30, "1h":0.20 };
    let sTotal=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += (b.fusionScore||0)*w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal/ws, -1, 1).toFixed(3)) : 0;

    // collect targets
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets||[])) {
        const tp = Number(t.tp||0); if (!isNum(tp) || tp<=0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence||0)) tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=> b.confidence - a.confidence);
    const priceRef = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t=>t.tp>priceRef).slice(0,4);
    const shorts = allTargets.filter(t=>t.tp<priceRef).slice(0,4);

    // run ML per stable TFs (non-blocking best-effort)
    const stableTFs = ["15m","30m","1h"];
    const mlPerTF = [];
    for (const mt of stableTFs) {
      try { const mlr = await runMLPrediction(symbol, mt); if (mlr) mlPerTF.push(mlr); } catch(e){}
    }
    let micro1m=null,micro5m=null;
    try { micro1m = await runMicroPrediction(symbol,"1m"); } catch(e){}
    try { micro5m = await runMicroPrediction(symbol,"5m"); } catch(e){}

    // fuse ML TFs
    let mlFusion = null;
    try { mlFusion = fuseMLTFs(mlPerTF); } catch(e){ mlFusion = null; }
    if (mlFusion && isNum(mlFusion.confidence)) overallFusion = clamp(overallFusion + (mlFusion.confidence/100)*0.18, -1, 1);

    // news
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch(e){ news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5)*2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);
    overallFusion = clamp(overallFusion + newsBoost*0.12, -1, 1);

    const feat15 = blocks.find(b=>b.tf==="15m") ? { atr: blocks.find(b=>b.tf==="15m").indicators.ATR, candles: blocks.find(b=>b.tf==="15m").candles } : {};
    const stableTargets = buildStableTargets(allTargets, mlFusion || {}, priceRef, feat15);

    // pro meters computed via our helpers
    const proMeters = {
      rebound: { reboundProb: computeReboundProbability(symbol, blocks) },
      exhaustion: { exhaustionPct: computeTrendExhaustion(symbol, blocks) },
      volCrush: { volCrush: computeVolatilityCrush(symbol, blocks) },
      pressure: compute30minPressure(symbol, blocks)
    };

    const mlAccObj = calculateAccuracy() || { accuracy:0 };

    const report = {
      ok:true, symbol, generatedAt: new Date().toISOString(), nowIST: new Date().toISOString(),
      blocks, price: priceRef, overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs, shorts, allTargets,
      ml: { perTF: mlPerTF, fusion: mlFusion },
      micro: { "1m": micro1m, "5m": micro5m },
      stableTargets, proMeters, mlAcc: mlAccObj, news,
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2))
    };
    return report;
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ----------------- default export (v15) -----------------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
  markOutcome, getStats, trainAdaptive, resetStats,
  computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
  fuseMLTFs, buildStableTargets, buildAIReport
};
export default defaultExport;