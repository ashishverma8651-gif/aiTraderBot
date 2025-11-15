// aiTraderBot.js — main runner: express server, WS mirror, auto 15m report + KeepAlive + Reversal Watcher
import express from "express";
import WebSocket from "ws";
import axios from "axios";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// Reversal watcher module (standalone file). Should export startReversalWatcher(symbol, opts) and stopReversalWatcher()
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// =======================================================
// EXPRESS SERVER
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.listen(PORT, () =>
  console.log(
    `✅ Server live on port ${PORT} (${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    })})`
  )
);

// =======================================================
// WEBSOCKET LIVE PRICE - robust mirror list + reconnect/backoff
// =======================================================
let lastPrice = null;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsBackoffMs = 1000;

const WS_MIRRORS = (CONFIG.WS_MIRRORS && CONFIG.WS_MIRRORS.length)
  ? CONFIG.WS_MIRRORS
  : [
      // prefer endpoints known to be stable from Binance
      "wss://stream.binance.com:9443/ws",
      "wss://data-stream.binance.vision/ws",
      "wss://fstream.binance.com/ws"
    ];

function makeTickerStream(symbol) {
  // keep classic ticker stream that is widely supported
  const s = symbol.toLowerCase();
  return `${s}@ticker`;
}

function connectWS(symbol = CONFIG.SYMBOL || "BTCUSDT") {
  const stream = makeTickerStream(symbol);
  const connectOnce = () => {
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) {
        try { ws.terminate(); } catch (_) {}
        ws = null;
      }

      ws = new WebSocket(url, { handshakeTimeout: 5000 });

      ws.on("open", () => {
        socketAlive = true;
        wsBackoffMs = 1000; // reset backoff
        console.log("🔗 WS Connected:", url);
      });

      ws.on("message", (data) => {
        try {
          const j = typeof data === "string" ? JSON.parse(data) : JSON.parse(data.toString());
          // Binance ticker uses 'c' for last price; other endpoints may use 'last_price'
          if (j && (j.c || j.last_price || j.p)) {
            lastPrice = parseFloat(j.c || j.last_price || j.p);
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn("⚠️ WS Closed", code, reason?.toString?.() || reason);
        mirrorIdx++;
        tryReconnectWithBackoff();
      });

      ws.on("error", (e) => {
        socketAlive = false;
        console.warn("⚠️ WS Error:", e?.message || e);
        try { ws.terminate(); } catch (_) {}
        mirrorIdx++;
        tryReconnectWithBackoff();
      });
    } catch (e) {
      socketAlive = false;
      mirrorIdx++;
      tryReconnectWithBackoff();
    }
  };

  function tryReconnectWithBackoff() {
    // exponential backoff capped
    const delay = Math.min(wsBackoffMs, 60 * 1000);
    wsBackoffMs = Math.min(60000, wsBackoffMs * 1.8);
    setTimeout(connectOnce, delay + Math.floor(Math.random() * 800));
  }

  connectOnce();
}

// start WS
connectWS(CONFIG.SYMBOL);

// =======================================================
// DATA CONTEXT helper (used by auto report & watcher)
async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    const candles = m15.data || [];
    const price = (typeof lastPrice === "number" && !Number.isNaN(lastPrice)) ? lastPrice : (m15.price || 0);
    return { price, candles, socketAlive };
  } catch (e) {
    console.warn("getDataContext error", e?.message || e);
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// =======================================================
// AUTO REPORT (every 15m) — time in Asia/Kolkata shown
// =======================================================
async function sendAutoReport() {
  try {
    const ctx = await getDataContext(CONFIG.SYMBOL);
    // buildAIReport signature in your project expects symbol (some versions accept ctx, optional)
    // this call uses only symbol; if your buildAIReport accepts ctx, change accordingly
    const report = await buildAIReport(CONFIG.SYMBOL);
    await formatAIReport(report);

    console.log(
      "📤 15m Report sent:",
      new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    );
  } catch (e) {
    console.error("Auto report error:", e?.message || e);
  }
}

// Use CONFIG.REPORT_INTERVAL_MS if set; else default 15 minutes
const REPORT_INTERVAL = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
let reportTimer = setInterval(sendAutoReport, REPORT_INTERVAL);

// send one immediate report on startup (non-blocking)
(async () => {
  try {
    await sendAutoReport();
  } catch (e) {
    console.warn("Startup initial report failed:", e?.message || e);
  }
})();

// =======================================================
// KEEP-ALIVE (Prevent Render from Sleeping)
// =======================================================
const SELF_PING_URL = process.env.SELF_PING_URL || CONFIG.SELF_PING_URL || null;
let keepAliveTimer = null;

function startKeepAlive() {
  if (!SELF_PING_URL) {
    console.log("⚠️ SELF_PING_URL not set — skipping keep-alive pings.");
    return;
  }
  // ping every ~4 minutes
  keepAliveTimer = setInterval(async () => {
    try {
      await axios.get(SELF_PING_URL, { timeout: 8000 });
      console.log("💓 KeepAlive Ping:", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    } catch (e) {
      console.warn("⚠️ KeepAlive ping failed:", e?.message || e);
    }
  }, 4 * 60 * 1000);
  console.log("✅ KeepAlive started ->", SELF_PING_URL);
}

startKeepAlive();

// =======================================================
// Reversal Watcher integration
// - expects ./reversal_watcher.js to export startReversalWatcher(symbol, options) and stopReversalWatcher()
// - we start it with modest poll interval to keep memory low
// =======================================================
try {
  const watcherOptions = {
    pollIntervalMs: Number(CONFIG.REVERSAL_WATCHER_POLL_MS || 15 * 1000), // default 15s
    microLookback: Number(CONFIG.REVERSAL_WATCHER_LOOKBACK || 60),
    telegramAlert: true, // reversal_watcher should handle sending telegram alerts (or call back)
    maxMemorySamples: Number(CONFIG.REVERSAL_WATCHER_MAX_SAMPLES || 200)
  };

  if (typeof startReversalWatcher === "function") {
    startReversalWatcher(CONFIG.SYMBOL, watcherOptions);
    console.log("✅ Reversal Watcher started for", CONFIG.SYMBOL, `(poll ${watcherOptions.pollIntervalMs}ms)`);
  } else {
    console.warn("⚠️ startReversalWatcher not found in reversal_watcher.js — skipping");
  }
} catch (e) {
  console.warn("⚠️ Reversal watcher start failed:", e?.message || e);
}

// =======================================================
// ENABLE EXPLICIT GC (if Node started with --expose-gc)
// - We'll call global.gc periodically if available to help keep memory under control
// =======================================================
if (typeof global.gc === "function") {
  // conservative: run GC every 5 minutes
  setInterval(() => {
    try {
      global.gc();
      console.log("🧹 Called global.gc()");
    } catch (e) {
      // ignore
    }
  }, 5 * 60 * 1000);
} else {
  console.log("ℹ️ global.gc() not available. To enable, start node with: node --expose-gc aiTraderBot.js");
}

// =======================================================
// Graceful shutdown
// =======================================================
async function shutdown(signal) {
  console.log(`\n🛑 Shutdown received (${signal}) — cleaning up...`);
  try {
    if (reportTimer) clearInterval(reportTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);

    // stop reversal watcher if available
    try {
      if (typeof stopReversalWatcher === "function") {
        await stopReversalWatcher();
        console.log("✅ Reversal watcher stopped");
      }
    } catch (e) { /* ignore */ }

    // close WS
    try {
      if (ws) {
        ws.terminate();
        ws = null;
      }
    } catch (e) {}

    // Wait a bit for sockets to close
    setTimeout(() => {
      console.log("✔️ Shutdown complete — exiting.");
      process.exit(0);
    }, 800);
  } catch (e) {
    console.error("Shutdown cleanup error:", e?.message || e);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err?.stack || err);
  // attempt graceful restart
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.warn("Unhandled Promise Rejection:", reason);
});

// =======================================================
export default {
  sendAutoReport,
  getDataContext
};