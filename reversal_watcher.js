// reversal_watcher_v3.js — Reversal Watcher v3 (full, standalone)
// Features:
// - 1m micro reversal detection (hammer, shooting star, engulfing, doji-like)
// - integrates ML micro predictions from ml_module_v8_6 (runMicroPrediction)
// - integrates news sentiment from news_social.js (fetchNewsBundle)
// - uses analyzeElliott for pivots (support/resistance proximity boost)
// - duplicate alert suppression + hourly throttling + persistent cache
// - Telegram alerts (CONFIG.TELEGRAM BOT_TOKEN + CHAT_ID) optional
// - Exports: startWatcher, stopWatcher, evaluateOnce, configure, getWatcherStatus

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import {
  runMicroPrediction,
  recordPrediction
} from "./ml_module_v8_6.js";
import newsModule from "./news_social.js";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";

// -------------------- Defaults & State --------------------
const DEFAULTS = {
  intervalSeconds: 30,            // poll frequency (seconds)
  lookbackCandles: 6,             // how many 1m candles to fetch
  wickToBodyRatio: 1.5,           // wick > body * ratio for hammer/shooting
  minConfidenceToAlert: 0.55,     // 0..1 threshold to alert
  duplicateAlertWindowMin: 10,    // suppress same-direction alerts (minutes)
  supportProximityPct: 0.005,     // 0.5% proximity considered close
  mlWeight: 0.35,                 // weight of ML micro-probability
  newsWeight: 0.25,               // weight for news sentiment
  patternWeight: 0.5,             // weight for detected pattern
  maxAlertsPerHourPerSymbol: 6,   // throttle alerts per symbol
  enableTelegram: true,
  telegramParseMode: "HTML",
  cacheFile: path.resolve(process.cwd(), "cache", "reversal_watcher_alerts.json")
};

let opts = { ...DEFAULTS };
const CACHE_DIR = path.dirname(opts.cacheFile);
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let alertCache = loadCache() || { bySymbol: {}, history: [] };
let watcherTimer = null;
let watcherSymbols = [CONFIG.SYMBOL || "BTCUSDT"];
let status = { running: false, lastRun: null };

// Telegram
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// -------------------- Helpers --------------------
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "N/A");
const nowISO = () => new Date().toISOString();
const nowLocalString = () => new Date().toLocaleString("en-IN");

function loadCache() {
  try {
    if (!fs.existsSync(opts.cacheFile)) return { bySymbol: {}, history: [] };
    const txt = fs.readFileSync(opts.cacheFile, "utf8");
    return txt ? JSON.parse(txt) : { bySymbol: {}, history: [] };
  } catch (e) {
    console.warn("reversal_watcher: loadCache error", e?.message || e);
    return { bySymbol: {}, history: [] };
  }
}
function saveCache() {
  try {
    fs.writeFileSync(opts.cacheFile, JSON.stringify(alertCache, null, 2));
  } catch (e) {
    console.warn("reversal_watcher: saveCache error", e?.message || e);
  }
}
function minutesSince(tsISO) {
  if (!tsISO) return Infinity;
  return (Date.now() - new Date(tsISO).getTime()) / 60000;
}

// Candle props
function propsOf(c) {
  const open = Number(c.open ?? c.o ?? c[1] ?? 0);
  const high = Number(c.high ?? c.h ?? c[2] ?? 0);
  const low = Number(c.low ?? c.l ?? c[3] ?? 0);
  const close = Number(c.close ?? c.c ?? c[4] ?? 0);
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const direction = close > open ? "bull" : close < open ? "bear" : "doji";
  return { open, high, low, close, body, upperWick, lowerWick, direction };
}

// Patterns
function isHammer(c) {
  const p = propsOf(c);
  if (p.body <= 0) return false;
  return (p.lowerWick > p.body * opts.wickToBodyRatio) && (p.upperWick < p.body * 0.6) && p.direction === "bull";
}
function isShootingStar(c) {
  const p = propsOf(c);
  if (p.body <= 0) return false;
  return (p.upperWick > p.body * opts.wickToBodyRatio) && (p.lowerWick < p.body * 0.6) && p.direction === "bear";
}
function isBullishEngulfing(curr, prev) {
  if (!prev) return false;
  const a = propsOf(prev), b = propsOf(curr);
  return a.direction === "bear" && b.direction === "bull" && (b.body > a.body) && (curr.close > prev.open);
}
function isBearishEngulfing(curr, prev) {
  if (!prev) return false;
  const a = propsOf(prev), b = propsOf(curr);
  return a.direction === "bull" && b.direction === "bear" && (b.body > a.body) && (curr.close < prev.open);
}
function isDojiLike(c) {
  const p = propsOf(c);
  if (p.body === 0) return true;
  return (p.body / (Math.max(p.upperWick, p.lowerWick) + 1e-9) < 0.2);
}

// Trend
function computeTrend(closes, look = 6) {
  if (!Array.isArray(closes) || closes.length < 3) return "flat";
  const slice = closes.slice(-Math.min(look, closes.length));
  const first = slice[0], last = slice.at(-1);
  if (last > first * 1.002) return "up";
  if (last < first * 0.998) return "down";
  return "flat";
}

// Proximity
function proximityPct(price, level) {
  if (!price || !level) return 9999;
  return Math.abs(price - level) / Math.max(1, price);
}

// Scoring combine
function combine({ pattern = 0, ml = 0.5, news = 0.5, volBoost = 1 }) {
  const pw = opts.patternWeight;
  const mw = opts.mlWeight;
  const nw = opts.newsWeight;
  const total = Math.max(1e-6, pw + mw + nw);
  let raw = (pattern * pw + ml * mw + news * nw) / total;
  const boosted = Math.max(0, Math.min(1, raw * Math.min(1.4, volBoost)));
  return boosted;
}

// Alert suppression check
function canAlert(symbol, direction, score) {
  const rec = alertCache.bySymbol[symbol] || { last: [] };
  // hourly throttle
  const lastHourCount = (rec.last || []).filter(a => minutesSince(a.ts) <= 60).length;
  if (lastHourCount >= opts.maxAlertsPerHourPerSymbol) return false;
  // same-direction suppression
  const lastSame = (rec.last || []).slice().reverse().find(a => a.direction === direction);
  if (lastSame && minutesSince(lastSame.ts) < opts.duplicateAlertWindowMin) return false;
  // score threshold
  if (score < opts.minConfidenceToAlert) return false;
  return true;
}
function saveAlert(symbol, direction, score, note = "") {
  const rec = alertCache.bySymbol[symbol] || { last: [] };
  const e = { ts: nowISO(), direction, score: Number(score.toFixed(3)), note };
  rec.last.push(e);
  rec.last = rec.last.slice(-500);
  alertCache.bySymbol[symbol] = rec;
  alertCache.history = (alertCache.history || []).concat([{ symbol, ...e }]).slice(-5000);
  saveCache();
}

// save cache wrapper
function saveCache() {
  try { fs.writeFileSync(opts.cacheFile, JSON.stringify(alertCache, null, 2)); }
  catch (e) { console.warn("reversal_watcher: saveCache failed", e?.message || e); }
}

// -------------------- Main evaluation --------------------
export async function evaluateOnce(symbol = CONFIG.SYMBOL || "BTCUSDT") {
  try {
    const interval = "1m";
    const look = Math.max(opts.lookbackCandles, 6);
    const resp = await fetchMarketData(symbol, interval, look);
    const candles = resp?.data || [];
    if (!Array.isArray(candles) || candles.length < 3) return { ok: false, error: "insufficient_candles" };

    const last = candles.at(-1);
    const prev = candles.at(-2);
    const prev2 = candles.at(-3);
    const closes = candles.map(c => Number(c.close ?? c.c ?? 0));

    // volumes & volBoost
    const vols = candles.map(c => Number(c.volume ?? c.v ?? c.vol ?? 0));
    const avgVol = vols.reduce((a,b) => a+b, 0) / Math.max(1, vols.length);
    const lastVol = Number(last.volume ?? last.v ?? last.vol ?? 0) || 0;
    const volBoost = avgVol > 0 ? (lastVol / avgVol) : 1;

    // detect patterns
    const patterns = [];
    if (isHammer(last)) patterns.push("Hammer");
    if (isShootingStar(last)) patterns.push("ShootingStar");
    if (isBullishEngulfing(last, prev)) patterns.push("BullishEngulfing");
    if (isBearishEngulfing(last, prev)) patterns.push("BearishEngulfing");
    if (isDojiLike(last)) patterns.push("DojiLike");
    if (isBullishEngulfing(prev, prev2)) patterns.push("BullishEngulfing(prev)");
    if (isBearishEngulfing(prev, prev2)) patterns.push("BearishEngulfing(prev)");

    // derive patternScore
    const weights = {
      Hammer: 0.8,
      ShootingStar: 0.8,
      BullishEngulfing: 0.9,
      BearishEngulfing: 0.9,
      DojiLike: 0.45,
      "BullishEngulfing(prev)": 0.7,
      "BearishEngulfing(prev)": 0.7
    };
    let patternScore = 0;
    for (const p of patterns) patternScore = Math.max(patternScore, weights[p] || 0);

    // quick trend
    const trend = computeTrend(closes, 6);

    // elliott pivots for SR proximity
    let ellSummary = null;
    try {
      const ell = await analyzeElliott(candles);
      if (ell && ell.ok) {
        const pivots = ell.pivots || [];
        const lastHigh = pivots.filter(x => x.type === "H").slice(-1)[0];
        const lastLow = pivots.filter(x => x.type === "L").slice(-1)[0];
        ellSummary = { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell.confidence ?? 0 };
      }
    } catch (e) { /* ignore */ }

    let proxBoost = 1;
    const lastClose = Number(last.close ?? last.c ?? 0);
    if (ellSummary?.support) {
      const p = proximityPct(lastClose, Number(ellSummary.support));
      if (p <= opts.supportProximityPct) proxBoost += 0.12;
    }
    if (ellSummary?.resistance) {
      const p = proximityPct(lastClose, Number(ellSummary.resistance));
      if (p <= opts.supportProximityPct) proxBoost += 0.12;
    }

    // ML micro-prediction
    let ml = null;
    let mlProb = 0.5;
    try {
      ml = await runMicroPrediction(symbol, "1m", Math.max(50, opts.lookbackCandles));
      if (ml && !ml.error) mlProb = typeof ml.prob === "number" ? Math.max(0, Math.min(100, ml.prob)) / 100 : 0.5;
    } catch (e) { ml = { error: e?.message || e }; }

    // News sentiment
    let news = null;
    let newsProb = 0.5;
    try {
      const n = await newsModule.fetchNewsBundle(symbol);
      if (n && n.ok) {
        news = n;
        newsProb = Number(n.sentiment) || 0.5;
      }
    } catch (e) { news = { error: e?.message || e }; }

    // direction inference
    let direction = null;
    if (patterns.some(p => p.toLowerCase().includes("hammer") || p.toLowerCase().includes("bull"))) direction = "long";
    if (patterns.some(p => p.toLowerCase().includes("shooting") || p.toLowerCase().includes("bear"))) direction = direction === "long" ? "mixed" : "short";
    if (!direction || direction === "mixed") {
      if (mlProb >= 0.58) direction = "long";
      else if (mlProb <= 0.42) direction = "short";
    }

    // combine final score
    const combinedScore = combine({ pattern: patternScore, ml: mlProb, news: newsProb, volBoost: Math.min(2, volBoost * proxBoost) });

    const detail = {
      ok: true,
      symbol,
      time: nowISO(),
      timeLocal: nowLocalString(),
      lastCandle: { open: last.open ?? last.o, high: last.high ?? last.h, low: last.low ?? last.l, close: last.close ?? last.c, volume: last.volume ?? last.v ?? last.vol },
      patterns,
      patternScore,
      ml,
      mlProb,
      news,
      newsProb,
      volBoost,
      proxBoost,
      trend,
      ellSummary,
      combinedScore,
      direction
    };

    // decide alert
    if (direction && canAlert(symbol, direction, combinedScore)) {
      const scorePct = Math.round(combinedScore * 100);
      const lines = [];
      lines.push(`<b>Reversal Watcher</b> — <b>${symbol}</b>`);
      lines.push(`Time: ${new Date().toLocaleString("en-IN")}`);
      lines.push(`Price: <b>${nf(lastClose, 2)}</b> | Trend: ${trend}`);
      lines.push(`Direction: <b>${direction.toUpperCase()}</b> | Confidence: <b>${scorePct}%</b>`);
      if (patterns.length) lines.push(`Patterns: ${patterns.join(", ")}`);
      if (ml && !ml.error) lines.push(`ML micro prob: ${Math.round(mlProb * 100)}%`);
      if (news && news.ok) lines.push(`News sentiment: ${(newsProb*100).toFixed(0)}% | Impact: ${news.impact || "N/A"}`);
      if (ellSummary) lines.push(`SR: S:${nf(ellSummary.support)} R:${nf(ellSummary.resistance)}`);
      lines.push(`VolBoost:${volBoost.toFixed(2)} proxBoost:${proxBoost.toFixed(2)}`);
      lines.push(`<i>Alerts suppressed for ${opts.duplicateAlertWindowMin}m after identical alert</i>`);

      const msg = lines.join("\n");

      if (opts.enableTelegram && bot && CHAT_ID) {
        try {
          await bot.sendMessage(CHAT_ID, msg, { parse_mode: opts.telegramParseMode, disable_web_page_preview: true });
        } catch (e) {
          console.warn("reversal_watcher: telegram send failed", e?.message || e);
        }
      } else {
        console.log("reversal_watcher alert:", msg);
      }

      // record
      saveAlert(symbol, direction, combinedScore, `patterns:${patterns.join("|")}`);
      // optionally record ML mapping if available
      if (ml && !ml.error && ml.id) {
        try { await recordPrediction({ id: ml.id, symbol, notedAt: nowISO(), context: "reversal_alert", combinedScore }); } catch {}
      }

      return { ...detail, alerted: true };
    }

    return { ...detail, alerted: false };

  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------------- Control API --------------------
export function configure(userOpts = {}) {
  opts = { ...opts, ...userOpts };
  return opts;
}
export function getWatcherStatus() {
  return { ...status, opts, symbols: watcherSymbols, cacheSummary: { symbols: Object.keys(alertCache.bySymbol || {}) } };
}

export async function startWatcher(symbols = [CONFIG.SYMBOL || "BTCUSDT"], intervalSeconds = null) {
  try {
    watcherSymbols = Array.isArray(symbols) ? symbols : [symbols];
    if (intervalSeconds) opts.intervalSeconds = Number(intervalSeconds);

    if (watcherTimer) clearInterval(watcherTimer);
    status.running = true;
    status.lastRun = null;

    // initial immediate evaluation
    for (const s of watcherSymbols) {
      try {
        const r = await evaluateOnce(s);
        status.lastRun = nowISO();
        if (r && r.alerted) console.log(`reversal_watcher immediate ALERT: ${s} (${r.combinedScore})`);
      } catch (e) { /* ignore */ }
    }

    watcherTimer = setInterval(async () => {
      for (const s of watcherSymbols) {
        try {
          const r = await evaluateOnce(s);
          status.lastRun = nowISO();
          if (r && r.alerted) console.log(`reversal_watcher ALERT: ${s} (${r.combinedScore})`);
        } catch (e) {
          console.warn("reversal_watcher loop error", e?.message || e);
        }
      }
    }, Math.max(5, Number(opts.intervalSeconds || 30)) * 1000);

    return true;
  } catch (e) {
    console.warn("reversal_watcher start error", e?.message || e);
    return false;
  }
}

export function stopWatcher() {
  try {
    if (watcherTimer) clearInterval(watcherTimer);
    watcherTimer = null;
    status.running = false;
    return true;
  } catch (e) {
    console.warn("reversal_watcher stop error", e?.message || e);
    return false;
  }
}

// -------------------- Exports default --------------------
export default {
  startWatcher,
  stopWatcher,
  evaluateOnce,
  configure,
  getWatcherStatus
};