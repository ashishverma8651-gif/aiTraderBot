// aiTraderBot.js — FULLY PATCHED + COMMANDS FIXED

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf, Markup } from "telegraf";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// MULTI-MARKET PANEL UI (KEYBOARD + CALLBACK)
import { handleCallback, kbHome } from "./merge_signals.js";

/* ======================================================
   SINGLE INSTANCE LOCK
====================================================== */
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


/* ======================================================
   START TELEGRAM BOT
====================================================== */
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

/* -------------------------
    COMMANDS FIXED HERE
-------------------------- */

// Start Command
bot.start(async (ctx) => {
  await ctx.reply("👋 Welcome! Use the Menu Below:", kbHome);
});

// Home Command
bot.command("home", async (ctx) => {
  await ctx.reply("🏠 HOME PANEL", kbHome);
});

// Panel Command
bot.command("panel", async (ctx) => {
  await ctx.reply("🏠 HOME PANEL", kbHome);
});

// Manual Symbol Commands
bot.command("eth", async (ctx) => {
  const rpt = await buildAIReport("ETHUSDT");
  const final = await formatAIReport(rpt);
  await ctx.reply(final);
});

bot.command("nifty50", async (ctx) => {
  const rpt = await buildAIReport("NIFTY50");
  const final = await formatAIReport(rpt);
  await ctx.reply(final);
});

/* -------------------------
    CALLBACK BUTTON HANDLER
-------------------------- */
bot.on("callback_query", async (ctx) => {
  try {
    const q = ctx.callbackQuery;
    const res = await handleCallback(q);
    await ctx.editMessageText(res.text, res.keyboard);
    await ctx.answerCbQuery(); // VERY IMPORTANT: avoids button freeze
  } catch (e) {
    console.log("Callback Error:", e.message);
  }
});

bot.launch();
console.log("🤖 Telegram Bot Running...");


/* ======================================================
   SIMPLE SERVER
====================================================== */
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (req, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));
app.listen(PORT, () => console.log("🚀 Server live on", PORT));


/* ======================================================
   TELEGRAM SENDER (SAFE)
====================================================== */
export async function sendTelegram(text) {
  try {
    const clean = String(text || "").trim();
    if (!clean) return;

    await bot.telegram.sendMessage(
      CONFIG.TELEGRAM.CHAT_ID,
      clean,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}


/* ======================================================
   MARKET DATA CONTEXT
====================================================== */
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [] };
  } catch {
    return { price: 0, candles: [] };
  }
}


/* ======================================================
   AUTO REPORT (WORKING)
====================================================== */
let autoTimer = null;
let autoRunning = false;

async function doAutoReport() {
  if (autoRunning) return;
  autoRunning = true;

  try {
    const raw = await buildAIReport(CONFIG.SYMBOL);
    const parts = await formatAIReport(raw);
    const arr = Array.isArray(parts) ? parts : [parts];

    for (const block of arr) {
      await sendTelegram(block);
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (e) {
    sendTelegram("⚠ AutoReport Error:\n" + e.message);
  }

  autoRunning = false;
}

function startAuto() {
  const ms = 15 * 60 * 1000;
  setTimeout(doAutoReport, 3000);
  autoTimer = setInterval(doAutoReport, ms);
}

startAuto();


/* ======================================================
   REVERSAL WATCHER
====================================================== */
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


/* ======================================================
   CLEAN EXIT
====================================================== */
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  try {
    if (autoTimer) clearInterval(autoTimer);
    await stopReversalWatcher();
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}
  process.exit(0);
}

export default { getDataContext, doAutoReport };