// reversal_watcher.js
// Reversal watcher v3 — multi-TF + ML + entry-zone + throttling + feedback
//
// Exports:
//   startReversalWatcher(symbol, cfg, notifyFn)
//   stopReversalWatcher()
//
// notifyFn should be async function(textOrObject) which sends Telegram (aiTraderBot passes sendTelegram)
// Requires (in project):
//   - ./utils.js with fetchMultiTF(symbol, tfs) or fetchMarketData
//   - ./ml_module_v8_6.js exporting runMicroPrediction, runMLPrediction, recordPrediction, recordOutcome, calculateAccuracy
//
// NOTE: keep notifyFn provided by aiTraderBot (do not import telegram.js here)

import { fetchMultiTF, fetchMarketData } from "./utils.js";
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
  minAlertConfidence: 60,         // combined score threshold (0..100)
  microLookback: 60,
  feedbackWindowsSec: [60, 300],  // evaluate performance over these windows
  zonePaddingPct: 0.0025,         // pad zones by this % of price
  requireSupportCount: 2,         // number of TF supports required for reversal
  maxPendingPerSymbol: 3,
  maxAlertsPerMinutePerSymbol: 6,
  globalRateLimitSec: 6,
  dedupeWindowSec: 6,
  spamWindowSec: 60,
  maxAlertsBurst: 4,
  entryZonesEnabled: true,        // send entry-zone alerts
  instantEntryOnTouch: true,
  entryZonePaddingPct: 0.0025
};

// internal state
let _running = false;
let _timer = null;
let _pendingMap = new Map();        // pendingID -> pending object
let _lastSentAt = 0;
let _lastSentPerSymbol = new Map(); // symbol -> [timestamps]
let _confirmedCount = 0;
let _globalConfig = {};
let _notify = null;
let _symbolGlobal = null;

// helpers
function nowSec() { return Math.floor(Date.now()/1000); }
function uid(prefix="pend") { return `${prefix}_${Date.now()}_${Math.floor(Math.random()*10000)}`; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// basic throttles
function canSendGlobal() {
  const t = nowSec();
  if (t - _lastSentAt < (_globalConfig.globalRateLimitSec || DEFAULTS.globalRateLimitSec)) return false;
  return true;
}
function recordSent(symbol) {
  _lastSentAt = nowSec();
  const arr = _lastSentPerSymbol.get(symbol) || [];
  arr.push(Date.now());
  // keep recent only (spamWindowSec)
  const cutoff = Date.now() - ((_globalConfig.spamWindowSec || DEFAULTS.spamWindowSec) * 1000);
  while (arr.length && arr[0] < cutoff) arr.shift();
  _lastSentPerSymbol.set(symbol, arr);
}
function allowedBySymbolRate(symbol) {
  const arr = _lastSentPerSymbol.get(symbol) || [];
  const windowMin = (_globalConfig.spamWindowSec || DEFAULTS.spamWindowSec) * 1000;
  // check burst
  if (arr.length >= (_globalConfig.maxAlertsBurst || DEFAULTS.maxAlertsBurst)) return false;
  // check per-minute cap
  const perMinute = (_globalConfig.maxAlertsPerMinutePerSymbol || DEFAULTS.maxAlertsPerMinutePerSymbol);
  const cutoff = Date.now() - 60*1000;
  const recent = arr.filter(t => t >= cutoff);
  if (recent.length >= perMinute) return false;
  return true;
}

async function safeNotify(text) {
  try {
    if (!_notify) {
      console.log("No notify fn provided; skipping notify:", text);
      return;
    }
    // final throttle check
    if (!canSendGlobal()) return;
    // symbol rate should be checked by caller (we still guard)
    await _notify(typeof text === "string" ? text : JSON.stringify(text, null, 2));
    // if text is object, attempt to extract symbol for per-symbol accounting
    try {
      const symbol = typeof text === "object" && text.symbol ? text.symbol : null;
      if (symbol) recordSent(symbol);
      else _lastSentAt = nowSec();
    } catch { _lastSentAt = nowSec(); }
  } catch (e) {
    console.error("notify error:", e?.message || e);
  }
}

// utility - construct a simple human message
function formatPendingMessage(p) {
  // p: { id, symbol, zone: { low, high, tfWeights }, score, price, label, micro, mlProb }
  const zoneStr = `${p.mergedZoneLow.toFixed(2)} - ${p.mergedZoneHigh.toFixed(2)}`;
  const topTPs = (p.tps || []).slice(0,3).map(n=>Number(n).toFixed(2)).join(" / ");
  return [
    `⚡ REVERSAL DETECTED (PENDING) —`,
    `Symbol: ${p.symbol}`,
    `Zone: ${p.zoneTfs.join(", ")} ${zoneStr}`,
    `Score: ${Math.round(p.score)}% | Price: ${Number(p.price).toFixed(2)}`,
    p.ml ? `ML: ${p.ml.label} ${p.ml.prob}%` : `MicroML: ${p.micro?.label || "n/a"} ${Math.round(p.micro?.prob||0)}%`,
    `TopTPs: ${topTPs}`,
    `SLs: ${ (p.sls||[]).map(x => Number(x).toFixed(2)).join(" / ") }`,
    `PendingID: ${p.id}`
  ].join("\n");
}
function formatConfirmationMsg(conf) {
  return [
    `🟢 REVERSAL CONFIRMED — ${conf.direction || "Unknown"}`,
    `Symbol: ${conf.symbol} | Price: ${Number(conf.price).toFixed(2)}`,
    `TPs: ${ (conf.tps||[]).map(n=>Number(n).toFixed(2)).join(" / ") }`,
    `SLs: ${ (conf.sls||[]).map(n=>Number(n).toFixed(2)).join(" / ") }`,
    `Support: ${conf.supportCount || 0} | movedPct: ${ (conf.movedPct || 0).toFixed(3) }%`,
    `ID: ${conf.id || conf.pendingId || ""}`
  ].join("\n");
}
function formatFailMsg(p, reason) {
  return `🔴 REVERSAL FAILED ${p.symbol} ${p.direction || ""}\nReason: ${reason}\nID: ${p.id}`;
}

// zone helpers: given multiTF candles, compute per-TF zone (simple: last N high/low)
function computeZoneFromCandles(multi, tf, lookback=5) {
  const obj = multi[tf];
  if (!obj || !Array.isArray(obj.data) || !obj.data.length) return null;
  const arr = obj.data;
  const recent = arr.slice(-lookback);
  let high = -Infinity, low = Infinity;
  for (const c of recent) { high = Math.max(high, c.high); low = Math.min(low, c.low); }
  if (!isFinite(high) || !isFinite(low)) return null;
  // return center zone
  return { tf, low, high, lastClose: recent.at(-1).close };
}
function mergeZones(zones, weights, paddingPct) {
  // zones: [{tf,low,high}], weights: per-tf weight
  // We'll compute intersection-ish: pick median low/high weighted by tf weights
  if (!zones || !zones.length) return null;
  const lows = []; const highs = [];
  for (const z of zones) {
    const w = weights && weights[z.tf] ? weights[z.tf] : 1;
    for (let i=0;i<Math.max(1, Math.round(w*3));i++) { lows.push(z.low); highs.push(z.high); }
  }
  lows.sort((a,b)=>a-b); highs.sort((a,b)=>a-b);
  const low = lows[Math.floor(lows.length*0.25)] || lows[0];
  const high = highs[Math.ceil(highs.length*0.75)-1] || highs[highs.length-1];
  const mid = (low+high)/2;
  const pad = Math.max(1, mid * (paddingPct || DEFAULTS.zonePaddingPct));
  return { low: low - pad, high: high + pad };
}

// scoring: naive combination of TF direction flips + ML
function computeScoreFromMulti(multi, cfg) {
  // compute returns per TF and momentum signs
  const signs = [];
  let aggregated = 0;
  for (const tf of cfg.tfs) {
    const cand = multi[tf]?.data || [];
    if (cand.length < 3) { signs.push(0); continue; }
    const last = cand.at(-1).close, prev = cand.at(-2).close, prev2 = cand.at(-3).close;
    const slope = last - prev;
    const slope2 = prev - prev2;
    const flip = (slope * slope2 < 0) ? 1 : 0; // sign flip
    const momentum = Math.abs(slope);
    aggregated += (cfg.weights[tf] || 1) * (flip ? 1 : 0) * (momentum || 1);
    signs.push(slope>0 ? 1 : slope<0 ? -1 : 0);
  }
  // normalize aggregated into 0..100 roughly
  const score = clamp(Math.round(aggregated * 100), 0, 100);
  return { score, signs };
}

// post-check outcome: called after windowSec, fetch price and compute realized return
async function checkPostOutcome(pending, windowSec) {
  try {
    // fetch recent price (use fetchMarketData 1m)
    const md = await fetchMarketData(pending.symbol, "1m", 2).catch(()=>null);
    const newPrice = md?.price ?? null;
    if (newPrice === null) return { success:false, reason: "no_price" };
    const priceAtSend = pending.priceAtSend ?? pending.price;
    if (priceAtSend == null) return { success:false, reason: "no_base_price" };
    const ret = ((newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend))) * 100;
    const realizedReturn = ret;
    const success = (pending.side === "Bullish") ? (ret > 0) : (ret < 0);
    return { success, newPrice, realizedReturn, ret };
  } catch (e) {
    return { success:false, reason: String(e) };
  }
}

// create pending object and notify
async function createPending(symbol, mergedZone, price, meta, cfg) {
  // meta: { ml, micro, tps, sls, direction }
  const id = uid("pend_v3");
  const p = {
    id,
    symbol,
    zoneTfs: cfg.tfs,
    mergedZoneLow: mergedZone.low,
    mergedZoneHigh: mergedZone.high,
    price,
    score: meta.score || 0,
    ml: meta.ml,
    micro: meta.micro,
    tps: meta.tps || [],
    sls: meta.sls || [],
    side: meta.direction || (meta.ml?.label || "Neutral"),
    createdAt: Date.now(),
    priceAtSend: price,
    notified: false,
    supportCount: meta.supportCount || 0
  };

  // limit number of pendings per symbol
  const pendingsForSymbol = Array.from(_pendingMap.values()).filter(x => x.symbol === symbol);
  if (pendingsForSymbol.length >= (cfg.maxPendingPerSymbol || DEFAULTS.maxPendingPerSymbol)) {
    // drop oldest
    const oldest = pendingsForSymbol.sort((a,b)=>a.createdAt - b.createdAt)[0];
    if (oldest) _pendingMap.delete(oldest.id);
  }

  _pendingMap.set(id, p);

  // notify pending
  if (allowedBySymbolRate(symbol)) {
    await safeNotify(formatPendingMessage(p));
    p.notified = true;
    recordPrediction({ id: p.id, symbol: p.symbol, label: p.side, featureVector: meta.featureVector }).catch(()=>{});
  }

  return p;
}

// check pendings for confirmations or failures
async function processPendingLifecycle(cfg) {
  const now = Date.now();
  for (const [id, p] of Array.from(_pendingMap.entries())) {
    const ageSec = Math.floor((now - p.createdAt)/1000);
    // For each feedback window, if we passed window, evaluate outcome once.
    for (const wSec of cfg.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec) {
      if (!p[`checked_w${wSec}`] && ageSec >= wSec) {
        p[`checked_w${wSec}`] = true;
        const res = await checkPostOutcome(p, wSec).catch(e=>({ success:false, reason:String(e) }));
        if (res.success) {
          // confirmed
          const confMsg = {
            direction: p.side,
            symbol: p.symbol,
            price: res.newPrice,
            tps: p.tps,
            sls: p.sls,
            supportCount: p.supportCount,
            movedPct: ( (res.newPrice - p.priceAtSend) / (Math.max(1, Math.abs(p.priceAtSend))) * 100 ),
            id: p.id
          };
          await safeNotify(formatConfirmationMsg(confMsg));
          // feedback to ML
          await recordOutcome(p.id, { correct: true, realizedReturn: res.realizedReturn }).catch(()=>{});
          _pendingMap.delete(id);
          _confirmedCount++;
        } else {
          // failed -> invalidated
          const reason = res.reason || "invalidated";
          await safeNotify(formatFailMsg(p, reason));
          await recordOutcome(p.id, { correct: false, realizedReturn: res.realizedReturn || 0 }).catch(()=>{});
          _pendingMap.delete(id);
        }
      }
    }
    // TTL safety: drop long-lived pendings > 3600s
    if (ageSec > 3600) {
      _pendingMap.delete(id);
    }
  }
}

// heartbeat / main scan
async function _scanOnce(symbol, cfg) {
  try {
    // fetch multi TF candles
    const multi = await fetchMultiTF(symbol, cfg.tfs).catch(async (e)=>{
      // fallback: try per-tf fetchMarketData with limit 20 (slow)
      console.warn("fetchMultiTF failed, trying per-TF fallback", e?.message||e);
      const out = {};
      for (const tf of cfg.tfs) {
        try { out[tf] = await fetchMarketData(symbol, tf, cfg.tfLimit || 30); } catch { out[tf] = null; }
      }
      return out;
    });

    // compute per-TF zones
    const perZones = [];
    for (const tf of cfg.tfs) {
      const z = computeZoneFromCandles(multi, tf, 5);
      if (z) perZones.push(z);
    }
    if (!perZones.length) return;

    const merged = mergeZones(perZones, cfg.weights, cfg.zonePaddingPct || DEFAULTS.zonePaddingPct);
    if (!merged) return;

    // current price: take 1m last close or multi[1m].price
    const price = (multi["1m"] && Array.isArray(multi["1m"].data) && multi["1m"].data.length)
      ? multi["1m"].data.at(-1).close
      : (multi["1m"]?.price || (perZones[0]?.lastClose || null));

    // compute signal score
    const scoreObj = computeScoreFromMulti(multi, cfg);
    let score = scoreObj.score;

    // run micro ML for a short-window read
    let micro = null;
    try { micro = await runMicroPrediction(symbol, cfg.microLookback || DEFAULTS.microLookback); } catch (e) { micro = null; }

    // run full ML if needed
    let ml = null;
    try {
      ml = await runMLPrediction(symbol, cfg.tfs[ cfg.tfs.length-1 ] || "15m");
      // if ML suggests strong opposite label, adjust score
      if (ml && typeof ml.prob === "number") {
        score = Math.max(score, Math.round(ml.prob));
      }
    } catch (e) { ml = null; }

    // check if price is inside merged zone => entry zone alert
    const inside = (price >= merged.low && price <= merged.high);
    if (cfg.entryZonesEnabled && inside) {
      // send entry-zone alert (instant touch)
      // throttle: per-symbol allowedBySymbolRate and global canSendGlobal
      if (canSendGlobal() && allowedBySymbolRate(symbol)) {
        const msg = [
          `🔔 ENTRY ZONE ALERT`,
          `Symbol: ${symbol}`,
          `Zone: ${cfg.tfs.join(",")} ${merged.low.toFixed(2)} - ${merged.high.toFixed(2)}`,
          `Score: ${score}% | Price: ${Number(price).toFixed(2)}`,
          cfg.instantEntryOnTouch ? "Instant entry zone touch" : "Entry zone"
        ].join("\n");
        await safeNotify({ text: msg, symbol });
      }
    }

    // when to raise pending reversal:
    // criteria: score >= minAlertConfidence OR micro strong & inside zone & supportCount satisfied
    const minConf = cfg.minAlertConfidence || DEFAULTS.minAlertConfidence;
    const microStrong = (micro && micro.prob && micro.prob > 60);
    const mlStrong = (ml && ml.prob && ml.prob >= (cfg.minAlertConfidence || DEFAULTS.minAlertConfidence));
    // compute supportCount: count TFs where last candle opposite to prior (naive)
    let supportCount = 0;
    try {
      for (const tf of cfg.tfs) {
        const arr = (multi[tf] && Array.isArray(multi[tf].data)) ? multi[tf].data : [];
        if (arr.length < 3) continue;
        const last = arr.at(-1).close, prev = arr.at(-2).close, prev2 = arr.at(-3).close;
        const slope = last - prev, slope2 = prev - prev2;
        if (slope * slope2 < 0) supportCount++;
      }
    } catch {}

    const shouldRaise =
      (score >= minConf) ||
      (inside && microStrong && supportCount >= (cfg.requireSupportCount || DEFAULTS.requireSupportCount)) ||
      mlStrong;

    if (shouldRaise) {
      // ensure not too many pendings for symbol
      const pendingsForSymbol = Array.from(_pendingMap.values()).filter(x => x.symbol === symbol);
      if (pendingsForSymbol.length >= (cfg.maxPendingPerSymbol || DEFAULTS.maxPendingPerSymbol)) {
        // too many, skip creating new pending
      } else {
        // determine direction label (prefer ML, else micro, else naive)
        let direction = "Neutral";
        if (ml && ml.label) direction = ml.label;
        else if (micro && micro.label) direction = micro.label;
        else direction = (score >= minConf) ? "Bearish" : "Neutral";

        // build tps, sls: simple placeholders around zone
        const width = merged.high - merged.low;
        const tp1 = direction === "Bullish" ? merged.high + width*0.8 : merged.low - width*0.8;
        const tp2 = direction === "Bullish" ? merged.high + width*1.6 : merged.low - width*1.6;
        const sl1 = direction === "Bullish" ? merged.low - width*0.5 : merged.high + width*0.5;

        // assemble meta
        const meta = {
          score,
          ml,
          micro,
          featureVector: ml?.featureVector || null,
          tps: [tp1, tp2],
          sls: [sl1],
          direction,
          supportCount
        };

        // create pending and notify inside createPending which also calls recordPrediction
        await createPending(symbol, { low: merged.low, high: merged.high }, price, meta, cfg);
      }
    }

    // process pending lifecycle: confirmations / failures
    await processPendingLifecycle(cfg);

  } catch (e) {
    console.error("scanOnce error:", e?.message || e);
  }
}

// public API
export function startReversalWatcher(symbol = "BTCUSDT", cfg = {}, notifyFn = null) {
  if (_running) {
    console.warn("Reversal watcher already running");
    return;
  }
  _running = true;
  _notify = notifyFn;
  _symbolGlobal = symbol;
  _globalConfig = Object.assign({}, DEFAULTS, cfg || {});

  // immediate single run, then schedule
  (async () => {
    try {
      await _scanOnce(symbol, _globalConfig);
    } catch (e) { console.error("startup scan error", e); }
  })();

  _timer = setInterval(() => {
    _scanOnce(symbol, _globalConfig);
  }, _globalConfig.pollIntervalMs || DEFAULTS.pollIntervalMs);

  // periodic status heartbeat (every spamWindowSec)
  setInterval(async () => {
    try {
      if (!_notify) return;
      const status = {
        Time: new Date().toLocaleString(),
        ActivePendings: Array.from(_pendingMap.values()).length,
        ConfirmedLast: _confirmedCount,
        GlobalRateLimitSec: _globalConfig.globalRateLimitSec
      };
      const msg = `⚙️ REV WATCH STATUS — ${symbol}\nTime: ${status.Time}\nActive pendings: ${status.ActivePendings}\nConfirmed (last): ${status.ConfirmedLast}\nGlobalRateLimitSec: ${status.GlobalRateLimitSec}`;
      await safeNotify(msg);
    } catch {}
  }, Math.max(60*1000, (_globalConfig.spamWindowSec||DEFAULTS.spamWindowSec)*1000) );

  console.log("🔧 reversal_watcher: STARTED for", symbol, "cfg:", JSON.stringify(_globalConfig));
}

export async function stopReversalWatcher() {
  if (!_running) return;
  try {
    if (_timer) clearInterval(_timer);
    _timer = null;
    _running = false;
    _pendingMap.clear();
    _lastSentPerSymbol.clear();
    _lastSentAt = 0;
    console.log("🛑 reversal_watcher: STOPPED");
  } catch (e) {
    console.error("stopReversalWatcher error:", e);
  }
}