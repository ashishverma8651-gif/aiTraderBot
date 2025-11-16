// reversal_watcher_strict.js — Single-file STRICT watcher
// Requires: config.js, utils.js (fetchMultiTF, fetchMarketData), elliott_module.js, core_indicators.js, ml_module_v8_6.js
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import * as indicators from "./core_indicators.js";
import {
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -------------------------
// Storage & logging
// -------------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STORE_FILE = path.join(DATA_DIR, "reversal_watcher_strict_store.json");
const LOG_FILE = path.join(DATA_DIR, "reversal_watcher_strict_log.txt");

// Safe JSON helpers (single definitions)
function safeLoad(fp, def = {}) {
  try {
    if (!fs.existsSync(fp)) return def;
    const txt = fs.readFileSync(fp, "utf8");
    return txt ? JSON.parse(txt) : def;
  } catch (e) {
    console.warn("safeLoad err", e?.message || e);
    return def;
  }
}
function safeSave(fp, obj) {
  try {
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.warn("safeSave err", e?.message || e);
    return false;
  }
}
function log(...args) {
  try {
    const line = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })}] ${args.join(" ")}`;
    fs.appendFileSync(LOG_FILE, line + "\n");
    console.log(line);
  } catch (e) {
    console.log("log:", ...args);
  }
}

// -------------------------
// Defaults (STRICT mode)
// -------------------------
const DEFAULTS = Object.assign({
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.4 },
  pollIntervalMs: 20 * 1000,
  minAlertConfidence: 75,        // strict: require high consensus
  mlGateMinProb: 60,             // require ml main prob >= 60
  confirmationCandles: 3,        // strict: 3 candles on confirmation TF
  confirmationTF: "1m",
  debounceSeconds: 600,          // cooldown after confirmed alert (10 min)
  pendingThresholdOffset: -5,    // start pending when consensus >= minAlertConfidence - 5
  microMlGateDelta: 3,           // micro ML contradictory guard (percent)
  feedbackWindowsSec: [60, 300],
  maxSavedAlerts: 2000,
  requireMLGate: true,
  maxAlertsPerHour: 4,           // stricter rate limit
  patternBoostPoints: 45,
  enablePatternBoost: true
}, CONFIG.REVERSAL_WATCHER || {});

// -------------------------
// Internal state (single store)
 // store = { alerts: [...], pending: [...], hourly: [...] }
const _store = safeLoad(STORE_FILE, { alerts: [], pending: [], hourly: [] });

// normalize
_store.alerts = Array.isArray(_store.alerts) ? _store.alerts.slice(-DEFAULTS.maxSavedAlerts) : [];
_store.pending = Array.isArray(_store.pending) ? _store.pending : [];
_store.hourly = Array.isArray(_store.hourly) ? _store.hourly : [];

// watcher timers
let _watcherTimers = new Map();
let _running = false;

// -------------------------
// Utility helpers
// -------------------------
function recordHourly() {
  const now = Date.now();
  _store.hourly.push(now);
  // keep last hour
  const cutoff = now - 60 * 60 * 1000;
  _store.hourly = _store.hourly.filter(t => t >= cutoff);
  safeSave(STORE_FILE, _store);
}
function hourlyCount() {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  _store.hourly = (_store.hourly || []).filter(t => t >= cutoff);
  return _store.hourly.length;
}
function cleanupAlerts() {
  // remove stale pending (older than 24h)
  const now = Date.now();
  _store.pending = (_store.pending || []).filter(p => (now - (p.ts || 0)) < (24 * 60 * 60 * 1000));
  _store.alerts = (_store.alerts || []).slice(-DEFAULTS.maxSavedAlerts);
  safeSave(STORE_FILE, _store);
}

// -------------------------
// Simple pattern detector
// -------------------------
function detectSimplePatternsFromCandles(candles = []) {
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1), prev = candles.at(-2);
  const body = Math.max(1e-6, Math.abs(last.close - last.open));
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;

  if (DEFAULTS.enablePatternBoost && lowerWick > body * 1.6 && upperWick < body * 0.6 && last.close > last.open) {
    out.push({ name: "Hammer", side: "Bullish", strength: Math.min(95, 30 + (lowerWick/body) * 12) });
  }
  if (DEFAULTS.enablePatternBoost && upperWick > body * 1.6 && lowerWick < body * 0.6 && last.close < last.open) {
    out.push({ name: "ShootingStar", side: "Bearish", strength: Math.min(95, 30 + (upperWick/body) * 12) });
  }
  const isBullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  if (isBullEngulf) out.push({ name: "BullishEngulfing", side: "Bullish", strength: 60 });
  const isBearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (isBearEngulf) out.push({ name: "BearishEngulfing", side: "Bearish", strength: 60 });
  return out;
}

// -------------------------
// Per-TF scoring
// -------------------------
function computeTFScore({ candles = [], ell = null, mlMicro = null, tf = "15m", tfWeight = 1 }) {
  let score = 0;
  const reasons = [];
  const patterns = detectSimplePatternsFromCandles(candles);

  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(90, p.strength || DEFAULTS.patternBoostPoints);
    score += pscore;
    reasons.push(`pattern:${p.name}(${p.side})`);
  }

  try {
    const rsi = indicators.computeRSI(candles);
    const macd = indicators.computeMACD(candles);
    const atr = indicators.computeATR(candles);
    if (macd && typeof macd.hist === "number") {
      if (macd.hist > 0) { score += 6; reasons.push("macd_pos"); }
      else if (macd.hist < 0) { score -= 6; reasons.push("macd_neg"); }
    }
    if (typeof rsi === "number") {
      if (rsi < 30) { score += 6; reasons.push("rsi_oversold"); }
      if (rsi > 70) { score -= 6; reasons.push("rsi_overbought"); }
    }
    if (typeof atr === "number") reasons.push(`atr:${Math.round(atr)}`);
  } catch (e) {
    // non-fatal
  }

  if (ell && typeof ell.sentiment === "number") {
    const s = ell.sentiment * 10;
    score += s;
    reasons.push(`ell_sent:${ell.sentiment.toFixed(2)}`);
  }

  if (mlMicro && typeof mlMicro.prob === "number") {
    const p = (mlMicro.prob - 50) / 100 * 20;
    score += p;
    reasons.push(`mlMicro:${mlMicro.label || ""}:${mlMicro.prob}`);
  }

  const raw = Math.max(-100, Math.min(100, score));
  const norm = Math.round((raw + 100) / 2); // 0..100
  const weighted = norm * (tfWeight || 1);
  return { score: norm, weighted, reasons, patterns };
}

// -------------------------
// Consensus builder
// -------------------------
function buildConsensus(perTfResults = [], weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTfResults) {
    const w = weights[r.tf] || 0.1;
    sumW += w;
    sumS += (r.score || 0) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || [] });
  }
  const avg = sumW ? (sumS / sumW) : 50;

  let boost = 0;
  if (mlMain && typeof mlMain.prob === "number") {
    // mlMain.prob: 0..100 -> convert to -8..+8 (smaller influence for strict)
    boost = ((mlMain.prob - 50) / 50) * 8 * DEFAULTS.mlGateMinProb / 100;
  }

  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 85 ? "STRONG" : final >= DEFAULTS.minAlertConfidence ? "MODERATE" : final >= 50 ? "WEAK" : "NONE";
  return { final, label, breakdown, mlBoost: Math.round(boost * 100) / 100, mlMainLabel: mlMain?.label || null };
}

// -------------------------
// Debounce key & recent checks
// -------------------------
function makeDebounceKey(symbol, side, perTfResults) {
  const patterns = perTfResults
    .flatMap(r => (r.patterns || []).map(p => `${r.tf}:${p.name}`))
    .sort()
    .join("|") || "NOPAT";
  const scores = perTfResults
    .map(r => `${r.tf}:${Math.round(r.score || 0)}`)
    .sort()
    .join("|") || "NOSCORE";
  const priceZone = perTfResults[0] && perTfResults[0].price ? Math.round(perTfResults[0].price / 10) : "P0";
  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}
function recentlyConfirmedOrCooldown(key) {
  cleanupAlerts();
  const now = Date.now();
  // check recent confirmed alerts with same key within debounceSeconds
  const cutoff = now - (DEFAULTS.debounceSeconds * 1000);
  return (_store.alerts || []).some(a => a.key === key && (a.ts || 0) >= cutoff);
}
function recordConfirmedAlert(key, meta = {}) {
  _store.alerts = _store.alerts || [];
  _store.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  _store.alerts = _store.alerts.slice(-DEFAULTS.maxSavedAlerts);
  recordHourly();
  safeSave(STORE_FILE, _store);
}

// -------------------------
// Confirmation assessment (strict)
// -------------------------
function assessConfirmation(side, recentCandles) {
  // recentCandles: array oldest->newest of length >= confirmationCandles
  const N = recentCandles.length;
  if (N === 0) return { ok: false, reason: "no_candles" };
  let directionalCount = 0;
  const start = recentCandles[0], last = recentCandles.at(-1);
  let movedPct = 0;
  if (start && last) movedPct = start.close ? ((last.close - start.close) / Math.max(1, Math.abs(start.close))) * 100 : 0;
  for (const c of recentCandles) {
    if (side === "Bullish" && c.close > c.open) directionalCount++;
    if (side === "Bearish" && c.close < c.open) directionalCount++;
    // wick confirmation adds weight
    const body = Math.max(1e-6, Math.abs(c.close - c.open));
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    if (side === "Bullish" && lowerWick > body * 1.6) directionalCount++;
    if (side === "Bearish" && upperWick > body * 1.6) directionalCount++;
  }
  const supportNeeded = Math.ceil(N * 0.6);
  const ok = directionalCount >= supportNeeded || (side === "Bullish" ? movedPct > 0.15 : movedPct < -0.15);
  return { ok, directionalCount, movedPct };
}

// -------------------------
// TP/SL builder
// -------------------------
function makeTPsAndSLs({ ellSummary = null, ellTargets = [], atr = 0, price = 0 }) {
  const tps = [];
  const sls = [];
  try {
    if (Array.isArray(ellTargets) && ellTargets.length) {
      for (const t of ellTargets.slice(0, 4)) {
        const tp = Number(t.tp || t.target || t.price || 0);
        if (tp && !Number.isNaN(tp)) tps.push({ source: "Elliott", tp, confidence: t.confidence || 50 });
      }
    }
    if ((!tps || tps.length === 0) && ellSummary && ellSummary.support && ellSummary.resistance) {
      tps.push({ source: "ElliottZoneHi", tp: ellSummary.resistance, confidence: 40 });
      tps.push({ source: "ElliottZoneLo", tp: ellSummary.support, confidence: 40 });
    }
    if (!tps || tps.length === 0) {
      tps.push({ source: "ATR_x2", tp: Number((price + Math.max(1, atr) * 2).toFixed(2)), confidence: 30 });
      tps.push({ source: "ATR_x4", tp: Number((price + Math.max(1, atr) * 4).toFixed(2)), confidence: 25 });
    }
    const slLong = Number((price - Math.max(1, atr) * 2).toFixed(2));
    const slShort = Number((price + Math.max(1, atr) * 2).toFixed(2));
    sls.push({ side: "LONG", sl: slLong });
    sls.push({ side: "SHORT", sl: slShort });
  } catch (e) {}
  return { tps, sls };
}

// -------------------------
// Evaluate symbol (candidate -> create pending)
// -------------------------
async function evaluateSymbolCandidate(symbol, opts = {}, sendAlert = null) {
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs);

    // ml main (15m) — best-effort
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }

    const perTfResults = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      let ell = null;
      try { const er = await analyzeElliott(candles); ell = (er && er.ok) ? er : null; } catch (e) { ell = null; }

      let mlMicro = null;
      if (["1m", "5m"].includes(tf)) {
        try { mlMicro = await runMicroPrediction(symbol, tf, opts.microLookback || 60); } catch (e) { mlMicro = null; }
      }

      const weight = opts.weights && opts.weights[tf] ? opts.weights[tf] : (DEFAULTS.weights[tf] || 0.1);
      const sc = computeTFScore({ candles, ell, mlMicro, tf, tfWeight: weight });

      perTfResults.push({
        tf,
        price,
        candles,
        ell,
        mlMicro,
        score: sc.score,
        weighted: sc.weighted,
        reasons: sc.reasons,
        patterns: sc.patterns
      });
    }

    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);
    const finalScore = consensus.final;

    // Trend quick check (use 15m or 1h if provided)
    let trend = "FLAT";
    try {
      const hc = multi["1h"] || multi["15m"];
      const closes = (hc?.data || []).map(c => c.close).slice(-10);
      if (closes.length >= 2) {
        const last = Number(closes.at(-1)), prev = Number(closes.at(-3) || closes.at(-2));
        if (last > prev) trend = "UP"; else if (last < prev) trend = "DOWN";
      }
    } catch (e) {}

    // Strict ML gate
    if (DEFAULTS.requireMLGate && mlMain && typeof mlMain.prob === "number") {
      if (mlMain.prob < DEFAULTS.mlGateMinProb && finalScore < 95) {
        log("ML main blocked candidate", symbol, "mlProb:", mlMain.prob, "consensus:", finalScore);
        return { alerted: false, reason: "ml_gate", finalScore, mlMain };
      }
    }

    // threshold to start pending (slightly below min to let confirmation verify)
    const pendingThreshold = (opts.pendingThresholdOffset != null) ? (DEFAULTS.minAlertConfidence + DEFAULTS.pendingThresholdOffset) : (DEFAULTS.minAlertConfidence - 5);
    if (finalScore >= pendingThreshold) {
      // determine side
      const bullCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bullish")).length;
      const bearCount = perTfResults.filter(r => (r.patterns || []).some(p => p.side === "Bearish")).length;
      let side = "Bullish";
      if (bullCount > bearCount) side = "Bullish";
      else if (bearCount > bullCount) side = "Bearish";
      else if (mlMain && mlMain.label) side = mlMain.label;
      else side = finalScore >= 50 ? "Bullish" : "Bearish";

      const key = makeDebounceKey(symbol, side, perTfResults);
      if (recentlyConfirmedOrCooldown(key)) {
        log("suppressed by recent confirmed/cooldown", key);
        return { alerted: false, reason: "suppressed_cooldown", key };
      }
      // avoid duplicate pending
      if ((_store.pending || []).some(p => p.key === key && (p.status === "pending" || p.status === "confirmed"))) {
        log("duplicate pending exists, skipping", key);
        return { alerted: false, reason: "duplicate_pending", key };
      }
      // rate limit per hour
      if (hourlyCount() >= DEFAULTS.maxAlertsPerHour) {
        log("hourly rate limit reached, skipping candidate", symbol);
        return { alerted: false, reason: "rate_limited" };
      }

      // record base prediction (for feedback later)
      let predId = null;
      try {
        predId = await recordPrediction({
          symbol,
          predictedAt: new Date().toISOString(),
          label: side,
          prob: finalScore,
          features: { perTf: perTfResults.map(r => ({ tf: r.tf, score: r.score })) },
          meta: { source: "reversal_watcher_strict", mlMain }
        });
      } catch (e) { predId = null; }

      // add pending entry
      const pendingId = `pending_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      _store.pending = _store.pending || [];
      _store.pending.push({
        id: pendingId,
        key,
        symbol,
        side,
        ts: Date.now(),
        createdAt: new Date().toISOString(),
        perTfResults,
        predId,
        status: "pending",
        consensusScore: finalScore,
        priceAtDetect: perTfResults[0]?.price || 0,
        requiredCandles: opts.confirmationCandles || DEFAULTS.confirmationCandles,
        confirmTf: opts.confirmationTF || DEFAULTS.confirmationTF
      });
      safeSave(STORE_FILE, _store);
      log("pending candidate recorded", symbol, side, "pendingId:", pendingId, "score:", finalScore);
      return { alerted: false, reason: "pending_created", pendingId, key, finalScore };
    }

    return { alerted: false, reason: "below_threshold", finalScore };

  } catch (e) {
    log("evaluateSymbolCandidate error", e?.message || e);
    return { alerted: false, error: e?.message || String(e) };
  }
}

// -------------------------
// Process pending queue (confirmation + confirmed send)
// -------------------------
async function processPending(sendAlert = null, opts = {}) {
  const pendingCopy = Array.isArray(_store.pending) ? _store.pending.slice() : [];
  for (const p of pendingCopy) {
    try {
      if (!p || p.status !== "pending") continue;
      const tf = p.confirmTf || DEFAULTS.confirmationTF;
      const needed = p.requiredCandles || DEFAULTS.confirmationCandles;

      // fetch recent needed candles (use last needed closed candles)
      const resp = await fetchMarketData(p.symbol, tf, needed + 3);
      const candles = (resp?.data || []);
      if (!candles || candles.length < needed) {
        // not enough closed candles yet (wait)
        continue;
      }
      // use last `needed` closed candles (excluding current open)
      const recent = candles.slice(- (needed + 0)); // they are closed if fetch returns closed candles
      // ensure oldest->newest
      const conf = assessConfirmation(p.side, recent.slice(-needed));
      if (conf.ok) {
        // re-evaluate micro ML average to avoid contradictory micro predictions
        let mlMicroAvg = null;
        try {
          const microPromises = (p.perTfResults || []).filter(r => ["1m", "5m"].includes(r.tf)).map(async r => {
            if (r.mlMicro) return r.mlMicro;
            try { return await runMicroPrediction(p.symbol, r.tf, opts.microLookback || 60); } catch (e) { return null; }
          });
          const microRes = await Promise.all(microPromises);
          const probs = microRes.filter(Boolean).map(m => Number(m.prob || 50));
          if (probs.length) mlMicroAvg = probs.reduce((a, b) => a + b, 0) / probs.length;
        } catch (e) { mlMicroAvg = null; }

        if (mlMicroAvg != null) {
          if (p.side === "Bullish" && mlMicroAvg < (50 - DEFAULTS.microMlGateDelta)) {
            log("micro ML contradiction - blocking confirmed send", p.id, p.symbol, "microAvg:", mlMicroAvg);
            // mark failed
            p.status = "failed";
            p.closedAt = new Date().toISOString();
            safeSave(STORE_FILE, _store);
            continue;
          }
          if (p.side === "Bearish" && mlMicroAvg > (50 + DEFAULTS.microMlGateDelta)) {
            log("micro ML contradiction - blocking confirmed send", p.id, p.symbol, "microAvg:", mlMicroAvg);
            p.status = "failed";
            p.closedAt = new Date().toISOString();
            safeSave(STORE_FILE, _store);
            continue;
          }
        }

        // final cooldown check (maybe confirmed already)
        if (recentlyConfirmedOrCooldown(p.key)) {
          log("recent confirmed/cooldown prevents sending", p.key);
          p.status = "failed";
          p.closedAt = new Date().toISOString();
          safeSave(STORE_FILE, _store);
          continue;
        }

        // Prepare TP/SL and send message
        const topTf = p.perTfResults && p.perTfResults.length ? p.perTfResults[0] : null;
        const ellTargets = (topTf && topTf.ell && topTf.ell.targets) ? topTf.ell.targets : [];
        const ellSummary = (topTf && topTf.ell && topTf.ell.ok) ? { support: topTf.ell.support, resistance: topTf.ell.resistance } : null;
        const atr = (topTf && topTf.candles) ? indicators.computeATR(topTf.candles) : 0;
        const price = p.priceAtDetect || (topTf && topTf.price) || 0;
        const { tps, sls } = makeTPsAndSLs({ ellSummary, ellTargets, atr, price });

        const tpTxt = tps && tps.length ? tps.slice(0, 3).map(t => `${Number(t.tp).toFixed(2)} (${t.source})`).join(" / ") : "n/a";
        const slTxt = sls && sls.length ? sls.map(s => `${s.side}:${s.sl}`).join(" / ") : "n/a";

        const msgLines = [
          `⚡ <b>REVERSED (CONFIRMED)</b> — <b>${p.side}</b>`,
          `Symbol: <b>${p.symbol}</b> | Confidence: <b>${Math.round(p.consensusScore || 0)}%</b>`,
          `PriceAtDetect: ${Number(price).toFixed(2)} | TP(s): ${tpTxt}`,
          `SLs: ${slTxt}`,
          `Observed: ${conf.directionalCount}/${needed} candles in direction | movePct: ${Number(conf.movedPct).toFixed(4)}%`,
          `ID: ${p.predId || "none"}`
        ];
        const text = msgLines.join("\n");

        try {
          if (typeof sendAlert === "function") await sendAlert(text);
          else log("Would send confirmed alert:", text);
        } catch (e) {
          log("sendAlert error", e?.message || e);
        }

        // mark sent & record for cooldown
        p.status = "sent";
        p.sentAt = new Date().toISOString();
        p.confirmation = conf;
        recordConfirmedAlert(p.key, { symbol: p.symbol, side: p.side, predId: p.predId, score: p.consensusScore });
        safeSave(STORE_FILE, _store);

        // schedule outcome checks (feedback)
        (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
          setTimeout(async () => {
            try {
              const outcome = await (async () => {
                // fetch fresh 1m price at time of check
                const r = await fetchMarketData(p.symbol, "1m", 1);
                const newPrice = r?.price ?? price;
                const movedUp = newPrice > price;
                const success = (p.side === "Bullish") ? movedUp : !movedUp;
                const realizedReturn = price ? ((newPrice - price) / Math.max(1, Math.abs(price))) * 100 : null;
                if (p.predId) {
                  try { recordOutcome(p.predId, { correct: !!success, realizedReturn: typeof realizedReturn === "number" ? realizedReturn : null, realizedPrice: newPrice }); } catch (e) {}
                }
                return { ok: true, predId: p.predId, newPrice, success, realizedReturn };
              })();
              // mark done/failed
              p.closedAt = new Date().toISOString();
              p.outcome = outcome;
              p.status = outcome.success ? "done" : "failed";
              safeSave(STORE_FILE, _store);
              log("feedback recorded for", p.id, JSON.stringify(outcome));
            } catch (e) {
              log("feedback processing error", e?.message || e);
            }
          }, win * 1000);
        });

      } else {
        // not confirmed -> increase observation counter or mark failed if old
        p.lastCheck = new Date().toISOString();
        p.observed = (p.observed || 0) + 1;
        // If observed many times without confirmation, mark failed
        if (p.observed > ((p.requiredCandles || DEFAULTS.confirmationCandles) + 6)) {
          p.status = "failed";
          p.closedAt = new Date().toISOString();
          safeSave(STORE_FILE, _store);
          log("pending marked failed (no confirmation over time)", p.id);
        } else {
          safeSave(STORE_FILE, _store);
          log("pending still waiting", p.id, "observed:", p.observed);
        }
      }
    } catch (e) {
      log("processPending error", e?.message || e);
    }
  }
  // cleanup finished/old pending entries
  cleanupAlerts();
}

// -------------------------
// Public API: start/stop watcher
// -------------------------
function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", options = {}, sendAlert = null) {
  if (_watcherTimers.has(symbol)) {
    log("Watcher already running for", symbol);
    return false;
  }
  const opts = Object.assign({}, DEFAULTS, options);
  log("Starting STRICT Reversal Watcher for", symbol, "opts:", JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs, minAlertConfidence: opts.minAlertConfidence }));

  // main candidate tick
  const tick = async () => {
    try {
      await evaluateSymbolCandidate(symbol, opts, sendAlert);
    } catch (e) {
      log("tick exception", e?.message || e);
    }
  };

  // pending processor tick
  const pendTick = async () => {
    try {
      await processPending(sendAlert, opts);
    } catch (e) {
      log("pendTick exception", e?.message || e);
    }
  };

  // start timers
  tick();
  const idMain = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  // process pending more frequently to catch candle closes (every 10s)
  const idPend = setInterval(pendTick, Math.max(8 * 1000, Math.floor((opts.pollIntervalMs || DEFAULTS.pollIntervalMs) / 2)));
  _watcherTimers.set(symbol, { idMain, idPend });
  _running = true;
  return true;
}

async function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _watcherTimers.get(symbol);
      if (rec) {
        if (rec.idMain) clearInterval(rec.idMain);
        if (rec.idPend) clearInterval(rec.idPend);
        _watcherTimers.delete(symbol);
      }
    } else {
      for (const [s, rec] of _watcherTimers.entries()) {
        if (rec.idMain) clearInterval(rec.idMain);
        if (rec.idPend) clearInterval(rec.idPend);
        _watcherTimers.delete(s);
      }
    }
    _running = _watcherTimers.size > 0;
    log("Stopped watcher for", symbol || "ALL");
    return true;
  } catch (e) {
    log("stopReversalWatcher error", e?.message || e);
    return false;
  }
}

function getWatcherState() {
  cleanupAlerts();
  return {
    running: _running,
    symbols: Array.from(_watcherTimers.keys()),
    pending: (_store.pending || []).slice(-50),
    recentAlerts: (_store.alerts || []).slice(-50),
    hourlyCount: hourlyCount(),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

// export functions (named exports)
export {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState,
  evaluateSymbolCandidate as evaluateSymbolCandidate, // exported for debugging
  processPending as processPending // exported for manual trigger
};