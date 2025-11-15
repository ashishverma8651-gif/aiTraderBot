// aiTraderBot.js — FINAL (no reversal watcher, IST 12-hour timestamps, auto 15m)
import fs from "fs";
import path from "path";
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import ml from "./ml_module_v8_6.js";

// -----------------------------
// SINGLE-INSTANCE GUARD (global + lockfile)
// -----------------------------
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");

function alreadyRunning() {
  if (global.__aiTrader_running) return true;
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pidText = fs.readFileSync(LOCK_FILE, "utf8").trim();
    if (!pidText) return true;
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return true;
  }
}

if (alreadyRunning()) {
  console.log("⚠️ aiTraderBot: another instance detected — exiting.");
  process.exit(0);
}

try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" }); } catch (e) {
  console.warn("⚠️ Could not write lock file:", e?.message || e);
}
global.__aiTrader_running = true;

function cleanExit(code = 0) {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
  try { global.__aiTrader_running = false; } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanExit(0));
process.on("SIGTERM", () => cleanExit(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
  cleanExit(1);
});
process.on("unhandledRejection", (r) => {
  console.warn("Unhandled Rejection:", r);
});

// -----------------------------
// EXPRESS server (keepalive endpoint)
// -----------------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// -----------------------------
// HELPER: Indian 12-hour timestamp
// -----------------------------
function nowIST() {
  try {
    return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
  } catch {
    return new Date().toLocaleString();
  }
}

// -----------------------------
// TELEGRAM SENDER (sanitizes separators; HTML)
// -----------------------------
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) {
      console.warn("⚠️ Telegram not configured (BOT_TOKEN/CHAT_ID missing)");
      return { ok: false, msg: "telegram_not_configured" };
    }

    // sanitize long separators (reduce to blank line) to avoid Telegram 400 payload issues
    let payloadText = String(text || "");
    payloadText = payloadText.replace(/(─|━|▬|—|_){3,}/g, "\n\n");
    payloadText = payloadText.replace(/[-=]{3,}/g, "\n\n");
    payloadText = payloadText.trim();

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;
    const resp = await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: payloadText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }, { timeout: 10000 });

    if (resp?.data?.ok) return { ok: true };
    return { ok: false, msg: resp?.data || "unknown" };

  } catch (e) {
    const code = e?.response?.status;
    if (code) console.warn("Telegram error:", code, e?.response?.data || "");
    else console.warn("Telegram error:", e?.message || e);
    return { ok: false, msg: e?.message || String(e) };
  }
}

// -----------------------------
// WEBSOCKET (stable, throttled, backoff)
// -----------------------------
let lastPrice = 0;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;
let wsBackoffMs = 1000;
const WS_MIRRORS = Array.isArray(CONFIG.WS_MIRRORS) && CONFIG.WS_MIRRORS.length
  ? CONFIG.WS_MIRRORS
  : ["wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws"];

function makeStream(symbol = CONFIG.SYMBOL) {
  return `${String(symbol).toLowerCase()}@ticker`;
}

function connectWS(symbol = CONFIG.SYMBOL) {
  let aborted = false;
  let lastUpdateTs = 0;

  async function attempt() {
    if (aborted) return;
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const stream = makeStream(symbol);
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) {
        try { ws.removeAllListeners(); ws.terminate(); } catch {}
        ws = null;
      }

      ws = new WebSocket(url, { handshakeTimeout: 5000 });

      ws.on("open", () => {
        socketAlive = true;
        wsBackoffMs = 1000;
        console.log(nowIST(), "🔗 WS Connected:", url);
      });

      ws.on("message", (msg) => {
        const now = Date.now();
        if (now - lastUpdateTs < 500) return;
        lastUpdateTs = now;
        try {
          const j = (typeof msg === "string") ? JSON.parse(msg) : JSON.parse(msg.toString());
          const p = parseFloat(j?.c || j?.last_price || j?.p);
          if (!Number.isNaN(p) && p !== 0) lastPrice = p;
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        mirrorIdx++;
        const delay = Math.min(60000, Math.max(1000, wsBackoffMs));
        wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
        console.warn(nowIST(), "⚠️ WS closed", code || "", (reason && reason.toString) ? reason.toString() : "", "reconnect in", delay, "ms");
        setTimeout(attempt, delay);
      });

      ws.on("error", (err) => {
        socketAlive = false;
        mirrorIdx++;
        const delay = Math.min(60000, Math.max(1000, wsBackoffMs));
        wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
        try { ws.terminate(); } catch {}
        console.warn(nowIST(), "⚠️ WS error:", err?.message || err);
        setTimeout(attempt, delay);
      });

    } catch (e) {
      mirrorIdx++;
      const delay = Math.min(60000, Math.max(1000, wsBackoffMs));
      wsBackoffMs = Math.min(60000, Math.floor(wsBackoffMs * 1.6));
      console.warn(nowIST(), "⚠️ WS connect exception:", e?.message || e, "reconnect in", delay);
      setTimeout(attempt, delay);
    }
  }

  attempt();

  return () => {
    aborted = true;
    try { if (ws) { ws.removeAllListeners(); ws.terminate(); ws = null; } } catch {}
  };
}

if (!global.__wsStarted) {
  global.__wsStarted = true;
  connectWS(CONFIG.SYMBOL);
  console.log(nowIST(), "🌐 WebSocket Started (single instance)");
}

// -----------------------------
// Data provider
// -----------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || m15.price || 0, candles: m15.data || [], socketAlive };
  } catch {
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// -----------------------------
// AUTO REPORT (single timer, 15 minutes)
// -----------------------------
let autoReportTimer = null;
let autoReportRunning = false;

async function doAutoReport() {
  if (autoReportRunning) {
    console.log(nowIST(), "ℹ️ autoReport already running — skipping this tick.");
    return;
  }
  autoReportRunning = true;
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const formatted = await formatAIReport(report); // HTML string from tg_commands
    const res = await sendTelegram(formatted);
    if (!res.ok) console.warn(nowIST(), "Telegram send failed for autoReport:", res.msg);
    else console.log(nowIST(), "📤 Auto report sent");
  } catch (e) {
    console.error(nowIST(), "autoReport error:", e?.message || e);
  } finally {
    autoReportRunning = false;
  }
}

function startAutoReport() {
  if (autoReportTimer) return;
  const ms = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000); // 15 minutes default
  setTimeout(doAutoReport, 5000);
  autoReportTimer = setInterval(doAutoReport, ms);
  console.log(nowIST(), "⏱ AutoReport scheduled every", ms / 1000, "sec (approx)");
}
startAutoReport();

// -----------------------------
// KEEPALIVE (optional — Render friendly)
// -----------------------------
const SELF_PING = (CONFIG.SELF_PING_URL || "").replace(/\/+$/, "") + "/ping";
if (CONFIG.SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_PING, { timeout: 4000 });
    } catch {
      console.warn(nowIST(), "⚠️ KEEPALIVE FAIL");
    }
  }, 4 * 60 * 1000);
} else {
  console.log(nowIST(), "ℹ️ SELF_PING_URL not set — keepalive disabled");
}

// -----------------------------
// Optional GC (if exposed)
// -----------------------------
if (typeof global.gc === "function") {
  setInterval(() => {
    try { global.gc(); } catch {}
  }, 5 * 60 * 1000);
}

// -----------------------------
// Shutdown/cleanup
// -----------------------------
async function shutdown(code = 0) {
  try {
    console.log(nowIST(), "🛑 Shutdown initiated...");
    if (autoReportTimer) clearInterval(autoReportTimer);
    try { if (ws) { ws.removeAllListeners(); ws.terminate(); ws = null; } } catch {}
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    global.__aiTrader_running = false;
  } catch (e) {
    console.error("Error during shutdown:", e?.message || e);
  } finally {
    process.exit(code);
  }
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// -----------------------------
// Exports
// -----------------------------
export default {
  getDataContext,
  doAutoReport
};