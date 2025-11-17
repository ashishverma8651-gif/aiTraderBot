// aiTraderBot.js — FINAL STABLE (integrated with tg_commands, robust lock, safe Telegram sends)
//
// Requirements: config.js, utils.js, tg_commands.js, reversal_watcher.js (optional), axios, express, fs
//
// Exports: getDataContext(symbol), doAutoReport()
// Usage: node aiTraderBot.js   (this file starts server + auto reporting)
//

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import TG from "./tg_commands.js";            // exports: buildAIReport, formatAIReport, sendSplitReport
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// -------------------- Config & constants --------------------
const PORT = process.env.PORT || CONFIG.PORT || 10000;
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 min
const AUTO_REPORT_INTERVAL_MS = (CONFIG.AUTO_REPORT_MS || (15 * 60 * 1000)); // default 15m
const FIRST_REPORT_DELAY_MS = 3000; // 3s

// -------------------- util helpers --------------------
function nowIST() {
  try {
    return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
  } catch {
    return new Date().toString();
  }
}

function safeReadFileTrimSync(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, "utf8");
    if (!txt) return null;
    return String(txt).trim();
  } catch {
    return null;
  }
}

function writeLock(pid) {
  try {
    fs.writeFileSync(LOCK_FILE, String(pid), { encoding: "utf8" });
    return true;
  } catch (e) {
    console.error("⚠️ Failed writing lock file:", e.message);
    return false;
  }
}

function removeLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

function alreadyRunning() {
  try {
    if (global.__aiTrader_running) return true;
    const content = safeReadFileTrimSync(LOCK_FILE);
    if (!content) return false;
    const pid = Number(content) || 0;
    if (!pid) return false;
    try {
      // if process exists, assume running
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // process not running -> stale lock
      return false;
    }
  } catch {
    return true;
  }
}

// -------------------- SAFE TELEGRAM SENDER --------------------
export async function sendTelegram(htmlText) {
  try {
    if (!CONFIG.TELEGRAM || !CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.CHAT_ID) {
      console.warn("⚠️ Missing Telegram credentials in CONFIG.TELEGRAM");
      return false;
    }

    const text = String(htmlText ?? "").trim();
    if (!text) {
      console.warn("⚠️ sendTelegram: empty text");
      return false;
    }

    const res = await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      },
      { timeout: 15000 }
    );

    return !!(res && res.data && res.data.ok);
  } catch (err) {
    console.error("Telegram send error:", err?.response?.data || err.message || err);
    return false;
  }
}

// -------------------- Data context helper --------------------
export async function getDataContext(symbol = (CONFIG.SYMBOL || "BTCUSDT")) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: Number(m15.price || 0), candles: Array.isArray(m15.data) ? m15.data : [] };
  } catch (e) {
    return { price: 0, candles: [] };
  }
}

// -------------------- Single instance lock --------------------
if (alreadyRunning()) {
  console.log("⚠️ Another aiTraderBot instance detected — exiting.");
  process.exit(0);
}
try {
  writeLock(process.pid);
  global.__aiTrader_running = true;
} catch { /* ignore */ }

// ensure remove lock on exit
async function shutdown() {
  console.log(nowIST(), "🛑 Shutting down aiTraderBot...");
  try {
    if (autoTimer) clearInterval(autoTimer);
    try { await stopReversalWatcher(); } catch (e) { /* ignore */ }
    removeLock();
  } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// -------------------- Express server (health) --------------------
const app = express();
app.get("/", (_, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (_, res) => res.send("pong"));
app.listen(PORT, () => console.log(nowIST(), `🚀 Server live on port ${PORT}`));

// -------------------- Auto-report logic --------------------
let autoTimer = null;
let autoRunning = false;

async function doAutoReport() {
  if (autoRunning) {
    console.log(nowIST(), "⏳ Auto-report skipped (already running)");
    return;
  }
  autoRunning = true;
  console.log(nowIST(), "⏳ Auto-report triggered");

  try {
    // build report using tg_commands buildAIReport
    const report = await TG.buildAIReport(CONFIG.SYMBOL || "BTCUSDT", { mlTF: "15m" });
    if (!report || !report.ok) {
      console.error("❌ buildAIReport failed:", report?.error || "no report");
      await sendTelegram(`<b>⚠️ AutoReport failed</b>\n${report?.error || "buildAIReport returned empty"}`);
      autoRunning = false;
      return;
    }

    // send using tg_commands.sendSplitReport(report, sendTelegram)
    try {
      const ok = await TG.sendSplitReport(report, sendTelegram);
      if (ok) console.log(nowIST(), "📤 Auto-report sent ✔");
      else {
        console.error("❌ sendSplitReport returned false — falling back to formatted single-send");
        // fallback -> format and send single HTML (may be trimmed by telegram)
        const parts = await TG.formatAIReport(report);
        if (Array.isArray(parts) && parts.length) {
          for (const p of parts) {
            await sendTelegram(p);
            // small delay
            await new Promise(r => setTimeout(r, 600));
          }
        } else {
          await sendTelegram(String(parts || "AutoReport error"));
        }
      }
    } catch (sendErr) {
      console.error("❌ Error while sending report:", sendErr.message || sendErr);
      await sendTelegram(`<b>⚠️ AutoReport send failed</b>\n${sendErr?.message || String(sendErr)}`);
    }
  } catch (e) {
    console.error("❌ AutoReport main error:", e?.message || e);
    try { await sendTelegram(`<b>⚠️ AutoReport crashed</b>\n${e?.message || String(e)}`); } catch {}
  } finally {
    autoRunning = false;
  }
}

function startAutoReports() {
  try {
    // first quick report
    setTimeout(doAutoReport, FIRST_REPORT_DELAY_MS);
    // scheduled repeating
    autoTimer = setInterval(doAutoReport, AUTO_REPORT_INTERVAL_MS);
    console.log(nowIST(), `⏱ AutoReport scheduled every ${Math.round(AUTO_REPORT_INTERVAL_MS / 1000 / 60)} min`);
  } catch (e) {
    console.error("Failed starting auto reports:", e.message || e);
  }
}
startAutoReports();

// -------------------- Keepalive (no-sleep) --------------------
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL || process.env.WEBSITE_URL || "").replace(/\/+$/, "");

setInterval(async () => {
  if (PUBLIC_URL) {
    try {
      await axios.get(PUBLIC_URL + "/ping", { timeout: 6000 });
      // console.log(nowIST(), "💓 KeepAlive Public OK");
      return;
    } catch {
      console.warn(nowIST(), "⚠️ Public KeepAlive failed");
    }
  }
  try {
    await axios.get(`http://localhost:${PORT}/ping`, { timeout: 4000 });
    // console.log(nowIST(), "💓 Localhost KeepAlive OK");
  } catch {
    console.warn(nowIST(), "⚠️ Localhost KeepAlive failed");
  }
}, KEEPALIVE_INTERVAL_MS);

// -------------------- Reversal watcher integration --------------------
try {
  startReversalWatcher(
    CONFIG.SYMBOL || "BTCUSDT",
    {
      pollIntervalMs: 20000,
      tfs: ["1m", "5m", "15m"],
      weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
      minAlertConfidence: 65,
      microLookback: 60,
      feedbackWindowsSec: [60, 300]
    },
    async (msgHtml) => {
      try {
        // Reversal watcher expects msg string (HTML). use sendTelegram to post alert.
        await sendTelegram(msgHtml);
      } catch (e) {
        console.error("Reversal watcher send error:", e?.message || e);
      }
    }
  );
  console.log(nowIST(), "⚡ Reversal Watcher ACTIVE");
} catch (e) {
  console.warn("⚠️ Reversal watcher not started:", e?.message || e);
}

// -------------------- Export for external usage --------------------
export default {
  getDataContext,
  doAutoReport,
  sendTelegram
};