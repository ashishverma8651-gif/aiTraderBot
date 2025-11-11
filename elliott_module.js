// elliott_module.js
// Async Elliott / Fib / Channel + ML helper (multi-timeframe, multi-market)
// Designed to be robust: dynamic imports for optional helpers (core_indicators, ml module).
// Exports: analyzeElliott (async)

export async function analyzeElliott(tfInput, options = {}) {
  // tfInput: either
  //  - an array of candles: [{ t, open, high, low, close, vol }, ...]  // single TF
  //  - OR an object map: { "1m": [...], "15m": [...], "1h": [...] }    // multi-TF
  //
  // options: { useML: true/false, mlModulePath: "./ml_module_v8_6.js", lookback: 500, verbose: false }
  const cfg = Object.assign(
    { useML: true, mlModulePath: "./ml_module_v8_6.js", lookback: 500, verbose: false },
    options
  );

  // Helper to normalize candle arrays (ensure fields and numbers)
  const normalize = (arr) =>
    Array.isArray(arr)
      ? arr
          .filter(Boolean)
          .map((k) => ({
            t: Number(k.t ?? k[0]),
            open: Number(k.open ?? k[1]),
            high: Number(k.high ?? k[2]),
            low: Number(k.low ?? k[3]),
            close: Number(k.close ?? k[4]),
            vol: Number(k.vol ?? k[5] ?? 0),
          }))
          .sort((a, b) => a.t - b.t)
      : [];

  // Build tfMap
  let tfMap = {};
  if (Array.isArray(tfInput)) {
    tfMap["raw"] = normalize(tfInput);
  } else if (tfInput && typeof tfInput === "object") {
    for (const [k, v] of Object.entries(tfInput)) tfMap[k] = normalize(v);
  } else {
    throw new Error("analyzeElliott: invalid input tfInput");
  }

  // Try to load indicator helpers (optional) dynamically.
  let helpers = {};
  try {
    const core = await import("./core_indicators.js");
    // safe aliases (function names may differ; we check availability)
    helpers.calcRSI = core.calculateRSI || core.calcRSI || core.rsi || null;
    helpers.calcMACD = core.calculateMACD || core.calcMACD || core.calcMacd || null;
    helpers.sma = core.sma || core.SMA || null;
  } catch (e) {
    // Not fatal — we'll proceed without these helpers
    if (cfg.verbose) console.warn("analyzeElliott: core_indicators not found or failed import:", e.message);
  }

  // Small utility functions
  const lastN = (arr, n = 20) => (arr && arr.length ? arr.slice(Math.max(0, arr.length - n)) : []);
  const pct = (a, b) => ((a - b) / b) * 100;
  const round = (v, d = 3) => Math.round((v + Number.EPSILON) * Math.pow(10, d)) / Math.pow(10, d);

  // Basic wave detection heuristic:
  // - Find local highs/lows (simple pivot detection)
  function findPivots(series, lookback = 3) {
    const highs = [], lows = [];
    for (let i = lookback; i < series.length - lookback; i++) {
      const c = series[i].close;
      const left = series.slice(i - lookback, i).map(x => x.close);
      const right = series.slice(i + 1, i + 1 + lookback).map(x => x.close);
      if (left.every(v => v < c) && right.every(v => v < c)) highs.push({ idx: i, t: series[i].t, price: c });
      if (left.every(v => v > c) && right.every(v => v > c)) lows.push({ idx: i, t: series[i].t, price: c });
    }
    return { highs, lows };
  }

  // Fibonacci level generator between two prices
  function fibLevels(a, b) {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map(r => ({
      ratio: r,
      level: round(a + (b - a) * r, 6),
    }));
    return levels;
  }

  // Channel detection (simple linear regression on high and low)
  function detectChannel(series) {
    if (!series || series.length < 10) return null;
    const n = series.length;
    // compute simple linear fits for highs and lows using least squares (time index as x)
    const xs = series.map((s, i) => i);
    const fit = (vals) => {
      const xbar = (n - 1) / 2;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - xbar) * (vals[i] - (vals.reduce((a, b) => a + b, 0) / n));
        den += (xs[i] - xbar) * (xs[i] - xbar);
      }
      const slope = den === 0 ? 0 : num / den;
      const intercept = (vals.reduce((a, b) => a + b, 0) / n) - slope * xbar;
      return { slope, intercept };
    };
    const highs = series.map(s => s.high), lows = series.map(s => s.low);
    const top = fit(highs), bottom = fit(lows);
    return { top, bottom, width: Math.abs(top.intercept - bottom.intercept) };
  }

  // Core single-TF analysis: indicators + wave heuristics
  function analyzeSingle(series, tfName = "raw") {
    const res = { ok: false, tf: tfName, summary: "No data", pattern: null, confidence: 0, wave: null, fibLevels: [], channel: null, indicators: {} };
    if (!series || series.length < 6) return res;
    res.ok = true;

    // Basic price action
    const recent = lastN(series, 50); // lookback for structure
    const first = recent[0].close, last = recent[recent.length - 1].close;
    const change = last - first;
    const changePct = pct(last, first);

    // Pivots
    const piv = findPivots(recent, 3);
    // Rough wave count: number of alternating pivots (high->low->high->low)
    const waveCount = Math.max(0, (piv.highs.length + piv.lows.length) - 1);

    // Fibonacci: from last major low to last major high (if available)
    let majorLow = null, majorHigh = null;
    if (piv.lows.length) majorLow = piv.lows[piv.lows.length - 1].price;
    if (piv.highs.length) majorHigh = piv.highs[piv.highs.length - 1].price;
    if (!majorLow && !majorHigh) {
      // fallback: use min/max of recent
      majorLow = Math.min(...recent.map(r => r.low));
      majorHigh = Math.max(...recent.map(r => r.high));
    }
    res.fibLevels = fibLevels(majorLow, majorHigh);

    // Channel
    res.channel = detectChannel(recent);

    // Indicators (optional)
    try {
      if (helpers.calcRSI) {
        const closes = recent.map(x => x.close);
        res.indicators.rsi = await Promise.resolve(helpers.calcRSI(closes, 14));
      }
      if (helpers.calcMACD) {
        const closes = recent.map(x => x.close);
        res.indicators.macd = await Promise.resolve(helpers.calcMACD(closes));
      }
    } catch (e) {
      if (cfg.verbose) console.warn("analyzeSingle: indicator helper failed", e.message);
    }

    // Decide pattern label using heuristics
    let pattern = "Neutral";
    if (changePct > 1.2 && waveCount >= 3) pattern = "Impulse-up";
    else if (changePct < -1.2 && waveCount >= 3) pattern = "Impulse-down";
    else if (Math.abs(changePct) < 0.4 && waveCount <= 1) pattern = "Range";
    else if (waveCount >= 4) pattern = changePct > 0 ? "W4-W5 forming (up)" : "W4-W5 forming (down)";

    // Confidence heuristic: combine pivot count, channel width and change magnitude
    const pivotScore = Math.min(1, waveCount / 6);
    const moveScore = Math.min(1, Math.abs(changePct) / 5);
    const channelScore = res.channel ? Math.min(1, Math.abs(res.channel.width) / Math.max(1, Math.abs(last))) : 0.2;
    const baseConfidence = round((pivotScore * 0.5 + moveScore * 0.3 + channelScore * 0.2) * 100, 2);

    res.pattern = pattern;
    res.confidence = baseConfidence;
    res.wave = { count: waveCount, lastHigh: majorHigh, lastLow: majorLow, changePct: round(changePct, 4) };

    // extra summary
    res.summary = `${pattern} | ${res.wave.count} pivots | ${res.confidence}%`;

    return res;
  }

  // Run analysis across TFs
  const tfSummary = {};
  for (const [tf, series] of Object.entries(tfMap)) {
    tfSummary[tf] = analyzeSingle(series, tf);
  }

  // Aggregate decision across TFs (simple voting)
  const valid = Object.values(tfSummary).filter(r => r.ok);
  let decision = "Neutral";
  if (valid.length) {
    const bullish = valid.filter(v => /up|Impulse|W4-W5|forming/i.test(v.pattern)).length;
    const bearish = valid.filter(v => /down|Corrective|Correction|Impulse-down/i.test(v.pattern)).length;
    if (bullish > bearish) decision = "Bullish";
    else if (bearish > bullish) decision = "Bearish";
    // confidence aggregate
  }
  const confidence = Math.round((valid.reduce((s, v) => s + (v.confidence || 0), 0) / (valid.length || 1)) * 100) / 100;

  // Optional ML integration (dynamic import), catch gracefully if missing
  let mlResult = { available: false, prediction: null, score: 0 };
  if (cfg.useML) {
    try {
      const ml = await import(cfg.mlModulePath);
      // runMLPrediction should accept: (tfMap, options) and return { pred: 'Buy'|'Sell'|'Neutral', prob: 0.xx }
      if (typeof ml.runMLPrediction === "function") {
        const mlOut = await ml.runMLPrediction(tfMap, { lookback: cfg.lookback });
        if (mlOut) {
          mlResult.available = true;
          mlResult.prediction = mlOut.pred || mlOut.label || mlOut.prediction || null;
          mlResult.score = mlOut.prob || mlOut.score || mlOut.confidence || 0;
        }
      } else if (typeof ml.default === "function") {
        // support default export function
        const mlOut = await ml.default(tfMap, { lookback: cfg.lookback });
        if (mlOut) {
          mlResult.available = true;
          mlResult.prediction = mlOut.pred || mlOut.label || mlOut.prediction || null;
          mlResult.score = mlOut.prob || mlOut.score || mlOut.confidence || 0;
        }
      }
    } catch (e) {
      if (cfg.verbose) console.warn("analyzeElliott: ML import failed (optional):", e.message);
      mlResult = { available: false, error: e.message };
    }
  }

  // Add recommended TP/SL roughs if user asked for bias-specific TP
  // Here we compute simple TP1/TP2/SL estimates based on fibLevels of main TF (prefer '15m' then any)
  const preferTFs = ["15m", "1h", "raw"];
  let main = valid.length ? valid[0] : null;
  for (const p of preferTFs) if (tfSummary[p] && tfSummary[p].ok) { main = tfSummary[p]; break; }
  let recommendations = { TP1: null, TP2: null, SL: null, breakoutZone: null };
  if (main && main.fibLevels && main.fibLevels.length) {
    const fibs = main.fibLevels;
    // choose TP levels on impulse direction
    const dir = /up|Impulse|Bullish/i.test(main.pattern) ? 1 : -1;
    if (dir === 1) {
      recommendations.TP1 = fibs[3].level; // 0.5
      recommendations.TP2 = fibs[4].level; // 0.618
      recommendations.SL = main.wave.lastLow ? round(main.wave.lastLow * 0.999, 6) : round(main.wave.lastLow || fibs[0].level, 6);
    } else {
      recommendations.TP1 = fibs[3].level; // 0.5
      recommendations.TP2 = fibs[2].level; // 0.382 (for downward)
      recommendations.SL = main.wave.lastHigh ? round(main.wave.lastHigh * 1.001, 6) : round(main.wave.lastHigh || fibs[fibs.length - 1].level, 6);
    }
    recommendations.breakoutZone = [fibs[1].level, fibs[5].level];
  }

  // Final composed result
  const result = {
    decision,
    confidence: round(confidence, 2),
    tfSummary,
    recommendations,
    ml: mlResult,
    timestamp: Date.now(),
    note: "Elliott-module v9 compatible; uses dynamic ML/core imports if available",
  };

  return result;
}