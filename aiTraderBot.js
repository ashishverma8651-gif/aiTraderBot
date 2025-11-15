// aiTraderBot.js — FINAL MERGED + PATACHED + KEEPALIVE + NO HTML BUG
// =====================================================================
// 🔒 GLOBAL INSTANCE-LOCK (prevents duplicate WS, reports, watcher)
// =====================================================================
if (global.__aiTrader_running) {
  console.log("⚠️ Already running. Skipping duplicate instance.");
  process.exit(0);
}
global.__aiTrader_running = true;

// =====================================================================
// Required imports
// =====================================================================
import express from "express";
import WebSocket from "ws";
import axios from "axios";
import CONFIG from "./config.js";

import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher } from "./reversal_watcher.js";

// =====================================================================
// EXPRESS Server
// =====================================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));
app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// =====================================================================
// TELEGRAM DIRECT SENDER — FIXED (Markdown Only, no HTML ever)
// =====================================================================
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      }
    );
  } catch (e) {
    console.log("Telegram error:", e?.response?.status || e.message);
  }
}

// =====================================================================
// WEBSOCKET — Fully Patched (No flood, No leak, Auto reconnect)
// =====================================================================
let lastPrice = 0;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsBackoffMs = 1000;

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = `${String(symbol).toLowerCase()}@ticker`;
  let aborted = false;

  const attempt = () => {
    if (aborted) return;

    const mirror = CONFIG.WS_MIRRORS[mirrorIdx % CONFIG.WS_MIRRORS.length];
    const url = `${mirror}/${stream}`;

    try { ws?.terminate(); } catch {}

    ws = new WebSocket(url, { handshakeTimeout: 5000 });

    ws.on("open", () => {
      socketAlive = true;
      wsBackoffMs = 1000;
      console.log("🔗 WS Connected:", url);
    });

    // THROTTLE: only read ticker 1× per 500ms
    let lastUpdate = 0;
    ws.on("message", msg => {
      const now = Date.now();
      if (now - lastUpdate < 500) return;
      lastUpdate = now;

      try {
        const json = JSON.parse(msg.toString());
        if (json?.c) lastPrice = parseFloat(json.c);
      } catch {}
    });

    const restart = () => {
      socketAlive = false;
      mirrorIdx++;
      wsBackoffMs = Math.min(60000, wsBackoffMs * 1.5);
      setTimeout(attempt, wsBackoffMs);
    };

    ws.on("close", restart);
    ws.on("error", restart);
  };

  attempt();

  return () => {
    aborted = true;
    try { ws?.terminate(); } catch {}
  };
}

// only once
if (!global.__wsStarted) {
  global.__wsStarted = true;
  connectWS(CONFIG.SYMBOL);
  console.log("🌐 WebSocket Started (single instance)");
}

// =====================================================================
// CONTEXT PROVIDER
// =====================================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return {
      price: lastPrice || m15.price,
      candles: m15.data,
      socketAlive
    };
  } catch {
    return { price: lastPrice, candles: [], socketAlive };
  }
}

// =====================================================================
// AUTO REPORT — FINAL (No duplicates, No HTML bug, No memory leak)
// =====================================================================
let autoReportRunning = false;

async function doAutoReport() {
  if (autoReportRunning) return;
  autoReportRunning = true;

  try {
    const r = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(r);

    await sendTelegram(text);
    console.log("📤 Auto 15m Report Sent");
  } catch (e) {
    console.log("autoReport error:", e.message);
  }

  autoReportRunning = false;
}

if (!global.__autoReportStarted) {
  global.__autoReportStarted = true;

  const interval = CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000;

  setTimeout(doAutoReport, 5000);
  setInterval(doAutoReport, interval);

  console.log("⏱ AutoReport started (single instance)");
}

// =====================================================================
// KEEPALIVE — Render Safe (prevents sleep)
// =====================================================================
if (CONFIG.SELF_PING_URL) {
  const PING_URL = `${CONFIG.SELF_PING_URL}/ping`;

  setInterval(() => {
    axios
      .get(PING_URL)
      .then(() => console.log("🔄 KeepAlive OK"))
      .catch(() => console.log("⚠️ KeepAlive failed"));
  }, 4 * 60 * 1000);
}

// =====================================================================
// REVERSAL WATCHER — Single instance, no duplicate alerts
// =====================================================================
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

// =====================================================================
// Optional GC
// =====================================================================
if (typeof global.gc === "function") {
  setInterval(() => global.gc(), 5 * 60 * 1000);
}

// =====================================================================
export default { getDataContext, doAutoReport };