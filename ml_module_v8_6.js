// ml_module_v12_fixed.js
// V12 — Stable / Clean ML module (no TF dependency required)
// Exports:
// runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction,
// recordOutcome, markOutcome, getStats, trainAdaptive, resetStats

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";          // must exist in repo
import { analyzeElliott } from "./elliott_module.js"; // must exist
import News from "./news_social.js";               // optional news provider

// safe news accessor
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// -------- persistence paths --------
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v12_logs");
const PRED_FILE = path.join(LOG_DIR, "predictions_v12.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes_v12.json");
const STATS_FILE = path.join(LOG_DIR, "stats_v12.json");

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const readJsonSafe = (f, fallback = []) => {
  try { if (!fs.existsSync(f)) return fallback; const s = fs.readFileSync(f, "utf8"); return JSON.parse(s || "[]"); } catch (e) { return fallback; }
};
const writeJsonSafe = (f, obj) => {
  try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
};

// -------- simple helpers --------
const EPS = 1e-12;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const mean = (arr) => Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const nf = (v,d=2) => isNum(v) ? Number(v).toFixed(d) : "N/A";

// -------- stats memory --------
let _stats = {
  total: 0, wins: 0, losses: 0,
  accuracyCache: null,
  adaptiveWeights: { w_ind: 0.45, w_cnn: 0.25, w_of: 0.2, w_news: 0.1, lr: 0.02 },
  alerts: [],
  lastUpdated: null
};
try { const raw = readJsonSafe(STATS_FILE, null); if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw); } catch (e) {}

// -------- recording functions --------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    writeJsonSafe(PRED_FILE, arr);
    // update lightweight stats
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id, symbol: pred.symbol, ts: new Date().toISOString(), meta: pred.meta || null });
    if (_stats.alerts.length > 2000) _stats.alerts.shift();
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
  } catch (e) {}
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    writeJsonSafe(OUT_FILE, arr);
    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1; else _stats.losses = (_stats.losses || 0) + 1;
    _stats.accuracyCache = null;
    _stats.lastUpdated = new Date().toISOString();
    writeJsonSafe(STATS_FILE, _stats);
  } catch (e) {}
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

export function markOutcome(symbol, alertId, success = true, trueLabel = null) {
  try {
    recordOutcome({ alertId, symbol, success });
    if (typeof trueLabel === "string") {
      // optionally update adaptive weights (simple)
      // find prediction
      const preds = readJsonSafe(PRED_FILE, []);
      const p = preds.find(px => px.id === alertId);
      if (p && p.meta && p.meta.scores) {
        const scores = p.meta.scores;
        // fused prob compute & update
        const fused = (scores.ind * _stats.adaptiveWeights.w_ind) + (scores.cnn * _stats.adaptiveWeights.w_cnn) + (scores.of * _stats.adaptiveWeights.w_of) + ((scores.news || 0.5) * _stats.adaptiveWeights.w_news);
        const trueVal = trueLabel.toLowerCase().includes("bull") ? 1 : trueLabel.toLowerCase().includes("bear") ? 0 : 0.5;
        // tiny gradient step
        const err = trueVal - fused;
        const lr = _stats.adaptiveWeights.lr || 0.02;
        _stats.adaptiveWeights.w_ind = clamp(_stats.adaptiveWeights.w_ind + lr * err * 0.5, 0.05, 0.8);
        _stats.adaptiveWeights.w_cnn = clamp(_stats.adaptiveWeights.w_cnn + lr * err * 0.3, 0.05, 0.6);
        _stats.adaptiveWeights.w_of = clamp(_stats.adaptiveWeights.w_of + lr * err * 0.15, 0.05, 0.6);
        _stats.adaptiveWeights.w_news = clamp(_stats.adaptiveWeights.w_news + lr * err * 0.05, 0.01, 0.3);
        // renormalize
        const s = _stats.adaptiveWeights.w_ind + _stats.adaptiveWeights.w_cnn + _stats.adaptiveWeights.w_of + _stats.adaptiveWeights.w_news;
        _stats.adaptiveWeights.w_ind /= s; _stats.adaptiveWeights.w_cnn /= s; _stats.adaptiveWeights.w_of /= s; _stats.adaptiveWeights.w_news /= s;
        writeJsonSafe(STATS_FILE, _stats);
      }
    }
    return true;
  } catch (e) { return false; }
}

export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc };
}
export function resetStats() {
  _stats = { total: 0, wins: 0, losses: 0, accuracyCache: null, adaptiveWeights: { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1,lr:0.02 }, alerts: [], lastUpdated: null };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// -------- candle heuristics (deterministic fallback) --------
function candleVisionHeuristic(candles, lookback = 8) {
  if (!Array.isArray(candles) || candles.length === 0) return { label: "Neutral", probs: { bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c => c.close > c.open).length;
  const down = last.filter(c => c.close < c.open).length;
  const momentum = (last.at(-1).close - last[0].close) / Math.max(EPS, last[0].close);
  const vol = mean(last.map(c => Number(c.volume||0)));
  let score = 0.5 + clamp(momentum * 5, -0.45, 0.45);
  // wick heuristics
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

// -------- feature builder --------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const closes = candles.map(c => Number(c.close||0));
  const last = candles[n-1];
  const close = Number(last.close || 0);
  // slope via simple linear fit on last 20 or less
  const len = Math.min(20, n);
  let xmean=0, ymean=0;
  for (let i=0;i<len;i++){ xmean += i; ymean += closes[n-len+i]; }
  xmean /= len; ymean /= len;
  let num=0, den=0;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den === 0 ? 0 : num/den;
  // ATR
  const trs = [];
  for (let i=1;i<n;i++) {
    const h = Number(candles[i].high||0), l = Number(candles[i].low||0), pc = Number(candles[i-1].close||0);
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  const atr = trs.length ? mean(trs.slice(-14)) : 0;
  // momentum windows
  const mom3 = n >= 4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n-11]) / Math.max(EPS, closes[n-11]) : 0;
  const vols = candles.map(c => Number(c.volume||0));
  const avgVol = mean(vols.slice(-20));
  // rsi simple
  let gains=0, losses=0;
  for (let i=Math.max(1,n-14); i<n; i++) {
    const d = closes[i] - closes[i-1]; if (d>0) gains += d; else losses += Math.abs(d);
  }
  const avgGain = gains/14 || 0; const avgLoss = losses/14 || 0;
  const rsi = (avgGain+avgLoss) ? 100 - (100 / (1 + avgGain/Math.max(EPS, avgLoss))) : 50;
  // orderflow quick
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

// -------- indicator scoring (simple) --------
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

// -------- cnnLayer fallback (deterministic) --------
async function cnnLayer(candles) {
  // avoid heavy ML; just call candleVisionHeuristic and convert to 0..1
  const cv = candleVisionHeuristic(candles, 8);
  const score = (cv.score || 0.5);
  return { score, probs: cv.probs, features: cv.features };
}

// -------- orderflow score conversion --------
function orderFlowScore(of) {
  if (!of) return 0.5;
  let s = 0.5;
  if (isNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, of.avgVol || 1)) * 0.2, -0.2, 0.2);
  if (isNum(of.vel)) s += clamp(Math.tanh(of.vel / Math.max(1, (of.avgVol || 1) / 100)) * 0.15, -0.15, 0.15);
  return clamp(s, 0.01, 0.99);
}

// -------- fuse scores using adaptive weights --------
function fuseScores(scores, weights) {
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind ?? 0.5, 0, 1);
  const cnn = clamp(scores.cnn ?? 0.5, 0, 1);
  const of = clamp(scores.of ?? 0.5, 0, 1);
  const news = clamp(scores.news ?? 0.5, 0, 1);
  const fused = ind * (w.w_ind || 0.45) + cnn * (w.w_cnn || 0.25) + of * (w.w_of || 0.2) + news * (w.w_news || 0.1);
  return { fused: clamp(fused, 0.01, 0.99), breakdown: { ind, cnn, of, news }, weights: w };
}

// -------- TP candidate builder + stable selection --------
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
    const key = Math.round(c.tp); // dedupe by rounded integer (keeps nearest)
    if (!map.has(key) || (c.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, c);
  }
  const arr = Array.from(map.values());
  arr.sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
  return arr;
}

function chooseStablePrimaryHedge(candidates, dir, price, feats, config) {
  // config contains minDist (absolute)
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  const minDist = config.MIN_TP_DISTANCE || (atr * config.MIN_TP_DISTANCE_ATR_MULT || atr * 1.2);
  // filter candidates that are meaningfully far
  const meaningful = candidates.filter(c => Math.abs(c.tp - price) >= minDist);
  const pool = meaningful.length ? meaningful : candidates; // fallback to any if none meaningful
  if (!pool.length) {
    // fallback ATR primary + hedge
    const primary = (dir === "Bullish") ? price + atr * 2.5 : (dir === "Bearish") ? price - atr * 2.5 : price + atr * 2.5;
    const hedge = (dir === "Bullish") ? price - atr * 1.2 : (dir === "Bearish") ? price + atr * 1.2 : price - atr * 1.2;
    return { primary: Number(primary), hedge: Number(hedge), primarySource: "ATR_FALLBACK", hedgeSource: "ATR_HEDGE", confidence: 40 };
  }
  // choose primary depending on dir
  let primary = null;
  if (dir === "Bullish") primary = pool.find(p => p.tp > price) || pool[0];
  else if (dir === "Bearish") primary = pool.find(p => p.tp < price) || pool[0];
  else primary = pool[0];
  // find hedge (opposite side)
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

// -------- pick SL --------
function pickSLForPrimary(dir, price, feats) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  // if bullish, SL below recent swing low; if bearish, SL above recent swing high
  if (feats && Array.isArray(feats.candles) && feats.candles.length >= 3) {
    const window = feats.candles.slice(-12);
    const swingLow = Math.min(...window.map(c => c.low));
    const swingHigh = Math.max(...window.map(c => c.high));
    if (dir === "Bullish") return Number(Math.min(swingLow, price - atr * 1.2).toFixed(8));
    if (dir === "Bearish") return Number(Math.max(swingHigh, price + atr * 1.2).toFixed(8));
  }
  return dir === "Bullish" ? Number((price - atr * 1.5).toFixed(8)) : dir === "Bearish" ? Number((price + atr * 1.5).toFixed(8)) : Number((price - atr * 1.5).toFixed(8));
}

// -------- MAIN runMLPrediction --------
/*
  options:
   - symbol (string)
   - tfc (string) primary timeframe to analyze (default "15m")
   - config: { fusedTFs: ["15m","30m","1h"], MIN_TP_DISTANCE_ATR_MULT: 1.2, maxPerTf: 1 }
*/
export async function runMLPrediction(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    const CONFIG = Object.assign({
      fusedTFs: ["15m","30m","1h"],
      minTFsForFusion: 2,
      MIN_TP_DISTANCE_ATR_MULT: 1.2,
      MAX_PER_TF_SNAPS: 1
    }, opts.config || {});

    // fetch multiple TFs (ensure fusedTFs + micro frames)
    const tfsToFetch = Array.from(new Set([tfc, ...CONFIG.fusedTFs, "1m", "5m", "30m", "1h"])).slice(0, 10);
    const mtfRaw = await fetchMultiTF(symbol, tfsToFetch);
    const primaryRaw = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = primaryRaw.data || [];
    const price = isNum(primaryRaw.price) && primaryRaw.price > 0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_module_v12_fixed",
        symbol, tf: tfc, direction: "Neutral",
        probs: { bull:33.33, bear:33.33, neutral:33.33 }, maxProb:33.33,
        tpEstimate: null, tpSource: null, tpConfidence: 0, slEstimate: null,
        perTf: []
      };
    }

    // features for primary tf
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment, 0, 1) : 0.5;

    // build per-TF ML snapshots for configured fusedTFs
    const perTfSnapshots = [];
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = raw.data || [];
      const p = isNum(raw.price) && raw.price > 0 ? raw.price : (c?.at(-1)?.close ?? price);
      if (!c || c.length < 6) {
        perTfSnapshots.push({ tf, direction: "Neutral", tp: null, maxProb: 33 });
        continue;
      }
      const f = buildFeaturesFromCandles(c);
      const indL = indicatorLayer(f);
      const cnnL = await cnnLayer(c);
      const ofL = orderFlowScore(f?.of || {});
      // simple fuse for per-tf
      const scores = { ind: indL.score, cnn: (cnnL.score || 0.5), of: ofL, news: newsScore };
      const fused = fuseScores(scores, _stats.adaptiveWeights);
      const bullP = fused.fused;
      const pb = Math.round(bullP * 10000) / 100;
      const pr = Math.round((1 - bullP) * 10000) / 100;
      const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
      // candidate TPs using ell if available
      let ell = null;
      try { ell = await analyzeElliott(c); } catch (e) { ell = null; }
      let candidates = buildCandidateTPsFromElliott(ell);
      if (!candidates.length) candidates = buildATRFallbackTPs(p, f?.atr);
      candidates = dedupeAndSortCandidates(candidates, p);
      const top = candidates[0] || null;
      perTfSnapshots.push({ tf, direction: dir, tp: top ? Number(top.tp) : null, maxProb: Math.round(Math.max(pb, pr)) });
    }

    // Compose master scores (use per-TF weighted fusion)
    // Weight scheme: favour mid & higher TFs
    const TF_WEIGHTS = Object.assign({ "1m":0.05, "5m":0.10, "15m":0.40, "30m":0.20, "1h":0.25 }, opts.tfWeights || {});
    let fusedSum = 0, wsum = 0;
    for (const tf of CONFIG.fusedTFs) {
      const entry = perTfSnapshots.find(x=>x.tf===tf);
      if (!entry) continue;
      // convert direction->score (-1..1)
      const s = entry.direction === "Bullish" ? 1 : entry.direction === "Bearish" ? -1 : 0;
      const w = TF_WEIGHTS[tf] ?? 0.1;
      fusedSum += s * w; wsum += w;
    }
    const overallFusion = wsum ? clamp(fusedSum / wsum, -1, 1) : 0;

    // ML main fused layer (use primary ind/cnn/of/news)
    const scoresMain = { ind: ind.score, cnn: (cnn.score || 0.5), of: of, news: newsScore };
    const fusionMain = fuseScores(scoresMain, _stats.adaptiveWeights);
    const bullP_main = fusionMain.fused;
    // integrate overallFusion (from multi-TF) and main fusion (ML) to produce final probability
    // weights: main fusion 0.5, overall TF fusion (scaled to 0..1) 0.4, news 0.1
    const overallTF0to1 = (overallFusion + 1) / 2; // -1..1 -> 0..1
    const fusedProb = clamp(bullP_main * 0.55 + overallTF0to1 * 0.35 + newsScore * 0.10, 0.01, 0.99);
    const pb = Math.round(fusedProb * 10000) / 100;
    const pr = Math.round((1 - fusedProb) * 10000) / 100;
    const pn = Math.round(Math.max(0, 100 - pb - pr) * 100) / 100;
    const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";
    const maxProb = Math.max(pb, pr, pn);

    // Build TP candidates using ell from fusedTFs combined
    let combinedCandidates = [];
    // collect ell-derived candidates from fused TFs
    for (const tf of CONFIG.fusedTFs) {
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = raw.data || [];
      if (!c || c.length < 6) continue;
      try {
        const ell = await analyzeElliott(c);
        if (ell && Array.isArray(ell.targets) && ell.targets.length) {
          const cs = buildCandidateTPsFromElliott(ell);
          if (cs && cs.length) combinedCandidates.push(...cs);
        }
      } catch (e) {}
    }
    // always add primary ell from primary tf too (if available)
    try {
      const ellP = await analyzeElliott(candles);
      if (ellP && Array.isArray(ellP.targets) && ellP.targets.length) combinedCandidates.push(...buildCandidateTPsFromElliott(ellP));
    } catch (e) {}
    // add ATR fallback from primary tf
    combinedCandidates.push(...buildATRFallbackTPs(price, feats?.atr));
    // dedupe
    combinedCandidates = dedupeAndSortCandidates(combinedCandidates, price);

    // choose stable primary & hedge (respect MIN distance)
    const chosen = chooseStablePrimaryHedge(combinedCandidates, dir, price, feats, {
      MIN_TP_DISTANCE_ATR_MULT: CONFIG.MIN_TP_DISTANCE_ATR_MULT,
      MIN_TP_DISTANCE: Math.max(feats?.atr || 0, Math.abs(price) * 0.0005) * CONFIG.MIN_TP_DISTANCE_ATR_MULT
    });

    // compute SL for primary
    const slEstimate = pickSLForPrimary(dir, price, feats);

    // tpConfidence: combine chosen.confidence and maxProb
    const tpConfidence = Math.round(Math.min(100, (chosen.confidence || 40) * 0.55 + maxProb * 0.4 + 5));

    // Prepare compact, clean output (minimal verbose data)
    const perTfClean = perTfSnapshots.map(p => ({
      tf: p.tf, direction: p.direction, tp: p.tp ? Number(p.tp) : null, maxProb: p.maxProb
    })).slice(0, CONFIG.fusedTFs.length);

    const mlObj = {
      modelVersion: "ml_module_v12_fixed",
      symbol, tf: tfc, generatedAt: new Date().toISOString(),
      direction: dir, probs: { bull: pb, bear: pr, neutral: pn }, maxProb,
      tpEstimate: Number(chosen.primary), tpSource: chosen.primarySource || "composite",
      tpConfidence, hedgeTP: Number(chosen.hedge), hedgeSource: chosen.hedgeSource || "composite",
      slEstimate: Number(slEstimate),
      perTf: perTfClean,
      adaptiveWeights: _stats.adaptiveWeights,
      raw: { fusionMain: Math.round(fusionMain.fused*10000)/10000, overallTF: Math.round(overallFusion*10000)/10000, newsScore }
    };

    // record the prediction
    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores: scoresMain, fusedProb } });

    return mlObj;

  } catch (e) {
    return { error: e?.toString?.() ?? String(e), symbol, tf: tfc };
  }
}

// -------- Micro predictor (fast 1m) --------
export async function runMicroPrediction(symbol = "BTCUSDT", tfc = "1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = mtf[tfc]?.data || [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_module_v12_fixed-micro", label: "Neutral", prob: 33.33, reason: "insufficient" };
    const f = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(f);
    const cnn = await cnnLayer(candles);
    const of = orderFlowScore(f?.of || {});
    const scores = { ind: ind.score, cnn: cnn.score || 0.5, of, news: 0.5 };
    const fused = fuseScores(scores, _stats.adaptiveWeights);
    const probBull = Math.round(fused.fused * 10000) / 100;
    const probBear = Math.round((1 - fused.fused) * 10000) / 100;
    const label = probBull > probBear ? "Bullish" : probBear > probBull ? "Bearish" : "Neutral";
    return { modelVersion: "ml_module_v12_fixed-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn.score, of } };
  } catch (e) { return { error: e?.toString?.() ?? String(e), label: "Neutral" }; }
}

// -------- training adaptor (exposed) --------
export async function trainAdaptive(batch = []) {
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
  } catch (e) { return { ok: false, error: e?.toString?.() ?? String(e) }; }
}

// -------- default export --------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction,
  recordOutcome, markOutcome, getStats, trainAdaptive, resetStats
};
export default defaultExport;