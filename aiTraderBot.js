// aiTraderBot.js — FINAL STABLE VERSION (AUTO-REPORT FIXED + NO-SLEEP + CLEAN LOGS)

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
// SIMPLE SERVER
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
// TELEGRAM SENDER (SAFE)
// ======================================================
export async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM?.BOT_TOKEN || !CONFIG.TELEGRAM?.CHAT_ID) {
      console.log("⚠️ Missing Telegram credentials");
      return false;
    }

    const clean = String(text || "").trim();
    if (!clean || clean.length < 2) {
      console.log("⚠️ Telegram send skipped: empty message");
      return false;
    }

    const r = await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM.CHAT_ID,
        text: clean,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

    return r.data?.ok ?? false;

  } catch (e) {
    console.log("Telegram error:", e?.message ?? e);
    return false;
  }
}



// ======================================================
// Market Data Context
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
// AUTO REPORT (FIXED VERSION)
// ======================================================
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
    // 1️⃣ BUILD REPORT
    const raw = await buildAIReport(CONFIG.SYMBOL);
    if (!raw) {
      console.log("❌ buildAIReport returned NULL or falsy");
      await sendTelegram("⚠️ AutoReport failed (buildAIReport empty)");
      autoRunning = false;
      return;
    }

    // 2️⃣ FORMAT REPORT (DEFENSIVE: ensure string)
    let html;
    try {
      html = await formatAIReport(raw);

      // Defensive: if formatAIReport returned non-string, coerce to string
      if (typeof html !== "string") {
        console.log("⚠️ formatAIReport returned non-string:", typeof html);
        // If it's an object (likely) try to stringify concisely but avoid circular crash
        try {
          html = typeof html === "object" ? JSON.stringify(html, (k, v) => (typeof v === 'function' ? '[fn]' : v), 2) : String(html);
        } catch (e) {
          html = String(html || "");
        }
      }

    } catch (e1) {
      console.log("❌ formatAIReport error:", e1?.message ?? e1);
      // Provide useful fallback message
      try {
        html = `<b>⚠️ Format Error</b>\nError: ${String(e1?.message ?? e1)}\n\nRaw data:\n${JSON.stringify(raw, null, 2)}`;
      } catch (e2) {
        html = `<b>⚠️ Format Error</b>\nError while formatting report.`;
      }
    }

    // final safety — avoid trim crash (guarantee html is string)
    if (!html || typeof html !== "string" || html.trim() === "") {
      console.log("❌ formatAIReport returned empty or invalid HTML");
      try {
        html = `<b>⚠️ AutoReport Empty Output</b>\nRaw:\n${JSON.stringify(raw, null, 2)}`;
      } catch (e) {
        html = `<b>⚠️ AutoReport Empty Output</b>\nRaw: (unable to stringify)`;
      }
    }

    // 3️⃣ SEND TO TELEGRAM
    const ok = await sendTelegram(html);
    if (!ok) console.log("❌ Telegram send failed");
    else console.log(nowIST(), "📤 Auto-report sent ✔");

  } catch (e) {
    console.log("❌ AutoReport main error:", e?.message ?? e);
    try {
      await sendTelegram(`⚠️ AutoReport crashed:\n${String(e?.message ?? e)}`);
    } catch {}
  }

  autoRunning = false;
}

function startAuto() {
  const ms = 15 * 60 * 1000;

  setTimeout(doAutoReport, 3000); // First report after 3 sec
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
// KEEPALIVE (NO-SLEEP)
// ======================================================
console.log("🔧 KeepAlive system enabled");

setInterval(async () => {
  if (PUBLIC_URL) {
    try {
      await axios.get(PUBLIC_URL + "/ping", { timeout: 6000 });
      console.log("💓 KeepAlive Public OK");
      return;
    } catch {
      console.log("⚠️ Public KeepAlive failed");
    }
  }

  try {
    await axios.get("http://localhost:" + (PORT || 10000) + "/ping", { timeout: 4000 });
    console.log("💓 Localhost KeepAlive OK");
  } catch (e) {
    console.log("⚠️ Localhost KeepAlive failed");
  }

}, 3 * 60 * 1000);



// ======================================================
// REVERSAL WATCHER START
// ======================================================
try {
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
      try { await sendTelegram(msg); } catch (e) { console.log("ReversalWatcher -> Telegram send failed", e?.message ?? e); }
    }
  );
  console.log("⚡ Reversal Watcher ACTIVE");
} catch (e) {
  console.log("⚠️ Failed to start Reversal Watcher:", e?.message ?? e);
}


// ======================================================
// CLEAN EXIT
// ======================================================
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("🛑 Shutting down...");
  try {
    if (autoTimer) clearInterval(autoTimer);
    try { await stopReversalWatcher(); } catch (err) { /* ignore */ }
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    console.log("Error during shutdown:", err?.message ?? err);
  }
  process.exit(0);
}

export default {
  getDataContext,
  doAutoReport
};