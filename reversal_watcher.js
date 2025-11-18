// reversal_watcher_pro.js — Professional Reversal Watcher
// Exports: startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats
// Default export: { startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats }

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

// -------------------- persistence for simple adaptive stats --------------------
const STATS_FILE = process.env.REV_STATS_FILE || path.join(process.cwd(), ".reversal_stats.json");
let _stats = { alerts: [], wins: 0, losses: 0, lastUpdated: null };
try {
  if (fs.existsSync(STATS_FILE)) {
    const txt = fs.readFileSync(STATS_FILE, "utf8") || "{}";
    _stats = JSON.parse(txt) || _stats;
  }
} catch (e) { /* ignore */ }

function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

// -------------------- runtime memory + defaults --------------------
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
  verbose: false,
  confirmCandleOffset: 1, // 1 => penultimate candle (confirmed)
  notifyOnEveryAlert: false // if true won't use cooldown (careful)
};

const memory = {
  lastSignature: "",
  lastAlertTs: 0,
  lastCandleTS: 0
};

// -------------------- small utils --------------------
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v, d = 2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";
const mean = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

// -------------------- candle / structure helpers --------------------

// wicks, body etc
function candleProps(c) {
  if (!c) return null;
  const open = c.open, close = c.close, high = c.high, low = c.low;
  const body = Math.abs(close - open);
  const range = Math.max(1e-9, high - low);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  return { open, close, high, low, body, range, upperWick, lowerWick };
}

// is doji
function isDoji(c, threshold = 0.15) {
  const p = candleProps(c);
  if (!p) return false;
  return (p.body / p.range) < threshold;
}

// inside bar
function isInsideBar(prev, c) {
  if (!prev || !c) return false;
  return c.high <= prev.high && c.low >= prev.low;
}

// outside bar / engulfing (bigger body)
function isOutsideBar(prev, c) {
  if (!prev || !c) return false;
  return c.high >= prev.high && c.low <= prev.low;
}

// three white soldiers / three black crows simplest
function threeSoldiers(candles, bullish = true) {
  if (!Array.isArray(candles) || candles.length < 3) return false;
  const last3 = candles.slice(-3);
  if (bullish) {
    return last3.every((c,i)=>c.close > c.open) &&
           last3[2].close > last3[1].close && last3[1].close > last3[0].close;
  } else {
    return last3.every((c,i)=>c.open > c.close) &&
           last3[2].close < last3[1].close && last3[1].close < last3[0].close;
  }
}

// tweezer top/bottom simple: two last candles have nearly same high (top) or low (bottom) and opposite direction
function tweezer(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const a = candles[candles.length-2], b = candles[candles.length-1];
  if (!a || !b) return null;
  const highClose = Math.abs(a.high - b.high) <= Math.max(1e-8, Math.max(a.high, b.high) * 0.0015);
  const lowClose = Math.abs(a.low - b.low) <= Math.max(1e-8, Math.max(a.low, b.low) * 0.0015);
  if (highClose && a.close < a.open && b.close > b.open) return { type: "tweezerBottom" };
  if (highClose && a.close > a.open && b.close < b.open) return { type: "tweezerTop" };
  if (lowClose && a.close > a.open && b.close < b.open) return { type: "tweezerTop" };
  if (lowClose && a.close < a.open && b.close > b.open) return { type: "tweezerBottom" };
  return null;
}

// detect hammer / inverted hammer / engulfing / piercing / dark cloud / harami / morning star / evening star
function detectCandlePattern(confirmedCandle, prevCandles = []) {
  if (!confirmedCandle) return null;
  const p = candleProps(confirmedCandle);
  const prev = prevCandles?.[prevCandles.length-1] ?? null;
  if (!p) return null;

  // Hammer (bullish)
  if (p.lowerWick > p.body * 2.2 && p.upperWick < p.body * 0.35) return { side: "Bullish", name: "Hammer" };
  // Inverted Hammer (bearish)
  if (p.upperWick > p.body * 2.2 && p.lowerWick < p.body * 0.35) return { side: "Bearish", name: "InvertedHammer" };
  // Bullish Engulfing
  if (prev && confirmedCandle.close > confirmedCandle.open && prev.close < prev.open && isOutsideBar(prev, confirmedCandle)) {
    return { side: "Bullish", name: "BullishEngulfing" };
  }
  // Bearish Engulfing
  if (prev && confirmedCandle.open > confirmedCandle.close && prev.close > prev.open && isOutsideBar(prev, confirmedCandle)) {
    return { side: "Bearish", name: "BearishEngulfing" };
  }
  // Piercing Pattern (bullish): prior red, then bullish candle opens below prior low and closes > mid of prior body
  if (prev && prev.close < prev.open && confirmedCandle.close > confirmedCandle.open &&
      confirmedCandle.open < prev.close && confirmedCandle.close > (prev.open + prev.close)/2) {
    return { side: "Bullish", name: "Piercing" };
  }
  // Dark Cloud Cover (bearish)
  if (prev && prev.close > prev.open && confirmedCandle.open > prev.close && confirmedCandle.close < (prev.open + prev.close)/2) {
    return { side: "Bearish", name: "DarkCloud" };
  }
  // Harami (small body inside prior)
  if (prev && isInsideBar(prev, confirmedCandle) && (confirmedCandle.body < prev.body * 0.6)) {
    return { side: (confirmedCandle.close > confirmedCandle.open ? "Bullish" : "Bearish"), name: "Harami" };
  }
  // Doji-based (if confirmed is doji and previous has big body)
  if (isDoji(confirmedCandle) && prev && prev.body > confirmedCandle.body * 4) {
    return { side: (prev.close > prev.open ? "Bearish" : "Bullish"), name: "DojiReversal" };
  }
  // Morning / Evening Star (3-candle)
  if (prevCandles && prevCandles.length >= 3) {
    const a = prevCandles[prevCandles.length-3], b = prevCandles[prevCandles.length-2], c = prevCandles[prevCandles.length-1];
    if (a && b && c) {
      // Morning star: long red, small body, long green closing into top half of first
      if (a.close < a.open && Math.abs(b.close - b.open) < a.body * 0.4 && c.close > c.open && c.close > (a.open + a.close)/2) {
        return { side: "Bullish", name: "MorningStar" };
      }
      // Evening star: opposite
      if (a.close > a.open && Math.abs(b.close - b.open) < a.body * 0.4 && c.open < c.close && c.close < (a.open + a.close)/2) {
        return { side: "Bearish", name: "EveningStar" };
      }
    }
  }
  // Three white soldiers / three black crows
  if (threeSoldiers(prevCandles, true)) return { side: "Bullish", name: "ThreeWhiteSoldiers" };
  if (threeSoldiers(prevCandles, false)) return { side: "Bearish", name: "ThreeBlackCrows" };

  // Tweezer
  const tw = tweezer(prevCandles.concat([confirmedCandle]));
  if (tw) return { side: tw.type.includes("Bottom") ? "Bullish" : "Bearish", name: tw.type };

  return null;
}

// -------------------- structural patterns: BoS / CHOCH (light) --------------------
// Very simplified: detect if the last confirmed candle breaks recent swing high/low
function detectBreakOfStructure(candles) {
  if (!Array.isArray(candles) || candles.length < 6) return null;
  const last = candles.at(-2); // confirmed
  const priorWindow = candles.slice(-8, -2);
  const priorHigh = Math.max(...priorWindow.map(c=>c.high));
  const priorLow = Math.min(...priorWindow.map(c=>c.low));
  if (last.close > priorHigh) return { type: "BOS", side: "Bullish", priorHigh };
  if (last.close < priorLow) return { type: "BOS", side: "Bearish", priorLow };
  // CHOCH detection: recent structure flip — simpler heuristic: last two swings reverse
  const highs = candles.slice(-12).map(c=>c.high);
  const lows = candles.slice(-12).map(c=>c.low);
  if (highs.length >= 6) {
    const recentHighs = highs.slice(-6);
    if (recentHighs[recentHighs.length-1] < recentHighs[recentHighs.length-2] && recentHighs[recentHighs.length-2] > recentHighs[recentHighs.length-3]) {
      return { type: "CHOCH", side: "Bearish" };
    }
  }
  return null;
}

// -------------------- Order block / FVG / Liquidity sweep --------------------
function detectOrderBlock(preCandles = [], impulseCandle) {
  if (!Array.isArray(preCandles) || preCandles.length < 4 || !impulseCandle) return null;
  const highs = preCandles.map(c => c.high), lows = preCandles.map(c => c.low);
  const range = Math.max(...highs) - Math.min(...lows);
  const avgBody = mean(preCandles.map(c => Math.abs(c.close - c.open))) || 1e-9;
  const impulsiveBody = Math.abs(impulseCandle.close - impulseCandle.open);
  // consolidation small range + impulsive follow-through
  if (range < avgBody * 4 && impulsiveBody > avgBody * 2.2) {
    return { lo: Math.min(...lows), hi: Math.max(...highs), avgBody };
  }
  return null;
}

function detectFVG(candles, lookback = 6) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  for (let i = candles.length - lookback - 1; i < candles.length - 1; i++) {
    const a = candles[i], b = candles[i+1];
    const aBodyHi = Math.max(a.open, a.close), aBodyLo = Math.min(a.open, a.close);
    const bBodyHi = Math.max(b.open, b.close), bBodyLo = Math.min(b.open, b.close);
    // gap up (bull)
    if (bBodyLo > aBodyHi + 1e-12) return { type: "up", lo: aBodyHi, hi: bBodyLo, index: i+1 };
    if (bBodyHi < aBodyLo - 1e-12) return { type: "down", lo: bBodyHi, hi: aBodyLo, index: i+1 };
  }
  return null;
}

function detectLiquiditySweep(candles, lookback = 12) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const last = candles.at(-2); // confirmed candle
  const priorHigh = Math.max(...candles.slice(-1-lookback, -1).map(c=>c.high));
  const priorLow = Math.min(...candles.slice(-1-lookback, -1).map(c=>c.low));
  if (last.high > priorHigh && last.close < priorHigh) return { side: "BearishSweep", priorHigh };
  if (last.low < priorLow && last.close > priorLow) return { side: "BullishSweep", priorLow };
  return null;
}

// wick strength
function wickStrength(c) {
  if (!c) return { up: 0, down: 0 };
  const body = Math.max(1e-9, Math.abs(c.close - c.open));
  const up = (c.high - Math.max(c.close, c.open)) / body;
  const down = (Math.min(c.close, c.open) - c.low) / body;
  return { up, down };
}

// -------------------- divergence checks (RSI/MACD) - lightweight --------------------
function computeRSIFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = (candles[i].close - (candles[i-1]?.close ?? candles[i].open));
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period || 0.000001;
  const avgLoss = losses / period || 0.000001;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function simpleRSIDivergence(candles) {
  // check whether price made lower low but RSI made higher low (bullish) or vice versa
  if (!Array.isArray(candles) || candles.length < 10) return null;
  // use 3 swing points: pick local lows/highs
  const last = candles.at(-2).close;
  const prevLow = Math.min(...candles.slice(-10, -2).map(c=>c.low));
  const prevHigh = Math.max(...candles.slice(-10, -2).map(c=>c.high));
  const rsiNow = computeRSIFromCandles(candles, 14);
  const rsiPrev = computeRSIFromCandles(candles.slice(0, -2).concat(candles.slice(-10, -2)), 14) || rsiNow;
  if (last < prevLow && isFiniteNum(rsiNow) && isFiniteNum(rsiPrev) && rsiNow > rsiPrev) return { type: "bullishRSIDiv" };
  if (last > prevHigh && isFiniteNum(rsiNow) && isFiniteNum(rsiPrev) && rsiNow < rsiPrev) return { type: "bearishRSIDiv" };
  return null;
}

// -------------------- multiTF alignment --------------------
function multiTFAlignment(multi, side) {
  try {
    // basic: 15m and 30m/1h trend alignment (use last two closes)
    const c15 = (multi["15m"]?.data || []).slice(-3).map(x=>x.close);
    const c30 = (multi["30m"]?.data || []).slice(-3).map(x=>x.close);
    const c1h = (multi["1h"]?.data || []).slice(-3).map(x=>x.close);
    const trend15 = (c15.length>=2) ? (c15.at(-1) - c15.at(-2)) : 0;
    const trend30 = (c30.length>=2) ? (c30.at(-1) - c30.at(-2)) : 0;
    const trend1h = (c1h.length>=2) ? (c1h.at(-1) - c1h.at(-2)) : 0;
    if (side === "Bullish") return (trend15 > 0 && (trend30 >= 0 || trend1h >= 0));
    if (side === "Bearish") return (trend15 < 0 && (trend30 <= 0 || trend1h <= 0));
  } catch (e) {}
  return false;
}

// -------------------- adaptive threshold (very simple online learning) --------------------
function adaptiveThreshold(base) {
  try {
    const total = (_stats.wins||0) + (_stats.losses||0);
    if (!total) return base;
    const winRate = (_stats.wins || 0) / total;
    // if winRate high, allow lower threshold; if low, be stricter
    const adj = Math.round((0.5 - winRate) * 50); // +/- up to ~25 points
    return clamp(base + adj, 45, 90);
  } catch (e) { return base; }
}

// -------------------- message / meta builders --------------------
function buildAlertMsg(meta) {
  const emoji = meta.side === "Bullish" ? "🟢" : "🔴";
  const lines = [
    `${emoji} REVERSAL CONFIRMED — ${meta.side}`,
    `Pattern: ${meta.pattern}`,
    `Price: ${nf(meta.price,2)}`,
    `ML: ${meta.mlLabel || "N/A"} (${meta.mlProb ?? "N/A"}%)`,
    `News: ${meta.newsSentiment ?? "N/A"} (${meta.newsImpact || "low"})`,
    `Order-block: ${meta.orderBlock ? `${nf(meta.orderBlock.lo,2)} - ${nf(meta.orderBlock.hi,2)}` : "no"}`,
    `FVG: ${meta.fvg ? `${meta.fvg.type}` : "no"}`,
    `LiquiditySweep: ${meta.sweep ? meta.sweep.side : "no"}`,
    `BoS/CHOCH: ${meta.struct ? meta.struct.type : "no"}`,
    `alertId: ${meta.alertId}`
  ];
  return lines.join("\n");
}

function recordLocalAlert(alert) {
  _stats.alerts = _stats.alerts || [];
  _stats.alerts.push({ ...alert, ts: new Date().toISOString() });
  if (_stats.alerts.length > 300) _stats.alerts.splice(0, _stats.alerts.length - 300);
  saveStats();
}

// -------------------- mark outcome & stats getters --------------------
export function markOutcome(symbol, alertId, success = true) {
  try {
    _stats.wins = _stats.wins || 0;
    _stats.losses = _stats.losses || 0;
    if (success) _stats.wins++; else _stats.losses++;
    if (_stats.alerts && _stats.alerts.length) {
      const idx = _stats.alerts.findIndex(a => a.alertId === alertId);
      if (idx >= 0) _stats.alerts[idx].outcome = success ? "win" : "loss";
    }
    saveStats();
    try { recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() }); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

export function getStats() {
  return JSON.parse(JSON.stringify(_stats));
}

// -------------------- main scan (confirmed candle only) --------------------
async function scan(symbol) {
  try {
    const now = Date.now();
    const multi = await fetchMultiTF(symbol, ["5m","15m","30m","1h"]);
    const candles15 = multi["15m"]?.data || [];
    if (!Array.isArray(candles15) || candles15.length < 25) return;

    // confirmed candle (penultimate)
    const confIndex = candles15.length - 1 - (_opts.confirmCandleOffset || 1);
    const confirm = candles15[confIndex];
    if (!confirm) return;
    const confirmTs = confirm.time ?? confirm.t ?? null;
    // dedupe per candle timestamp
    if (confirmTs && confirmTs === memory.lastCandleTS) return;
    memory.lastCandleTS = confirmTs;

    // pattern detection (on confirmed candle)
    const prevCandles = candles15.slice(Math.max(0, confIndex - 8), confIndex + 1);
    const pattern = detectCandlePattern(confirm, prevCandles);
    if (!pattern) return;

    // wick checks
    const ws = wickStrength(confirm);
    if (pattern.side === "Bullish" && ws.down < 0.4) return;
    if (pattern.side === "Bearish" && ws.up < 0.4) return;

    // structural checks
    const struct = detectBreakOfStructure(candles15.slice(0, confIndex + 1));

    // sweep/orderblock/fvg
    const sweep = detectLiquiditySweep(candles15.slice(0, confIndex + 1), 12);
    const pre = candles15.slice(Math.max(0, confIndex - 8), confIndex);
    const ob = detectOrderBlock(pre, confirm);
    const fvg = detectFVG(candles15.slice(0, confIndex + 1), 6);

    // volume check (use the candle before confirmed)
    const lastVols = candles15.slice(Math.max(0, confIndex - 14), confIndex + 1).map(c=>c.volume || 0);
    const prevVol = lastVols.length >= 2 ? lastVols[lastVols.length - 2] : lastVols[0] || 1;
    const avgVol = mean(lastVols.slice(0, -1)) || 1;
    const volSpike = prevVol / Math.max(1, avgVol);

    if (_opts.requireVolumeStructure && volSpike < 1.2) return;

    // multi-TF alignment
    if (_opts.requireMultiTFAlign && !multiTFAlignment(multi, pattern.side)) return;

    // dynamic ML threshold
    const baseThresh = _opts.mlMinConfidence || 65;
    const threshold = adaptiveThreshold(baseThresh);

    // ML main (15m)
    const ml = await runMLPrediction(symbol, "15m").catch(()=>null);
    if (!ml) return;
    // compute mlProb robustly
    const mlProb = (isFiniteNum(ml.maxProb) ? ml.maxProb : (ml.probs ? Math.max(ml.probs.bull||0, ml.probs.bear||0, ml.probs.neutral||0) : 0));

    // If ML strongly contradicts pattern side, block
    if (pattern.side === "Bullish" && ml.probs && ml.probs.bear && ml.probs.bear > ml.probs.bull + 12) return;
    if (pattern.side === "Bearish" && ml.probs && ml.probs.bull && ml.probs.bull > ml.probs.bear + 12) return;

    // require ML probability above threshold OR strong structural confirmation
    const structuralBoost = (ob ? 12 : 0) + (fvg ? 8 : 0) + (sweep ? 12 : 0) + (struct ? 10 : 0);
    const effectiveScore = mlProb + structuralBoost;
    if (effectiveScore < threshold && structuralBoost < 8) return;

    // news integration
    let news = { sentiment: 0.5, impact: "low", ok:false };
    try { news = await fetchNewsBundle(symbol); } catch (e) {}
    const newsScore = (isFiniteNum(news.sentiment) ? (news.sentiment - 0.5) * 2 : 0);
    // if high-impact news contradicts, block
    if ((String(news.impact||"").toLowerCase() === "high") &&
        ((newsScore > 0 && pattern.side === "Bearish") || (newsScore < 0 && pattern.side === "Bullish"))) {
      if (_opts.verbose) console.log("blocked by high-impact news:", news.headline || ""); 
      return;
    }

    // micro confirmation
    const micro = await runMicroPrediction(symbol, "1m").catch(()=>null);
    if (micro && micro.label) {
      if (pattern.side === "Bullish" && typeof micro.label === "string" && micro.label.toLowerCase().includes("bear")) return;
      if (pattern.side === "Bearish" && typeof micro.label === "string" && micro.label.toLowerCase().includes("bull")) return;
    }

    // Elliott confirmation (optional)
    let ell = { sentiment: 0, confidence: 0, ok: false };
    try { const e = await analyzeElliott(candles15.slice(0, confIndex+1)); if (e?.ok) ell = e; } catch (e) {}

 // simple RSI divergence check
    const rdiv = simpleRSIDivergence(candles15.slice(0, confIndex+1));
    if (rdiv) {
      if (_opts.verbose) console.log("RSI divergence:", rdiv.type);
    }

    // final composite scoring (fine tune weights as you like)
    let score = 0;
    score += (mlProb - threshold) / 10;      // positive if mlProb > threshold
    score += clamp((volSpike - 1), 0, 3) * 0.6;
    if (ob) score += 0.9;
    if (fvg) score += 0.7;
    if (sweep) score += 0.9;
    if (struct) score += 1.0;
    if (rdiv) score += 0.7;
    score += clamp(newsScore * 0.8, -1, 1);
    if (ell.ok && ell.confidence > 40 && ((ell.sentiment > 0 && pattern.side === "Bullish") || (ell.sentiment < 0 && pattern.side === "Bearish"))) score += 0.7;

    if (_opts.verbose) {
      console.log("scan:", {
        symbol, pattern: pattern.name, side: pattern.side, mlProb, threshold, volSpike: nf(volSpike,2),
        ob: !!ob, fvg: !!fvg, sweep: !!sweep, struct: struct?.type ?? null, score: nf(score,2), news: news.headline ?? null
      });
    }

    if (score < 0.6) return;

    // cooldown / dedupe
    const alertId = `${pattern.side}_${Math.floor(confirm.close)}_${Date.now()}`;
    if (alertId === memory.lastSignature) return;
    if (!_opts.notifyOnEveryAlert && Date.now() - memory.lastAlertTs < (_opts.cooldownMs || 90_000)) return;

    // record & persist
    const meta = {
      alertId, symbol, side: pattern.side, pattern: pattern.name, price: confirm.close,
      mlLabel: ml.direction || ml.label || null, mlProb, newsSentiment: news.sentiment || null,
      newsImpact: news.impact || "low", orderBlock: ob, fvg, sweep, struct, ts: new Date().toISOString()
    };

    recordLocalAlert(meta);
    try { recordPrediction({ id: alertId, symbol, ml, meta }); } catch (e) { /* ignore */ }

    const message = buildAlertMsg(meta);

    if (_send) {
      try {
        await _send(message);
      } catch (e) {
        if (_opts.verbose) console.error("send failed:", e?.message || e);
      }
    }

    // update memory
    memory.lastSignature = alertId;
    memory.lastAlertTs = Date.now();

    if (_opts.verbose) console.log("Reversal alert:", alertId);

  } catch (err) {
    if (_opts.verbose) console.error("scan error:", err?.message ?? err);
  }
}

// -------------------- public control functions --------------------
export function startReversalWatcher(symbol, opts = {}, sendFunc) {
  try {
    stopReversalWatcher();
    _opts = { ...DEFAULTS, ...(opts || {}) };
    _send = sendFunc;
    _interval = setInterval(()=>scan(symbol), _opts.pollIntervalMs);
    setTimeout(()=>scan(symbol), 1200);
    if (_opts.verbose) console.log("ReversalWatcher started for", symbol, "opts:", _opts);
    return true;
  } catch (e) {
    if (_opts.verbose) console.error("start error", e?.message || e);
    return false;
  }
}

export function stopReversalWatcher() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _send = null;
  if (_opts.verbose) console.log("ReversalWatcher stopped");
}

export async function scanReversal(symbol) {
  return await scan(symbol);
}

// default export
export default {
  startReversalWatcher,
  stopReversalWatcher,
  scanReversal,
  markOutcome,
  getStats
};