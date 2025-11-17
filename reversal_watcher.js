// reversal_watcher.js — PATcHED v1.0 (ML v8_6 compatible)
// Advanced Pattern+Volume Reversal Watcher with micro-ML + main ML + feedback
//
// Exports:
//   startReversalWatcher(symbol, opts, sendAlert)
//   stopReversalWatcher()
//   getWatcherState()
//
// Dependencies: ./utils.js (fetchMultiTF), ./ml_module_v8_6.js (runMicroPrediction, runMLPrediction, recordPrediction, recordOutcome, calculateAccuracy)

import fs from "fs";
import path from "path";

import { fetchMultiTF } from "./utils.js";
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -------------------- Persistence --------------------
const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const STORE_FILE = path.join(CACHE_DIR, "reversal_watcher_store.json");

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
    return true;
  } catch (e) {
    return false;
  }
}

// -------------------- Defaults --------------------
const DEFAULTS = {
  pollIntervalMs: 20 * 1000,         // main loop
  tfs: ["1m", "5m", "15m"],          // ordered from fastest to slowest
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  requireSupportCount: 2,            // TF count that must support reversal
  minScorePct: 55,                   // minimum combined score to create pending
  volumeRVolThreshold: 0.9,          // relative vol threshold (if <, lowers score)
  microLookbackSec: 60,              // micro ml lookback in seconds (used only to fetch micro features)
  microAlert: true,                  // allow micro-ML immediate alerts (lightweight)
  microAlertProbThresh: 75,          // micro-ML prob percent threshold to consider immediate micro-alert
  confirmWindowMs: 2 * 60 * 1000,    // pending expires after this
  confirmByNextCandle: true,         // require small TF's next candle direction as optional confirmation
  maxPendingPerSymbol: 3,
  globalRateLimitSec: 8,             // global minimal secs between sending messages
  perSymbolCooldownSec: 30,          // cooldown per symbol after confirmed
  maxAlertsBurst: 3,                 // burst limiter
  enableML: true,                    // whether to run main ML (async)
  mlMainGateMinProb: 20,             // don't aggressively block — only strong contradictions below this (0..100)
  debounceSimilarZonePct: 0.005,     // 0.5% same-zone dedupe
  feedbackWindowsSec: [60, 300],     // check outcomes after these seconds
  spamWindowSec: 60
};

// -------------------- Internal store --------------------
let STORE = safeLoad(STORE_FILE, { pending: [], recent: [], hourly: [] });
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

function persistState() { safeSave(STORE_FILE, STORE); }

// -------------------- Internal runtime state --------------------
let _opts = null;
let _sendFunc = null;
let _timer = null;
let _running = false;
let _pendingMap = new Map(); // id -> pending obj
let _lastSentAt = 0;
let _lastSentPerSymbol = new Map();
let _burstCount = 0;

// -------------------- Utils --------------------
const nowTs = () => Date.now();
const uid = (prefix = "p") => `${prefix}_${Date.now()}_${Math.floor(Math.random()*9000)}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// candle helpers
function last(c) { return Array.isArray(c) && c.length ? c.at(-1) : null; }
function avgVol(candles, n = 20) {
  const arr = (candles || []).slice(-n);
  if (!arr.length) return 1;
  const s = arr.reduce((acc, c) => acc + (c.vol ?? c.volume ?? 0), 0);
  return s / arr.length;
}

// -------------------- Pattern detection --------------------
function isBullishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return prev.close < prev.open && cur.close > cur.open && cur.open < prev.close && cur.close > prev.open;
}
function isBearishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return prev.close > prev.open && cur.close < cur.open && cur.open > prev.close && cur.close < prev.open;
}
function isHammer(c) {
  if (!c) return false;
  const body = Math.abs(c.close - c.open) || 1;
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return lower > body * 1.6 && upper < body * 0.6 && c.close > c.open;
}
function isShootingStar(c) {
  if (!c) return false;
  const body = Math.abs(c.close - c.open) || 1;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper > body * 1.6 && lower < body * 0.6 && c.close < c.open;
}
function isTweezerTop(a,b) {
  if (!a || !b) return false;
  return Math.abs(a.high - b.high) / Math.max(1, Math.min(a.high, b.high)) < 0.002 && a.close < a.open && b.close < b.open;
}
function isTweezerBottom(a,b) {
  if (!a || !b) return false;
  return Math.abs(a.low - b.low) / Math.max(1, Math.min(a.low, b.low)) < 0.002 && a.close > a.open && b.close > b.open;
}

// detect patterns for a TF (returns detection obj or null)
function detectPatternsForTF(candles) {
  try {
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const cur = candles.at(-1);
    const prev = candles.at(-2);

    if (isBullishEngulfing(prev, cur)) {
      return { side: "bull", pattern: "BullishEngulfing", score: 80, zone: { low: Math.min(prev.low, cur.low), high: Math.max(prev.high, cur.high) } };
    }
    if (isBearishEngulfing(prev, cur)) {
      return { side: "bear", pattern: "BearishEngulfing", score: 80, zone: { low: Math.min(prev.low, cur.low), high: Math.max(prev.high, cur.high) } };
    }
    if (isHammer(cur)) {
      return { side: "bull", pattern: "Hammer", score: 66, zone: { low: cur.low, high: cur.high } };
    }
    if (isShootingStar(cur)) {
      return { side: "bear", pattern: "ShootingStar", score: 66, zone: { low: cur.low, high: cur.high } };
    }
    // tweezer across last two
    if (isTweezerBottom(prev, cur)) {
      return { side: "bull", pattern: "TweezerBottom", score: 64, zone: { low: Math.min(prev.low, cur.low), high: Math.max(prev.high, cur.high) } };
    }
    if (isTweezerTop(prev, cur)) {
      return { side: "bear", pattern: "TweezerTop", score: 64, zone: { low: Math.min(prev.low, cur.low), high: Math.max(prev.high, cur.high) } };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// -------------------- Aggregation --------------------
function aggregateDetections(dets, weights) {
  // dets: { tf: detection | null }
  const support = { bull: 0, bear: 0 };
  let scoreSum = 0;
  let weightSum = 0;
  let zone = { low: Infinity, high: -Infinity };
  const supportingTFs = [];

  for (const tf of Object.keys(weights)) {
    const d = dets[tf];
    const w = weights[tf] ?? 1;
    if (!d) { weightSum += w; continue; }
    scoreSum += (d.score || 0) * w;
    weightSum += w;
    if (d.side === "bull") support.bull++;
    if (d.side === "bear") support.bear++;
    supportingTFs.push(`${tf}:${d.pattern}`);
    if (d.zone) {
      zone.low = Math.min(zone.low, d.zone.low ?? Infinity);
      zone.high = Math.max(zone.high, d.zone.high ?? -Infinity);
    }
  }

  const avgScore = weightSum ? Math.round(scoreSum / weightSum) : 0;
  const side = support.bull >= support.bear && support.bull > 0 ? "bull" : (support.bear > support.bull ? "bear" : null);
  const supportCount = Math.max(support.bull, support.bear);
  if (zone.low === Infinity) zone = null;
  return { side, supportCount, avgScore, supportingTFs, zone };
}

// -------------------- Rate limiting --------------------
function allowSendFor(symbol) {
  const now = nowTs();
  if (now - _lastSentAt < (_opts.globalRateLimitSec * 1000)) return false;
  const lastSym = _lastSentPerSymbol.get(symbol) || 0;
  if (now - lastSym < (_opts.perSymbolCooldownSec * 1000)) return false;
  if (_burstCount >= _opts.maxAlertsBurst) return false;
  return true;
}
function noteSent(symbol) {
  const t = nowTs();
  _lastSentAt = t;
  _lastSentPerSymbol.set(symbol, t);
  _burstCount++;
  // decay burst slowly
  setTimeout(() => { _burstCount = Math.max(0, _burstCount - 1); }, Math.max(1000, _opts.spamWindowSec * 1000));
  // also keep recent log persisted
  STORE.recent = (STORE.recent || []).slice(-_opts.maxPendingPerSymbol*10);
  STORE.recent.push({ symbol, ts: t });
  persistState();
}

// -------------------- Pending management --------------------
function persistPendingMapToStore() {
  STORE.pending = Array.from(_pendingMap.values()).map(x => {
    const clone = Object.assign({}, x);
    // remove large functions/refs
    delete clone._internal;
    return clone;
  });
  persistState();
}

function restorePendingFromStore() {
  try {
    const raw = STORE.pending || [];
    for (const r of raw) {
      // basic validation
      if (r && r.id) _pendingMap.set(r.id, r);
    }
  } catch {}
}

// -------------------- Create pending --------------------
async function createPending(symbol, side, zone, supportingTFs, score, dets, price, microMl) {
  const id = uid("pend");
  const rec = {
    id,
    symbol,
    side,
    zone,
    supportingTFs,
    createdAt: nowTs(),
    score,
    dets,
    priceAtPending: price,
    state: "pending",
    microMl: microMl || null,
    mlMain: null,
    sent: false,
    mlPredictionId: null
  };

  // record to ML store (weak record) - asynchronous but we await to store id
  if (_opts.enableML) {
    try {
      const pRec = {
        symbol,
        predictedAt: new Date().toISOString(),
        label: side === "bull" ? "Bullish" : "Bearish",
        prob: microMl?.prob ?? null,
        features: microMl?.features ?? null
      };
      const rid = await recordPrediction(pRec).catch(()=>null);
      rec.mlPredictionId = rid;
    } catch {}
  }

  _pendingMap.set(id, rec);
  persistPendingMapToStore();
  return rec;
}

// -------------------- Confirmation rules --------------------
async function tryConfirmPending(rec) {
  try {
    if (!rec || rec.state !== "pending") return false;
    const now = nowTs();
    if (now - rec.createdAt > _opts.confirmWindowMs) {
      // expire
      rec.state = "expired";
      _pendingMap.set(rec.id, rec);
      persistPendingMapToStore();
      return false;
    }

    // fetch fresh multi TFs (smallest tf first)
    const multi = await fetchMultiTF(rec.symbol, _opts.tfs);
    const price = multi[_opts.tfs[0]]?.price ?? Object.values(multi).find(x=>x.price)?.price ?? 0;

    // 1) price crossing zone edge
    const margin = 0.0006; // ~0.06%
    if (rec.side === "bull") {
      if (rec.zone && typeof rec.zone.high === "number" && price > rec.zone.high * (1 + margin)) {
        rec.state = "confirmed"; rec.confirmedAt = now; rec.confirmedPrice = price;
        _pendingMap.set(rec.id, rec);
        persistPendingMapToStore();
        return true;
      }
    } else { // bear
      if (rec.zone && typeof rec.zone.low === "number" && price < rec.zone.low * (1 - margin)) {
        rec.state = "confirmed"; rec.confirmedAt = now; rec.confirmedPrice = price;
        _pendingMap.set(rec.id, rec);
        persistPendingMapToStore();
        return true;
      }
    }

    // 2) next candle direction on smallest TF (optional)
    if (_opts.confirmByNextCandle) {
      const smallTF = _opts.tfs[0];
      const candles = (multi[smallTF] && multi[smallTF].data) ? multi[smallTF].data : [];
      if (candles.length >= 2) {
        const lastC = candles.at(-1), prev = candles.at(-2);
        if (rec.side === "bull" && lastC.close > lastC.open && lastC.close > prev.close) {
          rec.state = "confirmed"; rec.confirmedAt = now; rec.confirmedPrice = lastC.close;
          _pendingMap.set(rec.id, rec);
          persistPendingMapToStore();
          return true;
        }
        if (rec.side === "bear" && lastC.close < lastC.open && lastC.close < prev.close) {
          rec.state = "confirmed"; rec.confirmedAt = now; rec.confirmedPrice = lastC.close;
          _pendingMap.set(rec.id, rec);
          persistPendingMapToStore();
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.warn("tryConfirmPending err:", e);
    return false;
  }
}

// -------------------- Format message --------------------
function formatConfirmedMessage(rec) {
  const sideLabel = rec.side === "bull" ? "Bullish" : "Bearish";
  const micro = rec.microMl ? `\nMicroML: ${rec.microMl.label} ${rec.microMl.prob ? `(${Number(rec.microMl.prob).toFixed(1)}%)` : ""}` : "";
  const mlMain = rec.mlMain ? `\nML(15m): ${rec.mlMain.label} ${rec.mlMain.prob ? `(${Number(rec.mlMain.prob).toFixed(1)}%)` : ""}` : "";
  return [
    `🟢 REVERSAL CONFIRMED — ${sideLabel}`,
    `Symbol: ${rec.symbol}`,
    `EntryPrice: ${Number(rec.confirmedPrice || rec.priceAtPending).toFixed(2)}`,
    `Score: ${rec.score}%`,
    `Pattern support: ${ (rec.supportingTFs || []).join(", ") }`,
    `Zone: ${ rec.zone ? `${Number(rec.zone.low).toFixed(4)} - ${Number(rec.zone.high).toFixed(4)}` : "n/a" }`,
    micro ? micro : "",
    mlMain ? mlMain : "",
    `ID: ${rec.id}`
  ].filter(Boolean).join("\n");
}

// -------------------- Main scan loop --------------------
async function scanOnce(symbol) {
  try {
    // fetch multi TFs
    const multi = await fetchMultiTF(symbol, _opts.tfs);
    // detect per TF
    const dets = {};
    for (const tf of _opts.tfs) {
      const candles = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
      dets[tf] = detectPatternsForTF(candles);
    }

    const agg = aggregateDetections(dets, _opts.weights);

    // If no aggregate side, still check pendings for confirmation
    if (!agg.side || agg.supportCount < 1) {
      await checkAllPendings(symbol);
      return;
    }

    // adjust per-TF score based on volume
    for (const tf of _opts.tfs) {
      const d = dets[tf];
      if (!d) continue;
      const candles = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
      const lc = last(candles);
      const avg = avgVol(candles, 20);
      const rvol = (lc?.vol ?? lc?.volume ?? 0) / Math.max(1, avg);
      if (rvol < _opts.volumeRVolThreshold) {
        // penalize score if volume is low
        d.score = Math.max(20, (d.score || 0) - 18);
      } else {
        // small boost if volume spike
        if (rvol > 1.5) d.score = Math.min(95, (d.score || 0) + 8);
      }
    }

    const combinedScore = agg.avgScore || 50;

    // require minimum support and score
    if (agg.supportCount >= _opts.requireSupportCount && combinedScore >= _opts.minScorePct) {
      // micro-ML (fast) optional
      let microMl = null;
      if (_opts.microAlert || _opts.enableML) {
        try {
          microMl = await runMicroPrediction(symbol, _opts.microLookbackSec).catch(()=>null);
        } catch {}
      }

      // micro-immediate alert logic (lightweight) — only if configured and microMl strongly confident
      if (_opts.microAlert && microMl && typeof microMl.prob === "number" && microMl.prob >= _opts.microAlertProbThresh) {
        // send a micro alert but as a softer message to avoid spam; we still create pending and wait for confirmation
        const microMsg = [
          `⚡ MICRO-ML SIGNAL — ${microMl.label} (${Number(microMl.prob).toFixed(1)}%)`,
          `Symbol: ${symbol} | Patterns: ${agg.supportingTFs.join(", ")}`,
          `CombinedScore: ${combinedScore}% | zone: ${agg.zone ? `${agg.zone.low.toFixed(4)}-${agg.zone.high.toFixed(4)}` : "n/a"}`,
          `Note: This is a micro/fast signal. Waiting for confirmation before full alert.`
        ].join("\n");

        // rate-limited (micro alerts constrained by global limiter too)
        if (allowSendFor(symbol)) {
          try { await _sendFunc(microMsg); noteSent(symbol); } catch(e){ /* ignore */ }
        }
      }

      // Re-check pending count for symbol
      const existingPendingForSymbol = Array.from(_pendingMap.values()).filter(p => p.symbol === symbol && p.state === "pending").length;
      if (existingPendingForSymbol >= _opts.maxPendingPerSymbol) {
        await checkAllPendings(symbol);
        return;
      }

      // dedupe: avoid creating pending in same zone
      const zone = agg.zone || { low: 0, high: 0 };
      const existsSimilar = Array.from(_pendingMap.values()).some(p => {
        if (!p || p.symbol !== symbol || p.side !== agg.side || p.state !== "pending") return false;
        if (!p.zone || !zone) return false;
        const midA = (p.zone.low + p.zone.high) / 2;
        const midB = (zone.low + zone.high) / 2;
        return Math.abs(midA - midB) / Math.max(1, Math.abs(midB)) < _opts.debounceSimilarZonePct;
      });
      if (existsSimilar) {
        await checkAllPendings(symbol);
        return;
      }

      // create pending and optionally run main ML async to adjust score
      const priceNow = multi[_opts.tfs[0]]?.price ?? 0;
      const pending = await createPending(symbol, agg.side, zone, agg.supportingTFs, combinedScore, dets, priceNow, microMl);
      // async: run main ML (longer) to adjust final pending score (non-blocking)
      if (_opts.enableML) {
        (async () => {
          try {
            const fullMl = await runMLPrediction(symbol, _opts.tfs[_opts.tfs.length-1]).catch(()=>null);
            if (fullMl) {
              // attach main ML to pending
              const p = _pendingMap.get(pending.id);
              if (!p) return;
              p.mlMain = fullMl;
              // adjust pending.score modestly
              const mlProb = (p.side === "bull") ? fullMl.probBull : fullMl.probBear;
              if (typeof mlProb === "number") {
                const boost = Math.round((mlProb - 50) * 0.4); // scale down
                p.score = clamp(Math.round((p.score || 0) + boost), 1, 100);
                _pendingMap.set(p.id, p);
                persistPendingMapToStore();
              }
            }
          } catch (e) {}
        })();
      }
    }
    // finally check pendings for confirmation
    await checkAllPendings(symbol);
  } catch (e) {
    console.warn("scanOnce error:", e?.message ?? e);
  }
}

// -------------------- Check & confirm all pendings --------------------
async function checkAllPendings(symbol = null) {
  const pendings = Array.from(_pendingMap.values()).filter(p => p.state === "pending" && (!symbol || p.symbol === symbol));
  for (const p of pendings) {
    try {
      const confirmed = await tryConfirmPending(p);
      if (confirmed) {
        // gate with ML main contradiction: if mlMain exists and strongly opposite, optionally skip sending
        if (p.mlMain && typeof p.mlMain.prob === "number") {
          const mlProb = p.side === "bull" ? (p.mlMain.probBull ?? 50) : (p.mlMain.probBear ?? 50);
          // if mlMain strongly contradictory (e.g., prob for opposite > 80), block send (conservative)
          const oppositeProb = p.side === "bull" ? (p.mlMain.probBear ?? 0) : (p.mlMain.probBull ?? 0);
          if (oppositeProb > 90) {
            p.state = "blocked_by_ml";
            _pendingMap.set(p.id, p);
            persistPendingMapToStore();
            continue;
          }
        }

        // send confirmation message (rate-limited)
        if (allowSendFor(p.symbol)) {
          const msg = formatConfirmedMessage(p);
          try {
            await _sendFunc(msg);
            noteSent(p.symbol);
          } catch (e) {
            // if send fails, still mark as confirmed but not sent
            console.warn("sendFunc error:", e?.message ?? e);
          }
        } else {
          console.log("reversal_watcher: rate-limited, not sending confirmed:", p.id);
        }
        // mark sent / confirmed
        p.sent = true;
        p.state = "confirmed";
        p.confirmedAt = nowTs();
        _pendingMap.set(p.id, p);
        persistPendingMapToStore();

        // schedule feedback checks to call recordOutcome
        (async (pendingRec) => {
          for (const win of _opts.feedbackWindowsSec || []) {
            await new Promise(r => setTimeout(r, win * 1000));
            try {
              // fetch latest price on smallest tf
              const multi = await fetchMultiTF(pendingRec.symbol, [_opts.tfs[0]]);
              const priceNow = multi[_opts.tfs[0]]?.price ?? 0;
              const entryPrice = pendingRec.confirmedPrice || pendingRec.priceAtPending || 0;
              const realizedReturn = pendingRec.side === "bull"
                ? (priceNow - entryPrice) / Math.max(1, entryPrice)
                : (entryPrice - priceNow) / Math.max(1, entryPrice);
              // record outcome to ML store (if we had mlPredictionId)
              if (pendingRec.mlPredictionId) {
                await recordOutcome(pendingRec.mlPredictionId, { realizedReturn, correct: realizedReturn > 0 }).catch(()=>null);
              }
              // optionally store realized in pending
              pendingRec.outcome = pendingRec.outcome || {};
              pendingRec.outcome[win] = { priceNow, realizedReturn, ts: nowTs() };
              _pendingMap.set(pendingRec.id, pendingRec);
              persistPendingMapToStore();
            } catch (e) { /* ignore feedback errors */ }
          }
        })(p);
      }
    } catch (e) {
      console.warn("checkAllPendings inner err:", e);
    }
  }
}

// -------------------- Public API --------------------
export function startReversalWatcher(symbol = "BTCUSDT", opts = {}, sendFunc = async (m)=>{ console.log("send:", m); }) {
  if (_running) {
    console.log("reversal_watcher: already running");
    return false;
  }
  _opts = Object.assign({}, DEFAULTS, opts || {});
  _sendFunc = sendFunc;
  _running = true;
  _pendingMap = new Map();
  restorePendingFromStore(); // restore persisted pending if any

  // initial immediate scan
  (async () => { try { await scanOnce(symbol); } catch (e) { console.warn(e); } })();

  // interval loop
  _timer = setInterval(async () => {
    try {
      await scanOnce(symbol);
    } catch (e) {
      console.warn("reversal_watcher interval error:", e);
    }
  }, _opts.pollIntervalMs);

  console.log("reversal_watcher: started for", symbol, "opts:", JSON.stringify(_opts));
  return true;
}

export async function stopReversalWatcher() {
  if (!_running) return false;
  try {
    clearInterval(_timer);
  } catch (e) {}
  _timer = null;
  _running = false;
  _pendingMap.clear();
  console.log("reversal_watcher: stopped");
  return true;
}

export function getWatcherState() {
  return {
    running: _running,
    pending: Array.from(_pendingMap.values()),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0, samples: 0 },
    lastSentAt: _lastSentAt
  };
}

export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState
};