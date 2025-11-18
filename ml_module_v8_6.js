// ml_module_v9_9.js
// Backwards-compatible patched ML module (based on v9_7)
// Improvements:
//  - News integration (uses news_social.js default export)
//  - TP selection improvements (dedupe, direction-strict, RR-safe)
//  - Probability smoothing (EMA per symbol_tf)
//  - Confidence smoothing / blending with TP confidence
//  - Better micro predictor
//  - Accuracy tracker + persistence
//  - Defensive, robust I/O

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js"; // default export expected
const { fetchNewsBundle } = News || { fetchNewsBundle: async () => ({ ok:false, sentiment:0.5, impact:"low", items:[] }) };

// ---------------------------
// Config & storage
// ---------------------------
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const DEBUG_CSV = path.join(LOG_DIR, "debug.csv");
const STATE_FILE = path.join(LOG_DIR, "ml_state.json"); // for smoothing and small state

try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

function readJsonSafe(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const s = fs.readFileSync(file, "utf8");
    return s ? JSON.parse(s) : fallback;
  } catch (e) {
    return fallback;
  }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

// STATE for smoothing
const STATE = readJsonSafe(STATE_FILE, { smooth: {} });
function saveState() { try { writeJsonSafe(STATE_FILE, STATE); } catch (e) {} }

// ---------------------------
// Persistence helpers
// ---------------------------
export function recordPrediction(pred) {
  try {
    const arr = readJsonSafe(PRED_FILE, []);
    arr.push({ ...pred, recordedAt: new Date().toISOString() });
    writeJsonSafe(PRED_FILE, arr);
  } catch (e) {
    // best-effort
  }
  // CSV debug
  try {
    const line = [
      pred.id || "",
      pred.symbol || "",
      pred.tf || "",
      pred.ml?.direction || "",
      pred.ml?.probs ? `${pred.ml.probs.bull}/${pred.ml.probs.bear}/${pred.ml.probs.neutral}` : "",
      pred.ml?.tpEstimate ?? "",
      pred.ml?.slEstimate ?? "",
      new Date().toISOString()
    ].join(",") + "\n";
    if (!fs.existsSync(DEBUG_CSV)) fs.writeFileSync(DEBUG_CSV, "id,symbol,tf,direction,probs,tp,sl,timestamp\n", "utf8");
    fs.appendFileSync(DEBUG_CSV, line, "utf8");
  } catch (e) {}
}

export function recordOutcome(outcome) {
  try {
    const arr = readJsonSafe(OUT_FILE, []);
    arr.push({ ...outcome, recordedAt: new Date().toISOString() });
    writeJsonSafe(OUT_FILE, arr);
  } catch (e) {
    // ignore
  }
}

export function calculateAccuracy() {
  try {
    const outs = readJsonSafe(OUT_FILE, []);
    const total = outs.length;
    if (!total) return { accuracy: 0, total: 0, correct: 0 };
    const correct = outs.filter(o => o && o.correct).length;
    // by-tf and by-symbol summary
    const byTF = {};
    const bySymbol = {};
    for (const o of outs) {
      const tf = o.tf || "unknown";
      const sym = o.symbol || "unknown";
      if (!byTF[tf]) byTF[tf] = { win:0, lose:0 };
      if (!bySymbol[sym]) bySymbol[sym] = { win:0, lose:0 };
      if (o.correct) { byTF[tf].win++; bySymbol[sym].win++; }
      else { byTF[tf].lose++; bySymbol[sym].lose++; }
    }
    return {
      accuracy: Math.round((correct/total) * 10000) / 100,
      total, correct, byTF, bySymbol
    };
  } catch (e) {
    return { accuracy: 0, total: 0, correct: 0 };
  }
}

// ---------------------------
// Numeric helpers
// ---------------------------
const EPS = 1e-12;
function clamp(v, lo = -Infinity, hi = Infinity) { return Math.max(lo, Math.min(hi, v)); }
function isFiniteNum(n) { return typeof n === "number" && Number.isFinite(n); }
function nf(v,d=2){ return isFiniteNum(v) ? Number(v).toFixed(d) : "N/A"; }
function pctClamp(n) { if (!isFiniteNum(n)) return 0; return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100; }

/* stable softmax for 3 */
function softmax3(a,b,c) {
  const max = Math.max(a,b,c);
  const ea = Math.exp(a - max), eb = Math.exp(b - max), ec = Math.exp(c - max);
  const s = ea + eb + ec + EPS;
  return [ea/s, eb/s, ec/s];
}

// ---------------------------
// Feature builder (defensive)
function buildFeaturesFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const n = candles.length;
  const last = candles[n-1] || {};
  const close = Number(last.close ?? last.adjClose ?? 0);
  const closes = new Array(n);
  const highs = new Array(n);
  const lows = new Array(n);
  const vols = new Array(n);
  for (let i=0;i<n;i++){
    const c = candles[i] || {};
    closes[i] = Number(c.close ?? 0);
    highs[i] = Number(c.high ?? closes[i]);
    lows[i] = Number(c.low ?? closes[i]);
    vols[i] = Number(c.volume ?? c.vol ?? 0);
  }

  const close5 = n >= 6 ? closes[n-6] : closes[0];
  const close20 = n >= 21 ? closes[n-21] : closes[0];
  const mom5 = close5 ? (close - close5) / Math.max(1, close5) : 0;
  const mom20 = close20 ? (close - close20) / Math.max(1, close20) : 0;

  const nSlope = Math.min(30, n);
  let num=0, den=0, xmean=0, ymean=0;
  for (let i=0;i<nSlope;i++){ xmean += i; ymean += closes[n - nSlope + i]; }
  xmean /= nSlope; ymean /= nSlope;
  for (let i=0;i<nSlope;i++){
    const x = i;
    const y = closes[n - nSlope + i];
    num += (x - xmean) * (y - ymean);
    den += (x - xmean) * (x - xmean);
  }
  const slope = den === 0 ? 0 : num/den;

  let atr = 0;
  try {
    if (indicators.computeATR) atr = indicators.computeATR(candles);
    else {
      const trs = [];
      for (let i=1;i<n;i++){
        const t = Math.max(
          Math.abs(highs[i] - lows[i]),
          Math.abs(highs[i] - closes[i-1]),
          Math.abs(lows[i] - closes[i-1])
        );
        trs.push(t);
      }
      const tail = trs.slice(-14);
      atr = tail.length ? (tail.reduce((a,b)=>a+b,0) / tail.length) : 0;
    }
  } catch (e) { atr = 0; }

  let rsi = null, macdHist = null;
  try {
    if (indicators.computeRSI) rsi = indicators.computeRSI(candles);
    if (indicators.computeMACD) {
      const mac = indicators.computeMACD(candles);
      macdHist = mac?.hist ?? null;
    }
  } catch (e) { rsi = rsi ?? null; macdHist = macdHist ?? null; }

  const volSlice = vols.slice(-20);
  const avgVol = volSlice.length ? (volSlice.reduce((a,b)=>a+b,0) / volSlice.length) : 0;
  const lastVol = vols[n-1] || 0;

  return {
    close,
    mom5: Number(mom5 || 0),
    mom20: Number(mom20 || 0),
    slope: Number(slope || 0),
    atr: Number(atr || 0),
    rsi: isFiniteNum(rsi) ? Number(rsi) : null,
    macdHist: isFiniteNum(macdHist) ? Number(macdHist) : null,
    avgVol: Number(avgVol || 0),
    lastVol: Number(lastVol || 0),
    high: Number(highs[n-1] || close),
    low: Number(lows[n-1] || close)
  };
}

// ---------------------------
// Candidate TP generator
function buildCandidateTPsFromElliott(ell, price, atr) {
  const out = [];
  if (ell && Array.isArray(ell.targets) && ell.targets.length) {
    for (const t of ell.targets) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isFiniteNum(tp) || tp <= 0) continue;
      const ageDays = Number(t.ageDays ?? 0);
      const conf = clamp(Number(t.confidence ?? ell.confidence ?? 40), 0, 100);
      const adjConf = conf * (ageDays > 7 ? 0.6 : 1.0);
      out.push({ tp, source: t.source || t.type || "Elliott", confidence: Math.round(adjConf) });
    }
  }
  if (!out.length && ell && ell.fib && ell.fib.ext) {
    if (ell.fib.ext['1.272']) out.push({ tp: Number(ell.fib.ext['1.272']), source: 'FIB_1.272', confidence: 40 });
    if (ell.fib.ext['1.618']) out.push({ tp: Number(ell.fib.ext['1.618']), source: 'FIB_1.618', confidence: 35 });
  }
  // ATR fallbacks both sides (conservative)
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

// ---------------------------
// Risk helpers
function computeRiskMetrics(price, tp, sl) {
  if (!isFiniteNum(price) || !isFiniteNum(tp) || !isFiniteNum(sl)) return null;
  const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
  const percMove = Math.abs((tp - price) / Math.max(EPS, price)) * 100;
  return { rr: isFiniteNum(rr) ? rr : null, percMove: isFiniteNum(percMove) ? percMove : null };
}

// choose candidate TP with RR and distance checks
function chooseCandidateTP(candidates, dir, price, atr, feats, maxRiskRR = 10) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const multBase = clamp((feats?.atr || atr || price*0.002) / Math.max(EPS, price), 0.0005, 0.1);
  const volFactor = clamp(multBase / 0.002, 0.5, 3.0);

  const directionCmp = dir === "Bullish" ? (t => t.tp > price) : dir === "Bearish" ? (t => t.tp < price) : (() => true);

  const filtered = candidates.filter(directionCmp);
  const pool = filtered.length ? filtered : candidates;

  const scored = pool.map(c => {
    const dist = Math.abs(c.tp - price);
    const prox = 1 / (1 + Math.log(1 + dist / Math.max(1, feats?.atr || atr || price*0.002)));
    const score = (c.confidence || 40) * prox * volFactor;
    return { ...c, score, dist };
  }).sort((a,b) => b.score - a.score);

  for (const cand of scored) {
    // conservative SL
    let sl;
    if (dir === "Bullish") sl = Number((price - (feats.atr || atr || price*0.002) * 2).toFixed(8));
    else if (dir === "Bearish") sl = Number((price + (feats.atr || atr || price*0.002) * 2).toFixed(8));
    else sl = cand.tp > price ? Number((price - (feats.atr || atr || price*0.002) * 1.5).toFixed(8))
                              : Number((price + (feats.atr || atr || price*0.002) * 1.5).toFixed(8));

    const metrics = computeRiskMetrics(price, cand.tp, sl);
    if (!metrics || !isFiniteNum(metrics.rr) || metrics.rr <= 0 || metrics.rr > maxRiskRR) continue;
    const minTpDist = Math.max((feats.atr || atr || price*0.002) * 0.6, price * 0.0005);
    if (cand.dist < minTpDist) continue;
    if (Math.abs(cand.tp - price) < (price * 1e-9)) continue;
    return { tp: Number(cand.tp), source: cand.source, confidence: cand.confidence, reason: "best_conf_and_rr", suggestedSL: sl, rr: metrics.rr };
  }

  // fallback top scored -> ATR fallback
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
  return { tp: fallbackTP, source: "AUTO_ATR", confidence: top.confidence || 40, reason: "fallback_atr", suggestedSL: sl, rr: metrics?.rr ?? null };
}

// ---------------------------
// EMA smoothing for probabilities (per symbol_tf)
// alpha 0..1
function smoothProbsEMA(key, probs, alpha = 0.25) {
  if (!STATE.smooth) STATE.smooth = {};
  const prev = STATE.smooth[key] || null;
  if (!prev) {
    STATE.smooth[key] = { bull: probs.bull, bear: probs.bear, neutral: probs.neutral };
  } else {
    STATE.smooth[key] = {
      bull: prev.bull * (1 - alpha) + probs.bull * alpha,
      bear: prev.bear * (1 - alpha) + probs.bear * alpha,
      neutral: prev.neutral * (1 - alpha) + probs.neutral * alpha
    };
  }
  saveState();
  const s = STATE.smooth[key];
  const sum = (s.bull + s.bear + s.neutral) || 1;
  return {
    bull: Math.round((s.bull / sum) * 10000) / 100,
    bear: Math.round((s.bear / sum) * 10000) / 100,
    neutral: Math.round((s.neutral / sum) * 10000) / 100
  };
}

// ---------------------------
// Main predictor (based on v9_7, improved)
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
  try {
    const tfs = [tf, "1m"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const main = mtfRaw[tf] || { data: [], price: 0 };
    const candles = main.data || [];
    const price = isFiniteNum(main.price) && main.price ? main.price : (candles?.at(-1)?.close ?? 0);

    if (!candles || candles.length < 6 || !isFiniteNum(price) || price <= 0) {
      return {
        modelVersion: "ml_module_v9_9",
        symbol, tf,
        direction: "Neutral",
        probs: { bull: 33.33, bear: 33.33, neutral: 33.33 },
        maxProb: 33.33,
        tpEstimate: null,
        tpSource: null,
        tpConfidence: 33,
        slEstimate: null,
        explanation: "insufficient data"
      };
    }

    const feats = buildFeaturesFromCandles(candles);
    const microCandles = (mtfRaw["1m"] || {}).data || [];
    const microFeats = buildFeaturesFromCandles(microCandles || []);

    // Elliott (non-fatal)
    let ell = null;
    try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

    // News (best-effort)
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = null; }
    const newsSent = (news && typeof news.sentiment === "number") ? clamp(news.sentiment, 0, 1) : 0.5;
    const newsImpact = (news && news.impact) ? String(news.impact).toLowerCase() : "low";

    // --- scoring (heuristic, ATR-adaptive) ---
    let bullScore = 0, bearScore = 0;
    const atr = Math.max(feats.atr || 0, price * 0.0005);

    const volRatio = clamp((atr / Math.max(EPS, price)), 0, 0.05);
    const momWeight = clamp(1 + (volRatio * 10), 0.7, 3.0);
    const slopeWeight = clamp(1 + (volRatio * 6), 0.7, 2.5);

    bullScore += clamp(feats.slope * slopeWeight * 12, -12, 12);
    bearScore -= clamp(feats.slope * slopeWeight * 12, -12, 12);
    bullScore += clamp(feats.mom5 * momWeight * 10, -12, 12);
    bearScore -= clamp(feats.mom5 * momWeight * 10, -12, 12);

    if (isFiniteNum(feats.rsi)) {
      const r = (feats.rsi - 50) / 50;
      bullScore += clamp(r * 3.2, -4, 4);
      bearScore -= clamp(r * 3.2, -4, 4);
    }

    if (isFiniteNum(feats.macdHist)) {
      const m = Math.tanh(feats.macdHist / Math.max(1, atr)) * 2.0;
      bullScore += clamp(m, -3, 3);
      bearScore -= clamp(m, -3, 3);
    }

    // micro trend nudge
    if (microFeats) {
      const mN = microFeats.slope || 0;
      bullScore += clamp(mN * 6, -2.5, 2.5);
      bearScore -= clamp(mN * 6, -2.5, 2.5);
    }

    // volume spike (directionally biased)
    let volSpike = 0;
    if (feats.avgVol > 0) {
      volSpike = (feats.lastVol / Math.max(1, feats.avgVol)) - 1;
      const vAdj = clamp(Math.min(1.5, volSpike) * 1.0, -1.2, 1.2);
      bullScore += vAdj * 0.35;
      bearScore += vAdj * 0.15;
    }

    // Elliott weighting (if confident)
    let ellSent = 0, ellConf = 0;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      ellSent = clamp(Number(ell.sentiment || 0), -1, 1);
      ellConf = clamp(Number(ell.confidence || 0), 0, 100);
      if (ellConf >= 30) {
        const scale = (ellConf >= 80) ? 1.3 : 1.0;
        const ellAdj = ellSent * (0.5 * (ellConf / 100) * scale);
        bullScore += ellAdj;
        bearScore -= ellAdj;
      }
    }

    // News nudge (small, scaled by impact)
    if (news) {
      const impactMul = newsImpact === "high" ? 1.0 : newsImpact === "moderate" ? 0.6 : 0.25;
      const newsDir = (newsSent - 0.5) * 2;
      const newsNudge = newsDir * impactMul * 1.05;
      bullScore += newsNudge;
      bearScore -= newsNudge;
    }

    // neutral stability logit
    const neutralityBase = 0.25;
    const neutralVolPenalty = clamp(volRatio * 6 + Math.min(0.8, Math.max(0, volSpike)) * 0.6, 0, 1.2);
    const neutralStability = neutralityBase - neutralVolPenalty;
    const stabilityLogit = clamp(neutralStability, -1.0, 1.0);

    const a = clamp(bullScore, -12, 12);
    const b = clamp(bearScore, -12, 12);
    const c = clamp(stabilityLogit * 2.0, -6, 6);

    // softmax -> percentages
    let [pBull, pBear, pNeutral] = softmax3(a,b,c);

    // calibration tilt (ell + news)
    let calibA = a, calibB = b;
    if (ellConf > 0) {
      const ellAdj = ellSent * (ellConf / 100) * 0.4;
      calibA = clamp(a + ellAdj, -12, 12);
      calibB = clamp(b - ellAdj, -12, 12);
    }
    if (news) {
      const nAdj = ((newsSent - 0.5) * 2) * (newsImpact === "high" ? 0.6 : newsImpact === "moderate" ? 0.35 : 0.15);
      calibA = clamp(calibA + nAdj, -12, 12);
      calibB = clamp(calibB - nAdj, -12, 12);
    }
    if (calibA !== a || calibB !== b) {
      const [pa, pb, pc] = softmax3(calibA, calibB, c);
      pBull = pa; pBear = pb; pNeutral = pc;
    }

    let probBull = pctClamp(pBull * 100);
    let probBear = pctClamp(pBear * 100);
    let probNeutral = pctClamp(pNeutral * 100);

    // normalize to 100
    const sum = probBull + probBear + probNeutral || 1;
    probBull = Math.round((probBull / sum) * 10000) / 100;
    probBear = Math.round((probBear / sum) * 10000) / 100;
    probNeutral = Math.round((probNeutral / sum) * 10000) / 100;

    const maxProb = Math.max(probBull, probBear, probNeutral);
    const dirLabel = maxProb === probBull ? "Bullish" : maxProb === probBear ? "Bearish" : "Neutral";

    // -----------------------------
    // Candidate TPs & final selection
    const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);

    // score candidates integrating ML maxProb + candidate.confidence + news tilt
    function scoreCandidateForML(cand, mlMaxPct) {
      const candConf = Number(cand.confidence || 40) / 100; // 0..1
      const mlScore = (mlMaxPct != null) ? (Number(mlMaxPct) / 100) : (maxProb / 100);
      const newsAdj = news ? ((newsSent - 0.5) * 0.1) : 0;
      return candConf * 0.55 + mlScore * 0.35 + newsAdj;
    }

    // primary pick via RR-safe chooser
    let chosen = chooseCandidateTP(candidates, dirLabel, price, atr, feats, 20);

    // if chosen null, try scoring fallback
    if (!chosen && candidates.length) {
      const scored = candidates.map(c => ({ c, s: scoreCandidateForML(c, maxProb) })).sort((x,y)=>y.s - x.s);
      const fallbackCandidates = scored.map(x => x.c);
      chosen = chooseCandidateTP(fallbackCandidates, dirLabel, price, atr, feats, 40) || chooseCandidateTP(fallbackCandidates, "Neutral", price, atr, feats, 40);
    }

    // if still no chosen, create ATR fallback
    if (!chosen) {
      const fallbackTP = dirLabel === "Bullish" ? Number((price + atr * 2).toFixed(8))
                        : dirLabel === "Bearish" ? Number((price - atr * 2).toFixed(8))
                        : null;
      const fallbackSL = dirLabel === "Bullish" ? Number((price - atr * 2).toFixed(8)) : dirLabel === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null;
      if (fallbackTP) chosen = { tp: fallbackTP, source: "AUTO_ATR", confidence: 30, suggestedSL: fallbackSL, reason: "final_fallback" };
    }

    const tpEstimate = chosen && isFiniteNum(chosen.tp) ? Number(chosen.tp) : null;
    const tpSource = chosen ? (chosen.source || "AUTO") : null;

    // blend target confidence with ml max prob for final tpConfidence
    const tpConfidence = chosen ? Math.round( clamp(( (chosen.confidence || 40) * 0.6 + maxProb * 0.4 ), 1, 99) ) : Math.round(maxProb);

    const slEstimate = chosen && isFiniteNum(chosen.suggestedSL) ? Number(chosen.suggestedSL) :
                       dirLabel === "Bullish" ? Number((price - atr * 2).toFixed(8)) :
                       dirLabel === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null;

    // Explanation parts
    const explanationParts = [
      `slope:${Number(feats.slope.toFixed(6))}`,
      `mom5:${(feats.mom5*100).toFixed(2)}%`,
      isFiniteNum(feats.rsi) ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
      ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
      news ? `news:${Math.round(newsSent*100)}(${newsImpact})` : null,
      `atr:${Number(atr.toFixed(8))}`
    ].filter(Boolean).join(" | ");

    // build mlObj
    const mlObj = {
      modelVersion: "ml_module_v9_9",
      symbol,
      tf,
      generatedAt: new Date().toISOString(),
      direction: dirLabel,
      probs: { bull: probBull, bear: probBear, neutral: probNeutral },
      maxProb,
      tpEstimate,
      tpSource,
      tpConfidence,
      slEstimate,
      explanation: explanationParts,
      rawScores: { bull: a, bear: b, neutralLogit: c },
      ellSummary: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null,
      features: { slope: feats.slope, mom5: feats.mom5, rsi: feats.rsi, atr: feats.atr },
      newsSummary: news ? { sentiment: newsSent, impact: newsImpact } : null
    };

    // smoothing: EMA per symbol_tf (slightly smooth to avoid 100% jumps)
    try {
      const key = `${symbol}_${tf}`;
      const sm = smoothProbsEMA(key, { bull: probBull, bear: probBear, neutral: probNeutral }, 0.22);
      // replace probs with smoothed
      mlObj.probs = sm;
      mlObj.maxProb = Math.max(sm.bull, sm.bear, sm.neutral);
    } catch (e) {}

    // persist prediction (non-blocking)
    try { recordPrediction({ id: `${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch (e) {}

    return mlObj;

  } catch (e) {
    return { error: String(e), symbol, tf };
  }
}

// ---------------------------
// Micro predictor (improved)
export async function runMicroPrediction(symbol="BTCUSDT", tf="1m") {
  try {
    const mtf = await fetchMultiTF(symbol, [tf]);
    const entry = mtf[tf] || { data: [], price: 0 };
    const candles = entry.data || [];
    if (!candles || candles.length < 4) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };
    const feats = buildFeaturesFromCandles(candles);
    // combine slope and mom5 and rsi
    const score = clamp((feats.mom5 * 120) + (feats.slope * 12) + ((isFiniteNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 2.0), -14, 14);
    const pBull = 1 / (1 + Math.exp(-score));
    const pb = pctClamp(pBull * 100);
    const pa = pctClamp((1 - pBull) * 100);
    const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");
    return { modelVersion: "ml_module_v9_9-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
  } catch (e) {
    return { error: String(e), label: "Neutral" };
  }
}

// default export
export default {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
};