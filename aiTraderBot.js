// aiTraderBot.js — STABLE (AutoReport Disabled + KeepAlive Enabled)

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { formatAIReport, buildAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";
import { handleCallback, kbHome } from "./merge_signals.js";

// ------------------ SINGLE INSTANCE LOCK ------------------
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
  console.log("⚠️ Another bot instance detected — exiting.");
  process.exit(0);
}
try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
global.__aiTrader_running = true;

// ------------------ TELEGRAM BOT ------------------
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

// /start & /panel
bot.command("start", (ctx) => ctx.reply("Welcome! Use /panel to open signals panel.", kbHome));
bot.command("panel", (ctx) => ctx.reply("🏠 HOME PANEL", kbHome));

// callback buttons
bot.on("callback_query", async (ctx) => {
  try {
    const res = await handleCallback(ctx.callbackQuery);
    await ctx.editMessageText(res.text, res.keyboard).catch(async () => {
      await ctx.reply(res.text, res.keyboard);
    });
  } catch (e) {
    await ctx.reply("❌ Callback Error: " + (e.message || e));
  }
});

// Launch Bot (Render-safe polling)
bot.launch({ polling: { interval: 300, timeout: 50 } })
  .then(() => console.log("🤖 Telegram Bot Running"))
  .catch(err => console.log("Telegram launch error:", err.message || err));

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ------------------ EXPRESS KEEPALIVE SERVER ------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (req, res) => res.send("AI Trader Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));

app.listen(PORT, () => console.log("🚀 Server Live on", PORT));

// ------------------ TELEGRAM SEND HELPER ------------------
export async function sendTelegram(text) {
  const clean = String(text || "").trim();
  if (!clean) return false;

  try {
    await bot.telegram.sendMessage(
      CONFIG.TELEGRAM.CHAT_ID,
      clean,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
    return true;
  } catch (e) {
    // fallback HTTP
    try {
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
    } catch (e2) {
      console.log("Telegram send failed:", e2.message || e2);
      return false;
    }
  }
}

// ------------------ getDataContext ------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [] };
  } catch {
    return { price: 0, candles: [] };
  }
}

// ------------------ AUTO REPORT (DISABLED) ------------------
let autoTimer = null;
let autoRunning = false;

// ← This function intentionally disabled
async function doAutoReport() {
  console.log("⏸ Auto-Report is disabled.");
  return false;
}

// DO NOT START AUTO REPORT
// startAuto();   // ❌ disabled

// ------------------ KEEPALIVE / RENDER PING ------------------
function detectPublicURL() {
  return (process.env.RENDER_EXTERNAL_URL ||
          process.env.RENDER_URL ||
          process.env.WEBSITE_URL ||
          "").replace(/\/+$/, "");
}
const PUBLIC_URL = detectPublicURL();

console.log("💓 KeepAlive Enabled");
setInterval(async () => {
  try {
    const pingURL = (PUBLIC_URL || `http://localhost:${PORT}`) + "/ping";
    await axios.get(pingURL, { timeout: 6000 });
    console.log("💓 KeepAlive OK");
  } catch {
    console.log("⚠ KeepAlive Failed");
  }
}, 3 * 60 * 1000);

// ------------------ REVERSAL WATCHER ------------------
try {
  startReversalWatcher(
    CONFIG.SYMBOL,
    { pollIntervalMs: 20000, tfs: ["1m", "5m", "15m"],
      weights: { "1m": 0.25, "5m": 0.35, "15m": 0.40 },
      minAlertConfidence: 65,
      microLookback: 60,
      feedbackWindowsSec: [60, 300]
    },
    async (msg) => await sendTelegram(msg)
  );
  console.log("⚡ Reversal Watcher ACTIVE");
} catch (e) {
  console.log("⚠ Reversal watcher start failed:", e.message || e);
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
  } catch {}
  process.exit(0);
}

export default { getDataContext, doAutoReport };