// reversal_watcher.js — FINAL WORKING VERSION

import { runMicroPrediction } from "./ml_module_v8_6.js";
import CONFIG from "./config.js";

let timer = null;
let lastSignal = null;

export function startReversalWatcher(symbol, opts = {}) {
  const pollMs = opts.pollIntervalMs || 15000;
  const lookback = opts.lookback || 60;
  const bot = opts.bot || null;
  const chatId = opts.chatId || null;

  if (timer) clearInterval(timer);

  timer = setInterval(async () => {
    try {
      const pred = await runMicroPrediction(symbol, "1m", lookback);
      if (!pred || pred.error) return;

      const label = pred.label;
      const prob = pred.prob;

      let signal = null;

      if (label === "Bullish" && prob >= 58) signal = "Bullish Reversal";
      if (label === "Bearish" && prob >= 58) signal = "Bearish Reversal";

      if (signal && signal !== lastSignal) {
        lastSignal = signal;

        if (bot && chatId) {
          await bot.sendMessage(
            chatId,
            `⚡ *${signal} Detected*\nSymbol: *${symbol}*\nProbability: *${prob}%*`,
            { parse_mode: "Markdown" }
          );
        }
      }

    } catch (e) {
      console.log("Watcher error:", e.message);
    }
  }, pollMs);

  console.log(`🔎 Reversal Watcher STARTED for ${symbol} (${pollMs}ms)`);
}

export function stopReversalWatcher() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("🛑 Reversal Watcher STOPPED");
  }
}