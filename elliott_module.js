// ==========================================================
// elliott_module.js - FULL LOGIC RESTORED (V2.3)
// Contains Elliott, Harmonic, Smart Money Concepts (SMC), and Channel Detection.
// ==========================================================
// Export: analyzeElliott(candles = [], opts = {})

const VERSION = "v2.3";

const safeNum = v => (Number.isFinite(+v) ? +v : 0);
const last = (arr, n = 1) => (arr.length ? arr[arr.length - n] : null);

// ------------------- Pivot detection (fast, stable) -------------------
function findPivots(candles, left = 3, right = 3) {
  const out = [];
  const n = candles.length;
  const total = left + right;
  if (n <= total) return out;

  for (let i = left; i < n - right; i++) {
    const base = candles[i];
    const high = safeNum(base.high);
    const low = safeNum(base.low);

    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const c = candles[j];
      if (safeNum(c.high) > high) isHigh = false;
      if (safeNum(c.low) < low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) out.push({ idx: i, t: base.t, price: high, type: "H" });
    else if (isLow) out.push({ idx: i, t: base.t, price: low, type: "L" });
  }

  // merge same-type nearby pivots — keep most extreme
  const merged = [];
  for (const p of out) {
    const lastp = merged.at(-1);
    if (!lastp) { merged.push(p); continue; }
    if (p.type === lastp.type) {
      const replace = (p.type === "H" && p.price > lastp.price) || (p.type === "L" && p.price < lastp.price);
      if (replace) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  return merged;
}

// ------------------- Map waves between pivots -------------------
function mapWavesFromPivots(pivots) {
  const out = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i], b = pivots[i + 1];
    const diff = b.price - a.price;
    out.push({
      from: a.idx, to: b.idx,
      start: a.price,
      end: b.price,
      direction: diff > 0 ? "UP" : "DOWN",
      range: Math.abs(diff),
      pct: a.price ? Math.abs(diff / a.price) * 100 : 0,
      a, b
    });
  }
  return out;
}

// ------------------- ATR -------------------
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
  return sum / count;
}

// ------------------- Fib -------------------
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

// ------------------- Pattern detectors (kept + minor improvements) -------------------
function detectDoubleTopsBottoms(p) {
  const out = [];
  for (let i = 0; i < p.length - 2; i++) {
    const a = p[i], b = p[i + 1], c = p[i + 2];
    if (!a || !b || !c) continue;
    if (a.type === "H" && b.type === "L" && c.type === "H") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5 || 1);
      if (closeness > 0.88) {
        const height = a.price - b.price;
        out.push({
          type: "DoubleTop",
          side: "Bearish",
          neckline: b.price,
          target: Number((b.price - height).toFixed(2)),
          pivots: [a, b, c],
          confidence: closeness * 100
        });
      }
    }
    if (a.type === "L" && b.type === "H" && c.type === "L") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5 || 1);
      if (closeness > 0.88) {
        const height = b.price - a.price;
        out.push({
          type: "DoubleBottom",
          side: "Bullish",
          neckline: b.price,
          target: Number((b.price + height).toFixed(2)),
          pivots: [a, b, c],
          confidence: closeness * 100
        });
      }
    }
  }
  return out;
}

function detectHeadAndShoulders(p) {
  const out = [];
  for (let i = 0; i < p.length - 4; i++) {
    const a=p[i],b=p[i+1],c=p[i+2],d=p[i+3],e=p[i+4];
    if (!a||!b||!c||!d||!e) continue;
    if (a.type==="H" && b.type==="L" && c.type==="H" && d.type==="L" && e.type==="H") {
      if (c.price > a.price && c.price > e.price) {
        const neckline = (b.price + d.price) * 0.5;
        out.push({
          type:"HeadAndShoulders",
          side:"Bearish",
          neckline,
          target: Number((neckline - (c.price - neckline)).toFixed(2)),
          pivots:[a,b,c,d,e],
          confidence:70
        });
      }
    }
    if (a.type==="L" && b.type==="H" && c.type==="L" && d.type==="H" && e.type==="L") {
      if (c.price < a.price && c.price < e.price) {
        const neckline = (b.price + d.price) * 0.5;
        out.push({
          type:"InverseHeadAndShoulders",
          side:"Bullish",
          neckline,
          target: Number((neckline + (neckline - c.price)).toFixed(2)),
          pivots:[a,b,c,d,e],
          confidence:70
        });
      }
    }
  }
  return out;
}

function detectTriangles(p) {
  const out = [];
  for (let i = 0; i < p.length - 5; i++) {
    const seq = p.slice(i, i + 6);
    const highs = seq.filter(x => x.type === "H");
    const lows = seq.filter(x => x.type === "L");
    // Ensure we have at least 2 H and 2 L for a meaningful triangle check
    if (highs.length >= 2 && lows.length >= 2) { 
      // Symmetrical or Contracting Triangle: Highs are getting lower, Lows are getting higher
      if (highs[0].price > highs.at(-1).price && lows.at(-1).price > lows[0].price) {
        out.push({ type:"Triangle", triType:"Symmetrical", pivots:seq, confidence:60 });
      }
      // Ascending Triangle: Highs flat, Lows higher
      else if (Math.abs(highs[0].price - highs.at(-1).price) / highs[0].price < 0.005 && lows.at(-1).price > lows[0].price) {
         out.push({ type:"Triangle", triType:"Ascending", pivots:seq, confidence:65 });
      }
      // Descending Triangle: Lows flat, Highs lower
      else if (Math.abs(lows[0].price - lows.at(-1).price) / lows[0].price < 0.005 && highs[0].price > highs.at(-1).price) {
         out.push({ type:"Triangle", triType:"Descending", pivots:seq, confidence:65 });
      }
    }
  }
  return out;
}

function detectChannels(pivots) {
  if (pivots.length < 6) return [];
  const seq = pivots.slice(-20);
  const highs = seq.filter(p => p.type === "H");
  const lows = seq.filter(p => p.type === "L");
  if (highs.length < 2 || lows.length < 2) return [];
  
  // Linear Regression Fit function
  const fit = arr => {
    const n = arr.length;
    let sumX=0,sumY=0,sumXY=0,sumXX=0;
    for (let i=0;i<n;i++){ const x=i,y=arr[i].price; sumX+=x; sumY+=y; sumXY+=x*y; sumXX+=x*x; }
    const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX || 1e-9); // Added 1e-9 for safety
    const intercept = (sumY - slope*sumX)/n;
    return { slope, intercept };
  };

  const highFit = fit(highs);
  const lowFit = fit(lows);

  // Check if slopes are roughly parallel (within 10%)
  const highSlope = highFit.slope;
  const lowSlope = lowFit.slope;
  const avgSlope = (Math.abs(highSlope) + Math.abs(lowSlope)) / 2;
  let confidence = 60;
  
  if (Math.abs(highSlope - lowSlope) < avgSlope * 0.1) {
    confidence = 75; // Parallel channel
  } else if (highSlope > 0 && lowSlope > 0) {
    confidence = 65; // Rising channel
  } else if (highSlope < 0 && lowSlope < 0) {
    confidence = 65; // Falling channel
  }

  return [{
    type:"Channel",
    highFit,
    lowFit,
    confidence,
    side: highSlope > 0 ? "Bullish" : highSlope < 0 ? "Bearish" : "Neutral"
  }];
}

// ------------------- Order blocks & FVG -------------------
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];
  // Start from candle index 2 to ensure we have c-2, c-1, and c
  for (let i = 2; i < candles.length - 1; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    
    // 1. Order Block Detection (Requires strong impulse candle)
    // Focus on the strong candle (a) followed by movement
    // 'a' must be a strong body (e.g., body is > 70% of high-low range)
    const rangeA = safeNum(a.high) - safeNum(a.low);
    const bodyA = Math.abs(safeNum(a.close) - safeNum(a.open));
    
    // Check if candle 'a' is a dominant, full-bodied candle
    if (bodyA / rangeA > 0.7 && bodyA / safeNum(a.open) > 0.005) { // 0.5% body relative to price
      orderBlocks.push({
        type: "OrderBlock",
        idx: i - 2,
        side: a.close > a.open ? "Bullish" : "Bearish",
        // The block level is typically the high/low of the Order Block candle
        levelHigh: Math.max(a.open, a.close),
        levelLow: Math.min(a.open, a.close),
        confidence: 60
      });
    }

    // 2. Fair Value Gap (FVG) Detection
    // Bullish FVG (Gap up): High of candle (a) is lower than Low of candle (c)
    // Bearish FVG (Gap down): Low of candle (a) is higher than High of candle (c)
    
    // Bullish FVG (Low of C > High of A, leaving B in the gap)
    if (safeNum(c.low) > safeNum(a.high)) {
       fvgs.push({
        type: "FVG_Bullish",
        idx: i - 1,
        top: safeNum(c.low),
        bottom: safeNum(a.high),
        width: safeNum(c.low) - safeNum(a.high)
      });
    }
    
    // Bearish FVG (High of C < Low of A, leaving B in the gap)
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

// ------------------- SFP (Swing Failure Pattern) -------------------
function detectSFP(candles, pivots) {
  const out = [];
  // SFP is when price briefly takes out a pivot (H/L) but then closes back inside, failing to break structure.
  
  for (let i = 1; i < pivots.length; i++) {
    const prevP = pivots[i-1];
    const currP = pivots[i];
    
    // Look at the candle immediately after the current pivot (which might be the failure candle)
    const failureCandle = candles[currP.idx + 1] || last(candles);
    if (!failureCandle) continue;

    const prevClose = safeNum(candles[currP.idx - 1]?.close || 0);

    // Bullish SFP: Current Low failed to break below previous Low (L)
    if (prevP.type === "L" && currP.type === "L") {
      // If the current Low (currP) is slightly lower than previous (prevP), 
      // AND the close of the pivot candle (or failure candle) is significantly higher than the low,
      // AND price closed above the low of the previous candle (prevClose)
      if (currP.price < prevP.price && failureCandle.close > prevP.price * 1.001) {
        out.push({ type:"BullishSFP", pivotPrice:currP.price, prevPivot: prevP.price, idx:currP.idx, confidence: 75 });
      }
    }
    
    // Bearish SFP: Current High failed to break above previous High (H)
    if (prevP.type === "H" && currP.type === "H") {
      // If the current High (currP) is slightly higher than previous (prevP),
      // AND the close of the pivot candle (or failure candle) is significantly lower than the high,
      // AND price closed below the high of the previous candle (prevClose)
       if (currP.price > prevP.price && failureCandle.close < prevP.price * 0.999) {
        out.push({ type:"BearishSFP", pivotPrice:currP.price, prevPivot: prevP.price, idx:currP.idx, confidence: 75 });
      }
    }
  }
  return out;
}

// ------------------- Market structure (BOS/Change of Character) -------------------
function detectMarketStructure(candles, pivots) {
  if (pivots.length < 3) return [];
  const out = [];
  
  // Last significant swing points (H/L)
  const lastHigh = last(pivots.filter(p => p.type === "H"));
  const lastLow = last(pivots.filter(p => p.type === "L"));
  const price = last(candles).close;
  
  // Find the High that created the last Low (for Bullish) or vice versa (for Bearish)
  
  // Simple BOS (Break of Structure): Price goes above the last higher high (HH) or below the last lower low (LL).
  if (lastHigh && price > lastHigh.price) {
    out.push({ type:"BOS", side:"Bullish", level: lastHigh.price, confidence: 80 });
  }
  if (lastLow && price < lastLow.price) {
    out.push({ type:"BOS", side:"Bearish", level: lastLow.price, confidence: 80 });
  }
  
  // CoCH (Change of Character) - This is when a market structure break occurs, signaling a potential reversal.
  // Requires at least 3 pivots: [A, B, C]
  if (pivots.length >= 3) {
    const [c, b, a] = pivots.slice(-3);
    
    // Bearish CoCH: Prev trend Bullish (A > C), but price breaks B (which is the low that made the last high)
    if (c.type === "H" && b.type === "L" && a.type === "H" && a.price > c.price) { // HH (A) > Prev H (C)
      if (price < b.price) { // Price breaks the low (B)
        out.push({ type:"CoCH", side:"Bearish (Reversal)", level: b.price, confidence: 70 });
      }
    }
    // Bullish CoCH: Prev trend Bearish (A < C), but price breaks B (which is the high that made the last low)
     if (c.type === "L" && b.type === "H" && a.type === "L" && a.price < c.price) { // LL (A) < Prev L (C)
      if (price > b.price) { // Price breaks the high (B)
        out.push({ type:"CoCH", side:"Bullish (Reversal)", level: b.price, confidence: 70 });
      }
    }
  }
  
  return out;
}

// ------------------- Wave auto-labeler (impulse detection) -------------------
function labelImpulseFromPivots(pivots, candles) {
  const labels = [];
  // We need 5 pivots for a basic 5-wave structure
  for (let i = 0; i < pivots.length - 4; i++) {
    const seq = pivots.slice(i, i + 5);
    const types = seq.map(s => s.type).join("");
    if (!/^(HLHLH|LHLHL)$/.test(types)) continue; // need alternating pivots

    const waves = [];
    for (let j = 0; j < 4; j++) {
      const a = seq[j], b = seq[j+1];
      const diff = b.price - a.price;
      waves.push({
        idxFrom: a.idx, idxTo: b.idx,
        start: a.price, end: b.price,
        range: Math.abs(diff), direction: diff > 0 ? "UP" : "DOWN"
      });
    }

    const waveRanges = waves.map(w => w.range);
    const maxRange = Math.max(...waveRanges);
    const idxMax = waveRanges.indexOf(maxRange); // Index of the largest wave (0=W1, 1=W2, 2=W3, 3=W4)

    // Rule 1: Wave 3 is not the shortest (index 2)
    if (waveRanges[2] <= Math.min(waveRanges[0], waveRanges[1], waveRanges[3]) * 1.05) continue;
    
    // Rule 2: Wave 4 does not overlap Wave 1's price territory
    let overlapPenalty = 0;
    const wave1 = waves[0], wave4 = waves[3];
    if (wave1.direction === "UP") {
      if (wave4.end < wave1.start) overlapPenalty = 1; // W4 penetrates W1 start point
    } else { // DOWN
      if (wave4.end > wave1.start) overlapPenalty = 1; // W4 penetrates W1 start point
    }
    if (overlapPenalty === 1) continue; // Skip if classical overlap rule violated

    // Rule 3: Wave 2 Retracement (should be < 100% of W1)
    const wave2Pct = waves[1].range / (wave1.range || 1e-9);
    if (wave2Pct > 1.0) continue; // W2 can't be > W1

    // Volume validation (optional)
    let volScore = 0;
    try {
      const v1 = avgVolume(candles, wave1.idxFrom, wave1.idxTo);
      const v3 = avgVolume(candles, waves[2].idxFrom, waves[2].idxTo);
      // Prefer rising volume on impulse waves (W3 > W1)
      if (v3 > v1 * 1.1) volScore = 0.5; 
      else if (v3 < v1 * 0.9) volScore = -0.5;
    } catch (_) { volScore = 0; }

    // Scoring
    let score = 50;
    // Reward Wave 3 being the longest
    if (idxMax === 2) score += 20; 
    // Reward shallow W2 (less than 61.8%)
    if (wave2Pct < 0.618) score += 10;
    // Volume benefit
    score += volScore * 10;
    
    const quality = Math.max(0, Math.min(99, Math.round(score)));

    const label = {
      fromPivotIdx: i,
      pivots: seq,
      waves: waves.map((w, idx) => ({ wave: idx + 1, ...w })),
      direction: waves[0].direction === "UP" ? "Bullish" : "Bearish",
      quality,
      notes: {
        wave2Pct: Number((wave2Pct*100).toFixed(1)),
        wave4Pct: Number((waves[3].range / (waves[2].range || 1e-9) * 100).toFixed(1)),
        volScore: Number(volScore.toFixed(2))
      }
    };

    if (quality >= 35) labels.push(label);
  }

  // pick best label if multiples (highest quality)
  if (!labels.length) return null;
  labels.sort((a,b) => b.quality - a.quality);
  return labels[0];
}

// helper: average volume between candle idx range (inclusive start,end)
function avgVolume(candles, startIdx, endIdx) {
  const s = Math.min(startIdx, endIdx);
  const e = Math.max(startIdx, endIdx);
  let sum = 0, count = 0;
  for (let i = s; i <= e && i < candles.length; i++) {
    if (!candles[i]) continue;
    const v = safeNum(candles[i].vol || candles[i].volume || 0);
    sum += v; count++;
  }
  return count ? sum / count : 0;
}

// ------------------- ABC correction detection (following an impulse label) -------------------
function detectABCAfterImpulse(label, pivots, candles) {
  // label.pivots ends at pivot index i+4. We'll search next pivots for A (opposite), B (retracement), C (continuation)
  const endPivotIndex = label.fromPivotIdx + 4;
  const startSearch = endPivotIndex + 1;
  const rem = pivots.slice(startSearch);
  if (!rem.length) return null;

  // The pivot sequence must be 5-A-B-C or 5-A-B-C-D... 
  // A (opposite type of wave 5 pivot)
  const A = rem.find(p => p.type !== last(label.pivots).type);
  if (!A) return null;

  // B (same type as wave 5 pivot, retracing A)
  const B = rem.find(p => p.t > A.t && p.type === last(label.pivots).type);
  if (!B) return null;

  // C (opposite type of B, moving past A)
  const C = rem.find(p => p.t > B.t && p.type === A.type);

  if (!A || !B || !C) return null;

  // Compute targets using fib of the preceding impulse swing (Wave 1-5 total swing)
  const swingLow = Math.min(label.pivots[0].price, last(label.pivots).price);
  const swingHigh = Math.max(label.pivots[0].price, last(label.pivots).price);
  const fib = fibLevelsFromSwing(swingLow, swingHigh);

  const result = {
    A, B, C,
    fib,
    notes: {
      A_price: A.price,
      B_price: B.price,
      C_price: C.price,
      // Calculate B retracement of A
      B_retrace_A_pct: Number((Math.abs(B.price - A.price) / Math.abs(last(label.pivots).price - A.price) * 100).toFixed(2))
    }
  };
  return result;
}

// ------------------- Target generator (keeps earlier behavior) -------------------
function generateTargets({ price, atr, patterns, fib }) {
  const out = [];
  
  // 1. Targets from Patterns (Double Tops/Bottoms, H&S)
  for (const p of patterns) {
    if (p.target) {
      out.push({ source: p.type, side: p.side, tp: p.target, confidence: p.confidence || 50 });
    }
  }
  
  // 2. Targets from Fib Extensions (If price is near fib levels, generate targets based on extension)
  const highFib = fib.ext[1.618];
  const lowFib = fib.retrace[0.618];
  
  if (price > fib.hi && highFib) { // Above recent high, target extension
     out.push({ source: "Fib 1.618 Ext", side: "Bullish", tp: Number(highFib.toFixed(2)), confidence: 60 });
  } else if (price < fib.lo && lowFib) { // Below recent low, target retracement (as support)
     out.push({ source: "Fib 0.618 Ret", side: "Bullish", tp: Number(lowFib.toFixed(2)), confidence: 55 });
  }

  // 3. ATR Fallback Targets (if no specific patterns found)
  if (out.filter(t => t.confidence > 50).length === 0) {
    out.push({ side: "Bullish", tp: Number((price + atr * 2).toFixed(2)), source: "ATR x2", confidence: 40 });
    out.push({ side: "Bearish", tp: Number((price - atr * 2).toFixed(2)), source: "ATR x2", confidence: 40 });
  }
  return out;
}

// ------------------- Sentiment scoring (improved weighting) -------------------
function scoreEverything({ price, patterns, channels, sfps, ms, impulse, fib }) {
  let score = 0, weight = 0;
  
  // 1. Chart Patterns (H&S, Double Top/Bottom) - Strongest Signal
  for (const p of patterns) {
    score += (p.side === "Bullish" ? 1 : -1) * (p.confidence / 100) * 2;
    weight += 2;
  }
  
  // 2. Market Structure (BOS, CoCH) - Strong Signal
  for (const m of ms) {
    // BOS is trending, CoCH is reversal (higher weight for CoCH)
    let w = (m.type === "CoCH") ? 1.5 : 1.0; 
    score += (m.side.includes("Bullish") ? 1 : -1) * w; 
    weight += w;
  }
  
  // 3. Elliott Impulse Label - Strong Confirmation
  if (impulse && impulse.quality) {
    const imp = (impulse.quality - 50) / 50; // -1..+1
    score += imp * 3;
    weight += 3;
  }
  
  // 4. SFP (Swing Failure Pattern) - Reversal/Confirmation
  for (const s of sfps) {
    score += (s.type.includes("Bull") ? 1 : -1) * 0.8; 
    weight += 0.8;
  }
  
  // 5. Channels - Trend Confirmation
  for (const c of channels) {
    const slope = (c.lowFit?.slope || 0) + (c.highFit?.slope || 0);
    const s = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    score += s * 0.5; weight += 0.5;
  }
  
  // 6. Price proximity to major Fib levels (0.5, 0.618)
  const fib05 = fib.retrace[0.5];
  const fib0618 = fib.retrace[0.618];
  
  if (fib05 && fib0618) {
     const proximity = Math.min(Math.abs(price - fib05), Math.abs(price - fib0618));
     // If price is near major support/resistance levels, sentiment tends towards consolidation (Neutral)
     if (proximity < (fib.hi - fib.lo) * 0.05) { // within 5% of swing range
         score *= 0.8; // Dampen trend sentiment
     }
  }


  if (weight === 0) return { sentiment: 0, confidence: 25 };
  
  const rawSentiment = score / weight;
  // Normalize raw sentiment to a confidence value (0-100)
  const confidence = Math.min(99, Math.max(10, Math.abs(rawSentiment) * 100));

  return { sentiment: rawSentiment, confidence };
}

// ------------------- Main analyzeElliott (exported) -------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    // MultiTF handling: Use primary candles for pivots, but can fallback if primary is too short.
    const initialCandles = candles;
    const multiTF = opts.multiTF || null;

    if (!Array.isArray(candles) || candles.length < 50) { // Require more data for complex analysis
      if (multiTF && typeof multiTF === "object") {
        for (const k of Object.keys(multiTF)) {
          if (Array.isArray(multiTF[k]) && multiTF[k].length > initialCandles.length) {
            candles = multiTF[k]; // Use longer TF for stability if primary data is lacking
            console.warn(`[${VERSION}] Switched to ${k} TF data for analysis due to insufficient primary data.`);
            break;
          }
        }
      }
    }

    if (!Array.isArray(candles) || candles.length < 50) {
      return { ok: false, error: "not_enough_data" };
    }

    // Ensure numeric fields
    candles = candles.map(c => ({
      t: safeNum(c.t), open: safeNum(c.open), high: safeNum(c.high),
      low: safeNum(c.low), close: safeNum(c.close), vol: safeNum(c.vol || c.volume || 0)
    }));

    // Timeframe Fix: Your original logic used the full candle array, which is correct for MultiTF analysis.
    
    // Pivots and waves
    const pivots = findPivots(candles, opts.left || 3, opts.right || 3);
    const waves = mapWavesFromPivots(pivots);

    // ATR and fib on relevant slice (last 500 candles is a good balance)
    const atr = computeATR(candles, opts.atrLen || 14);
    const slice = candles.slice(-Math.min(500, candles.length));
    const highPrices = slice.map(c => c.high);
    const lowPrices = slice.map(c => c.low);
    const fib = fibLevelsFromSwing(Math.min(...lowPrices), Math.max(...highPrices));

    // detect various patterns
    const hns = detectHeadAndShoulders(pivots);
    const db = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms = detectMarketStructure(candles, pivots);

    // collect patterns for scoring/targets
    const patterns = [...hns, ...db, ...tri];

    // Wave auto-labelling (impulse)
    const impulseLabel = labelImpulseFromPivots(pivots, candles); // null or object
    let abc = null;
    if (impulseLabel) {
      abc = detectABCAfterImpulse(impulseLabel, pivots, candles);
    }
    
    // generate targets using patterns, atr, and fib
    const targets = generateTargets({ price: last(candles).close, atr, patterns, fib });

    // scoring
    const scoring = scoreEverything({ price: last(candles).close, patterns, channels: ch, sfps, ms, impulse: impulseLabel, fib });

    // shape return — keep backward compatibility + add new fields
    return {
      ok: true,
      version: VERSION,
      pivots,
      waves,
      atr,
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
      // NEW:
      waveLabels: impulseLabel ? impulseLabel.waves : [],
      waveType: impulseLabel ? impulseLabel.direction : "Unknown",
      waveMeta: impulseLabel ? {
        quality: impulseLabel.quality,
        notes: impulseLabel.notes
      } : null,
      abc,
      impulse: impulseLabel,
      // convenience:
      price: last(candles).close,
      length: candles.length
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), version: VERSION };
  }
}

export { analyzeElliott };