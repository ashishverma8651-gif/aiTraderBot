// ml_module_v8_6.js
// V11 Ultra implementation (keeps filename ml_module_v8_6.js as requested)
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction,
// recordOutcome, markOutcome, getStats, trainAdaptive, resetStats
//
// Hybrid SL fallback: choose ATR when volatility high, else structural swing (from ell or candles)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// Optional tfjs (kept as fallback, not required)
let tf = null;
let useTF = false;
try {
  tf = (() => {
    try { return require("@tensorflow/tfjs-node"); } catch (e) { return null; }
  })();
  if (tf) useTF = true;
} catch (e) { tf = null; useTF = false; }

// Paths & persistence
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_v11_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions_v11.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes_v11.json");
const STATS_FILE = path.join(LOG_DIR, "stats_v11.json");
const MODEL_FILE = path.join(LOG_DIR, "cnn_model_meta.json");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

let memPreds = [];
let memOuts = [];
let _stats = { total: 0, wins: 0, losses: 0, alerts: [], adaptiveWeights: null, lastUpdated: null };

try {
  if (fs.existsSync(STATS_FILE)) {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    if (raw) _stats = JSON.parse(raw);
  }
} catch (e) { /* ignore */ }

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
function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) {}
}

const EPS = 1e-12;
const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d = 2) => (isFiniteNum(v) ? Number(v).toFixed(d) : "N/A");

// Recording helpers
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);

    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id, symbol: pred.symbol, ts: new Date().toISOString(), meta: pred.meta || null });
    if (_stats.alerts.length > 500) _stats.alerts.shift();
    saveStats();
  } catch (e) {
    memPreds.push(pred);
  }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(OUT_FILE, arr)) memOuts.push(outcome);

    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1;
    else _stats.losses = (_stats.losses || 0) + 1;
    saveStats();
  } catch (e) {
    memOuts.push(outcome);
  }
}

export function calculateAccuracy() {
  try {
    const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
    const total = outs.length || (_stats.total || 0);
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.success).length || (_stats.wins || 0);
    const acc = Math.round((correct / total) * 10000) / 100;
    return { accuracy: acc, total, correct };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// Tiny CNN builder (placeholder)
let cnnModelMeta = null;
try { if (fs.existsSync(MODEL_FILE)) cnnModelMeta = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8")); } catch (e) { cnnModelMeta = null; }
async function buildTinyCNN() {
  if (!useTF) return null;
  try {
    const tfn = tf;
    const model = tfn.sequential();
    model.add(tfn.layers.conv2d({ inputShape: [32, 32, 1], filters: 8, kernelSize: 3, activation: "relu" }));
    model.add(tfn.layers.maxPooling2d({ poolSize: [2, 2] }));
    model.add(tfn.layers.conv2d({ filters: 16, kernelSize: 3, activation: "relu" }));
    model.add(tfn.layers.flatten());
    model.add(tfn.layers.dense({ units: 32, activation: "relu" }));
    model.add(tfn.layers.dense({ units: 3, activation: "softmax" }));
    model.compile({ optimizer: tfn.train.adam(0.001), loss: "categoricalCrossentropy", metrics: ["accuracy"] });
    cnnModelMeta = { builtAt: new Date().toISOString(), trained: false };
    writeJsonSafe(MODEL_FILE, cnnModelMeta);
    return model;
  } catch (e) {
    return null;
  }
}

// Candle-vision fallback (deterministic)
function candleVisionHeuristic(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return { label: "Neutral", probs: { bull: 33, bear: 33, neutral: 33 }, features: {} };
  const last = candles.slice(-6);
  const bodies = last.map(c => Math.abs(c.close - c.open));
  const ranges = last.map(c => c.high - c.low);
  const up = last.filter(c => c.close > c.open).length;
  const down = last.filter(c => c.close < c.open).length;
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastC = last[last.length - 1];
  const body = Math.abs(lastC.close - lastC.open);
  const lowerWick = Math.min(lastC.close, lastC.open) - lastC.low;
  const upperWick = lastC.high - Math.max(lastC.close, lastC.open);
  let bullScore = 0, bearScore = 0;
  const momentum = (last[last.length - 1].close - last[0].close) / Math.max(EPS, last[0].close);
  bullScore += clamp(momentum * 10, -8, 8);
  bearScore -= clamp(momentum * 10, -8, 8);
  if (lowerWick > body * 2 && upperWick < body * 0.4) bullScore += 3;
  if (upperWick > body * 2 && lowerWick < body * 0.4) bearScore += 3;
  if (lastC.close > lastC.open && body > avgRange * 0.6) bullScore += 2;
  if (lastC.open > lastC.close && body > avgRange * 0.6) bearScore += 2;
  const vols = last.map(c => c.volume || 0);
  const lastVol = vols[vols.length - 1] || 0;
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, vols.length - 1);
  if (avgVol > 0 && lastVol > avgVol * 1.3) {
    bullScore += (up > down ? 1.4 : 0.2);
    bearScore += (down > up ? 1.4 : 0.2);
  }
  let pb = Math.max(0, Math.min(100, 50 + bullScore * 5));
  let pr = Math.max(0, Math.min(100, 50 + bearScore * 5));
  let pn = Math.max(0, 100 - (pb + pr));
  if (pn < 0) {
    const s = pb + pr;
    pb = Math.round((pb / s) * 10000) / 100;
    pr = Math.round((pr / s) * 10000) / 100;
    pn = 0;
    const label = pb > pr ? "Bullish" : "Bearish";
    return { label, probs: { bull: pb, bear: pr, neutral: pn }, features: { momentum, lowerWick, upperWick, lastVol, avgVol } };
  }
  pb = Math.round(pb * 100) / 100;
  pr = Math.round(pr * 100) / 100;
  pn = Math.round(pn * 100) / 100;
  const label = pb > pr && pb > pn ? "Bullish" : pr > pb && pr > pn ? "Bearish" : "Neutral";
  return { label, probs: { bull: pb, bear: pr, neutral: pn }, features: { momentum, lowerWick, upperWick, lastVol, avgVol } };
}

// Order-flow features
function computeOrderFlowFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return {};
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const delta = (last.close - last.open) * (last.volume || 1);
  const deltaPrev = (prev.close - prev.open) * (prev.volume || 1);
  const vel = last.close - prev.close;
  const window = candles.slice(Math.max(0, n - 6), n);
  const swingHigh = Math.max(...window.map(c => c.high));
  const swingLow = Math.min(...window.map(c => c.low));
  let sweep = null;
  if (last.high > swingHigh && last.close < swingHigh) sweep = { side: "BearishSweep", priorHigh: swingHigh };
  if (last.low < swingLow && last.close > swingLow) sweep = { side: "BullishSweep", priorLow: swingLow };
  const upWicks = window.map(c => c.high - Math.max(c.close, c.open));
  const downWicks = window.map(c => Math.min(c.close, c.open) - c.low);
  const avgUp = upWicks.reduce((a, b) => a + b, 0) / upWicks.length;
  const avgDown = downWicks.reduce((a, b) => a + b, 0) / downWicks.length;
  return { delta, deltaPrev, vel, sweep, avgUp, avgDown };
}

// Feature builder
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n - 1];
  const closes = candles.map(c => Number(c.close || 0));
  const highs = candles.map(c => Number(c.high || 0));
  const lows = candles.map(c => Number(c.low || 0));
  const vols = candles.map(c => Number(c.volume || 0));
  const close = Number(last.close || 0);
  const mom3 = n >= 4 ? (close - closes[n - 4]) / Math.max(EPS, closes[n - 4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n - 11]) / Math.max(EPS, closes[n - 11]) : 0;
  const len = Math.min(30, n);
  let xmean = 0, ymean = 0, num = 0, den = 0;
  for (let i = 0; i < len; i++) { xmean += i; ymean += closes[n - len + i]; }
  xmean /= len; ymean /= len;
  for (let i = 0; i < len; i++) { const x = i; const y = closes[n - len + i]; num += (x - xmean) * (y - ymean); den += (x - xmean) * (x - xmean); }
  const slope = den === 0 ? 0 : num / den;
  const trs = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(Math.abs(highs[i] - lows[i]), Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  const atr = trs.length ? trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length) : 0;
  let gains = 0, losses = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / 14 || 0;
  const avgLoss = losses / 14 || 0;
  const rsi = avgGain + avgLoss ? 100 - (100 / (1 + avgGain / Math.max(EPS, avgLoss))) : 50;
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, vols.length));
  const of = computeOrderFlowFeatures(candles);
  return {
    close, slope, mom3, mom10, atr, rsi, avgVol, lastVol: last.volume || 0, of, high: last.high, low: last.low, candles
  };
}

// Adaptive weights
if (!_stats.adaptiveWeights) {
  _stats.adaptiveWeights = { w_ind: 0.45, w_cnn: 0.25, w_of: 0.20, w_news: 0.10, lr: 0.02 };
  saveStats();
}
function fuseScores(scores, weights) {
  const newsNorm = (scores.news ?? 0.5);
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

// Indicator layer
function indicatorLayer(feats) {
  if (!feats) return { score: 0.5, details: {} };
  const { slope, mom3, mom10, rsi, avgVol, lastVol, close } = feats;
  let s = 0;
  s += clamp((Math.tanh(slope / Math.max(1, Math.abs(close || 1))) + 0.5), 0, 1) * 0.5;
  s += clamp((0.5 + Math.tanh(mom3 * 6) / 2), 0, 1) * 0.3;
  if (isFiniteNum(rsi)) {
    const rnorm = clamp((rsi - 30) / 40, 0, 1);
    s = s * 0.9 + rnorm * 0.1;
  }
  if (avgVol > 0) {
    const volScore = clamp(lastVol / avgVol, 0, 2) / 2;
    s = s * 0.9 + volScore * 0.1;
  }
  return { score: clamp(s, 0, 1), details: { slope, mom3, mom10, rsi } };
}

// CNN wrapper
async function cnnLayer(candles) {
  if (!candles || !candles.length) return { score: 0.5, label: "Neutral", probs: { bull: 33, bear: 33, neutral: 33 }, features: {} };
  // prefer deterministic fallback unless user trained a CNN and placed meta
  return candleVisionHeuristic(candles);
}

// News layer
function newsLayer(newsObj) {
  if (!newsObj) return { score: 0.5, meta: {} };
  const sentiment = typeof newsObj.sentiment === "number" ? newsObj.sentiment : 0.5;
  return { score: clamp(sentiment, 0, 1), meta: { sentiment, impact: newsObj.impact || "low" } };
}

// TP/SL builder with hybrid SL fallback
function buildCandidateTPs(feats, price, ell) {
  const out = [];
  const atr = Math.max(feats?.atr || 0, price * 0.0005);
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      out.push({ tp, source: t.source || "Elliott", confidence: Math.min(100, Math.round(t.confidence || (ell.confidence || 40))) });
    }
  }
  if (!out.length) {
    out.push({ tp: price + atr * 2.5, source: "ATR_UP", confidence: 40 });
    out.push({ tp: price - atr * 2.5, source: "ATR_DOWN", confidence: 40 });
  }
  const map = new Map();
  for (const c of out) {
    const key = Math.round(c.tp);
    if (!map.has(key) || (c.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, c);
  }
  return [...map.values()].sort((a, b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}
function chooseTP(candidates, dir, price, feats, ell) {
  if (!candidates || !candidates.length) return null;
  const atr = Math.max(feats?.atr || 0, price * 0.0005);
  const pool = candidates.filter(c => (dir === "Bullish" ? c.tp > price : dir === "Bearish" ? c.tp < price : true));
  const chosen = (pool.length ? pool : candidates)[0];

  // Hybrid SL fallback:
  // - if ATR relative to price is high (volatility), use ATR fallback
  // - else prefer structural swing (from ell summary) if available, else fallback to ATR
  let sl = null;
  const volRatio = (feats && feats.atr && price) ? feats.atr / Math.max(EPS, price) : (atr / Math.max(EPS, price));
  const HIGH_VOL_THRESHOLD = 0.003; // tuned: if ATR > 0.3% of price -> use ATR
  if (volRatio >= HIGH_VOL_THRESHOLD) {
    sl = dir === "Bullish" ? price - atr * 1.8 : dir === "Bearish" ? price + atr * 1.8 : price - atr * 1.8;
  } else {
    // structural: prefer last pivot from ell, else last swing in candles
    const ellSwing = (ell && ell.pivots && ell.pivots.length) ? (() => {
      // find last opposite pivot as SL
      const pivots = ell.pivots.slice().reverse();
      if (dir === "Bullish") {
        const lastLow = pivots.find(p => p.type === "L");
        return lastLow ? lastLow.price : null;
      } else if (dir === "Bearish") {
        const lastHigh = pivots.find(p => p.type === "H");
        return lastHigh ? lastHigh.price : null;
      }
      return null;
    })() : null;

    if (isFiniteNum(ellSwing)) {
      sl = ellSwing;
    } else {
      // compute last swing from candles (simple)
      const candles = feats?.candles || [];
      if (Array.isArray(candles) && candles.length >= 3) {
        const window = candles.slice(-10);
        const swingLow = Math.min(...window.map(c => c.low));
        const swingHigh = Math.max(...window.map(c => c.high));
        sl = dir === "Bullish" ? swingLow : dir === "Bearish" ? swingHigh : (price - atr * 1.8);
      } else {
        sl = dir === "Bullish" ? price - atr * 1.8 : dir === "Bearish" ? price + atr * 1.8 : price - atr * 1.8;
      }
    }
  }

  return { tp: Number(chosen.tp), source: chosen.source, confidence: chosen.confidence, suggestedSL: Number(sl) };
}

// Main predictor
export async function runMLPrediction(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    const mtfRaw = await fetchMultiTF(symbol, [tfc, "1m", "5m", "30m", "1h"]);
    const main = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isFiniteNum(main.price) ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_module_v11_ultra",
        symbol, tf: tfc, direction: "Neutral",
        probs: { bull: 33.33, bear: 33.33, neutral: 33.33 }, maxProb: 33.33,
        tpEstimate: null, slEstimate: null, explanation: "insufficient data"
      };
    }

    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = computeOrderFlowFeatures(candles);
    const ofScore = (() => {
      if (!of) return 0.5;
      let s = 0.5;
      if (isFiniteNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, feats.avgVol || 1)), -0.4, 0.4);
      if (of.sweep && of.sweep.side) s += (of.sweep.side === "BullishSweep") ? 0.15 : -0.15;
      return clamp(s, 0, 1);
    })();

    let ell = null;
    try { if (opts.useElliott !== false) ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = null; }
    const newsScore = news ? newsLayer(news) : { score: 0.5 };

    const scores = { ind: ind.score, cnn: (cnn.probs ? (cnn.probs.bull / 100) : (cnn.score || 0.5)), of: ofScore, news: newsScore.score };
    const fusion = fuseScores(scores, _stats.adaptiveWeights);

    const bullP = clamp(fusion.fused, 0.01, 0.99);
    const bearP = clamp(1 - bullP, 0.01, 0.99);
    const neutralP = clamp(1 - Math.abs(bullP - bearP), 0, 1);

    let pb = bullP * 100;
    let pr = bearP * 100;
    let pn = neutralP * 100;
    const ssum = pb + pr + pn || 1;
    pb = Math.round((pb / ssum) * 10000) / 100;
    pr = Math.round((pr / ssum) * 10000) / 100;
    pn = Math.round((pn / ssum) * 10000) / 100;
    const probs = { bull: pb, bear: pr, neutral: pn };
    const maxProb = Math.max(pb, pr, pn);
    const dir = maxProb === pb ? "Bullish" : maxProb === pr ? "Bearish" : "Neutral";

    const candidates = buildCandidateTPs(feats, price, ell || {});
    const chosen = chooseTP(candidates, dir, price, feats, ell);
    const tpEstimate = chosen?.tp ?? null;
    const slEstimate = chosen?.suggestedSL ?? null;
    const tpConfidence = chosen ? Math.round((chosen.confidence || 40) * 0.6 + maxProb * 0.4) : Math.round(maxProb);

    const explanation = {
      features: { slope: feats.slope, mom3: feats.mom3, rsi: feats.rsi, atr: feats.atr, avgVol: feats.avgVol },
      layers: { indicator: ind.details, cnn: cnn.features || {}, orderflow: of, news: news || null },
      fusionBreakdown: fusion,
      ell: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null
    };

    const mlObj = {
      modelVersion: "ml_module_v11_ultra",
      symbol, tf: tfc, generatedAt: new Date().toISOString(),
      direction: dir, probs, maxProb,
      tpEstimate, tpSource: chosen?.source ?? null, tpConfidence,
      slEstimate, explanation, rawLayers: { ind: ind.score, cnn: (cnn.score || 0.5), of: ofScore, news: newsScore.score },
      adaptiveWeights: _stats.adaptiveWeights
    };

    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { cnn: cnn.probs || cnn, scores } });

    return mlObj;
  } catch (e) {
    return { error: e?.toString?.() ?? String(e), symbol, tf: tfc };
  }
}

// Micro predictor
export async function runMicroPrediction(symbol = "BTCUSDT", tfc = "1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = mtf[tfc]?.data || [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_module_v11_ultra-micro", label: "Neutral", prob: 33.33, reason: "insufficient" };
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = computeOrderFlowFeatures(candles);
    const ofScore = clamp(0.5 + (of.delta || 0) / Math.max(1, feats.avgVol || 1) / 2, 0, 1);
    const scores = { ind: ind.score, cnn: cnn.probs ? (cnn.probs.bull / 100) : (cnn.score || 0.5), of: ofScore, news: 0.5 };
    const fused = fuseScores(scores);
    const bull = fused.fused;
    const probBull = Math.round(bull * 10000) / 100;
    const probBear = Math.round((1 - bull) * 10000) / 100;
    const label = probBull > 60 ? "Bullish" : probBear > 60 ? "Bearish" : "Neutral";
    return { modelVersion: "ml_module_v11_ultra-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn, of: ofScore } };
  } catch (e) {
    return { error: e?.toString?.() ?? String(e), label: "Neutral" };
  }
}

// Adaptive training
export async function trainAdaptive(batch = []) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok: false, message: "no data" };
    for (const b of batch) updateAdaptiveWeights(b.trueLabel, b.fusedProb, { breakdown: b.breakdown });
    saveStats();
    return { ok: true, weights: _stats.adaptiveWeights };
  } catch (e) {
    return { ok: false, error: e?.toString?.() ?? String(e) };
  }
}

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

export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc };
}
export function resetStats() {
  _stats = { total: 0, wins: 0, losses: 0, alerts: [], adaptiveWeights: _stats.adaptiveWeights || null, lastUpdated: null };
  saveStats();
  return _stats;
}

const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction,
  recordOutcome, markOutcome, getStats, trainAdaptive, resetStats
};
export default defaultExport;
    