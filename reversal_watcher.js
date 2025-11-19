// reversal_watcher_pro_v3.js
// Reversal Watcher PRO V3 (single-file final)
// Exports: startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats
//
// Requirements: place this file alongside:
// - ml_module_v8_6.js (contains runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy)
// - elliott_module.js (export analyzeElliott)
// - utils.js (export fetchMultiTF)
// - news_social.js (either default { fetchNewsBundle } or named fetchNewsBundle)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as MLmodule from "./ml_module_v8_6.js"; // expects runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy
import { analyzeElliott } from "./elliott_module.js";
import * as News from "./news_social.js"; // robust import

// Resolve fetchNewsBundle robustly
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// Extract ML functions (safe fallbacks)
const { runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy } = MLmodule;

// -------------------- Persistence & stats --------------------
const REV_STATS_FILE = process.env.REV_STATS_FILE || path.join(process.cwd(), ".rev_pro_v3_stats.json");
let _stats = { alerts: [], wins: 0, losses: 0, lastUpdated: null, accuracyCache: null };

try {
  if (fs.existsSync(REV_STATS_FILE)) {
    const raw = fs.readFileSync(REV_STATS_FILE, "utf8");
    if (raw) _stats = Object.assign(_stats, JSON.parse(raw));
  }
} catch (e) { /* ignore load error */ }

function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(REV_STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

// -------------------- Defaults & runtime --------------------
const DEFAULTS = {
  pollIntervalMs: 20_000,
  mlMinConfidence: 65,
  cooldownMs: 90_000,
  requireMultiTFAlign: true,
  requireVolumeStructure: true,
  requireOrderBlockOrFVG: false,
  requireHiddenDivergence: false,
  verbose: false,
  microConfirmWindowMs: 60_000,
  scoreGate: 0.6 // final gate to fire alert
};

let _interval = null;
let _sendFunc = null;
let _opts = {};
const memory = { lastSignature: "", lastAlertTs: 0, lastCandleTS: 0 };

// -------------------- Helpers --------------------
const EPS = 1e-12;
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d = 2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";
const mean = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
function nowISO() { return new Date().toISOString(); }

// -------------------- Indicators / small utils --------------------
function computeRSIFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = (candles[i].close ?? 0) - (candles[i-1].close ?? 0);
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
function computeMACDHistApprox(candles, fast = 12, slow = 26) {
  if (!Array.isArray(candles) || candles.length < 3) return 0;
  const avg = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
  const len = candles.length;
  const fastAvg = avg(candles.slice(Math.max(0,len-fast), len).map(c=>c.close || 0));
  const slowAvg = avg(candles.slice(Math.max(0,len-slow), len).map(c=>c.close || 0));
  return fastAvg - slowAvg;
}
function attachPrevCandles(arr) {
  for (let i=0;i<(arr?.length||0);i++) arr[i]._prev = arr[i-1] || null;
  return arr;
}

// -------------------- Pattern detection --------------------
function detectCandlePattern(c) {
  if (!c) return null;
  const o=c.open, cl=c.close, h=c.high, l=c.low;
  const body = Math.abs(cl - o) || 1;
  const range = Math.max(1, h - l);
  const upperWick = h - Math.max(cl,o);
  const lowerWick = Math.min(cl,o) - l;
  // Hammer
  if (lowerWick > body * 1.8 && upperWick < body * 0.6 && cl > o) return { side: "Bullish", name: "Hammer", score: 0.8 };
  // Inverted hammer
  if (upperWick > body * 1.8 && lowerWick < body * 0.6 && cl < o) return { side: "Bearish", name: "InvertedHammer", score: 0.8 };
  // Engulfing
  if (cl > o && c._prev && Math.abs(c._prev.close - c._prev.open) < body*0.9 && cl > c._prev.open && o < c._prev.close) return { side: "Bullish", name: "BullishEngulfing", score:1.0 };
  if (o > cl && c._prev && Math.abs(c._prev.close - c._prev.open) < body*0.9 && o > c._prev.close && cl < c._prev.open) return { side: "Bearish", name: "BearishEngulfing", score:1.0 };
  // Big candle after move
  if (cl > o && body > range * 0.5) return { side:"Bullish", name:"BigBullCandle", score:0.6 };
  if (o > cl && body > range * 0.5) return { side:"Bearish", name:"BigBearCandle", score:0.6 };
  return null;
}

// -------------------- Order-block, FVG, Sweep --------------------
function detectOrderBlock(preCandles = [], impulse) {
  if (!preCandles || preCandles.length < 3 || !impulse) return null;
  const highs = preCandles.map(c=>c.high), lows = preCandles.map(c=>c.low);
  const range = Math.max(...highs) - Math.min(...lows) || 1;
  const avgBody = mean(preCandles.map(c => Math.abs(c.close - c.open))) || 1;
  const impulseBody = Math.abs(impulse.close - impulse.open);
  if (range < avgBody * 4 && impulseBody > avgBody * 1.6) return { lo: Math.min(...lows), hi: Math.max(...highs), note: "consolidation_impulse" };
  return null;
}
function detectFVG(candles, lookback = 6) {
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  for (let i=candles.length-lookback-1;i<candles.length-1;i++){
    const a=candles[i], b=candles[i+1];
    if (!a||!b) continue;
    const aHi=Math.max(a.open,a.close), aLo=Math.min(a.open,a.close);
    const bHi=Math.max(b.open,b.close), bLo=Math.min(b.open,b.close);
    if (bLo > aHi + 1e-12) return { type:"up", lo:aHi, hi:bLo, idx:i+1 };
    if (bHi < aLo - 1e-12) return { type:"down", lo:bHi, hi:aLo, idx:i+1 };
  }
  return null;
}
function detectLiquiditySweep(candles, lookback = 12) {
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  const last = candles.at(-1);
  const prior = candles.slice(-1-lookback,-1);
  if (!prior.length) return null;
  const priorHigh = Math.max(...prior.map(c=>c.high));
  const priorLow  = Math.min(...prior.map(c=>c.low));
  if (last.high > priorHigh && last.close < priorHigh) return { side: "BearishSweep", priorHigh };
  if (last.low < priorLow && last.close > priorLow) return { side: "BullishSweep", priorLow };
  return null;
}

// -------------------- Hidden divergence --------------------
function detectHiddenDivergence(candles, lookback = 8) {
  if (!Array.isArray(candles) || candles.length < lookback+2) return null;
  const arr = candles.slice(-(lookback+2));
  // simplistic: search two lows with RSI increase
  let idxs = [];
  for (let i=1;i<arr.length-1;i++){
    if (arr[i].low <= arr[i-1].low && arr[i].low <= arr[i+1].low) idxs.push(i);
  }
  if (idxs.length < 2) return null;
  const i1 = idxs[0], i2 = idxs[1];
  const priceLower = arr[i2].low < arr[i1].low;
  const rsi1 = computeRSIFromCandles(candles.slice(0, candles.length - (arr.length - i1)), 14);
  const rsi2 = computeRSIFromCandles(candles.slice(0, candles.length - (arr.length - i2)), 14);
  if (priceLower && isFiniteNum(rsi1) && isFiniteNum(rsi2) && rsi2 > rsi1) return { type: "hiddenBull", price1: arr[i1].low, price2: arr[i2].low, rsi1, rsi2 };
  // symmetrical for hiddenBear (highs)
  let idxsH = [];
  for (let i=1;i<arr.length-1;i++){
    if (arr[i].high >= arr[i-1].high && arr[i].high >= arr[i+1].high) idxsH.push(i);
  }
  if (idxsH.length >= 2) {
    const j1 = idxsH[0], j2 = idxsH[1];
    const priceHigher = arr[j2].high > arr[j1].high;
    const r1 = computeRSIFromCandles(candles.slice(0,candles.length-(arr.length-j1)),14);
    const r2 = computeRSIFromCandles(candles.slice(0,candles.length-(arr.length-j2)),14);
    if (priceHigher && isFiniteNum(r1) && isFiniteNum(r2) && r2 < r1) return { type: "hiddenBear", price1: arr[j1].high, price2: arr[j2].high, r1, r2 };
  }
  return null;
}

// -------------------- Order-flow features --------------------
function computeOrderFlowFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return {};
  const n = candles.length;
  const last = candles[n-1], prev = candles[n-2];
  const delta = (last.close - last.open) * (last.volume || 1);
  const deltaPrev = (prev.close - prev.open) * (prev.volume || 1);
  const vel = last.close - prev.close;
  const window = candles.slice(Math.max(0, n-6), n);
  const swingHigh = Math.max(...window.map(c=>c.high));
  const swingLow = Math.min(...window.map(c=>c.low));
  let sweep = null;
  if (last.high > swingHigh && last.close < swingHigh) sweep = { side: "BearishSweep", priorHigh: swingHigh };
  if (last.low < swingLow && last.close > swingLow) sweep = { side: "BullishSweep", priorLow: swingLow };
  const upWicks = window.map(c=>c.high - Math.max(c.close, c.open));
  const downWicks = window.map(c=>Math.min(c.close, c.open) - c.low);
  return { delta, deltaPrev, vel, sweep, avgUp: mean(upWicks), avgDown: mean(downWicks) };
}

// -------------------- Feature builder --------------------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const n = candles.length;
  const last = candles[n-1];
  const closes = candles.map(c => Number(c.close || 0));
  const highs = candles.map(c => Number(c.high || 0));
  const lows = candles.map(c => Number(c.low || 0));
  const vols = candles.map(c => Number(c.volume || 0));
  const close = Number(last.close || 0);
  const mom3 = n >= 4 ? (close - closes[n-4]) / Math.max(EPS, closes[n-4]) : 0;
  const mom10 = n >= 11 ? (close - closes[n-11]) / Math.max(EPS, closes[n-11]) : 0;
  const len = Math.min(30, n);
  let xmean=0,ymean=0,num=0,den=0;
  for (let i=0;i<len;i++){ xmean += i; ymean += closes[n-len+i]; }
  xmean /= len; ymean /= len;
  for (let i=0;i<len;i++){ const x=i; const y=closes[n-len+i]; num += (x-xmean)*(y-ymean); den += (x-xmean)*(x-xmean); }
  const slope = den === 0 ? 0 : num/den;
  const trs=[];
  for (let i=1;i<n;i++) {
    const tr = Math.max(Math.abs(highs[i]-lows[i]), Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    trs.push(tr);
  }
  const atr = trs.length ? mean(trs.slice(-14)) : 0;
  let gains=0, losses=0;
  for (let i=Math.max(1,n-14); i<n; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains/14 || 0;
  const avgLoss = losses/14 || 0;
  const rsi = avgGain + avgLoss ? 100 - (100 / (1 + avgGain / Math.max(EPS, avgLoss))) : 50;
  const avgVol = mean(vols.slice(-20)) || 0;
  const of = computeOrderFlowFeatures(candles);
  return { close, slope, mom3, mom10, atr, rsi, avgVol, lastVol: last.volume||0, of, high: last.high, low: last.low, candles };
}

// -------------------- Scoring helpers --------------------
function adaptiveThreshold(base) {
  try {
    const total = (_stats.wins || 0) + (_stats.losses || 0);
    if (!total) return base;
    const winRate = (_stats.wins || 0) / total;
    const adj = Math.round((0.5 - winRate) * 40);
    return clamp(base + adj, 45, 90);
  } catch (e) { return base; }
}
function momentumShiftScore(feats) {
  if (!feats) return 0;
  const rsiDelta = (isFiniteNum(feats.rsiNow) && isFiniteNum(feats.rsiPrev)) ? (feats.rsiNow - feats.rsiPrev) / 10 : 0;
  const macdDelta = isFiniteNum(feats.macdNow) && isFiniteNum(feats.macdPrev) ? (feats.macdNow - feats.macdPrev) / Math.max(1, Math.abs(feats.macdPrev)) : 0;
  const volDelta = isFiniteNum(feats.volNow) && isFiniteNum(feats.volAvg) ? ((feats.volNow / Math.max(1, feats.volAvg)) - 1) : 0;
  return clamp((rsiDelta * 0.5) + (macdDelta * 0.4) + (volDelta * 0.6), -3, 3);
}

// -------------------- TP/SL helper (hybrid fallback) --------------------
function buildCandidateTPsFromElliottOrAtr(ell, price, feats) {
  const out = [];
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp || t.price || t.target || 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      out.push({ tp, source: t.source || "Elliott", confidence: Math.min(100, Math.round(t.confidence || ell.confidence || 40)) });
    }
  }
  if (!out.length) {
    out.push({ tp: price + atr * 2.5, source: "ATR_UP", confidence: 35 });
    out.push({ tp: price - atr * 2.5, source: "ATR_DOWN", confidence: 35 });
  }
  // uniq by rounded tp
  const map = new Map();
  for (const c of out) {
    const key = Math.round(c.tp);
    if (!map.has(key) || (c.confidence || 0) > (map.get(key).confidence || 0)) map.set(key,c);
  }
  return [...map.values()].sort((a,b)=>Math.abs(a.tp - price) - Math.abs(b.tp - price));
}
function choosePrimaryHedge(candidates, dir, price, feats, ell) {
  if (!candidates || !candidates.length) return null;
  const bull = candidates.filter(c=>c.tp>price);
  const bear = candidates.filter(c=>c.tp<price);
  let primary = null;
  if (dir === "Bullish") primary = (bull.length?bull[0]:candidates[0]);
  else if (dir === "Bearish") primary = (bear.length?bear[0]:candidates[0]);
  else primary = candidates[0];
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  let hedge = null;
  if (dir === "Bullish") hedge = (bear.length?bear[0]:{ tp: price - atr*1.2, source:"HEDGE_ATR", confidence:30 });
  else if (dir === "Bearish") hedge = (bull.length?bull[0]:{ tp: price + atr*1.2, source:"HEDGE_ATR", confidence:30 });
  else hedge = (candidates.length>1?candidates[1]:{ tp: price - atr*1.2, source:"HEDGE_ATR", confidence:30 });
  const pconf = Math.round(((primary.confidence || 40) * 0.6 + 50) * 100) / 100;
  return { primary: Number(primary.tp), hedge: Number(hedge.tp), primarySource: primary.source, hedgeSource: hedge.source, confidence: Math.round(Math.min(100,pconf)) };
}
function pickSL(dir, price, feats, ell) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  const volRatio = feats && feats.atr ? feats.atr / Math.max(EPS, Math.abs(price)) : atr / Math.max(EPS, Math.abs(price));
  const HIGH_VOL_THRESHOLD = 0.003;
  if (volRatio >= HIGH_VOL_THRESHOLD) return dir === "Bullish" ? price - atr*1.8 : dir === "Bearish" ? price + atr*1.8 : price - atr*1.8;
  if (ell && Array.isArray(ell.pivots) && ell.pivots.length) {
    const piv = ell.pivots.slice().reverse();
    if (dir === "Bullish") {
      const lastLow = piv.find(p=>p.type==="L");
      if (lastLow && isFiniteNum(lastLow.price)) return lastLow.price;
    } else if (dir === "Bearish") {
      const lastHigh = piv.find(p=>p.type==="H");
      if (lastHigh && isFiniteNum(lastHigh.price)) return lastHigh.price;
    }
  }
  // swing fallback
  if (feats && Array.isArray(feats.candles) && feats.candles.length >= 3) {
    const window = feats.candles.slice(-10);
    const swingLow = Math.min(...window.map(c=>c.low));
    const swingHigh = Math.max(...window.map(c=>c.high));
    return dir === "Bullish" ? swingLow : dir === "Bearish" ? swingHigh : price - atr*1.8;
  }
  return dir === "Bullish" ? price - atr*1.8 : dir === "Bearish" ? price + atr*1.8 : price - atr*1.8;
}

// -------------------- Alert UI builder --------------------
function buildAlertPayload(meta) {
  // meta contains many fields: side, pattern, price, ml, micro, etc.
  const shortText = [
    `${meta.side === "Bullish" ? "🟢" : "🔴"} REVERSAL ALERT — ${meta.side}`,
    `Pattern: ${meta.pattern}`,
    `Price: ${nf(meta.price,2)}`,
    `ML: ${meta.mlDir || "N/A"} (${nf(meta.mlProb,2)}%)`,
    `Score: ${nf(meta.score,3)}`,
    `TP (Primary): ${nf(meta.tpPrimary,2)} (${meta.tpPrimarySource||"N/A"})`,
    `TP (Hedge): ${nf(meta.tpHedge,2)} (${meta.tpHedgeSource||"N/A"})`,
    `SL: ${nf(meta.sl,2)}`,
    `id: ${meta.alertId}`
  ].join("\n");

  const detailed = {
    alertId: meta.alertId,
    ts: meta.ts,
    symbol: meta.symbol,
    side: meta.side,
    price: meta.price,
    pattern: meta.pattern,
    score: meta.score,
    ml: { dir: meta.mlDir, probs: meta.mlProbs, maxProb: meta.mlMaxProb, tpEstimate: meta.mlTpEstimate },
    micro: meta.micro || null,
    news: { sentiment: meta.newsSentiment, impact: meta.newsImpact },
    tps: { primary: meta.tpPrimary, primarySource: meta.tpPrimarySource, hedge: meta.tpHedge, hedgeSource: meta.tpHedgeSource, confidence: meta.tpConfidence },
    sl: meta.sl,
    extras: { hiddenDiv: meta.hiddenDiv, orderBlock: meta.orderBlock, fvg: meta.fvg, sweep: meta.sweep }
  };

  return { compactText: shortText, detailedJSON: detailed };
}

async function sendAlertPayload(payload) {
  if (!_sendFunc) return false;
  try {
    // Prefer sending compact text first, then full JSON if sendFunc supports objects
    // If sendFunc expects string only, it will handle compactText.
    // We'll call sendFunc twice: compact text, then optional JSON (wrapped).
    await _sendFunc(payload.compactText);
    // small delay then send detailed JSON if function can handle objects
    try {
      await new Promise(r=>setTimeout(r,250));
      await _sendFunc({ type: "reversal_alert", body: payload.detailedJSON });
    } catch (e) {
      // ignore if sendFunc can't handle object
    }
    return true;
  } catch (e) {
    if (_opts.verbose) console.error("sendAlertPayload error:", e?.message || e);
    return false;
  }
}

// -------------------- Main scan logic --------------------
async function scan(symbol) {
  try {
    const multi = await fetchMultiTF(symbol, ["1m","5m","15m","30m","1h"]);
    const candles15 = (multi["15m"]?.data || []).slice();
    if (!candles15 || candles15.length < 25) {
      if (_opts.verbose) console.log("not enough 15m candles");
      return null;
    }
    attachPrevCandles(candles15);
    const confirm = candles15.at(-2); // penultimate confirmed candle
    if (!confirm) return null;
    const price = confirm.close;
    if (confirm.time === memory.lastCandleTS) return null;
    memory.lastCandleTS = confirm.time;

    // pattern detection
    const patternObj = detectCandlePattern(confirm);
    if (!patternObj) { if (_opts.verbose) console.log("no pattern"); return null; }
    const side = patternObj.side; // 'Bullish'|'Bearish'

    // wick sanity
    const upWick = confirm.high - Math.max(confirm.open, confirm.close);
    const downWick = Math.min(confirm.open, confirm.close) - confirm.low;
    const body = Math.abs(confirm.close - confirm.open) || 1;
    if (side === "Bullish" && downWick < body * 0.45) { if (_opts.verbose) console.log("bull wick small"); return null; }
    if (side === "Bearish" && upWick < body * 0.45) { if (_opts.verbose) console.log("bear wick small"); return null; }

    // compute features
    const rsiNow = computeRSIFromCandles(candles15,14);
    const rsiPrev = computeRSIFromCandles(candles15.slice(0,-1),14);
    const macdNow = computeMACDHistApprox(candles15);
    const macdPrev = computeMACDHistApprox(candles15.slice(0,-1));
    const lastVols = candles15.slice(-20).map(c=>c.volume||0);
    const volNow = candles15.at(-2)?.volume || 0;
    const volAvg = mean(lastVols.slice(0,-1)) || 1;
    const feats = { rsiNow, rsiPrev, macdNow, macdPrev, volNow, volAvg };

    const momentumShift = momentumShiftScore(feats);

    // other structural checks
    const preCandles = candles15.slice(-9,-1);
    const orderBlock = detectOrderBlock(preCandles, confirm);
    const fvg = detectFVG(candles15,6);
    const sweep = detectLiquiditySweep(candles15,12);
    let hiddenDiv = null;
    if (_opts.requireHiddenDivergence) {
      hiddenDiv = detectHiddenDivergence(candles15, 8);
      if (!hiddenDiv) { if (_opts.verbose) console.log("hidden divergence required but not found"); return null; }
      // ensure supports side
      if ((hiddenDiv.type === "hiddenBull" && side !== "Bullish") || (hiddenDiv.type === "hiddenBear" && side !== "Bearish")) {
        hiddenDiv = null;
      }
    }

    // volume structure
    const last12Vol = candles15.slice(-12).map(c=>c.volume||0);
    const avgVol12 = mean(last12Vol.slice(0,-1)) || 1;
    const volSpike = last12Vol.at(-2) / Math.max(1, avgVol12);
    if (_opts.requireVolumeStructure && volSpike < 1.15) { if (_opts.verbose) console.log("volume condition fail"); return null; }

    // multi TF alignment
    if (_opts.requireMultiTFAlign) {
      const c15 = (multi["15m"]?.data || []).slice(-3).map(x=>x.close);
      const c30 = (multi["30m"]?.data || []).slice(-3).map(x=>x.close);
      if (c15.length < 2 || c30.length < 2) { if (_opts.verbose) console.log("not enough TFs"); return null; }
      const trend15 = c15.at(-1) - c15.at(-2);
      const trend30 = c30.at(-1) - c30.at(-2);
      if (side === "Bullish" && !(trend15 > 0 && trend30 >= 0)) { if (_opts.verbose) console.log("TF align fail bullish"); return null; }
      if (side === "Bearish" && !(trend15 < 0 && trend30 <= 0)) { if (_opts.verbose) console.log("TF align fail bearish"); return null; }
    }

    // ML prediction (15m)
    const ml = await runMLPrediction(symbol, "15m").catch(()=>null);
    if (!ml) { if (_opts.verbose) console.log("ml missing"); return null; }
    const mlProbs = ml.probs || {};
    const mlMaxProb = ml.maxProb ?? Math.max(mlProbs.bull||0, mlProbs.bear||0, mlProbs.neutral||0);
    const mlDir = ml.direction || (mlMaxProb === (mlProbs.bull||0) ? "Bullish" : (mlMaxProb === (mlProbs.bear||0) ? "Bearish" : "Neutral"));
    const mlTpEstimate = ml.tpEstimate ?? ml.tpEstimate ?? null;

    // adaptive threshold + micro
    const threshold = adaptiveThreshold(_opts.mlMinConfidence);
    if (_opts.verbose) console.log("mlMaxProb", mlMaxProb, "threshold", threshold);

    // news
    let news = { sentiment: 0.5, impact: "low", ok:false };
    try { news = await fetchNewsBundle(symbol); } catch(e) {}
    const newsScore = (typeof news.sentiment === "number") ? (news.sentiment - 0.5) * 2 : 0;
    if (String(news.impact || "").toLowerCase() === "high") {
      if ((newsScore > 0 && side === "Bearish") || (newsScore < 0 && side === "Bullish")) { if (_opts.verbose) console.log("news contradicts side"); return null; }
    }

    // micro confirm
    const micro = await runMicroPrediction(symbol, "1m").catch(()=>null);
    if (!micro) { if (_opts.verbose) console.log("micro missing"); return null; }
    if (side === "Bullish" && micro.label && String(micro.label).toLowerCase().includes("bear")) { if (_opts.verbose) console.log("micro contradicts bullish"); return null; }
    if (side === "Bearish" && micro.label && String(micro.label).toLowerCase().includes("bull")) { if (_opts.verbose) console.log("micro contradicts bearish"); return null; }

    // final scoring
    let score = 0;
    // ml alignment
    if ((mlDir === "Bullish" && side === "Bullish") || (mlDir === "Bearish" && side === "Bearish")) {
      score += clamp((mlMaxProb - threshold) / 10, -2, 3);
    } else {
      score -= clamp((threshold - mlMaxProb) / 20, 0, 2);
    }
    // momentum shift
    score += clamp(momentumShift * 0.9, -2, 2);
    // volume spike
    score += clamp(volSpike - 1, 0, 3) * 0.5;
    // structural bonuses
    if (orderBlock) score += 0.8;
    if (fvg) score += 0.6;
    if (sweep) score += 0.9;
    if (hiddenDiv) score += 0.9;
    // news small boost
    score += clamp(newsScore * 0.6, -1, 1);
    // micro support
    if (micro && typeof micro.prob === "number" && micro.prob > 60) score += 0.7;

    if (_opts.verbose) console.log("scan debug", { pattern: patternObj.name, side, mlDir, mlMaxProb, score });

    // gate
    if (score < _opts.scoreGate) { if (_opts.verbose) console.log("score below gate"); return null; }

    // dedupe & cooldown
    const alertId = `${side}_${Math.floor(price)}_${Date.now()}`;
    if (alertId === memory.lastSignature) return null;
    if (Date.now() - memory.lastAlertTs < _opts.cooldownMs) { if (_opts.verbose) console.log("cooldown active"); return null; }

    // Elliott analysis for TP/SL
    let ell = null;
    try { ell = await analyzeElliott(candles15); } catch (e) { ell = null; }

    // build TP candidates & pick primary/hedge
    const candidates = buildCandidateTPsFromElliottOrAtr(ell, price, buildFeaturesFromCandles(candles15));
    const chosen = choosePrimaryHedge(candidates, mlDir || side, price, buildFeaturesFromCandles(candles15), ell) || {};
    const sl = pickSL(mlDir || side, price, buildFeaturesFromCandles(candles15), ell);

    // compose meta & record
    const meta = {
      alertId, ts: nowISO(), symbol, side, pattern: patternObj.name, price,
      mlDir, mlProbs, mlMaxProb, mlTpEstimate,
      micro, newsSentiment: news.sentiment, newsImpact: news.impact,
      momentumShift, orderBlock, fvg, sweep, hiddenDiv,
      score, tpPrimary: chosen.primary || null, tpHedge: chosen.hedge || null,
      tpPrimarySource: chosen.primarySource || null, tpHedgeSource: chosen.hedgeSource || null,
      tpConfidence: chosen.confidence || null,
      sl, rawML: ml
    };

    // record locally + call ML recordPrediction wrapper
    _stats.alerts = _stats.alerts || [];
    _stats.alerts.push({ alertId, symbol, ts: meta.ts, meta });
    if (_stats.alerts.length > 800) _stats.alerts.splice(0, _stats.alerts.length - 800);
    saveStats();

    try { recordPrediction({ id: alertId, symbol, meta, ml }); } catch(e){ if (_opts.verbose) console.log("recordPrediction failed", e?.message || e); }

    // send alert via user-supplied sender
    const payload = buildAlertPayload(meta);
    try { await sendAlertPayload(payload); } catch (e) { if (_opts.verbose) console.error("sendAlertPayload failed", e?.message || e); }

    // memory updates
    memory.lastSignature = alertId;
    memory.lastAlertTs = Date.now();

    if (_opts.verbose) console.log("Reversal alert emitted:", alertId);
    return meta;

  } catch (err) {
    if (_opts.verbose) console.error("scan error:", err?.message || err);
    return null;
  }
}

// -------------------- Public API --------------------
export function startReversalWatcher(symbol, opts = {}, sendFunc) {
  try {
    stopReversalWatcher();
    _opts = Object.assign({}, DEFAULTS, opts || {});
    _sendFunc = sendFunc;
    _interval = setInterval(()=>{ scan(symbol).catch(()=>{}); }, _opts.pollIntervalMs);
    // warm start
    setTimeout(()=>scan(symbol).catch(()=>{}), 800);
    if (_opts.verbose) console.log("ReversalWatcher PRO V3 started for", symbol, "opts:", _opts);
    return true;
  } catch (e) {
    if (_opts.verbose) console.error("start error", e?.message || e);
    return false;
  }
}

export function stopReversalWatcher() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _sendFunc = null;
  if (_opts.verbose) console.log("ReversalWatcher PRO V3 stopped");
}

export async function scanReversal(symbol) {
  return await scan(symbol);
}

export function markOutcome(symbol, alertId, success = true, trueLabel = null) {
  try {
    if (success) _stats.wins = (_stats.wins||0) + 1; else _stats.losses = (_stats.losses||0) + 1;
    const idx = (_stats.alerts || []).findIndex(a => a.alertId === alertId);
    if (idx >= 0) _stats.alerts[idx].outcome = success ? "win" : "loss";
    saveStats();
    try { recordOutcome({ alertId, symbol, success, ts: nowISO() }); } catch (e) {}
    // optionally update adaptive weights in ML module if trueLabel provided
    if (typeof trueLabel === "string" && typeof MLmodule.trainAdaptive === "function") {
      try { MLmodule.trainAdaptive([{ trueLabel, fusedProb: 0.5, breakdown: {} }]); } catch (e) {}
    }
    return true;
  } catch (e) { return false; }
}

export function getStats() {
  const accFromML = (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0, total: 0, correct: 0 };
  return { ..._stats, mlAccuracy: accFromML };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  scanReversal,
  markOutcome,
  getStats
};