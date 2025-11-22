// ml_module_v15_1.js
// ML v15.1 PRO — merged, deduped, aggregator + trainer + meters
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
// markOutcome, getStats, trainAdaptive, resetStats, manualTrain (helper),
// computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
// fuseMLTFs, buildStableTargets, buildAIReport, aggregateAndScoreTPs, finalizePrimaryHedgeFromScored
//
// Requires: ./utils.js export fetchMultiTF, ./elliott_module.js export analyzeElliott, optional ./news_social.js

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";             // required by your system
import { analyzeElliott } from "./elliott_module.js";  // required by your system
import News from "./news_social.js";                   // optional (safe fallback provided)

// Safe news accessor
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// ---------- Persistence ----------
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v15_1_logs");
const PRED_FILE = path.join(LOG_DIR, "predictions_v15_1.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes_v15_1.json");
const STATS_FILE = path.join(LOG_DIR, "stats_v15_1.json");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(e){}

const readJsonSafe = (f, fallback = null) => {
  try { if (!fs.existsSync(f)) return fallback; const s = fs.readFileSync(f, "utf8"); return JSON.parse(s || "null"); } catch (e) { return fallback; }
};
const writeJsonSafe = (f, obj) => {
  try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
};

// ---------- Helpers ----------
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a=-Infinity, b=Infinity) => Math.max(a, Math.min(b, v));
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0;

// ---------- Stats / Adaptive Weights ----------
let _stats = {
  total:0, wins:0, losses:0,
  accuracyCache: null,
  adaptiveWeights: { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1, lr:0.02 },
  alerts: [],
  lastUpdated: null,
  adaptiveTrainMeta: {}
};
try {
  const raw = readJsonSafe(STATS_FILE, null);
  if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw);
} catch(e){}

// ---------- Persistence helpers ----------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []) || [];
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    writeJsonSafe(PRED_FILE, arr);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id || null, symbol: pred.symbol || pred?.ml?.symbol || null, ts: new Date().toISOString(), meta: pred.meta || pred.ml || null });
    if (_stats.alerts.length > 3000) _stats.alerts.shift();
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []) || [];
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    writeJsonSafe(OUT_FILE, arr);
    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1; else _stats.losses = (_stats.losses || 0) + 1;
    _stats.accuracyCache = null;
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function calculateAccuracy() {
  try {
    if (_stats.accuracyCache) return _stats.accuracyCache;
    const outs = readJsonSafe(OUT_FILE, []) || [];
    const total = outs.length || (_stats.total || 0);
    if (!total) {
      const res = { accuracy:0, total:0, correct:0 };
      _stats.accuracyCache = res;
      return res;
    }
    const correct = outs.filter(o => o && o.success).length || 0;
    const acc = Math.round((correct / total) * 10000) / 100;
    const res = { accuracy: acc, total, correct };
    _stats.accuracyCache = res;
    return res;
  } catch (e) { return { accuracy:0, total:0, correct:0 }; }
}

export function markOutcome(symbol, alertId, success=true, trueLabel=null) {
  try {
    recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() });
    if (typeof trueLabel === "string") {
      const preds = readJsonSafe(PRED_FILE, []) || [];
      const p = preds.find(px => px.id === alertId);
      if (p && p.meta && p.meta.scores) {
        const fused = fuseScores(p.meta.scores, _stats.adaptiveWeights);
        updateAdaptiveWeights(trueLabel, fused.fused, { breakdown: fused.breakdown });
        writeJsonSafe(STATS_FILE, _stats);
      }
    }
    return true;
  } catch(e) { return false; }
}

export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc };
}

export function resetStats() {
  _stats = { total:0, wins:0, losses:0, accuracyCache:null, adaptiveWeights: { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1,lr:0.02 }, alerts:[], lastUpdated:null, adaptiveTrainMeta:{} };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// ---------- Adaptive fusion helpers ----------
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
  } catch(e){}
}

// ---------- Candle/Feature builders ----------
function candleVisionHeuristic(candles, lookback=8) {
  if (!Array.isArray(candles) || candles.length === 0) return { label:"Neutral", probs:{ bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c=>c.close>c.open).length;
  const down = last.filter(c=>c.close<c.open).length;
  const momentum = (last.at(-1).close - last[0].close) / Math.max(EPS, last[0].close || 1);
  let score = 0.5 + clamp(momentum*5, -0.45, 0.45);
  const lc = last.at(-1);
  const body = Math.abs(lc.close - lc.open) || 1;
  const upper = lc.high - Math.max(lc.open, lc.close);
  const lower = Math.min(lc.open, lc.close) - lc.low;
  if (lower > body * 1.6 && upper < body * 0.6) score += 0.12;
  if (upper > body * 1.6 && lower < body * 0.6) score -= 0.12;
  score = clamp(score, 0.01, 0.99);
  const bull = Math.round(score * 10000)/100;
  const bear = Math.round((1-score) * 10000)/100;
  const label = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";
  return { label, probs: { bull, bear, neutral: Math.round(100 - bull - bear) }, score, features: { momentum, up, down } };
}

function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const closes = candles.map(c=>Number(c.close||0));
  const last = candles[n-1];
  const close = Number(last.close||0);
  const len = Math.min(20, n);
  let xmean=0,ymean=0;
  for (let i=0;i<len;i++){ xmean+=i; ymean+=closes[n-len+i]; }
  xmean /= len; ymean /= len;
  let num=0, den=0;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den === 0 ? 0 : num/den;
  const trs = [];
  for (let i=1;i<n;i++){
    const h=Number(candles[i].high||0), l=Number(candles[i].low||0), pc=Number(candles[i-1].close||0);
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  const atr = trs.length ? mean(trs.slice(-14)) : 0;
  const mom3 = n>=4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const vols = candles.map(c=>Number(c.volume||0));
  const avgVol = mean(vols.slice(-20));
  let gains=0, losses=0;
  for (let i=Math.max(1,n-14); i<n; i++){ const d = closes[i]-closes[i-1]; if (d>0) gains+=d; else losses+=Math.abs(d); }
  const avgGain = gains/14 || 0; const avgLoss = losses/14 || 0;
  const rsi = (avgGain+avgLoss) ? 100 - (100 / (1 + avgGain/Math.max(EPS, avgLoss))) : 50;
  const of = (() => {
    if (n<2) return {};
    const lastVol = Number(last.volume||0);
    const prev = candles[n-2];
    const delta = (last.close - last.open) * (last.volume || 1);
    const vel = last.close - prev.close;
    return { delta, vel, lastVol, avgVol, swingHigh: Math.max(...candles.slice(-8).map(c=>c.high)), swingLow: Math.min(...candles.slice(-8).map(c=>c.low)) };
  })();
  return { close, slope, mom3, atr, rsi, avgVol, lastVol:(last.volume||0), of, candles };
}

// ---------- Indicator / CNN / orderflow ----------
function indicatorLayer(feats) {
  if (!feats) return { score:0.5, details:{} };
  const { slope, mom3, rsi, avgVol, lastVol } = feats;
  let s = 0.5;
  s += clamp(Math.tanh(slope / Math.max(1, Math.abs(feats.close||1))) * 0.5, -0.25, 0.25);
  s += clamp((Math.tanh(mom3 * 6) || 0) * 0.25, -0.2, 0.2);
  if (isNum(rsi)) { const rn = clamp((rsi - 50) / 50, -1, 1); s += rn * 0.15; }
  if (avgVol && lastVol) s += clamp((lastVol / Math.max(EPS, avgVol) - 1) * 0.05, -0.05, 0.05);
  s = clamp(s, 0.01, 0.99);
  return { score: s, details: { slope, mom3, rsi } };
}
async function cnnLayer(candles) { const cv = candleVisionHeuristic(candles,8); return { score: (cv.score||0.5), probs: cv.probs, features: cv.features }; }
function orderFlowScore(of) {
  if (!of) return 0.5;
  let s = 0.5;
  if (isNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, of.avgVol || 1)) * 0.2, -0.2, 0.2);
  if (isNum(of.vel)) s += clamp(Math.tanh(of.vel / Math.max(1, (of.avgVol || 1)/100)) * 0.15, -0.15, 0.15);
  return clamp(s, 0.01, 0.99);
}

// ---------- TP helpers ----------
function buildCandidateTPsFromElliott(ell) {
  if (!ell || !Array.isArray(ell.targets)) return [];
  const out = [];
  for (const t of ell.targets) {
    const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
    if (!isNum(tp) || tp <= 0) continue;
    out.push({ tp, source: t.source || t.type || "elliott", confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), raw: t });
  }
  return out;
}
function buildATRFallbackTPs(price, atr) {
  const _atr = Math.max(atr || 0, Math.abs(price) * 0.0005, 1);
  return [
    { tp: Number((price + _atr * 2.5).toFixed(8)), source: "ATR_UP", confidence: 30 },
    { tp: Number((price - _atr * 2.5).toFixed(8)), source: "ATR_DOWN", confidence: 30 }
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

// ---------- Aggregator: cluster + scoring (robust, single implementation) ----------
/*
  clusterTPCandidates(perTFCandidates, { precision })
  scoreTPCluster(cluster, price, feats, tfWeights)
  aggregateAndScoreTPs(perTFCandidates, price, feats, opts)
  finalizePrimaryHedgeFromScored(scored, direction, price, feats, config)
*/

export function clusterTPCandidates(perTFCandidates = [], opts = {}) {
  const PREC = (opts.precision !== undefined) ? Math.max(0, Number(opts.precision)) : 0;
  if (!Array.isArray(perTFCandidates) || !perTFCandidates.length) return [];
  // bucket by rounded value (precision param controls rounding digits)
  const map = new Map();
  for (const c of perTFCandidates) {
    const val = Number(c.tp || 0);
    if (!isNum(val) || val <= 0) continue;
    const k = PREC ? Number(val.toFixed(PREC)) : Math.round(val);
    const cur = map.get(k) || { center: k, members: [], sources: new Set(), tfCount: {} };
    cur.members.push(c);
    cur.sources.add(c.source || c.tf || "unknown");
    cur.tfCount[c.tf || (c.raw && c.raw.tf) || "unknown"] = (cur.tfCount[c.tf || (c.raw && c.raw.tf) || "unknown"] || 0) + 1;
    map.set(k, cur);
  }
  // build clusters array
  const clusters = Array.from(map.values()).map(cl => {
    // compute aggregated stats
    const members = cl.members;
    const confAvg = Math.round(mean(members.map(m => clamp(Number(m.confidence||40),0,100))) || 40);
    const weightCount = members.length;
    return { center: cl.center, members, confAvg, weightCount, sources: Array.from(cl.sources), tfCount: cl.tfCount };
  });
  // sort by weight then confidence
  clusters.sort((a,b) => (b.weightCount - a.weightCount) || (b.confAvg - a.confAvg) || (Math.abs(a.center - (opts.price||0)) - Math.abs(b.center - (opts.price||0))));
  return clusters;
}

export function scoreTPCluster(cluster = {}, price = 0, feats = {}, tfWeights = {}) {
  // cluster: { center, members, confAvg, weightCount, sources }
  const center = Number(cluster.center || 0);
  const conf = clamp(Number(cluster.confAvg || 40), 0, 100);
  const count = cluster.weightCount || (Array.isArray(cluster.members) ? cluster.members.length : 1);
  // distance score: closer TP to price gets slightly better (but we will also respect minDist later)
  const dist = Math.abs(center - price);
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  const distanceScore = clamp(1 - (dist / Math.max(atr*10, Math.abs(price) * 0.02, 1)), 0, 1); // normalized
  // tfWeight: measure member TF composition vs provided weights
  let tfWeight = 0.5;
  if (cluster.tfCount && typeof tfWeights === "object" && Object.keys(tfWeights).length) {
    let s = 0, wsum = 0;
    for (const [tf, n] of Object.entries(cluster.tfCount)) {
      const w = tfWeights[tf] ?? 0.1;
      s += n * w; wsum += n * w;
    }
    tfWeight = wsum ? clamp(s / wsum, 0.01, 1) : 0.5;
  } else {
    tfWeight = clamp(0.5 + (count>1?0.1:0), 0.1, 1);
  }
  // proximityBoost: reward clusters that are not wastefully far (moderate)
  const proximityBoost = distanceScore > 0.6 ? 1.1 : distanceScore > 0.3 ? 1.05 : 0.95;
  // ellBoost: if majority of members come from ell or high-confidence sources, boost
  const ellCount = cluster.members ? cluster.members.filter(m => (m.source||"").toLowerCase().includes("elli")).length : 0;
  const ellBoost = 1 + clamp((ellCount / Math.max(1, count)) * 0.25, 0, 0.35);
  // final score: combine normalized elements (0..1 scaled to 0..100)
  const raw = (conf/100) * 0.6 + distanceScore * 0.15 + tfWeight * 0.15;
  const boosted = raw * proximityBoost * ellBoost;
  const score = Math.round(clamp(boosted, 0, 1) * 100);
  return { center, score, conf, count, distanceScore: Math.round(distanceScore*100), tfWeight: Math.round(tfWeight*100), proximityBoost: Math.round((proximityBoost)*100), ellBoost: Math.round((ellBoost)*100) };
}

export function aggregateAndScoreTPs(perTFCandidates = [], price = 0, feats = {}, opts = {}) {
  // perTFCandidates: array of candidate objects (from multiple TFs)
  // returns list of prioritized tp objects [{ tp, score, cluster, meta }]
  const PREC = opts.precision || 0;
  const tfWeights = opts.tfWeights || { "15m":0.4, "30m":0.25, "1h":0.25 };
  // cluster
  const clusters = clusterTPCandidates(perTFCandidates, { precision: PREC, price });
  const out = [];
  for (const cl of clusters) {
    const sc = scoreTPCluster(cl, price, feats, tfWeights);
    out.push({ tp: Number(cl.center), score: sc.score, meta: sc, cluster: cl });
  }
  // Sort by score desc, then proximity to price
  out.sort((a,b) => (b.score - a.score) || (Math.abs(a.tp - price) - Math.abs(b.tp - price)));
  // mark recommended top N
  const topN = Number(opts.top || 3);
  for (let i=0;i<out.length;i++) out[i].recommended = i < topN;
  return out;
}

// finalize primary/hedge TP from scored list (solid single function, used by main predict)
export function finalizePrimaryHedgeFromScored(scored = [], direction = "Neutral", price = 0, feats = {}, config = {}) {
  try {
    const MIN_DIST_MULT = config.MIN_TP_DISTANCE_ATR_MULT || 1.2;
    const atr = Math.max((feats && feats.atr) ? feats.atr : Math.abs(price) * 0.001, 1);
    const minDist = (config.MIN_TP_DISTANCE || (atr * MIN_DIST_MULT));
    const pool = (scored || []).filter(s => Math.abs(s.tp - price) >= minDist);
    const chosen = pool.length ? pool[0] : (scored[0] || null);
    if (!chosen) {
      // fallback ATR-based
      const primary = direction === "Bullish" ? price + atr * 2.5 : direction === "Bearish" ? price - atr * 2.5 : price + atr * 2.5;
      const hedge = direction === "Bullish" ? price - atr * 1.2 : direction === "Bearish" ? price + atr * 1.2 : price - atr * 1.2;
      return { primary: Number(primary), hedge: Number(hedge), primarySource: "ATR_FALLBACK", hedgeSource: "ATR_HEDGE", primaryConf: 40 };
    }
    // choose hedge: nearest opposite-side cluster or ATR
    let opp = (scored || []).find(s => (direction === "Bullish" ? s.tp < price : s.tp > price));
    if (!opp) {
      opp = { tp: Number((price + (direction === "Bullish" ? -atr * 1.2 : atr * 1.2)).toFixed(8)), source: "HEDGE_ATR", score: 30 };
    }
    return { primary: Number(chosen.tp), hedge: Number(opp.tp), primarySource: chosen.meta?.source || chosen.cluster?.members?.[0]?.source || "cluster", hedgeSource: opp.cluster?.members?.[0]?.source || opp.source || "cluster", primaryConf: chosen.score || 40 };
  } catch(e) {
    const atr = Math.max((feats && feats.atr) ? feats.atr : Math.abs(price) * 0.001, 1);
    return { primary: Number(price + atr * 2), hedge: Number(price - atr * 1.2), primarySource: "ERR_FALLBACK", hedgeSource: "ERR_HEDGE", primaryConf: 40 };
  }
}

// ---------- Precision decision core ----------
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
  const S_vol = clamp(Math.sign(vol) * Math.min(1, Math.abs(vol) / Math.max(1, Math.abs(vol)||1)) * 0.4, -1, 1);
  const S_system = (systemProb - 0.5) * 2 * 1.1;
  const raw = S_slope + S_mom + S_rsi + S_news + S_vol + S_system;
  const probBull = 1 / (1 + Math.exp(-raw / 3.5));
  const confidence = Math.round(probBull * 100);
  const direction = (confidence >= 60) ? "Bullish" : (confidence <= 40) ? "Bearish" : "Neutral";
  return { direction, confidence, probBull: Math.round(probBull * 10000)/100 };
}

// ---------- Core ML outputs ----------
export async function runMLPrediction(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    const DEFAULT_CONFIG = { fusedTFs:["15m","30m","1h"], MIN_TP_DISTANCE_ATR_MULT:1.2, MAX_PER_TF_SNAPS:1 };
    const CONFIG = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    const tfsToFetch = Array.from(new Set([tfc, ...CONFIG.fusedTFs, "1m","5m","30m","1h"])).slice(0,12);
    const mtfRaw = await fetchMultiTF(symbol, tfsToFetch).catch(()=> ({}));
    const primaryRaw = mtfRaw[tfc] || { data:[], price:0 };
    const candles = Array.isArray(primaryRaw.data) ? primaryRaw.data : [];
    const price = isNum(primaryRaw.price) && primaryRaw.price>0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return { modelVersion:"ml_module_v15_1", symbol, tf:tfc, direction:"Neutral", probs:{ bull:33.33, bear:33.33, neutral:33.33 }, maxProb:33.33, tpEstimate:null, tpSource:null, tpConfidence:0, slEstimate:null, perTf:[] };
    }

    // primary features
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment, 0, 1) : 0.5;

    // per-TF snapshots
    const perTfSnapshots = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data:[], price:0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      const p = isNum(raw.price) && raw.price>0 ? raw.price : (c?.at(-1)?.close ?? price);
      if (!c || c.length < 6) { perTfSnapshots.push({ tf, direction:"Neutral", tp:null, maxProb:33 }); continue; }
      const f = buildFeaturesFromCandles(c);
      const indL = indicatorLayer(f);
      const cnnL = await cnnLayer(c);
      const ofL = orderFlowScore(f?.of || {});
      const scores = { ind: indL.score, cnn: cnnL.score || 0.5, of: ofL, news: newsScore };
      const fused = fuseScores(scores, _stats.adaptiveWeights);
      const bullP = fused.fused;
      const pb = Math.round(bullP*10000)/100;
      const pr = Math.round((1-bullP)*10000)/100;
      const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
      let ell = null;
      try { ell = await analyzeElliott(c); } catch(e) { ell = null; }
      let candidates = buildCandidateTPsFromElliott(ell);
      if (!candidates.length) candidates = buildATRFallbackTPs(p, f?.atr);
      candidates = dedupeAndSortCandidates(candidates, p);
      const top = candidates[0] || null;
      perTfSnapshots.push({ tf, direction:dir, tp: top ? Number(top.tp) : null, maxProb: Math.round(Math.max(pb, pr)), candidates });
    }

    // multi-TF fusion
    const TF_WEIGHTS = Object.assign({ "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 }, opts.tfWeights || {});
    let fusedSum=0, wsum=0;
    for (const tf of CONFIG.fusedTFs) {
      const entry = perTfSnapshots.find(x=>x.tf===tf);
      if (!entry) continue;
      const s = entry.direction === "Bullish" ? 1 : entry.direction === "Bearish" ? -1 : 0;
      const w = TF_WEIGHTS[tf] ?? 0.1;
      fusedSum += s * w; wsum += w;
    }
    const overallFusion = wsum ? clamp(fusedSum/wsum, -1, 1) : 0;

    // fuse main layers
    const scoresMain = { ind: ind.score, cnn: cnn.score || 0.5, of: ofScore, news: newsScore };
    const fusionMain = fuseScores(scoresMain, _stats.adaptiveWeights);
    const bullP_main = fusionMain.fused;

    const overallTF0to1 = (overallFusion + 1)/2;
    const fusedProb = clamp(bullP_main * 0.55 + overallTF0to1 * 0.35 + newsScore * 0.10, 0.01, 0.99);
    const pb = Math.round(fusedProb * 10000)/100;
    const pr = Math.round((1-fusedProb) * 10000)/100;
    const pn = Math.round(Math.max(0, 100 - pb - pr) * 100)/100;
    const directionGuess = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
    const maxProb = Math.max(pb, pr, pn);

    // combined TP candidates (ell across fusedTFs + primary + ATR)
    let combinedCandidates = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data:[], price:0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      if (!c || c.length < 6) continue;
      try { const ell = await analyzeElliott(c); if (ell && Array.isArray(ell.targets) && ell.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ell).map(x=>({ ...x, tf })) ); } catch(e){}
    }
    try { const ellP = await analyzeElliott(candles); if (ellP && Array.isArray(ellP.targets) && ellP.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ellP).map(x=>({ ...x, tf: tfc }))); } catch(e){}
    // add ATR fallback
    combinedCandidates.push(...buildATRFallbackTPs(price, feats?.atr).map(x => ({ ...x, tf: tfc })));
    combinedCandidates = dedupeAndSortCandidates(combinedCandidates, price);

    // aggregate & score clusters
    const scoredList = aggregateAndScoreTPs(combinedCandidates, price, feats, { precision: 0, tfWeights: TF_WEIGHTS, top: 4 });

    // precision core decision
    const decisionFeatures = buildDecisionFeaturesForPrecision(feats, newsObj, fusedProb);
    const prec = getMLDirectionPrecision(decisionFeatures);

    const chosen = finalizePrimaryHedgeFromScored(scoredList, prec.direction === "Neutral" ? directionGuess : prec.direction, price, feats, { MIN_TP_DISTANCE_ATR_MULT: CONFIG.MIN_TP_DISTANCE_ATR_MULT });

    const slEstimate = pickSLForPrimary(prec.direction === "Neutral" ? directionGuess : prec.direction, price, feats);
    const tpConfidence = Math.round(Math.min(100, ((chosen.primaryConf || 40) * 0.45) + (prec.confidence * 0.35) + (maxProb * 0.15) + 5));

    const perTfClean = perTfSnapshots.map(p => ({ tf: p.tf, direction: p.direction, tp: p.tp ? Number(p.tp) : null, maxProb: p.maxProb }));

    const mlObj = {
      modelVersion: "ml_module_v15_1",
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
      scoredTPs: scoredList,
      adaptiveWeights: _stats.adaptiveWeights,
      raw: { fusionMain: Math.round(fusionMain.fused*10000)/10000, overallTF: Math.round(overallFusion*10000)/10000, newsScore, precisionCore: prec }
    };

    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores: scoresMain, fusedProb } });

    return mlObj;
  } catch (e) {
    return { error: e?.toString?.() ?? String(e), symbol, tf: tfc };
  }
}

export async function runMicroPrediction(symbol = "BTCUSDT", tfc = "1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]).catch(()=>({}));
    const candles = Array.isArray(mtf[tfc]?.data) ? mtf[tfc].data : [];
    if (!candles || candles.length < 3) return { modelVersion:"ml_module_v15_1-micro", label:"Neutral", prob:33.33, reason:"insufficient" };
    const f = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(f);
    const cnn = await cnnLayer(candles);
    const of = orderFlowScore(f?.of || {});
    const scores = { ind: ind.score, cnn: cnn.score || 0.5, of, news: 0.5 };
    const fused = fuseScores(scores, _stats.adaptiveWeights);
    const probBull = Math.round(fused.fused * 10000)/100;
    const probBear = Math.round((1 - fused.fused) * 10000)/100;
    const label = probBull > probBear ? "Bullish" : probBear > probBull ? "Bearish" : "Neutral";
    return { modelVersion:"ml_module_v15_1-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw:{ ind: ind.score, cnn: cnn.score, of } };
  } catch (e) { return { error: e?.toString?.() ?? String(e), label:"Neutral" }; }
}
// ---------- Pro meters ----------
export function computeReboundProbability(symbol, blocks = []) {
  try {
    const b15 = blocks.find(b=>b.tf==="15m");
    const b5 = blocks.find(b=>b.tf==="5m");
    const rsi15 = b15?.indicators?.RSI ?? 50;
    const rsi5 = b5?.indicators?.RSI ?? 50;
    const vol5 = (b5?.candles && b5.candles.length) ? mean(b5.candles.slice(-6).map(c=>Number(c.volume||0))) : 0;
    const vol15 = (b15?.candles && b15.candles.length) ? mean(b15.candles.slice(-6).map(c=>Number(c.volume||0))) : 0;
    let score = 40;
    if (rsi15 < 35) score += 20;
    if (rsi5 < 30) score += 15;
    if (vol5 > vol15 * 1.2) score += 15;
    return Math.round(clamp(score, 0, 100));
  } catch(e) { return 0; }
}

export function computeTrendExhaustion(symbol, blocks = []) {
  try {
    const b30 = blocks.find(b=>b.tf==="30m");
    const atr = b30?.indicators?.ATR ?? 0;
    const macd = b30?.indicators?.MACD?.hist ?? 0;
    let score = 0;
    if (Math.abs(macd) < atr * 0.2) score = 60;
    if (Math.abs(macd) < atr * 0.1) score = 80;
    return Math.round(clamp(score, 0, 100));
  } catch(e) { return 0; }
}

export function computeVolatilityCrush(symbol, blocks = []) {
  try {
    const b1 = blocks.find(b=>b.tf==="1m"), b15 = blocks.find(b=>b.tf==="15m");
    const v1 = (b1?.candles && b1.candles.length) ? mean(b1.candles.slice(-10).map(c=>Number(c.volume||0))) : 0;
    const v15 = (b15?.candles && b15.candles.length) ? mean(b15.candles.slice(-10).map(c=>Number(c.volume||0))) : 0;
    if (!v15) return 0;
    const ratio = v1 / (v15 || 1);
    const score = ratio < 0.6 ? 80 : ratio < 0.9 ? 50 : 0;
    return Math.round(clamp(score, 0, 100));
  } catch(e) { return 0; }
}

export function compute30minPressure(symbol, blocks = []) {
  try {
    const b1 = blocks.find(b=>b.tf==="1m"), b5 = blocks.find(b=>b.tf==="5m");
    const pressure = { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0, breakdown:{ v1:{buy:0,sell:0,total:0}, v5:{buy:0,sell:0,total:0} } };
    if (b1?.candles && b1.candles.length) {
      const last = b1.candles.slice(-20);
      const buy = last.filter(c=>c.close>c.open).length;
      const sell = last.filter(c=>c.close<c.open).length;
      const total = buy+sell || 1;
      pressure.sellPressurePct = Math.round((sell/total)*100);
      pressure.buyRatio1 = +(buy/total).toFixed(2);
      pressure.breakdown.v1 = { buy, sell, total };
    }
    if (b5?.candles && b5.candles.length) {
      const last = b5.candles.slice(-20);
      const buy = last.filter(c=>c.close>c.open).length;
      const sell = last.filter(c=>c.close<c.open).length;
      const total = buy+sell || 1;
      pressure.buyRatio5 = +(buy/total).toFixed(2);
      pressure.breakdown.v5 = { buy, sell, total };
    }
    return pressure;
  } catch(e) { return { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0, breakdown:{} }; }
}

// ---------- ML TF fusion helper ----------
export function fuseMLTFs(perTFArrayOrObj) {
  try {
    const perTF = Array.isArray(perTFArrayOrObj) ? perTFArrayOrObj : (typeof perTFArrayOrObj === "object" ? Object.values(perTFArrayOrObj) : []);
    if (!perTF.length) return { direction: "Neutral", score: 0, confidence: 0 };
    let bull=0, bear=0, neutral=0;
    const weights = { "15m":0.45, "30m":0.3, "1h":0.25 };
    for (const p of perTF) {
      const dir = (p.direction || p.label || "").toString().toLowerCase();
      const prob = Number(p.maxProb !== undefined ? p.maxProb : (p.probs ? Math.max(p.probs.bull || 0, p.probs.bear || 0) : 50));
      const w = weights[p.tf] ?? 0.1;
      if (dir.includes("bull")) bull += prob * w;
      else if (dir.includes("bear")) bear += prob * w;
      else neutral += prob * w;
    }
    const direction = (bull > bear && bull > neutral) ? "Bullish" : (bear > bull && bear > neutral) ? "Bearish" : "Neutral";
    const normMax = Math.max(bull, bear, neutral) || 1;
    const score = Math.round((normMax / ((bull + bear + neutral) || 1)) * 100);
    return { direction, score, confidence: score };
  } catch(e) { return { direction:"Neutral", score:0, confidence:0 }; }
}

// ---------- buildStableTargets wrapper ----------
export function buildStableTargets(clusterTargets, mlFusion, price, feats) {
  try {
    const candidates = Array.isArray(clusterTargets) ? clusterTargets.slice() : [];
    const ded = dedupeAndSortCandidates(candidates, price);
    const chosen = finalizePrimaryHedgeFromScored(ded, (mlFusion && mlFusion.direction) || "Neutral", price, feats || {}, {});
    return { primaryTP: chosen.primary, hedgeTP: chosen.hedge, primarySource: chosen.primarySource, hedgeSource: chosen.hedgeSource, primaryConf: chosen.primaryConf, direction: (mlFusion && mlFusion.direction) || "Neutral" };
  } catch(e) {
    const fallback = finalizePrimaryHedgeFromScored([], "Neutral", price, feats || {}, {});
    return { primaryTP: fallback.primary, hedgeTP: fallback.hedge, primarySource: fallback.primarySource, hedgeSource: fallback.hedgeSource, primaryConf: fallback.primaryConf, direction: "Neutral" };
  }
}

// ---------- trainAdaptive / manual training ----------
export async function trainAdaptive(batch = []) {
  try {
    if (Array.isArray(batch) && batch.length) {
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
      return { ok:true, weights: _stats.adaptiveWeights };
    } else {
      const preds = readJsonSafe(PRED_FILE, []) || [];
      const outs = readJsonSafe(OUT_FILE, []) || [];
      if (!preds.length || !outs.length) return { ok:false, message:"no data" };
      const mapOut = new Map(outs.map(o=>[o.alertId||o.id, o]));
      const train = [];
      for (const p of preds.slice(-300)) {
        const o = mapOut.get(p.id || p.alertId);
        if (!o || typeof o.success !== "boolean") continue;
        const fused = p.meta?.scores ? fuseScores(p.meta.scores, _stats.adaptiveWeights) : { fused: 0.5, breakdown:{} };
        train.push({ trueLabel: o.success ? "Bullish" : "Bearish", fusedProb: fused.fused, breakdown: fused.breakdown });
      }
      if (!train.length) return { ok:false, message:"no matched pairs" };
      return await trainAdaptive(train);
    }
  } catch(e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

// convenience manual training wrapper (helpful when calling programmatically)
export async function manualTrain(samples = []) {
  return await trainAdaptive(samples);
}

// ---------- buildAIReport convenience (calls runMLPrediction etc.) ----------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs).catch(()=> ({}));
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data:[], price:0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price>0) ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = {
        RSI: (typeof entry.RSI === "number") ? entry.RSI : (candles.length?Math.round(buildFeaturesFromCandles(candles)?.rsi||50):50),
        MACD: (entry.MACD || { hist: 0 }),
        ATR: (typeof entry.ATR === "number") ? entry.ATR : (buildFeaturesFromCandles(candles)?.atr || 0),
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: "STABLE"
      };
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch(e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p=>p.type==="L") || null;
          const lastHigh = [...pivots].reverse().find(p=>p.type==="H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null };
        } catch(e) { return { support:null, resistance:null, confidence:0 }; }
      })();
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp>0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [ { tp: Number((price + fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_UP" }, { tp: Number((price - fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_DOWN" } ];
      }
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // compute per-block fusion
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0,w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50)/50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh/atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend==="UP"?0.15:indObj?.priceTrend==="DOWN"?-0.15:0); w += 0.15;
      s += (indObj?.volumeTrend==="INCREASING"?0.08:indObj?.volumeTrend==="DECREASING"?-0.08:0); w += 0.08;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w===0) return 0;
      return Number(clamp(s/w, -1, 1).toFixed(3));
    };

    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    // overall fusion
    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 };
    let s=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore||0)*w; ws += w; }
    const overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // cluster targets across TFs
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets||[])) {
        const tp = Number(t.tp||0); if (!isNum(tp) || tp<=0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence||0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b) => b.confidence - a.confidence);
    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;

    // ML per-TF (stable TFs)
    const stableTFs = ["15m","30m","1h"];
    const mlPerTF = [];
    for (const mt of stableTFs) {
      try { const mlr = await runMLPrediction(symbol, mt); if (mlr) mlPerTF.push(mlr); } catch(e) {}
    }
    let mlFusion = fuseMLTFs ? fuseMLTFs(mlPerTF) : { direction:"Neutral", confidence:0 };

    const feat15 = blocks.find(b=>b.tf==="15m") ? { atr: blocks.find(b=>b.tf==="15m").indicators.ATR, candles: blocks.find(b=>b.tf==="15m").candles } : {};
    const stable = buildStableTargets(allTargets, mlFusion || {}, price, feat15);
    const proMeters = { rebound: computeReboundProbability(symbol, blocks), exhaustion: computeTrendExhaustion(symbol, blocks), volCrush: computeVolatilityCrush(symbol, blocks), pressure: compute30minPressure(symbol, blocks) };
    const mlAcc = calculateAccuracy();
    const news = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5 }));

    const report = {
      ok:true, symbol, generatedAt: new Date().toISOString(), nowIST: new Date().toLocaleString("en-IN", { timeZone:"Asia/Kolkata" }),
      blocks, price, overallFusion, biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs: allTargets.filter(t => t.tp > price).slice(0,4),
      shorts: allTargets.filter(t => t.tp < price).slice(0,4),
      allTargets,
      ml: { perTF: mlPerTF, fusion: mlFusion },
      stableTargets: stable,
      proMeters,
      mlAcc,
      news,
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)),
      defaultSLLong: isNum(price) ? Number((price - (feat15.atr || price*0.005) * 2).toFixed(8)) : null,
      defaultSLShort: isNum(price) ? Number((price + (feat15.atr || price*0.005) * 2).toFixed(8)) : null
    };

    return report;
  } catch(e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ---------- default export ----------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
  markOutcome, getStats, trainAdaptive, manualTrain, resetStats,
  computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
  fuseMLTFs, buildStableTargets, buildAIReport, aggregateAndScoreTPs, clusterTPCandidates, scoreTPCluster, finalizePrimaryHedgeFromScored: finalizePrimaryHedgeFromScored
};
export default defaultExport;