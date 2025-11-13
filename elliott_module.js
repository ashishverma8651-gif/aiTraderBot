// elliott_module.js — v3.1 (Enhanced + Safe + Chart Export)
// Advanced Elliott + Fibonacci + Channel detection + visualization

// ----------------------------
// Helpers
// ----------------------------
function getSwingPoints(data, depth = 5) {
  const swings = [];
  if (!Array.isArray(data) || data.length < depth * 2 + 1) return swings;
  for (let i = depth; i < data.length - depth; i++) {
    const prev = data.slice(i - depth, i).map(c => c.close);
    const next = data.slice(i + 1, i + 1 + depth).map(c => c.close);
    const price = Number(data[i].close);
    if (Number.isNaN(price)) continue;
    if (price > Math.max(...prev) && price > Math.max(...next)) {
      swings.push({ type: "high", index: i, price });
    } else if (price < Math.min(...prev) && price < Math.min(...next)) {
      swings.push({ type: "low", index: i, price });
    }
  }
  return swings;
}

function fiboRatio(a, b) {
  if (!isFinite(a) || !isFinite(b) || b === 0) return 0;
  return Math.abs(a / b);
}

function safeNumber(x, fallback = NaN) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// ----------------------------
// analyzeElliott - main logic
// ----------------------------
export async function analyzeElliott(candles = [], opts = {}) {
  try {
    if (!Array.isArray(candles) || candles.length < 30)
      return { wave: "N/A", confidence: 0, summary: "Insufficient data" };

    const C = candles.map(c => ({
      t: safeNumber(c.t ?? c.time ?? c.timestamp ?? Date.now()),
      open: safeNumber(c.open ?? c.o),
      high: safeNumber(c.high ?? c.h),
      low: safeNumber(c.low ?? c.l),
      close: safeNumber(c.close ?? c.c),
      vol: safeNumber(c.vol ?? c.v ?? c.volume, 0),
    })).filter(c => !Number.isNaN(c.close));

    if (C.length < 30)
      return { wave: "N/A", confidence: 0, summary: "Not enough valid candles" };

    const depth = Math.max(3, opts.depth ?? 5);
    const swings = getSwingPoints(C, depth);
    if (swings.length < 6)
      return { wave: "N/A", confidence: 0, summary: "Not enough swing structure" };

    const waves = swings.slice(-6);
    const diffs = [];
    for (let i = 1; i < waves.length; i++) diffs.push(waves[i].price - waves[i - 1].price);

    const firstDiff = diffs.find(d => Math.abs(d) > 0) ?? 0;
    const direction = firstDiff > 0 ? "up" : firstDiff < 0 ? "down" : "neutral";

    const fibA = fiboRatio(diffs[2] ?? 0, diffs[0] ?? 1);
    const fibB = fiboRatio(diffs[4] ?? 0, diffs[2] ?? 1);

    let summary = `Detected ${direction.toUpperCase()} structure.`;
    let confidence = 40;

    if (direction === "up" && fibA > 0.3 && fibA < 3 && fibB > 0.3 && fibB < 3) {
      summary = "Impulse-like structure (bullish candidate)";
      confidence += 30;
    } else if (direction === "down" && fibA > 0.3 && fibB > 0.3) {
      summary = "Corrective-like structure (bearish candidate)";
      confidence += 20;
    } else summary = "Mixed / ambiguous structure";

    const lastDiff = diffs.at(-1) ?? 0;
    const prevDiff = diffs.at(-2) ?? 0;
    let reversal = false;
    if (direction === "up") reversal = lastDiff < 0 && Math.abs(lastDiff) > Math.abs(prevDiff) * 0.4;
    if (direction === "down") reversal = lastDiff > 0 && Math.abs(lastDiff) > Math.abs(prevDiff) * 0.4;
    if (reversal) {
      summary += " ⚠️ Possible Wave-5 reversal / exhaustion";
      confidence += 15;
    }

    const n = Math.min(40, C.length);
    const slice = C.slice(-n);
    const xs = slice.map((_, i) => i);
    const ys = slice.map(c => c.close);
    const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    const slopePct = (slope / (yMean || 1)) * 100;

    let channelTrend = "Sideways";
    if (slopePct > 0.03) channelTrend = "Ascending Channel";
    else if (slopePct < -0.03) channelTrend = "Descending Channel";

    const highs = slice.map(c => c.high);
    const lows = slice.map(c => c.low);
    const avgHigh = highs.reduce((a, b) => a + b, 0) / highs.length;
    const avgLow = lows.reduce((a, b) => a + b, 0) / lows.length;
    const channelWidthPct = ((avgHigh - avgLow) / (avgLow || 1)) * 100;

    return {
      structure: direction === "up" ? "Impulse-like" : direction === "down" ? "Corrective-like" : "Neutral",
      wave: 5,
      fibA: Number(fibA.toFixed(3)),
      fibB: Number(fibB.toFixed(3)),
      channelTrend,
      channelWidthPct: Number(channelWidthPct.toFixed(2)),
      slopePct: Number(slopePct.toFixed(4)),
      reversal,
      confidence: Math.min(100, Math.round(confidence)),
      summary,
      swings,
    };
  } catch (err) {
    console.warn("Elliott analyze error:", err.message || err);
    return { wave: "N/A", confidence: 0, summary: "Error during analysis" };
  }
}

// ----------------------------
// 🧩 Simple Visual Chart Export
// ----------------------------
export function drawElliottWaves(swings = []) {
  if (!Array.isArray(swings) || swings.length === 0) return "📉 No wave data";
  let chart = "📈 <b>Elliott Wave Structure</b>\n";
  for (let i = 0; i < swings.length; i++) {
    const s = swings[i];
    const emoji = s.type === "high" ? "🔺" : "🔻";
    chart += `Wave ${i + 1}: ${emoji} ${s.price.toFixed(2)} (${s.type})\n`;
  }
  return chart.trim();
}

// ----------------------------
// Exports
// ----------------------------
export default analyzeElliott;
export { analyzeElliott };