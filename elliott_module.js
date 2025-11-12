// elliott_module_v3.js
// Elliott v3 — Elliott + Fib + Channel + Harmonic + ML-hybrid
// ES module. Usage: import { analyzeElliottV3 } from './elliott_module_v3.js';

import CONFIG from "./config.js"; // expects CONFIG.ML.MODULE_PATH etc.

// ----------------------------
// Helpers / Normalizers
// ----------------------------
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCandles(input) {
  // Accepts array-of-arrays (binance), array-of-objects, or object map of timeframes
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((c, i) => {
        if (!c) return null;
        if (Array.isArray(c)) {
          return {
            t: toNumber(c[0], Date.now()),
            open: toNumber(c[1]),
            high: toNumber(c[2]),
            low: toNumber(c[3]),
            close: toNumber(c[4]),
            vol: toNumber(c[5] ?? 0),
          };
        }
        return {
          t: toNumber(c.t ?? c.time ?? c.timestamp ?? Date.now()),
          open: toNumber(c.open ?? c.o ?? c.O ?? 0),
          high: toNumber(c.high ?? c.h ?? c.H ?? 0),
          low: toNumber(c.low ?? c.l ?? c.L ?? 0),
          close: toNumber(c.close ?? c.c ?? c.C ?? NaN),
          vol: toNumber(c.vol ?? c.v ?? c.volume ?? 0),
        };
      })
      .filter(Boolean)
      .filter((x) => !Number.isNaN(x.close))
      .sort((a, b) => a.t - b.t);
  }

  if (typeof input === "object") {
    // pick best timeframe if it's a map
    if (Object.keys(input).some(k => Array.isArray(input[k]))) {
      // choose 15m if present, else longest
      const prefer = ["15m", "1h", "30m", "5m", "1m"];
      for (const p of prefer) {
        if (Array.isArray(input[p]) && input[p].length) return normalizeCandles(input[p]);
      }
      // fallback: longest array
      const best = Object.values(input).reduce((a, b) => (Array.isArray(b) && b.length > (a?.length || 0) ? b : a), []);
      return normalizeCandles(best || []);
    }
  }
  return [];
}

// ----------------------------
// Pivot / Swing detection
// ----------------------------
function detectPivots(candles, left = 3, right = 3) {
  // returns array of pivots: { idx, t, price, type: 'H'|'L' }
  const res = [];
  for (let i = left; i < candles.length - right; i++) {
    const cur = candles[i];
    const leftSlice = candles.slice(i - left, i).map(c => c.close);
    const rightSlice = candles.slice(i + 1, i + 1 + right).map(c => c.close);
    const isPeak = cur.high >= Math.max(...leftSlice, cur.high, ...rightSlice);
    const isTrough = cur.low <= Math.min(...leftSlice, cur.low, ...rightSlice);
    if (isPeak) res.push({ idx: i, t: cur.t, price: cur.high, type: 'H' });
    else if (isTrough) res.push({ idx: i, t: cur.t, price: cur.low, type: 'L' });
  }
  return res;
}

// prune small noisy pivots
function filterPivots(pivots, candles, minMovePct = 0.005) {
  if (!pivots || !pivots.length) return [];
  const out = [];
  for (const p of pivots) {
    const refPrice = p.type === 'H' ? candles[p.idx].high : candles[p.idx].low;
    const prev = out.length ? out[out.length-1] : null;
    if (!prev) { out.push(p); continue; }
    const prevPrice = prev.price;
    const diff = Math.abs((refPrice - prevPrice) / Math.max(prevPrice, 1));
    if (diff >= minMovePct) out.push(p);
  }
  return out;
}

// ----------------------------
// Fibonacci helpers
// ----------------------------
function fibLevelsFromRange(high, low) {
  const diff = high - low || 1;
  return {
    high, low, diff,
    fib0236: high - diff * 0.236,
    fib0382: high - diff * 0.382,
    fib05: high - diff * 0.5,
    fib0618: high - diff * 0.618,
    fib0786: high - diff * 0.786,
    ext127: high + diff * 0.272, // ext 1.272 ~= +0.272*diff from high
    ext1618: high + diff * 0.618, 
  };
}

// ----------------------------
// Harmonic pattern (very lightweight heuristics)
// ----------------------------
function detectHarmonic(pivots) {
  // look for 4 pivot pattern A-B-C-D ratios approximating common harmonics
  // pivots is sequence of {type, price}, we want alternating trough/peak
  if (!pivots || pivots.length < 4) return null;
  // use last 5 pivots candidate
  const seq = pivots.slice(-5).map(p => ({ type: p.type, price: p.price }));
  // Try AB=CD: (B-A) ~= (D-C)
  // find a pattern trough->peak->trough->peak or reverse
  for (let i = 0; i <= seq.length - 4; i++) {
    const a = seq[i], b = seq[i+1], c = seq[i+2], d = seq[i+3];
    if (!a || !b || !c || !d) continue;
    const ab = Math.abs((b.price - a.price) / Math.max(a.price,1));
    const cd = Math.abs((d.price - c.price) / Math.max(c.price,1));
    const ratio = ab / (cd || 1);
    if (ratio > 0.8 && ratio < 1.25) {
      return { pattern: 'AB=CD', anchor: [a,b,c,d], strength: Math.round(100 - Math.abs(1-ratio)*100) };
    }
  }
  return null;
}

// ----------------------------
// Linear regression channel (simple)
// ----------------------------
function linearChannel(candles) {
  const n = candles.length;
  if (n < 6) return { upper: null, lower: null, width: null, slopeUpper:0, slopeLower:0 };
  const xs = candles.map((c, i) => i);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const lr = (x, y) => {
    const N = x.length;
    const xm = x.reduce((a,b) => a+b,0)/N;
    const ym = y.reduce((a,b) => a+b,0)/N;
    const num = x.reduce((s, xi, i) => s + (xi-xm)*(y[i]-ym), 0);
    const den = x.reduce((s, xi) => s + (xi-xm)*(xi-xm), 0) || 1;
    const slope = num/den;
    const intercept = ym - slope * xm;
    return { slope, intercept };
  };
  const uh = lr(xs, highs);
  const ul = lr(xs, lows);
  const lastX = xs[xs.length-1];
  const upper = uh.intercept + uh.slope * lastX;
  const lower = ul.intercept + ul.slope * lastX;
  return { upper, lower, width: upper - lower, slopeUpper: uh.slope, slopeLower: ul.slope };
}

// ----------------------------
// Breakout / reversal rules
// ----------------------------
function detectBreakout(lastPrice, channel, fib, recentCloses) {
  const out = { breakout: false, type: null, reason: null };
  // breakout above channel upper
  if (channel.upper && lastPrice > channel.upper) {
    out.breakout = true; out.type = 'Bullish'; out.reason = 'Price above channel upper';
  } else if (channel.lower && lastPrice < channel.lower) {
    out.breakout = true; out.type = 'Bearish'; out.reason = 'Price below channel lower';
  }
  // overextension using fib ext
  if (!out.breakout) {
    if (lastPrice > fib.ext127) { out.breakout = true; out.type = 'Bullish'; out.reason = 'Above Fib ext 1.272'; }
    else if (lastPrice < fib.fib0618) { /* deep retrace */ out.type = 'Bearish'; out.reason = 'Below Fib 0.618'; }
  }
  // short-term momentum confirmation (last few closes slope)
  const m = recentCloses;
  if (m && m.length >= 3) {
    const slope = (m[m.length-1] - m[0]) / (m[0] || 1);
    if (Math.abs(slope) > 0.01 && !out.breakout) {
      out.reason = out.reason ? out.reason + ` | slope:${(slope*100).toFixed(2)}%` : `slope:${(slope*100).toFixed(2)}%`;
    }
  }
  return out;
}

// ----------------------------
// ML Integration hook (async)
// ----------------------------
async function runMLHook(closes, extra = {}) {
  try {
    const mlPath = (CONFIG && CONFIG.ML && CONFIG.ML.MODULE_PATH) || "./ml_module_v8_6.js";
    // dynamic import
    const mod = await import(mlPath);
    if (!mod) return { ok:false };
    // prefer predictWave or predictPattern or runMLPrediction
    const fn = mod.predictWave || mod.predictPattern || mod.runMLPrediction || null;
    if (!fn) return { ok:false };
    const res = await fn(closes, extra);
    // normalize returned { pattern, confidence } or { prob, label }
    if (!res) return { ok:false };
    // standardize to { mlLabel, mlProb }
    const mlLabel = res.label || res.pattern || res.mlLabel || null;
    const mlProb = (res.prob !== undefined) ? (res.prob / 100) : (res.confidence || res.confidencePct || 0);
    return { ok:true, mlLabel, mlProb: Number(mlProb) };
  } catch (e) {
    // fail silently (we expect optional ML)
    return { ok:false, error: e.message || String(e) };
  }
}

// ----------------------------
// Main exported analyzer
// ----------------------------
/**
 * analyzeElliottV3(input, opts)
 * input: candles array OR { "15m": [...], "1h": [...] } map
 * opts: { preferTF: "15m", lookback: 500, pivDepth:3, minPivotMovePct:0.005, useML:true }
 */
export async function analyzeElliottV3(input, opts = {}) {
  const cfg = Object.assign({
    preferTF: "15m",
    lookback: 500,
    pivDepth: 3,
    minPivotMovePct: 0.005,
    useML: true,
    verbose: false
  }, opts);

  try {
    // build candles from input
    let candles = normalizeCandles(input);
    if (candles.length > cfg.lookback) candles = candles.slice(-cfg.lookback);

    if (!candles || candles.length < 20) {
      return { ok:false, error: "insufficient_candles", candlesLength: candles.length };
    }

    // pivots
    const rawPivots = detectPivots(candles, cfg.pivDepth, cfg.pivDepth);
    const pivots = filterPivots(rawPivots, candles, cfg.minPivotMovePct);

    // fibonacci base
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const H = Math.max(...highs);
    const L = Math.min(...lows);
    const fib = fibLevelsFromRange(H, L);

    // harmonic patterns
    const harmonic = detectHarmonic(pivots);

    // channel
    const channel = linearChannel(candles);

    // Elliott naive impulse counting:
    // attempt to see if recent pivots form alternating HL/HH sequences
    let impulseScore = 0;
    let waveType = "unknown";
    try {
      const seq = pivots.map(p => ({ type: p.type, price: p.price, idx: p.idx }));
      // count direction changes
      for (let i = 1; i < seq.length; i++) {
        if (seq[i].type !== seq[i-1].type) impulseScore++;
      }
      // heuristics
      if (impulseScore >= 6) waveType = "impulse-like";
      else if (impulseScore >= 3) waveType = "possible-impulse";
      else waveType = "corrective/sideways";
    } catch (e) { /* ignore */ }

    // TP/SL logic using fib extensions and ATR-ish scale
    const lastClose = candles.at(-1).close;
    const priceRange = H - L || Math.max(1, Math.abs(lastClose*0.01));
    const pseudoATR = priceRange / Math.max(10, Math.min(100, candles.length));
    const TP1 = lastClose + (lastClose >= ((H+L)/2) ? priceRange*0.236 : priceRange*0.382);
    const TP2 = lastClose + (lastClose >= ((H+L)/2) ? priceRange*0.618 : priceRange*0.786);
    const SL = lastClose - Math.sign(lastClose - (H+L)/2) * pseudoATR * 4;

    // breakout/reversal detection
    const breakout = detectBreakout(lastClose, channel, fib, candles.slice(-6).map(c=>c.close));

    // ML integration (optional)
    let ml = { ok:false };
    if (cfg.useML) {
      try {
        const closes = candles.map(c => c.close);
        ml = await runMLHook(closes, { pivots, fib, channel });
      } catch (e) {
        ml = { ok:false, error: e.message || String(e) };
      }
    }

    // final label logic: merge heuristics + ml
    let label = "Neutral";
    let score = 0;
    // simple blend rules
    if (breakout.breakout && breakout.type === 'Bullish') { label = 'Bullish'; score += 40; }
    if (breakout.breakout && breakout.type === 'Bearish') { label = 'Bearish'; score += 40; }
    if (impulseScore >= 6) { label = 'Bullish'; score += 25; }
    if (harmonic && harmonic.pattern) { score += harmonic.strength * 0.2; }
    if (ml.ok && ml.mlProb) {
      // ml.mlProb may be fraction or 0-1 — normalize to 0-100
      const p = ml.mlProb > 1 ? ml.mlProb : ml.mlProb * 100;
      if (ml.mlLabel && /bull/i.test(String(ml.mlLabel))) { score += Math.min(30, p*0.3); label = 'Bullish'; }
      else if (ml.mlLabel && /bear/i.test(String(ml.mlLabel))) { score += Math.min(30, p*0.3); label = 'Bearish'; }
    }

    // confidence cap
    const confidence = Math.round(Math.max(10, Math.min(99, score)));

    const summary = {
      ok: true,
      timestamp: Date.now(),
      lastClose,
      label,
      confidence,
      impulseScore,
      waveType,
      pivotsCount: pivots.length,
      fib,
      harmonic,
      channel,
      breakout,
      TP1: Number(TP1.toFixed(6)),
      TP2: Number(TP2.toFixed(6)),
      SL: Number(SL.toFixed(6)),
      ml,
      summaryText: `${label} | conf:${confidence}% | wave:${waveType} | pivots:${pivots.length}`
    };

    return summary;

  } catch (err) {
    return { ok:false, error: String(err) };
  }
}

// default export
export default { analyzeElliottV3 };