// elliott_module.js — Enhanced Elliott + Pattern Engine (v1.1 fixed)
// Exports: analyzeElliott(candles, opts)
// Input: candles = [{t, open, high, low, close, vol}] (oldest -> newest)
// Output: object { ok, pivots, waves, patterns, harmonics, channels, fib, atr, targets, sentiment, confidence }

function safeNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function last(arr, n=1){ return arr.length ? arr[arr.length - n] : null; }

// ----------------------
// PIVOT / ZIGZAG
// ----------------------
function findPivots(candles, left = 3, right = 3) {
  const pivots = [];
  const n = candles.length;
  if (n < left + right + 1) return [];

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
    if (isHigh) pivots.push({ idx: i, t: cur.t, price: high, type: 'H' });
    else if (isLow) pivots.push({ idx: i, t: cur.t, price: low, type: 'L' });
  }

  // compress close pivots same direction (keep most extreme)
  const out = [];
  for (const p of pivots) {
    const lastp = out.at(-1);
    if (!lastp) { out.push(p); continue; }
    if (lastp.type === p.type && Math.abs(p.idx - lastp.idx) <= Math.max(left, right)) {
      // pick the more extreme (higher high or lower low)
      if (p.type === 'H' && p.price > lastp.price) out[out.length - 1] = p;
      else if (p.type === 'L' && p.price < lastp.price) out[out.length - 1] = p;
      // else keep lastp
    } else {
      out.push(p);
    }
  }

  // ensure alternation H-L-H-L
  const folded = [];
  for (const p of out) {
    const lastp = folded.at(-1);
    if (!lastp) { folded.push(p); continue; }
    if (lastp.type === p.type) {
      // choose the more extreme between lastp and p
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
// WAVES (simple mapping)
// ----------------------
function mapWavesFromPivots(pivots) {
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
  return Number(atr);
}

// ----------------------
// FIB LEVELS
// ----------------------
function fibLevelsFromSwing(low, high) {
  const lo = safeNum(low);
  const hi = safeNum(high);
  const diff = Math.max(1e-9, hi - lo);
  return {
    lo, hi,
    retrace: {
      '0.236': Number((hi - diff * 0.236).toFixed(6)),
      '0.382': Number((hi - diff * 0.382).toFixed(6)),
      '0.5': Number((hi - diff * 0.5).toFixed(6)),
      '0.618': Number((hi - diff * 0.618).toFixed(6)),
      '0.786': Number((hi - diff * 0.786).toFixed(6))
    },
    ext: {
      '1.272': Number((hi + diff * 0.272).toFixed(6)),
      '1.618': Number((hi + diff * 0.618).toFixed(6))
    }
  };
}

// ----------------------
// HEAD & SHOULDERS detection
// ----------------------
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
        const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price)/2));
        const headProm = (c.price - Math.max(a.price,e.price)) / Math.max(1, c.price);
        const confidence = Math.max(0, Math.min(1, (shoulderSym * 0.6 + headProm * 0.4)));
        const target = neck - (c.price - neck);
        patterns.push({
          type: 'HeadAndShoulders',
          side: 'Bearish',
          pivots: [a,b,c,d,e].map(p=>({idx:p.idx, t:p.t, price:p.price, type:p.type})),
          neckline: neck,
          target,
          confidence: Number((confidence * 100).toFixed(1))
        });
      }
    }

    // Inverse H&S (bottom)
    if (a.type === 'L' && b.type === 'H' && c.type === 'L' && d.type === 'H' && e.type === 'L') {
      const neck = (b.price + d.price) / 2;
      const headLower = c.price < a.price && c.price < e.price;
      if (headLower) {
        const shoulderSym = 1 - (Math.abs(a.price - e.price) / Math.max(1, (a.price + e.price)/2));
        const headProm = (Math.min(a.price,e.price) - c.price) / Math.max(1, Math.min(a.price,e.price));
        const confidence = Math.max(0, Math.min(1, (shoulderSym * 0.6 + headProm * 0.4)));
        const target = neck + (neck - c.price);
        patterns.push({
          type: 'InverseHeadAndShoulders',
          side: 'Bullish',
          pivots: [a,b,c,d,e].map(p=>({idx:p.idx, t:p.t, price:p.price, type:p.type})),
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
// ----------------------
function detectDoubleTopsBottoms(pivots) {
  const patterns = [];
  for (let i = 0; i < pivots.length - 2; i++) {
    const a = pivots[i], b = pivots[i+1], c = pivots[i+2];
    if (!a || !b || !c) continue;

    // Double Top: H-L-H with similar highs
    if (a.type === 'H' && b.type === 'L' && c.type === 'H') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price)/2);
      // relaxed tolerance from 0.94 to 0.88
      if (closeness > 0.88) {
        const neckline = b.price;
        const height = Math.abs(a.price - neckline);
        const target = neckline - height;
        patterns.push({
          type: 'DoubleTop',
          side: 'Bearish',
          pivots: [a,b,c].map(p=>({idx:p.idx, price:p.price, type:p.type})),
          neckline,
          target,
          confidence: Number((closeness * 100).toFixed(1))
        });
      }
    }
    // Double Bottom
    if (a.type === 'L' && b.type === 'H' && c.type === 'L') {
      const closeness = 1 - Math.abs(a.price - c.price) / Math.max(1, (a.price + c.price)/2);
      if (closeness > 0.88) {
        const neckline = b.price;
        const height = Math.abs(neckline - a.price);
        const target = neckline + height;
        patterns.push({
          type: 'DoubleBottom',
          side: 'Bullish',
          pivots: [a,b,c].map(p=>({idx:p.idx, price:p.price, type:p.type})),
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
// TRIANGLE DETECTOR (simple regression via endpoints)
// ----------------------
function detectTriangles(pivots) {
  const patterns = [];
  for (let start = 0; start < pivots.length - 4; start++) {
    for (let len = 4; len <= 8 && start + len <= pivots.length; len++) {
      const seq = pivots.slice(start, start + len);
      const highs = seq.filter(p=>p.type==='H').map(p=>p.price);
      const lows = seq.filter(p=>p.type==='L').map(p=>p.price);
      if (highs.length < 2 || lows.length < 2) continue;

      const highsTrend = highs[0] - highs.at(-1);
      const lowsTrend = lows.at(-1) - lows[0];

      // reduce contraction threshold (more tolerant)
      if (highsTrend > Math.max((highs[0]*0.0015), (Math.abs(highs[0])*0.0008)) &&
          lowsTrend > Math.max((lows[0]*0.0015), (Math.abs(lows[0])*0.0008))) {
        const firstHigh = seq.find(p=>p.type==='H').price;
        const lastHigh = [...seq].reverse().find(p=>p.type==='H').price;
        const firstLow = seq.find(p=>p.type==='L').price;
        const lastLow = [...seq].reverse().find(p=>p.type==='L').price;
        const highSlope = lastHigh - firstHigh;
        const lowSlope = lastLow - firstLow;
        let triType = 'Symmetrical';
        if (highSlope < 0 && lowSlope > 0) triType = 'Symmetrical';
        else if (highSlope < 0 && lowSlope <= 0) triType = 'Descending';
        else if (highSlope >= 0 && lowSlope > 0) triType = 'Ascending';
        const contraction = ((highs[0]-highs.at(-1)) + (lows.at(-1)-lows[0])) / (Math.max(1, Math.abs(highs[0]) + Math.abs(lows[0])));
        patterns.push({
          type: 'Triangle',
          triType,
          pivots: seq.map(p=>({idx:p.idx, price:p.price, type:p.type})),
          contraction: Number((contraction * 100).toFixed(1)),
          confidence: Math.min(99, Math.max(30, Math.round(contraction * 100)))
        });
      }
    }
  }
  return patterns;
}

// ----------------------
// CHANNEL DETECTION
// ----------------------
function detectChannels(pivots) {
  const channels = [];
  const seqLen = Math.min(20, pivots.length);
  if (seqLen < 6) return channels;
  const seq = pivots.slice(-seqLen);
  const highs = seq.filter(p=>p.type==='H');
  const lows = seq.filter(p=>p.type==='L');
  if (highs.length < 2 || lows.length < 2) return channels;

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
  const width = highs.reduce((a,b,i)=>a + Math.abs(b.price - (lowFit.slope * i + lowFit.intercept)),0)/Math.max(1,highs.length);
  channels.push({
    type: 'RegressionChannel',
    highFit, lowFit,
    width: Number(width.toFixed(6)),
    confidence: Math.min(99, Math.max(20, Math.round(100 - (width / (Math.abs(lowFit.intercept||1)) * 100))))
  });
  return channels;
}

// ----------------------
// HARMONIC PATTERNS (approximate)
// ----------------------
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
    const ratio = (a,b)=> b===0?0: Math.abs(a/b);
    const ab_xa = ratio(AB, XA);
    const bc_ab = ratio(BC, AB);
    const cd_xa = ratio(CD, XA);
    // more tolerant
    const gartley = ab_xa >= 0.52 && ab_xa <= 0.7 && bc_ab >= 0.34 && bc_ab <= 0.9 && cd_xa >= 0.9 && cd_xa <= 1.12;
    const bat = ab_xa >= 0.36 && ab_xa <= 0.54 && bc_ab >= 0.36 && bc_ab <= 0.9 && cd_xa >= 1.5 && cd_xa <= 2.8;
    const crab = ab_xa >= 0.35 && ab_xa <= 0.65 && cd_xa >= 1.8 && cd_xa <= 3.8;
    if (gartley || bat || crab) {
      patterns.push({
        type: gartley ? 'Gartley' : bat ? 'Bat' : 'Crab',
        side: D.price > C.price ? 'Bullish' : 'Bearish',
        pivots: [X,A,B,C,D].map(p=>({idx:p.idx, price:p.price, type:p.type})),
        ratios: { ab_xa: Number(ab_xa.toFixed(3)), bc_ab: Number(bc_ab.toFixed(3)), cd_xa: Number(cd_xa.toFixed(3)) },
        confidence: Math.min(99, Math.max(30, Math.round(( (gartley?0.95:0.7) - Math.abs(ab_xa - (gartley?0.618: (bat?0.45:2))) ) * 100 )))
      });
    }
  }
  return patterns;
}

// ----------------------
// ORDER BLOCKS & FVG (heuristic)
// ----------------------
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const prev = candles[i-2], cur = candles[i-1], next = candles[i];
    const sizePrev = Math.abs(safeNum(prev.close) - safeNum(prev.open));
    const sizeCur = Math.abs(safeNum(cur.close) - safeNum(cur.open));
    const sizeNext = Math.abs(safeNum(next.close) - safeNum(next.open));
    const big = Math.max(sizePrev, sizeCur, sizeNext);
    if (sizePrev >= big*0.7 && sizePrev > 0) {
      const dir = prev.close > prev.open ? 'Bull' : 'Bear';
      const continuation = (next.close > next.open && dir==='Bull') || (next.close < next.open && dir==='Bear');
      if (continuation) {
        orderBlocks.push({
          type: 'OrderBlock',
          idx: i-2,
          side: dir === 'Bull' ? 'Bullish' : 'Bearish',
          levelHigh: Math.max(safeNum(prev.open), safeNum(prev.close)),
          levelLow: Math.min(safeNum(prev.open), safeNum(prev.close)),
          confidence: 50 + Math.min(49, Math.round( (sizePrev / Math.max(1, sizeCur + sizeNext)) * 50 ))
        });
      }
    }
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
// ----------------------
function detectSFP(candles, pivots) {
  const sfps = [];
  for (let i = 1; i < pivots.length - 1; i++) {
    const p = pivots[i];
    const prev = pivots[i-1], next = pivots[i+1];
    if (!prev || !next) continue;
    const candle = safeNum(candles[p.idx]?.close || 0) - safeNum(candles[p.idx]?.open || 0);
    if (p.type === 'L') {
      const lowerThanPrev = p.price < prev.price;
      const closedAbove = candle > 0; // bullish close
      if (lowerThanPrev && closedAbove) {
        sfps.push({ type: 'BullishSFP', pivotIdx: p.idx, pivotPrice: p.price });
      }
    }
    if (p.type === 'H') {
      const higherThanPrev = p.price > prev.price;
      const closedBelow = candle < 0; // bearish close
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
  const ms = [];
  if (pivots.length < 4) return ms;
  const prevHighs = pivots.filter(p=>p.type==='H').slice(-3).map(p=>p.price);
  const prevLows = pivots.filter(p=>p.type==='L').slice(-3).map(p=>p.price);
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
      if (c.type === 'H' && c.price < b.price) ms.push({ type: 'CHoCH', side: 'Bearish', info: { a,b,c }});
      if (c.type === 'L' && c.price > b.price) ms.push({ type: 'CHoCH', side: 'Bullish', info: { a,b,c }});
    }
  }
  return ms;
}

// ----------------------
// TP/SL generator
// ----------------------
function generateTargets({ price, atr, patterns = [], fib = null, channels = [], orderBlocks = [] }) {
  const tps = [];
  const sls = [];

  // pattern based targets
  (patterns || []).forEach(p=>{
    if (p && p.target) {
      const tp = Number(p.target);
      const side = p.side || (tp > price ? 'Bullish' : 'Bearish');
      let sl = null;
      if (p.type && (p.type.toLowerCase().includes('head') || p.type.toLowerCase().includes('shoulder'))) {
        if (p.side === 'Bullish') sl = (p.pivots && p.pivots[2] && p.pivots[2].price) ? p.pivots[2].price - atr * 1.2 : price - atr * 2;
        else sl = (p.pivots && p.pivots[2] && p.pivots[2].price) ? p.pivots[2].price + atr * 1.2 : price + atr * 2;
      } else {
        if (p.side === 'Bullish') sl = Math.min(...(p.pivots||[]).map(x=>x.price)) - atr * 1.5 || price - atr * 2;
        else sl = Math.max(...(p.pivots||[]).map(x=>x.price)) + atr * 1.5 || price + atr * 2;
      }
      tps.push({ source: p.type || 'Pattern', side, tp: Number(tp), confidence: p.confidence || 50 });
      sls.push({ source: p.type || 'Pattern', side, sl: Number(sl), confidence: p.confidence || 50 });
    }
  });

  // orderblock targets
  if (orderBlocks && orderBlocks.length) {
    orderBlocks.slice(-3).forEach(ob=>{
      const tp = ob.side === 'Bullish' ? ob.levelHigh + (atr * 1.5) : ob.levelLow - (atr * 1.5);
      tps.push({ source: 'OrderBlock', side: ob.side, tp: Number(tp), confidence: ob.confidence || 50 });
    });
  }

  // fallback: fib ext or ATR multipliers — ensure both directions available
  if (!tps.length) {
    if (fib && fib.ext) {
      tps.push({ source: 'FIB_1.272', side: 'Bullish', tp: Number(fib.ext['1.272']), confidence: 40 });
      tps.push({ source: 'FIB_1.618', side: 'Bullish', tp: Number(fib.ext['1.618']), confidence: 40 });
      // symmetric bearish fallback
      tps.push({ source: 'FIB_1.272', side: 'Bearish', tp: Number(fib.lo - (fib.ext['1.272'] - fib.hi)), confidence: 30 });
      sls.push({ source: 'ATR_SL', side: 'Bullish', sl: Number(price - atr * 2) });
      sls.push({ source: 'ATR_SL', side: 'Bearish', sl: Number(price + atr * 2) });
    } else {
      tps.push({ source: 'ATR_MULT_BULL', side: 'Bullish', tp: Number(price + atr * 3), confidence: 30 });
      tps.push({ source: 'ATR_MULT_BEAR', side: 'Bearish', tp: Number(price - atr * 3), confidence: 30 });
      sls.push({ source: 'ATR_SL', side: 'Bullish', sl: Number(price - atr * 2) });
      sls.push({ source: 'ATR_SL', side: 'Bearish', sl: Number(price + atr * 2) });
    }
  }

  // dedupe by rounded tp (and keep best confidence)
  const uniqT = new Map();
  for (const tp of tps) {
    const key = `${Math.round(tp.tp)}_${tp.side}`;
    if (!uniqT.has(key)) uniqT.set(key, tp);
    else {
      const prev = uniqT.get(key);
      if ((tp.confidence||0) > (prev.confidence||0)) uniqT.set(key, tp);
    }
  }
  const uniqTps = Array.from(uniqT.values()).map(t => ({ ...t, tp: Number(Number(t.tp).toFixed(2)) }));

  // normalize stops (remove duplicates)
  const uniqS = new Map();
  for (const s of sls) {
    const key = `${Math.round(Number(s.sl||0))}_${s.side}`;
    if (!uniqS.has(key)) uniqS.set(key, s);
    else {
      const prev = uniqS.get(key);
      if ((s.confidence||0) > (prev.confidence||0)) uniqS.set(key, s);
    }
  }
  const uniqSls = Array.from(uniqS.values()).map(s => ({ ...s, sl: Number(Number(s.sl||0).toFixed(2)) }));

  return { targets: uniqTps, stops: uniqSls };
}

// ----------------------
// SCORING & SENTIMENT
// ----------------------
function scoreEverything({ patterns=[], harmonics=[], channels=[], sfps=[], ms=[] }) {
  // We'll convert each source's confidence to a -1..1 signed value and compute weighted average
  let scoreSum = 0;
  let weightSum = 0;

  const push = (signedConf, w=1) => {
    // signedConf in -1..1 (e.g. 0.6 bullish => +0.6)
    const wnum = Math.max(0.0001, w);
    scoreSum += signedConf * wnum;
    weightSum += wnum;
  };

  // pattern weight mapping
  for (const p of patterns || []) {
    const conf = Math.max(1, Math.min(99, Number(p.confidence || 50)));
    const sign = (p.side && p.side.toLowerCase().includes('bull')) ? 1 : (p.side && p.side.toLowerCase().includes('bear')) ? -1 : 0;
    // normalize confidence 0..1
    const n = (conf / 100) * sign;
    push(n, 2.0); // patterns strong weight
  }

  for (const h of harmonics || []) {
    const conf = Math.max(1, Math.min(99, Number(h.confidence || 50)));
    const sign = (h.side && h.side.toLowerCase().includes('bull')) ? 1 : -1;
    const n = (conf / 100) * sign;
    push(n, 1.6);
  }

  for (const c of channels || []) {
    const conf = Math.max(1, Math.min(99, Number(c.confidence || 40)));
    // channel confidence doesn't carry direction strongly, evaluate by slope average
    const slopeSign = (c.highFit && c.lowFit && ((c.lowFit.slope || 0) + (c.highFit.slope || 0)) > 0) ? 0.4 : ((c.highFit.slope||0) + (c.lowFit.slope||0) < 0 ? -0.4 : 0);
    push(slopeSign * (conf/100), 0.9);
  }

  for (const s of sfps || []) {
    const sign = s.type && s.type.toLowerCase().includes('bull') ? 1 : -1;
    push(sign * 0.45, 0.8);
  }

  for (const m of ms || []) {
    const sign = m.side && m.side.toLowerCase().includes('bull') ? 1 : -1;
    const conf = 0.6;
    push(sign * conf, 1.2);
  }

  // if nothing contributed, default neutral with low confidence
  if (weightSum < 1e-6) {
    return { sentiment: 0, confidence: 25 };
  }

  // weighted average in -1..1
  const raw = scoreSum / weightSum;
  const sentiment = Math.max(-1, Math.min(1, raw));
  // confidence derived from absolute magnitude and amount of signals
  // scale from 10..99
  const baseConf = Math.min(0.99, Math.abs(raw));
  // also take into account number of signals
  const signalCount = (patterns?.length||0) + (harmonics?.length||0) + (channels?.length||0) + (sfps?.length||0) + (ms?.length||0);
  const confBoost = Math.min(0.35, Math.log10(Math.max(1, signalCount)) * 0.15); // small boost with more signals
  const confidence = Math.min(99, Math.max(10, Math.round((baseConf + confBoost) * 100)));

  return { sentiment: Number(sentiment.toFixed(3)), confidence };
}

// ----------------------
// MAIN: analyzeElliott
// ----------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!Array.isArray(candles) || !candles.length) return { ok:false, error: 'no_data' };
    const left = opts.pivotLeft || 3, right = opts.pivotRight || 3;
    const pivots = findPivots(candles, left, right);
    const waves = mapWavesFromPivots(pivots);
    const atr = computeATR(candles, opts.atrPeriod || 14);
    const sliceForSwing = candles.slice(-200);
    const majorHigh = Math.max(...sliceForSwing.map(c=>safeNum(c.high)));
    const majorLow = Math.min(...sliceForSwing.map(c=>safeNum(c.low)));
    const fib = fibLevelsFromSwing(majorLow, majorHigh);

    const hns = detectHeadAndShoulders(pivots);
    const dt = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const harmonics = detectHarmonics(candles);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms = detectMarketStructure(candles, pivots);

    const patterns = [...hns, ...dt, ...tri]; // keep combined
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
      version: 'elliott_module_v1.1',
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