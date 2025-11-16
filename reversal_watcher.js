// reversal_watcher.js — FINAL CLEAN VERSION (All features: patterns, volume, RSI, MACD, ATR, Elliott, ML, feedback)

import fs from "fs";
import path from "path";

import CONFIG from "./config.js";
import { fetchMarketData, fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";


// =====================
// Storage
// =====================
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");

function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    return JSON.parse(fs.readFileSync(fp, "utf8") || "{}");
  } catch {
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
  } catch {}
}

const DEFAULTS = Object.assign({
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  pollIntervalMs: 20000,
  pendingThreshold: 60,
  minAlertConfidence: 65,
  confirmCandles: 3,
  confirmationTF: "1m",
  debounceSeconds: 300,
  cooldownAfterConfirmSec: 600,
  maxSavedAlerts: 2000,
  mlMainGateMinProb: 50,
  microMlGateDeltaPct: 6,
  maxPendingAgeMs: 24 * 60 * 60 * 1000,
  maxAlertsPerHour: 8,
  volumeMultiplier: 1.0,
  slAtrMultiplier: 2,
  tpAtrMultipliers: [2, 4],
  allowNeutral: false,
  feedbackWindowsSec: [60, 300]
}, CONFIG.REVERSAL_WATCHER || {});

let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
STORE.pending = STORE.pending || [];
STORE.hourly = STORE.hourly || [];


// =====================
// Record keeping
// =====================
function recordHourly() {
  const now = Date.now();
  STORE.hourly.push(now);
  STORE.hourly = STORE.hourly.filter(t => t >= now - 3600000);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() {
  return STORE.hourly.length;
}
function pruneRecent() {
  const cutoff = Date.now() - DEFAULTS.debounceSeconds * 1000;
  STORE.recent = STORE.recent.filter(x => x.ts >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function addRecent(key) {
  STORE.recent.push({ key, ts: Date.now() });
  STORE.recent = STORE.recent.slice(-DEFAULTS.maxSavedAlerts);
  recordHourly();
}
function recentlyAlerted(key) {
  pruneRecent();
  return STORE.recent.some(x => x.key === key);
}


// =====================
// Pattern detection
// =====================
function detectPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return [];

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const patterns = [];
  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.close, last.open);
  const lower = Math.min(last.close, last.open) - last.low;

  // Hammer
  if (lower > body * 1.6 && upper < body * 0.6 && last.close > last.open)
    patterns.push({ name: "Hammer", side: "Bullish", strength: 70 });

  // Shooting Star
  if (upper > body * 1.6 && lower < body * 0.6 && last.close < last.open)
    patterns.push({ name: "ShootingStar", side: "Bearish", strength: 70 });

  // Engulfing
  if (
    prev.close < prev.open &&
    last.close > last.open &&
    last.close > prev.open &&
    last.open < prev.close
  )
    patterns.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });

  if (
    prev.close > prev.open &&
    last.close < last.open &&
    last.open > prev.close &&
    last.close < prev.open
  )
    patterns.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });

  // Tweezer top
  if (
    Math.abs(prev.high - last.high) / Math.abs(prev.high || 1) < 0.0006 &&
    last.close < last.open
  )
    patterns.push({ name: "TweezerTop", side: "Bearish", strength: 55 });

  // Tweezer bottom
  if (
    Math.abs(prev.low - last.low) / Math.abs(prev.low || 1) < 0.0006 &&
    last.close > last.open
  )
    patterns.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  // Doji
  if (body / (last.high - last.low || 1) < 0.2)
    patterns.push({ name: "Doji", side: "Neutral", strength: 40 });

  // Morning Star
  if (
    prev2.close < prev2.open &&
    last.close > last.open &&
    last.close > prev.close
  )
    patterns.push({ name: "MorningStar", side: "Bullish", strength: 72 });

  // Evening Star
  if (
    prev2.close > prev2.open &&
    last.close < last.open &&
    last.close < prev.close
  )
    patterns.push({ name: "EveningStar", side: "Bearish", strength: 72 });

  return patterns;
}


// =====================
// TF Score
// =====================
function computeTFScore({ candles, tf, weight }) {
  const out = { score: 50, patterns: [], reasons: [] };
  if (!candles || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += p.side === "Bullish" ? p.strength / 2 : -p.strength / 2;
    out.reasons.push("pattern:" + p.name);
  }

  try {
    const rsi = indicators.computeRSI(candles);
    const macd = indicators.computeMACD(candles);
    const atr = indicators.computeATR(candles);

    const lastVol =
      candles.at(-1).vol ||
      candles.at(-1).v ||
      candles.at(-1).volume ||
      0;

    const avgVol =
      candles
        .slice(-20)
        .reduce(
          (s, c) =>
            s +
            (c.vol || c.v || c.volume || 0),
          0
        ) / 20;

    if (rsi < 30) out.score += 8;
    if (rsi > 70) out.score -= 8;

    if (macd?.hist > 0) out.score += 6;
    if (macd?.hist < 0) out.score -= 6;

    if (lastVol > avgVol * DEFAULTS.volumeMultiplier) out.score += 6;
    if (lastVol < avgVol * 0.6) out.score -= 6;

    out.score = Math.min(100, Math.max(0, out.score));
  } catch {}

  out.score = Math.round(out.score * weight);
  return out;
}


// =====================
// Consensus
// =====================
function buildConsensus(perTf, weights, mlMain) {
  let sumW = 0,
    sumS = 0;
  for (const r of perTf) {
    const w = weights[r.tf] ?? 0.1;
    sumW += w;
    sumS += r.score * w;
  }
  const avg = sumW ? sumS / sumW : 50;

  let boost = 0;
  if (mlMain)
    boost = ((mlMain.prob - 50) / 50) * 10;

  return Math.round(Math.min(100, Math.max(0, avg + boost)));
}


// =====================
// Targets
// =====================
function buildTargets({ ellObj, price, atr }) {
  const tps = [];
  if (ellObj?.targets?.length) {
    ellObj.targets.slice(0, 3).forEach(t => {
      tps.push({ source: "Elliott", tp: t.tp });
    });
  } else {
    DEFAULTS.tpAtrMultipliers.forEach(m => {
      tps.push({ source: "ATR", tp: Number((price + atr * m).toFixed(2)) });
    });
  }

  const sls = [
    { side: "LONG", sl: Number((price - atr * DEFAULTS.slAtrMultiplier).toFixed(2)) },
    { side: "SHORT", sl: Number((price + atr * DEFAULTS.slAtrMultiplier).toFixed(2)) }
  ];

  return { tps, sls };
}


// =====================
// Keys
// =====================
function makeKey(symbol, side, pattern, price) {
  return `${symbol}_${side}_${pattern}_${Math.round(price)}`;
}


// =====================
// Confirmation
// =====================
async function confirmPending(pending, opts) {
  try {
    const tf = pending.confirmationTF;
    const req = pending.requiredCandles;
    const data = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = data.data;

    const closed = candles.slice(-(req + 1), -1);

    if (closed.length < req)
      return { ok: false, reason: "not_enough_closed" };

    let support = 0;
    closed.forEach(c => {
      const body = Math.abs(c.close - c.open);
      const up = c.close > c.open;
      const lowWick = Math.min(c.open, c.close) - c.low;
      const upWick = c.high - Math.max(c.open, c.close);

      if (pending.side === "Bullish" && up) support++;
      if (pending.side === "Bearish" && !up) support++;

      if (pending.side === "Bullish" && lowWick > body * 1.6) support++;
      if (pending.side === "Bearish" && upWick > body * 1.6) support++;
    });

    const need = Math.ceil(closed.length * 0.6);
    const ok = support >= need;

    return {
      ok,
      support,
      need,
      closedLast: closed.at(-1),
      movedPct:
        ((closed.at(-1).close - closed[0].close) /
          Math.abs(closed[0].close)) *
        100
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}


// =====================
// Symbol evaluation (main logic)
// =====================
async function evaluateSymbol(symbol, opts, sendAlert) {
  const tfs = opts.tfs;

  const multi = await fetchMultiTF(symbol, tfs);

  let mlMain = null;
  try {
    mlMain = await runMLPrediction(symbol, "15m");
  } catch {}

  const perTfResults = [];
  for (const tf of tfs) {
    const entry = multi[tf];
    const c = entry.data;
    const price = entry.price;

    const score = computeTFScore({
      candles: c,
      tf,
      weight: opts.weights[tf]
    });

    perTfResults.push({
      tf,
      score: score.score,
      patterns: score.patterns,
      reasons: score.reasons,
      price,
      candles: c
    });
  }

  const finalScore = buildConsensus(perTfResults, opts.weights, mlMain);

  if (finalScore < opts.pendingThreshold) return;

  let bull = 0,
    bear = 0;
  perTfResults.forEach(r => {
    r.patterns.forEach(p => {
      if (p.side === "Bullish") bull++;
      if (p.side === "Bearish") bear++;
    });
  });

  let side = "Bullish";
  if (bear > bull) side = "Bearish";
  else if (bull === bear)
    side = mlMain?.prob > 50 ? "Bullish" : "Bearish";

  const topPattern =
    perTfResults.flatMap(r => r.patterns)[0] || { name: "Pattern" };

  const priceRef = perTfResults[0].price;
  const key = makeKey(symbol, side, topPattern.name, priceRef);

  if (recentlyAlerted(key)) return;
  if (hourlyCount() >= opts.maxAlertsPerHour) return;

  const id = "pend_" + Date.now();
  const pending = {
    id,
    key,
    symbol,
    side,
    pattern: topPattern.name,
    createdAt: Date.now(),
    priceAtDetect: priceRef,
    perTfResults
  };

  try {
    pending.predId = await recordPrediction({
      symbol,
      predictedAt: new Date().toISOString(),
      label: side,
      prob: finalScore
    });
  } catch {}

  STORE.pending.push(pending);
  safeSave(STORE_FILE, STORE);

  const atr = indicators.computeATR(perTfResults[0].candles);
  const ell = await analyzeElliott(perTfResults[0].candles);
  const targets = buildTargets({
    ellObj: ell?.ok ? ell : null,
    price: priceRef,
    atr
  });

  await sendAlert(
    `⚡ <b>REVERSAL DETECTED</b> (${side})\n` +
      `Symbol: ${symbol}\n` +
      `Pattern: ${pending.pattern}\n` +
      `Score: ${finalScore}%\n` +
      `Price: ${priceRef}\n` +
      `TPs: ${targets.tps.map(t => t.tp).join(" / ")}\n` +
      `SLs: L:${targets.sls[0].sl} / S:${targets.sls[1].sl}\n` +
      `Confirming soon...`
  );

  addRecent(key);
}


// =====================
// Pending checker
// =====================
async function processAllPending(sendAlert, opts) {
  const list = STORE.pending.slice();

  for (const p of list) {
    const conf = await confirmPending(p, opts);

    if (!conf.ok) continue;

    const atr = indicators.computeATR(
      p.perTfResults[0].candles
    );

    const ell = await analyzeElliott(p.perTfResults[0].candles);

    const targets = buildTargets({
      ellObj: ell?.ok ? ell : null,
      price: p.priceAtDetect,
      atr
    });

    const msg =
      `🟢 <b>REVERSAL CONFIRMED</b> (${p.side})\n` +
      `Symbol: ${p.symbol}\n` +
      `Pattern: ${p.pattern}\n` +
      `Price: ${p.priceAtDetect}\n` +
      `Support: ${conf.support}/${conf.need}\n` +
      `TPs: ${targets.tps.map(t => t.tp).join(" / ")}\n` +
      `SLs: L:${targets.sls[0].sl} / S:${targets.sls[1].sl}`;

    await sendAlert(msg);

    if (p.predId)
      await recordOutcome(p.predId, {
        correct: conf.support >= conf.need
      });

    STORE.pending = STORE.pending.filter(x => x.id !== p.id);
    safeSave(STORE_FILE, STORE);
  }
}


// =====================
// Scheduler
// =====================
let _timers = new Map();

export function startReversalWatcher(symbol, options, sendAlert) {
  const opts = Object.assign({}, DEFAULTS, options);
  if (_timers.has(symbol)) return;

  const t1 = setInterval(() => {
    evaluateSymbol(symbol, opts, sendAlert);
  }, opts.pollIntervalMs);

  const t2 = setInterval(() => {
    processAllPending(sendAlert, opts);
  }, 15000);

  _timers.set(symbol, { t1, t2 });
}

export function stopReversalWatcher(symbol) {
  if (symbol && _timers.has(symbol)) {
    clearInterval(_timers.get(symbol).t1);
    clearInterval(_timers.get(symbol).t2);
    _timers.delete(symbol);
  }
}

export function getWatcherState() {
  return {
    running: !!_timers.size,
    pending: STORE.pending,
    recent: STORE.recent,
    accuracy: calculateAccuracy()
  };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};