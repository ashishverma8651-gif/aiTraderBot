// core_indicators.js
// Named exports: calculateRSI, calculateMACD

export function calculateRSI(klines, period = 14) {
  if (!klines || klines.length < period+1) return null;
  const closes = klines.map(k => k.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  let rs = avgLoss === 0 ? 100 : avgGain/avgLoss;
  let rsi = 100 - (100/(1+rs));
  // simple current RSI approximation (not full SMA)
  return Number(rsi.toFixed(2));
}

export function calculateMACD(klines, fast=12, slow=26, signal=9) {
  // simple MACD using EMA approximate; for speed use close-based EMA
  if (!klines || klines.length < slow) return null;
  const closes = klines.map(k => k.close);
  function ema(values, period) {
    const k = 2/(period+1);
    let emaArr = [];
    let prev = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
    emaArr[period-1] = prev;
    for (let i = period; i<values.length; i++) {
      prev = values[i]*k + prev*(1-k);
      emaArr[i] = prev;
    }
    return emaArr;
  }
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = [];
  for (let i=0;i<closes.length;i++){
    const f = emaFast[i]||0;
    const s = emaSlow[i]||0;
    macdLine[i] = f - s;
  }
  // signal line simple SMA of last `signal` elements of macdLine
  const last = macdLine.slice(-signal).filter(v=>typeof v==="number");
  const sig = last.length ? last.reduce((a,b)=>a+b,0)/last.length : 0;
  const macdValue = macdLine[macdLine.length-1] || 0;
  return { macd: Number(macdValue.toFixed(4)), signal: Number(sig.toFixed(4)) };
}