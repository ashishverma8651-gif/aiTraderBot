// reversal_watcher_v3.js (B-version)
// Professional, reversal-first watcher with ML + News fusion + confirmed-candle logic
// Exports: startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats
// Default export included at bottom.

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || News.default && News.default.fetchNewsBundle))
  ? (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle))
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// --------------------- persistence / stats ---------------------
const STATS_FILE = process.env.REV_STATS_FILE || path.join(process.cwd(), ".reversal_stats.json");
let _stats = { alerts: [], wins: 0, losses: 0, lastUpdated: null };
try { if (fs.existsSync(STATS_FILE)) _stats = JSON.parse(fs.readFileSync(STATS_FILE,"utf8")||"{}") || _stats; } catch(e){}

function saveStats(){
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) {}
}

function recordLocalAlert(a){
  _stats.alerts = _stats.alerts || [];
  _stats.alerts.push({ ...a, ts: new Date().toISOString() });
  if (_stats.alerts.length > 300) _stats.alerts.splice(0, _stats.alerts.length - 300);
  saveStats();
}

// --------------------- runtime & defaults ---------------------
let _interval = null;
let _send = null;
let _opts = {};
const DEFAULTS = {
  pollIntervalMs: 20_000,
  mlMinConfidence: 65,
  cooldownMs: 90_000,
  requireMultiTFAlign: false, // turned off by default (reversals can occur vs trend)
  requireVolumeStructure: false,
  verbose: false,
  minScore: 0.5
};

const memory = { lastSignature: "", lastAlertTs: 0, lastCandleTS: 0 };

// --------------------- helpers ---------------------
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v,d=2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";
const mean = arr => (arr && arr.length) ? (arr.reduce((a,b)=>a+b,0)/arr.length) : 0;

// stable softmax small helper
function softmax(arr){
  const m = Math.max(...arr);
  const ex = arr.map(x=>Math.exp(x-m));
  const s = ex.reduce((a,b)=>a+b,0) + 1e-12;
  return ex.map(x=>x/s);
}

// --------------------- pattern detectors ---------------------

// pin bar / rejection candle
function isPinBar(c){
  if (!c) return false;
  const body = Math.abs(c.close - c.open);
  const total = c.high - c.low || 1e-9;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  // pin: long wick at one side > 2x body and wick > 0.5*total
  if (lowerWick > body * 1.8 && lowerWick > total * 0.35) return { side: "Bullish", type:"PinBar" };
  if (upperWick > body * 1.8 && upperWick > total * 0.35) return { side: "Bearish", type:"PinBar" };
  return false;
}

function isHammer(c){
  if (!c) return false;
  const body = Math.abs(c.close - c.open);
  const total = c.high - c.low || 1e-9;
  const lower = Math.min(c.open,c.close) - c.low;
  const upper = c.high - Math.max(c.open,c.close);
  if (lower > body * 2 && upper < body * 0.3 && body/total < 0.5) return { side:"Bullish", type:"Hammer" };
  if (upper > body * 2 && lower < body * 0.3 && body/total < 0.5) return { side:"Bearish", type:"InvHammer" };
  return false;
}

function isEngulfing(prev, cur){
  if (!prev || !cur) return false;
  // bullish engulfing: cur.close > cur.open and cur.close >= prev.open and cur.open <= prev.close (body engulfs)
  const prevBodyHi = Math.max(prev.open, prev.close);
  const prevBodyLo = Math.min(prev.open, prev.close);
  const curBodyHi = Math.max(cur.open, cur.close);
  const curBodyLo = Math.min(cur.open, cur.close);
  if (cur.close > cur.open && curBodyHi >= prevBodyHi && curBodyLo <= prevBodyLo) return { side:"Bullish", type:"Engulfing" };
  if (cur.open > cur.close && curBodyLo <= prevBodyLo && curBodyHi >= prevBodyHi) return { side:"Bearish", type:"Engulfing" };
  return false;
}

// fakey detection (false breakout + rejection)
function isFakey(prev, cur, next){
  if (!prev || !cur || !next) return false;
  // breakout of previous range but next closes back inside → fakey
  const rangeHi = Math.max(prev.high, prev.open, prev.close);
  const rangeLo = Math.min(prev.low, prev.open, prev.close);
  // cur breaks above and next closes back below rangeHi -> bearish fakey
  if (cur.high > rangeHi && next.close < rangeHi && cur.close > cur.open) return { side:"Bearish", type:"Fakey" };
  if (cur.low < rangeLo && next.close > rangeLo && cur.close < cur.open) return { side:"Bullish", type:"Fakey" };
  return false;
}

// reorder a small set of detectors to check confirmed candle
function detectPattern(prev2, prev1, confirm){ // prev2 older, prev1 previous, confirm = confirmed (penultimate)
  // check pinbar/hammer on confirm first
  let p = isPinBar(confirm) || isHammer(confirm);
  if (p) return p;
  // engulfing using prev1 and confirm
  p = isEngulfing(prev1, confirm);
  if (p) return p;
  // fakey using prev2, prev1, confirm
  p = isFakey(prev2, prev1, confirm);
  if (p) return p;
  return null;
}

// --------------------- structure detectors ---------------------

function detectOrderBlock(preCandles = [], impulseCandle){
  if (!Array.isArray(preCandles) || preCandles.length < 3 || !impulseCandle) return null;
  const highs = preCandles.map(c=>c.high), lows = preCandles.map(c=>c.low);
  const range = Math.max(...highs) - Math.min(...lows);
  const avgBody = mean(preCandles.map(c=>Math.abs(c.close - c.open))) || 1e-9;
  const impulsiveBody = Math.abs(impulseCandle.close - impulseCandle.open);
  if (range < avgBody * 4 && impulsiveBody > avgBody * 1.8) {
    return { lo: Math.min(...lows), hi: Math.max(...highs), bodyAvg: avgBody };
  }
  return null;
}

function detectFVG(candles, lookback=6){
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  for (let i = candles.length - lookback - 1; i < candles.length - 1; i++){
    const a = candles[i], b = candles[i+1];
    const aHi = Math.max(a.open, a.close), aLo = Math.min(a.open, a.close);
    const bHi = Math.max(b.open, b.close), bLo = Math.min(b.open, b.close);
    if (bLo > aHi + 1e-12) return { type:"up", lo: aHi, hi: bLo, idx: i+1 };
    if (bHi < aLo - 1e-12) return { type:"down", lo: bHi, hi: aLo, idx: i+1 };
  }
  return null;
}

function detectLiquiditySweep(candles, lookback=12){
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  const last = candles.at(-1);
  const window = candles.slice(-1-lookback, -1);
  if (!window.length) return null;
  const priorHigh = Math.max(...window.map(c=>c.high));
  const priorLow = Math.min(...window.map(c=>c.low));
  if (last.high > priorHigh && last.close < priorHigh) return { side:"BearishSweep", priorHigh };
  if (last.low < priorLow && last.close > priorLow) return { side:"BullishSweep", priorLow };
  return null;
}

function wickStrength(c){
  if (!c) return { up:0, down:0 };
  const body = Math.abs(c.close - c.open) || 1e-9;
  const up = (c.high - Math.max(c.open, c.close)) / body;
  const down = (Math.min(c.open, c.close) - c.low) / body;
  return { up, down };
}

// require multi-tf alignment (optional)
function multiTFAlignment(multi, side){
  try {
    const c15 = multi["15m"]?.data?.slice(-3).map(x=>x.close) || [];
    const c30 = multi["30m"]?.data?.slice(-3).map(x=>x.close) || [];
    if (c15.length < 2 || c30.length < 2) return false;
    const trend15 = c15.at(-1) - c15.at(-2);
    const trend30 = c30.at(-1) - c30.at(-2);
    return (side === "Bullish") ? (trend15 > 0 && trend30 >= 0) : (side === "Bearish" ? (trend15 < 0 && trend30 <= 0) : false);
  } catch (e) { return false; }
}

// adaptive threshold from wins/losses
function adaptiveThreshold(base){
  try {
    const total = (_stats.wins||0) + (_stats.losses||0);
    if (!total) return base;
    const wr = (_stats.wins||0)/total;
    const adj = (0.5 - wr) * 0.5 * 100; // ~[-25..25]
    return clamp(base + Math.round(adj), 45, 90);
  } catch (e) { return base; }
}

// build message
function buildAlertMsg(meta){
  const e = meta.side === "Bullish" ? "🟢" : "🔴";
  const lines = [
    `${e} REVERSAL CONFIRMED — ${meta.side}`,
    `Pattern: ${meta.pattern} (${meta.patternType || ""})`,
    `Price: ${nf(meta.price,2)}`,
    `ML: ${meta.mlDirection || meta.mlLabel || "N/A"} (${meta.mlProb ?? "N/A"}%)`,
    `Micro: ${meta.microLabel || "N/A"} (${meta.microProb ?? "N/A"}%)`,
    `News: ${nf(meta.newsSentiment,2)} (${meta.newsImpact||"low"})`,
    `OrderBlock: ${meta.orderBlock ? `${nf(meta.orderBlock.lo,2)} - ${nf(meta.orderBlock.hi,2)}` : "no"}`,
    `FVG: ${meta.fvg ? meta.fvg.type : "no"}`,
    `Sweep: ${meta.sweep ? meta.sweep.side : "no"}`,
    `alertId: ${meta.alertId}`
  ];
  return lines.join("\n");
}

// --------------------- main scan (confirmed-candle only) ---------------------
async function scan(symbol){
  try {
    const multi = await fetchMultiTF(symbol, ["1m","5m","15m","30m","1h"]);
    const candles15 = multi["15m"]?.data || [];
    if (!Array.isArray(candles15) || candles15.length < 8) return;

    // use confirmed (penultimate) candle to avoid false triggers
    const confirm = candles15.at(-2);
    const prev1 = candles15.at(-3);
    const prev2 = candles15.at(-4);

    if (!confirm) return;

    // avoid reprocessing same candle
    if (confirm.time === memory.lastCandleTS) return;
    memory.lastCandleTS = confirm.time;

    // detect pattern on confirmed candle
    const patternObj = detectPattern(prev2, prev1, confirm);
    if (!patternObj) return;

    const side = patternObj.side;
    const patternName = patternObj.type || "Pattern";

    // wick strength sanity (looser than before)
    const ws = wickStrength(confirm);
    if (side === "Bullish" && ws.down < 0.3) return;
    if (side === "Bearish" && ws.up < 0.3) return;

    // structural checks: order block / fvg / sweep
    const pre = candles15.slice(-8, -1);
    const ob = detectOrderBlock(pre, confirm);
    const fvg = detectFVG(candles15, 6);
    const sweep = detectLiquiditySweep(candles15, 12);

    // volume check: relaxed (optional)
    const lastVols = candles15.slice(-12).map(c => c.volume || 0);
    const avgVol = mean(lastVols.slice(0, -1)) || 1;
    const volSpike = lastVols.at(-2) / Math.max(1, avgVol);
    if (_opts.requireVolumeStructure && volSpike < 0.9) return; // allow volume slightly lower for reversals

    // multi TF alignment (optional and default false)
    if (_opts.requireMultiTFAlign && !multiTFAlignment(multi, side)) return;

    // ML main (15m)
    const ml = await runMLPrediction(symbol, "15m").catch(()=>null);
    if (!ml) return;
    const mlProb = ml.maxProb ?? Math.max(ml.probs?.bull||0, ml.probs?.bear||0, ml.probs?.neutral||0);
    const mlDirection = ml.direction || ml.label || (ml.probs && (ml.probs.bull>ml.probs.bear ? "Bullish":"Bearish")) || "Neutral";

    // micro confirmation (1m)
    const micro = await runMicroPrediction(symbol, "1m").catch(()=>null);
    const microLabel = micro?.label || micro?.direction || null;
    const microProb = micro?.prob || micro?.probBull || null;

    // news integration
    let news = { sentiment: 0.5, impact: "low", items: [] };
    try { news = await fetchNewsBundle(symbol); } catch(e){}
    const newsScore = (typeof news.sentiment === "number") ? (news.sentiment - 0.5) * 2 : 0;

    // optional check: micro should not be strongly opposite
    if (microLabel && side === "Bullish" && String(microLabel).toLowerCase().includes("bear")) return;
    if (microLabel && side === "Bearish" && String(microLabel).toLowerCase().includes("bull")) return;

    // adaptive threshold + scoring
    const threshold = adaptiveThreshold(_opts.mlMinConfidence);
    let score = 0;
    score += (mlProb - threshold) / 10;          // ML delta (positive if ML supports)
    score += clamp((volSpike - 1), -1, 3) * 0.5; // vol helps
    if (ob) score += 0.7;
    if (fvg) score += 0.5;
    if (sweep) score += 0.9;
    score += clamp(newsScore * 0.6, -1, 1);      // news small influence
    // Elliott confirmation
    let ell = null;
    try { ell = await analyzeElliott(candles15); } catch(e){ ell = null; }
    if (ell && ell.confidence > 40 && ((ell.sentiment>0 && side==="Bullish") || (ell.sentiment<0 && side==="Bearish"))) score += 0.5;

    if (_opts.verbose) console.log("rev-check", { symbol, side, patternName, mlProb, threshold, volSpike: nf(volSpike,2), ob: !!ob, fvg: !!fvg, sweep: !!sweep, score: nf(score,2) });

    if (score < _opts.minScore) return;

    // dedupe / cooldown
    const alertId = `${side}_${Math.floor(confirm.close)}_${confirm.time}`;
    if (alertId === memory.lastSignature) return;
    if (Date.now() - memory.lastAlertTs < _opts.cooldownMs) return;

    // record alert locally and via ml module
    const meta = {
      alertId,
      symbol,
      side,
      pattern: patternName,
      patternType: patternObj.type,
      price: confirm.close,
      mlDirection,
      mlProb,
      microLabel,
      microProb,
      newsSentiment: news.sentiment,
      newsImpact: news.impact || "low",
      orderBlock: ob,
      fvg,
      sweep,
      ell: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null,
      ts: new Date().toISOString()
    };

    recordLocalAlert(meta);
    try { recordPrediction({ id: alertId, symbol, meta, ml }); } catch(e){ if(_opts.verbose) console.warn("recordPrediction failed", e); }

    // build and send message
    const message = buildAlertMsg({ ...meta, mlProb, alertId });
    if (_send) {
      try { await _send(message); } catch (e) { if (_opts.verbose) console.error("send failed", e); }
    }

    // update memory
    memory.lastSignature = alertId;
    memory.lastAlertTs = Date.now();

    if (_opts.verbose) console.log("reversal alert ->", alertId);

  } catch (err) {
    if (_opts.verbose) console.error("scan error:", err?.message || err);
  }
}

// --------------------- public control ---------------------
export function startReversalWatcher(symbol, opts = {}, sendFunc){
  try {
    stopReversalWatcher();
    _opts = { ...DEFAULTS, ...(opts||{}) };
    _send = sendFunc;
    _interval = setInterval(()=>scan(symbol), _opts.pollIntervalMs);
    setTimeout(()=>scan(symbol), 1000);
    if (_opts.verbose) console.log("ReversalWatcher v3 started for", symbol);
    return true;
  } catch (e) {
    if (_opts.verbose) console.error("start error", e);
    return false;
  }
}

export function stopReversalWatcher(){
  if (_interval) { clearInterval(_interval); _interval = null; }
  _send = null;
  if (_opts.verbose) console.log("ReversalWatcher v3 stopped");
}

export async function scanReversal(symbol){
  return scan(symbol);
}

export function markOutcome(symbol, alertId, success = true){
  try {
    _stats.wins = _stats.wins || 0;
    _stats.losses = _stats.losses || 0;
    if (success) _stats.wins++; else _stats.losses++;
    // annotate alert
    if (_stats.alerts && _stats.alerts.length){
      const idx = _stats.alerts.findIndex(a=>a.alertId===alertId);
      if (idx>=0) _stats.alerts[idx].outcome = success ? "win":"loss";
    }
    saveStats();
    try { recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() }); } catch(e){}
    return true;
  } catch (e) { return false; }
}

export function getStats(){ return { ..._stats }; }

// default export
export default {
  startReversalWatcher,
  stopReversalWatcher,
  scanReversal,
  markOutcome,
  getStats
};