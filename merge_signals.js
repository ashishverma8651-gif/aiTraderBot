// merge_signals.js — v2 integrated (core indicators + Elliott + ML + volume + news)
// Smart signal fusion + optional alert system

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { analyzeElliott, drawElliottWaves } from "./elliott_module.js";
import { fetchMarketData } from "./utils.js";
import indicators from "./core_indicators.js";

const FEEDBACK_FILE = path.resolve("./cache/merge_signals_feedback.json");

// ------------------------------
// Safe number helpers
// ------------------------------
const safeNum = (v) => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "object") {
    if ("value" in v && typeof v.value === "number") return v.value;
    if (Array.isArray(v) && v.length) {
      const last = v.at(-1);
      return typeof last === "number"
        ? last
        : typeof last?.macd === "number"
        ? last.macd
        : NaN;
    }
    const n = Number(Object.values(v).at(-1));
    return Number.isFinite(n) ? n : NaN;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const clamp = (val, min = 0, max = 100) =>
  Number.isNaN(val) ? 0 : Math.max(min, Math.min(max, val));

// ------------------------------
// Feedback system (file cache)
// ------------------------------
function readFeedback() {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return { entries: [], summary: {} };
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf8") || "{}");
  } catch {
    return { entries: [], summary: {} };
  }
}
function saveFeedback(obj) {
  try {
    fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn("merge_signals: feedback save failed", e?.message);
  }
}
export function recordFeedback(predictionId, correct = true) {
  try {
    const fb = readFeedback();
    const entry = { id: predictionId ?? `pred_${Date.now()}`, correct: !!correct, ts: Date.now() };
    fb.entries.push(entry);
    const total = fb.entries.length;
    const correctCount = fb.entries.filter((e) => e.correct).length;
    fb.summary = {
      total,
      correct: correctCount,
      accuracy: total ? +(correctCount / total * 100).toFixed(2) : 0,
      lastUpdated: Date.now()
    };
    saveFeedback(fb);
    return fb.summary;
  } catch (e) {
    console.warn("recordFeedback failed", e?.message);
    return null;
  }
}

// ------------------------------
// 🌐 Full Integration Analyzer
// ------------------------------
export async function analyzeAndMerge(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    console.log(`🧠 Fetching and analyzing ${symbol} (${interval})...`);

    // 1️⃣ Fetch market candles
    const { data: candles } = await fetchMarketData(symbol, interval, 500);
    if (!candles?.length) throw new Error(`No candle data for ${symbol}`);

    // 2️⃣ Run indicator analysis
    const indRes = indicators.analyzeFromCandles(candles);

    // 3️⃣ Run Elliott Wave analysis
    const ellRes = await analyzeElliott(candles, { depth: 5 });
    const ellChart = drawElliottWaves(ellRes.swings);

    // 4️⃣ Merge everything into a unified signal
    const merged = mergeSignals(indRes, ellRes, {}, {});

    // 5️⃣ Enrich output summary
    merged.symbol = symbol;
    merged.interval = interval;
    merged.elliott = ellRes;
    merged.chart = ellChart;

    merged.summary = `
📊 *${symbol} Analysis (${interval})*
━━━━━━━━━━━━━━━━━━
📈 RSI: ${indRes?.rsi?.toFixed?.(2) ?? "N/A"}  
💹 MACD: ${indRes?.macd?.toFixed?.(4) ?? "N/A"}  
💥 ATR: ${indRes?.atr?.toFixed?.(2) ?? "N/A"}  
📊 Elliott: *${ellRes.structure}* (${ellRes.summary})
📉 Confidence: ${ellRes.confidence}%
━━━━━━━━━━━━━━━━━━
📍 Bias: *${merged.bias}* (${merged.strength}%)
${merged.chart}
`;

    // 6️⃣ Optional alert on high-confidence reversal
    if (ellRes.reversal && ellRes.confidence > 70) {
      merged.alert = `⚠️ *High-Confidence Elliott Reversal* Detected in ${symbol} (${interval})`;
      console.log(merged.alert);
    }

    return merged;
  } catch (err) {
    console.error("❌ analyzeAndMerge error:", err.message);
    return { error: err.message, symbol };
  }
}

// ------------------------------
// Core merge logic (unchanged, but wrapped)
// ------------------------------
export function mergeSignals(indicators = {}, ell = {}, ml = {}, opts = {}) {
  const weights = Object.assign({
    rsi: 0.20, macd: 0.25, volume: 0.15, atr: 0.05, elliott: 0.15, news: 0.10, ml: 0.10
  }, opts.weights || {});

  const rsiVal = safeNum(indicators.rsi);
  const macdVal = safeNum(indicators.macd);
  const atrVal = safeNum(indicators.atr);
  const volVal = safeNum(indicators.vol);
  const mlProb = ml?.prob ?? safeNum(ml?.prob);
  const mlLabel = ml?.label ?? null;
  const ellBias = ell?.structure?.toLowerCase?.() ?? ell?.bias ?? "neutral";
  const ellConf = Number(ell?.confidence ?? 0);

  let rsiScore = 0;
  if (!Number.isNaN(rsiVal)) {
    if (rsiVal <= 30) rsiScore = clamp((30 - rsiVal) / 30 * 100);
    else if (rsiVal >= 70) rsiScore = clamp((rsiVal - 70) / 30 * -100);
  }
  let macdScore = !Number.isNaN(macdVal) ? clamp((macdVal / (atrVal || 1)) * 10, -100, 100) : 0;
  let volumeScore = !Number.isNaN(volVal) ? clamp(volVal / 10, -100, 100) : 0;
  let ellScore = /bull|up|impulse/.test(ellBias) ? ellConf : /bear|down|corrective/.test(ellBias) ? -ellConf : 0;
  let mlScore = !Number.isNaN(mlProb) ? (mlLabel?.toLowerCase?.() === "buy" ? mlProb : -mlProb) * 0.5 : 0;

  const weighted =
    (rsiScore * weights.rsi) +
    (macdScore * weights.macd) +
    (volumeScore * weights.volume) +
    (ellScore * weights.elliott) +
    (mlScore * weights.ml);

  const denom = Object.values(weights).reduce((a, b) => a + b, 0);
  const rawScore = denom ? weighted / denom : 0;

  let bias = "Neutral";
  if (rawScore > 10) bias = "Buy";
  else if (rawScore < -10) bias = "Sell";

  const strength = clamp(Math.abs(rawScore), 0, 100);

  return { bias, strength, score: rawScore, id: `pred_${Date.now()}`, timestamp: Date.now() };
}

export default analyzeAndMerge;