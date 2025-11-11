// elliott_module.js
// Robust Elliott + Fib + Channel + Pattern + optional ML helper
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

    // ---- Normalizer: accepts array-of-arrays OR array-of-objects ----
    const normalizeArray = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map((k) => {
          if (!k) return null;
          // if k is array-like (binance raw)
          if (Array.isArray(k)) {
            // [t, open, high, low, close, vol,...]
            return {
              t: Number(k[0] ?? 0),
              open: Number(k[1] ?? 0),
              high: Number(k[2] ?? 0),
              low: Number(k[3] ?? 0),
              close: Number(k[4] ?? 0),
              vol: Number(k[5] ?? 0),
            };
          }
          // else assume object with named fields
          return {
            t: Number(k.t ?? k.time ?? 0),
            open: Number(k.open ?? k.o ?? 0),
            high: Number(k.high ?? k.h ?? 0),
            low: Number(k.low ?? k.l ?? 0),
            close: Number(k.close ?? k.c ?? 0),
            vol: Number(k.vol ?? k.volume ?? k.v ?? 0),
          };
        })
        .filter((x) => x && !Number.isNaN(x.close) && x.t > 0)
        .sort((a, b) => a.t - b.t);
    };

    // ---- Build timeframe map (supports single array or object map) ----
    let tfMap = {};
    if (Array.isArray(tfInput)) {
      tfMap["raw"] = normalizeArray(tfInput);
    } else if (tfInput && typeof tfInput === "object") {
      // if object with keys like { "15m": [...], "1h": [...] }
      for (const [k, v] of Object.entries(tfInput)) {
        tfMap[k] = normalizeArray(v);
      }
      // ensure there's at least some data in "raw"
      if (!tfMap.raw) {
        // pick longest series as raw fallback
        const best = Object.values(tfMap).reduce((a, b) => (b.length > (a?.length||0) ? b : a), []);
        tfMap.raw = best || [];
      }
    } else {
      return { error: "No input data", summary: "No candles provided" };
    }

    const candles = tfMap.raw || [];
    if (!candles || candles.length < 30) {
      // too small to analyze reliably
      console.warn(`[${cfg.tag}] insufficient candles: ${candles.length}`);
      return { error: "insufficient_data", summary: "Not enough candles", candlesLength: candles.length };
    }

    // ---- helpers ----
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    function detectPivots(arr) {
      const piv = [];
      for (let i = 2; i < arr.length - 2; i++) {
        const p = arr[i], p1 = arr[i-1], n1 = arr[i+1];
        if (p > p1 && p > n1) piv.push({ idx: i, type: "peak", value: arr[i] });
        if (p < p1 && p < n1) piv.push({ idx: i, type: "trough", value: arr[i] });
      }
      return piv;
    }

    // simplified wave detection: recent pivots (non-perfect but useful)
    const pivots = detectPivots(closes).slice(-12);

    // Fibonacci on recent swing
    const look = Math.min(candles.length, cfg.lookback || 200);
    const recentHigh = Math.max(...highs.slice(-look));
    const recentLow = Math.min(...lows.slice(-look));
    const fibRatios = [0.236,0.382,0.5,0.618,0.786];
    const fibLevels = fibRatios.map(r => ({ r, value: recentHigh - (recentHigh - recentLow) * r }));

    // channel: quick linear approx using first and last highs/lows
    const len = candles.length;
    const ch = {
      upperStart: highs[0],
      upperEnd: highs[len-1],
      lowerStart: lows[0],
      lowerEnd: lows[len-1],
      slopeUpper: (highs[len-1] - highs[0]) / Math.max(len-1,1),
      slopeLower: (lows[len-1] - lows[0]) / Math.max(len-1,1),
    };

    // pattern detection: simple heuristics
    function detectPattern() {
      const lastClose = closes[closes.length-1];
      const ma10 = closes.slice(-10).reduce((a,b)=>a+b,0)/Math.min(10,closes.length);
      const rel = (lastClose - ma10)/ma10;
      if (rel > 0.035) return "Bullish breakout";
      if (rel < -0.035) return "Bearish breakout";

      const peaks = pivots.filter(p => p.type === "peak");
      const troughs = pivots.filter(p => p.type === "trough");
      if (peaks.length >= 3 && troughs.length >= 2) return "Head & Shoulders (possible)";
      if (peaks.length >= 2 && Math.abs(peaks[0].value - peaks[1].value) < ma10*0.012) return "Double Top";
      if (troughs.length >= 2 && Math.abs(troughs[0].value - troughs[1].value) < ma10*0.012) return "Double Bottom";
      return "No clear pattern / Sideways";
    }

    const pattern = detectPattern();

    // ML fallback (optional & safe)
    let mlPrediction = { pattern: null, confidence: 0 };
    if (cfg.useML) {
      try {
        const ml = await import(cfg.mlModulePath);
        if (ml && typeof ml.predictPattern === "function") {
          // pass last N closes
          const inputCloses = closes.slice(-Math.min(500, closes.length));
          const res = await ml.predictPattern(inputCloses);
          if (res) mlPrediction = res;
        } else {
          if (cfg.verbose) console.warn(`[${cfg.tag}] ML module missing predictPattern`);
        }
      } catch (e) {
        console.warn(`[${cfg.tag}] ML import failed: ${e.message}`);
      }
    }

    // decision summary
    const last = closes[closes.length-1], prevN = closes[closes.length-5] ?? closes[0];
    const direction = last > prevN ? "UP" : "DOWN";
    const confidence = Math.round((mlPrediction.confidence ?? 0.65) * 100);

    return {
      ok: true,
      summary: `Dir:${direction} | Pattern:${pattern} | ML:${mlPrediction.pattern ?? "N/A"}(${confidence}%)`,
      direction,
      confidence,
      pivots,
      fibLevels,
      channel: ch,
      pattern,
      mlPrediction
    };

  } catch (err) {
    console.error("analyzeElliott error:", err && err.message ? err.message : err);
    return { ok: false, error: String(err), summary: "Elliott analysis failed" };
  }
}