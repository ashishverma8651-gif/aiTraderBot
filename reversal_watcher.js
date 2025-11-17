// reversal_watcher.js
// Advanced Pattern+Volume Reversal Watcher with ML feedback
// Exported API: startReversalWatcher(symbol, opts, sendFunc) and stopReversalWatcher()

import { fetchMultiTF } from "./utils.js";
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

const DEFAULTS = {
  pollIntervalMs: 20 * 1000,
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  requireSupportCount: 2,          // how many TFs must agree
  minScorePct: 50,                 // combined score minimum to create pending
  volumeRVolThreshold: 1.2,        // last volume >= avg * this
  microLookback: 60,               // seconds for micro ML
  confirmWindowMs: 90 * 1000,      // time window to confirm pending (e.g., 90s)
  confirmByNextCandle: true,       // require next candle in same direction to confirm
  maxPendingPerSymbol: 4,
  globalRateLimitSec: 6,           // global minimal secs between messages
  perSymbolCooldownSec: 30,        // per symbol cooldown after confirmed
  maxAlertsBurst: 3,               // safety
  enableML: true,
  spamWindowSec: 60
};

// internal state
let _running = false;
let _timer = null;
let _pending = new Map(); // pendingId -> {symbol, side, createdAt, supportTFs, zone, details, mlPredId?}
let _lastSentAt = 0;
let _lastSentPerSymbol = new Map(); // symbol -> ts
let _alertsBurstCount = 0;
let _opts = null;
let _sendFunc = null;

// util helpers
const nowTs = () => Date.now();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function uid(prefix = "pend") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random()*9000)}`;
}

// Candle helpers
function last(candles) { return (candles && candles.length) ? candles.at(-1) : null; }
function avgVolume(candles, n = 20) {
  const arr = (candles || []).slice(-n);
  if (!arr.length) return 1;
  const s = arr.reduce((acc, c) => acc + (c.vol || c.volume || 0), 0);
  return s / arr.length;
}

// Simple pattern detectors (work on candle objects {open,high,low,close,vol})
function isBullishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return (prev.close < prev.open) && (cur.close > cur.open) && (cur.open < prev.close) && (cur.close > prev.open);
}
function isBearishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return (prev.close > prev.open) && (cur.close < cur.open) && (cur.open > prev.close) && (cur.close < prev.open);
}
function isHammer(c) {
  if (!c) return false;
  const body = Math.abs(c.close - c.open);
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return lower > (body * 1.5) && upper < (body * 0.6);
}
function isInvertedHammer(c) {
  if (!c) return false;
  const body = Math.abs(c.close - c.open);
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  return upper > (body * 1.5) && lower < (body * 0.6);
}
function isShootingStar(c) {
  if (!c) return false;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper > (body * 1.6) && lower < (body * 0.6) && (c.close < c.open);
}
// basic tweezer detection (top/bottom) for last two candles
function isTweezerTop(c1, c2) {
  if (!c1 || !c2) return false;
  return (Math.abs(c1.high - c2.high) / Math.max(1, Math.min(c1.high, c2.high)) < 0.002) &&
         (c1.close < c1.open) && (c2.close < c2.open);
}
function isTweezerBottom(c1, c2) {
  if (!c1 || !c2) return false;
  return (Math.abs(c1.low - c2.low) / Math.max(1, Math.min(c1.low, c2.low)) < 0.002) &&
         (c1.close > c1.open) && (c2.close > c2.open);
}

// combine pattern detection for a candle series
function detectPatternsForTF(candles) {
  // returns side: "bull" | "bear" | null, patternName, score (0..100), zone{low,high}
  try {
    const n = candles.length;
    if (n < 2) return null;
    const lastC = candles.at(-1);
    const prev = candles.at(-2);
    // Engulfings
    if (isBullishEngulfing(prev, lastC)) {
      return { side: "bull", pattern: "BullishEngulfing", score: 80, zone: { low: Math.min(prev.low, lastC.low), high: Math.max(prev.high, lastC.high) } };
    }
    if (isBearishEngulfing(prev, lastC)) {
      return { side: "bear", pattern: "BearishEngulfing", score: 80, zone: { low: Math.min(prev.low, lastC.low), high: Math.max(prev.high, lastC.high) } };
    }
    // Hammers & inverted
    if (isHammer(lastC)) {
      return { side: "bull", pattern: "Hammer", score: 65, zone: { low: lastC.low, high: lastC.high } };
    }
    if (isInvertedHammer(lastC) || isShootingStar(lastC)) {
      // inverted hammer when green -> bullish; when red -> cautious. shooting star => bearish
      const p = isShootingStar(lastC) ? "ShootingStar" : "InvertedHammer";
      const side = isShootingStar(lastC) ? "bear" : "bull";
      return { side, pattern: p, score: 60, zone: { low: lastC.low, high: lastC.high } };
    }
    // Tweezer
    if (candles.length >= 2) {
      const c1 = candles.at(-2), c2 = candles.at(-1);
      if (isTweezerBottom(c1, c2)) return { side: "bull", pattern: "TweezerBottom", score: 65, zone: { low: Math.min(c1.low, c2.low), high: Math.max(c1.high, c2.high)} };
      if (isTweezerTop(c1, c2)) return { side: "bear", pattern: "TweezerTop", score: 65, zone: { low: Math.min(c1.low, c2.low), high: Math.max(c1.high, c2.high)} };
    }
    return null;
  } catch (e) {
    console.warn("pattern detect error:", e);
    return null;
  }
}

// combine multi-TF detections
function aggregateDetections(dets, weights) {
  // dets: { tf: {side, pattern, score, zone} }
  let support = { bull: 0, bear: 0 };
  let scoreSum = 0;
  let maxZone = { low: Infinity, high: -Infinity };
  const supportingTFs = [];
  for (const tf of Object.keys(dets)) {
    const d = dets[tf];
    if (!d) continue;
    const w = weights[tf] || 1;
    scoreSum += (d.score || 0) * w;
    if (d.side === "bull") { support.bull += 1; supportingTFs.push(`${tf}:${d.pattern}`); }
    if (d.side === "bear") { support.bear += 1; supportingTFs.push(`${tf}:${d.pattern}`); }
    if (d.zone) {
      maxZone.low = Math.min(maxZone.low, d.zone.low || Infinity);
      maxZone.high = Math.max(maxZone.high, d.zone.high || -Infinity);
    }
  }
  const avgScore = Object.keys(weights).length ? Math.round(scoreSum / Object.keys(weights).length) : Math.round(scoreSum);
  let side = null;
  if (support.bull >= support.bear && support.bull >= 1) side = "bull";
  if (support.bear > support.bull && support.bear >= 1) side = "bear";
  return { side, supportCount: Math.max(support.bull, support.bear), supportingTFs, avgScore, zone: (maxZone.low === Infinity ? null : maxZone) };
}

function formatZone(zone) {
  if (!zone) return "n/a";
  return `${Number(zone.low).toFixed(2)} - ${Number(zone.high).toFixed(2)}`;
}

// rate limiter: global + per symbol
function allowSend(symbol) {
  const now = nowTs();
  if (now - _lastSentAt < (_opts.globalRateLimitSec * 1000)) return false;
  const lastSym = _lastSentPerSymbol.get(symbol) || 0;
  if (now - lastSym < (_opts.perSymbolCooldownSec * 1000)) return false;
  // burst limiter
  if (_alertsBurstCount >= _opts.maxAlertsBurst) return false;
  return true;
}
function noteSent(symbol) {
  _lastSentAt = nowTs();
  _lastSentPerSymbol.set(symbol, _lastSentAt);
  _alertsBurstCount++;
  // decay burst count slowly
  setTimeout(() => { _alertsBurstCount = Math.max(0, _alertsBurstCount - 1); }, Math.max(1000, _opts.spamWindowSec * 1000));
}

// create pending object
async function createPending(symbol, side, zone, supportingTFs, score, details, price, microMl) {
  const pid = uid("pend");
  const createdAt = nowTs();
  const rec = {
    id: pid,
    symbol,
    side,
    zone,
    supportingTFs,
    createdAt,
    score,
    details,
    state: "pending",
    priceAtPending: price,
    microMl
  };
  _pending.set(pid, rec);
  // persist ML record
  if (_opts.enableML) {
    try {
      const predRec = {
        id: null,
        symbol,
        label: side === "bull" ? "Bullish" : "Bearish",
        prob: (microMl && microMl.prob) ? microMl.prob : null,
        predictedAt: new Date().toISOString(),
        features: microMl?.features || null
      };
      const rid = await recordPrediction(predRec).catch(()=>null);
      rec.mlPredictionId = rid;
    } catch(e){}
  }
  return rec;
}

// confirm pending by either price action or next-candle rule
async function tryConfirmPending(pending) {
  try {
    const now = nowTs();
    if (!pending) return false;
    // time window exceeded?
    if (now - pending.createdAt > _opts.confirmWindowMs) {
      // expire pending
      pending.state = "expired";
      _pending.set(pending.id, pending);
      return false;
    }
    // fetch latest multiTF (1m/5m/15m)
    const multi = await fetchMultiTF(pending.symbol, _opts.tfs);
    const price = multi[_opts.tfs[0]]?.price || Object.values(multi).find(x=>x.price)?.price || 0;
    // confirmation rule: if price has moved beyond zone edge in the pattern direction by small margin
    const marginPct = 0.0005; // 0.05% tolerance
    if (pending.side === "bull") {
      // price must rise above zone.high by margin OR next candle bullish (if requireNextCandle)
      if (price > (pending.zone.high * (1 + marginPct))) {
        pending.state = "confirmed"; pending.confirmedAt = now; pending.confirmedPrice = price;
        _pending.set(pending.id, pending);
        return true;
      }
    } else {
      if (price < (pending.zone.low * (1 - marginPct))) {
        pending.state = "confirmed"; pending.confirmedAt = now; pending.confirmedPrice = price;
        _pending.set(pending.id, pending);
        return true;
      }
    }
    // optionally require next candle direction: check latest candle in smallest TF
    if (_opts.confirmByNextCandle) {
      const smallTF = _opts.tfs[0]; // assume fastest tf first
      const candles = (multi[smallTF] && multi[smallTF].data) ? multi[smallTF].data : [];
      if (candles.length >= 2) {
        const lastC = candles.at(-1);
        const prev = candles.at(-2);
        if (pending.side === "bull" && lastC.close > lastC.open && lastC.close > prev.close) {
          pending.state = "confirmed"; pending.confirmedAt = now; pending.confirmedPrice = lastC.close;
          _pending.set(pending.id, pending);
          return true;
        }
        if (pending.side === "bear" && lastC.close < lastC.open && lastC.close < prev.close) {
          pending.state = "confirmed"; pending.confirmedAt = now; pending.confirmedPrice = lastC.close;
          _pending.set(pending.id, pending);
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

// formatting message for confirmed reversal
function formatConfirmedMessage(pending) {
  const sideLabel = pending.side === "bull" ? "Bullish" : "Bearish";
  const tp = ""; // TP logic can be added later
  let microText = "";
  if (pending.microMl) {
    microText = `\nMicroML: ${pending.microMl.label} ${pending.microMl.prob ? `(${Number(pending.microMl.prob).toFixed(1)}%)` : ""}`;
  }
  const support = pending.supportingTFs ? pending.supportingTFs.join(", ") : "";
  return [
    `🟢 REVERSAL CONFIRMED — ${sideLabel}`,
    `Symbol: ${pending.symbol} | Entry Price: ${Number(pending.confirmedPrice||pending.priceAtPending).toFixed(2)}`,
    `Score: ${pending.score}%`,
    microText ? microText : "",
    `Pattern supports: ${support}`,
    `Zone: ${formatZone(pending.zone)}`,
    `ID: ${pending.id}`
  ].filter(Boolean).join("\n");
}

// Main scan loop
async function scanOnce(symbol) {
  try {
    // fetch all TFs
    const multi = await fetchMultiTF(symbol, _opts.tfs);
    // detect patterns per TF
    const dets = {};
    for (const tf of _opts.tfs) {
      const candles = (multi[tf] && multi[tf].data) ? multi[tf].data : [];
      dets[tf] = detectPatternsForTF(candles);
    }
    // aggregate
    const agg = aggregateDetections(dets, _opts.weights);
    if (!agg.side || agg.supportCount < 1) {
      // still might be pending waiting for confirm -> check pending
      await checkPendings(symbol);
      return;
    }

    // volume check on each supporting TF
    let volOk = true;
    for (const tf of _opts.tfs) {
      const d = dets[tf];
      if (!d) continue;
      // check vol for that tf's last candle
      const candles = (multi[tf] && multi[tf].data) ? multi[tf].data : [];
      const lc = last(candles);
      const avg = avgVolume(candles, 20);
      if (!lc) { volOk = false; continue; }
      const rvol = (lc.vol || lc.volume || lc.v || 0) / Math.max(1, avg);
      if (rvol < _opts.volumeRVolThreshold) {
        // reduce score if vol not confirming
        d.score = Math.max(20, (d.score || 0) - 20);
      }
    }

    const combinedScore = agg.avgScore || 50;
    // require support count and combined score
    if (agg.supportCount >= _opts.requireSupportCount && combinedScore >= _opts.minScorePct) {
      // calculate micro ML (fast)
      let microMl = null;
      if (_opts.enableML) {
        try { microMl = await runMicroPrediction(symbol, _opts.microLookback/1).catch(()=>null); } catch(e){}
      }

      // final combined scoring: ML boosts score
      let finalScore = combinedScore;
      if (microMl && microMl.prob) {
        // microMl.prob in percent e.g. 34. -> boost
        const mlBoost = Math.max(-20, Math.min(40, (microMl.prob - 50) * 0.4)); // scale
        finalScore = Math.round(finalScore + mlBoost);
      }

      // check pending limits
      const pendingCountForSymbol = Array.from(_pending.values()).filter(p => p.symbol === symbol && p.state === "pending").length;
      if (pendingCountForSymbol >= _opts.maxPendingPerSymbol) {
        console.log("max pending reached for", symbol);
        await checkPendings(symbol);
        return;
      }

      // create pending if not already similar one exists (avoid duplicates)
      const zone = agg.zone || { low: 0, high: 0 };
      const existsSimilar = Array.from(_pending.values()).some(p => p.symbol === symbol && p.side === agg.side && p.state === "pending" && Math.abs((p.zone.low + p.zone.high)/2 - (zone.low + zone.high)/2) / Math.max(1, zone.high) < 0.005);
      if (existsSimilar) {
        await checkPendings(symbol);
        return;
      }

      // create pending
      const currentPrice = multi[_opts.tfs[0]]?.price || 0;
      const pending = await createPending(symbol, agg.side, zone, agg.supportingTFs, finalScore, { dets }, currentPrice, microMl);
      console.log("created pending", pending.id, pending.side, pending.score, "zone", formatZone(pending.zone));

      // After creating pending, run deeper ML prediction async (non-block)
      if (_opts.enableML) {
        (async () => {
          try {
            const full = await runMLPrediction(symbol, _opts.tfs[_opts.tfs.length-1]).catch(()=>null);
            if (full && pending) {
              pending.fullMl = full;
              // adjust pending score
              if (full && typeof full.probBull === "number") {
                const mlScore = (pending.side === "bull") ? full.probBull : full.probBear;
                // scale to [-20..+40]
                const boost = (mlScore - 50) * 0.5;
                pending.score = Math.max(1, Math.min(100, Math.round(pending.score + boost)));
                _pending.set(pending.id, pending);
              }
            }
          } catch(e){}
        })();
      }
    }

    // finally check existing pendings to attempt confirmation
    await checkPendings(symbol);

  } catch (e) {
    console.warn("scanOnce error:", e);
  }
}

// check all pending entries for symbol or globally
async function checkPendings(symbol = null) {
  const pendings = Array.from(_pending.values()).filter(p => p.state === "pending" && (symbol ? p.symbol === symbol : true));
  for (const p of pendings) {
    const confirmed = await tryConfirmPending(p).catch(()=>false);
    if (confirmed) {
      // send only if rate limiter allows
      if (allowSend(p.symbol)) {
        const msg = formatConfirmedMessage(p);
        try {
          await _sendFunc(msg);
          noteSent(p.symbol);
        } catch (e) {
          console.warn("sendFunc error", e);
        }
      } else {
        console.log("rate-limited, not sending confirmed:", p.id);
      }
      // mark pending state and register outcome later via recordOutcome (when realized)
      p.sent = true;
      p.state = "confirmed";
      p.confirmedAt = nowTs();
      _pending.set(p.id, p);

      // schedule outcome recording after some delay (feedback windows)
      // we attempt to record outcome after 60s & 300s windows (if ML wants)
      (async () => {
        // quick wait then compute realizedReturn
        await sleep(60 * 1000);
        try {
          const multi = await fetchMultiTF(p.symbol, [_opts.tfs[0]]);
          const priceNow = multi[_opts.tfs[0]]?.price || 0;
          const realizedReturn = p.side === "bull" ? (priceNow - (p.confirmedPrice || p.priceAtPending))/Math.max(1, (p.confirmedPrice || p.priceAtPending)) : ((p.confirmedPrice || p.priceAtPending) - priceNow)/Math.max(1, (p.confirmedPrice || p.priceAtPending));
          // record outcome
          if (p.mlPredictionId) {
            await recordOutcome(p.mlPredictionId, { realizedReturn, correct: realizedReturn > 0 }).catch(()=>null);
          }
        } catch(e){}
      })();
    }
    // expire old pending after confirmWindowMs handled in tryConfirmPending
  }
}

// Start watcher
export function startReversalWatcher(symbol = "BTCUSDT", opts = {}, sendFunc = async (m)=>{ console.log("send:",m); }) {
  if (_running) {
    console.log("reversal_watcher: already running");
    return;
  }
  _opts = Object.assign({}, DEFAULTS, opts || {});
  _sendFunc = sendFunc;
  _running = true;
  console.log("reversal_watcher: STARTED for", symbol, "cfg:", JSON.stringify(_opts));

  // initial immediate scan
  (async () => {
    try { await scanOnce(symbol); } catch(e) { console.warn(e); }
  })();

  _timer = setInterval(async () => {
    try {
      await scanOnce(symbol);
    } catch (e) {
      console.warn("watcher interval err:", e);
    }
  }, _opts.pollIntervalMs);

  return true;
}

// Stop watcher
export async function stopReversalWatcher() {
  if (!_running) return;
  try {
    clearInterval(_timer);
  } catch(e){}
  _timer = null;
  _running = false;
  _pending.clear();
  console.log("reversal_watcher: STOPPED");
  return true;
}

// Export small helpers (useful for testing)
export default {
  startReversalWatcher,
  stopReversalWatcher
};