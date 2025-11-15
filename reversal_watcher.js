// reversal_watcher.js
// Standalone Reversal Watcher (memory-safe, ML+News confirm, Telegram alerts, feedback recorder)
// Usage: node --expose-gc reversal_watcher.js
// Recommended: fork this file from aiTraderBot.js (child_process.fork) so it runs in separate memory space.

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import newsModule from "./news_social.js"; // provides fetchNewsBundle
import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";

// ---------- Configuration (tweak via env or config.js) ----------
const SYMBOL = process.env.SYMBOL || CONFIG.SYMBOL || "BTCUSDT";
const INTERVAL = process.env.RW_INTERVAL || "1m";           // candles for pattern detection
const POLL_MS = Number(process.env.RW_POLL_MS || 15_000);   // default 15s poll
const LOOKBACK = Number(process.env.RW_LOOKBACK || 30);     // only fetch last N candles (keeps mem low)
const MIN_VOL_CHANGE = Number(process.env.RW_MIN_VOL_CHANGE || 0.1); // optional filter
const ML_CONFIRM_ONLY_IF_STRONG = true; // call ML only on strong signals
const ML_CONF_THRESHOLD = Number(process.env.RW_ML_CONF_THRESHOLD || 0.6); // ml probability cutoff (0..1)
const OUTCOME_CHECK_MIN = Number(process.env.RW_OUTCOME_MIN || 3); // minutes after signal to check outcome
const TELEGRAM_BOT_TOKEN = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || null;
const TELEGRAM_CHAT = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID || null;
const ENABLE_TELEGRAM = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT);

// ---------- Setup Telegram (optional) ----------
const bot = ENABLE_TELEGRAM ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }) : null;

// ---------- Internal state, small and bounded ----------
let _timer = null;
let _pendingSignals = new Map(); // id -> {time, symbol, direction, price, checkAt, predId}
const MAX_PENDING = 200; // safety cap

// ---------- Helpers ----------
const nowISO = () => new Date().toISOString();
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "N/A");

async function safeFetchCandles(symbol = SYMBOL, interval = INTERVAL, limit = LOOKBACK) {
  try {
    const resp = await fetchMarketData(symbol, interval, limit);
    return resp?.data || [];
  } catch (e) {
    console.warn("reversal_watcher: fetchMarketData err", e?.message || e);
    return [];
  }
}

async function safeFetchPrice(symbol = SYMBOL) {
  try {
    const resp = await fetchMarketData(symbol, "1m", 1);
    return resp?.price || (resp?.data?.at(-1)?.close ?? null);
  } catch (e) {
    return null;
  }
}

async function sendTelegram(text, opts = {}) {
  if (!ENABLE_TELEGRAM || !bot) return false;
  try {
    await bot.sendMessage(TELEGRAM_CHAT, text, { parse_mode: "HTML", disable_web_page_preview: true, ...opts });
    return true;
  } catch (e) {
    console.warn("reversal_watcher: telegram send failed", e?.message || e);
    return false;
  }
}

// tiny candlestick pattern checks (lightweight)
function detectReversalPatterns(candles = []) {
  // expects array of candles with {open,high,low,close,vol}
  if (!Array.isArray(candles) || candles.length < 3) return { found: false };

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const prev2 = candles.at(-3);

  const body = Math.abs(last.close - last.open);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);

  const prevBody = Math.abs(prev.close - prev.open);
  const prev2Body = Math.abs(prev2.close - prev2.open);

  // hammer (bullish) heuristic
  const isHammer = lowerWick > body * 1.8 && upperWick < body * 0.6 && last.close > last.open;
  // shooting star (bearish)
  const isShooting = upperWick > body * 1.8 && lowerWick < body * 0.6 && last.close < last.open;
  // bullish engulfing
  const isBullEngulfing =
    last.close > last.open && prev.close < prev.open && last.open < prev.close && last.close > prev.open;
  // bearish engulfing
  const isBearEngulfing =
    last.close < last.open && prev.close > prev.open && last.open > prev.close && last.close < prev.open;

  let direction = null;
  let strength = 0;

  if (isHammer || isBullEngulfing) {
    direction = "long";
    strength = 70 + (isBullEngulfing ? 15 : 0);
  }
  if (isShooting || isBearEngulfing) {
    direction = "short";
    strength = 70 + (isBearEngulfing ? 15 : 0);
  }

  // additional volume check (if available)
  const vol = last.volume ?? last.vol ?? last.v ?? 0;
  const avgVol = candles.slice(-10).reduce((a, c) => a + (c.volume ?? c.vol ?? c.v ?? 0), 0) / Math.max(1, Math.min(10, candles.length));
  const volBoost = avgVol ? Math.min(1.2, Math.max(0, vol / avgVol)) : 1;
  strength = Math.round(Math.min(100, strength * volBoost));

  return { found: Boolean(direction), direction, strength, vol, avgVol };
}

// schedule an outcome check for a signal
async function scheduleOutcomeCheck(signalObj) {
  try {
    const id = `rw_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const checkAt = Date.now() + OUTCOME_CHECK_MIN * 60 * 1000;

    // record small pending entry
    _pendingSignals.set(id, { ...signalObj, id, checkAt });
    // cap map size
    if (_pendingSignals.size > MAX_PENDING) {
      // remove oldest
      const firstKey = _pendingSignals.keys().next().value;
      _pendingSignals.delete(firstKey);
    }

    // schedule setTimeout (non-blocking; will be short-lived)
    setTimeout(async () => {
      try {
        const entry = _pendingSignals.get(id);
        if (!entry) return;
        // fetch current price
        const nowPrice = await safeFetchPrice(entry.symbol);
        const realizedReturn = nowPrice && entry.price ? (nowPrice - entry.price) / Math.max(1, entry.price) : null;
        // decide correctness: for long, realizedReturn > 0 ; for short, < 0
        const correct = entry.direction === "long" ? (realizedReturn > 0) : (realizedReturn < 0);
        // if prediction id exists, record outcome in ML feedback
        if (entry.predId) {
          try { recordOutcome(entry.predId, { correct, realizedReturn, realizedPrice: nowPrice, note: "auto-feedback from reversal_watcher" }); } catch (e) {}
        }
        // send telegram feedback summary
        const msg = `<b>Reversal Outcome</b>\nSymbol: ${entry.symbol}\nSignal: ${entry.direction}\nSignal Price: ${nf(entry.price)}\nNow: ${nf(nowPrice)}\nReturn: ${realizedReturn === null ? "N/A" : ( (realizedReturn*100).toFixed(2) + "%" )}\nCorrect: ${correct ? "YES ✅" : "NO ❌"}\nDetectedAt: ${entry.detectedAt}`;
        await sendTelegram(msg);
      } catch (e) {
        console.warn("reversal_watcher: outcome check err", e?.message || e);
      } finally {
        // free memory
        _pendingSignals.delete(id);
        global.gc && global.gc();
      }
    }, Math.max(10_000, OUTCOME_CHECK_MIN * 60 * 1000));

    return id;
  } catch (e) {
    console.warn("reversal_watcher: scheduleOutcomeCheck err", e?.message || e);
    return null;
  }
}

// main detection loop (keeps memory low)
async function pollOnce() {
  try {
    const candles = await safeFetchCandles(SYMBOL, INTERVAL, LOOKBACK);
    if (!candles || !candles.length) return;

    const lastC = candles.at(-1);
    const detect = detectReversalPatterns(candles);

    // small heuristic filter: require some movement
    if (!detect.found || detect.strength < 60) {
      // nothing strong found — lightweight ML micro could still run for micro signals if configured.
      // free references
      global.gc && global.gc();
      return;
    }

    // optional news check (light)
    let newsBundle = null;
    try { newsBundle = (typeof newsModule.fetchNewsBundle === "function") ? await newsModule.fetchNewsBundle(SYMBOL) : null; } catch (e) { newsBundle = null; }

    // build signal summary
    const signal = {
      symbol: SYMBOL,
      interval: INTERVAL,
      direction: detect.direction,
      strength: detect.strength,
      price: Number(lastC.close ?? lastC.c ?? lastC.closePrice ?? 0),
      vol: detect.vol,
      avgVol: detect.avgVol,
      detectedAt: nowISO(),
      news: newsBundle ? { sentiment: newsBundle.sentiment, impact: newsBundle.impact } : null
    };

    // ML confirmation (light): call micro prediction first
    let mlDecision = null;
    try {
      // only call ML when signal strong OR news supports it
      const newsOk = signal.news && (signal.news.sentiment > 0.6 || signal.news.sentiment < 0.4);
      if (!ML_CONFIRM_ONLY_IF_STRONG || detect.strength >= 80 || newsOk) {
        const micro = await runMicroPrediction(SYMBOL, "1m", Math.min(100, LOOKBACK));
        if (micro && !micro.error) {
          mlDecision = { label: micro.label, prob: (micro.prob || micro.probability || 50) / 100, features: micro.features };
        }
      }
    } catch (e) {
      mlDecision = null;
    }

    // quick decision logic: require either ML bullishity for 'long' or neutral (user can tune)
    let pass = true;
    if (mlDecision) {
      const p = mlDecision.prob ?? 0.5;
      if (signal.direction === "long" && p < ML_CONF_THRESHOLD) pass = false;
      if (signal.direction === "short" && p > (1 - ML_CONF_THRESHOLD)) pass = false;
    }

    if (!pass) {
      // not confirmed by ML => skip
      global.gc && global.gc();
      return;
    }

    // record prediction into ML store (light)
    let predId = null;
    try {
      const rec = await recordPrediction({ symbol: SYMBOL, predictedAt: nowISO(), label: signal.direction === "long" ? "Bullish" : "Bearish", prob: mlDecision?.prob ? Math.round(mlDecision.prob*10000)/100 : detect.strength, features: mlDecision?.features || [], meta: { source: "reversal_watcher", interval: INTERVAL }});
      predId = rec || null;
    } catch (e) {
      predId = null;
    }

    // schedule outcome check and keep id
    const schedId = await scheduleOutcomeCheck({ ...signal, predId });

    // prepare telegram message
    const newsTxt = signal.news ? `NewsSentiment: ${signal.news.sentiment} | Impact: ${signal.news.impact}\n` : "";
    const mlTxt = mlDecision ? `ML: ${mlDecision.label} (${Math.round((mlDecision.prob||0)*100)}%)\n` : "";
    const msg = `<b>Reversal Watcher</b>\n${SYMBOL} | ${INTERVAL}\nSignal: <b>${signal.direction.toUpperCase()}</b> (${signal.strength}%)\nPrice: <b>${nf(signal.price)}</b>\nVol: ${Math.round(signal.vol || 0)} (avg ${Math.round(signal.avgVol||0)})\n${newsTxt}${mlTxt}Scheduled outcome check in ${OUTCOME_CHECK_MIN} min.\nDetectedAt: ${signal.detectedAt}`;

    // send telegram alert
    await sendTelegram(msg);

    // housekeeping
    global.gc && global.gc();

    console.log("ReversalWatcher: signal ->", signal.direction, "price", signal.price, "strength", signal.strength, "predId", predId, "schedId", schedId, nowISO());
    // free local heavy references
    // (candles remains referenced by function only; allow GC)
  } catch (e) {
    console.warn("reversal_watcher: pollOnce err", e?.message || e);
  }
}

// public start/stop
export function startWatcher({ pollMs = POLL_MS, immediate = true } = {}) {
  if (_timer) return false;
  console.log(`✅ Reversal Watcher started for ${SYMBOL} (poll ${pollMs}ms, lookback ${LOOKBACK})`);
  if (immediate) pollOnce().catch(()=>{});
  _timer = setInterval(() => { pollOnce().catch(()=>{}); }, Math.max(5_000, pollMs));
  return true;
}

export function stopWatcher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("🛑 Reversal Watcher stopped");
  }
  return true;
}

// If run directly, start automatically
if (process.argv[1] && process.argv[1].endsWith("reversal_watcher.js")) {
  (async () => {
    startWatcher();
    // log a small heartbeat to help debugging
    setInterval(() => {
      console.log("ReversalWatcher heartbeat", nowISO());
    }, 60_000);
  })();
}

// export default
export default { startWatcher, stopWatcher };