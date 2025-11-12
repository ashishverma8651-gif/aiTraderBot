// ================================
// 📁 core_indicators.js — AI Trader v10.0
// Enhanced indicator engine with safe guards + ML integration ready
// ================================

/**
 * ✅ Safe helper to extract closing prices
 */
function getClosePrices(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map(c => Number(c.close))
    .filter(v => !isNaN(v) && v > 0);
}

// ================================
// 📊 RSI (Relative Strength Index)
// ================================
export function calculateRSI(candles, period = 14) {
  const closes = getClosePrices(candles);
  if (closes.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period || 1e-6;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Number(rsi.toFixed(2));
}

// ================================
// 📈 MACD (Moving Average Convergence Divergence)
// ================================
export function calculateMACD(candles, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  const closes = getClosePrices(candles);
  if (closes.length < longPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const emaShort = EMA(closes, shortPeriod);
  const emaLong = EMA(closes, longPeriod);
  const macdLine = emaShort.map((v, i) => v - emaLong[i]);
  const signalLine = EMA(macdLine.slice(longPeriod - shortPeriod), signalPeriod);
  const histogram = macdLine.slice(-1)[0] - signalLine.slice(-1)[0];

  return {
    macd: Number(macdLine.slice(-1)[0].toFixed(2)),
    signal: Number(signalLine.slice(-1)[0].toFixed(2)),
    histogram: Number(histogram.toFixed(2))
  };
}

// ================================
// ⚙️ ATR (Average True Range)
// ================================
export function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return Number(atr.toFixed(2));
}

// ================================
// 🧮 SMA & EMA (helper functions)
// ================================
export function SMA(data, period) {
  if (!Array.isArray(data) || data.length < period) return [];
  const sma = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    sma.push(avg);
  }
  return sma;
}

export function EMA(data, period) {
  if (!Array.isArray(data) || data.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < data.length; i++) {
    ema.push(data[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

// ================================
// 📊 Bollinger Bands
// ================================
export function calculateBollingerBands(candles, period = 20, multiplier = 2) {
  const closes = getClosePrices(candles);
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };

  const middle = SMA(closes, period).slice(-1)[0];
  const slice = closes.slice(-period);
  const stdDev = Math.sqrt(slice.map(v => (v - middle) ** 2).reduce((a, b) => a + b, 0) / period);

  const upper = middle + multiplier * stdDev;
  const lower = middle - multiplier * stdDev;

  return {
    upper: Number(upper.toFixed(2)),
    middle: Number(middle.toFixed(2)),
    lower: Number(lower.toFixed(2))
  };
}

// ================================
// 🧠 Data Preprocessor for ML module
// ================================
export function prepareMLFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return [];
  return candles.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
    rsi: calculateRSI(candles),
    atr: calculateATR(candles),
  }));
}

// ================================
// 🧩 Export all together
// ================================
export default {
  calculateRSI,
  calculateMACD,
  calculateATR,
  SMA,
  EMA,
  calculateBollingerBands,
  prepareMLFeatures
};