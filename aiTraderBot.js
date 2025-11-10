/**
 * ai_trader_v9_3.js
 * AI Trader v9.3 (Hybrid Extended) - Text-only version
 *
 * Usage:
 *   Install deps: npm install
 *   Run: BOT_TOKEN=xxx CHAT_ID=yyy node ai_trader_v9_3.js
 *
 * Env:
 *   BOT_TOKEN, CHAT_ID, SYMBOL, CHECK_INTERVAL_MIN, REV_CHECK_INTERVAL_SEC,
 *   ML_ALERT_THRESH, RENDER_EXTERNAL_URL, PORT
 */

const fs = require("fs");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || ""; // default chat id to push messages
const SYMBOL_RAW = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const SERVER_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);

// Fallback endpoints / proxies
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

// Storage files (persist)
const ML_FILE = "./ml_model_v93.json";
const ACC_FILE = "./acc_v93.json";
const REV_FILE = "./reversals_v93.json";
const STATE_FILE = "./state_v93.json";

// ---------- UTIL ----------
function nowStr() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeChunk(text, n = 3800) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
async function safeFetchText(url, opts = {}) {
  try {
    const r = await axios.get(url, { timeout: 12000, responseType: "text", ...opts });
    return r.data;
  } catch (e) {
    // try proxies
    for (const p of PROXY_PREFIXES) {
      try {
        const r = await axios.get(p + encodeURIComponent(url), { timeout: 12000 });
        return r.data;
      } catch (e2) { /* continue */ }
    }
    throw new Error("All fetch attempts failed for " + url + " => " + (e && e.message));
  }
}

// ---------- SYMBOL NORMALIZE ----------
function normalizeSymbols(raw) {
  const up = (raw || "BTCUSDT").toUpperCase().replace(/[-_]/g, "");
  let coinbase;
  if (up.endsWith("USDT")) coinbase = `${up.slice(0, -4)}-USD`;
  else if (up.endsWith("USD")) coinbase = `${up.slice(0, -3)}-USD`;
  else coinbase = up.replace(/(.{3})(.*)/, "$1-$2") + "-USD";
  // simple coingecko guess
  let cg = "bitcoin";
  if (/^BTC/.test(up)) cg = "bitcoin";
  else if (/^ETH/.test(up)) cg = "ethereum";
  else cg = up.slice(0, 3).toLowerCase();
  return { bin: up, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(SYMBOL_RAW);
const SYMBOL = SYMBOLS.bin;

// ---------- ML (light online logistic) ----------
let ML = { w: null, bias: 0, n: 0, lr: 0.02, l2: 0.0001, trained: 0, threshold: ML_ALERT_THRESH };

function loadML() {
  try {
    if (fs.existsSync(ML_FILE)) {
      const j = JSON.parse(fs.readFileSync(ML_FILE, "utf8"));
      ML = Object.assign(ML, j);
      console.log("ML loaded:", ML.n, "trained:", ML.trained);
    } else console.log("ML file not found, init later.");
  } catch (e) { console.warn("loadML err", e.message); }
}
function saveML() {
  try { fs.writeFileSync(ML_FILE, JSON.stringify(ML, null, 2)); } catch (e) { console.warn("saveML err", e.message); }
}
function mlInit(n) {
  if (!ML.w || ML.n !== n) {
    ML.n = n;
    ML.w = new Array(n).fill(0).map(() => (Math.random() * 0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    saveML();
    console.log("ML init n=", n);
  }
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  let z = ML.bias;
  for (let i = 0; i < features.length; i++) z += (ML.w[i] || 0) * (features[i] || 0);
  return sigmoid(z);
}
function mlTrainOnline(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const p = mlPredict(features);
  const err = label - p;
  const lr = ML.lr || 0.02, l2 = ML.l2 || 0.0001;
  for (let i = 0; i < features.length; i++) {
    ML.w[i] += lr * (err * features[i] - l2 * (ML.w[i] || 0));
  }
  ML.bias += lr * err;
  ML.trained = (ML.trained || 0) + 1;
  if (ML.trained % 5 === 0) saveML();
  return p;
}

// ---------- small accuracy store ----------
function pushAcc(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, "utf8")) : [];
    arr.push(correct ? 1 : 0);
    while (arr.length > 100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { console.warn("pushAcc err", e.message); }
}
function getAccuracy(n = 10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, "utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-n);
    const sum = slice.reduce((a, b) => a + b, 0);
    return ((sum / slice.length) * 100).toFixed(1);
  } catch (e) { return "N/A"; }
}

// ---------- Multi-source klines ----------
async function fetchKlinesBinance(symbol, interval = "15m", limit = 80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/, "") + path;
      const r = await axios.get(url, { timeout: 10000 });
      if (!Array.isArray(r.data)) throw new Error("non-array");
      const mapped = r.data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
      return { data: mapped, source: "Binance" };
    } catch (e) {
      console.warn("Binance mirror failed:", e.message);
      continue;
    }
  }
  throw new Error("All Binance mirrors failed");
}
async function fetchKlinesCoinbase(coinbaseSymbol, interval = "15m", limit = 80) {
  const granMap = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 };
  const gran = granMap[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}&limit=${limit}`;
  try {
    const r = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(r.data)) throw new Error("coinbase no array");
    const sorted = r.data.slice(-limit).sort((a, b) => a[0] - b[0]);
    const mapped = sorted.map(k => ({ time: k[0] * 1000, open: +k[3], high: +k[2], low: +k[1], close: +k[4], volume: +(k[5] || 0) }));
    return { data: mapped, source: "Coinbase" };
  } catch (e) { throw new Error("Coinbase failed: " + e.message); }
}
async function fetchKlinesCoinGecko(cgid = "bitcoin", interval = "15m", limit = 80) {
  try {
    // coingecko returns daily OHLC, so limited usefulness — still provide fallback
    const url = `https://api.coingecko.com/api/v3/coins/${cgid}/ohlc?vs_currency=usd&days=1`;
    const r = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(r.data)) throw new Error("coingecko invalid");
    const slice = r.data.slice(-limit);
    const mapped = slice.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: 0 }));
    return { data: mapped, source: "CoinGecko" };
  } catch (e) { throw new Error("CoinGecko failed: " + e.message); }
}
async function fetchKlines(interval = "15m", limit = 80) {
  // Try Binance -> Coinbase -> CoinGecko
  try { return await fetchKlinesBinance(SYMBOL, interval, limit); } catch (e) { console.warn("binance fail:", e.message); }
  try { return await fetchKlinesCoinbase(SYMBOLS.coinbase, interval, limit); } catch (e) { console.warn("coinbase fail:", e.message); }
  try { return await fetchKlinesCoinGecko(SYMBOLS.cg, interval, limit); } catch (e) { console.warn("coingecko fail:", e.message); }
  return { data: [], source: "None" };
}

// ---------- News / Social (simple) ----------
async function fetchRSSHeadlines(url, limit = 6) {
  try {
    const txt = await safeFetchText(url);
    const items = txt.split("<item>").slice(1, limit + 1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    });
  } catch (e) { console.warn("fetchRSSHeadlines fail:", e.message); return []; }
}
async function fetchHeadlines() {
  const out = [];
  try { out.push(...(await fetchRSSHeadlines("https://cointelegraph.com/rss", 6))); } catch (e) { }
  try { out.push(...(await fetchRSSHeadlines("https://www.coindesk.com/arc/outboundfeeds/rss/", 6))); } catch (e) { }
  return out.slice(0, 8);
}
async function fetchReddit(limit = 8) {
  try {
    const r = await axios.get(`https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`, { timeout: 10000 });
    if (!r.data?.data?.children) return [];
    return r.data.data.children.map(c => c.data.title || "");
  } catch (e) { console.warn("fetchReddit fail", e.message); return []; }
}
async function fetchNitter(q = "bitcoin", limit = 6) {
  try {
    const html = await safeFetchText(`https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`);
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    if (!matches.length) return [];
    return matches.slice(0, limit).map(m => m[1].replace(/<[^>]+>/g, "").trim());
  } catch (e) { console.warn("fetchNitter fail", e.message); return []; }
}

// ---------- Technical indicators ----------
function emaArray(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function calcRSI(kl, period = 14) {
  if (!kl || kl.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < kl.length; i++) {
    const diff = kl[i].close - kl[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / (kl.length - 1);
  const avgLoss = losses / (kl.length - 1) || 0.000001;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
function calcMACD(kl, short = 12, long = 26, signal = 9) {
  const closes = kl.map(k => k.close);
  if (closes.length < long) return { macd: 0, signal: 0, hist: 0 };
  const emaShort = emaArray(closes, short);
  const emaLong = emaArray(closes, long);
  const offset = emaShort.length - emaLong.length;
  const macdLine = emaShort.slice(offset).map((v, i) => v - emaLong[i]);
  const signalLine = emaArray(macdLine, signal);
  const hist = (macdLine.at(-1) || 0) - (signalLine.at(-1) || 0);
  return { macd: macdLine.at(-1) || 0, signal: signalLine.at(-1) || 0, hist: hist || 0 };
}
function atr(kl, period = 14) {
  if (!kl || kl.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < kl.length; i++) {
    const cur = kl[i], prev = kl[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}
function calcFibLevels(kl) {
  if (!kl || kl.length === 0) return null;
  const highs = kl.map(k => k.high), lows = kl.map(k => k.low);
  const H = Math.max(...highs), L = Math.min(...lows), R = H - L || 1;
  return { high: H, low: L, fib236: H - R * 0.236, fib382: H - R * 0.382, fib5: H - R * 0.5, fib618: H - R * 0.618, fib786: H - R * 0.786 };
}

// Candle pattern detection (simple)
function detectCandlePatternSingle(last, prev) {
  if (!last) return { isDoji: 0, isHammer: 0, isShooting: 0, body: 0, range: 0 };
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > (prev ? prev.close : last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < (prev ? prev.close : last.open);
  return { isDoji: isDoji ? 1 : 0, isHammer: isHammer ? 1 : 0, isShooting: isShooting ? 1 : 0, body, range };
}

// ---------- features for ML ----------
function avgVolume(kl, n = 20) {
  if (!kl || !kl.length) return 1;
  const slice = kl.slice(-n);
  const s = slice.reduce((a, b) => a + (b.volume || 0), 0);
  return s / slice.length;
}
function mlExtractFeatures({ klines15, lastCandle, avgVol20 = 1, divergenceSign = 0, ellConf = 0, systemBias = 0 }) {
  const first = (klines15 && klines15[0]) || lastCandle;
  const last = lastCandle || (klines15 && klines15.at(-1));
  const slope15 = ((last.close - (first.close || last.close)) / (first.close || 1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open || 1)) * 100;
  const volRatio = avgVol20 > 0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePatternSingle(last, klines15 && klines15.at(-2));
  const rsi = calcRSI(klines15, 14);
  const mac = calcMACD(klines15, 12, 26, 9);
  return [
    slope15,
    lastDeltaP,
    volRatio - 1,
    patt.isDoji || 0,
    patt.isHammer || 0,
    patt.isShooting || 0,
    divergenceSign || 0,
    (ellConf || 0) / 100,
    systemBias || 0,
    (rsi - 50) / 50,
    mac.hist / (Math.abs(last.close) || 1)
  ];
}

// ---------- Reversal watcher + pending store ----------
let pendingReversals = [];
try { if (fs.existsSync(REV_FILE)) pendingReversals = JSON.parse(fs.readFileSync(REV_FILE, "utf8")); } catch (e) { pendingReversals = []; }
function saveReversals() { try { fs.writeFileSync(REV_FILE, JSON.stringify(pendingReversals.slice(-200), null, 2)); } catch (e) { } }

// send telegram helper
const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
async function sendTelegram(text, parse_mode = "HTML", chat = CHAT_ID) {
  if (!BOT_TOKEN) {
    console.log("[TG MOCK] ", text);
    return;
  }
  try {
    const parts = safeChunk(text, 3800);
    for (const p of parts) {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chat, text: p, parse_mode, disable_web_page_preview: true });
      await sleep(200);
    }
  } catch (e) {
    console.warn("sendTelegram err", e.message);
  }
}

// single-run reversal watcher
async function reversalWatcherOnce() {
  try {
    const { data: kl1, source } = await fetchKlines("1m", 120);
    if (!kl1 || kl1.length < 3) return null;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = avgVolume(kl1, 20) || 1;
    const patt = detectCandlePatternSingle(last, prev);
    const volSpike = last.volume > avgVol * 1.5;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (!reason) return null;
    const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
    const feat = mlExtractFeatures({ klines15: kl1.slice(-40), lastCandle: last, avgVol20: avgVol, divergenceSign: 0, ellConf: 0, systemBias: 0 });
    const prob = mlPredict(feat);
    const msg = `\u26A0\uFE0F <b>Reversal Watcher (v9.3)</b>\n${nowStr()}\nSymbol: <b>${SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b> | Direction: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgVol)})\nML Prob: ${(prob * 100).toFixed(1)}%`;
    await sendTelegram(msg);
    pendingReversals.push({ time: Date.now(), reason, dir, prob, price: last.close, feat });
    saveReversals();
    // quick training for very confident cases
    if (prob > 0.98) mlTrainOnline(feat, 1);
    if (prob < 0.02) mlTrainOnline(feat, 0);
    console.log("Reversal alert sent:", reason, "prob", (prob * 100).toFixed(1));
    return { reason, dir, prob };
  } catch (e) {
    console.warn("reversalWatcherOnce err", e.message);
    return null;
  }
}

// review pending reversals after 8+ minutes and auto-train
async function checkPendingReversals() {
  if (!pendingReversals.length) return;
  const now = Date.now();
  const keep = [];
  for (const ev of pendingReversals) {
    if (now - ev.time < 8 * 60 * 1000) { keep.push(ev); continue; } // wait 8 min
    try {
      const { data } = await fetchKlines("1m", 200);
      if (!data || !data.length) { keep.push(ev); continue; }
      const startPrice = ev.price;
      const min = Math.min(...data.map(k => k.low));
      const max = Math.max(...data.map(k => k.high));
      let success = false;
      if (ev.dir === "Bullish" && max >= startPrice * 1.004) success = true;
      if (ev.dir === "Bearish" && min <= startPrice * 0.996) success = true;
      mlTrainOnline(ev.feat, success ? 1 : 0);
      pushAcc(success ? 1 : 0);
      console.log("Auto-trained reversal:", success ? "success" : "fail");
    } catch (e) {
      console.warn("checkPendingReversals err", e.message);
      keep.push(ev);
    }
  }
  pendingReversals = keep;
  saveReversals();
}

// ---------- Multi-TF report (main) ----------
async function analyzeAndReport() {
  try {
    // get klines for each tf (in parallel)
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const fetches = await Promise.all(tfs.map(tf => fetchKlines(tf, 200).catch(e => ({ data: [], source: "none", err: e.message }))));
    // compute tech stats per tf
    const tfStats = {};
    for (let i = 0; i < tfs.length; i++) {
      const tf = tfs[i];
      const res = fetches[i];
      const kl = res.data || [];
      const src = res.source || "none";
      const last = kl.at(-1) || { open: 0, close: 0, high: 0, low: 0, volume: 0 };
      const rsi = calcRSI(kl, 14);
      const mac = calcMACD(kl, 12, 26, 9);
      const atr14 = atr(kl, 14);
      tfStats[tf] = { kl, src, last, rsi: Number(rsi.toFixed(1)), macHist: Number((mac.hist || 0).toFixed(3)), atr14: Number((atr14 || 0).toFixed(2)) };
    }

    // pick primary source (prefer Binance)
    const primarySource = Object.values(tfStats).find(s => s.src && s.src.toLowerCase().includes("binance")) ? "Binance" : (fetches[0].source || "Unknown");

    // aggregate tech volume (simplified): buy/sell percent approx from closes slope last few candles
    function techVol(kl) {
      if (!kl || kl.length < 6) return { buyPct: 50, sellPct: 50 };
      const last6 = kl.slice(-6);
      const ups = last6.filter((c, i, a) => c.close > (i ? a[i - 1].close : c.open)).length;
      const buys = Math.round((ups / last6.length) * 100);
      return { buyPct: buys, sellPct: 100 - buys };
    }
    const techVols = {};
    Object.keys(tfStats).forEach(tf => techVols[tf] = techVol(tfStats[tf].kl));

    // avg vol
    const avgVol20 = avgVolume(tfStats["15m"].kl || [], 20);

    // extract ML features from 15m
    const feat = mlExtractFeatures({ klines15: tfStats["15m"].kl || [], lastCandle: tfStats["15m"].last, avgVol20 });
    const mlProb = mlPredict(feat);
    // merge simple label from combined tech (weighted)
    const techCombined = (techVols["15m"].buyPct - techVols["15m"].sellPct) / 100;
    const newsList = await fetchHeadlines();
    const reddit = await fetchReddit(6);
    const tweets = await fetchNitter(SYMBOL.slice(0, 6), 6);
    const newsImpact = (newsList.length > 0 ? "Medium" : "Low");

     // targets (simple hybrid: ATR + fib + recent high/low)
    const fib = calcFibLevels(tfStats["1h"].kl || tfStats["15m"].kl || []);
    const lastPrice = Number((tfStats["15m"].last.close || 0).toFixed(2));
    const atr15 = tfStats["15m"].atr14 || 0;
    const TP1 = lastPrice + atr15 * 0.5;
    const TP2 = lastPrice + atr15 * 1.0;
    const TP3 = lastPrice + atr15 * 1.5;
    const SL = lastPrice - atr15 * 1.0;

    // bias label
    let biasLabel = "Neutral";
    if (mlProb > 0.65 || techCombined > 0.15) biasLabel = "Bullish";
    if (mlProb < 0.35 || techCombined < -0.15) biasLabel = "Bearish";

    // compose message
    let msg = `<b>${SYMBOL} \u2014 AI Trader v9.3</b>\n${nowStr()}\nSource: ${primarySource}\nPrice: ${lastPrice}\n`;
    msg += `Tech Vol (15m): Buy ${techVols["15m"].buyPct}% / Sell ${techVols["15m"].sellPct}%\n`;
    msg += `RSI(15): ${tfStats["15m"].rsi} | MACD hist(15): ${tfStats["15m"].macHist} | ATR(15): ${tfStats["15m"].atr14}\n`;
    msg += `Bias: <b>${biasLabel}</b> | Confidence(ML): ${(mlProb * 100).toFixed(1)}% (thr ${ML.threshold})\n`;
    msg += `Accuracy(last10): ${getAccuracy(10)}%\n`;
    msg += `TP1: ${Number(TP1.toFixed(2))} | TP2: ${Number(TP2.toFixed(2))} | TP3: ${Number(TP3.toFixed(2))} | SL: ${Number(SL.toFixed(2))}\n`;
    if (fib) msg += `Breakout zone (low-high): ${Number(fib.low.toFixed(2))} - ${Number(fib.high.toFixed(2))}\n`;
    msg += `News headlines:\n`;
    for (const h of newsList.slice(0, 6)) msg += `\u2022 ${h}\n`;
    msg += `\nSources: ${Object.values(tfStats).map(s => s.src).filter(Boolean).join(", ")}\n`;
    await sendTelegram(msg);

    // store state snapshot for /status command
    const state = { time: Date.now(), symbol: SYMBOL, price: lastPrice, biasLabel, mlProb, techVols, lastReport: msg, news: newsList.slice(0, 6) };
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.warn("state save err", e.message); }

    return state;
  } catch (e) {
    console.warn("analyzeAndReport err", e.message);
    return null;
  }
}

// ---------- Bot commands (polling getUpdates) ----------
let tgOffset = 0;
let autoReportsEnabled = true;
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  try {
    const r = await axios.get(`${TG_API}/getUpdates`, { params: { timeout: 10, offset: tgOffset + 1 }, timeout: 20000 });
    if (r.data && r.data.result && r.data.result.length) {
      for (const upd of r.data.result) {
        tgOffset = Math.max(tgOffset, upd.update_id);
        await handleUpdate(upd);
      }
    }
  } catch (e) { console.warn("pollTelegram err", e.message); }
}
async function handleUpdate(update) {
  try {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const parts = text.split(" ");
    const cmd = parts[0].toLowerCase();
    console.log("Received cmd:", cmd, "from", chatId);
    if (cmd === "/start" || cmd === "/help") {
      const help = `🤖 AI Trader v9.3\nCommands:\n/start /help\n/status\n/predict\n/setthreshold <0-1>\n/autoon\n/autooff\nNote: Reports auto-send every ${CHECK_INTERVAL_MIN} minutes when enabled.`;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: help });
      return;
    }
    if (cmd === "/status") {
      try {
        const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : null;
        const acc = getAccuracy(10);
        const modelInfo = `ML trained steps: ${ML.trained || 0} | threshold: ${ML.threshold || ML_ALERT_THRESH}`;
        const txt = `<b>Status</b>\nTime: ${nowStr()}\nSymbol: ${SYMBOL}\nAccuracy(last10): ${acc}%\n${modelInfo}\n${state ? "\nLast price: " + state.price : ""}`;
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: txt, parse_mode: "HTML" });
      } catch (e) { console.warn("status send err", e.message); }
      return;
    }
    if (cmd === "/predict") {
      const s = await analyzeAndReport();
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: s ? "Predict done. Check channel." : "Predict failed." });
      return;
    }
    if (cmd === "/setthreshold") {
      const v = parseFloat(parts[1]);
      if (isNaN(v) || v <= 0 || v >= 1) {
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: "Usage: /setthreshold 0.5 (value between 0 and 1)" });
      } else {
        ML.threshold = v;
        saveML();
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `ML alert threshold set to ${v}` });
      }
      return;
    }
    if (cmd === "/autoon") {
      autoReportsEnabled = true;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports enabled every ${CHECK_INTERVAL_MIN} min.` });
      return;
    }
    if (cmd === "/autooff") {
      autoReportsEnabled = false;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports disabled.` });
      return;
    }
  } catch (e) {
    console.warn("handleUpdate err", e.message);
  }
}

// ---------- Self-ping to avoid Render spin-down ----------
async function selfPing() {
  if (!SELF_PING_URL) return;
  try {
    const url = SELF_PING_URL.startsWith("http") ? SELF_PING_URL : `https://${SELF_PING_URL}`;
    const r = await axios.get(url, { timeout: 8000 });
    console.log("Self-ping OK", r.status);
  } catch (e) { console.warn("selfPing err", e.message); }
}

// ---------- Init & scheduler ----------
loadML();

// small express server for health
const app = express();
app.get("/", (req, res) => res.send(`AI Trader v9.3 live - ${nowStr()}`));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(SERVER_PORT, () => console.log("Server listening on", SERVER_PORT));

// initial notify
(async () => {
  console.log("AI Trader v9.3 starting...", SYMBOL);
  await sendTelegram(`<b>AI Trader v9.3 started</b>\n${nowStr()}\nSymbol: ${SYMBOL}\nHost: Node`);
})();

// main loops
// 1) Reversal watcher every REV_CHECK_INTERVAL_SEC
setInterval(async () => {
  try {
    await reversalWatcherOnce();
    await checkPendingReversals();
  } catch (e) { console.warn("reversal loop err", e.message); }
}, Math.max(10, REV_CHECK_INTERVAL_SEC) * 1000);

// 2) Auto-report every CHECK_INTERVAL_MIN (minutes)
setInterval(async () => {
  try {
    if (autoReportsEnabled) {
      const s = await analyzeAndReport();
      if (s && CHAT_ID) {
        // optionally post summary additionally (we already send inside analyzeAndReport)
      }
    }
    // self ping to keep Render awake
    await selfPing();
  } catch (e) { console.warn("auto-report err", e.message); }
}, Math.max(1, CHECK_INTERVAL_MIN) * 60 * 1000);

// 3) Telegram poll (every 4s)
setInterval(async () => {
  try { await pollTelegram(); } catch (e) { console.warn("tg poll err", e.message); }
}, 4000);

// ensure on-start immediate run
(async () => {
  try { await analyzeAndReport(); } catch (e) { console.warn("initial analyze err", e.message); }
})();