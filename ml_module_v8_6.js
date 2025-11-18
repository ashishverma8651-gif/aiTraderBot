// ============================================================================
// ml_module_v8_6.js  (NEWS + SOCIAL INTEGRATED VERSION)
// ============================================================================

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";


// ============================================================================
// CONFIG & PERSISTENCE
// ============================================================================
const LOG_DIR = process.env.ML_LOG_DIR || "./.ml_logs";
const PRED_FILE = path.join(LOG_DIR, "predictions.json");
const OUT_FILE = path.join(LOG_DIR, "outcomes.json");
const DEBUG_CSV = path.join(LOG_DIR, "debug.csv");

// Ensure directories
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
    console.error("LOG_DIR create failed:", e);
}

let memPreds = [];
let memOuts = [];

// ============================================================================
// SAFE JSON HELPERS
// ============================================================================
function readJsonSafe(file) {
    try {
        if (!fs.existsSync(file)) return [];
        const txt = fs.readFileSync(file, "utf8");
        return JSON.parse(txt || "[]");
    } catch {
        return [];
    }
}

function writeJsonSafe(file, obj) {
    try {
        fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
        return true;
    } catch {
        return false;
    }
}

// ============================================================================
// RECORD HELPERS (Prediction + Outcome + CSV Debug)
// ============================================================================
export function recordPrediction(pred) {
    try {
        const arr = readJsonSafe(PRED_FILE);
        arr.push({ ...pred, recordedAt: new Date().toISOString() });

        if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);

        // CSV Debug
        try {
            if (!fs.existsSync(DEBUG_CSV)) {
                fs.writeFileSync(
                    DEBUG_CSV,
                    "id,symbol,tf,direction,probs,tp,sl,newsImpact,timestamp\n",
                    "utf8"
                );
            }

            const line = [
                pred.id || "",
                pred.symbol || "",
                pred.tf || "",
                pred.ml?.direction || "",
                pred.ml?.probs
                    ? `${pred.ml.probs.bull}/${pred.ml.probs.bear}/${pred.ml.probs.neutral}`
                    : "",
                pred.ml?.tpEstimate ?? "",
                pred.ml?.slEstimate ?? "",
                pred.ml?.newsImpact ?? "",
                new Date().toISOString()
            ].join(",") + "\n";

            fs.appendFileSync(DEBUG_CSV, line, "utf8");
        } catch (e) {
            console.error("CSV write failed:", e);
        }
    } catch {
        memPreds.push(pred);
    }
}

export function recordOutcome(outcome) {
    try {
        const arr = readJsonSafe(OUT_FILE);
        arr.push({ ...outcome, recordedAt: new Date().toISOString() });

        if (!writeJsonSafe(OUT_FILE, arr)) memOuts.push(outcome);
    } catch {
        memOuts.push(outcome);
    }
}

// ============================================================================
// ACCURACY CALCULATION
// ============================================================================
export function calculateAccuracy() {
    try {
        const outs = readJsonSafe(OUT_FILE).concat(memOuts || []);
        const total = outs.length;

        if (!total)
            return { accuracy: 0, total: 0, correct: 0 };

        const correct = outs.filter(o => o && o.correct).length;
        const acc = Math.round((correct / total) * 10000) / 100;

        return { accuracy: acc, total, correct };
    } catch {
        return { accuracy: 0, total: 0, correct: 0 };
    }
}

// ============================================================================
// NUMERIC HELPERS
// ============================================================================
const EPS = 1e-12;
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const nf = (v, d = 2) => (isFiniteNum(v) ? Number(v).toFixed(d) : "N/A");
const boundedPercent = n => {
    if (!isFiniteNum(n)) return 0;
    return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100;
};

/** Softmax for 3-class stable logits */
function softmax3(a, b, c) {
    const m = Math.max(a, b, c);
    const ea = Math.exp(a - m);
    const eb = Math.exp(b - m);
    const ec = Math.exp(c - m);
    const s = ea + eb + ec + EPS;
    return [ea / s, eb / s, ec / s];
}

// ============================================================================
// FEATURE BUILDER  (Extract ML features from candles)
// ============================================================================
function buildFeaturesFromCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const n = candles.length;

    const last = candles[n - 1];
    const close = Number(last.close ?? last.adjClose ?? 0);

    const closes = candles.map(c => Number(c.close ?? 0));
    const highs = candles.map(c => Number(c.high ?? c.close ?? 0));
    const lows = candles.map(c => Number(c.low ?? c.close ?? 0));
    const vols = candles.map(c => Number(c.volume ?? c.vol ?? 0));

    // Momentum
    const close5 = n >= 6 ? closes[n - 6] : closes[0];
    const close20 = n >= 21 ? closes[n - 21] : closes[0];

    const mom5 = close5 ? (close - close5) / close5 : 0;
    const mom20 = close20 ? (close - close20) / close20 : 0;

    // Linear regression slope (trend)
    const len = Math.min(30, n);
    let num = 0, den = 0, xmean = 0, ymean = 0;

    for (let i = 0; i < len; i++) {
        xmean += i;
        ymean += closes[n - len + i];
    }
    xmean /= len;
    ymean /= len;

    for (let i = 0; i < len; i++) {
        const x = i;
        const y = closes[n - len + i];
        num += (x - xmean) * (y - ymean);
        den += (x - xmean) * (x - xmean);
    }

    const slope = den === 0 ? 0 : num / den;

    // ATR
    let atr = 0;
    try {
        if (indicators.computeATR) {
            atr = indicators.computeATR(candles);
        } else {
            const trs = [];
            for (let i = 1; i < n; i++) {
                const tr = Math.max(
                    Math.abs(highs[i] - lows[i]),
                    Math.abs(highs[i] - closes[i - 1]),
                    Math.abs(lows[i] - closes[i - 1])
                );
                trs.push(tr);
            }
            const tail = trs.slice(-14);
            atr = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
        }
    } catch {
        atr = 0;
    }

    // RSI / MACD
    let rsi = null, macdHist = null;
    try {
        if (indicators.computeRSI) rsi = indicators.computeRSI(candles);
        if (indicators.computeMACD) {
            const mac = indicators.computeMACD(candles);
            macdHist = mac?.hist ?? null;
        }
    } catch {}

    // Volume
    const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, vols.length));
    const lastVol = vols[n - 1] || 0;

    return {
        close,
        mom5,
        mom20,
        slope,
        atr,
        rsi: isFiniteNum(rsi) ? rsi : null,
        macdHist: isFiniteNum(macdHist) ? macdHist : null,
        avgVol,
        lastVol,
        high: highs[n - 1] || close,
        low: lows[n - 1] || close
    };
}

// ============================================================================
// BUILD CANDIDATE TP TARGETS FROM ELLIOTT
// ============================================================================
function buildCandidateTPsFromElliott(ell, price, atr) {
    const out = [];

    // Elliott Targets
    if (ell?.targets?.length) {
        for (const t of ell.targets) {
            const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
            if (!isFiniteNum(tp) || tp <= 0) continue;

            const age = Number(t.ageDays ?? 0);
            const conf = clamp(Number(t.confidence ?? 50), 0, 100);
            const adj = conf * (age > 7 ? 0.6 : 1);

            out.push({
                tp,
                source: t.source || t.type || "Elliott",
                confidence: Math.round(adj)
            });
        }
    }

    // FIB fallback
    if (!out.length && ell?.fib?.ext) {
        if (ell.fib.ext["1.272"])
            out.push({ tp: Number(ell.fib.ext["1.272"]), source: "FIB_1.272", confidence: 40 });
        if (ell.fib.ext["1.618"])
            out.push({ tp: Number(ell.fib.ext["1.618"]), source: "FIB_1.618", confidence: 35 });
    }

    // Last fallback — ATR TP (2×)
    if (!out.length) {
        out.push({
            tp: price + (atr || price * 0.002) * 2,
            source: "ATR_UP",
            confidence: 30
        });
        out.push({
            tp: price - (atr || price * 0.002) * 2,
            source: "ATR_DOWN",
            confidence: 30
        });
    }

    // Deduplicated sorted list
    const map = new Map();
    for (const t of out) {
        const key = Math.round(t.tp);
        if (!map.has(key) || t.confidence > map.get(key).confidence)
            map.set(key, t);
    }

    return [...map.values()].sort(
        (a, b) => Math.abs(a.tp - price) - Math.abs(b.tp - price)
    );
}

// ============================================================================
// RISK ENGINE — SL, RR, TP selection
// ============================================================================
function computeRiskMetrics(price, tp, sl) {
    if (!isFiniteNum(price) || !isFiniteNum(tp) || !isFiniteNum(sl)) return null;

    const rr = Math.abs((tp - price) / Math.max(EPS, price - sl));
    const pct = Math.abs((tp - price) / price) * 100;

    return {
        rr: isFiniteNum(rr) ? rr : null,
        percMove: isFiniteNum(pct) ? pct : null
    };
}

function chooseCandidateTP(candidates, dir, price, atr, feats, maxRR = 20) {
    if (!candidates?.length) return null;

    const baseATR = feats?.atr || atr || price * 0.002;
    const volFactor = clamp((baseATR / price) / 0.002, 0.5, 3);

    const dirFilter =
        dir === "Bullish" ? t => t.tp > price :
        dir === "Bearish" ? t => t.tp < price :
        () => true;

    const filtered = candidates.filter(dirFilter);
    const pool = filtered.length ? filtered : candidates;

    // Score by proximity + confidence + volatility adjustment
    const scored = pool
        .map(t => {
            const dist = Math.abs(t.tp - price);
            const prox = 1 / (1 + Math.log(1 + dist / baseATR));
            return {
                ...t,
                dist,
                score: (t.confidence || 40) * prox * volFactor
            };
        })
        .sort((a, b) => b.score - a.score);

    // Pick best
    for (const cand of scored) {
        let sl;

        if (dir === "Bullish") sl = price - baseATR * 2;
        else if (dir === "Bearish") sl = price + baseATR * 2;
        else sl = cand.tp > price ? price - baseATR * 1.5 : price + baseATR * 1.5;

        const metrics = computeRiskMetrics(price, cand.tp, sl);
        if (!metrics || metrics.rr <= 0 || metrics.rr > maxRR) continue;

        const minDist = Math.max(baseATR * 0.6, price * 0.0005);
        if (cand.dist < minDist) continue;

        return {
            tp: Number(cand.tp),
            source: cand.source,
            confidence: cand.confidence,
            reason: "best_conf_and_rr",
            suggestedSL: Number(sl.toFixed(8)),
            rr: metrics.rr
        };
    }

    // fallback ATR TP
    const top = scored[0];
    if (!top) return null;

    const fallbackTP =
        dir === "Bullish" ? price + baseATR * 2 :
        dir === "Bearish" ? price - baseATR * 2 :
        top.tp;

    const sl =
        dir === "Bullish" ? price - baseATR * 2 :
        dir === "Bearish" ? price + baseATR * 2 :
        null;

    return {
        tp: Number(fallbackTP.toFixed(8)),
        source: "AUTO_ATR",
        confidence: top.confidence || 40,
        reason: "fallback_atr",
        suggestedSL: isFiniteNum(sl) ? Number(sl.toFixed(8)) : null,
        rr: null
    };
}

// ============================================================================
// PART-3: MAIN PREDICTOR + MICRO + EXPORT (news integrated)
// ============================================================================

import News from "./news_social.js";
const { fetchNewsBundle } = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle))) ?
    (News.fetchNewsBundle || News.default.fetchNewsBundle) :
    async (sym) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// ---------------------------
// MAIN ML PREDICTOR (uses features, candidate builder, risk engine)
// ---------------------------
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m", opts = {}) {
    try {
        // fetch multi-timeframe (main tf + micro 1m)
        const mtfRaw = await fetchMultiTF(symbol, [tf, "1m"]);
        const main = mtfRaw[tf] || { data: [], price: 0 };
        const candles = main.data || [];
        const price = isFiniteNum(main.price) ? main.price : (candles?.at(-1)?.close ?? 0);

        if (!candles?.length || candles.length < 5 || price <= 0) {
            return {
                modelVersion: "ml_module_v9_0",
                symbol,
                tf,
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
        const microFeats = buildFeaturesFromCandles(mtfRaw["1m"]?.data || []);

        // Elliott (best-effort)
        let ell = null;
        try { ell = await analyzeElliott(candles); } catch {}

        // News bundle (best-effort, non-fatal)
        let news = null;
        try { news = await fetchNewsBundle(symbol); } catch { news = null; }
        const newsSent = news && typeof news.sentiment === "number" ? clamp(news.sentiment, 0, 1) : null;
        const newsImpact = news && news.impact ? String(news.impact).toLowerCase() : "low";

        // ---------------------------
        // CORE SCORING (same heuristics as before with small news nudge)
        // ---------------------------
        let bullScore = 0, bearScore = 0;
        const atr = Math.max(feats.atr || 0, price * 0.0005);
        const volRatio = clamp(atr / price, 0, 0.05);
        const momWeight = clamp(1 + volRatio * 10, 0.7, 3);
        const slopeWeight = clamp(1 + volRatio * 6, 0.7, 2.5);

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
            const m = Math.tanh(feats.macdHist / Math.max(1, atr)) * 2;
            bullScore += clamp(m, -3, 3);
            bearScore -= clamp(m, -3, 3);
        }

        if (microFeats) {
            const mN = microFeats.slope || 0;
            bullScore += clamp(mN * 6, -2.5, 2.5);
            bearScore -= clamp(mN * 6, -2.5, 2.5);
        }

        // volume spike
        let volSpike = 0;
        if (feats.avgVol > 0) {
            volSpike = feats.lastVol / feats.avgVol - 1;
            const adj = clamp(Math.min(1.5, volSpike), -1.2, 1.2);
            bullScore += adj * 0.4;
            bearScore += adj * 0.4;
        }

        // Elliott weighting
        let ellSent = 0, ellConf = 0;
        if (ell) {
            ellSent = clamp(ell.sentiment ?? 0, -1, 1);
            ellConf = clamp(ell.confidence ?? 0, 0, 100);
            if (ellConf >= 35) {
                const scale = ellConf >= 80 ? 1.6 : 1;
                const adj = ellSent * 0.6 * (ellConf / 100) * scale;
                bullScore += adj;
                bearScore -= adj;
            }
        }

        // NEWS: small nudge based on sentiment & impact
        if (newsSent != null) {
            // convert newsSent (0..1) to -1..1
            const newsDir = (newsSent - 0.5) * 2;
            const mul = newsImpact === "high" ? 0.9 : newsImpact === "moderate" ? 0.5 : 0.18;
            const nAdj = newsDir * mul;
            // apply symmetrical push
            bullScore += nAdj;
            bearScore -= nAdj;
        }

        // Neutral logit
        const neutralityBase = 0.25;
        const neutralPenalty = clamp(volRatio * 6 + Math.max(0, volSpike) * 0.6, 0, 1.2);
        const neutralLogit = clamp((neutralityBase - neutralPenalty) * 2, -6, 6);

        // Softmax
        const [pBullRaw, pBearRaw, pNeutralRaw] = softmax3(
            clamp(bullScore, -12, 12),
            clamp(bearScore, -12, 12),
            neutralLogit
        );

        let pBull = boundedPercent(pBullRaw * 100);
        let pBear = boundedPercent(pBearRaw * 100);
        let pNeutral = boundedPercent(pNeutralRaw * 100);

        const sum = pBull + pBear + pNeutral || 1;
        pBull = (pBull / sum) * 100;
        pBear = (pBear / sum) * 100;
        pNeutral = (pNeutral / sum) * 100;

        const probs = {
            bull: Math.round(pBull * 100) / 100,
            bear: Math.round(pBear * 100) / 100,
            neutral: Math.round(pNeutral * 100) / 100
        };

        const maxProb = Math.max(probs.bull, probs.bear, probs.neutral);
        const dir = maxProb === probs.bull ? "Bullish" : maxProb === probs.bear ? "Bearish" : "Neutral";

        // Candidates & selection
        const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);
        const chosen = chooseCandidateTP(candidates, dir, price, atr, feats, 20);

        let tpEstimate = chosen?.tp ?? null;
        let tpSource = chosen?.source ?? null;
        let slEstimate = chosen?.suggestedSL ?? null;

        let tpConfidence = chosen ? Math.round(chosen.confidence * 0.65 + maxProb * 0.35) : Math.round(maxProb);

        // Sanitize: enforce min TP distance
        const minTPdist = Math.max(price * 0.002, atr * 0.6, 1);
        if (isFiniteNum(tpEstimate) && Math.abs(tpEstimate - price) < minTPdist) {
            if (dir === "Bullish") tpEstimate = Number((price + minTPdist).toFixed(8));
            else if (dir === "Bearish") tpEstimate = Number((price - minTPdist).toFixed(8));
            else tpEstimate = null;
        }

        // Fallbacks
        if (!isFiniteNum(tpEstimate)) {
            // pick nearest consistent candidate
            const pick = (dir === "Bullish") ? (candidates.find(c => c.tp > price) ?? candidates[0]) :
                         (dir === "Bearish") ? (candidates.find(c => c.tp < price) ?? candidates[0]) :
                         candidates[0];
            if (pick) {
                tpEstimate = pick.tp;
                tpSource = pick.source;
                tpConfidence = Math.max(tpConfidence, pick.confidence || 30);
                slEstimate = pick.suggestedSL ?? slEstimate;
            } else {
                // ATR-based fallback
                tpEstimate = dir === "Bullish" ? Number((price + atr * 2).toFixed(8)) :
                             dir === "Bearish" ? Number((price - atr * 2).toFixed(8)) : null;
                slEstimate = dir === "Bullish" ? Number((price - atr * 2).toFixed(8)) :
                             dir === "Bearish" ? Number((price + atr * 2).toFixed(8)) : null;
                tpSource = "AUTO_ATR";
            }
        }

        // Final RR estimate
        const rrObj = isFiniteNum(tpEstimate) && isFiniteNum(slEstimate) ? computeRiskMetrics(price, tpEstimate, slEstimate) : null;
        const rrEstimate = rrObj?.rr ?? null;

        // Final confidence calibration (penalize when news high-impact contradicts)
        let finalTpConfidence = Math.round(clamp(tpConfidence * (0.98 + (1 - Math.abs(neutralLogit))/10), 5, 99));
        if (news && newsImpact === "high") {
            // if news sentiment strongly contradicts dir, reduce confidence
            if ((dir === "Bullish" && newsSent != null && newsSent < 0.4) ||
                (dir === "Bearish" && newsSent != null && newsSent > 0.6)) {
                finalTpConfidence = Math.round(finalTpConfidence * 0.72);
            }
        }

        // Explanation
        const explanationParts = [
            `slope:${Number(feats.slope.toFixed(6))}`,
            `mom5:${(feats.mom5*100).toFixed(2)}%`,
            isFiniteNum(feats.rsi) ? `rsi:${Number(feats.rsi.toFixed(1))}` : null,
            ell ? `ell:${ell.sentiment!=null?ell.sentiment:"N/A"}(${ell.confidence||0}%)` : null,
            news ? `news:${newsSent!=null?Math.round(newsSent*100):"N/A"}%(${newsImpact})` : null,
            `atr:${Number(atr.toFixed(8))}`
        ].filter(Boolean).join(" | ");

        const mlObj = {
            modelVersion: "ml_module_v9_0",
            symbol,
            tf,
            generatedAt: new Date().toISOString(),
            direction: dir,
            probs,
            maxProb,
            tpEstimate: isFiniteNum(tpEstimate) ? Number(tpEstimate) : null,
            tpSource,
            tpConfidence: finalTpConfidence,
            slEstimate: isFiniteNum(slEstimate) ? Number(slEstimate) : null,
            rrEstimate,
            hedgeTP: null, // hedge TP logic can be added by caller if needed
            hedgeConfidence: null,
            explanation,
            rawScores: { bull: bullScore, bear: bearScore, neutralLogit },
            ellSummary: ell ? { sentiment: ell.sentiment, confidence: ell.confidence } : null,
            newsSummary: news ? { sentiment: newsSent, impact: newsImpact, raw: news } : null,
            features: { slope: feats.slope, mom5: feats.mom5, rsi: feats.rsi, atr: feats.atr }
        };

        // persist prediction (best-effort)
        try { recordPrediction({ id: `${symbol}_${tf}_${Date.now()}`, symbol, tf, ml: mlObj }); } catch {}

        return mlObj;
    } catch (e) {
        return { error: String(e), symbol, tf };
    }
}

// ---------------------------
// MICRO predictor (keeps short-term behavior)
// ---------------------------
export async function runMicroPrediction(symbol = "BTCUSDT", tf = "1m") {
    try {
        const mtf = await fetchMultiTF(symbol, [tf]);
        const entry = mtf[tf] || { data: [], price: 0 };
        const candles = entry.data || [];
        if (!candles || candles.length < 3) return { label: "Neutral", prob: 33.33, reason: "insufficient micro data" };

        const feats = buildFeaturesFromCandles(candles);
        const score = clamp((feats.mom5 * 6) + (feats.slope * 5) + ((isFiniteNum(feats.rsi) ? (feats.rsi - 50)/50 : 0) * 1.5), -12, 12);
        const pBull = 1 / (1 + Math.exp(-score));
        const pb = boundedPercent(pBull * 100);
        const pa = boundedPercent((1 - pBull) * 100);
        const label = pb > 60 ? "Bullish" : (pa > 60 ? "Bearish" : "Neutral");

        return { modelVersion: "ml_module_v9_0-micro", label, prob: Math.max(pb, pa), probBull: pb, probBear: pa, slope: feats.slope || 0 };
    } catch (e) {
        return { error: String(e), label: "Neutral" };
    }
}

// ---------------------------
// DEFAULT EXPORT (include helpers from Part-1 if present)
// ---------------------------
export default {
    runMLPrediction,
    runMicroPrediction,
    calculateAccuracy,
    recordPrediction,
    recordOutcome
};