// aiTraderBot.js — FINAL WITH REVERSAL WATCHER + FIXED AUTO 15m + FIXED KEEPALIVE + NO WS

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// ======================================================
// SINGLE INSTANCE LOCK
// ======================================================
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");

function alreadyRunning() {
  if (global.__aiTrader_running) return true;

  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return true;
  }
}

if (alreadyRunning()) {
  console.log("⚠️ Another instance detected — EXIT");
  process.exit(0);
}

try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
global.__aiTrader_running = true;


// ======================================================
// SERVER
// ======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log("🚀 Server on", PORT));


// ======================================================
// HELPERS
// ======================================================
function nowIST() {
  return new Date().toLocaleString("en-IN", {
    hour12: true,
    timeZone: "Asia/Kolkata"
  });
}


// ======================================================
// Telegram sender (clean separators)
// ======================================================
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.CHAT_ID) return;

    const clean = String(text || "").replace(/[-=_]{3,}/g, "\n").trim();

    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text: clean,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  } catch (err) {
    console.log("Telegram error:", err?.message);
  }
}



// ======================================================
// Data fetcher (NO WS)
// ======================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return {
      price: m15.price || 0,
      candles: m15.data || []
    };
  } catch {
    return { price: 0, candles: [] };
  }
}



// ======================================================
// AUTO REPORT EVERY 15 MINUTES (FIXED)
// ======================================================
let autoTimer = null;

async function doAutoReport() {
  console.log(nowIST(), "⏳ Auto-report triggered");

  try {
    const r = await buildAIReport(CONFIG.SYMBOL);
    const html = await formatAIReport(r);
    await sendTelegram(html);

    console.log(nowIST(), "📤 Auto report sent");
  } catch (e) {
    console.log("Auto report error:", e.message);
  }
}

function startAuto() {
  const ms = 15 * 60 * 1000;

  setTimeout(doAutoReport, 3000);
  autoTimer = setInterval(doAutoReport, ms);

  console.log("⏱ AutoReport running every 15m");
}

startAuto();



// ======================================================
// KEEPALIVE (RENDER SAFE) — FIXED DOUBLE SLASH BUG
// ======================================================
if (CONFIG.SELF_PING_URL) {
  const cleanPing = CONFIG.SELF_PING_URL.replace(/\/+$/, "");

  setInterval(async () => {
    try {
      await axios.get(cleanPing + "/ping");
      console.log("💓 KeepAlive OK");
    } catch {
      console.log("⚠️ KeepAlive FAIL");
    }
  }, 4 * 60 * 1000);
}



// ======================================================
// REVERSAL WATCHER (ADDED BACK)
// ======================================================
let watcherStarted = false;

if (!watcherStarted) {
  watcherStarted = true;

  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: 20000,
    lookback: 60,
    minProb: 58,
    sendAlert: async (msg) => {
      await sendTelegram("⚡ <b>Reversal Signal</b>\n" + msg);
    }
  });

  console.log("⚡ Reversal Watcher ACTIVE");
}



// ======================================================
// CLEAN EXIT
// ======================================================
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

async function shutdown() {
  try {
    console.log("🛑 Shutdown...");

    if (autoTimer) clearInterval(autoTimer);
    try { await stopReversalWatcher(); } catch {}

    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}

  process.exit(0);
}

export default {
  getDataContext,
  doAutoReport
};