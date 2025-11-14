// aiTraderBot.js — entry, WS mirrors, auto 15m report
import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, keepAlive } from "./utils.js";
import { runMLPrediction } from "./ml_module_v8_6.js"; // if exists, else adjust
import { analyzeElliott } from "./elliott_module.js"; // optional
import { fetchNews } from "./news_social.js"; // optional
import { buildAIReport, formatAIReport } from "./tg_commands.js";

const app = express();
const PORT = CONFIG?.SERVER?.PORT || process.env.PORT || 10000;
app.get("/", (_, res) => res.send("✅ AI Trader running"));
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

let lastPrice = null;
let socketAlive = false;
let ws = null;

const WS_MIRRORS = (CONFIG?.DATA_SOURCES?.CRYPTO?.SOCKETS && CONFIG.DATA_SOURCES.CRYPTO.SOCKETS.BACKUP)
  ? [CONFIG.DATA_SOURCES.CRYPTO.SOCKETS.MAIN || "wss://stream.binance.com:9443/ws", CONFIG.DATA_SOURCES.CRYPTO.SOCKETS.BACKUP]
  : ["wss://stream.binance.com:9443/ws", "wss://data-stream.binance.vision/ws", "wss://stream.binance.us:9443/ws", "wss://binance.wsproxy.workers.dev/ws"];

let wsIndex = 0;
function connectLiveSocket(symbol = CONFIG?.SYMBOL || "BTCUSDT") {
  const stream = `${symbol.toLowerCase()}@ticker`;
  const tryConnect = () => {
    const base = WS_MIRRORS[wsIndex % WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : base + "/" + stream;
    console.log("Attempt WS:", url);
    try {
      if (ws) { try { ws.terminate?.(); } catch(_){} ws=null; }
      ws = new WebSocket(url);
      ws.on('open', ()=>{ socketAlive = true; console.log("WS open", url); });
      ws.on('message', (data)=>{
        try {
          const json = typeof data === "string" ? JSON.parse(data) : JSON.parse(data.toString());
          lastPrice = Number(json.c ?? json.price ?? lastPrice);
        } catch(_) {}
      });
      ws.on('close', (code, reason)=> {
        socketAlive = false;
        console.warn("WS closed", code, String(reason).slice(0,150));
        wsIndex = (wsIndex+1) % WS_MIRRORS.length;
        setTimeout(tryConnect, CONFIG?.DATA_SOURCES?.CRYPTO?.SOCKETS?.RECONNECT_DELAY_MS || 8000);
      });
      ws.on('error', (err)=> {
        socketAlive = false;
        console.warn("WS error:", err?.message || err);
        try { ws.terminate?.(); } catch(_) {}
      });
    } catch (err) {
      socketAlive = false;
      console.error("connectLiveSocket error:", err?.message || err);
      wsIndex = (wsIndex+1) % WS_MIRRORS.length;
      setTimeout(tryConnect, 8000);
    }
  };
  tryConnect();
}
connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT");
setInterval(()=> { if (!socketAlive) { console.log("WS not alive, reconnecting..."); connectLiveSocket(CONFIG?.SYMBOL || "BTCUSDT"); } }, 60*1000);

async function getDataContext(symbol = CONFIG?.SYMBOL || "BTCUSDT") {
  let candlesResp = null;
  try { candlesResp = await fetchMarketData(symbol, "15m", 200); } catch(e){ console.warn("fetchMarketData ctx:", e?.message || e); }
  const cleanCandles = (candlesResp && (candlesResp.data || candlesResp)) || [];
  if (!Array.isArray(cleanCandles) || !cleanCandles.length) {
    return { price: lastPrice || 0, candles: [], ml: null, ell: null, news: null, socketAlive, error: "no-candles" };
  }
  const price = (typeof lastPrice === "number" && !Number.isNaN(lastPrice)) ? lastPrice : (Number(cleanCandles.at(-1).close) || 0);
  const tasks = [
    (typeof runMLPrediction === "function") ? runMLPrediction(symbol).catch(()=>null) : Promise.resolve(null),
    (typeof analyzeElliott === "function") ? analyzeElliott(cleanCandles).catch(()=>null) : Promise.resolve(null),
    (typeof fetchNews === "function") ? fetchNews(symbol.replace("USDT","")).catch(()=>null) : Promise.resolve(null),
  ];
  const [ml, ell, news] = await Promise.all(tasks);
  return { price, candles: cleanCandles, ml, ell, news, socketAlive };
}

async function sendAutoReport() {
  try {
    const ctx = await getDataContext(CONFIG?.SYMBOL || "BTCUSDT");
    const report = await buildAIReport(CONFIG?.SYMBOL || "BTCUSDT", ctx);
    await formatAIReport(report);
    console.log(`[${CONFIG?.SYMBOL||"BTCUSDT"}] Report processed at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("Auto report error:", err?.message || err);
  }
}

const intervalMs = Number(CONFIG?.TIMERS?.REPORT_INTERVAL_MIN || 15) * 60 * 1000;
setInterval(sendAutoReport, intervalMs);
(async ()=> { try { await sendAutoReport(); } catch(e){ console.warn("initial report failed:", e?.message || e); } })();

if (CONFIG?.SERVER?.KEEP_ALIVE) {
  setInterval(async ()=> {
    try { const res = await keepAlive(); if (res?.ok) console.log("KeepAlive ok"); } catch(e){ console.warn("KeepAlive:", e?.message || e); }
  }, 5*60*1000);
}

export default { sendAutoReport, getDataContext };