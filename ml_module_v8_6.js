// ml_v12_precision_improved.js
// ML v12 Precision — Improved / Stabilized for TG integration
// Exports many functions expected by tg_commands.js
// Author: generated/adapted from user's v12 -> improved

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";
import * as indicators from "./core_indicators.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// Persistence config
const ML_LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v12_logs");
const ENABLE_PERSIST = !!ML_LOG_DIR;
const PRED_FILE = path.join(ML_LOG_DIR, "predictions.json");
const OUT_FILE = path.join(ML_LOG_DIR, "outcomes.json");
const STATS_FILE = path.join(ML_LOG_DIR, "stats.json");
const DEFAULT_THROTTLE_MS = Number(process.env.ML_THROTTLE_MS || 200);

if (ENABLE_PERSIST) try { if (!fs.existsSync(ML_LOG_DIR)) fs.mkdirSync(ML_LOG_DIR, { recursive: true }); } catch(e){}

const readJsonSafe = (f, fallback = []) => {
  if (!ENABLE_PERSIST) return fallback;
  try { if (!fs.existsSync(f)) return fallback; const s = fs.readFileSync(f,"utf8"); return JSON.parse(s||"[]"); } catch(e){ return fallback; }
};
const writeJsonSafe = (f, obj) => {
  if (!ENABLE_PERSIST) return false;
  try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch(e){ return false; }
};

// Utils
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const nowISO = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let _lastCall = 0;

// Stats/adaptive weights (persisted)
let _stats = {
  total:0, wins:0, losses:0, accuracyCache:null,
  adaptiveWeights: { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1, lr:0.02 },
  alerts: [], lastUpdated: null, meta:{ version: "v12_precision_improved" }
};
try {
  const raw = readJsonSafe(STATS_FILE, null);
  if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw);
} catch(e){}

// Persistence helpers
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []);
    arr.push(Object.assign({}, pred, { recordedAt: nowISO() }));
    writeJsonSafe(PRED_FILE, arr);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id || null, symbol: pred.symbol || pred?.ml?.symbol || null, ts: nowISO(), meta: pred.meta || pred.ml || null });
    if (_stats.alerts.length > 5000) _stats.alerts.shift();
    _stats.lastUpdated = nowISO();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch(e){ return false; }
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []);
    arr.push(Object.assign({}, outcome, { recordedAt: nowISO() }));
    writeJsonSafe(OUT_FILE, arr);
    _stats.total = (_stats.total || 0) + 1;
    if (outcome.success) _stats.wins = (_stats.wins || 0) + 1; else _stats.losses = (_stats.losses || 0) + 1;
    _stats.accuracyCache = null;
    _stats.lastUpdated = nowISO();
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch(e){ return false; }
}

export function calculateAccuracy() {
  try {
    if (_stats.accuracyCache) return _stats.accuracyCache;
    const outs = readJsonSafe(OUT_FILE, []);
    const total = outs.length || (_stats.total || 0);
    if (!total) {
      const res = { accuracy:0, total:0, correct:0 };
      _stats.accuracyCache = res;
      return res;
    }
    const correct = outs.filter(o => o && o.success).length || 0;
    const acc = Math.round((correct/total)*10000)/100;
    const res = { accuracy:acc, total, correct };
    _stats.accuracyCache = res;
    return res;
  } catch(e){ return { accuracy:0, total:0, correct:0 }; }
}

export function getStats(){ return Object.assign({}, _stats, { accuracy: calculateAccuracy() }); }
export function resetStats(){
  _stats = { total:0, wins:0, losses:0, accuracyCache:null, adaptiveWeights: { w_ind:0.45,w_cnn:0.25,w_of:0.2,w_news:0.1, lr:0.02 }, alerts:[], lastUpdated:null, meta:{ version: "v12_precision_improved" } };
  writeJsonSafe(STATS_FILE, _stats);
  return _stats;
}

// Mark outcome and optionally update adaptive weights
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
  } catch(e){ return false; }
}

// Candle utilities
function last(arr,n=1){ if(!Array.isArray(arr)||!arr.length) return null; return arr[arr.length - n]; }
function pct(a,b){ if(!isNum(a)||!isNum(b)||b===0) return 0; return (a-b)/Math.abs(b); }

function wickRatio(candles, lookback=6){
  if(!Array.isArray(candles) || !candles.length) return 1;
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

function atr(candles, period=14){
  if(!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for(let i=1;i<candles.length;i++){
    const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close;
    trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc)));
  }
  return mean(trs.slice(-period));
}

// ----------------- PRO METERS (from earlier snippet) -----------------
export function computeReboundProbability({candles1m, candles5m, candles15m, orderbook=null, tickerPrice=null, news=null}){
  let score = 30;
  const rsi1 = rsiSimple(candles1m,7);
  const rsi5 = rsiSimple(candles5m,14);
  const rsi15 = rsiSimple(candles15m,14);
  if(rsi1 < 30) score += 18;
  if(rsi5 < 30) score += 22;
  if(rsi15 < 35) score += 10;
  const wr1 = wickRatio(candles1m,6);
  const wr5 = wickRatio(candles5m,6);
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

export function computeTrendExhaustion({candles15m, candles30m}){
  let score = 0;
  function slopeFn(c){ if(!Array.isArray(c) || c.length < 4) return 0; const l = c.slice(-6); let s=0; for(let i=1;i<l.length;i++){ s += l[i].close - l[i-1].close; } return s/(l.length-1); }
  const sl15 = slopeFn(candles15m);
  const sl30 = slopeFn(candles30m);
  const atr15 = atr(candles15m,14);
  const atr30 = atr(candles30m,14);
  const atrDrop15 = (() => {
    if(!Array.isArray(candles15m) || candles15m.length < 30) return false;
    const left = atr(candles15m.slice(0, -10), 14);
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
    if(!Array.isArray(candles15m) || candles15m.length < 8) return false;
    const last8 = candles15m.slice(-8); return mean(last8.map(c=>c.volume||0)) < mean(candles15m.slice(-20,-8).map(c=>c.volume||0)||[0]) * 0.85;
  })();
  if(volTaper) score += 12;
  return { exhaustionPct: Math.round(clamp(score,0,100)), breakdown: { sl15, sl30, atr15, atr30, atrDrop15, rsi15, rsiDivergence, volTaper } };
}

export function computeVolatilityCrush({candles30m, candles15m}){
  const atrNow = atr(candles30m,14);
  const atrPrev = (() => { if(!Array.isArray(candles30m) || candles30m.length < 40) return atrNow; return atr(candles30m.slice(0, -10), 14); })();
  const atrDropPct = atrPrev > 0 ? (atrPrev - atrNow)/atrPrev : 0;
  const bodySizes = (candles15m || []).slice(-8).map(c => Math.abs(c.close - c.open) || 0);
  const bodyNow = mean(bodySizes);
  const bodyPrev = (candles15m && candles15m.length > 20) ? mean(candles15m.slice(-28, -8).map(c=>Math.abs(c.close - c.open)||0)) : bodyNow;
  const bodyShrink = bodyPrev > 0 ? (bodyPrev - bodyNow)/Math.max(EPS, bodyPrev) : 0;
  const squeeze = atrDropPct > 0.15 && bodyShrink > 0.25;
  const score = Math.round(clamp((atrDropPct*100)*0.6 + (bodyShrink*100)*0.4, 0, 100));
  return { volCrush: squeeze ? score : Math.round(score*0.4), breakdown: { atrNow, atrPrev, atrDropPct, bodyNow, bodyPrev, bodyShrink, squeeze } };
}

export function compute30minPressure({candles1m, candles5m, candles30m, orderflow=null, orderbook=null}){
  const recent1 = (candles1m||[]).slice(-30);
  const recent5 = (candles5m||[]).slice(-12);
  function sideVolume(arr){
    let buy=0, sell=0;
    for(const c of arr){
      const delta = (c.close - c.open) * (c.volume||0);
      if(delta >= 0) buy += Math.abs(delta); else sell += Math.abs(delta);
    }
    return { buy, sell, total: buy+sell };
  }
  const v1 = sideVolume(recent1);
  const v5 = sideVolume(recent5);
  const buyRatio1 = v1.total ? v1.buy / v1.total : 0.5;
  const buyRatio5 = v5.total ? v5.buy / v5.total : 0.5;
  let cvdScore = 0;
  if(orderflow && typeof orderflow.cvd === 'number'){
    cvdScore = clamp(orderflow.cvd / 100000, -1, 1);
  }
  const emaShort = (() => {
    if(!Array.isArray(candles5m) || candles5m.length < 10) return 0;
    const latest = candles5m.slice(-10);
    return mean(latest.map(c => c.close));
  })();
  const emaLong = (() => {
    if(!Array.isArray(candles30m) || candles30m.length < 6) return emaShort;
    const latest = candles30m.slice(-6);
    return mean(latest.map(c => c.close));
  })();
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
  sellPct += obPressure * 3;
  sellPct = Math.round(clamp(sellPct, 0, 100));
  return { sellPressurePct: sellPct, buyRatio1, buyRatio5, cvdScore, emaAlignBear, obPressure, breakdown: { v1, v5 } };
}

// ----------------- CNN / Candle heuristic (deterministic) -----------------
function candleVisionHeuristic(candles, lookback = 8){
  if(!Array.isArray(candles) || candles.length === 0) return { label:"Neutral", probs:{ bull:33.33, bear:33.33, neutral:33.33 }, score:0.5, features:{} };
  const last = candles.slice(-Math.min(lookback, candles.length));
  const up = last.filter(c=>c.close > c.open).length;
  const down = last.filter(c=>c.close < c.open).length;
  const momentum = (last.at(-1).close - last[0].close) / Math.max(EPS, last[0].close);
  const vol = mean(last.map(c => Number(c.volume||0)));
  let score = 0.5 + clamp(momentum * 5, -0.45, 0.45);
  const lc = last.at(-1);
  const body = Math.abs(lc.close - lc.open) || 1;
  const upper = lc.high - Math.max(lc.open, lc.close);
  const lower = Math.min(lc.open, lc.close) - lc.low;
  if(lower > body * 1.6 && upper < body * 0.6) score += 0.12;
  if(upper > body * 1.6 && lower < body * 0.6) score -= 0.12;
  score = clamp(score, 0.01, 0.99);
  const bull = Math.round(score * 10000)/100;
  const bear = Math.round((1 - score) * 10000)/100;
  const label = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";
  return { label, probs: { bull, bear, neutral: Math.round((100 - bull - bear) * 100)/100 }, score, features:{ momentum, up, down, vol } };
}

// ----------------- Feature builder & layers -----------------
function buildFeaturesFromCandles(candles) {
  if(!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const closes = candles.map(c => Number(c.close||0));
  const last = candles[n-1];
  const close = Number(last.close || 0);
  const len = Math.min(20, n);
  let xmean=0,ymean=0;
  for(let i=0;i<len;i++){ xmean += i; ymean += closes[n-len+i]; }
  xmean /= len; ymean /= len;
  let num=0, den=0;
  for(let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den === 0 ? 0 : num/den;
  const trs = [];
  for(let i=1;i<n;i++){ const h=Number(candles[i].high||0), l=Number(candles[i].low||0), pc=Number(candles[i-1].close||0); trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc))); }
  const atrv = trs.length ? mean(trs.slice(-14)) : 0;
  const mom3 = n >= 4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n-11]) / Math.max(EPS, closes[n-11]) : 0;
  const vols = candles.map(c => Number(c.volume||0));
  const avgVol = mean(vols.slice(-20));
  let gains=0, losses=0;
  for(let i=Math.max(1,n-14); i<n; i++){ const d = closes[i] - closes[i-1]; if(d>0) gains += d; else losses += Math.abs(d); }
  const avgGain = gains/14 || 0; const avgLoss = losses/14 || 0;
  const rsi = (avgGain+avgLoss) ? 100 - (100 / (1 + avgGain/Math.max(EPS, avgLoss))) : 50;
  const of = (() => { if(n < 2) return {}; const lastVol = Number(last.volume||0); const prev = candles[n-2]; const delta = (last.close - last.open) * (last.volume || 1); const vel = last.close - prev.close; return { delta, vel, lastVol, avgVol, swingHigh: Math.max(...candles.slice(-8).map(c=>c.high)), swingLow: Math.min(...candles.slice(-8).map(c=>c.low)) }; })();
  return { close, slope, mom3, mom10, atr: atrv, rsi, avgVol, lastVol: (last.volume||0), of, candles };
}

function indicatorLayer(feats) {
  if(!feats) return { score:0.5, details:{} };
  const { slope, mom3, rsi, avgVol, lastVol } = feats;
  let s = 0.5;
  s += clamp(Math.tanh(slope / Math.max(1, Math.abs(feats.close||1))) * 0.5, -0.25, 0.25);
  s += clamp((Math.tanh(mom3 * 6) || 0) * 0.25, -0.2, 0.2);
  if(isNum(rsi)) { const rn = clamp((rsi - 50)/50, -1, 1); s += rn * 0.15; }
  if(avgVol && lastVol) { s += clamp((lastVol / Math.max(EPS, avgVol) - 1) * 0.05, -0.05, 0.05); }
  s = clamp(s, 0.01, 0.99);
  return { score: s, details:{ slope, mom3, rsi } };
}

async function cnnLayer(candles) { const cv = candleVisionHeuristic(candles,8); return { score: cv.score || 0.5, probs: cv.probs, features: cv.features }; }

function orderFlowScore(of) {
  if(!of) return 0.5;
  let s = 0.5;
  if(isNum(of.delta)) s += clamp(Math.tanh(of.delta / Math.max(1, of.avgVol || 1)) * 0.2, -0.2, 0.2);
  if(isNum(of.vel)) s += clamp(Math.tanh(of.vel / Math.max(1, (of.avgVol || 1) / 100)) * 0.15, -0.15, 0.15);
  return clamp(s, 0.01, 0.99);
}

// ----------------- Adaptive weights helpers -----------------
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
    if(!w) return;
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

// ----------------- TP helpers -----------------
function buildCandidateTPsFromElliott(ell){
  if(!ell || !Array.isArray(ell.targets)) return [];
  return ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), source: t.source || t.type || "elliott", confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)) })).filter(x => isNum(x.tp) && x.tp>0);
}
function buildATRFallbackTPs(price, atr){
  atr = Math.max(atr || 0, Math.abs(price) * 0.0005, 1);
  return [
    { tp: Number((price + atr * 2.5).toFixed(8)), source: "ATR_UP", confidence: 30 },
    { tp: Number((price - atr * 2.5).toFixed(8)), source: "ATR_DOWN", confidence: 30 }
  ];
}
function dedupeCandidates(candidates, price){
  const map = new Map();
  for(const c of candidates){ const key = Math.round(c.tp); if(!map.has(key) || (c.confidence||0) > map.get(key).confidence) map.set(key, c); }
  const arr = Array.from(map.values());
  arr.sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
  return arr;
}
function choosePrimaryHedge(candidates, dir, price, feats, config = {}){
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  const minDist = config.MIN_TP_DISTANCE || atr * (config.MIN_TP_DISTANCE_ATR_MULT || 1.2);
  const meaningful = candidates.filter(c => Math.abs(c.tp - price) >= minDist);
  const pool = meaningful.length ? meaningful : candidates;
  if(!pool.length){
    const primary = (dir === "Bullish") ? price + atr * 2.5 : (dir === "Bearish") ? price - atr * 2.5 : price + atr * 2.5;
    const hedge = (dir === "Bullish") ? price - atr * 1.2 : (dir === "Bearish") ? price + atr * 1.2 : price - atr * 1.2;
    return { primary: Number(primary), hedge: Number(hedge), primarySource:"ATR_FALLBACK", hedgeSource:"ATR_HEDGE", confidence:40 };
  }
  let primary = null;
  if(dir === "Bullish") primary = pool.find(p => p.tp > price) || pool[0];
  else if(dir === "Bearish") primary = pool.find(p => p.tp < price) || pool[0];
  else primary = pool[0];
  const opp = pool.find(p => (dir === "Bullish" ? p.tp < price : p.tp > price));
  const atrH = Math.max(feats?.atr || atr, Math.abs(price) * 0.0005);
  const hedge = opp || { tp: Number((price + (dir === "Bullish" ? -atrH * 1.2 : atrH * 1.2)).toFixed(8)), source:"HEDGE_ATR", confidence:30 };
  const pconf = Math.round(Math.min(100, (primary.confidence || 40) * 0.6 + 40));
  return { primary: Number(primary.tp), hedge: Number(hedge.tp), primarySource: primary.source || "CAND", hedgeSource: hedge.source || "CAND", confidence: pconf };
}

// ----------------- Precision decision core (getMLDirectionPrecision) -----------------
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
function getMLDirectionPrecision(features) {
  const { slope, mom3, rsi, vol, atrNorm, newsImpact, sentiment, systemProb } = features;
  const momStrength = mom3 * (rsi / 50);
  const slopeSign = Math.sign(slope || 0);
  const slopeMag = Math.abs(slope || 0);
  const smoothedSlope = (slope * 0.55) + (slopeSign * Math.sqrt(Math.abs(slopeMag)) * 0.25) + (slope * atrNorm * 0.20);
  const volBase = Math.max(1, Math.abs(vol || 1));
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

// ----------------- MAIN runMLPrediction (v12 precision) -----------------
export async function runMLPrediction(symbol="BTCUSDT", tfc="15m", opts={}){
  try {
    const now = Date.now();
    if (now - _lastCall < DEFAULT_THROTTLE_MS) await sleep(DEFAULT_THROTTLE_MS - (now - _lastCall));
    _lastCall = Date.now();

    const DEFAULT_CONFIG = { fusedTFs: ["15m","30m","1h"], minTFsForFusion:2, MIN_TP_DISTANCE_ATR_MULT:1.2, MAX_PER_TF_SNAPS:1 };
    const CONFIG = Object.assign({}, DEFAULT_CONFIG, opts.config || {});

    const tfsToFetch = Array.from(new Set([tfc, ...CONFIG.fusedTFs, "1m", "5m", "30m", "1h"])).slice(0,12);
    const mtfRaw = await fetchMultiTF(symbol, tfsToFetch);
    const primaryRaw = mtfRaw[tfc] || { data: [], price: 0 };
    const candles = Array.isArray(primaryRaw.data) ? primaryRaw.data : [];
    const price = isNum(primaryRaw.price) && primaryRaw.price > 0 ? primaryRaw.price : (candles?.at(-1)?.close ?? 0);

    if(!candles || candles.length < 6 || price <= 0){
      return {
        modelVersion: "ml_v12_precision_improved",
        symbol, tf: tfc, direction: "Neutral",
        probs: { bull:33.33, bear:33.33, neutral:33.33 }, maxProb:33.33,
        tpEstimate: null, tpSource: null, tpConfidence: 0, slEstimate: null, perTf: []
      };
    }

    const feats = buildFeaturesFromCandles(candles);
    const indLayer = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowScore(feats?.of || {});
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment === "number") ? clamp(newsObj.sentiment, 0, 1) : 0.5;

    // per-TF snapshots for fusedTFs
    const perTfSnapshots = [];
    for(const tf of CONFIG.fusedTFs){
      const raw = mtfRaw[tf] || { data: [], price: 0 };
      const c = Array.isArray(raw.data) ? raw.data : [];
      const priceTf = isNum(raw.price) && raw.price>0 ? raw.price : (c?.at(-1)?.close ?? 0);
      const featsTf = buildFeaturesFromCandles(c);
      const indTf = indicatorLayer(featsTf);
      const cnnTf = await cnnLayer(c);
      const ofTf = orderFlowScore(featsTf?.of || {});
      perTfSnapshots.push({ tf, price: priceTf, feats: featsTf, ind: indTf, cnn: cnnTf, of: ofTf });
    }

    // Fuse per-TF quick probabilities (simple weight)
    let bullScore=0, bearScore=0, neutralScore=0, wsum=0;
    const TF_WEIGHTS = { "15m":0.40, "30m":0.35, "1h":0.25 };
    for(const s of perTfSnapshots){
      const w = TF_WEIGHTS[s.tf] ?? 0.2;
      const indS = s.ind.score || 0.5;
      const cnnS = s.cnn.score || 0.5;
      const ofS = s.of || 0.5;
      const fused = indS * (_stats.adaptiveWeights.w_ind || 0.45) + cnnS * (_stats.adaptiveWeights.w_cnn || 0.25) + ofS * (_stats.adaptiveWeights.w_of || 0.2) + (newsScore * (_stats.adaptiveWeights.w_news || 0.1));
      const bull = fused;
      const bear = 1 - fused;
      bullScore += bull * w;
      bearScore += bear * w;
      wsum += w;
    }
    const fusedProbBull = wsum ? bullScore/wsum : 0.5;
    const fusedProbBear = wsum ? bearScore/wsum : 0.5;

    // Direction precision
    const decisionFeatures = buildDecisionFeaturesForPrecision(feats, newsObj, fusedProbBull);
    const dirRes = getMLDirectionPrecision(decisionFeatures);

    // Determine TP candidates: use Elliott targets where available else ATR fallback
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch(e){ ell = null; }
    const clusterCandidates = buildCandidateTPsFromElliott(ell);
    const atrFallback = buildATRFallbackTPs(price, feats?.atr || 0);
    const candidates = clusterCandidates.length ? clusterCandidates.concat(atrFallback) : atrFallback;

    // choose primary/hedge considering dirRes.direction
    const ded = dedupeCandidates(candidates, price);
    const chosen = choosePrimaryHedge(ded, dirRes.direction, price, feats, { MIN_TP_DISTANCE_ATR_MULT: CONFIG.MIN_TP_DISTANCE_ATR_MULT });

    // Compose ML object (per-TF minimal object)
    const out = {
      modelVersion: "ml_v12_precision_improved",
      symbol,
      tf: tfc,
      timestamp: nowISO(),
      direction: dirRes.direction,
      confidence: dirRes.confidence,
      probBull: dirRes.probBull,
      probs: { bull: Math.round(dirRes.probBull*100)/100, bear: Math.round((100-dirRes.probBull)*100)/100 },
      tpEstimate: chosen.primary,
      tpSource: chosen.primarySource || "cluster/elliott/atr",
      tpConfidence: chosen.confidence || dirRes.confidence,
      hedgeTP: chosen.hedge,
      perTf: perTfSnapshots,
      explanation: { indLayer, cnn: cnn.features || cnn, ofScore, news: { sentiment: newsObj.sentiment, impact: newsObj.impact }, decisionFeatures }
    };

    // optional record
    try { recordPrediction({ id:`ml-${symbol}-${tfc}-${Date.now()}`, symbol, ml: out, meta:{ scores:{ ind: indLayer.score, cnn: cnn.score, of: ofScore }, fusedProb: fusedProbBull } }); } catch(e){}

    return out;
  } catch(e){
    return { modelVersion: "ml_v12_precision_improved", symbol, tf: tfc, direction:"Neutral", probs:{ bull:33.33,bear:33.33,neutral:33.33 }, maxProb:33.33, tpEstimate:null, tpSource:null, tpConfidence:0, slEstimate:null, perTf:[] };
  }
}

// Micro prediction (1m quick)
export async function runMicroPrediction(symbol="BTCUSDT", tfc="1m"){
  try {
    const mtf = await fetchMultiTF(symbol, [tfc]);
    const raw = mtf[tfc] || { data: [], price: 0 };
    const candles = Array.isArray(raw.data) ? raw.data : [];
    if(!candles || candles.length < 4) return null;
    const feats = buildFeaturesFromCandles(candles);
    const ind = indicatorLayer(feats);
    const cv = candleVisionHeuristic(candles, 6);
    const of = orderFlowScore(feats?.of || {});
    const score = ind.score * 0.6 + cv.score * 0.3 + of * 0.1;
    const direction = score >= 0.6 ? "Bullish" : score <= 0.4 ? "Bearish" : "Neutral";
    return { symbol, tf: tfc, score: Math.round(score*100)/100, direction, explanation:{ ind, cv, of } };
  } catch(e){ return null; }
}

// ----------------- Stable target fusion -----------------
export function fuseMLTFs(mlListInput = []) {
  // Accept either array or object-like { "15m":obj, "30m":obj, ... }
  const mlList = Array.isArray(mlListInput) ? mlListInput : (typeof mlListInput === "object" ? Object.values(mlListInput) : []);
  const WEIGHTS = { "15m":0.40, "30m":0.35, "1h":0.25 };
  const available = mlList.filter(m => m && m.tf);
  if(!available.length) return null;
  let bullScore=0, bearScore=0, neutralScore=0;
  const tps = [];
  for(const m of available){
    const w = WEIGHTS[m.tf] ?? 0.2;
    const maxProb = Number(m.tpConfidence ?? m.confidence ?? (m.probs && (m.probs.bull||m.probs.bear) ) || 0);
    const dir = (m.direction || m.label || "Neutral");
    if(String(dir).toLowerCase().includes("bull")) bullScore += (maxProb/100) * w;
    else if(String(dir).toLowerCase().includes("bear")) bearScore += (maxProb/100) * w;
    else neutralScore += (maxProb/100) * w;
    tps.push({ tf: m.tf, tp: Number(m.tpEstimate ?? m.tpEstimate ?? m.tp ?? m.tpEstimate ?? m.tpEstimate ?? m.tpEstimate || m.tp || m.tpEstimate || m.tp || 0), hedge: Number(m.hedgeTP ?? m.hedge ?? m.hedgeTP ?? 0), tpConfidence: Number(m.tpConfidence ?? m.confidence ?? maxProb), maxProb });
  }
  const finalDir = (bullScore > bearScore && bullScore > neutralScore) ? "Bullish" : (bearScore > bullScore && bearScore > neutralScore) ? "Bearish" : "Neutral";
  let wSum=0,tpSum=0,hedgeSum=0,confSum=0;
  for(const t of tps){
    const w = WEIGHTS[t.tf] ?? 0.2;
    const mdir = (available.find(x=>x.tf===t.tf)?.direction || "Neutral");
    let includeWeight = w;
    if(finalDir === "Bullish" && String(mdir).toLowerCase().includes("bear") && t.maxProb > 60) includeWeight *= 0.15;
    if(finalDir === "Bearish" && String(mdir).toLowerCase().includes("bull") && t.maxProb > 60) includeWeight *= 0.15;
    if(isNum(t.tp) && t.tp > 0){ tpSum += t.tp * includeWeight; wSum += includeWeight; }
    if(isNum(t.hedge) && t.hedge > 0){ hedgeSum += t.hedge * includeWeight; confSum += (t.tpConfidence || t.maxProb) * includeWeight; }
  }
  const primaryTP = (wSum>0) ? (tpSum/wSum) : (tps[0] ? tps[0].tp : null);
  const hedgeTP = (confSum>0) ? (hedgeSum/wSum) : (tps[0] ? tps[0].hedge : null);
  const avgConfidence = (wSum>0) ? (confSum/wSum) : (available.reduce((a,b)=>a + (b.maxProb||0),0) / available.length || 0);
  return { direction: finalDir, primaryTP: isNum(primaryTP) ? Number(primaryTP) : null, hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null, confidence: Math.round(clamp(avgConfidence,0,100)) };
}

export function buildStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  // Backwards-compatible: accept clusterTargets array (candidates), mlFusion object
  const sorted = (Array.isArray(clusterTargets) ? clusterTargets.slice() : []).sort((a,b)=>b.confidence - a.confidence);
  const dir = mlFusion?.direction || "Neutral";
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005, 1);
  // If mlFusion provides explicit primaryTP/hedgeTP, prefer it (but ensure direction/gap)
  if(mlFusion && isNum(mlFusion.primaryTP) && mlFusion.primaryTP > 0){
    const primaryFromML = { tp: Number(mlFusion.primaryTP), source: "ML", confidence: mlFusion.confidence ?? 50 };
    const hedgeFromML = (isNum(mlFusion.hedgeTP) && mlFusion.hedgeTP>0) ? { tp: Number(mlFusion.hedgeTP), source: "ML", confidence: mlFusion.confidence ?? 40 } : { tp: (dir === "Bullish" ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence:30 };
    // if cluster has better candidate aligned with ML direction, pick that instead
    const bulls = sorted.filter(s => s.tp > price);
    const bears = sorted.filter(s => s.tp < price);
    let chosenPrimary = primaryFromML;
    if(dir === "Bullish" && bulls.length && Math.abs(bulls[0].tp - price) < Math.abs(primaryFromML.tp - price) * 1.2) chosenPrimary = bulls[0];
    if(dir === "Bearish" && bears.length && Math.abs(bears[0].tp - price) < Math.abs(primaryFromML.tp - price) * 1.2) chosenPrimary = bears[0];
    return {
      primaryTP: Number(chosenPrimary.tp),
      hedgeTP: Number(hedgeFromML.tp),
      primarySource: chosenPrimary.source || "ML",
      hedgeSource: hedgeFromML.source || "ML",
      primaryConf: Math.round(chosenPrimary.confidence ?? mlFusion.confidence ?? 40),
      direction: dir
    };
  }

  // If no ML primary, choose from cluster or ATR fallback
  if(sorted.length){
    const bulls = sorted.filter(s => s.tp > price);
    const bears = sorted.filter(s => s.tp < price);
    let primary = null, hedge = null;
    if(dir === "Bullish") primary = (bulls.length ? bulls[0] : sorted[0]);
    else if(dir === "Bearish") primary = (bears.length ? bears[0] : sorted[0]);
    else primary = sorted[0];
    if(dir === "Bullish") hedge = (bears.length ? bears[0] : { tp: price - atr * 1.2, source:"HEDGE_ATR", confidence:30 });
    else if(dir === "Bearish") hedge = (bulls.length ? bulls[0] : { tp: price + atr * 1.2, source:"HEDGE_ATR", confidence:30 });
    else hedge = (sorted.length > 1 ? sorted[1] : { tp: (primary.tp > price ? price - atr * 1.2 : price + atr * 1.2), source:"HEDGE_ATR", confidence:30 });
    return {
      primaryTP: Number(primary.tp),
      hedgeTP: Number(hedge.tp),
      primarySource: primary.source || "Cluster",
      hedgeSource: hedge.source || "Cluster",
      primaryConf: Math.round(primary.confidence ?? 40),
      direction: dir
    };
  }

  // fallback to ATR
  const primary = dir === "Bullish" ? price + atr * 2.5 : dir === "Bearish" ? price - atr * 2.5 : price + atr * 2.5;
  const hedge = dir === "Bullish" ? price - atr * 1.2 : dir === "Bearish" ? price + atr * 1.2 : price - atr * 1.2;
  return { primaryTP: Number(primary), hedgeTP: Number(hedge), primarySource: "ATR", hedgeSource: "HEDGE_ATR", primaryConf:30, direction:dir };
}

// ----------------- Train adaptive (simple online) -----------------
export function trainAdaptive(samples = []) {
  try {
    for(const s of samples){
      if(!s || !s.trueLabel || !s.scores) continue;
      const fused = fuseScores(s.scores, _stats.adaptiveWeights);
      updateAdaptiveWeights(s.trueLabel, fused.fused, { breakdown: fused.breakdown });
    }
    writeJsonSafe(STATS_FILE, _stats);
    return true;
  } catch(e){ return false; }
}

// ----------------- Convenience: BuildAIReport (lightweight) -----------------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = opts.tfs && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const blocks = [];
    for(const tf of tfs){
      const entry = mtfRaw[tf] || { data: [], price:0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price>0 ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = { RSI: indicators.computeRSI?.(candles) ?? rsiSimple(candles,14), MACD: indicators.computeMACD?.(candles) ?? { hist:0 }, ATR: indicators.computeATR?.(candles) ?? atr(candles,14) };
      let ell = null;
      try{ ell = await analyzeElliott(candles); } catch(e){ ell = null; }
      const ellSummary = { support: ell?.pivots?.filter(p=>p.type==="L").at(-1)?.price ?? null, resistance: ell?.pivots?.filter(p=>p.type==="H").at(-1)?.price ?? null, confidence: ell?.confidence ?? 0 };
      const targets = (ell && Array.isArray(ell.targets) && ell.targets.length) ? ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source||t.type||tf })).filter(x=>isNum(x.tp) && x.tp>0) : buildATRFallbackTPs(price, ind.ATR);
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // run ML per stable TF and fuse
    const mlTfs = ["15m","30m","1h"];
    const mlResults = [];
    for(const mt of mlTfs){
      try{ const r = await runMLPrediction(symbol, mt); if(r) mlResults.push(r); } catch(e){}
    }
    const mlFusion = fuseMLTFs(mlResults);
    const price = blocks.find(b=>b.tf==="15m")?.price || blocks[0]?.price || 0;
    const allCandidates = blocks.flatMap(b => (b.targets || []));
    const stableTargets = buildStableTargets(allCandidates, mlFusion || {}, price, { atr: blocks.find(b=>b.tf==="15m")?.indicators?.ATR || 0 });
    const news = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low" }));

    const overallFusion = (() => {
      // quick fusion across TF fusion scores
      const TF_WEIGHTS = { "1m":0.05,"5m":0.08,"15m":0.4,"30m":0.22,"1h":0.25 };
      let s=0, ws=0;
      for(const b of blocks){
        const f = ((b.indicators?.RSI ?? 50) - 50) / 50;
        const w = TF_WEIGHTS[b.tf] ?? 0.1;
        s += f * w; ws += w;
      }
      let base = ws ? clamp(s/ws, -1, 1) : 0;
      if(mlFusion?.confidence) base = clamp(base + (mlFusion.confidence/100)*0.18, -1, 1);
      const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
      const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase()==="high" ? 1.0 : 0.4);
      return clamp(base + newsBoost * 0.12, -1, 1);
    })();

    return {
      ok:true,
      symbol,
      generatedAt: nowISO(),
      blocks,
      price,
      stableTargets,
      ml: { perTF: mlResults, fusion: mlFusion },
      overallFusion,
      news,
      mlAcc: calculateAccuracy()
    };
  } catch(e){
    return { ok:false, error: e?.message || String(e) };
  }
}

// ---------- default export ----------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
  markOutcome, getStats, trainAdaptive, resetStats,
  computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
  fuseMLTFs, buildStableTargets, buildAIReport
};
export default defaultExport;