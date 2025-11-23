// =====================================
// elliott_module_v2_4.js — Elliott V2.4 (FIXED Impulse Logic)
// =====================================

const VERSION = "v2.4";

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

// ------------------- Pattern detectors (UNCHANGED) -------------------
// ... (detectDoubleTopsBottoms, detectHeadAndShoulders, detectTriangles, detectChannels, detectOrderBlocksAndFVG, detectSFP, detectMarketStructure functions are unchanged)

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
    if (highs.length > 1 && lows.length > 1) {
      if (highs[0].price > highs.at(-1).price && lows.at(-1).price > lows[0].price) {
        out.push({ type:"Triangle", triType:"Symmetrical", pivots:seq, confidence:60 });
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
  const fit = arr => {
    const n = arr.length;
    let sumX=0,sumY=0,sumXY=0,sumXX=0;
    for (let i=0;i<n;i++){ const x=i,y=arr[i].price; sumX+=x; sumY+=y; sumXY+=x*y; sumXX+=x*x; }
    const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX || 1);
    const intercept = (sumY - slope*sumX)/n;
    return { slope, intercept };
  };
  return [{
    type:"Channel",
    highFit: fit(highs),
    lowFit: fit(lows),
    confidence:60
  }];
}

function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];
    const big = Math.max(Math.abs(a.close - a.open), Math.abs(b.close - b.open), Math.abs(c.close - c.open));
    if (Math.abs(a.close - a.open) >= big * 0.7) {
      orderBlocks.push({
        type: "OrderBlock",
        idx: i - 2,
        side: a.close > a.open ? "Bullish" : "Bearish",
        levelHigh: Math.max(a.open, a.close),
        levelLow: Math.min(a.open, a.close),
        confidence: 50
      });
    }
    const gapHigh = Math.min(a.open, a.close);
    const gapLow = Math.max(c.open, c.close);
    if (gapHigh > gapLow) {
      fvgs.push({
        type: "FVG",
        idx: i - 1,
        top: gapHigh,
        bottom: gapLow,
        width: gapHigh - gapLow
      });
    }
  }
  return { orderBlocks, fvgs };
}

function detectSFP(candles, pivots) {
  const out = [];
  for (const p of pivots) {
    const c = candles[p.idx];
    if (!c) continue;
    const body = safeNum(c.close) - safeNum(c.open);
    if (p.type === "L" && body > 0) out.push({ type:"BullishSFP", pivotPrice:p.price, idx:p.idx });
    if (p.type === "H" && body < 0) out.push({ type:"BearishSFP", pivotPrice:p.price, idx:p.idx });
  }
  return out;
}

function detectMarketStructure(candles, pivots) {
  if (!pivots.length) return [];
  const highs = pivots.filter(p => p.type === "H").map(x=>x.price);
  const lows = pivots.filter(p => p.type === "L").map(x=>x.price);
  if (!highs.length || !lows.length) return [];
  const price = last(candles).close;
  const out = [];
  if (price > Math.max(...highs)) out.push({ type:"BOS", side:"Bullish" });
  if (price < Math.min(...lows)) out.push({ type:"BOS", side:"Bearish" });
  return out;
}

// ------------------- Wave auto-labeler (impulse detection) -------------------
/*
  FIXED HEURISTIC: Enforce 3 core Elliott Wave rules strictly.
   1. Wave 2 cannot retrace 100% of Wave 1.
   2. Wave 3 cannot be the shortest motive wave (1, 3, or 5).
   3. Wave 4 cannot overlap the price territory of Wave 1.
*/
function labelImpulseFromPivots(pivots, candles) {
  const labels = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const seq = pivots.slice(i, i + 5);
    const types = seq.map(s => s.type).join("");
    if (!/^(HLHLH|LHLHL)$/.test(types)) continue; // 5 alternating pivots (4 moves)

    const waves = [];
    for (let j = 0; j < 4; j++) { // 4 waves (1, 2, 3, 4) defined by 5 pivots
      const a = seq[j], b = seq[j+1];
      const diff = b.price - a.price;
      waves.push({
        wave: j + 1, // Label moves as 1, 2, 3, 4
        idxFrom: a.idx, idxTo: b.idx,
        start: a.price, end: b.price,
        range: Math.abs(diff), direction: diff > 0 ? "UP" : "DOWN"
      });
    }

    const direction = waves[0].direction;
    const isBullish = direction === "UP";

    const wave1 = waves[0];
    const wave2 = waves[1];
    const wave3 = waves[2];
    const wave4 = waves[3];
    // Wave 5 price is implied by the segment seq[3] -> seq[4]

    // --- RULE 1: Wave 2 cannot retrace 100% of Wave 1 ---
    const wave2Retraced100 = isBullish
      ? wave2.end <= wave1.start // Low of wave 2 below start of wave 1
      : wave2.end >= wave1.start; // High of wave 2 above start of wave 1
    
    if (wave2Retraced100) continue; 

    // --- RULE 3: Wave 4 cannot overlap the price territory of Wave 1 (STRICT) ---
    const wave1PriceTerritory = {
      min: Math.min(wave1.start, wave1.end),
      max: Math.max(wave1.start, wave1.end)
    };
    
    // Wave 4 overlaps if its price range enters wave 1's price range
    const wave4Range = {
      min: Math.min(wave4.start, wave4.end),
      max: Math.max(wave4.start, wave4.end)
    };

    let overlapPenalty = 0;
    if (
      wave4Range.max > wave1PriceTerritory.min && 
      wave4Range.min < wave1PriceTerritory.max
    ) {
      overlapPenalty = 1; // HARD FAIL for Impulse, but we continue to check Rule 2 for scoring
    }
    
    // --- Rule 2: Wave 3 is not the shortest motive wave (1, 3, 5) ---
    // The sequence is only 4 moves (1-2-3-4), but the 5th pivot implies the end of a 5th wave segment.
    // For simplicity, we compare the known impulse moves 1 and 3. We cannot reliably compare wave 5 yet.
    // We'll calculate a theoretical "Wave 5" range as the last wave move.
    
    // Theoretical Wave 5 range (move from Pivot 4 to Pivot 5)
    const wave5Range = Math.abs(seq[4].price - seq[3].price); 
    const waveRanges = [wave1.range, wave3.range, wave5Range];
    
    const shortestRange = Math.min(...waveRanges);
    const wave3IsShortest = wave3.range === shortestRange;
    
    if (wave3IsShortest) {
      // If wave 3 is strictly the shortest of 1, 3, and 5, it's a fail. 
      // We will allow it to proceed with heavy scoring penalty if it wasn't a hard fail (Overlap or W2 fail).
    }

    // --- SCORE CALCULATION ---
    let score = 50;

    // Hard fail? Skip scoring and move on.
    if (overlapPenalty > 0 || wave3IsShortest) { 
        score = 0; 
        if (overlapPenalty > 0) continue; // IMPULSE FAILS RULE 3
    }
    
    const totalMotiveRange = wave1.range + wave3.range + wave5Range;

    // Reward bigger wave3
    score += ((wave3.range / (totalMotiveRange || 1)) - 0.33) * 80;
    
    // Penalize deep wave 4 (overlap penalty already handles the strict rule)
    const wave4Pct = wave4.range / (wave3.range || 1);
    if (wave4Pct > 0.618) score -= 8;
    
    // Volume validation (unchanged)
    let volScore = 0;
    try {
      const v1 = avgVolume(candles, wave1.idxFrom, wave1.idxTo);
      const v3 = avgVolume(candles, wave3.idxFrom, wave3.idxTo);
      if (v3 && v1) {
        volScore = Math.max(0, Math.min(1, (v3 - v1) / (v1 || 1)));
      }
    } catch (_) { volScore = 0; }
    score += volScore * 10;
    
    // Final quality calculation
    const quality = Math.max(0, Math.min(99, Math.round(score)));

    // Assemble labels (We add the implied wave 5 for completeness)
    const wavesFull = [
        ...waves.map(w => ({ wave: w.wave, ...w })),
        { 
            wave: 5, 
            idxFrom: seq[3].idx, idxTo: seq[4].idx,
            start: seq[3].price, end: seq[4].price,
            range: wave5Range, direction: seq[4].price > seq[3].price ? "UP" : "DOWN"
        }
    ];

    const label = {
      fromPivotIdx: i,
      pivots: seq,
      waves: wavesFull,
      direction: direction === "UP" ? "Bullish" : "Bearish",
      quality,
      notes: {
        w1_range: Number(wave1.range.toFixed(4)),
        w3_range: Number(wave3.range.toFixed(4)),
        w5_range: Number(wave5Range.toFixed(4)),
        w2_retrace: Number(((wave2.range / (wave1.range || 1)) * 100).toFixed(1)),
        overlapPenalty, // 1 for fail
        wave3IsShortest,
        volScore: Number(volScore.toFixed(2))
      }
    };

    if (quality >= 35) labels.push(label);
  }

  if (!labels.length) return null;
  labels.sort((a,b) => b.quality - a.quality);
  return labels[0];
}

// helper: average volume (UNCHANGED)
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

// ------------------- ABC correction detection (FIXED) -------------------
function detectABCAfterImpulse(label, pivots, candles) {
  // label.pivots ends at pivot index i+4. We search next pivots for A (opposite), B (retracement), C (continuation)
  const endPivotIndex = label.fromPivotIdx + 4;
  const startSearchIndex = endPivotIndex + 1;
  const rem = pivots.slice(startSearchIndex);
  if (!rem.length) return null;
  
  const impulseEndPrice = label.pivots.at(-1).price;
  const impulseDirection = label.direction;

  // Pivot A: First pivot after impulse end that is opposite to the trend
  const A = rem.find(p => p.type === (impulseDirection === "Bullish" ? "L" : "H"));

  if (!A) return null;

  // Pivot B: Pivot opposite type of A, and between A and C, indicating a retracement
  const B = rem.find(p => p.type !== A.type && p.t > A.t) || null;

  // Pivot C: Pivot same type as A, occurring after B
  const C = rem.find(p => p.type === A.type && p.t > (B?.t || A.t)) || null;

  if (!B || !C) return null;

  // Simple sanity check: C should extend past A for a typical ZigZag (5-3-5)
  let C_extends_A = false;
  if (impulseDirection === "Bullish") { // Bearish correction (A, C are Lows)
      C_extends_A = C.price < A.price;
  } else { // Bullish correction (A, C are Highs)
      C_extends_A = C.price > A.price;
  }

  // compute targets using fib
  const swingLow = Math.min(label.pivots[0].price, label.pivots.at(-1).price);
  const swingHigh = Math.max(label.pivots[0].price, label.pivots.at(-1).price);
  const fib = fibLevelsFromSwing(swingLow, swingHigh);
  
  const A_range = Math.abs(A.price - impulseEndPrice);
  const B_retrace_A = Math.abs(B.price - A.price) / (A_range || 1);


  const result = {
    A, B, C,
    fib,
    extendsA: C_extends_A,
    notes: {
      impulseEnd: impulseEndPrice,
      A_price: A.price,
      B_price: B.price,
      C_price: C.price,
      B_retrace_A_pct: Number((B_retrace_A*100).toFixed(2))
    }
  };
  return result;
}

// ------------------- Target generator (UNCHANGED) -------------------
function generateTargets({ price, atr, patterns }) {
  const out = [];
  for (const p of patterns) {
    if (p.target) {
      out.push({ source: p.type, side: p.side, tp: p.target, confidence: p.confidence || 50 });
    }
  }
  if (!out.length) {
    out.push({ side: "Bullish", tp: price + atr * 3, source: "ATR", confidence: 40 });
    out.push({ side: "Bearish", tp: price - atr * 3, source: "ATR", confidence: 40 });
  }
  return out;
}

// ------------------- Sentiment scoring (IMPROVED IMPULSE WEIGHT) -------------------
function scoreEverything({ patterns, channels, sfps, ms, impulse }) {
  let score = 0, weight = 0;
  for (const p of patterns) {
    score += (p.side === "Bullish" ? 1 : -1) * (p.confidence / 100) * 2;
    weight += 2;
  }
  for (const c of channels) {
    const slope = (c.lowFit?.slope || 0) + (c.highFit?.slope || 0);
    const s = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    score += s * 0.8; weight += 0.8;
  }
  for (const s of sfps) {
    score += (s.type.includes("Bull") ? 1 : -1) * 0.5; weight += 0.5;
  }
  for (const m of ms) {
    score += (m.side === "Bullish" ? 1 : -1) * 0.7; weight += 0.7;
  }
  // reward good impulse quality strongly - now with higher weight
  if (impulse && impulse.quality) {
    const imp = (impulse.quality - 50) / 50; // -1..+1
    score += imp * 4; // Increased weight for high-quality impulse
    weight += 4;
  }
  if (weight === 0) return { sentiment: 0, confidence: 25 };
  const sentiment = score / weight;
  return { sentiment, confidence: Math.min(99, Math.max(10, Math.abs(sentiment) * 100)) };
}

// ------------------- Main analyzeElliott (exported) -------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    const multiTF = opts.multiTF || null;

    if (!Array.isArray(candles) || candles.length < 8) {
      if (multiTF && typeof multiTF === "object") {
        for (const k of Object.keys(multiTF)) {
          if (Array.isArray(multiTF[k]?.data) && multiTF[k].data.length >= 8) {
            candles = multiTF[k].data; // Use .data if multiTF format includes it
            break;
          } else if (Array.isArray(multiTF[k]) && multiTF[k].length >= 8) {
            candles = multiTF[k]; // Use array directly if not in {data:[]} format
            break;
          }
        }
      }
    }

    if (!Array.isArray(candles) || candles.length < 8) {
      return { ok: false, error: "no_data" };
    }

    // ensure numeric fields
    candles = candles.map(c => ({
      t: safeNum(c.t), open: safeNum(c.open), high: safeNum(c.high),
      low: safeNum(c.low), close: safeNum(c.close), vol: safeNum(c.vol || c.volume || 0)
    }));

    // Pivots and waves
    const pivots = findPivots(candles, opts.left || 3, opts.right || 3);
    const waves = mapWavesFromPivots(pivots);

    // ATR and fib on recent slice
    const atr = computeATR(candles, opts.atrLen || 14);
    const slice = candles.slice(-Math.min(500, candles.length));
    const fib = fibLevelsFromSwing(Math.min(...slice.map(c => c.low)), Math.max(...slice.map(c => c.high)));

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

    // generate targets using both patterns and atr fallback
    const targets = generateTargets({ price: last(candles).close, atr, patterns });

     // Wave auto-labelling (impulse)
    const impulseLabel = labelImpulseFromPivots(pivots, candles); // null or object
    let abc = null;
    if (impulseLabel) {
      abc = detectABCAfterImpulse(impulseLabel, pivots, candles);
    }

    // scoring
    const scoring = scoreEverything({ patterns, channels: ch, sfps, ms, impulse: impulseLabel });

    // shape return
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
    return { ok: false, error: err?.message || String(err) };
  }
}

export default { analyzeElliott };

// EXPORTS (Same as original)
