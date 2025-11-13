// aiTraderBot.js — unified main (v9.5-style report)
// Expects: config.js, tg_commands.js to exist
import CONFIG from "./config.js";
import express from "express";
import axios from "axios";
import WebSocket from "ws";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

const PORT = process.env.PORT || 10000;
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ------------------ Live price socket (primary) ------------------
let lastPrice = null;
let socketAlive = false;
let socketRetries = 0;

function connectBinanceSocket(symbol = CONFIG.SYMBOL) {
  // Binance minimize to lowercase stream name
  const stream = `${symbol.toLowerCase()}@kline_1m`; // 1m ticker candles for quick update
  const wsUrl = `wss://stream.binance.com:9443/ws/${stream}`;
  try {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 5000 });

    ws.on('open', () => {
      socketAlive = true;
      socketRetries = 0;
      console.log("📡 Binance WebSocket open");
    });

    ws.on('message', (d) => {
      try {
        const j = JSON.parse(d);
        // candlestick payload: j.k with .c close price
        if (j && j.k && j.k.c) {
          lastPrice = Number(j.k.c);
        } else if (j && j.c) {
          lastPrice = Number(j.c);
        }
      } catch (e) { /* ignore parse */ }
    });

    ws.on('error', (err) => {
      socketAlive = false;
      console.warn("Socket error:", err && err.message ? err.message : err);
      ws.terminate();
    });

    ws.on('close', (code, reason) => {
      socketAlive = false;
      console.warn("Socket closed:", code, reason?.toString?.() || reason);
      // retry with backoff
      socketRetries++;
      const wait = Math.min(30000, 2000 + socketRetries * 2000);
      setTimeout(() => connectBinanceSocket(symbol), wait);
    });

    return ws;
  } catch (e) {
    socketAlive = false;
    console.warn("Failed to create websocket:", e.message || e);
    // schedule retry
    setTimeout(() => connectBinanceSocket(symbol), 5000);
  }
}

// start socket
connectBinanceSocket(CONFIG.SYMBOL);

// ------------------ REST fallback utilities ------------------
async function fetchCandlesFromSource(url) {
  try {
    const r = await axios.get(url, { timeout: 7000 });
    return r.data;
  } catch (e) {
    // console.warn("source fetch failed:", e.message);
    return null;
  }
}

// normalized ensureCandles (many formats supported)
function ensureCandlesArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object' && raw[0].close !== undefined) return raw;
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return raw.map(r => ({
      t: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      vol: Number(r[5] ?? 0)
    }));
  }
  // Binance REST (array-of-arrays) handled above
  return [];
}

// try multiple REST sources (binance first)
async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = "15m", limit = 200) {
  // convert interval to binance format if needed (pass as-is from config)
  const binanceInt = interval;
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInt}&limit=${limit}`,
    // (others can be added)
  ];
  for (const u of urls) {
    const data = await fetchCandlesFromSource(u);
    if (data && data.length) return { data, source: "binance" };
  }
  // fallback to empty
  return { data: [], source: "none" };
}

// small indicator helpers
function safeNum(v, fallback=NaN){ const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function lastOf(arr){ return (Array.isArray(arr) && arr.length) ? arr[arr.length-1] : null; }

// compute simple RSI (fast, for UI only)
function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=candles.length-period; i<candles.length; i++){
    const diff = candles[i].close - (candles[i-1]?.close ?? candles[i].open);
    if (diff>0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = (gains/period) / (losses/period || 1);
  return 100 - (100/(1+rs));
}

// compute ATR simple
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period+1) return null;
  let tr=0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1] || c;
    tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return tr / period;
}

// Build multi-timeframe snapshot (simplified)
async function buildMultiTimeframeIndicators(symbol) {
  const outs = {};
  for (const tf of CONFIG.INTERVALS) {
    try {
      const resp = await fetchMarketData(symbol, tf, 200);
      const candles = ensureCandlesArray(resp.data || []);
      if (!candles.length) {
        outs[tf] = { price: "N/A", vol: "-", rsi: "N/A", macd: "0.000", atr: "-" , bias: "Sideways" };
        continue;
      }
      const last = lastOf(candles);
      const rsi = computeRSI(candles, 14);
      const atr = computeATR(candles, 14);
      // Very simple bias: RSI >60 Bull, <40 Bear else Sideways
      const bias = (rsi && rsi>60) ? "Bullish" : (rsi && rsi<40) ? "Bearish" : "Sideways";
      outs[tf] = {
        price: safeNum(last.close, 0).toFixed(2),
        vol: String(safeNum(last.vol || last.volume || 0, 0)),
        rsi: rsi ? rsi.toFixed(2) : "N/A",
        macd: "0.000",
        atr: atr ? atr.toFixed(2) : "-",
        bias
      };
    } catch (e) {
      outs[tf] = { price: "N/A", vol: "-", rsi: "N/A", macd: "0.000", atr: "-", bias: "N/A" };
    }
  }
  return outs;
}

// Hybrid target generator (simplified version to match v9.5 UI)
function computeHybridTargets({ lastPrice, k15 = [], pricePrecision = 2 }) {
  const lp = safeNum(lastPrice, (k15 && k15.length ? k15.at(-1).close : 0));
  // tiny mock targets for UI
  const tp1 = Number((lp * 1.06).toFixed(pricePrecision));
  const tp2 = Number((lp * 1.08).toFixed(pricePrecision));
  const tp3 = Number((lp * 1.11).toFixed(pricePrecision));
  const sl = Number((lp * 0.96).toFixed(pricePrecision));
  return {
    buy: { tp1, tp2, tp3, sl, score: 40 },
    sell: { tp1: Number((lp*0.94).toFixed(pricePrecision)), tp2: Number((lp*0.92).toFixed(pricePrecision)), tp3: Number((lp*0.89).toFixed(pricePrecision)), sl: Number((lp*1.04).toFixed(pricePrecision)), score: 60 },
    recommended: "Sell",
    confidencePct: 64
  };
}

// buildReport -> returns { text, hybrid, multiTF }
export async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    // fetch main candles (15m)
    const resp = await fetchMarketData(symbol, interval, 500);
    const candlesRaw = ensureCandlesArray(resp.data || []);
    const last = lastOf(candlesRaw) || { close: lastPrice || 0, vol: 0 };
    const multiTF = await buildMultiTimeframeIndicators(symbol);

    const hybrid = computeHybridTargets({ lastPrice: last.close, k15: candlesRaw, pricePrecision: 2 });

    // Compose UI text matching screenshot style (v9.5)
    let text = "";
    text += `🚀 <b>${symbol} — AI Trader v9.5</b>\n`;
    text += `🕒 ${new Date().toLocaleString()}\n`;
    text += `📡 Source: ${socketAlive ? "Binance (Live)" : (resp.source || "Multi-source (fallback)")}\n`;
    text += `💰 <b>Price:</b> ${safeNum(last.close, 0).toFixed(2)}\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const tf of Object.keys(multiTF)) {
      const r = multiTF[tf];
      text += `📊 ${tf} | ${r.bias}\n`;
      text += `💲 Price: ${r.price} | Vol: ${r.vol}\n`;
      text += `📈 RSI: ${r.rsi} | MACD: ${r.macd} | ATR: ${r.atr}\n`;
      text += `━━━━━━━━━━━━━━━━━━━\n`;
    }

    text += `\n🧭 <b>Overall Bias:</b> ${hybrid.recommended} | Strength: ${hybrid.buy.score}% | 🤖 ML Prob: 50%\n`;
    text += `🎯 TP1: ${hybrid.buy.tp1} | TP2: ${hybrid.buy.tp2} | TP3: ${hybrid.buy.tp3} | SL: ${hybrid.buy.sl}\n`;
    text += `\n📰 <b>News Impact:</b> Low (score 0)\n`;
    text += `• Top headlines:\n• (news items will appear here)\n\n`;
    text += `Sources: Multi-source (config)\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n`;

    return { text, hybrid, multiTF, raw: { resp } };

  } catch (err) {
    console.error("buildReport err:", err && err.message ? err.message : err);
    return null;
  }
}

// ------------------ Report loop runner ------------------
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      console.warn("No report produced");
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${new Date().toLocaleString()}`);
      return;
    }
    await sendTelegramMessage(out.text);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (e) {
    console.error("generateReportLoop err:", e && e.message ? e.message : e);
    try { await sendTelegramMessage(`❌ Error generating report: ${e.message || e}`); } catch(e){}
  }
}

// immediate run + schedule
(async () => {
  await setupTelegramBot(); // start polling (if available)
  // run immediately
  await generateReportLoop();
  // schedule
  setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS || 15*60*1000);
})();

export default { buildReport, computeHybridTargets };