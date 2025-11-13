// ===============================================
// 🤖 aiTraderBot.js — AI Trader v10.1 (Hardened & Integrated)
// Multi-source | WebSocket Mirror | ML + Elliott + News | Auto 15m Report
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, keepAlive } from "./utils.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";

// IMPORTANT: tg_commands.js must export these two functions:
//   - buildTelegramUIReport(symbol, data)  -> returns formatted string (HTML) or object accepted by sendTelegramMessage
//   - sendTelegramMessage(messageOrObject, chatId?) -> sends to Telegram
import { buildTelegramUIReport, sendTelegramMessage } from "./tg_commands.js";

// ===============================================
// 🌐 Express Keep-Alive Server
// ===============================================
const app = express();
const PORT = (CONFIG?.SERVER?.PORT) || process.env.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader v10.1 running fine!"));
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// ===============================================
// 📡 Binance WebSocket + Multi-Mirror + Fallback
// ===============================================
let lastPrice = null;
let ws = null;
let socketAlive = false;

const BINANCE_WS_MIRRORS = Array.isArray(CONFIG?.BINANCE_WS_MIRRORS) && CONFIG.BINANCE_WS_MIRRORS.length
  ? CONFIG.BINANCE_WS_MIRRORS
  : [
      "wss://stream.binance.com:9443/ws/",
      "wss://data-stream.binance.vision/ws/",
      "wss://stream.binance.us:9443/ws/",
    ];

let wsMirrorIndex = 0;
let wsReconnectTimer = null;

function connectLiveSocket(symbol = (CONFIG?.SYMBOL || "BTCUSDT")) {
  const stream = `${symbol.toLowerCase()}@ticker`;

  const connect = () => {
    try {
      const base = BINANCE_WS_MIRRORS[wsMirrorIndex % BINANCE_WS_MIRRORS.length];
      const url = base.endsWith("/") ? base + stream : base + "/" + stream;
      console.log(`🔄 Connecting WebSocket: ${url}`);

      // clear previous socket if exists
      if (ws) {
        try { ws.removeAllListeners?.(); } catch (_) {}
        try { ws.close?.(); } catch (_) {}
        ws = null;
      }

      ws = new WebSocket(url);

      ws.on("open", () => {
        socketAlive = true;
        console.log(`✅ Live WebSocket connected (${url})`);
      });

      ws.on("message", (data) => {
        try {
          const json = typeof data === "string" ? JSON.parse(data) : JSON.parse(data.toString());
          // Binance ticker payload uses 'c' as last price in many streams
          if (json && (json.c || json.price)) {
            lastPrice = parseFloat(json.c ?? json.price);
          }
        } catch (err) {
          // non-fatal parse error
          // console.debug("WS parse error:", err.message);
        }
      });

      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn(`🔴 WS closed — code=${code} reason=${String(reason).slice(0,120)}`);
        // rotate mirror and reconnect after short delay
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
      // try again with next mirror
      wsMirrorIndex = (wsMirrorIndex + 1) % BINANCE_WS_MIRRORS.length;
      setTimeout(connect, 8000);
    }
  }; // connect

  connect();
}

// start WS
try {
  connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT");
} catch (err) {
  console.warn("⚠️ WebSocket startup failed:", err.message || err);
  socketAlive = false;
}

// periodically ensure WS is alive, else try reconnect
setInterval(() => {
  if (!socketAlive) {
    console.log("♻️ WS not alive — attempting reconnect...");
    try {
      connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT");
    } catch (e) {
      console.warn("♻️ Reconnect attempt failed:", e.message || e);
    }
  }
}, 60 * 1000);

// ===============================================
// 📊 Build Data Context (for tg_commands.js)
// ===============================================
async function getDataContext(symbol = (CONFIG?.SYMBOL || "BTCUSDT")) {
  // Attempt fetch from fetchMarketData (utils) - utils should implement mirror/proxy internally if needed
  let candlesResp = null;
  try {
    candlesResp = await fetchMarketData(symbol, "15m", 200);
  } catch (err) {
    console.warn("⚠️ fetchMarketData error:", err.message || err);
  }

  const cleanCandles = (candlesResp && (candlesResp.data || candlesResp)) || [];
  if (!Array.isArray(cleanCandles) || !cleanCandles.length) {
    // Do not throw — return partial context so UI can show an error message gracefully
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

  // run ML, Elliott, News in parallel where possible
  const tasks = {
    ml: runMLPrediction(symbol).catch((e) => { console.warn("ML error:", e?.message || e); return null; }),
    ell: analyzeElliott(cleanCandles).catch((e) => { console.warn("Elliott error:", e?.message || e); return null; }),
    news: fetchNews(symbol.replace("USDT", "")).catch((e) => { console.warn("News error:", e?.message || e); return null; }),
  };

  const results = await Promise.all([tasks.ml, tasks.ell, tasks.news]);

  const ml = results[0];
  const ell = results[1];
  const news = results[2];

  return {
    price,
    candles: cleanCandles,
    ml,
    ell,
    news,
    socketAlive,
  };
}

// ===============================================
// 🔁 Auto 15m Telegram Updates (uses tg_commands.js UI)
// ===============================================
async function sendAutoReport() {
  try {
    const data = await getDataContext(CONFIG?.SYMBOL || "BTCUSDT");

    // buildTelegramUIReport must be exported from tg_commands.js
    // It should accept (symbol, data) and return final formatted message (string) or object.
    if (typeof buildTelegramUIReport !== "function") {
      throw new Error("buildTelegramUIReport() not found in tg_commands.js — ensure it is exported");
    }

    const report = await buildTelegramUIReport(CONFIG?.SYMBOL || "BTCUSDT", data);

    // sendTelegramMessage should handle either a string or object as per your tg_commands implementation
    if (typeof sendTelegramMessage !== "function") {
      throw new Error("sendTelegramMessage() not found in tg_commands.js — ensure it is exported");
    }

    await sendTelegramMessage(report).catch((e) => {
      // sendTelegramMessage may throw or reject
      console.error("❌ sendTelegramMessage failed:", e?.message || e);
    });

    console.log(`✅ [${CONFIG?.SYMBOL || "BTCUSDT"}] Report sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("❌ Auto report error:", err?.message || err);
    // do not crash — swallow and continue next interval
  }
}

// schedule auto reports (15 minutes default)
const intervalMs = CONFIG?.REPORT_INTERVAL_MS || (15 * 60 * 1000);
setInterval(sendAutoReport, intervalMs);

// run immediately on start (wrapped)
(async () => {
  try {
    await sendAutoReport();
  } catch (e) {
    console.warn("Initial auto report failed:", e?.message || e);
  }
})();

// ===============================================
// ♻️ Auto Keep-Alive Ping (Render Safe)
// ===============================================
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

// ===============================================
// 🧠 Export for modular use
// ===============================================
export default { sendAutoReport, getDataContext };