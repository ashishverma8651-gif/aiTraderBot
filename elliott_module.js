// elliott_module.js — v4-enhanced (Smart Pattern + Channel + Integration-ready)

// ----------------------------
// Helpers
// ----------------------------
function avgPrice(c) {
  return (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
}

function safeNumber(x, fallback = NaN) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function fiboRatio(a, b) {
  if (!isFinite(a) || !isFinite(b) || b === 0) return 0;
  return Math.abs(a / b);
}

function getSwingPoints(data, depth = 5) {
  const swings = [];
  if (!Array.isArray(data) || data.length < depth * 2 + 1) return swings;

  for (let i = depth; i < data.length - depth; i++) {
    const cur = avgPrice(data[i]);
    const prev = data.slice(i - depth, i).map(avgPrice);
    const next = data.slice(i + 1, i + 1 + depth).map(avgPrice);

    if (cur > Math.max(...prev) && cur > Math.max(...next)) {
      swings.push({ type: "high", index: i, price: cur });
    } else if (cur < Math.min(...prev) && cur < Math.min(...next)) {
      swings.push({ type: "low", index: i, price: cur });
    }
  }
  return swings;
}

// ----------------------------
// Main Analyzer
// ----------------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!Array.isArray(candles) || candles.length < 30) {
      return { wave: "N/A", confidence: 0, summary: "Insufficient data" };
    }

    const C = candles
      .map((c) => ({
        t: c.t || c.time || c.timestamp || Date.now(),
        open: safeNumber(c.open ?? c.o),
        high: safeNumber(c.high ?? c.h),
        low: safeNumber(c.low ?? c.l),
        close: safeNumber(c.close ?? c.c),
        vol: safeNumber(c.vol ?? c.v ?? c.volume, 0),
      }))
      .filter((c) => !Number.isNaN(c.close));

    const depth = Math.max(3, opts.depth ?? 5);
    const swings = getSwingPoints(C, depth);
    if (swings.length < 6)
      return { wave: "N/A", confidence: 0, summary: "Not enough swing structure" };

    const waves = swings.slice(-6);
    const diffs = [];
    for (let i = 1; i < waves.length; i++) {
      diffs.push(waves[i].price - waves[i - 1].price);
    }

    const direction =
      (diffs.find((d) => Math.abs(d) > 0) ?? 0) > 0 ? "up" : "down";

    const fibA = fiboRatio(diffs[2] ?? 0, diffs[0] ?? 1);
    const fibB = fiboRatio(diffs[4] ?? 0, diffs[2] ?? 1);

    let confidence = 40;
    let patternType = "Ambiguous";
    let summary = "";

    if (direction === "up" && fibA > 0.5 && fibA < 2 && fibB > 0.5 && fibB < 2) {
      patternType = "Impulse";
      summary = "Impulse (Bullish) pattern forming";
      confidence += 30;
    } else if (direction === "down" && fibA > 0.5 && fibB > 0.5) {
      patternType = "Corrective";
      summary = "Corrective (Bearish) pattern forming";
      confidence += 25;
    } else {
      summary = "Mixed/unclear wave structure";
    }

    // Reversal detection
    const lastDiff = diffs.at(-1) ?? 0;
    const prevDiff = diffs.at(-2) ?? 0;
    let reversal = false;
    if (direction === "up" && lastDiff < 0 && Math.abs(lastDiff) > Math.abs(prevDiff) * 0.4) {
      reversal = true;
      summary += " ⚠️ Possible Wave-5 top reversal";
      confidence += 10;
    } else if (direction === "down" && lastDiff > 0 && Math.abs(lastDiff) > Math.abs(prevDiff) * 0.4) {
      reversal = true;
      summary += " ⚠️ Possible bottom exhaustion";
      confidence += 10;
    }

    // Channel trend (slope regression)
    const slice = C.slice(-Math.min(60, C.length));
    const xs = slice.map((_, i) => i);
    const ys = slice.map((c) => avgPrice(c));
    const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0,
      den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const slopePct = (slope / (yMean || 1)) * 100;

    const channelTrend =
      slopePct > 0.05
        ? "Ascending Channel"
        : slopePct < -0.05
        ? "Descending Channel"
        : "Sideways";

    const highs = slice.map((c) => c.high);
    const lows = slice.map((c) => c.low);
    const channelWidthPct =
      ((Math.max(...highs) - Math.min(...lows)) / (Math.min(...lows) || 1)) *
      100;

    return {
      wave: 5,
      structure: patternType,
      direction,
      fibA: +fibA.toFixed(3),
      fibB: +fibB.toFixed(3),
      reversal,
      channelTrend,
      channelWidthPct: +channelWidthPct.toFixed(2),
      slopePct: +slopePct.toFixed(4),
      patternType,
      strength: confidence > 70 ? "Strong" : confidence > 50 ? "Moderate" : "Weak",
      confidence: Math.min(100, Math.round(confidence)),
      summary,
      swings,
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error("Elliott analyze error:", err);
    return { wave: "N/A", confidence: 0, summary: "Error during analysis", status: "error" };
  }
}

export default analyzeElliott;