// ml_module_v13_ultra.js
// ML v13 Ultra-Dynamic Precision
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
//          markOutcome, getStats, trainAdaptive, resetStats,
//          computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
//          fuseMLTFs, buildStableTargets, buildAIReport
//
// Requirements (must exist in repo):
//  - ./utils.js -> fetchMultiTF(symbol, tfsArray)
//  - ./elliott_module.js -> analyzeElliott(candles)
//  - ./news_social.js -> fetchNewsBundle
//  - ./core_indicators.js -> optional computeRSI, computeATR, computeMACD, volumeTrend
//
// Usage: import ML from './ml_module_v13_ultra.js';

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";
import * as indicators from "./core_indicators.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// ---------- Config & persistence ----------
const LOG_DIR = process.env.ML_LOG_DIR || path.join(process.cwd(), ".ml_v13_logs");
const PRED_FILE = path.join(LOG_DIR, "preds.json");
const OUT_FILE = path.join(LOG_DIR, "outs.json");
const STATS_FILE = path.join(LOG_DIR, "stats.json");
const DEFAULT_THROTTLE_MS = Number(process.env.ML_THROTTLE_MS || 150);

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const readJson = (f, fallback) => {
  try { if (!fs.existsSync(f)) return fallback; return JSON.parse(fs.readFileSync(f, "utf8") || "null") || fallback; } catch (e) { return fallback; }
};
const writeJson = (f, obj) => { try { fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; } };

// ---------- Utilities ----------
const EPS = 1e-12;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const nowISO = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let _lastCall = 0;

// ---------- state ----------
let _stats = {
  total:0, wins:0, losses:0, accuracyCache:null,
  adaptiveWeights: { w_ind:0.45, w_cnn:0.25, w_of:0.18, w_news:0.12, lr:0.03 },
  alerts: [], lastUpdated: null, meta:{ version:"v13_ultra" }
};
try {
  const raw = readJson(STATS_FILE, null);
  if (raw && typeof raw === "object") _stats = Object.assign(_stats, raw);
} catch (e) {}

// ---------- persistence helpers ----------
export function recordPrediction(pred) {
  try {
    const arr = readJson(PRED_FILE, []);
    arr.push({ ...pred, recordedAt: nowISO() });
    writeJson(PRED_FILE, arr);
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ id: pred.id || null, symbol: pred.symbol || null, ts: nowISO(), meta: pred.meta || null });
    if (_stats.alerts.length > 5000) _stats.alerts.shift();
    _stats.lastUpdated = nowISO(); writeJson(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function recordOutcome(out) {
  try {
    const arr = readJson(OUT_FILE, []);
    arr.push({ ...out, recordedAt: nowISO() });
    writeJson(OUT_FILE, arr);
    _stats.total = (_stats.total||0) + 1;
    if (out.success) _stats.wins = (_stats.wins||0) + 1; else _stats.losses = (_stats.losses||0) + 1;
    _stats.accuracyCache = null; _stats.lastUpdated = nowISO(); writeJson(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

export function calculateAccuracy() {
  try {
    if (_stats.accuracyCache) return _stats.accuracyCache;
    const outs = readJson(OUT_FILE, []);
    const total = outs.length || _stats.total || 0;
    if (!total) { const r = { accuracy:0, total:0, correct:0 }; _stats.accuracyCache=r; return r; }
    const correct = outs.filter(o => o && o.success).length || 0;
    const acc = Math.round((correct/total)*10000)/100;
    const res = { accuracy: acc, total, correct };
    _stats.accuracyCache = res; return res;
  } catch (e) { return { accuracy:0, total:0, correct:0 }; }
}

export function getStats(){ return { ..._stats, accuracy: calculateAccuracy() }; }
export function resetStats(){ _stats = { total:0,wins:0,losses:0,accuracyCache:null,adaptiveWeights:{ w_ind:0.45,w_cnn:0.25,w_of:0.18,w_news:0.12,lr:0.03 },alerts:[],lastUpdated:null,meta:{version:"v13_ultra"} }; writeJson(STATS_FILE,_stats); return _stats; }

// markOutcome: record and optionally adapt weights
export function markOutcome(symbol, alertId, success=true, trueLabel=null){
  try{
    recordOutcome({ alertId, symbol, success, ts: nowISO() });
    if (trueLabel && alertId) {
      const preds = readJson(PRED_FILE, []);
      const p = preds.find(x=>x.id===alertId);
      if (p && p.meta && p.meta.scores) {
        const fused = fuseScores(p.meta.scores, _stats.adaptiveWeights);
        updateAdaptiveWeights(trueLabel, fused.fused, { breakdown: fused.breakdown });
        writeJson(STATS_FILE, _stats);
      }
    }
    return true;
  } catch (e) { return false; }
}

// ---------- Candle helpers & features ----------
const mean = arr => Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
function last(arr,n=1){ if(!Array.isArray(arr)||!arr.length) return null; return arr[arr.length - n]; }

function simpleRSI(candles, period=14){
  if(!Array.isArray(candles) || candles.length < period+1) return 50;
  let gains=0, losses=0;
  for(let i=candles.length-period;i<candles.length;i++){ const d=candles[i].close-candles[i-1].close; if(d>0) gains+=d; else losses+=Math.abs(d); }
  const avgG = gains/period, avgL = losses/period;
  if(avgG+avgL===0) return 50;
  const rs = avgG/Math.max(EPS,avgL); return 100 - (100/(1+rs));
}

function computeATR(candles, period=14){
  if(!Array.isArray(candles) || candles.length < 2) return 0;
  const trs=[];
  for(let i=1;i<candles.length;i++){ const h=candles[i].high, l=candles[i].low, pc=candles[i-1].close; trs.push(Math.max(Math.abs(h-l), Math.abs(h-pc), Math.abs(l-pc))); }
  return mean(trs.slice(-period));
}

function slopeOfCloses(candles, len=12){
  if(!Array.isArray(candles) || candles.length < 3) return 0;
  const slice = candles.slice(-len);
  const n = slice.length;
  const xs = slice.map((_,i)=>i);
  const ys = slice.map(c=>c.close);
  const xm = mean(xs), ym = mean(ys);
  let num=0, den=0;
  for(let i=0;i<n;i++){ num += (xs[i]-xm)*(ys[i]-ym); den += (xs[i]-xm)*(xs[i]-xm); }
  return den===0?0:num/den;
}

// candle-vision heuristic (deterministic fallback)
function candleVision(candles, lookback=8){
  if(!Array.isArray(candles)||!candles.length) return { score:0.5, label:"Neutral", probs:{bull:33.33,bear:33.33,neutral:33.33}, features:{} };
  const lastN = candles.slice(-Math.min(lookback,candles.length));
  const momentum = (lastN.at(-1).close - lastN[0].close)/Math.max(EPS,lastN[0].close);
  const up = lastN.filter(c=>c.close>c.open).length;
  const down = lastN.filter(c=>c.close<c.open).length;
  let score = 0.5 + clamp(momentum*6, -0.45, 0.45);
  const lc = lastN.at(-1);
  const body = Math.max(Math.abs(lc.close-lc.open), 1e-8);
  const upper = lc.high - Math.max(lc.open, lc.close);
  const lower = Math.min(lc.open, lc.close) - lc.low;
  if(lower > body*1.6) score += 0.08;
  if(upper > body*1.6) score -= 0.08;
  score = clamp(score, 0.01, 0.99);
  const bull = Math.round(score*10000)/100;
  const bear = Math.round((1-score)*10000)/100;
  return { score, label: bull>bear?"Bullish":"Bearish", probs:{bull,bear,neutral:Math.round((100-bull-bear)*100)/100}, features:{momentum, up, down} };
}

// build features from candles robustly
function buildFeatures(candles){
  if(!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const close = Number(candles[n-1].close||0);
  const slope = slopeOfCloses(candles, Math.min(20,n));
  const mom3 = n>=4 ? (close - candles[n-4].close)/Math.max(EPS, candles[n-4].close) : 0;
  const atr = computeATR(candles, 14);
  const rsi = (typeof indicators.computeRSI==='function') ? indicators.computeRSI(candles) : simpleRSI(candles, 14);
  const vols = candles.map(c=>Number(c.volume||0));
  const avgVol = mean(vols.slice(-20));
  const lastVol = Number(candles[n-1].volume||0);
  const of = { delta: (candles[n-1].close - candles[n-1].open) * lastVol, vel: (candles[n-1].close - candles[n-2].close), avgVol, lastVol, swingHigh: Math.max(...candles.slice(-8).map(c=>c.high)), swingLow: Math.min(...candles.slice(-8).map(c=>c.low)) };
  return { close, slope, mom3, atr, rsi, avgVol, lastVol, of, candles };
}

// ---------- indicator / cnn / of layers ----------
function indicatorLayer(feats){
  if(!feats) return { score:0.5, details:{} };
  let s = 0.5;
  s += clamp(Math.tanh(feats.slope/Math.max(EPS,Math.abs(feats.close||1)))*0.5, -0.25, 0.25);
  s += clamp(Math.tanh(feats.mom3*6)*0.25, -0.2, 0.2);
  s += clamp(((feats.rsi||50)-50)/50 * 0.15, -0.15, 0.15);
  if(feats.avgVol && feats.lastVol) s += clamp((feats.lastVol/Math.max(EPS,feats.avgVol)-1)*0.05, -0.05, 0.05);
  s = clamp(s, 0.01, 0.99);
  return { score:s, details:{ slope:feats.slope, mom3:feats.mom3, rsi:feats.rsi } };
}

async function cnnLayer(candles){
  // If you have a CNN, plug it here; fallback to candleVision
  return candleVision(candles, 8);
}

function orderFlowLayer(of){
  if(!of) return 0.5;
  let s = 0.5;
  if(isNum(of.delta)) s += clamp(Math.tanh(of.delta/Math.max(1, of.avgVol))*0.2, -0.2, 0.2);
  if(isNum(of.vel)) s += clamp(Math.tanh(of.vel/Math.max(1, (of.avgVol||1)/100))*0.12, -0.12, 0.12);
  return clamp(s, 0.01, 0.99);
}

// ---------- adaptive fusion helpers ----------
function fuseScores(scores, weights){
  const w = weights || _stats.adaptiveWeights;
  const ind = clamp(scores.ind ?? 0.5, 0.01, 0.99);
  const cnn = clamp(scores.cnn ?? 0.5, 0.01, 0.99);
  const of = clamp(scores.of ?? 0.5, 0.01, 0.99);
  const news = clamp(scores.news ?? 0.5, 0.01, 0.99);
  const fused = ind*(w.w_ind||0.45) + cnn*(w.w_cnn||0.25) + of*(w.w_of||0.18) + news*(w.w_news||0.12);
  return { fused: clamp(fused,0.01,0.99), breakdown:{ind,cnn,of,news}, weights:w };
}

function updateAdaptiveWeights(trueLabel, predProb, features={}){
  try {
    const w = _stats.adaptiveWeights; if(!w) return;
    const lr = w.lr || 0.02;
    const y = trueLabel==="Bullish"?1: trueLabel==="Bearish"?0:0.5;
    const err = y - predProb;
    const contrib = features.breakdown || { ind:0.5, cnn:0.5, of:0.5, news:0.5 };
    w.w_ind = clamp(w.w_ind + lr * err * (contrib.ind - 0.5), 0.05, 0.8);
    w.w_cnn = clamp(w.w_cnn + lr * err * (contrib.cnn - 0.5), 0.05, 0.6);
    w.w_of = clamp(w.w_of + lr * err * (contrib.of - 0.5), 0.05, 0.6);
    w.w_news = clamp(w.w_news + lr * err * (contrib.news - 0.5), 0.01, 0.3);
    // normalize
    const s = w.w_ind + w.w_cnn + w.w_of + w.w_news;
    w.w_ind /= s; w.w_cnn /= s; w.w_of /= s; w.w_news /= s;
    _stats.adaptiveWeights = w; writeJson(STATS_FILE, _stats);
  } catch (e) {}
}

// ---------- TP/SL helpers ----------
function buildCandidatesFromElliott(ell){
  if(!ell || !Array.isArray(ell.targets)) return [];
  return ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), source: t.source || t.type || "elliott", confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)) }))
                    .filter(x=>isNum(x.tp) && x.tp>0);
}
function atrFallbackTPs(price, atr){
  atr = Math.max(atr||0, Math.abs(price)*0.0005, 1);
  return [
    { tp: Number((price + atr*2.2).toFixed(8)), source:"ATR_UP", confidence:30 },
    { tp: Number((price - atr*2.2).toFixed(8)), source:"ATR_DOWN", confidence:30 }
  ];
}
function dedupeCandidates(cands, price){
  const map = new Map();
  for(const c of cands){ const key = Math.round(c.tp); if(!map.has(key) || (c.confidence || 0) > (map.get(key).confidence||0)) map.set(key, c); }
  const arr = Array.from(map.values()); arr.sort((a,b)=>Math.abs(a.tp-price) - Math.abs(b.tp-price)); return arr;
}
function choosePrimaryHedge(cands, dir, price, feats, cfg={}){
  const atr = Math.max(feats?.atr || 0, Math.abs(price)*0.0005, 1);
  const minDist = cfg.MIN_TP_DISTANCE || atr * (cfg.MIN_TP_DISTANCE_ATR_MULT || 1.0);
  const meaningful = cands.filter(c=>Math.abs(c.tp - price) >= minDist);
  const pool = meaningful.length ? meaningful : cands;
  if(!pool.length){
    const primary = dir==="Bullish" ? price + atr*2.2 : dir==="Bearish" ? price - atr*2.2 : price + atr*2.2;
    const hedge = dir==="Bullish" ? price - atr*1.2 : price + atr*1.2;
    return { primary:Number(primary), hedge:Number(hedge), primarySource:"ATR_FALLBACK", hedgeSource:"ATR_HEDGE", confidence:40 };
  }
  let primary = null;
  if(dir==="Bullish") primary = pool.find(p=>p.tp>price) || pool[0];
  else if(dir==="Bearish") primary = pool.find(p=>p.tp<price) || pool[0];
  else primary = pool[0];
  const opp = pool.find(p => (dir==="Bullish" ? p.tp<price : p.tp>price));
  const hedge = opp || { tp: Number((price + (dir==="Bullish" ? -atr*1.2 : atr*1.2)).toFixed(8)), source:"HEDGE_ATR", confidence:30 };
  const pconf = Math.round(Math.min(100, (primary.confidence||40)*0.6 + 40));
  return { primary: Number(primary.tp), hedge: Number(hedge.tp), primarySource: primary.source||"CAND", hedgeSource: hedge.source||"CAND", confidence: pconf };
}

// -----------------------------
// Improved fuseMLTFs (v13) — dynamic weighting
// -----------------------------
export function fuseMLTFs(mlList = []){
  const baseWeights = { "15m": 0.42, "30m": 0.33, "1h": 0.25 };
  const available = mlList.filter(m=>m && m.tf);
  if(!available.length) return null;

  // compute momentum multiplier per TF (if provided) else default 1
  let bullScore=0, bearScore=0, neutralScore=0;
  const tps = [];
  for(const m of available){
    const w0 = baseWeights[m.tf] ?? 0.2;
    // momentum multiplier heuristic: if model provides momentum or prob change, use it; else use maxProb
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0));
    // rapid flip protection: if TF is recent (15m) and maxProb strong (>65) then boost weight
    let momentumMult = 1;
    if(m.tf==="15m" && maxProb >= 65) momentumMult = 1.35;
    if(m.tf==="30m" && maxProb >= 70) momentumMult = 1.15;
    if(m.tf==="1h" && maxProb >= 80) momentumMult = 1.05;
    const w = w0 * momentumMult;
    const dir = (m.direction || m.label || "Neutral");
    if(String(dir).toLowerCase().includes("bull")) bullScore += (maxProb/100) * w;
    else if(String(dir).toLowerCase().includes("bear")) bearScore += (maxProb/100) * w;
    else neutralScore += (maxProb/100) * w;

    tps.push({ tf: m.tf, tp: Number(m.tpEstimate ?? m.tp ?? 0), hedge: Number(m.hedgeTP ?? m.hedge ?? 0), tpConfidence: Number(m.tpConfidence ?? m.tpConfidence ?? 0), maxProb });
  }

  const finalDir = (bullScore > bearScore && bullScore > neutralScore) ? "Bullish" : (bearScore > bullScore && bearScore > neutralScore) ? "Bearish" : "Neutral";

  // compute weighted TP but favor TFs that align and have strong recent momentum
  let wSum=0,tpSum=0, hedgeSum=0, confSum=0;
  for(const t of tps){
    let w = baseWeights[t.tf] ?? 0.2;
    // align boost
    const mdir = available.find(x=>x.tf===t.tf)?.direction || "Neutral";
    if(finalDir==="Bullish" && String(mdir).toLowerCase().includes("bull")) w *= 1.2;
    if(finalDir==="Bearish" && String(mdir).toLowerCase().includes("bear")) w *= 1.2;
    // downweight opposites strongly if confidence high
    if(finalDir==="Bullish" && String(mdir).toLowerCase().includes("bear") && t.maxProb>65) w *= 0.12;
    if(finalDir==="Bearish" && String(mdir).toLowerCase().includes("bull") && t.maxProb>65) w *= 0.12;

    if(isNum(t.tp) && t.tp>0){ tpSum += t.tp * w; wSum += w; }
    if(isNum(t.hedge) && t.hedge>0){ hedgeSum += t.hedge * w; confSum += (t.tpConfidence||t.maxProb) * w; }
  }

  const primaryTP = (wSum>0) ? tpSum/wSum : (tps[0]?tps[0].tp:null);
  const hedgeTP = (confSum>0) ? hedgeSum/wSum : (tps[0]?tps[0].hedge:null);
  const avgConfidence = (wSum>0) ? confSum/wSum : (available.reduce((a,b)=>a + (b.maxProb||0),0)/available.length || 0);

  // sanity clamp for TPs: do not allow >10*ATR move or >10% from price in fused result
  // We'll leave actual clamping to caller who knows price. Return also avgConfidence.
  return { direction: finalDir, primaryTP: isNum(primaryTP)?Number(primaryTP):null, hedgeTP: isNum(hedgeTP)?Number(hedgeTP):null, confidence: Math.round(clamp(avgConfidence,0,100)) };
}

// -----------------------------
// PRO METERS (improved)
// -----------------------------
export function computeReboundProbability({candles1m, candles5m, candles15m, orderbook=null, tickerPrice=null, news=null}){
  let score = 28;
  const r1 = simpleRSI(candles1m,7), r5 = simpleRSI(candles5m,14), r15 = simpleRSI(candles15m,14);
  if(r1<30) score += 16; if(r5<35) score += 18; if(r15<40) score += 10;
  // wick spike
  const wick = (arr,lk=6)=>{ if(!Array.isArray(arr)) return 1; const s=arr.slice(-Math.min(lk,arr.length)); const ratios=s.map(c=>{ const body=Math.max(Math.abs(c.close-c.open),1e-8); const low=(Math.min(c.open,c.close)-c.low); return low/body; }); return mean(ratios||[1]); };
  const wr1 = wick(candles1m,6), wr5 = wick(candles5m,6);
  if(wr1>1.6) score+=12; if(wr5>1.4) score+=8;
  // ema/mean reversion: distance from 20-EMA (approx)
  const ed15 = (()=>{ if(!Array.isArray(candles15m) || candles15m.length<10) return 0; const closes=candles15m.map(c=>c.close); const ema=closes.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,closes.length); return (last(candles15m).close - ema)/Math.max(EPS,ema); })();
  if(ed15 < -0.01) score += clamp(Math.abs(ed15)*1000,0,12);
  // volume spike detection
  const volSpike = (()=>{ if(!Array.isArray(candles1m) || candles1m.length<8) return false; const a=candles1m.slice(-8); const avg=mean(a.slice(0,6).map(c=>c.volume||0)); const tail=mean(a.slice(-2).map(c=>c.volume||0)); return tail>avg*1.8; })();
  if(volSpike) score+=12;
  // orderbook
  if(orderbook && orderbook.bids && orderbook.asks){
    const bid = orderbook.bids[0]?.size||0; const ask = orderbook.asks[0]?.size||0;
    if(bid>ask*2.5 && bid>100) score+=10;
  }
  if(news && typeof news.sentiment==="number"){
    if(news.sentiment>=0.65) score -= 8;
    if(news.sentiment<=0.35) score += 6;
  }
  return { reboundProb: Math.round(clamp(score,0,100)), breakdown:{ r1,r5,r15,wr1,wr5,ed15,volSpike } };
}

export function computeTrendExhaustion({candles15m, candles30m}){
  let score=0;
  const slope15 = slopeOfCloses(candles15m,8);
  const slope30 = slopeOfCloses(candles30m,8);
  const atr15 = computeATR(candles15m,14), atr30 = computeATR(candles30m,14);
  const atrDrop = (()=>{ if(!Array.isArray(candles15m)||candles15m.length<30) return false; const left = computeATR(candles15m.slice(0,-10),14); return atr15 < left*0.85; })();
  const rsi15 = simpleRSI(candles15m,14);
  // price lower low but RSI higher (bullish divergence) or vice versa
  const rsiDiv = (()=>{ if(!Array.isArray(candles15m)||candles15m.length<12) return false; const lastClose = candles15m.slice(-6).map(c=>c.close); const prevClose = candles15m.slice(-12,-6).map(c=>c.close); if(!lastClose.length||!prevClose.length) return false; const lowNow = Math.min(...lastClose); const lowPrev = Math.min(...prevClose); const rsiNow = simpleRSI(candles15m.slice(-6),6); const rsiPrev = simpleRSI(candles15m.slice(-12,-6),6); return (lowNow<lowPrev && rsiNow>rsiPrev) || (lowNow>lowPrev && rsiNow<rsiPrev); })();
  if(Math.abs(slope15) < Math.max(1, Math.abs(slope30)*0.6)) score += 18;
  if(atrDrop) score += 18;
  if(rsiDiv) score += 30;
  const volTaper = (()=>{ if(!Array.isArray(candles15m)||candles15m.length<20) return false; const last8 = candles15m.slice(-8); const recentAvg = mean(last8.map(c=>c.volume||0)); const prevAvg = mean(candles15m.slice(-28,-8).map(c=>c.volume||0) || [recentAvg]); return recentAvg < prevAvg*0.85; })();
  if(volTaper) score += 12;
  return { exhaustionPct: Math.round(clamp(score,0,100)), breakdown:{ slope15, slope30, atr15, atr30, atrDrop, rsi15, rsiDiv, volTaper } };
}

export function computeVolatilityCrush({candles30m, candles15m}){
  const atrNow = computeATR(candles30m,14);
  const atrPrev = (()=>{ if(!Array.isArray(candles30m)||candles30m.length<40) return atrNow; return computeATR(candles30m.slice(0,-10),14); })();
  const atrDropPct = atrPrev>0 ? (atrPrev - atrNow)/atrPrev : 0;
  const bodyNow = mean((candles15m||[]).slice(-8).map(c=>Math.abs((c.close||0)-(c.open||0))||0));
  const bodyPrev = (candles15m && candles15m.length>20) ? mean(candles15m.slice(-28,-8).map(c=>Math.abs((c.close||0)-(c.open||0))||0)) : bodyNow;
  const bodyShrink = bodyPrev>0 ? (bodyPrev - bodyNow)/Math.max(EPS, bodyPrev) : 0;
  const squeeze = atrDropPct>0.15 && bodyShrink>0.25;
  const score = Math.round(clamp((atrDropPct*100)*0.6 + (bodyShrink*100)*0.4, 0, 100));
  return { volCrush: squeeze ? score : Math.round(score*0.45), breakdown:{ atrNow, atrPrev, atrDropPct, bodyNow, bodyPrev, bodyShrink, squeeze } };
}

export function compute30minPressure({candles1m, candles5m, candles30m, orderflow=null, orderbook=null}){
  const recent1 = (candles1m||[]).slice(-30), recent5 = (candles5m||[]).slice(-12);
  function sideVol(arr){ let buy=0,sell=0; for(const c of (arr||[])){ const d=(c.close - c.open) * (c.volume||0); if(d>=0) buy += Math.abs(d); else sell += Math.abs(d);} return { buy, sell, total: buy+sell }; }
  const v1 = sideVol(recent1), v5 = sideVol(recent5);
  const buyRatio1 = v1.total? v1.buy/v1.total : 0.5;
  const buyRatio5 = v5.total? v5.buy/v5.total : 0.5;
  let cvdScore = 0; if(orderflow && typeof orderflow.cvd==="number") cvdScore = clamp(orderflow.cvd/100000, -1, 1);
  const emaShort = (candles5m && candles5m.length) ? mean(candles5m.slice(-10).map(c=>c.close)) : 0;
  const emaLong = (candles30m && candles30m.length) ? mean(candles30m.slice(-6).map(c=>c.close)) : emaShort;
  const emaAlignBear = emaShort < emaLong ? 1 : 0;
  let obPressure = 0;
  if(orderbook && orderbook.bids && orderbook.asks){
    const bidSum = orderbook.bids.slice(0,10).reduce((a,b)=>a+(b.size||0),0);
    const askSum = orderbook.asks.slice(0,10).reduce((a,b)=>a+(b.size||0),0);
    obPressure = bidSum > askSum ? (bidSum/Math.max(1,askSum)) : -(askSum/Math.max(1,bidSum));
    obPressure = clamp(obPressure, -3, 3);
  }
  let sellPct = 50;
  if(buyRatio1 < 0.45) sellPct += (0.5 - buyRatio1) * 100 * 0.7;
  if(buyRatio5 < 0.48) sellPct += (0.5 - buyRatio5) * 100 * 0.4;
  sellPct += clamp(-cvdScore * 30, -30, 30);
  // orderbook pushes
  if(obPressure > 1.2) sellPct -= Math.min(12, (obPressure-1)*6);
  if(obPressure < -1.2) sellPct += Math.min(12, (Math.abs(obPressure)-1)*6);
  sellPct = clamp(sellPct, 0, 100);
  return { sellPressurePct: Math.round(sellPct), buyRatio1: Math.round(buyRatio1*100)/100, buyRatio5: Math.round(buyRatio5*100)/100, cvdScore, emaAlignBear, obPressure, breakdown:{ v1, v5 } };
}

// ---------- Precision decision core (v13) ----------
function computeDecision(features, newsObj, systemProb){
  const sysProb = clamp(systemProb || 0.5, 0.01, 0.99);
  const newsSent = (newsObj && typeof newsObj.sentiment==="number") ? clamp(newsObj.sentiment,0,1) : 0.5;
  // Compose from layers
  const ind = indicatorLayer(features).score;
  const cnn = features.candles ? candleVision(features.candles,8).score : 0.5;
  const of = orderFlowLayer(features.of);
  const newsScore = clamp(newsSent, 0.01, 0.99);
  // fuse adaptively but allow systemProb and recency to influence
  const fused = fuseScores({ ind, cnn, of, news:newsScore }, _stats.adaptiveWeights).fused;
  // dynamic recency boost: if slope & mom3 indicate a flip, boost fused towards that side
  const flipStrength = Math.tanh(Math.abs(features.mom3 || 0) * 6) * 0.35 + clamp(Math.abs(features.slope||0)/Math.max(1,Math.abs(features.close||1)) * 0.4, 0, 0.6);
  // if momentum positive -> pull fused up, else pull down
  const directionBias = (features.mom3 || 0) > 0 ? 1 : -1;
  const adjusted = clamp(fused + (directionBias * flipStrength * (0.5 - Math.abs(0.5 - fused))), 0.01, 0.99);
  // final probability for bullish
  const probBull = (adjusted*0.8) + (sysProb*0.2);
  const probPct = Math.round(probBull*10000)/100;
  const confidence = Math.round(clamp(Math.abs(probBull-0.5)*200, 10, 100));
  const dir = (probBull >= 0.6) ? "Bullish" : (probBull <= 0.4) ? "Bearish" : "Neutral";
  return { direction: dir, confidence, probBull: Math.round(probBull*10000)/100, fusedRaw: fused, adjusted };
}

// ---------- runMicroPrediction (fast) ----------
export async function runMicroPrediction(symbol="BTCUSDT", tfc="1m", opts={}){
  try {
    // fetch only 1m and 5m
    const mtf = await fetchMultiTF(symbol, [tfc, "5m"]);
    const raw = mtf[tfc] || { data: [], price: 0 };
    const candles = Array.isArray(raw.data)? raw.data : [];
    const price = raw.price || (candles?.at(-1)?.close || 0);
    if(!candles || candles.length < 4) return { modelVersion:"v13_ultra", symbol, tf:tfc, direction:"Neutral", maxProb:33.33, probs:{bull:33.33,bear:33.33,neutral:33.33} };
    const feats = buildFeatures(candles);
    const cnn = await cnnLayer(candles);
    const ind = indicatorLayer(feats);
    const of = orderFlowLayer(feats.of);
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({sentiment:0.5,impact:"low"}));
    const decision = computeDecision(feats, newsObj, 0.5);
    return {
      modelVersion:"v13_ultra",
      symbol, tf: tfc,
      direction: decision.direction,
      probs: { bull: decision.probBull, bear: Math.round((100-decision.probBull)*100)/100, neutral: Math.round((100-decision.probBull)/2*100)/100 },
      maxProb: Math.max(decision.probBull, 100-decision.probBull),
      tpEstimate: null, tpConfidence: decision.confidence, adaptiveWeights: _stats.adaptiveWeights, explanation: { ind:ind.details, cnn:cnn.features, of }
    };
  } catch (e) {
    return { modelVersion:"v13_ultra", symbol, tf:tfc, direction:"Neutral", probs:{bull:33.33,bear:33.33,neutral:33.33}, maxProb:33.33 };
  }
}
// ---------- MAIN runMLPrediction (v13) ----------
export async function runMLPrediction(symbol="BTCUSDT", tfc="15m", opts={}){
  try {
    // throttle
    const now = Date.now();
    if(now - _lastCall < DEFAULT_THROTTLE_MS) await sleep(DEFAULT_THROTTLE_MS - (now - _lastCall));
    _lastCall = Date.now();

    const DEFAULT_CFG = { fusedTFs:["15m","30m","1h"], minTFsForFusion:2, MIN_TP_DISTANCE_ATR_MULT:1.0 };
    const CFG = Object.assign({}, DEFAULT_CFG, opts.config || {});

    const tfsToFetch = Array.from(new Set([tfc, ...CFG.fusedTFs, "1m", "5m", "30m", "1h"])).slice(0,12);
    const mtf = await fetchMultiTF(symbol, tfsToFetch);
    const primaryRaw = mtf[tfc] || { data: [], price: 0 };
    const candles = Array.isArray(primaryRaw.data)? primaryRaw.data : [];
    const price = isNum(primaryRaw.price) && primaryRaw.price>0 ? primaryRaw.price : (candles?.at(-1)?.close || 0);

    if(!candles || candles.length < 6 || price<=0){
      return { modelVersion:"v13_ultra", symbol, tf:tfc, direction:"Neutral", probs:{bull:33.33,bear:33.33,neutral:33.33}, maxProb:33.33, tpEstimate:null, tpConfidence:0 };
    }

    // build layers
    const feats = buildFeatures(candles);
    const indLayer = indicatorLayer(feats);
    const cnn = await cnnLayer(candles);
    const ofScore = orderFlowLayer(feats.of);
    const newsObj = await fetchNewsBundle(symbol).catch(()=>({ sentiment:0.5, impact:"low" }));
    const newsScore = (newsObj && typeof newsObj.sentiment==="number") ? clamp(newsObj.sentiment,0,1) : 0.5;

    // per-TF predictions for fusedTFs (use micro engine)
    const perTF = [];
    for(const tf of CFG.fusedTFs){
      try {
        const raw = mtf[tf] || { data: [], price: 0 };
        const cs = Array.isArray(raw.data) ? raw.data : [];
        const p = raw.price || (cs?.at(-1)?.close || 0);
        const f = buildFeatures(cs) || { close:p, slope:0, mom3:0, atr:0, rsi:50, of:{} };
        const cnnTf = await cnnLayer(cs);
        const indTf = indicatorLayer(f);
        const ofTf = orderFlowLayer(f.of);
        const fusedLayer = fuseScores({ ind: indTf.score, cnn: cnnTf.score, of: ofTf, news: newsScore }, _stats.adaptiveWeights);
        // decision at TF-level
        const tfDecision = computeDecision(f, newsObj, fusedLayer.fused);
        // candidate TP/hedge from ell/ATR
        const ell = await analyzeElliott(cs).catch(()=>null);
        const candidates = buildCandidatesFromElliott(ell).concat(atrFallbackTPs(p, f.atr));
        const ded = dedupeCandidates(candidates, p);
        const chosen = choosePrimaryHedge(ded, tfDecision.direction, p, f, { MIN_TP_DISTANCE_ATR_MULT: CFG.MIN_TP_DISTANCE_ATR_MULT });
        perTF.push({
          tf, direction: tfDecision.direction, probBull: tfDecision.probBull, confidence: tfDecision.confidence,
          tpEstimate: chosen.primary, hedgeTP: chosen.hedge, adaptiveWeights: _stats.adaptiveWeights, maxProb: tfDecision.probBull
        });
      } catch (e) {
        perTF.push({ tf, direction:"Neutral", probBull:50, confidence:10, tpEstimate:null, hedgeTP:null, maxProb:50 });
      }
    }

    // Fuse perTF predictions with dynamic recency boost (favor newer TFs when momentum strong)
    const mlFusion = fuseMLTFs(perTF);

    // guard & sanity on TP: clamp fused TP relative to price & ATR
    const feat15 = mtf["15m"] && Array.isArray(mtf["15m"].data) ? buildFeatures(mtf["15m"].data) : feats;
    const atr15 = feat15?.atr || computeATR(candles,14) || Math.max(1, Math.abs(price)*0.005);
    const maxMovePct = 0.12; // allow up to 12% move as fused TP default (configurable)
    const maxMoveAbs = Math.max(atr15 * 12, Math.abs(price)*maxMovePct);
    if(mlFusion && isNum(mlFusion.primaryTP) && Math.abs(mlFusion.primaryTP - price) > maxMoveAbs){
      // clamp toward price by allowed distance to avoid huge unrealistic overshoots
      mlFusion.primaryTP = mlFusion.primaryTP > price ? price + maxMoveAbs : price - maxMoveAbs;
    }
    if(mlFusion && isNum(mlFusion.hedgeTP) && Math.abs(mlFusion.hedgeTP - price) > maxMoveAbs*1.5){
      mlFusion.hedgeTP = mlFusion.hedgeTP > price ? price + maxMoveAbs*1.5 : price - maxMoveAbs*1.5;
    }

    // choose stable targets combining Elliott cluster + mlFusion
    const clusterMap = new Map();
    for(const tf of Object.keys(mtf)){
      const entry = mtf[tf] || { data: [], price:0 };
      const candlesTF = Array.isArray(entry.data) ? entry.data : [];
      const ell = await analyzeElliott(candlesTF).catch(()=>null);
      const cands = buildCandidatesFromElliott(ell);
      for(const c of cands){ const k=Math.round(c.tp); if(!clusterMap.has(k) || (c.confidence||0) > (clusterMap.get(k).confidence||0)) clusterMap.set(k, c); }
    }
    const allTargets = Array.from(clusterMap.values()).sort((a,b)=>b.confidence - a.confidence);
    const stable = (allTargets.length ? choosePrimaryHedge(allTargets, mlFusion?.direction||"Neutral", price, feat15, {}) : choosePrimaryHedge(atrFallbackTPs(price, atr15), mlFusion?.direction||"Neutral", price, feat15, {}));
    const stableTargets = { primaryTP: stable.primary, hedgeTP: stable.hedge, primarySource: stable.primarySource || "Cluster/ML", hedgeSource: stable.hedgeSource || "Cluster/ML", primaryConf: stable.confidence, direction: mlFusion?.direction || "Neutral" };

    // Build final report-like ML object
    const res = {
      modelVersion: "v13_ultra",
      symbol, tf: tfc,
      direction: mlFusion?.direction || "Neutral",
      probs: { bull: mlFusion?.confidence || 50, bear: 100 - (mlFusion?.confidence || 50), neutral: Math.max(0, 100 - Math.abs((mlFusion?.confidence||50)-50)) },
      maxProb: mlFusion?.confidence || 50,
      tpEstimate: mlFusion?.primaryTP || stable.primary, tpSource: mlFusion?.primaryTP ? "ML_FUSED" : stable.primarySource,
      tpConfidence: mlFusion?.confidence || stable.primaryConf || 40,
      hedgeTP: mlFusion?.hedgeTP || stable.hedge,
      perTF: perTF,
      adaptiveWeights: _stats.adaptiveWeights,
      explanation: { fusedRaw: mlFusion, feat15: feat15, news: newsObj }
    };

    return res;
  } catch (e) {
    return { modelVersion:"v13_ultra", symbol, tf:tfc, direction:"Neutral", probs:{bull:33.33,bear:33.33,neutral:33.33}, maxProb:33.33, tpEstimate:null, tpConfidence:0, error: e?.message||String(e) };
  }
}

// ---------- buildAIReport convenience (small) ----------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}){
  // lightweight helper to produce an object compatible with tg_commands buildAIReport expectations
  try {
    const report = { ok:false, error:"not implemented" };
    // prefer to call user's tg_commands buildAIReport which orchestrates multi-TF + news + ml
    // But provide a minimal fallback single-call wrapper:
    const ml15 = await runMLPrediction(symbol, "15m", opts).catch(()=>null);
    const ml30 = await runMLPrediction(symbol, "30m", opts).catch(()=>null);
    const ml1h = await runMLPrediction(symbol, "1h", opts).catch(()=>null);
    const fusion = fuseMLTFs([ml15, ml30, ml1h].filter(x=>x));
    return { ok:true, modelVersion:"v13_ultra", symbol, ml:{ perTF:[ml15,ml30,ml1h], fusion }, generatedAt: nowISO() };
  } catch (e) { return { ok:false, error: e?.message||String(e) }; }
}

// ---------- trainAdaptive (very small online trainer) ----------
export function trainAdaptive(trainingSamples = []) {
  // trainingSamples: [{features:{...}, label:"Bullish"|"Bearish"| "Neutral"}]
  try {
    if(!Array.isArray(trainingSamples) || !trainingSamples.length) return false;
    for(const s of trainingSamples){
      if(!s || !s.features || !s.label) continue;
      const scores = { ind: indicatorLayer(s.features).score, cnn: candleVision(s.features.candles||[],8).score, of: orderFlowLayer(s.features.of||{}), news: (s.news && typeof s.news.sentiment==="number")? clamp(s.news.sentiment,0,1) : 0.5 };
      const fused = fuseScores(scores, _stats.adaptiveWeights);
      updateAdaptiveWeights(s.label, fused.fused, { breakdown: fused.breakdown });
    }
    writeJson(STATS_FILE, _stats);
    return true;
  } catch (e) { return false; }
}

// ---------- Exports ----------
const defaultExport = {
  runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome,
  markOutcome, getStats, trainAdaptive, resetStats,
  computeReboundProbability, computeTrendExhaustion, computeVolatilityCrush, compute30minPressure,
  fuseMLTFs, buildStableTargets: (clusterTargets, mlFusion, price, feats) => {
    // compatibility shim using choosePrimaryHedge
    const candidates = Array.isArray(clusterTargets) ? clusterTargets.slice() : [];
    const ded = dedupeCandidates(candidates, price);
    const chosen = choosePrimaryHedge(ded, mlFusion?.direction||"Neutral", price, feats, {});
    return { primaryTP: chosen.primary, hedgeTP: chosen.hedge, primarySource: chosen.primarySource, hedgeSource: chosen.hedgeSource, primaryConf: chosen.confidence, direction: mlFusion?.direction||"Neutral" };
  },
  buildAIReport
};
export default defaultExport;