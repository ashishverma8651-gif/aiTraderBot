// reversal_watcher.js — Lightweight Reversal Watcher (patched + safe)
// - Uses runMicroPrediction from ml_module_v8_6.js
// - Sends Telegram alerts via provided bot OR via CONFIG (fallback)
// - Small feedback queue, limited memory footprint
// - Escapes Telegram Markdown to avoid 400 errors
// - Rate-limits sends and delays feedback checks to avoid immediate/duplicate feedback

import CONFIG from "./config.js";
import { runMicroPrediction } from "./ml_module_v8_6.js";
import { fetchMarketData } from "./utils.js";

let _timer = null;
let _lastSignal = null;
let _feedback = []; // tiny array of recent signals (kept short)
let _lastSendAt = 0; // timestamp of last Telegram send (throttle)
let _stopped = false;

// -------------------------
// Utilities
// -------------------------
const defaultOpts = {
  pollIntervalMs: 15_000,
  lookback: 60,
  minProb: 58,                 // percent threshold
  feedbackWindowSeconds: 60,   // how long to wait to confirm feedback entries
  minFeedbackAgeSeconds: 10,   // don't check feedback until entry is at least this old
  sendThrottleMs: 3000,        // at most one send per this ms (simple throttle)
  bot: null,
  chatId: CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID
};

// Escape MarkdownV2-ish characters safely for Telegram (we use Markdown, so escape common chars)
function escapeTelegramMarkdown(text = "") {
  // Basic escape for Markdown special characters to be safe with 'Markdown' parse_mode.
  // We escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
  // Note: The original bot used Markdown (not v2). Escaping a broad set is safe.
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")   // dot can cause issues in some markdown flavors
    .replace(/!/g, "\\!");
}

// chunk long texts into Telegram-safe sizes (4096 char limit)
function chunkText(txt, size = 3800) {
  const out = [];
  let i = 0;
  while (i < txt.length) {
    out.push(txt.slice(i, i + size));
    i += size;
  }
  return out;
}

// small helper to actually send messages, supports bot object fallback and HTTP fallback
async function _sendTelegramRaw(bot, chatId, text, options = {}) {
  // throttle: simple guard to avoid flooding Telegram (global per-watcher)
  const now = Date.now();
  if (now - (_lastSendAt || 0) < (options.sendThrottleMs || defaultOpts.sendThrottleMs)) {
    // skip or defer; we choose to skip to keep watcher lightweight
    // you could implement a queue if you want guaranteed delivery
    return { ok: false, msg: "throttled" };
  }

  _lastSendAt = now;

  try {
    // if a bot object is provided and has sendMessage, use it
    if (bot && typeof bot.sendMessage === "function") {
      // bot.sendMessage usually accepts plain text and parse_mode 'Markdown'
      await bot.sendMessage(chatId, text, Object.assign({ parse_mode: "Markdown", disable_web_page_preview: true }, options));
      return { ok: true };
    }

    // fallback: use Telegram HTTP API
    const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
    const cid = chatId || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
    if (!token || !cid) return { ok: false, msg: "telegram_not_configured" };

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: cid,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    };

    // Use fetch (global) or node-fetch if available via utils — but to keep file isolated, use fetch if present
    if (typeof fetch === "function") {
      const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, msg: `http_${resp.status}`, body };
      }
      return { ok: true };
    } else {
      // if fetch not available, use a minimal xhr via node's https would be heavier; skip and return failure
      return { ok: false, msg: "no_fetch_available" };
    }
  } catch (e) {
    // do not spam logs
    // Telegram returns 400 when markdown is bad; we already escape, but still handle gracefully
    return { ok: false, msg: e?.message || String(e) };
  }
}

// safe message sender: escape and chunk
async function _safeSend(bot, chatId, rawText, opts = {}) {
  if (!rawText) return { ok: false, msg: "empty" };
  // escape text
  const escaped = escapeTelegramMarkdown(rawText);
  const chunks = chunkText(escaped);

  let lastRes = { ok: true };
  for (const c of chunks) {
    const res = await _sendTelegramRaw(bot, chatId, c, opts);
    lastRes = res;
    // small pause between chunk sends to avoid throttle clash
    await new Promise(r => setTimeout(r, 200));
  }
  return lastRes;
}

// -------------------------
// Pattern detection (cheap)
function detectSimplePatterns(last, prev) {
  if (!last || !prev) return [];
  const patterns = [];
  const body = Math.abs(last.close - last.open);
  const lower = Math.abs(Math.min(last.open, last.close) - last.low);
  const upper = Math.abs(last.high - Math.max(last.open, last.close));
  if (body > 0 && lower > body * 1.8 && upper < body * 0.5) patterns.push("Hammer");
  if (body > 0 && upper > body * 1.8 && lower < body * 0.5) patterns.push("Shooting Star");
  if ((last.close > last.open) && (prev.close < prev.open) && (last.open < prev.close)) patterns.push("Bullish Engulfing");
  if ((last.close < last.open) && (prev.close > prev.open) && (last.open > prev.close)) patterns.push("Bearish Engulfing");
  return patterns;
}

// -------------------------
// Feedback check: only confirm entries older than minFeedbackAgeSeconds
async function _checkFeedback(symbol, bot, chatId, opts = {}) {
  try {
    if (!_feedback.length) return;
    const now = Date.now();
    const minAge = (opts.minFeedbackAgeSeconds ?? defaultOpts.minFeedbackAgeSeconds) * 1000;
    // only keep feedback entries that are not too old (sliding window)
    const windowMs = (opts.feedbackWindowSeconds ?? defaultOpts.feedbackWindowSeconds) * 1000;
    _feedback = _feedback.filter(f => (now - f.ts) <= windowMs);

    // pick entries that are old enough to evaluate
    const ready = _feedback.filter(f => (now - f.ts) >= minAge);
    if (!ready.length) return;

    // fetch last 2 1m candles
    const ctx = await fetchMarketData(symbol, "1m", 3);
    const data = ctx?.data || [];
    if (data.length < 2) return;
    const lastClose = Number(data.at(-1).close);
    const prevClose = Number(data.at(-2).close);
    const movePct = ((lastClose - prevClose) / Math.max(1, Math.abs(prevClose))) * 100;

    // evaluate and send one message per ready entry (but rate-limited by _safeSend)
    for (const f of ready.splice(0)) {
      // remove this entry from feedback queue (we used splice(0) above to make ready empty)
      // determine correctness
      const correct = (f.type === "Bullish") ? (movePct > 0) : (movePct < 0);
      const txt = [
        `📊 Reversal Feedback`,
        `Signal: *${f.type}*`,
        `Result: *${correct ? "Confirmed ✅" : "Not Confirmed ❌"}*`,
        `Move (1m): *${movePct.toFixed(3)}%*`,
        `Symbol: *${symbol}*`,
        `Time: ${new Date().toLocaleString()}`
      ].join("\n");

      // send (throttled inside _safeSend)
      await _safeSend(bot, chatId, txt, { sendThrottleMs: opts.sendThrottleMs });
    }

    // purge entries we already processed (older than minAge)
    _feedback = _feedback.filter(f => (now - f.ts) < minAge);
  } catch (e) {
    // swallow — we don't want feedback errors to stop watcher
  }
}

// -------------------------
// Start watcher
// -------------------------
export function startReversalWatcher(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  const o = Object.assign({}, defaultOpts, opts);
  // ensure poll within safe bounds
  o.pollIntervalMs = Math.max(5_000, Math.min(60_000, Number(o.pollIntervalMs || defaultOpts.pollIntervalMs)));
  o.lookback = Number(o.lookback || defaultOpts.lookback);
  o.minProb = Number(o.minProb || defaultOpts.minProb);
  o.chatId = o.chatId || defaultOpts.chatId;
  o.sendThrottleMs = Number(o.sendThrottleMs || defaultOpts.sendThrottleMs);
  o.minFeedbackAgeSeconds = Number(o.minFeedbackAgeSeconds ?? defaultOpts.minFeedbackAgeSeconds);
  o.feedbackWindowSeconds = Number(o.feedbackWindowSeconds ?? defaultOpts.feedbackWindowSeconds);

  // clear previous
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lastSignal = _lastSignal || null;
  _stopped = false;

  _timer = setInterval(async () => {
    try {
      // avoid running when stopped
      if (_stopped) return;

      // run micro prediction (light)
      const res = await runMicroPrediction(symbol, "1m", o.lookback);
      if (!res || res.error) return;
      const prob = Number(res.prob || 0);
      const label = res.label || "Neutral";

      // cheap pattern check (use latest 2 candles)
      const ctx = await fetchMarketData(symbol, "1m", 3);
      const candles = ctx?.data || [];
      const last = candles.at(-1) || null;
      const prev = candles.at(-2) || null;
      const patterns = detectSimplePatterns(last, prev);

      // decide signal: require label, prob threshold, and supporting pattern (either from res.patterns or local detect)
      let signal = null;
      if (label === "Bullish" && prob >= o.minProb) {
        const ok = patterns.includes("Hammer") || patterns.includes("Bullish Engulfing") || (Array.isArray(res.patterns) && res.patterns.includes("Bullish Engulfing"));
        if (ok) signal = "Bullish";
      } else if (label === "Bearish" && prob >= o.minProb) {
        const ok = patterns.includes("Shooting Star") || patterns.includes("Bearish Engulfing") || (Array.isArray(res.patterns) && res.patterns.includes("Bearish Engulfing"));
        if (ok) signal = "Bearish";
      }

      // if new signal (not duplicate), report and queue feedback
      if (signal && signal !== _lastSignal) {
        _lastSignal = signal;
        // push feedback entry (small)
        _feedback.push({ ts: Date.now(), type: signal });

        const title = (signal === "Bullish") ? "⚡ Bullish Reversal" : "🔻 Bearish Reversal";
        const patternText = (patterns.length ? patterns.join(", ") : (Array.isArray(res.patterns) ? res.patterns.join(", ") : "None"));
        const msgLines = [
          `${title} detected`,
          `Symbol: *${symbol}*`,
          `ML: *${prob}%*`,
          `Patterns: *${patternText}*`,
          `Time: ${new Date().toLocaleString()}`
        ];
        const msg = msgLines.join("\n");

        // send (escaped + chunked + throttled)
        await _safeSend(o.bot, o.chatId, msg, { sendThrottleMs: o.sendThrottleMs });
      }

      // run feedback check (but it will only evaluate entries older than minFeedbackAgeSeconds)
      // do not await too long; allow it to run but keep it non-blocking and safe
      _checkFeedback(symbol, o.bot, o.chatId, o).catch(() => {});

    } catch (e) {
      // swallow errors so watcher keeps running; don't log stack every time
      // minimal log for debugging if needed
      // console.warn("reversal_watcher error", e?.message || e);
    }
  }, o.pollIntervalMs);

  return true;
}

// -------------------------
// Stop watcher
// -------------------------
export async function stopReversalWatcher() {
  _stopped = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lastSignal = null;
  _feedback = [];
  return true;
}

export default { startReversalWatcher, stopReversalWatcher };