// reversal_watcher.js — MAX PRO (drop-in for aiTraderBot.js)
//
// Exports:
//   startReversalWatcher(symbol, opts, onMessage)
//   stopReversalWatcher()
//
// Dependencies expected in your repo:
//   ./utils.js  -> fetchMultiTF(symbol, tfs), fetchMarketData (optional)
//   ./ml_module_v8_6.js -> runMicroPrediction, runMLPrediction, recordPrediction, recordOutcome, calculateAccuracy
//
// Important: This module *does not* call Telegram directly. It calls the onMessage(msg) callback
// provided by aiTraderBot.js (which will call sendTelegram).
//

import fs from "fs";
import path from "path";

import { fetchMultiTF } from "./utils.js"; // must exist
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// ---------------------------
// Internal state & defaults
// ---------------------------
let _running = false;
let _timer = null;
let _pendingMap = new Map(); // pendingID -> pending object
let _lastAlertAt = 0;
let _globalRateLimitSec = 6; // default throttle between alerts globally
let _lastSentPerSymbol = new Map(); // symbol -> timestamp

let _statusTicker = null;

let _configDefaults = {
  pollIntervalMs: 20 * 1000,
  tfs: ["1m", "5m", "15m"],
  weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
  minAlertConfidence: 55, // percent threshold from combined signals
  microLookback: 60,
  feedbackWindowsSec: [60, 300],
  zonePaddingPct: 0.0025, // small buffer around zone
  requireSupportCount: 2,  // how many TF supports required to confirm
  maxPendingPerSymbol: 3,
  maxAlertsPerMinutePerSymbol: 6,
  rateLimitSec: 6,
  entryZonesEnabled: true,
  instantEntryOnZoneTouch: true, // sends entry alert immediately when price touches zone
  dedupeWindowSec: 6, // avoid duplicate alerts in short window
  spamWindowSec: 60, // per-symbol spam control
  maxAlertsBurst: 4
};

// file store for persistent counters (optional)
const STORE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

function nowMs(){ return Date.now(); }
function nowSec(){ return Math.floor(Date.now()/1000); }

function mkPendingId() {
  return "pend_v3_" + Date.now() + "_" + Math.floor(Math.random()*90000);
}

// ---------------------------
// Utility helpers
// ---------------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function composeTelegramText(obj) {
  // obj: { type: "pending"|"confirmed"|"failed"|"entry", symbol, zone, score, price, ... }
  const emoji = obj.type === "pending" ? "⚡" : obj.type === "confirmed" ? "🟢" : obj.type === "failed" ? "🔴" : "🔔";
  let lines = [];
  if (obj.type === "status") {
    lines.push("⚙️ REV WATCH STATUS — " + obj.symbol);
    lines.push("Time: " + new Date().toLocaleString());
    lines.push("Active pendings: " + (obj.active || 0));
    lines.push("Confirmed (last): " + (obj.confirmed || 0));
    lines.push("GlobalRateLimitSec: " + (obj.rateLimit || 0));
    return lines.join("\n");
  }

  lines.push(`${emoji} ${obj.type === "pending" ? "REVERSAL DETECTED (PENDING) —" : obj.type === "confirmed" ? "REVERSAL CONFIRMED —" : obj.type === "failed" ? "REVERSAL FAILED" : "ENTRY ZONE ALERT"}`);
  lines.push(`Symbol: ${obj.symbol}`);
  if (obj.zone) lines.push(`Zone: ${obj.zone.tf} ${obj.zone.low.toFixed(2)} - ${obj.zone.high.toFixed(2)}`);
  if (typeof obj.score !== "undefined") lines.push(`Score: ${obj.score}% | Price: ${obj.price}`);
  if (obj.topTPs) lines.push(`TPs: ${obj.topTPs.join(" / ")}`);
  if (obj.sls) lines.push(`SLs: ${obj.sls.join(" / ")}`);
  if (obj.micro) lines.push(`MicroML: ${obj.micro.label} ${Math.round(obj.micro.prob*100)/100}%`);
  if (obj.id) lines.push(`PendingID: ${obj.id}`);
  if (obj.note) lines.push(obj.note);
  return lines.join("\n");
}

// simple rate limiter per symbol
function canSendAlert(symbol, cfg) {
  const now = nowSec();
  const last = _lastSentPerSymbol.get(symbol) || 0;
  if (now - last < cfg.dedupeWindowSec) return false;
  _lastSentPerSymbol.set(symbol, now);
  return true;
}

// ---------------------------
// Core: zone detection & scoring
// ---------------------------

/*
Zone design:
- For each timeframe configured we identify candidate reversal zones as the last candle's
  high/low plus padding OR a small range around important pattern levels.
- Then we compute a support score: how many TFs 'agree' (price near extremes, tail size, volume)
- We combine with ML model to compute final score.
*/

function detectZonesFromMulti(multi, cfg) {
  // multi: { "1m": { data:[candles], price }, ... }
  // returns array of { tf, low, high, type('bull'|'bear'), supportScore }
  const out = [];
  for (const tf of cfg.tfs) {
    const block = multi[tf];
    if (!block || !Array.isArray(block.data) || !block.data.length) continue;
    const last = block.data.at(-1);
    // build small zone near candle body/tail depending on bullish/bearish candle
    const bodyLow = Math.min(last.open, last.close);
    const bodyHigh = Math.max(last.open, last.close);
    const tailLow = last.low;
    const tailHigh = last.high;
    const width = Math.max( (bodyHigh - bodyLow) || 1, Math.abs(tailHigh - tailLow) * 0.2 );
    // Two possible zones: bull zone (tail bottom) and bear zone (tail top)
    const pad = Math.max(1, Math.abs(last.close) * cfg.zonePaddingPct);

    // bull zone candidate (if last candle has long lower tail or bullish)
    const bullZone = { tf, low: tailLow - pad, high: bodyLow + pad, type: "bull", support: 0 };
    // bear zone candidate
    const bearZone = { tf, low: bodyHigh - pad, high: tailHigh + pad, type: "bear", support: 0 };

    // compute support heuristics: tail length, volume spike, candle body direction
    const tailDown = bodyLow - tailLow;
    const tailUp = tailHigh - bodyHigh;
    const bodySize = Math.abs(last.close - last.open) || 1;
    const vol = last.volume || last.vol || last.v || 0;
    const avgVol = (block.data.slice(-20).reduce((s,c)=>s+(c.volume||c.vol||c.v||0),0) / Math.max(1, Math.min(20, block.data.length))) || 1;

    // heuristics
    if (tailDown > bodySize * 1.2) bullZone.support += 1.3;
    if (last.close > last.open) bullZone.support += 0.7;
    if (vol > avgVol * 1.5) bullZone.support += 0.8;

    if (tailUp > bodySize * 1.2) bearZone.support += 1.3;
    if (last.close < last.open) bearZone.support += 0.7;
    if (vol > avgVol * 1.5) bearZone.support += 0.8;

    // normalize support roughly
    bullZone.support = Math.round(bullZone.support*10)/10;
    bearZone.support = Math.round(bearZone.support*10)/10;

    out.push(bullZone, bearZone);
  }
  return out;
}

function mergeZones(zones, cfg) {
  // Merge overlapping zones across TFs into candidate zones with votes/support count
  const merged = [];
  for (const z of zones) {
    // attempt to find an existing merged zone (same type) that overlaps
    let found = null;
    for (const m of merged) {
      if (m.type !== z.type) continue;
      // overlap if ranges intersect more than small epsilon
      if (!(z.high < m.low || z.low > m.high)) { found = m; break; }
    }
    if (!found) {
      merged.push({
        low: z.low,
        high: z.high,
        tfs: [z.tf],
        type: z.type,
        support: z.support,
      });
    } else {
      found.low = Math.min(found.low, z.low);
      found.high = Math.max(found.high, z.high);
      if (!found.tfs.includes(z.tf)) found.tfs.push(z.tf);
      found.support = Math.max(found.support, z.support) + (z.support*0.2);
    }
  }
  // finalize score
  for (const m of merged) {
    // normalized support score (1..100)
    const score = clamp(Math.round( ( (m.support || 0) + m.tfs.length*0.8 ) * 12 ), 1, 100);
    m.score = score;
    m.supportCount = m.tfs.length;
  }
  // sort by score desc
  merged.sort((a,b)=>b.score - a.score);
  return merged;
}

// ---------------------------
// Pending lifecycle: validate after N seconds and confirm/failed
// ---------------------------
async function validatePending(pending, cfg, onMessage) {
  // pending: { id, symbol, zone, createdAt, type, score, featureVector etc }
  // validate after a short window (cfg.validateWindowSec)
  try {
    // get latest multi-TF snapshot
    const multi = await fetchMultiTF(pending.symbol, cfg.tfs);
    const price = multi[pending.zone.tf]?.price ?? (multi["1m"]?.price || 0);
    // micro-ML check for quick confirmation
    let micro = {};
    try {
      micro = await runMicroPrediction(pending.symbol, cfg.microLookback);
    } catch(e) { micro = { error: String(e) }; }

    // price must have moved into the expected direction a bit, or touched zone again
    const touched = (price >= pending.zone.low && price <= pending.zone.high);
    const movedInDir = (pending.type === "bear" ? (price < pending.entryPrice) : (price > pending.entryPrice));
    const microConfidence = (micro && typeof micro.prob === "number") ? micro.prob : 0;

    // Compose combined score (weighted)
    const ml = await safeRunMLPrediction(pending.symbol);
    const mlMax = (ml && typeof ml.prob === "number") ? ml.prob : 0;

    const combined = clamp(
      Math.round( (pending.score * 0.6) + (microConfidence * 0.25) + (mlMax * 0.15) ), 0, 100
    );

    // validation rules:
    // - require supportCount >= cfg.requireSupportCount OR micro/ML strong
    // - require combined >= cfg.minAlertConfidence OR zone touched strongly
    const supportOk = (pending.zone.supportCount >= Math.max(1, cfg.requireSupportCount));
    const strongMicro = microConfidence >= 55;
    const strongML = mlMax >= cfg.minAlertConfidence;

    // decide
    if (touched || (supportOk && (combined >= cfg.minAlertConfidence || strongMicro || strongML) && movedInDir)) {
      // CONFIRM
      pending.confirmedAt = nowSec();
      pending.confirmScore = combined;
      pending.micro = micro;
      pending.ml = ml;
      pending.status = "confirmed";
      // store feedback record in ML
      try {
        const predRec = {
          id: pending.mlPredId || null,
          symbol: pending.symbol,
          label: pending.type === "bear" ? "Bearish" : "Bullish",
          score: combined,
          priceAtDetect: pending.entryPrice,
          createdAt: new Date().toISOString()
        };
        // if we didn't record prediction earlier, record now
        if (!pending.mlPredId && typeof recordPrediction === "function") {
          pending.mlPredId = await recordPrediction(predRec);
        }
      } catch(e) { /* ignore ml store errors */ }

      // send confirmation
      const msg = composeTelegramText({
        type: "confirmed",
        symbol: pending.symbol,
        price,
        zone: { tf: pending.zone.tf, low: pending.zone.low, high: pending.zone.high },
        score: combined,
        topTPs: pending.topTPs || [],
        sls: pending.sls || [],
        micro: micro,
        id: pending.id
      });
      await safeSend(onMessage, msg);
      // schedule feedback check later (feedback windows)
      setTimeout(async ()=> await postOutcomeCheck(pending), cfg.feedbackWindowsSec && cfg.feedbackWindowsSec.length ? cfg.feedbackWindowsSec[0]*1000 : 60*1000);
      setTimeout(async ()=> await postOutcomeCheck(pending), cfg.feedbackWindowsSec && cfg.feedbackWindowsSec[1]*1000 ? cfg.feedbackWindowsSec[1]*1000 : 300*1000);
    } else {
      // INVALIDATED
      pending.status = "invalidated";
      const msg = composeTelegramText({
        type: "failed",
        symbol: pending.symbol,
        price,
        zone: { tf: pending.zone.tf, low: pending.zone.low, high: pending.zone.high },
        score: combined,
        id: pending.id,
        note: "Reason: invalidated"
      });
      await safeSend(onMessage, msg);
      // record outcome as failed
      try { if (pending.mlPredId) await recordOutcome(pending.mlPredId, { correct:false }); } catch(e){}
    }

  } catch (e) {
    // if validation fetch failed, keep pending (will re-check next cycle)
    pending.lastError = String(e);
  } finally {
    // persist status to map
    _pendingMap.set(pending.id, pending);
  }
}

async function postOutcomeCheck(pending) {
  // check price after feedback window to determine success
  try {
    if (!pending || !pending.status || pending.status !== "confirmed") return;
    const multi = await fetchMultiTF(pending.symbol, ["1m","5m","15m"]);
    const price = multi["1m"]?.price || multi[pending.zone.tf]?.price || 0;
    // realized return relative to detection
    const realized = (price - pending.entryPrice) / Math.max(1, Math.abs(pending.entryPrice));
    const success = pending.type === "bear" ? (realized < 0) : (realized > 0);
    // send feedback
    const fb = `📄 Feedback: ${pending.symbol} ${pending.type === "bear" ? "Bearish" : "Bullish"} -> ${success ? "SUCCESS" : "FAIL"} | window ${Math.round((nowSec() - pending.createdAt))}s`;
    await safeSend(pending._onMessage, fb);

    // record to ML if we have a pred id
    try {
      if (pending.mlPredId) {
        await recordOutcome(pending.mlPredId, { correct: success, realizedReturn: realized, realizedPrice: price });
      }
    } catch(e){}

    // mark resolved
    pending.resolved = true;
    _pendingMap.set(pending.id, pending);
  } catch(e){}
}

// ---------------------------
// helper to safely call onMessage
// ---------------------------
async function safeSend(onMessage, text) {
  if (typeof onMessage !== "function") {
    console.log("reversal_watcher: no onMessage callback, message:", text);
    return;
  }
  try {
    // ensure small global rate-limit
    const now = nowSec();
    if (now - _lastAlertAt < 1) {
      // throttle a little
      await new Promise(r => setTimeout(r, 250));
    }
    _lastAlertAt = now;
    await onMessage(text);
  } catch (e) {
    console.log("reversal_watcher: safeSend error:", e.message || e);
  }
}

// safe run ML prediction with timeout/backoff
async function safeRunMLPrediction(symbol) {
  try {
    const timeout = 4000;
    let done = false;
    const p = new Promise(async (resolve) => {
      try {
        const r = await runMLPrediction(symbol, "15m");
        done = true;
        resolve(r);
      } catch(e) { resolve({ error: String(e) }); }
    });
    // timeout guard
    const race = await Promise.race([p, new Promise(res => setTimeout(()=>res({ error: "timeout" }), timeout))]);
    return race;
  } catch(e) { return { error: String(e) }; }
}

// ---------------------------
// Core loop
// ---------------------------
export function startReversalWatcher(symbol = "BTCUSDT", opts = {}, onMessage = null) {
  if (_running) {
    console.log("reversal_watcher: already running");
    return;
  }
  _running = true;
  const cfg = Object.assign({}, _configDefaults, opts || {});
  _globalRateLimitSec = cfg.rateLimitSec || _globalRateLimitSec;

  console.log("reversal_watcher: STARTED for", symbol, "cfg:", JSON.stringify(cfg));

  // initial run immediately
  (async function worker() {
    try {
      // fetch multi-TF candles snapshot
      const multi = await fetchMultiTF(symbol, cfg.tfs);

      // get candidate zones and merge
      const rawZones = detectZonesFromMulti(multi, cfg);
      const merged = mergeZones(rawZones, cfg);

      // optionally, run ML to bias
      const ml = await safeRunMLPrediction(symbol);
      const mlBias = (ml && ml.label) ? ml.label : "Neutral";
      const mlProb = (ml && typeof ml.prob === "number") ? ml.prob : 0;

      // price
      const price = multi["1m"]?.price || multi[cfg.tfs[0]]?.price || 0;

      // traverse merged candidate zones
      for (const z of merged) {
        // skip weak zones
        if (z.score < 10) continue;

        // calculate final score = zone.score * supportCount weight + ml bias
        let finalScore = Math.round( z.score * 0.7 + (z.support ? z.support*6 : 0) * 0.3 );
        // if ML label contradicts zone type, penalize; if agrees, boost
        if (ml && ml.label && mlProb > 40) {
          if ((z.type === "bull" && ml.label === "Bullish") || (z.type === "bear" && ml.label === "Bearish")) {
            finalScore = clamp(finalScore + Math.round(mlProb * 0.15), 1, 100);
          } else {
            finalScore = clamp(finalScore - Math.round(mlProb * 0.25), 1, 100);
          }
        }

        // spam/rate checks
        const perSymbolSent = _lastSentPerSymbol.get(symbol) || 0;
        const now = nowSec();
        if (now - perSymbolSent < cfg.dedupeWindowSec) {
          // skip due to dedupe
          continue;
        }

        // if price is currently inside the zone and instant entry enabled => send an "entry zone" alert
        if (cfg.entryZonesEnabled && cfg.instantEntryOnZoneTouch) {
          if (price >= z.low && price <= z.high) {
            const instMsg = composeTelegramText({
              type: "entry",
              symbol,
              zone: { tf: z.tfs.join(","), low: z.low, high: z.high },
              price,
              score: finalScore,
              note: "Instant entry zone touch"
            });
            if (canSendAlert(symbol, cfg)) {
              await safeSend(onMessage, instMsg);
            }
            // do not create pending in this case (entry only)
          }
        }

        // create pending if score threshold reached
        if (finalScore >= cfg.minAlertConfidence) {
          // check pending limit
          const existingPendingsForSymbol = [..._pendingMap.values()].filter(p => p.symbol === symbol && !p.resolved && p.status !== "invalidated");
          if (existingPendingsForSymbol.length >= cfg.maxPendingPerSymbol) {
            // skip spawn to avoid spam
            continue;
          }

          // Avoid creating duplicate pending for very similar zone (merge check)
          const dup = [..._pendingMap.values()].find(p => p.symbol === symbol && !p.resolved && Math.abs(p.zone.low - z.low) < (Math.abs(z.high - z.low)*0.35) && p.type === z.type && (now - (p.createdAt||0) < cfg.spamWindowSec));
          if (dup) continue;

          // create pending object
          const pend = {
            id: mkPendingId(),
            symbol,
            createdAt: nowSec(),
            zone: { low: z.low, high: z.high, tf: z.tfs[0], supportCount: z.supportCount },
            type: z.type, // bull/bear
            score: finalScore,
            entryPrice: price,
            topTPs: [], sls: [],
            status: "pending",
            _onMessage: onMessage
          };

          // compute TP/SL guess from zone width and ATR if available
          const width = Math.max(1, Math.abs(z.high - z.low));
          const tp1 = pend.entryPrice + (pend.type === "bull" ? width*1.2 : -width*1.2);
          const tp2 = pend.entryPrice + (pend.type === "bull" ? width*2.8 : -width*2.8);
          pend.topTPs = [Number(tp1.toFixed(2)), Number(tp2.toFixed(2))];
          pend.sls = [ Number((pend.entryPrice - (pend.type === "bull" ? width*0.8 : -width*0.8)).toFixed(2)) ];

          // record micro/ml pred to bind with pending
          try {
            const micro = await runMicroPrediction(symbol, cfg.microLookback);
            pend.micro = micro;
          } catch(e){ pend.micro = { error: String(e) }; }

          try {
            const mlp = await safeRunMLPrediction(symbol);
            pend.ml = mlp;
          } catch(e){ pend.ml = { error: String(e) }; }

          // record prediction in ML storage (optional)
          try {
            if (typeof recordPrediction === "function") {
              const predRec = {
                symbol,
                label: pend.type === "bear" ? "Bearish" : "Bullish",
                createdAt: new Date().toISOString(),
                score: pend.score,
                featureVector: (pend.ml && pend.ml.featureVector) ? pend.ml.featureVector : null
              };
              pend.mlPredId = await recordPrediction(predRec);
            }
          } catch(e){ /* ignore */ }

          // store pending and announce
          _pendingMap.set(pend.id, pend);

          // announce pending
          const msg = composeTelegramText({
            type: "pending",
            symbol,
            zone: { tf: pend.zone.tf, low: pend.zone.low, high: pend.zone.high },
            score: pend.score,
            price,
            topTPs: pend.topTPs,
            sls: pend.sls,
            micro: pend.micro,
            id: pend.id
          });

          if (canSendAlert(symbol, cfg)) {
            await safeSend(onMessage, msg);
          }
          // schedule validation checks after short delay (10s..cfg.pollInterval)
          setTimeout(()=> validatePending(pend, cfg, onMessage), Math.max(5000, Math.floor(cfg.pollIntervalMs/2)));
        }
      } // end merged zones loop

      // Clean old pendings
      const maxAge = 3600; // 1 hour
      for (const [id, p] of _pendingMap.entries()) {
        if (p.resolved || p.status === "invalidated") {
          // keep short while then delete
          if (nowSec() - (p.createdAt || 0) > 60) _pendingMap.delete(id);
          continue;
        }
        if (nowSec() - (p.createdAt || 0) > maxAge) {
          p.status = "stale";
          _pendingMap.delete(id);
        }
      }

    } catch (e) {
      console.log("reversal_watcher: worker error:", e && e.message ? e.message : e);
    } finally {
      // schedule next tick if still running
      if (_running) {
        _timer = setTimeout(worker, opts.pollIntervalMs || _configDefaults.pollIntervalMs);
      }
    }
  })();

  // periodic status ticker to reduce spam: send periodic status every minute
  _statusTicker = setInterval(async ()=>{
    if (!_running) return;
    const activePendings = [..._pendingMap.values()].filter(p=>!p.resolved && p.status!=='invalidated').length;
    const confirmed = [..._pendingMap.values()].filter(p=>p.status==='confirmed').length;
    const statusMsg = composeTelegramText({ type: "status", symbol, active: activePendings, confirmed: confirmed, rateLimit: _globalRateLimitSec });
    if (onMessage && typeof onMessage === "function") {
      // send but obey rate limiter
      try { await safeSend(onMessage, statusMsg); } catch(e){}
    }
  }, 60 * 1000);

}

// ---------------------------
// stop function
// ---------------------------
export async function stopReversalWatcher() {
  if (!_running) return;
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (typeof _statusTicker !== "undefined" && _statusTicker) { clearInterval(_statusTicker); _statusTicker = null; }
  // optional cleanup persistence
  console.log("reversal_watcher: stopped");
  // mark unresolved pendings as invalidated
  for (const [id, p] of _pendingMap.entries()) {
    if (!p.resolved) {
      p.status = "invalidated";
      _pendingMap.set(id, p);
    }
  }
  return true;
}