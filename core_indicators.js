// core_indicators.js
// Robust technicals + multi-timeframe + ML hooks
// Exports: calculateRSI, calculateMACD, calculateATR, EMA, SMA,
//          analyzeIndicators, analyzeMultiTF, analyzeFromCandles,
//          runMLForCandles

import fs from "fs";
import path from "path";

// ---------------------- Safe utilities ----------------------
const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

// ---------------------- Simple moving average ----------------------
export function SMA(arr = [], period = 14) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    const end = i + 1;
    const start = Math.max(0, end - period);
    const window = arr.slice(start, end).map(v => safeNum(v));
    const sum = window.reduce((a, b) => a + b, 0);
    res.push(sum / (window.length || 1));
  }
  return res;
}

// ---------------------- Exponential moving average ----------------------
export function EMA(data = [], period = 12) {
  // data: array of numbers OR array of {close}
  const closes = data.map(d => (typeof d === "object" ? safeNum(d.close) : safeNum(d)));
  if (closes.length < period) {
    // return array of same length with fallback averages if not enough
    const avg = closes.length ? closes.reduce((a,b)=>a+b,0)/closes.length : 0;
    return closes.map(() => avg);
  }

  const k = 2 / (period + 1);
  const ema = [];
  // start with SMA of first `period`
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let prev = sum / period;
  // fill first values up to period-1 with prev to keep indexing simple
  for (let i = 0; i < period - 1; i++) ema.push(null);
  ema.push(prev); // index period-1

  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    ema.push(prev);
  }

  // ensure same length as input (fill leading nulls if necessary)
  while (ema.length < closes.length) ema.unshift(null);
  return ema;
}

// ---------------------- ATR ----------------------
export function calculateATR(candles = [], period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  // create true ranges
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const high = safeNum(cur.high);
    const low = safeNum(cur.low);
    const prevClose = safeNum(prev.close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  // simple moving average of TRs over `period`
  const len = trs.length;
  const use = Math.min(period, len);
  const lastN = trs.slice(len - use);
  const sum = lastN.reduce((a, b) => a + b, 0);
  const atr = sum / Math.max(1, use);
  return round2(atr);
}

// ---------------------- RSI ----------------------
export function calculateRSI(candles = [], period = 14) {
  // returns { value, summary } or null
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  // build changes
  const changes = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = safeNum(candles[i].close);
    const prev = safeNum(candles[i - 1].close);
    changes.push(cur - prev);
  }

  // initial avg gain/loss
  let gain = 0, loss = 0;
  for (let i = 0; i < period; i++) {
    const ch = safeNum(changes[i] ?? 0);
    if (ch >= 0) gain += ch;
    else loss += Math.abs(ch);
  }
  gain = gain / period;
  loss = loss / period;

  // Wilder smoothing for remaining changes (if any)
  for (let i = period; i < changes.length; i++) {
    const ch = safeNum(changes[i]);
    gain = (gain * (period - 1) + Math.max(0, ch)) / period;
    loss = (loss * (period - 1) + Math.max(0, -ch)) / period;
  }

  // RS and RSI
  const rs = loss === 0 ? Infinity : gain / loss;
  const rsi = loss === 0 ? 100 : 100 - 100 / (1 + rs);
  const rounded = Math.round(rsi * 100) / 100;

  const summary = rounded >= 70 ? "Overbought" : rounded <= 30 ? "Oversold" : "Neutral";
  return { value: rounded, summary };
}

// ---------------------- MACD ----------------------
export function calculateMACD(candles = [], fast = 12, slow = 26, signal = 9) {
  // returns { macd: array, signal: array, histogram: array, latest: {macd, signal, hist}, summary }
  // Accepts candles array or numeric close-series
  if (!Array.isArray(candles) || candles.length < slow + signal) {
    // try to calculate with whatever we have; but be safe
    if (!Array.isArray(candles) || candles.length < 3) return null;
  }

  // extract closes
  const closes = candles.map(c => safeNum(c.close));

  // compute emaFast and emaSlow
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);

  // macd line = emaFast - emaSlow (align indices)
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f == null || s == null) {
      macdLine.push(null);
    } else {
      macdLine.push(f - s);
    }
  }

  // signal line as EMA of macdLine values (skip nulls by treating them as 0)
  const macdNumbers = macdLine.map(v => (v == null ? 0 : v));
  const signalLine = EMA(macdNumbers, signal);

  // histogram = macd - signal
  const histogram = macdLine.map((m, i) => {
    const sig = signalLine[i];
    if (m == null || sig == null) return null;
    return m - sig;
  });

  // latest non-null values
  let latestIdx = null;
  for (let i = histogram.length - 1; i >= 0; i--) {
    if (histogram[i] != null) { latestIdx = i; break; }
  }

  const latest = latestIdx == null ? { macd: 0, signal: 0, hist: 0 } : {
    macd: round2(macdLine[latestIdx]),
    signal: round2(signalLine[latestIdx]),
    hist: round2(histogram[latestIdx])
  };

  const summary = latest.hist > 0 ? "Bullish" : latest.hist < 0 ? "Bearish" : "Neutral";

  return {
    macd: macdLine.map(v => (v == null ? null : round2(v))),
    signal: signalLine.map(v => (v == null ? null : round2(v))),
    histogram: histogram.map(v => (v == null ? null : round2(v))),
    latest,
    summary
  };
}

// ---------------------- Single-candle analysis helper ----------------------
export function analyzeFromCandles(candles = [], opts = {}) {
  // Returns consolidated indicators: { rsi: num/null, macd: num/null, atr: num/null }
  // opts: rsiPeriod, macd params, atrPeriod
  const rsiPeriod = opts.rsiPeriod || 14;
  const macdFast = opts.macdFast || 12;
  const macdSlow = opts.macdSlow || 26;
  const macdSignal = opts.macdSignal || 9;
  const atrPeriod = opts.atrPeriod || 14;

  const res = { rsi: null, macd: null, atr: null };

  if (!Array.isArray(candles) || candles.length === 0) {
    return res;
  }

  // RSI
  const rsiObj = calculateRSI(candles, rsiPeriod);
  res.rsi = rsiObj ? rsiObj.value : null;

  // MACD: use latest.hist or latest.macd
  const macdObj = calculateMACD(candles, macdFast, macdSlow, macdSignal);
  if (macdObj && macdObj.latest) {
    // prefer histogram sign as quick signal, but return latest.macd as numeric
    res.macd = safeNum(macdObj.latest.macd, 0);
  } else {
    res.macd = null;
  }

  // ATR
  res.atr = calculateATR(candles.slice(-Math.max(atrPeriod, 20)), atrPeriod);

  // Final rounding
  res.rsi = res.rsi == null ? null : Math.round(res.rsi * 100) / 100;
  res.macd = res.macd == null ? null : Math.round(res.macd * 100) / 100;
  res.atr = res.atr == null ? null : Math.round(res.atr);

  return res;
}

// ---------------------- Per-timeframe summary ----------------------
export function analyzeIndicators(data = [], tf = "15m", opts = {}) {
  // data: array of candles
  // returns { ok, tf, rsi, macd, atr, volume, summary }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, tf, summary: "NoData" };
  }

  const last = data[data.length - 1] || {};
  const lastVol = safeNum(last.vol, 0);
  const avgVol = Math.round(
    (data.slice(-20).reduce((a, b) => a + safeNum(b.vol, 0), 0) /
      Math.max(1, Math.min(20, data.length)))
  );

  const volSignal = avgVol && lastVol > avgVol * 1.5 ? "HighVolume" : "NormalVolume";

  const ind = analyzeFromCandles(data, opts);
  const rsiSummary = ind.rsi == null ? "NoRSI" : ind.rsi > 70 ? "Overbought" : ind.rsi < 30 ? "Oversold" : "Neutral";
  const macdSummary = ind.macd == null ? "NoMACD" : ind.macd > 0 ? "Bullish" : ind.macd < 0 ? "Bearish" : "Neutral";

  // Combined
  let bullish = 0, bearish = 0;
  if (rsiSummary === "Overbought") bearish++;
  if (rsiSummary === "Oversold") bullish++;
  if (macdSummary === "Bullish") bullish++;
  if (macdSummary === "Bearish") bearish++;

  let summary = "Neutral";
  if (bullish > bearish) summary = "Bullish";
  else if (bearish > bullish) summary = "Bearish";

  return {
    ok: true,
    tf,
    rsi: ind.rsi,
    macd: ind.macd,
    atr: ind.atr,
    volume: volSignal,
    summary
  };
}

// ---------------------- Multi-TF ----------------------
export function analyzeMultiTF(tfDataMap = {}, opts = {}) {
  // tfDataMap: { "1m": candlesArray, "5m": ... }
  const results = {};
  for (const [tf, data] of Object.entries(tfDataMap || {})) {
    results[tf] = analyzeIndicators(Array.isArray(data) ? data : [], tf, opts);
  }

  const valid = Object.values(results).filter(r => r.ok);
  const bullish = valid.filter(v => v.summary === "Bullish").length;
  const bearish = valid.filter(v => v.summary === "Bearish").length;

  let decision = "Neutral";
  if (bullish > bearish) decision = "Bullish";
  else if (bearish > bullish) decision = "Bearish";

  const confidence = Math.round((Math.max(bullish, bearish) / (valid.length || 1)) * 100);

  return { decision, confidence, tfSummary: results };
}

// ---------------------- ML integration hook ----------------------
export async function runMLForCandles(candles = []) {
  // Safe dynamic import of your ml module. Returns { prob, label } or null
  try {
    const modPath = "./ml_module_v8_6.js";
    if (!Array.isArray(candles) || candles.length < 5) return { error: "insufficient" };

    // dynamic import (if exists)
    const ml = await import(modPath).catch(() => null);
    if (!ml || typeof ml.runMLPrediction !== "function") return { error: "no_ml" };

    // run prediction on last N candles
    const featWindow = candles.slice(-Math.min(500, candles.length));
    const res = ml.runMLPrediction(featWindow);
    // normalize
    if (res && typeof res.prob === "number") {
      return { prob: Math.round(res.prob * 100) / 100, label: res.label || "N/A" };
    }
    return { error: "invalid_result" };
  } catch (e) {
    return { error: "ml_error", message: e.message || String(e) };
  }
}

// ---------------------- Default export (for convenience) ----------------------
export default {
  SMA,
  EMA,
  calculateATR,
  calculateRSI,
  calculateMACD,
  analyzeFromCandles,
  analyzeIndicators,
  analyzeMultiTF,
  runMLForCandles
};