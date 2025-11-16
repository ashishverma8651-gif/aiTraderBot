// elliott_module.js — Enhanced Elliott + Pattern Engine (v1.0)
// Exports: analyzeElliott(candles, opts)
// Input: candles = [{t, open, high, low, close, vol}] (oldest -> newest)
// Output: object { ok, pivots, waves, patterns, harmonics, channels, fib, atr, targets, sentiment, confidence }

function safeNum(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function last(arr, n=1){ return arr.length ? arr[arr.length - n] : null; }

// ----------------------
// PIVOT / ZIGZAG
// ----------------------
function findPivots(candles, left = 3, right = 3) {
  // Returns pivots: [{idx, t, price, type: 'L'|'H'}]
  const pivots = [];
  const n = candles.length;
  for (let i = left; i < n - right; i++) {
    const cur = candles[i];
    const high = cur.high;
    const low = cur.low;
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high > high) isHigh = false;
      if (candles[j].low < low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ idx: i, t: cur.t, price: safeNum(high), type: 'H' });
    else if (isLow) pivots.push({ idx: i, t: cur.t, price: safeNum(low), type: 'L' });
  }
  // Compress close pivots same direction (keep most extreme)
  const out = [];
  for (const p of pivots) {
    const lastp = out.at(-1);
    if (!lastp) { out.push(p); continue; }
    if (lastp.type === p.type && Math.abs(p.idx - lastp.idx) <= Math.max(left, right)) {
      // pick the more extreme (higher high or lower low)
      if (p.type === 'H' && p.price > lastp.price) out[out.length - 1] = p;
      if (p.type === 'L' && p.price < lastp.price) out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

// ----------------------
// WAVES (simple mapping)
// ----------------------
function mapWavesFromPivots(pivots) {
  // Waves are consecutive pivot moves: pivot[i] -> pivot[i+1]
  const waves = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i];
    const b = pivots[i + 1];
    const dir = (a.price < b.price) ? 'UP' : 'DOWN';
    waves.push({
      from: a.idx, to: b.idx,
      start: a.price, end: b.price,
      direction: dir,
      range: Math.abs(b.price - a.price),
      pct: (a.price ? Math.abs((b.price - a.price) / a.price) * 100 : 0)
    });
  }
  return waves;
}

// ----------------------
// ATR
// ----------------------
function computeATR(candles, length=14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i-1];
    const tr = Math.max(
      safeNum(cur.high) - safeNum(cur.low),
      Math.abs(safeNum(cur.high) - safeNum(prev.close)),
      Math.abs(safeNum(cur.low) - safeNum(prev.close))
    );
    trs.push(tr);
  }
  const slice = trs.slice(-length);
  const atr = slice.reduce((a,b)=>a+b,0)/Math.max(1,slice.length);
  return Number(atr.toFixed(6));
}

// ----------------------
// FIB LEVELS
// ----------------------
function fibLevelsFromSwing(low, high) {
  const diff = high - low;
  return {
    lo: low, hi: high,
    retrace: {
      '0.236': Number((high - diff*0.236).toFixed(6)),
      '0.382': Number((high - diff*0.382).toFixed(6)),
      '0.5': Number((high - diff*0.5).toFixed(6)),
      '0.618': Number((high - diff*0.618).toFixed(6)),
      '0.786': Number((high - diff*0.786).toFixed(6))
    },
    ext: {
      '1.272': Number((high + diff*0.272).toFixed(6)),
      '1.618': Number((high + diff*0.618).toFixed(6))
    }
  };
}

// ----------------------
// HEAD & SHOULDERS detection
// ----------------------
function detectHeadAndShoulders(pivots) {
  // Look for pattern: H - L - H - L - H  (for H&S top)
  // pivots: sequence of H/L alternating. We'll search triplets of three highs with lows between.
  const patterns = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const a = pivots[i], b = pivots[i+1], c = pivots[i+2], d = pivots[i+3], e = pivots[i+4];
    if (a.type === 'H' && b.type === 'L' && c.type === 'H' && d.type === 'L' && e.type === 'H') {
      // potential H&S top: left shoulder (a), head (c), right shoulder (e)
      // Neckline between lows b and d
      const neck = (b.price + d.price) / 2;
      const headHigher = c.price > a.price && c.price > e.price;
      if (!headHigher) continue;
      // Confidence: how symmetric shoulders are and head prominence
      const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price)/2));
      const headProm = (c.price - Math.max(a.price,e.price)) / Math.max(1, c.price);
      const confidence = Math.max(0, Math.min(1, (shoulderSym*0.5 + headProm*0.5)));
      const target = neck - (c.price - neck); // target measured move
      patterns.push({
        type: 'HeadAndShoulders',
        side: 'Bearish',
        pivots: [a,b,c,d,e].map(p=>({idx:p.idx, t:p.t, price:p.price, type:p.type})),
        neckline: neck,
        target,
        confidence: Number((confidence*100).toFixed(1))
      });
    }
    // Inverse H&S (bottom)
    if (a.type === 'L' && b.type === 'H' && c.type === 'L' && d.type === 'H' && e.type === 'L') {
      const neck = (b.price + d.price) / 2;
      const headLower = c.price < a.price && c.price < e.price;
      if (!headLower) continue;
      const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price)/2));
      const headProm = (Math.min(a.price,e.price) - c.price) / Math.max(1, Math.min(a.price,e.price));
      const confidence = Math.max(0, Math.min(1, (shoulderSym*0.5 + headProm*0.5)));
      const target = neck + (neck - c.price);
      patterns.push({
        type: 'InverseHeadAndShoulders',
        side: 'Bullish',
        pivots: [a,b,c,d,e].map(p=>({idx:p.idx, t:p.t, price:p.price, type:p.type})),
        neckline: neck,
        target,
        confidence: Number((confidence*100).toFixed(1))
      });
    }
  }
  return patterns;
}

// ----------------------
// DOUBLE TOP / BOTTOM
// ----------------------
function detectDoubleTopsBottoms(pivots) {
  const patterns = [];
  for (let i = 0; i < pivots.length - 2; i++) {
    const a = pivots[i], b = pivots[i+1], c = pivots[i+2];
    // Double Top: H-L-H with similar highs
    if (a.type === 'H' && b.type === 'L' && c.type === 'H') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price)/2);
      if (closeness > 0.94) { // 6% tolerance
        const neckline = b.price;
        const height = Math.abs(a.price - neckline);
        const target = neckline - height;
        patterns.push({
          type: 'DoubleTop',
          side: 'Bearish',
          pivots: [a,b,c].map(p=>({idx:p.idx, price:p.price, type:p.type})),
          neckline,
          target,
          confidence: Number((closeness*100).toFixed(1))
        });
      }
    }
    // Double Bottom
    if (a.type === 'L' && b.type === 'H' && c.type === 'L') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price)/2);
      if (closeness > 0.94) {
        const neckline = b.price;
        const height = Math.abs(neckline - a.price);
        const target = neckline + height;
        patterns.push({
          type: 'DoubleBottom',
          side: 'Bullish',
          pivots: [a,b,c].map(p=>({idx:p.idx, price:p.price, type:p.type})),
          neckline,
          target,
          confidence: Number((closeness*100).toFixed(1))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// TRIANGLE DETECTOR (simple regression via endpoints)
// ----------------------
function detectTriangles(pivots) {
  // We'll search sequences of 4-8 pivots that form tightening highs/lows
  const patterns = [];
  for (let start = 0; start < pivots.length - 4; start++) {
    for (let len = 4; len <= 8 && start + len <= pivots.length; len++) {
      const seq = pivots.slice(start, start + len);
      // Need alternating types roughly
      const highs = seq.filter(p=>p.type==='H').map(p=>p.price);
      const lows = seq.filter(p=>p.type==='L').map(p=>p.price);
      if (highs.length < 2 || lows.length < 2) continue;
      // Check contraction: highs decreasing, lows increasing
      const highsTrend = highs[0] - highs.at(-1); // positive if contracted downward
      const lowsTrend = lows.at(-1) - lows[0]; // positive if contracted upward
      if (highsTrend > Math.max( (highs[0]*0.002),  (Math.abs(highs[0])*0.001)) && lowsTrend > Math.max((lows[0]*0.002),(Math.abs(lows[0])*0.001))) {
        // determine type
        const firstHigh = seq.find(p=>p.type==='H').price;
        const lastHigh = [...seq].reverse().find(p=>p.type==='H').price;
        const firstLow = seq.find(p=>p.type==='L').price;
        const lastLow = [...seq].reverse().find(p=>p.type==='L').price;
        const highSlope = lastHigh - firstHigh; // negative -> descending
        const lowSlope = lastLow - firstLow; // positive -> ascending
        let triType = 'Symmetrical';
        if (highSlope < 0 && lowSlope > 0) triType = 'Symmetrical';
        else if (highSlope < 0 && lowSlope <= 0) triType = 'Descending';
        else if (highSlope >= 0 && lowSlope > 0) triType = 'Ascending';
        // confidence proportional to contraction ratio
        const contraction = ( (highs[0]-highs.at(-1)) + (lows.at(-1)-lows[0]) ) / (Math.max(1, Math.abs(highs[0]) + Math.abs(lows[0])));
        patterns.push({
          type: 'Triangle',
          triType,
          pivots: seq.map(p=>({idx:p.idx, price:p.price, type:p.type})),
          contraction: Number((contraction*100).toFixed(1)),
          confidence: Math.min(99, Math.max(30, Math.round(contraction*100)))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// CHANNEL DETECTION (linear regression endpoints)
// ----------------------
function detectChannels(pivots) {
  // Build simple channels by pairing consecutive highs and lows and computing slope
  const channels = [];
  // Use sliding window of last 8-20 pivots
  const seqLen = Math.min(20, pivots.length);
  if (seqLen < 6) return channels;
  const seq = pivots.slice(-seqLen);
  const highs = seq.filter(p=>p.type==='H');
  const lows = seq.filter(p=>p.type==='L');
  if (highs.length < 2 || lows.length < 2) return channels;
  // compute linear regression slope for highs and lows using indices
  const fit = (pts) => {
    const n = pts.length;
    const xs = pts.map((p,i)=>i);
    const ys = pts.map(p=>p.price);
    const xmean = xs.reduce((a,b)=>a+b,0)/n;
    const ymean = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    for (let i=0;i<n;i++){ num += (xs[i]-xmean)*(ys[i]-ymean); den += (xs[i]-xmean)**2; }
    const slope = den===0?0:num/den;
    const intercept = ymean - slope * xmean;
    return { slope, intercept };
  };
  const highFit = fit(highs);
  const lowFit = fit(lows);
  const width = highs.reduce((a,b)=>a + Math.abs(b.price - (lowFit.slope*(highs.indexOf(b)) + lowFit.intercept)),0)/Math.max(1,highs.length);
  channels.push({
    type: 'RegressionChannel',
    highFit, lowFit,
    width: Number(width.toFixed(6)),
    confidence: Math.min(99, Math.round(100 - (width / (Math.abs(lowFit.intercept||1)) * 100)))
  });
  return channels;
}

// ----------------------
// HARMONIC PATTERNS (approximate)
// ----------------------
function detectHarmonics(candles) {
  // We'll look for X-A-B-C-D patterns in last 40 candles using pivot finder
  const pivots = findPivots(candles, 3, 3);
  const patterns = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const X = pivots[i], A = pivots[i+1], B = pivots[i+2], C = pivots[i+3], D = pivots[i+4];
    // Only consider alternating types X-A-B-C-D
    if (!X || !A || !B || !C || !D) continue;
    // distances
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);
    const ratio = (a,b)=> b===0?0: Math.abs(a/b);
    // Basic Gartley: AB ~ 0.618 XA, BC ~ 0.382-0.886 AB, CD ~ 1.27-1.618 XA (approx)
    const ab_xa = ratio(AB, XA);
    const bc_ab = ratio(BC, AB);
    const cd_xa = ratio(CD, XA);
    const gartley = ab_xa >= 0.55 && ab_xa <= 0.68 && bc_ab >= 0.38 && bc_ab <= 0.886 && cd_xa >= 0.95 && cd_xa <= 1.05;
    const bat = ab_xa >= 0.38 && ab_xa <= 0.5 && bc_ab >= 0.382 && bc_ab <= 0.886 && cd_xa >= 1.618 && cd_xa <= 2.618;
    const crab = ab_xa >= 0.382 && ab_xa <= 0.618 && cd_xa >= 2.0 && cd_xa <= 3.618;
    if (gartley || bat || crab) {
      patterns.push({
        type: gartley ? 'Gartley' : bat ? 'Bat' : 'Crab',
        side: D.price > C.price ? 'Bullish' : 'Bearish',
        pivots: [X,A,B,C,D].map(p=>({idx:p.idx, price:p.price, type:p.type})),
        ratios: { ab_xa: Number(ab_xa.toFixed(3)), bc_ab: Number(bc_ab.toFixed(3)), cd_xa: Number(cd_xa.toFixed(3)) },
        confidence: Math.round( ( (gartley?0.9:0.6) + (1 - Math.abs(ab_xa - (gartley?0.618: (bat?0.45:2))))*0.1 )*100 )
      });
    }
  }
  return patterns;
}

// ----------------------
// ORDER BLOCKS & FVG (heuristic)
// ----------------------
function detectOrderBlocksAndFVG(candles) {
  // Order block: large directional candle followed by consolidation then continuation
  // Fair Value Gap: three-candle gap where body/wick leaves a gap
  const orderBlocks = [];
  const fvgs = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const prev = candles[i-2], cur = candles[i-1], next = candles[i];
    // big candle
    const sizePrev = Math.abs(prev.close - prev.open);
    const sizeCur = Math.abs(cur.close - cur.open);
    const sizeNext = Math.abs(next.close - next.open);
    // Order block detection (basic): big candle followed by smaller candles then continuation in same dir
    const big = Math.max(sizePrev, sizeCur, sizeNext);
    if (sizePrev >= big*0.75 && sizePrev > 0) {
      const dir = prev.close > prev.open ? 'Bull' : 'Bear';
      const continuation = (next.close > next.open && dir==='Bull') || (next.close < next.open && dir==='Bear');
      if (continuation) {
        orderBlocks.push({
          type: 'OrderBlock',
          idx: i-2,
          side: dir === 'Bull' ? 'Bullish' : 'Bearish',
          levelHigh: Math.max(prev.open, prev.close),
          levelLow: Math.min(prev.open, prev.close),
          confidence: 60 + Math.min(39, Math.round( (sizePrev / Math.max(1, sizeCur + sizeNext)) * 20 ))
        });
      }
    }
    // Fair Value Gap: gap between candles (body gap)
    const gapHigh = Math.min(prev.open, prev.close);
    const gapLow = Math.max(next.open, next.close);
    if (gapHigh > gapLow) {
      fvgs.push({
        type: 'FVG',
        idx: i-1,
        top: gapHigh,
        bottom: gapLow,
        width: Number((gapHigh - gapLow).toFixed(6))
      });
    }
  }
  return { orderBlocks, fvgs };
}

// ----------------------
// Swing Failure Pattern (SFP) detection
// ----------------------
function detectSFP(candles, pivots) {
  // SFP: price briefly breaks structure then reverses (wick fails)
  const sfps = [];
  for (let i = 1; i < pivots.length - 1; i++) {
    const p = pivots[i];
    // check if previous pivot sets a structure and p is extreme wick beyond it then reversal
    const prev = pivots[i-1], next = pivots[i+1];
    if (!prev || !next) continue;
    // Example: bullish SFP = low pushes below prior low but closes above
    if (p.type === 'L') {
      const candle = candles[p.idx];
      const lowerThanPrev = p.price < prev.price;
      const closedAbove = candle.close > candle.open; // bullish close
      if (lowerThanPrev && closedAbove) {
        sfps.push({ type: 'BullishSFP', pivotIdx: p.idx, pivotPrice: p.price });
      }
    }
    if (p.type === 'H') {
      const candle = candles[p.idx];
      const higherThanPrev = p.price > prev.price;
      const closedBelow = candle.close < candle.open; // bearish close
      if (higherThanPrev && closedBelow) {
        sfps.push({ type: 'BearishSFP', pivotIdx: p.idx, pivotPrice: p.price });
      }
    }
  }
  return sfps;
}

// ----------------------
// Market Structure Breaks (BOS / CHoCH)
// ----------------------
function detectMarketStructure(candles, pivots) {
  // Basic approach: compare latest pivots with previous structure
  const ms = [];
  if (pivots.length < 4) return ms;
  const lastPivot = pivots.at(-1);
  const prevHighs = pivots.filter(p=>p.type==='H').slice(-3).map(p=>p.price);
  const prevLows = pivots.filter(p=>p.type==='L').slice(-3).map(p=>p.price);

  // BOS up: higher high higher low sequence broken upwards
  const hh = Math.max(...prevHighs);
  const ll = Math.min(...prevLows);
  const price = candles.at(-1).close;
  if (price > hh) ms.push({ type: 'BOS', side: 'Bullish', price });
  if (price < ll) ms.push({ type: 'BOS', side: 'Bearish', price });

  // CHoCH detection (change of character): quick reversal crossing recent structure
  // If last pivot direction flips and new pivot crosses mid-range
  const lastTwo = pivots.slice(-3);
  if (lastTwo.length >= 3) {
    const a = lastTwo[0], b = lastTwo[1], c = lastTwo[2];
    if (a.type !== c.type) {
      // cross detection
      if (c.type === 'H' && c.price < b.price) ms.push({ type: 'CHoCH', side: 'Bearish', info: { a,b,c }});
      if (c.type === 'L' && c.price > b.price) ms.push({ type: 'CHoCH', side: 'Bullish', info: { a,b,c }});
    }
  }

  return ms;
}

// ----------------------
// TP/SL generator (fixed ordering & side-aware)
// ----------------------

function generateTargets({ price, atr, patterns = [], fib = null, channels = [], orderBlocks = [] }) {
  // Combine pattern targets (if present) and ATR/fib fallback
  const rawTps = [];
  const rawSls = [];

  // pattern-based (collect)
  (patterns || []).forEach(p => {
    if (p.target == null) return;
    const tp = Number(p.target);
    const side = (p.side === 'Bullish') ? 'BUY' : (p.side === 'Bearish' ? 'SELL' : 'BOTH');

    // SL: use neckline/structure +/- ATR if available
    let sl = null;
    if (p.type === 'HeadAndShoulders' || p.type === 'InverseHeadAndShoulders') {
      // use neckline +/- ATR (use pivot center)
      sl = p.side === 'Bullish' ? (p.pivots[2].price - (atr * 1.2)) : (p.pivots[2].price + (atr * 1.2));
    } else {
      sl = p.side === 'Bullish'
        ? Math.min(...p.pivots.map(x => x.price)) - (atr * 1.5)
        : Math.max(...p.pivots.map(x => x.price)) + (atr * 1.5);
    }

    rawTps.push({ source: p.type, side, tp: Number(tp), confidence: p.confidence || 50 });
    rawSls.push({ source: p.type, side, sl: Number(sl), confidence: p.confidence || 50 });
  });

  // harmonics/fib/ATR fallback if no pattern TPs
  if (!rawTps.length) {
    if (fib && fib.ext) {
      rawTps.push({ source: 'FIB_1.272', side: 'BOTH', tp: Number(fib.ext['1.272']) });
      rawTps.push({ source: 'FIB_1.618', side: 'BOTH', tp: Number(fib.ext['1.618']) });
      rawSls.push({ source: 'ATR_SL', side: 'BOTH', sl: Number(price - atr * 2) });
    } else {
      rawTps.push({ source: 'ATR_MULT', side: 'BOTH', tp: Number(price + atr * 3) });
      rawSls.push({ source: 'ATR_SL', side: 'BOTH', sl: Number(price - atr * 2) });
    }
  }

  // orderblock based nearest levels
  if (orderBlocks && orderBlocks.length) {
    orderBlocks.slice(-3).forEach(ob => {
      const tpVal = ob.side === 'Bullish' ? (ob.levelHigh + atr * 2) : (ob.levelLow - atr * 2);
      rawTps.push({ source: 'OrderBlock', side: ob.side === 'Bullish' ? 'BUY' : 'SELL', tp: Number(tpVal), confidence: ob.confidence || 50 });
    });
  }

  // Dedupe by exact numeric value (keep last occurrence)
  const tpMap = new Map(); // key -> tpObj
  for (const r of rawTps) tpMap.set(Number(r.tp).toFixed(6), r);
  const deduped = Array.from(tpMap.values());

  // Partition by side to sort properly relative to price
  const bullish = deduped.filter(x => x.side === 'BUY');
  const bearish = deduped.filter(x => x.side === 'SELL');
  const both = deduped.filter(x => x.side === 'BOTH');

  // Helper: distance
  const dist = (v) => Math.abs(Number(v) - Number(price || 0));

  // For bullish: keep only tps > price (if none, keep all and sort by distance)
  function sortBull(list) {
    const above = list.filter(x => Number(x.tp) > Number(price));
    if (above.length) return above.sort((a,b) => Number(a.tp) - Number(b.tp)); // ascending -> nearest above first
    return list.sort((a,b) => dist(a.tp) - dist(b.tp)); // fallback
  }

  // For bearish: keep only tps < price (if none, keep all and sort by distance)
  function sortBear(list) {
    const below = list.filter(x => Number(x.tp) < Number(price));
    if (below.length) return below.sort((a,b) => Number(b.tp) - Number(a.tp)); // descending -> nearest below first
    return list.sort((a,b) => dist(a.tp) - dist(b.tp)); // fallback
  }

  // For BOTH: sort by absolute distance (closest first)
  function sortBoth(list) {
    return list.sort((a,b) => dist(a.tp) - dist(b.tp));
  }

  const sortedTps = [
    ...sortBull(bullish),
    ...sortBear(bearish),
    ...sortBoth(both)
  ];

  // final formatting: attach rank (TP1, TP2...) and round numbers to sensible decimals
  const targets = sortedTps.map((t, idx) => ({
    rank: idx + 1,
    source: t.source,
    side: t.side,
    tp: Number(Number(t.tp).toFixed(2)),
    confidence: t.confidence || null,
    distance: Number(dist(t.tp).toFixed(2))
  }));

  // dedupe stops (keep last for same rounded SL)
  const slMap = new Map();
  for (const s of rawSls) {
    if (s.sl == null) continue;
    slMap.set(Number(s.sl).toFixed(6), s);
  }
  const stops = Array.from(slMap.values()).map(s => ({
    source: s.source,
    side: s.side,
    sl: Number(Number(s.sl).toFixed(2)),
    confidence: s.confidence || null
  }));

  return { targets, stops };
}


// ----------------------
// SCORING & SENTIMENT
// ----------------------
function scoreEverything({ patterns=[], harmonics=[], channels=[], sfps=[], ms=[] }) {
  let score = 0;
  let weight = 0;
  // patterns
  patterns.forEach(p => { score += (p.confidence || 50) * (p.side === 'Bullish' ? 1 : -1); weight += 100; });
  harmonics.forEach(h => { score += (h.confidence || 50) * (h.side === 'Bullish' ? 1 : -1); weight += 80; });
  channels.forEach(c => { score += (c.confidence || 50) * (c.highFit && c.lowFit ? 0 : 10); weight += 40; });
  sfps.forEach(s => { score += s.type === 'BullishSFP' ? 30 : -30; weight += 30; });
  ms.forEach(m => { score += m.side === 'Bullish' ? 40 : -40; weight += 40; });
  if (weight === 0) return { sentiment: 0, confidence: 30 };
  const sentiment = Math.max(-1, Math.min(1, score / (weight)));
  const confidence = Math.min(99, Math.max(10, Math.round(Math.abs(score) / Math.max(1, weight) * 200)));
  return { sentiment: Number(sentiment.toFixed(3)), confidence };
}

// ----------------------
// MAIN: analyzeElliott
// ----------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!Array.isArray(candles) || !candles.length) return { ok:false, error: 'no_data' };
    // parameters
    const left = opts.pivotLeft || 3, right = opts.pivotRight || 3;
    const pivots = findPivots(candles, left, right);
    const waves = mapWavesFromPivots(pivots);
    const atr = computeATR(candles, opts.atrPeriod || 14);
    // major swing for fib (use last 20 pivots)
    const majorHigh = Math.max(...candles.slice(-200).map(c=>c.high));
    const majorLow = Math.min(...candles.slice(-200).map(c=>c.low));
    const fib = fibLevelsFromSwing(majorLow, majorHigh);

    // detect patterns
    const hns = detectHeadAndShoulders(pivots);
    const dt = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const harmonics = detectHarmonics(candles);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms = detectMarketStructure(candles, pivots);

    const patterns = [...hns, ...dt, ...tri];
    const targetsObj = generateTargets({
      price: safeNum(last(candles)?.close || 0),
      atr,
      patterns,
      fib,
      channels: ch,
      orderBlocks
    });

    const scoring = scoreEverything({ patterns, harmonics, channels: ch, sfps, ms });

    return {
      ok: true,
      version: 'elliott_module_v1.0',
      pivots,
      waves,
      atr: Number(atr.toFixed(6)),
      fib,
      patterns,
      harmonics,
      channels: ch,
      orderBlocks,
      fvgs,
      sfps,
      marketStructure: ms,
      targets: targetsObj.targets,
      stops: targetsObj.stops,
      sentiment: scoring.sentiment,
      confidence: scoring.confidence,
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    return { ok:false, error: e?.message || 'err' };
  }
}

// default export
export default {
  analyzeElliott,
  // Exports for unit tests / reuse
  findPivots,
  mapWavesFromPivots,
  computeATR,
  fibLevelsFromSwing,
  detectHeadAndShoulders,
  detectDoubleTopsBottoms,
  detectTriangles,
  detectChannels,
  detectHarmonics,
  detectOrderBlocksAndFVG,
  detectSFP,
  detectMarketStructure,
  generateTargets,
  scoreEverything
};