/**
 * ai_trader_v8.9_full.js
 *
 * - Multi-source klines: Binance -> Coinbase -> Bitstamp -> CoinGecko (with proxy fallbacks)
 * - Multi-TF analysis (1m,3m,5m,15m,30m,1h)
 * - Hybrid Targets: ATR + Fibonacci + simple Elliott heuristic
 * - Enhanced Reversal Watcher (fuzzy patterns + volume + ATR + multi-TF sync)
 * - Tiny online ML (logistic) for reversal probability + soft-train hooks
 * - Telegram messaging + Express keepalive + simple command endpoints
 *
 * Requirements:
 *   npm i node-fetch@3 express dotenv
 *
 * Usage:
 *   node ai_trader_v8.9_full.js
 *
 * .env keys:
 *   BOT_TOKEN - telegram bot token
 *   CHAT_ID - telegram chat id (group or user)
 *   SYMBOL - e.g. BTCUSDT
 *   PORT - express port (default 3000)
 *   SELF_PING_URL - optional (render/keepalive)
 *   ML_THRESH - default 0.7
 *
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RAW_SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "30", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_THRESH || "0.7");
const SELF_PING_URL = process.env.SELF_PING_URL || null;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);

// quick env check:
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

// ---------- constants ----------
const TIMEFRAMES = ["1m","3m","5m","15m","30m","1h"];
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// storage
const ML_MODEL_FILE = "./ml_model_v89.json";
const ACC_FILE = "./acc_v89.json";

// ---------- helpers ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

// chunk telegram messages
function chunkMessage(text, chunkSize = 3800) {
  const out = [];
  for (let i=0;i<text.length;i+=chunkSize) out.push(text.slice(i,i+chunkSize));
  return out;
}

async function sendTG(text, parse_mode="HTML") {
  const parts = chunkMessage(text);
  for (const part of parts) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ chat_id: CHAT_ID, text: part, parse_mode, disable_web_page_preview: true })
      });
      const j = await res.json().catch(()=>({}));
      if (!j.ok) console.warn("TG send warning:", j);
    } catch (e) {
      console.warn("TG send failed:", e.message);
    }
    await new Promise(r=>setTimeout(r, 250));
  }
}

async function safeFetch(url, opts={}, tryProxies=true, timeoutMs=12000) {
  try {
    const controller = new AbortController();
    const id = setTimeout(()=>controller.abort(), timeoutMs);
    const r = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    if (r) return r;
  } catch(e) {}
  if (!tryProxies) throw new Error("Direct fetch failed");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, opts);
      if (r && r.ok) return r;
      // if r not ok still can try next
    } catch(e) {}
  }
  throw new Error("safeFetch: all proxies failed");
}

function normalizeSymbols(raw) {
  const up = raw.toUpperCase();
  let binSymbol = up.replace(/[-_]/g, "");
  // coinbase uses BTC-USD style
  let coinbaseSymbol;
  if (binSymbol.endsWith("USDT") || binSymbol.endsWith("USD")) {
    const base = binSymbol.replace(/(USDT|USD)$/i,"");
    coinbaseSymbol = `${base}-USD`;
  } else {
    coinbaseSymbol = binSymbol.slice(0,3) + "-USD";
  }
  // coingecko id heuristic
  let coingeckoId = "bitcoin";
  if (/^BTC/.test(binSymbol)) coingeckoId = "bitcoin";
  else if (/^ETH/.test(binSymbol)) coingeckoId = "ethereum";
  else coingeckoId = binSymbol.slice(0,3).toLowerCase();
  return { binSymbol, coinbaseSymbol, coingeckoId };
}
const SYMBOLS = normalizeSymbols(RAW_SYMBOL);

// ---------- data fetchers ----------
// Binance klines (try mirrors)
async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await safeFetch(url);
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (!Array.isArray(j)) throw new Error("binance response not array");
        return j.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
      } catch(e) {
        console.warn("binance mirror gave non-array or parse fail:", base, (txt||"").slice(0,200));
        continue;
      }
    } catch(e){ console.warn("fetchKlinesBinance error", base, e.message); continue; }
  }
  throw new Error("All Binance mirrors failed");
}

// Coinbase candles fallback
async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=80) {
  const granMap = { "1m":60, "3m":180, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  try {
    const r = await safeFetch(url);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("Coinbase returned non-array");
    // element [time, low, high, open, close, volume]
    const sorted = j.slice(-limit).sort((a,b)=>a[0]-b[0]);
    return sorted.map(k => ({ time: k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume: (k[5]||0) }));
  } catch(e){ throw new Error("Coinbase fetch failed: " + e.message); }
}

// Bitstamp fallback (ohlc)
async function fetchKlinesBitstamp(symbol, interval="15m", limit=80) {
  // Bitstamp uses pair like btcusd, interval in minutes (minute/hours/day)
  try {
    const pair = symbol.replace(/USDT$/,"USD").toLowerCase();
    // use public ohlc endpoint
    const url = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=900&limit=${limit}`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!j || !j.data || !Array.isArray(j.data.ohlc)) throw new Error("bitstamp bad");
    const arr = j.data.ohlc.slice(-limit).map(k=>({ time: k.timestamp*1000, open:+k.open, high:+k.high, low:+k.low, close:+k.close, volume:+k.volume }));
    return arr;
  } catch(e) { throw new Error("Bitstamp failed: " + e.message); }
}

// CoinGecko fallback (OHLC)
async function fetchKlinesCoinGecko(coingeckoId="bitcoin", interval="15m", limit=80) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/ohlc?vs_currency=usd&days=1`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("coingecko invalid");
    const slice = j.slice(-limit);
    return slice.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume: 0 }));
  } catch(e){ throw new Error("CoinGecko fetch failed: " + e.message); }
}

// Unified fetchKlines (tries in order)
async function fetchKlines(symbolRaw, interval="15m", limit=80) {
  const { binSymbol, coinbaseSymbol, coingeckoId } = SYMBOLS;
  // first try Binance
  try {
    const kl = await fetchKlinesBinance(binSymbol, interval, limit);
    return { data: kl, source: "Binance" };
  } catch(e) { console.warn("Binance failed:", e.message); }
  // Coinbase
  try {
    const kl = await fetchKlinesCoinbase(coinbaseSymbol, interval, limit);
    return { data: kl, source: "Coinbase" };
  } catch(e) { console.warn("Coinbase failed:", e.message); }
  // Bitstamp
  try {
    const kl = await fetchKlinesBitstamp(binSymbol, interval, limit);
    return { data: kl, source: "Bitstamp" };
  } catch(e) { console.warn("Bitstamp failed:", e.message); }
  // CoinGecko
  try {
    const kl = await fetchKlinesCoinGecko(coingeckoId, interval, limit);
    return { data: kl, source: "CoinGecko" };
  } catch(e) { console.warn("CoinGecko failed:", e.message); }
  return { data: [], source: "None" };
}

// ---------- small indicators ----------
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((acc,k)=>acc + (k.volume||0), 0);
  return s / slice.length;
}
function atr(klines, period=14) {
  if (!klines || klines.length < period+1) return null;
  const trs = [];
  for (let i=1;i<klines.length;i++){
    const cur = klines[i], prev = klines[i-1];
    const tr = Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/slice.length;
}
function detectDivergence(kl) {
  if (!kl || kl.length < 2) return { type:"Neutral", dp:0, dv:0, strength:0 };
  const last = kl.at(-1), prev = kl.at(-2);
  const dp = ((last.close - prev.close) / (prev.close||1)) * 100;
  const dv = ((last.volume - prev.volume) / (prev.volume||1)) * 100;
  let type = "Neutral";
  if (dp > 0 && dv < 0) type = "Bearish Divergence";
  if (dp < 0 && dv > 0) type = "Bullish Divergence";
  const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
  return { type, dp, dv, strength };
}

// fuzzy candle pattern detection
function detectCandlePatternFuzzy(last, prev) {
  if (!last) return { name:"None", dir:"Neutral", body:0, range:0 };
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  // fuzzy thresholds for hammer / shooting star / doji / engulfing
  const isDoji = body <= range * 0.2;
  const isHammer = lowerRatio > 0.35 && upperRatio < 0.3 && (last.close >= last.open);
  const isHammerWeak = lowerRatio > 0.25 && upperRatio < 0.4;
  const isShooting = upperRatio > 0.35 && lowerRatio < 0.3 && (last.close <= last.open);
  const isShootingWeak = upperRatio > 0.25 && lowerRatio < 0.4;
  const isBullEngulf = prev && (last.close > prev.open && last.open < prev.close && last.close > prev.close);
  const isBearEngulf = prev && (last.open > prev.close && last.close < prev.open && last.close < prev.close);
  if (isHammer || isHammerWeak) return { name:"Hammer", dir:"Bullish", body, range, strength: isHammer?0.9:0.6 };
  if (isShooting || isShootingWeak) return { name:"Shooting Star", dir:"Bearish", body, range, strength: isShooting?0.9:0.6 };
  if (isBullEngulf) return { name:"Bullish Engulfing", dir:"Bullish", body, range, strength:0.8 };
  if (isBearEngulf) return { name:"Bearish Engulfing", dir:"Bearish", body, range, strength:0.8 };
  if (isDoji) return { name:"Doji", dir:"Neutral", body, range, strength:0.4 };
  return { name:"None", dir:"Neutral", body, range, strength:0 };
}

// fib calc from klines (use combined 15m+30m hybrid)
function calcFibFrom(kl15, kl30) {
  const kl = (kl15 && kl15.length>=5) ? kl15 : (kl30 && kl30.length>=5 ? kl30 : kl15);
  if (!kl || !kl.length) return null;
  const highs = kl.map(k=>k.high), lows = kl.map(k=>k.low);
  const high = Math.max(...highs), low = Math.min(...lows);
  const range = high - low || 1;
  return {
    high, low,
    fib236: high - range * 0.236,
    fib382: high - range * 0.382,
    fib5: high - range * 0.5,
    fib618: high - range * 0.618,
    fib786: high - range * 0.786
  };
}

// elliott simple heuristic: count recent impulse-like moves
function elliottHeuristic(kl15, kl30) {
  // simple approach: measure last swing directions and amplitude
  function impulseScore(kl) {
    if (!kl || kl.length < 8) return 50;
    const closes = kl.map(k=>k.close);
    const diffs = [];
    for (let i=1;i<closes.length;i++) diffs.push(closes[i]-closes[i-1]);
    const up = diffs.filter(d=>d>0).reduce((a,b)=>a+b,0);
    const down = Math.abs(diffs.filter(d=>d<0).reduce((a,b)=>a+b,0));
    const score = 50 + Math.sign(up-down) * (Math.min(50, Math.abs(up-down)/Math.max(1, (up+down)) * 50));
    return Math.round(score);
  }
  return { e15: impulseScore(kl15), e30: impulseScore(kl30) };
}

// targets & SL - hybrid of ATR+Fib+Elliott direction
function getHybridTargets(price, dir="Neutral", atr15=null, fib=null, ell15=50, ell30=50) {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  const baseMove = (atr15 && isFinite(atr15)) ? atr15 : price*0.0045;
  // elliott influences multiplier
  const ellFactor = (ell30>60 || ell15>60) ? 1.25 : (ell30<40 || ell15<40 ? 0.9 : 1.0);
  const move = baseMove * ellFactor;
  if (dir.includes("Bull")) {
    const tp1 = +(price + move).toFixed(2);
    const tp2 = +(price + move*1.8).toFixed(2);
    const tp3 = +(price + move*3).toFixed(2);
    const sl = +(price - move*0.8).toFixed(2);
    return { tp1, tp2, tp3, sl };
  } else if (dir.includes("Bear")) {
    const tp1 = +(price - move).toFixed(2);
    const tp2 = +(price - move*1.8).toFixed(2);
    const tp3 = +(price - move*3).toFixed(2);
    const sl = +(price + move*0.8).toFixed(2);
    return { tp1, tp2, tp3, sl };
  } else {
    // neutral: propose breakout zone only (using fib)
    return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  }
}

// ---------- accuracy store ----------
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while (arr.length > 100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr,null,2));
  } catch(e) { console.warn("pushAccLocal", e.message); }
}
function getAccLocal(lastN=10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN);
    const s = slice.reduce((a,b)=>a+b,0);
    return ((s/slice.length)*100).toFixed(1);
  } catch(e) { return "N/A"; }
}

// ---------- tiny ML (logistic) ----------
function mlLoad() {
  try {
    if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8"));
  } catch(e) { console.warn("mlLoad", e.message); }
  return { w:null, bias:0, n_features:0, lr:0.02, l2:0.0001, trained:0, threshold: ML_ALERT_THRESH };
}
function mlSave(model) { try { fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(model,null,2)); } catch(e) { console.warn("mlSave", e.message); } }
let ML = mlLoad();
function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave(ML);
    console.log("ML initialized features =", n);
  }
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  let z = ML.bias;
  for (let i=0;i<features.length;i++) z += (ML.w[i]||0) * (features[i]||0);
  return sigmoid(z);
}
function mlTrain(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const p = mlPredict(features);
  const err = label - p;
  const lr = ML.lr || 0.02;
  const l2 = ML.l2 || 0.0001;
  for (let i=0;i<features.length;i++) ML.w[i] += lr * (err * (features[i]||0) - l2 * (ML.w[i]||0));
  ML.bias += lr * err;
  ML.trained = (ML.trained||0) + 1;
  if (ML.trained % 5 === 0) mlSave(ML);
  return p;
}
function mlExtractFeatures({kl1, kl3, kl5, lastCandle, avgVol20=1, divergenceSign=0, ell15=50, ell30=50}) {
  const last = lastCandle || (kl1 && kl1.at(-1)) || { close:0, open:0, volume:1 };
  const first15 = (kl5 && kl5[0]) || last;
  const slope15 = ((last.close - (first15.close||last.close)) / (first15.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePatternFuzzy(last, kl1 && kl1.at(-2));
  return [
    slope15,
    lastDeltaP,
    volRatio - 1,
    patt.strength||0,
    divergenceSign||0,
    (ell15||50)/100,
    (ell30||50)/100
  ];
}

// ---------- Self-ping ----------
async function selfPing() {
  if (!SELF_PING_URL) return;
  let url = SELF_PING_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  try {
    const r = await fetch(url);
    console.log("Self-ping status", r.status);
  } catch(e) {
    console.warn("Self-ping failed", e.message);
  }
}

// ---------- Reversal watcher (enhanced multi-TF) ----------
let lastRevAt = 0;
const REV_COOLDOWN_MS = 60 * 1000;
async function reversalWatcherOnce() {
  try {
    // fetch small TFs: 1m,3m,5m
    const r1 = await fetchKlines(RAW_SYMBOL, "1m", 40);
    const r3 = await fetchKlines(RAW_SYMBOL, "3m", 40);
    const r5 = await fetchKlines(RAW_SYMBOL, "5m", 40);
    const kl1 = r1.data || [], kl3 = r3.data || [], kl5 = r5.data || [];
    const source = r1.source || r3.source || r5.source || "Unknown";
    if (!kl1.length) return;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = avgVolume(kl1, 20) || 1;
    const patt = detectCandlePatternFuzzy(last, prev);
    const volSpike = last.volume > avgVol * 1.25; // fuzzy
    const atrVal = atr(kl5, 14) || atr(kl1, 7) || 0;
    const now = Date.now();
    if (now - lastRevAt < REV_COOLDOWN_MS) return;
    // multi-TF confirmation: check 3m/5m patterns or divergence supporting same dir
    const d1 = detectDivergence(kl1);
    const d3 = detectDivergence(kl3);
    const supportCount = (
      ((patt.dir!=="Neutral")?1:0) +
      ((d1.type.includes(patt.dir==="Bullish" ? "Bull" : patt.dir==="Bearish" ? "Bear" : "") )?1:0) +
      ((d3.type.includes(patt.dir==="Bullish" ? "Bull" : patt.dir==="Bearish" ? "Bear" : "") )?1:0)
    );
    // ML features
    const ell = elliottHeuristic(kl5, kl3);
    const feat = mlExtractFeatures({ kl1, kl3, kl5, lastCandle: last, avgVol20: avgVol, divergenceSign: (d1.type.includes("Bull")?1:d1.type.includes("Bear")?-1:0), ell15:ell.e15, ell30:ell.e30 });
    const prob = mlPredict(feat);
    // decision logic:
    const strongPattern = patt.name !== "None" && (patt.strength >= 0.6);
    const mlAccept = prob > 0.55;
    const volAccept = volSpike || (last.volume > avgVol * 1.1);
    // require at least pattern+vol or multi-tf support + moderate ML prob
    let trigger = false;
    if (strongPattern && volAccept && (mlAccept || supportCount >= 2)) trigger = true;
    // allow weak patterns if supportCount high and ml strong
    if (!strongPattern && supportCount >= 2 && prob > 0.68) trigger = true;
    if (trigger) {
      lastRevAt = now;
      const dirText = patt.dir==="Bullish" ? "Bullish 🟢" : patt.dir==="Bearish" ? "Bearish 🔴" : "Neutral";
      const txt = `🚨 <b>Reversal Watcher (v8.9)</b>\n${nowStr()}\nSymbol: <b>${RAW_SYMBOL}</b>\nSource: ${source}\nPattern: <b>${patt.name}</b> | Direction: <b>${dirText}</b>\nPrice: <b>${last.close.toFixed(2)}</b>\nVolume: ${last.volume.toFixed(0)} (avg ${avgVol.toFixed(0)})\nATR(5m): ${atrVal?atrVal.toFixed(2):"N/A"}\nMultiTF support: ${supportCount}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(txt);
      // soft training: if user later confirms via /mark_correct endpoint, we can train; for now store feat for potential training
      // We'll append a pending file with features to be labeled later if desired
      try {
        const pending = fs.existsSync("./ml_pending_v89.json") ? JSON.parse(fs.readFileSync("./ml_pending_v89.json","utf8")) : [];
        pending.push({ t: Date.now(), feat, prob, patt: patt.name, price: last.close });
        fs.writeFileSync("./ml_pending_v89.json", JSON.stringify(pending,null,2));
      } catch(e){}
    }
  } catch(e) {
    console.warn("reversalWatcherOnce error", e.message);
  }
}

// ---------- main analysis & report ----------
async function analyzeAndReport() {
  try {
    // fetch klines for TFs
    const tfData = {};
    const sourcesUsed = {};
    const requests = TIMEFRAMES.map(tf => fetchKlines(RAW_SYMBOL, tf, tf==="1m"?200:150));
    const results = await Promise.allSettled(requests);
    for (let i=0;i<TIMEFRAMES.length;i++){
      const tf = TIMEFRAMES[i];
      const r = results[i];
      if (r.status === "fulfilled") {
        tfData[tf] = r.value.data || [];
        sourcesUsed[tf] = r.value.source || "None";
      } else {
        tfData[tf] = [];
        sourcesUsed[tf] = "None";
      }
    }
    const base15 = tfData["15m"] || [];
    const base30 = tfData["30m"] || [];
    if (!base15 || base15.length < 8) {
      const msg = `❗ Not enough 15m candles (${(base15||[]).length}) — skipping (${nowStr()})`;
      console.warn(msg);
      try { await sendTG(msg); } catch(e){}
      return;
    }
    const lastPrice = base15.at(-1).close;
    const tech = (arr=> {
      const kl = arr || [];
      let buy=0, sell=0;
      for (const k of kl){ if (k.close > k.open) buy += (k.volume||0); else sell += (k.volume||0); }
      const tot = buy + sell || 1;
      return { buyPct: (buy/tot)*100, sellPct: (sell/tot)*100 };
    })(base15);
    const fib = calcFibFrom(base15, base30);
    const atr15 = atr(base15, 14) || 0;
    const atr30 = atr(base30, 14) || 0;
    // per TF divergence and trend
    let bull=0,bear=0,totalStrength=0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = kl.length>1 ? ((kl.at(-1).close - kl[0].close)/(kl[0].close||1))*100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bull++;
      if (d.type.includes("Bear")) bear++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Str ${Math.round(d.strength)} | Source: ${sourcesUsed[tf]}\nTrend: ${trend}\n`;
    }
    // Elliott heuristic
    const ell = elliottHeuristic(base15, base30);
    // targets
    const overallDir = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";
    const hybridTargets = getHybridTargets(lastPrice, overallDir, atr15, fib, ell.e15, ell.e30);
    // ml features & prob
    const d1 = detectDivergence(tfData["1m"]||[]);
    const feat = mlExtractFeatures({ klines15: base15, kl1: tfData["1m"], kl3: tfData["3m"], kl5: tfData["5m"], lastCandle: base15.at(-1), avgVol20: avgVolume(base15,20), divergenceSign: d1.type.includes("Bull")?1:d1.type.includes("Bear")?-1:0, ellConf:ell.e15, systemBias: (overallDir==="Bullish"?1:overallDir==="Bearish"?-1:0) });
    const mlProb = mlPredict(feat);
    // news & headlines (simple RSS)
    const headlines = await fetchHeadlinesSafe();
    // build message
    let txt = `🤖 <b>${RAW_SYMBOL} — AI Trader v8.9 (Hybrid)</b>\n🕒 ${nowStr()}\n`;
    txt += perTfText + "\n";
    txt += `\n🎯 <b>Targets (Hybrid ATR+Fib+Elliott):</b>\nTP1: ${hybridTargets.tp1} | TP2: ${hybridTargets.tp2} | TP3: ${hybridTargets.tp3}\nSL: ${hybridTargets.sl}\n`;
    if (fib) txt += `📊 Breakout Zone: ${fib.fib618.toFixed(2)} - ${fib.fib382.toFixed(2)}\n`;
    txt += `\n🧠 Bias: ${overallDir} | Confidence: ${Math.round((totalStrength/ (TIMEFRAMES.length*100)) * 100)}% | ML Prob: ${(mlProb*100).toFixed(1)}% (thr ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n`;
    txt += `💰 Price: ${lastPrice.toFixed(2)} | ATR(15m): ${atr15?atr15.toFixed(2):"N/A"} | ATR(30m): ${atr30?atr30.toFixed(2):"N/A"}\n`;
    txt += `📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}% | Accuracy(Last10): ${getAccLocal(10)}%\n`;
    txt += `📰 News Impact: ${headlines.length? "Medium" : "None"}\nSources: ${Object.values(sourcesUsed).join(", ")}\n\n`;
    if (headlines.length) {
      txt += "🗞️ <b>Headlines:</b>\n";
      for (const h of headlines.slice(0,6)) txt += `• ${h}\n`;
    }
    await sendTG(txt);
  } catch(e) {
    console.warn("analyzeAndReport error", e.message);
  }
}

// simple RSS headlines fetch using cointelegraph & coindesk
async function fetchHeadlinesSafe() {
  try {
    const cointele = await safeFetch("https://cointelegraph.com/rss", {}, true);
    const ctTxt = await cointele.text();
    const items = ctTxt.split("<item>").slice(1,7).map(it => (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "").map(s=>s.replace(/<!\[CDATA\[|\]\]>/g,"").trim());
    return items.filter(Boolean);
  } catch(e) {
    try {
      const cd = await safeFetch("https://www.coindesk.com/arc/outboundfeeds/rss/");
      const txt = await cd.text();
      const items = txt.split("<item>").slice(1,7).map(it => (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "").map(s=>s.replace(/<!\[CDATA\[|\]\]>/g,"").trim());
      return items.filter(Boolean);
    } catch(e2) {
      console.warn("fetchHeadlines failed", e.message);
      return [];
    }
  }
}

// ---------- start / scheduling ----------
async function startAll() {
  // ensure ML init feature size ~7 as defined above
  mlInit(7);
  // immediate run
  await analyzeAndReport();
  await reversalWatcherOnce();
  // intervals
  setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
  if (SELF_PING_URL) setInterval(selfPing, 5 * 60 * 1000);
}

// ---------- Express keepalive & simple command endpoints ----------
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("AI Trader v8.9 running"));
app.get("/check", async (_, res) => {
  try { await analyzeAndReport(); res.json({ ok:true }); } catch(e){ res.status(500).json({ ok:false, err:e.message }); }
});
app.post("/mark_correct", async (req, res) => {
  // endpoint to mark last pending ML entry as correct/incorrect for training
  // body: { idx: <index> (or null), correct: true/false }
  try {
    const pendingFile = "./ml_pending_v89.json";
    if (!fs.existsSync(pendingFile)) return res.json({ ok:false, msg:"no pending" });
    const pending = JSON.parse(fs.readFileSync(pendingFile,"utf8"));
    const { idx=null, correct } = req.body;
    let entry;
    if (idx === null) entry = pending.pop();
    else entry = pending.splice(idx,1)[0];
    fs.writeFileSync(pendingFile, JSON.stringify(pending,null,2));
    if (entry) {
      // label = 1 if correct & pattern direction matched actual move - this is heuristic
      // We'll do simple: if correct==true train label 1 else 0
      try {
        const lbl = correct ? 1 : 0;
        mlTrain(entry.feat, lbl);
        pushAccLocal(correct);
      } catch(e){}
      return res.json({ ok:true, trained: !!entry });
    } else return res.json({ ok:false, msg:"no entry" });
  } catch(e) { res.status(500).json({ ok:false, err:e.message }); }
});

// minimal tg commands integration (tg_commands.js can POST here)
app.post("/tg/cmd", (req, res) => {
  // accept { cmd: "help" | "start" | "status" | "mark_correct", args:{} }
  const { cmd, args } = req.body || {};
  if (!cmd) return res.status(400).json({ ok:false, msg:"cmd missing" });
  (async ()=>{
    try {
      if (cmd === "start" || cmd === "help") {
        const help = `🤖 <b>AI Trader v8.9</b>\nCommands:\n/start - show help\n/status - latest analysis\n/mark_correct - mark last reversal as correct (body: {correct:true})\n/check - force analysis\n`;
        await sendTG(help);
        return res.json({ ok:true });
      } else if (cmd === "status") {
        await analyzeAndReport();
        return res.json({ ok:true });
      } else if (cmd === "check") {
        await analyzeAndReport();
        return res.json({ ok:true });
      } else if (cmd === "mark_correct") {
        const r = await fetch(`http://localhost:${PORT}/mark_correct`, {
          method:"POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(args||{})
        });
        const j = await r.json();
        return res.json(j);
      } else {
        return res.json({ ok:false, msg:"unknown cmd" });
      }
    } catch(e){
      console.warn("tg/cmd error", e.message);
      return res.status(500).json({ ok:false, err:e.message });
    }
  })();
});

// start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAll().catch(e=>console.error("startAll error", e.message));
});