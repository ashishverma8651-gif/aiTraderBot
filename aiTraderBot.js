// aiTraderBot.js — FINAL CLEAN BUILD (with Reversal Watcher integrated)

import express from "express";
import WebSocket from "ws";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { startReversalWatcher, stopReversalWatcher } from "./reversal_watcher.js";

// =======================================================
// TELEGRAM BOT
// =======================================================
const BOT_TOKEN = CONFIG.TELEGRAM.BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM.CHAT_ID;

let bot = null;

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn("⚠️ Telegram not configured — BOT_TOKEN or CHAT_ID missing");
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: false });
  console.log("🤖 Telegram bot ready");
}

// =======================================================
// EXPRESS SERVER
// =======================================================
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader is running"));
app.listen(PORT, () =>
  console.log(
    `✅ Server live on port ${PORT} (${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    })})`
  )
);

// =======================================================
// WEBSOCKET LIVE PRICE
// =======================================================
let lastPrice = null;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;

const WS_MIRRORS = CONFIG.WS_MIRRORS;

function wsStream(symbol) {
  return `${symbol.toLowerCase()}@ticker`;
}

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = wsStream(symbol);

  function connectNow() {
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) try { ws.terminate(); } catch {}

      ws = new WebSocket(url);

      ws.on("open", () => {
        socketAlive = true;
        console.log("🔗 WebSocket Connected:", url);
      });

      ws.on("message", (data) => {
        try {
          const j = JSON.parse(data.toString());
          if (j.c) lastPrice = parseFloat(j.c);
        } catch {}
      });

      ws.on("close", () => {
        socketAlive = false;
        mirrorIdx++;
        setTimeout(connectNow, 3000);
      });

      ws.on("error", () => {
        socketAlive = false;
        mirrorIdx++;
        try { ws.terminate(); } catch {}
        setTimeout(connectNow, 3000);
      });
    } catch {
      mirrorIdx++;
      setTimeout(connectNow, 3000);
    }
  }

  connectNow();
}

connectWS(CONFIG.SYMBOL);

// =======================================================
// MARKET DATA CONTEXT
// =======================================================
async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    const candles = m15.data || [];
    const price = lastPrice || m15.price || 0;

    return { price, candles, socketAlive };
  } catch {
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// =======================================================
// AUTO 15m REPORT
// =======================================================
async function sendAutoReport() {
  try {
    const report = await buildAIReport(CONFIG.SYMBOL);
    await formatAIReport(report);

    console.log(
      "📤 Auto Report Sent:",
      new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    );
  } catch (e) {
    console.error("Auto report error:", e.message);
  }
}

setInterval(sendAutoReport, CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000);

(async () => {
  try { await sendAutoReport(); } catch {}
})();

// =======================================================
// KEEP ALIVE (Render fix)
// =======================================================
const SELF_URL = CONFIG.SELF_PING_URL;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_URL);
      console.log("💓 KeepAlive Ping");
    } catch {}
  }, 4 * 60 * 1000);
}

// =======================================================
// REVERSAL WATCHER INTEGRATION (FINAL)
// =======================================================
try {
  startReversalWatcher(CONFIG.SYMBOL, {
    bot,
    chatId: CHAT_ID,
    pollIntervalMs: CONFIG.REVERSAL_WATCHER_POLL_MS || 15000,
    lookback: CONFIG.REVERSAL_WATCHER_LOOKBACK || 60,
  });

  console.log("🚀 Reversal Watcher ACTIVE");
} catch (e) {
  console.log("⚠️ Reversal Watcher failed:", e.message);
}

// =======================================================
// SHUTDOWN HANDLER
// =======================================================
async function shutdown() {
  try {
    stopReversalWatcher();
    if (ws) ws.terminate();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default {
  sendAutoReport,
  getDataContext
};