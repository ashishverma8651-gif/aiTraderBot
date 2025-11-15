// aiTraderBot.js — Patched single-instance runner (lightweight + safe + HTML reports)
// Assumes: ./config.js, ./utils.js, ./tg_commands.js, ./ml_module_v8_6.js, ./reversal_watcher.js exist
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

// ---------------------------
// GLOBAL SINGLE-INSTANCE GUARD
// ---------------------------
if (global.__aiTrader_running) {
  console.log("⚠️ aiTrader already running — exiting duplicate instance.");
  process.exit(0);
}
global.__aiTrader_running = true;

// optional file lock to help debugging across restarts
const LOCK_FILE = path.resolve(process.cwd(), ".aitrader.lock");
try {
  fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" });
} catch (_) {}

// ensure lock cleanup on exit
function cleanupAndExit(code = 0) {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
  process.exit(code);
}
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err?.stack || err);
  cleanupAndExit(1);
});
process.on("unhandledRejection", (r) => {
  console.warn("Unhandled Rejection:", r);
});

// ---------------------------
// EXPRESS (Render keep-alive endpoint)
// ---------------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// ---------------------------
// TELEGRAM SENDER (HTML mode)
// ---------------------------
async function sendTelegramHTML(htmlText) {
  try {
    const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
    const chatId = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
    if (!token || !chatId) {
      console.warn("⚠️ Telegram not configured (BOT_TOKEN/CHAT_ID). Skipping send.");
      return { ok: false, reason: "not_configured" };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };

    const resp = await axios.post(url, payload, { timeout: 8000 });
    if (resp?.data?.ok) return { ok: true };
    return { ok: false, reason: resp?.data || "unknown" };
  } catch (e) {
    const code = e?.response?.status;
    if (code) console.warn("Telegram HTTP error:", code);
    else console.warn("Telegram error:", e?.message || e);
    return { ok: false, reason: e?.message || String(e) };
  }
}

// ---------------------------
// WEBSOCKET — stable + throttled updates
// ---------------------------
let lastPrice = 0;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsBackoffMs = 1000;

const WS_MIRRORS = Array.isArray(CONFIG.WS_MIRRORS) && CONFIG.WS_MIRRORS.length
  ? CONFIG.WS_MIRRORS
  : ["wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws"];

function makeTickerStream(symbol = CONFIG.SYMBOL) {
  return `${String(symbol).toLowerCase()}@ticker`;
}

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = makeTickerStream(symbol);
  let aborted = false;

  const tryConnect = () => {
    if (aborted) return;
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) try { ws.terminate(); } catch (_) {}
      ws = new WebSocket(url, { handshakeTimeout: 5000 });

      ws.on("open", () => {
        socketAlive = true;
        wsBackoffMs = 1000;
        console.log("🔗 WS Connected:", url);
      });

      // throttle updates to avoid flood (0.5s)
      let lastUpdate = 0;
      ws.on("message", (data) => {
        try {
          const now = Date.now();
          if (now - lastUpdate < 500) return;
          lastUpdate = now;
          const j = (typeof data === "string") ? JSON.parse(data) : JSON.parse(data.toString());
          if (j && (j.c || j.last_price || j.p)) {
            lastPrice = parseFloat(j.c || j.last_price || j.p) || lastPrice;
          }
        } catch (_) { /* ignore parse errors */ }
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        mirrorIdx++;
        const delay = Math.min(60000, wsBackoffMs + Math.floor(Math.random() * 800));
        wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
        console.warn("⚠️ WS closed", code, (reason && reason.toString) ? reason.toString() : reason, "reconnect in", delay);
        setTimeout(tryConnect, delay);
      });

      ws.on("error", (err) => {
        socketAlive = false;
        mirrorIdx++;
        console.warn("⚠️ WS error:", err?.message || err);
        try { ws.terminate(); } catch (_) {}
        const delay = Math.min(60000, wsBackoffMs + Math.floor(Math.random() * 800));
        wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
        setTimeout(tryConnect, delay);
      });
    } catch (e) {
      mirrorIdx++;
      const delay = Math.min(60000, wsBackoffMs + Math.floor(Math.random() * 800));
      wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
      setTimeout(tryConnect, delay);
    }
  };

  tryConnect();

  return () => {
    aborted = true;
    try { if (ws) ws.terminate(); } catch (_) {}
  };
}

// start WS once
if (!global.__wsStarted) {
  global.__wsStarted = true;
  connectWS(CONFIG.SYMBOL);
  console.log("🌐 WebSocket Started (single instance)");
}

// ---------------------------
// Data context helper
// ---------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || m15.price || 0, candles: m15.data || [], socketAlive };
  } catch (e) {
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// ---------------------------
// AUTO REPORT (single guarded runner)
// ---------------------------
let _autoReportRunning = false;
async function doAutoReport() {
  if (_autoReportRunning) {
    console.log("ℹ️ autoReport already running — skipping tick.");
    return;
  }
  _autoReportRunning = true;
  try {
    // build + format
    const report = await buildAIReport(CONFIG.SYMBOL);
    const formatted = await formatAIReport(report); // returns HTML/text
    // send HTML via our single sender
    const res = await sendTelegramHTML(formatted);
    if (!res.ok) console.warn("AutoReport: telegram send failed", res.reason);
    else console.log("📤 AutoReport sent at", new Date().toLocaleString());
  } catch (e) {
    console.error("autoReport error:", e?.message || e);
  } finally {
    _autoReportRunning = false;
  }
}

// schedule auto report only once
if (!global.__autoReportStarted) {
  global.__autoReportStarted = true;
  const intervalMs = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
  // initial small delay so process stabilizes
  setTimeout(doAutoReport, 5000);
  setInterval(doAutoReport, Math.max(30_000, intervalMs));
  console.log("⏱ AutoReport scheduled every", Math.round(intervalMs/1000), "sec");
}

// ---------------------------
// KEEPALIVE for Render (ping /ping)
// ---------------------------
if (CONFIG.SELF_PING_URL) {
  const SELF_PING = String(CONFIG.SELF_PING_URL).replace(/\/+$/,"") + "/ping";
  setInterval(async () => {
    try {
      await axios.get(SELF_PING, { timeout: 4000 });
      console.log("💓 KEEPALIVE success");
    } catch (e) {
      console.warn("⚠️ KEEPALIVE fail", e?.message || (e?.response && e.response.status));
    }
  }, 4 * 60 * 1000);
} else {
  console.log("ℹ️ SELF_PING_URL not set — keepalive disabled");
}

// ---------------------------
// Reversal watcher integration (lightweight)
// pass our send function to keep watcher minimal (so watcher won't call Telegram directly)
// ---------------------------
try {
  if (typeof startReversalWatcher === "function") {
    // watcher is expected to accept { sendAlert: fn } option to notify
    startReversalWatcher(CONFIG.SYMBOL, {
      pollIntervalMs: Number(CONFIG.REVERSAL_WATCHER_POLL_MS || 15000),
      microLookback: Number(CONFIG.REVERSAL_WATCHER_LOOKBACK || 60),
      minProb: Number(CONFIG.REVERSAL_MIN_PROB || 58),
      // watcher can call this to send alert — we keep HTML mode consistent
      sendAlert: async (txt) => {
        // watcher may pass plain text; convert to simple HTML-safe message
        if (!txt) return;
        // keep small: send as preformatted HTML (escape minimal)
        const safe = String(txt)
          .replace(/&/g,"&amp;")
          .replace(/</g,"&lt;")
          .replace(/>/g,"&gt;")
          .replace(/\n/g,"\n");
        await sendTelegramHTML(`<pre>${safe}</pre>`);
      }
    });
    console.log("⚡ Reversal Watcher started (lightweight)");
  } else {
    console.log("ℹ️ No reversal watcher exported — skipping");
  }
} catch (e) {
  console.warn("⚠️ startReversalWatcher error:", e?.message || e);
}

// ---------------------------
// Optional periodic GC if enabled
// ---------------------------
if (typeof global.gc === "function") {
  setInterval(() => {
    try { global.gc(); console.log("🧹 global.gc() called"); } catch (_) {}
  }, 5 * 60 * 1000);
}

// ---------------------------
// Graceful shutdown wrapper
// ---------------------------
async function gracefulShutdown() {
  try {
    console.log("🛑 Shutdown requested — cleaning...");
    // stop scheduled stuff
    try { if (typeof stopReversalWatcher === "function") await stopReversalWatcher(); } catch (_) {}
    try { if (ws) ws.terminate(); } catch (_) {}
    try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (_) {}
  } catch (e) {
    console.warn("Shutdown warning:", e?.message || e);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ---------------------------
// Exports (so tests/commands can call doAutoReport/getDataContext)
// ---------------------------
export default {
  getDataContext,
  doAutoReport
};