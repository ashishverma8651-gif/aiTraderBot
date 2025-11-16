// reversal_watcher_v3.js
// Single-file Reversal Watcher v3 (5m+15m main, 1m micro confirmation + micro-ML)
// Drop-in replacement: exports startReversalWatcher, stopReversalWatcher, getWatcherState
//
// Depends on:
//  - ./config.js (CONFIG.SYMBOL optional)
//  - ./utils.js -> fetchMarketData(symbol, tf, limit), fetchMultiTF(symbol, [tfs])
//  - ./core_indicators.js -> computeRSI, computeMACD, computeATR, volumeTrend (optional)
//  - ./elliott_module.js -> analyzeElliott (optional)
//  - ./ml_module_v8_6.js -> runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome, calculateAccuracy

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

// --------------------
// Storage & defaults
// --------------------
const DATA_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_PATH = path.join(DATA_DIR, "reversal_watcher_v3_store.json");

function safeLoad(fp, def = {}) {
  try { if (!fs.existsSync(fp)) return def; return JSON.parse(fs.readFileSync(fp, "utf8") || "{}"); } catch { return def; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
}

const DEFAULTS = Object.assign({
  tfs: ["5m", "15m"],           // primary analysis TFs
  entryTf: "5m",                // entry zone TF
  confirmTf: "1m",              // fast confirmation TF
  pollIntervalMs: 20 * 1000,
  pendingThreshold: 58,         // consensus -> pending start
  confirmCandles: 2,            // closed 1m candles to confirm
  microMlImmediatePct: 65,      // if micro-ml prob >= this then immediate confirm
  cooldownSeconds: 120,
  debounceSeconds: 90,
  slAtrMul: 2,
  tpAtrMuls: [2,4],
  volumeMultiplier: 0.8,
  maxPendingAgeMs: 60*60*1000,
  feedbackWindowsSec: [60, 300],
  allowNeutral: true
}, CONFIG.REVERSAL_WATCHER_V3 || {});

let STORE = safeLoad(STORE_PATH, { recent: [], pending: [], hourly: [] });
STORE.recent = Array.isArray(STORE.recent) ? STORE.recent.slice(-1000) : [];
STORE.pending = Array.isArray(STORE.pending) ? STORE.pending : [];
STORE.hourly = Array.isArray(STORE.hourly) ? STORE.hourly : [];

// --------------------
// Helpers
// --------------------
function now() { return Date.now(); }
function nowStr() { return new Date().toISOString(); }
function recordHourly() {
  const t = now();
  STORE.hourly.push(t);
  STORE.hourly = STORE.hourly.filter(x => x >= t - 3600000);
  safeSave(STORE_PATH, STORE);
}
function hourlyCount() { return STORE.hourly.length; }
function pruneRecent() {
  const cutoff = now() - DEFAULTS.debounceSeconds*1000;
  STORE.recent = STORE.recent.filter(r => r.ts >= cutoff);
}
function addRecent(key) {
  STORE.recent.push({ key, ts: now() });
  STORE.recent = STORE.recent.slice(-1000);
  recordHourly();
  safeSave(STORE_PATH, STORE);
}
function recentlyAlerted(key) { pruneRecent(); return STORE.recent.some(r => r.key === key); }

function makeKey(symbol, side, zone, price) {
  const bucket = Math.round((price||0)/Math.max(1, Math.abs(price||1))*100);
  return `${symbol}|${side}|${zone}|${bucket}`;
}

// pattern detection (light, used by consensus)
function detectBasicPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return [];
  const last = candles.at(-1), prev = candles.at(-2), prev2 = candles.at(-3);
  const patterns = [];
  const body = Math.abs(last.close - last.open) || 1;
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;

  if (lower > body*1.6 && upper < body*0.6 && last.close > last.open) patterns.push({name:"Hammer", side:"Bullish", strength:70});
  if (upper > body*1.6 && lower < body*0.6 && last.close < last.open) patterns.push({name:"ShootingStar", side:"Bearish", strength:70});
  if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) patterns.push({name:"BullishEngulfing", side:"Bullish", strength:65});
  if (prev.close > prev.open && last.close < last.open && last.open > prev.close && last.close < prev.open) patterns.push({name:"BearishEngulfing", side:"Bearish", strength:65});
  if (body / ((last.high - last.low)||1) < 0.2) patterns.push({name:"Doji", side:"Neutral", strength:40});
  return patterns;
}

// compute score per TF
function computeTfScore(candles, weight=1) {
  const out = { score:50, reasons:[], patterns:[] };
  if (!candles || candles.length < 3) return out;
  const patterns = detectBasicPatterns(candles);
  if (patterns.length) { const p = patterns[0]; out.patterns.push(p); out.score += (p.side==="Bullish"? p.strength/2: -p.strength/2); out.reasons.push("pattern:"+p.name); }

  try {
    const rsi = typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : 50;
    const macd = typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : {hist:0};
    const last = candles.at(-1);
    const vol = (last && (last.vol||last.v||last.volume)) || 0;
    const window = Math.min(20, candles.length);
    const avgVol = candles.slice(-window).reduce((s,c)=> s + ((c.vol||c.v||c.volume)||0), 0) / Math.max(1, window);

    if (rsi < 30) { out.score += 8; out.reasons.push("rsi_oversold"); }
    if (rsi > 70) { out.score -= 8; out.reasons.push("rsi_overbought"); }
    if (macd && typeof macd.hist === "number") { out.score += macd.hist > 0 ? 6 : -6; out.reasons.push("macd"); }
    if (avgVol && vol) {
      if (vol > avgVol * DEFAULTS.volumeMultiplier) { out.score += 6; out.reasons.push("vol_spike"); }
      if (vol < avgVol*0.6) { out.score -= 3; out.reasons.push("vol_drop"); }
    }
  } catch(e){}

  out.score = Math.round(Math.max(0, Math.min(100, out.score)) * (weight||1));
  return out;
}

// consensus across tfs
function buildConsensus(perTfResults, weights = {}) {
  let sumW = 0, sumS = 0;
  for (const r of perTfResults) {
    const w = weights[r.tf] ?? 1;
    sumW += w;
    sumS += (r.score||50) * w;
  }
  const avg = sumW ? sumS/sumW : 50;
  return Math.round(Math.max(0, Math.min(100, avg)));
}

// targets / SL builder (ATR + Elliott if available)
function buildTargets({ price, atr, ellObj=null }) {
  const tps = [];
  if (ellObj && Array.isArray(ellObj.targets) && ellObj.targets.length) {
    ellObj.targets.slice(0,3).forEach(t => {
      const tpVal = Number(t.tp || t.target || t.price || 0);
      if (tpVal) tps.push({ source:"Elliott", tp: tpVal, confidence: t.confidence || 50 });
    });
  }
  if (!tps.length) {
    for (const m of DEFAULTS.tpAtrMuls) tps.push({ source:"ATR", tp: Number((price + (atr||1)*m).toFixed(2)), confidence:40 });
  }
  const slLong = Number((price - (atr||1)*DEFAULTS.slAtrMul).toFixed(2));
  const slShort = Number((price + (atr||1)*DEFAULTS.slAtrMul).toFixed(2));
  return { tps, sls: [ {side:"LONG", sl: slLong}, {side:"SHORT", sl: slShort} ] };
}

// --------------------
// Evaluate symbol -> create pending
// --------------------
async function evaluateSymbol(symbol, opts, sendAlert) {
  // returns object with status
  try {
    const tfs = opts.tfs || DEFAULTS.tfs;
    const multi = await fetchMultiTF(symbol, tfs.concat([opts.entryTf, opts.confirmTf]).filter((v,i,a)=>a.indexOf(v)===i));
    // compute per tf scores (primary tfs only)
    const per = [];
    for (const tf of tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price ?? (candles.at(-1)?.close ?? 0);
      const weight = (tf === "15m") ? 1.2 : 1.0;
      const s = computeTfScore(candles, weight);
      per.push({ tf, score: s.score, patterns: s.patterns, price, candles });
    }

    const consensus = buildConsensus(per, opts.weights || { "5m":1, "15m":1.2 });
    if (consensus < (opts.pendingThreshold ?? DEFAULTS.pendingThreshold)) return { alerted:false, reason:"below_threshold", score:consensus };

    // decide side by pattern majority and simple trend
    let bull=0, bear=0;
    for (const p of per.flatMap(x=>x.patterns||[])) { if (p.side==="Bullish") bull++; if (p.side==="Bearish") bear++; }
    // trend via 15m slope if available
    let trend = "FLAT";
    try {
      const c15 = per.find(x=>x.tf==="15m")?.candles || [];
      if (c15.length >= 3) { const s = c15.at(-1).close - c15.at(-3).close; trend = s>0 ? "UP" : s<0 ? "DOWN" : "FLAT"; }
    } catch {}

    let side = "Bullish";
    if (bear > bull) side = "Bearish";
    else if (bull === bear) side = (trend==="UP" ? "Bullish" : trend==="DOWN" ? "Bearish" : "Bullish");

    // entry zone: recent 5m candle high/low +/- small buffer
    const entryTf = opts.entryTf || DEFAULTS.entryTf;
    const entryCandles = (multi[entryTf] && Array.isArray(multi[entryTf].data)) ? multi[entryTf].data : [];
    const lastEntry = entryCandles.at(-1) || {};
    const zoneHigh = lastEntry.high || lastEntry.close || 0;
    const zoneLow = lastEntry.low || lastEntry.close || 0;
    const priceRef = per[0]?.price ?? (zoneHigh || zoneLow || 0);
    const zoneName = `${entryTf}_${Math.round(zoneLow)}_${Math.round(zoneHigh)}`;
    const key = makeKey(symbol, side, zoneName, priceRef);

    // debounce / rate
    if (recentlyAlerted(key)) return { alerted:false, reason:"debounced" };
    if (hourlyCount() > 500) return { alerted:false, reason:"rate_limit" }; // safe guard

    // micro-ML immediate check: if micro predicts strongly same side, confirm immediately
    let micro = null;
    try {
      micro = await runMicroPrediction(symbol, opts.microLookbackSec || 60);
    } catch {}
    const microStrong = micro && typeof micro.prob === "number" && micro.prob >= (opts.microMlImmediatePct || DEFAULTS.microMlImmediatePct) &&
                        ((side === "Bullish" && (micro.label||"").toLowerCase().includes("bull")) || (side==="Bearish" && (micro.label||"").toLowerCase().includes("bear")));

    // create pending record
    const id = `pend_v3_${Date.now()}_${Math.floor(Math.random()*9000)}`;
    const pending = {
      id, key, symbol, side, createdAt: now(), priceAtDetect: priceRef,
      zone: { high: zoneHigh, low: zoneLow, tf: entryTf }, consensus, perTf: per,
      predId: null, status: "pending", requiredCandles: opts.confirmCandles || DEFAULTS.confirmCandles,
      confirmationTf: opts.confirmTf || DEFAULTS.confirmTf
    };

    // record pred (if recordPrediction exists)
    try {
      pending.predId = await recordPrediction({
        symbol, predictedAt: nowStr(), label: side, prob: consensus, features: { perTf: per.map(p=>({tf:p.tf,score:p.score})) }, meta:{source:"rev_watcher_v3"}
      });
    } catch { pending.predId = null; }

    STORE.pending = STORE.pending || [];
    STORE.pending.push(pending);
    safeSave(STORE_PATH, STORE);

    // build preview alert
    let atr = 0;
    try { atr = indicators.computeATR(per.find(x=>x.tf==="15m")?.candles || []) || 0; } catch {}
    let ell = null;
    try { ell = await analyzeElliott(per.find(x=>x.tf==="15m")?.candles || []); } catch {}
    const { tps, sls } = buildTargets({ price: priceRef, atr, ellObj: ell && ell.ok ? ell : null });

    const previewMsg = [
      `⚡ <b>REVERSAL DETECTED (PENDING)</b> — <b>${side}</b>`,
      `Symbol: <b>${symbol}</b> | Zone: ${entryTf} ${zoneLow} - ${zoneHigh}`,
      `Score: <b>${consensus}%</b> | Price: ${Number(priceRef).toFixed(4)}`,
      `Top TPs: ${tps.slice(0,2).map(x=>`${x.tp}(${x.source})`).join(" / ")}`,
      `SLs: ${sls.map(s=>s.sl).join(" / ")}`,
      `MicroML: ${micro ? `${micro.label} ${Math.round(micro.prob)}%` : "N/A"}`,
      `PendingID: ${id}`
    ].join("\n");

    // send preview
    try { if (typeof sendAlert === "function") await sendAlert(previewMsg); } catch(e){}

    // if micro strong -> immediate confirm shortcut
    if (microStrong) {
      // mark confirmed and send final immediately
      const confirmed = {
        ...pending,
        status: "confirmed_micro",
        confirmedAt: now(),
        confirmedBy: "microML"
      };
      // create final message
      const finalMsg = [
        `🟢 <b>REVERSAL CONFIRMED (MICRO ML)</b> — <b>${side}</b>`,
        `Symbol: <b>${symbol}</b> | Zone: ${entryTf} ${zoneLow} - ${zoneHigh}`,
        `Detected: ${Number(priceRef).toFixed(4)} | MicroML: ${micro.label} ${Math.round(micro.prob)}%`,
        `TPs: ${tps.map(x=>x.tp).join(" / ")}`,
        `SLs: ${sls.map(x=>x.sl).join(" / ")}`,
        `ID: ${id}`
      ].join("\n");
      try { if (typeof sendAlert === "function") await sendAlert(finalMsg); } catch(e){}
      // update store/outcome
      addRecent(key);
      updatePendingStatus(id, "sent_micro");
      if (pending.predId) {
        try { await recordOutcome(pending.predId, { correct: true, realizedPrice: priceRef }); } catch {}
      }
      // schedule post-feedback checks
      scheduleFeedbackChecks(pending, opts, sendAlert);
      return { alerted:true, pendingId:id, microConfirmed:true };
    }

    return { alerted:true, pendingId:id, microConfirmed:false };
  } catch (e) {
    return { alerted:false, error: String(e) };
  }
}

// --------------------
// Pending processor: confirm and finalize
// --------------------
async function confirmPendingRecord(p) {
  // uses confirmationTF and requiredCandles
  try {
    const tf = p.confirmationTf || DEFAULTS.confirmTf;
    const req = p.requiredCandles || DEFAULTS.confirmCandles;
    const resp = await fetchMarketData(p.symbol, tf, req + 3);
    const candles = resp?.data || [];
    const closed = candles.slice(-(req+1), -1);
    if (closed.length < req) return { ok:false, reason:"not_enough_closed" };

    // simple supportive votes
    let support = 0;
    for (const c of closed) {
      const up = c.close > c.open;
      const body = Math.abs(c.close - c.open) || 1;
      const lowWick = Math.min(c.open,c.close) - c.low;
      const upWick = c.high - Math.max(c.open,c.close);

      if (p.side === "Bullish" && up) support++;
      if (p.side === "Bearish" && !up) support++;
      if (p.side === "Bullish" && lowWick > body*1.5) support++;
      if (p.side === "Bearish" && upWick > body*1.5) support++;
    }
    const need = Math.ceil(closed.length * 0.6);
    const ok = support >= need;

    return { ok, support, need, closedLast: closed.at(-1), movedPct: ((closed.at(-1).close - closed[0].close)/Math.max(1, Math.abs(closed[0].close))) * 100 };
  } catch (e) {
    return { ok:false, reason: String(e) };
  }
}

function updatePendingStatus(id, status, extra={}) {
  STORE.pending = STORE.pending || [];
  for (let i=0;i<STORE.pending.length;i++) {
    if (STORE.pending[i].id === id) {
      STORE.pending[i].status = status;
      if (extra) STORE.pending[i].meta = Object.assign({}, STORE.pending[i].meta || {}, extra);
      STORE.pending[i].closedAt = now();
      break;
    }
  }
  safeSave(STORE_PATH, STORE);
}
function removePending(id) {
  STORE.pending = (STORE.pending||[]).filter(x=>x.id!==id);
  safeSave(STORE_PATH, STORE);
}
function scheduleFeedbackChecks(pending, opts={}, sendAlert=async()=>{}) {
  const wins = opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec;
  wins.forEach(win=>{
    setTimeout(async ()=>{
      try {
        const outcome = await checkPostOutcome(pending, win);
        updatePendingStatus(pending.id, outcome.success ? "done" : "failed", outcome);
        if (pending.predId) {
          try { await recordOutcome(pending.predId, { correct: !!outcome.success, realizedReturn: outcome.realizedReturn, realizedPrice: outcome.newPrice }); } catch {}
        }
        // optionally send short feedback alert
        try { if (typeof sendAlert === "function") await sendAlert(`🧾 Feedback: ${pending.symbol} ${pending.side} -> ${outcome.success ? "SUCCESS":"FAIL"} | window ${win}s`); } catch {}
        // remove after small delay
        setTimeout(()=> removePending(pending.id), 2000);
      } catch(e){}
    }, win*1000);
  });
}

async function checkPostOutcome(pending, windowSec) {
  try {
    const resp = await fetchMarketData(pending.symbol, "1m", Math.max(3, Math.ceil(windowSec/60)+2));
    const newPrice = resp?.price ?? null;
    const orig = pending.priceAtDetect || (pending.perTf && pending.perTf[0] && pending.perTf[0].price) || 0;
    const success = pending.side === "Bullish" ? (newPrice > orig) : (newPrice < orig);
    const realizedReturn = orig ? ((newPrice - orig) / Math.max(1, Math.abs(orig))) * 100 : null;
    return { ok:true, predId: pending.predId, windowSec, priceAtSend: orig, newPrice, success, realizedReturn };
  } catch (e) { return { ok:false, error: String(e) }; }
}

// --------------------
// processAllPending loop
// --------------------
async function processAllPending(sendAlert, opts={}) {
  const list = Array.isArray(STORE.pending) ? STORE.pending.slice() : [];
  for (const p of list) {
    try {
      if (now() - (p.createdAt||0) > (opts.maxPendingAgeMs||DEFAULTS.maxPendingAgeMs)) {
        updatePendingStatus(p.id, "expired");
        removePending(p.id);
        continue;
      }
      const conf = await confirmPendingRecord(p);
      if (!conf.ok) {
        if (conf.reason === "not_enough_closed") continue;
        // failed: notify & record outcome
        try { if (typeof sendAlert === "function") await sendAlert(`🔴 <b>REVERSAL FAILED</b> ${p.symbol} ${p.side}\nReason: ${conf.reason || "invalidated"}`); } catch {}
        if (p.predId) { try { await recordOutcome(p.predId, { correct:false, realizedPrice: conf.closedLast?.close || null }); } catch {} }
        updatePendingStatus(p.id, "failed", conf);
        removePending(p.id);
        continue;
      }
      // confirmed -> final alert
      const lastClose = conf.closedLast.close;
      const atr = (()=>{ try { return indicators.computeATR(p.perTf.find(x=>x.tf==="15m")?.candles||[]) || 0; } catch(e){ return 0; } })();
      let ell = null;
      try { ell = await analyzeElliott(p.perTf.find(x=>x.tf==="15m")?.candles || []); } catch {}
      const { tps, sls } = buildTargets({ price: p.priceAtDetect || lastClose, atr, ellObj: ell && ell.ok ? ell : null });

      const finalMsg = [
        `🟢 <b>REVERSAL CONFIRMED</b> — <b>${p.side}</b>`,
        `Symbol: <b>${p.symbol}</b> | Price: ${Number(lastClose).toFixed(4)}`,
        `TPs: ${tps.map(x=>x.tp).join(" / ")}`,
        `SLs: ${sls.map(x=>x.sl).join(" / ")}`,
        `Support: ${conf.support}/${conf.need} | movedPct: ${conf.movedPct.toFixed(3)}%`,
        `ID: ${p.id}`
      ].join("\n");

      try { if (typeof sendAlert === "function") await sendAlert(finalMsg); } catch {}

      updatePendingStatus(p.id, "sent_confirm");
      addRecent(p.key);
      // schedule feedback checks
      scheduleFeedbackChecks(p, opts, sendAlert);
    } catch(e) {
      // swallow
    }
  }
}

// --------------------
// Public start/stop
// --------------------
let _timers = new Map();

export function startReversalWatcher(symbol = CONFIG.SYMBOL, options = {}, sendAlert = async ()=>{}) {
  if (_timers.has(symbol)) return false;
  const opts = Object.assign({}, DEFAULTS, options || {});
  // tick: detect candidates
  const tick = async ()=> {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch(e){ /* swallow */ }
  };
  // pend processor
  const pend = async ()=> {
    try { await processAllPending(sendAlert, opts); } catch(e){ /* swallow */ }
  };

  // run immediately
  tick();
  const t1 = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  const t2 = setInterval(pend, Math.max(5000, Math.floor((opts.confirmCandles||2)*15000))); // frequent pend checks
  _timers.set(symbol, { t1, t2 });
  return true;
}

export async function stopReversalWatcher(symbol=null) {
  if (symbol) {
    const rec = _timers.get(symbol);
    if (rec) { clearInterval(rec.t1); clearInterval(rec.t2); _timers.delete(symbol); }
  } else {
    for (const [k, rec] of _timers.entries()) { clearInterval(rec.t1); clearInterval(rec.t2); _timers.delete(k); }
  }
  return true;
}

export function getWatcherState() {
  return {
    running: _timers.size > 0,
    symbols: Array.from(_timers.keys()),
    pending: STORE.pending.slice(-50),
    recent: STORE.recent.slice(-50),
    accuracy: (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 }
  };
}

export default { startReversalWatcher, stopReversalWatcher, getWatcherState };