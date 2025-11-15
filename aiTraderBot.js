// aiTraderBot.js — FINAL RENDER-SAFE BUILD

import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// =======================================================
// EXPRESS SERVER (REQUIRED for Render Keep-Alive)
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));    // <-- KEEPALIVE ENDPOINT

app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
});

// =======================================================
// WEBSOCKET PRICE STREAM
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
      console.log("🔗 WS connected:", url);
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
async function getDataContext(symbol = CONFIG.SYMBOL) {
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
// AUTO REPORT (EVERY 15m SAFE)
// =======================================================
async function autoReport() {
  try {
    const rpt = await buildAIReport(CONFIG.SYMBOL);
    await formatAIReport(rpt);
    console.log("📤 15m report sent");
  } catch (e) {
    console.log("Auto report error:", e.message);
  }
}

setInterval(autoReport, 15 * 60 * 1000);

// =======================================================
// KEEP ALIVE — FIXED FOR RENDER
// =======================================================
const SELF_URL = `${CONFIG.SELF_PING_URL}/ping`;

setInterval(async () => {
  try {
    await axios.get(SELF_URL, { timeout: 4000 });
    console.log("💓 KEEPALIVE SUCCESS");
  } catch {
    console.log("⚠️ KEEPALIVE FAIL");
  }
}, 240000);

// =======================================================
// REVERSAL WATCHER
// =======================================================
try {
  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    microLookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60,
  });
  console.log("⚡ Reversal watcher started");
} catch (e) {
  console.log("🚫 Reversal watcher error:", e.message);
}

// =======================================================
// CLEAN SHUTDOWN
// =======================================================
function shutdown() {
  try {
    stopReversalWatcher();
    if (ws) ws.terminate();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default {
  getDataContext,
  autoReport
};