// aiTraderBot.js — main runner: express server, WS mirror, auto 15m report
import express from "express";
import WebSocket from "ws";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import { buildAIReport, formatAIReport } from "./tg_commands.js";
import { keepAlive } from "./utils.js"; // keepAlive in utils isn't implemented above; optional

// simple express server
const app = express();
const PORT = process.env.PORT || CONFIG.PORT || 10000;
app.get("/", (_,res)=> res.send("✅ AI Trader running"));
app.listen(PORT, ()=> console.log(`✅ Server live on port ${PORT}`));

// WebSocket mirrors (only used for last price tick)
let lastPrice = null;
let socketAlive = false;
let ws = null;
let mirrorIdx = 0;

const WS_MIRRORS = CONFIG.WS_MIRRORS || ["wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws"];

function connectWS(symbol = CONFIG.SYMBOL || "BTCUSDT") {
  const stream = `${symbol.toLowerCase()}@ticker`;
  const connect = () => {
    const base = WS_MIRRORS[mirrorIdx % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : base + "/" + stream;
    try {
      if (ws) try { ws.terminate(); } catch {}
      ws = new WebSocket(url);
      ws.on("open", () => { socketAlive = true; console.log("WS open", url); });
      ws.on("message", (data) => {
        try {
          const j = typeof data === "string" ? JSON.parse(data) : JSON.parse(data.toString());
          if (j && (j.c || j.last_price)) lastPrice = parseFloat(j.c || j.last_price);
        } catch(_) {}
      });
      ws.on("close", (code, reason) => { socketAlive = false; console.warn("WS closed", code, reason); mirrorIdx++; setTimeout(connect, 5000); });
      ws.on("error", (e) => { socketAlive = false; console.warn("WS error", e?.message || e); try { ws.terminate(); } catch {} });
    } catch (e) { socketAlive = false; mirrorIdx++; setTimeout(connect, 5000); }
  };
  connect();
}
connectWS(CONFIG.SYMBOL);

// getDataContext
async function getDataContext(symbol = CONFIG.SYMBOL) {
  try {
    const m15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    const candles = m15.data || [];
    const price = (typeof lastPrice === "number" && !Number.isNaN(lastPrice)) ? lastPrice : (m15.price || 0);
    return { price, candles, socketAlive };
  } catch (e) {
    console.warn("getDataContext error", e?.message || e);
    return { price: lastPrice || 0, candles: [], socketAlive };
  }
}

// auto report
async function sendAutoReport() {
  try {
    const ctx = await getDataContext(CONFIG.SYMBOL);
    const report = await buildAIReport(CONFIG.SYMBOL, ctx);
    await formatAIReport(report);
    console.log("✅ Report sent at", new Date().toLocaleString());
  } catch (e) {
    console.error("Auto report error:", e?.message || e);
  }
}

setInterval(sendAutoReport, CONFIG.REPORT_INTERVAL_MS || (15*60*1000));
(async()=>{ try{ await sendAutoReport(); }catch{} })();

export default { sendAutoReport, getDataContext };