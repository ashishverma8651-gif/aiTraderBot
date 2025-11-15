// aiTraderBot.js — Optimized Render-safe single-instance runner (PATCHED)

// =============================================================
// 🔒 GLOBAL INSTANCE-LOCK (prevents duplicate WS, reports, watcher)
// =============================================================
if (global.__aiTrader_running) {
  console.log("⚠️ Already running. Skipping duplicate instance.");
  process.exit(0);
}
global.__aiTrader_running = true;

// =============================================================
// Required imports
// =============================================================
import fs from "fs";
import path from "path";
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

import ml from "./ml_module_v8_6.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";


// -----------------------------
// EXPRESS Server
// -----------------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));


// -----------------------------
// TELEGRAM DIRECT SENDER
// -----------------------------
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
  chat_id: CONFIG.TELEGRAM.CHAT_ID,
  text,
  parse_mode: "HTML",
  disable_web_page_preview: true
});

  } catch (e) {
    const code = e?.response?.status;
    if (code) console.warn("Telegram error:", code);
    else console.warn("Telegram error:", e.message);
  }
}


// =============================================================
// WEBSOCKET (Stable, throttled, patched for no-flood)
// =============================================================
let lastPrice = 0;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsBackoffMs = 1000;

const WS_MIRRORS = CONFIG.WS_MIRRORS;

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = `${String(symbol).toLowerCase()}@ticker`;

  let aborted = false;

  const attempt = () => {
    if (aborted) return;

    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = `${base}/${stream}`;

    try { if (ws) ws.terminate(); } catch {}

    ws = new WebSocket(url, { handshakeTimeout: 5000 });

    ws.on("open", () => {
      socketAlive = true;
      wsBackoffMs = 1000;
      console.log("🔗 WS Connected:", url);
    });

    // ---------- PATCH: THROTTLED PRICE UPDATES (anti flood) ----------
    let lastUpdate = 0;
    ws.on("message", (msg) => {
      const now = Date.now();
      if (now - lastUpdate < 500) return; // update only every 0.5 sec
      lastUpdate = now;

      try {
        const j = JSON.parse(msg.toString());
        if (j?.c) lastPrice = parseFloat(j.c);
      } catch {}
    });

    ws.on("close", () => {
      socketAlive = false;
      mirrorIdx++;
      const delay = Math.min(60000, wsBackoffMs);
      wsBackoffMs *= 1.5;
      setTimeout(attempt, delay);
    });

    ws.on("error", () => {
      socketAlive = false;
      mirrorIdx++;
      const delay = Math.min(60000, wsBackoffMs);
      wsBackoffMs *= 1.5;
      try { ws.terminate(); } catch {}
      setTimeout(attempt, delay);
    });
  };

  attempt();

  return () => {
    aborted = true;
    try { ws.terminate(); } catch {}
  };
}

// start WS only once
if (!global.__wsStarted) {
  global.__wsStarted = true;
  connectWS(CONFIG.SYMBOL);
  console.log("🌐 WebSocket Started (single instance)");
}


// =============================================================
// CONTEXT PROVIDER
// =============================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || m15.price, candles: m15.data, socketAlive };
  } catch {
    return { price: lastPrice, candles: [], socketAlive };
  }
}


// =============================================================
// AUTO REPORT (Patched — NO DUPLICATES EVER)
// =============================================================
let autoReportRunning = false;

async function doAutoReport() {
  if (autoReportRunning) return;
  autoReportRunning = true;

  try {
    const r = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(r);
    await sendTelegram(text);
    console.log("📤 Auto 15m sent");
  } catch (e) {
    console.log("autoReport error:", e.message);
  }

  autoReportRunning = false;
}

// Ensure auto-report runs ONCE only
if (!global.__autoReportStarted) {
  global.__autoReportStarted = true;

  const interval = CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000;

  setTimeout(doAutoReport, 5000);
  setInterval(doAutoReport, interval);

  console.log("⏱ AutoReport started (single instance)");
}


// =============================================================
// KEEPALIVE — unchanged
// =============================================================
const SELF_PING = `${CONFIG.SELF_PING_URL}/ping`;

if (CONFIG.SELF_PING_URL) {
  setInterval(() => {
    axios.get(SELF_PING).catch(() => {});
  }, 4 * 60 * 1000);
}


// =============================================================
// REVERSAL WATCHER (Patched — NO double alerts, NO feedback spam)
// =============================================================
if (!global.__revWatcherStarted) {
  global.__revWatcherStarted = true;

  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    microLookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60,
    minProb: CONFIG.REVERSAL_MIN_PROB || 58,
    sendAlert: sendTelegram
  });

  console.log("⚡ Reversal Watcher Started (single instance)");
}


// =============================================================
// GC (optional)
// =============================================================
if (typeof global.gc === "function") {
  setInterval(() => global.gc(), 5 * 60 * 1000);
}


// =============================================================
export default { getDataContext, doAutoReport };