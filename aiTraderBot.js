/**
 * aiTraderBot_v9_2.js
 * v9.2 Extended single-file
 *
 * Required env:
 * BOT_TOKEN, CHAT_ID (developer/admin chat id for summaries),
 * SYMBOL (e.g. BTCUSDT),
 * CHECK_INTERVAL_MIN (default 15),
 * REV_CHECK_INTERVAL_SEC (default 60),
 * ML_ALERT_THRESH (0-1, default 0.7),
 * PORT (optional),
 * RENDER_EXTERNAL_URL (optional, used for self-ping)
 *
 * Install:
 *   npm install axios express dotenv telegraf
 *
 * Start:
 *   BOT_TOKEN=xxx CHAT_ID=yyy node aiTraderBot_v9_2.js
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const { Telegraf } = require("telegraf");
require("dotenv").config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || ""; // admin / channel id
const SYMBOL_RAW = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);

// endpoints / proxies
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://api-gateway.binance.com", // some mirrors
  "https://data-api.binance.vision",
  "https://api.binance.us" // sometimes
];
const PROXY_PREFIXES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// FILES
const ML_FILE = path.join(__dirname, "ml_model_v92.json");
const ACC_FILE = path.join(__dirname, "acc_v92.json");
const REV_FILE = path.join(__dirname, "reversal_events_v92.json");
const LAST_PRED_FILE = path.join(__dirname, "last_pred_v92.json");

// ---------- UTIL ----------
function nowISO() { return new Date().toISOString(); }
function nowIndia() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }); }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function safeJSONread(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")) : null; } catch(e){ return null; } }
function safeJSONwrite(file, obj) { try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch(e){ console.warn("write fail", file, e.message); } }
function chunkText(s, n=3500) { const out=[]; for(let i=0;i<s.length;i+=n) out.push(s.slice(i,i+n)); return out; }

// ---------- SYMBOL NORMALIZE ----------
function normalizeSymbols(raw) {
  const up = (raw||"BTCUSDT").toUpperCase().replace(/[-_]/g,"");
  let coinbase;
  if (up.endsWith("USDT")) {
    const base = up.slice(0,-4);
    coinbase = `${base}-USD`;
  } else if (up.endsWith("USD")) {
    const base = up.slice(0,-3);
    coinbase = `${base}-USD`;
  } else {
    coinbase = up.replace(/(.{3})(.*)/,"$1-$2") + "-USD";
  }
  let cg = "bitcoin";
  if (/^BTC/.test(up)) cg = "bitcoin";
  else if (/^ETH/.test(up)) cg = "ethereum";
  else cg = up.slice(0,3).toLowerCase();
  return { bin: up, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(SYMBOL_RAW);
const SYMBOL = SYMBOLS.bin;

// ---------- ML simple online logistic ----------
let ML = { w: null, bias:0, n:0, lr:0.02, l2:0.0001, trained:0, threshold: ML_ALERT_THRESH };
function mlLoad() {
  const j = safeJSONread(ML_FILE);
  if (j) Object.assign(ML, j);
}
function mlSave() { safeJSONwrite(ML_FILE, ML); }
function mlInit(n) {
  if (!ML.w || ML.n !== n) {
    ML.n = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave();
  }
}
function sigmoid(z) { return 1/(1+Math.exp(-z)); }
function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  let z = ML.bias;
  for (let i=0;i<features.length;i++) z += (ML.w[i]||0) * (features[i]||0);
  return sigmoid(z);
}
function mlTrainOnline(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const p = mlPredict(features);
  const err = label - p;
  for (let i=0;i<features.length;i++){
    ML.w[i] += ML.lr * (err * features[i] - ML.l2 * (ML.w[i]||0));
  }
  ML.bias += ML.lr * err;
  ML.trained += 1;
  if (ML.trained % 10 === 0) mlSave();
  return p;
}

// accuracy store
function pushAcc(v) {
  let arr = safeJSONread(ACC_FILE) || [];
  arr.push(v?1:0);
  while (arr.length > 200) arr.shift();
  safeJSONwrite(ACC_FILE, arr);
}
function getAcc(n=10) {
  const arr = safeJSONread(ACC_FILE) || [];
  if (!arr.length) return "N/A";
  const slice = arr.slice(-n);
  const sum = slice.reduce((a,b)=>a+b,0);
  return ((sum / slice.length) * 100).toFixed(1) + "%";
}

// ---------- DATA FETCHERS (multi-source) ----------

async function safeFetchText(url, timeout=12000) {
  try {
    const r = await axios.get(url, { timeout, responseType: "text" });
    return r.data;
  } catch(e) {}
  for (const prefix of PROXY_PREFIXES) {
    try {
      const r = await axios.get(prefix + encodeURIComponent(url), { timeout, responseType: "text" });
      return r.data;
    } catch(e) {}
  }
  throw new Error("all proxies failed for " + url);
}

async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await axios.get(url, { timeout: 10000 });
      if (!Array.isArray(r.data)) throw new Error("no array");
      return { data: r.data.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })), source: "Binance" };
    } catch(e) {
      // console.warn("binance failed:", base, e.message);
      continue;
    }
  }
  throw new Error("binance all failed");
}

async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=80) {
  const granMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  try {
    const r = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(r.data)) throw new Error("coinbase no array");
    const sorted = r.data.slice(0,limit).sort((a,b)=>a[0]-b[0]);
    return { data: sorted.map(k => ({ time:k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume:+(k[5]||0) })), source: "Coinbase" };
  } catch(e) { throw new Error("coinbase failed: " + e.message); }
}

async function fetchKlinesCoinGecko(cgid="bitcoin", interval="15m", limit=80) {
  try {
    // Coingecko OHLC endpoint returns daily slices; we fallback to market_chart for price history
    const url = `https://api.coingecko.com/api/v3/coins/${cgid}/market_chart?vs_currency=usd&days=1&interval=hourly`;
    const r = await axios.get(url, { timeout: 10000 });
    if (!r.data || !r.data.prices) throw new Error("coingecko invalid");
    const prices = r.data.prices; // [timestamp, price]
    // fabricate OHLC by using prices (simple)
    const arr = prices.slice(-limit).map(p => ({ time: p[0], open: p[1], high: p[1], low: p[1], close: p[1], volume: 0 }));
    return { data: arr, source: "CoinGecko" };
  } catch(e){ throw new Error("coingecko failed: " + e.message); }
}

async function fetchKlines(symbol, interval="15m", limit=80) {
  const { bin, coinbase, cg } = SYMBOLS;
  try { return await fetchKlinesBinance(bin, interval, limit); } catch(e){ /*fallback*/ }
  try { return await fetchKlinesCoinbase(coinbase, interval, limit); } catch(e){ /*fallback*/ }
  try { return await fetchKlinesCoinGecko(cg, interval, limit); } catch(e){ /*fallback*/ }
  return { data: [], source: "None" };
}

// ---------- TECHNICAL INDICATORS ----------
function emaArray(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2/(period+1);
  const out = [values[0]];
  for (let i=1;i<values.length;i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}
function calcMACD(kl, short=12, long=26, signal=9) {
  const closes = kl.map(k=>k.close);
  if (closes.length < long) return { macd:0, signal:0, hist:0 };
  const emaS = emaArray(closes, short);
  const emaL = emaArray(closes, long);
  const offset = emaS.length - emaL.length;
  const macdLine = emaS.slice(offset).map((v,i)=>v - emaL[i]);
  const signalLine = emaArray(macdLine, signal);
  const hist = (macdLine.at(-1)||0) - (signalLine.at(-1)||0);
  return { macd: macdLine.at(-1)||0, signal: signalLine.at(-1)||0, hist };
}
function calcRSI(kl, period=14) {
  const closes = kl.map(k=>k.close);
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i=1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    if (d>0) gains += d; else losses -= d;
  }
  const avgG = gains / (closes.length-1);
  const avgL = (losses || 0.000001) / (closes.length-1);
  const rs = avgG / avgL;
  return 100 - (100/(1+rs));
}
function atr(kl, period=14) {
  if (!kl || kl.length <= period) return null;
  const trs = [];
  for (let i=1;i<kl.length;i++){
    const cur = kl[i], prev = kl[i-1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((a,b)=>a+b,0);
  return sum / slice.length;
}
function calcFib(kl) {
  if (!kl || !kl.length) return null;
  const highs = kl.map(k=>k.high), lows = kl.map(k=>k.low);
  const H = Math.max(...highs), L = Math.min(...lows), R = H-L || 1;
  return { high:H, low:L, f382: H - R*0.382, f5: H - R*0.5, f618: H - R*0.618 };
}

// ---------- Candle patterns ----------
function detectCandlePatternSingle(last, prev) {
  if (!last) return {};
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close >= (prev ? prev.close : last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close <= (prev ? prev.close : last.open);
  return { isDoji, isHammer, isShooting, body, range };
}

// ---------- Feature extraction ----------
function avgVolume(kl, n=20) {
  if (!kl || !kl.length) return 1;
  const slice = kl.slice(-n);
  const sum = slice.reduce((a,b)=>a + (b.volume||0), 0);
  return sum / slice.length;
}
function mlExtractFeatures({ klines15, lastCandle, avgVol20=1, divergenceSign=0, ellConf=0, systemBias=0 }) {
  const first = (klines15 && klines15[0]) || lastCandle;
  const last = lastCandle || (klines15 && klines15.at(-1));
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePatternSingle(last, klines15 && klines15.at(-2));
  const rsi = calcRSI(klines15 || [last], 14);
  const mac = calcMACD(klines15 || [last], 12, 26, 9);
  const features = [
    slope15,
    lastDeltaP,
    volRatio - 1,
    patt.isDoji?1:0,
    patt.isHammer?1:0,
    patt.isShooting?1:0,
    divergenceSign || 0,
    (ellConf||0)/100,
    systemBias || 0,
    (rsi - 50) / 50,
    mac.hist / (Math.abs(last.close) || 1)
  ];
  return features;
}

// ---------- Merge Signals (tech + news + social) ----------
function mergeSignals(techBuyPct, newsCount, redditScore, tweetScore, econCount) {
  const techNorm = Math.max(-1, Math.min(1, (techBuyPct - 50) / 50)); // [-1,1]
  const newsNorm = Math.max(-1, Math.min(1, (newsCount - 3) / 3));
  const socialNorm = Math.max(-1, Math.min(1, (redditScore/20 + tweetScore/20)/2));
  const econBoost = Math.min(1, econCount / 3) * 0.05;
  const combined = 0.6*techNorm + 0.3*newsNorm + 0.1*socialNorm + econBoost;
  const label = combined > 0.12 ? "Bullish" : combined < -0.12 ? "Bearish" : "Neutral";
  return { combined, label, strength: Math.abs(combined) };
}

// ---------- Reversal watcher and pending auto-eval ----------
let pendingReversals = safeJSONread(REV_FILE) || [];
function savePending() { safeJSONwrite(REV_FILE, pendingReversals.slice(-200)); }

async function reversalWatcherOnce() {
  try {
    const res = await fetchKlines(SYMBOL, "1m", 120);
    const kl = res.data;
    if (!kl || kl.length < 3) return null;
    const last = kl.at(-1), prev = kl.at(-2);
    const avgVol = avgVolume(kl, 20) || 1;
    const patt = detectCandlePatternSingle(last, prev);
    const volSpike = last.volume > avgVol * 1.5;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (!reason) return null;
    const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
    const feat = mlExtractFeatures({ klines15: kl.slice(-40), lastCandle: last, avgVol20: avgVol });
    const prob = mlPredict(feat);
    const msg = `🚨 <b>Reversal Watcher (v9.2)</b>\n${nowIndia()}\nSymbol: <b>${SYMBOL}</b>\nSource: ${res.source}\nPattern: <b>${reason}</b>\nDirection: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgVol)})\nML Prob: ${(prob*100).toFixed(1)}%`;
    await sendTelegram(msg);
    pendingReversals.push({ time: Date.now(), reason, dir, prob, price: last.close, feat });
    savePending();
    // soft immediate training when very confident
    if (prob > 0.95) mlTrainOnline(feat, 1);
    if (prob < 0.05) mlTrainOnline(feat, 0);
    return true;
  } catch(e) {
    console.warn("rev watch err", e.message);
    return null;
  }
}

async function evaluatePending() {
  if (!pendingReversals.length) return;
  const now = Date.now();
  const keep = [];
  for (const ev of pendingReversals) {
    if (now - ev.time < 8*60*1000) { keep.push(ev); continue; } // wait 8 min
    try {
      const { data } = await fetchKlines(SYMBOL, "1m", 240);
      if (!data || !data.length) { keep.push(ev); continue; }
      const startPrice = ev.price;
      const periodLow = Math.min(...data.map(k=>k.low));
      const periodHigh = Math.max(...data.map(k=>k.high));
      let success = false;
      if (ev.dir === "Bullish" && periodHigh >= startPrice * 1.004) success = true;
      if (ev.dir === "Bearish" && periodLow <= startPrice * 0.996) success = true;
      // train
      mlTrainOnline(ev.feat, success ? 1 : 0);
      pushAcc(success?1:0);
      // notify
      await sendTelegram(`<b>Pending reversal evaluated</b>\n${nowIndia()}\nPattern: ${ev.reason}\nStartPrice: ${startPrice}\nResult: ${success? "Success":"Fail"}`);
    } catch(e) {
      keep.push(ev);
    }
  }
  pendingReversals = keep;
  savePending();
}

// ---------- ANALYSIS (15m main report) ----------
async function analyzeOnce() {
  try {
    const { data: kl15, source } = await fetchKlines(SYMBOL, "15m", 120);
    if (!kl15 || kl15.length < 10) {
      await sendTelegram(`<b>Analysis failed</b>\nInsufficient klines from sources.`);
      return;
    }
    const last = kl15.at(-1);
    const avgVol20 = avgVolume(kl15, 20);
    const rsi = calcRSI(kl15, 14);
    const mac = calcMACD(kl15, 12, 26, 9);
    const atrVal = atr(kl15, 14) || 0;
    const fib = calcFib(kl15);
    // simple buy/sell tech vol (count of last 10 candles)
    const buys = kl15.slice(-10).filter(k=>k.close > k.open).length;
    const sells = 10 - buys;
    const techBuyPct = (buys/10)*100;
    // features & predict
    const feat = mlExtractFeatures({ klines15: kl15, lastCandle: last, avgVol20 });
    const prob = mlPredict(feat);
    safeJSONwrite(LAST_PRED_FILE, { time: Date.now(), prob, feat });
    // create targets (simple ATR-based)
    const tp1 = +(last.close + atrVal*1).toFixed(2);
    const tp2 = +(last.close + atrVal*2).toFixed(2);
    const tp3 = +(last.close + atrVal*3).toFixed(2);
    const sl = +(last.close - atrVal*1.5).toFixed(2);
    // news/social quick fetch (non-blocking)
    const news = await tryFetchHeadlines(); // returns array
    const reddit = await tryFetchReddit();
    const tweet = await tryFetchNitter();
    const merged = mergeSignals(techBuyPct, news.length, reddit.length, tweet.length, 0);
    const bias = merged.label;
    // Push summary
    const msg = [
      `🤖 ${SYMBOL} — AI Trader v9.2`,
      `${nowIndia()}`,
      `Source: ${source}`,
      `Price: ${last.close}`,
      `Tech Vol: Buy ${techBuyPct.toFixed(1)}% / Sell ${(100-techBuyPct).toFixed(1)}%`,
      `RSI(14): ${rsi.toFixed(1)} | MACD hist: ${mac.hist.toFixed(3)} | ATR(14): ${atrVal?atrVal.toFixed(2):"N/A"}`,
      `Bias: <b>${bias}</b> | ML Prob: <b>${(prob*100).toFixed(1)}%</b> | Accuracy(last10): ${getAcc(10)}`,
      `TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}`,
      `Breakout zone (low-high): ${fib ? fib.low.toFixed(2) + " - " + fib.high.toFixed(2) : "N/A"}`,
      `News headlines: ${news.slice(0,3).map(n=>"\n• "+n.title).join("")}`
    ].join("\n");
    await sendTelegram(msg);
    // soft train: when label is extreme and prob aligns, train
    if ((prob > 0.9 && bias === "Bullish") || (prob < 0.1 && bias === "Bearish")) {
      mlTrainOnline(feat, bias==="Bullish"?1:0);
      pushAcc(1);
    } else {
      pushAcc(0);
    }
  } catch(e) {
    console.warn("analyzeOnce err", e.message);
    await sendTelegram(`<b>Analysis Error</b>\n${e.message}`);
  }
}

// ---------- News / Social fetchers ----------
async function tryFetchHeadlines() {
  const out = [];
  try {
    const ct = await safeFetchText("https://cointelegraph.com/rss");
    const items = ct.split("<item>").slice(1,6);
    for (const it of items) {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1];
      if (t) out.push({ title: t.replace(/<!\[CDATA\[|\]\]>/g,"").trim() });
    }
  } catch(e){}
  try {
    const cd = await safeFetchText("https://www.coindesk.com/arc/outboundfeeds/rss/");
    const items = cd.split("<item>").slice(1,6);
    for (const it of items) {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1];
      if (t) out.push({ title: t.replace(/<!\[CDATA\[|\]\]>/g,"").trim() });
    }
  } catch(e){}
  return out.slice(0,8);
}
async function tryFetchReddit(limit=8) {
  try {
    const r = await axios.get(`https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`, { timeout: 8000 });
    if (!r.data || !r.data.data) return [];
    return (r.data.data.children || []).map(c=>({ title: c.data.title, ups: c.data.ups }));
  } catch(e){ return []; }
}
async function tryFetchNitter(q="bitcoin") {
  try {
    const html = await safeFetchText(`https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`);
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    if (!matches.length) return [];
    return matches.slice(0,8).map(m => m[1].replace(/<[^>]+>/g,"").trim());
  } catch(e){ return []; }
}

// ---------- TELEGRAM (Telegraf) ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start((ctx) => ctx.reply("AI Trader v9.2 ready. Use /status or /predict."));
  bot.help((ctx) => ctx.reply("/status\n/predict\n/setthreshold <0-1>\n/autoon\n/autooff"));
  bot.command("status", async (ctx) => {
    const acc = getAcc(10);
    const last = safeJSONread(LAST_PRED_FILE) || {};
    await ctx.replyWithHTML(`<b>AI Trader Status (v9.2)</b>\n${nowIndia()}\nSymbol: ${SYMBOL}\nML Prob (last): ${last.prob? (last.prob*100).toFixed(1)+"%": "N/A"}\nAccuracy(last10): ${acc}\nPending reversals: ${pendingReversals.length}`);
  });
  bot.command("predict", async (ctx) => {
    await ctx.reply("Running immediate analysis...");
    await analyzeOnce();
    await ctx.reply("Analysis sent to admin channel.");
  });
  bot.command("setthreshold", async (ctx) => {
    const txt = ctx.message.text || "";
    const parts = txt.split(" ");
    if (parts.length < 2) return ctx.reply("Usage: /setthreshold 0.7");
    const v = parseFloat(parts[1]);
    if (isNaN(v) || v < 0 || v > 1) return ctx.reply("Provide 0..1");
    ML.threshold = v;
    mlSave();
    return ctx.reply(`ML alert threshold set to ${v}`);
  });
  // auto report toggle stored in memory
  let autoReporting = true;
  bot.command("autoon", async (ctx)=> { autoReporting = true; ctx.reply("Auto reports enabled"); });
  bot.command("autooff", async (ctx)=> { autoReporting = false; ctx.reply("Auto reports disabled"); });
  bot.launch().then(()=> console.log("TG bot started")).catch(e=>console.warn("TG start fail", e.message));
} else {
  console.log("BOT_TOKEN not provided — Telegram features disabled. Use env BOT_TOKEN.");
}

// send to admin chat (fallback to console)
async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM:", message);
    return;
  }
  try {
    const parts = chunkText(message);
    for (const p of parts) {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID, parse_mode: "HTML", text: p, disable_web_page_preview: true
      });
      await sleep(200);
    }
  } catch(e) {
    console.warn("sendTelegram err", e.message);
  }
}

// ---------- SELF PING for Render ----------
async function selfPing() {
  if (!SELF_PING_URL) return;
  try {
    const url = SELF_PING_URL.startsWith("http") ? SELF_PING_URL : `https://${SELF_PING_URL}`;
    const r = await axios.get(url, { timeout: 5000 });
    console.log("self-ping ok", r.status);
  } catch(e) { console.warn("self-ping fail", e.message); }
}

// ---------- SCHEDULERS ----------
mlLoad();
let lastAnalysisAt = 0;
async function startSchedulers() {
  console.log("Starting schedulers...");
  // 1m reversal watcher
  setInterval(async ()=>{
    try { await reversalWatcherOnce(); } catch(e){ /*ignore*/ }
  }, Math.max(10, REV_CHECK_INTERVAL_SEC) * 1000);

  // evaluate pending every 2 minutes
  setInterval(async ()=> {
    try { await evaluatePending(); } catch(e){ console.warn("eval pending err", e.message); }
  }, 2*60*1000);

  // main 15m reporting (aligned to clock roughly)
  async function mainTick() {
    const now = Date.now();
    if (now - lastAnalysisAt < CHECK_INTERVAL_MIN*60*1000 - 1000) return;
    lastAnalysisAt = now;
    await analyzeOnce();
  }
  setInterval(mainTick, 30*1000); // check frequently, run when enough time passed

  // self-ping every 8 minutes
  setInterval(async ()=> { try { await selfPing(); } catch(e){} }, 8*60*1000);
}

// ---------- SIMPLE EXPRESS FOR Render healthcheck ----------
const app = express();
app.get("/", (req,res) => {
  res.send(`<pre>AI Trader v9.2 running. Symbol: ${SYMBOL}\nTime: ${nowISO()}</pre>`);
});
app.get("/health", (req,res) => res.json({ ok:true, ts: nowISO() }));
app.listen(PORT, ()=> {
  console.log(`Server listening on port ${PORT}`);
  // start schedulers after server up
  startSchedulers();
});

// ---------- STARTUP message ----------
(async ()=> {
  console.log("AI Trader v9.2 starting", SYMBOL);
  await sendTelegram(`<b>AI Trader v9.2 started</b>\n${nowIndia()}\nSymbol: ${SYMBOL}\nHost: Node`);
})();
