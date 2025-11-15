// aiTraderBot.js — FINAL BUILD (Stable + Flood-proof WS + Silent Reversal Watcher)

import fs from "fs";
import path from "path";
import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import ml from "./ml_module_v8_6.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";


// =======================================================
// LOCK SYSTEM — prevent duplicate instances (Render safe)
// =======================================================
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");

function isAlreadyRunning() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
    if (!pid) return true;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

if (isAlreadyRunning()) {
  console.log("⚠️ Instance already running — exit.");
  process.exit(0);
}

fs.writeFileSync(LOCK_FILE, String(process.pid));

process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));


// =======================================================
// EXPRESS SERVER
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader Running"));
app.get("/ping", (_, res) => res.send("pong"));

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));


// =======================================================
// TELEGRAM SENDER
// =======================================================
async function sendTelegram(text) {
  try {
    const token = CONFIG.TELEGRAM.BOT_TOKEN;
    const chat = CONFIG.TELEGRAM.CHAT_ID;
    if (!token || !chat) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    await axios.post(url, {
      chat_id: chat,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
  } catch (e) {
    console.log("Telegram error:", e.response?.status || e.message);
  }
}


// =======================================================
// FLOOD-PROOF WEBSOCKET (SUPER STABLE VERSION)
// =======================================================
let ws = null;
let wsAlive = false;
let wsConnecting = false;
let lastWS = 0;
let lastPrice = 0;

const WS_RETRY = 7000;

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;

  async function open() {
    const now = Date.now();
    if (wsConnecting) return;
    if (now - lastWS < WS_RETRY) return;

    wsConnecting = true;
    lastWS = now;

    try { if (ws) ws.terminate(); } catch {}

    const url = `wss://stream.binance.com:9443/ws/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      wsAlive = true;
      wsConnecting = false;
      console.log("🔗 WS Connected");
    });

    ws.on("message", (msg) => {
      try {
        const j = JSON.parse(msg);
        if (j?.c) lastPrice = parseFloat(j.c);
      } catch {}
    });

    ws.on("close", () => {
      wsAlive = false;
      wsConnecting = false;
      console.log("⚠️ WS closed → retry 7s");
      setTimeout(open, WS_RETRY);
    });

    ws.on("error", () => {
      wsAlive = false;
      wsConnecting = false;
      console.log("⚠️ WS error → retry 7s");
      setTimeout(open, WS_RETRY);
    });
  }

  open();
}

connectWS(CONFIG.SYMBOL);


// =======================================================
// DATA CONTEXT
// =======================================================
export async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    return { price: lastPrice || m15.price, candles: m15.data, socketAlive: wsAlive };
  } catch {
    return { price: lastPrice, candles: [], socketAlive: wsAlive };
  }
}


// =======================================================
// AUTO REPORT (single instance guaranteed)
// =======================================================
let autoReportRun = false;

async function autoReport() {
  if (autoReportRun) return;
  autoReportRun = true;

  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    const msg = await formatAIReport(report);
    await sendTelegram(msg);
    console.log("📤 15m report sent");
  } catch (e) {
    console.log("AutoReport error:", e.message);
  }

  autoReportRun = false;
}

setInterval(autoReport, 15 * 60 * 1000);
setTimeout(autoReport, 5000);


// =======================================================
// KEEPALIVE PING (Render)
// =======================================================
if (CONFIG.SELF_PING_URL) {
  setInterval(() => {
    axios.get(`${CONFIG.SELF_PING_URL}/ping`).catch(() => {});
  }, 240000);
}


// =======================================================
// ML AUTO RETRAIN
// =======================================================
ml.startAutoRetrain();


// =======================================================
// SILENT REVERSAL WATCHER — NO FEEDBACK SPAM
// =======================================================
try {
  startReversalWatcher(CONFIG.SYMBOL, {
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    microLookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60,
    minProb: CONFIG.REVERSAL_MIN_PROB || 58,

    // ONLY ONE OUTPUT ALLOWED
    sendAlert: async (msg) => {
      await sendTelegram(msg);
    },

    // DISABLE logs completely
    silent: true
  });

  console.log("⚡ Reversal Watcher started (silent mode)");
} catch (e) {
  console.log("Reversal Watcher failed:", e.message);
}


// =======================================================
// EXPORT
// =======================================================
export default { getDataContext, autoReport };