// reversal_watcher_v2.js
// Ultra-upgrade: Order Blocks, FVG, Liquidity Sweep, News, Adaptive ML threshold
// Exports: startReversalWatcher, stopReversalWatcher, scanReversal, markOutcome, getStats (and default export)

import fs from "fs";
import path from "path";
import { fetchMultiTF } from "./utils.js";
import { runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import News from "./news_social.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || News.default && News.default.fetchNewsBundle)) ?
    (News.fetchNewsBundle || News.default.fetchNewsBundle) :
    async (s)=>({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

// ---- persistence for stats (simple online learning) ----
const STATS_FILE = process.env.REV_STATS_FILE || path.join(process.cwd(), ".reversal_stats.json");
let _stats = { alerts: [], wins: 0, losses: 0, lastUpdated: null };
try { if (fs.existsSync(STATS_FILE)) _stats = JSON.parse(fs.readFileSync(STATS_FILE,"utf8")||"{}") || _stats; } catch(e){}

function saveStats() {
  try {
    _stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), "utf8");
  } catch (e) { /* ignore */ }
}

// ---- runtime memory & config ----
let _interval = null;
let _send = null;
let _opts = {};
const DEFAULTS = {
  pollIntervalMs: 20_000,
  mlMinConfidence: 65,
  cooldownMs: 90_000,
  requireMultiTFAlign: true,
  requireVolumeStructure: true,
  requireOrderBlock: false, // optional stricter mode
  verbose: false
};

const memory = {
  lastSignature: "",
  lastAlertTs: 0,
  lastCandleTS: 0
};

// ---- HELPERS ----
const isFiniteNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo=-Infinity, hi=Infinity) => Math.max(lo, Math.min(hi, v));
const nf = (v,d=2) => isFiniteNum(v) ? Number(v).toFixed(d) : "N/A";

// quick mean
function mean(arr){ if (!arr || !arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length; }

// detect order block (light) — looks for a small consolidation (n candles) with tight range followed by impulsive candle
function detectOrderBlock(preCandles = [], impulseCandle) {
  if (!Array.isArray(preCandles) || preCandles.length < 4 || !impulseCandle) return null;
  // consolidation iff range small relative to ATR-like measure
  const highs = preCandles.map(c=>c.high), lows = preCandles.map(c=>c.low);
  const range = Math.max(...highs) - Math.min(...lows);
  const avgBody = mean(preCandles.map(c=>Math.abs(c.close - c.open)));
  const impulsiveBody = Math.abs(impulseCandle.close - impulseCandle.open);
  if (range < avgBody * 4 && impulsiveBody > avgBody * 2.2) {
    return {
      lo: Math.min(...lows),
      hi: Math.max(...highs),
      bodyAvg: avgBody
    };
  }
  return null;
}

// Fair Value Gap detection (simple): check gap between prior candle bodies
function detectFVG(candles, lookback = 6) {
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  // scan last 'lookback' candles: if there is a gap between body of a candle and next
  for (let i = candles.length - lookback - 1; i < candles.length - 1; i++) {
    const a = candles[i], b = candles[i+1];
    const aBodyHi = Math.max(a.open, a.close), aBodyLo = Math.min(a.open, a.close);
    const bBodyHi = Math.max(b.open, b.close), bBodyLo = Math.min(b.open, b.close);
    if (bBodyLo > aBodyHi + 1e-12) {
      return { type: "up", lo: aBodyHi, hi: bBodyLo, index: i+1 };
    }
    if (bBodyHi < aBodyLo - 1e-12) {
      return { type: "down", lo: bBodyHi, hi: aBodyLo, index: i+1 };
    }
  }
  return null;
}

// liquidity sweep: candle wick pushes beyond previous lg swing high/low and quickly returns
function detectLiquiditySweep(candles, lookback=10) {
  if (!Array.isArray(candles) || candles.length < lookback+1) return null;
  const last = candles.at(-1);
  const priorHigh = Math.max(...candles.slice(-1-lookback, -1).map(c=>c.high));
  const priorLow = Math.min(...candles.slice(-1-lookback, -1).map(c=>c.low));
  // sweep above priorHigh and close back below (bearish sweep) or sweep below priorLow and close back above (bullish sweep)
  if (last.high > priorHigh && last.close < priorHigh) return { side: "BearishSweep", priorHigh };
  if (last.low < priorLow && last.close > priorLow) return { side: "BullishSweep", priorLow };
  return null;
}

// wick strength
function wickStrength(c) {
  if (!c) return { up:0, down:0 };
  const body = Math.abs(c.close - c.open) || 1e-9;
  const up = (c.high - Math.max(c.close, c.open)) / body;
  const down = (Math.min(c.close, c.open) - c.low) / body;
  return { up, down };
}

// multiTF alignment: require 15m move aligned with 30m/1h
function multiTFAlignment(multi, side) {
  try {
    // side: "Bullish" or "Bearish"
    const c15 = multi["15m"].data?.slice(-3).map(x => x.close) || [];
    const c30 = multi["30m"]?.data?.slice(-3).map(x => x.close) || [];
    const trend15 = c15.length >= 2 ? (c15.at(-1) - c15.at(-2)) : 0;
    const trend30 = c30.length >= 2 ? (c30.at(-1) - c30.at(-2)) : 0;
    if (side === "Bullish") return trend15 > 0 && trend30 >= 0;
    if (side === "Bearish") return trend15 < 0 && trend30 <= 0;
  } catch (e) {}
  return false;
}

// adaptive ML threshold based on stats (simple)
function adaptiveThreshold(base) {
  try {
    const total = (_stats.wins||0) + (_stats.losses||0);
    if (!total) return base;
    const winRate = (_stats.wins || 0) / total;
    // if winRate high, allow lower threshold; if low, be stricter
    const adj = (0.5 - winRate) * 0.5 * 100; // range ~ -25..+25
    return clamp(base + Math.round(adj), 45, 90);
  } catch { return base; }
}

// small summary builder
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
    `msgId: ${meta.alertId}`
  ];
  return lines.join("\n");
}

// record local alert (stats)
function recordLocalAlert(alert) {
  _stats.alerts = _stats.alerts || [];
  _stats.alerts.push({ ...alert, ts: new Date().toISOString() });
  // keep last 200
  if (_stats.alerts.length > 200) _stats.alerts.splice(0, _stats.alerts.length - 200);
  saveStats();
}

// public function to mark outcome (call externally after trade closed)
export function markOutcome(symbol, alertId, success = true) {
  try {
    _stats.wins = _stats.wins || 0;
    _stats.losses = _stats.losses || 0;
    if (success) _stats.wins++;
    else _stats.losses++;
    // optionally annotate alert
    if (_stats.alerts && _stats.alerts.length) {
      const idx = _stats.alerts.findIndex(a=>a.alertId===alertId);
      if (idx>=0) _stats.alerts[idx].outcome = success ? "win" : "loss";
    }
    saveStats();
    // also persist via ML module (outcome recording)
    try { recordOutcome({ alertId, symbol, success, ts: new Date().toISOString() }); } catch(e){}
    return true;
  } catch (e) { return false; }
}

// getStats export
export function getStats() {
  return { ..._stats };
}

// ---- main scan logic (confirmed-candle only) ----
async function scan(symbol) {
  try {
    const now = Date.now();
    const multi = await fetchMultiTF(symbol, ["5m","15m","30m","1h"]);
    const candles15 = multi["15m"]?.data || [];
    if (candles15.length < 25) return;

    // use confirmed candle = penultimate (so current can still change)
    const confirm = candles15.at(-2);
    const recent = candles15.slice(-8);
    const price = confirm.close;

    // dedupe per candle
    if (confirm.time === memory.lastCandleTS) return;
    memory.lastCandleTS = confirm.time;

    // quick pattern detection (on the confirmed candle)
    // pattern heuristic: hammer, inverted hammer, engulfing
    const o=confirm.open, cl=confirm.close, h=confirm.high, l=confirm.low;
    const body = Math.abs(cl - o); const range = h - l;
    let pattern = null;
    if ((Math.min(o,cl) - l) > body * 2 && (h - Math.max(o,cl)) < body*0.3) pattern = { side:"Bullish", name:"Hammer" };
    else if ((h - Math.max(o,cl)) > body*2 && (Math.min(o,cl) - l) < body*0.3) pattern = { side:"Bearish", name:"InvertedHammer" };
    else if (cl>o && body > range*0.45) pattern = { side:"Bullish", name:"BullEngulf" };
    else if (o>cl && body > range*0.45) pattern = { side:"Bearish", name:"BearEngulf" };
    if (!pattern) return;

    // wick & sweep checks
    const ws = wickStrength(confirm);
    if (pattern.side === "Bullish" && ws.down < 0.6) return;
    if (pattern.side === "Bearish" && ws.up < 0.6) return;

    const sweep = detectLiquiditySweep(candles15, 12);

    // order-block & FVG detection around the pre candles
    const pre = candles15.slice(-8, -1);
    const ob = detectOrderBlock(pre, confirm);
    const fvg = detectFVG(candles15, 6);

    // volume structure
    const lastVols = candles15.slice(-12).map(c=>c.volume || 0);
    const avgVol = mean(lastVols.slice(0, -1)) || 1;
    const volSpike = (lastVols.at(-2) / avgVol);
    if (_opts.requireVolumeStructure && volSpike < 1.2) return; // require some volume action

    // Multi-TF alignment
    if (_opts.requireMultiTFAlign && !multiTFAlignment(multi, pattern.side)) return;

    // dynamic ML threshold
    const baseThresh = _opts.mlMinConfidence;
    const threshold = adaptiveThreshold(baseThresh);

    // ML main prediction (non-blocking but awaited)
    const ml = await runMLPrediction(symbol, "15m").catch(()=>null);
    if (!ml) return;
    const mlProb = ml.maxProb ?? (ml.probs ? Math.max(ml.probs.bull||0, ml.probs.bear||0, ml.probs.neutral||0) : 0);

    // news integration — if news strongly against signal, block
    let news = { sentiment: 0.5, impact: "low" };
    try { news = await fetchNewsBundle(symbol); } catch(e){}
    const newsScore = (news && typeof news.sentiment === "number") ? (news.sentiment - 0.5)*2 : 0;
    // if high-impact and opposite sign, reduce acceptance
    if (news.impact && String(news.impact).toLowerCase() === "high") {
      if ((newsScore > 0 && pattern.side === "Bearish") || (newsScore < 0 && pattern.side === "Bullish")) {
        return; // news contradicts strongly
      }
    }

    // Micro confirmation
    const micro = await runMicroPrediction(symbol, "1m").catch(()=>null);
    if (!micro) return;
    // simple check: micro label should not be strongly opposite
    if (pattern.side === "Bullish" && micro.label && String(micro.label).toLowerCase().includes("bear")) return;
    if (pattern.side === "Bearish" && micro.label && String(micro.label).toLowerCase().includes("bull")) return;

    // Elliott check (optional)
    let ell = { sentiment:0, confidence:0, ok:false };
    try { const e = await analyzeElliott(candles15); if (e?.ok) ell = e; } catch(e){}

    // final combined scoring
    // score components: mlProb, volSpike, ob presence, fvg, sweep, news
    let score = 0;
    score += (mlProb - threshold) / 10; // positive if mlProb > threshold
    score += clamp((volSpike - 1), 0, 3) * 0.6;
    if (ob) score += 0.8;
    if (fvg) score += 0.6;
    if (sweep) score += 0.9;
    // news supportive small boost
    score += clamp(newsScore * 0.8, -1, 1);
    // ell supportive
    if (ell.ok && ell.confidence > 40 && (ell.sentiment > 0 && pattern.side==="Bullish" || ell.sentiment < 0 && pattern.side==="Bearish")) score += 0.7;

    if (_opts.verbose) console.log("rev-check", { pattern, mlProb, threshold, volSpike: nf(volSpike,2), ob: !!ob, fvg: !!fvg, sweep: !!sweep, score: nf(score,2) });

    // require score positive enough
    if (score < 0.5) return;

    // cooldown + dedupe
    const alertId = `${pattern.side}_${Math.floor(price)}_${Date.now()}`;
    if (alertId === memory.lastSignature) return;
    if (Date.now() - memory.lastAlertTs < _opts.cooldownMs) return;

    // record local and via ml-module
    const meta = {
      alertId,
      symbol,
      side: pattern.side,
      pattern: pattern.name,
      price,
      mlLabel: ml.direction || ml.label || null,
      mlProb,
      newsSentiment: news.sentiment || null,
      newsImpact: news.impact || "low",
      orderBlock: ob,
      fvg,
      sweep,
      ts: new Date().toISOString()
    };
    recordLocalAlert(meta);
    try { recordPrediction({ id: alertId, symbol, ml, meta }); } catch(e){}

    // build message
    const message = buildAlertMsg({ ...meta, mlProb, alertId });

    // send if user provided send func
    if (_send) await _send(message);

    // update memory
    memory.lastSignature = alertId;
    memory.lastAlertTs = Date.now();

    if (_opts.verbose) console.log("Reversal alert sent:", alertId);

  } catch (err) {
    if (_opts.verbose) console.error("scan error:", err?.message || err);
  }
}

// ---- public start/stop/scan/markOutcome/getStats ----
export function startReversalWatcher(symbol, opts = {}, sendFunc) {
  try {
    stopReversalWatcher();
    _opts = { ...DEFAULTS, ...(opts || {}) };
    _send = sendFunc;
    _interval = setInterval(()=>scan(symbol), _opts.pollIntervalMs);
    // warm run
    setTimeout(()=>scan(symbol), 1200);
    if (_opts.verbose) console.log("ReversalWatcher started for", symbol);
    return true;
  } catch (e) {
    return false;
  }
}

export function stopReversalWatcher() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _send = null;
  if (_opts.verbose) console.log("ReversalWatcher stopped");
}

export async function scanReversal(symbol) {
  return scan(symbol);
}

export { markOutcome, getStats };
