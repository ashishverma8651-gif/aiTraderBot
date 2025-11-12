/**
 * ai_trader_multimarket_v9_6.js
 * Multimarket AI Trader (single-file) — v9.6
 *
 * Requirements:
 *   npm i axios express dotenv
 *
 * Usage:
 *   - Create a .env file with values described below
 *   - node ai_trader_multimarket_v9_6.js
 *
 * .env keys:
 *   BOT_TOKEN=<telegram bot token>
 *   CHAT_ID=<telegram chat id to send batch reports>
 *   SYMBOL=BTCUSDT
 *   REPORT_INTERVAL_MIN=15
 *   SELF_PING_URL=<optional keepalive URL>
 *
 * Notes:
 *  - This script aims to be robust with multiple data sources.
 *  - The ML code here is intentionally lightweight; you can replace or extend via external module later.
 */

import axios from "axios";
import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();
import CONFIG from "./config.js";

/* ===========================
   Config / Constants
   =========================== */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || ""; // channel/group id or your chat id
const RAW_SYMBOL = process.env.SYMBOL || "BTCUSDT";
const REPORT_INTERVAL_MIN = parseInt(process.env.REPORT_INTERVAL_MIN || "15", 10);
const SELF_PING_URL = process.env.SELF_PING_URL || "";
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h"];
const CACHE_DIR = path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Files for persistence
const ML_FILE = path.join(CACHE_DIR, "ml_model_v96.json");
const LAST_PRED_FILE = path.join(CACHE_DIR, "last_pred_v96.json");
const ACC_FILE = path.join(CACHE_DIR, "acc_v96.json");
const REV_FILE = path.join(CACHE_DIR, "reversals_v96.json");
const CACHE_FILE = path.join(CACHE_DIR, "market_cache_v96.json");

// Multi-source endpoints (Binance mirrors + others)
const BINANCE_SOURCES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com"
];
const FALLBACK = {
  COINBASE: "https://api.exchange.coinbase.com",
  COINGECKO: "https://api.coingecko.com/api/v3",
  KUCOIN: "https://api.kucoin.com",
  YAHOO: "https://query1.finance.yahoo.com"
};
const RSS_SOURCES = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/"
];

/* ===========================
   Helpers: time, sleep, cache
   =========================== */

const nowIndia = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(file, def = null) {
  try {
    if (!fs.existsSync(file)) return def;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return def;
  }
}
function writeJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch(e) { console.warn("writeJSON err", e.message); }
}

/* ===========================
   Network-safe fetch with proxies fallback (basic)
   =========================== */

const PROXY_PREFIXES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/"
];

async function safeFetchText(url, tryProxies = true) {
  try {
    const r = await axios.get(url, { timeout: 11000, responseType: "text" });
    if (r.status === 200) return r.data;
  } catch (e) { /* continue */ }
  if (!tryProxies) throw new Error("fetch failed");
  for (const p of PROXY_PREFIXES) {
    try {
      const r = await axios.get(p + encodeURIComponent(url), { timeout: 12000, responseType: "text" });
      if (r.status === 200) return r.data;
    } catch (e) { continue; }
  }
  throw new Error("All fetch attempts failed for " + url);
}

async function safeFetchJson(url, tryProxies = true) {
  try {
    const r = await axios.get(url, { timeout: 10000 });
    if (r.status === 200) return r.data;
  } catch (e) { /* ignore */ }
  if (!tryProxies) throw new Error("fetch failed");
  for (const p of PROXY_PREFIXES) {
    try {
      const r = await axios.get(p + encodeURIComponent(url), { timeout: 12000 });
      if (r.status === 200) return r.data;
    } catch (e) { continue; }
  }
  throw new Error("All fetch attempts failed for " + url);
}

/* ===========================
   Symbol normalization
   =========================== */

function normalizeSymbols(raw) {
  const up = (raw || "BTCUSDT").toUpperCase().replace(/[-_]/g, "");
  const bin = up;
  let coinbase;
  if (bin.endsWith("USDT")) coinbase = `${bin.slice(0,-4)}-USD`;
  else if (bin.endsWith("USD")) coinbase = `${bin.slice(0,-3)}-USD`;
  else coinbase = bin.slice(0,3) + "-USD";
  let cg = "bitcoin";
  if (/^BTC/.test(bin)) cg = "bitcoin";
  else if (/^ETH/.test(bin)) cg = "ethereum";
  else cg = bin.slice(0,3).toLowerCase();
  return { bin, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(RAW_SYMBOL);
const SYMBOL = SYMBOLS.bin;

/* ===========================
   Market fetchers (multi-source)
   - fetchKlines(symbol, interval, limit)
   Returns { data: [ {t, open, high, low, close, volume}... ], source }
   =========================== */

async function fetchKlinesBinance(symbol, interval="15m", limit=500) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_SOURCES) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await axios.get(url, { timeout: 10000 });
      if (!Array.isArray(r.data)) continue;
      return { data: r.data.map(k => ({ t:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })), source: `Binance:${base}` };
    } catch (e) { continue; }
  }
  throw new Error("Binance mirrors failed");
}

async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=500) {
  // granularity mapping
  const map = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = map[interval] || 900;
  const url = `${FALLBACK.COINBASE}/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  const r = await safeFetchJson(url);
  if (!Array.isArray(r)) throw new Error("Coinbase returned non-array");
  // coinbase returns [time, low, high, open, close, volume]
  const sorted = r.slice(-limit).sort((a,b) => a[0] - b[0]);
  return { data: sorted.map(k => ({ t: k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume:+(k[5]||0) })), source: "Coinbase" };
}

async function fetchKlinesCoinGecko(cgid="bitcoin", interval="15m", limit=500) {
  // coinGecko OHLC are limited, but best-effort
  const url = `${FALLBACK.COINGECKO}/coins/${cgid}/ohlc?vs_currency=usd&days=1`;
  const r = await safeFetchJson(url);
  if (!Array.isArray(r)) throw new Error("CoinGecko invalid");
  const slice = r.slice(-limit);
  return { data: slice.map(k => ({ t:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:0 })), source: "CoinGecko" };
}

async function fetchKlinesUnified(symbolRaw, interval="15m", limit=500) {
  const { bin, coinbase, cg } = normalizeSymbols(symbolRaw);
  // Binance preferred
  try {
    const b = await fetchKlinesBinance(bin, interval, limit);
    return b;
  } catch (e) {
    // fallback to Coinbase (if product exists)
    try { const c = await fetchKlinesCoinbase(coinbase, interval, limit); return c; } catch(e2) {}
    try { const g = await fetchKlinesCoinGecko(cg, interval, limit); return g; } catch(e3) {}
  }
  return { data: [], source: "none" };
}

/* ===========================
   News & social fetch (real RSS)
   - fetchHeadlines()
   - computeNewsScore(headlines) -> -inf..+inf
   =========================== */

async function fetchHeadlines(limit=6) {
  const out = [];
  for (const url of RSS_SOURCES) {
    try {
      const txt = await safeFetchText(url);
      const items = txt.split("<item>").slice(1, limit+1);
      for (const it of items) {
        const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||"";
        const title = t.replace(/<!\[CDATA\[|\]\]>/g,"").trim();
        if (title) out.push({ title, source: url });
      }
    } catch (e) { continue; }
  }
  return out.slice(0, limit);
}
function newsScoreFromHeadlines(headlines) {
  const POS = ["bull","surge","gain","rally","soar","adopt","upgrade","support","positive","pump"];
  const NEG = ["bear","dump","selloff","crash","fear","ban","hack","lawsuit","negative","down"];
  let score=0;
  for (const h of headlines) {
    const t = (h.title||"").toLowerCase();
    for (const p of POS) if (t.includes(p)) score++;
    for (const n of NEG) if (t.includes(n)) score--;
  }
  return score;
}

/* ===========================
   Technical indicators (RSI, EMA, MACD, ATR)
   =========================== */

function calculateRSI(kl, period=14) {
  if (!kl || kl.length <= period) return null;
  const changes = [];
  for (let i=1;i<kl.length;i++) changes.push(kl[i].close - kl[i-1].close);
  let gains = 0, losses = 0;
  for (let i=0;i<period;i++) {
    const v = changes[i] || 0;
    if (v>0) gains += v; else losses -= v;
  }
  gains /= period; losses /= period;
  const rs = losses === 0 ? 100 : gains / losses;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

function emaArray(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i=1;i<values.length;i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}

function calculateMACD(kl, short=12, long=26, signal=9) {
  const closes = kl.map(k=>k.close);
  if (closes.length < long) return null;
  const emaS = emaArray(closes, short);
  const emaL = emaArray(closes, long);
  const offset = emaS.length - emaL.length;
  const macdLine = emaS.slice(offset).map((v,i)=> v - emaL[i]);
  const signalLine = emaArray(macdLine, signal);
  const hist = macdLine.at(-1) - (signalLine.at(-1) || 0);
  return { macd: macdLine.at(-1) || 0, signal: signalLine.at(-1) || 0, hist };
}

function atr(kl, period=14) {
  if (!kl || kl.length < period+1) return null;
  const trs = [];
  for (let i=1;i<kl.length;i++) {
    const cur = kl[i], prev = kl[i-1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/slice.length;
}

/* ===========================
   Candle pattern detection (Doji, Hammer, Shooting star)
   =========================== */

function detectCandlePattern(last, prev) {
  if (!last) return { isDoji:false, isHammer:false, isShooting:false, body:0, range:0 };
  const body = Math.abs(last.close - last.open);
  const range = Math.max(1e-8, last.high - last.low);
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > (prev?prev.close:last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < (prev?prev.close:last.open);
  return { isDoji, isHammer, isShooting, body, range };
}

/* ===========================
   Elliott-lite & Fib (15m)
   - find pivots, fib levels, naive structure
   =========================== */

function findSwings(kl, lookback=100) {
  const n = Math.min(kl.length, lookback);
  const highs=[], lows=[];
  for (let i=kl.length-n;i<kl.length;i++) {
    const cur = kl[i], left = kl[i-2] || cur, right = kl[i+2] || cur;
    if (cur.high >= (left.high||cur.high) && cur.high >= (right.high||cur.high)) highs.push({i,price:cur.high,t:cur.t});
    if (cur.low <= (left.low||cur.low) && cur.low <= (right.low||cur.low)) lows.push({i,price:cur.low,t:cur.t});
  }
  return {highs, lows};
}

function elliottLite(kl15) {
  if (!kl15 || kl15.length < 10) return { structure:"unknown", currentWave:"unknown", confidence:0, fibLevels:null, swings:null };
  const { highs, lows } = findSwings(kl15, 120);
  const recentHigh = Math.max(...kl15.slice(-120).map(k=>k.high));
  const recentLow = Math.min(...kl15.slice(-120).map(k=>k.low));
  const range = recentHigh - recentLow || 1;
  const fib = {
    high: recentHigh,
    low: recentLow,
    fib236: recentHigh - range*0.236,
    fib382: recentHigh - range*0.382,
    fib5: recentHigh - range*0.5,
    fib618: recentHigh - range*0.618,
    fib786: recentHigh - range*0.786
  };
  // naive structure detection
  const last = kl15.at(-1).close, prev = kl15.at(-5).close || kl15[0].close;
  const dir = last > prev ? "UP" : "DOWN";
  const confidence = Math.min(90, Math.abs((last - prev) / (prev||last)) * 1000);
  return { structure: dir==="UP" ? "impulse-like" : "corrective-like", currentWave:"auto", confidence:Math.round(confidence), fibLevels: fib, swings:{highs,lows} };
}

/* ===========================
   Targets & SL — hybrid bull/bear both-sided (uses fib & atr & elliott)
   =========================== */

function computeTargets(lastPrice, kl15) {
  const ell = elliottLite(kl15);
  const HH = ell.fibLevels?.high ?? Math.max(...kl15.map(k=>k.high));
  const LL = ell.fibLevels?.low ?? Math.min(...kl15.map(k=>k.low));
  const range = Math.max(1, HH - LL);
  // Bullish: use fib extension from last swing low -> high
  const bullTP1 = +(lastPrice + range*0.236).toFixed(2);
  const bullTP2 = +(lastPrice + range*0.382).toFixed(2);
  const bullTP3 = +(lastPrice + range*0.618).toFixed(2);
  const bullSL  = +(lastPrice - range*0.5).toFixed(2);
  // Bearish
  const bearTP1 = +(lastPrice - range*0.236).toFixed(2);
  const bearTP2 = +(lastPrice - range*0.382).toFixed(2);
  const bearTP3 = +(lastPrice - range*0.618).toFixed(2);
  const bearSL  = +(lastPrice + range*0.5).toFixed(2);

  return { bull:{tp1:bullTP1,tp2:bullTP2,tp3:bullTP3,sl:bullSL}, bear:{tp1:bearTP1,tp2:bearTP2,tp3:bearTP3,sl:bearSL}, HH, LL, ell };
}

/* ===========================
   Simple online ML (lightweight) — logistic-like with local persistence
   - designed to be replaceable by an external file later (ml_module.js)
   =========================== */

let ML = readJSON(ML_FILE, { w: null, bias: 0, n_features: 0, lr: 0.02, trained:0 });
function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = Array.from({length:n}, ()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    writeJSON(ML_FILE, ML);
  }
}
function sigmoid(x){ return 1/(1+Math.exp(-x)); }
function mlPredictArray(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  let z = ML.bias;
  for (let i=0;i<features.length;i++) z += (ML.w[i]||0) * (features[i]||0);
  return sigmoid(z);
}
function mlTrain(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const p = mlPredictArray(features);
  const err = label - p;
  const lr = ML.lr || 0.02;
  for (let i=0;i<features.length;i++) ML.w[i] += lr * (err * features[i] - 1e-4 * (ML.w[i]||0));
  ML.bias += lr * err;
  ML.trained = (ML.trained || 0) + 1;
  if (ML.trained % 10 === 0) writeJSON(ML_FILE, ML);
  return p;
}
function mlExtractFeatures({ kl15, last, avgVol20 }) {
  const first = kl15 && kl15[0] ? kl15[0] : last;
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePattern(last, kl15[kl15.length-2]);
  const rsi15 = calculateRSI(kl15,14) || 50;
  const macd15 = calculateMACD(kl15) || { hist:0 };
  return [slope15, lastDeltaP, volRatio-1, patt.isDoji?1:0, patt.isHammer?1:0, patt.isShooting?1:0, (rsi15-50)/50, (macd15.hist||0)/(last.close||1)];
}

/* ===========================
   Accuracy tracking & reversal pending queue
   =========================== */

function pushAcc(correct) {
  try {
    const arr = readJSON(ACC_FILE, []);
    arr.push(correct?1:0);
    while (arr.length > 200) arr.shift();
    writeJSON(ACC_FILE, arr);
  } catch(e){ }
}
function getAcc(lastN=10) {
  const arr = readJSON(ACC_FILE, []);
  if (!arr.length) return "N/A";
  const s = arr.slice(-lastN).reduce((a,b)=>a+b,0);
  return ((s / Math.min(lastN, arr.length)) * 100).toFixed(1);
}
let pendingRevs = readJSON(REV_FILE, []);
function savePendingRevs(){ writeJSON(REV_FILE, pendingRevs); }

/* ===========================
   Telegram helpers & commands (polling)
   =========================== */

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
let tgOffset = 0;

async function sendTelegram(text, options={}) {
  if (!TG_API) { console.log("[TG disabled] ->", text); return; }
  const parts = [];
  const chunkSize = 3800;
  for (let i=0;i<text.length;i+=chunkSize) parts.push(text.slice(i,i+chunkSize));
  for (const p of parts) {
    try {
      await axios.post(`${TG_API}/sendMessage`, {
        chat_id: options.chat_id || CHAT_ID,
        text: p,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }, { timeout: 10000 });
      await sleep(200);
    } catch (e) {
      console.warn("sendTelegram err", e && e.message ? e.message : e);
    }
  }
}

async function handleUpdates() {
  if (!TG_API) return;
  try {
    const res = await axios.get(`${TG_API}/getUpdates?offset=${tgOffset+1}&timeout=2`, { timeout: 15000 });
    if (!res.data || !res.data.ok) return;
    for (const u of res.data.result) {
      tgOffset = Math.max(tgOffset, u.update_id);
      try { await processUpdate(u); } catch(e){ console.warn("processUpdate err", e.message); }
    }
  } catch (e) { /* polling can fail occasionally */ }
}

async function processUpdate(update) {
  const msg = update.message || update.edited_message || update.callback_query && update.callback_query.message;
  if (!msg || !msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const who = msg.from && (msg.from.username || msg.from.first_name);
  console.log("TG msg", who, text);
  const parts = text.split(" ");
  const cmd = parts[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    const help = `🤖 AI Trader Bot commands:\n/status - latest summary\n/predict - immediate analysis\n/setthreshold <0-1> - set ml alert threshold\n/symbol <SYMBOL> - set symbol for ad-hoc prediction\n/help - this message`;
    await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: help });
    return;
  }
  if (cmd === "/status") {
    const acc = getAcc(10);
    const payload = `🟢 Bot Status\nSymbol: ${SYMBOL}\nReport every ${REPORT_INTERVAL_MIN} min\nAccuracy(last10): ${acc}%\nML trained steps: ${ML.trained||0}`;
    await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: payload });
    return;
  }
  if (cmd === "/predict" || cmd === "/analyse" || cmd === "/analyze") {
    const symbol = parts[1] ? parts[1].toUpperCase() : SYMBOL;
    const out = await buildAndFormatReport(symbol, "15m", true);
    if (out && out.text) await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: out.text, parse_mode:"HTML" });
    return;
  }
  if (cmd === "/setthreshold") {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v>=0 && v<=1) {
      ML.threshold = v;
      writeJSON(ML_FILE, ML);
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `ML threshold set to ${v}` });
    } else {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Usage: /setthreshold 0.7 (0..1)` });
    }
    return;
  }
  if (cmd === "/symbol") {
    const sym = parts[1] ? parts[1].toUpperCase() : null;
    if (sym) {
      // Just respond; main run uses env SYMBOL static. User can change .env and restart.
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Symbol ${sym} acknowledged. Use in /predict.` });
    }
    return;
  }
}

/* ===========================
   Reversal watcher (1m) - sends immediate alert with ML prob
   =========================== */

let lastRevAt = 0;
const REV_COOLDOWN_MS = 90*1000;

async function reversalWatcherOnce(symbol=SYMBOL) {
  try {
    const result = await fetchKlinesUnified(symbol, "1m", 120);
    if (!result.data || result.data.length < 4) return;
    const kl1 = result.data;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = kl1.slice(-20).reduce((a,b)=>a+(b.volume||0),0)/Math.min(20,kl1.length) || 1;
    const patt = detectCandlePattern(last, prev);
    const volSpike = last.volume > avgVol * 1.5;
    const now = Date.now();
    if (now - lastRevAt < REV_COOLDOWN_MS) return;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (!reason) return;
    lastRevAt = now;
    const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
    const avgVol20 = avgVol;
    const features = mlExtractFeatures({ kl15: kl1.slice(-40), last, avgVol20 });
    const prob = mlPredictArray(features);
    const msg = `🚨 <b>Reversal Watcher</b>\n${nowIndia()}\nSymbol: <b>${symbol}</b>\nPattern: <b>${reason}</b>\nDirection: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgVol)})\nML Prob: ${(prob*100).toFixed(1)}%`;
    await sendTelegram(msg);
    // remember event for later evaluation
    pendingRevs.push({ time: now, symbol, reason, dir, prob, price: last.close, features });
    savePendingRevs();
    // soft immediate training for high confidence
    if (prob > 0.95) mlTrain(features, 1);
    if (prob < 0.05) mlTrain(features, 0);
  } catch (e) { console.warn("reversalWatcher err", e.message); }
}

/* ===========================
   Check pending reversals after waiting window to auto-evaluate & train
   =========================== */

async function evaluatePendingReversals() {
  if (!pendingRevs.length) return;
  const now = Date.now();
  const keep = [];
  for (const ev of pendingRevs) {
    // wait ~ 8 minutes before evaluating
    if (now - ev.time < 8*60*1000) { keep.push(ev); continue; }
    try {
      const resp = await fetchKlinesUnified(ev.symbol, "1m", 200);
      if (!resp.data || !resp.data.length) { keep.push(ev); continue; }
      const startPrice = ev.price;
      const max = Math.max(...resp.data.map(k=>k.high));
      const min = Math.min(...resp.data.map(k=>k.low));
      let success = false;
      if (ev.dir === "Bullish" && max >= startPrice * 1.004) success = true;
      if (ev.dir === "Bearish" && min <= startPrice * 0.996) success = true;
      // train on result
      try { mlTrain(ev.features, success?1:0); } catch(e){}
      pushAcc(success?1:0);
    } catch (e) { keep.push(ev); }
  }
  pendingRevs = keep;
  savePendingRevs();
}

/* ===========================
   Build report (core function)
   - symbol (string), timeframe primary (15m)
   - returns { text, summary }
   =========================== */

async function buildAndFormatReport(symbol=SYMBOL, primaryTf="15m", forCommand=false) {
  try {
    // fetch multi-TF data in parallel
    const dataMap = {};
    for (const tf of TIMEFRAMES) {
      try {
        const r = await fetchKlinesUnified(symbol, tf, tf==="1m" ? 200 : 200);
        dataMap[tf] = r.data || [];
        await sleep(300);
      } catch (e) { dataMap[tf] = []; }
    }
    const base = dataMap[primaryTf] || [];
    if (!base || base.length < 8) {
      const txt = `❗ Not enough ${primaryTf} candles for ${symbol} (${(base||[]).length}) — ${nowIndia()}`;
      return { text: txt, summary: null };
    }

    // technicals on primary
    const last = base.at(-1);
    const avgVol20 = base.slice(-20).reduce((a,b)=>a+(b.volume||0),0)/Math.min(20,base.length)||1;
    const rsi15 = calculateRSI(base,14) || 50;
    const macd15 = calculateMACD(base) || { macd:0, signal:0, hist:0 };
    const atr15 = atr(base,14) || 0;

    // per-TF divergence / quick summary
    let bullCount=0, bearCount=0, totalStrength=0;
    let perTfLines = "";
    for (const tf of TIMEFRAMES) {
      const kl = dataMap[tf] || [];
      const mac = kl.length>10 ? calculateMACD(kl) : null;
      const rsi = kl.length>14 ? calculateRSI(kl,14) : null;
      const summary = (mac && mac.hist>0) || (rsi && rsi>55) ? "Bullish" : (mac && mac.hist<0) || (rsi && rsi<45) ? "Bearish" : "Neutral";
      if (summary==="Bullish") bullCount++;
      if (summary==="Bearish") bearCount++;
      perTfLines += `\n⏱ ${tf} | ${summary} | RSI:${Math.round(rsi||50)} | MACD:${(mac?mac.hist.toFixed(2):"0.00")}`;
    }

    // elliott + fib target
    const ell = elliottLite(base);
    const targs = computeTargets(last.close, base);

    // news & sentiment
    const headlines = await fetchHeadlines(6);
    const newsScore = newsScoreFromHeadlines(headlines);
    let newsImpact = "Low";
    if (Math.abs(newsScore) >= 3) newsImpact = "High";
    else if (Math.abs(newsScore) >=1) newsImpact = "Medium";

    // ML features & prob
    const features = mlExtractFeatures({ kl15: base.slice(-40), last, avgVol20 });
    const mlProb = mlPredictArray(features);
    const mlPct = +(mlProb*100).toFixed(1);

    // compute combined bias (simple weights)
    const techNorm = Math.max(-1,Math.min(1,( (bullCount - bearCount) / TIMEFRAMES.length )));
    const newsNorm = Math.max(-1,Math.min(1, newsScore / 6 ));
    const mlNorm = Math.max(-1,Math.min(1, mlProb*2 - 1 ));
    const combined = 0.55 * techNorm + 0.30 * newsNorm + 0.15 * mlNorm;
    const label = combined > 0.12 ? "Bullish" : combined < -0.12 ? "Bearish" : "Neutral";
    const confidence = Math.round(Math.min(99, Math.abs(combined) * 100));

    // record last prediction for training
    try {
      writeJSON(LAST_PRED_FILE, { pred: label, prevClose: last.close, kl15: base.slice(-40), ts: Date.now(), features });
    } catch(e){}

    // accuracy
    const acc10 = getAcc(10);

    // Build message
    let msg = `<b>🤖 AI Trader — Multimarket v9.6</b>\n🕒 ${nowIndia()}\nSymbol: <b>${symbol}</b>\nPrimary TF: ${primaryTf} | Source: Multi\n\n`;
    msg += `<b>Overall Bias:</b> ${label} | Confidence: ${confidence}% | ML:${mlPct}% | Acc(last10): ${acc10}%\n`;
    msg += `Price: ${last.close} | ATR(14): ${+(atr15||0).toFixed(4)} | RSI(15): ${Math.round(rsi15)}\n\n`;
    msg += `<b>Targets (both-sided):</b>\n<b>Bullish TP:</b> ${targs.bull.tp1} | ${targs.bull.tp2} | ${targs.bull.tp3} | SL: ${targs.bull.sl}\n`;
    msg += `<b>Bearish TP:</b> ${targs.bear.tp1} | ${targs.bear.tp2} | ${targs.bear.tp3} | SL: ${targs.bear.sl}\n`;
    msg += `Breakout zone est: ${targs.LL.toFixed(2)} - ${targs.HH.toFixed(2)}\n\n`;
    msg += `<b>Elliott (15m):</b> ${ell.structure} | Confidence: ${ell.confidence}%\n\n`;
    msg += `📰 News Impact: ${newsImpact} (score ${newsScore})\n`;
    if (headlines && headlines.length) { msg += `Headlines:\n• ${headlines.map(h=>h.title).join("\n• ")}\n\n`; }

    msg += `<b>Per-TF quick:</b>\n${perTfLines}\n\n`;
    msg += `🔁 ML features: [${features.map(f=>f.toFixed?f.toFixed(3):f).slice(0,6).join(", ")}] | ML prob ${mlPct}%\n`;

    return { text: msg, summary: { label, confidence, mlPct, targs, ell } };

  } catch (e) {
    return { text: `❌ Error building report: ${e.message}`, summary: null };
  }
}

/* ===========================
   Main loops & startup
   =========================== */

async function periodicTasks() {
  // schedule: reversal watcher every REV_CHECK_INTERVAL (~every 60s) and pending evaluate every 3 min
  setInterval(() => reversalWatcherOnce(SYMBOL).catch(e=>{}), 60*1000);
  setInterval(() => evaluatePendingReversals().catch(e=>{}), 3*60*1000);
  // Telegram polling every 2s
  setInterval(() => handleUpdates().catch(e=>{}), 2000);

  // main report loop
  async function sendReport() {
    const out = await buildAndFormatReport(SYMBOL, "15m");
    await sendTelegram(out.text);
  }
  // initial send
  await sendReport();
  // repeat every REPORT_INTERVAL_MIN
  setInterval(async () => {
    try { await sendReport(); } catch(e){ console.warn("main report err", e.message); }
  }, Math.max(1, REPORT_INTERVAL_MIN) * 60 * 1000);
}

/* ===========================
   Keep-alive Express server
   =========================== */

const app = express();
app.get("/", (req,res) => res.send("AI Trader Multimarket v9.6 running"));
app.listen(PORT, () => {
  console.log(`Keep-alive server listening on port ${PORT}`);
});

/* ===========================
   Start
   =========================== */

(async function main(){
  console.log("Starting AI Trader Multimarket v9.6 —", nowIndia());
  if (SELF_PING_URL) {
    // try self ping once and schedule periodic ping every 4 minutes
    try { await axios.get(SELF_PING_URL); console.log("Self-ping OK"); } catch(e){ console.warn("Self-ping failed:", e.message); }
    setInterval(()=>{ if (SELF_PING_URL) axios.get(SELF_PING_URL).catch(e=>console.warn("selfPing err", e.message)); }, 4*60*1000);
  }
  // load ml file into ML variable
  ML = readJSON(ML_FILE, ML);
  // start periodic tasks
  periodicTasks().catch(e=>console.error("periodicTasks failed", e.message));
})();