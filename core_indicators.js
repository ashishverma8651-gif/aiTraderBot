// core_indicators.js — v11.0
// Linked to CONFIG + UTILS + ML

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { analyzeVolume } from "./utils.js"; // optional import for volume
const ML_PATH = CONFIG?.ML?.MODULE_PATH || "./ml_module_v8_6.js";

const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

// ---------- SMA ----------
export function SMA(arr = [], period = 14) {
  const res = [];
  for (let i = 0; i < arr.length; i++) {
    const slice = arr.slice(Math.max(0, i - period + 1), i + 1);
    const avg = slice.reduce((a, b) => a + safeNum(b), 0) / Math.max(1, slice.length);
    res.push(avg);
  }
  return res;
}

// ---------- EMA ----------
export function EMA(data = [], period = 12) {
  const closes = data.map((d) => (typeof d === "object" ? safeNum(d.close) : safeNum(d)));
  const k = 2 / (period + 1);
  const ema = [];
  let prev = closes[0] || 0;
  for (let i = 0; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

// ---------- ATR ----------
export function calculateATR(candles = [], period = CONFIG.ML?.ATR_PERIOD || 14) {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((cur, i) => {
    const prev = candles[i];
    const high = safeNum(cur.high);
    const low = safeNum(cur.low);
    const prevClose = safeNum(prev.close);
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  });
  const avg = trs.slice(-period).reduce((a, b) => a + b, 0) / Math.max(period, 1);
  return round2(avg);
}

// ---------- RSI ----------
export function calculateRSI(candles = [], period = CONFIG.ML?.RSI_PERIOD || 14) {
  if (candles.length < period + 1) return { value: null, summary: "NoData" };
  const gains = [], losses = [];
  for (let i = 1; i < candles.length; i++) {
    const diff = safeNum(candles[i].close) - safeNum(candles[i - 1].close);
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  const val = round2(rsi);
  return { value: val, summary: val > 70 ? "Overbought" : val < 30 ? "Oversold" : "Neutral" };
}

// ---------- MACD ----------
export function calculateMACD(candles = [], fast = 12, slow = 26, signal = 9) {
  const closes = candles.map((c) => safeNum(c.close));
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macd = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = EMA(macd, signal);
  const hist = macd.map((v, i) => v - signalLine[i]);
  const latest = { macd: round2(macd.at(-1)), signal: round2(signalLine.at(-1)), hist: round2(hist.at(-1)) };
  const summary = latest.hist > 0 ? "Bullish" : latest.hist < 0 ? "Bearish" : "Neutral";
  return { macd, signal: signalLine, histogram: hist, latest, summary };
}

// ---------- Combined Indicators ----------
export function analyzeIndicators(data = [], tf = "15m") {
  if (!data.length) return { ok: false, summary: "NoData" };
  const rsi = calculateRSI(data);
  const macd = calculateMACD(data);
  const atr = calculateATR(data);
  const volStats = analyzeVolume(data);
  const bullish = (rsi.summary === "Oversold" ? 1 : 0) + (macd.summary === "Bullish" ? 1 : 0);
  const bearish = (rsi.summary === "Overbought" ? 1 : 0) + (macd.summary === "Bearish" ? 1 : 0);
  const summary = bullish > bearish ? "Bullish" : bearish > bullish ? "Bearish" : "Neutral";
  return {
    ok: true,
    tf,
    rsi: rsi.value,
    macd: macd.latest.macd,
    atr,
    volume: volStats.label,
    summary
  };
}

// ---------- Multi-TF Analyzer ----------
export function analyzeMultiTF(tfDataMap = {}) {
  const results = {};
  for (const [tf, data] of Object.entries(tfDataMap)) {
    results[tf] = analyzeIndicators(data, tf);
  }
  const vals = Object.values(results).filter((r) => r.ok);
  const bull = vals.filter((r) => r.summary === "Bullish").length;
  const bear = vals.filter((r) => r.summary === "Bearish").length;
  const decision = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";
  const confidence = Math.round((Math.max(bull, bear) / (vals.length || 1)) * 100);
  return { decision, confidence, results };
}

// ---------- ML Integration ----------
export async function runMLForCandles(candles = []) {
  try {
    if (!candles.length) return { error: "no_data" };
    const ml = await import(ML_PATH).catch(() => null);
    if (!ml?.runMLPrediction) return { error: "no_ml" };
    const res = await ml.runMLPrediction(candles.slice(-CONFIG.ML.LOOKBACK || 500));
    if (res && typeof res.prob === "number")
      return { prob: round2(res.prob), label: res.label || "Unknown" };
    return { error: "invalid_result" };
  } catch (e) {
    return { error: e.message || "ml_error" };
  }
}

export default {
  SMA,
  EMA,
  calculateATR,
  calculateRSI,
  calculateMACD,
  analyzeIndicators,
  analyzeMultiTF,
  runMLForCandles
};