// ml_module_v8_6.js
// V13 Stable Dual-TP implementation (keeps filename per request)
// Features:
// - Uses multi-TF fusion for stable TP: 15m, 30m, 1h, 4h
// - Does NOT use 1m/5m for TP calculation (only micro-confirmation allowed)
// - Dual TP: TP1 (conservative), TP2 (aggressive)
// - Elliott override if high-confidence Elliott targets exist
// - Hybrid SL: pivot (Elliott) -> swing -> ATR fallback
// - Stability rules: TP moves only if fusion change > 8% OR ATR change > 12%
// - Accuracy bookkeeping (per-alert + aggregate) persisted to disk
// - Adaptive blending of indicator/CNN/Orderflow/News
// - Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction,
//            recordOutcome, markOutcome, getStats, trainAdaptive, resetStats
//
// NOTE: This file intentionally keeps TFJS optional (deterministic fallback used).

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

// safe news accessor
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// optional tfjs (non-blocking)
let tf = null;
let useTF = false;
try {
  tf = (() => { try { return require("@tensorflow/tfjs-node"); } catch (e) { return null; } })();
  if (tf) useTF = true;
} catch (e) { tf = null; useTF = false; }

// ---------------- Paths & persistence ----------------
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v8_6_logs");
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const STATS_FILE = path.join(LOG_DIR, "stats.json");
const LAST_TP_FILE = path.join(LOG_DIR, "last_tps.json");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const EPS = 1e-12;
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d = 2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";
const mean = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

// ---------------- In-memory and persisted stats ----------------
let memPreds = [];
let memOuts = [];
let lastTPs = {}; // structure: { "<symbol>": { tf: { tp1, tp2, atr, fusedProb } } }
let _stats = { total: 0, wins: 0, losses: 0, alerts: [], adaptiveWeights: null, lastUpdated: null, accuracyCache: null };

try {
  if (fs.existsSync(STATS_FILE)) {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    if (raw) _stats = Object.assign(_stats, JSON.parse(raw));
  }
} catch (e) {}
try {
  if (fs.existsSync(LAST_TP_FILE)) {
    const raw = fs.readFileSync(LAST_TP_FILE, "utf8");
    if (raw) lastTPs = JSON.parse(raw);
  }
} catch (e) { lastTPs = {}; }

function writeSafe(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
}
function readJsonSafe(file) {
  try { if (!fs.existsSync(file)) return []; const txt = fs.readFileSync(file, "utf8"); return JSON.parse(txt || "[]"); } catch (e) { return []; }
}
function saveStats() {
  try { _stats.lastUpdated = new Date().toISOString(); writeSafe(STATS_FILE, _stats); } catch (e) {}
}
function saveLastTPs() {
  try { writeSafe(LAST_TP_FILE, lastTPs); } catch (e) {}
}

// ---------------- Recording helpers ----------------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeSafe(PRED_FILE, arr)) memPreds.push(pred);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id, symbol: pred.symbol, ts: new Date().toISOString(), meta: pred.meta || null });
    if (_stats.alerts.length > 2000) _stats.alerts.shift();
    saveStats();
  } catch (e) { memPreds.push(pred); }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    if (!writeSafe(OUT_FILE, arr)) memOuts.push(outcome);
    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1; else _stats.losses = (_stats.losses || 0) + 1;
    _stats.accuracyCache = null;
    saveStats();
  } catch (e) { memOuts.push(outcome); }
}

export function calculateAccuracy() {
  try {
    if (_stats.accuracyCache) return _stats.accuracyCache;
    const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
    const total = outs.length || (_stats.total || 0);
    if (!total) { const res = { accuracy: 0, total: 0, correct: 0 }; _stats.accuracyCache = res; return res; }
    const correct = outs.filter(o => o && o.success).length || (_stats.wins || 0);
    const acc = Math.round((correct / total) * 10000) / 100;
    const res = { accuracy: acc, total, correct };
    _stats.accuracyCache = res;
    return res;
  } catch (e) { return { accuracy: 0, total: 0, correct: 0 }; }
}

// ---------------- Adaptive weights ----------------
if (!_stats.adaptiveWeights) {
  _stats.adaptiveWeights = { w_ind: 0.45, w_cnn: 0.25, w_of: 0.2, w_news: 0.1, lr: 0.02 };
  saveStats();
}
function fuseScores(scores, weights) {
  const newsNorm = (isFiniteNum(scores.news) ? scores.news : 0.5);
  const ind = clamp(scores.ind ?? 0.5, 0, 1);
  const cnn = clamp(scores.cnn ?? 0.5, 0, 1);
  const of = clamp(scores.of ?? 0.5, 0, 1);
  const w = weights || _stats.adaptiveWeights;
  const fused = ind * w.w_ind + cnn * w.w_cnn + of * w.w_of + newsNorm * w.w_news;
  return { fused, breakdown: { ind, cnn, of, news: newsNorm }, weights: w };
}
function updateAdaptiveWeights(trueLabel, predProb, features = {}) {
  try {
    const w = _stats.adaptiveWeights;
    if (!w) return;
    const lr = w.lr || 0.02;
    const y = trueLabel === "Bullish" ? 1 : trueLabel === "Bearish" ? 0 : 0.5;
    const err = y - predProb;
    const contrib = features.breakdown || { ind: 0.5, cnn: 0.5, of: 0.5, news: 0.5 };
    w.w_ind = clamp(w.w_ind + lr * err * (contrib.ind - 0.5), 0.05, 0.8);
    w.w_cnn = clamp(w.w_cnn + lr * err * (contrib.cnn - 0.5), 0.05, 0.6);
    w.w_of = clamp(w.w_of + lr * err * (contrib.of - 0.5), 0.05, 0.6);
    w.w_news = clamp(w.w_news + lr * err * (contrib.news - 0.5), 0.01, 0.3);
    const s = w.w_ind + w.w_cnn + w.w_of + w.w_news;
    w.w_ind /= s; w.w_cnn /= s; w.w_of /= s; w.w_news /= s;
    _stats.adaptiveWeights = w;
    saveStats();
  } catch (e) {}
}

// ---------------- Indicators & features ----------------
function computeATRFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, prevClose = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.length ? mean(recent) : mean(trs);
}
function computeRSIFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = (candles[i].close || 0) - (candles[i-1].close || 0);
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period || 0;
  const avgLoss = losses / period || 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeOrderFlowFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return {};
  const n = candles.length;
  const last = candles[n-1], prev = candles[n-2];
  const delta = (last.close - last.open) * (last.volume || 1);
  const vel = last.close - prev.close;
  const window = candles.slice(Math.max(0, n-6), n);
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow = Math.min(...window.map(c => c.low));
  let sweep = null;
  if (last.high > swingHigh && last.close < swingHigh) sweep = { side: "BearishSweep", priorHigh: swingHigh };
  if (last.low < swingLow && last.close > swingLow) sweep = { side: "BullishSweep", priorLow: swingLow };
  return { delta, vel, sweep };
}

// deterministic candle vision fallback
function candleVisionHeuristic(candles, lookback = 6) {
  if (!Array.isArray(candles) || !candles.length) return { label: "Neutral", probs: { bull:33.33, bear:33.33, neutral:33.33 }, features: {} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const bodies = last.map(c => Math.abs((c.close||0) - (c.open||0)));
  const ranges = last.map(c => (c.high||0) - (c.low||0));
  const avgRange = mean(ranges) || 1;
  const lastC = last[last.length-1];
  const body = Math.abs((lastC.close||0) - (lastC.open||0)) || 1;
  const lowerWick = Math.min(lastC.close, lastC.open) - lastC.low;
  const upperWick = lastC.high - Math.max(lastC.close, lastC.open);
  let bullScore = 0, bearScore = 0;
  const momentum = (last[last.length-1].close - last[0].close) / Math.max(EPS, last[0].close);
  bullScore += clamp(momentum * 10, -10, 10);
  if (lowerWick > body * 1.8 && upperWick < body * 0.6) bullScore += 3;
  if (upperWick > body * 1.8 && lowerWick < body * 0.6) bearScore += 3;
  if (lastC.close > lastC.open && body > avgRange * 0.6) bullScore += 2;
  if (lastC.open > lastC.close && body > avgRange * 0.6) bearScore += 2;
  const vols = last.map(c => c.volume || 0);
  const avgVol = mean(vols.slice(0, -1)) || 1;
  const lastVol = vols[vols.length-1] || 0;
  if (avgVol > 0 && lastVol > avgVol * 1.3) bullScore += 1.0;
  let pb = clamp(50 + bullScore * 4, 0, 100);
  let pr = clamp(50 + bearScore * 4, 0, 100);
  let pn = clamp(100 - (pb + pr), 0, 100);
  if (pn < 0) {
    const s = pb + pr || 1; pb = (pb / s) * 100; pr = (pr / s) * 100; pn = 0;
  }
  pb = Math.round(pb * 100) / 100; pr = Math.round(pr * 100) / 100; pn = Math.round(pn * 100) / 100;
  const label = pb > pr && pb > pn ? "Bullish" : pr > pb && pr > pn ? "Bearish" : "Neutral";
  return { label, probs: { bull: pb, bear: pr, neutral: pn }, features: { momentum, lowerWick, upperWick, lastVol, avgVol } };
}

// ---------------- Indicator & fusion layer ----------------
function indicatorLayer(feats) {
  if (!feats) return { score: 0.5, details: {} };
  const { slope = 0, mom3 = 0, rsi = 50, avgVol = 1, lastVol = 0, close = 0 } = feats;
  let s = 0;
  s += clamp((Math.tanh(slope / Math.max(1, Math.abs(close || 1))) + 0.5), 0, 1) * 0.5;
  s += clamp((0.5 + Math.tanh(mom3 * 6) / 2), 0, 1) * 0.3;
  if (isFiniteNum(rsi)) {
    const rnorm = clamp((rsi - 30) / 40, 0, 1);
    s = s * 0.9 + rnorm * 0.1;
  }
  if (avgVol > 0) {
    const vscore = clamp(lastVol / avgVol, 0, 2) / 2;
    s = s * 0.9 + vscore * 0.1;
  }
  return { score: clamp(s, 0, 1), details: { slope, mom3, rsi } };
}

// ---------------- TP/SL builder (multi-TF fused) ----------------
// IMPORTANT: TP generation uses high-stability TFs only: 15m, 30m, 1h, 4h
function buildTFTargetsFromTFData(mtf, price) {
  // mtf: { "15m": { data: [], price }, "30m": {...}, ... }
  const TFs = ["15m","30m","1h","4h"];
  const targets = [];
  for (const tf of TFs) {
    const entry = mtf[tf];
    if (!entry || !Array.isArray(entry.data) || entry.data.length < 3) continue;
    const candles = entry.data;
    // compute ATR on that TF
    const atr = computeATRFromCandles(candles, 14) || 0;
    // attempt Elliott targets for that TF
    try {
      const ell = analyzeElliott ? analyzeElliott(candles) : null;
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        for (const t of ell.targets) {
          const tp = Number(t.tp || t.price || t.target || 0);
          if (!isFiniteNum(tp) || tp <= 0) continue;
          targets.push({ tp, source: `Elliott:${tf}`, confidence: Math.min(100, Math.round(t.confidence || ell.confidence || 40)), tf, atr });
        }
      } else {
        // fallback ATR TPs for this TF
        targets.push({ tp: Number((price + atr * 2.5).toFixed(8)), source: `ATR_UP:${tf}`, confidence: 30, tf, atr });
        targets.push({ tp: Number((price - atr * 2.5).toFixed(8)), source: `ATR_DOWN:${tf}`, confidence: 30, tf, atr });
      }
    } catch (e) {
      const atrFallback = atr || Math.max(1, Math.abs(price) * 0.002);
      targets.push({ tp: Number((price + atrFallback * 2.5).toFixed(8)), source: `ATR_UP:${tf}`, confidence: 30, tf, atr: atrFallback });
      targets.push({ tp: Number((price - atrFallback * 2.5).toFixed(8)), source: `ATR_DOWN:${tf}`, confidence: 30, tf, atr: atrFallback });
    }
  }
  return targets;
}

// dedupe & produce stable aggregated TPs sorted by confidence then distance
function aggregateAndChooseTargets(targets, price) {
  const map = new Map();
  for (const t of targets) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, t);
  }
  const arr = Array.from(map.values());
  // prefer targets that are further TF (1h/4h) by slightly boosting confidence
  for (const a of arr) {
    if (a.tf === "1h") a.confidence += 6;
    if (a.tf === "4h") a.confidence += 10;
  }
  arr.sort((A,B) => {
    if ((B.confidence||0) !== (A.confidence||0)) return (B.confidence||0) - (A.confidence||0);
    return Math.abs(A.tp - price) - Math.abs(B.tp - price);
  });
  return arr;
}

// choose TP1 (conservative) and TP2 (aggressive) with stability rules
function chooseStableTPs(symbol, price, feats, aggregatedTargets, fusedProb) {
  // aggregatedTargets sorted: highest-confidence first
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  // default scheme:
  // TP1 = ATR * conservativeMultiplier (2.8 - 3.4 depending on trend)
  // TP2 = ATR * aggressiveMultiplier (3.8 - 5.0)
  const trendFactor = clamp(Math.abs(feats.slope || 0) / Math.max(1, Math.abs(price) / 100), 0, 2); // small factor
  const tp1Mult = 3.0 + (trendFactor * 0.3); // 3.0 .. ~3.6
  const tp2Mult = 4.2 + (trendFactor * 0.6); // 4.2 .. ~5.4
  // If Elliott high-confidence targets exist (confidence >= 65), prefer Elliott for TP1/TP2
  const ellTargets = aggregatedTargets.filter(t => String(t.source || "").toLowerCase().includes("elliott") && (t.confidence || 0) >= 65);
  let primaryTP, secondaryTP, primarySource = "ATR", secondarySource = "ATR";
  if (ellTargets.length >= 2) {
    primaryTP = ellTargets[0].tp; secondaryTP = ellTargets[1].tp;
    primarySource = ellTargets[0].source; secondarySource = ellTargets[1].source;
  } else if (ellTargets.length === 1) {
    const ellTP = ellTargets[0].tp;
    primaryTP = ellTP;
    // secondary either next best aggregated or ATR far
    const fallback = aggregatedTargets.find(t => t.tp !== ellTP) || null;
    secondaryTP = fallback ? fallback.tp : (price + Math.sign(ellTP - price) * (atr * tp2Mult));
    primarySource = ellTargets[0].source;
    secondarySource = fallback ? (fallback.source || "agg") : "ATR";
  } else {
    // No reliable Elliott: use aggregated targets if available to get direction-specific TPs
    const bullCandidates = aggregatedTargets.filter(t => t.tp > price);
    const bearCandidates = aggregatedTargets.filter(t => t.tp < price);
    // derive direction by fusedProb (>0.52 bullish else bearish else neutral)
    const dir = fusedProb >= 0.52 ? "Bull" : fusedProb <= 0.48 ? "Bear" : "Neutral";
    if (dir === "Bull") {
      primaryTP = (bullCandidates.length ? bullCandidates[0].tp : Number((price + atr * tp1Mult).toFixed(8)));
      secondaryTP = (bullCandidates.length > 1 ? bullCandidates[1].tp : Number((price + atr * tp2Mult).toFixed(8)));
      primarySource = bullCandidates.length ? bullCandidates[0].source : "ATR";
      secondarySource = bullCandidates.length > 1 ? bullCandidates[1].source : "ATR";
    } else if (dir === "Bear") {
      primaryTP = (bearCandidates.length ? bearCandidates[0].tp : Number((price - atr * tp1Mult).toFixed(8)));
      secondaryTP = (bearCandidates.length > 1 ? bearCandidates[1].tp : Number((price - atr * tp2Mult).toFixed(8)));
      primarySource = bearCandidates.length ? bearCandidates[0].source : "ATR";
      secondarySource = bearCandidates.length > 1 ? bearCandidates[1].source : "ATR";
    } else {
      // Neutral: provide symmetric TPs around price using ATR
      primaryTP = Number((price + atr * tp1Mult).toFixed(8));
      secondaryTP = Number((price - atr * tp1Mult).toFixed(8));
      primarySource = "ATR"; secondarySource = "ATR";
    }
  }

  // Ensure primary is farther than very-small distance
  if (Math.abs(primaryTP - price) < atr * 0.5) {
    primaryTP = Number((price + Math.sign(primaryTP - price) * atr * tp1Mult).toFixed(8));
  }
  if (Math.abs(secondaryTP - price) < atr * 0.4) {
    secondaryTP = Number((price + Math.sign(secondaryTP - price) * atr * tp2Mult).toFixed(8));
  }

  // STABILITY: compare with lastTPs; update only if substantial change
  lastTPs[symbol] = lastTPs[symbol] || {};
  const key = "fused"; // single aggregated state
  const prev = lastTPs[symbol][key] || null;
  const MUST_CHANGE = (() => {
    if (!prev) return true;
    const prevFused = prev.fusedProb || 0;
    const fusedChange = Math.abs(fusedProb - prevFused);
    const atrPrev = prev.atr || 0;
    const atrChange = atrPrev > 0 ? Math.abs((atr - atrPrev) / atrPrev) : 1;
    // require fused change > 0.08 (8%) OR atr change > 12% to accept TP move
    return (fusedChange >= 0.08) || (atrChange >= 0.12);
  })();

  if (MUST_CHANGE) {
    lastTPs[symbol][key] = { tp1: primaryTP, tp2: secondaryTP, atr, fusedProb, updatedAt: new Date().toISOString(), primarySource, secondarySource };
    saveLastTPs();
    return { tp1: primaryTP, tp2: secondaryTP, primarySource, secondarySource, atr, changed: true };
  } else {
    // keep previous TPs; respond with prev but indicate not changed
    const prevTP1 = prev?.tp1 ?? primaryTP;
    const prevTP2 = prev?.tp2 ?? secondaryTP;
    return { tp1: prevTP1, tp2: prevTP2, primarySource: prev?.primarySource || primarySource, secondarySource: prev?.secondarySource || secondarySource, atr, changed: false };
  }
}

// ---------------- SL picker ----------------
function pickSL(dir, price, feats, ell) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  const HIGH_VOL_THRESHOLD = 0.003;
  const volRatio = feats && feats.atr ? feats.atr / Math.max(EPS, Math.abs(price)) : atr / Math.max(EPS, Math.abs(price));
  if (volRatio >= HIGH_VOL_THRESHOLD) {
    return dir === "Bullish" ? Number((price - atr * 1.9).toFixed(8)) : dir === "Bearish" ? Number((price + atr * 1.9).toFixed(8)) : Number((price - atr * 1.9).toFixed(8));
  }
  // prefer Elliott pivot if available
  if (ell && Array.isArray(ell.pivots) && ell.pivots.length) {
    const piv = ell.pivots.slice().reverse();
    if (dir === "Bullish") {
      const lastLow = piv.find(p => p.type === "L");
      if (lastLow && isFiniteNum(lastLow.price)) return Number(lastLow.price);
    } else if (dir === "Bearish") {
      const lastHigh = piv.find(p => p.type === "H");
      if (lastHigh && isFiniteNum(lastHigh.price)) return Number(lastHigh.price);
    }
  }
  // fallback swing
  if (feats && Array.isArray(feats.candles) && feats.candles.length >= 3) {
    const window = feats.candles.slice(-10);
    const swingLow = Math.min(...window.map(c => c.low));
    const swingHigh = Math.max(...window.map(c => c.high));
    return dir === "Bullish" ? Number(swingLow) : dir === "Bearish" ? Number(swingHigh) : Number((price - atr * 1.9).toFixed(8));
  }
  return dir === "Bullish" ? Number((price - atr * 1.9).toFixed(8)) : dir === "Bearish" ? Number((price + atr * 1.9).toFixed(8)) : Number((price - atr * 1.9).toFixed(8));
}

// ---------------- CNN wrapper (deterministic fallback) ----------------
async function cnnLayer(candles) {
  if (!candles || !candles.length) return { score: 0.5, label: "Neutral", probs: { bull:33.33, bear:33.33, neutral:33.33 }, features: {} };
  if (useTF) {
    // optional: if user has trained and placed model, they can plug in loading here
    // fallback kept deterministic
  }
  return candleVisionHeuristic(candles);
}

// ---------------- MAIN predictor (stable dual-TP) ----------------
export async function runMLPrediction(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    // Fetch multi-TF (we fetch all to allow multi-TF TP generation)
    // Important: include 4h for stability (if your utils supports it)
    const neededTFsForTP = ["15m","30m","1h","4h"];
    const microTFs = ["1m","5m"];
    const allTfs = Array.from(new Set([tfc, ...neededTFsForTP, ...microTFs]));
    const mtfRaw = await fetchMultiTF(symbol, allTfs);

    const main = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isFiniteNum(main.price) ? main.price : (candles?.at(-1)?.close ?? 0);
    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_module_v8_6_stable_dual",
        symbol, tf: tfc, direction: "Neutral", probs: { bull:33.33, bear:33.33, neutral:33.33 }, maxProb: 33.33,
        tpEstimate: null, tp2Estimate: null, slEstimate: null, explanation: "insufficient data"
      };
    }

    // build local features from main TF
    const feats = (() => {
      const atr = computeATRFromCandles(candles, 14);
      const rsi = computeRSIFromCandles(candles, 14);
      const closes = candles.map(c => c.close || 0);
      const len = Math.min(30, closes.length);
      let slope = 0;
      if (len >= 3) {
        let xmean = 0, ymean = 0, num = 0, den = 0;
        for (let i=0;i<len;i++){ xmean += i; ymean += closes[closes.length - len + i]; }
        xmean /= len; ymean /= len;
        for (let i=0;i<len;i++){ const x=i; const y=closes[closes.length - len + i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
        slope = den === 0 ? 0 : num/den;
      }
      const of = computeOrderFlowFeatures(candles);
      return { candles, atr, rsi, slope, mom3: (closes.at(-1) - closes.at(-4) || 0)/Math.max(EPS, Math.abs(closes.at(-4) || 1)), avgVol: mean(candles.slice(-20).map(c => c.volume || 0)), lastVol: (candles.at(-1)?.volume || 0), of, close: price };
    })();

    // layers
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = feats.of || {};
    const ofScore = (() => { if (!of) return 0.5; let s = 0.5; if (isFiniteNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, feats.avgVol || 1)), -0.4, 0.4); if (of.sweep && of.sweep.side) s += (of.sweep.side === "BullishSweep") ? 0.15 : -0.15; return clamp(s, 0, 1); })();

    let ell = null;
    try { if (opts.useElliott !== false) ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = null; }
    const newsScore = news ? (typeof news.sentiment === "number" ? clamp(news.sentiment, 0, 1) : 0.5) : 0.5;

    // compose scores and fuse
    const scores = { ind: ind.score, cnn: (cnn.probs ? (cnn.probs.bull/100) : (cnn.score || 0.5)), of: ofScore, news: newsScore };
    const fusion = fuseScores(scores, _stats.adaptiveWeights);

    // fused bull prob normalized
    const bullP = clamp(fusion.fused, 0.01, 0.99);
    const bearP = clamp(1 - bullP, 0.01, 0.99);
    let pb = bullP * 100, pr = bearP * 100;
    let pn = clamp(100 - (pb + pr), 0, 100);
    const ssum = pb + pr + pn || 1;
    pb = Math.round((pb / ssum) * 10000) / 100; pr = Math.round((pr / ssum) * 10000) / 100; pn = Math.round((pn / ssum) * 10000) / 100;
    const probs = { bull: pb, bear: pr, neutral: pn };
    const maxProb = Math.max(pb, pr, pn);
    const dir = maxProb === pb ? "Bullish" : maxProb === pr ? "Bearish" : "Neutral";

    // Build multi-TF targets (only high-stability TFs)
    const mtfDataForTP = {};
    for (const tf of ["15m","30m","1h","4h"]) {
      mtfDataForTP[tf] = mtfRaw[tf] || { data: [], price };
      // ensure 4h may be empty if your fetchMultiTF doesn't support; that's fine
    }
    const tfTargets = buildTFTargetsFromTFData(mtfDataForTP, price);
    const aggregated = aggregateAndChooseTargets(tfTargets, price);

    // choose stable TPs using stored lastTPs and stability rules
    const tpSelection = chooseStableTPs(symbol, price, feats, aggregated, fusion.fused);

    // pick SL using hybrid approach (preferring Elliott then swing then ATR)
    const sl = pickSL(dir, price, feats, ell);

    // compute tpConfidence: blend chosen sources and fused probability
    const tpConfidence = Math.round(Math.min(100, ((tpSelection.primarySource && tpSelection.primarySource.toLowerCase().includes("elliott")) ? 70 : 40) * 0.5 + (maxProb) * 0.45 + 5));

    // assemble ml object
    const mlObj = {
      modelVersion: "ml_module_v8_6_stable_dual",
      symbol,
      tf: tfc,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs,
      maxProb,
      tpEstimate: tpSelection.tp1,
      tp2Estimate: tpSelection.tp2,
      tpPrimarySource: tpSelection.primarySource,
      tpSecondarySource: tpSelection.secondarySource,
      tpChanged: !!tpSelection.changed,
      tpConfidence,
      slEstimate: sl,
      explanation: {
        features: { slope: feats.slope, mom3: feats.mom3, rsi: feats.rsi, atr: feats.atr },
        layers: { indicator: ind.details, cnn: cnn.features || {}, orderflow: of, news: news || null },
        fusionBreakdown: fusion,
        ell: ell ? { confidence: ell.confidence } : null,
        stability: { lastUpdated: lastTPs[symbol]?.fused?.updatedAt ?? null }
      },
      rawLayers: { ind: ind.score, cnn: (cnn.score || 0.5), of: ofScore, news: newsScore },
      adaptiveWeights: _stats.adaptiveWeights
    };

    // record prediction
    const id = `${symbol}_${tfc}_${Date.now()}`;
    try { recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores } }); } catch (e) {}

    return mlObj;

  } catch (e) {
    return { error: e?.toString?.() ?? String(e), symbol, tf: tfc };
  }
}

// ---------------- Micro predictor (allowed to use 1m/5m for confirmation only) ----------------
export async function runMicroPrediction(symbol = "BTCUSDT", tfc = "1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = mtf[tfc]?.data || [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_module_v8_6_micro", label: "Neutral", prob: 33.33, reason: "insufficient" };
    const feats = (() => {
      const atr = computeATRFromCandles(candles, 14);
      const rsi = computeRSIFromCandles(candles, 14);
      return { candles, atr, rsi, slope: 0, avgVol: mean(candles.map(c => c.volume || 0)), lastVol: candles.at(-1)?.volume || 0 };
    })();
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = computeOrderFlowFeatures(candles);
    const ofScore = clamp(0.5 + (of.delta || 0) / Math.max(1, feats.avgVol || 1) / 2, 0, 1);
    const scores = { ind: ind.score, cnn: (cnn.probs ? (cnn.probs.bull/100) : (cnn.score || 0.5)), of: ofScore, news: 0.5 };
    const fused = fuseScores(scores);
    const bull = fused.fused;
    const probBull = Math.round(bull * 10000) / 100;
    const probBear = Math.round((1 - bull) * 10000) / 100;
    const label = probBull > 60 ? "Bullish" : probBear > 60 ? "Bearish" : "Neutral";
    return { modelVersion: "ml_module_v8_6_micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn, of: ofScore } };
  } catch (e) { return { error: e?.toString?.() ?? String(e), label: "Neutral" }; }
}

// ---------------- Multimarket helpers ----------------
// Accepts string symbol or array of symbols. Returns mapping: { "<symbol>": <prediction> }
function normalizeSymbolsInput(symbols) {
  if (!symbols) return [];
  if (typeof symbols === "string") return [symbols];
  if (Array.isArray(symbols)) return symbols.filter(s => !!s).map(s => String(s));
  // if object with keys, interpret keys as symbols
  if (typeof symbols === "object") return Object.keys(symbols);
  return [];
}

/**
 * Run predictions for multiple symbols (sequential to avoid hammering data provider).
 * Returns { results: { symbol: mlObj }, errors: { symbol: error } }
 */
export async function runMultiMarketPrediction(symbols = [], tfc = "15m", opts = {}) {
  const list = normalizeSymbolsInput(symbols);
  const results = {};
  const errors = {};
  for (const s of list) {
    try {
      // reuse runMLPrediction which handles single symbol
      const res = await runMLPrediction(s, tfc, opts);
      results[s] = res;
    } catch (err) {
      errors[s] = err?.toString?.() ?? String(err);
    }
  }
  return { results, errors };
}

/**
 * Run micro predictions for multiple symbols
 */
export async function runMultiMicroPrediction(symbols = [], tfc = "1m", opts = {}) {
  const list = normalizeSymbolsInput(symbols);
  const results = {};
  const errors = {};
  for (const s of list) {
    try {
      const res = await runMicroPrediction(s, tfc, opts);
      results[s] = res;
    } catch (err) {
      errors[s] = err?.toString?.() ?? String(err);
    }
  }
  return { results, errors };
}

// ---------------- Adaptive training ----------------
export async function trainAdaptive(batch = []) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok: false, message: "no data" };
    for (const b of batch) updateAdaptiveWeights(b.trueLabel, b.fusedProb, { breakdown: b.breakdown });
    saveStats();
    return { ok: true, weights: _stats.adaptiveWeights };
  } catch (e) { return { ok: false, error: e?.toString?.() ?? String(e) }; }
}

// ---------------- Mark outcome ----------------
export function markOutcome(symbol, alertId, success = true, trueLabel = null) {
  try {
    recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() });
    if (typeof trueLabel === "string") {
      const preds = readJsonSafe(PRED_FILE);
      const p = preds.find(px => px.id === alertId);
      if (p && p.meta && p.meta.scores) {
        const fused = fuseScores(p.meta.scores, _stats.adaptiveWeights);
        updateAdaptiveWeights(trueLabel, fused.fused, { breakdown: fused.breakdown });
        saveStats();
      }
    }
    return true;
  } catch (e) { return false; }
}

// ---------------- Stats utils ----------------
export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc };
}
export function resetStats() {
  _stats = { total: 0, wins: 0, losses: 0, alerts: [], adaptiveWeights: _stats.adaptiveWeights || { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1,lr:0.02 }, lastUpdated: null, accuracyCache: null };
  saveStats();
  lastTPs = {};
  saveLastTPs();
  return _stats;
}

// ---------------- Default export ----------------
const defaultExport = {
  runMLPrediction, runMicroPrediction, runMultiMarketPrediction, runMultiMicroPrediction,
  calculateAccuracy, recordPrediction, recordOutcome, markOutcome, getStats, trainAdaptive, resetStats
};
export default defaultExport;