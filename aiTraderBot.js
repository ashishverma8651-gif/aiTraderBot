/* ============================================================
   aiTraderBot.js — AI Trader + Reversal Watcher Integration
   ============================================================ */

import express from "express";
import WebSocket from "ws";
import axios from "axios";

import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// 🔥 NEW: Reversal Watcher
import { startReversalWatcher } from "./reversal_watcher.js";

/* ============================================================
   EXPRESS SERVER
   ============================================================ */

const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;

app.get("/", (_, res) => res.send("✅ AI Trader is running with Reversal Watcher"));

app.listen(PORT, () =>
  console.log(`✅ Server live on port ${PORT} (${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})})`)
);

/* ============================================================
   WEBSOCKET LIVE PRICE (1s update)
   ============================================================ */

let lastPrice = null;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;

const WS_MIRRORS = CONFIG.WS_MIRRORS;

function connectWS(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;

  const connect = () => {
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : `${base}/${stream}`;

    try {
      if (ws) try { ws.terminate(); } catch {}

      ws = new WebSocket(url);

      ws.on("open", () => {
        socketAlive = true;
        console.log("🔗 WS Connected:", url);
      });

      ws.on("message", (data) => {
        try {
          const j =
            typeof data === "string"
              ? JSON.parse(data)
              : JSON.parse(data.toString());

          if (j?.c) lastPrice = parseFloat(j.c);
        } catch (_) {}
      });

      ws.on("close", () => {
        socketAlive = false;
        mirrorIdx++;
        setTimeout(connect, 4000);
      });

      ws.on("error", () => {
        socketAlive = false;
        mirrorIdx++;
        setTimeout(connect, 4000);
      });

    } catch {
      socketAlive = false;
      mirrorIdx++;
      setTimeout(connect, 4000);
    }
  };

  connect();
}

connectWS(CONFIG.SYMBOL);

/* ============================================================
   DATA CONTEXT
   ============================================================ */

async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    const candles = m15.data || [];

    const price =
      typeof lastPrice === "number" && !Number.isNaN(lastPrice)
        ? lastPrice
        : m15.price || 0;

    return { price, candles, socketAlive };
  } catch (e) {
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

/* ============================================================
   AUTO 15M REPORT
   ============================================================ */

async function sendAutoReport() {
  try {
    const ctx = await getDataContext(CONFIG.SYMBOL);
    const report = await buildAIReport(CONFIG.SYMBOL, ctx);
    await formatAIReport(report);

    console.log("📤 15m Report sent:", new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}));
  } catch (e) {
    console.error("Auto report error:", e);
  }
}

setInterval(sendAutoReport, CONFIG.REPORT_INTERVAL_MS);
(async () => sendAutoReport())();

/* ============================================================
   REVERSAL WATCHER START (1m scans)
   ============================================================ */

startReversalWatcher({
  symbol: CONFIG.SYMBOL,
  interval: "1m",
  limit: 60,
  telegram: CONFIG.TELEGRAM
});

/* ============================================================
   KEEP-ALIVE (Render)
   ============================================================ */
const SELF = CONFIG.SELF_URL;

setInterval(async () => {
  try {
    await axios.get(SELF);
    console.log("💓 KeepAlive", new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}));
  } catch (e) {
    console.log("⚠️ KeepAlive failed");
  }
}, 4 * 60 * 1000);

export default { sendAutoReport, getDataContext };