// aiTraderBot.js — FINAL (FORCE NO-SLEEP VERSION)

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
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch {
    return true;
  }
}

if (alreadyRunning()) {
  console.log("⚠️ Another bot instance detected — exit.");
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

app.listen(PORT, () => console.log("🚀 Server live on", PORT));


// ======================================================
// HELPERS
// ======================================================
function nowIST() {
  return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
}


// ======================================================
// Telegram Sender
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
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}



// ======================================================
// Data Fetcher
// ======================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [] };
  } catch {
    return { price: 0, candles: [] };
  }
}



// ======================================================
// AUTO REPORT (15m)
// ======================================================
let autoTimer = null;

async function doAutoReport() {
  console.log(nowIST(), "⏳ Auto-report triggered");

  try {
    const r = await buildAIReport(CONFIG.SYMBOL);
    const html = await formatAIReport(r);
    await sendTelegram(html);
    console.log(nowIST(), "📤 Auto-report sent");

  } catch (e) {
    console.log("Auto report error:", e.message);
  }
}

function startAuto() {
  const ms = 15 * 60 * 1000;

  setTimeout(doAutoReport, 3000); // first report after 3s
  autoTimer = setInterval(doAutoReport, ms);

  console.log("⏱ AutoReport scheduled every 15m");
}

startAuto();



// ======================================================
// PUBLIC URL Auto-detect
// ======================================================
function detectPublicURL() {
  return (process.env.RENDER_EXTERNAL_URL ||
          process.env.RENDER_URL ||
          process.env.WEBSITE_URL ||
          "").replace(/\/+$/, "");
}

const PUBLIC_URL = detectPublicURL();


// ======================================================
// FORCE KEEPALIVE BLOCK (NEVER SLEEPS)
// ======================================================
console.log("🔧 KeepAlive system enabled");

setInterval(async () => {
  // 1️⃣ PRIMARY — Public URL ping
  if (PUBLIC_URL) {
    try {
      await axios.get(PUBLIC_URL + "/ping", { timeout: 6000 });
      console.log("💓 KeepAlive Public OK");
      return;
    } catch {
      console.log("⚠️ Public KeepAlive failed");
    }
  }

  // 2️⃣ FALLBACK — Localhost ping (always works)
  try {
    await axios.get("http://localhost:10000/ping", { timeout: 4000 });
    console.log("💓 Localhost KeepAlive OK");
  } catch (e) {
    console.log("⚠️ Localhost KeepAlive failed");
  }

}, 3 * 60 * 1000); // every 3 min



// ======================================================
// REVERSAL WATCHER
// ======================================================
startReversalWatcher(CONFIG.SYMBOL, {
  pollIntervalMs: 20000,
  lookback: 60,
  minProb: 58,
  sendAlert: async (msg) => {
    await sendTelegram("⚡ <b>Reversal Signal</b>\n" + msg);
  }
});

console.log("⚡ Reversal Watcher ACTIVE");



// ======================================================
// CLEAN EXIT
// ======================================================
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("🛑 Shutting down...");
  try {
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