// ===================================================
// core_indicators.js — Enhanced Universal Indicators
// Crypto + Stocks + Forex + Indices (NSE, US, Global)
// ===================================================

// ---------------------------
// SAFE NUMBER
// ---------------------------
function N(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// ===================================================
// RSI — Smoothed & More Accurate
// ===================================================
export function computeRSI(candles = [], length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 2) return 50;

  let gains = 0, losses = 0;

  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const prev = N(candles[i].close);
    const curr = N(candles[i + 1].close);
    const diff = curr - prev;

    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  if (!gains && !losses) return 50;

  // Avoid div-zero
  const avgGain = gains / length;
  const avgLoss = (losses || 0.000001) / length;

  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

// ===================================================
// ATR — True Range
// ===================================================
export function computeATR(candles = [], length = 14) {
  if (candles.length < length + 1) return 0;

  const trs = [];

  for (let i = candles.length - length; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1] || cur;

    const high = N(cur.high);
    const low = N(cur.low);
    const prevC = N(prev.close);

    trs.push(
      Math.max(
        high - low,
        Math.abs(high - prevC),
        Math.abs(low - prevC)
      )
    );
  }

  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  return Number(atr.toFixed(4));
}

// ===================================================
// EMA — SMA-Initialized (PRO LEVEL)
// ===================================================
function ema(values = [], period = 12) {
  if (values.length < period) return [];

  // SMA start — MUCH more accurate for small datasets
  const sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);
  let prev = sma;
  const out = [];

  for (let i = 0; i < values.length; i++) {
    const v = N(values[i]);
    if (i < period) {
      out.push(sma);
      continue;
    }
    prev = (v * k) + (prev * (1 - k));
    out.push(prev);
  }

  return out;
}

// ===================================================
// MACD — Noise-Reduced Output
// ===================================================
export function computeMACD(candles = []) {
  if (candles.length < 35) return { hist: 0, line: 0, signal: 0 };

  const closes = candles.map(c => N(c.close));

  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = e12.map((v, i) => v - (e26[i] || 0));
  const signal = ema(macdLine, 9);

  const line = macdLine.at(-1) || 0;
  const sig = signal.at(-1) || 0;
  const hist = line - sig;

  return {
    hist: Number(hist.toFixed(6)),
    line: Number(line.toFixed(6)),
    signal: Number(sig.toFixed(6))
  };
}

// ===================================================
// Volume Trend (Safe for Yahoo/NSE null volumes)
// ===================================================
export function volumeTrend(candles = []) {
  if (candles.length < 2) return "STABLE";

  const last = N(candles.at(-1).vol);
  const prev = N(candles.at(-2).vol);

  if (!last || !prev) return "STABLE";

  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

// ===================================================
// Volume Analyzer — More granular
// ===================================================
export function analyzeVolume(candles = []) {
  if (candles.length < 3) return { status: "UNKNOWN", strength: 0 };

  const v1 = N(candles.at(-3).vol);
  const v2 = N(candles.at(-2).vol);
  const v3 = N(candles.at(-1).vol);

  if (v3 > v2 && v2 > v1) return { status: "RISING", strength: 3 };
  if (v3 < v2 && v2 < v1) return { status: "FALLING", strength: -3 };

  if (v3 > v2) return { status: "SLIGHT_UP", strength: 1 };
  if (v3 < v2) return { status: "SLIGHT_DOWN", strength: -1 };

  return { status: "STABLE", strength: 0 };
}

// ===================================================
// Fibonacci Levels — No change (already optimal)
// ===================================================
export function computeFibLevelsFromCandles(candles = []) {
  if (!candles.length) return null;

  const highs = candles.map(c => N(c.high));
  const lows = candles.map(c => N(c.low));

  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const diff = hi - lo;

  return {
    lo,
    hi,
    retrace: {
      "0.236": Number((hi - diff * 0.236).toFixed(6)),
      "0.382": Number((hi - diff * 0.382).toFixed(6)),
      "0.5":   Number((hi - diff * 0.5).toFixed(6)),
      "0.618": Number((hi - diff * 0.618).toFixed(6)),
      "0.786": Number((hi - diff * 0.786).toFixed(6))
    }
  };
}

// ===================================================
// Price Trend — NEW! (Better signals)
// ===================================================
export function computePriceTrend(candles = []) {
  if (candles.length < 4) return "FLAT";

  const c1 = N(candles.at(-4).close);
  const c2 = N(candles.at(-3).close);
  const c3 = N(candles.at(-2).close);
  const c4 = N(candles.at(-1).close);

  if (c4 > c3 && c3 > c2 && c2 > c1) return "UP";
  if (c4 < c3 && c3 < c2 && c2 < c1) return "DOWN";

  return "FLAT";
}

// ===================================================
// deriveSignal — Better weighting
// ===================================================
export function deriveSignal(ind) {
  if (!ind) return "NEUTRAL";

  let score = 0;

  // RSI Weighting
  if (typeof ind.RSI === "number") {
    if (ind.RSI < 30) score += 2;
    if (ind.RSI < 20) score += 1;
    if (ind.RSI > 70) score -= 2;
    if (ind.RSI > 80) score -= 1;
  }

  // MACD
  if (ind.MACD) {
    score += ind.MACD.hist > 0 ? 2 : -2;
  }

  // Price Trend
  if (ind.priceTrend === "UP") score += 1;
  if (ind.priceTrend === "DOWN") score -= 1;

  // Volume confirmation
  if (ind.volumeTrend === "INCREASING") score += 1;
  if (ind.volumeTrend === "DECREASING") score -= 1;

  // Final Signal
  if (score >= 3) return "BUY";
  if (score <= -3) return "SELL";
  return "HOLD";
}