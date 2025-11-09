/**
 * AI_Trader_v8.8_full_ml.js
 * Full single-file bot:
 * - Multi-source klines: Binance -> Coinbase -> Kraken -> Bitstamp -> CoinGecko (with proxy fallbacks)
 * - Multi-TF analysis (1m,5m,15m,30m,1h)
 * - Fib + ATR targets & breakout zones
 * - Reversal watcher (1m) detecting Doji/Hammer/ShootingStar + High volume
 * - Tiny online ML (logistic-ish) trainer & predictor (features from price/vol/pattern)
 * - News (CoinTelegraph, CoinDesk RSS) + Reddit + Nitter + heuristic sentiment
 * - Accuracy tracking, self-ping, chunked Telegram messages, Express keepalive
 *
 * Requirements:
 *  npm i node-fetch@3 express dotenv
 *
 * Usage:
 *  node AI_Trader_v8.8_full_ml.js
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
import { initTelegramCommands } from "./tg_commands.js";
// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RAW_SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70", 10);
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || "10000", 10);

// safety
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

// Timeframes & limits
const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
const LIMITS = { "1m": 200, "5m": 150, "15m": 120, "30m": 100, "1h": 80 };

// proxies to bypass CORS / blocks
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// Binance mirrors
const BINANCE_MIRRORS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// Kraken public
const KRAKEN_BASE = "https://api.kraken.com/0/public";

// Bitstamp public
const BITSTAMP_BASE = "https://www.bitstamp.net/api";

// CoinGecko
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// storage files
const ML_MODEL_FILE = "./ml_model_v88.json";
const LAST_PRED_FILE = "./last_pred_v88.json";
const ACC_FILE = "./acc_v88.json";
const LAST_REPORT_FILE = "./last_report_prevclose_v88.json";

// ---------- helpers ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

function chunkMessage(text, chunkSize = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += chunkSize) parts.push(text.slice(i, i + chunkSize));
  return parts;
}

async function sendTG(text) {
  const parts = chunkMessage(text);
  for (const p of parts) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ chat_id: CHAT_ID, text: p, parse_mode: "HTML", disable_web_page_preview: true })
      });
      const j = await res.json().catch(()=>({}));
      if (!j.ok) console.warn("TG send warning:", j);
    } catch (e) {
      console.warn("TG send failed:", e.message);
    }
    await new Promise(r => setTimeout(r, 220));
  }
}

async function safeFetch(url, opts = {}, tryProxies = true) {
  try {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    // if not ok, still return so caller can inspect body
    return r;
  } catch(e) {}
  if (!tryProxies) throw new Error("Direct fetch failed");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, opts);
      if (r.ok) return r;
    } catch(e) {}
  }
  throw new Error("All proxied fetch attempts failed");
}

// ---------- symbol normalization ----------
function normalizeSymbols(raw) {
  const up = raw.toUpperCase().replace(/[-_]/g, "");
  // bin: BTCUSDT etc
  const binSymbol = up;
  // coinbase: BTC-USD
  const coinbaseSymbol = (binSymbol.endsWith("USDT") || binSymbol.endsWith("USD")) ? `${binSymbol.replace(/(USDT|USD)$/i,"")}-USD` : `${binSymbol}-USD`;
  // coingecko id
  let coingecko = "bitcoin";
  if (/^BTC/.test(binSymbol)) coingecko = "bitcoin";
  else if (/^ETH/.test(binSymbol)) coingecko = "ethereum";
  else coingecko = binSymbol.slice(0,3).toLowerCase();
  // kraken symbol mapping (BTCUSD => XBTUSD)
  const krakenSymbol = (() => {
    const base = binSymbol.replace(/(USDT|USD)$/i, "");
    const pair = `${base}USD`.replace(/^BTC/, "XBT");
    return pair;
  })();
  // bitstamp: btcusd
  const bitstampSymbol = coinbaseSymbol.replace("-", "").toLowerCase();
  return { binSymbol, coinbaseSymbol, coingecko, krakenSymbol, bitstampSymbol };
}
const SYMBOLS = normalizeSymbols(RAW_SYMBOL);

// ---------- low-level data fetchers ----------
// 1) Binance klines (mirrors)
async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_MIRRORS) {
    try {
      const url = base.replace(/\/$/, "") + path;
      const r = await safeFetch(url, {}, false);
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (!Array.isArray(j)) throw new Error("non-array");
        return j.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
      } catch(e) {
        console.warn("Binance mirror non-array or error:", base, e.message);
        continue;
      }
    } catch(e) {
      console.warn("fetchKlinesBinance error", e.message);
      continue;
    }
  }
  throw new Error("Binance mirrors failed");
}

// 2) Coinbase candles fallback
// Coinbase API: GET /products/{product_id}/candles?granularity=SECONDS
async function fetchKlinesCoinbase(symbol, interval="15m", limit=80) {
  const granMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${gran}`;
  const r = await safeFetch(url, {}, true);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Coinbase returned non-array");
  // j entries: [time, low, high, open, close, volume] often descending
  const sorted = j.slice(-limit).sort((a,b)=>a[0]-b[0]);
  return sorted.map(k => ({ time: k[0]*1000, open: +k[3], high: +k[2], low: +k[1], close: +k[4], volume: +k[5] }));
}

// 3) Kraken OHLC fallback
async function fetchKlinesKraken(krakenSymbol, interval="15m", limit=80) {
  // Kraken intervals: 1,5,15,30,60 minutes mapped to 1,5,15,30,60
  const map = { "1m":1, "5m":5, "15m":15, "30m":30, "1h":60 };
  const intv = map[interval] || 15;
  const url = `${KRAKEN_BASE}/OHLC?pair=${krakenSymbol}&interval=${intv}&since=0`;
  const r = await safeFetch(url, {}, true);
  const j = await r.json();
  // j.result has pair key
  const keys = Object.keys(j.result || {});
  if (!keys.length) throw new Error("Kraken result empty");
  const arr = j.result[keys[0]]; // entries: [time, open, high, low, close, vwap, volume, count]
  const slice = arr.slice(-limit);
  return slice.map(k => ({ time: k[0]*1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[6] }));
}

// 4) Bitstamp OHLC fallback
async function fetchKlinesBitstamp(symbol, interval="15m", limit=80) {
  // bitstamp has minute resolution endpoint: /v2/ohlc/{currency_pair}/?step=60&limit=1000
  const stepMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const step = stepMap[interval] || 900;
  const url = `${BITSTAMP_BASE}/v2/ohlc/${symbol}/?step=${step}&limit=${limit}`;
  const r = await safeFetch(url, {}, true);
  const j = await r.json();
  if (!j?.data?.ohlc) throw new Error("Bitstamp invalid response");
  const arr = j.data.ohlc;
  const sorted = arr.slice(-limit).sort((a,b)=>a.timestamp - b.timestamp);
  return sorted.map(k => ({ time: k.timestamp*1000, open:+k.open, high:+k.high, low:+k.low, close:+k.close, volume:+k.volume }));
}

// 5) CoinGecko OHLC fallback (no volume)
async function fetchKlinesCoinGecko(id="bitcoin", interval="15m", limit=80) {
  const url = `${COINGECKO_BASE}/coins/${id}/ohlc?vs_currency=usd&days=1`;
  const r = await safeFetch(url, {}, true);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("CoinGecko invalid");
  const slice = j.slice(-limit);
  return slice.map(k => ({ time: +k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume: 0 }));
}

// Unified multi-source fetch that tries in order and returns {data, source}
async function fetchKlinesUnified(symbolRaw, interval="15m", limit=80) {
  const { binSymbol, coinbaseSymbol, coingecko, krakenSymbol, bitstampSymbol } = SYMBOLS;
  // 1) Binance
  try {
    const bin = await fetchKlinesBinance(binSymbol, interval, limit);
    if (bin && bin.length >= Math.max(10, Math.floor(limit/2))) return { data: bin, source: "Binance" };
  } catch(e) { console.warn("Binance fail:", e.message); }
  // 2) Coinbase
  try {
    const cb = await fetchKlinesCoinbase(coinbaseSymbol, interval, limit);
    if (cb && cb.length >= Math.max(6, Math.floor(limit/3))) return { data: cb, source: "Coinbase" };
  } catch(e) { console.warn("Coinbase fail:", e.message); }
  // 3) Kraken
  try {
    const kr = await fetchKlinesKraken(krakenSymbol, interval, limit);
    if (kr && kr.length >= Math.max(6, Math.floor(limit/3))) return { data: kr, source: "Kraken" };
  } catch(e) { console.warn("Kraken fail:", e.message); }
  // 4) Bitstamp
  try {
    const bs = await fetchKlinesBitstamp(bitstampSymbol, interval, limit);
    if (bs && bs.length >= Math.max(6, Math.floor(limit/3))) return { data: bs, source: "Bitstamp" };
  } catch(e) { console.warn("Bitstamp fail:", e.message); }
  // 5) CoinGecko
  try {
    const cg = await fetchKlinesCoinGecko(coingecko, interval, limit);
    if (cg && cg.length) return { data: cg, source: "CoinGecko" };
  } catch(e) { console.warn("CoinGecko fail:", e.message); }
  return { data: [], source: "None" };
}

// ---------- News & social fetchers ----------
async function fetchRSS(url, limit=6) {
  try {
    const r = await safeFetch(url, {}, true);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g,"").trim();
    });
  } catch(e) { console.warn("fetchRSS fail", url, e.message); return []; }
}
async function fetchHeadlines() {
  const a = await Promise.allSettled([
    fetchRSS("https://cointelegraph.com/rss"),
    fetchRSS("https://www.coindesk.com/arc/outboundfeeds/rss/")
  ]);
  const out = [];
  for (const s of a) if (s.status === "fulfilled") out.push(...s.value);
  return out.slice(0,6).map(t => ({ title: t }));
}
async function fetchReddit(limit=8) {
  try {
    const r = await safeFetch(`https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`);
    const j = await r.json();
    if (!j?.data?.children) return [];
    return j.data.children.map(c => ({ title: c.data.title||"", ups: c.data.ups||0 }));
  } catch(e) { console.warn("fetchReddit fail", e.message); return []; }
}
async function fetchNitter(q="bitcoin", limit=6) {
  try {
    const url = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`;
    const r = await safeFetch(url, {}, true);
    const html = await r.text();
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    return matches.slice(0,limit).map(m => m[1].replace(/<[^>]+>/g,"").trim());
  } catch(e) { console.warn("fetchNitter fail", e.message); return []; }
}

// ---------- analysis helpers ----------
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((acc,k)=>acc + (k.volume || 0), 0);
  return s / slice.length;
}
function calcVolSent(klines) {
  let buy=0, sell=0;
  for (const k of klines) { if (k.close > k.open) buy += (k.volume||0); else sell += (k.volume||0); }
  const tot = buy + sell || 1;
  const buyPct = (buy/tot)*100, sellPct = (sell/tot)*100;
  const bias = buyPct > sellPct ? "Bullish" : buyPct < sellPct ? "Bearish" : "Neutral";
  return { buyPct, sellPct, bias, diff: Math.abs(buyPct - sellPct) };
}
function calcFib(kl) {
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
function atr(klines, period=14) {
  if (!klines || klines.length < period+1) return null;
  const trs = [];
  for (let i=1;i<klines.length;i++){
    const cur=klines[i], prev=klines[i-1];
    const tr = Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((a,b)=>a+b,0);
  return sum / period;
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
function detectCandlePatternSingle(last, prev) {
  if (!last) return { isDoji:0, isHammer:0, isShooting:0, body:0, range:0 };
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > (prev?prev.close:last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < (prev?prev.close:last.open);
  return { isDoji:isDoji?1:0, isHammer:isHammer?1:0, isShooting:isShooting?1:0, body, range };
}
function getTargetsAndSL(price, dir="Neutral", atrVal=null, fib=null) {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  // prefer fib levels if available for entries; use ATR for move sizing
  const move = (atrVal && isFinite(atrVal)) ? atrVal : price*0.005;
  if (dir.includes("Bull")) {
    const tp1 = (price + move).toFixed(2);
    const tp2 = (price + move*1.8).toFixed(2);
    const tp3 = (price + move*3).toFixed(2);
    const sl = (price - (move * 0.8)).toFixed(2);
    return { tp1, tp2, tp3, sl };
  } else if (dir.includes("Bear")) {
    const tp1 = (price - move).toFixed(2);
    const tp2 = (price - move*1.8).toFixed(2);
    const tp3 = (price - move*3).toFixed(2);
    const sl = (price + (move * 0.8)).toFixed(2);
    return { tp1, tp2, tp3, sl };
  } else return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
}

// ---------- accuracy store ----------
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while (arr.length > 120) arr.shift();
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

// ---------- ML module ----------
function mlLoad() {
  try { if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8")); }
  catch(e){ console.warn("mlLoad", e.message); }
  return { w:null, bias:0, n_features:0, lr:0.02, l2:0.0001, trained:0, threshold: ML_ALERT_THRESH };
}
function mlSave() { try { fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(ML,null,2)); } catch(e) { console.warn("mlSave", e.message); } }
let ML = mlLoad();
function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave();
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
  if (ML.trained % 5 === 0) mlSave();
  return p;
}
function biasToSign(biasStr) {
  if (!biasStr) return 0;
  const s = biasStr.toString().toLowerCase();
  if (s.includes("bull")) return 1;
  if (s.includes("bear")) return -1;
  return 0;
}
function mlExtractFeatures({klines15, lastCandle, avgVol20=1, divergenceSign=0, ellConf=0, systemBias=0}) {
  const first = (klines15 && klines15[0]) || lastCandle || { close:0 };
  const last = lastCandle || (klines15 && klines15.at(-1)) || { close:0, open:0, volume:1 };
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePatternSingle(last, klines15 && klines15.at(-2));
  return [
    slope15,
    lastDeltaP,
    volRatio - 1,
    patt.isDoji||0,
    patt.isHammer||0,
    patt.isShooting||0,
    divergenceSign||0,
    (ellConf||0) / 100,
    systemBias||0
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
  } catch(e) { console.warn("Self-ping failed", e.message); }
}

// ---------- Reversal watcher ----------
let lastRevAt = 0;
const REV_COOLDOWN_MS = 90 * 1000;
async function reversalWatcherOnce() {
  try {
    const { data: kl1, source } = await fetchKlinesUnified(RAW_SYMBOL, "1m", LIMITS["1m"]);
    if (!kl1 || kl1.length < 5) return;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = avgVolume(kl1, 20) || 1;
    const patt = detectCandlePatternSingle(last, prev);
    const volSpike = last.volume > avgVol * 1.5;
    const now = Date.now();
    if (now - lastRevAt < REV_COOLDOWN_MS) return;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (reason) {
      lastRevAt = now;
      const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
      const feat = mlExtractFeatures({ klines15: kl1.slice(-40), lastCandle: last, avgVol20: avgVol, divergenceSign:0, ellConf:0, systemBias:0 });
     const prob = mlPredict(feat);
      const txt = `🚨 <b>Reversal Watcher</b>\n${nowStr()}\nSymbol: <b>${RAW_SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b>\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgVol)})\nPrice: ${last.close.toFixed(2)}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(txt);
      // Soft training: label 1 if prob>threshold else 0 (heuristic)
      try { mlTrain(feat, prob > (ML.threshold || ML_ALERT_THRESH) ? 1 : 0); } catch(e){ console.warn("mlTrain error", e.message); }
    }
  } catch(e) { console.warn("reversalWatcherOnce error", e.message); }
}

// ---------- Main analyze & report ----------
async function analyzeAndReport() {
  try {
    const tfData = {}, sourcesUsed = {};
    for (const tf of TIMEFRAMES) {
      let { data, source } = await fetchKlinesUnified(RAW_SYMBOL, tf, LIMITS[tf] || 80);
      // Force extra fallbacks if data too small
      if ((!data || data.length < 6) && source === "Binance") {
        try {
          const cb = await fetchKlinesCoinbase(SYMBOLS.coinbaseSymbol, tf, LIMITS[tf] || 80);
          if (cb && cb.length >= 6) { data = cb; source = "Coinbase"; }
        } catch(e) { /* ignore */ }
      }
      if ((!data || data.length < 6) && source !== "CoinGecko") {
        try {
          const cg = await fetchKlinesCoinGecko(SYMBOLS.coingecko, tf, LIMITS[tf] || 80);
          if (cg && cg.length) { data = cg; source = "CoinGecko"; }
        } catch(e) {}
      }
      tfData[tf] = data || [];
      sourcesUsed[tf] = source || "None";
    }

    const base = tfData["15m"] || [];
    if (!base || base.length < 8) {
      const txt = `❗ Not enough 15m candles (${(base||[]).length}) — skipping (${nowStr()})`;
      console.warn(txt);
      await sendTG(txt);
      return;
    }

    const lastPrice = base.at(-1).close;
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base, 14);

    // per-TF
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

    // news & socials
    const [newsRes, redditRes, nitterRes] = await Promise.allSettled([fetchHeadlines(), fetchReddit(8), fetchNitter("bitcoin",8)]);
    const newsArr = newsRes.status==="fulfilled"? newsRes.value : [];
    const redditArr = redditRes.status==="fulfilled"? redditRes.value : [];
    const tweetsArr = nitterRes.status==="fulfilled"? nitterRes.value : [];

    // news sentiment heuristic
    const posK = ["surge","approval","bull","bullish","gain","rally","soar","support","up","rise","positive","etf"];
    const negK = ["bear","dump","selloff","crash","fear","ban","hack","lawsuit","negative","fall","liquidation"];
    let newsScore = 0;
    for (const n of newsArr) {
      const t = (n.title||"").toLowerCase();
      for (const k of posK) if (t.includes(k)) newsScore += 1;
      for (const k of negK) if (t.includes(k)) newsScore -= 1;
    }
    let newsImpact = "Low";
    if (Math.abs(newsScore) >= 3) newsImpact = "High";
    else if (Math.abs(newsScore) >= 1) newsImpact = "Medium";

    // merge signals
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct)/100 ));
    const newsNorm = Math.max(-1, Math.min(1, newsScore/6 ));
    let redditScoreVal = 0;
    for (const r of redditArr) { redditScoreVal += (r.title? ((/bull/i.test(r.title)?1:(/bear/i.test(r.title)?-1:0)) ) : 0); }
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal/6 ));
    const COMBINED = 0.55*techNorm + 0.30*newsNorm + 0.15*socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const confidencePct = Math.round(Math.min(99, Math.abs(COMBINED) * 100));
    if (label.includes("Bull")) bull++;
    if (label.includes("Bear")) bear++;

    // targets & breakout
    const tgs = getTargetsAndSL(lastPrice, label, atrVal, fib);
    const breakoutRange = (fib && isFinite(fib.fib382) && isFinite(fib.fib618)) ? `${fib.fib618.toFixed(2)} - ${fib.fib382.toFixed(2)}` : "N/A";

    // ML: train on previous saved pred (if exists)
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15 && typeof prev.pred !== "undefined") {
          const prevClose = prev.prevClose || 0;
          const actual = lastPrice > prevClose ? "Bullish" : lastPrice < prevClose ? "Bearish" : "Neutral";
          const labelTrain = (prev.pred === actual) ? 1 : 0;
          const featPrev = mlExtractFeatures({
            klines15: prev.klines15,
            lastCandle: prev.klines15.at(-1),
            avgVol20: avgVolume(prev.klines15,20),
            divergenceSign: prev.divSign||0,
            ellConf: prev.ellConf||0,
            systemBias: biasToSign(prev.pred)
          });
          const probBefore = mlPredict(featPrev);
          mlTrain(featPrev, labelTrain);
          console.log("ML trained on previous prediction label", labelTrain, "probBefore", probBefore.toFixed(3));
        }
      }
    } catch(e) { console.warn("ML train prev error", e.message); }

    // ML predict current
    const feat = mlExtractFeatures({
      klines15: base.slice(-40),
      lastCandle: base.at(-1),
      avgVol20: avgVolume(base,20),
      divergenceSign: bull>bear?1:(bear>bull?-1:0),
      ellConf: 0,
      systemBias: biasToSign(label)
    });
    const mlProb = mlPredict(feat);

    // save last pred
    try {
      const lastPredPayload = {
        pred: label,
        prevClose: lastPrice,
        klines15: base.slice(-40),
        divSign: bull>bear?1:(bear>bull?-1:0),
        ellConf: 0,
        ts: Date.now()
      };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload,null,2));
    } catch(e) { console.warn("save last pred error", e.message); }

    // update accuracy
    try {
      if (fs.existsSync(LAST_REPORT_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_REPORT_FILE,"utf8"));
        if (prev && prev.pred && typeof prev.prevClose !== "undefined") {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(LAST_REPORT_FILE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() },null,2));
    } catch(e) { console.warn("acc update", e.message); }

    // construct message
    let msg = `<b>🤖 ${RAW_SYMBOL} — AI Trader v8.8 (Full ML)</b>\n🕒 ${nowStr()}\n`;
    msg += perTfText + "\n\n";
    msg += `🎯 <b>Targets & Zones</b>\nTP1: ${tgs.tp1} | TP2: ${tgs.tp2} | TP3: ${tgs.tp3}\nSL: ${tgs.sl}\nBreakout: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Bias:</b> ${label} | Confidence: ${confidencePct}% | ML Prob: ${(mlProb*100).toFixed(1)}% (thr ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n💰 Price: ${lastPrice.toFixed(2)} | ATR(14): ${(atrVal||0).toFixed(2)}\n📈 Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}% | Accuracy(last10): ${getAccLocal(10)}%\n📰 News Impact: ${newsImpact}\nSources: ${Object.values(sourcesUsed).join(", ")}\n\n`;
    if (newsArr.length) { msg += "<b>Headlines:</b>\n"; for (const n of newsArr) msg += `• ${n.title}\n`; }
    else msg += "<b>Headlines:</b> None\n";
    msg += `\n🔎 Reversal Watcher active. ML alerts will be sent when conditions & prob exceed threshold.\n`;

    // ML alert addition
    if (mlProb >= (ML.threshold || ML_ALERT_THRESH) && confidencePct >= 40) {
      msg += `\n🚨 <b>ML Smart Alert</b>: ${(mlProb*100).toFixed(1)}% chance of ${label} — watch breakout range\n`;
    }

    await sendTG(msg);

  } catch (e) {
    console.error("analyzeAndReport error", e.message);
    try { await sendTG(`❗ Error in analyzeAndReport: ${e.message}`); } catch(_) {}
  }
}

// ---------- LOOP START ----------
async function startAll() {
  // ensure ML init
  mlInit(9);
  // immediate runs
  await analyzeAndReport();
  await reversalWatcherOnce();
  // intervals
  setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
  if (SELF_PING_URL) setInterval(selfPing, 5 * 60 * 1000);
}

// ---------- Express keepalive ----------
const app = express();
app.get("/", (_, res) => res.send("AI Trader v8.8 running"));
app.get("/check", async (_, res) => {
  try { await analyzeAndReport(); res.json({ ok:true }); } catch(e){ res.status(500).json({ ok:false, err:e.message }); }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAll().catch(e=>console.error("startAll error", e.message));
});
// === Telegram Command System ===
  initTelegramCommands({
  SYMBOL,
  analyzeAndReport,
  fetchHeadlines,
  reversalWatcherOnce
});