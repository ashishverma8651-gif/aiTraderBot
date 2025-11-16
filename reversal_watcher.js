// reversal_watcher.js — Reversal Watcher v3.5 (MicroML-powered Super Watcher)
// Features:
// - Fast Micro-ML live nudges (1m/5m) -> immediate alerts
// - MTF consensus (1m/5m/15m) + pattern detection + ML gating -> robust reversal alerts
// - Confirmation window + pending system + feedback recording
// - Integrates with ml_module_v8_6.js (runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome)
// - Safe persistence in ./cache/reversal_watcher_store.json

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

// ------------------ Persistence ------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_store.json");

function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    return JSON.parse(fs.readFileSync(fp, "utf8") || "{}");
  } catch (e) {
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error("safeSave error:", e?.message || e);
    return false;
  }
}

const DEFAULTS = Object.assign({
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 55,          // MTF consensus threshold to create pending
  minAlertConfidence: 60,        // final threshold to send alert on confirmation
  microAlertProbPct: 40,         // micro-ml prob (%) to trigger immediate micro-alert (fast nudge)
  microAlertCooldownSec: 45,     // debounce micro alerts per symbol
  confirmCandles: 2,             // number of confirmation candles on confirmation TF
  confirmationTF: "1m",
  debounceSeconds: 60,           // dedupe identical alerts
  cooldownAfterConfirmSec: 600,  // post-confirm cooldown
  maxPendingAgeMs: 30 * 60 * 1000, // pending expiry
  maxAlertsPerHour: 30,
  allowNeutral: true,
  feedbackWindowsSec: [60, 300]
}, CONFIG.REVERSAL_WATCHER || {});

let STORE = safeLoad(STORE_FILE, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-1000) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// ------------------ Helper utils ------------------
function now() { return Date.now(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function nf(n, d = 2) { return (typeof n === "number" && Number.isFinite(n)) ? Number(n).toFixed(d) : "N/A"; }

function recordHourly() {
  const t = now();
  STORE.hourly.push(t);
  STORE.hourly = STORE.hourly.filter(x => x >= t - 3600000);
  safeSave(STORE_FILE, STORE);
}
function hourlyCount() {
  return STORE.hourly.length;
}
function pruneRecent() {
  const cutoff = now() - DEFAULTS.debounceSeconds * 1000;
  STORE.recent = (STORE.recent || []).filter(x => x.ts >= cutoff);
  safeSave(STORE_FILE, STORE);
}
function addRecent(key) {
  STORE.recent.push({ key, ts: now() });
  STORE.recent = STORE.recent.slice(-2000);
  recordHourly();
  safeSave(STORE_FILE, STORE);
}
function recentlyAlerted(key) {
  pruneRecent();
  return (STORE.recent || []).some(r => r.key === key);
}

// ------------------ Pattern detector (robust) ------------------
function detectPatterns(candles) {
  // returns array of { name, side, strength }
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
  if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close)
    patterns.push({ name: "BullishEngulfing", side: "Bullish", strength: 65 });
  if (prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open)
    patterns.push({ name: "BearishEngulfing", side: "Bearish", strength: 65 });

  // Tweezer top/bottom
  if (Math.abs(prev.high - last.high) / Math.max(1, Math.abs(prev.high)) < 0.0008 && last.close < last.open)
    patterns.push({ name: "TweezerTop", side: "Bearish", strength: 55 });
  if (Math.abs(prev.low - last.low) / Math.max(1, Math.abs(prev.low)) < 0.0008 && last.close > last.open)
    patterns.push({ name: "TweezerBottom", side: "Bullish", strength: 55 });

  // Doji
  if (body / (last.high - last.low || 1) < 0.18)
    patterns.push({ name: "Doji", side: "Neutral", strength: 40 });

  // Pivot-like (simple pivot reversal: high/low pivot)
  try {
    if (prev2 && prev && last) {
      // pivot high
      if (prev.high > prev2.high && prev.high > last.high && prev.close < prev.open)
        patterns.push({ name: "PivotReversalHigh", side: "Bearish", strength: 68 });
      // pivot low
      if (prev.low < prev2.low && prev.low < last.low && prev.close > prev.open)
        patterns.push({ name: "PivotReversalLow", side: "Bullish", strength: 68 });
    }
  } catch (e) { /* ignore */ }

  return patterns;
}

// ------------------ TF score and consensus ------------------
function computeTFScore({ candles, tf, weight }) {
  const out = { score: 50, patterns: [], reasons: [] };
  if (!Array.isArray(candles) || candles.length < 3) return out;

  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    out.patterns.push(p);
    out.score += (p.side === "Bullish" ? p.strength / 2 : -p.strength / 2);
    out.reasons.push("pattern:" + p.name);
  }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : 50;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : { hist: 0 };
    const atr = typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : 1;

    const lastVol = candles.at(-1).vol || candles.at(-1).v || candles.at(-1).volume || 0;
    const volWindow = Math.min(20, candles.length);
    const avgVol = candles.slice(-volWindow).reduce((s, c) => s + (c.vol || c.v || c.volume || 0), 0) / Math.max(1, volWindow);

    if (rsi < 30) { out.score += 6; out.reasons.push("rsi_oversold"); }
    if (rsi > 70) { out.score -= 6; out.reasons.push("rsi_overbought"); }

    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { out.score += 5; out.reasons.push("macd_pos"); }
      if (macd.hist < 0) { out.score -= 5; out.reasons.push("macd_neg"); }
    }

    if (avgVol && lastVol) {
      if (lastVol > avgVol * (DEFAULTS.volumeMultiplier ?? 1)) { out.score += 5; out.reasons.push("vol_spike"); }
      if (lastVol < avgVol * 0.6) { out.score -= 3; out.reasons.push("vol_low"); }
    }

    out.score = Math.min(100, Math.max(0, out.score));
  } catch (e) { /* ignore indicator failures */ }

  // scale by tf weight for downstream consensus
  out.score = Math.round(out.score * (weight || 1));
  return out;
}

function buildConsensus(perTf, weights, mlMain) {
  let sumW = 0, sumS = 0;
  for (const r of perTf) {
    const w = (weights && weights[r.tf]) ? weights[r.tf] : (DEFAULTS.weights[r.tf] || 0.1);
    sumW += w;
    sumS += (r.score || 50) * w;
  }
  const avg = sumW ? sumS / sumW : 50;

  // lightweight ML boost (non-blocking)
  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    boost = ((mlMain.prob - 50) / 50) * 8; // scale small
  }

  const final = Math.round(Math.min(100, Math.max(0, avg + boost)));
  return final;
}

// ------------------ Targets builder ------------------
function buildTargets({ ellObj, price, atr }) {
  const tps = [];
  let slLong = null, slShort = null;
  if (ellObj && ellObj.targets && Array.isArray(ellObj.targets) && ellObj.targets.length) {
    ellObj.targets.slice(0, 3).forEach(t => {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (tp) tps.push({ source: t.source || "Elliott", tp, confidence: t.confidence || 50 });
    });
  }

  if (!tps.length) {
    const m1 = (price + (atr || 1) * 2);
    const m2 = (price + (atr || 1) * 4);
    tps.push({ source: "ATR", tp: Number(m1.toFixed(2)), confidence: 25 });
    tps.push({ source: "ATR", tp: Number(m2.toFixed(2)), confidence: 20 });
  }

  slLong = Number((price - (atr || 1) * (DEFAULTS.slAtrMultiplier || 2)).toFixed(2));
  slShort = Number((price + (atr || 1) * (DEFAULTS.slAtrMultiplier || 2)).toFixed(2));

  return { tps, sls: [{ side: "LONG", sl: slLong }, { side: "SHORT", sl: slShort }] };
}

// ------------------ Helpers for pending store ------------------
function addPending(p) {
  STORE.pending = STORE.pending || [];
  STORE.pending.push(p);
  safeSave(STORE_FILE, STORE);
}
function removePending(id) {
  STORE.pending = (STORE.pending || []).filter(x => x.id !== id);
  safeSave(STORE_FILE, STORE);
}
function updatePendingStatus(id, status, extra = {}) {
  STORE.pending = STORE.pending || [];
  for (let i = 0; i < STORE.pending.length; i++) {
    if (STORE.pending[i].id === id) {
      STORE.pending[i].status = status;
      if (extra) STORE.pending[i].outcome = extra;
      STORE.pending[i].closedAt = now();
      break;
    }
  }
  safeSave(STORE_FILE, STORE);
}

// ------------------ Confirmation logic ------------------
async function confirmPending(pending, opts = {}) {
  try {
    const tf = pending.confirmationTF || opts.confirmationTF || DEFAULTS.confirmationTF;
    const req = pending.requiredCandles || opts.confirmCandles || DEFAULTS.confirmCandles;

    const res = await fetchMarketData(pending.symbol, tf, req + 3);
    const candles = (res && Array.isArray(res.data)) ? res.data : [];

    const closed = candles.slice(-(req + 1), -1);
    if (closed.length < req) return { ok: false, reason: "not_enough_closed" };

    let support = 0;
    for (const c of closed) {
      const body = Math.abs(c.close - c.open) || 1;
      const up = c.close > c.open;
      const lowWick = Math.min(c.open, c.close) - c.low;
      const upWick = c.high - Math.max(c.open, c.close);
      if (pending.side === "Bullish" && up) support++;
      if (pending.side === "Bearish" && !up) support++;
      if (pending.side === "Bullish" && lowWick > body * 1.6) support++;
      if (pending.side === "Bearish" && upWick > body * 1.6) support++;
    }

    const need = Math.ceil(closed.length * 0.6);
    const ok = support >= need;

    const movedPct = closed.length ? ((closed.at(-1).close - closed[0].close) / Math.max(1, Math.abs(closed[0].close))) * 100 : 0;

    return { ok, support, need, closedLast: closed.at(-1), movedPct };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// ------------------ Evaluation (main) ------------------
async function evaluateSymbol(symbol, opts = {}, sendAlert = async () => {}) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs);
    const perTfResults = [];

    // Get ML main (15m) and micro (1m/5m) in parallel
    const mlMainP = runMLPrediction(symbol, "15m").catch(() => null);
    const microP = runMicroPrediction(symbol, 60).catch(() => null);

    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (candles.at(-1)?.close ?? 0);

      const scoreObj = computeTFScore({
        candles,
        tf,
        weight: opts.weights?.[tf] ?? DEFAULTS.weights[tf] ?? 1
      });

      perTfResults.push({
        tf,
        score: scoreObj.score,
        patterns: scoreObj.patterns,
        reasons: scoreObj.reasons,
        price,
        candles
      });
    }

    const [mlMain, micro] = await Promise.all([mlMainP, microP]);

    // MICRO: immediate live nudge alerts (fast)
    if (micro && typeof micro.prob === "number") {
      const probPct = Array.isArray([micro.prob]) ? micro.prob : micro.prob; // safe
      // micro.prob in module returns percent or numeric depending on version; normalize to 0-100
      const microProb = probPct > 1 ? probPct : (probPct * 100);

      if (microProb >= (opts.microAlertProbPct ?? DEFAULTS.microAlertProbPct)) {
        // debounce per symbol+micro
        const microKey = `${symbol}_micro_${Math.round(microProb)}`;
        const lastMicro = (STORE.lastMicroAlerts || {})[symbol] || 0;
        if (now() - lastMicro > (opts.microAlertCooldownSec ?? DEFAULTS.microAlertCooldownSec) * 1000) {
          STORE.lastMicroAlerts = STORE.lastMicroAlerts || {};
          STORE.lastMicroAlerts[symbol] = now();
          safeSave(STORE_FILE, STORE);

          const msg =
            `⚡ <b>MICRO ALERT</b> — ${micro.label || "MicroML"}\n` +
            `Symbol: ${symbol}\n` +
            `MicroML: ${micro.label || ""} (${nf(microProb,2)}%)\n` +
            `TF quick nudge — act fast\n` +
            `Model TP multiplier: ${micro.tpMul ?? micro.tpMul?.toFixed?.(3) ?? "N/A"}\n` +
            `Time: ${new Date().toLocaleString()}`;
          // record lightweight pred
          try {
            const id = await recordPrediction({ symbol, label: micro.label || "Micro", prob: Number(microProb), features: micro.features || micro, source: "micro" });
            // store id inside message for traceability
            await sendAlert(msg + `\nID: ${id}`);
          } catch (e) {
            await sendAlert(msg);
          }
        }
      }
    }

    // Build consensus
    const consensusScore = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);

    // If consensus below pending threshold -> ignore
    if (consensusScore < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) {
      return { alerted: false, reason: "below_threshold", score: consensusScore };
    }

    // Decide side from majority patterns + MTF sentiment
    let bull = 0, bear = 0;
    for (const r of perTfResults) {
      (r.patterns || []).forEach(p => {
        if (p.side === "Bullish") bull++;
        if (p.side === "Bearish") bear++;
      });
    }

    // Add fusion from simple price delta across main TFs (quick heuristic)
    let trendBias = 0;
    try {
      const p15 = perTfResults.find(x => x.tf === "15m");
      if (p15 && p15.candles && p15.candles.length >= 2) {
        const arr = p15.candles;
        trendBias = ((arr.at(-1).close - arr.at(-2).close) / Math.max(1, Math.abs(arr.at(-2).close)));
        // positive -> bullish
      }
    } catch (e) {}

    let side = "Bullish";
    if (bear > bull) side = "Bearish";
    else if (bull === bear) {
      if (mlMain && typeof mlMain.prob === "number") {
        // mlMain.prob is percent (0-100) in our ml_module
        const mlLabel = (mlMain.label || "").toLowerCase();
        if (mlLabel.includes("bull")) side = "Bullish"; else if (mlLabel.includes("bear")) side = "Bearish";
      } else {
        // fallback by trend bias
        side = (trendBias < 0) ? "Bearish" : "Bullish";
      }
    }

    // Build key and dedupe
    const topPattern = perTfResults.flatMap(r => r.patterns || []).at(0) || { name: "Pattern" };
    const priceRef = perTfResults[0]?.price ?? 0;
    const key = `${symbol}_${side}_${topPattern.name}_${Math.round(priceRef)}`;

    if (recentlyAlerted(key)) return { alerted: false, reason: "debounced" };
    if (hourlyCount() >= (opts.maxAlertsPerHour ?? DEFAULTS.maxAlertsPerHour)) return { alerted: false, reason: "rate_limit" };

    // ML gating (relaxed): only block if ML strongly contradicts
    if (mlMain && typeof mlMain.prob === "number") {
      const mlProb = Number(mlMain.prob);
      const mlLabel = (mlMain.label || "").toLowerCase();
      if (mlProb > 65 && ((mlLabel.includes("bull") && side === "Bearish") || (mlLabel.includes("bear") && side === "Bullish"))) {
        return { alerted: false, reason: "ml_strong_contradict", ml: mlMain };
      }
    }

    // Build pending object
    const id = `rev_${Date.now()}_${Math.floor(Math.random()*9000)}`;
    const atr = perTfResults[0] && perTfResults[0].candles ? indicators.computeATR(perTfResults[0].candles) : 0;
    let ell = null;
    try { ell = await analyzeElliott(perTfResults[0].candles); } catch (e) { ell = null; }
    const targets = buildTargets({ ellObj: ell?.ok ? ell : null, price: priceRef, atr });

    const pending = {
      id,
      key,
      symbol,
      side,
      pattern: topPattern.name,
      createdAt: now(),
      priceAtDetect: priceRef,
      perTfResults,
      predId: null,
      status: "pending",
      requiredCandles: opts.confirmCandles ?? DEFAULTS.confirmCandles,
      confirmationTF: opts.confirmationTF ?? DEFAULTS.confirmationTF,
      consensusScore,
      mlMain,
      micro
    };

    // record prediction (for feedback)
    try {
      pending.predId = await recordPrediction({
        symbol,
        predictedAt: new Date().toISOString(),
        label: side,
        prob: consensusScore,
        features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
        meta: { source: "reversal_watcher_v3.5", pattern: topPattern.name }
      });
    } catch (e) {
      pending.predId = null;
    }

    addPending(pending);

    // send pending preview alert
    const previewMsg =
      `⚠️ <b>REVERSAL WATCHER v3.5 — PENDING</b>\n` +
      `Time: ${new Date().toLocaleString()}\n\n` +
      `Symbol: ${symbol}\n` +
      `Direction: <b>${side}</b>\n` +
      `Confidence: <b>${nf(consensusScore,2)}%</b>\n` +
      `TF-weighted Bias: ${nf((consensusScore-50)/50, 2)}\n` +
      `Pattern: ${topPattern.name}\n\n` +
      `ML: ${mlMain?.label || "N/A"} (${mlMain?.prob ?? "N/A"}%)\n` +
      `MicroML: ${micro?.label || "N/A"} (${micro?.prob ?? micro?.prob ? nf(micro.prob,2) : "N/A"}%)\n\n` +
      `Entry: ${nf(priceRef,2)}\n` +
      `Est. TP(s): ${targets.tps.map(t => nf(t.tp,2)).join(" / ")}\n` +
      `SL Guide: ${targets.sls.find(s=>s.side==="LONG")?.sl || "n/a"}\n\n` +
      `ID: ${pending.predId || "none"}`;

    try { await sendAlert(previewMsg); } catch (e) { /* ignore */ }

    // add to recent to debounce identical triggers
    addRecent(key);

    return { alerted: true, pendingId: id, key, score: consensusScore };
  } catch (e) {
    return { alerted: false, error: e?.message || String(e) };
  }
}

// ------------------ Processing pending list ------------------
async function processAllPending(sendAlert = async () => {}, opts = {}) {
  const nowTs = now();
  const list = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of list) {
    try {
      // expire if too old
      if (nowTs - (p.createdAt || 0) > (opts.maxPendingAgeMs || DEFAULTS.maxPendingAgeMs)) {
        updatePendingStatus(p.id, "expired");
        removePending(p.id);
        continue;
      }

      // confirm
      const conf = await confirmPending(p, opts);
      if (!conf.ok) {
        if (conf.reason === "not_enough_closed") {
          // still waiting
          continue;
        } else {
          // failed -> send failed message and record outcome
          const failMsg =
            `🔴 <b>REVERSAL FAILED</b> — ${p.symbol} ${p.side}\n` +
            `Pattern: ${p.pattern}\nReason: ${conf.reason || "invalidated"}\nID: ${p.predId || "none"}`;
          try { await sendAlert(failMsg); } catch (e) {}
          if (p.predId) {
            try { await recordOutcome(p.predId, { correct: false, realizedPrice: conf.closedLast?.close ?? null }); } catch (e) {}
          }
          updatePendingStatus(p.id, "failed", { reason: conf.reason });
          removePending(p.id);
          continue;
        }
      }

      // confirmed -> final alert
      const lastClose = conf.closedLast.close;
      const price = p.priceAtDetect || lastClose;
      const atr = p.perTfResults && p.perTfResults[0]?.candles ? indicators.computeATR(p.perTfResults[0].candles) : 0;
      let ell = null;
      try { ell = await analyzeElliott(p.perTfResults[0].candles); } catch (e) { ell = null; }
      const targets = buildTargets({ ellObj: ell?.ok ? ell : null, price, atr });

      const finalMsg =
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>\n` +
        `Time: ${new Date().toLocaleString()}\n\n` +
        `Symbol: ${p.symbol}\n` +
        `Pattern: ${p.pattern}\n` +
        `Price at detect: ${nf(p.priceAtDetect,2)} | Now: ${nf(lastClose,2)}\n` +
        `Confidence: <b>${nf(p.consensusScore,2)}%</b>\n\n` +
        `TPs: ${targets.tps.map(t => `${nf(t.tp,2)}(${t.source})`).join(" / ")}\n` +
        `SLs: LONG:${targets.sls.find(s=>s.side==="LONG")?.sl || "n/a"} | SHORT:${targets.sls.find(s=>s.side==="SHORT")?.sl || "n/a"}\n\n` +
        `Observed support: ${conf.support}/${conf.need} | movePct: ${nf(conf.movedPct,3)}%\n` +
        `ID: ${p.predId || "none"}`;

      try { await sendAlert(finalMsg); } catch (e) {}

      // record outcome (success)
      if (p.predId) {
        try {
          await recordOutcome(p.predId, { correct: true, realizedPrice: lastClose, realizedReturn: ((lastClose - p.priceAtDetect) / Math.max(1, Math.abs(p.priceAtDetect))) * 100 });
        } catch (e) {}
      }

      updatePendingStatus(p.id, "sent");
      addRecent(p.key);

      // schedule feedback checks for windows
      (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
        setTimeout(async () => {
          try {
            const outcome = await checkPostOutcome(p, win);
            updatePendingStatus(p.id, outcome.success ? "done" : "failed", outcome);
            if (p.predId) {
              try { await recordOutcome(p.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch (e) {}
            }
            // cleanup
            setTimeout(() => removePending(p.id), 2000);
          } catch (e) {}
        }, win * 1000);
      });
    } catch (e) {
      // ignore single pending error and continue
      // console.error("processAllPending error:", e?.message || e);
    }
  }
}

// helper: check post outcome (price move) after windowSec seconds
async function checkPostOutcome(pending, windowSec) {
  try {
    const resp = await fetchMarketData(pending.symbol, "1m", Math.max(3, Math.ceil(windowSec/60) + 2));
    const newPrice = resp?.price ?? null;

    const priceAtSend = (
  pending.priceAtDetect ??
  ((pending.perTfResults && pending.perTfResults[0]?.price) ?? 0)
);

    if (newPrice == null) return { success: false, reason: "no_price" };
    const ret = ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100;
    const success = (pending.side === "Bullish") ? (ret > 0) : (ret < 0);
    return { success, newPrice, realizedReturn: ret };
  } catch (e) { return { success: false, reason: e?.message || String(e) }; }
}

// ------------------ Scheduler ------------------
let _timers = new Map();

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = async () => {}) {
  const opts = Object.assign({}, DEFAULTS, options);

  if (_timers.has(symbol)) return;
  // main scan loop
  const t1 = setInterval(async () => {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch (e) {}
  }, opts.pollIntervalMs);

  // pending confirmation loop (faster)
  const t2 = setInterval(async () => {
    try { await processAllPending(sendAlert, opts); } catch (e) {}
  }, Math.max(5000, Math.floor((opts.confirmationTF === "1m" ? 15000 : 30000))));

  // run initial scan immediately
  (async () => { try { await evaluateSymbol(symbol, opts, sendAlert); } catch (e) {} })();

  _timers.set(symbol, { t1, t2, opts });
  console.log("⚡ Reversal Watcher v3.5 ACTIVE for", symbol);
}

export function stopReversalWatcher(symbol) {
  if (symbol) {
    const t = _timers.get(symbol);
    if (!t) return;
    clearInterval(t.t1); clearInterval(t.t2);
    _timers.delete(symbol);
  } else {
    for (const [s, t] of _timers.entries()) {
      clearInterval(t.t1); clearInterval(t.t2);
    }
    _timers.clear();
  }
}

// status
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