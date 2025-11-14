// core_indicators.js — RSI, ATR, MACD, volume, fibs, deriveSignal
export function computeRSI(candles = [], length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const a = candles[i+1], b = candles[i];
    const diff = (Number(a.close)||0) - (Number(b.close)||0);
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50;
  const avgGain = gains / length;
  const avgLoss = (losses || 0.000001) / length;
  const rs = avgGain / avgLoss;
  return Number((100 - 100/(1+rs)).toFixed(2));
}

export function computeATR(candles = [], length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 0;
  const trs = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i-1] ?? cur;
    const high = Number(cur.high||0), low = Number(cur.low||0), prevC = Number(prev.close||0);
    const tr = Math.max(high - low, Math.abs(high - prevC), Math.abs(low - prevC));
    trs.push(tr);
  }
  const atr = trs.reduce((a,b)=>a+b,0)/trs.length;
  return Number(atr.toFixed(2));
}

function ema(values = [], period = 12) {
  if (!Array.isArray(values) || !values.length) return [];
  const k = 2/(period+1);
  let prev = values[0];
  const out = [];
  for (const v of values) { prev = v*k + prev*(1-k); out.push(prev); }
  return out;
}

export function computeMACD(candles = []) {
  if (!Array.isArray(candles) || candles.length < 35) return { hist: 0, line: 0, signal:0 };
  const closes = candles.map(c => Number(c.close||0));
  const e12 = ema(closes,12);
  const e26 = ema(closes,26);
  const macdLine = e12.map((v,i)=> v - (e26[i]||0));
  const signal = ema(macdLine, 9);
  const hist = (macdLine.at(-1)||0) - (signal.at(-1)||0);
  return {
    hist: Number(hist.toFixed(6)),
    line: Number((macdLine.at(-1)||0).toFixed(6)),
    signal: Number((signal.at(-1)||0).toFixed(6))
  };
}

export function volumeTrend(candles=[]) {
  if (!Array.isArray(candles) || candles.length<2) return "STABLE";
  const last = Number(candles.at(-1).vol||0);
  const prev = Number(candles.at(-2).vol||0);
  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

// small volume analyzer used by tg
export function analyzeVolume(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return { status:"UNKNOWN", strength:0 };
  const v1 = Number(candles.at(-3).vol||0), v2 = Number(candles.at(-2).vol||0), v3 = Number(candles.at(-1).vol||0);
  if (v3>v2 && v2>v1) return {status:"RISING", strength:3};
  if (v3<v2 && v2<v1) return {status:"FALLING", strength:-3};
  if (v3>v2) return {status:"SLIGHT_UP", strength:1};
  if (v3<v2) return {status:"SLIGHT_DOWN", strength:-1};
  return {status:"STABLE", strength:0};
}

export function computeFibLevelsFromCandles(candles=[]) {
  if (!Array.isArray(candles) || candles.length===0) return null;
  const highs = candles.map(c=>Number(c.high||0));
  const lows = candles.map(c=>Number(c.low||0));
  const hi = Math.max(...highs), lo = Math.min(...lows);
  const diff = hi-lo;
  return {
    lo, hi,
    retrace: {
      "0.236": Number((hi - diff*0.236).toFixed(6)),
      "0.382": Number((hi - diff*0.382).toFixed(6)),
      "0.5": Number((hi - diff*0.5).toFixed(6)),
      "0.618": Number((hi - diff*0.618).toFixed(6)),
      "0.786": Number((hi - diff*0.786).toFixed(6))
    }
  };
}

// derive signal (quick heuristic)
export function deriveSignal(indicators) {
  if (!indicators) return "NEUTRAL";
  let score = 0;
  if (typeof indicators.RSI === "number") {
    if (indicators.RSI < 30) score += 1;
    if (indicators.RSI > 70) score -= 1;
  }
  if (indicators.MACD && typeof indicators.MACD.hist === "number") {
    score += indicators.MACD.hist > 0 ? 1 : (indicators.MACD.hist < 0 ? -1 : 0);
  }
  if (indicators.priceTrend === "UP") score += 1;
  if (indicators.priceTrend === "DOWN") score -= 1;
  if (indicators.volumeTrend === "INCREASING") score += 1;
  if (score >= 2) return "BUY";
  if (score <= -2) return "SELL";
  return "HOLD";
}