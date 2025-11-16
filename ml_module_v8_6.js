// ml_module_v17.js — ML Engine v17 (fixed labels, safer nudges, small improvements)
// Replace previous ml_module_v8_6.js with this file (or update imports).
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import * as indicators from "./core_indicators.js";
import newsModule from "./news_social.js";

// ---------- storage ----------
const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const MODEL_FILE = path.join(CACHE_DIR, "ml_model_v17.json");
const PREDICTIONS_FILE = path.join(CACHE_DIR, "ml_predictions_v17.json");
const FEEDBACK_FILE = path.join(CACHE_DIR, "ml_feedback_v17.json");
const HISTORY_FILE = path.join(CACHE_DIR, "ml_history_v17.json");

// ---------- defaults (balanced) ----------
const DEFAULTS = {
  epochs: Number(CONFIG.ML?.EPOCHS ?? 25),
  lr: Number(CONFIG.ML?.LEARNING_RATE ?? 0.02),
  lookback: Number(CONFIG.ML?.LOOKBACK ?? 200),
  microLookback: Number(CONFIG.ML?.MICRO_LOOKBACK ?? 80),
  horizon: Number(CONFIG.ML?.HORIZON ?? 3),
  maxSamples: Number(CONFIG.ML?.MAX_SAMPLES ?? 300),
  autoRetrainHours: Number(CONFIG.ML?.RETRAIN_INTERVAL_HOURS ?? 12),
  autoTrainOnStart: CONFIG.ML?.AUTO_TRAIN_ON_START ?? true,
  microWatcherEnabled: CONFIG.ML?.MICRO_WATCHER ?? false,
  microWatcherIntervalSeconds: Number(CONFIG.ML?.MICRO_WATCHER_INTERVAL_SECONDS ?? 30),
  newsFeatureEnabled: CONFIG.ML?.NEWS_FEATURES ?? true,
  newsTopicFromSymbol: CONFIG.ML?.NEWS_TOPIC_FROM_SYMBOL ?? true,
  // conservative nudges
  newsNudge: Number(CONFIG.ML?.NEWS_NUDGE ?? 0.02),       // default 0.02 (was 0.05)
  ellNudgeFactor: Number(CONFIG.ML?.ELL_NUDGE ?? 0.02),   // small nudge from ell confidence
  microPatternNudge: 0.04                                // small micro-pattern nudge
};

// ---------- small JSON helpers ----------
function safeJSONLoad(fp, fallback = null) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    const txt = fs.readFileSync(fp, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.warn("ml_v17.safeJSONLoad:", e?.message || e);
    return fallback;
  }
}
function safeJSONSave(fp, data) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("ml_v17.safeJSONSave:", e?.message || e);
    return false;
  }
}

// ---------- math ----------
const sigmoid = x => 1 / (1 + Math.exp(-x));
const nowISO = () => new Date().toISOString();

// ---------- model helpers ----------
function initModel(dim) {
  const w = Array.from({ length: dim }, () => (Math.random() - 0.5) * 0.01);
  const b = 0;
  return { w, b, dim, trainedAt: nowISO() };
}
function predictRaw(model, x) {
  if (!model || !Array.isArray(model.w)) return 0.5;
  let s = model.b || 0;
  for (let i = 0; i < model.w.length && i < x.length; i++) s += (model.w[i] || 0) * (x[i] || 0);
  return sigmoid(s);
}
function updateSGD(model, x, y, lr = 0.02) {
  const p = predictRaw(model, x);
  const e = p - y;
  // gradient descent step (logistic loss derivative approximation)
  for (let i = 0; i < model.w.length && i < x.length; i++) model.w[i] -= lr * e * (x[i] || 0);
  model.b -= lr * e;
}

// ---------- news helper (best-effort, lightweight) ----------
async function safeFetchNewsFeatures(symbol) {
  if (!DEFAULTS.newsFeatureEnabled || !newsModule || typeof newsModule.fetchNewsBundle !== "function") return { newsScore: 0, newsAbs: 0, raw: null };
  try {
    let topic = String(symbol || "BTCUSDT").toUpperCase().replace(/[^A-Z]/g, "");
    if (DEFAULTS.newsTopicFromSymbol) topic = topic.length > 3 ? topic.slice(0,3) : (topic || "BTC");
    const n = await newsModule.fetchNewsBundle(topic);
    if (!n || !n.ok) return { newsScore: 0, newsAbs: 0, raw: n };
    const newsScore = ( (typeof n.sentiment === "number") ? (n.sentiment * 2 - 1) : 0 );
    const newsAbs = Math.min(1, Math.abs(newsScore));
    return { newsScore, newsAbs, raw: n };
  } catch (e) {
    console.warn("ml_v17.safeFetchNewsFeatures err", e?.message || e);
    return { newsScore: 0, newsAbs: 0, raw: null };
  }
}

// ---------- feature extraction (single-window) ----------
export async function extractFeatures(symbol, interval = "15m", lookback = DEFAULTS.lookback) {
  try {
    const resp = await fetchMarketData(symbol, interval, Math.max(lookback, 60));
    const data = resp?.data || [];
    if (!Array.isArray(data) || data.length < 30) return null;

    const closes = data.map(c => Number(c.close ?? c.c ?? 0));
    const vols = data.map(c => Number(c.vol ?? c.v ?? c.volume ?? 0));
    const lastClose = closes.at(-1) ?? 0;
    const lastVol = vols.at(-1) ?? 0;

    const avgVol = vols.reduce((a,b)=>a+b,0)/Math.max(1,vols.length);
    const volChange = avgVol ? (lastVol - avgVol) / avgVol : 0;

    const returns = [];
    for (let i=1;i<closes.length;i++) returns.push((closes[i]-closes[i-1]) / Math.max(1, Math.abs(closes[i-1])));
    const avgRet = returns.length ? returns.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,returns.length) : 0;

    let rsi=50, macdHist=0, atr=0;
    try {
      if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(data,14);
      if (typeof indicators.computeMACD === "function") { const m = indicators.computeMACD(data); macdHist = (m && typeof m.hist==="number")?m.hist:0; }
      if (typeof indicators.computeATR === "function") atr = indicators.computeATR(data,14);
    } catch(e){}

    let ell = null;
    try { ell = await analyzeElliott(data); } catch(e){ ell = null; }
    const ellSent = ell?.sentiment ?? 0;
    const ellConf = (ell?.confidence ?? 0) / 100;

    const newsFeat = await safeFetchNewsFeatures(symbol);

    // stable ordering
    const features = [
      avgRet || 0,
      volChange || 0,
      (rsi || 50)/100,
      (macdHist || 0),
      (atr || 0),
      ellSent || 0,
      ellConf || 0,
      newsFeat.newsScore || 0,
      newsFeat.newsAbs || 0
    ];

    return { symbol, interval, features, close: lastClose, vol: lastVol, ell, news: newsFeat.raw || null, fetchedAt: nowISO() };

  } catch (e) {
    console.warn("ml_v17.extractFeatures err", e?.message || e);
    return null;
  }
}

// ---------- sliding dataset (lightweight) ----------
export async function buildSlidingDataset(symbol, interval = "15m", window = 60, horizon = DEFAULTS.horizon, maxSamples = DEFAULTS.maxSamples) {
  try {
    const resp = await fetchMarketData(symbol, interval, window + horizon + 10);
    const data = resp?.data || [];
    if (!Array.isArray(data) || data.length < window + horizon) return null;

    const newsGlobal = await safeFetchNewsFeatures(symbol);
    const X = [], Y = [], meta = [];

    for (let start=0; start + window + horizon <= data.length; start++) {
      const w = data.slice(start, start+window);
      const fwd = data.slice(start+window, start+window+horizon);

      const closes = w.map(c=>Number(c.close ?? 0));
      const vols = w.map(c=>Number(c.vol ?? 0));
      const lastClose = closes.at(-1) ?? 0;
      const avgVol = vols.reduce((a,b)=>a+b,0)/Math.max(1,vols.length);
      const volChange = avgVol ? (vols.at(-1) - avgVol)/avgVol : 0;

      const returns = [];
      for (let i=1;i<closes.length;i++) returns.push((closes[i]-closes[i-1])/Math.max(1,Math.abs(closes[i-1])));
      const avgRet = returns.length ? returns.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,returns.length) : 0;

      let rsi=50, macdHist=0, atr=0;
      try {
        if (typeof indicators.computeRSI === "function") rsi = indicators.computeRSI(w,14);
        if (typeof indicators.computeMACD === "function") macdHist = indicators.computeMACD(w).hist ?? 0;
        if (typeof indicators.computeATR === "function") atr = indicators.computeATR(w,14);
      } catch(e){}

      let ell = null;
      try { ell = await analyzeElliott(w); } catch(e){ ell=null; }
      const ellSent = ell?.sentiment ?? 0;
      const ellConf = (ell?.confidence ?? 0)/100;

      const features = [
        avgRet || 0,
        volChange || 0,
        (rsi||50)/100,
        (macdHist||0),
        (atr||0),
        ellSent||0,
        ellConf||0,
        newsGlobal.newsScore||0,
        newsGlobal.newsAbs||0
      ];

      const futureClose = Number(fwd.at(-1)?.close ?? fwd.at(0)?.close ?? lastClose);
      const futureRet = lastClose ? (futureClose - lastClose)/Math.max(1,Math.abs(lastClose)) : 0;
      const label = futureRet > 0 ? 1 : 0;

      X.push(features);
      Y.push(label);
      meta.push({ symbol, index:start, lastClose, futureClose, futureRet });

      if (X.length >= maxSamples) break;
    }

    return { X, Y, meta };

  } catch (e) {
    console.warn("ml_v17.buildSlidingDataset err", e?.message || e);
    return null;
  }
}

// ---------- train ----------
export async function trainModel(symbols = [CONFIG.SYMBOL || "BTCUSDT"], options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const allX = [], allY = [];

  for (const s of symbols) {
    try {
      // prefer sliding dataset (correct labels)
      const ds = await buildSlidingDataset(s, opts.interval || "15m", opts.window || 60, opts.horizon || DEFAULTS.horizon, opts.maxSamples || DEFAULTS.maxSamples);
      if (ds && ds.X && ds.X.length) { allX.push(...ds.X); allY.push(...ds.Y); }
    } catch (e) {
      console.warn("ml_v17.trainModel sample build failed for", s, e?.message || e);
    }
  }

  if (!allX.length) throw new Error("No training samples available.");

  const dim = allX[0].length;
  let model = safeJSONLoad(MODEL_FILE, null);
  if (!model || model.dim !== dim) model = initModel(dim);

  const epochs = Math.max(1, opts.epochs || DEFAULTS.epochs);
  const lr = opts.lr || DEFAULTS.lr;

  // small, memory-friendly training loop (stochastic)
  for (let ep=0; ep<epochs; ep++) {
    for (let i=0;i<allX.length;i++) {
      const idx = Math.floor(Math.random() * allX.length);
      updateSGD(model, allX[idx], allY[idx], lr);
    }
  }

  model.trainedAt = nowISO();
  model.dim = dim;
  safeJSONSave(MODEL_FILE, model);
  return model;
}

// ---------- prediction (15m) ----------
export async function runMLPrediction(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "15m") {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model) return { error: "model_not_found" };

    const f = await extractFeatures(symbol, interval, DEFAULTS.lookback);
    if (!f) return { error: "no_features" };

    let p = predictRaw(model, f.features); // 0..1

    // conservative news + ell nudges
    try {
      const newsScore = f.news ? ( (typeof f.news.sentiment === "number") ? (f.news.sentiment) : (f.features?.[7] ?? 0) ) : 0;
      p = Math.max(0, Math.min(1, p + (newsScore * DEFAULTS.newsNudge) + ((f.ell?.confidence ?? 0)/100 * DEFAULTS.ellNudgeFactor)));
    } catch(e){}

    const pct = Math.round(p * 10000)/100;
    const label = pct > 55 ? "Bullish" : pct < 45 ? "Bearish" : "Neutral";

    const predId = await recordPrediction({
      symbol,
      predictedAt: nowISO(),
      label,
      prob: pct,
      features: f.features,
      meta: { interval, ell: f.ell, news: f.news }
    });

    return { id: predId, symbol, label, prob: pct, features: f.features, ell: f.ell, news: f.news };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------- micro prediction (lightweight) ----------
export async function runMicroPrediction(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "1m", lookback = DEFAULTS.microLookback) {
  try {
    const f = await extractFeatures(symbol, interval, lookback);
    if (!f) return { error: "no_features" };

    const model = safeJSONLoad(MODEL_FILE, null);
    const pModel = model ? predictRaw(model, f.features) : 0.5;
    let p = pModel;

    // minor news & simple pattern nudges (cheap, conservative)
    const resp = await fetchMarketData(symbol, interval, 6);
    const candles = resp?.data || [];
    const last = candles.at(-1), prev = candles.at(-2);
    const patterns = [];
    try {
      if (last && prev) {
        const body = Math.abs(last.close - last.open);
        const lowerWick = Math.abs(Math.min(last.open, last.close) - last.low);
        const upperWick = Math.abs(last.high - Math.max(last.open, last.close));
        if (body > 0 && lowerWick > body * 1.8 && upperWick < body * 0.5) patterns.push("Hammer");
        if (body > 0 && upperWick > body * 1.8 && lowerWick < body * 0.5) patterns.push("ShootingStar");
        if ((last.close > last.open) && (prev.close < prev.open) && (last.open < prev.close)) patterns.push("BullishEngulfing");
        if ((last.close < last.open) && (prev.close > prev.open) && (last.open > prev.close)) patterns.push("BearishEngulfing");
      }
    } catch(e){}

    try {
      p = Math.max(0, Math.min(1, p + ((f.news?.sentiment ?? (f.features?.[7]??0)) * (DEFAULTS.newsNudge*0.8))));
      if (patterns.includes("Hammer")) p = Math.min(1, p + DEFAULTS.microPatternNudge);
      if (patterns.includes("ShootingStar")) p = Math.max(0, p - DEFAULTS.microPatternNudge);
      if (patterns.includes("BullishEngulfing")) p = Math.min(1, p + (DEFAULTS.microPatternNudge + 0.02));
      if (patterns.includes("BearishEngulfing")) p = Math.max(0, p - (DEFAULTS.microPatternNudge + 0.02));
    } catch(e){}

    const pct = Math.round(p * 10000)/100;
    const label = pct > 55 ? "Bullish" : pct < 45 ? "Bearish" : "Neutral";

    return { symbol, interval, prob: pct, label, features: f.features, patterns, ell: f.ell, news: f.news, fetchedAt: nowISO() };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// ---------- records & feedback ----------
export async function recordPrediction(obj = {}) {
  try {
    const store = safeJSONLoad(PREDICTIONS_FILE, { preds: [] }) || { preds: [] };
    const id = `mlpred_v17_${Date.now()}_${Math.floor(Math.random()*9999)}`;
    const entry = Object.assign({ id, ts: Date.now() }, obj);
    store.preds = store.preds || [];
    store.preds.push(entry);
    if (store.preds.length > 5000) store.preds = store.preds.slice(-5000);
    safeJSONSave(PREDICTIONS_FILE, store);
    return id;
  } catch(e) {
    console.warn("ml_v17.recordPrediction err", e?.message || e);
    return null;
  }
}
export function recordOutcome(predictionId, outcome = {}) {
  try {
    const preds = safeJSONLoad(PREDICTIONS_FILE, { preds: [] });
    const pred = (preds.preds || []).find(x => x.id === predictionId) || null;
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    const rec = { predictionId, ts: Date.now(), predicted: pred, outcome: { correct: !!outcome.correct, realizedReturn: typeof outcome.realizedReturn === "number" ? outcome.realizedReturn : null, realizedPrice: typeof outcome.realizedPrice === "number" ? outcome.realizedPrice : null, note: outcome.note || null } };
    fb.outcomes.push(rec);
    if (fb.outcomes.length > 10000) fb.outcomes = fb.outcomes.slice(-10000);
    safeJSONSave(FEEDBACK_FILE, fb);
    return { ok: true, rec };
  } catch(e) {
    console.warn("ml_v17.recordOutcome err", e?.message || e);
    return { ok: false, message: e?.message || String(e) };
  }
}

// ---------- accuracy ----------
export function calculateAccuracy() {
  try {
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    if (!Array.isArray(fb.outcomes) || !fb.outcomes.length) return { total: 0, accuracy: 0, lastUpdated: nowISO() };
    const total = fb.outcomes.length;
    const correct = fb.outcomes.filter(o => o.outcome && o.outcome.correct).length;
    const accuracy = Math.round((correct/total) * 10000)/100;
    const summary = { total, correct, accuracy, time: nowISO() };
    safeJSONSave(HISTORY_FILE, summary);
    return summary;
  } catch(e) {
    console.warn("ml_v17.calculateAccuracy err", e?.message || e);
    return { total: 0, accuracy: 0, lastUpdated: nowISO() };
  }
}

// ---------- simple evaluator ----------
export async function evaluateModelOnSymbols(symbols = [CONFIG.SYMBOL || "BTCUSDT"], interval = "15m") {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model) return { error: "model_missing" };
    const out = [];
    for (const s of symbols) {
      try {
        const f = await extractFeatures(s, interval);
        if (!f) { out.push({ symbol: s, error: "no_features" }); continue; }
        const pRaw = predictRaw(model, f.features);
        const newsScore = f.features?.[7] ?? 0;
        const p = Math.max(0, Math.min(1, pRaw + (newsScore * DEFAULTS.newsNudge)));
        out.push({ symbol: s, prob: Math.round(p*10000)/100, features: f.features, ell: f.ell, news: f.news });
      } catch(e) { out.push({ symbol: s, error: e.message || String(e) }); }
    }
    return out;
  } catch(e) { return { error: e?.message || String(e) }; }
}

// ---------- auto retrain (balanced) ----------
export async function dailyRetrain() {
  try {
    const markets = [ ...(CONFIG.MARKETS?.CRYPTO || []), ...(CONFIG.MARKETS?.INDIAN || []), ...(CONFIG.MARKETS?.METALS || []) ].filter(Boolean);
    if (!markets.length) markets.push(CONFIG.SYMBOL || "BTCUSDT");
    try {
      const model = await trainModel(markets, { epochs: DEFAULTS.epochs, lr: DEFAULTS.lr, window: 60, horizon: DEFAULTS.horizon, maxSamples: DEFAULTS.maxSamples });
      const acc = calculateAccuracy();
      return { ok: true, modelMeta: { trainedAt: model.trainedAt, dim: model.dim }, accuracy: acc };
    } catch(e) {
      return { ok: false, error: e?.message || String(e) };
    }
  } catch(e) { return { ok: false, error: e?.message || String(e) }; }
}

// ---------- dashboard ----------
export function getMLDashboard() {
  try {
    const model = safeJSONLoad(MODEL_FILE, {}) || {};
    const acc = safeJSONLoad(HISTORY_FILE, {}) || {};
    const fb = safeJSONLoad(FEEDBACK_FILE, { outcomes: [] }) || { outcomes: [] };
    return { modelAge: model.trainedAt || "never", modelDim: model.dim || 0, accuracy: acc.accuracy ?? 0, feedbackSamples: (fb.outcomes||[]).length, lastUpdated: acc.time || nowISO() };
  } catch(e) { return { modelAge:"err", modelDim:0, accuracy:0, feedbackSamples:0, lastUpdated: nowISO() }; }
}

// ---------- schedulers ----------
let _autoRetrainTimer = null;
let _microWatcherTimer = null;
let _microWatcherSymbols = [CONFIG.SYMBOL || "BTCUSDT"];

export function startAutoRetrain() {
  try {
    const hours = Number(CONFIG.ML?.RETRAIN_INTERVAL_HOURS ?? DEFAULTS.autoRetrainHours) || DEFAULTS.autoRetrainHours;
    const ms = Math.max(1, hours) * 60 * 60 * 1000;
    if (_autoRetrainTimer) clearInterval(_autoRetrainTimer);
    _autoRetrainTimer = setInterval(async () => {
      try { await dailyRetrain(); } catch(e) { console.warn("ml_v17.autoRetrain err", e?.message || e); }
    }, ms);
    return true;
  } catch(e) { console.warn("ml_v17.startAutoRetrain err", e?.message || e); return false; }
}
export function stopAutoRetrain() { if (_autoRetrainTimer) { clearInterval(_autoRetrainTimer); _autoRetrainTimer = null; } }

export function startMicroWatcher(symbols = [CONFIG.SYMBOL || "BTCUSDT"], intervalSeconds = DEFAULTS.microWatcherIntervalSeconds) {
  try {
    if (_microWatcherTimer) clearInterval(_microWatcherTimer);
    _microWatcherSymbols = Array.isArray(symbols) ? symbols : [symbols];
    _microWatcherTimer = setInterval(async () => {
      try {
        for (const s of _microWatcherSymbols) {
          const res = await runMicroPrediction(s, "1m", DEFAULTS.microLookback);
          if (res && !res.error) { await recordPrediction({ symbol: s, predictedAt: nowISO(), label: res.label, prob: res.prob, features: res.features, meta: { micro:true, patterns: res.patterns }}); }
        }
      } catch(e) { console.warn("ml_v17.microWatcher err", e?.message || e); }
    }, Math.max(5, Number(intervalSeconds || DEFAULTS.microWatcherIntervalSeconds)) * 1000);
    return true;
  } catch(e){ console.warn("ml_v17.startMicroWatcher err", e?.message || e); return false; }
}
export function stopMicroWatcher() { if (_microWatcherTimer) { clearInterval(_microWatcherTimer); _microWatcherTimer = null; } }

// ---------- init (best-effort non-blocking) ----------
(async function __ml_init_auto() {
  try {
    const model = safeJSONLoad(MODEL_FILE, null);
    if (!model && DEFAULTS.autoTrainOnStart) {
      (async () => {
        try {
          await trainModel([CONFIG.SYMBOL || "BTCUSDT"], { epochs: Math.min(20, DEFAULTS.epochs), lr: DEFAULTS.lr, maxSamples: Math.min(200, DEFAULTS.maxSamples) });
          calculateAccuracy();
        } catch(e) { console.warn("ml_v17: background initial train failed", e?.message || e); }
      })();
    }
    if (Number(DEFAULTS.autoRetrainHours) > 0) startAutoRetrain();
    if (DEFAULTS.microWatcherEnabled) startMicroWatcher(_microWatcherSymbols, DEFAULTS.microWatcherIntervalSeconds);
  } catch(e){ console.warn("ml_v17.__ml_init_auto err", e?.message || e); }
})();

// ---------- exports ----------
export default {
  extractFeatures,
  buildSlidingDataset,
  trainModel,
  runMLPrediction,
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy,
  evaluateModelOnSymbols,
  dailyRetrain,
  getMLDashboard,
  startAutoRetrain,
  stopAutoRetrain,
  startMicroWatcher,
  stopMicroWatcher
};