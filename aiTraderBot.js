// aiTraderBot.js — Memory-safer final build (drop-in)
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// ML v16 (balanced) — keep import, but ML module should be memory-aware
import ml from "./ml_module_v8_6.js";

// Reversal watcher must export startReversalWatcher and stopReversalWatcher
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// ---------------------------
// App + server
// ---------------------------
const app = express();
const PORT = Number(process.env.PORT || CONFIG.PORT || 10000);

app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.get("/ping", (_, res) => res.send("pong")); // keep-alive endpoint

const server = app.listen(PORT, () => {
  console.log(`✅ Server live on port ${PORT}`);
});

// ---------------------------
// WebSocket price mirror (robust + small memory foot)
// ---------------------------
let lastPrice = 0;
let socketAlive = false;
let ws = null;
let wsMirrorIndex = 0;
let wsBackoff = 1000;

const WS_MIRRORS = Array.isArray(CONFIG.WS_MIRRORS) && CONFIG.WS_MIRRORS.length
  ? CONFIG.WS_MIRRORS
  : ["wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws"];

function makeStream(sym) {
  return `${String(sym || CONFIG.SYMBOL || "BTCUSDT").toLowerCase()}@ticker`;
}

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = makeStream(symbol);
  let closedByUs = false;

  async function _connect() {
    const base = WS_MIRRORS[wsMirrorIndex % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) {
        try { closedByUs = true; ws.terminate(); } catch {}
        ws = null;
      }
      closedByUs = false;
      ws = new WebSocket(url, { handshakeTimeout: 5000 });

      ws.on("open", () => {
        socketAlive = true;
        wsBackoff = 1000;
        console.log("🔗 WS connected:", url);
      });

      ws.on("message", (msg) => {
        // lightweight parse + defensive
        try {
          const s = typeof msg === "string" ? msg : msg.toString();
          const j = JSON.parse(s);
          // Binance ticker uses 'c' for last price
          const p = j?.c ?? j?.last_price ?? j?.p ?? null;
          if (p != null) lastPrice = parseFloat(p);
        } catch (e) {
          // ignore parse noise
        }
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        if (!closedByUs) {
          console.warn("⚠️ WS closed", code, reason?.toString?.slice?.(0,150) || reason);
          wsMirrorIndex++;
          const delay = Math.min(wsBackoff, 60000);
          wsBackoff = Math.min(60000, Math.floor(wsBackoff * 1.8));
          setTimeout(_connect, delay + Math.floor(Math.random() * 500));
        }
      });

      ws.on("error", (err) => {
        socketAlive = false;
        console.warn("⚠️ WS error", err?.message || err);
        try { ws.terminate(); } catch {}
        wsMirrorIndex++;
        const delay = Math.min(wsBackoff, 60000);
        wsBackoff = Math.min(60000, Math.floor(wsBackoff * 1.8));
        setTimeout(_connect, delay + Math.floor(Math.random() * 500));
      });
    } catch (e) {
      console.warn("WS connect failed:", e?.message || e);
      wsMirrorIndex++;
      setTimeout(_connect, Math.min(wsBackoff, 60000));
      wsBackoff = Math.min(60000, Math.floor(wsBackoff * 1.8));
    }
  }

  _connect();

  // return a stop function
  return () => {
    closedByUs = true;
    try { if (ws) ws.terminate(); } catch {}
    ws = null;
  };
}

// start once
const stopWS = connectWS(CONFIG.SYMBOL);

// ---------------------------
// Data context
// ---------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const resp = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || resp.price || 0, candles: resp.data || [], socketAlive };
  } catch (e) {
    console.warn("getDataContext err", e?.message || e);
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// ---------------------------
// Telegram sender (single function with small retry)
// ---------------------------
async function sendTelegram(text, tries = 1) {
  if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) return;
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    }, { timeout: 8000 });
    return true;
  } catch (e) {
    if (tries < 2) {
      // short backoff then retry once
      await new Promise(r => setTimeout(r, 600));
      return sendTelegram(text, tries+1);
    }
    console.warn("Telegram error:", e?.response?.status, e?.message || e);
    return false;
  }
}

// ---------------------------
// Auto 15m report (single interval, guarded)
// ---------------------------
let reportTimer = null;
async function sendAutoReport() {
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(report); // formatAIReport returns text (adapter in your project)
    await sendTelegram(text);
    console.log("📤 15m report sent:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  } catch (e) {
    console.error("AutoReport error:", e?.message || e);
  }
}
function startAutoReport() {
  if (reportTimer) return;
  reportTimer = setInterval(sendAutoReport, Number(CONFIG.REPORT_INTERVAL_MS || 15*60*1000));
  // initial (give server settle)
  setTimeout(sendAutoReport, 3000);
}
startAutoReport();

// ---------------------------
// Keepalive ping (Render-safe)
// ---------------------------
let keepAliveTimer = null;
function startKeepAlive() {
  const SELF = (CONFIG.SELF_PING_URL || process.env.SELF_PING_URL || "").replace(/\/$/, "") + "/ping";
  if (!SELF || SELF.includes("null") || SELF.includes("undefined")) {
    console.warn("⚠️ SELF_PING_URL not set — skipping keepalive");
    return;
  }
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    try {
      await axios.get(SELF, { timeout: 5000 });
      // minimal log
      console.log("💓 keepalive ok");
    } catch (e) {
      console.warn("⚠️ keepalive fail:", e?.message || e?.response?.status || "");
    }
  }, 4 * 60 * 1000);
}
startKeepAlive();

// ---------------------------
// Reversal watcher integration — LIGHTWEIGHT
// Uses ml.runMicroPrediction but keeps interval low-memory and optional
// ---------------------------
let reversalHandle = null;
function startLightweightWatcher() {
  // don't start if not configured
  if (!CONFIG.REVERSAL_WATCHER_ENABLED && CONFIG.REVERSAL_WATCHER_ENABLED !== undefined) {
    console.log("ℹ️ Reversal watcher disabled via config");
    return;
  }

  try {
    reversalHandle = startReversalWatcher(CONFIG.SYMBOL, {
      pollIntervalMs: Number(CONFIG.REVERSAL_WATCHER_POLL_MS || 15000),
      microLookback: Number(CONFIG.REVERSAL_WATCHER_LOOKBACK || 60),
      minProb: Number(CONFIG.REVERSAL_MIN_PROB || 58),
      // pass sendTelegram so watcher can alert, avoid duplicating bot logic
      sendTelegram
    });
    console.log("⚡ Lightweight reversal watcher started");
  } catch (e) {
    console.warn("Reversal watcher start failed:", e?.message || e);
  }
}
startLightweightWatcher();

// ---------------------------
// Graceful shutdown
// ---------------------------
async function shutdown(signal) {
  console.log(`\n🛑 Shutdown (${signal})`);
  try {
    if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    try { stopWS(); } catch {}
    try { if (typeof stopReversalWatcher === "function") await stopReversalWatcher(); } catch {}
    try { if (server) server.close(); } catch {}
  } catch (e) { console.warn("shutdown err", e?.message || e); }
  // small delay then exit
  setTimeout(() => process.exit(0), 600);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught:", err?.stack || err);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (r) => {
  console.warn("UnhandledRejection:", r);
});

export default {
  getDataContext,
  sendAutoReport
};