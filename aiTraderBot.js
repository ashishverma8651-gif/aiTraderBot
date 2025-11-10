/**
 * aiTrader_v9_2.js
 * AI Trader v9.2 Extended
 *
 * Features:
 *  - Multi-source klines (Binance primary -> Coinbase -> CoinGecko)
 *  - Multi-TF analysis (1m,5m,15m,30m,1h)
 *  - Reversal watcher (1m) with multi-TF confirmation (1m+5m+15m)
 *  - Online ML (logistic) that can be trained from reversal outcomes
 *  - Hybrid targets: ATR + Fibonacci + simple Elliott placeholder
 *  - News, Reddit and Nitter scraping fallbacks (proxy-enabled)
 *  - Telegram bot commands (polling via bot API)
 *  - Self-ping for Render sleep prevention
 *
 * Run: BOT_TOKEN=xxx CHAT_ID=yyy node aiTrader_v9_2.js
 *
 * Files used / created:
 *   ml_model_v92.json
 *   last_pred_v92.json
 *   acc_v92.json
 *   reversal_events_v92.json
 *
 * Important: set BOT_TOKEN and CHAT_ID in environment / .env
 */

const fs = require("fs");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || ""; // default chat to push messages
const SYMBOL_RAW = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_THRESHOLD = parseFloat(process.env.ML_THRESHOLD || "0.70");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const SERVER_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// Binance endpoints (primary) and mirrors
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// proxies for HTML fetch fallback
const PROXY_PREFIXES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// File paths
const ML_FILE = "./ml_model_v92.json";
const LAST_PRED_FILE = "./last_pred_v92.json";
const ACC_FILE = "./acc_v92.json";
const REV_FILE = "./reversal_events_v92.json";

// ---------- UTIL ----------
function nowISO() { return new Date().toISOString(); }
function nowIndia() { return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunkText(text, n = 3800) {
  const res = [];
  for (let i = 0; i < text.length; i += n) res.push(text.slice(i, i + n));
  return res;
}
async function safeFetchText(url) {
  try {
    const r = await axios.get(url, { timeout: 12000, responseType: "text" });
    return r.data;
  } catch (e) {
    // try proxies
  }
  for (const p of PROXY_PREFIXES) {
    try {
      const r = await axios.get(p + encodeURIComponent(url), { timeout: 12000, responseType: "text" });
      return r.data;
    } catch (e) { /* continue */ }
  }
  throw new Error("All fetch attempts failed for " + url);
}

// ---------- SYMBOL NORMALIZATION ----------
function normalizeSymbols(raw) {
  const up = raw.toUpperCase().replace(/[-_]/g, "");
  const bin = up;
  let coinbase;
  if (bin.endsWith("USDT")) {
    coinbase = `${bin.slice(0, -4)}-USD`;
  } else if (bin.endsWith("USD")) {
    coinbase = `${bin.slice(0, -3)}-USD`;
  } else {
    coinbase = bin.replace(/(.{3})(.*)/, "$1-$2") + "-USD";
  }
  let cg = "bitcoin";
  if (/^BTC/.test(bin)) cg = "bitcoin";
  else if (/^ETH/.test(bin)) cg = "ethereum";
  else cg = bin.slice(0, 3).toLowerCase();
  return { bin, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(SYMBOL_RAW);
const SYMBOL = SYMBOLS.bin;

// ---------- ML (online logistic) ----------
let ML = { w: null, bias: 0, n: 0, lr: 0.02, l2: 0.0001, trained: 0, threshold: ML_THRESHOLD };
function mlLoad() {
  try {
    if (fs.existsSync(ML_FILE)) {
      const j = JSON.parse(fs.readFileSync(ML_FILE, "utf8"));
      ML = Object.assign(ML, j);
      console.log("ML loaded:", ML.n, "trained:", ML.trained);
    } else {
      console.log("No ML file, init.");
    }
  } catch (e) { console.warn("mlLoad", e.message); }
}
function mlSave() {
  try { fs.writeFileSync(ML_FILE, JSON.stringify(ML, null, 2)); } catch (e) { console.warn("mlSave", e.message); }
}
function mlInit(n) {
  if (!ML.w || ML.n !== n) {
    ML.n = n;
    ML.w = new Array(n).fill(0).map(() => (Math.random() * 0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave();
    console.log("ML initialized n=", n);
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
  if (ML.trained % 5 === 0) mlSave();
  return p;
}

// ---------- ACC storage ----------
function pushAcc(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, "utf8")) : [];
    arr.push(correct ? 1 : 0);
    while (arr.length > 200) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { console.warn("pushAcc", e.message); }
}
function getAccuracy(lastN = 10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE, "utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN);
    const sum = slice.reduce((a, b) => a + b, 0);
    return ((sum / slice.length) * 100).toFixed(1);
  } catch (e) { return "N/A"; }
}

// ---------- Multi-source Klines ----------
async function fetchKlinesBinance(symbol, interval = "15m", limit = 80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/, "") + path;
      const r = await axios.get(url, { timeout: 10000 });
      if (!Array.isArray(r.data)) throw new Error("non-array response");
      return { data: r.data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })), source: "Binance" };
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
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  const r = await axios.get(url, { timeout: 10000 });
  if (!Array.isArray(r.data)) throw new Error("coinbase no array");
  const sorted = r.data.slice(-limit).sort((a, b) => a[0] - b[0]);
  return { data: sorted.map(k => ({ time: k[0] * 1000, open: +k[3], high: +k[2], low: +k[1], close: +k[4], volume: +(k[5] || 0) })), source: "Coinbase" };
}
async function fetchKlinesCoinGecko(cgid = "bitcoin", interval = "15m", limit = 80) {
  const url = `https://api.coingecko.com/api/v3/coins/${cgid}/ohlc?vs_currency=usd&days=1`;
  const r = await axios.get(url, { timeout: 10000 });
  if (!Array.isArray(r.data)) throw new Error("coingecko invalid");
  const slice = r.data.slice(-limit);
  return { data: slice.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: 0 })), source: "CoinGecko" };
}

// Primary-first behavior (Binance preferred, fallback to other sources)
async function fetchKlines(symbolRaw, interval = "15m", limit = 80) {
  const { bin, coinbase, cg } = SYMBOLS;
  try {
    return await fetchKlinesBinance(bin, interval, limit);
  } catch (e) { console.warn("Binance fallback:", e.message); }
  try { return await fetchKlinesCoinbase(coinbase, interval, limit); } catch (e) { console.warn("Coinbase fallback:", e.message); }
  try { return await fetchKlinesCoinGecko(cg, interval, limit); } catch (e) { console.warn("CoinGecko fallback:", e.message); }
  return { data: [], source: "None" };
}

// ---------- News & Social ----------
async function fetchRSSHeadlines(url, limit = 6) {
  try {
    const txt = await safeFetchText(url);
    const items = txt.split("<item>").slice(1, limit + 1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    });
  } catch (e) { console.warn("fetchRSSHeadlines", e.message); return []; }
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
    return r.data.data.children.map(c => ({ title: c.data.title || "", ups: c.data.ups || 0, created_utc: c.data.created_utc }));
  } catch (e) { console.warn("fetchReddit", e.message); return []; }
}
async function fetchNitter(q = "bitcoin", limit = 6) {
  try {
    const html = await safeFetchText(`https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`);
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    if (!matches.length) return [];
    return matches.slice(0, limit).map(m => m[1].replace(/<[^>]+>/g, "").trim());
  } catch (e) { console.warn("fetchNitter", e.message); return []; }
}

// ---------- Technical functions ----------
function calcRSI(kl, period = 14) {
  if (!kl || kl.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < kl.length; i++) {
    const diff = kl[i].close - kl[i - 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / (kl.length - 1);
  const avgLoss = (losses || 0.000001) / (kl.length - 1);
  const rs = avgGain / (avgLoss || 0.000001);
  return 100 - (100 / (1 + rs));
}
function emaArray(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
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
  if (!kl || kl.length < period + 1) return null;
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
  if (!kl || !kl.length) return null;
  const highs = kl.map(k => k.high), lows = kl.map(k => k.low);
  const H = Math.max(...highs), L = Math.min(...lows), R = H - L || 1;
  return { high: H, low: L, fib236: H - R * 0.236, fib382: H - R * 0.382, fib5: H - R * 0.5, fib618: H - R * 0.618, fib786: H - R * 0.786 };
}

// permissive candle detection to match old behaviour
function detectCandlePatternSingle(last, prev) {
  if (!last) return { isDoji: 0, isHammer: 0, isShooting: 0, body: 0, range: 0 };
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 0.000001);
  const isDoji = body <= range * 0.20;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.35 && upperRatio < 0.35 && last.close >= (prev ? prev.close : last.open);
  const isShooting = upperRatio > 0.35 && lowerRatio < 0.35 && last.close <= (prev ? prev.close : last.open);
  return { isDoji: isDoji ? 1 : 0, isHammer: isHammer ? 1 : 0, isShooting: isShooting ? 1 : 0, body, range };
}

function avgVolume(klines, n = 20) {
  if (!klines || !klines.length) return 1;
  const slice = klines.slice(-n);
  const s = slice.reduce((a, b) => a + (b.volume || 0), 0);
  return s / slice.length;
}

// ---------- Feature extraction ----------
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

// ---------- Merge signals (old-like weights) ----------
function mergeSignals(techBuyPct, newsCount, redditScore, tweetScore, econCount) {
  const techNorm = Math.max(-1, Math.min(1, (techBuyPct - 50) / 50));
  const newsNorm = Math.max(-1, Math.min(1, (newsCount - 2) / 4));
  const socialNorm = Math.max(-1, Math.min(1, ((redditScore / 20) + (tweetScore / 20)) / 2));
  const econBoost = Math.min(1, econCount / 3) * 0.05;
  const combined = 0.7 * techNorm + 0.2 * newsNorm + 0.1 * socialNorm + econBoost;
  const label = combined > 0.08 ? "Bullish" : combined < -0.08 ? "Bearish" : Math.abs(combined) < 0.02 ? "Sideways" : "Neutral";
  const strength = Math.abs(combined);
  let newsImpact = "Low";
  if (Math.abs(newsNorm) > 0.5 || econCount >= 2) newsImpact = "High";
  else if (Math.abs(newsNorm) > 0.2) newsImpact = "Moderate";
  return { combined, label, strength, newsImpact };
}

// ---------- Self-ping ----------
async function selfPing() {
  if (!SELF_PING_URL) return;
  let url = SELF_PING_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  try {
    const r = await axios.get(url);
    console.log("[selfPing] status", r.status);
  } catch (e) { console.warn("[selfPing]", e.message); }
}

// ---------- Reversal watcher and auto-train ----------
let pendingReversals = [];
try { if (fs.existsSync(REV_FILE)) pendingReversals = JSON.parse(fs.readFileSync(REV_FILE, "utf8")); } catch (e) { pendingReversals = []; }
function savePendingReversals() { try { fs.writeFileSync(REV_FILE, JSON.stringify(pendingReversals.slice(-500), null, 2)); } catch (e) { } }

async function reversalWatcherOnce() {
  try {
    // fetch 1m + 5m + 15m quickly
    const k1 = await fetchKlines(SYMBOL, "1m", 120);
    if (!k1 || !k1.data || k1.data.length < 3) return null;
    const k5 = await fetchKlines(SYMBOL, "5m", 120).catch(() => ({ data: [], source: "none" }));
    const k15 = await fetchKlines(SYMBOL, "15m", 120).catch(() => ({ data: [], source: "none" }));
    const last1 = k1.data.at(-1), prev1 = k1.data.at(-2);
    const avgVol1 = avgVolume(k1.data, 20) || 1;
    const patt1 = detectCandlePatternSingle(last1, prev1);
    const patt5 = k5.data.length ? detectCandlePatternSingle(k5.data.at(-1), k5.data.at(-2)) : {};
    const patt15 = k15.data.length ? detectCandlePatternSingle(k15.data.at(-1), k15.data.at(-2)) : {};
    // require multiTF confirmation (score)
    let multiSupport = 0;
    if (patt1.isHammer || patt1.isDoji || patt1.isShooting) multiSupport += (patt1.isHammer ? 1 : 0) + (patt1.isDoji ? 0.5 : 0) + (patt1.isShooting ? 1 : 0);
    if (patt5.isHammer || patt5.isDoji || patt5.isShooting) multiSupport += (patt5.isHammer ? 1 : 0) + (patt5.isDoji ? 0.5 : 0) + (patt5.isShooting ? 1 : 0);
    if (patt15.isHammer || patt15.isDoji || patt15.isShooting) multiSupport += (patt15.isHammer ? 1 : 0) + (patt15.isDoji ? 0.5 : 0) + (patt15.isShooting ? 1 : 0);
    // require > = 1.0 multiSupport (i.e., at least two minor confirmations or one big)
    if (multiSupport < 1) return null;
    // detect reason
    let reason = null, dir = "Neutral";
    if (patt1.isHammer || patt5.isHammer || patt15.isHammer) { reason = "Hammer"; dir = "Bullish"; }
    if (patt1.isShooting || patt5.isShooting || patt15.isShooting) { reason = "Shooting Star"; dir = "Bearish"; }
    if (!reason) reason = patt1.isDoji ? "Doji" : "Pattern";
    // volume spike check
    const volSpike = last1.volume > avgVol1 * 1.3;
    // ML features & prob
    const feat = mlExtractFeatures({ klines15: k15.data.length ? k15.data.slice(-60) : k1.data.slice(-60), lastCandle: last1, avgVol20: avgVolume(k1.data, 20), divergenceSign: 0, ellConf: 0, systemBias: 0 });
    const prob = mlPredict(feat);
    // build message
    const msg = `🚨 <b>Reversal Watcher (v9.2)</b>\n${nowIndia()}\nSymbol: <b>${SYMBOL}</b>\nSource: ${k1.source}\nPattern: <b>${reason}</b> | MultiTF support: ${Math.round(multiSupport)}\nDirection: <b>${dir}</b>\nPrice: ${last1.close}\nVolume: ${Math.round(last1.volume)} (avg ${Math.round(avgVol1)}) | volSpike: ${volSpike ? "Yes" : "No"}\nML Prob: ${(prob * 100).toFixed(1)}%`;
    await sendTelegramSafe(msg);
    pendingReversals.push({ time: Date.now(), reason, dir, prob, price: last1.close, feat });
    savePendingReversals();
    // soft immediate training on very high/low prob
    try { if (prob > 0.98) mlTrainOnline(feat, dir === "Bullish" ? 1 : 0); if (prob < 0.02) mlTrainOnline(feat, dir === "Bearish" ? 0 : 1); } catch (e) { }
    return { reason, dir, prob, price: last1.close };
  } catch (e) {
    console.warn("reversalWatcherOnce", e.message);
    return null;
  }
}

async function checkPendingReversals() {
  if (!pendingReversals.length) return;
  const now = Date.now();
  const keep = [];
  for (const ev of pendingReversals) {
    if (now - ev.time < 6 * 60 * 1000) { keep.push(ev); continue; } // wait 6 minutes min
    try {
      const r = await fetchKlines(SYMBOL, "1m", 300);
      if (!r.data || !r.data.length) { keep.push(ev); continue; }
      const prices = r.data.map(k => ({ high: k.high, low: k.low }));
      const min = Math.min(...prices.map(x => x.low)), max = Math.max(...prices.map(x => x.high));
      let reversed = false;
      if (ev.dir === "Bullish" && max >= ev.price * 1.004) reversed = true;
      if (ev.dir === "Bearish" && min <= ev.price * 0.996) reversed = true;
      // train
      mlTrainOnline(ev.feat, reversed ? 1 : 0);
      pushAcc(reversed ? 1 : 0);
      // send outcome message (optional quiet)
      const outcomeMsg = `📈 Reversal outcome\n${nowIndia()}\nPattern: ${ev.reason}\nStart: ${ev.price}\nReversed: ${reversed ? "Yes" : "No"}\nML Prob (start): ${(ev.prob * 100).toFixed(1)}%`;
      await sendTelegramSafe(outcomeMsg);
    } catch (e) {
      console.warn("checkPendingReversals err", e.message);
      keep.push(ev);
    }
  }
  pendingReversals = keep;
  savePendingReversals();
}

// ---------- Telegram helpers (simple polling) ----------
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
let tgOffset = 0;

async function sendTelegramSafe(text, parse_mode = "HTML") {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[TG]", text);
    return;
  }
  try {
    const parts = chunkText(text, 3800);
    for (const p of parts) {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: CHAT_ID, text: p, parse_mode, disable_web_page_preview: true });
      await sleep(250);
    }
  } catch (e) {
    console.warn("sendTelegramSafe err", e.message);
  }
}

async function tgPollOnce() {
  if (!BOT_TOKEN) return;
  try {
    const r = await axios.get(`${TG_API}/getUpdates?timeout=10&offset=${tgOffset + 1}`);
    if (!r.data || !r.data.result) return;
    const updates = r.data.result;
    for (const u of updates) {
      tgOffset = Math.max(tgOffset, u.update_id);
      if (u.message) handleCommand(u.message);
      if (u.edited_message) handleCommand(u.edited_message);
    }
  } catch (e) { /* network might fail */ }
}
async function handleCommand(msg) {
  try {
    const text = (msg.text || "").trim();
    const chatId = msg.chat.id;
    const from = msg.from && (msg.from.username || msg.from.first_name);
    if (!text) return;
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    console.log("TG cmd", cmd, "from", from);
    if (cmd === "/start" || cmd === "/help") {
      const help = `AI Trader v9.2 commands:\n/status\n/predict\n/setthreshold <0-1>\n/autoon\n/autooff\n/retrain\n/help`;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: help });
      return;
    }
    if (cmd === "/status") {
      // reuse last prediction file
      let last = {};
      try { last = fs.existsSync(LAST_PRED_FILE) ? JSON.parse(fs.readFileSync(LAST_PRED_FILE, "utf8")) : {}; } catch (e) { }
      const acc = getAccuracy(10);
      const textOut = `🤖 Status v9.2\nSymbol: ${SYMBOL}\nLast run: ${last.time || "N/A"}\nBias: ${last.bias || "N/A"}\nML Prob: ${last.mlProb ? (last.mlProb * 100).toFixed(1) + "%" : "N/A"}\nAccuracy(last10): ${acc}`;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: textOut });
      return;
    }
    if (cmd === "/predict") {
      // force an immediate analyze and reply
      const report = await analyzeOnce();
      if (report) {
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: report, parse_mode: "HTML", disable_web_page_preview: true });
      } else {
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: "Prediction failed or no data." });
      }
      return;
    }
    if (cmd === "/setthreshold") {
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && val > 0 && val < 1) {
        ML.threshold = val; mlSave();
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `ML threshold set to ${val}` });
      } else {
        await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Usage: /setthreshold 0.6 (value between 0 and 1)` });
      }
      return;
    }
    if (cmd === "/autoon") {
      AUTO_REPORT = true;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports enabled.` });
      return;
    }
    if (cmd === "/autooff") {
      AUTO_REPORT = false;
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Auto reports disabled.` });
      return;
    }
    if (cmd === "/retrain") {
      mlSave();
      await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: `Model saved. (Manual retrain not implemented in this command)` });
      return;
    }
  } catch (e) {
    console.warn("handleCommand", e.message);
  }
}

// ---------- Analysis / Report ----------
let AUTO_REPORT = true;

async function analyzeOnce() {
  try {
    // Fetch main TFs
    const main15 = await fetchKlines(SYMBOL, "15m", 120).catch(() => ({ data: [], source: "none" }));
    const main5 = await fetchKlines(SYMBOL, "5m", 200).catch(() => ({ data: [], source: "none" }));
    const main1 = await fetchKlines(SYMBOL, "1m", 200).catch(() => ({ data: [], source: "none" }));
    const main30 = await fetchKlines(SYMBOL, "30m", 120).catch(() => ({ data: [], source: "none" }));
    const main1h = await fetchKlines(SYMBOL, "1h", 120).catch(() => ({ data: [], source: "none" }));
    const source = main15.source || main5.source || main1.source || "Unknown";
    if (!main15.data || !main15.data.length) {
      console.warn("analyzeOnce: no 15m data");
      return null;
    }
    const last15 = main15.data.at(-1);
    const avgVol20 = avgVolume(main15.data, 20);
    const rsi15 = calcRSI(main15.data, 14);
    const mac15 = calcMACD(main15.data, 12, 26, 9);
    const atr15 = atr(main15.data, 14) || 0;
    const fib = calcFibLevels(main15.data);
    // tech vol mock (simple buy/sell ratio using last moves)
    const buys = main15.data.filter(k => k.close > k.open).length;
    const sells = main15.data.filter(k => k.close <= k.open).length;
    const techVol = { buyPct: Math.round((buys / main15.data.length) * 100), sellPct: Math.round((sells / main15.data.length) * 100) };
    // social & news
    const headlines = await fetchHeadlines().catch(() => []);
    const reddit = await fetchReddit(8).catch(() => []);
    const nitter = await fetchNitter(SYMBOL.replace(/USDT$/,""), 6).catch(() => []);
    const newsImpactScore = headlines.length; // crude
    // ML features & prob
    const feat = mlExtractFeatures({ klines15: main15.data, lastCandle: last15, avgVol20 });
    const prob = mlPredict(feat);
    // Merge signals
    const merged = mergeSignals(techVol.buyPct, headlines.length, reddit.length ? reddit.map(r=>r.ups).reduce((a,b)=>a+b,0) : 0, nitter.length, 0);
    // bias influenced by ML if strong
    let bias = merged.label;
    if (prob > (ML.threshold || ML_THRESHOLD)) bias = "Bullish";
    if (prob < (1 - (ML.threshold || ML_THRESHOLD))) bias = "Bearish";
    // combined confidence
    const combinedConfidence = Math.min(99, Math.round((Math.abs(merged.combined) * 100) * 0.6 + (Math.abs(prob - 0.5) * 200) * 0.4));
    // targets (hybrid)
    const fibMid = fib ? (fib.f5 || ((fib.high + fib.low) / 2)) : last15.close;
    const tp1 = +(fibMid + atr15 * 0.5).toFixed(2);
    const tp2 = +(fibMid + atr15 * 1.0).toFixed(2);
    const tp3 = +(fibMid + atr15 * 1.5).toFixed(2);
    const sl = +(fibMid - atr15 * 0.8).toFixed(2);
    // formatting
    const msgLines = [];
    msgLines.push(`🤖 BTCUSDT — AI Trader v9.2`);
    msgLines.push(`${nowIndia()}`);
    msgLines.push(`Source: ${source}`);
    msgLines.push(`Price: ${last15.close}`);
    msgLines.push(`Tech Vol: Buy ${techVol.buyPct}% / Sell ${techVol.sellPct}%`);
    msgLines.push(`RSI(14): ${rsi15.toFixed(1)} | MACD hist: ${mac15.hist.toFixed(3)} | ATR(14): ${atr15 ? atr15.toFixed(2) : "N/A"}`);
    msgLines.push(`Bias: <b>${bias}</b> | Confidence: ${combinedConfidence}% | ML Prob: ${(prob*100).toFixed(1)}% (thr ${(ML.threshold||ML_THRESHOLD)})`);
    msgLines.push(`Accuracy(last10): ${getAccuracy(10)}`);
    msgLines.push(`TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}`);
    msgLines.push(`Breakout zone (low-high): ${fib ? `${fib.low.toFixed(2)} - ${fib.high.toFixed(2)}` : "N/A"}`);
    msgLines.push(`News headlines:`);
    for (let i = 0; i < Math.min(headlines.length, 5); i++) msgLines.push(` • ${headlines[i]}`);
    const finalMsg = msgLines.join("\n");
    // save prediction snapshot
    try { fs.writeFileSync(LAST_PRED_FILE, JSON.stringify({ time: nowISO(), bias, mlProb: prob, confidence: combinedConfidence, price: last15.close }, null, 2)); } catch (e) { }
    // send telegram if auto enabled
    if (AUTO_REPORT) await sendTelegramSafe(finalMsg, "HTML");
    return finalMsg;
  } catch (e) {
    console.warn("analyzeOnce error", e.message);
    return null;
  }
}

// ---------- Scheduler ----------
async function periodicTasks() {
  // initial analyze
  await analyzeOnce();
  // set intervals
  setInterval(async () => {
    if (AUTO_REPORT) await analyzeOnce();
    // keep Render awake
    await selfPing();
  }, CHECK_INTERVAL_MIN * 60 * 1000);

  // reversal watcher every REV_CHECK_INTERVAL_SEC
  setInterval(async () => {
    await reversalWatcherOnce();
    await checkPendingReversals();
  }, REV_CHECK_INTERVAL_SEC * 1000);

  // TG poll loop
  setInterval(async () => { await tgPollOnce(); }, 5000);
}

// ---------- Express server for healthcheck ----------
const app = express();
app.get("/", (req, res) => res.send(`AI Trader v9.2 running. Symbol: ${SYMBOL} Time: ${nowISO()}`));
app.listen(SERVER_PORT, () => console.log("Server listening on", SERVER_PORT));

// ---------- Start ----------
(async function main() {
  console.log("Starting AI Trader v9.2", SYMBOL, "host: Node");
  mlLoad();
  ML.threshold = ML.threshold || ML_THRESHOLD;
  // announce to TG if configured
  try {
    await sendTelegramSafe(`AI Trader v9.2 started\n${nowIndia()}\nSymbol: ${SYMBOL}\nHost: Node`);
  } catch (e) { console.warn("announce err", e.message); }
  // schedule background tasks
  periodicTasks();
})();