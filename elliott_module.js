// elliott_module.js — v3 (Advanced Elliott + Fibonacci + Channel Pattern Detection)

import math from "mathjs";

// ----------------------------
// Helper Functions
// ----------------------------
function getSwingPoints(data, depth = 5) {
  const swings = [];
  for (let i = depth; i < data.length - depth; i++) {
    const prev = data.slice(i - depth, i).map((c) => c.close);
    const next = data.slice(i + 1, i + 1 + depth).map((c) => c.close);
    const price = data[i].close;
    if (price > Math.max(...prev) && price > Math.max(...next)) {
      swings.push({ type: "high", index: i, price });
    } else if (price < Math.min(...prev) && price < Math.min(...next)) {
      swings.push({ type: "low", index: i, price });
    }
  }
  return swings;
}

function fiboRatio(a, b) {
  if (!a || !b) return 0;
  const ratio = Math.abs(a / b);
  return Number(ratio.toFixed(3));
}

// ----------------------------
// Core Elliott Analyzer
// ----------------------------
export async function analyzeElliott(candles = []) {
  try {
    if (!Array.isArray(candles) || candles.length < 50)
      return { wave: "N/A", confidence: 0, summary: "Insufficient data" };

    const closes = candles.map((c) => +c.close);
    const swings = getSwingPoints(candles, 5);

    if (swings.length < 6)
      return { wave: "N/A", confidence: 0, summary: "Not enough swing structure" };

    // Try to form 5-wave pattern
    const waves = swings.slice(-6);
    const diffs = [];
    for (let i = 1; i < waves.length; i++) {
      diffs.push(waves[i].price - waves[i - 1].price);
    }

    const direction = diffs[0] > 0 ? "up" : "down";
    const waveCount = 5;
    const fibA = fiboRatio(diffs[2], diffs[0]);
    const fibB = fiboRatio(diffs[4], diffs[2]);

    // Basic Elliott heuristic rules
    let summary = `Detected ${direction.toUpperCase()} Wave Structure `;
    let confidence = 50;

    if (direction === "up" && fibA > 0.5 && fibA < 2 && fibB > 0.5 && fibB < 2) {
      summary += "🟢 Impulse Wave (Bullish)";
      confidence += 25;
    } else if (direction === "down" && fibA > 0.5 && fibB > 0.5) {
      summary += "🔴 Corrective Wave (Bearish)";
      confidence += 20;
    } else {
      summary += "⚪ Mixed / Sideways Pattern";
    }

    // Detect possible Wave 5 reversal
    const lastWave = diffs.at(-1);
    const prevWave = diffs.at(-2);
    const reversal =
      direction === "up"
        ? lastWave < 0 && Math.abs(lastWave) > Math.abs(prevWave) * 0.5
        : lastWave > 0 && Math.abs(lastWave) > Math.abs(prevWave) * 0.5;

    if (reversal) {
      summary += " ⚠️ Potential Wave 5 Reversal Zone Detected";
      confidence += 15;
    }

    // Channel detection (simple regression channel)
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const avgHigh = highs.reduce((a, b) => a + b, 0) / highs.length;
    const avgLow = lows.reduce((a, b) => a + b, 0) / lows.length;
    const channelWidth = (avgHigh - avgLow) / avgLow;

    let channelTrend = "Sideways";
    if (channelWidth > 0.015 && direction === "up") channelTrend = "Ascending Channel 📈";
    else if (channelWidth > 0.015 && direction === "down") channelTrend = "Descending Channel 📉";

    return {
      structure: direction === "up" ? "Impulse" : "Corrective",
      wave: waveCount,
      fibA,
      fibB,
      channelTrend,
      confidence: Math.min(100, confidence),
      summary,
    };
  } catch (err) {
    console.warn("Elliott analysis failed:", err.message);
    return { wave: "N/A", confidence: 0, summary: "Analysis error" };
  }
}

// ✅ Default export for safe import
export default analyzeElliott;