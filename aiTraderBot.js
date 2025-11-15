// aiTraderBot.js — main runner: express server, WS mirror, auto 15m report + KeepAlive
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// =======================================================
// CONFIG SAFETY / DEFAULTS
// =======================================================
const PORT = Number(process.env.PORT || CONFIG.PORT || 10000);
const SYMBOL = CONFIG.SYMBOL || "BTCUSDT";
const REPORT_INTERVAL_MS = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
const WS_MIRRORS = CONFIG.WS_MIRRORS || [
  "wss://data-stream.binance.vision/ws",
  "wss://stream.binance.com:9443/ws"
];
const SELF_PING_URL = CONFIG.SELF_URL || CONFIG.SELF_PING_URL || null;
const KEEPALIVE_MS = Number(CONFIG.KEEPALIVE_MS || 4 * 60 * 1000); // 4 min
const MAX_RECENT_EVENTS = Number(CONFIG.MAX_RECENT_EVENTS || 50);

// =======================================================
// EXPRESS SERVER
// =======================================================
const app = express();
app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.listen(PORT, () =>
  console.log(`✅ Server live on port ${PORT} (${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})`)
);

// =======================================================
// SHARED STATE (kept tiny)
// =======================================================
let lastPrice = null;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsReconnectAttempts = 0;
let recentEvents = [];

// helper to keep small buffer
function pushEvent(msg) {
  try {
    recentEvents.push({ ts: Date.now(), msg });
    if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
  } catch {}
}

// =======================================================
// WS MIRROR (with backoff & sane timeouts)
// =======================================================
function connectWS(symbol = SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;
  const connectInternal = () => {
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : base + "/" + stream;

    try {
      if (ws) {
        try { ws.removeAllListeners(); ws.terminate(); } catch {}
        ws = null;
      }

      ws = new WebSocket(url, { handshakeTimeout: 10_000 });

      ws.on("open", () => {
        socketAlive = true;
        wsReconnectAttempts = 0;
        pushEvent(`WS open ${url}`);
        console.log("🔗 WS Connected:", url);
      });

      ws.on("message", (data) => {
        try {
          const s = typeof data === "string" ? data : data.toString();
          const j = JSON.parse(s);
          // Binance ticker uses 'c' for current price; other mirrors may differ
          const p = parseFloat(j?.c ?? j?.last_price ?? j?.p ?? null);
          if (!Number.isNaN(p)) lastPrice = p;
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        pushEvent(`WS closed ${code}`);
        console.warn("⚠️ WS Closed", code, reason);
        mirrorIdx++;
        scheduleReconnect();
      });

      ws.on("error", (e) => {
        socketAlive = false;
        pushEvent(`WS error ${String(e?.message || e)}`);
        console.warn("⚠️ WS Error:", e?.message || e);
        try { ws.terminate(); } catch {}
        scheduleReconnect();
      });
    } catch (e) {
      socketAlive = false;
      pushEvent(`WS connect fail ${e?.message || e}`);
      mirrorIdx++;
      scheduleReconnect();
    }
  };

  function scheduleReconnect() {
    wsReconnectAttempts++;
    // exponential backoff capped
    const delay = Math.min(120000, 5000 + Math.pow(2, Math.min(wsReconnectAttempts, 8)) * 1000);
    setTimeout(() => {
      try {
        connectInternal();
      } catch (e) {
        mirrorIdx++;
        setTimeout(connectInternal, Math.min(60000, delay * 2));
      }
    }, delay);
  }

  // Start first connect
  connectInternal();
}

// start WS
connectWS(SYMBOL);

// =======================================================
// GET DATA CONTEXT (lightweight)
// =======================================================
async function getDataContext(symbol = SYMBOL) {
  try {
    // Use a smaller default limit at call site (utils uses CONFIG.DEFAULT_LIMIT)
    const m15 = await fetchMarketData(symbol, "15m", Math.max(50, Number(CONFIG.DEFAULT_LIMIT || 120)));
    const candles = m15?.data || [];
    const price = (typeof lastPrice === "number" && !Number.isNaN(lastPrice)) ? lastPrice : (m15?.price || 0);
    return { price, candles, socketAlive };
  } catch (e) {
    console.warn("getDataContext error", e?.message || e);
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// =======================================================
// SEND REPORT (single run, defensive)
// =======================================================
async function sendAutoReport() {
  try {
    const ctx = await getDataContext(SYMBOL);
    // buildAIReport may be heavier; guard with timeout in case of hang
    const report = await buildAIReport(SYMBOL, ctx);
    await formatAIReport(report);
    const nowStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    pushEvent(`15m Report sent: ${nowStr}`);
    console.log("📤 15m Report sent:", nowStr);
  } catch (e) {
    pushEvent(`Auto report error: ${String(e?.message || e)}`);
    console.error("Auto report error:", e?.message || e);
  }
}

// =======================================================
// SAFE SCHEDULER (prevents overlaps)
// =======================================================
let reportRunning = false;
async function safeScheduleReport() {
  if (reportRunning) {
    console.log("🕒 Previous report still running — skipping this tick.");
    return;
  }
  reportRunning = true;
  try {
    await sendAutoReport();
  } catch (e) {
    // already handled in sendAutoReport
  } finally {
    reportRunning = false;
  }
}

// schedule (use setInterval but with guard)
const intervalMs = Number(REPORT_INTERVAL_MS || 15 * 60 * 1000);
const intervalHandle = setInterval(() => safeScheduleReport().catch(()=>{}), intervalMs);

// also run once immediately but guarded
(async () => { try { await safeScheduleReport(); } catch (e) {} })();

// =======================================================
// KEEP-ALIVE (prevent Render idle sleep + reduce memory)
// =======================================================
function startKeepAlive() {
  if (!SELF_PING_URL) {
    console.log("⚠️ SELF_PING_URL not set — skipping keep-alive pings.");
    return;
  }

  // light ping every KEEPALIVE_MS
  setInterval(async () => {
    try {
      await axios.get(SELF_PING_URL, { timeout: 8_000 });
      pushEvent(`KeepAlive ping ok ${new Date().toISOString()}`);
      console.log("💓 KeepAlive Ping:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    } catch (e) {
      pushEvent(`KeepAlive ping failed ${String(e?.message || e)}`);
      console.warn("⚠️ KeepAlive failed:", e?.message || e);
    }
  }, Math.max(60_000, KEEPALIVE_MS)); // not too aggressive
}
startKeepAlive();

// =======================================================
// MEMORY CLEANER (call GC if exposed, low-frequency)
// =======================================================
function startMemoryCleaner() {
  try {
    // only attempt if Node allowed explicit GC
    if (typeof global !== "undefined" && typeof global.gc === "function") {
      setInterval(() => {
        try {
          global.gc();
          pushEvent("♻️ GC invoked");
          // lightweight memory logging
          if (typeof process?.memoryUsage === "function") {
            const mu = process.memoryUsage();
            console.log(`♻️ GC run — RSS:${Math.round(mu.rss/1024/1024)}MB HeapUsed:${Math.round(mu.heapUsed/1024/1024)}MB`);
          }
        } catch (e) {
          console.warn("GC error:", e?.message || e);
        }
      }, 60 * 1000); // every 60s
      console.log("♻️ Memory cleaner (GC) started (node --expose-gc recommended).");
    } else {
      console.log("⚠️ Global GC not available. Start node with --expose-gc to enable memory cleaner.");
    }
  } catch (e) {
    console.warn("startMemoryCleaner err", e?.message || e);
  }
}
startMemoryCleaner();

// =======================================================
// GRACEFUL SHUTDOWN
// =======================================================
async function shutdown(signal) {
  try {
    console.log(`\n🛑 Shutdown (${signal}) — cleaning up...`);
    try { clearInterval(intervalHandle); } catch {}
    try { if (ws) ws.terminate(); } catch {}
    // final small GC
    try { if (global.gc) global.gc(); } catch {}
    console.log("✅ Shutdown complete.");
    process.exit(0);
  } catch (e) {
    console.error("Shutdown error:", e?.message || e);
    process.exit(1);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// =======================================================
// EXPORTS (for tests / external triggers)
// =======================================================
export default {
  sendAutoReport: safeScheduleReport,
  getDataContext: getDataContext,
  pushEvent,
  getRecentEvents: () => recentEvents.slice()
};