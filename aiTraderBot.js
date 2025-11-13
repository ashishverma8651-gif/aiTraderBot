// ===============================================
// 🤖 aiTraderBot.js — AI Trader v10.2 (Synced with tg_commands.js)
// Multi-source | WebSocket Mirror | ML + Elliott + News | Auto 15m Report
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, keepAlive } from "./utils.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";

// Correct imports (tg_commands.js exports these named functions)
import { buildAIReport, formatAIReport } from "./tg_commands.js";

// Express server (keep-alive)
const app = express();
const PORT = CONFIG?.SERVER?.PORT || process.env.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader v10.2 running fine!"));
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// WebSocket multi-mirror
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
          const json = typeof data === "string" ? JSON.parse(data) : JSON.parse(data.toString());
          if (json && (json.c || json.price)) lastPrice = parseFloat(json.c ?? json.price);
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn(`🔴 WS closed — code=${code} reason=${String(reason).slice(0,120)}`);
        wsMirrorIndex = (wsMirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connect, 8000);
      });

      ws.on("error", (err) => {
        socketAlive = false;
        console.warn("⚠️ WS error:", err && err.message ? err.message : String(err));
        try { ws.close(); } catch (_) {}
      });
    } catch (err) {
      socketAlive = false;
      console.error("❌ connectLiveSocket fatal:", err.message || err);
      wsMirrorIndex = (wsMirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
      setTimeout(connect, 8000);
    }
  };

  connect();
}

// start WS
try {
  connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT");
} catch (err) {
  console.warn("⚠️ WebSocket startup failed:", err.message || err);
  socketAlive = false;
}

// ensure WS is alive or try reconnect
setInterval(() => {
  if (!socketAlive) {
    console.log("♻️ WS not alive — attempting reconnect...");
    try { connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT"); } catch (e) {}
  }
}, 60 * 1000);

// Get data context: candles, ml, ell, news
async function getDataContext(symbol = (CONFIG?.SYMBOL || "BTCUSDT")) {
  let candlesResp = null;
  try {
    candlesResp = await fetchMarketData(symbol, "15m", 200);
  } catch (err) {
    console.warn("⚠️ fetchMarketData error:", err?.message || err);
  }

  const cleanCandles = (candlesResp && (candlesResp.data || candlesResp)) || [];
  if (!Array.isArray(cleanCandles) || !cleanCandles.length) {
    // return partial context; tg_commands will handle display fallback
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
  const price = (typeof lastPrice === "number" && !Number.isNaN(lastPrice)) ? lastPrice : (parseFloat(last.close) || 0);

  const tasks = {
    ml: runMLPrediction(symbol).catch((e) => { console.warn("ML error:", e?.message || e); return null; }),
    ell: analyzeElliott(cleanCandles).catch((e) => { console.warn("Elliott error:", e?.message || e); return null; }),
    news: fetchNews(symbol.replace("USDT", "")).catch((e) => { console.warn("News error:", e?.message || e); return null; }),
  };

  const [ml, ell, news] = await Promise.all([tasks.ml, tasks.ell, tasks.news]);

  return {
    price,
    candles: cleanCandles,
    ml,
    ell,
    news,
    socketAlive,
  };
}

// Auto 15m report: buildAIReport -> formatAIReport (formatAIReport sends message)
async function sendAutoReport() {
  try {
    const data = await getDataContext(CONFIG?.SYMBOL || "BTCUSDT");

    if (typeof buildAIReport !== "function") {
      throw new Error("buildAIReport not found in tg_commands.js");
    }
    if (typeof formatAIReport !== "function") {
      throw new Error("formatAIReport not found in tg_commands.js");
    }

    const reportObj = await buildAIReport(CONFIG?.SYMBOL || "BTCUSDT", data);
    await formatAIReport(reportObj);

    console.log(`✅ [${CONFIG?.SYMBOL || "BTCUSDT"}] Report processed at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("❌ Auto report error:", err?.message || err);
  }
}

const intervalMs = CONFIG?.REPORT_INTERVAL_MS || (15 * 60 * 1000);
setInterval(sendAutoReport, intervalMs);

// initial immediate run
(async () => {
  try { await sendAutoReport(); } catch (e) { console.warn("Initial auto report failed:", e?.message || e); }
})();

// Keep-alive ping for Render
if (CONFIG?.SERVER?.KEEP_ALIVE) {
  setInterval(async () => {
    try {
      const res = await keepAlive();
      if (res && res.ok) console.log("✅ KeepAlive success ping");
    } catch (err) {
      console.warn("⚠️ KeepAlive ping failed:", err?.message || err);
    }
  }, 5 * 60 * 1000);
}

export default { sendAutoReport, getDataContext };