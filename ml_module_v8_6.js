// ml_module_v8_6.js  (V11 Ultra integrated inside original filename)
// Replaces older v8_6 behavior but keeps same exported API (backwards compatible).
// Exports:
// - runMLPrediction(symbol, tf)
// - runMicroPrediction(symbol, tf)
// - calculateAccuracy()
// - recordPrediction(pred)
// - recordOutcome(outcome)
// - markOutcome(symbol, id, success, trueLabel)
// - getStats()
// - trainAdaptive(batch)
// - resetStats()
// default export includes above

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle))
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// Optional TF (attempt require, but not mandatory)
let tf = null;
let useTF = false;
try {
  tf = (() => {
    try { return require("@tensorflow/tfjs-node"); } catch (e) { return null; }
  })();
  if (tf) useTF = true;
} catch (e) { tf = null; useTF = false; }

// -------------- Persistence & config --------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs_v11";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const STATS_FILE = path.join(LOG_DIR, "stats_summary.json");
const MODEL_META = path.join(LOG_DIR, "cnn_meta.json");

if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

// in-memory quick arrays
let memPreds = [];
let memOuts = [];
let _stats = { total: 0, wins: 0, losses: 0, alerts: [], adaptiveWeights: null, lastUpdated: null };

try {
  if (fs.existsSync(STATS_FILE)) {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    if (raw) _stats = JSON.parse(raw);
  }
} catch (e) { /* ignore */ }

function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) {}
}

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
  } catch (e) { return false; }
}

// -------------- numeric helpers --------------
const EPS = 1e-12;
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d=2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";

// -------------- record helpers --------------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);
    // quick stats log
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id, symbol: pred.symbol, ts: new Date().toISOString(), meta: pred.meta || null });
    if (_stats.alerts.length > 800) _stats.alerts.shift();
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

// -------------- Simple CNN meta (optional) --------------
let cnnMeta = null;
try { if (fs.existsSync(MODEL_META)) cnnMeta = JSON.parse(fs.readFileSync(MODEL_META, "utf8")); } catch (e) { cnnMeta = null; }

async function buildTinyCNN() {
  if (!useTF) return null;
  try {
    const tfn = tf;
    const model = tfn.sequential();
    model.add(tfn.layers.conv2d({ inputShape: [32,32,1], filters: 8, kernelSize: 3, activation: 'relu' }));
    model.add(tfn.layers.maxPooling2d({ poolSize: [2,2] }));
    model.add(tfn.layers.flatten());
    model.add(tfn.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tfn.layers.dense({ units: 3, activation: 'softmax' }));
    model.compile({ optimizer: tfn.train.adam(0.001), loss: 'categoricalCrossentropy' });
    cnnMeta = { builtAt: new Date().toISOString(), trained: false };
    writeJsonSafe(MODEL_META, cnnMeta);
    return model;
  } catch (e) { return null; }
}

// -------------- Deterministic Candle Vision (fallback) --------------
function candleVisionHeuristic(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return { label: "Neutral", probs: { bull:33, bear:33, neutral:33 }, features:{} };
  const last = candles.slice(-6);
  const bodies = last.map(c => Math.abs(c.close - c.open));
  const ranges = last.map(c => c.high - c.low);
  const up = last.filter(c => c.close > c.open).length;
  const down = last.filter(c => c.close < c.open).length;
  const avgRange = ranges.reduce((a,b)=>a+b,0)/ranges.length;
  const firstClose = last[0].close;
  const lastClose = last[last.length-1].close;
  const momentum = (lastClose - firstClose)/Math.max(EPS, firstClose);
  let bull=0, bear=0;
  bull += clamp(momentum*8, -6, 6);
  bear -= clamp(momentum*8, -6, 6);
  const lc = last[last.length-1];
  const body = Math.abs(lc.close - lc.open);
  const upper = lc.high - Math.max(lc.close, lc.open);
  const lower = Math.min(lc.close, lc.open) - lc.low;
  if (lower > body*2 && upper < body*0.5) bull += 2;
  if (upper > body*2 && lower < body*0.5) bear += 2;
  if (body > avgRange*0.6) (lc.close>lc.open ? bull+=1.2 : bear+=1.2);
  // volume confirmation
  const vols = last.map(c=>c.volume||0);
  const avgVol = vols.slice(0,-1).reduce((a,b)=>a+b,0)/Math.max(1,vols.length-1);
  const lastVol = vols[vols.length-1]||0;
  if (avgVol>0 && lastVol > avgVol*1.3) { bull += (up>down?0.8:0.2); bear += (down>up?0.8:0.2); }
  let pb = clamp(50 + bull*5, 1, 99);
  let pr = clamp(50 + bear*5, 1, 99);
  let pn = clamp(100 - (pb + pr), 0, 100);
  if (pn < 0) {
    const sum = pb + pr;
    pb = Math.round((pb/sum)*10000)/100;
    pr = Math.round((pr/sum)*10000)/100;
    pn = 0;
  } else {
    const sum = pb + pr + pn;
    pb = Math.round((pb/sum)*10000)/100;
    pr = Math.round((pr/sum)*10000)/100;
    pn = Math.round((pn/sum)*10000)/100;
  }
  const label = pb > pr && pb > pn ? "Bullish" : pr > pb && pr > pn ? "Bearish" : "Neutral";
  return { label, probs: { bull: pb, bear: pr, neutral: pn }, features: { momentum, avgRange, lastVol } };
}

// -------------- Order-flow proxies --------------
function computeOrderFlowFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return {};
  const n = candles.length;
  const last = candles[n-1];
  const prev = candles[n-2];
  const delta = ((last.close - last.open) * (last.volume || 1));
  const deltaPrev = ((prev.close - prev.open) * (prev.volume || 1));
  const vel = last.close - prev.close;
  const window = candles.slice(Math.max(0, n-6), n);
  const swingHigh = Math.max(...window.map(c=>c.high));
  const swingLow  = Math.min(...window.map(c=>c.low));
  let sweep = null;
  if (last.high > swingHigh && last.close < swingHigh) sweep = { side: "BearishSweep", priorHigh: swingHigh };
  if (last.low < swingLow && last.close > swingLow) sweep = { side: "BullishSweep", priorLow: swingLow };
  const upW = window.map(c=>c.high - Math.max(c.close, c.open));
  const dnW = window.map(c=>Math.min(c.close,c.open) - c.low);
  const avgUp = upW.reduce((a,b)=>a+b,0)/upW.length;
  const avgDown = dnW.reduce((a,b)=>a+b,0)/dnW.length;
  return { delta, deltaPrev, vel, sweep, avgUp, avgDown };
}

// -------------- Feature builder --------------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n-1];
  const closes = candles.map(c => Number(c.close || 0));
  const highs  = candles.map(c => Number(c.high || 0));
  const lows   = candles.map(c => Number(c.low || 0));
  const vols   = candles.map(c => Number(c.volume || 0));
  const close  = Number(last.close || 0);
  const mom3 = n >= 4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n-11]) / Math.max(EPS, closes[n-11]) : 0;
  const len = Math.min(30, n);
  let xmean=0, ymean=0, num=0, den=0;
  for (let i=0;i<len;i++){ xmean+=i; ymean += closes[n-len+i]; }
  xmean/=len; ymean/=len;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den===0 ? 0 : num/den;
  // ATR
  const trs = [];
  for (let i=1;i<n;i++){
    const tr = Math.max(Math.abs(highs[i]-lows[i]), Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    trs.push(tr);
  }
  const atr = trs.length ? trs.slice(-14).reduce((a,b)=>a+b,0)/Math.min(14, trs.length) : 0;
  // RSI approx
  let gains=0, losses=0;
  for (let i=Math.max(1, n-14); i<n; i++){ const diff = closes[i]-closes[i-1]; if (diff>0) gains+=diff; else losses+=Math.abs(diff); }
  const avgGain = gains/14 || 0, avgLoss = losses/14 || 0;
  const rsi = avgGain+avgLoss ? 100 - (100/(1 + (avgGain/Math.max(EPS, avgLoss)))) : 50;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(20, vols.length));
  const of = computeOrderFlowFeatures(candles);
  return { close, slope, mom3, mom10, atr, rsi, avgVol, lastVol: last.volume||0, of, high: last.high, low: last.low };
}

// -------------- Adaptive weights --------------
if (!_stats.adaptiveWeights) {
  _stats.adaptiveWeights = { w_ind: 0.45, w_cnn: 0.25, w_of: 0.20, w_news: 0.10, lr: 0.02 };
  saveStats();
}

function fuseScores(scores, weights) {
  // scores: ind/ cnn / of in 0..1, news 0..1
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind || 0.5, 0, 1);
  const cnn = clamp(scores.cnn || 0.5, 0, 1);
  const of  = clamp(scores.of  || 0.5, 0, 1);
  const news = clamp(scores.news || 0.5, 0, 1);
  const fused = ind*w.w_ind + cnn*w.w_cnn + of*w.w_of + news*w.w_news;
  return { fused: clamp(fused, 0, 1), breakdown: { ind, cnn, of, news }, weights: w };
}

function updateAdaptiveWeights(trueLabel, predProb, features = {}) {
  try {
    const w = _stats.adaptiveWeights;
    if (!w) return;
    const lr = w.lr || 0.02;
    const y = trueLabel === "Bullish" ? 1 : trueLabel === "Bearish" ? 0 : 0.5;
    const err = y - predProb;
    const contrib = features.breakdown || { ind:0.5, cnn:0.5, of:0.5, news:0.5 };
    w.w_ind = clamp(w.w_ind + lr * err * (contrib.ind - 0.5), 0.01, 0.9);
    w.w_cnn = clamp(w.w_cnn + lr * err * (contrib.cnn - 0.5), 0.01, 0.9);
    w.w_of  = clamp(w.w_of  + lr * err * (contrib.of - 0.5), 0.01, 0.9);
    w.w_news= clamp(w.w_news+ lr * err * (contrib.news - 0.5), 0.01, 0.9);
    // normalize
    const s = w.w_ind + w.w_cnn + w.w_of + w.w_news;
    w.w_ind /= s; w.w_cnn /= s; w.w_of /= s; w.w_news /= s;
    _stats.adaptiveWeights = w;
    saveStats();
  } catch (e) {}
}

// -------------- Indicator layer --------------
function indicatorLayer(feats) {
  if (!feats) return { score: 0.5, details: {} };
  const { slope, mom3, mom10, rsi, atr, avgVol, lastVol, close } = feats;
  let s = 0;
  s += clamp((Math.tanh(slope/Math.max(1, Math.abs(close||1))) + 0.5), 0, 1) * 0.5;
  s += clamp((0.5 + Math.tanh(mom3*6)/2), 0, 1) * 0.3;
  if (isFiniteNum(rsi)) {
    const rnorm = clamp((rsi - 30)/40, 0, 1);
    s = s*0.88 + rnorm*0.12;
  }
  if (avgVol > 0) {
    const volScore = clamp(lastVol/avgVol, 0, 2)/2;
    s = s*0.9 + volScore*0.1;
  }
  return { score: clamp(s, 0, 1), details: { slope, mom3, mom10, rsi, atr } };
}

// -------------- CNN layer wrapper (uses deterministic fallback) --------------
async function cnnLayer(candles) {
  if (!candles || !candles.length) return { score: 0.5, label: "Neutral", probs: { bull:33, bear:33, neutral:33 }, features: {} };
  if (useTF && cnnMeta && cnnMeta.trained && cnnMeta.modelPath) {
    // user may implement custom model load; fallback here to heuristic
  }
  // deterministic fallback
  return candleVisionHeuristic(candles);
}

// -------------- News layer --------------
function newsLayer(newsObj) {
  if (!newsObj) return { score: 0.5, meta: {} };
  const sentiment = typeof newsObj.sentiment === "number" ? newsObj.sentiment : 0.5; // 0..1
  const impact = (newsObj.impact || "low").toLowerCase();
  const impactScale = impact === "high" ? 0.6 : (impact === "moderate" ? 0.35 : 0.1);
  const score = clamp(sentiment * (1 - (1-impactScale)/1.2), 0, 1);
  return { score: clamp(score + (Math.random()*0.01), 0, 1), meta: { sentiment, impact, impactScale } };
}

// -------------- TP/SL candidate builder tuned for v11 --------------
function buildCandidateTPs(feats, price, ell) {
  const out = [];
  const atr = Math.max(feats?.atr || 0, price * 0.0007);
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp || t.price || t.target || 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      out.push({ tp, source: t.source || "Elliott", confidence: Math.min(100, Math.round(t.confidence||50)) });
    }
  }
  // fallback fib/atr style
  if (!out.length) {
    out.push({ tp: price + atr*2.4, source: "ATR_UP", confidence: 40 });
    out.push({ tp: price - atr*2.4, source: "ATR_DOWN", confidence: 40 });
    out.push({ tp: price + atr*4.0, source: "ATR_EXT_UP", confidence: 25 });
    out.push({ tp: price - atr*4.0, source: "ATR_EXT_DOWN", confidence: 25 });
  }
  // dedupe
  const map = new Map();
  for (const c of out) {
    const key = Math.round(c.tp);
    if (!map.has(key) || (c.confidence||0) > (map.get(key).confidence||0)) map.set(key, c);
  }
  return [...map.values()].sort((a,b)=>Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// choose primary and hedge according to bias (dir)
function choosePrimaryAndHedge(candidates, dir, price, feats) {
  if (!candidates || !candidates.length) return { primary: null, hedge: null, primarySrc: null, hedgeSrc: null };
  // pick closest candidate in direction as primary
  const atr = Math.max(feats?.atr || 0, price*0.0007);
  const bullPool = candidates.filter(c => c.tp > price);
  const bearPool = candidates.filter(c => c.tp < price);
  let primary = null, hedge = null;
  if (dir === "Bullish") {
    primary = bullPool.length ? bullPool[0] : candidates[0];
    // hedge = best candidate on other side (closest)
    hedge = bearPool.length ? bearPool[0] : candidates.find(c=>c.tp!==primary.tp) || null;
  } else if (dir === "Bearish") {
    primary = bearPool.length ? bearPool[0] : candidates[0];
    hedge = bullPool.length ? bullPool[0] : candidates.find(c=>c.tp!==primary.tp) || null;
  } else {
    // Neutral -> pick top confidence candidate as primary, opposite side as hedge
    const sorted = candidates.slice().sort((a,b)=>b.confidence - a.confidence);
    primary = sorted[0];
    hedge = candidates.find(c => Math.sign(c.tp - price) !== Math.sign(primary.tp - price)) || sorted[1] || null;
  }
  const primarySrc = primary?.source || null;
  const hedgeSrc = hedge?.source || null;
  return { primary: primary ? Number(primary.tp) : null, hedge: hedge ? Number(hedge.tp) : null, primarySrc, hedgeSrc };
}

// -------------- MAIN ML PREDICTOR (signature kept same: runMLPrediction) --------------
export async function runMLPrediction(symbol="BTCUSDT", tfc="15m", opts={}) {
  try {
    // fetch several TFs (we primarily use tfc but get others for robustness)
    const mtfRaw = await fetchMultiTF(symbol, [tfc, "1m", "5m", "30m", "1h"]);
    const main = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isFiniteNum(main.price) ? main.price : candles?.at(-1)?.close ?? 0;

    if (!candles || candles.length < 6 || price <= 0) {
      return {
        modelVersion: "ml_module_v11_ultra",
        symbol,
        tf: tfc,
        direction: "Neutral",
        probs: { bull:33.33, bear:33.33, neutral:33.33 },
        maxProb: 33.33,
        tpEstimate: null,
        slEstimate: null,
        mlTargets: { primary: null, hedge: null },
        explanation: "insufficient data"
      };
    }

    // features
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = computeOrderFlowFeatures(candles);
    const ofScore = (() => {
      if (!of) return 0.5;
      let s = 0.5;
      if (isFiniteNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, feats.avgVol||1)), -0.35, 0.35);
      if (of.sweep && of.sweep.side) s += (of.sweep.side === "BullishSweep" ? 0.14 : -0.14);
      return clamp(s, 0, 1);
    })();

    // elliott
    let ell = null;
    try { if (opts.useElliott !== false) ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // news
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = null; }
    const newsScore = news ? newsLayer(news) : { score: 0.5 };

    // fuse scores
    const scores = { ind: ind.score, cnn: (cnn.probs ? (cnn.probs.bull/100) : (cnn.score||0.5)), of: ofScore, news: newsScore.score };
    const fused = fuseScores(scores, _stats.adaptiveWeights);

    // convert fused to probs
    const bullP = clamp(fused.fused, 0.001, 0.999);
    const bearP = clamp(1 - bullP, 0.001, 0.999);
    // neutral estimate: proximity to 0.5
    const neutralP = clamp(1 - Math.abs(bullP - 0.5)*2, 0, 1);
    let pb = bullP*100, pr = bearP*100, pn = neutralP*100;
    const ssum = pb + pr + pn || 1;
    pb = Math.round((pb/ssum)*10000)/100;
    pr = Math.round((pr/ssum)*10000)/100;
    pn = Math.round((pn/ssum)*10000)/100;
    const probs = { bull: pb, bear: pr, neutral: pn };
    const maxProb = Math.max(pb, pr, pn);
    const dir = maxProb === pb ? "Bullish" : maxProb === pr ? "Bearish" : "Neutral";

    // Build candidates & choose primary+hedge
    const candidates = buildCandidateTPs(feats, price, ell || {});
    const chosen = choosePrimaryAndHedge(candidates, dir, price, feats);

    // suggested SL logic: use 15m ATR if provided, else use feats.atr
    const atr15 = (mtfRaw["15m"] && Array.isArray(mtfRaw["15m"].data) && mtfRaw["15m"].data.length) ? (() => {
      const f15 = buildFeaturesFromCandles(mtfRaw["15m"].data);
      return f15?.atr || feats.atr || price*0.002;
    })() : (feats.atr || price*0.002);

    // provide SL per TF small timeframe fallback (1m,5m)
    const slPerTF = {};
    slPerTF["1m"] = isFiniteNum(price) ? Number((price - atr15*1.2).toFixed(8)) : null; // looser
    slPerTF["5m"] = isFiniteNum(price) ? Number((price - atr15*1.6).toFixed(8)) : null;
    slPerTF[tfc] = isFiniteNum(price) ? Number((dir === "Bullish" ? (price - atr15*2.2) : (price + atr15*2.2)).toFixed(8)) : null;

    // build mlTargets object as required: primary & hedge only
    const mlTargets = {
      primary: chosen.primary ? Number(chosen.primary) : null,
      hedge: chosen.hedge ? Number(chosen.hedge) : null,
      primarySource: chosen.primarySrc || null,
      hedgeSource: chosen.hedgeSrc || null
    };

    // compute tpConfidence numeric
    const tpConfidence = (() => {
      if (!chosen.primary) return Math.round(maxProb);
      // find candidate confidence if exists
      const cand = candidates.find(c => Math.round(c.tp) === Math.round(chosen.primary));
      const base = cand ? cand.confidence : 40;
      return Math.round(base*0.6 + maxProb*0.4);
    })();

    const explanation = {
      modelVersion: "ml_module_v11_ultra",
      features: { slope: feats.slope, mom3: feats.mom3, rsi: feats.rsi, atr: feats.atr, avgVol: feats.avgVol },
      layers: { indicator: ind.details, cnn: cnn.features || {}, orderflow: of, news: news || null },
      fusionBreakdown: fused,
      ell: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null
    };

    const mlObj = {
      modelVersion: "ml_module_v11_ultra",
      symbol,
      tf: tfc,
      generatedAt: new Date().toISOString(),
      direction: dir,
      probs,
      maxProb,
      tpEstimate: mlTargets.primary,
      tpSource: mlTargets.primarySource,
      tpConfidence,
      slEstimate: slPerTF[tfc] ?? null,
      mlTargets, // { primary, hedge, primarySource, hedgeSource }
      explanation,
      rawLayers: { ind: ind.score, cnn: (cnn.score||0.5), of: ofScore, news: newsScore.score },
      adaptiveWeights: _stats.adaptiveWeights
    };

    // persist prediction (id)
    const id = `${symbol}_${tfc}_${Date.now()}`;
    recordPrediction({ id, symbol, tf: tfc, ml: mlObj, meta: { scores, cnn: cnn.probs||cnn } });

    return mlObj;
  } catch (e) {
    return { error: e?.toString?.() || String(e), symbol, tf: tfc };
  }
}

// -------------- MICRO predictor --------------
export async function runMicroPrediction(symbol="BTCUSDT", tfc="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const candles = mtf[tfc]?.data || [];
    if (!candles || candles.length < 3) return { modelVersion: "ml_module_v11_ultra-micro", label: "Neutral", prob: 33.33, reason: "insufficient" };
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const of = computeOrderFlowFeatures(candles);
    const ofScore = clamp(0.5 + (of.delta || 0)/Math.max(1, feats.avgVol||1)/2, 0, 1);
    const scores = { ind: ind.score, cnn: (cnn.probs ? (cnn.probs.bull/100) : (cnn.score||0.5)), of: ofScore, news: 0.5 };
    const fused = fuseScores(scores);
    const bull = fused.fused;
    const probBull = Math.round(bull*10000)/100;
    const probBear = Math.round((1-bull)*10000)/100;
    const label = probBull > 60 ? "Bullish" : probBear > 60 ? "Bearish" : "Neutral";
    return { modelVersion: "ml_module_v11_ultra-micro", label, prob: Math.max(probBull, probBear), probBull, probBear, raw: { ind: ind.score, cnn: cnn, of: ofScore } };
  } catch (e) {
    return { error: e?.toString?.() || String(e), label: "Neutral" };
  }
}

// -------------- Adaptive training --------------
export async function trainAdaptive(batch=[]) {
  try {
    if (!Array.isArray(batch) || !batch.length) return { ok:false, message: "no data" };
    for (const b of batch) { updateAdaptiveWeights(b.trueLabel, b.fusedProb, { breakdown: b.breakdown }); }
    saveStats();
    return { ok:true, weights: _stats.adaptiveWeights };
  } catch (e) { return { ok:false, error: e?.toString?.() || String(e) }; }
}

// -------------- markOutcome (external) --------------
export function markOutcome(symbol, alertId, success=true, trueLabel=null) {
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

// -------------- stats helpers --------------
export function getStats() {
  const acc = calculateAccuracy();
  return { ..._stats, accuracy: acc.accuracy ?? 0 };
}
export function resetStats() {
  _stats = { total:0, wins:0, losses:0, alerts: [], adaptiveWeights: _stats.adaptiveWeights || { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1, lr:0.02 }, lastUpdated: null };
  saveStats();
  return _stats;
}

// default export
const defaultExport = {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome,
  markOutcome,
  getStats,
  trainAdaptive,
  resetStats
};

export default defaultExport;