// aiTraderBot.js — CLEAN FINAL + SAFETY WATCHDOG + KEEPALIVE + PANEL
// Single file handles: Telegram Commands + Buttons + Signal Calls + Safety

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { generateMergeSignal } from "./merge_signals.js";

// ----------------------- Instance lock -----------------------
const LOCK = path.resolve(".aitraderbot.lock");
function writeLock() {
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch {}
}
function clearLock() {
  try { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); } catch {}
}
if (fs.existsSync(LOCK)) {
  try {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    if (pid && pid > 0) {
      try { process.kill(pid, 0); console.log("⚠ Another bot instance running — exiting."); process.exit(0); } catch {}
    }
  } catch {}
}
writeLock();
process.once("exit", clearLock);

// ----------------------- Globals & Tunables -----------------------
const PORT = process.env.PORT || 10000;
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 3 * 60 * 1000); // 3m
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 30 * 1000); // 30s
const MEM_THRESHOLD_MB = Number(process.env.MEM_THRESHOLD_MB || 400); // restart if > this
const HUNG_TASK_MS = Number(process.env.HUNG_TASK_MS || 2 * 60 * 1000); // consider generate call hung after 2m
const MAX_CONSECUTIVE_FAILURES = Number(process.env.MAX_CONSECUTIVE_FAILURES || 5); // restart after N fails
const CRASH_NOTIFY_CHAT = CONFIG.TELEGRAM?.CHAT_ID || null;

let consecutiveFailures = 0;
let lastGenerateAt = 0;
let lastGenerateId = null;
let lastKeepAliveOk = true;

// ----------------------- Telegram bot -----------------------
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN || "", { username: undefined });

// Safe telegram send (best-effort)
async function safeTelegramSend(text) {
  try {
    if (!CONFIG.TELEGRAM?.ENABLED || !CONFIG.TELEGRAM?.CHAT_ID) return false;
    await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, String(text).slice(0, 4000), { parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  } catch (e) {
    try {
      // fallback HTTP
      if (CONFIG.TELEGRAM?.BOT_TOKEN && CONFIG.TELEGRAM?.CHAT_ID) {
        await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`, {
          chat_id: CONFIG.TELEGRAM.CHAT_ID,
          text: String(text).slice(0, 4000),
          parse_mode: "HTML",
          disable_web_page_preview: true
        }, { timeout: 5000 });
        return true;
      }
    } catch {}
    console.log("⚠ Telegram notify failed:", e?.message || e);
    return false;
  }
}

// ----------------------- Express server -----------------------
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✔"));
app.get("/ping", (req, res) => {
  res.send("pong");
});

// Health endpoint for watchdog + metrics
app.get("/health", (req, res) => {
  res.json({
    pid: process.pid,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    consecutiveFailures,
    lastGenerateAt,
    lastKeepAliveOk
  });
});

app.listen(PORT, () => {
  console.log(`🌍 Server listening on port ${PORT}`);
});

// ----------------------- Keep-alive ping -----------------------
function detectPublicURL() {
  return (process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.SELF_PING_URL || "").replace(/\/+$/, "") || `http://localhost:${PORT}`;
}
const PUBLIC_URL = detectPublicURL();
const PING_URL = PUBLIC_URL + "/ping";

function startKeepAlive() {
  console.log("💓 KeepAlive enabled ->", PING_URL);
  setInterval(async () => {
    try {
      await axios.get(PING_URL, { timeout: 5000 });
      lastKeepAliveOk = true;
    } catch (e) {
      lastKeepAliveOk = false;
      console.log("⚠ KeepAlive ping failed");
    }
  }, KEEPALIVE_INTERVAL_MS);
}
startKeepAlive();

// ----------------------- Bot panel + callbacks -----------------------
const homeKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⚡ Generate Signal", callback_data: "GENERATE_SIGNAL" }],
      [{ text: "Market: Crypto", callback_data: "SET_MARKET_CRYPTO" }, { text: "Market: India", callback_data: "SET_MARKET_INDIA" }],
      [{ text: "Forex", callback_data: "SET_MARKET_FOREX" }, { text: "US Stocks", callback_data: "SET_MARKET_US" }],
      [{ text: "Auto-Report: Toggle", callback_data: "TOGGLE_AUTOREPORT" }]
    ]
  },
  parse_mode: "HTML"
};

let autoReportEnabled = Boolean(process.env.AUTO_REPORT_ENABLED === "true");
function kbHome() { return homeKeyboard; }

bot.command("start", (ctx) => ctx.reply("🏠 <b>AI Trader Control Panel</b>\nChoose an option:", kbHome()));
bot.command("panel", (ctx) => ctx.reply("🏠 <b>AI Trader Control Panel</b>", kbHome()));

bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("SET_MARKET_")) {
      const mk = data.replace("SET_MARKET_", "");
      if (mk === "CRYPTO") CONFIG.ACTIVE_MARKET = "CRYPTO";
      if (mk === "INDIA") CONFIG.ACTIVE_MARKET = "INDIA";
      if (mk === "FOREX") CONFIG.ACTIVE_MARKET = "FOREX";
      if (mk === "US") CONFIG.ACTIVE_MARKET = "US_STOCKS";

      CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET?.[CONFIG.ACTIVE_MARKET] || CONFIG.ACTIVE_SYMBOL;

      await ctx.editMessageText(`🔄 Market switched to <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`, kbHome());
      return;
    }

    if (data === "TOGGLE_AUTOREPORT") {
      autoReportEnabled = !autoReportEnabled;
      await ctx.answerCbQuery(`Auto-report ${autoReportEnabled ? "enabled" : "disabled"}`);
      await ctx.editMessageText(`Auto-report is now <b>${autoReportEnabled ? "ON" : "OFF"}</b>`, kbHome());
      return;
    }

    if (data === "GENERATE_SIGNAL") {
      await ctx.editMessageText("⏳ Generating signal...");

      // generate and send UI text with timeout/hung detection
      try {
        const id = `${CONFIG.ACTIVE_SYMBOL}_${Date.now()}`;
        lastGenerateId = id;
        lastGenerateAt = Date.now();

        const resPromise = generateMergeSignal(CONFIG.ACTIVE_SYMBOL, { mainTF: "15m" });
        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("generateSignal timeout")), HUNG_TASK_MS));

        const { uiText } = await Promise.race([resPromise, timeoutPromise]);
        consecutiveFailures = 0;
        lastGenerateAt = Date.now();

        await ctx.editMessageText(uiText, kbHome());
      } catch (e) {
        consecutiveFailures++;
        console.log("❌ generateSignal failed:", e?.message || e);
        await ctx.editMessageText("❌ Failed to generate signal: " + (e?.message || "error"), kbHome());

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await notifyAndRestart("Consecutive generate failures threshold reached — restarting.");
        }
      }
      return;
    }

    await ctx.answerCbQuery("Unknown action");
  } catch (e) {
    console.log("Callback error:", e?.message || e);
  }
});

// Launch bot with Render-safe polling (if token present)
(async () => {
  try {
    if (CONFIG.TELEGRAM?.ENABLED && CONFIG.TELEGRAM?.BOT_TOKEN) {
      await bot.launch({ polling: { interval: 300, timeout: 50 } });
      console.log("🤖 Telegram Bot Running (polling)");
    } else {
      console.log("⚠ Telegram disabled or missing token — skipping bot launch");
    }
  } catch (e) {
    console.log("Telegram launch error:", e?.message || e);
  }
})();

// ----------------------- Auto-report scheduler (light) -----------------------
let autoReportTimer = null;
async function doAutoReport() {
  if (!autoReportEnabled) return;
  try {
    const { uiText } = await generateMergeSignal(CONFIG.ACTIVE_SYMBOL, { mainTF: "15m" });
    await safeTelegramSend(`<b>AutoReport</b>\n${uiText}`);
  } catch (e) {
    console.log("AutoReport error:", e?.message || e);
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) await notifyAndRestart("AutoReport failures threshold reached — restarting.");
  }
}
function startAutoReport() {
  const ms = Number(process.env.REPORT_INTERVAL_MS || CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);
  if (autoReportTimer) clearInterval(autoReportTimer);
  autoReportTimer = setInterval(async () => { if (autoReportEnabled) await doAutoReport(); }, ms);
  // small initial trigger
  setTimeout(() => { if (autoReportEnabled) doAutoReport(); }, 5_000);
}
startAutoReport();

// ----------------------- Watchdog & Safety -----------------------
let watchdogFailures = 0;

async function notifyAndRestart(reason = "Watchdog triggered") {
  try {
    console.log("‼️ WATCHDOG: " + reason);
    await safeTelegramSend(`<b>AI Trader Watchdog</b>\n${reason}\nPID: ${process.pid}\nTime: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  } catch (e) {
    console.log("Notify failed:", e?.message || e);
  }
  // graceful shutdown sequence
  try {
    await gracefulShutdown();
  } catch {}
  // exit to let hosting restart process
  process.exit(1);
}

async function gracefulShutdown() {
  try {
    console.log("🧹 Graceful shutdown starting...");
    try { if (autoReportTimer) clearInterval(autoReportTimer); } catch {}
    try { await bot.stop(); } catch {}
    try { clearLock(); } catch {}
    console.log("🧹 Graceful shutdown finished.");
  } catch (e) {
    console.log("Shutdown error:", e?.message || e);
  }
}

// Periodic watchdog loop
setInterval(async () => {
  try {
    // memory
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memMB > MEM_THRESHOLD_MB) {
      watchdogFailures++;
      console.log(`⚠ High memory detected: ${memMB}MB (threshold ${MEM_THRESHOLD_MB})`);
      if (watchdogFailures >= 2) { // allow one transient spike
        await notifyAndRestart(`Memory ${memMB}MB exceeded threshold ${MEM_THRESHOLD_MB}MB`);
        return;
      }
    } else {
      watchdogFailures = 0;
    }

    // hung generate detection
    if (lastGenerateAt && (Date.now() - lastGenerateAt) > (HUNG_TASK_MS + 30_000)) {
      console.log("⚠ Possible hung generate detected (last at)", new Date(lastGenerateAt).toISOString());
      await notifyAndRestart("Hung generate task detected");
      return;
    }

    // consecutive failures check (extra check)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await notifyAndRestart("Too many consecutive failures");
      return;
    }

    // keepalive check - if ping has been failing for a while, alert
    if (!lastKeepAliveOk) {
      console.log("⚠ KeepAlive last ping failed");
      // do not immediately restart — just alert once
      await safeTelegramSend("⚠ KeepAlive ping failing. Check hosting network.");
    }

    // optional health self-check: call /health
    try {
      const h = await axios.get(PUBLIC_URL + "/health", { timeout: 4000 });
      // if health returns unexpected content, log
      if (!h || h.status !== 200) console.log("⚠ Health check returned non-200");
    } catch {}
  } catch (e) {
    console.log("Watchdog error:", e?.message || e);
  }
}, WATCHDOG_INTERVAL_MS);

// ----------------------- Process-level handlers -----------------------
process.on("unhandledRejection", async (reason, p) => {
  console.log("unhandledRejection:", reason);
  try { await safeTelegramSend(`<b>UnhandledRejection</b>\n${String(reason).slice(0,1500)}`); } catch {}
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) await notifyAndRestart("unhandledRejection threshold reached");
});

process.on("uncaughtException", async (err) => {
  console.log("uncaughtException:", err?.message || err);
  try { await safeTelegramSend(`<b>UncaughtException</b>\n${String(err?.stack || err).slice(0,1500)}`); } catch {}
  // immediate restart
  await notifyAndRestart("uncaughtException — restarting");
});

// ----------------------- Cleanup on signals -----------------------
async function cleanupAndExit(code = 0) {
  try { await gracefulShutdown(); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

// ----------------------- Exported helpers (optional) -----------------------
export default {
  startKeepAlive,
  startAutoReport,
  gracefulShutdown
};