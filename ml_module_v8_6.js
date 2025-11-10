/**
 * ml_module_v9_2.js
 * Simple persistent online model (logisti style). Keeps small persisted weights.
 */

import fs from "fs";
const MODEL_FILE = "./ml_model_v9_2.json";

let MODEL = { w: [0.0, 0.0, 0.0, 0.0, 0.0], bias: 0.0, lr: 0.02, trained: 0, history: [] };

export function initModel() {
  try {
    if (fs.existsSync(MODEL_FILE)) {
      MODEL = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
      console.log("ML v9.2 model loaded");
    } else {
      fs.writeFileSync(MODEL_FILE, JSON.stringify(MODEL, null, 2));
      console.log("ML v9.2 model initialized");
    }
  } catch (e) { console.warn("initModel err", e.message); }
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function featureExtractFromCandles(candles) {
  if (!candles || candles.length < 30) return [0,0,0,0,0];
  const closes = candles.map(c=>c.close);
  // momentum: last vs mean of last 5
  const last = closes.slice(-1)[0];
  const mean5 = closes.slice(-6,-1).reduce((a,b)=>a+b,0)/5;
  const momentum = (last - mean5)/Math.max(1, mean5);
  // volatility normalized: ATR / price
  let trs = [];
  for (let i=1;i<candles.length;i++){
    const cur = candles[i], prev = candles[i-1];
    trs.push(Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close)));
  }
  const atr = trs.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(14, trs.slice(-14).length));
  const vol = candles.slice(-1)[0].vol || 0;
  const volNorm = vol / Math.max(1, atr);
  // rsi-like
  let up=0, down=0;
  for (let i=1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    if (d>0) up+=d; else down += Math.abs(d);
  }
  const rsiProxy = up / (up + down + 1e-9);
  // macd proxy simple
  const fast = closes.slice(-12).reduce((a,b)=>a+b,0)/Math.min(12, closes.slice(-12).length);
  const slow = closes.slice(-26).reduce((a,b)=>a+b,0)/Math.min(26, closes.slice(-26).length);
  const macd = fast - slow;
  return [momentum, (rsiProxy-0.5), macd/Math.max(1, Math.abs(slow)||1), volNorm/100, atr/Math.max(1, last)];
}

export function predictFromCandles(candles) {
  try {
    const feats = featureExtractFromCandles(candles);
    while (MODEL.w.length < feats.length) MODEL.w.push(0);
    let z = MODEL.bias;
    for (let i=0;i<feats.length;i++) z += (MODEL.w[i]||0) * feats[i];
    const p = sigmoid(z);
    MODEL.history = (MODEL.history || []).slice(-49).concat([p]);
    try { fs.writeFileSync(MODEL_FILE, JSON.stringify(MODEL,null,2)); } catch(e){}
    return p;
  } catch (e) { return 0.5; }
}

export function predictSimple(obj) {
  try {
    const feats = [
      ((obj.last.close - (obj.prevClose || obj.last.close)) / Math.max(1, (obj.prevClose || obj.last.close))),
      ((obj.rsi || 0.5) - 0.5),
      (obj.macd && obj.macd.MACD) ? obj.macd.MACD/100 : 0,
      ((obj.vol || 0) / Math.max(1, obj.atr || 1))/100,
      0
    ];
    while (MODEL.w.length < feats.length) MODEL.w.push(0);
    let z = MODEL.bias;
    for (let i=0;i<feats.length;i++) z += (MODEL.w[i]||0) * feats[i];
    return sigmoid(z) * 100;
  } catch(e){ return 50; }
}

export function trainOnExample(candles, label) {
  try {
    const feats = featureExtractFromCandles(candles);
    while (MODEL.w.length < feats.length) MODEL.w.push(0);
    const z = MODEL.bias + feats.reduce((s,f,i)=>s + (MODEL.w[i]||0) * f, 0);
    const p = sigmoid(z);
    const err = (label - p);
    for (let i=0;i<feats.length;i++) MODEL.w[i] += MODEL.lr * (err * feats[i] - 0.0001 * (MODEL.w[i]||0));
    MODEL.bias += MODEL.lr * err;
    MODEL.trained = (MODEL.trained||0) + 1;
    if (MODEL.trained % 5 === 0) fs.writeFileSync(MODEL_FILE, JSON.stringify(MODEL,null,2));
    return p;
  } catch(e) { console.warn("train err", e.message); return null; }
}

export function getAccuracyLast10() {
  try {
    if (!MODEL.history || !MODEL.history.length) return 0;
    const arr = MODEL.history.slice(-10);
    // heuristic: distance from 0.5 averaged
    const score = arr.reduce((s,p)=> s + Math.abs(p-0.5), 0) / arr.length;
    return Math.round(score * 200);
  } catch(e){ return 0; }
}