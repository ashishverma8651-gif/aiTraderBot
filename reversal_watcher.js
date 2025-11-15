// reversal_watcher.js — Lightweight Reversal Watcher (EMA trend + Fib+S/R bounce + ML micro)
// - Uses runMicroPrediction(symbol, '1m', lookback) from ml_module_v8_6.js
// - Uses fetchMarketData to access candles
// - Exposes startReversalWatcher(symbol, opts) and stopReversalWatcher()
// - opts: pollIntervalMs, lookback, minProb, cooldownMs, feedbackWindowSeconds, sendAlert (async fn)

import CONFIG from "./config.js";
import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";

// internal state (single-instance friendly)
let _timer = null;
let _lastSignal = null; // "Bullish" | "Bearish" | null
let _lastSignalTs = 0;
let _feedbackQueue = []; // tiny: entries { ts, type, symbol, originMsg } (kept short)
const MAX_FEEDBACK = 6;

// --------- tiny helpers (no heavy deps) ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function now() { return Date.now(); }
function toPct(n) { return Math.round(n * 1000) / 10; } // one decimal percent if needed

// EMA (simple, in-place, returns last EMA)
function computeEMA(values = [], period = 9) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    const price = Number(values[i]) || 0;
    ema = price * k + ema * (1 - k);
  }
  return ema;
}

// compute simple trend strength using EMA9/21/50
function computeTrendStrength(closes) {
  if (!Array.isArray(closes) || closes.length < 50) return { strength: 0, direction: "Neutral" };
  const ema9 = computeEMA(closes.slice(-50), 9);
  const ema21 = computeEMA(closes.slice(-50), 21);
  const ema50 = computeEMA(closes.slice(-60), 50);

  // direction by EMA slope / ordering
  const bullish = ema9 > ema21 && ema21 > ema50;
  const bearish = ema9 < ema21 && ema21 < ema50;

  // strength approximated by normalized difference
  const spread = Math.abs((ema9 - ema50) || 0);
  // normalize by average close size to avoid huge numbers
  const avg = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.max(1, closes.slice(-50).length);
  const strength = avg ? clamp((spread / avg) * 1000, 0, 100) : 0; // 0..100

  return { strength, direction: bullish ? "Bull" : bearish ? "Bear" : "Neutral", ema9, ema21, ema50 };
}

// simple support/resistance zones from last N candles (returns arrays)
function getSRZones(candles = [], lookback = 120) {
  // choose recent lookback
  const window = candles.slice(-Math.min(lookback, candles.length));
  if (!window.length) return { supports: [], resistances: [] };

  // simple approach: local pivot extremes
  const highs = window.map(c => Number(c.high));
  const lows = window.map(c => Number(c.low));
  const max = Math.max(...highs);
  const min = Math.min(...lows);

  // coarse zones: quartile thresholds
  const q1 = min + (max - min) * 0.25;
  const q3 = min + (max - min) * 0.75;

  // find top few local highs near q3 and bottom lows near q1
  const supports = [];
  const resistances = [];

  for (let i = window.length - 1; i >= 0 && supports.length < 3; i--) {
    const l = Number(window[i].low);
    if (l <= q1) supports.push(l);
  }
  for (let i = window.length - 1; i >= 0 && resistances.length < 3; i--) {
    const h = Number(window[i].high);
    if (h >= q3) resistances.push(h);
  }

  // fallback to min/max
  if (!supports.length) supports.push(min);
  if (!resistances.length) resistances.push(max);

  return { supports, resistances };
}

// Fibonacci quick zone using last swing high/low
function computeFibZone(candles = [], lookback = 120) {
  const window = candles.slice(-Math.min(lookback, candles.length));
  if (!window.length) return null;
  // use highest high and lowest low in window
  let hh = -Infinity, ll = Infinity;
  for (let c of window) {
    const h = Number(c.high), l = Number(c.low);
    if (h > hh) hh = h;
    if (l < ll) ll = l;
  }
  if (!isFinite(hh) || !isFinite(ll) || hh <= ll) return null;
  const diff = hh - ll;
  // standard fib band: 0.382..0.618
  return { top: ll + diff * 0.618, bottom: ll + diff * 0.382, high: hh, low: ll };
}

// price-in-zone boolean with margin %
function inZone(price, zTop, zBottom, marginPct = 0.004) {
  // margin allows slight outside touches
  const margin = Math.max(1, Math.abs(price)) * marginPct;
  return price >= (zBottom - margin) && price <= (zTop + margin);
}

// internal default Telegram fallback (very small)
async function _sendFallbackTelegram(msg) {
  if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM.CHAT_ID, text: msg, parse_mode: "Markdown", disable_web_page_preview: true })
    });
  } catch (e) {
    // suppress
  }
}

// --------- public API ----------
/**
 * startReversalWatcher(symbol, opts)
 * opts:
 *  - pollIntervalMs (default 15k)
 *  - lookback (used by ML micro & candle fetch)
 *  - minProb (percent threshold)
 *  - cooldownMs (no repeated alerts) default 90_000
 *  - feedbackWindowSeconds (how long to wait then send feedback) default 45
 *  - sendAlert: async function(text) { .. }  // preferred (passed from main)
 */
export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  const poll = Number(opts.pollIntervalMs ?? 15000);
  const lookback = Number(opts.lookback ?? 60);
  const minProb = Number(opts.minProb ?? 58);
  const cooldownMs = Number(opts.cooldownMs ?? 90_000); // 90s
  const feedbackWindowSeconds = Number(opts.feedbackWindowSeconds ?? 45);
  const sendAlert = typeof opts.sendAlert === "function" ? opts.sendAlert : _sendFallbackTelegram;

  // clear previous
  if (_timer) clearInterval(_timer);
  _timer = setInterval(async () => {
    try {
      // 1) Get micro-prediction (light)
      const pred = await runMicroPrediction(symbol, "1m", lookback).catch(() => ({ error: true }));
      if (!pred || pred.error) return;
      const prob = Number(pred.prob || 0);
      const label = (pred.label || "Neutral");

      // 2) quickly fetch 1m candles (3) and a slightly larger window for bounce/trend (120)
      const ctxSmall = await fetchMarketData(symbol, "1m", 4).catch(() => ({ data: [] }));
      const cSmall = ctxSmall?.data || [];
      if (cSmall.length < 2) return;
      const lastC = cSmall.at(-1);
      const price = Number(lastC.close || lastC.c || 0);

      // candles for bounce/trend: keep small (120 max)
      const ctxTrend = await fetchMarketData(symbol, "1m", Math.min(120, Math.max(lookback, 60))).catch(() => ({ data: [] }));
      const trendCandles = ctxTrend?.data || [];
      if (!trendCandles.length) return;

      // 3) Pattern check: use pred.patterns (if provided) + simple local candle checks
      const patterns = Array.isArray(pred.patterns) ? pred.patterns : [];
      // simple pattern detect based on last two candles if none from pred
      if (!patterns.length && cSmall.length >= 2) {
        const last = cSmall.at(-1), prev = cSmall.at(-2);
        const body = Math.abs(last.close - last.open);
        const lower = Math.abs(Math.min(last.open, last.close) - last.low);
        const upper = Math.abs(last.high - Math.max(last.open, last.close));
        if (lower > body * 1.8 && upper < body * 0.5) patterns.push("Hammer");
        if (upper > body * 1.8 && lower < body * 0.5) patterns.push("Shooting Star");
        if ((last.close > last.open) && (prev.close < prev.open) && (last.open < prev.close)) patterns.push("Bullish Engulfing");
        if ((last.close < last.open) && (prev.close > prev.open) && (last.open > prev.close)) patterns.push("Bearish Engulfing");
      }

      // 4) Trend check (EMA9/21/50) — only small computation on recent closes
      const closes = trendCandles.map(c => Number(c.close || c.c || 0)).filter(v => Number.isFinite(v));
      const { strength, direction } = computeTrendStrength(closes);

      // lightweight bounce zone: hybrid fib + S/R
      const fib = computeFibZone(trendCandles, 120);
      const { supports, resistances } = getSRZones(trendCandles, 120);

      // decide zone acceptance
      let inBounceZone = false;
      if (fib && price) {
        inBounceZone = inZone(price, fib.top, fib.bottom, 0.006); // small margin ~0.6%
      }
      // also accept if price near top support/resistance
      if (!inBounceZone && supports.length && resistances.length) {
        // if price within 0.6% of support or resistance
        const sup = supports[0], res = resistances[0];
        if (sup && Math.abs(price - sup) / Math.max(1, sup) < 0.006) inBounceZone = true;
        if (res && Math.abs(price - res) / Math.max(1, res) < 0.006) inBounceZone = true;
      }

      // 5) Reversal conditions:
      // - ML label and probability threshold
      // - pattern (one of the classic reversal patterns)
      // - bounce zone true (helps filter false moves)
      // - trend strength must be not strongly trending in the same direction (we want reversal on weak trend)
      // - cooldown respected
      const nowTs = now();
      const cooldownOk = (!_lastSignalTs) || (nowTs - _lastSignalTs > cooldownMs);

      let candidate = null;
      if (label === "Bullish" && prob >= minProb) {
        // pattern list favor bullish
        const okPattern = patterns.some(p => /hammer|bullish|engulfing/i.test(p));
        const trendWeak = !(direction === "Bull" && strength > 45); // reject strong bull trend
        if (okPattern && inBounceZone && trendWeak && cooldownOk) candidate = "Bullish";
      } else if (label === "Bearish" && prob >= minProb) {
        const okPattern = patterns.some(p => /shooting|bearish|engulfing/i.test(p));
        const trendWeak = !(direction === "Bear" && strength > 45);
        if (okPattern && inBounceZone && trendWeak && cooldownOk) candidate = "Bearish";
      }

      if (candidate) {
        // ensure not duplicate of immediate last signal
        if (candidate !== _lastSignal || (nowTs - _lastSignalTs) > (cooldownMs + 1000)) {
          _lastSignal = candidate;
          _lastSignalTs = nowTs;

          // build message (compact but informative)
          const title = candidate === "Bullish" ? "⚡ Bullish Reversal" : "🔻 Bearish Reversal";
          const pProb = `${prob}%`;
          const msg = [
            `${title} detected`,
            `Symbol: *${symbol}*`,
            `Price: *${price}*`,
            `ML: *${pProb}*  Label: *${label}*`,
            `Patterns: *${patterns.length ? patterns.join(", ") : "None"}*`,
            `Trend: *${direction}* (strength ${Math.round(strength)})`,
            `Zone: *${fib ? `${toPct(fib.bottom)} - ${toPct(fib.top)}` : (supports[0] || resistances[0]) }*`,
            `Time: ${new Date().toLocaleString()}`
          ].join("\n");

          // send alert through provided function
          try {
            await sendAlert(msg);
          } catch (e) {
            // fallback via internal Telegram HTTP if provided
            await _sendFallbackTelegram(msg);
          }

          // small feedback entry (kept tiny in memory)
          _feedbackQueue.push({ ts: nowTs, type: candidate, symbol, price });
          if (_feedbackQueue.length > MAX_FEEDBACK) _feedbackQueue.shift();

          // schedule a one-shot feedback check for this alert (non-blocking)
          setTimeout(async () => {
            try {
              // fetch last 2 1m closes to compute small move
              const c = await fetchMarketData(symbol, "1m", 3).catch(() => ({ data: [] }));
              const d = c?.data || [];
              if (d.length >= 2) {
                const last = Number(d.at(-1).close || d.at(-1).c || 0);
                const prev = Number(d.at(-2).close || d.at(-2).c || 0);
                const movePct = prev ? ((last - prev) / Math.abs(prev)) * 100 : 0;
                const correct = candidate === "Bullish" ? movePct > 0 : movePct < 0;
                const fbMsg = `📊 Reversal Feedback\nSignal: *${candidate}*\nResult: *${correct ? "Confirmed ✅" : "Not Confirmed ❌"}*\nMove (1m): *${movePct.toFixed(3)}%*`;
                try { await sendAlert(fbMsg); } catch (_) { await _sendFallbackTelegram(fbMsg); }
              }
            } catch (e) {
              // ignore errors
            }
          }, Math.max(1000, (feedbackWindowSeconds || 45)) * 1000);
        }
      }

    } catch (e) {
      // swallow errors to avoid interval termination and logs spam
      // but keep a succinct warn occasionally
      // console.warn("reversal_watcher loop err", e?.message || e);
    }
  }, Math.max(5000, Math.min(60000, poll)));

  return true;
}

export async function stopReversalWatcher() {
  try {
    if (_timer) clearInterval(_timer);
    _timer = null;
    _lastSignal = null;
    _lastSignalTs = 0;
    _feedbackQueue = [];
    return true;
  } catch (e) {
    return false;
  }
}

export default { startReversalWatcher, stopReversalWatcher };