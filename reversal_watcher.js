// reversal_watcher.js — Reversal Watcher v2 (Standalone)
// Part 1/3: imports, config, helpers, persistence

import fs from "fs";
import path from "path";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import {
  runMicroPrediction,
  recordPrediction,
  recordOutcome,
  startMicroWatcher,
  stopMicroWatcher,
  calculateAccuracy
} from "./ml_module_v8_6.js";
import newsModule from "./news_social.js";
import TelegramBot from "node-telegram-bot-api";

// ---------------------------
// Basic config / storage
// ---------------------------
const SYMBOL = CONFIG.SYMBOL || "BTCUSDT";
const INTERVAL = CONFIG.REVERSAL_WATCHER?.INTERVAL || "1m"; // micro watcher default
const POLL_INTERVAL_MS = Number(CONFIG.REVERSAL_WATCHER?.POLL_MS || 15 * 1000); // poll every 15s
const CONFIRM_CANDLES = Number(CONFIG.REVERSAL_WATCHER?.CONFIRM_CANDLES || 5); // confirm window
const REVERSAL_SCORE_THRESHOLD = Number(CONFIG.REVERSAL_WATCHER?.SCORE_THRESHOLD || 0.65); // detection threshold (0..1)
const NEWS_WEIGHT = Number(CONFIG.REVERSAL_WATCHER?.NEWS_WEIGHT ?? 0.2); // 0..1
const ML_WEIGHT = Number(CONFIG.REVERSAL_WATCHER?.ML_WEIGHT ?? 0.35); // 0..1
const ELL_WEIGHT = Number(CONFIG.REVERSAL_WATCHER?.ELL_WEIGHT ?? 0.25); // 0..1
const IND_WEIGHT = Number(CONFIG.REVERSAL_WATCHER?.IND_WEIGHT ?? 0.2); // 0..1

const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const STATE_FILE = path.join(CACHE_DIR, "reversal_watcher_state.json");

// Telegram init (optional)
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// internal timers
let _watcherTimer = null;
let _isRunning = false;

// outstanding alerts store (keeps alerts waiting for confirmation)
let outstandingAlerts = safeJSONLoad(STATE_FILE, { alerts: [] }).alerts || [];

// ---------------------------
// helpers: safe json
// ---------------------------
function safeJSONLoad(fp, fallback = null) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    const txt = fs.readFileSync(fp, "utf8");
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.warn("reversal_watcher: safeJSONLoad err", e?.message || e);
    return fallback;
  }
}
function safeJSONSave(fp, data) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("reversal_watcher: safeJSONSave err", e?.message || e);
    return false;
  }
}
function persistState() {
  try {
    safeJSONSave(STATE_FILE, { alerts: outstandingAlerts.slice(-200) });
  } catch (_) {}
}

// ---------------------------
// time formatting (India)
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function nowISO() { return new Date().toISOString(); }

// ---------------------------
// small numeric helpers
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

// ---------------------------
// quick indicator heuristics (simple) - accepts candles array with {open,high,low,close,vol}
function computeIndicatorSignal(candles) {
  // returns -1..1 where negative = bearish reversal, positive = bullish reversal
  try {
    if (!Array.isArray(candles) || candles.length < 5) return 0;
    const last = candles.at(-1);
    const prev = candles.at(-2);
    const closeChange = (last.close - prev.close) / Math.max(1, prev.close);
    // momentum flip: if last candle reverses direction heavily
    const momentum = Math.max(-1, Math.min(1, -closeChange * 10)); // flip sign so big down-> potential bullish
    // volume spike
    const avgVol = candles.slice(-10).reduce((a,c)=>a+(c.volume||c.v||0),0)/Math.max(1,Math.min(10,candles.length));
    const volLast = last.volume || last.v || 0;
    const volSpike = avgVol ? Math.max(-1, Math.min(1, (volLast - avgVol)/avgVol)) : 0;
    // combine
    const sig = (momentum * 0.6) + (volSpike * 0.4);
    return Number(Math.max(-1, Math.min(1, sig)).toFixed(3));
  } catch (e) {
    return 0;
  }
}

// Part 2/3: Core detection loop, scoring, ML + news integration, alert send

// ---------------------------
// compute Elliott summary quick
async function computeElliottSignal(candles) {
  try {
    const res = await analyzeElliott(candles);
    if (!res || !res.ok) return { score: 0, text: null, details: null };
    // use res.sentiment (if present) normalized -1..1; else attempt pattern-based
    const sent = typeof res.sentiment === "number" ? Number(res.sentiment) : 0;
    // additional confidence factor
    const conf = Math.min(1, (res.confidence ?? res.conf ?? 0) / 100);
    const score = sent * conf; // -1..1
    return { score: Number(Number(score).toFixed(3)), text: res.patterns?.join?.(",") || null, details: res };
  } catch (e) {
    return { score: 0, text: null, details: null };
  }
}

// ---------------------------
// compute news sentiment (0..1)
async function computeNewsSentiment(symbol) {
  try {
    if (!newsModule || typeof newsModule.fetchNewsBundle !== "function") return 0.5;
    const news = await newsModule.fetchNewsBundle(symbol);
    if (!news || !news.ok) return 0.5;
    // news.sentiment is 0..1
    return Number(news.sentiment || 0.5);
  } catch (e) {
    return 0.5;
  }
}

// ---------------------------
// compute ml micro prediction (prob 0..100)
async function computeMLPrediction(symbol) {
  try {
    const res = await runMicroPrediction(symbol, INTERVAL, CONFIG.ML?.MICRO_LOOKBACK || 100);
    if (!res || res.error) return { prob: 50, label: "Neutral", details: res };
    return { prob: Number(res.prob || 50), label: res.label || "Neutral", details: res };
  } catch (e) {
    return { prob: 50, label: "Neutral", details: null };
  }
}

// ---------------------------
// compute final reversal score (0..1) for either 'bull' or 'bear'
// direction: "bull" (expect bullish reversal) or "bear"
async function computeReversalScore(direction, symbol = SYMBOL) {
  // fetch recent candles (we'll use 15 candles min)
  const resp = await fetchMarketData(symbol, INTERVAL, 30);
  const candles = resp?.data || [];
  if (!Array.isArray(candles) || candles.length < 3) return { score: 0, breakdown: {} };

  // indicators signal (-1..1)
  const indSig = computeIndicatorSignal(candles); // positive means bullish reversal potential
  const indForDir = direction === "bull" ? Math.max(0, indSig) : Math.max(0, -indSig); // 0..1

  // elliot
  const ell = await computeElliottSignal(candles);
  const ellForDir = direction === "bull" ? Math.max(0, ell.score) : Math.max(0, -ell.score); // 0..1

  // ml
  const ml = await computeMLPrediction(symbol);
  // convert ml.prob (0..100) to -1..1 bias (above 55 bullish, below 45 bearish)
  let mlBiasRaw = 0;
  if (ml.prob >= 55) mlBiasRaw = (ml.prob - 50) / 50; // 0.1..1
  else if (ml.prob <= 45) mlBiasRaw = (ml.prob - 50) / 50; // -1..-0.1
  // ml direction factor
  const mlForDir = direction === "bull" ? Math.max(0, mlBiasRaw) : Math.max(0, -mlBiasRaw); // 0..1

  // news
  const newsSent = await computeNewsSentiment(symbol); // 0..1
  // map to direction: if newsSent > 0.55 -> bullish, <0.45 -> bearish
  const newsForDir = direction === "bull" ? Math.max(0, (newsSent - 0.5) * 2) : Math.max(0, (0.5 - newsSent) * 2); // 0..1

  // combine with weights
  const wInd = IND_WEIGHT, wEll = ELL_WEIGHT, wML = ML_WEIGHT, wNews = NEWS_WEIGHT;
  const raw = (indForDir * wInd) + (ellForDir * wEll) + (mlForDir * wML) + (newsForDir * wNews);
  const totalW = wInd + wEll + wML + wNews || 1;
  const norm = Math.max(0, Math.min(1, raw / totalW)); // 0..1

  const breakdown = {
    ind: Number(indForDir.toFixed(3)),
    ell: Number(ellForDir.toFixed(3)),
    ml: Number(mlForDir.toFixed(3)),
    news: Number(newsForDir.toFixed(3)),
    weights: { ind: wInd, ell: wEll, ml: wML, news: wNews }
  };

  return { score: Number(norm.toFixed(3)), breakdown, ml, ell, newsSent, candles };
}

// ---------------------------
// Compose alert payload & send telegram
async function sendAlert(alert) {
  try {
    const { direction, symbol, score, breakdown, price, id, ml, ell, newsSent } = alert;
    const when = nowIST();
    const title = `${symbol} — Reversal Watcher Alert`;
    const text = `
⏰ ${when}
⚠️ <b>${direction.toUpperCase()} REVERSAL</b> detected for <b>${symbol}</b>
Score: <b>${nf(score * 100,1)}%</b> (threshold ${nf(REVERSAL_SCORE_THRESHOLD*100,1)}%)
Price: <b>${nf(price)}</b>

Breakdown:
• Indicators: ${breakdown.ind}
• Elliott: ${breakdown.ell} (${ell?.text || "—"})
• ML: ${breakdown.ml} (label: ${ml?.label || "N/A"}, prob: ${ml?.prob || "N/A"}%)
• News: ${nf(newsSent,3)}

Action ID: <code>${id}</code>
Confirm window: ${CONFIRM_CANDLES} candles (interval ${INTERVAL})
`.trim();

    // send to telegram if configured; also console.log
    console.log("Reversal Alert:", title, `Score=${score}`, breakdown);
    if (bot && CHAT_ID) {
      try {
        await bot.sendMessage(CHAT_ID, text, { parse_mode: "HTML", disable_web_page_preview: true });
      } catch (e) { console.warn("reversal_watcher: telegram send failed", e?.message || e); }
    }
  } catch (e) {
    console.warn("reversal_watcher.sendAlert err", e?.message || e);
  }
}

// ---------------------------
// create alert object and persist
function createAlertObject({ direction, symbol, score, breakdown, ml, ell, newsSent, candles }) {
  const id = `rev_${Date.now()}_${Math.floor(Math.random()*9999)}`;
  const price = candles?.at(-1)?.close ?? null;
  const alert = {
    id,
    symbol,
    direction, // 'bull' or 'bear'
    score,
    breakdown,
    ml,
    ell,
    newsSent,
    price,
    createdAt: nowISO(),
    createdAtIST: nowIST(),
    confirmCandles: CONFIRM_CANDLES,
    checked: false // will be set true after confirmation
  };
  outstandingAlerts.push(alert);
  persistState();
  return alert;
}

// ---------------------------
// check outstanding alerts after confirm window
async function confirmAlerts() {
  try {
    const nowAlerts = outstandingAlerts.filter(a=>!a.checked);
    if (!nowAlerts.length) return;
    // for each, sample candles from created time to now to see if reversal realized
    for (const a of nowAlerts) {
      try {
        // fetch candles since alert creation: we'll fetch (confirmCandles + 2) candles to be safe
        const resp = await fetchMarketData(a.symbol, INTERVAL, a.confirmCandles + 4);
        const candles = resp?.data || [];
        if (candles.length < a.confirmCandles + 1) {
          // not enough candles yet — skip
          continue;
        }
        // evaluate outcome:
        // for bullish reversal: price after confirm window must be >= alert.price * (1 + minMove)
        // for bearish reversal: price after confirm window must be <= alert.price * (1 - minMove)
        // minMove is relative threshold; small moves may be noise. default 0.002 (0.2%)
        const minMove = Number(CONFIG.REVERSAL_WATCHER?.MIN_MOVE ?? 0.002);
        const idx = candles.length - 1; // latest
        const confirmIndex = Math.max(0, candles.length - 1 - (a.confirmCandles - 1)); // candle at or just after window
        const confirmPrice = candles[confirmIndex]?.close ?? candles[idx]?.close;
        const realized = (a.direction === "bull")
          ? (confirmPrice >= (a.price * (1 + minMove)))
          : (confirmPrice <= (a.price * (1 - minMove)));

        // mark checked and record outcome
        a.checked = true;
        a.confirmedAt = nowISO();
        a.confirmedAtIST = nowIST();
        a.confirmPrice = confirmPrice;
        a.realized = !!realized;
        a.realizedReturn = a.realized ? ((confirmPrice - a.price) / a.price) * (a.direction === "bull" ? 1 : -1) : 0;

        // record outcome into ML feedback store if we have prediction id (we store recordPrediction id at alert.recordId)
        if (a.recordId) {
          try {
            recordOutcome(a.recordId, {
              correct: !!realized,
              realizedReturn: Number(a.realizedReturn || 0),
              realizedPrice: Number(confirmPrice || 0),
              note: `ReversalWatcher confirm (${a.direction})`
            });
          } catch (e) { console.warn("reversal_watcher: recordOutcome failed", e?.message || e); }
        }

        // send Telegram summary
        const summary = `
✅ Reversal Confirmed? <b>${a.realized ? "YES" : "NO"}</b>
ID: <code>${a.id}</code>
Symbol: ${a.symbol}
Direction: <b>${a.direction}</b>
Alert Price: ${nf(a.price)}
Confirm Price: ${nf(confirmPrice)}
Realized Return (signed): ${nf(a.realizedReturn*100,2)}%
`;
        if (bot && CHAT_ID) {
          try { await bot.sendMessage(CHAT_ID, summary, { parse_mode: "HTML" }); } catch (_){}
        }
      } catch (e) {
        console.warn("reversal_watcher.confirmAlerts err for", a.id, e?.message || e);
      }
    }
    persistState();
  } catch (e) {
    console.warn("reversal_watcher.confirmAlerts err", e?.message || e);
  }
}

// Part 3/3: main loop, start/stop, API functions, exports

// ---------------------------
// main tick: compute both bull + bear scores and create alerts
async function watcherTick() {
  try {
    // compute bull and bear
    const bull = await computeReversalScore("bull", SYMBOL);
    const bear = await computeReversalScore("bear", SYMBOL);

    // choose stronger side
    const bestDir = (bull.score >= bear.score) ? { direction: "bull", data: bull } : { direction: "bear", data: bear };
    const bestScore = bestDir.data.score;

    // fetch last price for alert payload
    const priceResp = await fetchMarketData(SYMBOL, INTERVAL, 3);
    const lastPrice = priceResp?.data?.at(-1)?.close ?? priceResp?.price ?? null;

    // if exceeds threshold, create alert
    if (bestScore >= REVERSAL_SCORE_THRESHOLD) {
      // create alert object
      const alert = createAlertObject({
        direction: bestDir.direction,
        symbol: SYMBOL,
        score: bestScore,
        breakdown: bestDir.data.breakdown,
        ml: bestDir.data.ml,
        ell: bestDir.data.ell,
        newsSent: bestDir.data.newsSent,
        candles: bestDir.data.candles
      });

      // store recordPrediction id if possible: we will call recordPrediction to tie alert with ML record
      try {
        const recId = await recordPrediction({
          symbol: SYMBOL,
          predictedAt: nowISO(),
          label: (bestDir.direction === "bull" ? "ReversalBull" : "ReversalBear"),
          prob: Math.round(bestScore*100),
          features: { breakdown: bestDir.data.breakdown, ml: bestDir.data.ml?.prob },
          meta: { source: "reversal_watcher", interval: INTERVAL }
        });
        if (recId) alert.recordId = recId;
      } catch (e) {
        console.warn("reversal_watcher: recordPrediction failed", e?.message || e);
      }

      // send alert immediately
      await sendAlert(alert);
      persistState();
    }

    // attempt to confirm outstanding alerts (some may not have reached confirm window)
    await confirmAlerts();

  } catch (e) {
    console.warn("reversal_watcher.tick err", e?.message || e);
  }
}

// ---------------------------
// start/stop functions
export function startReversalWatcher({ symbol = SYMBOL, intervalMs = POLL_INTERVAL_MS } = {}) {
  if (_isRunning) return false;
  _isRunning = true;
  // optionally start micro-watcher in ML module so its internal micro predictions keep fresh
  try { startMicroWatcher([symbol], Number(CONFIG.ML?.MICRO_WATCHER_INTERVAL_SECONDS || 30)); } catch (_) {}

  // initial tick immediately
  (async()=>{ try { await watcherTick(); } catch(_){} })();

  _watcherTimer = setInterval(async () => {
    try {
      await watcherTick();
    } catch (e) { console.warn("reversal_watcher.interval err", e?.message || e); }
  }, Math.max(5, Number(intervalMs || POLL_INTERVAL_MS)));

  console.log(`✅ Reversal Watcher started for ${symbol} (poll ${intervalMs}ms)`);

  return true;
}

export function stopReversalWatcher() {
  if (_watcherTimer) {
    clearInterval(_watcherTimer);
    _watcherTimer = null;
  }
  _isRunning = false;
  try { stopMicroWatcher(); } catch (_) {}
  console.log("🛑 Reversal Watcher stopped");
  return true;
}

// ---------------------------
// utilities
export function listOutstandingAlerts() {
  return outstandingAlerts.slice().reverse();
}

export function clearOutstandingAlerts() {
  outstandingAlerts = [];
  persistState();
  return true;
}

// ---------------------------
// quick health
export function getWatcherStatus() {
  return {
    running: _isRunning,
    symbol: SYMBOL,
    interval: INTERVAL,
    pollMs: POLL_INTERVAL_MS,
    outstanding: outstandingAlerts.length,
    lastUpdated: nowISO()
  };
}

// ---------------------------
// auto-start if configured
if (CONFIG.REVERSAL_WATCHER?.AUTO_START === true) {
  try { startReversalWatcher({ symbol: CONFIG.SYMBOL, intervalMs: POLL_INTERVAL_MS }); } catch (_) {}
}

// ---------------------------
// default export
export default {
  startReversalWatcher,
  stopReversalWatcher,
  getWatcherStatus,
  listOutstandingAlerts,
  clearOutstandingAlerts
};
