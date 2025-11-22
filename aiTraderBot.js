// aiTraderBot.js — FINAL STABLE + PANEL UI + RENDER FIX + AUTOREPORT (ENABLED)

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

// ------------------ single instance lock ------------------
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");
function alreadyRunning() {
  if (global.__aiTrader_running) return true;
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return true; }
}
if (alreadyRunning()) { console.log("⚠️ Another bot instance detected — exit."); process.exit(0); }
try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
global.__aiTrader_running = true;

// ------------------ Telegram bot (Render-safe polling) ------------------
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

// Home command
bot.command("start", (ctx) => ctx.reply("Welcome! Use /panel to open signals panel.", kbHome));
bot.command("panel", (ctx) => ctx.reply("🏠 HOME PANEL", kbHome));

// Callback handler from inline keyboard
bot.on("callback_query", async (ctx) => {
  try {
    const res = await handleCallback(ctx.callbackQuery);
    // res.text is HTML; res.keyboard contains inline keyboard
    // editMessageText requires text + extra options
    await ctx.editMessageText(res.text, res.keyboard).catch(async (e) => {
      // if not editable (new message required), send a new message instead
      await ctx.reply(res.text, res.keyboard).catch(() => {});
    });
  } catch (e) {
    await ctx.reply("❌ Error processing button: " + (e?.message || e));
  }
});

// Launch with polling tuned for Render
bot.launch({ polling: { interval: 300, timeout: 50 } })
  .then(() => console.log("🤖 Telegram Bot Running (Render-safe polling)"))
  .catch(err => console.log("Telegram launch error:", err?.message || err));

// Graceful Telegraf stop on shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ------------------ Express server ------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;
app.get("/", (req, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));
app.listen(PORT, () => console.log("🚀 Server live on", PORT));

// ------------------ Helpers ------------------
function nowIST() { return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" }); }

// ------------------ Safe telegram send (fallback using bot or API) ------------------
export async function sendTelegram(text) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  // prefer bot API if bot available
  try {
    if (bot && bot.telegram && CONFIG.TELEGRAM.CHAT_ID) {
      await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, clean, { parse_mode: "HTML", disable_web_page_preview: true });
      return true;
    }
  } catch (e) {
    // fallback to HTTP post (if token + chat id available)
    try {
      await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`, {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text: clean,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
      return true;
    } catch (e2) {
      console.log("Telegram send failed:", e2?.message || e2);
      return false;
    }
  }
  return false;
}

// ------------------ getDataContext ------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [] };
  } catch { return { price: 0, candles: [] }; }
}

// ------------------ AUTO REPORT (ENABLED) ------------------
let autoTimer = null;
let autoRunning = false;

async function doAutoReport() {
  if (autoRunning) { console.log(nowIST(), "⏳ Auto-report skipped (already running)"); return; }
  autoRunning = true;
  console.log(nowIST(), "⏳ Auto-report triggered");

  try {
    // buildAIReport returns full report object
    const raw = await buildAIReport(CONFIG.SYMBOL);
    if (!raw) {
      console.log("❌ buildAIReport returned null");
      await sendTelegram("⚠️ AutoReport failed: buildAIReport empty");
      autoRunning = false; return;
    }

    let parts = await formatAIReport(raw);
    if (typeof parts === "string") parts = [parts];
    if (!Array.isArray(parts) || parts.length === 0) {
      console.log("❌ formatAIReport returned empty");
      await sendTelegram("⚠️ AutoReport empty output");
      autoRunning = false; return;
    }

    for (const p of parts) {
      const msg = String(p || "");
      if (msg.length < 2) continue;
      await sendTelegram(msg);
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(nowIST(), "📤 Auto-report sent ✔");
  } catch (e) {
    console.log("❌ AutoReport error:", e?.message || e);
    await sendTelegram("⚠️ AutoReport crashed:\n" + (e?.message || e));
  }

  autoRunning = false;
}

function startAuto() {
  const ms = CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000;
  // initial small delay then periodic
  setTimeout(doAutoReport, 4000);
  autoTimer = setInterval(doAutoReport, ms);
  console.log("⏱ AutoReport scheduled every " + Math.round((ms / 60000)) + "m");
}

// start auto reports
startAuto();

// ------------------ KEEPALIVE / PUBLIC URL ------------------
function detectPublicURL() {
  return (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL || process.env.WEBSITE_URL || "").replace(/\/+$/, "");
}
const PUBLIC_URL = detectPublicURL();

console.log("🔧 KeepAlive enabled");
setInterval(async () => {
  try {
    const pingUrl = (PUBLIC_URL || `http://localhost:${PORT}`) + "/ping";
    await axios.get(pingUrl, { timeout: 6000 });
    console.log("💓 KeepAlive OK");
  } catch {
    console.log("⚠ KeepAlive failed");
  }
}, 3 * 60 * 1000);

// ------------------ REVERSAL WATCHER ------------------
try {
  startReversalWatcher(
    CONFIG.SYMBOL,
    { pollIntervalMs: 20000, tfs: ["1m", "5m", "15m"], weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 }, minAlertConfidence: 65, microLookback: 60, feedbackWindowsSec: [60, 300] },
    async (msg) => { await sendTelegram(msg); }
  );
  console.log("⚡ Reversal Watcher ACTIVE");
} catch (e) {
  console.log("⚠ Reversal watcher start failed:", e?.message || e);
}

// ------------------ CLEAN EXIT ------------------
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("🛑 Shutting down...");
  try {
    if (autoTimer) clearInterval(autoTimer);
    try { await stopReversalWatcher(); } catch {}
    try { await bot.stop(); } catch {}
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (e) {}
  process.exit(0);
}

export default { getDataContext, doAutoReport };