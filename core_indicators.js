// ===============================
// 📊 core_indicators.js
// Multi-timeframe Technical Analysis Module
// ===============================

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calculateRSI(data, period = 14) {
  if (!data || data.length < period) return null;
  const changes = [];
  for (let i = 1; i < data.length; i++) {
    changes.push(data[i].close - data[i - 1].close);
  }

  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) gains += changes[i];
    else losses -= changes[i];
  }

  gains /= period;
  losses /= period;
  const rs = losses === 0 ? 100 : gains / losses;
  const rsi = 100 - 100 / (1 + rs);

  return {
    value: rsi,
    summary: rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral"
  };
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function EMA(data, period) {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  let ema = [];
  let sum = 0;

  for (let i = 0; i < period; i++) sum += data[i].close;
  let prevEma = sum / period;
  ema[period - 1] = prevEma;

  for (let i = period; i < data.length; i++) {
    prevEma = data[i].close * k + prevEma * (1 - k);
    ema.push(prevEma);
  }

  return ema;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(data, fast = 12, slow = 26, signal = 9) {
  if (!data || data.length < slow + signal) return null;

  const emaFast = EMA(data, fast);
  const emaSlow = EMA(data, slow);

  const macdLine = emaFast.map((v, i) => v - emaSlow[i] || 0);
  const signalLine = EMA(macdLine.map(v => ({ close: v })), signal);
  const histogram = macdLine.map((v, i) => v - (signalLine[i] || 0));

  const latest = histogram[histogram.length - 1];
  return {
    macd: macdLine,
    signal: signalLine,
    histogram,
    summary: latest > 0 ? "Bullish" : "Bearish"
  };
}

/**
 * Analyze all indicators for a single timeframe
 */
export function analyzeIndicators(data, tf = "15m") {
  if (!data || data.length < 50) return { ok: false, summary: "NoData" };

  const rsi = calculateRSI(data);
  const macd = calculateMACD(data);

  // Volume analysis
  const lastVolume = data[data.length - 1].volume;
  const avgVolume =
    data.slice(-20).reduce((a, b) => a + b.volume, 0) / Math.min(20, data.length);
  const volSignal = lastVolume > avgVolume * 1.5 ? "HighVolume" : "NormalVolume";

  // Combined decision
  let signals = [rsi?.summary, macd?.summary];
  const bullish = signals.filter(s => s === "Bullish").length;
  const bearish = signals.filter(s => s === "Bearish").length;

  let summary = "Neutral";
  if (bullish > bearish) summary = "Bullish";
  else if (bearish > bullish) summary = "Bearish";

  return {
    ok: true,
    tf,
    rsi,
    macd,
    volume: volSignal,
    summary
  };
}

/**
 * Analyze Multi-Timeframe
 */
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

  const confidence = Math.round(
    (Math.max(bullish, bearish) / (valid.length || 1)) * 100
  );

  return { decision, confidence, tfSummary: results };
}