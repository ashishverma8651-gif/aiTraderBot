// ===============================================
// 🤖 aiTraderBot.js — AI Trader v10.2 (Synced with tg_commands.js)
// Multi-source | Mirror | ML + Elliott + News | Auto 15m Report
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, keepAlive } from "./utils.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";

// ✅ Correct imports as per your tg_commands.js exports
// Make sure tg_commands.js has: export { buildAIReport, formatAIReport };
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// ===============================================
// 🌐 Express Keep-Alive Server
// ===============================================
const app = express();
const PORT = CONFIG?.SERVER?.PORT || process.env.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader v10.2 running fine!"));
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// ===============================================
// 📡 Binance WebSocket + Multi-Mirror + Fallback
// ===============================================
let lastPrice = null;
let ws = null;
let socketAlive = false;

const BINANCE_WS_MIRRORS = CONFIG?.BINANCE_WS_MIRRORS?.length
  ? CONFIG.BINANCE_WS_MIRRORS
  : [
      "wss://stream.binance.com:9443/ws/",
      "wss://data-stream.binance.vision/ws/",
      "wss://stream.binance.us:9443/ws/",
    ];

let wsMirrorIndex = 0;
let wsReconnectTimer = null;

function connectLiveSocket(symbol = CONFIG?.SYMBOL || "BTCUSDT") {
  const stream = `${symbol.toLowerCase()}@ticker`;

  const connect = () => {
    try {
      const base = BINANCE_WS_MIRRORS[wsMirrorIndex % BINANCE_WS_MIRRORS.length];
      const url = base.endsWith("/") ? base + stream : base + "/" + stream;
      console.log(`🔄 Connecting WebSocket: ${url}`);

      if (ws) {
        try { ws.removeAllListeners?.(); ws.close?.(); } catch (_) {}
        ws = null;
      }

      ws = new WebSocket(url);

      ws.on("open", () => {
        socketAlive = true;
        console.log(`✅ WebSocket connected (${url})`);
      });

      ws.on("message", (data) => {
        try {
          const json = JSON.parse(data.toString());
          if (json?.c || json?.price) lastPrice = parseFloat(json.c ?? json.price);
        } catch {}
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn(`🔴 WS closed — code=${code} reason=${String(reason).slice(0,120)}`);
        wsMirrorIndex = (wsMirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
        wsReconnectTimer = setTimeout(connect, 8000);
      });

      ws.on("error", (err) => {
        socketAlive = false;
        console.warn("⚠️ WS error:", err?.message);
        try { ws.close(); } catch (_) {}
      });
    } catch (err) {
      socketAlive = false;
      console.error("❌ connectLiveSocket fatal:", err.message);
      wsMirrorIndex = (wsMirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
      setTimeout(connect, 8000);
    }
  };

  connect();
}

// connect WS initially
try {
  connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT");
} catch (err) {
  console.warn("⚠️ WS startup failed:", err.message);
}

// ensure WS stays alive
setInterval(() => {
  if (!socketAlive) {
    console.log("♻️ Reconnecting WebSocket...");
    try { connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT"); } catch (e) {}
  }
}, 60000);

// ===============================================
// 📊 Market Data Context
// ===============================================
async function getDataContext(symbol = CONFIG?.SYMBOL || "BTCUSDT") {
  let candlesResp = null;
  try {
    candlesResp = await fetchMarketData(symbol, "15m", 200);
  } catch (err) {
    console.warn("⚠️ fetchMarketData error:", err.message);
  }

  const cleanCandles = candlesResp?.data || candlesResp || [];
  if (!Array.isArray(cleanCandles) || !cleanCandles.length) {
    return {
      price: lastPrice || 0,
      candles: [],
      ml: null,
      ell: null,
      news: null,
      socketAlive,
      error: "No candle data available",
    };
  }

  const last = cleanCandles.at(-1);
  const price = lastPrice || parseFloat(last.close) || 0;

  const [ml, ell, news] = await Promise.all([
    runMLPrediction(symbol).catch((e) => (console.warn("ML error:", e.message), null)),
    analyzeElliott(cleanCandles).catch((e) => (console.warn("Elliott error:", e.message), null)),
    fetchNews(symbol.replace("USDT", "")).catch((e) => (console.warn("News error:", e.message), null)),
  ]);

  return { price, candles: cleanCandles, ml, ell, news, socketAlive };
}

// ===============================================
// 🔁 Auto 15m Telegram Updates
// ===============================================
async function sendAutoReport() {
  try {
    const data = await getDataContext(CONFIG?.SYMBOL || "BTCUSDT");

    // ✅ buildAIReport must return a full formatted message for Telegram
    if (typeof buildAIReport !== "function") throw new Error("buildAIReport() not found");

    const report = await buildAIReport(CONFIG?.SYMBOL || "BTCUSDT", data);

    // ✅ formatAIReport should handle Telegram message sending
    if (typeof formatAIReport !== "function") throw new Error("formatAIReport() not found");

    await formatAIReport(report);
    console.log(`✅ Report sent for ${CONFIG?.SYMBOL || "BTCUSDT"} at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("❌ Auto report error:", err.message);
  }
}

// every 15 min (or CONFIG interval)
const intervalMs = CONFIG?.REPORT_INTERVAL_MS || 15 * 60 * 1000;
setInterval(sendAutoReport, intervalMs);

// first run immediately
(async () => {
  try { await sendAutoReport(); } catch (e) { console.warn("Initial report failed:", e.message); }
})();

// ===============================================
// ♻️ Keep Alive Ping (Render Safe)
// ===============================================
if (CONFIG?.SERVER?.KEEP_ALIVE) {
  setInterval(async () => {
    try {
      const res = await keepAlive();
      if (res?.ok) console.log("✅ KeepAlive ping ok");
    } catch (err) {
      console.warn("⚠️ KeepAlive failed:", err.message);
    }
  }, 5 * 60 * 1000);
}

// ===============================================
// 🧠 Export for modular usage
// ===============================================
export default { sendAutoReport, getDataContext };