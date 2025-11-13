// =====================================
// merge_signals.js — v3.2 Enhanced
// Merges: Core Indicators + Elliott + ML + Volume + News + Feedback
// =====================================

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchNews } from "./news_social.js"; // 🔥 New integration

const FEEDBACK_FILE = path.resolve("./cache/merge_signals_feedback.json");

// ---------- SAFE HELPERS ----------
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

const clamp = (val, min = -100, max = 100) =>
  Math.max(min, Math.min(max, Number.isNaN(val) ? 0 : val));

// ---------- FEEDBACK ----------
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
      lastUpdated: Date.now(),
    };
    saveFeedback(fb);
    return fb.summary;
  } catch (e) {
    console.warn("recordFeedback failed", e?.message);
    return null;
  }
}

// ---------- MAIN MERGER ----------
export async function mergeSignals(indicators = {}, ell = {}, ml = {}, opts = {}) {
  // Fetch and include news sentiment (topic from config or opts)
  const topic = opts.topic || CONFIG?.symbol || "BTC";
  let newsImpact = 0;
  let newsPolarity = "Neutral";
  try {
    const newsData = await fetchNews(topic);
    newsImpact = newsData?.newsImpact ?? 0;
    newsPolarity = newsData?.polarity ?? "Neutral";
  } catch {
    newsImpact = 0;
  }

  const weights = Object.assign(
    {
      rsi: 0.20,
      macd: 0.25,
      volume: 0.15,
      atr: 0.05,
      elliott: 0.15,
      news: 0.10,
      ml: 0.10,
    },
    opts.weights || {}
  );

  // Extract indicator values
  const rsiVal = safeNum(indicators.rsi);
  const macdVal = safeNum(indicators.macd);
  const atrVal = safeNum(indicators.atr);
  const volVal = safeNum(indicators.vol);

  // ML data
  const mlProb = safeNum(ml?.prob ?? 0);
  const mlLabel = (ml && ml.label) ? String(ml.label) : "Neutral";

  // Elliott wave info
  const ellBias = (ell?.structure || ell?.direction || ell?.bias || "").toLowerCase();
  const ellConf = safeNum(ell?.confidence ?? 0);

  // ---------- SCORE CALCULATIONS ----------

  // RSI
  let rsiScore = 0;
  if (!Number.isNaN(rsiVal)) {
    if (rsiVal <= 30) rsiScore = ((30 - rsiVal) / 30) * 100; // buy
    else if (rsiVal >= 70) rsiScore = -((rsiVal - 70) / 30) * 100; // sell
  }

  // MACD
  let macdScore = 0;
  if (!Number.isNaN(macdVal)) {
    const denom = Math.max(1, Math.abs(atrVal) || 1);
    macdScore = clamp((macdVal / denom) * 10);
  }

  // Volume
  let volumeScore = 0;
  const avgVol = safeNum(indicators.avgVol);
  if (!Number.isNaN(volVal) && avgVol > 0) {
    if (volVal > avgVol * 1.5) volumeScore = 30;
    else if (volVal > avgVol * 1.2) volumeScore = 15;
    else if (volVal < avgVol * 0.5) volumeScore = -10;
  }

  // Elliott
  let ellScore = 0;
  if (ellBias.includes("up") || ellBias.includes("bull")) ellScore = ellConf;
  else if (ellBias.includes("down") || ellBias.includes("bear")) ellScore = -ellConf;

  // ML
  let mlScore = 0;
  if (!Number.isNaN(mlProb)) {
    if (/buy/i.test(mlLabel)) mlScore = mlProb * 0.5;
    else if (/sell/i.test(mlLabel)) mlScore = -mlProb * 0.5;
  }

  // News 🔥
  let newsScore = clamp(newsImpact);
  if (newsPolarity === "Positive") newsScore += 10;
  else if (newsPolarity === "Negative") newsScore -= 10;

  // ---------- WEIGHTED AVERAGE ----------
  const numerator =
    rsiScore * weights.rsi +
    macdScore * weights.macd +
    volumeScore * weights.volume +
    ellScore * weights.elliott +
    newsScore * weights.news +
    mlScore * weights.ml;

  const denom = Object.values(weights).reduce((a, b) => a + b, 0);
  const rawScore = denom ? numerator / denom : 0;

  let bias = "Neutral";
  if (rawScore > 10) bias = "Buy";
  else if (rawScore < -10) bias = "Sell";
  const strength = clamp(Math.abs(rawScore), 0, 100);

  // ---------- RATIONALE ----------
  const rationale = [];
  rationale.push(`RSI: ${rsiVal?.toFixed(2) ?? "n/a"}`);
  rationale.push(`MACD: ${macdVal?.toFixed(2) ?? "n/a"}`);
  rationale.push(`Elliott: ${ellBias || "n/a"} (${ellConf}%)`);
  rationale.push(`News: ${newsPolarity} (${newsImpact})`);
  rationale.push(`ML: ${mlLabel} (${mlProb}%)`);

  // ---------- OUTPUT ----------
  const id = `pred_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return {
    id,
    bias,
    strength,
    score: rawScore,
    mlProb,
    newsImpact,
    newsPolarity,
    rationale,
    signals: {
      rsi: rsiVal,
      macd: macdVal,
      vol: volVal,
      ellScore,
      mlScore,
      newsScore,
    },
    timestamp: Date.now(),
  };
}

export default mergeSignals;