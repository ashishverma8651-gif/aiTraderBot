// ============================================================================
// ml_module_v8_6.js  (OPTIMIZED + CLEAN STRUCTURE)
// Deterministic lightweight ML engine (no reversal logic inside)
// TP/SL engine improved, candidate selection cleaned
// Exports: runMLPrediction, runMicroPrediction, calculateAccuracy,
//          recordPrediction, recordOutcome
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

try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {}

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
// RECORD HELPERS (Prediction + Outcome)
// ============================================================================
export function recordPrediction(pred) {
    try {
        const arr = readJsonSafe(PRED_FILE);
        arr.push({ ...pred, recordedAt: new Date().toISOString() });

        if (!writeJsonSafe(PRED_FILE, arr)) memPreds.push(pred);

        // CSV debug append
        try {
            if (!fs.existsSync(DEBUG_CSV))
                fs.writeFileSync(
                    DEBUG_CSV,
                    "id,symbol,tf,direction,probs,tp,sl,timestamp\n",
                    "utf8"
                );

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
                new Date().toISOString()
            ].join(",") + "\n";

            fs.appendFileSync(DEBUG_CSV, line, "utf8");
        } catch {}
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

        if (!total) return { accuracy: 0, total: 0, correct: 0 };

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

/** Stable Softmax for 3 logits */
function softmax3(a, b, c) {
    const m = Math.max(a, b, c);
    const ea = Math.exp(a - m);
    const eb = Math.exp(b - m);
    const ec = Math.exp(c - m);

    const s = ea + eb + ec + EPS;
    return [ea / s, eb / s, ec / s];
}

// ============================================================================
// FEATURE BUILDER (CANDLES → FEATURES)
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

    // Slope via linear regression
    const len = Math.min(30, n);
    let num = 0,
        den = 0,
        xmean = 0,
        ymean = 0;

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

    // RSI + MACD
    let rsi = null,
        macdHist = null;
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

    // Fallback FIB
    if (!out.length && ell?.fib?.ext) {
        if (ell.fib.ext["1.272"])
            out.push({ tp: Number(ell.fib.ext["1.272"]), source: "FIB_1.272", confidence: 40 });
        if (ell.fib.ext["1.618"])
            out.push({ tp: Number(ell.fib.ext["1.618"]), source: "FIB_1.618", confidence: 35 });
    }

    // Last fallback ATR
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

    // Deduplicate
    const map = new Map();
    for (const t of out) {
        const key = Math.round(t.tp);
        if (!map.has(key) || t.confidence > map.get(key).confidence) map.set(key, t);
    }

    return [...map.values()].sort((a, b) => Math.abs(a.tp - price) - Math.abs(b.tp - price));
}

// ============================================================================
// TP/SL SELECTION ENGINE
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
        dir === "Bullish"
            ? t => t.tp > price
            : dir === "Bearish"
            ? t => t.tp < price
            : () => true;

    const filtered = candidates.filter(dirFilter);
    const pool = filtered.length ? filtered : candidates;

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

    for (const cand of scored) {
        let sl;

        if (dir === "Bullish") {
            sl = price - baseATR * 2;
        } else if (dir === "Bearish") {
            sl = price + baseATR * 2;
        } else {
            sl = cand.tp > price ? price - baseATR * 1.5 : price + baseATR * 1.5;
        }

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
        dir === "Bullish"
            ? price + baseATR * 2
            : dir === "Bearish"
            ? price - baseATR * 2
            : top.tp;

    const sl =
        dir === "Bullish"
            ? price - baseATR * 2
            : dir === "Bearish"
            ? price + baseATR * 2
            : null;

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
// MAIN ML PREDICTOR
// ============================================================================
export async function runMLPrediction(symbol = "BTCUSDT", tf = "15m") {
    try {
        const mtfRaw = await fetchMultiTF(symbol, [tf, "1m"]);

        const main = mtfRaw[tf] || { data: [], price: 0 };
        const candles = main.data || [];
        const price = isFiniteNum(main.price) ? main.price : candles?.at(-1)?.close ?? 0;

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

        // Elliott analysis
        let ell = null;
        try {
            ell = await analyzeElliott(candles);
        } catch {}

        // CORE SCORING
        let bullScore = 0,
            bearScore = 0;

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

        // Volume spike logic
        let volSpike = 0;
        if (feats.avgVol > 0) {
            volSpike = feats.lastVol / feats.avgVol - 1;
            const adj = clamp(Math.min(1.5, volSpike), -1.2, 1.2) * 1;
            bullScore += adj * 0.4;
            bearScore += adj * 0.4;
        }

        // Elliott weighting
        let ellSent = 0,
            ellConf = 0;

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

        // NEUTRAL LOGIT
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

        // normalize sum 100
        const s = pBull + pBear + pNeutral || 1;
        pBull = (pBull / s) * 100;
        pBear = (pBear / s) * 100;
        pNeutral = (pNeutral / s) * 100;

        const probs = {
            bull: Math.round(pBull * 100) / 100,
            bear: Math.round(pBear * 100) / 100,
            neutral: Math.round(pNeutral * 100) / 100
        };

        const maxProb = Math.max(probs.bull, probs.bear, probs.neutral);
        const dir =
            maxProb === probs.bull
                ? "Bullish"
                : maxProb === probs.bear
                ? "Bearish"
                : "Neutral";

        // Build TP candidates
        const candidates = buildCandidateTPsFromElliott(ell || {}, price, atr);
        const chosen = chooseCandidateTP(candidates, dir, price, atr, feats, 20);

        const tpEstimate = chosen?.tp ?? null;
        const slEstimate = chosen?.suggestedSL ?? null;

        const tpConfidence = chosen
            ? Math.round(chosen.confidence * 0.65 + maxProb * 0.35)
            : Math.round(maxProb);

        const explanation = [
            `slope:${feats.slope.toFixed(6)}`,
            `mom5:${(feats.mom5 * 100).toFixed(2)}%`,
            isFiniteNum(feats.rsi) ? `rsi:${feats.rsi.toFixed(1)}` : null,
            ell ? `ell:${ell.sentiment}(${ell.confidence}%)` : null,
            feats.avgVol
                ? `volSpike:${(feats.lastVol / feats.avgVol - 1).toFixed(2)}x`
                : null,
            `atr:${atr.toFixed(8)}`
        ]
            .filter(Boolean)
            .join(" | ");

        const mlObj = {
            modelVersion: "ml_module_v9_0",
            symbol,
            tf,
            generatedAt: new Date().toISOString(),

            direction: dir,
            probs,
            maxProb,

            tpEstimate,
            tpSource: chosen?.source ?? null,
            tpConfidence,

            slEstimate,

            explanation,

            rawScores: {
                bull: bullScore,
                bear: bearScore,
                neutralLogit
            },

            ellSummary: ell
                ? { sentiment: ell.sentiment, confidence: ell.confidence }
                : null,

            features: {
                slope: feats.slope,
                mom5: feats.mom5,
                rsi: feats.rsi,
                atr: feats.atr
            }
        };

        // Persist
        recordPrediction({
            id: `${symbol}_${tf}_${Date.now()}`,
            symbol,
            tf,
            ml: mlObj
        });

        return mlObj;
    } catch (e) {
        return { error: e.toString(), symbol, tf };
    }
}

// ============================================================================
// MICRO PREDICTOR (1m short-term model)
// ============================================================================
export async function runMicroPrediction(symbol = "BTCUSDT", tf = "1m") {
    try {
        const mtf = await fetchMultiTF(symbol, [tf]);
        const candles = mtf[tf]?.data || [];

        if (candles.length < 3)
            return {
                label: "Neutral",
                prob: 33.33,
                reason: "insufficient micro data"
            };

        const feats = buildFeaturesFromCandles(candles);

        const score = clamp(
            feats.mom5 * 6 +
                feats.slope * 5 +
                ((isFiniteNum(feats.rsi) ? (feats.rsi - 50) / 50 : 0) * 1.5),
            -12,
            12
        );

        const pBull = 100 / (1 + Math.exp(-score));
        const pBear = 100 - pBull;

        const pb = boundedPercent(pBull);
        const pa = boundedPercent(pBear);

        const label = pb > 60 ? "Bullish" : pa > 60 ? "Bearish" : "Neutral";

        return {
            modelVersion: "ml_module_v9_0-micro",
            label,
            prob: Math.max(pb, pa),
            probBull: pb,
            probBear: pa,
            slope: feats.slope
        };
    } catch (e) {
        return { error: e.toString(), label: "Neutral" };
    }
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
    runMLPrediction,
    runMicroPrediction,
    calculateAccuracy,
    recordPrediction,
    recordOutcome
}; 