// ml_module_v9_8.js
// Ultra-stable ML module
// - TP selection v2 (direction-strict, volatility-adaptive, RR-safe)
// - Probability smoothing (EMA)
// - News weighting v3 (decay + impact scaling)
// - Accuracy Tracker Pro (per TF, per symbol, streaks)
// - Micro model improved

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";
const { fetchNewsBundle } = News;

// ---------------------------
// Config / Storage
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const STATE_FILE = path.join(LOG_DIR, "state.json"); // NEW: For smoothed probs + stats cache

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function readJsonSafe(f) {
  try {
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf8") || "{}");
  } catch { return {}; }
}
function writeJsonSafe(f, data) {
  try { fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8"); } catch {}
}

// ---------------------------
// GLOBAL STATE (probability smoothing + accuracy cache)
// ---------------------------
let STATE = readJsonSafe(STATE_FILE) || {
  smooth: {},     // { "BTCUSDT_15m": { bull, bear, neutral } }
};
function saveState() { writeJsonSafe(STATE_FILE, STATE); }

// ---------------------------
// Prediction + Outcome Logging
// ---------------------------
function safePush(file, obj) {
  const data = readJsonSafe(file);
  if (!Array.isArray(data.list)) data.list = [];
  data.list.push(obj);
  writeJsonSafe(file, data);
}

export function recordPrediction(p) {
  safePush(PRED_FILE, { ...p, t: Date.now() });
}

export function recordOutcome(o) {
  safePush(OUT_FILE, { ...o, t: Date.now() });
}

// ---------------------------
// Accuracy Tracker PRO v3
// ---------------------------
export function calculateAccuracy() {
  const P = readJsonSafe(PRED_FILE).list || [];
  const O = readJsonSafe(OUT_FILE).list || [];

  let total = O.length;
  let correct = O.filter(x => x.correct).length;

  const byTF = {};
  const bySymbol = {};
  let winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0;

  for (const o of O) {
    // streak logic
    if (o.correct) {
      winStreak++;
      lossStreak = 0;
    } else {
      lossStreak++;
      winStreak = 0;
    }
    maxWin = Math.max(maxWin, winStreak);
    maxLoss = Math.max(maxLoss, lossStreak);

    // tf stats
    if (!byTF[o.tf]) byTF[o.tf] = { win:0, lose:0 };
    o.correct ? byTF[o.tf].win++ : byTF[o.tf].lose++;

    // symbol stats
    if (!bySymbol[o.symbol]) bySymbol[o.symbol] = { win:0, lose:0 };
    o.correct ? bySymbol[o.symbol].win++ : bySymbol[o.symbol].lose++;
  }

  return {
    accuracy: total ? Number(((correct/total)*100).toFixed(2)) : 0,
    total,
    correct,
    byTF,
    bySymbol,
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss
  };
}

// ---------------------------
// Utilities
// ---------------------------
const EPS = 1e-12;
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isNum(n) { return typeof n === "number" && Number.isFinite(n); }

function softmax3(a,b,c) {
  const m = Math.max(a,b,c);
  const eA = Math.exp(a-m), eB = Math.exp(b-m), eC = Math.exp(c-m);
  const s = eA+eB+eC+EPS;
  return [eA/s, eB/s, eC/s];
}

// ---------------------------
// Features (fast, safe)
// ---------------------------
function buildFeatures(candles) {
  if (!candles?.length) return null;
  const n = candles.length;
  const last = candles[n-1];
  const close = Number(last.close);

  const closes = candles.map(c => Number(c.close));
  const highs = candles.map(c => Number(c.high));
  const lows  = candles.map(c => Number(c.low));
  const vols  = candles.map(c => Number(c.volume ?? 0));

  // Momentum
  const mom = (i) => {
    if (n > i) return (close - closes[n-1-i]) / Math.max(1, closes[n-1-i]);
    return 0;
  };

  // Slope regression
  const len = Math.min(30, n);
  let sx=0, sy=0;
  for (let i=0;i<len;i++) { sx+=i; sy+=closes[n-len+i]; }
  sx/=len; sy/=len;
  let num=0, den=0;
  for (let i=0;i<len;i++) {
    let x=i, y=closes[n-len+i];
    num += (x-sx)*(y-sy);
    den += (x-sx)*(x-sx);
  }
  const slope = den===0 ? 0 : num/den;

  // ATR
  let atr = 0;
  try {
    if (indicators.computeATR) atr = indicators.computeATR(candles);
  } catch {}
  atr = isNum(atr) ? atr : Math.abs(highs[n-1]-lows[n-1]);

  // RSI / MACD
  let rsi = null, macd = null;
  try { rsi = indicators.computeRSI?.(candles) ?? null; } catch {}
  try { macd = indicators.computeMACD?.(candles)?.hist ?? null; } catch {}

  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(20, vols.length));
  const lastVol = vols[n-1] || 0;

  return {
    close,
    mom5: mom(5),
    mom20: mom(20),
    slope,
    atr,
    rsi,
    macd,
    avgVol,
    lastVol,
    high: highs[n-1],
    low: lows[n-1]
  };
}

// ---------------------------
// PART 2/3 — Candidate TP builders, RR-safe chooser, news helpers, smoothing
// ---------------------------

// Candidate TP generator (Elliott-first, ATR fallback)
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isNum(tp) || tp <= 0) continue;
      const ageDays = Number(t.ageDays ?? 0);
      const conf = clamp(Number(t.confidence ?? ell.confidence ?? 40), 0, 100);
      const adjConf = conf * (ageDays > 7 ? 0.6 : 1.0);
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(adjConf) });
    }
  }

  // Fib exts fallback
  if (!out.length && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }

  // ATR-based fallback (both sides)
  if (!out.length) {
    out.push({ tp: Number(price + (atr || price*0.002) * 2), source: 'ATR_UP', confidence: 30 });
    out.push({ tp: Number(price - (atr || price*0.002) * 2), source: 'ATR_DOWN', confidence: 30 });
  }

  // dedupe by rounded price keep max confidence
  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// Risk metrics
function computeRiskMetrics(price, tp, sl) {
  if (!isNum(price) || !isNum(tp) || !isNum(sl)) return null;
  const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
  const percMove = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isNum(rr) ? rr : null, percMove: isNum(percMove) ? percMove : null };
}

// chooseCandidateTP: RR-safe, direction-aware, returns chosen object or null
function chooseCandidateTP(candidates, dir, price, atr, feats, maxRiskRR = 10) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const multBase = clamp((feats?.atr || atr || price*0.002) / Math.max(EPS, price), 0.0005, 0.1);
  const volFactor = clamp(multBase / 0.002, 0.5, 3.0);

  const directionCmp = dir === "Bullish" ? (t => t.tp > price)
                     : dir === "Bearish" ? (t => t.tp < price)
                     : (() => true);

  const filtered = candidates.filter(directionCmp);
  const pool = filtered.length ? filtered : candidates;

  const scored = pool.map(c => {
    const dist = Math.abs(c.tp - price);
    const prox = 1 / (1 + Math.log(1 + dist / Math.max(1, feats?.atr || atr || price*0.002)));
    const score = (c.confidence || 40) * prox * volFactor;
    return { ...c, score, dist };
  }).sort((a,b) => b.score - a.score);

  for (const cand of scored) {
    // conservative SL choice
    let sl;
    if (dir === "Bullish") sl = Number((price - (feats?.atr || atr || price*0.002) * 2).toFixed(8));
    else if (dir === "Bearish") sl = Number((price + (feats?.atr || atr || price*0.002) * 2).toFixed(8));
    else sl = cand.tp > price ? Number((price - (feats?.atr || atr || price*0.002) * 1.5).toFixed(8))
                              : Number((price + (feats?.atr || atr || price*0.002) * 1.5).toFixed(8));

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    if (!metrics || !isNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRiskRR) continue;

    const minTpDist = Math.max((feats?.atr || atr || price*0.002) * 0.6, price * 0.0005);
    if (cand.dist < minTpDist) continue;

    if (Math.abs(cand.tp - price) < (price * 1e-9)) continue;

    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, reason: "best_conf_and_rr", suggestedSL: sl, rr: metrics.rr };
  }

  // fallback: top scored -> ATR-based fallback TP
  const top = scored[0];
  if (!top) return null;
  const mult = dir === "Bullish" ? 2.0 : dir === "Bearish" ? 2.0 : 1.5;
  const fallbackTP = dir === "Bullish" ? Number((price + (feats?.atr || atr || price*0.002) * mult).toFixed(8))
                                      : dir === "Bearish" ? Number((price - (feats?.atr || atr || price*0.002) * mult).toFixed(8))
                                                           : Number(top.tp);
  const sl = dir === "Bullish" ? Number((price - (feats?.atr || atr || price*0.002) * 2).toFixed(8))
                               : dir === "Bearish" ? Number((price + (feats?.atr || atr || price*0.002) * 2).toFixed(8))
                                                    : null;
  const metrics = computeRiskMetrics(price, fallbackTP, sl);
  return { tp: fallbackTP, source: "AUTO_ATR", confidence: top.confidence || 40, reason: "fallback_atr", suggestedSL: sl, rr: metrics?.rr ?? null };
}

// ---------------------------
// Smoothing (EMA) for probabilities stored in STATE
// ---------------------------
function smoothProbs(key, probs, alpha = 0.25) {
  if (!STATE.smooth) STATE.smooth = {};
  const prev = STATE.smooth[key] || null;
  if (!prev) {
    STATE.smooth[key] = { bull: probs.bull, bear: probs.bear, neutral: probs.neutral };
  } else {
    STATE.smooth[key] = {
      bull: prev.bull * (1 - alpha) + (probs.bull * alpha),
      bear: prev.bear * (1 - alpha) + (probs.bear * alpha),
      neutral: prev.neutral * (1 - alpha) + (probs.neutral * alpha)
    };
  }
  saveState();
  const s = STATE.smooth[key];
  // normalize to sum 100
  const sum = s.bull + s.bear + s.neutral || 1;
  return {
    bull: Math.round((s.bull / sum) * 10000) / 100,
    bear: Math.round((s.bear / sum) * 10000) / 100,
    neutral: Math.round((s.neutral / sum) * 10000) / 100
  };
}

// ---------------------------
// News helper (returns normalized sentiment and impact multiplier)
function normalizeNews(news) {
  if (!news) return { sentiment: 0.5, impactMul: 0.25, raw: null };
  const sent = (typeof news.sentiment === "number") ? clamp(news.sentiment, 0, 1) : 0.5;
  const impact = (news.impact || "low").toString().toLowerCase();
  const mul = impact === "high" ? 1.0 : (impact === "moderate" ? 0.6 : 0.25);
  return { sentiment: sent, impactMul: mul, raw: news };
}

// ===========================================================
// PART 3/3  — MAIN ML ENGINE (runMLPrediction + microPrediction)
// ===========================================================

export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  try {
    // Fetch candles MTF
    const tfs = [tf, "1m"];
    const mtf = await fetchMultiTF(symbol, tfs);

    const main = mtf[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isNum(main.price) && main.price ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 10 || !isNum(price) || price <= 0) {
      return {
        modelVersion: STATE.modelVersion,
        symbol,
        tf,
        direction: "Neutral",
        probs: { bull: 33.33, bear: 33.33, neutral: 33.33 },
        maxProb: 33.33,
        tpEstimate: null,
        slEstimate: null,
        explanation: "insufficient data"
      };
    }

    // Feature extraction
    const feats = buildFeaturesFromCandles(candles);
    const microCandles = (mtf["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    // Elliott Wave
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch { ell = null; }

    // News sentiment
    let rawNews = null;
    try { rawNews = await fetchNewsBundle(symbol); } catch {}
    const news = normalizeNews(rawNews);

    const atr = Math.max(feats.atr || 0, price * 0.0006);
    const volRatio = clamp(atr / price, 0, 0.06);

    // -------------------------------------------------------
    // ML scoring system (adaptive)
    // -------------------------------------------------------
    let bull = 0, bear = 0;

    // Trend slope
    bull += clamp(feats.slope * 16, -18, 18);
    bear -= clamp(feats.slope * 16, -18, 18);

    // Momentum
    bull += clamp(feats.mom5 * 100 * 0.20, -10, 10);
    bear -= clamp(feats.mom5 * 100 * 0.20, -10, 10);

    // RSI
    if (isNum(feats.rsi)) {
      const r = (feats.rsi - 50) / 50;
      bull += r * 4.2;
      bear -= r * 4.2;
    }

    // MACD
    if (isNum(feats.macdHist)) {
      const m = Math.tanh(feats.macdHist / (atr || 1)) * 2.3;
      bull += m;
      bear -= m;
    }

    // Micro trend boost
    if (microFeats?.slope) {
      bull += clamp(microFeats.slope * 8, -3, 3);
      bear -= clamp(microFeats.slope * 8, -3, 3);
    }

    // Volume spike
    let spike = 0;
    if (feats.avgVol > 0) {
      spike = (feats.lastVol / feats.avgVol) - 1;
      const spikeAdj = clamp(spike, -2.0, 3.0) * 0.65;
      bull += spikeAdj;
      bear += spikeAdj * 0.3; // weaker effect
    }

    // Elliott sentiment
    if (ell && isNum(ell.sentiment) && isNum(ell.confidence)) {
      const eAdj = ell.sentiment * (ell.confidence / 100) * 1.25;
      bull += eAdj;
      bear -= eAdj;
    }

    // NEWS influence
    const newsDir = (news.sentiment - 0.5) * 2;
    const newsBoost = newsDir * news.impactMul * 1.4;
    bull += newsBoost;
    bear -= newsBoost;

    // Neutral logit
    const neutralLogit = clamp(0.2 - (volRatio * 12) - Math.abs(spike * 0.4), -6, 4);

    // Softmax
    let [pBull, pBear, pNeutral] = softmax3(bull, bear, neutralLogit);

    let probs = {
      bull: pct(pBull*100),
      bear: pct(pBear*100),
      neutral: pct(pNeutral*100)
    };

    // Smooth probabilities
    const smooth = smoothProbs(`${symbol}_${tf}`, probs);

    const maxP = Math.max(smooth.bull, smooth.bear, smooth.neutral);
    const direction = maxP === smooth.bull ? "Bullish" :
                      maxP === smooth.bear ? "Bearish" : "Neutral";

    // -------------------------------------------------------
    // Build TP candidates (Elliott → fallback ATR)
    // -------------------------------------------------------
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);

    const chosen = chooseCandidateTP(candidates, direction, price, atr, feats, 25);

    const tp = chosen?.tp ?? null;
    const sl = chosen?.suggestedSL ?? (
      direction === "Bullish" ? Number((price - atr * 1.8).toFixed(8)) :
      direction === "Bearish" ? Number((price + atr * 1.8).toFixed(8)) : null
    );

    // -------------------------------------------------------
    // ML ACCURACY UPDATE
    // -------------------------------------------------------
    const acc = calculateAccuracy();
    const mlAccuracy = acc.accuracy || 0;

    // -------------------------------------------------------
    // Final ML Object
    // -------------------------------------------------------
    const ML = {
      modelVersion: STATE.modelVersion,
      accuracy: mlAccuracy,
      symbol,
      tf,
      generatedAt: new Date().toISOString(),

      direction,
      probs: smooth,
      maxProb: maxP,

      tpEstimate: tp,
      slEstimate: sl,
      tpSource: chosen?.source ?? null,
      tpConfidence: chosen?.confidence ?? Math.round(maxP),

      explanation: [
        `slope:${feats.slope?.toFixed(5)}`,
        `mom5:${(feats.mom5*100).toFixed(2)}%`,
        isNum(feats.rsi) ? `rsi:${feats.rsi.toFixed(1)}` : null,
        `atr:${atr.toFixed(8)}`,
        ell ? `ell(${ell.sentiment},${ell.confidence}%)` : null,
        rawNews ? `news:${Math.round(news.sentiment*100)}%(${rawNews.impact})` : "news:N/A",
        `volSpike:${spike.toFixed(2)}`
      ].filter(Boolean).join(" | ")
    };

    // Persist prediction
    recordPrediction({
      id: `${symbol}_${tf}_${Date.now()}`,
      symbol,
      tf,
      ml: ML
    });

    return ML;

  } catch (err) {
    return { error: String(err), symbol, tf };
  }
}

// ===========================================================
// Micro predictor
// ===========================================================

export async function runMicroPrediction(symbol = "BTCUSDT", tf = "1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];

    if (candles.length < 5) {
      return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    }

    const feats = buildFeaturesFromCandles(candles);
    const score = clamp(
      (feats.mom5 * 120) +
      (feats.slope * 14) +
      ((isNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 2.2),
      -15, 15
    );

    const pBull = 1 / (1 + Math.exp(-score));
    const bull = pct(pBull * 100);
    const bear = pct((1 - pBull) * 100);

    const label = bull > 60 ? "Bullish" :
                  bear > 60 ? "Bearish" : "Neutral";

    return {
      modelVersion: STATE.modelVersion + "-micro",
      label,
      prob: Math.max(bull, bear),
      probBull: bull,
      probBear: bear,
      slope: feats.slope
    };

  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// ===========================================================
// EXPORT DEFAULT
// ===========================================================

export default {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};