// elliott_module.js — Elliott + Pattern Engine (v1.2 Stable for Render)
// Cleaned, safe, error-free, ESModule-compatible

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function last(arr, n = 1) {
  return arr.length ? arr[arr.length - n] : null;
}

/* ------------------------------------------------------------------
   PIVOT DETECTION
------------------------------------------------------------------ */
function findPivots(candles, left = 3, right = 3) {
  const out = [];
  const n = candles.length;
  if (n < left + right + 1) return [];

  const pivots = [];

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

    if (isHigh) pivots.push({ idx: i, t: cur.t, price: high, type: "H" });
    else if (isLow) pivots.push({ idx: i, t: cur.t, price: low, type: "L" });
  }

  // compress pivots of same type
  const compressed = [];
  for (const p of pivots) {
    const lastp = compressed.at(-1);
    if (!lastp) compressed.push(p);
    else if (lastp.type === p.type) {
      if (p.type === "H" && p.price > lastp.price) compressed[compressed.length - 1] = p;
      if (p.type === "L" && p.price < lastp.price) compressed[compressed.length - 1] = p;
    } else compressed.push(p);
  }

  // enforce alternation
  for (const p of compressed) {
    const lastp = out.at(-1);
    if (!lastp) out.push(p);
    else if (lastp.type === p.type) {
      if (p.type === "H" && p.price > lastp.price) out[out.length - 1] = p;
      if (p.type === "L" && p.price < lastp.price) out[out.length - 1] = p;
    } else out.push(p);
  }

  return out;
}

/* ------------------------------------------------------------------
   WAVES
------------------------------------------------------------------ */
function mapWavesFromPivots(pivots) {
  const waves = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i];
    const b = pivots[i + 1];
    waves.push({
      from: a.idx,
      to: b.idx,
      start: a.price,
      end: b.price,
      direction: a.price < b.price ? "UP" : "DOWN",
      range: Math.abs(b.price - a.price),
      pct: a.price ? Math.abs((b.price - a.price) / a.price) * 100 : 0
    });
  }
  return waves;
}

/* ------------------------------------------------------------------
   ATR
------------------------------------------------------------------ */
function computeATR(candles, length = 14) {
  if (candles.length < 2) return 0;
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
  const arr = trs.slice(-length);
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
}

/* ------------------------------------------------------------------
   FIB LEVELS
------------------------------------------------------------------ */
function fibLevelsFromSwing(low, high) {
  const lo = safeNum(low);
  const hi = safeNum(high);
  const diff = Math.max(1e-9, hi - lo);

  return {
    lo, hi,
    retrace: {
      "0.236": hi - diff * 0.236,
      "0.382": hi - diff * 0.382,
      "0.5": hi - diff * 0.5,
      "0.618": hi - diff * 0.618,
      "0.786": hi - diff * 0.786
    },
    ext: {
      "1.272": hi + diff * 0.272,
      "1.618": hi + diff * 0.618
    }
  };
}

/* ------------------------------------------------------------------
   PATTERN: Head & Shoulders
------------------------------------------------------------------ */
function detectHeadAndShoulders(p) {
  const out = [];
  for (let i = 0; i < p.length - 4; i++) {
    const a = p[i], b = p[i + 1], c = p[i + 2], d = p[i + 3], e = p[i + 4];
    if (!a || !b || !c || !d || !e) continue;

    // H&S Top
    if (a.type === "H" && b.type === "L" && c.type === "H" && d.type === "L" && e.type === "H") {
      const headHigher = c.price > a.price && c.price > e.price;
      if (headHigher) {
        const neckline = (b.price + d.price) / 2;
        const target = neckline - (c.price - neckline);
        out.push({
          type: "HeadAndShoulders",
          side: "Bearish",
          pivots: [a, b, c, d, e],
          neckline,
          target,
          confidence: 70
        });
      }
    }

    // Inverse H&S
    if (a.type === "L" && b.type === "H" && c.type === "L" && d.type === "H" && e.type === "L") {
      const headLower = c.price < a.price && c.price < e.price;
      if (headLower) {
        const neckline = (b.price + d.price) / 2;
        const target = neckline + (neckline - c.price);
        out.push({
          type: "InverseHeadAndShoulders",
          side: "Bullish",
          pivots: [a, b, c, d, e],
          neckline,
          target,
          confidence: 70
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   DOUBLE TOP / BOTTOM
------------------------------------------------------------------ */
function detectDoubleTopsBottoms(p) {
  const out = [];
  for (let i = 0; i < p.length - 2; i++) {
    const a = p[i], b = p[i + 1], c = p[i + 2];
    if (!a || !b || !c) continue;

    if (a.type === "H" && b.type === "L" && c.type === "H") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) / 2);
      if (closeness > 0.88) {
        const height = a.price - b.price;
        out.push({
          type: "DoubleTop",
          side: "Bearish",
          pivots: [a, b, c],
          neckline: b.price,
          target: b.price - height,
          confidence: Math.round(closeness * 100)
        });
      }
    }

    if (a.type === "L" && b.type === "H" && c.type === "L") {
      const closeness = 1 - Math.abs(a.price - c.price) / ((a.price + c.price) / 2);
      if (closeness > 0.88) {
        const height = b.price - a.price;
        out.push({
          type: "DoubleBottom",
          side: "Bullish",
          pivots: [a, b, c],
          neckline: b.price,
          target: b.price + height,
          confidence: Math.round(closeness * 100)
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   TRIANGLES
------------------------------------------------------------------ */
function detectTriangles(p) {
  const out = [];
  for (let i = 0; i < p.length - 4; i++) {
    const seq = p.slice(i, i + 6);
    if (seq.length < 6) continue;

    const highs = seq.filter(x => x.type === "H").map(x => x.price);
    const lows = seq.filter(x => x.type === "L").map(x => x.price);

    if (highs.length < 2 || lows.length < 2) continue;

    if (highs[0] > highs.at(-1) && lows.at(-1) > lows[0]) {
      out.push({
        type: "Triangle",
        triType: "Symmetrical",
        pivots: seq,
        confidence: 60
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------
   CHANNELS
------------------------------------------------------------------ */
function detectChannels(pivots) {
  if (pivots.length < 6) return [];
  const seq = pivots.slice(-20);

  const highs = seq.filter(p => p.type === "H");
  const lows = seq.filter(p => p.type === "L");
  if (highs.length < 2 || lows.length < 2) return [];

  const fit = arr => {
    const n = arr.length;
    const xs = arr.map((p, i) => i);
    const ys = arr.map(p => p.price);
    const xm = xs.reduce((a, b) => a + b, 0) / n;
    const ym = ys.reduce((a, b) => a + b, 0) / n;

    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xm) * (ys[i] - ym);
      den += (xs[i] - xm) ** 2;
    }
    return { slope: den ? num / den : 0, intercept: ym - (den ? num / den : 0) * xm };
  };

  const hiFit = fit(highs);
  const loFit = fit(lows);

  return [{
    type: "Channel",
    highFit: hiFit,
    lowFit: loFit,
    confidence: 60
  }];
}

/* ------------------------------------------------------------------
   ORDER BLOCK + FVG (simple safe version)
------------------------------------------------------------------ */
function detectOrderBlocksAndFVG(candles) {
  const orderBlocks = [];
  const fvgs = [];

  for (let i = 2; i < candles.length - 1; i++) {
    const prev = candles[i - 2];
    const cur = candles[i - 1];
    const next = candles[i];

    const sizePrev = Math.abs(prev.close - prev.open);
    const sizeCur = Math.abs(cur.close - cur.open);
    const sizeNext = Math.abs(next.close - next.open);
    const big = Math.max(sizePrev, sizeCur, sizeNext);

    if (sizePrev >= big * 0.7) {
      const side = prev.close > prev.open ? "Bullish" : "Bearish";
      orderBlocks.push({
        type: "OrderBlock",
        idx: i - 2,
        side,
        levelHigh: Math.max(prev.open, prev.close),
        levelLow: Math.min(prev.open, prev.close),
        confidence: 50
      });
    }

    // FVG
    const gapHigh = Math.min(prev.open, prev.close);
    const gapLow = Math.max(next.open, next.close);
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

/* ------------------------------------------------------------------
   SFP
------------------------------------------------------------------ */
function detectSFP(candles, pivots) {
  const out = [];
  for (let i = 1; i < pivots.length - 1; i++) {
    const p = pivots[i];
    const body = candles[p.idx].close - candles[p.idx].open;

    if (p.type === "L" && body > 0) out.push({ type: "BullishSFP", pivotPrice: p.price });
    if (p.type === "H" && body < 0) out.push({ type: "BearishSFP", pivotPrice: p.price });
  }
  return out;
}

/* ------------------------------------------------------------------
   MARKET STRUCTURE
------------------------------------------------------------------ */
function detectMarketStructure(candles, pivots) {
  const out = [];
  if (pivots.length < 3) return out;

  const highs = pivots.filter(p => p.type === "H").map(p => p.price);
  const lows = pivots.filter(p => p.type === "L").map(p => p.price);

  const price = last(candles).close;

  if (price > Math.max(...highs)) out.push({ type: "BOS", side: "Bullish" });
  if (price < Math.min(...lows)) out.push({ type: "BOS", side: "Bearish" });

  return out;
}

/* ------------------------------------------------------------------
   TARGET GENERATOR
------------------------------------------------------------------ */
function generateTargets({ price, atr, patterns = [], fib }) {
  const tps = [];

  // pattern TPs
  for (const p of patterns) {
    if (p.target) {
      tps.push({
        source: p.type,
        side: p.side,
        tp: p.target,
        confidence: p.confidence || 50
      });
    }
  }

  // ZARURI fallback
  if (!tps.length) {
    tps.push({ side: "Bullish", tp: price + atr * 3, source: "ATR", confidence: 40 });
    tps.push({ side: "Bearish", tp: price - atr * 3, source: "ATR", confidence: 40 });
  }

  return { targets: tps };
}

/* ------------------------------------------------------------------
   SENTIMENT SCORING
------------------------------------------------------------------ */
function scoreEverything({ patterns, channels, sfps, ms }) {
  let score = 0;
  let weight = 0;

  for (const p of patterns) {
    const sign = p.side === "Bullish" ? 1 : -1;
    score += sign * (p.confidence / 100) * 2;
    weight += 2;
  }

  for (const c of channels) {
    const slope = c.lowFit.slope + c.highFit.slope;
    const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
    score += sign * 0.8;
    weight += 0.8;
  }

  for (const s of sfps) {
    const sign = s.type.includes("Bull") ? 1 : -1;
    score += sign * 0.5;
    weight += 0.5;
  }

  for (const m of ms) {
    const sign = m.side === "Bullish" ? 1 : -1;
    score += sign * 0.7;
    weight += 0.7;
  }

  if (weight === 0) return { sentiment: 0, confidence: 25 };

  const sentiment = score / weight;
  const confidence = Math.min(99, Math.max(10, Math.round(Math.abs(sentiment) * 100)));

  return { sentiment, confidence };
}

/* ------------------------------------------------------------------
   MAIN EXPORT
------------------------------------------------------------------ */
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!candles.length) return { ok: false, error: "no_data" };

    const pivots = findPivots(candles, opts.left || 3, opts.right || 3);
    const waves = mapWavesFromPivots(pivots);
    const atr = computeATR(candles);
    const slice = candles.slice(-200);
    const fib = fibLevelsFromSwing(
      Math.min(...slice.map(c => c.low)),
      Math.max(...slice.map(c => c.high))
    );

    const hns = detectHeadAndShoulders(pivots);
    const db = detectDoubleTopsBottoms(pivots);
    const tri = detectTriangles(pivots);
    const ch = detectChannels(pivots);
    const { orderBlocks, fvgs } = detectOrderBlocksAndFVG(candles);
    const sfps = detectSFP(candles, pivots);
    const ms = detectMarketStructure(candles, pivots);

    const patterns = [...hns, ...db, ...tri];

    const targetsObj = generateTargets({
      price: last(candles).close,
      atr,
      patterns,
      fib,
      channels: ch,
      orderBlocks
    });

    const scoring = scoreEverything({
      patterns,
      channels: ch,
      sfps,
      ms
    });

    return {
      ok: true,
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
      targets: targetsObj.targets,
      sentiment: scoring.sentiment,
      confidence: scoring.confidence
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default {
  analyzeElliott
};