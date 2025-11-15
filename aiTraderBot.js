// aiTraderBot.js — FINAL (NO WEBSOCKET, NO REVERSAL WATCHER, STABLE FOR RENDER FREE)
// Price only via REST, 15m auto-report, IST timestamps.

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// -----------------------------
// SINGLE-INSTANCE GUARD
// -----------------------------
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");

function alreadyRunning() {
  if (global.__aiTrader_running) return true;
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (isNaN(pid)) return true;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return true; }
}

if (alreadyRunning()) {
  console.log("⚠️ Bot already running — exiting.");
  process.exit(0);
}

try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
global.__aiTrader_running = true;

process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });

// -----------------------------
// EXPRESS SERVER
// -----------------------------
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("AI Trader Running (No-WS)"));
app.listen(PORT, () => console.log("🚀 Server on", PORT));

// -----------------------------
// HELPERS
// -----------------------------
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// -----------------------------
// TELEGRAM SENDER
// -----------------------------
async function sendTelegram(text) {
  try {
    if (!CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.CHAT_ID) return;

    let clean = text.replace(/[-=_]{3,}/g, "\n\n").trim();

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
    console.log("Telegram error:", err?.response?.status || err?.message);
  }
}

// -----------------------------
// DATA FETCHER (NO WS)
// -----------------------------
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: m15.price || 0, candles: m15.data || [] };
  } catch {
    return { price: 0, candles: [] };
  }
}

// -----------------------------
// AUTO REPORT EVERY 15 MINUTES
// -----------------------------
let running = false;

async function doAutoReport() {
  if (running) return;
  running = true;

  try {
    console.log(nowIST(), "📡 Building report...");
    const r = await buildAIReport(CONFIG.SYMBOL);
    const html = await formatAIReport(r);
    await sendTelegram(html);
    console.log(nowIST(), "📤 Report sent");
  } catch (e) {
    console.log("AutoReport error:", e.message);
  }

  running = false;
}

function startAuto() {
  const ms = 15 * 60 * 1000; // 15m
  setTimeout(doAutoReport, 3000);
  setInterval(doAutoReport, ms);
  console.log(nowIST(), "⏱ AutoReport every 15m started");
}

startAuto();

// -----------------------------
// OPTIONAL KEEPALIVE
// -----------------------------
if (CONFIG.SELF_PING_URL) {
  setInterval(async () => {
    try { await axios.get(CONFIG.SELF_PING_URL + "/ping"); }
    catch { console.log("Keepalive fail"); }
  }, 4 * 60 * 1000);
}

// -----------------------------
export default {
  getDataContext,
  doAutoReport
};