// aiTraderBot.js — FINAL BUILD (ML v16 + Lightweight Reversal Watcher + Render-safe)

import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// ML v16 (Balanced)
import ml from "./ml_module_v8_6.js";

// Lightweight Reversal Watcher
import { startReversalWatcher } from "./reversal_watcher.js";


// =======================================================
// EXPRESS SERVER (Render requires server always ON)
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});


// =======================================================
// WEBSOCKET LIVE PRICE STREAM (stable reconnect)
// =======================================================
let lastPrice = 0;
let ws = null;
let alive = false;
let wsIndex = 0;

const WS_MIRRORS = CONFIG.WS_MIRRORS;

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;

  function open() {
    const base = WS_MIRRORS[wsIndex % WS_MIRRORS.length];
    const url = `${base}/${stream}`;

    try {
      if (ws) ws.terminate();
    } catch {}

    ws = new WebSocket(url);

    ws.on("open", () => {
      alive = true;
      console.log("🔗 WS Connected:", url);
    });

    ws.on("message", (msg) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j.c) lastPrice = parseFloat(j.c);
      } catch {}
    });

    ws.on("close", () => {
      alive = false;
      wsIndex++;
      setTimeout(open, 2500);
    });

    ws.on("error", () => {
      alive = false;
      wsIndex++;
      try { ws.terminate(); } catch {}
      setTimeout(open, 2500);
    });
  }

  open();
}

connectWS(CONFIG.SYMBOL);


// =======================================================
// DATA CONTEXT PROVIDER
// =======================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);

    return {
      price: lastPrice || m15.price || 0,
      candles: m15.data || [],
      socketAlive: alive
    };
  } catch {
    return { price: lastPrice, candles: [], socketAlive: alive };
  }
}


// =======================================================
// TELEGRAM DIRECT SENDER
// =======================================================
async function sendTelegram(msg) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: msg,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
  } catch (e) {
    console.log("Telegram Error:", e.message);
  }
}


// =======================================================
// FIXED AUTO 15m REPORT SENDER
// =======================================================
export async function autoReport() {
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(report);

    await sendTelegram(text);

    console.log("📤 15m report sent");
  } catch (e) {
    console.log("Auto report error:", e.message);
  }
}

// Schedule 15m reports
setInterval(autoReport, 15 * 60 * 1000);

// Send 1st report after 5 sec
setTimeout(autoReport, 5000);


// =======================================================
// KEEPALIVE FOR RENDER
// =======================================================
const SELF_URL = `${CONFIG.SELF_PING_URL}/ping`;

setInterval(async () => {
  try {
    await axios.get(SELF_URL, { timeout: 4000 });
    console.log("💓 KEEPALIVE OK");
  } catch {
    console.log("⚠️ KEEPALIVE FAIL");
  }
}, 240000); // 4 min


// =======================================================
// ML v16 AUTO RETRAIN START
// =======================================================
ml.startAutoRetrain();   // Balanced → retrains every 12 hours safely


// =======================================================
// LIGHTWEIGHT REVERSAL WATCHER START
// =======================================================
try {
  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    lookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60,
    minProb: CONFIG.REVERSAL_MIN_PROB || 58
  });

  console.log("⚡ Reversal Watcher STARTED");
} catch (e) {
  console.log("❌ Reversal watcher failed:", e.message);
}


// =======================================================
// EXPORTS
// =======================================================
export default {
  getDataContext,
  autoReport
};