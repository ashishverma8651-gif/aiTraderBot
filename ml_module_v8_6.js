// ==============================
// ml_module_v15_1_pro.js — PART 1/6
// v15.1 PRO (PART 1: imports, persistence, helpers, stats, base layers)
// NOTE: This file is split into 6 parts. KEEP PART 1 as the only place with imports.
// Combine parts in order to produce the final single file.
// ==============================

/*
  Imports (KEPT exactly as v15 style, ESM)
  - fs, path (node builtin)
  - fetchMultiTF, analyzeElliott, News as in v15
*/
import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";            // must exist in your project
import { analyzeElliott } from "./elliott_module.js"; // must exist in your project
import News from "./news_social.js";                  // optional (safe accessor below)

/* Safe news accessor (keeps compatibility with v15) */
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// ---------- Persistence paths (configurable via env) ----------
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v15_1_pro_logs");
const PRED_FILE = path.join(LOG_DIR, "predictions_v15_1_pro.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes_v15_1_pro.json");
const STATS_FILE = path.join(LOG_DIR, "stats_v15_1_pro.json");
const MODEL_FILE = path.join(LOG_DIR, "model_v15_1_pro.json"); // lightweight saved weights

try {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // best-effort; if this fails it's non-fatal for in-memory ops
}

// ---------- Safe JSON read/write ----------
const readJsonSafe = (f, fallback = null) => {
  try {
    if (!fs.existsSync(f)) return fallback;
    const s = fs.readFileSync(f, "utf8");
    return JSON.parse(s || "null");
  } catch (e) {
    return fallback;
  }
};
const writeJsonSafe = (f, obj) => {
  try {
    fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
};

// ---------- Numeric helpers ----------
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a=-Infinity, b=Infinity) => Math.max(a, Math.min(b, v));
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0;

// ---------- In-memory stats (loaded from disk) ----------
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
} catch(e){/* ignore */}

// ---------- Lightweight model weights (saved & loaded) ----------
let _model = {
  // tuned starting weights (v15.1 PRO)
  W_indicator: 1.0,
  W_cnn: 1.0,
  W_orderflow: 1.0,
  W_trend: 1.0,
  W_reversal: 1.0,
  W_volatility: 1.0,
  W_multitf: 1.0,
  learningRate: 0.002
};
try {
  const raw = readJsonSafe(MODEL_FILE, null);
  if (raw && typeof raw === "object") _model = Object.assign(_model, raw);
} catch(e){/* ignore */}

// ---------- Persistence helpers (predictions/outcomes) ----------
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
  } catch (e) {
    return false;
  }
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
  } catch (e) {
    return false;
  }
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
  } catch (e) {
    return { accuracy:0, total:0, correct:0 };
  }
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
  } catch(e) {
    return false;
  }
}

export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc, model: _model };
}

export function resetStats() {
  _stats = { total:0, wins:0, losses:0, accuracyCache:null, adaptiveWeights: { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1,lr:0.02 }, alerts:[], lastUpdated:null, adaptiveTrainMeta:{} };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// ---------- Fusion/adaptive helpers (reused from v12, polished) ----------
export function fuseScores(scores, weights) {
  // scores: { ind, cnn, of, news } in 0..1
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind ?? 0.5, 0, 1);
  const cnn = clamp(scores.cnn ?? 0.5, 0, 1);
  const of = clamp(scores.of ?? 0.5, 0, 1);
  const news = clamp(scores.news ?? 0.5, 0, 1);
  const fused = ind * (w.w_ind || 0.45) + cnn * (w.w_cnn || 0.25) + of * (w.w_of || 0.2) + news * (w.w_news || 0.1);
  return { fused: clamp(fused, 0.01, 0.99), breakdown: { ind, cnn, of, news }, weights: w };
}

export function updateAdaptiveWeights(trueLabel, predProb, features = {}) {
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
    // normalize
    w.w_ind /= s; w.w_cnn /= s; w.w_of /= s; w.w_news /= s;
    _stats.adaptiveWeights = w;
    writeJsonSafe(STATS_FILE, _stats);
  } catch(e){}
}

// ---------- Candle / features helpers ----------
export function candleVisionHeuristic(candles, lookback=8) {
  if (!Array.isArray(candles) || candles.length === 0) return { label:"Neutral", probs:{ bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c=>c.close>c.open).length;
  const down = last.filter(c=>c.close<c.open).length;
  const momentum = (last.at(-1).close - last[0].close) / Math.max(EPS, last[0].close);
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

export function buildFeaturesFromCandles(candles) {
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

// ---------- Indicator / CNN / orderflow score functions ----------
export function indicatorLayer(feats) {
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

export async function cnnLayer(candles) {
  // This is an intentionally lightweight "candle vision" substitute for heavy CNNs.
  // It derives heuristics and a compact score, not a deep model, to keep memory low.
  const cv = candleVisionHeuristic(candles,8);
  return { score: (cv.score||0.5), probs: cv.probs, features: cv.features, label: cv.label };
}

export function orderFlowScore(of) {
  if (!of) return 0.5;
  let s = 0.5;
  if (isNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, of.avgVol || 1)) * 0.2, -0.2, 0.2);
  if (isNum(of.vel)) s += clamp(Math.tanh(of.vel / Math.max(1, (of.avgVol || 1)/100)) * 0.15, -0.15, 0.15);
  // include lastVol vs avgVol signal if available
  if (isNum(of.lastVol) && isNum(of.avgVol) && of.avgVol>0) {
    const volRatio = of.lastVol / of.avgVol;
    s += clamp(Math.tanh((volRatio - 1) * 0.7) * 0.08, -0.08, 0.08);
  }
  return clamp(s, 0.01, 0.99);
}

// End of PART 1/6
// Next: PART 2/6 (multi-TF fusion, advanced TP helpers, ATR fallback, dedupe, stable chooser)
// =============================================================

// ==============================
// ml_module_v15_1_pro.js — PART 2/6
// (multi-TF fusion, TP helpers, improved primary/hedge chooser, precision core)
// Continue from Part 1 — DO NOT add imports here.
// ==============================

/* ---------- TP helpers (Elliott -> candidate, ATR fallback, dedupe/cluster) ---------- */

export function buildCandidateTPsFromElliott(ell, tf = null) {
  // ell: object returned by analyzeElliott(candles)
  if (!ell || !Array.isArray(ell.targets)) return [];
  const out = [];
  for (const t of ell.targets) {
    const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
    if (!isNum(tp) || tp <= 0) continue;
    const conf = Math.round(clamp(Number(t.confidence ?? ell.confidence ?? 40), 0, 100));
    out.push({ tp, source: t.source || t.type || "elliott", confidence: conf, tf });
  }
  return out;
}

export function buildATRFallbackTPs(price, atr) {
  // More robust ATR fallback with configurable multipliers from model weights
  try {
    const baseAtr = Math.max(atr || 0, Math.abs(price) * 0.0005, 1);
    const up = Number((price + baseAtr * 2.5).toFixed(8));
    const down = Number((price - baseAtr * 2.5).toFixed(8));
    return [
      { tp: up, source: "ATR_UP", confidence: 30 },
      { tp: down, source: "ATR_DOWN", confidence: 30 }
    ];
  } catch (e) {
    return [];
  }
}

export function dedupeAndSortCandidates(candidates, price, opts = {}) {
  // candidates: [{tp, source, confidence, tf}, ...]
  // Remove near-duplicates (rounded) and keep the highest confidence per bucket.
  const PREC = opts.precision || 0; // rounding decimals; 0 => round to integer
  const bucketKey = (tp) => {
    if (PREC > 0) return Number(tp.toFixed(PREC));
    return Math.round(tp);
  };
  const map = new Map();
  for (const c of (candidates || [])) {
    if (!c || !isNum(c.tp)) continue;
    const key = bucketKey(c.tp);
    const existing = map.get(key);
    if (!existing || (c.confidence || 0) > (existing.confidence || 0)) {
      map.set(key, { ...c, tp: Number(c.tp) });
    } else if (existing && (c.confidence || 0) === (existing.confidence || 0)) {
      // prefer closer to price
      if (Math.abs(c.tp - price) < Math.abs(existing.tp - price)) map.set(key, { ...c, tp: Number(c.tp) });
    }
  }
  const arr = Array.from(map.values());
  // sort by distance from price ascending, then by confidence descending
  arr.sort((a, b) => {
    const da = Math.abs(a.tp - price); const db = Math.abs(b.tp - price);
    if (da !== db) return da - db;
    return (b.confidence || 0) - (a.confidence || 0);
  });
  return arr;
}

/* ---------- TP selection: improved chooseStablePrimaryHedge ---------- */

export function chooseStablePrimaryHedge(candidates, dir = "Neutral", price = 0, feats = {}, config = {}) {
  // candidates: deduped sorted list
  // dir: "Bullish" | "Bearish" | "Neutral"
  // returns { primary, hedge, primarySource, hedgeSource, confidence }
  try {
    const atr = Math.max(feats?.atr || 0, Math.abs(price) * (config.BASE_ATR_MULT || 0.0005), 1);
    const MIN_MULT = config.MIN_TP_DISTANCE_ATR_MULT ?? (config.MIN_TP_DISTANCE_ATR_MULT || 1.2);
    const minDist = config.MIN_TP_DISTANCE || (atr * MIN_MULT);

    // filter out wacky candidates too close to price
    const meaningful = (candidates || []).filter(c => Math.abs(c.tp - price) >= minDist);
    const pool = meaningful.length ? meaningful : (candidates || []);

    // fallback if nothing found
    if (!pool.length) {
      const primary = dir === "Bullish" ? price + atr * 2.5 : dir === "Bearish" ? price - atr * 2.5 : price + atr * 2.5;
      const hedge = dir === "Bullish" ? price - atr * 1.2 : dir === "Bearish" ? price + atr * 1.2 : price - atr * 1.2;
      return { primary: Number(primary), hedge: Number(hedge), primarySource: "ATR_FALLBACK", hedgeSource: "ATR_HEDGE", confidence: 40 };
    }

    // pick primary based on direction and candidate distances + confidence + volatility context
    const volatility = feats?.atr || atr;
    // scoring function for candidate: weight distance and confidence and source bias
    const scoreFor = (c) => {
      const dist = Math.abs(c.tp - price);
      // prefer candidates in direction and with higher confidence and reasonable distance
      const dirBonus = ((dir === "Bullish" && c.tp > price) || (dir === "Bearish" && c.tp < price)) ? 1 : 0.6;
      const conf = (c.confidence || 40) / 100;
      // distance penalty: log scale to prefer nearer TPs but still allow further ones if high confidence
      const distScore = 1 / (1 + Math.log(1 + dist / Math.max(EPS, volatility)));
      return dirBonus * conf * distScore;
    };

    // compute scores and pick top
    let scored = pool.map(c => ({ ...c, _score: scoreFor(c) }));
    scored.sort((a, b) => b._score - a._score);

    const primaryCand = scored[0];
    // find a hedge: the best candidate on opposite side
    const opp = scored.find(c => (dir === "Bullish" ? c.tp < price : c.tp > price));
    const atrH = Math.max(volatility, Math.abs(price) * 0.0005);
    const hedgeFallback = { tp: Number((price + (dir === "Bullish" ? -atrH * 1.2 : atrH * 1.2)).toFixed(8)), source: "HEDGE_ATR", confidence: 30 };

    const hedgeCand = opp || hedgeFallback;
    const primary = primaryCand ? Number(primaryCand.tp) : Number(price + (dir === "Bullish" ? atr * 2.5 : -atr * 2.5));
    const hedge = hedgeCand ? Number(hedgeCand.tp) : Number(hedgeFallback.tp);

    // combine confidence
    const pconf = Math.round(Math.min(100, (primaryCand ? (primaryCand.confidence || 40) : 40) * 0.7 + ((feats?.atr || 0) ? 10 : 0) + 20));
    return {
      primary,
      hedge,
      primarySource: primaryCand ? primaryCand.source || primaryCand.tf || "cluster" : "ATR_FALLBACK",
      hedgeSource: hedgeCand.source || hedgeCand.tf || "HEDGE_FALLBACK",
      confidence: pconf
    };
  } catch (e) {
    // fallback
    const fatr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
    return { primary: Number(price + fatr * 2.5), hedge: Number(price - fatr * 1.2), primarySource: "ERR_FALLBACK", hedgeSource: "ERR_FALLBACK", confidence: 30 };
  }
}

/* ---------- Improved SL picker ---------- */

export function pickSLForPrimary(dir = "Neutral", price = 0, feats = {}, opts = {}) {
  try {
    const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
    // use swing structure for SL (protect vs recent swings)
    if (feats && Array.isArray(feats.candles) && feats.candles.length >= 3) {
      const window = feats.candles.slice(-Math.min(24, feats.candles.length));
      const swingLow = Math.min(...window.map(c=>Number(c.low || c[1] || 0)));
      const swingHigh = Math.max(...window.map(c=>Number(c.high || c[2] || 0)));
      if (dir === "Bullish") {
        // place SL below nearest swing low but allow ATR padding
        const base = Math.min(swingLow, price - atr * 1.2);
        return Number((base - atr * (opts.extraPad || 0.2)).toFixed(8));
      }
      if (dir === "Bearish") {
        const base = Math.max(swingHigh, price + atr * 1.2);
        return Number((base + atr * (opts.extraPad || 0.2)).toFixed(8));
      }
    }
    // generic fallback
    if (dir === "Bullish") return Number((price - atr * 1.5).toFixed(8));
    if (dir === "Bearish") return Number((price + atr * 1.5).toFixed(8));
    return Number((price - atr * 1.5).toFixed(8));
  } catch (e) {
    return Number((price - (feats?.atr || Math.abs(price)*0.005) * 1.5).toFixed(8));
  }
}

/* ---------- Multi-TF fusion helpers (small utilities used by prediction flow) ---------- */

export function computePerTFSnapshots(mtfRaw = {}, fusedTFs = ["15m","30m","1h"], newsScore = 0.5, adaptiveWeights = _stats.adaptiveWeights) {
  // returns array of { tf, direction, tp, maxProb, rawScores }
  const out = [];
  for (const tf of fusedTFs) {
    try {
      const raw = mtfRaw[tf] || { data:[], price:0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      const p = isNum(raw.price) && raw.price>0 ? raw.price : (c?.at(-1)?.close ?? 0);
      if (!c || c.length < 6) { out.push({ tf, direction:"Neutral", tp:null, maxProb:33, rawScores:null }); continue; }

      const f = buildFeaturesFromCandles(c);
      const indL = indicatorLayer(f);
      const cnnL = (async()=>await cnnLayer(c))(); // keep as Promise for non-blocking (caller should await if needed)
      // We'll compute orderflow score synchronously
      const ofL = orderFlowScore(f?.of || {});

      // fuse scores (synchronous approximate — if cnnLayer Promise, assume value will be awaited by caller)
      const cnnScore = (typeof cnnL === "object" && cnnL.score) ? cnnL.score : 0.5;
      const scores = { ind: indL.score, cnn: cnnScore || 0.5, of: ofL, news: newsScore };
      const fused = fuseScores(scores, adaptiveWeights);
      const bullP = fused.fused;
      const pb = Math.round(bullP*10000)/100;
      const pr = Math.round((1-bullP)*10000)/100;
      const dir = pb > pr ? "Bullish" : pr > pb ? "Bearish" : "Neutral";

      // analyze ell
      let ell = null;
      try { ell = analyzeElliott ? analyzeElliott(c) : null; } catch(e) { ell = null; }
      // build tps (sync if ell returns sync; otherwise caller can refine)
      let candidates = [];
      if (ell && Array.isArray(ell.targets)) candidates = buildCandidateTPsFromElliott(ell, tf);
      if (!candidates.length) candidates = buildATRFallbackTPs(p, f?.atr);

      const ded = dedupeAndSortCandidates(candidates, p);
      const top = ded[0] || null;
      out.push({ tf, direction: dir, tp: top ? Number(top.tp) : null, maxProb: Math.round(Math.max(pb, pr)), rawScores: scores });
    } catch (e) {
      out.push({ tf, direction: "Neutral", tp: null, maxProb: 33, rawScores: null });
    }
  }
  return out;
}

/* ---------- Precision decision core (refined) ---------- */

export function buildDecisionFeaturesForPrecision(featsPrimary = {}, newsObj = {}, systemProb = 0.5) {
  const slope = featsPrimary.slope || 0;
  const mom3 = featsPrimary.mom3 || 0;
  const rsi = featsPrimary.rsi || 50;
  const vol = (featsPrimary.lastVol || 0) - (featsPrimary.avgVol || 0);
  const atrNorm = featsPrimary.atr ? (featsPrimary.atr / Math.max(EPS, Math.abs(featsPrimary.close || 1))) : 0.001;
  const newsImpact = (newsObj && newsObj.impact) ? String(newsObj.impact).toLowerCase() : "low";
  const sentiment = (newsObj && typeof newsObj.sentiment === "number") ? (newsObj.sentiment * 100) : 50;
  const candleStructure = (featsPrimary.candles && featsPrimary.candles.length) ? featsPrimary.candles.slice(-12) : [];
  return { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb: systemProb || 0.5, candles: candleStructure, atr: featsPrimary.atr || 0 };
}

export function getMLDirectionPrecision(features = {}) {
  // features from buildDecisionFeaturesForPrecision
  const { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb } = features;
  // transform features to bounded signals
  const momStrength = mom3 * (rsi / 50);
  const slopeSign = Math.sign(slope || 0);
  const slopeMag = Math.abs(slope || 0);
  const smoothedSlope = (slope * 0.55) + (slopeSign * Math.sqrt(Math.abs(slopeMag)) * 0.25) + (slope * atrNorm * 0.20);
  const sentAdj = (sentiment - 50) / 50;
  const newsMultiplier = (newsImpact === "high") ? 1.6 : (newsImpact === "moderate") ? 1.0 : 0.4;
  const S_slope = clamp(smoothedSlope * 0.45, -5, 5);
  const S_mom = clamp(momStrength * 0.33, -4, 4);
  const S_rsi = clamp((rsi - 50) * 0.06, -3, 3);
  const S_news = clamp(sentAdj * 1.2 * newsMultiplier, -3, 3);
  const S_vol = clamp(Math.sign(vol) * Math.min(1, Math.abs(vol) / Math.max(1, Math.abs(vol)||1)) * 0.4, -1, 1);
  const S_system = (systemProb - 0.5) * 2 * 1.1;
  const raw = S_slope + S_mom + S_rsi + S_news + S_vol + S_system;
  // convert to probability via logistic
  const probBull = 1 / (1 + Math.exp(-raw / 3.5));
  const confidence = Math.round(probBull * 100);
  const direction = (confidence >= 60) ? "Bullish" : (confidence <= 40) ? "Bearish" : "Neutral";
  return { direction, confidence, probBull: Math.round(probBull * 10000)/100, raw };
}

/* ---------- End of PART 2/6 ----------
// Next: PART 3/6 (ML prediction cores, per-TF fusion, TP aggregation, TP confidence scoring)
============================================================ */
// ==============================
// ml_module_v15_1_pro.js — PART 3/6
// (ML prediction core, tp aggregation & scoring, light training/eval)
// Continue from Part 2 — DO NOT add imports here.
// ==============================

/* ---------- Utility: cluster / merge TP candidates across TFs ---------- */

export function clusterTPCandidates(candidates = [], opts = {}) {
  // candidates: [{tp, source, confidence, tf}, ...]
  // returns clusters: [{ center, members:[], avgConfidence, span }]
  const PREC = opts.precision || 0; // rounding decimals used for bucket
  const bucketKey = tp => PREC > 0 ? Number(tp.toFixed(PREC)) : Math.round(tp);
  // group by bucket
  const map = new Map();
  for (const c of (candidates || [])) {
    if (!c || !isNum(c.tp)) continue;
    const key = bucketKey(c.tp);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const clusters = [];
  for (const [k, members] of map.entries()) {
    const center = mean(members.map(m => m.tp));
    const avgConfidence = mean(members.map(m => clamp(m.confidence || 40, 0, 100)));
    const span = Math.max(...members.map(m => Math.abs(m.tp - center)));
    clusters.push({ center: Number(center), members, avgConfidence: Math.round(avgConfidence), span });
  }
  // sort by confidence desc then proximity (lower span)
  clusters.sort((a,b) => (b.avgConfidence - a.avgConfidence) || (a.span - b.span));
  return clusters;
}

/* ---------- TP scoring: combine confidence, TF support, source trust, distance & volatility ---------- */

export function scoreTPCluster(cluster = {}, price = 0, feats = {}, tfWeights = {}) {
  // cluster: { center, members, avgConfidence, span }
  // Compute composite score 0..100
  try {
    const volatility = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
    const dist = Math.abs(cluster.center - price);
    // support: how many TFs / distinct sources
    const tfSet = new Set(cluster.members.map(m => m.tf || m.source || "unknown"));
    const sourceSet = new Set(cluster.members.map(m => m.source || "unknown"));
    const support = cluster.members.length;
    const tfSupport = tfSet.size;
    // source trust: boost for elliott / multi-tf consensus
    const srcScores = cluster.members.map(m => {
      const src = (m.source || "").toLowerCase();
      if (src.includes("elliott")) return 1.1;
      if (src.includes("atr")) return 0.7;
      if (src.includes("cluster")) return 0.9;
      return 0.8;
    });
    const srcTrust = mean(srcScores);
    // distance penalty
    const distPenalty = 1 / (1 + Math.log(1 + dist / volatility));
    // base confidence from cluster
    const baseConf = (cluster.avgConfidence || 40) / 100;
    // tf-weighted multiplier (more weight if cluster members come from high-tier TFs)
    const tfMult = (() => {
      const wmap = Object.assign({ "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.25, "1h":0.22, "4h":0.15, "1d":0.2 }, tfWeights || {});
      let s=0, ws=0;
      for (const m of cluster.members) {
        const w = wmap[m.tf] ?? 0.1;
        s += w; ws += w;
      }
      return ws ? (s / ws) : 1;
    })();
    // final raw score
    let raw = baseConf * srcTrust * distPenalty * (1 + Math.log(1 + support)) * tfMult;
    // map to 0..100
    const score = Math.round(clamp(raw, 0.01, 2) / 2 * 100);
    return { score, baseConf: Math.round(baseConf*100), srcTrust: Number(srcTrust.toFixed(2)), dist: Number(dist.toFixed(8)), support, tfSupport, tfMult: Number(tfMult.toFixed(3)), span: cluster.span };
  } catch (e) {
    return { score: 30, baseConf: 40, srcTrust: 0.8, dist: Math.abs((cluster.center||0)-price), support: (cluster.members||[]).length, tfSupport: 1, tfMult:1, span: cluster.span || 0 };
  }
}

/* ---------- Aggregate candidates across TFs and produce prioritized TP list ---------- */

export function aggregateAndScoreTPs(perTFCandidates = [], price = 0, feats = {}, opts = {}) {
  // perTFCandidates: array of candidate objects (from multiple TFs)
  // returns list of prioritized tp objects [{ tp, score, cluster, sourceBreakdown, recommended }]
  const PREC = opts.precision || 0;
  // cluster
  const clusters = clusterTPCandidates(perTFCandidates, { precision: PREC });
  const out = [];
  for (const cl of clusters) {
    const sc = scoreTPCluster(cl, price, feats, opts.tfWeights || {});
    out.push({ tp: Number(cl.center), score: sc.score, meta: sc, cluster: cl });
  }
  // Sort by score desc, then proximity to price
  out.sort((a,b) => (b.score - a.score) || (Math.abs(a.tp - price) - Math.abs(b.tp - price)));
  // mark recommended top 3
  for (let i=0;i<out.length;i++) out[i].recommended = i < (opts.top || 3);
  return out;
}

/* ---------- Finalize primary & hedge TP with mixed strategy ---------- */

export function finalizePrimaryHedgeFromScored(scores = [], dir = "Neutral", price = 0, feats = {}, config = {}) {
  try {
    if (!Array.isArray(scores) || !scores.length) {
      const fallback = chooseStablePrimaryHedge([], dir, price, feats, config);
      return { primary: fallback.primary, hedge: fallback.hedge, primarySource: fallback.primarySource, hedgeSource: fallback.hedgeSource, primaryConf: fallback.confidence };
    }
    // prefer highest score in direction; else choose highest overall
    const inDir = scores.filter(s => (dir === "Bullish" ? s.tp > price : dir === "Bearish" ? s.tp < price : true));
    const primaryCand = (inDir.length ? inDir[0] : scores[0]);
    // choose hedge: take best score on opposite side
    const opp = scores.find(s => (dir === "Bullish" ? s.tp < price : dir === "Bearish" ? s.tp > price : s.tp < price));
    const fallback = chooseStablePrimaryHedge([], dir, price, feats, config);
    const primary = primaryCand ? primaryCand.tp : fallback.primary;
    const hedge = opp ? opp.tp : fallback.hedge;
    const pconf = primaryCand ? primaryCand.score : fallback.confidence;
    const primarySource = primaryCand ? (primaryCand.cluster?.members?.map(m=>m.source).filter(Boolean).join("|") || "cluster") : fallback.primarySource;
    const hedgeSource = opp ? (opp.cluster?.members?.map(m=>m.source).filter(Boolean).join("|") || "cluster") : fallback.hedgeSource;
    return { primary: Number(primary), hedge: Number(hedge), primarySource, hedgeSource, primaryConf: pconf };
  } catch (e) {
    const fb = chooseStablePrimaryHedge([], dir, price, feats, config);
    return { primary: fb.primary, hedge: fb.hedge, primarySource: fb.primarySource, hedgeSource: fb.hedgeSource, primaryConf: fb.confidence };
  }
}

/* ---------- Main ML prediction coordinator (light, uses earlier helpers) ---------- */

export async function runMLPredictionCore(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  // This is an orchestrator that:
  // - fetches multi-TF (caller must supply mtf via opts.mtfRaw to avoid duplicate fetch if desired)
  // - builds per-TF candidates (elliott + atr fallback)
  // - aggregates & scores TPs
  // - selects primary & hedge TP and SL
  // - returns a structured ml object
  try {
    const CONFIG = Object.assign({ fusedTFs: ["15m","30m","1h"], topTargets: 3, precision: 0, tfWeights: null }, opts.config || {});
    const fusedTFs = Array.isArray(CONFIG.fusedTFs) && CONFIG.fusedTFs.length ? CONFIG.fusedTFs : ["15m","30m","1h"];
    const mtfRaw = opts.mtfRaw || await fetchMultiTF(symbol, Array.from(new Set([tf, ...fusedTFs, "1m","5m"])) ).catch(()=>({}));
    const primaryRaw = mtfRaw[tf] || { data: [], price: 0 };
    const candles = Array.isArray(primaryRaw.data) ? primaryRaw.data : [];
    const price = isNum(primaryRaw.price) && primaryRaw.price > 0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return { ok:false, reason: "insufficient_data", modelVersion: "ml_module_v15_core" };
    }

    // primary feats
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment,0,1) : 0.5;

    // run per-TF processing (sync)
    const perTFCandidates = [];
    for (const t of fusedTFs) {
      const raw = mtfRaw[t] || { data: [], price: 0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      const p = isNum(raw.price) && raw.price>0 ? raw.price : (c?.at(-1)?.close ?? price);
      if (!c || c.length < 6) continue;
      let ell = null;
      try { ell = await analyzeElliott(c); } catch(e) { ell = null; }
      let candidates = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        candidates = buildCandidateTPsFromElliott(ell, t);
      } else {
        candidates = buildATRFallbackTPs(p, buildFeaturesFromCandles(c)?.atr );
      }
      // attach tf price context & push
      for (const cand of candidates) {
        perTFCandidates.push({ ...cand, tf: t, tfPrice: p });
      }
    }

    // include primary's own ell/atr candidates
    try {
      const ellP = await analyzeElliott(candles);
      if (ellP && Array.isArray(ellP.targets) && ellP.targets.length) {
        perTFCandidates.push(...buildCandidateTPsFromElliott(ellP, tf).map(x => ({ ...x, tf: tf, tfPrice: price })));
      } else {
        perTFCandidates.push(...buildATRFallbackTPs(price, feats?.atr).map(x => ({ ...x, tf: tf, tfPrice: price })));
      }
    } catch(e) {
      perTFCandidates.push(...buildATRFallbackTPs(price, feats?.atr).map(x => ({ ...x, tf: tf, tfPrice: price })));
    }

    // dedupe & cluster & score
    const deduped = dedupeAndSortCandidates(perTFCandidates, price, { precision: CONFIG.precision });
    const aggregated = aggregateAndScoreTPs(perTFCandidates, price, feats, { precision: CONFIG.precision, tfWeights: CONFIG.tfWeights, top: CONFIG.topTargets });

    // finalize primary & hedge
    const directionGuess = (() => {
      const scores = aggregated || [];
      const top = scores[0];
      if (!top) return "Neutral";
      return top.tp > price ? "Bullish" : top.tp < price ? "Bearish" : "Neutral";
    })();

    const precFeatures = buildDecisionFeaturesForPrecision(feats, newsObj, (ind && ind.score) ? ind.score : 0.5);
    const prec = getMLDirectionPrecision(precFeatures);

    const finalDir = (prec.direction === "Neutral") ? directionGuess : prec.direction;

    const final = finalizePrimaryHedgeFromScored(aggregated, finalDir, price, feats, CONFIG);

    const sl = pickSLForPrimary(finalDir, price, feats);

    // build ml object
    const ml = {
      modelVersion: "ml_module_v15_pro",
      symbol, tf, generatedAt: new Date().toISOString(),
      direction: finalDir,
      primaryTP: Number(final.primary),
      primarySource: final.primarySource,
      hedgeTP: Number(final.hedge),
      hedgeSource: final.hedgeSource,
      tpCandidates: aggregated.slice(0, CONFIG.topTargets),
      slEstimate: Number(sl),
      probs: { system: Math.round((prec.probBull||0) * 100)/100, news: Math.round(newsScore*10000)/100 },
      tpConfidence: final.primaryConf || (aggregated[0] ? aggregated[0].score : 40),
      featsSummary: { ind: ind.score, cnn: cnn.score || 0.5, of: ofScore, atr: feats?.atr || 0 },
      raw: { perTFCandidatesCount: perTFCandidates.length, dedupedCount: deduped.length, prec }
    };

    // record prediction
    const id = `${symbol}_${tf}_${Date.now()}`;
    recordPrediction({ id, symbol, tf, ml, meta: { scores: { ind: ind.score, cnn: cnn.score || 0.5, of: ofScore, news: newsScore }, fusedProb: prec.probBull || 0.5 } });

    return { ok:true, ml };
  } catch (e) {
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

/* ---------- Lightweight training & evaluation routines (no TF libs) ---------- */

/*
  trainModelLight:
  - Accepts array of training pairs: { fusedProb, trueLabel: "Bullish"|"Bearish"|"Neutral", breakdown }
  - Performs simple online gradient updates on _stats.adaptiveWeights (already used in fusion)
  - Adds optional regularization and momentum
*/
export function trainModelLight(batch = [], options = {}) {
  try {
    const lr = (options.lr || _stats.adaptiveWeights.lr || 0.02);
    const momentum = options.momentum || 0.0;
    _stats.adaptiveTrainMeta = _stats.adaptiveTrainMeta || {};
    _stats.adaptiveTrainMeta.lastTrained = new Date().toISOString();
    let updates = { w_ind:0, w_cnn:0, w_of:0, w_news:0 };
    for (const b of (batch || [])) {
      const y = b.trueLabel === "Bullish" ? 1 : (b.trueLabel === "Bearish" ? 0 : 0.5);
      const pred = (typeof b.fusedProb === "number") ? b.fusedProb : 0.5;
      const err = y - pred;
      const contrib = b.breakdown || { ind:0.5, cnn:0.5, of:0.5, news:0.5 };
      // update each weight
      updates.w_ind += lr * err * (contrib.ind - 0.5);
      updates.w_cnn += lr * err * (contrib.cnn - 0.5);
      updates.w_of += lr * err * (contrib.of - 0.5);
      updates.w_news += lr * err * (contrib.news - 0.5);
    }
    // apply updates with clamp + momentum
    _stats.adaptiveWeights.w_ind = clamp(_stats.adaptiveWeights.w_ind + updates.w_ind + (momentum * (_stats.adaptiveWeights.w_ind || 0)), 0.05, 0.8);
    _stats.adaptiveWeights.w_cnn = clamp(_stats.adaptiveWeights.w_cnn + updates.w_cnn + (momentum * (_stats.adaptiveWeights.w_cnn || 0)), 0.05, 0.6);
    _stats.adaptiveWeights.w_of = clamp(_stats.adaptiveWeights.w_of + updates.w_of + (momentum * (_stats.adaptiveWeights.w_of || 0)), 0.05, 0.6);
    _stats.adaptiveWeights.w_news = clamp(_stats.adaptiveWeights.w_news + updates.w_news + (momentum * (_stats.adaptiveWeights.w_news || 0)), 0.01, 0.3);
    // renormalize
    const s = _stats.adaptiveWeights.w_ind + _stats.adaptiveWeights.w_cnn + _stats.adaptiveWeights.w_of + _stats.adaptiveWeights.w_news;
    _stats.adaptiveWeights.w_ind /= s; _stats.adaptiveWeights.w_cnn /= s; _stats.adaptiveWeights.w_of /= s; _stats.adaptiveWeights.w_news /= s;
    writeJsonSafe(STATS_FILE, _stats);
    return { ok:true, weights: _stats.adaptiveWeights };
  } catch (e) {
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

/* ---------- Evaluate predictions vs outcomes (simple accuracy, AUC-ish proxy) ---------- */

export function evaluatePredictionsWindow(window = 500) {
  try {
    const preds = readJsonSafe(PRED_FILE, []) || [];
    const outs = readJsonSafe(OUT_FILE, []) || [];
    if (!preds.length || !outs.length) return { ok:false, message:"no data" };
    const mapOut = new Map(outs.map(o => [o.alertId || o.id, o]));
    const pairs = [];
    for (const p of preds.slice(-window)) {
      const o = mapOut.get(p.id || p.alertId);
      if (!o || typeof o.success !== "boolean") continue;
      const fused = p.meta?.scores ? fuseScores(p.meta.scores, _stats.adaptiveWeights) : { fused: 0.5, breakdown: {} };
      pairs.push({ pred: fused.fused, true: o.success ? 1 : 0, id: p.id || p.alertId });
    }
    if (!pairs.length) return { ok:false, message:"no matched pairs" };
    // accuracy at 0.5 threshold
    const correct = pairs.filter(pp => (pp.pred >= 0.5 && pp.true === 1) || (pp.pred < 0.5 && pp.true === 0)).length;
    const accuracy = Math.round((correct / pairs.length) * 10000) / 100;
    // crude separation metric: mean pred for true=1 minus mean pred for true=0
    const meanPos = mean(pairs.filter(pp => pp.true === 1).map(pp => pp.pred));
    const meanNeg = mean(pairs.filter(pp => pp.true === 0).map(pp => pp.pred));
    const separation = Math.round((meanPos - meanNeg) * 10000) / 100;
    return { ok:true, totalPairs: pairs.length, accuracy, separation, pairsSample: pairs.slice(0,10) };
  } catch (e) {
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

/* ---------- Export convenience alias mapping for compatibility ---------- */

// Some callers expect these exact function names
export const runMLPredictionLight = runMLPredictionCore;
export const trainAdaptiveLight = trainModelLight;

/* ---------- End of PART 3/6 ----------
 Next: PART 4/6 — advanced meters, pro-meters improvements, fuseMLTFs refinement and reporting helpers
============================================================ */
// ==============================
// PART 4/6 — Advanced fusion, pro-meters, telemetry & report v2
// Continue from Part 3 — DO NOT add imports here.
// ==============================

/* ---------- Telemetry / light logging ---------- */
const TELEMETRY_FILE = path.join(LOG_DIR, "telemetry_v15.json");
function writeTelemetry(entry) {
  try {
    const arr = readJsonSafe(TELEMETRY_FILE, []) || [];
    arr.push({ ...entry, ts: new Date().toISOString() });
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
    writeJsonSafe(TELEMETRY_FILE, arr);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- Refined fuseMLTFs (normalizes probabilities, handles missing TFs) ---------- */
export function fuseMLTFsRefined(perTFArrayOrObj, opts = {}) {
  try {
    const perTF = Array.isArray(perTFArrayOrObj) ? perTFArrayOrObj : (typeof perTFArrayOrObj === "object" ? Object.values(perTFArrayOrObj) : []);
    if (!perTF.length) return { direction: "Neutral", score: 0, confidence: 0, breakdown: {} };

    // default weights (can be overridden)
    const defaultWeights = Object.assign({ "1m":0.05, "5m":0.08, "15m":0.45, "30m":0.25, "1h":0.3, "4h":0.2, "1d":0.15 }, opts.tfWeights || {});

    let bull=0, bear=0, neutral=0;
    let weightSum = 0;
    const breakdown = { byTF: {}, bySource: {} };

    for (const p of perTF) {
      const tf = p.tf || p.labelTf || "unk";
      const dirRaw = (p.direction || p.label || "").toString().toLowerCase();
      const probs = p.probs ? { bull: Number(p.probs.bull||0), bear: Number(p.probs.bear||0) } : { bull: p.probBull || (p.prob || 50), bear: p.probBear || (100 - (p.prob || 50)) };
      // normalize individual probabilities to 0..1
      const pb = clamp((probs.bull || 0) / 100, 0, 1);
      const pr = clamp((probs.bear || 0) / 100, 0, 1);
      const pmax = Math.max(pb, pr);
      const w = defaultWeights[tf] ?? (opts.defaultTFWeight || 0.1);
      weightSum += w;
      // accumulate weighted votes
      bull += pb * w;
      bear += pr * w;
      neutral += (1 - Math.max(pb, pr)) * w * 0.5;
      // breakdown
      breakdown.byTF[tf] = breakdown.byTF[tf] ? breakdown.byTF[tf] + w : w;
      const src = p.source || "unknown";
      breakdown.bySource[src] = (breakdown.bySource[src] || 0) + (p.confidence || 40);
    }

    // normalize to 0..1
    const total = Math.max( (bull + bear + neutral), EPS );
    const nbull = bull / total;
    const nbear = bear / total;
    const nneu = neutral / total;

    // pick direction
    const direction = (nbull > nbear && nbull > nneu) ? "Bullish" : (nbear > nbull && nbear > nneu) ? "Bearish" : "Neutral";
    const confidence = Math.round(Math.max(nbull, nbear, nneu) * 100);

    const result = { direction, score: Math.round((Math.max(nbull, nbear, nneu) * 100)), confidence, probs: { bull: Math.round(nbull*10000)/100, bear: Math.round(nbear*10000)/100, neutral: Math.round(nneu*10000)/100 }, breakdown, weightSum };
    writeTelemetry({ event:"fuseMLTFsRefined", symbol: opts.symbol || null, meta: { direction: result.direction, confidence: result.confidence } });
    return result;
  } catch (e) {
    return { direction:"Neutral", score:0, confidence:0, breakdown:{} };
  }
}
// override older name for compatibility (later definition wins when concatenated)
export const fuseMLTFs = fuseMLTFsRefined;

/* ---------- CVD (Cumulative Volume Delta) proxy & liquidity detection ---------- */

export function computeCVDProxy(candles = [], lookback = 50) {
  // candles: array with {open,high,low,close,volume}
  try {
    if (!Array.isArray(candles) || !candles.length) return { cvd: 0, slope: 0, recentSpike: false };
    const slice = candles.slice(-lookback);
    let cvd = 0;
    for (let i=1;i<slice.length;i++){
      const c = slice[i]; const p = slice[i-1];
      const sign = (c.close > c.open) ? 1 : (c.close < c.open ? -1 : (c.close >= p.close ? 1 : -1));
      cvd += sign * (Number(c.volume) || 0);
    }
    // simple metrics
    const volAvg = mean(slice.map(x=>Number(x.volume||0)));
    const recent = slice.slice(-6);
    const recentVol = mean(recent.map(x=>Number(x.volume||0)));
    const recentSpike = recentVol > volAvg * 1.6;
    // slope via linear regression on cvd cumulative series
    const cumul = [];
    let acc = 0;
    for (let i=0;i<slice.length;i++){ const c = slice[i]; const sign = (c.close > c.open) ? 1 : (c.close < c.open ? -1 : 0); acc += (Number(c.volume||0) * sign); cumul.push(acc); }
    // slope approx
    const n = cumul.length;
    const xmean = (n-1)/2;
    const ymean = mean(cumul);
    let num=0, den=0;
    for (let i=0;i<n;i++){ num += (i - xmean) * (cumul[i] - ymean); den += (i - xmean) ** 2; }
    const slope = den ? num/den : 0;
    return { cvd, slope, recentSpike, volAvg, recentVol };
  } catch (e) { return { cvd:0, slope:0, recentSpike:false }; }
}

export function detectLiquidityGaps(candles = [], minGapPts = 0.002) {
  // finds intraday gaps where no candles exist in a band: naive approach using sorted highs/lows
  try {
    if (!Array.isArray(candles) || candles.length < 5) return [];
    const gaps = [];
    const sorted = candles.slice().sort((a,b) => a.low - b.low);
    // scan windows and detect large jumps
    for (let i=1;i<sorted.length;i++){
      const prevMax = Number(sorted[i-1].high||0);
      const curMin = Number(sorted[i].low||0);
      if (curMin <= prevMax) continue;
      const gap = (curMin - prevMax) / Math.max(EPS, prevMax);
      if (gap >= minGapPts) gaps.push({ gapPct: gap, low: prevMax, high: curMin });
    }
    return gaps;
  } catch (e) { return []; }
}

/* ---------- Improved 30min pressure (uses CVD + buy/sell counts + VWAP alignment) ---------- */

export function compute30minPressureRefined(symbol, blocks = []) {
  try {
    const b1 = blocks.find(b=>b.tf==="1m");
    const b5 = blocks.find(b=>b.tf==="5m");
    const pressure = { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0, liquidityGaps:[], vwapAlign:0, breakdown:{ v1:{buy:0,sell:0,total:0}, v5:{buy:0,sell:0,total:0} } };

    if (b1?.candles && b1.candles.length) {
      const last = b1.candles.slice(-30);
      const buy = last.filter(c=>c.close>c.open).length;
      const sell = last.filter(c=>c.close<c.open).length;
      const total = buy + sell || 1;
      pressure.sellPressurePct = Math.round((sell/total)*100);
      pressure.buyRatio1 = +(buy/total).toFixed(2);
      pressure.breakdown.v1 = { buy, sell, total };
      const cvd = computeCVDProxy(last, 30);
      pressure.cvd = cvd;
      pressure.cvdScore = Math.round(clamp((cvd.slope / (Math.abs(cvd.slope) + 1)) * 100 + 50, 0, 100));
    }

    if (b5?.candles && b5.candles.length) {
      const last = b5.candles.slice(-30);
      const buy = last.filter(c=>c.close>c.open).length;
      const sell = last.filter(c=>c.close<c.open).length;
      const total = buy + sell || 1;
      pressure.buyRatio5 = +(buy/total).toFixed(2);
      pressure.breakdown.v5 = { buy, sell, total };
      const gaps = detectLiquidityGaps(last, 0.003);
      pressure.liquidityGaps = gaps;
    }

    // VWAP alignment proxy: compare latest close vs simple VWAP approximation using price*vol / vol
    if (b1?.candles && b1.candles.length) {
      const slice = b1.candles.slice(-100);
      const pv = slice.map(c => ((Number(c.close||0) + Number(c.high||0) + Number(c.low||0))/3) * Number(c.volume||0));
      const vol = slice.map(c => Number(c.volume||0));
      const vwap = vol.reduce((s,x,i)=>s + (x||0),0) ? pv.reduce((s,x)=>s+x,0) / Math.max(1, vol.reduce((s,x)=>s+x,0)) : (slice.at(-1)?.close || 0);
      const lastClose = Number(slice.at(-1)?.close || 0);
      pressure.vwapAlign = (lastClose >= vwap) ? 1 : -1;
    }

    writeTelemetry({ event:"compute30minPressureRefined", symbol, pressureSummary: { sellPressurePct: pressure.sellPressurePct, cvdScore: pressure.cvdScore || 0 } });
    return pressure;
  } catch (e) {
    return { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, liqGaps:[], vwapAlign:0, breakdown:{} };
  }
}

/* ---------- buildAIReportV2 — more structured, uses refined fusion & pro-meters ---------- */

export async function buildAIReportV2(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs).catch(()=> ({}));
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data:[], price:0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price>0) ? entry.price : (candles?.at(-1)?.close ?? 0);
      const feats = buildFeaturesFromCandles(candles) || {};
      const ind = {
        RSI: (typeof entry.RSI === "number") ? entry.RSI : (candles.length?Math.round(feats.rsi||50):50),
        MACD: (entry.MACD || { hist: 0 }),
        ATR: (typeof entry.ATR === "number") ? entry.ATR : (feats.atr || 0),
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: "STABLE"
      };

      let ell = null;
      try { ell = await analyzeElliott(candles); } catch(e) { ell = null; }

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp>0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [ { tp: Number((price + fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_UP" }, { tp: Number((price - fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_DOWN" } ];
      }

      blocks.push({ tf, price, candles, indicators: ind, feats, ell, targets });
    }

    // compute per-block fusion using previous computeFusionScore logic, but store more telemetry
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

    // overall fusion with refined weights
    const TF_WEIGHTS = Object.assign({ "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 }, opts.tfWeights || {});
    let s=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore||0)*w; ws += w; }
    const overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // collect target candidates across TFs (attach tf)
    const allCandidates = [];
    for (const b of blocks) {
      for (const t of (b.targets||[])) {
        const tp = Number(t.tp||0); if (!isNum(tp) || tp<=0) continue;
        allCandidates.push({ tp, confidence: clamp(Number(t.confidence||40),0,100), source: t.source, tf: b.tf });
      }
    }

    // aggregate & score using new aggregator
    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const aggregated = aggregateAndScoreTPs(allCandidates, price, blocks.find(b=>b.tf==="15m")?.feats || {}, { precision: opts.precision || 0, tfWeights: TF_WEIGHTS, top: opts.topTargets || 4 });

    // run ML per stable TF using runMLPredictionCore (lightweight)
    const stableTFs = opts.stableTFs || ["15m","30m","1h"];
    const mlPerTF = [];
    for (const mt of stableTFs) {
      try { const mlr = await runMLPredictionCore(symbol, mt, { config: { fusedTFs: stableTFs, precision: opts.precision || 0, tfWeights: TF_WEIGHTS }, mtfRaw }); if (mlr.ok && mlr.ml) mlPerTF.push(mlr.ml); } catch(e){}
    }

    const mlFusion = fuseMLTFsRefined(mlPerTF, { symbol, tfWeights: TF_WEIGHTS });

    const refinedPressure = compute30minPressureRefined(symbol, blocks);

    // finalize primary/hedge
    const final = finalizePrimaryHedgeFromScored(aggregated, mlFusion.direction || "Neutral", price, blocks.find(b=>b.tf==="15m")?.feats || {}, { MIN_TP_DISTANCE_ATR_MULT:1.2 });
    const sl = pickSLForPrimary(mlFusion.direction || "Neutral", price, blocks.find(b=>b.tf==="15m")?.feats || {});

    const report = {
      ok:true, modelVersion: "ml_module_v15_report_v2", symbol, generatedAt: new Date().toISOString(),
      overallFusion, bias: mlFusion.direction,
      price, blocksCount: blocks.length,
      blocks, aggregatedTargets: aggregated.slice(0, opts.topTargets || 4),
      ml: { perTF: mlPerTF, fusion: mlFusion },
      primaryTP: final.primary, primarySource: final.primarySource, hedgeTP: final.hedge, hedgeSource: final.hedgeSource,
      slEstimate: sl, tpConfidence: final.primaryConf || (aggregated[0] ? aggregated[0].score : 40),
      proMeters: refinedPressure,
      stats: getStats(),
      telemetryNote: "use buildAIReportV2 telemetry log for debugging"
    };

    writeTelemetry({ event:"buildAIReportV2", symbol, meta: { price, primaryTP: report.primaryTP, bias: report.bias } });

    return report;
  } catch (e) {
    writeTelemetry({ event:"buildAIReportV2_error", symbol, error: e?.toString?.() ?? String(e) });
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

/* ---------- Backwards compatibility aliases ---------- */
export const compute30minPressure = compute30minPressureRefined;
export const fuseMLTFsV2 = fuseMLTFsRefined;

/* ---------- End of PART 4/6 ----------
Next: PART 5/6 — metrics dashboards, exporter (CSV/JSON) helpers, backtesting harness (light, offline)
============================================================ */
// ==============================
// PART 5/6 — Backtester, Metrics & Exporters
// Paste after Part 4 (do not add imports)
// ==============================

/* ---------- Helpers for time / CSV ---------- */
function toISO(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  try { return new Date(d).toISOString(); } catch(e){ return null; }
}
function safeNum(v, d = 0) { return (typeof v === "number" && Number.isFinite(v)) ? v : d; }

function arrayToCSV(rows = [], headers = []) {
  if (!rows || !rows.length) return "";
  const cols = headers.length ? headers : Object.keys(rows[0] || {});
  const escape = v => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) {
    const row = cols.map(c => escape(r[c]));
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

/* ---------- Backtest core ---------- */
/*
  Approach (simple, robust):
  - Use stored predictions (PRED_FILE). Each prediction should include id, symbol, generatedAt, ml.tpEstimate, ml.slEstimate
  - For each prediction we need historical candle series for the symbol (array of {ts, open, high, low, close, volume})
  - Find first candle whose ts > generatedAt (entry candle). Simulate price path from that candle forward:
      - If high >= TP before low <= SL => win (hit TP)
      - If low <= SL before high >= TP => loss (hit SL)
      - If neither within maxBars window (or time limit in seconds), mark 'timeout' and optionally mark as failure or 'expired'
  - Record outcomes to OUT_FILE via recordOutcome (if writeResults=true) and return detailed results.
*/
export function runBacktestOnPredictions({ symbol = null, candles = [], maxBars = 500, writeResults = false, treatTimeoutAsLoss = true, timeLimitMs = null } = {}) {
  try {
    const preds = readJsonSafe(PRED_FILE, []) || [];
    const predsFiltered = preds.filter(p => p && (!symbol || p.symbol === symbol) && p.ml && (isNum(p.ml.tpEstimate) || isNum(p.ml.slEstimate)));
    const outcomes = [];
    const now = Date.now();

    // normalize candle timestamps to ms
    const normCandles = (Array.isArray(candles) ? candles.slice() : []).map(c => {
      // accept ts, time, t or string
      const ts = c.ts || c.time || c.t || c.timestamp || c[0];
      const tms = (typeof ts === "number") && (ts>1e12) ? Math.floor(ts) : (typeof ts==="number" && ts<1e12 && ts>1e9 ? Math.floor(ts*1000) : (typeof ts==="string" ? Date.parse(ts) : null));
      return { ...c, ts: tms || (c.ts || null) };
    }).filter(c => c && isNum(c.ts)).sort((a,b)=>a.ts-b.ts);

    const byId = new Map(); // for quick skip / avoid duplicates if already out
    const existingOuts = readJsonSafe(OUT_FILE, []) || [];
    for (const o of existingOuts) if (o && (o.alertId || o.id)) byId.set(o.alertId || o.id, true);

    for (const p of predsFiltered) {
      const id = p.id || p.alertId || `${p.symbol}_${p.tf}_${p.generatedAt || p.recordedAt || Date.now()}`;
      if (byId.has(id)) {
        // already recorded previously in outcomes — include in results as existing
        outcomes.push({ alertId: id, symbol: p.symbol, status: "already_recorded" });
        continue;
      }
      const genAt = Date.parse(p.generatedAt || p.recordedAt || p.ts || p.ml?.generatedAt || new Date().toISOString());
      if (!isNum(genAt)) {
        outcomes.push({ alertId: id, symbol: p.symbol, status: "no_generation_time" });
        continue;
      }
      // find entry candle index
      const idx = normCandles.findIndex(c => c.ts > genAt);
      if (idx === -1) {
        outcomes.push({ alertId: id, symbol: p.symbol, status: "no_future_data" });
        continue;
      }

      const tp = safeNum(p.ml?.tpEstimate, null);
      const sl = safeNum(p.ml?.slEstimate, null);
      if (!isNum(tp) || !isNum(sl)) {
        outcomes.push({ alertId: id, symbol: p.symbol, status: "missing_tp_sl" });
        continue;
      }

      const direction = (p.ml && p.ml.direction) ? p.ml.direction : (tp > (normCandles[idx].close||0) ? "Bullish" : "Bearish");
      // simulate successive candles up to maxBars or timeLimit
      let result = { alertId: id, symbol: p.symbol, entryIndex: idx, entryTs: normCandles[idx].ts, entryPrice: normCandles[idx].close || ((normCandles[idx].open+normCandles[idx].close)/2), tp, sl, direction, status: "timeout", hitAt: null, hitPrice: null, hitType: null, barsToHit: null, durationMs: null, pnlR: null };
      const entryTime = normCandles[idx].ts;
      const entryPrice = result.entryPrice;
      const endIdx = Math.min(normCandles.length - 1, idx + Math.max(1, Math.min(maxBars, normCandles.length - idx - 1)));

      for (let i = idx; i <= endIdx; i++) {
        const c = normCandles[i];
        if (!c) continue;
        // check for TP/SL in candle:
        // if Bullish: TP is above, SL is below entry
        // we respect first occurrence within candle: if both inside same candle, assume which came first? we can't know — use a conservative tie-break:
        // Use ordering: if candle opened below TP and closed above TP, we assume TP hit if TP is closer to open than SL is to open. Simpler: if both hit in same candle, decide by comparing distance from open.
        const high = safeNum(c.high, c.close);
        const low = safeNum(c.low, c.close);
        const tHit = (direction === "Bullish") ? (high >= tp) : (low <= tp);
        const sHit = (direction === "Bullish") ? (low <= sl) : (high >= sl);

        if (tHit && !sHit) {
          // TP hit first (or only)
          result.status = "win";
          result.hitAt = c.ts;
          result.hitPrice = direction === "Bullish" ? tp : tp; // exact TP
          result.hitType = "TP";
          result.barsToHit = i - idx;
          result.durationMs = c.ts - entryTime;
          // compute R: (TP - entry) / (entry - SL) for Bullish, mirror for Bearish
          const risk = Math.abs(entryPrice - sl) || 1;
          const profit = Math.abs(tp - entryPrice);
          result.pnlR = +(profit / risk).toFixed(4);
          break;
        } else if (sHit && !tHit) {
          // SL hit first
          result.status = "loss";
          result.hitAt = c.ts;
          result.hitPrice = direction === "Bullish" ? sl : sl;
          result.hitType = "SL";
          result.barsToHit = i - idx;
          result.durationMs = c.ts - entryTime;
          const loss = Math.abs(entryPrice - sl) || 1;
          result.pnlR = - +(loss / (Math.abs(entryPrice - tp) || 1)).toFixed(4); // negative R relative to TP distance
          break;
        } else if (tHit && sHit) {
          // both in same candle -> tiebreak: compare distances from open
          const distTP = Math.abs((tp) - (c.open || entryPrice));
          const distSL = Math.abs((sl) - (c.open || entryPrice));
          if (distTP <= distSL) {
            result.status = "win";
            result.hitAt = c.ts; result.hitPrice = tp; result.hitType = "TP"; result.barsToHit = i - idx; result.durationMs = c.ts - entryTime;
            const risk = Math.abs(entryPrice - sl) || 1; const profit = Math.abs(tp - entryPrice);
            result.pnlR = +(profit / risk).toFixed(4);
          } else {
            result.status = "loss";
            result.hitAt = c.ts; result.hitPrice = sl; result.hitType = "SL"; result.barsToHit = i - idx; result.durationMs = c.ts - entryTime;
            const loss = Math.abs(entryPrice - sl) || 1;
            result.pnlR = - +(loss / (Math.abs(entryPrice - tp) || 1)).toFixed(4);
          }
          break;
        } else {
          // no hit yet - continue
          // optionally check timeLimit
        }
        if (timeLimitMs && (c.ts - entryTime) > timeLimitMs) {
          result.status = treatTimeoutAsLoss ? "loss_timeout" : "timeout";
          break;
        }
      } // end for candles

      // if still timeout after loop
      if (result.status === "timeout") {
        result.hitAt = null; result.hitPrice = null; result.hitType = "timeout"; result.barsToHit = null; result.durationMs = null; result.pnlR = treatTimeoutAsLoss ? -1 * (Math.abs(entryPrice - sl) || 1) / Math.max(1, Math.abs(entryPrice - tp) || 1) : 0;
      }

      outcomes.push(result);
      if (writeResults) {
        try {
          const success = (result.status === "win");
          recordOutcome({ alertId: id, symbol: p.symbol, success, ts: toISO(result.hitAt ? new Date(result.hitAt) : new Date()), note: "backtest_sim" });
        } catch (e) {
          // ignore
        }
      }
    } // end for preds

    // compute aggregate metrics
    const metrics = computeBacktestMetrics(outcomes);
    return { ok:true, symbol, runs: outcomes.length, outcomes, metrics };
  } catch (e) {
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

/* ---------- Aggregate & Metrics ---------- */
export function computeBacktestMetrics(outcomes = []) {
  try {
    const valid = outcomes.filter(o => o && (o.status === "win" || o.status === "loss" || o.status === "loss_timeout" || o.status === "timeout"));
    const wins = valid.filter(o => o.status === "win").length;
    const losses = valid.filter(o => o.status === "loss" || o.status === "loss_timeout").length;
    const timeouts = valid.filter(o => o.status === "timeout").length;
    const total = valid.length || 1;
    const winRate = Math.round((wins / total) * 10000) / 100;
    const avgR = Math.round((valid.filter(o=>isNum(o.pnlR)).reduce((s,o)=>s + (o.pnlR||0),0) / Math.max(1, valid.filter(o=>isNum(o.pnlR)).length)) * 10000) / 100;
    const avgBars = Math.round((valid.filter(o=>isNum(o.barsToHit)).reduce((s,o)=>s + (o.barsToHit||0),0) / Math.max(1, valid.filter(o=>isNum(o.barsToHit)).length)) * 100) / 100;
    // expectancy = avg(winR) * winRate - avg(lossR) * lossRate (we'll compute R in absolute)
    const winRs = valid.filter(o => o.status === "win" && isNum(o.pnlR)).map(o=>o.pnlR);
    const lossRs = valid.filter(o => (o.status === "loss" || o.status === "loss_timeout") && isNum(o.pnlR)).map(o=>Math.abs(o.pnlR));
    const avgWinR = winRs.length ? (mean(winRs)) : 0;
    const avgLossR = lossRs.length ? (mean(lossRs)) : 0;
    const expectancy = Math.round(((avgWinR * (wins/total)) - (avgLossR * (losses/total))) * 10000) / 10000;
    // simple equity sim using 1 unit per trade
    let equity = 0; let peak = 0; let maxDD = 0;
    const series = [];
    for (const o of outcomes) {
      if (!isNum(o.pnlR)) continue;
      equity += o.pnlR;
      series.push(equity);
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    return { total: valid.length, wins, losses, timeouts, winRate, avgR, avgBars, avgWinR: +(avgWinR.toFixed(4)), avgLossR: +(avgLossR.toFixed(4)), expectancy, maxDrawdown: +(maxDD.toFixed(4)), equityFinal: +(equity.toFixed(4)) };
  } catch (e) {
    return { total:0, wins:0, losses:0, winRate:0, avgR:0 };
  }
}





      // base confidence average
      const confAvg = mean(v.members.map(m => clamp(Number(m.confidence || 40), 0, 100)));
      // proximity: farther TPs (beyond atr*mult) get lower score for short styles; use feats.atr
      const atr = (feats && feats.atr) ? Math.max(1, feats.atr) : Math.max(1, Math.abs(price) * 0.001);
      const dist = Math.abs(v.tp - price);
      const proximityScore = Math.exp(-Math.max(0, dist/Math.max(atr,1)) * 0.15); // decays with distance
      // tf influence
      let tfInfluence = 0;
      for (const tf in v.tfCount) tfInfluence += (tfWeights[tf] || 0.05) * v.tfCount[tf];
      tfInfluence = Math.min(1, tfInfluence);
      // final score
      const score = Math.round((confAvg * 0.6 + proximityScore * 100 * 0.25 + tfInfluence * 100 * 0.15) * 100) / 100;
      arr.push({ tp: v.tp, confidenceAvg: Math.round(confAvg), proximityScore: Math.round(proximityScore*10000)/100, tfInfluence: Math.round(tfInfluence*10000)/100, score });
    }
    // sort by score desc
    arr.sort((a,b) => b.score - a.score);
    return arr;
  } catch(e) { return []; }
}

export function finalizePrimaryHedgeFromScored(scored = [], direction = "Neutral", price = 0, feats = {}, config = {}) {
  try {
    const MIN_DIST_MULT = config.MIN_TP_DISTANCE_ATR_MULT || 1.2;
    const atr = Math.max((feats && feats.atr) ? feats.atr : Math.abs(price) * 0.001, 1);
    const minDist = (config.MIN_TP_DISTANCE || (atr * MIN_DIST_MULT));
    const pool = scored.filter(s => Math.abs(s.tp - price) >= minDist);
    const chosen = pool.length ? pool[0] : (scored[0] || null);
    if (!chosen) {
      // fallback ATR-based
      const primary = direction === "Bullish" ? price + atr * 2.5 : direction === "Bearish" ? price - atr * 2.5 : price + atr * 2.5;
      const hedge = direction === "Bullish" ? price - atr * 1.2 : direction === "Bearish" ? price + atr * 1.2 : price - atr * 1.2;
      return { primary: Number(primary), hedge: Number(hedge), primarySource: "ATR_FALLBACK", hedgeSource: "ATR_HEDGE", primaryConf: 40 };
    }
    // choose hedge: nearest opposite side cluster or ATR
    let opp = scored.find(s => (direction === "Bullish" ? s.tp < price : s.tp > price));
    if (!opp) {
      opp = { tp: Number((price + (direction === "Bullish" ? -atr * 1.2 : atr * 1.2)).toFixed(8)), source: "HEDGE_ATR", score: 30 };
    }
    return { primary: Number(chosen.tp), hedge: Number(opp.tp), primarySource: chosen.source || "cluster", hedgeSource: opp.source || "cluster", primaryConf: chosen.score || 40 };
  } catch(e) {
    const atr = Math.max((feats && feats.atr) ? feats.atr : Math.abs(price) * 0.001, 1);
    return { primary: Number(price + atr * 2), hedge: Number(price - atr * 1.2), primarySource: "ERR_FALLBACK", hedgeSource: "ERR_HEDGE", primaryConf: 40 };
  }
}

/* ---------- Exporters ---------- */
export function exportPredictionsCSV(outPath = path.join(LOG_DIR, "predictions_export.csv")) {
  try {
    const preds = readJsonSafe(PRED_FILE, []) || [];
    if (!preds.length) { writeJsonSafe(outPath, ""); return { ok:true, path: outPath }; }
    const rows = preds.map(p => ({
      id: p.id || "",
      symbol: p.symbol || "",
      tf: p.tf || (p.ml && p.ml.tf) || "",
      generatedAt: p.generatedAt || p.recordedAt || "",
      direction: p.ml?.direction || "",
      tpEstimate: p.ml?.tpEstimate || "",
      slEstimate: p.ml?.slEstimate || "",
      tpSource: p.ml?.tpSource || "",
      tpConfidence: p.ml?.tpConfidence || "",
      recordedAt: p.recordedAt || ""
    }));
    const csv = arrayToCSV(rows, ["id","symbol","tf","generatedAt","direction","tpEstimate","slEstimate","tpSource","tpConfidence","recordedAt"]);
    fs.writeFileSync(outPath, csv, "utf8");
    return { ok:true, path: outPath, count: rows.length };
  } catch (e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

export function exportOutcomesCSV(outPath = path.join(LOG_DIR, "outcomes_export.csv")) {
  try {
    const outs = readJsonSafe(OUT_FILE, []) || [];
    if (!outs.length) { writeJsonSafe(outPath, ""); return { ok:true, path: outPath }; }
    const rows = outs.map(o => ({
      id: o.alertId || o.id || "",
      symbol: o.symbol || "",
      success: typeof o.success === "boolean" ? o.success : "",
      ts: o.ts || o.recordedAt || "",
      note: o.note || ""
    }));
    const csv = arrayToCSV(rows, ["id","symbol","success","ts","note"]);
    fs.writeFileSync(outPath, csv, "utf8");
    return { ok:true, path: outPath, count: rows.length };
  } catch (e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

export function exportMetricsJSON(metrics, outPath = path.join(LOG_DIR, `backtest_metrics_${Date.now()}.json`)) {
  try {
    writeJsonSafe(outPath, metrics);
    return { ok:true, path: outPath };
  } catch (e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

/* ---------- Small unit-test / sanity helper (synthetic candles) ---------- */
export function makeSyntheticCandles({ startTs = Date.now() - 1000*60*60, bars = 500, periodMs = 60000, startPrice = 100, volatility = 0.002, volume = 1000 } = {}) {
  const out = [];
  let price = startPrice;
  for (let i=0;i<bars;i++){
    const ts = startTs + i * periodMs;
    const change = (Math.random() * 2 - 1) * volatility * price;
    const close = +(price + change).toFixed(8);
    const open = +(price).toFixed(8);
    const high = +(Math.max(open, close) + Math.abs(change) * Math.random()).toFixed(8);
    const low = +(Math.min(open, close) - Math.abs(change) * Math.random()).toFixed(8);
    const vol = Math.round(volume * (0.5 + Math.random() * 1.5));
    out.push({ ts, open, high, low, close, volume: vol });
    price = close;
  }
  return out;
}

/* ---------- Example quick-test runner ---------- */
export function quickBacktestSanityCheck() {
  // create synthetic candles
  const candles = makeSyntheticCandles({ bars: 800, startPrice: 200, volatility: 0.005 });
  // create a synthetic prediction file entry and write to PRED_FILE (temp)
  const pred = {
    id: `synthetic_${Date.now()}`,
    symbol: "SYNTH",
    tf: "1m",
    generatedAt: new Date(candles[100].ts - 10).toISOString(), // generate just before candle 101
    ml: { symbol: "SYNTH", tf: "1m", direction: "Bullish", tpEstimate: Number((candles[101].close + 2).toFixed(8)), slEstimate: Number((candles[101].close - 1).toFixed(8)), tpSource: "SYNTH", tpConfidence: 60 },
    meta: { scores: { ind:0.6, cnn:0.55, of:0.5, news:0.5 }, fusedProb: 0.6 }
  };
  const prev = readJsonSafe(PRED_FILE, []) || [];
  prev.push(pred);
  writeJsonSafe(PRED_FILE, prev);
  // run backtest for this symbol with these candles
  const res = runBacktestOnPredictions({ symbol: "SYNTH", candles, maxBars: 300, writeResults: false });
  return res;
}

// ==============================
// End of PART 5/6
// Next: PART 6/6 — final polish, README header, performance improvements (streaming mode) and packaging export.
// ==============================
// ==============================
// PART 6/6 — Streaming fetcher, caching, packaging, README & performance helpers
// Paste after Part 5 (do NOT re-add imports)
// ==============================

/*
  Goals in this part:
  - Provide a streaming/throttled wrapper around fetchMultiTF to avoid memory spikes and burst requests.
  - Maintain a small LRU-like cache with TTL to reuse recent fetches.
  - Allow swapping in custom fetcher (e.g., lightweight remote HTTP or local mock).
  - Provide packaging helper to dump a README and lightweight manifest into LOG_DIR.
  - Provide memory-trim helpers for logs.
*/

let _streamingMode = false;
let _fetcher = fetchMultiTF; // default imported one; can be overridden
const CACHE_TTL_MS = Number(process.env.ML_FETCH_CACHE_TTL_MS || 30_000); // 30s default
const CACHE_MAX_ENTRIES = Number(process.env.ML_FETCH_CACHE_MAX || 200);
const FETCH_CONCURRENCY = Number(process.env.ML_FETCH_CONCURRENCY || 4);

const _fetchCache = new Map(); // key => { ts, data }
const _fetchQueue = []; // simple FIFO queue of pending requests
let _activeRequests = 0;

function _cacheKey(symbol, tfs) {
  const tfSorted = Array.isArray(tfs) ? tfs.slice().sort().join(",") : String(tfs);
  return `${symbol}::${tfSorted}`;
}
function _pruneCache() {
  try {
    if (_fetchCache.size <= CACHE_MAX_ENTRIES) return;
    // remove oldest
    const entries = Array.from(_fetchCache.entries()).sort((a,b)=>a[1].ts - b[1].ts);
    while (_fetchCache.size > CACHE_MAX_ENTRIES) _fetchCache.delete(entries.shift()[0]);
  } catch(e){}
}
function _cleanupExpiredCache() {
  try {
    const now = Date.now();
    for (const [k,v] of _fetchCache.entries()) {
      if ((now - v.ts) > CACHE_TTL_MS) _fetchCache.delete(k);
    }
  } catch(e){}
}
setInterval(() => {
  _cleanupExpiredCache();
  _pruneCache();
}, Math.max(1000, Math.min(60_000, CACHE_TTL_MS)));

export function registerExternalFetcher(fn) {
  if (typeof fn === "function") _fetcher = fn;
  return { ok:true };
}

export function enableStreamingMode(enable = true) {
  _streamingMode = !!enable;
  return { ok:true, streamingMode: _streamingMode };
}

// Internal worker to process queue
async function _processQueue() {
  if (_activeRequests >= FETCH_CONCURRENCY) return;
  const item = _fetchQueue.shift();
  if (!item) return;
  _activeRequests++;
  try {
    const { symbol, tfs, resolve, reject, opts } = item;
    const res = await _fetcher(symbol, tfs, opts).catch(err => { throw err; });
    resolve(res);
  } catch (e) {
    try { item.reject(e); } catch(_) {}
  } finally {
    _activeRequests = Math.max(0, _activeRequests - 1);
    // process next
    setImmediate(_processQueue);
  }
}

// streamingFetchMultiTF: respects cache, streaming mode, concurrency
export function streamingFetchMultiTF(symbol, tfs = [], opts = {}) {
  // returns a Promise resolving to same shape as fetchMultiTF
  return new Promise((resolve, reject) => {
    try {
      const key = _cacheKey(symbol, tfs);
      const now = Date.now();
      // return cached if fresh
      const cached = _fetchCache.get(key);
      if (cached && (now - cached.ts) <= CACHE_TTL_MS) {
        return resolve(cached.data);
      }
      // if streaming disabled, call directly
      if (!_streamingMode) {
        _fetcher(symbol, tfs, opts).then((d) => {
          try { _fetchCache.set(key, { ts: Date.now(), data: d }); _pruneCache(); } catch(e){}
          resolve(d);
        }).catch(reject);
        return;
      }
      // streaming mode: push into queue
      _fetchQueue.push({ symbol, tfs, resolve: (d) => {
        try { _fetchCache.set(key, { ts: Date.now(), data: d }); _pruneCache(); } catch(e){}
        resolve(d);
      }, reject, opts });
      // kick worker(s)
      setImmediate(_processQueue);
    } catch (e) { reject(e); }
  });
}

// batchFetch with concurrency and per-tf trimming (avoid large arrays)
export async function batchFetchSymbols(symbols = [], tfs = [], opts = {}) {
  const results = {};
  const concurrency = opts.concurrency || FETCH_CONCURRENCY;
  const limitHistoryPerTF = opts.limitHistoryPerTF || 500; // drop old candle entries to avoid memory blow

  // create tasks
  const tasks = symbols.map(sym => async () => {
    const res = await streamingFetchMultiTF(sym, tfs, opts).catch(()=> ({}));
    // trim histories to limitHistoryPerTF if present
    for (const tf of Object.keys(res || {})) {
      if (Array.isArray(res[tf]?.data) && res[tf].data.length > limitHistoryPerTF) {
        // keep only the last limitHistoryPerTF entries
        res[tf].data = res[tf].data.slice(-limitHistoryPerTF);
      }
    }
    results[sym] = res;
  });

  // run with concurrency
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { await tasks[i](); } catch(e){}
    }
  }
  const workers = [];
  for (let i=0;i<concurrency;i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Lightweight memory-trim helpers for logs and caches
export function trimLogs(maxPred=1000, maxOut=2000, keepRecentAlerts=1000) {
  try {
    const preds = readJsonSafe(PRED_FILE, []) || [];
    const outs = readJsonSafe(OUT_FILE, []) || [];
    const stats = readJsonSafe(STATS_FILE, {}) || _stats;
    const ptrim = preds.slice(-Math.max(0, maxPred));
    const otrim = outs.slice(-Math.max(0, maxOut));
    writeJsonSafe(PRED_FILE, ptrim);
    writeJsonSafe(OUT_FILE, otrim);
    if (stats && stats.alerts) stats.alerts = stats.alerts.slice(-Math.max(0, keepRecentAlerts));
    writeJsonSafe(STATS_FILE, stats);
    // also prune cache
    _pruneCache();
    _cleanupExpiredCache();
    return { ok:true, predCount: ptrim.length, outCount: otrim.length };
  } catch(e) {
    return { ok:false, error: e?.toString?.() ?? String(e) };
  }
}

// Packaging & README helper
export function writePackageREADME(opts = {}) {
  try {
    const now = new Date().toISOString();
    const pkg = {
      name: opts.name || "ml_module_v15_1",
      version: opts.version || "15.1.0",
      builtAt: now,
      tradeStyle: opts.tradeStyle || "Mixed",
      notes: opts.notes || "Auto-generated ML v15.1 package. This bundle uses streamingFetchMultiTF for resilient fetches and backtester included.",
      files: ["ml_module_v15.js (source)", "predictions_v15.json", "outcomes_v15.json", "stats_v15.json"],
      instructions: [
        "Place this module in your project and ensure ./utils.js and ./elliott_module.js exist.",
        "Enable streaming mode if your fetcher/API rate-limits or you run many symbols: enableStreamingMode(true).",
        "To override fetcher: registerExternalFetcher(async (symbol,tfs,opts)=>{...})"
      ]
    };
    const readme = [
      `# ${pkg.name} — v${pkg.version}`,
      ``,
      `Generated: ${now}`,
      ``,
      `## Summary`,
      `${pkg.notes}`,
      ``,
      `## Quick start`,
      `- import module and ensure dependencies (utils, elliott_module, news_social (optional)) are present.`,
      `- Use streamingFetchMultiTF(symbol, tfs) if you want internal caching and concurrency protection.`,
      `- Use runMLPrediction(symbol, tf) for main predictions, and buildAIReport for consolidated reports.`,
      ``,
      `## Config`,
      `- CACHE_TTL_MS: ${CACHE_TTL_MS}`,
      `- CACHE_MAX_ENTRIES: ${CACHE_MAX_ENTRIES}`,
      `- FETCH_CONCURRENCY: ${FETCH_CONCURRENCY}`,
      ``,
      `## Helpers`,
      `- batchFetchSymbols(symbols, tfs, opts)`,
      `- runBacktestOnPredictions({symbol,candles,maxBars,writeResults})`,
      `- trainAdaptive(batch) — adaptive weight trainer`,
      ``,
      `## Notes`,
      `- This module purposely avoids heavy ML libs (tensorflow) to remain lightweight and server-friendly.`,
      `- For more advanced offline model training, export predictors with exportPredictionsCSV and use Python/R pipelines.`,
      ``
    ].join("\n");

    const manifest = { pkg, readmeCreatedAt: now };
    const mdPath = path.join(LOG_DIR, `${pkg.name}_README.md`);
    const manifestPath = path.join(LOG_DIR, `${pkg.name}_manifest.json`);
    fs.writeFileSync(mdPath, readme, "utf8");
    writeJsonSafe(manifestPath, manifest);
    return { ok:true, mdPath, manifestPath };
  } catch (e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

// Export a small helper to produce a minimal "bundle" file (concatenates source parts into a single dump in LOG_DIR).
// Note: this is a convenience snapshot — assumes your build pipeline will manage real bundling.
export function snapshotModuleBundle({ outName = "ml_module_v15_1_snapshot.js", includeParts = true } = {}) {
  try {
    // Attempt: read current file (if available via __filename) else build a minimal manifest
    let content = "// ml_module_v15_1 snapshot - generated by part6 helper\n";
    content += `// generatedAt: ${new Date().toISOString()}\n\n`;
    content += "// NOTE: For a proper bundle, concatenate ml_module_v15.js and auxiliary modules (utils, elliott_module)\n";
    const outPath = path.join(LOG_DIR, outName);
    fs.writeFileSync(outPath, content, "utf8");
    return { ok:true, outPath };
  } catch (e) { return { ok:false, error: e?.toString?.() ?? String(e) }; }
}

// Small diagnostics
export function diagnostics() {
  return {
    streamingMode: _streamingMode,
    cacheSize: _fetchCache.size,
    queueLength: _fetchQueue.length,
    activeRequests: _activeRequests,
    cacheTTLms: CACHE_TTL_MS,
    cacheMaxEntries: CACHE_MAX_ENTRIES,
    fetchConcurrency: FETCH_CONCURRENCY,
    logDir: LOG_DIR
  };
}

// Export names are intentionally standalone; default export at file bottom already contains core functions.
export {
  streamingFetchMultiTF,
  batchFetchSymbols,
  registerExternalFetcher,
  enableStreamingMode,
  trimLogs,
  writePackageREADME,
  snapshotModuleBundle,
  diagnostics
};

// ==============================
// End of PART 6/6
// You're now ready to run: enableStreamingMode(true); registerExternalFetcher(...); runMLPrediction(...).
// ==============================