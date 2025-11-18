// reversal_watcher_a_plus.js
// Professional Reversal Watcher (A++) — full upgraded implementation
// Exports: startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats
// Default export included at bottom.
// Requirements: same imports as your project (ml_module_v8_6.js, elliott_module.js, news_social.js, utils.js)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

// ---------------------------
// Persistence & Stats (simple online learning)
// ---------------------------
const REV_STATS_FILE = process.env.REV_STATS_FILE || path.join(process.cwd(), ".rev_stats.json");
let _stats = { alerts: [], wins: 0, losses: 0, lastUpdated: null };
try {
  if (fs.existsSync(REV_STATS_FILE)) {
    const txt = fs.readFileSync(REV_STATS_FILE, "utf8");
    _stats = Object.assign(_stats, JSON.parse(txt || "{}"));
  }
} catch (e) { /* ignore */ }
function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(REV_STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

// ---------------------------
// Runtime memory & defaults
// ---------------------------
let _interval = null;
let _send = null;
let _opts = {};
const DEFAULTS = {
  pollIntervalMs: 20_000,
  mlMinConfidence: 65,
  cooldownMs: 90_000,
  requireMultiTFAlign: true,
  requireVolumeStructure: true,
  requireOrderBlock: false,
  requireHiddenDivergence: true,
  verbose: false,
  microConfirmWindowMs: 60_000 // micro-confirm within 1 minute of event
};

const memory = {
  lastSignature: "",
  lastAlertTs: 0,
  lastCandleTS: 0
};

// ---------------------------
// Util helpers
// ---------------------------
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d = 2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";
const mean = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

// ---------------------------
// Indicator helpers (lightweight, safe)
// ---------------------------
function computeRSIFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = (candles[i].close ?? 0) - (candles[i-1].close ?? 0);
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// compute a simple macd-like delta via differences of closes (approx)
function computeMACDHistApprox(candles, fast = 12, slow = 26) {
  if (!Array.isArray(candles) || candles.length < slow + 2) return 0;
  // approximate by comparing short-term avg and long-term avg of closes
  const avg = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;
  const len = candles.length;
  const fastAvg = avg(candles.slice(Math.max(0, len - fast), len).map(c => c.close || 0));
  const slowAvg = avg(candles.slice(Math.max(0, len - slow), len).map(c => c.close || 0));
  return fastAvg - slowAvg; // positive => bullish momentum
}

// ---------------------------
// Price swing / pivot utilities
// ---------------------------
function lastNHigherHighs(candles, n = 3) {
  if (!Array.isArray(candles)) return [];
  return candles.slice(-n).map(c => c.high);
}
function lastNLowerLows(candles, n = 3) {
  if (!Array.isArray(candles)) return [];
  return candles.slice(-n).map(c => c.low);
}

// ---------------------------
// Pattern detection (confirmed candle only - penultimate)
// ---------------------------
// returns { side: "Bullish"|"Bearish", name: string, score: number }
function detectCandlePattern(c) {
  if (!c) return null;
  const o = c.open, cl = c.close, h = c.high, l = c.low;
  const body = Math.abs(cl - o);
  const range = h - l || 1;
  const upperWick = h - Math.max(cl, o);
  const lowerWick = Math.min(cl, o) - l;

  // Hammer
  if (lowerWick > body * 1.8 && upperWick < body * 0.5 && cl > o) {
    return { side: "Bullish", name: "Hammer", score: 0.8 };
  }
  // Inverted Hammer
  if (upperWick > body * 1.8 && lowerWick < body * 0.5 && cl < o) {
    return { side: "Bearish", name: "InvertedHammer", score: 0.8 };
  }
  // Bullish Engulfing (confirmed candle is bullish and engulfs prior body)
  if (cl > o && body > 0 && c._prev && Math.abs(c._prev.close - c._prev.open) < body * 0.9 && cl > c._prev.open && o < c._prev.close) {
    return { side: "Bullish", name: "BullishEngulfing", score: 1.0 };
  }
  // Bearish Engulfing
  if (o > cl && body > 0 && c._prev && Math.abs(c._prev.close - c._prev.open) < body * 0.9 && o > c._prev.close && cl < c._prev.open) {
    return { side: "Bearish", name: "BearishEngulfing", score: 1.0 };
  }
  // Large bullish candle after down move
  if (cl > o && body > range * 0.5) return { side: "Bullish", name: "BigBullCandle", score: 0.6 };
  if (o > cl && body > range * 0.5) return { side: "Bearish", name: "BigBearCandle", score: 0.6 };

  return null;
}

// attach previous candle (helper used in scan)
function attachPrevCandles(arr) {
  for (let i = 0; i < (arr?.length || 0); i++) {
    arr[i]._prev = arr[i-1] || null;
  }
  return arr;
}

// ---------------------------
// Order block, FVG, Liquidity Sweep (improved)
// ---------------------------
function detectOrderBlock(preCandles = [], impulse) {
  if (!preCandles || preCandles.length < 4 || !impulse) return null;
  const highs = preCandles.map(c => c.high), lows = preCandles.map(c => c.low);
  const range = Math.max(...highs) - Math.min(...lows);
  const avgBody = mean(preCandles.map(c => Math.abs(c.close - c.open))) || 1;
  const impulseBody = Math.abs(impulse.close - impulse.open);
  // consolidation small range & impulse larger body
  if (range < avgBody * 4 && impulseBody > avgBody * 1.8) {
    return { lo: Math.min(...lows), hi: Math.max(...highs), avgBody, note: "consolidation_impulse" };
  }
  return null;
}

function detectFVG(candles, lookback = 6) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  for (let i = candles.length - lookback - 1; i < candles.length - 1; i++) {
    const a = candles[i], b = candles[i+1];
    if (!a || !b) continue;
    const aBodyHi = Math.max(a.open, a.close), aBodyLo = Math.min(a.open, a.close);
    const bBodyHi = Math.max(b.open, b.close), bBodyLo = Math.min(b.open, b.close);
    if (bBodyLo > aBodyHi + 1e-12) return { type: "up", lo: aBodyHi, hi: bBodyLo, index: i+1 };
    if (bBodyHi < aBodyLo - 1e-12) return { type: "down", lo: bBodyHi, hi: aBodyLo, index: i+1 };
  }
  return null;
}

function detectLiquiditySweep(candles, lookback = 12) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const last = candles.at(-1);
  const priorRange = candles.slice(-1 - lookback, -1);
  const priorHigh = Math.max(...priorRange.map(c => c.high));
  const priorLow = Math.min(...priorRange.map(c => c.low));
  // sweep above priorHigh then close back below -> bearish sweep
  if (last.high > priorHigh && last.close < priorHigh) return { side: "BearishSweep", priorHigh };
  // sweep below priorLow then close back above -> bullish sweep
  if (last.low < priorLow && last.close > priorLow) return { side: "BullishSweep", priorLow };
  return null;
}

// ---------------------------
// Hidden divergence (RSI) detection (local) — bullish when price lower low & RSI higher low
// returns { type: "hiddenBull"|"hiddenBear", details }
function detectHiddenDivergence(candles, lookback = 8) {
  if (!Array.isArray(candles) || candles.length < lookback + 2) return null;
  // find two local lows (indices)
  const arr = candles.slice(- (lookback + 2));
  // build lows and rsi
  const closes = arr.map(c => c.close || 0);
  const rsiArr = arr.map((_,i) => {
    const sub = candles.slice(-(lookback + 2) + i - 14, -(lookback + 2) + i + 1);
    return computeRSIFromCandles(sub || [], 14) ?? null;
  });
  // simple heuristic: compare last low vs earlier low
  let idx1 = -1, idx2 = -1;
  // find first local low (from left)
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i].low <= arr[i-1].low && arr[i].low <= arr[i+1].low) {
      if (idx1 < 0) idx1 = i;
      else idx2 = i;
    }
  }
  if (idx1 >= 0 && idx2 >= 0 && idx2 > idx1) {
    const priceLower = arr[idx2].low < arr[idx1].low;
    const rsiHigher = (rsiArr[idx2] != null && rsiArr[idx1] != null) ? (rsiArr[idx2] > rsiArr[idx1]) : false;
    if (priceLower && rsiHigher) return { type: "hiddenBull", idx1, idx2, price1: arr[idx1].low, price2: arr[idx2].low, rsi1: rsiArr[idx1], rsi2: rsiArr[idx2] };
    const priceHigher = arr[idx2].high > arr[idx1].high;
    const rsiLower = (rsiArr[idx2] != null && rsiArr[idx1] != null) ? (rsiArr[idx2] < rsiArr[idx1]) : false;
    if (priceHigher && rsiLower) return { type: "hiddenBear", idx1, idx2, price1: arr[idx1].high, price2: arr[idx2].high, rsi1: rsiArr[idx1], rsi2: rsiArr[idx2] };
  }
  return null;
}

// ---------------------------
// Multi-TF alignment
// ---------------------------
function multiTFAlignment(multi, side) {
  try {
    // side: "Bullish" or "Bearish"
    const c15 = (multi["15m"]?.data || []).slice(-3).map(x => x.close);
    const c30 = (multi["30m"]?.data || []).slice(-3).map(x => x.close);
    if (c15.length < 2 || c30.length < 2) return false;
    const trend15 = c15.at(-1) - c15.at(-2);
    const trend30 = c30.at(-1) - c30.at(-2);
    if (side === "Bullish") return trend15 > 0 && trend30 >= 0;
    if (side === "Bearish") return trend15 < 0 && trend30 <= 0;
  } catch {}
  return false;
}

// ---------------------------
// Adaptive ML threshold (simple online adjustment by win rate)
// ---------------------------
function adaptiveThreshold(base) {
  try {
    const total = (_stats.wins || 0) + (_stats.losses || 0);
    if (!total) return base;
    const winRate = (_stats.wins || 0) / total; // 0..1
    // adjust: if winRate high, lower threshold; if low, increase threshold
    const adj = Math.round((0.5 - winRate) * 40); // range approx -20..+20
    return clamp(base + adj, 45, 90);
  } catch { return base; }
}

// ---------------------------
// Momentum shift (RSI change + MACD delta + volume delta) → normalized score
// ---------------------------
function momentumShiftScore(feats) {
  // feats: { rsiNow, rsiPrev, macdNow, macdPrev, volNow, volAvg }
  if (!feats) return 0;
  const rsiDelta = (isFiniteNum(feats.rsiNow) && isFiniteNum(feats.rsiPrev)) ? (feats.rsiNow - feats.rsiPrev) / 10 : 0;
  const macdDelta = isFiniteNum(feats.macdNow) && isFiniteNum(feats.macdPrev) ? (feats.macdNow - feats.macdPrev) / Math.max(1, Math.abs(feats.macdPrev)) : 0;
  const volDelta = isFiniteNum(feats.volNow) && isFiniteNum(feats.volAvg) ? ((feats.volNow / Math.max(1, feats.volAvg)) - 1) : 0;
  // combine with weights
  const score = clamp((rsiDelta * 0.5) + (macdDelta * 0.4) + (volDelta * 0.6), -3, 3);
  return score; // positive supports bullish shift, negative bearish
}

// ---------------------------
// Helper: Build alert message
// ---------------------------
function buildAlertMsg(meta) {
  const emoji = meta.side === "Bullish" ? "🟢" : "🔴";
  const lines = [
    `${emoji} REVERSAL CONFIRMED — ${meta.side}`,
    `Pattern: ${meta.pattern}`,
    `Price: ${nf(meta.price,2)}`,
    `ML: ${meta.mlLabel || "N/A"} (${meta.mlProb ?? "N/A"}%)`,
    `MomentumShift: ${nf(meta.momentumShift,3)}`,
    `HiddenDiv: ${meta.hiddenDiv ? meta.hiddenDiv.type : "no"}`,
    `OrderBlock: ${meta.orderBlock ? `${nf(meta.orderBlock.lo,2)}-${nf(meta.orderBlock.hi,2)}` : "no"}`,
    `FVG: ${meta.fvg ? meta.fvg.type : "no"}`,
    `Sweep: ${meta.sweep ? meta.sweep.side : "no"}`,
    `News: ${nf((meta.newsSentiment||0)*100,1)}% (${meta.newsImpact || "low"})`,
    `id: ${meta.alertId}`
  ];
  return lines.join("\n");
}

// ---------------------------
// Local recording wrapper
// ---------------------------
function recordLocalAlert(alert) {
  _stats.alerts = _stats.alerts || [];
  _stats.alerts.push({ ...alert, ts: new Date().toISOString() });
  if (_stats.alerts.length > 400) _stats.alerts.splice(0, _stats.alerts.length - 400);
  saveStats();
}

// ---------------------------
// External: markOutcome (called by user to train) — persists stats & ML outcome
// ---------------------------
export function markOutcome(symbol, alertId, success = true) {
  try {
    _stats.wins = _stats.wins || 0;
    _stats.losses = _stats.losses || 0;
    if (success) _stats.wins++;
    else _stats.losses++;
    // annotate alert if exists
    const idx = (_stats.alerts || []).findIndex(a => a.alertId === alertId);
    if (idx >= 0) _stats.alerts[idx].outcome = success ? "win" : "loss";
    saveStats();
    try { recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() }); } catch(e){}
    return true;
  } catch (e) { return false; }
}

export function getStats() {
  return { ..._stats };
}

// ---------------------------
// The main scan function (confirmed-candle logic + all checks)
// ---------------------------
async function scan(symbol) {
  try {
    const now = Date.now();
    const multi = await fetchMultiTF(symbol, ["1m", "5m", "15m", "30m", "1h"]);
    const candles15 = (multi["15m"]?.data || []).slice();
    if (!candles15 || candles15.length < 25) {
      if (_opts.verbose) console.log("not enough 15m candles");
      return null;
    }

    // attach prev references (for pattern detection that needs previous candle)
    attachPrevCandles(candles15);

    // Use confirmed candle = penultimate (so last open candle not used)
    const confirm = candles15.at(-2);
    if (!confirm) return null;
    const price = confirm.close;

    // dedupe per candle
    if (confirm.time === memory.lastCandleTS) return null;
    memory.lastCandleTS = confirm.time;

    // detect pattern on confirmed candle
    const patternObj = detectCandlePattern(confirm);
    if (!patternObj) {
      if (_opts.verbose) console.log("no pattern on confirmed candle");
      return null;
    }
    const side = patternObj.side; // "Bullish" or "Bearish"

    // quick wick check: require decent wick relative to body (to indicate rejection)
    const upWick = confirm.high - Math.max(confirm.open, confirm.close);
    const downWick = Math.min(confirm.open, confirm.close) - confirm.low;
    const body = Math.abs(confirm.close - confirm.open) || 1;
    if (side === "Bullish" && downWick < body * 0.5) {
      if (_opts.verbose) console.log("bullish wick too small, skip");
      return null;
    }
    if (side === "Bearish" && upWick < body * 0.5) {
      if (_opts.verbose) console.log("bearish wick too small, skip");
      return null;
    }

    // compute simple features for momentumShift
    const rsiNow = computeRSIFromCandles(candles15, 14);
    const rsiPrev = computeRSIFromCandles(candles15.slice(0, -1), 14);
    const macdNow = computeMACDHistApprox(candles15);
    const macdPrev = computeMACDHistApprox(candles15.slice(0, -1));
    const lastVols = candles15.slice(-20).map(c => c.volume || 0);
    const volNow = (candles15.at(-2)?.volume || 0);
    const volAvg = mean(lastVols.slice(0, -1)) || 1;

    const feats = { rsiNow, rsiPrev, macdNow, macdPrev, volNow, volAvg };
    const momentumShift = momentumShiftScore(feats);

    // Hidden divergence detection (if enabled)
    let hiddenDiv = null;
    if (_opts.requireHiddenDivergence) {
      try { hiddenDiv = detectHiddenDivergence(candles15, 8); } catch(e){}
      if (!hiddenDiv) {
        // If config requires hidden divergence, skip
        if (_opts.requireHiddenDivergence) {
          if (_opts.verbose) console.log("hidden divergence required but not found");
          return null;
        }
      } else {
        // ensure divergence supports the side
        if ((hiddenDiv.type === "hiddenBull" && side !== "Bullish") || (hiddenDiv.type === "hiddenBear" && side !== "Bearish")) {
          if (_opts.verbose) console.log("hidden divergence contradicts side");
          hiddenDiv = null;
        }
      }
    }

    // order block, FVG, sweep detection
    const preCandles = candles15.slice(-9, -1);
    const orderBlock = detectOrderBlock(preCandles, confirm);
    const fvg = detectFVG(candles15, 6);
    const sweep = detectLiquiditySweep(candles15, 12);

    // volume structure requirement
    const last12Vol = candles15.slice(-12).map(c => c.volume || 0);
    const avgVol = mean(last12Vol.slice(0, -1)) || 1;
    const volSpike = (last12Vol.at(-2) / avgVol);
    if (_opts.requireVolumeStructure && volSpike < 1.15) {
      if (_opts.verbose) console.log("volume condition failed", nf(volSpike,2));
      return null;
    }

    // multiTF alignment check
    if (_opts.requireMultiTFAlign && !multiTFAlignment(multi, side)) {
      if (_opts.verbose) console.log("multi-TF alignment failed");
      return null;
    }

    // ML prediction
    const ml = await runMLPrediction(symbol, "15m").catch(() => null);
    if (!ml) {
      if (_opts.verbose) console.log("ml failed");
      return null;
    }
    const mlProb = ml.maxProb ?? (ml.probs ? Math.max(ml.probs.bull || 0, ml.probs.bear || 0, ml.probs.neutral || 0) : 0);
    const mlDir = ml.direction || ml.label || (ml.probs && (ml.probs.bull > ml.probs.bear ? "Bullish" : "Bearish")) || "Neutral";

    // adaptive threshold
    const threshold = adaptiveThreshold(_opts.mlMinConfidence);

    // news check
    let news = { sentiment: 0.5, impact: "low", ok: false };
    try { news = await fetchNewsBundle(symbol); } catch (e) { /* ignore */ }
    const newsScore = (typeof news.sentiment === "number") ? (news.sentiment - 0.5) * 2 : 0;
    if (String(news.impact || "").toLowerCase() === "high") {
      // if news strongly contradicts pattern side, skip
      if ((newsScore > 0 && side === "Bearish") || (newsScore < 0 && side === "Bullish")) {
        if (_opts.verbose) console.log("news contradicts signal, skip");
        return null;
      }
    }

    // micro (1m) confirmation — require not strongly opposite and small micro support
    const micro = await runMicroPrediction(symbol, "1m").catch(()=>null);
    if (!micro) {
      if (_opts.verbose) console.log("micro missing");
      return null;
    }
    if (side === "Bullish" && micro.label && String(micro.label).toLowerCase().includes("bear")) {
      if (_opts.verbose) console.log("micro contradicts bullish");
      return null;
    }
    if (side === "Bearish" && micro.label && String(micro.label).toLowerCase().includes("bull")) {
      if (_opts.verbose) console.log("micro contradicts bearish");
      return null;
    }

    // Combined scoring (weights tuned for strict Professional mode)
    let score = 0;
    // ML: positive if ML direction aligns and prob above threshold
    if ((mlDir === "Bullish" && side === "Bullish") || (mlDir === "Bearish" && side === "Bearish")) {
      score += clamp((mlProb - threshold) / 10, -2, 3); // bigger if mlProb >> threshold
    } else {
      score -= clamp((threshold - mlProb) / 20, 0, 2);
    }
    // momentum shift
    score += clamp(momentumShift * 0.9, -2, 2);
    // volume spike
    score += clamp((volSpike - 1), 0, 3) * 0.5;
    // orderblock/fvg/sweep bonuses
    if (orderBlock) score += 0.8;
    if (fvg) score += 0.6;
    if (sweep) score += 0.9;
    // hidden divergence bonus
    if (hiddenDiv) score += 0.9;
    // news supportive small boost
    score += clamp(newsScore * 0.6, -1, 1);
    // micro support
    if (micro && micro.prob && micro.prob > 60) score += 0.7;

    if (_opts.verbose) {
      console.log("scan debug:", {
        pattern: patternObj.name,
        side,
        mlProb,
        threshold,
        momentumShift: nf(momentumShift,3),
        volSpike: nf(volSpike,2),
        orderBlock: !!orderBlock,
        fvg: !!fvg,
        sweep: !!sweep,
        hiddenDiv: !!hiddenDiv,
        score: nf(score,2)
      });
    }

    // require final score > gate (strict) — tune as needed
    const requiredScore = 0.6; // pro strict
    if (score < requiredScore) {
      if (_opts.verbose) console.log("score below required ->", nf(score,2));
      return null;
    }

    // cooldown + dedupe
    const alertId = `${side}_${Math.floor(price)}_${Date.now()}`;
    if (alertId === memory.lastSignature) return null;
    if (Date.now() - memory.lastAlertTs < _opts.cooldownMs) {
      if (_opts.verbose) console.log("global cooldown active");
      return null;
    }

    // Build meta, record and send
    const meta = {
      alertId,
      symbol,
      side,
      pattern: patternObj.name,
      price,
      mlLabel: mlDir,
      mlProb,
      micro,
      newsSentiment: news.sentiment ?? null,
      newsImpact: news.impact ?? "low",
      momentumShift,
      orderBlock,
      fvg,
      sweep,
      hiddenDiv,
      score,
      ts: new Date().toISOString()
    };

    recordLocalAlert(meta);
    try { recordPrediction({ id: alertId, symbol, meta, ml }); } catch (e) { /* ignore */ }

    const msg = buildAlertMsg(meta);
    if (_send) {
      try { await _send(msg); } catch (e) { /* ignore */ }
    }

    // memory updates
    memory.lastSignature = alertId;
    memory.lastAlertTs = Date.now();

    if (_opts.verbose) console.log("Reversal alert SENT:", alertId);

    return meta;

  } catch (err) {
    if (_opts.verbose) console.error("scan error:", err?.message || err);
    return null;
  }
}

// ---------------------------
// Public API: start / stop / scanReversal
// ---------------------------
export function startReversalWatcher(symbol, opts = {}, sendFunc) {
  try {
    stopReversalWatcher();
    _opts = Object.assign({}, DEFAULTS, opts || {});
    _send = sendFunc;
    // ensure mlMinConfidence present
    _opts.mlMinConfidence = _opts.mlMinConfidence ?? DEFAULTS.mlMinConfidence;
    _opts.cooldownMs = _opts.cooldownMs ?? DEFAULTS.cooldownMs;
    _opts.pollIntervalMs = _opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    _interval = setInterval(() => { scan(symbol).catch(()=>{}); }, _opts.pollIntervalMs);
    // warm immediate scan
    setTimeout(()=>scan(symbol).catch(()=>{}), 1000);
    if (_opts.verbose) console.log("ReversalWatcher A++ started for", symbol, "opts:", _opts);
    return true;
  } catch (e) {
    return false;
  }
}

export function stopReversalWatcher() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _send = null;
  if (_opts.verbose) console.log("ReversalWatcher A++ stopped");
}

export async function scanReversal(symbol) {
  return await scan(symbol);
}

// ---------------------------
// default export
// ---------------------------
export default {
  startReversalWatcher,
  stopReversalWatcher,
  scanReversal,
  markOutcome,
  getStats
};