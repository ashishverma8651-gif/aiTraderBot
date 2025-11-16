// reversal_watcher.js
// v3 — Reversal Watcher with Entry Zone (Hybrid 5m+15m), MicroML + Feedback + Anti-spam
//
// Exports: startReversalWatcher(symbol, options, onAlert)
//          stopReversalWatcher()
//
// Depends on (expected to exist in your project):
//  - fetchMultiTF(symbol, tfs)           // returns { "1m":{data,price}, "5m":..., "15m":..., "1h":... }
//  - fetchMarketData(symbol, tf, limit)  // returns { price, data }
//  - runMicroPrediction(symbol)          // quick micro ML (1m/5m) returns { label, prob, probBull, probBear, tpMul, features }
//  - runMLPrediction(symbol)             // optional full ML for bias/TP
//  - recordPrediction(pred), recordOutcome(id, outcome)
//  - indicators helpers optional (computeATR etc.) if available via ./core_indicators.js

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js"; // adjust name if your ML file differs
import * as indicators from "./core_indicators.js";

let _watcher = null;

function nowISO() { return new Date().toISOString(); }
function clamp(v, lo=-1, hi=1){ return Math.max(lo, Math.min(hi, v)); }

function nf(v, d=2){ return (typeof v==="number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A"; }

// default options
const DEFAULTS = {
  pollIntervalMs: 20_000,
  tfs: ["1m","5m","15m"],
  weights: { "1m":0.25, "5m":0.35, "15m":0.40 },
  minAlertConfidence: 60,
  microLookback: 60,
  feedbackWindowsSec: [60, 300],
  zoneCfg: {
    // zone width multipliers relative to ATR (wider zone for 5m, tighter for 15m)
    "5m": { atrMult: 1.4, padPct: 0.0025 },
    "15m": { atrMult: 0.9, padPct: 0.0015 }
  },
  cooldownSecPerZone: 60,   // don't re-alert same zone within this seconds
  globalRateLimitSec: 6,    // min seconds between any alert send
  statusEverySec: 300       // heartbeat/status message every 5 minutes
};

// helpers: get ATR fallback
function getATR(candles) {
  try { return (typeof indicators.computeATR==="function") ? indicators.computeATR(candles) : null; } catch(e){return null;}
}

// build zone from level +/- atr-based width or small percent fallback
function buildZone(level, candles, tf, cfg) {
  const atr = getATR(candles) || (candles?.length ? (candles.at(-1).close * 0.002) : 0.002);
  const mult = (cfg?.zoneCfg?.[tf]?.atrMult) ?? 1.0;
  const padPct = (cfg?.zoneCfg?.[tf]?.padPct) ?? 0.002;
  const half = Math.max( Math.abs(atr) * mult, Math.abs(level) * padPct );
  return { lo: level - half, hi: level + half, width: half*2, basisATR: atr };
}

// internal state
class WatcherState {
  constructor(symbol, opts, onAlert) {
    this.symbol = symbol;
    this.opts = opts;
    this.onAlert = onAlert;
    this.running = false;
    this.timer = null;
    this.lastGlobalAlertAt = 0;
    this.zoneCooldowns = new Map(); // key -> timestamp
    this.pending = new Map(); // id -> pending object
    this.confirmed = new Map(); // id -> confirmed object
    this.statusTimer = null;
  }
  canSendGlobal() {
    return (Date.now() - this.lastGlobalAlertAt) / 1000 >= this.opts.globalRateLimitSec;
  }
  markSent() { this.lastGlobalAlertAt = Date.now(); }
  zoneKey(tf, side, lo, hi) {
    // key combining tf+side+rounded zone
    return `${tf}|${side}|${Math.round(lo)}|${Math.round(hi)}`;
  }
  inCooldown(key) {
    const now = Date.now();
    const t = this.zoneCooldowns.get(key) || 0;
    return (now - t) / 1000 < this.opts.cooldownSecPerZone;
  }
  setCooldown(key) {
    this.zoneCooldowns.set(key, Date.now());
  }
}

// build fusion bias simple helper (we keep lightweight)
function computeTFBias(mtf) {
  // mtf: [{tf, fusionScore}] -> weighted sum
  try {
    const weights = mtf.reduce((s,m)=>s + (m.weight||1), 0) || 1;
    let sum = 0;
    for (const m of mtf) {
      sum += (m.fusionScore || 0) * (m.weight || 1);
    }
    return clamp(sum / weights, -1, 1);
  } catch(e){ return 0; }
}

// format messages (html/plain)
function formatPendingMessage(p) {
  return `⚡ REVERSAL DETECTED (PENDING) —\nSymbol: ${p.symbol}\nZone: ${p.tf} ${nf(p.zone.lo,2)} - ${nf(p.zone.hi,2)}\nScore: ${Math.round(p.score*100)}% | Price: ${nf(p.price,2)}\nTopTPs: ${p.topTPs.join(" / ")}\nSLs: ${p.SLs.join(" / ")}\nMicroML: ${p.micro?.label || "N/A"} ${p.micro?.prob ? "(" + nf(p.micro.prob,2) + "%)" : ""}\nPendingID: ${p.id}`;
}
function formatConfirmedMessage(c) {
  return `🟢 REVERSAL CONFIRMED — ${c.side}\nSymbol: ${c.symbol} | Price: ${nf(c.price,2)}\nTPs: ${c.TPs.join(" / ")}\nSLs: ${c.SLs.join(" / ")}\nSupport: ${c.supportCount || 0} | movedPct: ${nf(c.movedPct*100,3)}%\nID: ${c.id}`;
}
function formatFailedMessage(f) {
  return `🔴 REVERSAL FAILED ${f.symbol} ${f.side}\nReason: ${f.reason}\nID: ${f.id}`;
}
function formatStatusMessage(summary) {
  return `⚙️ REV WATCH STATUS — ${summary.symbol}\nTime: ${new Date().toLocaleString()}\nActive pendings: ${summary.pending}\nConfirmed (last): ${summary.confirmed}\nGlobalRateLimitSec: ${summary.globalRateLimitSec}`;
}

// decide whether price is inside zone
function priceInZone(price, zone) {
  return (price >= zone.lo && price <= zone.hi);
}

// choose TPs: prefer ML tp multiplier if available, else use Elliott targets or simple ATR multiples
function chooseTPs(price, mlPred, ellTargets, atr) {
  const tps = [];
  if (ellTargets && ellTargets.length) {
    // use top upto 3 unique
    for (const t of ellTargets.slice(0,3)) {
      const tp = Number(t.tp || t.target || t.price || 0);
      if (tp && !tps.includes(tp)) tps.push(tp);
    }
  }
  if (!tps.length && mlPred && mlPred.tpMul) {
    const mul = Number(mlPred.tpMul) || 2.0;
    if (mlPred.label && mlPred.label.toLowerCase().includes("bull")) {
      tps.push(price * (1 + mul/100));
      tps.push(price * (1 + (mul*1.5)/100));
    } else if (mlPred.label && mlPred.label.toLowerCase().includes("bear")) {
      tps.push(price * (1 - mul/100));
      tps.push(price * (1 - (mul*1.5)/100));
    }
  }
  // fallback: ATR multiples
  if (!tps.length) {
    const a = Math.max(atr || 1, price*0.002);
    tps.push(price + a*3, price + a*6);
  }
  // normalize numbers
  return tps.map(v => Number(v));
}

// choose SLs: use ATR or small percent
function chooseSLs(price, side, atr) {
  const a = Math.max(atr || 1, price*0.0015);
  if (side === "Bullish") {
    // long SL below
    return [ price - a*2, price - a*4 ].map(v => Number(v));
  } else {
    return [ price + a*2, price + a*4 ].map(v => Number(v));
  }
}

// MAIN: detect zones from ell/fib and build candidates (both buy & sell)
async function discoverZones(symbol, multi, opts) {
  // returns array of { tf, side, zone, priceRef, scoreHint, ellTargets, ellSupport, ellRes }
  const zones = [];
  // for each TF we try to get ell summary: safe fallback to fib levels or simple pivots
  for (const tf of opts.tfs) {
    const entry = multi[tf] || {};
    const candles = entry.data || [];
    const price = (entry.price || candles?.at(-1)?.close || 0);
    // try to get ell info from analyzeElliott (assumed present in multi object e.g. multi[tf].ell)
    const ell = entry.ell || entry.elliott || null;
    // prefer ell pivots: support/resistance
    let sup = ell?.support || null;
    let res = ell?.resistance || null;
    // fallback: simple fib or last swing extremes (cheap)
    if (!sup || !res) {
      // derive simple recent high/low (last 20)
      const recent = (candles.length >= 20) ? candles.slice(-20) : candles;
      const highs = recent.map(c=>c.high||c.h||c[2]||0);
      const lows = recent.map(c=>c.low||c.l||c[3]||0);
      const hi = highs.length ? Math.max(...highs) : null;
      const lo = lows.length ? Math.min(...lows) : null;
      if (!res && hi) res = hi;
      if (!sup && lo) sup = lo;
    }
    // build buy zone (around support) and sell zone (around resistance)
    if (sup) {
      const zone = buildZone(sup, candles, tf, opts);
      zones.push({ tf, side: "Bullish", zone, priceRef: price, scoreHint: 0.6, ell, ellTargets: ell?.targets || [] });
    }
    if (res) {
      const zone = buildZone(res, candles, tf, opts);
      zones.push({ tf, side: "Bearish", zone, priceRef: price, scoreHint: 0.6, ell, ellTargets: ell?.targets || [] });
    }
  }
  return zones;
}

// pending -> confirm logic
async function processPending(state, p) {
  // p: pending object { id, symbol, tf, zone, side, score, createdAt, priceAtDetect, topTPs, SLs, micro, ml }
  const windowSec = state.opts.feedbackWindowsSec[0] || 60; // primary short window (1m)
  try {
    // wait lookback seconds then check price movement
    await new Promise(r => setTimeout(r, Math.max(1000, Math.min(windowSec*1000, 30_000))));
    const resp = await fetchMarketData(p.symbol, "1m", 3);
    const newPrice = resp?.price ?? null;
    if (newPrice === null) {
      // mark failed (no price)
      await finalizeFailed(state, p, "no_price");
      return;
    }
    // compute realized move relative to priceAtDetect
    const priceAtSend = (p.priceAtDetect || p.price) || newPrice;
    const ret = (newPrice - priceAtSend) / Math.max(1, Math.abs(priceAtSend));
    const success = (p.side === "Bullish") ? (ret > 0) : (ret < 0);
    const movedPct = ret;
    if (success) {
      // confirm
      const confirmed = {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        price: newPrice,
        TPs: p.topTPs,
        SLs: p.SLs,
        supportCount: 2,
        movedPct,
        createdAt: nowISO()
      };
      state.confirmed.set(p.id, confirmed);
      // send confirmed msg (throttle check)
      if (state.canSendGlobal()) {
        await state.onAlert(formatConfirmedMessage(confirmed));
        state.markSent();
      }
      // record feedback/outcome to ML store if available
      try {
        await recordOutcome(p.predId || p.id, { correct: true, realizedReturn: ret, realizedPrice: newPrice });
      } catch(e) {}
    } else {
      // failed
      await finalizeFailed(state, p, "invalidated");
    }
  } catch(e) {
    await finalizeFailed(state, p, "error:" + (e?.message||String(e)));
  } finally {
    // cleanup pending
    state.pending.delete(p.id);
  }
}

async function finalizeFailed(state, p, reason="invalidated") {
  try {
    const f = { id: p.id, symbol: p.symbol, side: p.side, reason, createdAt: nowISO() };
    if (state.canSendGlobal()) {
      await state.onAlert(formatFailedMessage(f));
      state.markSent();
    }
    try { await recordOutcome(p.predId || p.id, { correct:false, realizedReturn: 0 }); } catch(e){}
  } catch(e){}
}

// main watcher tick
async function tick(state) {
  try {
    // fetch multi-tf candles (1m/5m/15m)
    const multi = await fetchMultiTF(state.symbol, state.opts.tfs);
    const mtfArray = [];
    for (const tf of state.opts.tfs) {
      const entry = multi[tf] || {};
      const ind = {};
      ind.ATR = (typeof indicators.computeATR === "function") ? indicators.computeATR(entry.data || []) : null;
      ind.RSI = (typeof indicators.computeRSI === "function") ? indicators.computeRSI(entry.data || []) : null;
      ind.MACD = (typeof indicators.computeMACD === "function") ? (indicators.computeMACD(entry.data || [])).hist : null;
      mtfArray.push({ tf, fusionScore: (entry.fusionScore ?? 0), weight: state.opts.weights[tf] ?? 1, ind, entry });
    }

    // discover entry zones (support/resistance)
    const zones = await discoverZones(state.symbol, multi, state.opts);

    // current price (from 1m)
    const m1 = multi["1m"] || {};
    const price = m1.price || (m1.data?.at(-1)?.close) || (multi["5m"]?.price) || 0;

    // microML quick
    let micro = null;
    try { micro = await runMicroPrediction(state.symbol); } catch(e){ micro = null; }

    // for each zone candidate check if price is inside (both 5m & 15m logic: prefer confirmed when both hit)
    for (const z of zones) {
      // construct key & de-dupe
      const key = state.zoneKey(z.tf, z.side, z.zone.lo, z.zone.hi);
      if (state.inCooldown(key)) continue;

      if (priceInZone(price, z.zone)) {
        // build pending object
        const id = "pend_v3_" + Date.now() + "_" + Math.floor(Math.random()*9000);
        const ellTargets = (z.ellTargets || []).map(t => Number(t.tp || t.target || t.price || 0)).filter(v=>v);
        // get ml full prediction optionally (non-blocking)
        let ml = null;
        try { ml = await runMLPrediction(state.symbol); } catch(e){ ml = null; }
        const tps = chooseTPs(price, ml, ellTargets, z.zone.basisATR);
        const sls = chooseSLs(price, z.side, z.zone.basisATR);
        const pending = {
          id, symbol: state.symbol, tf: z.tf, zone: z.zone, side: z.side,
          score: (z.scoreHint || 0.6), price, priceAtDetect: price,
          topTPs: tps, SLs: sls, micro, ml, ell: z.ell || null,
          createdAt: nowISO()
        };

        // record prediction to ML store (so we can tie later)
        try {
          const predRec = { id, symbol: state.symbol, label: z.side, price, createdAt: nowISO(), features: { tf:z.tf } };
          const predId = await recordPrediction(predRec);
          if (predId) pending.predId = predId;
        } catch(e){}

        // send pending alert (respect global rate limit)
        if (state.canSendGlobal()) {
          await state.onAlert(formatPendingMessage(pending));
          state.markSent();
        }
        // push pending and start async monitor
        state.pending.set(id, pending);
        state.setCooldown(key); // start zone cooldown immediately to avoid duplicates
        // kick background checker
        processPending(state, pending).catch(()=>{});
      }
    }

    // optionally send a periodic status summary (every statusEverySec)
    // maintained by separate timer below - so not here

  } catch (e) {
    // swallow and log (if you have logger, print)
    try { console.error("reversalWatcher tick err:", e?.message || e); } catch(e2){}
  }
}

export function startReversalWatcher(symbol = "BTCUSDT", options = {}, onAlert = async (msg)=>{ console.log(msg); }) {
  if (_watcher && _watcher.running) {
    console.log("Reversal watcher already running for", _watcher.symbol);
    return _watcher;
  }
  const opts = Object.assign({}, DEFAULTS, options || {});
  const state = new WatcherState(symbol, opts, onAlert);
  _watcher = state;
  state.running = true;

  // primary polling
  state.timer = setInterval(() => {
    tick(state).catch(()=>{});
  }, Math.max(2000, opts.pollIntervalMs || 20_000));
  // fire one immediate tick
  tick(state).catch(()=>{});

  // periodic status heartbeat (every opts.statusEverySec)
  state.statusTimer = setInterval(async () => {
    try {
      const summary = { symbol, pending: state.pending.size, confirmed: state.confirmed.size, globalRateLimitSec: state.opts.globalRateLimitSec };
      if (state.canSendGlobal()) {
        await state.onAlert(formatStatusMessage(summary));
        state.markSent();
      }
    } catch(e){}
  }, Math.max(60_000, opts.statusEverySec || 300_000));

  console.log("Reversal Watcher Started v3 for", symbol);
  return state;
}

export async function stopReversalWatcher() {
  if (!_watcher) return;
  try {
    _watcher.running = false;
    if (_watcher.timer) clearInterval(_watcher.timer);
    if (_watcher.statusTimer) clearInterval(_watcher.statusTimer);
    _watcher = null;
    console.log("Reversal Watcher stopped");
  } catch(e){}
}

export default { startReversalWatcher, stopReversalWatcher };