// core_indicators.js — Fixed RSI / MACD / ATR (safe + accurate)
// v10.2 — 2025-11-12

export function calculateRSI(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 50;
  const closes = candles.map(c => Number(c.close) || 0);
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  const rsi = 100 - 100 / (1 + rs);
  return Number.isFinite(rsi) ? +rsi.toFixed(2) : 50;
}

// Helper for EMA
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [emaPrev];
  for (let i = period; i < values.length; i++) {
    emaPrev = values[i] * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}

// MACD: difference of 12/26 EMAs and 9 EMA signal line
export function calculateMACD(candles) {
  if (!Array.isArray(candles) || candles.length < 26) return 0;
  const closes = candles.map(c => Number(c.close) || 0);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const diff = ema12.slice(-ema26.length).map((v, i) => v - ema26[i]);
  const signal = ema(diff, 9);
  const macd = diff.at(-1) - (signal.at(-1) || 0);

  return Number.isFinite(macd) ? +macd.toFixed(2) : 0;
}

export function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = Number(candles[i - 1].close);
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return Number.isFinite(atr) ? +atr.toFixed(2) : 0;
}

// Safe wrapper that returns all three
export function getIndicators(candles) {
  try {
    const RSI = calculateRSI(candles);
    const MACD = calculateMACD(candles);
    const ATR = calculateATR(candles);
    return { RSI, MACD, ATR };
  } catch (err) {
    console.error("Indicator calc failed:", err.message);
    return { RSI: 50, MACD: 0, ATR: 0 };
  }
}

export default { calculateRSI, calculateMACD, calculateATR, getIndicators };