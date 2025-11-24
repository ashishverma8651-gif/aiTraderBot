// elliott_module.js
// ML-Optimized Elliott & Pattern Engine (v1.0)

// VERSION: 1.0
const VERSION = "1.0.0";

/* -------------------------
   Helpers
   ------------------------- */
const safeNum = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const last = (arr, n = 1) => (Array.isArray(arr) && arr.length ? arr[arr.length - n] : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = arr => (Array.isArray(arr) && arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0);
const fmt = (n, dp = 2) => Number(Number.isFinite(+n) ? n.toFixed(dp) : 0);

/* -------------------------
   Normalize candles (defensive)
   ------------------------- */
export function normalizeCandles(raw = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] || {};
    const t = safeNum(c.t, null);
    const o = safeNum(c.open, null);
    const h = safeNum(c.high, null);
    const l = safeNum(c.low, null);
    const cl = safeNum(c.close, null);
    const v = safeNum(c.vol ?? c.volume ?? 0, 0);
    if (t === null || cl === null) continue; // must have timestamp and close
    out.push({ t, open: o ?? cl, high: h ?? Math.max(o ?? cl, cl), low: l ?? Math.min(o ?? cl, cl), close: cl, vol: v });
  }
  out.sort((a,b)=>a.t - b.t);
  // remove duplicates (same timestamp) keep last
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length-1].t === c.t) dedup[dedup.length-1] = c;
    else dedup.push(c);
  }
  return dedup;
}

/* -------------------------
   Pivot detection (fast single-pass)
   left/right window parameters control sensitivity
   ------------------------- */
function findPivots(candles, left = 3, right = 3, minPriceMovePct = 0.0001) {
  const out = [];
  if (!Array.isArray(candles) || candles.length <= left + right) return out;
  const n = candles.length;
  const highs = new Array(n), lows = new Array(n);
  for (let i=0;i<n;i++){ highs[i]=safeNum(candles[i].high); lows[i]=safeNum(candles[i].low); }

  for (let i = left; i < n - right; i++) {
    const h = highs[i], l = lows[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j < i; j++) {
      if (highs[j] > h) { isHigh = false; if (!isLow) break; }
      if (lows[j] < l) { isLow = false; if (!isHigh) break; }
    }
    for (let j = i + 1; j <= i + right; j++) {
      if (highs[j] > h) { isHigh = false; if (!isLow) break; }
      if (lows[j] < l) { isLow = false; if (!isHigh) break; }
    }
    // minor noise filter - require small move relative to price
    if (isHigh && Math.abs(h) > 0 && Math.abs(h - avg(highs.slice(Math.max(0,i-left), i+right+1))) / h < minPriceMovePct) isHigh = false;
    if (isLow && Math.abs(l) > 0 && Math.abs(avg(lows.slice(Math.max(0,i-left), i+right+1)) - l) / (l || 1) < minPriceMovePct) isLow = false;

    if (isHigh) out.push({ idx:i, t:safeNum(candles[i].t), price:h, type:"H" });
    else if (isLow) out.push({ idx:i, t:safeNum(candles[i].t), price:l, type:"L" });
  }

  // merge proximate same-type pivots (keep extreme)
  const merged = [];
  for (const p of out) {
    const lastp = merged.at(-1);
    if (!lastp) { merged.push(p); continue; }
    if (p.type === lastp.type && Math.abs(p.idx - lastp.idx) <= left) {
      // keep extreme
      if ((p.type === "H" && p.price > lastp.price) || (p.type==="L" && p.price < lastp.price)) merged[merged.length-1] = p;
    } else merged.push(p);
  }
  return merged;
}

/* -------------------------
   Map waves from pivots (simple segments)
   ------------------------- */
function mapWavesFromPivots(pivots=[]) {
  const out=[];
  for (let i=0;i<pivots.length-1;i++){
    const a=pivots[i], b=pivots[i+1];
    const diff = b.price - a.price;
    out.push({
      fromIdx: a.idx, toIdx: b.idx,
      start: a.price, end: b.price,
      dir: diff>0 ? "UP" : "DOWN",
      abs: Math.abs(diff),
      pct: a.price? Math.abs(diff/a.price)*100 : 0,
      a,b
    });
  }
  return out;
}

/* -------------------------
   ATR (simple)
   ------------------------- */
function computeATR(candles, len=14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const start = Math.max(1, candles.length - len);
  let sum=0, cnt=0;
  for (let i=start;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    const tr = Math.max(safeNum(c.high)-safeNum(c.low), Math.abs(safeNum(c.high)-safeNum(p.close)), Math.abs(safeNum(c.low)-safeNum(p.close)));
    sum+=tr; cnt++;
  }
  return cnt? sum/cnt : 0;
}

/* -------------------------
   Fibonacci from swing
   ------------------------- */
function fibLevelsFromSwing(low, high) {
  const lo = safeNum(low), hi = safeNum(high);
  const diff = Math.max(1e-9, hi-lo);
  return {
    lo, hi, diff,
    retrace: {
      "0.236": hi - diff*0.236,
      "0.382": hi - diff*0.382,
      "0.5":   hi - diff*0.5,
      "0.618": hi - diff*0.618,
      "0.786": hi - diff*0.786
    },
    ext: {
      "1.272": hi + diff*0.272,
      "1.618": hi + diff*0.618,
      "2.0":   hi + diff*1.0
    }
  };
}

/* -------------------------
   Pattern detectors
   - Double top/bottom
   - Head & Shoulders / Inverse
   - Triangles (sym, asc, desc)
   - Channels (linear fits)
   ------------------------- */
function detectDoubleTopsBottoms(pivots) {
  const out=[];
  for (let i=0;i<pivots.length-2;i++){
    const a=pivots[i], b=pivots[i+1], c=pivots[i+2];
    if (!a||!b||!c) continue;
    // double top
    if (a.type==="H" && b.type==="L" && c.type==="H"){
      const closeness = 1 - Math.abs(a.price-c.price)/((a.price+c.price)/2||1);
      if (closeness>0.82){
        const height = a.price - b.price;
        out.push({ type:"DoubleTop", side:"Bearish", neckline:b.price, target: fmt(b.price - height,2), pivots:[a,b,c], confidence: Math.round(closeness*100) });
      }
    }
    // double bottom
    if (a.type==="L" && b.type==="H" && c.type==="L"){
      const closeness = 1 - Math.abs(a.price-c.price)/((a.price+c.price)/2||1);
      if (closeness>0.82){
        const height = b.price - a.price;
        out.push({ type:"DoubleBottom", side:"Bullish", neckline:b.price, target: fmt(b.price + height,2), pivots:[a,b,c], confidence: Math.round(closeness*100) });
      }
    }
  }
  return out;
}

function detectHeadAndShoulders(pivots) {
  const out=[];
  for (let i=0;i<pivots.length-4;i++){
    const a=pivots[i], b=pivots[i+1], c=pivots[i+2], d=pivots[i+3], e=pivots[i+4];
    if (!a||!b||!c||!d||!e) continue;
    // H&S
    if (a.type==="H" && b.type==="L" && c.type==="H" && d.type==="L" && e.type==="H"){
      if (c.price > a.price && c.price > e.price){
        const neckline = (b.price + d.price)/2;
        out.push({ type:"HeadAndShoulders", side:"Bearish", neckline, target: fmt(neckline - (c.price - neckline),2), pivots:[a,b,c,d,e], confidence:70 });
      }
    }
    // Inverse H&S
    if (a.type==="L" && b.type==="H" && c.type==="L" && d.type==="H" && e.type==="L"){
      if (c.price < a.price && c.price < e.price){
        const neckline = (b.price + d.price)/2;
        out.push({ type:"InverseHeadAndShoulders", side:"Bullish", neckline, target: fmt(neckline + (neckline - c.price),2), pivots:[a,b,c,d,e], confidence:70 });
      }
    }
  }
  return out;
}

function detectTriangles(pivots) {
  const out=[];
  if (!pivots || pivots.length < 6) return out;
  for (let w = 6; w <= Math.min(9, pivots.length); w++){
    for (let i=0;i<=pivots.length-w;i++){
      const seq = pivots.slice(i,i+w);
      const highs = seq.filter(x=>x.type==="H"), lows = seq.filter(x=>x.type==="L");
      if (highs.length<2 || lows.length<2) continue;
      const hiSlope = (highs.at(-1).price - highs[0].price) / Math.max(1, highs.at(-1).t - highs[0].t);
      const loSlope = (lows.at(-1).price - lows[0].price) / Math.max(1, lows.at(-1).t - lows[0].t);
      if (hiSlope < 0 && loSlope > 0) out.push({ type:"Triangle", triType:"Symmetrical", pivots:seq, confidence:60 });
      else {
        if (Math.abs(hiSlope) < Math.abs(loSlope)*0.5 && loSlope>0) out.push({ type:"Triangle", triType:"Ascending", pivots:seq, confidence:65 });
        if (Math.abs(loSlope) < Math.abs(hiSlope)*0.5 && hiSlope<0) out.push({ type:"Triangle", triType:"Descending", pivots:seq, confidence:65 });
      }
    }
  }
  return out;
}

function detectChannels(pivots) {
  if (!pivots || pivots.length < 6) return [];
  const seq = pivots.slice(-Math.min(60, pivots.length));
  const highs = seq.filter(p=>p.type==="H");
  const lows = seq.filter(p=>p.type==="L");
  if (highs.length < 2 || lows.length < 2) return [];
  const fit = arr => {
    let n=arr.length,sumX=0,sumY=0,sumXY=0,sumXX=0;
    for (let i=0;i<n;i++){
      const x = safeNum(arr[i].t) || i;
      const y = safeNum(arr[i].price);
      sumX+=x; sumY+=y; sumXY+=x*y; sumXX+=x*x;
    }
    const denom = (n*sumXX - sumX*sumX) || 1e-9;
    const slope = (n*sumXY - sumX*sumY)/denom;
    const intercept = (sumY - slope*sumX)/n;
    return { slope, intercept };
  };
  const highFit = fit(highs), lowFit = fit(lows);
  const avgSlope = (Math.abs(highFit.slope)+Math.abs(lowFit.slope))/2;
  let confidence = 60;
  if (Math.abs(highFit.slope - lowFit.slope) < Math.abs(avgSlope)*0.12) confidence = 80;
  else if ((highFit.slope>0 && lowFit.slope>0) || (highFit.slope<0 && lowFit.slope<0)) confidence = 65;
  return [{ type:"Channel", highFit, lowFit, confidence, side: highFit.slope>0 ? "Bullish" : highFit.slope<0 ? "Bearish" : "Neutral" }];
}

/* -------------------------
   Order Blocks & FVG
   - Order block: strong directional candle followed by displacement
   - FVG: gap between a and c (three-candle assessment)
   ------------------------- */
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [], fvgs = [];
  for (let i=2;i<candles.length-1;i++){
    const a=candles[i-2], b=candles[i-1], c=candles[i];
    if (!a||!b||!c) continue;
    const rangeA = Math.max(1e-9, safeNum(a.high)-safeNum(a.low));
    const bodyA = Math.abs(safeNum(a.close)-safeNum(a.open));
    const bodyRatio = bodyA / rangeA;
    if (bodyRatio > 0.65 && bodyA/Math.max(1,Math.abs(safeNum(a.open))) > 0.0005) {
      if ((a.close > a.open && safeNum(c.close) > safeNum(b.close)) || (a.close < a.open && safeNum(c.close) < safeNum(b.close))) {
        orderBlocks.push({
          type:"OrderBlock",
          idx: i-2,
          side: a.close > a.open ? "Bullish":"Bearish",
          levelHigh: Math.max(safeNum(a.open), safeNum(a.close)),
          levelLow: Math.min(safeNum(a.open), safeNum(a.close)),
          confidence: clamp(Math.round(50 + (bodyRatio-0.65)*200), 50, 95)
        });
      }
    }
    // FVG (c.low > a.high) or (c.high < a.low)
    if (safeNum(c.low) > safeNum(a.high)) {
      fvgs.push({ type:"FVG_Bullish", idx:i-1, top: safeNum(c.low), bottom: safeNum(a.high), width: safeNum(c.low)-safeNum(a.high) });
    }
    if (safeNum(c.high) < safeNum(a.low)) {
      fvgs.push({ type:"FVG_Bearish", idx:i-1, top: safeNum(a.low), bottom: safeNum(c.high), width: safeNum(a.low)-safeNum(c.high) });
    }
  }
  return { orderBlocks, fvgs };
}

/* -------------------------
   SFP detection (failed breaks)
   ------------------------- */
function detectSFP(candles, pivots) {
  const out=[];
  if (!Array.isArray(pivots) || pivots.length < 2) return out;
  for (let i=1;i<pivots.length;i++){
    const prevP = pivots[i-1], currP = pivots[i];
    const fc = candles[currP.idx+1] || last(candles);
    if (!fc) continue;
    const fcHigh = safeNum(fc.high), fcLow = safeNum(fc.low), fcOpen = safeNum(fc.open), fcClose = safeNum(fc.close);
    const body = Math.abs(fcClose - fcOpen), wickUp = fcHigh - Math.max(fcClose, fcOpen), wickDown = Math.min(fcClose, fcOpen) - fcLow;
    // Bullish SFP: prev low then curr low lower but price closes back above prev low with long lower wick
    if (prevP.type==="L" && currP.type==="L") {
      if (currP.price < prevP.price && (fcClose > prevP.price*1.0005) && wickUp > body*0.8) out.push({ type:"BullishSFP", pivotPrice:currP.price, prevPivot:prevP.price, idx:currP.idx, confidence:75 });
    }
    // Bearish SFP
    if (prevP.type==="H" && currP.type==="H") {
      if (currP.price > prevP.price && (fcClose < prevP.price*0.9995) && wickDown > body*0.8) out.push({ type:"BearishSFP", pivotPrice:currP.price, prevPivot:prevP.price, idx:currP.idx, confidence:75 });
    }
  }
  return out;
}

/* -------------------------
   Market Structure: BOS / CHoCH
   ------------------------- */
function detectMarketStructure(candles, pivots) {
  const out=[];
  if (!Array.isArray(pivots) || pivots.length < 2) return out;
  const lastPrice = safeNum(last(candles)?.close || 0);
  if (!lastPrice) return out;
  const highs = pivots.filter(p=>p.type==="H"), lows = pivots.filter(p=>p.type==="L");
  const lastHigh = highs.at(-1), lastLow = lows.at(-1);
  if (lastHigh && lastPrice > lastHigh.price) out.push({ type:"BOS", side:"Bullish", level:lastHigh.price, confidence:80 });
  if (lastLow && lastPrice < lastLow.price) out.push({ type:"BOS", side:"Bearish", level:lastLow.price, confidence:80 });
  // CHoCH using last 3 pivots
  if (pivots.length >= 3) {
    const a=pivots[pivots.length-3], b=pivots[pivots.length-2], c=pivots[pivots.length-1];
    // bearish CHoCH
    if (a.type==="H" && b.type==="L" && c.type==="H" && c.price > a.price && lastPrice < b.price) out.push({ type:"CoCH", side:"Bearish (Reversal)", level:b.price, confidence:70 });
    if (a.type==="L" && b.type==="H" && c.type==="L" && c.price < a.price && lastPrice > b.price) out.push({ type:"CoCH", side:"Bullish (Reversal)", level:b.price, confidence:70 });
  }
  return out;
}

/* -------------------------
   Elliott impulse labeler (full)
   - finds candidate 1-5 sequences among pivots (HLHLH or LHLHL)
   - applies wave rules: W3 longest mostly, W2 retrace <100%, W4 overlap rules
   - returns top label or null
   ------------------------- */
function labelImpulseFromPivots(pivots, candles, opts={}) {
  const labels = [];
  if (!Array.isArray(pivots) || pivots.length < 5) return null;
  const allowOverlapPct = safeNum(opts.allowW4OverlapPct ?? 0.12, 0.12); // more lenient for crypto
  for (let i=0;i<pivots.length-4;i++){
    const seq = pivots.slice(i,i+5);
    const types = seq.map(s=>s.type).join("");
    if (!/^(HLHLH|LHLHL)$/.test(types)) continue;
    // compute waves
    const waves = [];
    for (let j=0;j<4;j++){
      const a=seq[j], b=seq[j+1];
      const diff = b.price - a.price;
      waves.push({ fromIdx:a.idx, toIdx:b.idx, start:a.price, end:b.price, dir: diff>0 ? "UP":"DOWN", abs: Math.abs(diff) });
    }
    const waveRanges = waves.map(w=>w.abs); const maxRange = Math.max(...waveRanges); const idxMax = waveRanges.indexOf(maxRange);
    // wave3 should not be shortest (allow some tolerance)
    if (waveRanges[2] <= Math.min(waveRanges[0],waveRanges[1],waveRanges[3]) * 0.9) continue;
    // wave4 overlap rule
    const wave1=waves[0], wave4=waves[3];
    let overlapPenalty = false;
    if (wave1.dir === "UP") {
      if (wave4.end < wave1.start - (wave1.abs * allowOverlapPct)) overlapPenalty = true;
    } else {
      if (wave4.end > wave1.start + (wave1.abs * allowOverlapPct)) overlapPenalty = true;
    }
    if (overlapPenalty) continue;
    // wave2 retrace
    const wave2Pct = waves[1].abs / (wave1.abs || 1e-9);
    if (wave2Pct > 1.0) continue;
    // volume heuristic
    let volScore = 0;
    try {
      const v1 = avgVolume(candles, waves[0].fromIdx, waves[0].toIdx);
      const v3 = avgVolume(candles, waves[2].fromIdx, waves[2].toIdx);
      if (v3 > v1 * 1.1) volScore = 0.5;
      else if (v3 < v1 * 0.9) volScore = -0.5;
    } catch (_) { volScore = 0; }
    let score = 50;
    if (idxMax === 2) score += 20;
    if (wave2Pct < 0.618) score += 10;
    score += volScore * 10;
    const quality = clamp(Math.round(score), 0, 99);
    const label = {
      fromPivotIdx:i,
      pivots: seq,
      waves: waves.map((w, idx)=>({ wave: idx+1, ...w })),
      direction: waves[0].dir === "UP" ? "Bullish":"Bearish",
      quality,
      notes: { wave2Pct: fmt(wave2Pct*100,1), wave4Pct: fmt(waves[3].abs/(waves[2].abs||1e-9)*100,1), volScore: fmt(volScore,2) }
    };
    if (quality >= 30) labels.push(label);
  }
  if (!labels.length) return null;
  labels.sort((a,b)=>b.quality - a.quality);
  return labels[0];
}

/* -------------------------
   detect ABC after impulse (uses pivots after impulse end)
   ------------------------- */
function detectABCAfterImpulse(label, pivots, candles) {
  if (!label) return null;
  const endPivotIndex = label.fromPivotIdx + 4;
  const rem = pivots.slice(endPivotIndex+1);
  if (!rem.length) return null;
  const lastPivotType = label.pivots.at(-1).type;
  const A = rem.find(p=>p.type !== lastPivotType);
  if (!A) return null;
  const B = rem.find(p=>p.t > A.t && p.type === lastPivotType);
  if (!B) return null;
  const C = rem.find(p=>p.t > B.t && p.type === A.type);
  if (!C) return null;
  const pivotPrices = label.pivots.map(p=>p.price);
  const swingLow = Math.min(...pivotPrices), swingHigh = Math.max(...pivotPrices);
  const fib = fibLevelsFromSwing(swingLow, swingHigh);
  const res = {
    A,B,C,
    fib,
    notes: {
      A_price: A.price, B_price: B.price, C_price: C.price,
      B_retrace_impulse_pct: fmt(Math.abs(B.price - label.pivots[0].price) / Math.max(1e-9, Math.abs(label.pivots.at(-1).price - label.pivots[0].price)) * 100, 2)
    }
  };
  return res;
}

/* -------------------------
   Targets generation
   ------------------------- */
function generateTargets({ price=0, atr=0, patterns=[], fib=null }) {
  const out=[];
  for (const p of patterns) {
    if (p.target) out.push({ source: p.type, side: p.side || (p.type.includes("Bottom")?"Bullish":"Bearish"), tp: p.target, confidence: p.confidence || 50 });
  }
  if (fib) {
    const highFib = fib.ext["1.618"], midFib = fib.retrace["0.5"], ret618 = fib.retrace["0.618"];
    if (price > fib.hi && highFib) out.push({ source:"Fib 1.618 Ext", side:"Bullish", tp: fmt(highFib,2), confidence:60 });
    if (price < fib.lo && ret618) out.push({ source:"Fib 0.618 Ret", side:"Bullish", tp: fmt(ret618,2), confidence:55 });
    if (midFib) out.push({ source:"Fib 0.5", side:"Both", tp: fmt(midFib,2), confidence:40 });
  }
  // ATR fallback
  if (!out.some(t=>t.confidence>50)) {
    out.push({ side:"Bullish", tp: fmt(price + atr*2,2), source:"ATR x2", confidence:40 });
    out.push({ side:"Bearish", tp: fmt(price - atr*2,2), source:"ATR x2", confidence:40 });
  }
  return out;
}

/* -------------------------
   Scoring & Sentiment
   - combine patterns, market structure, SFP, channels, OB
   ------------------------- */
function scoreEverything({ price, patterns=[], channels=[], sfps=[], ms=[], impulse=null, fib=null, orderBlocks=[] }) {
  let score=0, weight=0;
  // patterns: H&S, double stronger
  for (const p of patterns) {
    const w = 2;
    const s = (p.side && p.side.includes("Bull")) ? 1 : -1;
    score += s * w * (p.confidence/100);
    weight += w;
  }
  // market structure
  for (const m of ms) {
    const w = m.type==="CoCH"?1.6:1.0;
    const s = (m.side && m.side.includes("Bull")) ? 1 : -1;
    score += s * w;
    weight += w;
  }
  // impulse quality
  if (impulse && typeof impulse.quality === "number") {
    const imp = (impulse.quality - 50) / 50; // -1..+1
    score += imp * 3; weight += 3;
  }
  // sfps
  for (const s of sfps) {
    const sgn = s.type.includes("Bull")?1:-1;
    score += sgn * 0.8; weight += 0.8;
  }
  // channels
  for (const c of channels) {
    const slope = (c.lowFit?.slope||0) + (c.highFit?.slope||0);
    const sgn = slope>0?1: slope<0?-1:0;
    score += sgn*0.5; weight += 0.5;
  }
  // order blocks bias
  for (const ob of orderBlocks) {
    const sgn = ob.side==="Bullish"?0.4:-0.4;
    score += sgn * (ob.confidence/100); weight += 0.4;
  }
  // fib proximity dampening
  if (fib) {
    const fib05 = fib.retrace["0.5"], fib0618 = fib.retrace["0.618"];
    if (fib05 && fib0618) {
      const proximity = Math.min(Math.abs(price - fib05), Math.abs(price - fib0618));
      const range = Math.max(1e-9, fib.hi - fib.lo);
      if (proximity < range * 0.05) score *= 0.85;
    }
  }
  if (weight===0) return { sentiment:0, confidence:25 };
  const raw = score/weight;
  const norm = clamp(raw, -1, 1);
  const confidence = Math.min(99, Math.max(10, Math.round(Math.abs(norm)*100)));
  return { sentiment: Number(norm.toFixed(3)), confidence };
}

/* -------------------------
   avgVolume helper
   ------------------------- */
function avgVolume(candles, startIdx, endIdx) {
  if (!Array.isArray(candles) || !candles.length) return 0;
  const s = Math.max(0, Math.min(startIdx, endIdx));
  const e = Math.min(candles.length-1, Math.max(startIdx, endIdx));
  let sum=0, cnt=0;
  for (let i=s;i<=e;i++){
    if (!candles[i]) continue;
    const v = safeNum(candles[i].vol ?? candles[i].volume ?? 0);
    sum+=v; cnt++;
  }
  return cnt? sum/cnt : 0;
}

/* -------------------------
   ML Feature extractor (fixed-length vector)
   Returns object { vector: [...], keys: [...] } where vector is numbers normalized-ish
   Features include: RSI-like stats, ATR, last returns, vol ratios, impulse quality, pattern counts, fib proximity, structure flags
   ------------------------- */
export function extractFeatures(candles, analysis = {}) {
  // candles normalized expected
  const outVec = [];
  const keys = [];

  const len = candles.length;
  const price = safeNum(last(candles)?.close || 0);
  const returns = [];
  for (let i=Math.max(1,len-20); i<len; i++){
    const p0 = safeNum(candles[i-1]?.close||0), p1=safeNum(candles[i]?.close||0);
    if (p0) returns.push((p1-p0)/p0);
  }
  // basic stats
  const meanRet = avg(returns);
  const stdRet = Math.sqrt(avg(returns.map(r=>r*r)) - meanRet*meanRet || 0);
  const atr = computeATR(candles, Math.min(20, Math.max(5, Math.floor(len/10))));
  // pattern counts
  const pattCount = (analysis.patterns || []).length;
  const obCount = (analysis.orderBlocks || []).length;
  const fvgCount = (analysis.fvgs || []).length;
  const sfpCount = (analysis.sfps || []).length;
  const channelCount = (analysis.channels || []).length;
  const impulseQuality = safeNum(analysis.impulse?.quality ?? 0);
  const sentiment = safeNum(analysis.sentiment ?? 0);
  const confidence = safeNum(analysis.confidence ?? 0);

  // Feature vector creation (normalize by price or atr where appropriate)
  outVec.push(meanRet); keys.push("meanRet");
  outVec.push(stdRet); keys.push("stdRet");
  outVec.push(atr); keys.push("atr");
  outVec.push(atr / (price || 1)); keys.push("atr_over_price");
  outVec.push(pattCount); keys.push("pattern_count");
  outVec.push(obCount); keys.push("orderblock_count");
  outVec.push(fvgCount); keys.push("fvg_count");
  outVec.push(sfpCount); keys.push("sfp_count");
  outVec.push(channelCount); keys.push("channel_count");
  outVec.push(impulseQuality/100); keys.push("impulse_quality_norm");
  outVec.push(sentiment); keys.push("sentiment");
  outVec.push(confidence/100); keys.push("confidence_norm");

  // recent returns (pad to length 10)
  const rab = returns.slice(-10);
  while (rab.length < 10) rab.unshift(0);
  for (let i=0;i<10;i++){ outVec.push(rab[i]); keys.push(`ret_${i-10}`); }

  // fib proximity features
  const fib = analysis.fib || null;
  if (fib) {
    const mid = fib.retrace["0.5"]; const r618 = fib.retrace["0.618"];
    outVec.push((price - mid)/(fib.diff||1)); keys.push("fib_mid_norm");
    outVec.push((price - r618)/(fib.diff||1)); keys.push("fib_618_norm");
  } else {
    outVec.push(0); keys.push("fib_mid_norm");
    outVec.push(0); keys.push("fib_618_norm");
  }

  return { vector: outVec.map(v=> Number.isFinite(+v)? +v : 0), keys };
}

/* -------------------------
   Main analyzeElliott export
   ------------------------- */
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    // pick best TF if provided and naive candles short
    let input = Array.isArray(candles) ? candles.slice() : [];
    const multiTF = opts.multiTF || null;
    if ((!Array.isArray(input) || input.length < 60) && multiTF && typeof multiTF === "object") {
      // pick longest available TF array
      const bestKey = Object.keys(multiTF).reduce((best,k)=>{
        const len = Array.isArray(multiTF[k]) ? multiTF[k].length : 0;
        return len > (multiTF[best]?.length||0) ? k : best;
      }, Object.keys(multiTF)[0]);
      if (bestKey && Array.isArray(multiTF[bestKey]) && multiTF[bestKey].length > (input?.length||0)) {
        input = multiTF[bestKey].slice();
        if (opts.debug) console.debug(`[elliott ${VERSION}] switched to TF ${bestKey} for analysis`);
      }
    }

    const normalized = normalizeCandles(input);
    if (!normalized || normalized.length < 30) return { ok:false, error:"not_enough_data", version:VERSION };

    // compute pivots
    const left = safeNum(opts.left ?? 3, 3), right = safeNum(opts.right ?? 3, 3);
    const pivots = findPivots(normalized, left, right, opts.minPriceMovePct ?? 0.0001);
    const waves = mapWavesFromPivots(pivots);
    const atr = computeATR(normalized, safeNum(opts.atrLen ?? 14, 14));
    const slice = normalized.slice(-Math.min(500, normalized.length));
    const highs = slice.map(c=>c.high), lows = slice.map(c=>c.low);
    const fib = fibLevelsFromSwing(Math.min(...lows), Math.max(...highs));

    // detect patterns
    const hns = detectHeadAndShoulders(pivots);
    const db = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(normalized);
    const sfps = detectSFP(normalized, pivots);
    const ms = detectMarketStructure(normalized, pivots);

    const patterns = [...hns, ...db, ...tri];

    // impulse labeler and ABC
    const impulseLabel = labelImpulseFromPivots(pivots, normalized, opts);
    const abc = impulseLabel ? detectABCAfterImpulse(impulseLabel, pivots, normalized) : null;

    // price & targets
    const price = safeNum(last(normalized)?.close || 0);
    const targets = generateTargets({ price, atr, patterns, fib });

    // scoring
    const scoring = scoreEverything({ price, patterns, channels:ch, sfps, ms, impulse: impulseLabel, fib, orderBlocks });

    const trend = scoring.sentiment > 0.18 ? "Bullish" : scoring.sentiment < -0.18 ? "Bearish" : "Neutral";

    // ML features
    const ml = extractFeatures(normalized, { patterns, orderBlocks, fvgs, sfps, channels:ch, impulse: impulseLabel, fib, sentiment:scoring.sentiment, confidence:scoring.confidence, price });

    const debugInfo = opts.debug ? {
      pivotCount: pivots.length,
      patternsFound: patterns.length,
      channelsFound: ch.length,
      orderBlocksFound: orderBlocks.length,
      fvgsFound: fvgs.length,
      sfpsFound: sfps.length,
      impulseSummary: impulseLabel ? { quality: impulseLabel.quality, direction: impulseLabel.direction } : null
    } : undefined;

    return {
      ok: true,
      version: VERSION,
      pivots,
      waves,
      atr: fmt(atr,4),
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
      abc,
      impulse: impulseLabel,
      price,
      length: normalized.length,
      trend,
      mlFeatures: ml,
      debug: debugInfo
    };
  } catch (err) {
    return { ok:false, error: err?.message || String(err), version: VERSION };
  }
}

/* -------------------------
   Exports (for CommonJS compatibility if needed)
   ------------------------- */
export default { analyzeElliott, extractFeatures, normalizeCandles, VERSION };