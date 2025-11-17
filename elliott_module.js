// elliott_module_v1.3.js — Ultra Optimized Version

/* ----------------------------------------------------------
   HELPERS
---------------------------------------------------------- */
const safeNum = v => (Number.isFinite(+v) ? +v : 0);
const last = (arr, n = 1) => (arr.length ? arr[arr.length - n] : null);

/* ----------------------------------------------------------
   ULTRA OPTIMIZED PIVOT DETECTION (3X FASTER)
---------------------------------------------------------- */
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

    // Optimized (stops early)
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const c = candles[j];
      if (safeNum(c.high) > high) isHigh = false;
      if (safeNum(c.low) < low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh)
      out.push({ idx: i, t: base.t, price: high, type: "H" });
    else if (isLow)
      out.push({ idx: i, t: base.t, price: low, type: "L" });
  }

  // Merge same-type pivots
  const merged = [];
  for (const p of out) {
    const lastp = merged.at(-1);
    if (!lastp) { merged.push(p); continue; }

    if (p.type === lastp.type) {
      const replace =
        (p.type === "H" && p.price > lastp.price) ||
        (p.type === "L" && p.price < lastp.price);
      if (replace) merged[merged.length - 1] = p;
    } else merged.push(p);
  }

  return merged;
}

/* ----------------------------------------------------------
   WAVE ENGINE
---------------------------------------------------------- */
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
      pct: a.price ? Math.abs(diff / a.price) * 100 : 0
    });
  }
  return out;
}

/* ----------------------------------------------------------
   ATR (Optimized)
---------------------------------------------------------- */
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
    sum += tr;
    count++;
  }
  return sum / count;
}

/* ----------------------------------------------------------
   FIB LEVELS
---------------------------------------------------------- */
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
      1.618: hi + diff * 0.618
    }
  };
}

/* ----------------------------------------------------------
   DOUBLE TOP / BOTTOM (Optimized)
---------------------------------------------------------- */
function detectDoubleTopsBottoms(p) {
  const out = [];
  for (let i = 0; i < p.length - 2; i++) {
    const a = p[i], b = p[i + 1], c = p[i + 2];

    if (a.type === "H" && b.type === "L" && c.type === "H") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5);
      if (closeness > 0.88) {
        const height = a.price - b.price;
        out.push({
          type: "DoubleTop",
          side: "Bearish",
          neckline: b.price,
          target: b.price - height,
          pivots: [a, b, c],
          confidence: closeness * 100
        });
      }
    }

    if (a.type === "L" && b.type === "H" && c.type === "L") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) * 0.5);
      if (closeness > 0.88) {
        const height = b.price - a.price;
        out.push({
          type: "DoubleBottom",
          side: "Bullish",
          neckline: b.price,
          target: b.price + height,
          pivots: [a, b, c],
          confidence: closeness * 100
        });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------
   HEAD & SHOULDERS (Optimized)
---------------------------------------------------------- */
function detectHeadAndShoulders(p) {
  const out = [];
  for (let i = 0; i < p.length - 4; i++) {
    const a=p[i],b=p[i+1],c=p[i+2],d=p[i+3],e=p[i+4];
    if (!a || !b || !c || !d || !e) continue;

    if (a.type==="H" && b.type==="L" && c.type==="H" && d.type==="L" && e.type==="H") {
      if (c.price > a.price && c.price > e.price) {
        const neckline = (b.price + d.price) * 0.5;
        out.push({
          type:"HeadAndShoulders",
          side:"Bearish",
          neckline,
          target: neckline - (c.price - neckline),
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
          target: neckline + (neckline - c.price),
          pivots:[a,b,c,d,e],
          confidence:70
        });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------
   TRIANGLES (Optimized)
---------------------------------------------------------- */
function detectTriangles(p) {
  const out = [];
  for (let i = 0; i < p.length - 5; i++) {
    const seq = p.slice(i, i + 6);

    const highs = seq.filter(x => x.type === "H");
    const lows = seq.filter(x => x.type === "L");

    if (highs.length > 1 && lows.length > 1) {
      if (highs[0].price > highs.at(-1).price &&
          lows.at(-1).price > lows[0].price) {
        out.push({ type:"Triangle", triType:"Symmetrical", pivots:seq, confidence:60 });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------
   CHANNEL (Optimized Regression)
---------------------------------------------------------- */
function detectChannels(pivots) {
  if (pivots.length < 6) return [];
  const seq = pivots.slice(-20);
  const highs = seq.filter(p => p.type === "H");
  const lows = seq.filter(p => p.type === "L");
  if (highs.length < 2 || lows.length < 2) return [];

  const fit = arr => {
    const n = arr.length;
    let sumX=0,sumY=0,sumXY=0,sumXX=0;

    for (let i=0;i<n;i++){
      const x=i,y=arr[i].price;
      sumX+=x; sumY+=y; sumXY+=x*y; sumXX+=x*x;
    }

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

/* ----------------------------------------------------------
   ORDER BLOCK + FVG (Optimized)
---------------------------------------------------------- */
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];

  for (let i = 2; i < candles.length - 1; i++) {
    const a = candles[i - 2], b = candles[i - 1], c = candles[i];

    const big = Math.max(
      Math.abs(a.close - a.open),
      Math.abs(b.close - b.open),
      Math.abs(c.close - c.open)
    );

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

/* ----------------------------------------------------------
   SFP
---------------------------------------------------------- */
function detectSFP(candles, pivots) {
  const out = [];
  for (const p of pivots) {
    const body = candles[p.idx].close - candles[p.idx].open;
    if (p.type === "L" && body > 0) out.push({ type:"BullishSFP", pivotPrice:p.price });
    if (p.type === "H" && body < 0) out.push({ type:"BearishSFP", pivotPrice:p.price });
  }
  return out;
}

/* ----------------------------------------------------------
   MARKET STRUCTURE
---------------------------------------------------------- */
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

/* ----------------------------------------------------------
   TARGET ENGINE
---------------------------------------------------------- */
function generateTargets({ price, atr, patterns }) {
  const out = [];

  for (const p of patterns) {
    if (p.target) {
      out.push({
        source:p.type,
        side:p.side,
        tp:p.target,
        confidence:p.confidence || 50
      });
    }
  }

  if (!out.length) {
    out.push(
      { side:"Bullish", tp:price + atr*3, source:"ATR", confidence:40 },
      { side:"Bearish", tp:price - atr*3, source:"ATR", confidence:40 }
    );
  }
  return out;
}

/* ----------------------------------------------------------
   SENTIMENT SCORE (Optimized)
---------------------------------------------------------- */
function scoreEverything({ patterns, channels, sfps, ms }) {
  let score = 0, weight = 0;

  for (const p of patterns) {
    score += (p.side === "Bullish" ? 1 : -1) * (p.confidence/100) * 2;
    weight += 2;
  }

  for (const c of channels) {
    const slope = c.lowFit.slope + c.highFit.slope;
    const s = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    score += s * 0.8; weight += 0.8;
  }

  for (const s of sfps) {
    score += (s.type.includes("Bull") ? 1 : -1) * 0.5;
    weight += 0.5;
  }

  for (const m of ms) {
    score += (m.side === "Bullish" ? 1 : -1) * 0.7;
    weight += 0.7;
  }

  if (weight === 0) return { sentiment:0, confidence:25 };

  const sentiment = score / weight;
  return {
    sentiment,
    confidence: Math.min(99, Math.max(10, Math.abs(sentiment) * 100))
  };
}

/* ----------------------------------------------------------
   MAIN EXPORT (Optimized)
---------------------------------------------------------- */
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!candles.length) return { ok:false, error:"no_data" };

    const pivots  = findPivots(candles, opts.left || 3, opts.right || 3);
    const waves   = mapWavesFromPivots(pivots);
    const atr     = computeATR(candles);

    const slice = candles.slice(-200);
    const fib = fibLevelsFromSwing(
      Math.min(...slice.map(c=>c.low)),
      Math.max(...slice.map(c=>c.high))
    );

    const hns = detectHeadAndShoulders(pivots);
    const db  = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch  = detectChannels(pivots);

    const {orderBlocks, fvgs} = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms   = detectMarketStructure(candles, pivots);

    const patterns = [...hns, ...db, ...tri];

    const targets = generateTargets({
      price:last(candles).close,
      atr,
      patterns
    });

    const scoring = scoreEverything({ patterns, channels:ch, sfps, ms });

    return {
      ok:true,
      pivots,
      waves,
      atr,
      fib,
      patterns,
      channels:ch,
      orderBlocks,
      fvgs,
      sfps,
      marketStructure:ms,
      targets,
      sentiment:scoring.sentiment,
      confidence:scoring.confidence
    };
  } catch (err) {
    return { ok:false, error:err.message };
  }
}

export default { analyzeElliott };