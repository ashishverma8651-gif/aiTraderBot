// core_indicators.js — AI Trader v9.7 (Multi-TF Indicators)
import CONFIG from "./config.js";

// =============== HELPER MATH ===============
const avg = arr => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const ema = (data, period) => {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const res = [data[0]];
  for (let i = 1; i < data.length; i++) {
    res.push(data[i] * k + res[i - 1] * (1 - k));
  }
  return res;
};

// =============== RSI =======================
export function calcRSI(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < period + 1; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period || 0.00001;

  for (let i = period + 1; i < klines.length; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }

  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// =============== MACD ======================
export function calcMACD(klines, short = 12, long = 26, signal = 9) {
  const closes = klines.map(k => k.close);
  if (closes.length < long + signal) return { macd: 0, signal: 0, hist: 0, trend: "flat" };
  const emaShort = ema(closes, short);
  const emaLong = ema(closes, long);
  const macdLine = emaShort.slice(-emaLong.length).map((v, i) => v - emaLong[i]);
  const signalLine = ema(macdLine, signal);
  const hist = macdLine.at(-1) - signalLine.at(-1);
  const trend = hist > 0 ? "bullish" : hist < 0 ? "bearish" : "neutral";
  return { macd: macdLine.at(-1), signal: signalLine.at(-1), hist, trend };
}

// =============== ATR =======================
export function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const cur = klines[i], prev = klines[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  return +(avg(trs.slice(-period))).toFixed(2);
}

// =============== VOLUME STRENGTH ===========
export function calcVolumeStrength(klines, lookback = 20) {
  if (!klines || klines.length < lookback) return { ratio: 1, signal: "neutral" };
  const avgVol = avg(klines.slice(-lookback).map(k => k.vol || 0));
  const lastVol = klines.at(-1).vol || 0;
  const ratio = lastVol / avgVol;
  let signal = "normal";
  if (ratio > 1.5) signal = "high";
  else if (ratio < 0.7) signal = "low";
  return { ratio: +ratio.toFixed(2), signal };
}

// =============== PRICE TREND ===============
export function calcPriceTrend(klines) {
  if (!klines || klines.length < 2) return { slope: 0, direction: "flat" };
  const start = klines[0].close, end = klines.at(-1).close;
  const slope = ((end - start) / start) * 100;
  const direction = slope > 0.5 ? "up" : slope < -0.5 ? "down" : "sideways";
  return { slope: +slope.toFixed(2), direction };
}

// =============== COMPOSITE ANALYSIS ========
export function analyzeIndicators(klines, tf = "15m") {
  if (!klines || !klines.length) return { ok: false };

  const rsi = calcRSI(klines);
  const macd = calcMACD(klines);
  const atr = calcATR(klines);
  const vol = calcVolumeStrength(klines);
  const price = calcPriceTrend(klines);

  let summary = "Neutral";
  if (rsi > 65 && macd.trend === "bullish" && price.direction === "up") summary = "Bullish";
  else if (rsi < 35 && macd.trend === "bearish" && price.direction === "down") summary = "Bearish";

  return {
    ok: true,
    tf,
    summary,
    indicators: { rsi, macdTrend: macd.trend, atr, vol, price },
  };
}

// =============== MULTI-TF COMBINED =========
export function analyzeMultiTF(tfDataMap) {
  const results = {};
  for (const [tf, data] of Object.entries(tfDataMap)) {
    results[tf] = analyzeIndicators(data, tf);
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

const strength = confidence > 70 ? "🟢 Strong" :
                  confidence > 40 ? "🟡 Moderate" : "🔴 Weak";

return { decision, confidence, strength, tfSummary: results };