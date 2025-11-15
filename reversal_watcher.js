// reversal_watcher_light.js — Lightweight Reversal Watcher (safe / low memory)
// Exports: startReversalWatcher(symbol, opts), stopReversalWatcher()
import CONFIG from "./config.js";
import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";

let _timer = null;
let _lastSignal = null; // string
const _pendingFeedback = new Map(); // key -> timeoutId (keeps tiny state)

function _sendTelegramSimple(text) {
  try {
    const token = CONFIG.TELEGRAM?.BOT_TOKEN;
    const chat = CONFIG.TELEGRAM?.CHAT_ID;
    if (!token || !chat) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    // minimal fetch using global fetch if present, else node's fetch may exist in your environment
    // use axios if you prefer; keeping no new deps here
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" })
    }).then(res => {
      if (!res.ok) console.warn("Telegram error:", res.status, res.statusText);
    }).catch(err => console.warn("Telegram error:", err?.message || err));
  } catch (e) {
    // ignore
  }
}

function _detectSimplePattern(c1, c2) {
  // c1 = latest candle, c2 = prev
  if (!c1 || !c2) return [];
  const body = Math.abs(c1.close - c1.open) || 1;
  const lower = Math.abs(Math.min(c1.open, c1.close) - (c1.low ?? c1.l ?? c1.min ?? c1.low));
  const upper = Math.abs((c1.high ?? c1.h ?? c1.max ?? c1.high) - Math.max(c1.open, c1.close));
  const patterns = [];
  if (lower > body * 1.8 && upper < body * 0.5) patterns.push("Hammer");
  if (upper > body * 1.8 && lower < body * 0.5) patterns.push("Shooting Star");
  if (c1.close > c1.open && c2.close < c2.open && c1.open < c2.close && c1.close > c2.open) patterns.push("Bullish Engulfing");
  if (c1.close < c1.open && c2.close > c2.open && c1.open > c2.close && c1.close < c2.open) patterns.push("Bearish Engulfing");
  return patterns;
}

export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  const poll = Number(opts.pollIntervalMs || opts.poll || 15_000);
  const minProb = Number(opts.minProb || 58); // percent
  const cooldownMs = Number(opts.cooldownMs || 60_000); // no duplicate alerts within cooldown
  const feedbackDelayMs = Number(opts.feedbackDelayMs || 60_000); // check feedback after this delay
  const microLookback = Number(opts.microLookback || 100);

  if (_timer) clearInterval(_timer);
  // clear any pending feedback timeouts (safeguard)
  for (const t of _pendingFeedback.values()) clearTimeout(t);
  _pendingFeedback.clear();
  _lastSignal = null;

  _timer = setInterval(async () => {
    try {
      // 1) get micro prediction from ML (lightweight)
      const pred = await runMicroPrediction(symbol, "1m", microLookback).catch(() => null);
      if (!pred || pred.error) return;

      const prob = Number(pred.prob ?? 0); // e.g., 72.34
      const label = pred.label || (prob > 55 ? "Bullish" : prob < 45 ? "Bearish" : "Neutral");

      if (label === "Neutral") return; // nothing to do

      // only consider sufficiently confident predictions
      if (prob < minProb) return;

      // 2) fetch last 2 candles for quick pattern check
      const m = await fetchMarketData(symbol, "1m", 3).catch(() => null);
      const candles = (m && m.data) || [];
      if (candles.length < 2) return;
      const c1 = candles.at(-1);
      const c2 = candles.at(-2);

      const patterns = _detectSimplePattern(c1, c2);

      // 3) require at least one pattern match consistent with label
      let allowed = false;
      if (label === "Bullish" && (patterns.includes("Hammer") || patterns.includes("Bullish Engulfing"))) allowed = true;
      if (label === "Bearish" && (patterns.includes("Shooting Star") || patterns.includes("Bearish Engulfing"))) allowed = true;

      // allow alert even if no pattern *only* if ML prob is very high (>=85)
      if (!allowed && prob >= 85) allowed = true;

      if (!allowed) return;

      const signalKey = `${label}:${Math.round(prob)}:${(patterns.join(","))}`;

      // 4) cooldown dedupe
      if (_lastSignal === signalKey) return;
      // extra check: if last signal same type and last time less than cooldown => skip
      _lastSignal = signalKey;
      setTimeout(() => {
        // after cooldown allow new similar signal
        if (_lastSignal === signalKey) _lastSignal = null;
      }, cooldownMs);

      // 5) send alert (minimal payload)
      const txt = `⚡ *Reversal Alert*\nSymbol: *${symbol}*\nType: *${label}*\nProb: *${prob}%*\nPatterns: *${patterns.join(", ") || "None"}*`;
      _sendTelegramSimple(txt);

      // 6) schedule a one-time feedback check after feedbackDelayMs
      const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const to = setTimeout(async () => {
        try {
          // fetch 1m two candles to compute immediate move
          const r = await fetchMarketData(symbol, "1m", 3).catch(() => null);
          const d = (r && r.data) || [];
          if (d.length < 2) return;
          const prev = Number(d.at(-2).close);
          const last = Number(d.at(-1).close);
          const pct = prev ? ((last - prev) / Math.abs(prev)) * 100 : 0;
          const correct = label === "Bullish" ? pct > 0 : pct < 0;
          const fbTxt = `📊 *Reversal Feedback*\nSymbol: *${symbol}*\nSignal: *${label}* → *${correct ? "Correct ✅" : "Wrong ❌"}*\nMove: *${pct.toFixed(3)}%*`;
          _sendTelegramSimple(fbTxt);
        } catch (e) {
          // ignore
        } finally {
          _pendingFeedback.delete(id);
        }
      }, feedbackDelayMs);

      _pendingFeedback.set(id, to);

    } catch (e) {
      // swallow errors to avoid crashing interval
      // but print minimal trace
      // console.warn("watcher tick err", e?.message || e);
    }
  }, Math.max(1000, poll));

  console.log(`🔎 Reversal Watcher STARTED (light) for ${symbol} — poll ${poll}ms`);
}

export function stopReversalWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  for (const t of _pendingFeedback.values()) clearTimeout(t);
  _pendingFeedback.clear();
  _lastSignal = null;
  console.log("🛑 Reversal Watcher STOPPED (light)");
}