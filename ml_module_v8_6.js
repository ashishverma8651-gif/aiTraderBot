// ml_module_v8_6.js
// ML Module (v12 engine) — placed in repo filename ml_module_v8_6.js
// Backwards-compatible default export (runMLPrediction, runMicroPrediction, calculateAccuracy, recordPrediction, recordOutcome)
// Improvements: strict TP/hedge sanitization, confidence calibration, safer fallbacks, clearer outputs

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";
const { fetchNewsBundle } = News || { fetchNewsBundle: async () => ({ ok:false, sentiment:0.5, impact:"low", items:[] }) };

// ---------------------------
// Config & persistence
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const DEBUG_CSV = path.join(LOG_DIR, "debug.csv");
const STATE_FILE = path.join(LOG_DIR, "ml_state_v12.json"); // smoothing + caches

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) { return fallback; }
}
function writeJsonSafe(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
}

// load state
const STATE = readJsonSafe(STATE_FILE, { smooth: {}, recent: {}, historyLimit: 8 }) || { smooth: {}, recent: {}, historyLimit: 8 };
function saveState() { try { writeJsonSafe(STATE_FILE, STATE); } catch (e) {} }

// ---------------------------
// Logging helpers
// ---------------------------
function appendDebugCSV(arr) {
  try {
    if (!fs.existsSync(DEBUG_CSV)) fs.writeFileSync(DEBUG_CSV, "id,symbol,tf,direction,probs,tp,sl,timestamp\n","utf8");
    fs.appendFileSync(DEBUG_CSV, arr.join(",") + "\n", "utf8");
  } catch (e) {}
}

export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []) || [];
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    writeJsonSafe(PRED_FILE, arr);
  } catch (e) {}
  try {
    appendDebugCSV([pred.id||"", pred.symbol||"", pred.tf||"", pred.ml?.direction||"", pred.ml?.probs ? `${pred.ml.probs.bull}/${pred.ml.probs.bear}/${pred.ml.probs.neutral}` : "", pred.ml?.tpEstimate ?? "", pred.ml?.slEstimate ?? "", new Date().toISOString()]);
  } catch (e) {}
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []) || [];
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    writeJsonSafe(OUT_FILE, arr);
  } catch (e) {}
}

export function calculateAccuracy() {
  try {
    const outs = readJsonSafe(OUT_FILE, []) || [];
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.correct).length;
    // stats by tf/symbol
    const byTF = {}, bySymbol = {};
    for (const o of outs) {
      const tf = o.tf || "unknown", sym = o.symbol || "unknown";
      if (!byTF[tf]) byTF[tf] = { win:0, lose:0 };
      if (!bySymbol[sym]) bySymbol[sym] = { win:0, lose:0 };
      if (o.correct) { byTF[tf].win++; bySymbol[sym].win++; } else { byTF[tf].lose++; bySymbol[sym].lose++; }
    }
    return { accuracy: Math.round((correct/total)*10000)/100, total, correct, byTF, bySymbol };
  } catch (e) { return { accuracy: 0, total: 0, correct: 0 }; }
}

// ---------------------------
// Numeric / util helpers
// ---------------------------
const EPS = 1e-12;
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const isNum = n => typeof n === "number" && Number.isFinite(n);
const pct = n => Math.round(n * 10000) / 100;
const pctClamp = n => isNum(n) ? Math.round(Math.max(0, Math.min(100, n)) * 100) / 100 : 0;

function softmax3(a,b,c) {
  const m = Math.max(a,b,c);
  const ea = Math.exp(a-m), eb = Math.exp(b-m), ec = Math.exp(c-m);
  const s = ea+eb+ec + EPS;
  return [ea/s, eb/s, ec/s];
}

// stable timestamp
function nowISO(){ return new Date().toISOString(); }

// ---------------------------
// Feature builder (robust)
// ---------------------------
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const n = candles.length;
  const last = candles[n-1] || {};
  const close = Number(last.close ?? last.adjClose ?? 0);
  const closes = new Array(n), highs = new Array(n), lows = new Array(n), vols = new Array(n);
  for (let i=0;i<n;i++){
    const c = candles[i] || {};
    closes[i] = Number(c.close ?? 0);
    highs[i] = Number(c.high ?? closes[i]);
    lows[i] = Number(c.low ?? closes[i]);
    vols[i] = Number(c.volume ?? c.vol ?? 0);
  }
  const close5 = n >= 6 ? closes[n-6] : closes[0];
  const close20 = n >= 21 ? closes[n-21] : closes[0];
  const mom5 = close5 ? (close - close5) / Math.max(EPS, close5) : 0;
  const mom20 = close20 ? (close - close20) / Math.max(EPS, close20) : 0;

  const sl = Math.min(30, n);
  let num=0, den=0, xm=0, ym=0;
  for (let i=0;i<sl;i++){ xm += i; ym += closes[n-sl+i]; }
  xm /= sl; ym /= sl;
  for (let i=0;i<sl;i++){ const x=i; const y=closes[n-sl+i]; num += (x-xm)*(y-ym); den += (x-xm)*(x-xm); }
  const slope = den===0 ? 0 : num/den;

  // ATR
  let atr = 0;
  try {
    if (indicators.computeATR) atr = indicators.computeATR(candles);
    else {
      const trs = [];
      for (let i=1;i<n;i++){
        trs.push(Math.max(Math.abs(highs[i]-lows[i]), Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
      }
      const tail = trs.slice(-14);
      atr = tail.length ? tail.reduce((a,b)=>a+b,0)/tail.length : 0;
    }
  } catch (e){ atr = 0; }

  // RSI/MACD
  let rsi = null, macdHist = null;
  try { if (indicators.computeRSI) rsi = indicators.computeRSI(candles); } catch {}
  try { if (indicators.computeMACD) macdHist = indicators.computeMACD(candles)?.hist ?? null; } catch {}

  const volSlice = vols.slice(-20);
  const avgVol = volSlice.length ? volSlice.reduce((a,b)=>a+b,0) / volSlice.length : 0;
  const lastVol = vols[n-1] || 0;

  return {
    close,
    high: highs[n-1],
    low: lows[n-1],
    mom5: Number(mom5 || 0),
    mom20: Number(mom20 || 0),
    slope: Number(slope || 0),
    atr: Number(atr || 0),
    rsi: isNum(rsi) ? Number(rsi) : null,
    macdHist: isNum(macdHist) ? Number(macdHist) : null,
    avgVol,
    lastVol
  };
}

// ---------------------------
// Reversal Engine v2
function detectReversal({ tfCandles, microCandles, feats, microFeats, ell, price, news }) {
  const reasons = [];
  let score = 0;

  // 1) Price & RSI/MACD divergence
  const rsi = feats.rsi;
  const macd = feats.macdHist;
  if (rsi != null && microFeats && microFeats.rsi != null) {
    const lastClose = tfCandles.at(-1)?.close ?? price;
    const priorSlice = tfCandles.slice(-12, -3);
    const priorLow = priorSlice.reduce((s,c)=> (s===null || (c && c.close < s) ? c.close : s), null);
    if (priorLow != null && lastClose < priorLow && rsi > (priorSlice.reduce((a,b)=>a+ (b.rsi ?? 50),0)/(priorSlice.length||1) - 5)) {
      score += 12; reasons.push("price_lower_low_rsi_higher_low");
    }
  }
  if (macd != null) {
    const macdRecent = macd;
    const priceRecentSlope = feats.slope;
    if (priceRecentSlope < 0 && macdRecent > 0) { score += 10; reasons.push("macd_positive_while_price_down"); }
    if (priceRecentSlope > 0 && macdRecent < 0) { score -= 10; reasons.push("macd_negative_while_price_up"); }
  }

  // 2) Volume flush detection
  const volRatio = feats.avgVol > 0 ? (feats.lastVol / feats.avgVol) - 1 : 0;
  if (volRatio > 1.2) {
    const lastC = tfCandles.at(-1) || {};
    const body = Math.abs((lastC.close ?? price) - (lastC.open ?? price));
    const wickLower = ((lastC.low ?? price) < Math.min(lastC.open ?? price, lastC.close ?? price)) ? 1 : 0;
    if (wickLower && body / Math.max(EPS, feats.atr) < 1.2) {
      score += 14; reasons.push("volume_flush_with_lower_wick");
    }
  }

  // 3) Micro-turn
  if (microFeats && microFeats.slope != null) {
    if (microFeats.slope > 0.0001 && feats.slope < 0) { score += 8; reasons.push("micro_slope_positive_after_downtrend"); }
    if (microFeats.slope < -0.0001 && feats.slope > 0) { score -= 8; reasons.push("micro_slope_negative_after_uptrend"); }
  }

  // 4) Elliott hints
  if (ell && typeof ell.confidence === "number" && typeof ell.sentiment === "number") {
    if (ell.confidence >= 50) {
      if (ell.sentiment < -0.6) { score += 12; reasons.push("elliott_bear_exhaustion"); }
      if (ell.sentiment > 0.6) { score -= 12; reasons.push("elliott_bull_exhaustion"); }
    }
  }

  // 5) News
  if (news && typeof news.sentiment === "number") {
    const ns = news.sentiment;
    const impact = (news.impact || "low").toString().toLowerCase();
    if (impact === "high") {
      if (feats.close && ns < 0.4 && feats.slope > 0.0001) { score -= 14; reasons.push("high_impact_neg_sent_while_price_up"); }
      if (feats.close && ns > 0.6 && feats.slope < -0.0001) { score += 14; reasons.push("high_impact_pos_sent_while_price_down"); }
    }
  }

  const likelihood = Math.round(Math.max(0, Math.min(100, 50 + score)));
  let signal = null;
  if (likelihood >= 68 && score > 0) signal = "Bullish";
  else if (likelihood >= 68 && score < 0) signal = "Bearish";
  else signal = null;

  return { signal, likelihood, reasons, rawScore: score };
}

// ---------------------------
// Candidate TP generator
function buildCandidateTPsAdvanced(ell, price, atr, candles) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isNum(tp) || tp <= 0) continue;
      const ageDays = Number(t.ageDays ?? 0);
      let conf = clamp(Number(t.confidence ?? ell.confidence ?? 50), 0, 100);
      if (ageDays > 7) conf *= 0.6;
      out.push({ tp, source: "Elliott", confidence: Math.round(conf) });
    }
  }
  if (ell && ell.fib && ell.fib.ext) {
    ["1.272","1.414","1.618","2.0"].forEach(k=>{
      if (ell.fib.ext[k]) out.push({ tp: Number(ell.fib.ext[k]), source: `FIB_${k}`, confidence: 36 });
    });
  }
  try {
    const n = (candles||[]).length;
    if (n > 5) {
      const recent = (candles||[]).slice(-60);
      const highs = [];
      for (let i=2;i<recent.length-2;i++){
        const c = recent[i], p1=recent[i-1], p2=recent[i+1];
        if (c && p1 && p2 && c.high >= p1.high && c.high >= p2.high) highs.push(c.high);
      }
      const lows = [];
      for (let i=2;i<recent.length-2;i++){
        const c = recent[i], p1=recent[i-1], p2=recent[i+1];
        if (c && p1 && p2 && c.low <= p1.low && c.low <= p2.low) lows.push(c.low);
      }
      highs.slice(-4).forEach(h => out.push({ tp: Number(h), source: "SWING_HIGH", confidence: 40 }));
      lows.slice(-4).forEach(l => out.push({ tp: Number(l), source: "SWING_LOW", confidence: 40 }));
    }
  } catch (e) {}

  if (!out.length) {
    out.push({ tp: Number((price + (atr || price*0.002) * 2).toFixed(8)), source: "ATR_UP", confidence: 30 });
    out.push({ tp: Number((price - (atr || price*0.002) * 2).toFixed(8)), source: "ATR_DOWN", confidence: 30 });
  }

  const map = new Map();
  for (const t of out) {
    const key = Math.round(t.tp);
    if (!map.has(key) || (t.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a,b)=> Math.abs(a.tp-price) - Math.abs(b.tp-price));
}

// ---------------------------
// chooseCandidateTPAdvanced (RR-safe)
function chooseCandidateTPAdvanced(candidates, dir, price, atr, feats, maxRiskRR=20, mode="standard") {
  if (!Array.isArray(candidates) || candidates.length===0) return null;
  const multBase = clamp((feats?.atr || atr || price*0.002) / Math.max(EPS, price), 0.0005, 0.15);
  const volFactor = clamp(multBase / 0.002, 0.5, 4.0);
  const directionCmp = dir === "Bullish" ? (t => t.tp > price) : dir === "Bearish" ? (t => t.tp < price) : (()=>true);
  const filtered = candidates.filter(directionCmp);
  const pool = filtered.length ? filtered : candidates;

  const scored = pool.map(c => {
    const dist = Math.abs(c.tp - price);
    const prox = 1 / (1 + Math.log(1 + dist / Math.max(1, feats?.atr || atr || price*0.002)));
    const srcBoost = (c.source && String(c.source).toUpperCase().includes("ELL") ) ? 1.15 : ((String(c.source||"").includes("FIB"))?1.08:1.0);
    const score = (c.confidence || 40) * prox * volFactor * srcBoost;
    return { ...c, score, dist };
  }).sort((a,b)=>b.score - a.score);

  for (const cand of scored) {
    let sl;
    if (dir === "Bullish") sl = Number((price - (feats.atr || atr || price*0.002) * (mode==="aggressive"?1.6:2)).toFixed(8));
    else if (dir === "Bearish") sl = Number((price + (feats.atr || atr || price*0.002) * (mode==="aggressive"?1.6:2)).toFixed(8));
    else sl = cand.tp > price ? Number((price - (feats.atr || atr || price*0.002) * 1.5).toFixed(8)) : Number((price + (feats.atr || atr || price*0.002) * 1.5).toFixed(8));

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    if (!metrics || !isNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRiskRR) continue;
    const minTpDist = Math.max((feats.atr || atr || price*0.002) * 0.6, price * 0.0004);
    if (cand.dist < minTpDist) continue;
    if (Math.abs(cand.tp - price) < price * 1e-9) continue;
    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, suggestedSL: sl, reason: "best_conf_and_rr", rr: metrics.rr };
  }

  const top = scored[0];
  if (!top) return null;
  const mult = dir === "Bullish" ? 2.0 : dir === "Bearish" ? 2.0 : 1.5;
  const fallbackTP = dir === "Bullish" ? Number((price + (feats.atr || atr || price*0.002) * mult).toFixed(8))
                                      : dir === "Bearish" ? Number((price - (feats.atr || atr || price*0.002) * mult).toFixed(8))
                                                           : Number(top.tp);
  const sl = dir === "Bullish" ? Number((price - (feats.atr || atr || price*0.002) * 2).toFixed(8))
                               : dir === "Bearish" ? Number((price + (feats.atr || atr || price*0.002) * 2).toFixed(8))
                                                    : null;
  const metrics = computeRiskMetrics(price, fallbackTP, sl);
  return { tp: fallbackTP, source: "AUTO_ATR", confidence: (top && top.confidence) ? top.confidence : 40, suggestedSL: sl, reason: "fallback_atr", rr: metrics?.rr ?? null };
}

// ---------------------------
// Risk helpers
function computeRiskMetrics(price, tp, sl) {
  if (!isNum(price) || !isNum(tp) || !isNum(sl)) return null;
  // Ensure denominator non-zero (price - sl) may be negative depending on side; use absolute distance to SL
  const riskDen = Math.abs(price - sl) < EPS ? EPS : Math.abs(price - sl);
  const rr = Math.abs((tp - price) / riskDen);
  const percMove = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isNum(rr) ? rr : null, percMove: isNum(percMove) ? percMove : null };
}

// ---------------------------
// EMA smoothing & stability helpers
function smoothProbsEMA(key, probs, alpha = 0.22) {
  if (!STATE.smooth) STATE.smooth = {};
  const prev = STATE.smooth[key] || null;
  if (!prev) STATE.smooth[key] = { bull: probs.bull, bear: probs.bear, neutral: probs.neutral };
  else {
    STATE.smooth[key] = {
      bull: prev.bull * (1 - alpha) + probs.bull * alpha,
      bear: prev.bear * (1 - alpha) + probs.bear * alpha,
      neutral: prev.neutral * (1 - alpha) + probs.neutral * alpha
    };
  }
  saveState();
  const s = STATE.smooth[key];
  const sum = (s.bull + s.bear + s.neutral) || 1;
  return { bull: Math.round((s.bull / sum) * 10000) / 100, bear: Math.round((s.bear / sum) * 10000) / 100, neutral: Math.round((s.neutral / sum) * 10000) / 100 };
}

function recordRecentProbs(key, probs) {
  try {
    if (!STATE.recent) STATE.recent = {};
    if (!STATE.recent[key]) STATE.recent[key] = [];
    STATE.recent[key].push({ t: Date.now(), probs });
    const lim = STATE.historyLimit || 8;
    if (STATE.recent[key].length > lim) STATE.recent[key].shift();
    saveState();
  } catch (e) {}
}

function computeStabilityIndex(key) {
  try {
    const list = (STATE.recent && STATE.recent[key]) || [];
    if (!list.length) return 100;
    let avgBull=0, avgBear=0;
    for (const p of list) { avgBull += p.probs.bull; avgBear += p.probs.bear; }
    avgBull /= list.length; avgBear /= list.length;
    let varSum = 0;
    for (const p of list) {
      varSum += Math.abs(p.probs.bull - avgBull) + Math.abs(p.probs.bear - avgBear);
    }
    const avgVar = varSum / (list.length * 2 + EPS);
    const stability = clamp(100 - avgVar * 1.5, 10, 100);
    return Math.round(stability);
  } catch (e) { return 80; }
}

// ---------------------------
// Trade quality rating
function rateTrade({ direction, probs, tpConfidence, rrEstimate, reversal, news }) {
  let score = 50; const reasons = [];
  if (probs && probs.bull != null) {
    const maxProb = Math.max(probs.bull, probs.bear, probs.neutral);
    score += (maxProb - 50) * 0.35; reasons.push("probability");
  }
  score += (tpConfidence ? (tpConfidence - 40) * 0.25 : 0);
  if (rrEstimate && rrEstimate > 0) {
    score += Math.min(10, (Math.log10(Math.max(1, rrEstimate)) * 4));
    reasons.push("rr");
  }
  if (reversal && reversal.signal) { score -= Math.round(reversal.likelihood * 0.35); reasons.push("reversal_risk"); }
  if (news) {
    const impact = (news.impact || "low").toString().toLowerCase();
    if (impact === "high") score -= 8;
    if (news.sentiment > 0.66) score += 5;
    if (news.sentiment < 0.33) score -= 5;
  }
  const final = Math.round(clamp(score, 1, 99));
  const rating = final >= 80 ? "A" : final >= 60 ? "B" : final >= 40 ? "C" : "D";
  return { score: final, rating, reasons };
}

// ---------------------------
// Core predictor: runMLPrediction (v12 engine, exported as part of ml_module_v8_6)
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  try {
    const tfs = [tf, "1m"];
    const mtf = await fetchMultiTF(symbol, tfs);
    const main = mtf[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = (isNum(main.price) && main.price) ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || !isNum(price) || price <= 0) {
      return { modelVersion: "ml_module_v12", symbol, tf, direction: "Neutral", probs: { bull:33.33,bear:33.33,neutral:33.33 }, maxProb:33.33, tpEstimate:null, tpConfidence:33, slEstimate:null, explanation: "insufficient data" };
    }

    const feats = buildFeaturesFromCandles(candles);
    const microCandles = (mtf["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
    let rawNews = null;
    try { rawNews = await fetchNewsBundle(symbol); } catch (e) { rawNews = null; }
    const news = rawNews ? { sentiment: clamp(Number(rawNews.sentiment ?? 0.5),0,1), impact: rawNews.impact || "low", raw: rawNews } : null;

    // scoring
    let bullScore = 0, bearScore = 0;
    const atr = Math.max(feats.atr || 0, price * 0.0006);
    const volRatio = clamp(atr / price, 0, 0.06);
    const momWeight = clamp(1 + (volRatio * 10), 0.7, 3.0);
    const slopeWeight = clamp(1 + (volRatio * 6), 0.7, 2.5);

    bullScore += clamp(feats.slope * slopeWeight * 12, -18, 18);
    bearScore -= clamp(feats.slope * slopeWeight * 12, -18, 18);
    bullScore += clamp(feats.mom5 * momWeight * 10, -14, 14);
    bearScore -= clamp(feats.mom5 * momWeight * 10, -14, 14);

    if (isNum(feats.rsi)) {
      const r = (feats.rsi - 50) / 50;
      bullScore += clamp(r * 3.6, -5, 5);
      bearScore -= clamp(r * 3.6, -5, 5);
    }

    if (isNum(feats.macdHist)) {
      const m = Math.tanh(feats.macdHist / Math.max(1, atr)) * 2.2;
      bullScore += clamp(m, -3.5, 3.5);
      bearScore -= clamp(m, -3.5, 3.5);
    }

    if (microFeats) {
      const mN = microFeats.slope || 0;
      bullScore += clamp(mN * 6, -3, 3);
      bearScore -= clamp(mN * 6, -3, 3);
    }

    let volSpike = 0;
    if (feats.avgVol > 0) {
      volSpike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1;
      const vAdj = clamp(Math.min(2.0, volSpike) * 0.6, -1.5, 2.0);
      bullScore += vAdj * 0.4;
      bearScore += vAdj * 0.2;
    }

    let ellSent = 0, ellConf = 0;
    if (ell && isNum(ell.sentiment) && isNum(ell.confidence)) {
      ellSent = clamp(Number(ell.sentiment), -1, 1);
      ellConf = clamp(Number(ell.confidence), 0, 100);
      if (ellConf >= 35) {
        const scale = (ellConf >= 80) ? 1.5 : 1.0;
        const ellAdj = ellSent * (0.55 * (ellConf/100) * scale);
        bullScore += ellAdj;
        bearScore -= ellAdj;
      }
    }

    if (news) {
      const newsDir = (news.sentiment - 0.5) * 2;
      const mul = news.impact === "high" ? 1.0 : news.impact === "moderate" ? 0.5 : 0.2;
      const nAdj = newsDir * mul * 1.2;
      bullScore += nAdj;
      bearScore -= nAdj;
    }

    const neutralityBase = 0.25;
    const neutralVolPenalty = clamp(volRatio * 6 + Math.min(0.8, Math.max(0, volSpike)) * 0.6, 0, 1.2);
    const neutralStability = neutralityBase - neutralVolPenalty;
    const stabilityLogit = clamp(neutralStability, -1.0, 1.0);

    const a = clamp(bullScore, -18, 18);
    const b = clamp(bearScore, -18, 18);
    const c = clamp(stabilityLogit * 2.0, -6, 6);

    let [pBull, pBear, pNeutral] = softmax3(a,b,c);

    if (ellConf > 0) {
      const ellAdj = ellSent * (ellConf/100) * 0.45;
      const [pa,pb,pc] = softmax3(clamp(a + ellAdj, -18, 18), clamp(b - ellAdj, -18, 18), c);
      pBull = pa; pBear = pb; pNeutral = pc;
    }
    if (news) {
      const nAdj = ((news.sentiment - 0.5) * 2) * (news.impact === "high" ? 0.6 : news.impact === "moderate" ? 0.35 : 0.15);
      const [pa,pb,pc] = softmax3(clamp(a + nAdj, -18, 18), clamp(b - nAdj, -18, 18), c);
      pBull = pa; pBear = pb; pNeutral = pc;
    }

    let probBull = pctClamp(pBull * 100);
    let probBear = pctClamp(pBear * 100);
    let probNeutral = pctClamp(pNeutral * 100);
    const sum = probBull + probBear + probNeutral || 1;
    probBull = Math.round((probBull / sum) * 10000) / 100;
    probBear = Math.round((probBear / sum) * 10000) / 100;
    probNeutral = Math.round((probNeutral / sum) * 10000) / 100;

    const key = `${symbol}_${tf}`;
    const sm = smoothProbsEMA(key, { bull: probBull, bear: probBear, neutral: probNeutral }, 0.22);
    probBull = sm.bull; probBear = sm.bear; probNeutral = sm.neutral;
    recordRecentProbs(key, sm);

    const maxProb = Math.max(probBull, probBear, probNeutral);
    const dir = maxProb === probBull ? "Bullish" : maxProb === probBear ? "Bearish" : "Neutral";

    const reversal = detectReversal({ tfCandles: candles, microCandles, feats, microFeats, ell, price, news });

    const candidates = buildCandidateTPsAdvanced(ell || {}, price, atr, candles);
    const chosen = chooseCandidateTPAdvanced(candidates, dir, price, atr, feats, 25, (opts.mode || "standard"));

    // ---------- SANITIZE & IMPROVE TP / HEDGE / CONF  ----------
    // Minimum TP distance
    const minTPdist = Math.max(price * 0.002, atr * 0.6, 1);

    let tpEstimate = chosen && isNum(chosen.tp) ? chosen.tp : (dir === "Bullish" ? Number((price + atr * 2).toFixed(8)) : dir === "Bearish" ? Number((price - atr * 2).toFixed(8)) : null);
    let tpSource = chosen ? chosen.source : "AUTO_ATR";
    let tpConfidence = chosen ? Math.round(clamp(((chosen.confidence||40) * 0.6 + maxProb * 0.4), 1, 99)) : Math.round(maxProb);
    let slEstimate = (chosen && isNum(chosen.suggestedSL)) ? chosen.suggestedSL : (dir === "Bullish" ? Number((price - atr * 2).toFixed(8)) : dir === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null);

    // if tp too close to price or on wrong side -> try pick candidate on proper side
    function pickNearestSide(side) {
      const pool = side === "bull" ? candidates.filter(c=>c.tp>price) : side === "bear" ? candidates.filter(c=>c.tp<price) : candidates;
      if (!Array.isArray(pool) || pool.length===0) return null;
      pool.sort((a,b)=> b.confidence - a.confidence || Math.abs(a.tp-price) - Math.abs(b.tp-price));
      return pool[0] ?? null;
    }

    if (isNum(tpEstimate)) {
      if (dir === "Bullish" && tpEstimate <= price + minTPdist) {
        const pick = pickNearestSide("bull");
        if (pick && Math.abs(pick.tp - price) >= minTPdist) {
          tpEstimate = pick.tp; tpSource = pick.source; tpConfidence = Math.max(tpConfidence, pick.confidence);
          slEstimate = Number((price - Math.max(pick.confidence/100, atr) * 2).toFixed(8));
        } else {
          tpEstimate = Number((price + minTPdist).toFixed(8));
        }
      } else if (dir === "Bearish" && tpEstimate >= price - minTPdist) {
        const pick = pickNearestSide("bear");
        if (pick && Math.abs(pick.tp - price) >= minTPdist) {
          tpEstimate = pick.tp; tpSource = pick.source; tpConfidence = Math.max(tpConfidence, pick.confidence);
          slEstimate = Number((price + Math.max(pick.confidence/100, atr) * 2).toFixed(8));
        } else {
          tpEstimate = Number((price - minTPdist).toFixed(8));
        }
      }
    } else {
      // try to pick nearest candidate consistent with dir
      const pick = dir === "Bullish" ? pickNearestSide("bull") : dir === "Bearish" ? pickNearestSide("bear") : (pickNearestSide("bull") || pickNearestSide("bear"));
      if (pick) {
        tpEstimate = pick.tp; tpSource = pick.source; tpConfidence = Math.max(tpConfidence, pick.confidence);
        slEstimate = pick.suggestedSL ?? slEstimate;
      }
    }

    // Final guard: ensure tpEstimate is not equal to price and has sensible rounding
    if (isNum(tpEstimate) && Math.abs(tpEstimate - price) < minTPdist) {
      tpEstimate = dir === "Bullish" ? Number((price + minTPdist).toFixed(8)) : dir === "Bearish" ? Number((price - minTPdist).toFixed(8)) : tpEstimate;
    }

    // Hedge determination: choose true opposite-side candidate if possible
    let hedgeTP = null;
    if (dir === "Bullish") {
      const opp = pickNearestSide("bear");
      if (opp && Math.abs(opp.tp - price) >= minTPdist) hedgeTP = opp.tp;
    } else if (dir === "Bearish") {
      const opp = pickNearestSide("bull");
      if (opp && Math.abs(opp.tp - price) >= minTPdist) hedgeTP = opp.tp;
    } else {
      const oppB = pickNearestSide("bear"), oppL = pickNearestSide("bull");
      hedgeTP = oppB?.tp ?? oppL?.tp ?? null;
    }

    // Fallback hedge: ATR opposite side offset (tighter than primary)
    if (!isNum(hedgeTP) && isNum(tpEstimate)) {
      const hedgeOffset = Math.max(minTPdist * 0.6, atr * 0.6);
      if (dir === "Bullish") hedgeTP = Number((price - hedgeOffset).toFixed(8));
      else if (dir === "Bearish") hedgeTP = Number((price + hedgeOffset).toFixed(8));
      else hedgeTP = null;
    }

    // Ensure hedge and primary are not identical and are on opposite sides
    if (isNum(tpEstimate) && isNum(hedgeTP)) {
      if (Math.abs(tpEstimate - hedgeTP) < Math.max(1, minTPdist/5)) {
        const nudge = Math.max(minTPdist, atr * 0.6);
        hedgeTP = dir === "Bullish" ? Number((price - nudge).toFixed(8)) : dir === "Bearish" ? Number((price + nudge).toFixed(8)) : hedgeTP;
      }
      // ensure opposite sides
      if ((dir === "Bullish" && hedgeTP > price) || (dir === "Bearish" && hedgeTP < price)) {
        // flip hedge to opposite side using offset
        const offset = Math.max(minTPdist * 0.8, atr * 0.6);
        hedgeTP = dir === "Bullish" ? Number((price - offset).toFixed(8)) : Number((price + offset).toFixed(8));
      }
    }

    // Calibrate final TP confidence: include stability and tradeQuality signals
    const rrEstimateObj = computeRiskMetrics(price, tpEstimate || price, slEstimate || price);
    const rrEstimate = rrEstimateObj?.rr ?? null;
    const stabilityIndex = computeStabilityIndex(key);
    const tradeQuality = rateTrade({ direction: dir, probs: { bull: probBull, bear: probBear, neutral: probNeutral }, tpConfidence, rrEstimate, reversal, news });

    // If ML direction strongly contradicts recent fusion/elliott, reduce confidence more
    // (fusion/elliott info is best derived externally; we give hooks here — caller tg_commands adjusts further)
    // final tpConfidence tweak
    let finalTpConfidence = Math.round(clamp(tpConfidence * (stabilityIndex / 100) * (Math.max(0.6, tradeQuality.score/100)), 5, 99));

    // Safety: if maxProb is extreme but RR unreasonable, reduce confidence
    if (finalTpConfidence > 85 && rrEstimate && rrEstimate < 0.2) finalTpConfidence = Math.round(finalTpConfidence * 0.7);

    // Explanation
    const explanationParts = [
      `slope:${Number(feats.slope.toFixed(6))}`,
      `mom5:${(feats.mom5*100).toFixed(2)}%`,
      isNum(feats.rsi) ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
      ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
      news ? `news:${Math.round(news.sentiment*100)}%(${news.impact})` : null,
      `atr:${Number(atr.toFixed(8))}`
    ].filter(Boolean).join(" | ");

    const mlObj = {
      modelVersion: "ml_module_v12",
      symbol, tf, generatedAt: nowISO(),
      direction: dir,
      probs: { bull: probBull, bear: probBear, neutral: probNeutral },
      maxProb,
      tpEstimate: isNum(tpEstimate) ? Number(tpEstimate) : null,
      tpSource,
      tpConfidence: finalTpConfidence,
      slEstimate: isNum(slEstimate) ? Number(slEstimate) : null,
      rrEstimate,
      hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null,
      hedgeConfidence: isNum(hedgeTP) ? Math.round(clamp(100 - finalTpConfidence, 10, 90)) : null,
      reversal,
      newsSummary: news ? { sentiment: news.sentiment, impact: news.impact } : null,
      stabilityIndex,
      tradeQuality,
      explanation: explanationParts,
      rawScores: { bull: a, bear: b, neutralLogit: c },
      ellSummary: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null,
      features: { slope: feats.slope, mom5: feats.mom5, rsi: feats.rsi, atr: feats.atr }
    };

    try { recordPrediction({ id:`${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch (e) {}

    return mlObj;

  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (v12)
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];
    if (!candles || candles.length < 3) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    const score = clamp((feats.mom5 * 120) + (feats.slope * 14) + ((isNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 2.2), -16, 16);
    const pBull = 1 / (1 + Math.exp(-score));
    const pb = pctClamp(pBull * 100);
    const pa = pctClamp((1 - pBull) * 100);
    const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v12-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
  } catch (e) { return { error: String(e), label: "Neutral" }; }
}

// ---------------------------
// default export (backwards compatible)
export default {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};