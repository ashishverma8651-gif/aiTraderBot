// elliott_module.js
// Elliott + Fib + Channel + ML helper (error-free async version)

export async function analyzeElliott(tfInput, options = {}) {
  const cfg = Object.assign(
    { useML: true, mlModulePath: "./ml_module_v8_6.js", lookback: 500, verbose: false },
    options
  );

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

  let tfMap = {};
  if (Array.isArray(tfInput)) tfMap["raw"] = normalize(tfInput);
  else if (tfInput && typeof tfInput === "object")
    for (const [k, v] of Object.entries(tfInput)) tfMap[k] = normalize(v);
  else throw new Error("Invalid Elliott input");

  // dynamic import (no crash if missing)
  let helpers = {};
  try {
    const core = await import("./core_indicators.js");
    helpers.calcRSI = core.calculateRSI || core.calcRSI || null;
    helpers.calcMACD = core.calculateMACD || core.calcMACD || null;
  } catch {
    if (cfg.verbose) console.log("⚠️ core_indicators not found");
  }

  const pct = (a, b) => ((a - b) / b) * 100;
  const round = (v, d = 3) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d;
  const lastN = (arr, n = 20) => arr.slice(-n);

  const findPivots = (s, n = 3) => {
    const highs = [], lows = [];
    for (let i = n; i < s.length - n; i++) {
      const c = s[i].close;
      if (s.slice(i - n, i).every(v => v.close < c) && s.slice(i + 1, i + 1 + n).every(v => v.close < c)) highs.push(i);
      if (s.slice(i - n, i).every(v => v.close > c) && s.slice(i + 1, i + 1 + n).every(v => v.close > c)) lows.push(i);
    }
    return { highs, lows };
  };

  function fibLevels(a, b) {
    return [0, 0.382, 0.5, 0.618, 1].map((r) => ({ r, level: round(a + (b - a) * r, 4) }));
  }

  function detectChannel(series) {
    if (!series?.length) return null;
    const highs = series.map(x => x.high), lows = series.map(x => x.low);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const top = mean(highs), bottom = mean(lows);
    return { width: round(top - bottom, 3), top, bottom };
  }

  async function analyzeSingle(series, tf = "raw") {
    const res = { ok: false, tf, pattern: "Neutral", confidence: 0, wave: {}, fibLevels: [], indicators: {} };
    if (!series?.length) return res;
    res.ok = true;

    const recent = lastN(series, 50);
    const piv = findPivots(recent, 3);
    const waveCount = piv.highs.length + piv.lows.length;
    const first = recent[0].close, last = recent.at(-1).close;
    const changePct = pct(last, first);

    let low = Math.min(...recent.map(x => x.low));
    let high = Math.max(...recent.map(x => x.high));
    res.fibLevels = fibLevels(low, high);
    res.channel = detectChannel(recent);

    if (helpers.calcRSI) {
      const closes = recent.map(c => c.close);
      res.indicators.rsi = helpers.calcRSI(closes, 14);
    }
    if (helpers.calcMACD) {
      const closes = recent.map(c => c.close);
      res.indicators.macd = helpers.calcMACD(closes);
    }

    let pattern = "Neutral";
    if (changePct > 1 && waveCount >= 3) pattern = "Bullish Impulse";
    else if (changePct < -1 && waveCount >= 3) pattern = "Bearish Impulse";
    else if (waveCount >= 5) pattern = "Complex Wave";

    const confidence = round(Math.min(100, Math.abs(changePct) * 2 + waveCount * 10), 2);
    res.pattern = pattern;
    res.confidence = confidence;
    res.wave = { waveCount, changePct: round(changePct, 3) };
    return res;
  }

  const tfSummary = {};
  for (const [tf, data] of Object.entries(tfMap)) tfSummary[tf] = await analyzeSingle(data, tf);

  // Combine multi-TF results
  const valid = Object.values(tfSummary).filter(r => r.ok);
  const avgConf = valid.reduce((a, b) => a + b.confidence, 0) / (valid.length || 1);
  let decision = "Neutral";
  const ups = valid.filter(v => /Bullish/.test(v.pattern)).length;
  const downs = valid.filter(v => /Bearish/.test(v.pattern)).length;
  if (ups > downs) decision = "Bullish";
  else if (downs > ups) decision = "Bearish";

  // Optional ML support
  let mlResult = { prediction: null, score: 0 };
  if (cfg.useML) {
    try {
      const ml = await import(cfg.mlModulePath);
      if (ml?.runMLPrediction) mlResult = await ml.runMLPrediction(tfMap);
    } catch {
      if (cfg.verbose) console.log("⚠️ ML module not found, skipping");
    }
  }

  return {
    decision,
    confidence: round(avgConf, 2),
    tfSummary,
    ml: mlResult,
    timestamp: Date.now(),
  };
}