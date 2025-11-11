// elliott_module.js — v9.7 Elliott + ML Hybrid
import { runMLPrediction } from "./ml_module_v9.js";  // ML integration
import { calcRSI, calcMACD } from "./core_indicators.js";
import CONFIG from "./config.js";


// Example: after fetching 1-day data
await trainModelFromData(dayCandles);

// Example: predict from 15m window
const ml = runMLPrediction(lastCandles);
console.log("🤖 ML says:", ml.label, "Confidence:", ml.prob + "%");


// ---------- Utility: find swing highs & lows ----------
function findSwingPoints(kl, lookback = 50) {
  const highs = [], lows = [];
  if (!kl || kl.length < 5) return { highs, lows };

  const n = Math.min(lookback, kl.length - 2);
  for (let i = kl.length - n; i < kl.length - 2; i++) {
    const prev = kl[i - 1] || kl[i];
    const cur  = kl[i];
    const next = kl[i + 1] || kl[i];

    if (cur.high >= prev.high && cur.high >= next.high)
      highs.push({ i, price: cur.high });
    if (cur.low <= prev.low && cur.low <= next.low)
      lows.push({ i, price: cur.low });
  }
  return { highs, lows };
}

// ---------- Elliott analyzer (single timeframe) ----------
function elliottAnalyze(kl) {
  if (!kl || kl.length < 15) return null;
  const { highs, lows } = findSwingPoints(kl, 80);
  const swings = [...highs.map(h => ({ t: h.i, p: h.price, type: "H" })),
                  ...lows.map(l => ({ t: l.i, p: l.price, type: "L" }))].sort((a,b)=>a.t-b.t);
  if (swings.length < 5) return { structure: "flat", wave: "N/A", bias: "Neutral", confidence: 0.3 };

  // trend detection
  const seq = swings.slice(-6);
  const prices = seq.map(s=>s.p);
  const up = prices[prices.length-1] > prices[0];
  const bias = up ? "Bullish" : "Bearish";

  // naive wave label
  const wave = seq.length >= 5 ? (up ? "Wave 5" : "Wave C") : (up ? "Wave 3" : "Wave A");
  const structure = up ? "impulse" : "correction";
  const confidence = Math.min(0.9, 0.4 + Math.abs(prices[prices.length-1] - prices[0]) / prices[0]);

  return { bias, structure, wave, confidence, seq };
}

// ---------- Hybrid Analysis (Elliott + ML + Indicators) ----------
export async function hybridElliottAnalysis(allData) {
  const tfResults = {};
  const timeframes = CONFIG.INTERVALS || ["1m","5m","15m","30m","1h"];

  let bull = 0, bear = 0, confSum = 0;

  for (const tf of timeframes) {
    const kl = allData[tf] || [];
    if (!kl.length) continue;

    const ell = elliottAnalyze(kl);
    if (!ell) continue;

    // feature extraction for ML
    const rsi = calcRSI(kl, 14);
    const macd = calcMACD(kl, 12, 26, 9);
    const last = kl.at(-1);
    const change = ((last.close - kl[0].close) / kl[0].close) * 100;
    const vol = kl.map(k=>k.vol||0).slice(-20);
    const volAvg = vol.reduce((a,b)=>a+b,0)/(vol.length||1);
    const feat = [
      change / 10,                   // normalized price move
      (rsi - 50) / 50,               // RSI deviation
      macd.hist / (last.close || 1), // MACD histogram
      (last.vol / volAvg) - 1,       // volume spike ratio
      ell.confidence                 // from Elliott
    ];

    // ML prediction (trained model output 0–1)
    const mlScore = await runMLPrediction(feat); // e.g. 0.85 means bullish
    const mlBias = mlScore > 0.55 ? "Bullish" : mlScore < 0.45 ? "Bearish" : "Neutral";

    // merge Elliott + ML
    const mergedBias = (ell.bias === mlBias) ? ell.bias : 
                       (mlScore > 0.55 ? "Bullish" : mlScore < 0.45 ? "Bearish" : "Neutral");
    const combinedConfidence = Math.round(((ell.confidence * 100) + (mlScore * 100)) / 2);

    if (mergedBias === "Bullish") bull++;
    if (mergedBias === "Bearish") bear++;
    confSum += combinedConfidence;

    tfResults[tf] = {
      elliott: ell,
      mlScore: (mlScore*100).toFixed(1),
      bias: mergedBias,
      confidence: combinedConfidence
    };
  }

  // overall bias
  let overallBias = "Neutral";
  if (bull > bear) overallBias = "Bullish";
  else if (bear > bull) overallBias = "Bearish";

  const avgConf = Math.round(confSum / (bull + bear || 1));

  return {
    overallBias,
    confidence: avgConf,
    results: tfResults
  };
}