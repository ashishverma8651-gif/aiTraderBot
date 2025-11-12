// core_indicators.js
// Self-contained indicator library for AI Trader v10+
// - No external dependencies
// - Exports names used by aiTraderBot: calculateRSI, calculateMACD, analyzeIndicators, analyzeMultiTF
// - ML helper: getMLFeatures
// - Safe for missing/partial candles (returns null-safe results)

// ---------- Helpers ----------
function safeClosesFromData(data) {
  if (!Array.isArray(data)) return null;
  // accept array of numbers or array of candle objects
  if (data.length === 0) return null;
  if (typeof data[0] === "number") return data.filter(x => Number.isFinite(x));
  return data
    .map((c) => {
      if (!c) return null;
      if (typeof c.close === "number") return c.close;
      if (typeof c.c === "number") return c.c;
      // try string -> number
      const n = Number(c.close ?? c.c ?? c.price ?? null);
      return Number.isFinite(n) ? n : null;
    })
    .filter((x) => Number.isFinite(x));
}

function safeArray(x, min = 2) {
  return Array.isArray(x) && x.length >= min;
}

function round(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// EMA for numeric arrays (returns full ema array aligned to input end)
function EMA(values, period) {
  if (!safeArray(values, period)) return [];
  const k = 2 / (period + 1);
  const out = [];
  // seed with SMA of first period
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  // return compacted array (only defined entries)
  return out.slice(period - 1);
}

// ---------- RSI ----------
export function calculateRSI(dataOrCloses, period = 14) {
  const closes = safeClosesFromData(dataOrCloses);
  if (!safeArray(closes, period + 1)) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

  let gains = 0,
    losses = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c >= 0) gains += c;
    else losses += -c;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? -c : 0)) / period;
  }

  if (avgLoss === 0) return { value: 100, summary: "Overbought" };

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  const summary = rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral";
  return { value: round(rsi, 2), summary };
}

// ---------- MACD ----------
export function calculateMACD(dataOrCloses, fast = 12, slow = 26, signal = 9) {
  const closes = safeClosesFromData(dataOrCloses);
  if (!safeArray(closes, slow + signal)) return null;

  // compute EMAs aligned to input length
  const emaFastFull = EMA(closes, fast); // length: closes.length - (fast-1)
  const emaSlowFull = EMA(closes, slow); // length: closes.length - (slow-1)
  if (!emaFastFull.length || !emaSlowFull.length) return null;

  // align: emaFastFull is shorter offset than emaSlowFull if fast < slow. We want macd array aligned from the later index.
  // Simpler: regenerate arrays to aligned indexes by indexing from end.
  const macdArray = [];
  // macd index corresponds to positions where both EMAs exist; those start from index = (slow - 1)
  const startIndex = Math.max(emaFastFull.length, emaSlowFull.length) ? Math.max(emaFastFull.length, emaSlowFull.length) : 0;
  // build macd by aligning from the end of the input
  const len = Math.min(emaFastFull.length, emaSlowFull.length);
  // easiest: compute macd by computing fastEMA and slowEMA at each possible index from (slow-1) to end using simple running calculation:
  // Build full arrays of length closes.length with undefined until their starting point, but EMA() returned with index offset = period -1
  const fastStart = fast - 1;
  const slowStart = slow - 1;
  const fullFast = new Array(closes.length).fill(undefined);
  const fullSlow = new Array(closes.length).fill(undefined);
  // put values
  for (let i = 0; i < emaFastFull.length; i++) fullFast[i + fastStart] = emaFastFull[i];
  for (let i = 0; i < emaSlowFull.length; i++) fullSlow[i + slowStart] = emaSlowFull[i];

  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fullFast[i];
    const s = fullSlow[i];
    if (f !== undefined && s !== undefined) macdLine.push(f - s);
  }
  if (!macdLine.length) return null;

  // signal line = EMA of macdLine
  const signalArr = EMA(macdLine, signal);
  // histogram = macd - signal (aligned)
  const histogram = [];
  const offset = macdLine.length - signalArr.length;
  for (let i = 0; i < signalArr.length; i++) {
    const m = macdLine[i + offset];
    const sig = signalArr[i];
    histogram.push(m - sig);
  }

  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalArr[signalArr.length - 1] ?? null;
  const latestHist = histogram[histogram.length - 1] ?? null;

  return {
    macd: round(latestMacd, 4),
    signal: latestSignal !== null ? round(latestSignal, 4) : null,
    histogram: latestHist !== null ? round(latestHist, 4) : null,
    macdLine,
    signalLine: signalArr,
    histogramLine: histogram,
    summary: (latestHist || 0) > 0 ? "Bullish" : "Bearish"
  };
}

// ---------- ATR (simple) ----------
export function calculateATR(candleArray, period = 14) {
  if (!Array.isArray(candleArray) || candleArray.length < period + 1) return null;
  try {
    const highs = candleArray.map((c) => Number(c.high ?? c.h ?? 0));
    const lows = candleArray.map((c) => Number(c.low ?? c.l ?? 0));
    const closes = candleArray.map((c) => Number(c.close ?? c.c ?? 0));
    const trs = [];
    for (let i = 1; i < candleArray.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    if (trs.length < period) return null;
    // simple SMA over last `period` TRs
    const last = trs.slice(-period);
    const atr = last.reduce((a, b) => a + b, 0) / last.length;
    return round(atr, 4);
  } catch (e) {
    return null;
  }
}

// ---------- Bollinger-ish band width (simple) ----------
export function calculateBollingerWidth(closesOrData, period = 20) {
  const closes = safeClosesFromData(closesOrData);
  if (!safeArray(closes, period)) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length;
  const std = Math.sqrt(variance);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  return { upper: round(upper, 2), lower: round(lower, 2), width: round(upper - lower, 2) };
}

// ---------- Momentum ----------
export function calculateMomentum(closesOrData, period = 10) {
  const closes = safeClosesFromData(closesOrData);
  if (!safeArray(closes, period + 1)) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 1 - period];
  return round((last - prev) / prev * 100, 3); // percent momentum
}

// ---------- analyzeIndicators (single timeframe) ----------
export function analyzeIndicators(data, tf = "15m") {
  // data expected as array of candles (objects)
  if (!Array.isArray(data) || data.length < 5) return { ok: false, summary: "NoData" };
  try {
    const closes = safeClosesFromData(data);
    const highs = data.map((d) => Number(d.high ?? d.h ?? 0));
    const lows = data.map((d) => Number(d.low ?? d.l ?? 0));
    const rsiObj = calculateRSI(closes);
    const macdObj = calculateMACD(closes);
    const atr = calculateATR(data);
    const bb = calculateBollingerWidth(closes);
    const mom = calculateMomentum(closes);

    const rsiSummary = rsiObj ? rsiObj.summary : "Neutral";
    const macdSummary = macdObj ? macdObj.summary : "Neutral";

    const bullish = (rsiSummary === "Oversold" ? 0 : rsiSummary === "Overbought" ? -1 : 0) + (macdSummary === "Bullish" ? 1 : -1);
    let summary = "Neutral";
    if (bullish > 0) summary = "Bullish";
    else if (bullish < 0) summary = "Bearish";

    const vol = (data[data.length - 1].vol ?? data[data.length - 1].volume ?? 0) || 0;

    return {
      ok: true,
      tf,
      rsi: rsiObj,
      macd: macdObj,
      atr,
      bb,
      momentum: mom,
      volume: vol,
      summary
    };
  } catch (e) {
    return { ok: false, summary: "Error", error: String(e) };
  }
}

// ---------- analyzeMultiTF ----------
export function analyzeMultiTF(tfDataMap) {
  const results = {};
  for (const [tf, d] of Object.entries(tfDataMap || {})) {
    results[tf] = analyzeIndicators(d, tf);
  }
  const valid = Object.values(results).filter((r) => r.ok);
  const bullish = valid.filter((v) => v.summary === "Bullish").length;
  const bearish = valid.filter((v) => v.summary === "Bearish").length;
  let decision = "Neutral";
  if (bullish > bearish) decision = "Bullish";
  else if (bearish > bullish) decision = "Bearish";
  const confidence = Math.round((Math.max(bullish, bearish) / (valid.length || 1)) * 100);
  return { decision, confidence, tfSummary: results };
}

// ---------- ML Feature vector (normalized) ----------
export function getMLFeatures(candleArray, opts = {}) {
  // returns object normalized between 0..1
  // TODO: later: use rolling min/max for dynamic scaling
  if (!Array.isArray(candleArray) || candleArray.length < 5) return null;
  const closes = safeClosesFromData(candleArray);
  const highs = candleArray.map((c) => Number(c.high ?? c.h ?? 0));
  const lows = candleArray.map((c) => Number(c.low ?? c.l ?? 0));

  const rsiObj = calculateRSI(closes);
  const macdObj = calculateMACD(closes);
  const atr = calculateATR(candleArray);
  const bb = calculateBollingerWidth(closes);
  const mom = calculateMomentum(closes);
  const last = closes[closes.length - 1] ?? 0;
  const minC = Math.min(...closes);
  const maxC = Math.max(...closes);

  const normalize = (v, lo, hi) => {
    if (v === null || v === undefined || Number.isNaN(v)) return 0.5;
    if (hi === lo) return 0.5;
    return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  };

  return {
    rsi: normalize(rsiObj?.value ?? null, 0, 100),
    macd: normalize(macdObj?.macd ?? 0, -Math.abs(maxC - minC), Math.abs(maxC - minC)),
    signal: normalize(macdObj?.signal ?? 0, -Math.abs(maxC - minC), Math.abs(maxC - minC)),
    atr: normalize(atr ?? 0, 0, Math.max(1, (maxC - minC) * 0.1)),
    bbWidth: normalize(bb?.width ?? 0, 0, Math.max(1, (maxC - minC) * 0.2)),
    momentum: normalize(mom ?? 0, -100, 100),
    pricePos: normalize(last, minC, maxC)
  };
}

// ---------- default export ----------
export default {
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateMomentum,
  calculateBollingerWidth,
  analyzeIndicators,
  analyzeMultiTF,
  getMLFeatures
};