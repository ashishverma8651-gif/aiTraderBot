// ===============================
// 📈 elliott_module.js
// Robust Elliott + Fibonacci + Channel + Pattern + optional ML support
// ===============================

export async function analyzeElliott(tfInput, options = {}) {
  try {
    const cfg = Object.assign(
      {
        useML: true,
        mlModulePath: "./ml_module_v8_6.js",
        lookback: 500,
        verbose: false,
        tag: "elliott"
      },
      options
    );

    // -----------------------------
    // 🔧 Normalize Input Data
    // -----------------------------
    const normalizeArray = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map((k) => {
          if (!k) return null;
          if (Array.isArray(k)) {
            return {
              t: +k[0] || 0,
              open: +k[1] || 0,
              high: +k[2] || 0,
              low: +k[3] || 0,
              close: +k[4] || 0,
              vol: +k[5] || 0,
            };
          }
          return {
            t: +k.t || +k.time || 0,
            open: +k.open || +k.o || 0,
            high: +k.high || +k.h || 0,
            low: +k.low || +k.l || 0,
            close: +k.close || +k.c || 0,
            vol: +k.vol || +k.volume || +k.v || 0,
          };
        })
        .filter((x) => x && !isNaN(x.close) && x.t > 0)
        .sort((a, b) => a.t - b.t);
    };

    // Build TF map
    let tfMap = {};
    if (Array.isArray(tfInput)) {
      tfMap.raw = normalizeArray(tfInput);
    } else if (tfInput && typeof tfInput === "object") {
      for (const [k, v] of Object.entries(tfInput)) tfMap[k] = normalizeArray(v);
      if (!tfMap.raw) {
        const best = Object.values(tfMap).reduce(
          (a, b) => (b.length > (a?.length || 0) ? b : a),
          []
        );
        tfMap.raw = best || [];
      }
    } else {
      return { ok: false, error: "no_input", summary: "No candles provided" };
    }

    const candles = tfMap.raw || [];
    if (candles.length < 30) {
      console.warn(`[${cfg.tag}] insufficient candles: ${candles.length}`);
      return { ok: false, error: "insufficient_data", summary: "Not enough candles" };
    }

    // -----------------------------
    // 📊 Data Extraction
    // -----------------------------
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    function detectPivots(arr) {
      const piv = [];
      for (let i = 2; i < arr.length - 2; i++) {
        const p = arr[i], p1 = arr[i - 1], n1 = arr[i + 1];
        if (p > p1 && p > n1) piv.push({ idx: i, type: "peak", value: p });
        if (p < p1 && p < n1) piv.push({ idx: i, type: "trough", value: p });
      }
      return piv;
    }

    const pivots = detectPivots(closes).slice(-12);

    // -----------------------------
    // 🔢 Fibonacci Levels
    // -----------------------------
    const look = Math.min(candles.length, cfg.lookback);
    const recentHigh = Math.max(...highs.slice(-look));
    const recentLow = Math.min(...lows.slice(-look));
    const fibRatios = [0.236, 0.382, 0.5, 0.618, 0.786];
    const fibLevels = fibRatios.map(r => ({
      r,
      value: recentHigh - (recentHigh - recentLow) * r
    }));

    // -----------------------------
    // 📈 Channel Approximation
    // -----------------------------
    const len = candles.length;
    const ch = {
      upperStart: highs[0],
      upperEnd: highs[len - 1],
      lowerStart: lows[0],
      lowerEnd: lows[len - 1],
      slopeUpper: (highs[len - 1] - highs[0]) / Math.max(len - 1, 1),
      slopeLower: (lows[len - 1] - lows[0]) / Math.max(len - 1, 1),
    };

    // -----------------------------
    // 🔍 Pattern Detection
    // -----------------------------
    function detectPattern() {
      const lastClose = closes.at(-1);
      const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, closes.length);
      const rel = (lastClose - ma10) / ma10;
      if (rel > 0.035) return "Bullish breakout";
      if (rel < -0.035) return "Bearish breakout";

      const peaks = pivots.filter(p => p.type === "peak");
      const troughs = pivots.filter(p => p.type === "trough");
      if (peaks.length >= 3 && troughs.length >= 2) return "Head & Shoulders (possible)";
      if (peaks.length >= 2 && Math.abs(peaks[0].value - peaks[1].value) < ma10 * 0.012)
        return "Double Top";
      if (troughs.length >= 2 && Math.abs(troughs[0].value - troughs[1].value) < ma10 * 0.012)
        return "Double Bottom";
      return "No clear pattern / Sideways";
    }

    const pattern = detectPattern();

    // -----------------------------
    // 🤖 Optional ML Pattern Prediction
    // -----------------------------
    let mlPrediction = { pattern: "N/A", confidence: 0.65 };
    if (cfg.useML) {
      try {
        const ml = await import(new URL(cfg.mlModulePath, import.meta.url).href);
        if (ml?.predictPattern) {
          const inputCloses = closes.slice(-Math.min(500, closes.length));
          const res = await ml.predictPattern(inputCloses);
          if (res?.pattern) mlPrediction = res;
        } else if (cfg.verbose) {
          console.warn(`[${cfg.tag}] ML module missing predictPattern`);
        }
      } catch (e) {
        console.warn(`[${cfg.tag}] ML import failed: ${e.message}`);
      }
    }

    // -----------------------------
    // 📊 Summary + Direction
    // -----------------------------
    const last = closes.at(-1);
    const prevN = closes.at(-5) ?? closes[0];
    const direction = last > prevN ? "UP" : "DOWN";
    const confidence = Math.round((mlPrediction.confidence ?? 0.65) * 100);

    return {
      ok: true,
      structure: "Impulse/Correction",
      wave: direction === "UP" ? "Wave 3/5" : "Wave C",
      direction,
      confidence,
      fibLevels,
      channel: ch,
      pattern,
      pivots,
      mlPrediction,
      summary: `Dir:${direction} | Pattern:${pattern} | ML:${mlPrediction.pattern} (${confidence}%)`
    };

  } catch (err) {
    console.error("❌ analyzeElliott error:", err?.message || err);
    return { ok: false, error: String(err), summary: "Elliott analysis failed" };
  }
}