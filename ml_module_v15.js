// ml_module_v15.js
// ML Module v15 — Hybrid multimarket ANALYTICS engine with online-learnable ML component
// - PURE ANALYSIS (no TP/SL generation)
// - Hybrid fusion: rule-based layers + logistic regression trained online (SGD)
// - Multi-TF aware (uses fetchMultiTF from utils.js)
// - Persistence: model weights + adaptive fusion weights + stats saved to disk
// - Exports: analyzeSymbol, analyzeMulti, predictProb, trainModelBatch, trainAdaptive, markOutcome, getModel, saveModel, resetModel, getStats

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import elliottModule, { analyzeElliott, extractFeatures, normalizeCandles } from "./elliott_module.js";
import {
  computeRSI,
  computeATR,
  computeMACD,
  volumeTrend,
  analyzeVolume,
  computeFibLevelsFromCandles,
  computePriceTrend,
  deriveSignal
} from "./core_indicators.js";
import News from "./news_social.js";

// ----------------- Config & persistence -----------------
const DIR = process.env.ML_V15_DIR || path.join(process.cwd(), ".ml_v15");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const MODEL_FILE = path.join(DIR, "model.json");
const STATS_FILE = path.join(DIR, "stats.json");
const FUSION_FILE = path.join(DIR, "fusion.json");
const HISTORY_FILE = path.join(DIR, "history.json");

const EPS = 1e-12;
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const mean = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const nf = (v, d = 4) => isFiniteNum(v) ? Number(v).toFixed(d) : null;
const nowISO = () => new Date().toISOString();

// ----------------- News helper -----------------
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// ----------------- Stats, Fusion weights, Model -----------------
let _stats = { analyses:0, trainedSamples:0, lastUpdated: nowISO(), accuracyCache: null };
let _fusion = { w_ind:0.35, w_pattern:0.18, w_elliott:0.15, w_of:0.12, w_cnn:0.08, w_news:0.08, lr: 0.02 };
let _history = []; // small event history

// Simple logistic regression model (online): weights vector + bias
// Model will operate on features returned by extractFeatures.vector
let _model = {
  dim: 0,
  weights: [],    // length dim
  bias: 0,
  lr: 0.01,       // learning rate for SGD
  trained: 0
};

// load persisted if exists
try { if (fs.existsSync(STATS_FILE)) _stats = Object.assign(_stats, JSON.parse(fs.readFileSync(STATS_FILE, "utf8"))); } catch(e){}
try { if (fs.existsSync(FUSION_FILE)) _fusion = Object.assign(_fusion, JSON.parse(fs.readFileSync(FUSION_FILE, "utf8"))); } catch(e){}
try { if (fs.existsSync(HISTORY_FILE)) _history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch(e){}
try {
  if (fs.existsSync(MODEL_FILE)) {
    const raw = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
    if (raw && raw.weights && Array.isArray(raw.weights)) {
      _model = Object.assign(_model, raw);
    }
  }
} catch(e){}

// persistence helpers
function saveModel() {
  try { fs.writeFileSync(MODEL_FILE, JSON.stringify(_model, null, 2), "utf8"); return true; } catch(e){ return false; }
}
function saveFusion() {
  try { fs.writeFileSync(FUSION_FILE, JSON.stringify(_fusion, null, 2), "utf8"); return true; } catch(e){ return false; }
}
function saveStats() {
  try { _stats.lastUpdated = nowISO(); fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8"); return true; } catch(e){ return false; }
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(_history.slice(-2000), null, 2), "utf8"); return true; } catch(e){ return false; }
}

// ----------------- Utility helpers -----------------
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function dot(w, x) { if (!Array.isArray(w) || !Array.isArray(x)) return 0; let s = 0; for (let i=0;i<Math.min(w.length,x.length);i++) s += w[i]*x[i]; return s; }
function ensureModelDim(dim) {
  if (_model.dim === dim && _model.weights.length === dim) return;
  _model.dim = dim;
  _model.weights = new Array(dim).fill(0).map((v,i)=> (i===0? 0.001 : 0)); // small init
  _model.bias = 0;
  _model.trained = 0;
  saveModel();
}

// ----------------- Rule-based layers (scorers) -----------------
// indicator layer uses core_indicators functions
function runIndicatorLayer(candles) {
  const rsi = computeRSI(candles, 14);
  const atr = computeATR(candles, 14);
  const macd = computeMACD(candles);
  const priceTrend = computePriceTrend(candles);
  const volTrend = volumeTrend(candles);
  const rsiNorm = clamp((rsi - 30) / 40, 0, 1);
  const macdBias = clamp((macd.hist || 0) > 0 ? 0.62 : 0.38, 0, 1);
  const trendBias = priceTrend === "UP" ? 0.6 : priceTrend === "DOWN" ? 0.4 : 0.5;
  const volBias = volTrend === "INCREASING" ? 0.55 : volTrend === "DECREASING" ? 0.45 : 0.5;
  const score = clamp((rsiNorm*0.45 + macdBias*0.25 + trendBias*0.18 + volBias*0.12), 0, 1);
  return { score, details: { rsi, atr, macd, priceTrend, volTrend } };
}

function runOrderflowLayer(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return { score: 0.5, details: {} };
  const last = candles[candles.length-1], prev = candles[candles.length-2];
  const delta = (last.close - last.open) * (last.volume || last.vol || 1);
  const window = candles.slice(Math.max(0, candles.length-6));
  const swingHigh = Math.max(...window.map(c=>c.high)), swingLow = Math.min(...window.map(c=>c.low));
  let sweep = null;
  if (last.high > swingHigh && last.close < swingHigh) sweep = { side:"BearishSweep", priorHigh:swingHigh };
  if (last.low < swingLow && last.close > swingLow) sweep = { side:"BullishSweep", priorLow:swingLow };
  let s = 0.5;
  try {
    const avgVol = mean(window.map(c => c.volume || c.vol || 0)) || 1;
    s += clamp(Math.tanh(delta / Math.max(1, avgVol)) , -0.45, 0.45);
  } catch(e){}
  if (sweep) s += sweep.side === "BullishSweep" ? 0.12 : -0.12;
  return { score: clamp(s,0,1), details: { delta, sweep } };
}

function runPatternLayer(elliottResult) {
  // use patterns already detected by elliott_module
  if (!elliottResult || !elliottResult.patterns) return { score:0.5, details: { count:0 } };
  const patterns = elliottResult.patterns;
  let bull=0, bear=0;
  for (const p of patterns) {
    const t = String(p.type || "").toLowerCase();
    if (t.includes("bottom") || t.includes("inverse") || t.includes("bull")) bull++;
    if (t.includes("top") || t.includes("bear")) bear++;
    if (t.includes("doublebottom")) bull+=1;
    if (t.includes("doubletop")) bear+=1;
  }
  const raw = (bull - bear) / Math.max(1, (bull + bear));
  const score = clamp(0.5 + raw * 0.35, 0, 1);
  return { score, details: { bull, bear, total: patterns.length } };
}

function runElliottLayer(ell) {
  if (!ell || !ell.ok) return { score: 0.5, details: null };
  const raw = clamp(ell.sentiment ?? 0, -1, 1);
  const base = clamp( (raw + 1)/2 , 0, 1);
  const impulseQ = ell.impulse?.quality ?? ell.waveMeta?.quality ?? 0;
  const boost = impulseQ > 65 ? 0.08 : impulseQ > 45 ? 0.04 : 0;
  return { score: clamp(base + boost, 0, 1), details: { confidence: ell.confidence, impulseQ } };
}

function runCNNLayer(candles) {
  // deterministic heuristic fallback (candleVisionHeuristic)
  if (!Array.isArray(candles) || !candles.length) return { score:0.5, details:{} };
  const last = candles.slice(-6);
  const bodies = last.map(c => Math.abs((c.close||0)-(c.open||0)));
  const ranges = last.map(c => (c.high||0)-(c.low||0));
  const avgRange = mean(ranges) || 1;
  const lastC = last[last.length-1];
  const body = Math.abs((lastC.close||0)-(lastC.open||0)) || 1;
  const lowerWick = Math.min(lastC.close,lastC.open)-lastC.low;
  const upperWick = lastC.high - Math.max(lastC.close,lastC.open);
  let bullScore = 0, bearScore = 0;
  const momentum = (last[last.length-1].close - last[0].close) / Math.max(EPS, last[0].close);
  bullScore += clamp(momentum*8, -10, 10);
  if (lowerWick > body*1.8 && upperWick < body*0.6) bullScore += 2.5;
  if (upperWick > body*1.8 && lowerWick < body*0.6) bearScore += 2.5;
  if (lastC.close > lastC.open && body > avgRange*0.6) bullScore += 1.5;
  if (lastC.open > lastC.close && body > avgRange*0.6) bearScore += 1.5;
  const vols = last.map(c=> c.volume || c.vol || 0);
  const avgVol = mean(vols.slice(0,-1)) || 1;
  const lastVol = vols[vols.length-1] || 0;
  if (avgVol > 0 && lastVol > avgVol * 1.3) bullScore += 0.8;
  let pb = clamp(50 + bullScore * 4, 0, 100);
  let pr = clamp(50 + bearScore * 4, 0, 100);
  let pn = clamp(100 - (pb + pr), 0, 100);
  if (pn < 0) {
    const s = pb + pr || 1; pb = (pb / s) * 100; pr = (pr / s)*100; pn = 0;
  }
  pb = Math.round(pb*100)/100; pr = Math.round(pr*100)/100; pn = Math.round(pn*100)/100;
  return { score: pb/100, details: { probs:{bull:pb,bear:pr,neutral:pn} } };
}

async function runNewsLayer(symbol) {
  try {
    const n = await fetchNewsBundle(symbol);
    const s = (n && typeof n.sentiment === "number") ? clamp(n.sentiment, 0, 1) : 0.5;
    return { score: s, details: n };
  } catch(e) { return { score: 0.5, details: null }; }
}

function detectHarmonics(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return { found:false, patterns:[] };
  const closes = candles.map(c=>c.close);
  const hi = Math.max(...closes.slice(-50)), lo = Math.min(...closes.slice(-50));
  const diff = hi - lo;
  const last = closes.at(-1);
  const rel = (last - lo) / Math.max(EPS, diff);
  const patterns = [];
  if (rel > 0.55 && rel < 0.68) patterns.push({ name: "Gartley_like", rel });
  return { found: patterns.length>0, patterns };
}

// ----------------- Fusion & ML mixing -----------------
function fuseLayerScores(layerScores, fusionWeights = _fusion) {
  // input: layerScores: { indicator, pattern, elliott, orderflow, cnn, news, harmonics }
  const ind = clamp(layerScores.indicator ?? 0.5, 0, 1);
  const pattern = clamp(layerScores.pattern ?? 0.5, 0, 1);
  const ell = clamp(layerScores.elliott ?? 0.5, 0, 1);
  const of = clamp(layerScores.orderflow ?? 0.5, 0, 1);
  const cnn = clamp(layerScores.cnn ?? 0.5, 0, 1);
  const news = clamp(layerScores.news ?? 0.5, 0, 1);
  const harm = clamp(layerScores.harmonics ?? 0.5, 0, 1);
  const w = fusionWeights || _fusion;
  // normalize weights if needed
  const sumW = (w.w_ind + w.w_pattern + w.w_elliott + w.w_of + w.w_cnn + w.w_news);
  const wi = w.w_ind / sumW, wp = w.w_pattern / sumW, we = w.w_elliott / sumW, wo = w.w_of / sumW, wc = w.w_cnn / sumW, wn = w.w_news / sumW;
  const fused = ind*wi + pattern*wp + ell*we + of*wo + cnn*wc + news*wn;
  const breakdown = { indicator:ind, pattern:pattern, elliott:ell, orderflow:of, cnn, news, harmonics: harm, weights: { wi, wp, we, wo, wc, wn } };
  return { fused: clamp(fused, 0, 1), breakdown };
}

// ----------------- ML Model functions -----------------
// predict probability from feature vector
export function predictProbVector(vec) {
  if (!Array.isArray(vec)) return 0.5;
  ensureModelDim(vec.length);
  const z = dot(_model.weights, vec) + (_model.bias || 0);
  const p = sigmoid(z);
  return clamp(p, 0.0001, 0.9999);
}

// expose a convenience predict that accepts ell analysis (uses extractFeatures)
export function predictProbFromAnalysis(mlAnalysis) {
  if (!mlAnalysis || !mlAnalysis.mtfSummary) return 0.5;
  // we prefer mlFeatures if provided
  const featObj = mlAnalysis.mlFeatures || (mlAnalysis.layers && mlAnalysis.layers.elliott ? extractFeatures(normalizeCandles(mlAnalysis.layers.elliott?.price ? [] : [])) : null);
  if (!featObj || !featObj.vector) return 0.5;
  return predictProbVector(featObj.vector);
}

// online SGD step: x vector, label y in {0,1}
function sgdUpdate(x, y, lr = _model.lr) {
  ensureModelDim(x.length);
  const p = predictProbVector(x);
  const err = (y - p);
  // gradient of logistic loss wrt weights = -err * x (since loss L = -y ln p - (1-y) ln(1-p), dL/dw = (p - y)*x)
  // We'll use simple update: w += lr * err * x
  for (let i=0;i<_model.dim;i++) {
    _model.weights[i] += lr * err * (x[i] || 0);
  }
  _model.bias += lr * err;
  _model.trained += 1;
  _stats.trainedSamples = (_stats.trainedSamples || 0) + 1;
  saveModel(); saveStats();
}

// batch training wrapper
export async function trainModelBatch(samples = [], opts = {}) {
  // samples: [{ vector: [...], label: "Bullish"/"Bearish" or labelNumeric 0/1 }]
  try {
    if (!Array.isArray(samples) || !samples.length) return { ok:false, message:"no samples" };
    for (const s of samples) {
      const vec = Array.isArray(s.vector) ? s.vector : (s.vector && Array.isArray(s.vector.vector) ? s.vector.vector : null);
      if (!vec) continue;
      const label = (typeof s.labelNumeric === "number") ? (s.labelNumeric) : (s.label === "Bullish" ? 1 : s.label === "Bearish" ? 0 : (s.labelProb ?? 0.5));
      sgdUpdate(vec, label, opts.lr || _model.lr);
    }
    return { ok:true, trained:_model.trained };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}

// ----------------- High-level analyzeSymbol (final product, no TP/SL) -----------------
/**
 * analyzeSymbol(symbol, tfc, opts)
 * returns an analysis object with:
 * - direction, probs, fusedScore
 * - layers: indicator, pattern aggregation, elliott, orderflow, cnn, news, harmonics, regime
 * - mlFeatures (vector)
 * - mlModelProb (model predicted probability)
 */
export async function analyzeSymbol(symbol = "BTCUSDT", tfc = "15m", opts = {}) {
  try {
    // decide TF list to fetch: primary + contextual HTFs
    const micro = ["1m","5m"];
    const needed = Array.from(new Set([tfc, ...opts.multiTF || ["15m","30m","1h","4h"], ...micro]));
    const mtfRaw = await fetchMultiTF(symbol, needed);

    // build mtfSummary
    const mtfSummary = {};
    for (const k of Object.keys(mtfRaw || {})) {
      const e = mtfRaw[k] || { data: [], price: 0 };
      const arr = Array.isArray(e.data) ? e.data : [];
      mtfSummary[k] = { available: arr.length >= 3, length: arr.length, lastPrice: arr.length ? Number(arr.at(-1).close) : (isFiniteNum(e.price) ? e.price : null) };
    }

    const main = mtfRaw[tfc] || { data: [], price: 0 };
    const raw = Array.isArray(main.data) ? main.data : [];
    const candles = normalizeCandles(raw);
    const price = isFiniteNum(main.price) ? main.price : (candles.at(-1)?.close ?? null);

    if (!candles || candles.length < 6) {
      return { ok:false, reason:"insufficient_data", symbol, tf:tfc, mtfSummary, generatedAt: nowISO() };
    }

    // run elliott with multiTF support
    const multiTFObj = {};
    for (const tf of Object.keys(mtfRaw||{})) multiTFObj[tf] = (mtfRaw[tf] && Array.isArray(mtfRaw[tf].data)) ? mtfRaw[tf].data : [];
    let ell = null;
    try { ell = await analyzeElliott(candles, { multiTF: multiTFObj, debug: !!opts.debug }); } catch(e){ ell = null; }

    // run layers
    const indicator = runIndicatorLayer(candles);
    const orderflow = runOrderflowLayer(candles);
    const patternAgg = (() => {
      const pat = ell?.patterns ? ell.patterns : [];
      const orderBlocks = ell?.orderBlocks ? ell.orderBlocks : [];
      const fvgs = ell?.fvgs ? ell.fvgs : [];
      const sfps = ell?.sfps ? ell.sfps : [];
      const channels = ell?.channels ? ell.channels : [];
      // basic aggregation object similar to earlier module
      return { patterns: pat, orderBlocks, fvgs, sfps, channels, counts: { total: (pat.length + (orderBlocks.length||0)) } };
    })();
    const patternLayer = runPatternLayer(ell || { patterns: [] });
    const ellLayer = runElliottLayer(ell);
    const cnn = runCNNLayer(candles);
    const news = await runNewsLayer(symbol);
    const harmonics = detectHarmonics(candles);
    const regime = (function(){ // reuse simple regime detect (from earlier)
      if (!Array.isArray(candles) || candles.length < 30) return { regime:"unknown", volatility:0, trendFactor:0 };
      const slice = candles.slice(-60);
      const closes = slice.map(c=>c.close).filter(isFiniteNum);
      if (!closes.length) return { regime:"unknown", volatility:0, trendFactor:0 };
      const last20 = closes.slice(-20);
      const m20 = mean(last20);
      const vol = Math.sqrt(mean(last20.map(x => Math.pow(x - m20, 2))));
      const slope = (last20[last20.length-1] - last20[0]) / Math.max(EPS, last20[0]);
      const volRatio = vol / Math.max(EPS, m20);
      let regime = "neutral";
      if (Math.abs(slope) > 0.002 && volRatio < 0.015) regime = "trending";
      else if (volRatio < 0.007) regime = "calm";
      else if (volRatio > 0.03) regime = "volatile";
      else regime = Math.abs(slope) < 0.001 ? "ranging" : "choppy";
      return { regime, volatility: volRatio, trendFactor: slope };
    })();

    // layer scores
    const layerScores = {
      indicator: indicator.score,
      pattern: patternLayer.score,
      elliott: ellLayer.score,
      orderflow: orderflow.score,
      cnn: cnn.score,
      news: news.score,
      harmonics: harmonics.found ? 0.6 : 0.5
    };

    // fuse rule-based
    const fused = fuseLayerScores(layerScores, _fusion);
    const fusedBull = fused.fused;
    const fusedBear = clamp(1 - fusedBull, 0, 1);

    // ML prediction using features extracted by extractFeatures
    let mlFeatures = null;
    try {
      mlFeatures = extractFeatures ? extractFeatures(candles, { patterns: patternAgg.patterns, orderBlocks: ell?.orderBlocks || [], fvgs: ell?.fvgs || [], sfps: ell?.sfps || [], channels: ell?.channels || [], impulse: ell?.impulse || null, fib: ell?.fib || null, sentiment: ell?.sentiment ?? fusedBull, confidence: ell?.confidence ?? 0, price }) : null;
    } catch(e) { mlFeatures = null; }

    const mlModelProb = (mlFeatures && mlFeatures.vector) ? predictProbVector(mlFeatures.vector) : 0.5;

    // final hybrid prob: combine fused rule-based + ML model (weighted)
    // blending weights configurable: give more weight to ML after it's trained more
    const mlWeightFactor = Math.min(0.6, 0.2 + Math.log10(1 + (_model.trained || 0)) * 0.03); // increases with training count
    const blendedBull = clamp(fusedBull * (1 - mlWeightFactor) + mlModelProb * mlWeightFactor, 0, 1);
    const pb = Math.round(blendedBull * 10000)/100;
    const pr = Math.round((1 - blendedBull) * 10000)/100;
    const pn = Math.round(clamp(100 - (pb + pr), 0, 10000))/100;
    const direction = (pb > pr && pb > pn) ? "Bullish" : (pr > pb && pr > pn) ? "Bearish" : "Neutral";

    const analysis = {
      ok: true,
      version: "ml_v15",
      symbol,
      tf: tfc,
      generatedAt: nowISO(),
      price: isFiniteNum(price) ? price : null,
      direction,
      probs: { bull: pb, bear: pr, neutral: pn },
      fusedRuleProb: Math.round(fusedBull * 10000)/100,
      mlModelProb: Math.round(mlModelProb * 10000)/100,
      blendedProb: Math.round(blendedBull * 10000)/100,
      mlWeightFactor,
      layerScores,
      layers: {
        indicator,
        patternAggregation: patternAgg,
        elliott: ell,
        orderflow,
        cnn,
        news: news.details || news,
        harmonics,
        regime
      },
      mtfSummary,
      mlFeatures: mlFeatures || null
    };

    // bookkeeping
    _stats.analyses = (_stats.analyses || 0) + 1;
    _history.push({ ts: nowISO(), symbol, tf: tfc, dir: direction, fused: fusedBull, ml: mlModelProb });
    if (_history.length > 5000) _history.shift();
    saveStats(); saveHistory();

    return analysis;
  } catch (err) {
    return { ok:false, error: String(err), symbol, tf: tfc };
  }
}

// ----------------- analyzeMulti -----------------
export async function analyzeMulti(symbols = [], tfc = "15m", opts = {}) {
  const list = (typeof symbols === "string") ? [symbols] : Array.isArray(symbols) ? symbols : (symbols && typeof symbols === "object" ? Object.keys(symbols) : []);
  const results = {}; const errors = {};
  for (const s of list) {
    try { results[s] = await analyzeSymbol(s, tfc, opts); } catch(e) { errors[s] = String(e); }
  }
  return { results, errors };
}

// ----------------- Training helpers & feedback -----------------
/**
 * trainAdaptive adjusts fusion weights using labelled outcome(s)
 * batch: [{ trueLabel: "Bullish"|"Bearish", predProb: 0..1, breakdown: { indicator, pattern, elliott, orderflow, cnn, news } }]
 */
export async function trainAdaptive(batch = []) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok:false, message:"no data" };
    for (const b of batch) {
      const pred = (typeof b.predProb === "number") ? clamp(b.predProb, 0, 1) : (b.predProb && b.predProb.bull ? clamp(b.predProb.bull/100,0,1) : 0.5);
      const y = (b.trueLabel === "Bullish") ? 1 : (b.trueLabel === "Bearish") ? 0 : 0.5;
      const err = y - pred;
      const contrib = b.breakdown || { indicator:0.5, pattern:0.5, elliott:0.5, orderflow:0.5, cnn:0.5, news:0.5 };
      const lr = _fusion.lr || 0.02;
      // adjust each fusion weight a bit toward helpful contributors
      _fusion.w_ind = clamp(_fusion.w_ind + lr * err * ((contrib.indicator||0) - 0.5), 0.01, 0.8);
      _fusion.w_pattern = clamp(_fusion.w_pattern + lr * err * ((contrib.pattern||0) - 0.5), 0.01, 0.6);
      _fusion.w_elliott = clamp(_fusion.w_elliott + lr * err * ((contrib.elliott||0) - 0.5), 0.01, 0.6);
      _fusion.w_of = clamp(_fusion.w_of + lr * err * ((contrib.orderflow||0) - 0.5), 0.01, 0.6);
      _fusion.w_cnn = clamp(_fusion.w_cnn + lr * err * ((contrib.cnn||0) - 0.5), 0.005, 0.5);
      _fusion.w_news = clamp(_fusion.w_news + lr * err * ((contrib.news||0) - 0.5), 0.005, 0.4);
      // normalize weights
      const ssum = _fusion.w_ind + _fusion.w_pattern + _fusion.w_elliott + _fusion.w_of + _fusion.w_cnn + _fusion.w_news || 1;
      _fusion.w_ind /= ssum; _fusion.w_pattern /= ssum; _fusion.w_elliott /= ssum; _fusion.w_of /= ssum; _fusion.w_cnn /= ssum; _fusion.w_news /= ssum;
    }
    saveFusion();
    return { ok:true, fusion: _fusion };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}

/**
 * markOutcome(symbol, alertId, successBoolean, trueLabel) - records outcome and optionally trains
 */
export function markOutcome(symbol, alertId, success=true, trueLabel=null) {
  try {
    // record history outcome in _history and use to train small amount
    const rec = { ts: nowISO(), symbol, alertId, success, trueLabel };
    _history.push(rec);
    saveHistory();
    // optional quick adapt: if trueLabel provided + last analysis exists for symbol, update fusion & ML slightly
    if (trueLabel) {
      // find recent analysis for symbol in history
      const recent = _history.slice().reverse().find(h => h.symbol === symbol && h.dir);
      // prepare training sample if we have mlFeatures saved - we do not persist per-analysis vectors by default
      // so here we only update fusion weights using label and last fused prob if present in history
      const fusedProb = (recent && typeof recent.fused === "number") ? recent.fused : 0.5;
      trainAdaptive([{ trueLabel, predProb: fusedProb, breakdown: recent?.breakdown || {} }]);
    }
    return true;
  } catch (e) { return false; }
}

// ----------------- Model management -----------------
export function getModel() { return { model: _model, fusion: _fusion, stats: _stats }; }
export function resetModel() {
  _model = { dim:0, weights:[], bias:0, lr: 0.01, trained: 0 };
  _fusion = { w_ind:0.35, w_pattern:0.18, w_elliott:0.15, w_of:0.12, w_cnn:0.08, w_news:0.08, lr:0.02 };
  _stats = { analyses:0, trainedSamples:0, lastUpdated: nowISO(), accuracyCache: null };
  saveModel(); saveFusion(); saveStats();
  return { ok:true };
}

// ----------------- Convenience: train from labeled analyses -----------------
/**
 * feed back labelled analyses to model
 * each item: { analysis (from analyzeSymbol), trueLabel: "Bullish"/"Bearish" }
 * Will extract features (mlFeatures.vector) and perform SGD update
 */
export async function trainFromAnalyses(batch = [], opts = {}) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok:false, message:"no data" };
    let trained = 0;
    for (const item of batch) {
      const trueLabel = item.trueLabel;
      const analysis = item.analysis;
      if (!analysis || !analysis.mlFeatures || !Array.isArray(analysis.mlFeatures.vector)) continue;
      const vec = analysis.mlFeatures.vector;
      ensureModelDim(vec.length);
      const y = (trueLabel === "Bullish") ? 1 : (trueLabel === "Bearish") ? 0 : (item.labelProb ?? 0.5);
      sgdUpdate(vec, y, opts.lr || _model.lr);
      trained++;
    }
    return { ok:true, trained };
  } catch (e) { return { ok:false, error: String(e) }; }
}

// ----------------- Small utilities -----------------
export function getStats() { return { stats: _stats, fusion: _fusion, model: { trained: _model.trained, dim: _model.dim } }; }

// ----------------- Exports -----------------
export default {
  analyzeSymbol,
  analyzeMulti,
  predictProbVector,
  predictProbFromAnalysis,
  trainModelBatch,
  trainFromAnalyses,
  trainAdaptive,
  markOutcome,
  getModel,
  saveModel,
  resetModel,
  getStats
};