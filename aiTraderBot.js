// aiTraderBot.js — FINAL STABLE (Reversal Watcher ON, Auto 15m, KeepAlive, No-WS)
// - Single-instance lock
// - IST 12-hour logs
// - Safe Telegram HTML send (sanitizes long separators)
// - Robust error handling and graceful shutdown

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// -----------------------------
// SINGLE-INSTANCE LOCK (file + global)
// -----------------------------
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function alreadyRunning() {
  if (global.__aiTrader_running) return true;
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const txt = fs.readFileSync(LOCK_FILE, "utf8").trim();
    if (!txt) return false;
    const pid = Number(txt);
    if (!Number.isFinite(pid)) return false;
    return isProcessAlive(pid);
  } catch {
    return true;
  }
}

if (alreadyRunning()) {
  console.log("⚠️ aiTraderBot: another instance detected — exiting.");
  process.exit(0);
}
try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" }); } catch (e) { console.warn("Could not write lock file:", e?.message || e); }
global.__aiTrader_running = true;

// cleanup helper
async function gracefulCleanup(code = 0) {
  try {
    console.log(nowIST(), "🛑 Shutdown initiated...");
    // stop timers / watchers
    try { if (autoInterval) clearInterval(autoInterval); } catch {}
    try { if (autoStartTimeout) clearTimeout(autoStartTimeout); } catch {}
    try { await stopReversalWatcher(); } catch {}
    try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}
  } catch (e) {
    console.warn("Cleanup error:", e?.message || e);
  } finally {
    process.exit(code);
  }
}
process.on("SIGINT", () => gracefulCleanup(0));
process.on("SIGTERM", () => gracefulCleanup(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
  gracefulCleanup(1);
});
process.on("unhandledRejection", (r) => {
  console.warn("Unhandled Rejection:", r);
});

// -----------------------------
// Server (express) — simple endpoints
// -----------------------------
const app = express();
const PORT = Number(process.env.PORT || CONFIG.PORT || 10000);

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(nowIST(), "🚀 Server live on port", PORT));

// -----------------------------
// Helpers
// -----------------------------
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function sanitizeForTelegram(text) {
  if (!text) return "";
  // Remove very long repeated separators and collapse to single blank line
  let s = String(text);
  s = s.replace(/(─|━|▬|—){3,}/g, "\n\n");
  s = s.replace(/[-=]{3,}/g, "\n\n");
  // Trim trailing spaces and lines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// -----------------------------
// Telegram send (HTML)
// -----------------------------
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) {
      console.warn("⚠️ Telegram not configured (BOT_TOKEN/CHAT_ID). Skipping send.");
      return { ok: false, msg: "telegram_not_configured" };
    }

    const payloadText = sanitizeForTelegram(text);

    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`;
    const resp = await axios.post(url, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: payloadText,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }, { timeout: 15000 });

    if (resp?.data?.ok) {
      return { ok: true };
    } else {
      return { ok: false, msg: resp?.data || "unknown" };
    }
  } catch (e) {
    const code = e?.response?.status;
    if (code) console.warn("Telegram error:", code, e?.response?.data || e?.message);
    else console.warn("Telegram error:", e?.message || e);
    return { ok: false, msg: e?.message || String(e) };
  }
}

// -----------------------------
// Data fetcher wrapper (15m context)
// -----------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [], updated: m15.updated || null };
  } catch (e) {
    console.warn("getDataContext err:", e?.message || e);
    return { price: 0, candles: [], updated: null };
  }
}

// -----------------------------
// AUTO-REPORT (single timer, safe)
// -----------------------------
let autoInterval = null;
let autoStartTimeout = null;
let autoRunning = false;

async function doAutoReport() {
  if (autoRunning) {
    console.log(nowIST(), "ℹ️ Auto-report already running — skipping this tick.");
    return;
  }
  autoRunning = true;
  try {
    console.log(nowIST(), "⏳ Auto-report triggered");
    const report = await buildAIReport(CONFIG.SYMBOL);
    const formatted = await formatAIReport(report);
    const res = await sendTelegram(formatted);
    if (res?.ok) console.log(nowIST(), "📤 Auto report sent");
    else console.warn(nowIST(), "⚠️ Auto report send failed:", res?.msg);
  } catch (e) {
    console.error(nowIST(), "Auto-report error:", e?.message || e);
  } finally {
    autoRunning = false;
  }
}

function startAutoReport(intervalMs = Number(CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000)) {
  if (autoInterval) return;
  // start after small delay then every intervalMs
  autoStartTimeout = setTimeout(doAutoReport, 5000); // first run after 5s
  autoInterval = setInterval(doAutoReport, intervalMs);
  console.log(nowIST(), "⏱ AutoReport scheduled every", Math.round(intervalMs/1000), "sec");
}

// Start auto-report
startAutoReport();

// -----------------------------
// KEEPALIVE (Render-friendly)
// -----------------------------
if (CONFIG.SELF_PING_URL) {
  const cleanPing = String(CONFIG.SELF_PING_URL).replace(/\/+$/, "");
  setInterval(async () => {
    try {
      await axios.get(cleanPing + "/ping", { timeout: 6000 });
      // minimal log to avoid noise
      // console.log(nowIST(), "💓 KeepAlive OK");
    } catch (e) {
      console.warn(nowIST(), "⚠️ KeepAlive FAIL");
    }
  }, 4 * 60 * 1000);
} else {
  console.log(nowIST(), "ℹ️ SELF_PING_URL not set — keepalive disabled");
}

// -----------------------------
// REVERSAL WATCHER (ensure single start, reliable sendAlert wrapper)
// -----------------------------
let revWatcherActive = false;

try {
  if (!revWatcherActive && typeof startReversalWatcher === "function") {
    revWatcherActive = true;

    // wrapper ensures small sanitize and non-blocking send
    const sendAlertWrapper = async (payload) => {
      try {
        // payload may be string or object
        let msg = typeof payload === "string" ? payload : (payload?.message || JSON.stringify(payload));
        // prepend header, but keep message trimmed
        const header = "⚡ <b>Reversal Watcher</b>\n";
        const full = header + String(msg || "").trim();
        await sendTelegram(full);
      } catch (e) {
        console.warn("Reversal watcher sendAlert err:", e?.message || e);
      }
    };

    // start the watcher with conservative defaults (lightweight)
    startReversalWatcher(CONFIG.SYMBOL, {
      pollIntervalMs: Number(CONFIG.REVERSAL_WATCHER_POLL_MS || 20000),
      microLookback: Number(CONFIG.REVERSAL_WATCHER_LOOKBACK || 60),
      minProb: Number(CONFIG.REVERSAL_MIN_PROB || 58),
      sendAlert: sendAlertWrapper
    });

    console.log(nowIST(), "⚡ Reversal Watcher ACTIVE");
  } else {
    console.log(nowIST(), "⚠️ Reversal watcher not available (missing startReversalWatcher)");
  }
} catch (e) {
  console.warn("Failed to start reversal watcher:", e?.message || e);
  revWatcherActive = false;
}

// -----------------------------
// OPTIONAL: expose a manual trigger endpoint
// -----------------------------
app.post("/trigger-report", async (req, res) => {
  try {
    await doAutoReport();
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -----------------------------
// EXPORTS
// -----------------------------
export default {
  getDataContext,
  doAutoReport
};