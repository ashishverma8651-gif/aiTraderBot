// aiTraderBot.js — Optimized Render-safe single-instance runner
import fs from "fs";
import path from "path";
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// optional imports (assume these exist in your repo)
import ml from "./ml_module_v8_6.js"; // default export (object)
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// -----------------------------
// SINGLE-INSTANCE LOCK (prevents duplicate runs on Render restarts)
// -----------------------------
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");
function isAlreadyRunning() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pidText = fs.readFileSync(LOCK_FILE, "utf8");
    if (!pidText) return true;
    // optional: check pid alive (best-effort)
    const pid = Number(pidText);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return true; // existing process alive
      } catch (e) {
        // process not alive -> overwrite lock
        return false;
      }
    }
    return true;
  } catch (e) {
    return true;
  }
}

if (isAlreadyRunning()) {
  console.log("⚠️ aiTraderBot: another instance detected — exiting to avoid duplicates.");
  process.exit(0);
}

// create lock
try {
  fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" });
} catch (e) {
  console.warn("⚠️ Failed to create lock file:", e?.message || e);
}

// cleanup lock on exit
function removeLockAndExit(code = 0) {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
  process.exit(code);
}
process.on("exit", () => { try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {} });
process.on("SIGINT", () => removeLockAndExit(0));
process.on("SIGTERM", () => removeLockAndExit(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err?.stack || err);
  removeLockAndExit(1);
});
process.on("unhandledRejection", (r) => {
  console.warn("Unhandled Rejection:", r);
});

// -----------------------------
// EXPRESS Server (Render + keepalive endpoint)
// -----------------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// -----------------------------
// TELEGRAM SENDER (direct, lightweight)
// -----------------------------
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) {
      console.warn("⚠️ Telegram not configured (BOT_TOKEN/CHAT_ID missing)");
      return { ok: false, msg: "telegram_not_configured" };
    }
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    };

    const resp = await axios.post(url, payload, { timeout: 8000 });
    if (resp?.data?.ok) return { ok: true };
    return { ok: false, msg: resp?.data || "unknown" };
  } catch (e) {
    // log status code if available
    const code = e?.response?.status;
    if (code) console.warn(`Telegram error: Request failed with status code ${code}`);
    else console.warn("Telegram error:", e?.message || e);
    return { ok: false, msg: e?.message || String(e) };
  }
}

// -----------------------------
// WEBSOCKET (single stable connection + backoff)
// -----------------------------
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
      if (ws) try { ws.terminate(); } catch {}
      ws = new WebSocket(url, { handshakeTimeout: 5000 });

      ws.on("open", () => {
        socketAlive = true;
        wsBackoffMs = 1000;
        console.log("🔗 WS Connected:", url);
      });

      ws.on("message", (data) => {
        try {
          const j = (typeof data === "string") ? JSON.parse(data) : JSON.parse(data.toString());
          if (j && (j.c || j.last_price || j.p)) lastPrice = parseFloat(j.c || j.last_price || j.p) || lastPrice;
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        mirrorIdx++;
        // small delay then reconnect with backoff
        const delay = Math.min(60000, wsBackoffMs + Math.floor(Math.random() * 800));
        wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
        console.warn("⚠️ WS closed", code, reason?.toString?.() || reason, "reconnect in", delay);
        setTimeout(tryConnect, delay);
      });

      ws.on("error", (err) => {
        socketAlive = false;
        mirrorIdx++;
        console.warn("⚠️ WS error:", err?.message || err);
        try { ws.terminate(); } catch {}
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

  // return a stop function
  return () => {
    aborted = true;
    try { if (ws) ws.terminate(); } catch {}
  };
}

// start WS
const stopWS = connectWS(CONFIG.SYMBOL);

// -----------------------------
// data context for external use
// -----------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || m15.price || 0, candles: m15.data || [], socketAlive };
  } catch (e) {
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// -----------------------------
// AUTO REPORT (single timer, no duplicates)
// -----------------------------
let autoReportTimer = null;
let autoReportRunning = false;

async function doAutoReport() {
  if (autoReportRunning) {
    console.log("ℹ️ autoReport already running — skipping this tick.");
    return;
  }
  autoReportRunning = true;
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const text = await formatAIReport(report); // returns text (some versions return string)
    // ensure single send
    const res = await sendTelegram(text);
    if (!res.ok) console.warn("Telegram send failed for autoReport:", res.msg);
    console.log("📤 15m report sent");
  } catch (e) {
    console.error("autoReport error:", e?.message || e);
  } finally {
    autoReportRunning = false;
  }
}

// schedule autoReport only once
function startAutoReport() {
  if (autoReportTimer) return;
  const ms = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
  // send first report shortly after start (small delay)
  setTimeout(doAutoReport, 5000);
  autoReportTimer = setInterval(doAutoReport, ms);
  console.log("✅ autoReport scheduled every", ms / 1000, "seconds");
}
startAutoReport();

// -----------------------------
// KEEPALIVE (Render friendly)
// -----------------------------
const SELF_PING = (CONFIG.SELF_PING_URL || "").replace(/\/+$/, "") + "/ping";
if (CONFIG.SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_PING, { timeout: 4000 });
      console.log("💓 KEEPALIVE success");
    } catch (e) {
      console.warn("⚠️ KEEPALIVE failed:", e?.message || e?.response?.status || "");
    }
  }, 4 * 60 * 1000);
} else {
  console.log("ℹ️ SELF_PING_URL not set — skipping keepalive pings.");
}

// -----------------------------
// Lightweight Reversal Watcher integration (minimal memory)
// -----------------------------
let reversalHandle = null;
try {
  if (typeof startReversalWatcher === "function") {
    // pass only light options; watcher should be written lightweight (no heavy arrays retained)
    startReversalWatcher(CONFIG.SYMBOL, {
      pollIntervalMs: Number(CONFIG.REVERSAL_WATCHER_POLL_MS || 15000),
      microLookback: Number(CONFIG.REVERSAL_WATCHER_LOOKBACK || 60),
      // provide a send function to avoid watcher doing its own network heavy work
      sendAlert: async (msg) => {
        await sendTelegram(msg);
      },
      minProb: Number(CONFIG.REVERSAL_MIN_PROB || 58)
    });
    console.log("⚡ Reversal Watcher started (lightweight)");
  } else {
    console.log("ℹ️ No reversal watcher exported — skipping");
  }
} catch (e) {
  console.warn("⚠️ startReversalWatcher error:", e?.message || e);
}

// -----------------------------
// Optional GC (if started with --expose-gc)
// -----------------------------
if (typeof global.gc === "function") {
  setInterval(() => {
    try { global.gc(); console.log("🧹 Called global.gc()"); } catch {}
  }, 5 * 60 * 1000);
} else {
  console.log("ℹ️ Node not started with --expose-gc (recommended for memory-critical envs)");
}

// -----------------------------
// Graceful shutdown
// -----------------------------
async function shutdownClean(code = 0) {
  try {
    console.log("🛑 Shutdown initiated...");
    if (autoReportTimer) clearInterval(autoReportTimer);
    try { stopWS(); } catch {}
    try { if (typeof stopReversalWatcher === "function") stopReversalWatcher(); } catch {}
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    console.log("✔️ Cleanup done. Exiting.");
  } catch (e) {
    console.error("Error during shutdown:", e?.message || e);
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdownClean(0));
process.on("SIGTERM", () => shutdownClean(0));

// -----------------------------
// Export helpers for tests / other modules
// -----------------------------
export default {
  getDataContext,
  doAutoReport
};