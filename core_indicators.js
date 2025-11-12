// ===============================
// 📁 core_indicators.js — AI Trader v10.1 (Safe + ML-Ready Indicators)
// ===============================

import { EMA, SMA } from "technicalindicators";

// 🧰 Helper: Clean numeric array
function safeValues(arr = []) {
  return arr
    .filter(v => v !== null && v !== undefined && !isNaN(v))
    .map(v => parseFloat(v));
}

// ✅ MACD Calculation (Safe)
export function calcMACD(candles = [], fast = 12, slow = 26, signal = 9) {
  try {
    const closes = safeValues(candles.map(c => c?.close));
    if (closes.length < slow + signal) throw new Error("Not enough candles");

    const macdValues = EMA.calculate({ period: fast, values: closes })
      .slice(slow - fast)
      .map((emaFast, i) => emaFast - EMA.calculate({ period: slow, values: closes })[i]);

    const signalLine = EMA.calculate({ period: signal, values: macdValues });
    const histogram = macdValues.slice(signal - 1).map((m, i) => m - signalLine[i]);

    return {
      macd: macdValues.at(-1) || 0,
      signal: signalLine.at(-1) || 0,
      hist: histogram.at(-1) || 0
    };
  } catch (err) {
    console.warn("⚠️ MACD error:", err.message);
    return { macd: 0, signal: 0, hist: 0 };
  }
}

// ✅ RSI Calculation (Safe)
export function calcRSI(candles = [], period = 14) {
  try {
    const closes = safeValues(candles.map(c => c?.close));
    if (closes.length < period + 1) throw new Error("Not enough candles");

    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgGain / (avgLoss || 1);
    return 100 - 100 / (1 + rs);
  } catch (err) {
    console.warn("⚠️ RSI error:", err.message);
    return 50;
  }
}

// ✅ EMA Calculation (Safe)
export function calcEMA(candles = [], period = 20) {
  try {
    const closes = safeValues(candles.map(c => c?.close));
    if (closes.length < period) throw new Error("Not enough candles");
    const result = EMA.calculate({ period, values: closes });
    return result.at(-1) || closes.at(-1);
  } catch (err) {
    console.warn("⚠️ EMA error:", err.message);
    return 0;
  }
}

// ✅ ATR (Safe)
export function calcATR(candles = [], period = 14) {
  try {
    if (!candles?.length || candles.length < period + 1)
      throw new Error("Not enough candles");

    const trs = candles.map((c, i, arr) => {
      if (i === 0 || !arr[i - 1]) return 0;
      const prevClose = arr[i - 1].close;
      if (!c?.high || !c?.low || !prevClose) return 0;
      return Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
    });

    const atr = SMA.calculate({ period, values: trs });
    return atr.at(-1) || 0;
  } catch (err) {
    console.warn("⚠️ ATR error:", err.message);
    return 0;
  }
}

// ✅ Get all indicators together
export function getAllIndicators(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) {
    console.warn("⚠️ No candle data provided to indicators.");
    return { rsi: 50, macd: 0, signal: 0, hist: 0, ema: 0, atr: 0 };
  }

  const rsi = calcRSI(candles);
  const macd = calcMACD(candles);
  const ema = calcEMA(candles);
  const atr = calcATR(candles);

  return {
    rsi,
    macd: macd.macd,
    signal: macd.signal,
    hist: macd.hist,
    ema,
    atr
  };
}

export default {
  calcRSI,
  calcMACD,
  calcEMA,
  calcATR,
  getAllIndicators
};