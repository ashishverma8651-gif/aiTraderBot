/**
 * aiTrader_v9.4.js
 * Multi-TF reporter (1m,5m,15m,30m,1h) + 15m analysis + reversal watcher + simple online ML
 * Requirements: axios, express, dotenv
 *
 * Save as aiTrader_v9.4.js
 * npm install axios express dotenv
 *
 * Env:
 * BOT_TOKEN, CHAT_ID, SYMBOL (BTCUSDT), CHECK_INTERVAL_MIN, REV_CHECK_INTERVAL_SEC,
 * ML_ALERT_THRESH, RENDER_EXTERNAL_URL, PORT
 *
 * This is text-only; no chart libraries so it deploys easily.
 */

const fs = require("fs");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || ""; // required to post (use channel or group id)
const SYMBOL_RAW = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// ---------- ENDPOINTS & PROXIES ----------
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];
const PROXY_PREFIXES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// ---------- FILES ----------
const ML_FILE = "./ml_v94.json";
const PENDING_FILE = "./pending_reversals_v94.json";
const ACC_FILE = "./acc_v94.json";

// ---------- UTIL ----------
function nowStr() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function safeFetchText(url, timeout=12000) {
  try { const r = await axios.get(url, { timeout }); return r.data; } catch(e){}
  for (const p of PROXY_PREFIXES) {
    try { const r = await axios.get(p + encodeURIComponent(url), { timeout }); return r.data; } catch(e){}
  }
  throw new Error("All fetch attempts failed for " + url);
}

// ---------- SYMBOL normalization ----------
function normalizeSymbols(raw) {
  const up = (raw||"BTCUSDT").replace(/[-_]/g,"").toUpperCase();
  const bin = up;
  let coinbase;
  if (bin.endsWith("USDT")) coinbase = `${bin.slice(0,-4)}-USD`;
  else if (bin.endsWith("USD")) coinbase = `${bin.slice(0,-3)}-USD`;
  else coinbase = bin.replace(/(.{3})(.*)/,"$1-$2") + "-USD";
  let cg = "bitcoin";
  if (/^BTC/.test(bin)) cg = "bitcoin";
  else if (/^ETH/.test(bin)) cg = "ethereum";
  else cg = bin.slice(0,3).toLowerCase();
  return { bin, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(SYMBOL_RAW);
const SYMBOL = SYMBOLS.bin;

// ---------- SIMPLE ONLINE ML (logistic) ----------
let ML = { w: null, bias: 0, n: 0, lr: 0.02, l2: 0.0001, trained:0, threshold: ML_ALERT_THRESH };
function mlLoad() {
  try {
    if (fs.existsSync(ML_FILE)) {
      const j = JSON.parse(fs.readFileSync(ML_FILE,"utf8"));
      ML = Object.assign(ML, j);
      console.log("ML loaded", ML.n, "trained", ML.trained);
    } else console.log("ML file not found, init later");
  } catch(e){ console.warn("mlLoad err", e.message); }
}
function mlSave(){ try{ fs.writeFileSync(ML_FILE, JSON.stringify(ML, null,2)); }catch(e){console.warn(e.message);} }
function mlInit(n) {
  if (!ML.w || ML.n !== n) {
    ML.n = n; ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0; ML.trained = 0; mlSave();
    console.log("ML initialized n=", n);
  }
}
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
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
  const lr = ML.lr || 0.02, l2 = ML.l2 || 0.0001;
  for (let i=0;i<features.length;i++){
    ML.w[i] += lr * (err * features[i] - l2 * (ML.w[i]||0));
  }
  ML.bias += lr * err;
  ML.trained = (ML.trained||0) + 1;
  if (ML.trained % 5 === 0) mlSave();
  return p;
}

// ---------- ACCURACY helpers ----------
function pushAcc(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while(arr.length>100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr,null,2));
  } catch(e){ console.warn("pushAcc", e.message); }
}
function getAccuracy(n=10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-n);
    return ((slice.reduce((a,b)=>a+b,0)/slice.length)*100).toFixed(1) + "%";
  } catch(e){ return "N/A"; }
}

// ---------- KLINE fetch (multi-source) ----------
async function fetchKlinesBinance(symbol, interval="15m", limit=200) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await axios.get(url, { timeout:10000 });
      if (!Array.isArray(r.data)) throw new Error("non-array");
      return { data: r.data.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })), source: "Binance" };
    } catch(e) {
      console.warn("Binance mirror failed:", e.message);
      continue;
    }
  }
  throw new Error("All Binance mirrors failed");
}
async function fetchKlinesCoinbase(product, interval="15m", limit=200) {
  const map = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = map[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}`;
  try {
    const r = await axios.get(url, { timeout:10000 });
    if (!Array.isArray(r.data)) throw new Error("coinbase no array");
    const sorted = r.data.slice(-limit).sort((a,b)=>a[0]-b[0]);
    return { data: sorted.map(k=>({ time:k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume:+(k[5]||0) })), source: "Coinbase" };
  } catch(e){ throw new Error("Coinbase failed: "+e.message); }
}
async function fetchKlinesCoinGecko(cgid="bitcoin", interval="15m", limit=200) {
  try {
    // coarse fallback (CoinGecko returns daily OHLC only for /ohlc). We'll use market chart /range for prices per minute if needed (but keep simple):
    const url = `https://api.coingecko.com/api/v3/coins/${cgid}/market_chart?vs_currency=usd&days=1`;
    const r = await axios.get(url, { timeout:12000 });
    if (!r.data || !r.data.prices) throw new Error("coingecko invalid");
    const prices = r.data.prices; // [ [ts, price], ... ]
    // aggregate into candles by interval (approx)
    const msMap = { "1m":60000, "5m":300000, "15m":900000, "30m":1800000, "1h":3600000 };
    const periodMs = msMap[interval] || 900000;
    const buckets = {};
    for (const p of prices) {
      const t = Math.floor(p[0] / periodMs) * periodMs;
      if (!buckets[t]) buckets[t] = { time:t, open:p[1], high:p[1], low:p[1], close:p[1], volume:0 };
      else {
        buckets[t].high = Math.max(buckets[t].high, p[1]);
        buckets[t].low = Math.min(buckets[t].low, p[1]);
        buckets[t].close = p[1];
      }
    }
    const arr = Object.values(buckets).sort((a,b)=>a.time-b.time).slice(-limit);
    return { data: arr, source: "CoinGecko" };
  } catch(e){ throw new Error("CoinGecko failed: "+e.message); }
}

async function fetchKlinesAny(symbol, interval="15m", limit=200) {
  const { bin, coinbase, cg } = SYMBOLS;
  try { return await fetchKlinesBinance(bin, interval, limit); } catch(e){ console.warn("binance fail:", e.message); }
  try { return await fetchKlinesCoinbase(coinbase, interval, limit); } catch(e){ console.warn("coinbase fail:", e.message); }
  try { return await fetchKlinesCoinGecko(cg, interval, limit); } catch(e){ console.warn("coingecko fail:", e.message); }
  return { data: [], source: "None" };
}

// ---------- small TA helpers ----------
function calcRSI(kl, period=14) {
  if (!kl || kl.length<=period) return 50;
  const deltas = [];
  for (let i=1;i<kl.length;i++) deltas.push(kl[i].close - kl[i-1].close);
  let gains = 0, losses = 0;
  for (const d of deltas) { if (d>0) gains += d; else losses -= d; }
  const avgGain = gains / deltas.length;
  const avgLoss = losses / deltas.length || 0.000001;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}
function emaArray(values, period) {
  if (!values.length) return [];
  const k = 2/(period+1);
  const out=[values[0]];
  for (let i=1;i<values.length;i++) out.push(values[i]*k + out[i-1]*(1-k));
  return out;
}
function calcMACD(kl, short=12,long=26,signal=9) {
  const closes = kl.map(k=>k.close);
  if (closes.length < long) return { macd:0, signal:0, hist:0 };
  const emaShort = emaArray(closes, short);
  const emaLong = emaArray(closes, long);
  const offset = emaShort.length - emaLong.length;
  const macdLine = emaShort.slice(offset).map((v,i)=> v - emaLong[i]);
  const signalLine = emaArray(macdLine, signal);
  const hist = (macdLine.at(-1)||0) - (signalLine.at(-1)||0);
  return { macd: macdLine.at(-1)||0, signal: signalLine.at(-1)||0, hist: hist||0 };
}
function atr(kl, period=14) {
  if (!kl || kl.length < period+1) return 0;
  const trs=[];
  for (let i=1;i<kl.length;i++){
    const cur=kl[i], prev=kl[i-1];
    const tr = Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return (slice.reduce((a,b)=>a+b,0) / slice.length) || 0;
}
function avgVol(kl, n=20) {
  if (!kl || !kl.length) return 1;
  const s = kl.slice(-n).reduce((a,b)=>a + (b.volume||0), 0);
  return s / Math.min(n, kl.length);
}
function detectCandlePattern(last, prev) {
  if (!last) return {};
  const body = Math.abs(last.close - last.open);
  const range = Math.max(1, last.high - last.low);
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open,last.close) - last.low;
  const upperWick = last.high - Math.max(last.open,last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > (prev? prev.close : last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < (prev? prev.close : last.open);
  return { isDoji, isHammer, isShooting, body, range };
}

// ---------- Feature extraction ----------
function extractFeatures(kl15, last, avgVol20=1, divergence=0, bias=0) {
  const first = kl15 && kl15[0] ? kl15[0] : last;
  const slope = ((last.close - first.close) / (first.close||1)) * 100;
  const lastPct = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = (last.volume || 0) / (avgVol20 || 1) - 1;
  const patt = detectCandlePattern(last, kl15 && kl15[kl15.length-2]);
  const rsi = calcRSI(kl15 || [], 14);
  const mac = calcMACD(kl15 || [], 12, 26, 9);
  return [
    slope,
    lastPct,
    volRatio,
    patt.isDoji?1:0,
    patt.isHammer?1:0,
    patt.isShooting?1:0,
    divergence || 0,
    (rsi - 50)/50,
    bias || 0,
    (mac.hist || 0) / (Math.abs(last.close) || 1)
  ];
}

// ---------- News fetch (real sources - RSS) ----------
async function fetchRSS(url, limit=6) {
  try {
    const txt = await safeFetchText(url);
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const title = (it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
      return title.replace(/<!\[CDATA\[|\]\]>/g,"").trim();
    }).filter(Boolean);
  } catch(e) { console.warn("fetchRSS fail", e.message); return []; }
}
async function fetchHeadlines() {
  const out = [];
  try { out.push(...await fetchRSS("https://cointelegraph.com/rss", 6)); } catch(e){ }
  try { out.push(...await fetchRSS("https://www.coindesk.com/arc/outboundfeeds/rss/", 6)); } catch(e){ }
  // dedupe and return top 6
  const uniq = [...new Set(out)].slice(0,6);
  return uniq;
}

// ---------- Merge & label ----------
function labelTrendFromPct(pct) {
  if (pct > 0.25) return "Uptrend";
  if (pct < -0.25) return "Downtrend";
  return "Sideways";
}
function labelFromCombined(value) {
  if (value > 0.12) return "Bullish";
  if (value < -0.12) return "Bearish";
  return "Neutral";
}

// ---------- Telegram helpers ----------
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
async function sendTelegram(text, opts={parse_mode:"HTML"}) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TG disabled: ", text);
    return;
  }
  const parts = [];
  // chunk message <4096 characters for telegram
  const chunkSize = 3800;
  for (let i=0;i<text.length;i+=chunkSize) parts.push(text.slice(i,i+chunkSize));
  for (const p of parts) {
    try {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: CHAT_ID, text: p, parse_mode: opts.parse_mode, disable_web_page_preview: true });
      await sleep(250);
    } catch(e) {
      console.warn("sendTelegram err", e.message);
      // do not throw
    }
  }
}

// ---------- Self-ping (to avoid free-host sleep) ----------
async function selfPing(){
  if (!SELF_PING_URL) return;
  try { await axios.get(SELF_PING_URL, { timeout: 8000 }); console.log("self-ping ok"); } catch(e){ console.warn("self-ping err", e.message); }
}

// ---------- Reversal watcher (1m) ----------
let pending = [];
try { if (fs.existsSync(PENDING_FILE)) pending = JSON.parse(fs.readFileSync(PENDING_FILE,"utf8")); } catch(e){ pending=[]; }
function savePending(){ try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pending.slice(-300), null,2)); } catch(e){} }

async function reversalOnce() {
  try {
    const { data, source } = await fetchKlinesAny(SYMBOL, "1m", 120);
    if (!data || data.length < 3) return;
    const last = data.at(-1), prev = data.at(-2);
    const avgV = avgVol(data, 20) || 1;
    const patt = detectCandlePattern(last, prev);
    const volSpike = (last.volume || 0) > avgV * 1.5;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (!reason) return;
    // features & ml
    const feat = extractFeatures(data.slice(-40), last, avgV, 0, 0);
    const prob = mlPredict(feat);
    const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
    // send telegram
    const msg = `\u26A0\uFE0F <b>Reversal Watcher (v9.4)</b>\n${nowStr()}\nSymbol: <b>${SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b> | Direction: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgV)})\nML Prob: ${(prob*100).toFixed(1)}%`;
    await sendTelegram(msg);
    // record for post-evaluation
    pending.push({ time: Date.now(), reason, dir, prob, price: last.close, feat });
    savePending();
    // soft training if extreme
    if (prob > 0.98) try{ mlTrainOnline(feat, 1); }catch(e){}
    if (prob < 0.02) try{ mlTrainOnline(feat, 0); }catch(e){}
    console.log("Reversal alert:", reason, dir, (prob*100).toFixed(1));
  } catch(e){ console.warn("reversalOnce err", e.message); }
}

async function evaluatePending() {
  if (!pending.length) return;
  const now = Date.now();
  const keep=[];
  for (const ev of pending) {
    if (now - ev.time < 8*60*1000) { keep.push(ev); continue; } // keep until 8 minutes pass
    try {
      const { data } = await fetchKlinesAny(SYMBOL, "1m", 300);
      if (!data || !data.length) { keep.push(ev); continue; }
      const startPrice = ev.price;
      const max = Math.max(...data.map(d=>d.high));
      const min = Math.min(...data.map(d=>d.low));
      let success = false;
      if (ev.dir === "Bullish" && max >= startPrice * 1.004) success = true;
      if (ev.dir === "Bearish" && min <= startPrice * 0.996) success = true;
      // train
      mlTrainOnline(ev.feat, success?1:0);
      pushAcc(success?1:0);
      console.log("Pending evaluated:", success);
    } catch(e) { console.warn("evaluatePending err", e.message); keep.push(ev); }
  }
  pending = keep; savePending();
}

// ---------- Build multi-TF analysis & 15m summary ----------
async function buildReportAndSend() {
  try {
    // fetch klines for TFs (parallel)
    const tfs = ["1m","5m","15m","30m","1h"];
    const promises = tfs.map(tf => fetchKlinesAny(SYMBOL, tf, 200).catch(e=>({ data:[], source:"Fail" })));
    const results = await Promise.all(promises);
    const tfMap = {};
    for (let i=0;i<tfs.length;i++) tfMap[tfs[i]] = results[i];

    // create TF blocks
    const tfBlocks = [];
    for (const tf of tfs) {
      const res = tfMap[tf];
      const kl = res.data || [];
      const src = res.source || "None";
      const last = kl.at(-1) || null;
      let deltaP = 0, deltaV = 0, strength = 0, trend = "NA";
      if (last && kl.length>1) {
        const prev = kl.at(-2);
        deltaP = ((last.close - prev.close)/ (prev.close||1)) * 100;
        const avg = avgVol(kl, 10) || 1;
        deltaV = ((last.volume || 0) - avg) / (avg || 1) * 100;
        strength = Math.min(100, Math.round(Math.abs(deltaP)*100)/100 + Math.min(100, Math.round(Math.abs(deltaV))));
        trend = labelTrendFromPct(((last.close - kl[0].close)/(kl[0].close||1)) * 100);
      }
      // divergence rudimentary: compare MACD hist with previous
      const mac = calcMACD(kl, 12,26,9);
      let div = "Neutral";
      if (mac.hist > 0.5) div="Bullish Divergence";
      else if (mac.hist < -0.5) div="Bearish Divergence";
      tfBlocks.push(`\u23F1 ${tf} | ${div} | \u0394P ${deltaP.toFixed(2)}% | \u0394V ${deltaV.toFixed(2)}% | Str ${strength} | Source: ${src}\nTrend: ${trend}`);
    }

    // take 15m as main analysis
    const kl15 = tfMap["15m"].data || [];
    const src15 = tfMap["15m"].source || "None";
    const last15 = kl15.at(-1) || { close:0, volume:0, open:0, high:0, low:0 };
    const avgV20 = avgVol(kl15, 20) || 1;
    const rsi15 = calcRSI(kl15, 14);
    const mac15 = calcMACD(kl15, 12,26,9);
    const atr15 = atr(kl15, 14);
    // features & ML
    const feat = extractFeatures(kl15.slice(-80), last15, avgV20, 0, 0);
    const mlProb = mlPredict(feat);
    // tech vol simple: compare SMA-ish buys vs sells by price movement count (very rudimentary)
    let buyCount=0, sellCount=0;
    for (let i=Math.max(1,kl15.length-50); i<kl15.length;i++){
      const d = kl15[i];
      if (d.close > d.open) buyCount++; else sellCount++;
    }
    const techBuyPct = Math.round( (buyCount/(buyCount+sellCount||1)) * 100 * 10)/10;
    const techSellPct = Math.round(100 - techBuyPct*10)/10 + (100 - techBuyPct);
    // targets (very simple: ATR/Fib hybrid)
    const highs = kl15.map(x=>x.high), lows = kl15.map(x=>x.low);
    const H = highs.length?Math.max(...highs):last15.close, L = lows.length?Math.min(...lows):last15.close;
    const R = Math.max(1, H-L);
    const tp1 = (last15.close + R*0.236).toFixed(2);
    const tp2 = (last15.close + R*0.382).toFixed(2);
    const tp3 = (last15.close + R*0.618).toFixed(2);
    const sl = (last15.close - atr15*1.2).toFixed(2);
    const breakoutLow = L.toFixed(2), breakoutHigh = H.toFixed(2);

    // label bias
    let biasLabel = "Neutral";
    let conf = Math.round((Math.abs((techBuyPct || 50) - 50) / 50) * 100);
    // combine with mlProb
    if (techBuyPct > 55 && mlProb > 0.55) biasLabel = "Bullish";
    else if (techBuyPct < 45 && mlProb < 0.45) biasLabel = "Bearish";
    else biasLabel = "Neutral";

    // headlines
    const headlines = await fetchHeadlines();
    const htext = headlines.length ? headlines.map(s => `\u2022 ${s}`).join("\n") : "\u2022 No headlines";

    // assemble message
    const header = `\uD83E\uDD16 ${SYMBOL} \u2014 AI Trader v9.4\n${nowStr()}\nSource: ${src15}\nPrice: ${last15.close}\nTech Vol (15m): Buy ${techBuyPct}% / Sell ${100-techBuyPct}%\nRSI(15): ${rsi15.toFixed(1)} | MACD hist(15): ${mac15.hist.toFixed(3)} | ATR(15): ${Math.round(atr15)}`;
    const biasLine = `Bias: <b>${biasLabel}</b> | Confidence(ML): ${(mlProb*100).toFixed(1)}% (thr ${ML.threshold})\nAccuracy(last10): ${getAccuracy(10)}`;
    const targetLine = `TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}\nBreakout zone (low-high): ${breakoutLow} - ${breakoutHigh}`;
    const tfSection = tfBlocks.join("\n\n");
    const msg = `${header}\n${biasLine}\n${targetLine}\n\nMulti timeframe:\n${tfSection}\n\nNews headlines:\n${htext}\n\nSources: Binance, Coinbase, CoinGecko (fallback)`;
    await sendTelegram(msg);

    // Auto train some on whether big move follows in short future? (deferred)
    // Save last features snapshot in memory (simple)
    // done
  } catch(e) {
    console.warn("buildReportAndSend err", e.message);
  }
}

// ---------- POLLING & SCHEDULER ----------
let autoReports = true;
async function schedulerLoop() {
  // immediate run
  await buildReportAndSend();
  // schedule periodic
  setInterval(async ()=>{
    try { await selfPing(); await buildReportAndSend(); } catch(e) { console.warn("periodic err", e.message); }
  }, CHECK_INTERVAL_MIN * 60 * 1000);
  // reversal watcher
  setInterval(async ()=>{ try{ await reversalOnce(); await evaluatePending(); }catch(e){console.warn("rev loop err", e.message);} }, REV_CHECK_INTERVAL_SEC * 1000);
}

// ---------- Telegram basic command poller (simple getUpdates loop) ----------
let tgOffset = 0;
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  try {
    const r = await axios.get(`${TG_API}/getUpdates?offset=${tgOffset}&timeout=5`);
    if (!r.data || !r.data.result) return;
    for (const u of r.data.result) {
      tgOffset = (u.update_id || 0) + 1;
      try { await handleUpdate(u); } catch(e){ console.warn("handleUpdate err", e.message); }
    }
  } catch(e){ console.warn("pollTelegram err", e.message); }
}
async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const txt = msg.text.trim();
  const chatId = msg.chat.id;
  const parts = txt.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd==="/start" || cmd==="/help") {
    const help = `AI Trader Bot v9.4\nCommands:\n/status - latest summary\n/predict - immediate 15m analysis\n/setthreshold <0-1> - set ML threshold\n/autoon - enable auto reports\n/autooff - disable auto reports\n`;
    await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: help });
    return;
  }
  if (cmd === "/status") {
    await buildReportAndSend();
    return;
  }
  if (cmd === "/predict") {
    // run immediate 15m analysis only
    await buildReportAndSend();
    return;
  }
  if (cmd === "/setthreshold" && parts[1]) {
    const v = parseFloat(parts[1]);
    if (!isNaN(v) && v>0 && v<1) { ML.threshold = v; mlSave(); await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `ML threshold set to ${v}` }); }
    else await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Invalid value. Use 0 < value < 1` });
    return;
  }
  if (cmd === "/autoon") { autoReports = true; await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports enabled` }); return; }
  if (cmd === "/autooff") { autoReports = false; await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports disabled` }); return; }
}

// ---------- INIT ----------
(async function main(){
  try {
    mlLoad();
    // basic express server for render
    const app = express();
    app.get("/", (req,res)=> res.send("aiTrader v9.4 live - " + nowStr()));
    app.listen(PORT, ()=> console.log("Server listening on", PORT));
    // start scheduler & polling
    schedulerLoop().catch(e=>console.warn(e.message));
    setInterval(pollTelegram, 3000);
    console.log("AI Trader v9.4 starting... symbol", SYMBOL);
    // quick immediate reversal loop start
    // note: evaluatePending runs within reversal loop as setInterval
  } catch(e) {
    console.error("startup err", e.message);
  }
})();