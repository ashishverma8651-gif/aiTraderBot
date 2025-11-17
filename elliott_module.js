// elliott_module_v2.js — Elliott + Pattern Engine (v2.0) — Drop-in replacement
// Exports: analyzeElliott(candles, opts)
// Keeps backwards-compatible output: { ok, pivots, waves, patterns, harmonics, channels, fib, atr, targets, stops, sentiment, confidence, ... }

function safeNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function last(arr, n = 1){ return (Array.isArray(arr) && arr.length) ? arr[arr.length - n] : null; }

// ----------------------
// PIVOT / ZIGZAG (improved, stable alternate)
function findPivots(candles, left = 3, right = 3) {
  const n = (Array.isArray(candles) ? candles.length : 0);
  if (n < left + right + 1) return [];

  const raw = [];
  for (let i = left; i < n - right; i++) {
    const cur = candles[i];
    const high = safeNum(cur.high);
    const low = safeNum(cur.low);
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      const h = safeNum(candles[j].high);
      const l = safeNum(candles[j].low);
      if (h > high) isHigh = false;
      if (l < low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) raw.push({ idx: i, t: cur.t, price: high, type: 'H' });
    else if (isLow) raw.push({ idx: i, t: cur.t, price: low, type: 'L' });
  }

  // compress near-duplicates keeping most extreme
  const compressed = [];
  for (const p of raw) {
    const lastp = compressed.at(-1);
    if (!lastp) { compressed.push(p); continue; }
    if (lastp.type === p.type && Math.abs(p.idx - lastp.idx) <= Math.max(left, right)) {
      if (p.type === 'H' && p.price > lastp.price) compressed[compressed.length - 1] = p;
      else if (p.type === 'L' && p.price < lastp.price) compressed[compressed.length - 1] = p;
      // else keep existing
    } else compressed.push(p);
  }

  // force alternation H-L-H-L, choosing the more extreme in case of same-type adjacency
  const folded = [];
  for (const p of compressed) {
    const lastp = folded.at(-1);
    if (!lastp) { folded.push(p); continue; }
    if (lastp.type === p.type) {
      // replace by more extreme
      if (p.type === 'H') {
        if (p.price > lastp.price) folded[folded.length - 1] = p;
      } else {
        if (p.price < lastp.price) folded[folded.length - 1] = p;
      }
    } else folded.push(p);
  }

  return folded;
}

// ----------------------
// WAVES
function mapWavesFromPivots(pivots) {
  const waves = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i], b = pivots[i + 1];
    if (!a || !b) continue;
    const dir = (a.price < b.price) ? 'UP' : 'DOWN';
    waves.push({
      from: a.idx, to: b.idx,
      start: a.price, end: b.price,
      direction: dir,
      range: Math.abs(b.price - a.price),
      pct: a.price ? Math.abs((b.price - a.price) / a.price) * 100 : 0
    });
  }
  return waves;
}

// ----------------------
// ATR (standard)
function computeATR(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const tr = Math.max(
      safeNum(cur.high) - safeNum(cur.low),
      Math.abs(safeNum(cur.high) - safeNum(prev.close)),
      Math.abs(safeNum(cur.low) - safeNum(prev.close))
    );
    trs.push(tr);
  }
  const slice = trs.slice(-length);
  const atr = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
  return Number(atr);
}

// ----------------------
// FIB LEVELS (both directions)
function fibLevelsFromSwing(low, high) {
  const lo = safeNum(low);
  const hi = safeNum(high);
  // ensure hi > lo
  const hiReal = Math.max(lo, hi);
  const loReal = Math.min(lo, hi);
  const diff = Math.max(1e-9, hiReal - loReal);
  return {
    lo: loReal,
    hi: hiReal,
    retrace: {
      '0.236': Number((hiReal - diff * 0.236).toFixed(6)),
      '0.382': Number((hiReal - diff * 0.382).toFixed(6)),
      '0.5': Number((hiReal - diff * 0.5).toFixed(6)),
      '0.618': Number((hiReal - diff * 0.618).toFixed(6)),
      '0.786': Number((hiReal - diff * 0.786).toFixed(6))
    },
    ext: {
      '1.272': Number((hiReal + diff * 0.272).toFixed(6)),
      '1.618': Number((hiReal + diff * 0.618).toFixed(6)),
      // also project bearish ext symmetric (below lo)
      '1.272_bear': Number((loReal - diff * 0.272).toFixed(6)),
      '1.618_bear': Number((loReal - diff * 0.618).toFixed(6))
    }
  };
}

// ----------------------
// HEAD & SHOULDERS detection
function detectHeadAndShoulders(pivots) {
  const patterns = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const a = pivots[i], b = pivots[i+1], c = pivots[i+2], d = pivots[i+3], e = pivots[i+4];
    if (!a || !b || !c || !d || !e) continue;

    // H&S top
    if (a.type === 'H' && b.type === 'L' && c.type === 'H' && d.type === 'L' && e.type === 'H') {
      const neck = (b.price + d.price) / 2;
      const headHigher = c.price > a.price && c.price > e.price;
      if (headHigher) {
        const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price) / 2));
        const headProm = (c.price - Math.max(a.price, e.price)) / Math.max(1, c.price);
        const confidence = Math.max(0, Math.min(1, (shoulderSym * 0.6 + headProm * 0.4)));
        const target = neck - (c.price - neck);
        patterns.push({
          type: 'HeadAndShoulders',
          side: 'Bearish',
          pivots: [a,b,c,d,e].map(p=>({ idx: p.idx, t: p.t, price: p.price, type: p.type })),
          neckline: neck,
          target,
          confidence: Number((confidence * 100).toFixed(1))
        });
      }
    }

    // Inverse H&S bottom
    if (a.type === 'L' && b.type === 'H' && c.type === 'L' && d.type === 'H' && e.type === 'L') {
      const neck = (b.price + d.price) / 2;
      const headLower = c.price < a.price && c.price < e.price;
      if (headLower) {
        const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price) / 2));
        const headProm = (Math.min(a.price, e.price) - c.price) / Math.max(1, Math.min(a.price, e.price));
        const confidence = Math.max(0, Math.min(1, (shoulderSym * 0.6 + headProm * 0.4)));
        const target = neck + (neck - c.price);
        patterns.push({
          type: 'InverseHeadAndShoulders',
          side: 'Bullish',
          pivots: [a,b,c,d,e].map(p=>({ idx: p.idx, t: p.t, price: p.price, type: p.type })),
          neckline: neck,
          target,
          confidence: Number((confidence * 100).toFixed(1))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// DOUBLE TOP / BOTTOM
function detectDoubleTopsBottoms(pivots) {
  const patterns = [];
  for (let i = 0; i < pivots.length - 2; i++) {
    const a = pivots[i], b = pivots[i + 1], c = pivots[i + 2];
    if (!a || !b || !c) continue;
    if (a.type === 'H' && b.type === 'L' && c.type === 'H') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price) / 2);
      if (closeness > 0.86) { // tolerant
        const neckline = b.price;
        const height = Math.abs(a.price - neckline);
        const target = neckline - height;
        patterns.push({
          type: 'DoubleTop',
          side: 'Bearish',
          pivots: [a,b,c].map(p=>({ idx: p.idx, price: p.price, type: p.type })),
          neckline,
          target,
          confidence: Number((closeness * 100).toFixed(1))
        });
      }
    }
    if (a.type === 'L' && b.type === 'H' && c.type === 'L') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price) / 2);
      if (closeness > 0.86) {
        const neckline = b.price;
        const height = Math.abs(neckline - a.price);
        const target = neckline + height;
        patterns.push({
          type: 'DoubleBottom',
          side: 'Bullish',
          pivots: [a,b,c].map(p=>({ idx: p.idx, price: p.price, type: p.type })),
          neckline,
          target,
          confidence: Number((closeness * 100).toFixed(1))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// TRIANGLES (improved tolerance)
function detectTriangles(pivots) {
  const patterns = [];
  for (let start = 0; start < pivots.length - 4; start++) {
    for (let len = 4; len <= 8 && start + len <= pivots.length; len++) {
      const seq = pivots.slice(start, start + len);
      const highs = seq.filter(p => p.type === 'H').map(p => p.price);
      const lows = seq.filter(p => p.type === 'L').map(p => p.price);
      if (highs.length < 2 || lows.length < 2) continue;
      const highsTrend = highs[0] - highs.at(-1);
      const lowsTrend = lows.at(-1) - lows[0];
      if (highsTrend > Math.max((highs[0] * 0.001), (Math.abs(highs[0]) * 0.0008)) &&
          lowsTrend > Math.max((lows[0] * 0.001), (Math.abs(lows[0]) * 0.0008))) {
        const firstHigh = seq.find(p => p.type === 'H').price;
        const lastHigh = [...seq].reverse().find(p => p.type === 'H').price;
        const firstLow = seq.find(p => p.type === 'L').price;
        const lastLow = [...seq].reverse().find(p => p.type === 'L').price;
        const highSlope = lastHigh - firstHigh;
        const lowSlope = lastLow - firstLow;
        let triType = 'Symmetrical';
        if (highSlope < 0 && lowSlope > 0) triType = 'Symmetrical';
        else if (highSlope < 0 && lowSlope <= 0) triType = 'Descending';
        else if (highSlope >= 0 && lowSlope > 0) triType = 'Ascending';
        const contraction = ((highs[0] - highs.at(-1)) + (lows.at(-1) - lows[0])) / Math.max(1, Math.abs(highs[0]) + Math.abs(lows[0]));
        patterns.push({
          type: 'Triangle',
          triType,
          pivots: seq.map(p => ({ idx: p.idx, price: p.price, type: p.type })),
          contraction: Number((contraction * 100).toFixed(1)),
          confidence: Math.min(99, Math.max(25, Math.round(contraction * 100)))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// CHANNEL DETECTION
function detectChannels(pivots) {
  const channels = [];
  const seqLen = Math.min(20, pivots.length);
  if (seqLen < 6) return channels;
  const seq = pivots.slice(-seqLen);
  const highs = seq.filter(p => p.type === 'H');
  const lows = seq.filter(p => p.type === 'L');
  if (highs.length < 2 || lows.length < 2) return channels;

  const fit = (pts) => {
    const n = pts.length;
    const xs = pts.map((p, i) => i);
    const ys = pts.map(p => p.price);
    const xmean = xs.reduce((a,b)=>a+b,0)/n;
    const ymean = ys.reduce((a,b)=>a+b,0)/n;
    let num = 0, den = 0;
    for (let i=0;i<n;i++){ num += (xs[i]-xmean)*(ys[i]-ymean); den += (xs[i]-xmean)**2; }
    const slope = den === 0 ? 0 : num / den;
    const intercept = ymean - slope * xmean;
    return { slope, intercept };
  };

  const highFit = fit(highs);
  const lowFit = fit(lows);
  // channel width approximate
  let width = 0;
  for (let i = 0; i < highs.length; i++) {
    const p = highs[i];
    const estimateLowAtI = lowFit.slope * i + lowFit.intercept;
    width += Math.abs(p.price - estimateLowAtI);
  }
  width = width / Math.max(1, highs.length);

  channels.push({
    type: 'RegressionChannel',
    highFit, lowFit,
    width: Number(width.toFixed(6)),
    confidence: Math.min(99, Math.max(20, Math.round(100 - (width / (Math.abs(lowFit.intercept || 1)) * 100))))
  });
  return channels;
}

// ----------------------
// HARMONICS (tolerant)
function detectHarmonics(candles) {
  const pivots = findPivots(candles, 3, 3);
  const patterns = [];
  for (let i = 0; i < pivots.length - 4; i++) {
    const X = pivots[i], A = pivots[i+1], B = pivots[i+2], C = pivots[i+3], D = pivots[i+4];
    if (!X || !A || !B || !C || !D) continue;
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);
    const ratio = (a,b)=> b === 0 ? 0 : Math.abs(a/b);
    const ab_xa = ratio(AB, XA);
    const bc_ab = ratio(BC, AB);
    const cd_xa = ratio(CD, XA);
    const gartley = ab_xa >= 0.52 && ab_xa <= 0.7 && bc_ab >= 0.34 && bc_ab <= 0.9 && cd_xa >= 0.9 && cd_xa <= 1.12;
    const bat = ab_xa >= 0.36 && ab_xa <= 0.54 && bc_ab >= 0.36 && bc_ab <= 0.9 && cd_xa >= 1.5 && cd_xa <= 2.8;
    const crab = ab_xa >= 0.35 && ab_xa <= 0.65 && cd_xa >= 1.8 && cd_xa <= 3.8;
    if (gartley || bat || crab) {
      const side = D.price > C.price ? 'Bullish' : 'Bearish';
      patterns.push({
        type: gartley ? 'Gartley' : bat ? 'Bat' : 'Crab',
        side,
        pivots: [X,A,B,C,D].map(p => ({ idx: p.idx, price: p.price, type: p.type })),
        ratios: { ab_xa: Number(ab_xa.toFixed(3)), bc_ab: Number(bc_ab.toFixed(3)), cd_xa: Number(cd_xa.toFixed(3)) },
        confidence: Math.min(99, Math.max(30, Math.round(( (gartley?0.95:0.7) - Math.abs(ab_xa - (gartley?0.618: (bat?0.45:2))) ) * 100 )))
      });
    }
  }
  return patterns;
}

// ----------------------
// ORDER BLOCKS & FVG (improved numeric safety)
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const prev = candles[i-2], cur = candles[i-1], next = candles[i];
    if (!prev || !cur || !next) continue;
    const sizePrev = Math.abs(safeNum(prev.close) - safeNum(prev.open));
    const sizeCur = Math.abs(safeNum(cur.close) - safeNum(cur.open));
    const sizeNext = Math.abs(safeNum(next.close) - safeNum(next.open));
    const big = Math.max(sizePrev, sizeCur, sizeNext, 1e-9);
    if (sizePrev >= big * 0.7 && sizePrev > 0) {
      const dir = safeNum(prev.close) > safeNum(prev.open) ? 'Bull' : 'Bear';
      const continuation = (safeNum(next.close) > safeNum(next.open) && dir === 'Bull') || (safeNum(next.close) < safeNum(next.open) && dir === 'Bear');
      if (continuation) {
        orderBlocks.push({
          type: 'OrderBlock',
          idx: i-2,
          side: dir === 'Bull' ? 'Bullish' : 'Bearish',
          levelHigh: Math.max(safeNum(prev.open), safeNum(prev.close)),
          levelLow: Math.min(safeNum(prev.open), safeNum(prev.close)),
          confidence: Math.min(99, Math.max(30, 50 + Math.min(49, Math.round((sizePrev / Math.max(1, sizeCur + sizeNext)) * 50)))))
        );
      }
    }
    // FVG: body gap check
    const gapHigh = Math.min(safeNum(prev.open), safeNum(prev.close));
    const gapLow = Math.max(safeNum(next.open), safeNum(next.close));
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
// SFP detection
function detectSFP(candles, pivots) {
  const sfps = [];
  for (let i = 1; i < pivots.length - 1; i++) {
    const p = pivots[i];
    const prev = pivots[i-1], next = pivots[i+1];
    if (!prev || !next) continue;
    const candleBody = safeNum(candles[p.idx]?.close || 0) - safeNum(candles[p.idx]?.open || 0);
    if (p.type === 'L') {
      const lowerThanPrev = p.price < prev.price;
      const closedAbove = candleBody > 0;
      if (lowerThanPrev && closedAbove) sfps.push({ type: 'BullishSFP', pivotIdx: p.idx, pivotPrice: p.price });
    }
    if (p.type === 'H') {
      const higherThanPrev = p.price > prev.price;
      const closedBelow = candleBody < 0;
      if (higherThanPrev && closedBelow) sfps.push({ type: 'BearishSFP', pivotIdx: p.idx, pivotPrice: p.price });
    }
  }
  return sfps;
}

// ----------------------
// Market structure (BOS/CHoCH)
function detectMarketStructure(candles, pivots) {
  const ms = [];
  if (pivots.length < 4) return ms;
  const prevHighs = pivots.filter(p => p.type === 'H').slice(-3).map(p => p.price);
  const prevLows = pivots.filter(p => p.type === 'L').slice(-3).map(p => p.price);
  if (prevHighs.length && prevLows.length) {
    const hh = Math.max(...prevHighs);
    const ll = Math.min(...prevLows);
    const price = safeNum(last(candles)?.close || 0);
    if (price > hh) ms.push({ type: 'BOS', side: 'Bullish', price });
    if (price < ll) ms.push({ type: 'BOS', side: 'Bearish', price });
  }
  const lastTwo = pivots.slice(-3);
  if (lastTwo.length >= 3) {
    const a = lastTwo[0], b = lastTwo[1], c = lastTwo[2];
    if (a.type !== c.type) {
      if (c.type === 'H' && c.price < b.price) ms.push({ type: 'CHoCH', side: 'Bearish', info: { a, b, c }});
      if (c.type === 'L' && c.price > b.price) ms.push({ type: 'CHoCH', side: 'Bullish', info: { a, b, c }});
    }
  }
  return ms;
}

// ----------------------
// TARGETS & STOPS generation (balanced both sides)
function generateTargets({ price, atr, patterns = [], fib = null, channels = [], orderBlocks = [] }) {
  const tps = [];
  const sls = [];

  // 1) Pattern-based targets (use pattern.side if provided)
  for (const p of patterns || []) {
    if (!p) continue;
    if (typeof p.target === 'number' || (!isNaN(Number(p.target)) && p.target !== null)) {
      const tp = Number(p.target);
      const side = p.side || (tp > price ? 'Bullish' : 'Bearish');
      // SL heuristics
      let sl = null;
      if (p.type && /head/i.test(p.type)) {
        // use pivot center as SL with ATR buffer
        if (p.pivots && p.pivots[2]) {
          sl = (side === 'Bullish') ? (p.pivots[2].price - atr * 1.2) : (p.pivots[2].price + atr * 1.2);
        } else {
          sl = (side === 'Bullish') ? (price - atr * 2) : (price + atr * 2);
        }
      } else {
        const pivotPrices = (p.pivots || []).map(x => x.price).filter(Boolean);
        if (pivotPrices.length) {
          sl = (side === 'Bullish') ? (Math.min(...pivotPrices) - atr * 1.5) : (Math.max(...pivotPrices) + atr * 1.5);
        } else {
          sl = (side === 'Bullish') ? (price - atr * 2) : (price + atr * 2);
        }
      }
      tps.push({ source: p.type || 'Pattern', side, tp: Number(tp), confidence: p.confidence || 50 });
      sls.push({ source: p.type || 'Pattern', side, sl: Number(sl || (side === 'Bullish' ? price - atr * 2 : price + atr * 2)), confidence: p.confidence || 50 });
    }
  }

  // 2) Order blocks: create direction-specific TP (nearby breakout projection)
  if (orderBlocks && orderBlocks.length) {
    orderBlocks.slice(-3).forEach(ob => {
      const tp = ob.side === 'Bullish' ? (ob.levelHigh + (atr * 1.5)) : (ob.levelLow - (atr * 1.5));
      tps.push({ source: 'OrderBlock', side: ob.side, tp: Number(tp), confidence: ob.confidence || 50 });
      // SL near opposite edge
      const sl = ob.side === 'Bullish' ? ob.levelLow - atr : ob.levelHigh + atr;
      sls.push({ source: 'OrderBlock', side: ob.side, sl: Number(sl), confidence: ob.confidence || 50 });
    });
  }

  // 3) Harmonincs: use their implied D targets (if any)
  // Note: heuristics — harmonics already include pivot D as target in some libs, check p.target if provided
  // (we handled pattern targets above)

  // 4) Fib / fallback: always propose both bullish and bearish TPs from fib.ext or ATR multipliers
  if (fib && fib.ext) {
    // bullish exts
    tps.push({ source: 'FIB_1.272', side: 'Bullish', tp: Number(fib.ext['1.272']), confidence: 40 });
    tps.push({ source: 'FIB_1.618', side: 'Bullish', tp: Number(fib.ext['1.618']), confidence: 40 });
    // bearish symmetric exts (created earlier)
    if (fib.ext['1.272_bear']) tps.push({ source: 'FIB_1.272', side: 'Bearish', tp: Number(fib.ext['1.272_bear']), confidence: 35 });
    if (fib.ext['1.618_bear']) tps.push({ source: 'FIB_1.618', side: 'Bearish', tp: Number(fib.ext['1.618_bear']), confidence: 35 });
    // SL fallbacks
    sls.push({ source: 'FIB_SL', side: 'Bullish', sl: Number(price - atr * 2), confidence: 30 });
    sls.push({ source: 'FIB_SL', side: 'Bearish', sl: Number(price + atr * 2), confidence: 30 });
  } else {
    // ATR fallback both sides
    tps.push({ source: 'ATR_MULT_BULL', side: 'Bullish', tp: Number(price + atr * 3), confidence: 30 });
    tps.push({ source: 'ATR_MULT_BEAR', side: 'Bearish', tp: Number(price - atr * 3), confidence: 30 });
    sls.push({ source: 'ATR_SL', side: 'Bullish', sl: Number(price - atr * 2), confidence: 30 });
    sls.push({ source: 'ATR_SL', side: 'Bearish', sl: Number(price + atr * 2), confidence: 30 });
  }

  // 5) Channel projections: if channel slope positive propose bull ext; if negative propose bear ext
  for (const ch of channels || []) {
    const slopeSum = (ch.highFit?.slope || 0) + (ch.lowFit?.slope || 0);
    // project a modest target: current price +/- width * 1.5
    if (slopeSum > 0.000001) {
      tps.push({ source: 'ChannelProj', side: 'Bullish', tp: Number(price + ch.width * 1.5), confidence: ch.confidence || 35 });
    } else if (slopeSum < -0.000001) {
      tps.push({ source: 'ChannelProj', side: 'Bearish', tp: Number(price - ch.width * 1.5), confidence: ch.confidence || 35 });
    }
  }

  // dedupe & keep best confidence per rounded TP per side
  const mergeMap = new Map();
  for (const tp of tps) {
    const key = `${tp.side}_${Math.round(tp.tp)}`;
    if (!mergeMap.has(key)) mergeMap.set(key, tp);
    else {
      const prev = mergeMap.get(key);
      if ((tp.confidence || 0) > (prev.confidence || 0)) mergeMap.set(key, tp);
    }
  }
  const uniqTps = Array.from(mergeMap.values())
    .map(t => ({ ...t, tp: Number(Number(t.tp).toFixed(2)) }))
    .sort((a,b) => b.confidence - a.confidence);

  // normalize stops: best SL per side
  const stopMap = new Map();
  for (const s of sls) {
    const key = `${s.side}_${Math.round(s.sl || 0)}`;
    if (!stopMap.has(key)) stopMap.set(key, s);
    else {
      const prev = stopMap.get(key);
      if ((s.confidence || 0) > (prev.confidence || 0)) stopMap.set(key, s);
    }
  }
  const uniqSls = Array.from(stopMap.values()).map(s => ({ ...s, sl: Number(Number(s.sl).toFixed(2)) }));

  // ensure at least one long & one short present: if missing, create ATR fallback for that side
  const hasLong = uniqTps.some(t => t.side === 'Bullish');
  const hasShort = uniqTps.some(t => t.side === 'Bearish');
  if (!hasLong) uniqTps.push({ source: 'FORCED_ATR', side: 'Bullish', tp: Number(price + atr * 3), confidence: 20 });
  if (!hasShort) uniqTps.push({ source: 'FORCED_ATR', side: 'Bearish', tp: Number(price - atr * 3), confidence: 20 });

  return { targets: uniqTps, stops: uniqSls };
}

// ----------------------
// SCORING / SENTIMENT (balanced weighted)
function scoreEverything({ patterns = [], harmonics = [], channels = [], sfps = [], ms = [] }) {
  let scoreSum = 0;
  let weightSum = 0;

  const add = (signedVal, w=1) => {
    scoreSum += signedVal * w;
    weightSum += w;
  };

  for (const p of patterns || []) {
    const conf = Math.max(1, Math.min(99, Number(p.confidence || 50)));
    const sign = (p.side && p.side.toLowerCase().includes('bull')) ? 1 : (p.side && p.side.toLowerCase().includes('bear')) ? -1 : 0;
    add((conf / 100) * sign, 2.0);
  }

  for (const h of harmonics || []) {
    const conf = Math.max(1, Math.min(99, Number(h.confidence || 50)));
    const sign = (h.side && h.side.toLowerCase().includes('bull')) ? 1 : -1;
    add((conf / 100) * sign, 1.4);
  }

  for (const c of channels || []) {
    const conf = Math.max(1, Math.min(99, Number(c.confidence || 40)));
    const slopeAvg = ((c.highFit?.slope || 0) + (c.lowFit?.slope || 0));
    const sign = slopeAvg > 0 ? 0.4 : (slopeAvg < 0 ? -0.4 : 0);
    add(sign * (conf / 100), 0.9);
  }

  for (const s of sfps || []) {
    const sign = s.type && s.type.toLowerCase().includes('bull') ? 1 : -1;
    add(sign * 0.45, 0.8);
  }

  for (const m of ms || []) {
    const sign = m.side && m.side.toLowerCase().includes('bull') ? 1 : -1;
    add(sign * 0.6, 1.2);
  }

  if (weightSum < 1e-6) return { sentiment: 0, confidence: 25 };

  const raw = scoreSum / weightSum;
  const sentiment = Math.max(-1, Math.min(1, raw));
  const baseConf = Math.min(0.99, Math.abs(raw));
  const signalCount = (patterns?.length || 0) + (harmonics?.length || 0) + (channels?.length || 0) + (sfps?.length || 0) + (ms?.length || 0);
  const confBoost = Math.min(0.35, Math.log10(Math.max(1, signalCount)) * 0.15);
  const confidence = Math.min(99, Math.max(10, Math.round((baseConf + confBoost) * 100)));

  return { sentiment: Number(sentiment.toFixed(3)), confidence };
}

// ----------------------
// MAIN: analyzeElliott (exports same fields)
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!Array.isArray(candles) || candles.length < 3) return { ok: false, error: 'no_data' };

    const left = opts.pivotLeft || 3;
    const right = opts.pivotRight || 3;
    const pivots = findPivots(candles, left, right);
    const waves = mapWavesFromPivots(pivots);
    const atr = computeATR(candles, opts.atrPeriod || 14);

    // major swing for fib: use last up to 500 candles for robustness
    const sliceForSwing = candles.slice(-Math.min(500, candles.length));
    const majorHigh = Math.max(...sliceForSwing.map(c => safeNum(c.high)));
    const majorLow = Math.min(...sliceForSwing.map(c => safeNum(c.low)));
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

    // combine patterns (include also harmonics separately)
    const patterns = [...hns, ...dt, ...tri];
    // generate targets/stops using robust dual-direction logic
    const priceNow = safeNum(last(candles)?.close || 0);
    const targetsObj = generateTargets({
      price: priceNow,
      atr,
      patterns,
      fib,
      channels: ch,
      orderBlocks
    });

    // scoring & sentiment
    const scoring = scoreEverything({ patterns, harmonics, channels: ch, sfps, ms });

    return {
      ok: true,
      version: 'elliott_module_v2.0',
      pivots,
      waves,
      atr: Number(atr),
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
    return { ok: false, error: e?.message || 'err' };
  }
}

// default export for compatibility
export default {
  analyzeElliott,
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