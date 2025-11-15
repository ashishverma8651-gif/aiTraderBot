// aiTraderBot.js — FINAL RENDER-SAFE + TELEGRAM FIX + KEEPALIVE FIX

import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";


// =======================================================
// EXPRESS SERVER (Render requires active server)
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

// Root endpoint
app.get("/", (_, res) => res.send("✅ AI Trader is running"));

// A simple PING endpoint for KeepAlive
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});


// =======================================================
// WEBSOCKET PRICE STREAM (Stable reconnect)
// =======================================================
let lastPrice = 0;
let ws = null;
let alive = false;
let wsIndex = 0;

const WS_MIRRORS = CONFIG.WS_MIRRORS;

function connectWS(sym = CONFIG.SYMBOL) {
  const stream = `${sym.toLowerCase()}@ticker`;

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

    ws.on("message", (d) => {
      try {
        const j = JSON.parse(d.toString());
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
// DATA CONTEXT
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
// TELEGRAM DIRECT SENDER (no polling bot needed)
// =======================================================
async function sendTelegram(msg) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}


// =======================================================
// FIXED AUTO 15m REPORT
// =======================================================
export async function autoReport() {
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(report);

    await sendTelegram(text);   // ← FIXED: REAL TELEGRAM SEND

    console.log("📤 15m report sent");
  } catch (e) {
    console.log("Auto report error:", e.message);
  }
}

// interval (15 mins)
setInterval(autoReport, 15 * 60 * 1000);

// send first report after start (wait 5 seconds)
setTimeout(autoReport, 5000);


// =======================================================
// KEEP ALIVE (Render fix)
// =======================================================
const SELF_URL = CONFIG.SELF_PING_URL;  // MUST be https://your-app.onrender.com/ping

setInterval(async () => {
  try {
    await axios.get(SELF_URL, { timeout: 4000 });
    console.log("💓 KEEPALIVE SUCCESS");
  } catch {
    console.log("⚠ KEEPALIVE FAIL");
  }
}, 240000); // 4 minutes


// =======================================================
// REVERSAL WATCHER
// =======================================================
try {
  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    microLookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60
  });

  console.log("⚡ Reversal Watcher STARTED");
} catch (e) {
  console.log("❌ Reversal watcher failed:", e.message);
}


// =======================================================
// CLEAN SHUTDOWN (Render compatible)
// =======================================================
function shutdown() {
  try { stopReversalWatcher(); } catch {}
  try { if (ws) ws.terminate(); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);


export default {
  getDataContext,
  autoReport
};