// reversal_watcher.js — STABLE V10 (No Spam / No Errors)

import { fetchMarketData } from "./utils.js";
import { runMicroPrediction, runMLPrediction } from "./ml_module_v8_6.js";

let timer = null;
let active = false;

export function startReversalWatcher(symbol, cfg, sendFn) {
  if (active) return;
  active = true;

  console.log("⚡ Reversal Watcher started");

  const poll = async () => {
    try {
      const tf = "15m";
      const r = await fetchMarketData(symbol, tf, 60);

      if (!r || !r.data || r.data.length < 20) {
        console.log("⚠️ No data for watcher");
        return;
      }

      const candles = r.data;
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];

      // SIMPLE + STABLE PATTERN DETECTOR
      const bullish = last.close > last.open && prev.close < prev.open;
      const bearish = last.close < last.open && prev.close > prev.open;

      let pattern = null;
      if (bullish) pattern = "Bullish Reversal (Engulfing)";
      if (bearish) pattern = "Bearish Reversal (Engulfing)";

      if (!pattern) return;

      // ML CONFIDENCE
      const micro = await runMicroPrediction(symbol, candles);
      const ml = await runMLPrediction(symbol, candles);

      if (!ml || !ml.confidence) return;

      if (ml.confidence < cfg.minAlertConfidence) return;

      const msg = `
🔥 <b>${pattern}</b>
<b>${symbol}</b> — ${tf}
Price: <b>${last.close}</b>
ML: <b>${ml.direction} ${ml.confidence}%</b>
Micro: ${micro?.signal || "-"}
Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
      `;

      await sendFn(msg.trim());

    } catch (err) {
      console.log("scan error:", err.message);
    }
  };

  timer = setInterval(poll, cfg.pollIntervalMs || 20000);
  poll(); // run instantly once
}


export function stopReversalWatcher() {
  active = false;
  if (timer) clearInterval(timer);
}