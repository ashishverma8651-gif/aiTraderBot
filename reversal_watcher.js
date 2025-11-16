// reversal_watcher_final_vC.js
// FINAL Reversal Watcher (Pro format - Option C)
// Single-file module. No duplicate helpers. Plug-and-play: pass your fetchMarketData & sendAlert.
// Usage (recommended):
//   const RW = require('./reversal_watcher_final_vC.js');
//   RW.startReversalWatcher('BTCUSDT', { fetchMarketData: myFetcher, mlModule: mlModuleObj, pollIntervalMs:20000 }, sendAlertFn);

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// -------------------------
// Configurable defaults
// -------------------------
const DEFAULTS = {
  tfs: ['1m','5m','15m'],
  weights: { '1m':0.25, '5m':0.35, '15m':0.4 },
  pollIntervalMs: 20000,
  minAlertConfidence: 65,
  mlWeight: 0.18,
  debounceSeconds: 180,
  confirmationCandles: 3,
  confirmationTF: '1m',
  mlGateMinProb: 55,
  microMlGateDelta: 4,
  feedbackWindowsSec: [60, 300],
  maxSavedAlerts: 2000,
  maxAlertsPerHour: 6,
  enablePatterns: true,
  enableIndicators: true,
  dataDir: path.resolve(process.cwd(), 'cache')
};

// -------------------------
// simple FS store & logs
// -------------------------
if (!fs.existsSync(DEFAULTS.dataDir)) fs.mkdirSync(DEFAULTS.dataDir, { recursive: true });
const STORE_FILE = path.join(DEFAULTS.dataDir, 'reversal_watcher_store_vC.json');
const LOG_FILE = path.join(DEFAULTS.dataDir, 'reversal_watcher_vC.log');

function appendLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e){}
  console.log(line);
}
function safeLoad(fp, fallback = {}) {
  try { if (!fs.existsSync(fp)) return fallback; return JSON.parse(fs.readFileSync(fp,'utf8')||'{}'); }
  catch(e){ return fallback; }
}
function safeSave(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj,null,2)); return true; } catch(e){ return false; }
}
let _store = safeLoad(STORE_FILE, { alerts: [], pending: [], hourly: [] });
_store.alerts = Array.isArray(_store.alerts) ? _store.alerts.slice(-DEFAULTS.maxSavedAlerts) : [];
_store.pending = Array.isArray(_store.pending) ? _store.pending : [];
_store.hourly = Array.isArray(_store.hourly) ? _store.hourly : [];

// -------------------------
// Internal state
// -------------------------
const _timers = new Map();
let _running = false;

// -------------------------
// Utilities: safe optional require for ML module
// -------------------------
function tryRequire(name) {
  try { return require(name); } catch(e) { return null; }
}

// -------------------------
// Minimal indicators (RSI, ATR, MACD hist) — local simple implementations
// These are intentionally lightweight approximations to avoid external deps.
// -------------------------
function computeRSIFromCloses(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains/period;
  const avgLoss = losses/period;
  if (avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeATRFromCandles(candles, period=14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  // simple ATR estimate: average of true ranges of last 'period' candles
  const trs = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i-1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trs.push(tr);
  }
  if (!trs.length) return 0;
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}

function computeMACDHist(closes, short=12, long=26, signal=9) {
  // approximate EMA-based MACD histogram (use simple EMA)
  if (!Array.isArray(closes) || closes.length < long + signal) return null;
  function ema(values, period) {
    const k = 2/(period+1);
    let emaPrev = values[0];
    for (let i=1;i<values.length;i++) {
      emaPrev = values[i]*k + emaPrev*(1-k);
    }
    return emaPrev;
  }
  const macdLine = ema(closes.slice(- (long+20)), short) - ema(closes.slice(- (long+20)), long);
  // signal on short series
  const signalLine = macdLine; // simplified fallback
  return { hist: (macdLine - signalLine) || 0, macd: macdLine, signal: signalLine };
}

// -------------------------
// Patterns (comprehensive)
// -------------------------
function detectPatterns(candles = []) {
  // returns array of { name, side, strength }
  const out = [];
  if (!Array.isArray(candles) || candles.length < 3) return out;
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const body = Math.max(1e-8, Math.abs(last.close - last.open));
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const ratioUpper = upperWick / body;
  const ratioLower = lowerWick / body;

  // Hammer / Hanging Man / Inverted Hammer
  if (ratioLower > 1.6 && ratioUpper < 0.6 && last.close > last.open) out.push({name:'Hammer', side:'Bullish', strength: Math.min(95, 30 + ratioLower*12)});
  if (ratioUpper > 1.6 && ratioLower < 0.6 && last.close < last.open) out.push({name:'ShootingStar', side:'Bearish', strength: Math.min(95, 30 + ratioUpper*12)});
  // Doji variations
  const bodyPct = body / Math.max(1e-8, last.high - last.low);
  if (bodyPct < 0.15) {
    // if low body close near high: Dragonfly
    if ((last.close - last.low) < (last.high - last.close) * 1.2) out.push({name:'DragonflyDoji', side:'Bullish', strength:40});
    // if open/close near high: Gravestone
    if ((last.high - last.close) < (last.close - last.low) * 1.2) out.push({name:'GravestoneDoji', side:'Bearish', strength:40});
    out.push({name:'Doji', side:'Neutral', strength:30});
  }
  // Engulfing
  const bullEngulf = (prev.close < prev.open) && (last.close > last.open) && (last.close > prev.open) && (last.open < prev.close);
  const bearEngulf = (prev.close > prev.open) && (last.close < last.open) && (last.open > prev.close) && (last.close < prev.open);
  if (bullEngulf) out.push({name:'BullishEngulfing', side:'Bullish', strength:65});
  if (bearEngulf) out.push({name:'BearishEngulfing', side:'Bearish', strength:65});
  // Morning/Evening star (three-candle)
  const morning = (prev2.close < prev2.open) && (prev.close < prev.open) && (last.close > last.open) && (last.close > prev2.close);
  const evening = (prev2.close > prev2.open) && (prev.close > prev.open) && (last.close < last.open) && (last.close < prev2.close);
  if (morning) out.push({name:'MorningStar', side:'Bullish', strength:70});
  if (evening) out.push({name:'EveningStar', side:'Bearish', strength:70});
  // Tweezers (top/bottom)
  if (Math.abs(prev.high - last.high) / Math.max(1, Math.abs(last.high)) < 0.0006 && last.close < last.open) out.push({name:'TweezerTop', side:'Bearish', strength:45});
  if (Math.abs(prev.low - last.low) / Math.max(1, Math.abs(last.low)) < 0.0006 && last.close > last.open) out.push({name:'TweezerBottom', side:'Bullish', strength:45});
  // Hanging man (red hammer near top)
  if (ratioLower > 1.6 && ratioUpper < 0.6 && last.close < last.open) out.push({name:'HangingMan', side:'Bearish', strength:50});
  return out;
}

// -------------------------
// Scoring per TF
// -------------------------
function computeTFScore({ candles = [], mlMicro = null, ell = null, tf = '15m', tfWeight = 1 }) {
  let score = 0;
  const reasons = [];
  const patterns = detectPatterns(candles);
  if (patterns.length) {
    const p = patterns[0];
    const pscore = Math.min(95, p.strength || 40);
    score += pscore;
    reasons.push(`pattern:${p.name}`);
  }

  // simple indicators
  try {
    const closes = (candles || []).map(c => Number(c.close));
    const rsi = computeRSIFromCloses(closes);
    const macd = computeMACDHist(closes);
    const atr = computeATRFromCandles(candles);

    if (typeof rsi === 'number') {
      if (rsi < 30) { score += 8; reasons.push('rsi_oversold'); }
      if (rsi > 70) { score -= 8; reasons.push('rsi_overbought'); }
    }
    if (macd && typeof macd.hist === 'number') {
      if (macd.hist > 0) { score += 5; reasons.push('macd_pos'); }
      else if (macd.hist < 0) { score -= 5; reasons.push('macd_neg'); }
    }
    if (typeof atr === 'number') reasons.push(`atr:${Math.round(atr)}`);
  } catch(e){}

  if (mlMicro && typeof mlMicro.prob === 'number') {
    // micro nudges ±10
    const p = (mlMicro.prob - 50)/100 * 20;
    score += p;
    reasons.push(`mlMicro:${mlMicro.prob}`);
  }

  const raw = Math.max(-100, Math.min(100, score));
  const norm = Math.round((raw + 100) / 2); // 0..100
  const weighted = norm * (tfWeight || 1);
  return { score: norm, weighted, reasons, patterns };
}

// -------------------------
// Consensus builder with ML main boost
// -------------------------
function buildConsensus(perTfResults = [], weights = DEFAULTS.weights, mlMain = null) {
  let sumW = 0, sumS = 0;
  const breakdown = [];
  for (const r of perTfResults) {
    const w = weights[r.tf] || 0.1;
    sumW += w;
    sumS += (r.score || 50) * w;
    breakdown.push({ tf: r.tf, score: r.score, patterns: r.patterns || [], reasons: r.reasons || []});
  }
  const avg = sumW ? (sumS / sumW) : 50;
  let boost = 0;
  if (mlMain && typeof mlMain.prob === 'number') {
    // convert mlMain prob (0..100) to -10..10 and scale by mlWeight
    boost = ((mlMain.prob - 50)/50) * (DEFAULTS.mlWeight * 100 / 2);
  }
  const final = Math.round(Math.max(0, Math.min(100, avg + boost)));
  const label = final >= 85 ? 'STRONG' : final >= 70 ? 'MODERATE' : final >= 55 ? 'WEAK' : 'NONE';
  return { final, label, breakdown, mlBoost: Math.round(boost*100)/100, mlMainLabel: mlMain?.label || null };
}

// -------------------------
// Debounce key & store helpers
// -------------------------
function makeDebounceKey(symbol, side, perTfResults) {
  const patterns = perTfResults.flatMap(r => (r.patterns||[]).map(p => `${r.tf}:${p.name}`)).sort().join('|') || 'NOPAT';
  const scores = perTfResults.map(r => `${r.tf}:${Math.round(r.score||50)}`).sort().join('|') || 'NOSCORE';
  const priceZone = Math.round((perTfResults[0]?.price || 0) / 10) || 'P0';
  return `${symbol}_${side}_${patterns}_${scores}_${priceZone}`;
}
function pruneStore() {
  _store.alerts = (_store.alerts||[]).slice(-DEFAULTS.maxSavedAlerts);
  _store.pending = (_store.pending||[]).filter(p => p && p.ts && (Date.now() - p.ts) < (24*60*60*1000));
  _store.hourly = (_store.hourly||[]).filter(h => (Date.now() - h.ts) < (60*60*1000));
}
function recentlyAlerted(key) {
  pruneStore();
  const cutoff = Date.now() - (DEFAULTS.debounceSeconds * 1000);
  _store.alerts = (_store.alerts||[]).filter(a => a.ts >= cutoff);
  return (_store.alerts||[]).some(a => a.key === key);
}
function recordSentAlert(key, meta={}) {
  _store.alerts = _store.alerts || [];
  _store.alerts.push(Object.assign({ key, ts: Date.now() }, meta));
  _store.alerts = _store.alerts.slice(-DEFAULTS.maxSavedAlerts);
  // hourly
  _store.hourly.push({ ts: Date.now() });
  pruneStore();
  safeSave(STORE_FILE, _store);
}

// -------------------------
// Outcome check (feedback -> ML)
async function checkOutcome(predId, symbol, side, priceAtSend, windowSec, fetchMarketDataFn, mlModule) {
  try {
    const resp = await fetchMarketDataFn(symbol, '1m', Math.max(3, Math.ceil(windowSec/60)+2));
    const newPrice = resp?.price ?? priceAtSend;
    const movedUp = newPrice > priceAtSend;
    const success = (side === 'Bullish') ? movedUp : (!movedUp);
    const realizedReturn = priceAtSend ? ((newPrice - priceAtSend)/Math.max(1, Math.abs(priceAtSend))) * 100 : null;
    // ML feedback
    if (predId && mlModule && typeof mlModule.recordOutcome === 'function') {
      try {
        mlModule.recordOutcome(predId, { correct: !!success, realizedReturn: typeof realizedReturn === 'number' ? realizedReturn : null, realizedPrice: newPrice });
      } catch(e){}
    }
    return { ok:true, predId, success, newPrice, realizedReturn };
  } catch(e) {
    return { ok:false, error: String(e) };
  }
}

// -------------------------
// Confirm across subsequent candles
async function confirmAcrossCandles(symbol, side, requiredCandles, confirmTF, fetchMarketDataFn) {
  const timeoutMs = Math.max(8000, requiredCandles * 60 * 1000); // reasonable cap
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    const resp = await fetchMarketDataFn(symbol, confirmTF, requiredCandles + 3);
    const candles = resp?.data || [];
    if (!Array.isArray(candles) || candles.length < requiredCandles) {
      await new Promise(r => setTimeout(r, 800));
      continue;
    }
    const recent = candles.slice(-requiredCandles);
    // assessment heuristic
    let support = 0;
    for (const c of recent) {
      const moveUp = c.close > c.open;
      if ((side === 'Bullish' && moveUp) || (side === 'Bearish' && !moveUp)) support++;
      // wick support
      const body = Math.max(1e-8, Math.abs(c.close - c.open));
      const upperWick = c.high - Math.max(c.close, c.open);
      const lowerWick = Math.min(c.close, c.open) - c.low;
      if (side === 'Bullish' && lowerWick > body * 1.6) support++;
      if (side === 'Bearish' && upperWick > body * 1.6) support++;
    }
    const needed = Math.ceil(recent.length * 0.6);
    const movePct = ((recent.at(-1).close - recent[0].close) / Math.max(1, Math.abs(recent[0].close))) * 100;
    return { confirmed: support >= needed, support, required: recent.length, movePct, recent };
  }
  return { confirmed:false, reason:'timeout' };
}

// -------------------------
// Main evaluation tick (single symbol)
async function evaluateSymbol(symbol, options, sendAlert) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const fetchMarketDataFn = opts.fetchMarketData || (async (s, tf, limit) => { throw new Error('fetchMarketData not provided'); });
  const mlModule = opts.mlModule || null;

  try {
    // fetch multi-TF candles
    const multi = {};
    for (const tf of opts.tfs) {
      try {
        const r = await fetchMarketDataFn(symbol, tf, Math.max( Math.max( opts.lookback || 60, 60) , opts.confirmationCandles+5 ));
        multi[tf] = r || { data: [], price: r?.price || 0 };
      } catch(e) { multi[tf] = { data: [], price:0 }; }
    }

    // main ML prediction (15m) best-effort
    let mlMain = null;
    try {
      if (mlModule && typeof mlModule.runMLPrediction === 'function') mlMain = await mlModule.runMLPrediction(symbol, '15m');
      else if (opts.runMLPrediction && typeof opts.runMLPrediction === 'function') mlMain = await opts.runMLPrediction(symbol, '15m');
    } catch(e) { mlMain = null; }

    const perTfResults = [];

    for (const tf of opts.tfs) {
      const entry = multi[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = entry.price || (candles.at(-1)?.close ?? 0);

      // micro ML
      let mlMicro = null;
      try {
        if (mlModule && typeof mlModule.runMicroPrediction === 'function' && (tf === '1m' || tf === '5m')) {
          mlMicro = await mlModule.runMicroPrediction(symbol, tf, opts.microLookback || 60);
        } else if (opts.runMicroPrediction && typeof opts.runMicroPrediction === 'function' && (tf==='1m'||tf==='5m')) {
          mlMicro = await opts.runMicroPrediction(symbol, tf, opts.microLookback || 60);
        }
      } catch(e){ mlMicro = null; }

      const weight = opts.weights && opts.weights[tf] ? opts.weights[tf] : DEFAULTS.weights[tf] || 0.1;
      const sc = computeTFScore({ candles, mlMicro, ell: null, tf, tfWeight: weight });
      perTfResults.push({ tf, price, candles, mlMicro, score: sc.score, weighted: sc.weighted, reasons: sc.reasons, patterns: sc.patterns });
    }

    const consensus = buildConsensus(perTfResults, opts.weights || DEFAULTS.weights, mlMain);

    // quick trend from higher TF
    let trend = 'FLAT';
    try {
      const hi = multi['1h'] || multi['15m'];
      const closes = (hi?.data || []).map(c => Number(c.close)).slice(-10);
      if (closes.length >= 2) {
        const last = closes.at(-1), prev = closes.at(-3) || closes.at(-2);
        trend = last > prev ? 'UP' : last < prev ? 'DOWN' : 'FLAT';
      }
    } catch(e){}

    // gating by ML main
    if (mlMain && typeof mlMain.prob === 'number') {
      if (mlMain.prob < (opts.mlGateMinProb || DEFAULTS.mlGateMinProb) && consensus.final < 95) {
        appendLog('ML gate blocked candidate', symbol, 'mlProb:', mlMain.prob, 'consensus:', consensus.final);
        return { alerted:false, reason:'ml_gate', consensus };
      }
    }

    const finalScore = consensus.final;

    // decide candidate threshold slightly lower to create pending confirmations
    const pendingThreshold = Math.max(40, (opts.minAlertConfidence || DEFAULTS.minAlertConfidence) - 10);

    if (finalScore >= pendingThreshold) {
      // side detection
      const bullCount = perTfResults.filter(r => (r.patterns||[]).some(p => p.side === 'Bullish')).length;
      const bearCount = perTfResults.filter(r => (r.patterns||[]).some(p => p.side === 'Bearish')).length;
      let side = 'Bullish';
      if (bullCount > bearCount) side = 'Bullish';
      else if (bearCount > bullCount) side = 'Bearish';
      else if (mlMain && mlMain.label) side = mlMain.label;
      else side = finalScore >= 50 ? 'Bullish' : 'Bearish';

      // debounce key
      const key = makeDebounceKey(symbol, side, perTfResults);

      // rate-limit hourly
      const recentHour = (_store.hourly||[]).filter(h => (Date.now() - h.ts) < (60*60*1000)).length;
      if (recentHour >= (opts.maxAlertsPerHour || DEFAULTS.maxAlertsPerHour)) {
        appendLog('rate limit reached, skip candidate', symbol);
        return { alerted:false, reason:'rate_limited' };
      }

      if (recentlyAlerted(key)) {
        appendLog('recently alerted, suppress', key);
        return { alerted:false, reason:'debounced' };
      }

      // if an identical pending exists skip
      if ((_store.pending||[]).some(p => p.key === key && p.status === 'pending')) {
        appendLog('already pending, skip', key);
        return { alerted:false, reason:'already_pending' };
      }

      // record prediction in ML storage if available
      let predId = null;
      try {
        if (mlModule && typeof mlModule.recordPrediction === 'function') {
          predId = await mlModule.recordPrediction({ symbol, predictedAt: new Date().toISOString(), label: side, prob: finalScore, meta:{ source:'reversal_final_vC' } });
        }
      } catch(e){ predId = null; }

      // create pending entry
      const pendingId = `pend_${Date.now()}_${Math.floor(Math.random()*9999)}`;
      const priceAtDetect = perTfResults[0]?.price || 0;
      const pendingObj = {
        id: pendingId,
        key, symbol, side, createdAt: new Date().toISOString(), ts: Date.now(),
        confirmedObserved: 0, requiredCandles: opts.confirmationCandles || DEFAULTS.confirmationCandles,
        confirmTF: opts.confirmationTF || DEFAULTS.confirmationTF,
        priceAtDetect, perTfResults, predId, status:'pending', consensusScore: finalScore
      };
      _store.pending.push(pendingObj);
      safeSave(STORE_FILE, _store);

      // send first (simple) alert — short, pro-format Option C, but mark it's a PENDING detection (simple output)
      const topPattern = (perTfResults.flatMap(r => r.patterns || []).at(0) || { name:'N/A' });
      const priceStr = Number(priceAtDetect).toFixed(2);
      const closesForVol = (perTfResults[0]?.candles || []).map(c => Number(c.close));
      const lastCl = perTfResults[0]?.candles?.at(-1) || null;
      const vol = lastCl ? (lastCl.vol || lastCl.volume || 'n/a') : 'n/a';
      const avgVol = Array.isArray(perTfResults[0]?.candles) && perTfResults[0].candles.length ? (perTfResults[0].candles.map(c=>Number(c.vol||c.volume||0)).reduce((a,b)=>a+b,0)/perTfResults[0].candles.length).toFixed(0) : 'n/a';
      const rsi = computeRSIFromCloses(closesForVol) || 'n/a';
      const macd = computeMACDHist(closesForVol)?.hist || 0;
      const mlProb = mlMain && typeof mlMain.prob === 'number' ? `${Math.round(mlMain.prob)}%` : 'N/A';

      const firstMsg = [
        `🚨 Reversal Watcher (PENDING) — ${side}`,
        `Time: ${new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata', hour12:true })}`,
        `Symbol: ${symbol}`,
        `Pattern: ${topPattern.name || 'N/A'}`,
        `Volume: ${vol} (avg ${avgVol})`,
        `RSI: ${typeof rsi === 'number' ? Math.round(rsi) : rsi}`,
        `MACD hist: ${typeof macd === 'number' ? macd.toFixed(3) : 'n/a'}`,
        `Price: ${priceStr}`,
        `ML Prob: ${mlProb}`,
        `ID: ${predId || 'none'}`
      ].join('\n');

      try { if (typeof sendAlert === 'function') await sendAlert(firstMsg); else appendLog('Would send (pending):', firstMsg); } catch(e){ appendLog('sendAlert error (pending):', String(e)); }

      appendLog('pending created', pendingId, 'key', key);
      return { alerted:false, reason:'pending_created', pendingId, key, consensus: finalScore };
    }

    return { alerted:false, reason:'below_threshold', score: finalScore };

  } catch(e) {
    appendLog('evaluateSymbol error', String(e));
    return { alerted:false, error:String(e) };
  }
}

// -------------------------
// Process pending items: confirmation checks & final send & feedback schedule
// -------------------------
async function processPendingAll(options, sendAlert) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const fetchMarketDataFn = opts.fetchMarketData || (async ()=>{ throw new Error('fetchMarketData not provided'); });
  const mlModule = opts.mlModule || null;

  const pendList = Array.isArray(_store.pending) ? _store.pending.slice() : [];
  for (const p of pendList) {
    try {
      if (!p || p.status !== 'pending') continue;
      // fetch confirmation TF candles (last requiredCandles)
      const resp = await fetchMarketDataFn(p.symbol, p.confirmTF || opts.confirmationTF, (p.requiredCandles || opts.confirmationCandles) + 3);
      const candles = resp?.data || [];
      if (!Array.isArray(candles) || candles.length < (p.requiredCandles || opts.confirmationCandles)) {
        continue; // not enough candles yet
      }
      const recent = candles.slice(- (p.requiredCandles || opts.confirmationCandles));
      const conf = (() => {
        // mimic confirmAcrossCandles logic quickly here
        let support = 0;
        for (const c of recent) {
          const moveUp = c.close > c.open;
          if ((p.side === 'Bullish' && moveUp) || (p.side === 'Bearish' && !moveUp)) support++;
          const body = Math.max(1e-8, Math.abs(c.close - c.open));
          const upperWick = c.high - Math.max(c.close, c.open);
          const lowerWick = Math.min(c.close, c.open) - c.low;
          if (p.side === 'Bullish' && lowerWick > body * 1.6) support++;
          if (p.side === 'Bearish' && upperWick > body * 1.6) support++;
        }
        const needed = Math.ceil(recent.length * 0.6);
        const movePct = ((recent.at(-1).close - recent[0].close) / Math.max(1, Math.abs(recent[0].close))) * 100;
        return { confirmed: support >= needed, support, needed, movePct, recent };
      })();

      if (conf.confirmed) {
        // micro ML gating: if micro ML strongly contradicts -> fail
        let microAvg = null;
        try {
          const microPromises = (p.perTfResults || []).filter(r => r.tf === '1m' || r.tf === '5m').map(async r => {
            if (r.mlMicro) return r.mlMicro;
            if (mlModule && typeof mlModule.runMicroPrediction === 'function') {
              try { return await mlModule.runMicroPrediction(p.symbol, r.tf, options.microLookback || 60); } catch(e){ return null; }
            }
            return null;
          });
          const microRes = await Promise.all(microPromises);
          const probs = microRes.filter(Boolean).map(m => (m.prob || 50));
          if (probs.length) microAvg = probs.reduce((a,b)=>a+b,0)/probs.length;
        } catch(e){ microAvg = null; }

        if (microAvg && p.side === 'Bullish' && microAvg < (50 - (opts.microMlGateDelta || DEFAULTS.microMlGateDelta))) {
          appendLog('micro ML blocked confirmed candidate (contradictory)', p.id, 'microAvg', microAvg);
          p.status = 'failed';
          p.closedAt = new Date().toISOString();
          safeSave(STORE_FILE, _store);
          // remove or keep for history
          _store.pending = _store.pending.filter(x => x.id !== p.id);
          safeSave(STORE_FILE, _store);
          continue;
        }
        if (microAvg && p.side === 'Bearish' && microAvg > (50 + (opts.microMlGateDelta || DEFAULTS.microMlGateDelta))) {
          appendLog('micro ML blocked confirmed candidate (contradictory)', p.id, 'microAvg', microAvg);
          p.status = 'failed';
          p.closedAt = new Date().toISOString();
          _store.pending = _store.pending.filter(x => x.id !== p.id);
          safeSave(STORE_FILE, _store);
          continue;
        }

        // Compose final Pro-format C alert (CONFIRMED)
        const price = p.priceAtDetect || (p.perTfResults?.[0]?.price || 0);
        const atr = computeATRFromCandles(p.perTfResults?.[0]?.candles || []);
        const tp1 = (price + Math.max(1,atr)*2).toFixed(2);
        const tp2 = (price + Math.max(1,atr)*4).toFixed(2);
        const slLong = (price - Math.max(1,atr)*2).toFixed(2);
        const slShort = (price + Math.max(1,atr)*2).toFixed(2);
        const msgLines = [
          `⚡ Reversed (CONFIRMED) — ${p.side}`,
          `Symbol: ${p.symbol} | Confidence: ${Math.round(p.consensusScore||0)}%`,
          `PriceAtDetect: ${Number(price).toFixed(2)} | TP(s): ${tp1} / ${tp2}`,
          `SLs: LONG:${slLong} / SHORT:${slShort}`,
          `Observed: ${conf.support}/${conf.needed} supportive signals | movePct: ${conf.movePct.toFixed(3)}%`,
          `ID: ${p.predId || 'none'}`
        ];
        const text = msgLines.join('\n');
        try { if (typeof sendAlert === 'function') await sendAlert(text); else appendLog('Would send (confirmed):', text); } catch(e){ appendLog('sendAlert error (confirmed):', String(e)); }

        // mark sent & feedback
        recordSentAlert(p.key, { symbol: p.symbol, side: p.side, predId: p.predId || null, score: p.consensusScore });
        p.status = 'sent';
        p.sentAt = new Date().toISOString();
        safeSave(STORE_FILE, _store);

        // schedule feedback windows
        (opts.feedbackWindowsSec || DEFAULTS.feedbackWindowsSec).forEach(win => {
          setTimeout(async () => {
            try {
              const res = await checkOutcome(p.predId, p.symbol, p.side, p.priceAtDetect, win, fetchMarketDataFn, mlModule);
              appendLog('feedback result', p.id, JSON.stringify(res));
              p.status = (res.ok && res.success) ? 'done' : 'failed';
              p.closedAt = new Date().toISOString();
              p.outcome = res;
              safeSave(STORE_FILE, _store);
              // optionally remove after short delay
              setTimeout(()=> {
                _store.pending = _store.pending.filter(x => x.id !== p.id);
                safeSave(STORE_FILE, _store);
              }, 3000);
            } catch(e){ appendLog('feedback scheduling error', String(e)); }
          }, win*1000);
        });

      } else {
        // not confirmed — increment observed counter and decide fail after some attempts
        p.confirmedObserved = (p.confirmedObserved || 0) + 1;
        p.lastCheck = new Date().toISOString();
        if (p.confirmedObserved > ((opts.maxPendingWaits || 6) + (p.requiredCandles||opts.confirmationCandles))) {
          appendLog('pending expired no confirmation', p.id);
          p.status = 'failed';
          p.closedAt = new Date().toISOString();
          // remove pending
          _store.pending = _store.pending.filter(x => x.id !== p.id);
          safeSave(STORE_FILE, _store);
        } else {
          // update store and continue
          safeSave(STORE_FILE, _store);
        }
      }
    } catch(e) {
      appendLog('processPending error', String(e));
    }
  }
}

// -------------------------
// Public API: start/stop/getState
// -------------------------
function startReversalWatcher(symbol = 'BTCUSDT', options = {}, sendAlert = null) {
  if (_timers.has(symbol)) {
    appendLog('Watcher already running for', symbol);
    return false;
  }
  const opts = Object.assign({}, DEFAULTS, options || {});
  appendLog('Starting Reversal Watcher FINAL vC for', symbol, 'opts:', JSON.stringify({ tfs: opts.tfs, pollIntervalMs: opts.pollIntervalMs }));

  // main tick
  const tick = async () => {
    try { await evaluateSymbol(symbol, opts, sendAlert); } catch(e){ appendLog('tick error', String(e)); }
  };
  // pending tick
  const pendTick = async () => {
    try { await processPendingAll(opts, sendAlert); pruneStore(); } catch(e){ appendLog('pendTick error', String(e)); }
  };

  // run once immediately then schedule
  tick();
  const idMain = setInterval(tick, opts.pollIntervalMs || DEFAULTS.pollIntervalMs);
  const idPend = setInterval(pendTick, Math.max(8*1000, Math.round((opts.pendingIntervalMs||15000))));

  _timers.set(symbol, { idMain, idPend });
  _running = true;
  return true;
}

function stopReversalWatcher(symbol = null) {
  try {
    if (symbol) {
      const rec = _timers.get(symbol);
      if (rec) { if (rec.idMain) clearInterval(rec.idMain); if (rec.idPend) clearInterval(rec.idPend); _timers.delete(symbol); }
    } else {
      for (const [s, rec] of _timers.entries()) { if (rec.idMain) clearInterval(rec.idMain); if (rec.idPend) clearInterval(rec.idPend); _timers.delete(s); }
    }
    _running = _timers.size > 0;
    appendLog('Stopped watcher for', symbol || 'ALL');
    return true;
  } catch(e){ appendLog('stop error', String(e)); return false; }
}

function getWatcherState() {
  pruneStore();
  return {
    running: _running,
    symbols: Array.from(_timers.keys()),
    pending: (_store.pending || []).slice(-50),
    recentAlerts: (_store.alerts || []).slice(-50),
    hourlyCount: (_store.hourly||[]).filter(h => (Date.now() - h.ts) < (60*60*1000)).length
  };
}

// Export CommonJS
module.exports = {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherState,
  // also export internal helpers for testing or advanced integration
  _internal: {
    computeRSIFromCloses, computeATRFromCandles, computeMACDHist, detectPatterns, computeTFScore, buildConsensus
  }
};