// aiTraderBot.js — FINAL STABLE + PANEL UI + RENDER FIX + AUTOREPORT FIX

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";
import { handleCallback, kbHome } from "./merge_signals.js";


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
  } catch { return true; }
}

if (alreadyRunning()) {
  console.log("⚠ Another bot instance detected — exit.");
  process.exit(0);
}

try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
global.__aiTrader_running = true;


// ======================================================
// TELEGRAM BOT — FIXED (NO POLLING CONFLICT)
// ======================================================
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

// Commands
bot.command("start", (ctx) => ctx.reply("Welcome! Use /panel to open signals panel.", kbHome));
bot.command("panel", (ctx) => ctx.reply("🏠 HOME PANEL", kbHome));

// Callback buttons
bot.on("callback_query", async (ctx) => {
  const res = await handleCallback(ctx.callbackQuery);
  await ctx.editMessageText(res.text, res.keyboard);
});

// RENDER FIX — avoid double polling
bot.launch({
  polling: {
    interval: 300,
    timeout: 50,
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

console.log("🤖 Telegram Bot Running (Render-safe polling)");


// ======================================================
// EXPRESS SERVER
// ======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (req, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));

app.listen(PORT, () => console.log("🚀 Server live on", PORT));


// ======================================================
// HELPERS
// ======================================================
function nowIST() {
  return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" });
}


// ======================================================
// TELEGRAM SAFE SEND
// ======================================================
export async function sendTelegram(text) {
  try {
    const clean = String(text || "").trim();
    if (!clean) return false;

    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text: clean,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
    return true;

  } catch (e) {
    console.log("Telegram error:", e.message);
    return false;
  }
}


// ======================================================
// DATA CONTEXT
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
// AUTO 15 MINUTE REPORT (BTC/ETH)
// ======================================================
let autoTimer = null;
let autoRunning = false;

async function doAutoReport() {
  if (autoRunning) return;
  autoRunning = true;

  console.log(nowIST(), "⏳ Auto-report triggered");

  try {
    const raw = await buildAIReport(CONFIG.SYMBOL);
    if (!raw) {
      await sendTelegram("⚠ AutoReport failed: buildAIReport empty");
      autoRunning = false;
      return;
    }

    let parts = await formatAIReport(raw);
    if (typeof parts === "string") parts = [parts];
    if (!Array.isArray(parts)) parts = [];

    for (const msg of parts) {
      if (msg.trim().length > 2) {
        await sendTelegram(msg);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(nowIST(), "📤 Auto-report sent ✔");

  } catch (err) {
    await sendTelegram("⚠ AutoReport crashed:\n" + err.message);
  }

  autoRunning = false;
}

function startAuto() {
  const ms = 15 * 60 * 1000;
  setTimeout(doAutoReport, 4000);
  autoTimer = setInterval(doAutoReport, ms);
  console.log("⏱ AutoReport scheduled every 15m");
}

startAuto();


// ======================================================
// PUBLIC URL
// ======================================================
function detectPublicURL() {
  return (process.env.RENDER_EXTERNAL_URL ||
          process.env.RENDER_URL ||
          process.env.WEBSITE_URL ||
          "").replace(/\/+$/, "");
}
const PUBLIC_URL = detectPublicURL();


// ======================================================
// KEEPALIVE
// ======================================================
console.log("🔧 KeepAlive enabled");

setInterval(async () => {
  try {
    await axios.get((PUBLIC_URL || "http://localhost:10000") + "/ping");
    console.log("💓 KeepAlive OK");
  } catch {
    console.log("⚠ KeepAlive failed");
  }
}, 3 * 60 * 1000);


// ======================================================
// REVERSAL WATCHER
// ======================================================
startReversalWatcher(
  CONFIG.SYMBOL,
  {
    pollIntervalMs: 20000,
    tfs: ["1m", "5m", "15m"],
    weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
    minAlertConfidence: 65,
    microLookback: 60,
    feedbackWindowsSec: [60, 300]
  },
  async (msg) => {
    await sendTelegram(msg);
  }
);

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
    await stopReversalWatcher();
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}
  process.exit(0);
}


export default {
  getDataContext,
  doAutoReport
};