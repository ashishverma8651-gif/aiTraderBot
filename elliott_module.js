// ==========================================================
// elliott_module.js — Enhanced Non-Breaking Version (v2.4)
// - Same export: analyzeElliott(candles = [], opts = {})
// - Enhancements: faster pivots, timestamp regression for channels,
//   stricter SFP, better Order Blocks, corrected ABC, improved scoring,
//   trend field, debug toggle, minor crypto-friendly loosenings.
// ==========================================================
const VERSION = "v2.4";

const safeNum = v => (Number.isFinite(+v) ? +v : 0);
const last = (arr, n = 1) => (arr && arr.length ? arr[arr.length - n] : null);

// -----------------------------
// Small utilities
// -----------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function avg(arr) { if (!arr || !arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function fmt(n, dp=2) { return Number(Number.isFinite(+n) ? n.toFixed(dp) : 0); }

// -----------------------------
// Pivot detection (optimized)
// - single pass with local window checks
// - merges nearby same-type pivots preserving extreme
// -----------------------------
function findPivots(candles, left = 3, right = 3) {
  const out = [];
  if (!Array.isArray(candles) || candles.length <= left + right) return out;
  const n = candles.length;

  // Pre-extract highs/lows for fewer object accesses
  const highs = new Array(n), lows = new Array(n);
  for (let i=0;i<n;i++){ highs[i]=safeNum(candles[i]?.high); lows[i]=safeNum(candles[i]?.low); }

  for (let i = left; i < n - right; i++) {
    const h = highs[i], l = lows[i];
    let isHigh = true, isLow = true;

    // check left side
    for (let j = i - left; j < i; j++) {
      if (highs[j] > h) { isHigh = false; if (!isLow) break; }
      if (lows[j] < l) { isLow = false; if (!isHigh) break; }
    }
    // check right side
    for (let j = i + 1; j <= i + right; j++) {
      if (highs[j] > h) { isHigh = false; if (!isLow) break; }
      if (lows[j] < l) { isLow = false; if (!isHigh) break; }
    }

    if (isHigh) out.push({ idx: i, t: safeNum(candles[i].t), price: h, type: "H" });
    else if (isLow) out.push({ idx: i, t: safeNum(candles[i].t), price: l, type: "L" });
  }

  // Merge proximate same-type pivots — keep most extreme within a small window
  const merged = [];
  for (const p of out) {
    const lastp = merged.at(-1);
    if (!lastp) { merged.push(p); continue; }
    // if same type and close in index (<= left), keep the extreme one
    if (p.type === lastp.type && Math.abs(p.idx - lastp.idx) <= left) {
      const replace = (p.type === "H" && p.price > lastp.price) || (p.type === "L" && p.price < lastp.price);
      if (replace) merged[merged.length - 1] = p;
    } else merged.push(p);
  }

  return merged;
}

// -----------------------------
// Map waves between pivots
// -----------------------------
function mapWavesFromPivots(pivots) {
  const out = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i], b = pivots[i + 1];
    const diff = b.price - a.price;
    out.push({
      from: a.idx, to: b.idx,
      start: a.price, end: b.price,
      direction: diff > 0 ? "UP" : "DOWN",
      range: Math.abs(diff),
      pct: a.price ? Math.abs(diff / a.price) * 100 : 0,
      a, b
    });
  }
  return out;
}

// -----------------------------
// ATR
// -----------------------------
function computeATR(candles, length = 14) {
  const n = candles.length;
  if (n < 2) return 0;
  const start = Math.max(1, n - length);
  let sum = 0, count = 0;
  for (let i = start; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(
      safeNum(c.high) - safeNum(c.low),
      Math.abs(safeNum(c.high) - safeNum(p.close)),
      Math.abs(safeNum(c.low) - safeNum(p.close))
    );
    sum += tr; count++;
  }
  return count ? sum / count : 0;
}

// -----------------------------
// Fib from swing
// -----------------------------
function fibLevelsFromSwing(low, high) {
  const lo = safeNum(low), hi = safeNum(high);
  const diff = Math.max(1e-9, hi - lo);
  return {
    lo, hi,
    retrace: {
      0.236: hi - diff * 0.236,
      0.382: hi - diff * 0.382,
      0.5: hi - diff * 0.5,
      0.618: hi - diff * 0.618,
      0.786: hi - diff * 0.786
    },
    ext: {
      1.272: hi + diff * 0.272,
      1.618: hi + diff * 0.618,
      2.0: hi + diff * 1.0
    }
  };
}

// -----------------------------
// Patterns: Double Tops/Bottoms
// -----------------------------
function detectDoubleTopsBottoms(pivots) {
  const out = [];
  for (let i = 0; i < pivots.length - 2; i++) {
    const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2];
    if (!a || !b || !c) continue;
    // Double Top
    if (a.type === "H" && b.type === "L" && c.type === "H") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5 || 1);
      if (closeness > 0.85) {
        const height = a.price - b.price;
        out.push({
          type: "DoubleTop",
          side: "Bearish",
          neckline: b.price,
          target: fmt(b.price - height, 2),
          pivots: [a, b, c],
          confidence: Math.round(closeness * 100)
        });
      }
    }
    // Double Bottom
    if (a.type === "L" && b.type === "H" && c.type === "L") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5 || 1);
      if (closeness > 0.85) {
        const height = b.price - a.price;
        out.push({
          type: "DoubleBottom",
          side: "Bullish",
          neckline: b.price,
          target: fmt(b.price + height, 2),
          pivots: [a, b, c],
          confidence: Math.round(closeness * 100)
        });
      }
    }
  }
  return out;
}

// -----------------------------
// Head & Shoulders
// -----------------------------
function detectHeadAndShoulders(pivots) {
  const out = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2], d = pivots[i + 3], e = pivots[i + 4];
    if (!a || !b || !c || !d || !e) continue;
    // H&S
    if (a.type === "H" && b.type === "L" && c.type === "H" && d.type === "L" && e.type === "H") {
      if (c.price > a.price && c.price > e.price) {
        const neckline = (b.price + d.price) * 0.5;
        out.push({
          type: "HeadAndShoulders",
          side: "Bearish",
          neckline,
          target: fmt(neckline - (c.price - neckline), 2),
          pivots: [a, b, c, d, e],
          confidence: 70
        });
      }
    }
    // Inverse H&S
    if (a.type === "L" && b.type === "H" && c.type === "L" && d.type === "H" && e.type === "L") {
      if (c.price < a.price && c.price < e.price) {
        const neckline = (b.price + d.price) * 0.5;
        out.push({
          type: "InverseHeadAndShoulders",
          side: "Bullish",
          neckline,
          target: fmt(neckline + (neckline - c.price), 2),
          pivots: [a, b, c, d, e],
          confidence: 70
        });
      }
    }
  }
  return out;
}

// -----------------------------
// Triangles (improved heuristics)
// -----------------------------
function detectTriangles(pivots) {
  const out = [];
  if (!pivots || pivots.length < 6) return out;

  // Consider windows size 6..9 for better detection
  for (let w = 6; w <= 9; w++) {
    for (let i = 0; i <= pivots.length - w; i++) {
      const seq = pivots.slice(i, i + w);
      const highs = seq.filter(x => x.type === "H");
      const lows = seq.filter(x => x.type === "L");
      if (highs.length < 2 || lows.length < 2) continue;

      // compute high slope and low slope (price over time)
      const hiSlope = (highs.at(-1).price - highs[0].price) / Math.max(1, highs.at(-1).t - highs[0].t);
      const loSlope = (lows.at(-1).price - lows[0].price) / Math.max(1, lows.at(-1).t - lows[0].t);

      // Symmetrical: hiSlope < 0, loSlope > 0 (converging)
      if (hiSlope < 0 && loSlope > 0) {
        out.push({ type: "Triangle", triType: "Symmetrical", pivots: seq, confidence: 60 });
      } else {
        // Ascending: hi flat (small slope), lo rising
        if (Math.abs(hiSlope) < Math.abs(loSlope) * 0.5 && loSlope > 0) {
          out.push({ type: "Triangle", triType: "Ascending", pivots: seq, confidence: 65 });
        }
        // Descending: lo flat, hi falling
        if (Math.abs(loSlope) < Math.abs(hiSlope) * 0.5 && hiSlope < 0) {
          out.push({ type: "Triangle", triType: "Descending", pivots: seq, confidence: 65 });
        }
      }
    }
  }
  return out;
}

// -----------------------------
// Channels (timestamp-based linear fit)
// -----------------------------
function detectChannels(pivots) {
  if (!pivots || pivots.length < 6) return [];
  const seq = pivots.slice(-Math.min(60, pivots.length)); // last few
  const highs = seq.filter(p => p.type === "H");
  const lows = seq.filter(p => p.type === "L");
  if (highs.length < 2 || lows.length < 2) return [];

  // Linear regression using timestamp as x
  const fit = arr => {
    const n = arr.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      const x = safeNum(arr[i].t) || i; // fallback to index
      const y = safeNum(arr[i].price);
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const denom = (n * sumXX - sumX * sumX) || 1e-9;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  };

  const highFit = fit(highs);
  const lowFit = fit(lows);
  const avgSlope = (Math.abs(highFit.slope) + Math.abs(lowFit.slope)) / 2;

  let confidence = 60;
  if (Math.abs(highFit.slope - lowFit.slope) < Math.abs(avgSlope) * 0.12) confidence = 80;
  else if ((highFit.slope > 0 && lowFit.slope > 0) || (highFit.slope < 0 && lowFit.slope < 0)) confidence = 65;

  return [{
    type: "Channel",
    highFit, lowFit,
    confidence,
    side: highFit.slope > 0 ? "Bullish" : highFit.slope < 0 ? "Bearish" : "Neutral"
  }];
}

// -----------------------------
// Order Blocks & FVG (stricter rules)
// -----------------------------
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];
  // Look for strong directional candles followed by imbalance / displacement
  for (let i = 2; i < candles.length - 1; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    if (!a || !b || !c) continue;

    const rangeA = Math.max(1e-9, safeNum(a.high) - safeNum(a.low));
    const bodyA = Math.abs(safeNum(a.close) - safeNum(a.open));
    const bodyRatio = bodyA / rangeA;

    // require strong candle and relative size vs price (avoid tiny candles)
    if (bodyRatio > 0.65 && bodyA / Math.max(1, Math.abs(safeNum(a.open))) > 0.002) {
      // displacement check: subsequent candle (c) should move away from block in same direction
      if ((a.close > a.open && safeNum(c.close) > safeNum(b.close)) || (a.close < a.open && safeNum(c.close) < safeNum(b.close))) {
        // record order block
        orderBlocks.push({
          type: "OrderBlock",
          idx: i - 2,
          side: a.close > a.open ? "Bullish" : "Bearish",
          levelHigh: Math.max(safeNum(a.open), safeNum(a.close)),
          levelLow: Math.min(safeNum(a.open), safeNum(a.close)),
          confidence: clamp(Math.round(50 + (bodyRatio - 0.65) * 100), 50, 90)
        });
      }
    }

    // FVG detection (gap zones between a and c)
    if (safeNum(c.low) > safeNum(a.high)) {
      fvgs.push({
        type: "FVG_Bullish",
        idx: i - 1,
        top: safeNum(c.low),
        bottom: safeNum(a.high),
        width: safeNum(c.low) - safeNum(a.high)
      });
    }
    if (safeNum(c.high) < safeNum(a.low)) {
      fvgs.push({
        type: "FVG_Bearish",
        idx: i - 1,
        top: safeNum(a.low),
        bottom: safeNum(c.high),
        width: safeNum(a.low) - safeNum(c.high)
      });
    }
  }
  return { orderBlocks, fvgs };
}

// -----------------------------
// SFP detection (strict wick + closure rules)
// -----------------------------
function detectSFP(candles, pivots) {
  const out = [];
  if (!Array.isArray(pivots) || pivots.length < 2) return out;

  for (let i = 1; i < pivots.length; i++) {
    const prevP = pivots[i - 1];
    const currP = pivots[i];
    const failureCandle = candles[currP.idx + 1] || last(candles);
    if (!failureCandle) continue;

    // wick & body measures
    const fcHigh = safeNum(failureCandle.high), fcLow = safeNum(failureCandle.low);
    const fcOpen = safeNum(failureCandle.open), fcClose = safeNum(failureCandle.close);
    const body = Math.abs(fcClose - fcOpen);
    const wickUp = fcHigh - Math.max(fcOpen, fcClose);
    const wickDown = Math.min(fcOpen, fcClose) - fcLow;

    // Bullish SFP (failed bearish break)
    if (prevP.type === "L" && currP.type === "L") {
      // currP.price slightly lower than prevP.price but price closes back above prev low (disproving break)
      if (currP.price < prevP.price && (fcClose > prevP.price * 1.0005) && wickUp > body * 0.8) {
        out.push({ type: "BullishSFP", pivotPrice: currP.price, prevPivot: prevP.price, idx: currP.idx, confidence: 75 });
      }
    }

    // Bearish SFP (failed bullish break)
    if (prevP.type === "H" && currP.type === "H") {
      if (currP.price > prevP.price && (fcClose < prevP.price * 0.9995) && wickDown > body * 0.8) {
        out.push({ type: "BearishSFP", pivotPrice: currP.price, prevPivot: prevP.price, idx: currP.idx, confidence: 75 });
      }
    }
  }
  return out;
}

// -----------------------------
// Market structure (BOS / CoCH) detection
// -----------------------------
function detectMarketStructure(candles, pivots) {
  if (!pivots || pivots.length < 2) return [];
  const out = [];
  const lastPrice = safeNum(last(candles)?.close || 0);
  if (!lastPrice) return out;

  const highs = pivots.filter(p => p.type === "H");
  const lows = pivots.filter(p => p.type === "L");
  const lastHigh = highs.at(-1);
  const lastLow = lows.at(-1);

  if (lastHigh && lastPrice > lastHigh.price) out.push({ type: "BOS", side: "Bullish", level: lastHigh.price, confidence: 80 });
  if (lastLow && lastPrice < lastLow.price) out.push({ type: "BOS", side: "Bearish", level: lastLow.price, confidence: 80 });

  // Change of Character detection using last 3 pivots
  if (pivots.length >= 3) {
    const [c, b, a] = pivots.slice(-3); // c older, a newest
    // Bearish CoCH
    if (c.type === "H" && b.type === "L" && a.type === "H" && a.price > c.price && lastPrice < b.price) {
      out.push({ type: "CoCH", side: "Bearish (Reversal)", level: b.price, confidence: 70 });
    }
    // Bullish CoCH
    if (c.type === "L" && b.type === "H" && a.type === "L" && a.price < c.price && lastPrice > b.price) {
      out.push({ type: "CoCH", side: "Bullish (Reversal)", level: b.price, confidence: 70 });
    }
  }
  return out;
}

// -----------------------------
// avgVolume helper
// -----------------------------
function avgVolume(candles, startIdx, endIdx) {
  if (!Array.isArray(candles) || candles.length === 0) return 0;
  const s = Math.max(0, Math.min(startIdx, endIdx));
  const e = Math.min(candles.length - 1, Math.max(startIdx, endIdx));
  let sum = 0, count = 0;
  for (let i = s; i <= e; i++) {
    if (!candles[i]) continue;
    const v = safeNum(candles[i].vol || candles[i].volume || 0);
    sum += v; count++;
  }
  return count ? sum / count : 0;
}

// -----------------------------
// Wave auto-labeler (impulse detection)
// - slightly relaxed overlap rules for crypto
// -----------------------------
function labelImpulseFromPivots(pivots, candles, opts = {}) {
  const labels = [];
  const allowOverlapPct = opts.allowW4OverlapPct ?? 0.12; // 12% default tolerance for W4 overlap
  for (let i = 0; i < pivots.length - 4; i++) {
    const seq = pivots.slice(i, i + 5);
    const types = seq.map(s => s.type).join("");
    if (!/^(HLHLH|LHLHL)$/.test(types)) continue;

    const waves = [];
    for (let j = 0; j < 4; j++) {
      const a = seq[j], b = seq[j + 1];
      const diff = b.price - a.price;
      waves.push({
        idxFrom: a.idx, idxTo: b.idx,
        start: a.price, end: b.price,
        range: Math.abs(diff), direction: diff > 0 ? "UP" : "DOWN"
      });
    }

    const waveRanges = waves.map(w => w.range);
    const maxRange = Math.max(...waveRanges);
    const idxMax = waveRanges.indexOf(maxRange);

    // Wave 3 should not be the shortest (allow some tolerance)
    if (waveRanges[2] <= Math.min(waveRanges[0], waveRanges[1], waveRanges[3]) * 0.9) continue;

    // Wave 4 overlap rule (allow small overlap for crypto)
    const wave1 = waves[0], wave4 = waves[3];
    let overlapPenalty = 0;
    if (wave1.direction === "UP") {
      if (wave4.end < wave1.start - (wave1.range * allowOverlapPct)) overlapPenalty = 1;
    } else {
      if (wave4.end > wave1.start + (wave1.range * allowOverlapPct)) overlapPenalty = 1;
    }
    if (overlapPenalty) continue;

    // W2 retracement (should be < 100% of W1)
    const wave2Pct = waves[1].range / (wave1.range || 1e-9);
    if (wave2Pct > 1.0) continue;

    // Volume check
    let volScore = 0;
    try {
      const v1 = avgVolume(candles, wave1.idxFrom, wave1.idxTo);
      const v3 = avgVolume(candles, waves[2].idxFrom, waves[2].idxTo);
      if (v3 > v1 * 1.1) volScore = 0.5;
      else if (v3 < v1 * 0.9) volScore = -0.5;
    } catch (_) { volScore = 0; }

    let score = 50;
    if (idxMax === 2) score += 20; // wave 3 longest
    if (wave2Pct < 0.618) score += 10;
    score += volScore * 10;

    const quality = clamp(Math.round(score), 0, 99);
    const label = {
      fromPivotIdx: i,
      pivots: seq,
      waves: waves.map((w, idx) => ({ wave: idx + 1, ...w })),
      direction: waves[0].direction === "UP" ? "Bullish" : "Bearish",
      quality,
      notes: {
        wave2Pct: fmt(wave2Pct * 100, 1),
        wave4Pct: fmt(waves[3].range / (waves[2].range || 1e-9) * 100, 1),
        volScore: fmt(volScore, 2)
      }
    };

    if (quality >= 30) labels.push(label);
  }

  if (!labels.length) return null;
  labels.sort((a, b) => b.quality - a.quality);
  return labels[0];
}

// -----------------------------
// ABC detection (fixed baseline & coherent fib usage)
// - Looks for A-B-C following impulse end
// -----------------------------
function detectABCAfterImpulse(label, pivots, candles) {
  if (!label) return null;
  const endPivotIndex = label.fromPivotIdx + 4;
  const rem = pivots.slice(endPivotIndex + 1);
  if (!rem.length) return null;

  // A should be opposite type to last pivot in label
  const lastPivotType = label.pivots.at(-1).type;
  const A = rem.find(p => p.type !== lastPivotType);
  if (!A) return null;
  // B should be same type as last pivot (retracement)
  const B = rem.find(p => p.t > A.t && p.type === lastPivotType);
  if (!B) return null;
  // C should be opposite type after B
  const C = rem.find(p => p.t > B.t && p.type === A.type);
  if (!C) return null;

  // Use wave 3-5 or entire impulse swing for fib baseline — prefer 3-5 if available
  // determine swing low/high for fib
  const pivotPrices = label.pivots.map(p => p.price);
  const swingLow = Math.min(...pivotPrices);
  const swingHigh = Math.max(...pivotPrices);
  const fib = fibLevelsFromSwing(swingLow, swingHigh);

  // compute retracements for A-B relative to preceding impulse leg
  const result = {
    A, B, C, fib,
    notes: {
      A_price: A.price,
      B_price: B.price,
      C_price: C.price,
      // B retrace as % of impulse (end-start)
      B_retrace_impulse_pct: fmt(Math.abs(B.price - label.pivots[0].price) / Math.max(1e-9, Math.abs(label.pivots.at(-1).price - label.pivots[0].price)) * 100, 2)
    }
  };
  return result;
}

// -----------------------------
// Targets generator (improved weighting)
// -----------------------------
function generateTargets({ price=0, atr=0, patterns=[], fib }) {
  const out = [];
  // From pattern targets
  for (const p of patterns) {
    if (p.target) {
      out.push({ source: p.type, side: p.side, tp: p.target, confidence: p.confidence || 50 });
    }
  }

  // From fib extensions (if price above recent high)
  if (fib) {
    const highFib = fib.ext["1.618"];
    const lowFib = fib.retrace["0.618"];
    if (price > fib.hi && highFib) out.push({ source: "Fib 1.618 Ext", side: "Bullish", tp: fmt(highFib,2), confidence: 60 });
    else if (price < fib.lo && lowFib) out.push({ source: "Fib 0.618 Ret", side: "Bullish", tp: fmt(lowFib,2), confidence: 55 });
  }

  // ATR fallback
  if (!out.some(t => t.confidence > 50)) {
    out.push({ side: "Bullish", tp: fmt(price + atr * 2,2), source: "ATR x2", confidence: 40 });
    out.push({ side: "Bearish", tp: fmt(price - atr * 2,2), source: "ATR x2", confidence: 40 });
  }

  return out;
}

// -----------------------------
// Scoring (normalized & bounded)
// -----------------------------
function scoreEverything({ price, patterns=[], channels=[], sfps=[], ms=[], impulse=null, fib=null, orderBlocks=[] }) {
  let score = 0;
  let weight = 0;

  // Patterns (H&S, Double) stronger weight
  for (const p of patterns) {
    const w = 2;
    const s = (p.side === "Bullish" ? 1 : -1) * (p.confidence / 100);
    score += s * w;
    weight += w;
  }

  // Market Structure
  for (const m of ms) {
    const w = m.type === "CoCH" ? 1.6 : 1.0;
    const s = (m.side && m.side.includes("Bull")) ? 1 : -1;
    score += s * w;
    weight += w;
  }

  // Elliott impulse
  if (impulse && typeof impulse.quality === "number") {
    const imp = (impulse.quality - 50) / 50; // -1..+1
    score += imp * 3;
    weight += 3;
  }

  // SFPs
  for (const s of sfps) {
    const sgn = s.type.includes("Bull") ? 1 : -1;
    score += sgn * 0.8;
    weight += 0.8;
  }

  // Channels
  for (const c of channels) {
    const slope = (c.lowFit?.slope || 0) + (c.highFit?.slope || 0);
    const sgn = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    score += sgn * 0.5;
    weight += 0.5;
  }

  // Order blocks bias (if recent)
  for (const ob of orderBlocks) {
    const sgn = ob.side === "Bullish" ? 0.4 : -0.4;
    score += sgn * (ob.confidence / 100);
    weight += 0.4;
  }

  // Price near fib mid-levels dampens conviction a bit
  if (fib) {
    const fib05 = fib.retrace[0.5], fib0618 = fib.retrace[0.618];
    if (fib05 && fib0618) {
      const proximity = Math.min(Math.abs(price - fib05), Math.abs(price - fib0618));
      const range = Math.max(1e-9, fib.hi - fib.lo);
      if (proximity < range * 0.05) score *= 0.85; // dampen near key level
    }
  }

  if (weight === 0) return { sentiment: 0, confidence: 25 };

  const rawSentiment = score / weight; // roughly -? .. +?
  // normalize rawSentiment to [-1,1] (cap)
  const norm = clamp(rawSentiment, -1, 1);
  const confidence = Math.min(99, Math.max(10, Math.round(Math.abs(norm) * 100)));

  return { sentiment: Number(norm.toFixed(3)), confidence };
}

// -----------------------------
// Main analyzeElliott (exported)
// -----------------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    // Validate and possibly swap to multiTF if primary too short
    const initialCandles = Array.isArray(candles) ? candles.slice() : [];
    const multiTF = opts.multiTF || null;

    if ((!Array.isArray(candles) || candles.length < 60) && multiTF && typeof multiTF === "object") {
      // pick the longest available TF
      const bestKey = Object.keys(multiTF).reduce((best, k) => {
        const len = Array.isArray(multiTF[k]) ? multiTF[k].length : 0;
        return len > (multiTF[best]?.length || 0) ? k : best;
      }, Object.keys(multiTF)[0]);
      if (bestKey && Array.isArray(multiTF[bestKey]) && multiTF[bestKey].length > (candles?.length || 0)) {
        candles = multiTF[bestKey];
        if (opts.debug) console.debug(`[${VERSION}] switched to TF ${bestKey} for analysis`);
      }
    }

    if (!Array.isArray(candles) || candles.length < 30) {
      return { ok: false, error: "not_enough_data" };
    }

    // Normalize candle numeric fields
    candles = candles.map(c => ({
      t: safeNum(c.t), open: safeNum(c.open), high: safeNum(c.high),
      low: safeNum(c.low), close: safeNum(c.close), vol: safeNum(c.vol ?? c.volume ?? 0)
    }));

    // Pivots and waves
    const pivots = findPivots(candles, opts.left || 3, opts.right || 3);
    const waves = mapWavesFromPivots(pivots);

    // ATR & fib baseline on last N candles
    const atr = computeATR(candles, opts.atrLen || 14);
    const slice = candles.slice(-Math.min(500, candles.length));
    const highPrices = slice.map(c => c.high), lowPrices = slice.map(c => c.low);
    const fib = fibLevelsFromSwing(Math.min(...lowPrices), Math.max(...highPrices));

    // Pattern detection
    const hns = detectHeadAndShoulders(pivots);
    const db = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms = detectMarketStructure(candles, pivots);

    const patterns = [...hns, ...db, ...tri];

    // Impulse label & ABC
    const impulseLabel = labelImpulseFromPivots(pivots, candles, opts);
    const abc = impulseLabel ? detectABCAfterImpulse(impulseLabel, pivots, candles) : null;

    // Targets
    const price = safeNum(last(candles)?.close || 0);
    const targets = generateTargets({ price, atr, patterns, fib });

    // Scoring
    const scoring = scoreEverything({
      price, patterns, channels: ch, sfps, ms, impulse: impulseLabel, fib, orderBlocks
    });

    const trend = scoring.sentiment > 0.18 ? "Bullish" : scoring.sentiment < -0.18 ? "Bearish" : "Neutral";

    // Extra debug info optionally included
    const debugInfo = opts.debug ? {
      pivotCount: pivots.length,
      patternsFound: patterns.length,
      channelsFound: ch.length,
      orderBlocksFound: orderBlocks.length,
      fvgsFound: fvgs.length,
      sfpsFound: sfps.length,
      impulseLabelSummary: impulseLabel ? { quality: impulseLabel.quality, direction: impulseLabel.direction } : null
    } : undefined;

    // Return object (backwards-compatible keys preserved)
    const result = {
      ok: true,
      version: VERSION,
      pivots,
      waves,
      atr: fmt(atr, 4),
      fib,
      patterns,
      channels: ch,
      orderBlocks,
      fvgs,
      sfps,
      marketStructure: ms,
      targets,
      sentiment: scoring.sentiment,
      confidence: scoring.confidence,
      waveLabels: impulseLabel ? impulseLabel.waves : [],
      waveType: impulseLabel ? impulseLabel.direction : "Unknown",
      waveMeta: impulseLabel ? { quality: impulseLabel.quality, notes: impulseLabel.notes } : null,
      abc,
      impulse: impulseLabel,
      price,
      length: candles.length,
      trend,
      debug: debugInfo
    };

    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err), version: VERSION };
  }
}

