// reversal_watcher.js — Lightweight Reversal Watcher (balanced)
// - Uses runMicroPrediction from ml_module_v8_6.js
// - Sends Telegram alerts via provided bot OR via CONFIG (fallback)
// - Small feedback queue, limited memory footprint
import CONFIG from "./config.js";
import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";

let _timer = null;
let _lastSignal = null;
let _feedback = []; // tiny array of recent signals (kept short)

// helper: send telegram via bot (if provided) else via HTTP API
async function _sendTelegram(bot, chatId, text, options = {}) {
  try {
    if (bot && typeof bot.sendMessage === "function") {
      await bot.sendMessage(chatId || CONFIG.TELEGRAM?.CHAT_ID, text, Object.assign({ parse_mode: "Markdown", disable_web_page_preview: true }, options));
      return;
    }
    // fallback: use Telegram HTTP API
    const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
    const cid = chatId || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
    if (!token || !cid) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ chat_id: cid, text, parse_mode: "Markdown", disable_web_page_preview: true }) });
  } catch (e) {
    // don't spam logs
    console.warn("reversal_watcher._sendTelegram err", e?.message || e);
  }
}

// simple pattern filter (use last 2 candles)
function detectSimplePatterns(last, prev) {
  if (!last || !prev) return [];
  const patterns = [];
  const body = Math.abs(last.close - last.open);
  const lower = Math.abs(Math.min(last.open, last.close) - last.low);
  const upper = Math.abs(last.high - Math.max(last.open, last.close));
  if (lower > body * 1.8 && upper < body * 0.5) patterns.push("Hammer");
  if (upper > body * 1.8 && lower < body * 0.5) patterns.push("Shooting Star");
  if ((last.close > last.open) && (prev.close < prev.open) && (last.open < prev.close)) patterns.push("Bullish Engulfing");
  if ((last.close < last.open) && (prev.close > prev.open) && (last.open > prev.close)) patterns.push("Bearish Engulfing");
  return patterns;
}

// feedback checker: after X seconds check if small move confirmed (keeps tiny state)
async function _checkFeedback(symbol, bot, chatId, maxAgeSeconds = 45) {
  try {
    if (!_feedback.length) return;
    const now = Date.now();
    // keep only recent items
    _feedback = _feedback.filter(f => now - f.ts <= maxAgeSeconds * 1000);
    if (!_feedback.length) return;
    // fetch last 2 1m candles
    const ctx = await fetchMarketData(symbol, "1m", 3);
    const data = ctx?.data || [];
    if (data.length < 2) return;
    const last = data.at(-1).close, prev = data.at(-2).close;
    const movePct = ((last - prev)/Math.max(1, Math.abs(prev))) * 100;
    // evaluate each feedback entry
    for (const f of _feedback.splice(0)) {
      const correct = f.type === "Bullish" ? movePct > 0 : movePct < 0;
      const txt = `📊 Reversal Feedback\nSignal: *${f.type}*\nResult: *${correct ? "Confirmed ✅" : "Not Confirmed ❌"}*\nMove (1m): *${movePct.toFixed(3)}%*`;
      await _sendTelegram(bot, chatId, txt);
    }
  } catch (e) {
    // ignore
  }
}

// start watcher
export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  const poll = Number(opts.pollIntervalMs ?? opts.pollInterval ?? 15_000);
  const lookback = Number(opts.lookback ?? 60);
  const minProb = Number(opts.minProb ?? 58); // percent threshold for micro prediction
  const bot = opts.bot || null;
  const chatId = opts.chatId || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;

  if (_timer) clearInterval(_timer);
  _timer = setInterval(async () => {
    try {
      const res = await runMicroPrediction(symbol, "1m", lookback);
      if (!res || res.error) return;
      const prob = Number(res.prob || 0);
      const label = res.label || "Neutral";

      // cheap pattern check
      const ctx = await fetchMarketData(symbol, "1m", 3);
      const candles = ctx?.data || [];
      const last = candles.at(-1) || null, prev = candles.at(-2) || null;
      const patterns = detectSimplePatterns(last, prev);

      // decide
      let signal = null;
      if (label === "Bullish" && prob >= minProb && (patterns.includes("Hammer") || patterns.includes("Bullish Engulfing") || res.patterns?.includes("Bullish Engulfing"))) signal = "Bullish";
      if (label === "Bearish" && prob >= minProb && (patterns.includes("Shooting Star") || patterns.includes("Bearish Engulfing") || res.patterns?.includes("Bearish Engulfing"))) signal = "Bearish";

      if (signal && signal !== _lastSignal) {
        _lastSignal = signal;
        // push small feedback entry
        _feedback.push({ ts: Date.now(), type: signal });
        // compose message
        const title = signal === "Bullish" ? "⚡ Bullish Reversal" : "🔻 Bearish Reversal";
        const msg = `${title} detected\nSymbol: *${symbol}*\nML: *${prob}%*\nPatterns: *${(patterns.length?patterns.join(", "): (res.patterns?.join(", ") || "None"))}*\nTime: ${new Date().toLocaleString()}`;
        await _sendTelegram(bot, chatId, msg);
      }

      // run quick feedback check (non-blocking)
      _checkFeedback(symbol, bot, chatId, opts.feedbackWindowSeconds ?? 60).catch(()=>{});
    } catch (e) {
      // swallow errors to avoid memory growth from thrown stacks
      // keep running
    }
  }, Math.max(5_000, Math.min(60_000, poll)));

  return true;
}

// stop watcher
export async function stopReversalWatcher() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _lastSignal = null;
  _feedback = [];
  return true;
}

export default { startReversalWatcher, stopReversalWatcher };