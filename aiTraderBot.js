// aiTraderBot_v9.5_unified.js — single file version

import fs from "fs";
import path from "path";
import axios from "axios";
import express from "express";

// --- CONFIG ---
const CONFIG = {
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m","5m","15m","30m","1h"],
  SELF_PING_URL: process.env.SELF_PING_URL,
  CACHE_FILE: path.resolve("./cache/marketData.json"),
  MARKETS: {
    CRYPTO: ["BTCUSDT","ETHUSDT","BNBUSDT"],
    INDIAN: ["NIFTY","SENSEX","RELIANCE.NS"],
    METALS: ["GOLD","SILVER"]
  },
  BINANCE_SOURCES: [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com"
  ],
  FALLBACK_SOURCES: {
    YAHOO: "https://query1.finance.yahoo.com"
  },
  REPORT_INTERVAL_MS: (parseInt(process.env.REPORT_INTERVAL_MIN || "15") || 15) * 60 * 1000,
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    CHAT_ID: process.env.CHAT_ID || ""
  }
};

// --- UTILITIES ---
const nowLocal = () => new Date().toLocaleString("en-IN", { timeZone:"Asia/Kolkata" });

async function keepAlive(url = CONFIG.SELF_PING_URL) {
  if (!url) return;
  try {
    const res = await axios.get(url);
    if (res.status === 200) console.log("🌐 KeepAlive OK");
    else console.warn("⚠️ KeepAlive non-200:", res.status);
  } catch(e) {
    console.warn("KeepAlive failed:", e.message);
  }
}

function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE,"utf8"));
    }
    cache[symbol] = { ts: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache,null,2));
  } catch(e) {
    console.warn("Cache save failed:", e.message);
  }
}
function readCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE,"utf8"));
    }
  } catch(e) {}
  return {};
}

async function safeFetch(url,label,transform) {
  try {
    const res = await axios.get(url, { timeout:8000 });
    if (res.status !== 200) throw new Error("HTTP "+res.status);
    const data = transform(res.data);
    if (Array.isArray(data) && data.length>0) {
      console.log(`✅ ${label} OK (${data.length} candles)`);
      return { ok:true, data, source:label };
    }
    throw new Error("No data");
  } catch(e) {
    console.warn(`❌ ${label} failed:`, e.message);
    return { ok:false };
  }
}

// Market fetchers
async function fetchCrypto(symbol, interval="15m", limit=500) {
  for (const base of CONFIG.BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await safeFetch(url, `Binance(${new URL(base).hostname})`, raw =>
      (Array.isArray(raw) ? raw.map(k => ({
        t:Number(k[0]||0),
        open:Number(k[1]||0),
        high:Number(k[2]||0),
        low:Number(k[3]||0),
        close:Number(k[4]||0),
        vol:Number(k[5]||0),
      })) : [])
    );
    if (res.ok) return res;
    await new Promise(r=>setTimeout(r,900));
  }
  return { ok:false };
}

async function fetchIndian(symbol) {
  const url = `${CONFIG.FALLBACK_SOURCES.YAHOO}/v8/finance/chart/${symbol}?region=IN&interval=15m&range=1d`;
  return safeFetch(url,"Yahoo.IN", raw => {
    const r = raw?.chart?.result?.[0];
    if(!r) return [];
    return (r.timestamp||[]).map((t,i)=>({
      t: Number(t)*1000,
      open: Number(r.indicators.quote[0].open[i]||0),
      high: Number(r.indicators.quote[0].high[i]||0),
      low: Number(r.indicators.quote[0].low[i]||0),
      close: Number(r.indicators.quote[0].close[i]||0),
      vol: Number(r.indicators.quote[0].volume[i]||0),
    }));
  });
}

function ensureCandles(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw).flat();
  return arr.map(k => {
    if (!k) return null;
    const t = Number(k.t ?? k[0] ?? 0);
    const open = Number(k.open ?? k[1] ?? 0);
    const high = Number(k.high ?? k[2] ?? 0);
    const low = Number(k.low ?? k[3] ?? 0);
    const close = Number(k.close ?? k[4] ?? 0);
    const vol = Number(k.vol ?? k[5] ?? 0);
    return { t, open, high, low, close, vol };
  }).filter(c => c && typeof c.close === "number" && !isNaN(c.close));
}

async function fetchMarketData(symbol=CONFIG.SYMBOL, interval="15m", limit=500) {
  console.log(`⏳ Fetching data for ${symbol} (${interval})...`);
  try {
    let res = { ok:false };
    if (CONFIG.MARKETS.CRYPTO.includes(symbol)) {
      res = await fetchCrypto(symbol, interval, limit);
    } else if (CONFIG.MARKETS.INDIAN.includes(symbol)) {
      res = await fetchIndian(symbol);
    }
    if (res.ok && res.data) {
      const clean = ensureCandles(res.data);
      if (clean.length === 0) throw new Error("No valid candles");
      saveCache(symbol, clean);
      return { data: clean, source:res.source };
    }
    const cache = readCache();
    if (cache[symbol] && Array.isArray(cache[symbol].data) && cache[symbol].data.length) {
      console.log("♻️ Using cached data for", symbol);
      return { data: cache[symbol].data, source:"cache" };
    }
    throw new Error("No market data");
  } catch(e) {
    console.error("❌ fetchMarketData error:", e.message);
    return { data: [], source:"error" };
  }
}

// --- Indicators ---
function EMA(data, period) {
  if (!data || data.length < period) return [];
  const closes = data.map(d=>d.close);
  const k = 2/(period+1);
  let emaArr = [];
  let sum = closes.slice(0,period).reduce((a,b)=>a+b,0);
  let prev = sum/period;
  emaArr[period-1] = prev;
  for (let i = period; i<closes.length; i++) {
    prev = closes[i]*k + prev*(1-k);
    emaArr.push(prev);
  }
  return emaArr;
}

function calculateRSI(data, period=14) {
  if (!data || data.length < period+1) return null;
  const changes = [];
  for (let i=1; i<data.length; i++){
    const d = data[i].close - data[i-1].close;
    changes.push(d);
  }
  let gains=0, losses=0;
  for (let i=0; i<period; i++){
    if (changes[i]>=0) gains+=changes[i];
    else losses-=changes[i];
  }
  gains/=period;
  losses/=period;
  const rs = losses===0 ? 100 : gains/losses;
  const rsi = 100 - (100/(1+rs));
  return { value:Math.round(rsi*100)/100, summary: rsi>70?"Overbought":rsi<30?"Oversold":"Neutral" };
}

function calculateMACD(data, fast=12, slow=26, signal=9) {
  if (!data || data.length < slow + signal) return null;
  const emaFast = EMA(data, fast);
  const emaSlow = EMA(data, slow);
  const offset = emaSlow.length - emaFast.length;
  const macdLine = emaFast.map((v,i)=> v - (emaSlow[i+offset]||0));
  const signalLine = EMA(macdLine.map(v=>({close:v})), signal);
  const histogram = macdLine.map((v,i)=> v - (signalLine[i]||0));
  const latest = histogram[histogram.length-1];
  return {
    macd: macdLine,
    signal: signalLine,
    histogram,
    summary: latest>0?"Bullish":"Bearish"
  };
}

// --- Elliot (basic version) ---
async function analyzeElliott(data, interval="15m") {
  if (!data || data.length < 30) {
    return { ok:false, summary:"Not enough candles" };
  }
  const closes = data.map(c=>c.close);
  const last = closes[closes.length-1];
  const prev = closes[closes.length-5] || closes[0];
  const direction = last > prev ? "UP" : "DOWN";
  return { ok:true, summary:`Dir:${direction}` };
}

// --- ML Prediction (dummy) ---
function runMLPrediction(data) {
  // assume simple dummy for v9.5
  if (!data || data.length < 10) return { prob:50, label:"Neutral" };
  const last = data[data.length-1].close;
  const first = data[0].close;
  const prob = last > first ? 60 : 40;
  const label = prob>=50?"Bullish":"Bearish";
  return { prob, label };
}

// --- Signal Merge ---
function mergeSignals(indicators, ell, ml) {
  let bias="Neutral";
  let strength=0;
  if (indicators.rsi) {
    if (indicators.rsi.value <30) { bias="Buy"; strength+=20;}
    else if (indicators.rsi.value>70){ bias="Sell"; strength+=20;}
  }
  if (indicators.macd) {
    const m = indicators.macd;
    const lastdiff = (m.histogram && m.histogram.length>0)?m.histogram[m.histogram.length-1]:0;
    if (lastdiff>0) { bias= bias==="Sell"?"Neutral":"Buy"; strength+=25; }
    else if (lastdiff<0) { bias= bias==="Buy"?"Neutral":"Sell"; strength+=25; }
  }
  if (ml && ml.prob) {
    if (ml.prob>55){ bias="Buy"; strength += (ml.prob-50);}
    else if (ml.prob<45){ bias="Sell"; strength += (50-ml.prob);}
  }
  if (ell && ell.summary) {
    strength += 10; // simple add
  }
  strength = Math.round(Math.min(100, strength));
  return { bias, strength, mlProb: ml.prob||50 };
}

// --- Telegram Setup ---
import { Telegraf } from "telegraf";
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);
async function setupTelegram() {
  bot.start(ctx => ctx.reply("AI Trader Bot online"));
  await bot.launch();
}
async function sendTelegramMessage(text) {
  try {
    await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, text, { parse_mode:"HTML" });
  } catch(e) {
    console.warn("Telegram send error:", e.message);
  }
}

// --- Build Report & Loop ---
async function buildReport(symbol=CONFIG.SYMBOL, interval="15m") {
  const m = await fetchMarketData(symbol, interval, 500);
  const data = Array.isArray(m.data)?m.data: [];
  if (data.length<10) {
    console.warn("⚠️ Not enough candles for report:", data.length);
    return null;
  }

  const rsi = calculateRSI(data, 14);
  const macd = calculateMACD(data, 12,26,9);
  const ell = await analyzeElliott(data, interval);
  const ml = runMLPrediction(data);
  const merged = mergeSignals({ rsi, macd }, ell, ml);

  const last = data[data.length-1];
  const atr = data.slice(-20).reduce((acc,c,i,arr) =>{
    if (i===0) return acc;
    return acc + Math.max(c.high-c.low, Math.abs(c.high-arr[i-1].close), Math.abs(c.low-arr[i-1].close));
  },0) / Math.max(1, data.length-1);

  const SL = Math.round(last.close - (merged.bias==="Buy"?1:-1)*atr*2);
  const TP1 = Math.round(last.close + (merged.bias==="Buy"?1:-1)*atr*4);
  const TP2 = Math.round(last.close + (merged.bias==="Buy"?1:-1)*atr*6);

  let text = `🚀 <b>${symbol} — AI Trader v9.5</b>\n${nowLocal()}\nPrice: ${last.close}\n`;
  text += `Bias: ${merged.bias} | Strength: ${merged.strength}%\n`;
  text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\n`;

  await sendTelegramMessage(text);
  return true;
}

async function runLoop() {
  await setupTelegram();
  console.log("🤖 Bot started at", nowLocal());
  if (CONFIG.SELF_PING_URL) keepAlive(CONFIG.SELF_PING_URL);

  // keepalive server
  const app = express();
  app.get("/", (req,res)=> res.send("✅ AI Trader Bot running"));
  const port = process.env.PORT || 10000;
  app.listen(port,()=>console.log("Server listening on port",port));
  setInterval(()=>keepAlive(),5*60*1000);

  // report loop
  await buildReport(CONFIG.SYMBOL, "15m");
  setInterval(async ()=>{
    try { await buildReport(CONFIG.SYMBOL, "15m"); }
    catch(e){ console.error("Loop error:", e.message || e); }
  }, CONFIG.REPORT_INTERVAL_MS);
}

runLoop().catch(e=> console.error("Startup error:", e));