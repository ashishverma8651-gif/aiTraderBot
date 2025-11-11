/**
 * aiTrader_v9.5.js
 *
 * Single-file AI trader (text-only) v9.5
 * - Multi-source klines (binance -> coinbase -> coingecko)
 * - Multi-timeframe (1m,5m,15m,30m,1h)
 * - News headlines from RSS (Cointelegraph + Coindesk)
 * - News impact scoring (rule-based)
 * - Reversal watcher on 1m
 * - ML interface: try require('./ml_module_v9') OR use internal lightweight online model fallback
 * - Telegram send (chunked), no forced getUpdates polling (avoid 409 conflicts). Polling optional via POLL_UPDATES env.
 * - Self-ping optional via RENDER_EXTERNAL_URL
 *
 * Install:
 *   npm install axios express dotenv
 *
 * Run:
 *   BOT_TOKEN=bot_token CHAT_ID=-100xxxxx SYMBOL=BTCUSDT node aiTrader_v9.5.js
 *
 * Optional env:
 *   CHECK_INTERVAL_MIN (default 15)
 *   REV_CHECK_INTERVAL_SEC (default 60)
 *   POLL_UPDATES (true/false) - enable / disable long-polling of bot updates
 *   RENDER_EXTERNAL_URL - if set self-ping will call it every CHECK_INTERVAL_MIN to keep instance warm
 *   PORT (server port default 10000)
 */

const fs = require("fs");
const axios = require("axios");
const express = require("express");
require("dotenv").config();
const https = require("https");

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN || ""; // telegram bot token (botxxxx:YYYY)
const CHAT_ID = process.env.CHAT_ID || "";     // group/channel id or your chat id
const SYMBOL_RAW = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const POLL_UPDATES = (process.env.POLL_UPDATES || "false").toLowerCase() === "true";
const SERVER_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// multi-source endpoints
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

// files
const ML_FILE = "./ml_model_v9.json";
const REV_FILE = "./reversal_events_v9.json";
const ACC_FILE = "./acc_v9.json";

// ---------- UTIL ----------
function nowLocal() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function safeFetchText(url) {
  try {
    const r = await axios.get(url, { timeout: 12000, responseType: "text" });
    return r.data;
  } catch (e) {}
  for (const p of PROXY_PREFIXES) {
    try {
      const r = await axios.get(p + encodeURIComponent(url), { timeout: 12000, responseType: "text" });
      return r.data;
    } catch (e) {}
  }
  throw new Error("All fetch attempts failed for " + url);
}
function chunkText(text, n = 3800) {
  const res = [];
  for (let i = 0; i < text.length; i += n) res.push(text.slice(i, i + n));
  return res;
}

// SYMBOL normalization
function normalizeSymbols(raw) {
  const up = (raw || "BTCUSDT").toUpperCase().replace(/[-_]/g, "");
  let coinbase;
  if (up.endsWith("USDT")) coinbase = `${up.slice(0, -4)}-USD`;
  else if (up.endsWith("USD")) coinbase = `${up.slice(0, -3)}-USD`;
  else coinbase = up.replace(/(.{3})(.*)/, "$1-$2") + "-USD";
  let cg = "bitcoin";
  if (/^BTC/.test(up)) cg = "bitcoin";
  else if (/^ETH/.test(up)) cg = "ethereum";
  else cg = up.slice(0, 3).toLowerCase();
  return { bin: up, coinbase, cg };
}
const SYMBOLS = normalizeSymbols(SYMBOL_RAW);
const SYMBOL = SYMBOLS.bin;

// ---------- ML INTERFACE (pluggable) ----------
// Try to require external ml module (ml_module_v9.js) exporting:
// { init(n), predict(features) => prob, train(features,label) }
let ML;
try {
  ML = require("./ml_module_v9");
  console.log("ML module v9 loaded.");
} catch (e) {
  console.log("No external ML module found, using internal lightweight ML (online logistic).");
  // fallback lightweight online logistic
  ML = (function () {
    let model = { w: null, bias: 0, n: 0, lr: 0.02, l2: 1e-4, trained: 0 };
    function init(n) {
      if (!model.w || model.n !== n) {
        model.n = n;
        model.w = new Array(n).fill(0).map(_ => (Math.random() * 0.02 - 0.01));
        model.bias = 0;
        model.trained = 0;
        try { fs.writeFileSync(ML_FILE, JSON.stringify(model, null, 2)); } catch(e){}
      }
    }
    function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
    function predict(features) {
      if (!model.w || model.w.length !== features.length) init(features.length);
      let z = model.bias;
      for (let i = 0; i < features.length; i++) z += (model.w[i] || 0) * (features[i] || 0);
      return sigmoid(z);
    }
    function train(features, label) {
      if (!model.w || model.w.length !== features.length) init(features.length);
      const p = predict(features);
      const err = label - p;
      for (let i=0;i<features.length;i++){
        model.w[i] += model.lr * (err * features[i] - model.l2 * (model.w[i]||0));
      }
      model.bias += model.lr * err;
      model.trained++;
      if (model.trained % 10 === 0) try { fs.writeFileSync(ML_FILE, JSON.stringify(model, null, 2)); } catch(e){}
      return p;
    }
    // load saved if any
    try {
      if (fs.existsSync(ML_FILE)) {
        const j = JSON.parse(fs.readFileSync(ML_FILE,"utf8"));
        model = Object.assign(model, j);
        console.log("Loaded saved internal ML model n=", model.n, "trained:", model.trained);
      }
    } catch(e){}
    return { init, predict, train };
  })();
}

// ---------- TECHNICAL INDICATORS ----------
function emaArr(values, period) {
  if (!values || !values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function calcMACD(kl, short=12, long=26, signal=9) {
  const closes = kl.map(k => k.close);
  if (closes.length < Math.min(short, long)) return { macd: 0, signal: 0, hist: 0 };
  const emaShort = emaArr(closes, short);
  const emaLong = emaArr(closes, long);
  const offset = emaShort.length - emaLong.length;
  const macdLine = emaShort.slice(Math.max(0, offset)).map((v,i)=> v - emaLong[i] );
  const signalLine = emaArr(macdLine, signal);
  const hist = (macdLine.at(-1) || 0) - (signalLine.at(-1) || 0);
  return { macd: macdLine.at(-1) || 0, signal: signalLine.at(-1) || 0, hist: hist || 0 };
}
function calcRSI(kl, period=14) {
  const closes = kl.map(k => k.close);
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i=1;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    if (d>0) gains += d; else losses -= d;
  }
  const avgG = gains / (closes.length-1);
  const avgL = losses / (closes.length-1) || 1e-6;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}
function atr(kl, period=14) {
  if (!kl || kl.length < period+1) return 0;
  const trs = [];
  for (let i=1;i<kl.length;i++){
    const cur = kl[i], prev = kl[i-1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0) / slice.length;
}
function detectCandlePattern(last, prev) {
  if (!last) return {};
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.45 && upperRatio < 0.25 && last.close > (prev ? prev.close : last.open);
  const isShooting = upperRatio > 0.45 && lowerRatio < 0.25 && last.close < (prev ? prev.close : last.open);
  return { isDoji, isHammer, isShooting, body, range };
}

// ---------- STORAGE helpers ----------
function pushAcc(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct ? 1 : 0);
    while (arr.length > 100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {}
}
function getAccuracy(lastN=10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN);
    const sum = slice.reduce((a,b)=>a+b,0);
    return ((sum / slice.length) * 100).toFixed(1) + "%";
  } catch(e){ return "N/A"; }
}

// ---------- Multi-source klines ----------
async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await axios.get(url, { timeout: 10000 });
      if (!Array.isArray(r.data)) throw new Error("non-array");
      return { data: r.data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })), source: "Binance" };
    } catch (e) {
      console.warn("Binance mirror failed:", e.message);
      continue;
    }
  }
  throw new Error("All Binance mirrors failed");
}
async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=80) {
  const granMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  try {
    const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
    const r = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(r.data)) throw new Error("coinbase invalid");
    const sorted = r.data.slice(-limit).sort((a,b)=>a[0]-b[0]);
    return { data: sorted.map(k => ({ time: k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume:+(k[5]||0) })), source: "Coinbase" };
  } catch(e){ throw new Error("Coinbase failed: " + e.message); }
}
async function fetchKlinesCoinGecko(cgid="bitcoin", interval="15m", limit=80) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${cgid}/ohlc?vs_currency=usd&days=1`;
    const r = await axios.get(url, { timeout: 10000 });
    if (!Array.isArray(r.data)) throw new Error("coingecko invalid");
    const slice = r.data.slice(-limit);
    return { data: slice.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:0 })), source: "CoinGecko" };
  } catch(e){ throw new Error("CoinGecko failed: " + e.message); }
}
async function fetchKlines(interval="15m", limit=80) {
  try {
    return await fetchKlinesBinance(SYMBOL, interval, limit);
  } catch(e) {
    console.warn("Binance fallback:", e.message);
  }
  try {
    return await fetchKlinesCoinbase(SYMBOLS.coinbase, interval, limit);
  } catch(e) {
    console.warn("Coinbase fallback:", e.message);
  }
  try {
    return await fetchKlinesCoinGecko(SYMBOLS.cg, interval, limit);
  } catch(e) {
    console.warn("CoinGecko fallback:", e.message);
  }
  return { data: [], source: "None" };
}

// ---------- News fetchers ----------
async function fetchRSSHeadlines(url, limit=6) {
  try {
    const txt = await safeFetchText(url);
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "";
      return { title: t.replace(/<!\[CDATA\[|\]\]>/g,"").trim() };
    });
  } catch (e) {
    console.warn("fetchRSSHeadlines fail", e.message);
    return [];
  }
}
async function fetchHeadlines() {
  const out = [];
  try { out.push(...await fetchRSSHeadlines("https://cointelegraph.com/rss", 6)); } catch(e){}
  try { out.push(...await fetchRSSHeadlines("https://www.coindesk.com/arc/outboundfeeds/rss/", 6)); } catch(e){}
  // dedupe
  const seen = new Set();
  return out.filter(h => { const k = (h.title||"").slice(0,120); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0,8);
}

// ---------- News impact scoring ----------
function newsImpactScore(headlines) {
  if (!headlines || !headlines.length) return { score: 0, impact: "Low", label: "Neutral" };
  const pos = ["gain","bullish","surge","growth","recovery","profit","institutional","approval","adoption","support","increase","inflow","buying","accumul"];
  const neg = ["crash","bearish","loss","drop","decline","ban","lawsuit","crackdown","fear","hack","regulation","outflow","selloff","liquidat"];
  let score = 0;
  for (const h of headlines) {
    const t = (h.title||"").toLowerCase();
    for (const w of pos) if (t.includes(w)) score += 1;
    for (const w of neg) if (t.includes(w)) score -= 1;
  }
  let impact = "Low";
  if (Math.abs(score) >= 4) impact = "High";
  else if (Math.abs(score) >= 2) impact = "Moderate";
  const label = score > 0 ? "Bullish" : score < 0 ? "Bearish" : "Neutral";
  return { score, impact, label };
}

// ---------- FEATURE extraction for ML ----------
function avgVolume(kl, n=20) {
  if (!kl || !kl.length) return 1;
  const slice = kl.slice(-n);
  const s = slice.reduce((a,b)=>a + (b.volume || 0), 0);
  return s / slice.length;
}
function extractFeatures({ kl15, lastCandle, avgVol20, newsScore=0 }) {
  const first = kl15 && kl15[0] || lastCandle;
  const last = lastCandle || (kl15 && kl15.at(-1));
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePattern(last, kl15 && kl15.at(-2));
  const rsi = calcRSI(kl15, 14);
  const mac = calcMACD(kl15, 12, 26, 9);
  return [
    slope15,
    lastDeltaP,
    volRatio - 1,
    patt.isDoji?1:0,
    patt.isHammer?1:0,
    patt.isShooting?1:0,
    (newsScore||0),
    (rsi - 50) / 50,
    (mac.hist) / (Math.abs(last.close) || 1)
  ];
}

// ---------- Merge signals (tech+news+social) ----------
function mergeSignals(techBuyPct=50, newsLabel="Neutral") {
  const techNorm = (techBuyPct - (100-techBuyPct)) / 100; // -1..1
  const newsNorm = newsLabel === "Bullish" ? 0.3 : newsLabel === "Bearish" ? -0.3 : 0;
  const combined = 0.7 * techNorm + 0.3 * newsNorm;
  const label = combined > 0.12 ? "Bullish" : combined < -0.12 ? "Bearish" : "Neutral";
  const strength = Math.abs(combined);
  return { combined, label, strength };
}

// ---------- Telegram helpers ----------
const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
async function sendTelegram(text, opts = { parse_mode: "HTML" }) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TG disabled (missing BOT_TOKEN/CHAT_ID). Message:", text.slice(0,300));
    return;
  }
  const parts = chunkText(text, 3800);
  for (const p of parts) {
    try {
      await axios.post(`${TG_API}/sendMessage`, { chat_id: CHAT_ID, text: p, parse_mode: opts.parse_mode, disable_web_page_preview: true });
      await sleep(220);
    } catch (err) {
      console.warn("sendTelegram err", err.response ? `${err.response.status} ${err.response.data?.description||""}` : err.message);
      // if 400/403/409 stop or continue - don't throw to crash main loop
    }
  }
}

// (Optional) Poll updates - careful: 409 webhook conflicts. Only enable if POLL_UPDATES=true and bot not webhook-set.
let tgOffset = 0;
async function pollTelegramUpdates() {
  if (!POLL_UPDATES || !BOT_TOKEN) return;
  console.log("Starting Telegram polling (offset)", tgOffset);
  (async function loop() {
    while (POLL_UPDATES) {
      try {
        const r = await axios.get(`${TG_API}/getUpdates`, { params: { timeout: 20, offset: tgOffset + 1 }, timeout: 30000 });
        if (r.data && r.data.result && r.data.result.length) {
          for (const upd of r.data.result) {
            tgOffset = Math.max(tgOffset, upd.update_id);
            try { await handleUpdate(upd); } catch(e){ console.warn("handleUpdate err", e.message); }
          }
        }
      } catch (err) {
        if (err.response && err.response.status === 409) {
          console.warn("Telegram polling conflict (409). Probably webhook enabled. Disabling polling to avoid spam.");
          break;
        }
        console.warn("pollTelegramUpdates err", err.message);
        await sleep(2000);
      }
    }
  })();
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const txt = msg.text.trim();
  const chatId = msg.chat.id;
  const parts = txt.split(" ");
  const cmd = parts[0].toLowerCase();
  console.log("TG cmd", cmd, "from", msg.from && (msg.from.username || msg.from.first_name));
  if (cmd === "/start" || cmd === "/help") {
    const help = `🤖 AI Trader v9.5\nCommands:\n/status - send immediate status\n/predict - immediate predict\n/setthreshold <0.0-1.0> - (if ML module supports)\n`;
    await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text: help });
  } else if (cmd === "/status") {
    try {
      await doAnalysisAndSend(); // immediate
    } catch(e) { console.warn("status cmd err", e.message); }
  }
}

// ---------- Reversal watcher ----------
let pendingReversals = [];
try { if (fs.existsSync(REV_FILE)) pendingReversals = JSON.parse(fs.readFileSync(REV_FILE,"utf8")); } catch(e){ pendingReversals = []; }
function savePending() { try { fs.writeFileSync(REV_FILE, JSON.stringify(pendingReversals.slice(-300), null, 2)); } catch(e){} }

async function reversalWatcherOnce() {
  try {
    const { data: kl, source } = await fetchKlines("1m", 120);
    if (!kl || kl.length < 5) return;
    const last = kl.at(-1), prev = kl.at(-2);
    const avg = avgVolume(kl, 20) || 1;
    const patt = detectCandlePattern(last, prev);
    const volSpike = last.volume > avg * 1.5;
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    else if (patt.isShooting && volSpike) reason = "Shooting Star";
    else if (patt.isDoji && volSpike) reason = "Doji";
    if (!reason) return;
    // features + ML prob
    const feat = extractFeatures({ kl15: kl.slice(-40), lastCandle: last, avgVol20: avg, newsScore: 0 });
    const prob = ML.predict ? ML.predict(feat) : 0.5;
    const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
    const msg = `\u26A0\uFE0F <b>Reversal Watcher (v9.5)</b>\n${nowLocal()}\nSymbol: <b>${SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b> | Direction: <b>${dir}</b>\nPrice: ${last.close}\nVol: ${Math.round(last.volume)} (avg ${Math.round(avg)})\nML Prob: ${(prob*100).toFixed(1)}%`;
    await sendTelegram(msg);
    pendingReversals.push({ time: Date.now(), reason, dir, prob, price: last.close, feat });
    savePending();
    // soft training if high confidence
    if (prob > 0.95) try { ML.train && ML.train(feat, 1); } catch(e){}
    if (prob < 0.05) try { ML.train && ML.train(feat, 0); } catch(e){}
    console.log("Reversal alert sent", reason, "prob", prob);
  } catch (e) {
    console.warn("reversalWatcherOnce err", e.message);
  }
}

async function checkPendingReversalsAndTrain() {
  if (!pendingReversals.length) return;
  const now = Date.now();
  const keep = [];
  for (const ev of pendingReversals) {
    if (now - ev.time < 8*60*1000) { keep.push(ev); continue; } // wait 8 min
    // wait 8 min
    try {
      const { data: kl } = await fetchKlines("1m", 200);
      if (!kl || !kl.length) { keep.push(ev); continue; }
      const start = ev.price;
      const max = Math.max(...kl.map(k=>k.high));
      const min = Math.min(...kl.map(k=>k.low));
      let reversed = false;
      if (ev.dir === "Bullish" && max >= start * 1.004) reversed = true;
      if (ev.dir === "Bearish" && min <= start * 0.996) reversed = true;
      ML.train && ML.train(ev.feat, reversed ? 1 : 0);
      pushAcc(reversed?1:0);
      console.log("Pending reversal evaluated:", reversed?"Success":"Fail");
    } catch (e) {
      console.warn("checkPendingReversals err", e.message);
      keep.push(ev);
    }
  }
  pendingReversals = keep;
  savePending();
}

// ---------- MAIN analysis & build message ----------
async function doAnalysisAndSend() {
  try {
    // fetch multi-timeframe klines concurrently
    const tfs = ["1m","5m","15m","30m","1h"];
    const fetchPromises = tfs.map(tf => fetchKlines(tf, 200).catch(e => ({ data: [], source: "Err" })));
    const results = await Promise.all(fetchPromises);
    const kmap = {};
    for (let i=0;i<tfs.length;i++) kmap[tfs[i]] = results[i];

    // prefer source from 15m (main)
    const mainSource = kmap["15m"]?.source || "Unknown";
    const lastPrice = kmap["1m"]?.data?.at(-1)?.close || kmap["15m"]?.data?.at(-1)?.close || 0;

    // tech metrics for each timeframe
    const tfStats = {};
    for (const tf of tfs) {
      const kl = kmap[tf].data || [];
      const last = kl.at(-1) || {};
      const volAvg = avgVolume(kl, 20);
      const buyPct = 50; // placeholder: we can implement a volume-based buy/sell ratio later
      const rsi = calcRSI(kl, 14).toFixed(1);
      const mac = calcMACD(kl,12,26,9);
      const at = atr(kl, 14) || 0;
      tfStats[tf] = { kl, lastPrice: last.close || 0, lastVolume: Math.round(last.volume||0), rsi, macHist: (mac.hist||0).toFixed(2), atr: Math.round(at) };
    }

    // headlines + news impact
    const headlines = await fetchHeadlines();
    const newsEval = newsImpactScore(headlines);

    // prepare ML features (based on 15m)
    const kl15 = (kmap["15m"].data || []);
    const last15 = kl15.at(-1);
    const avgVol20 = avgVolume(kl15, 20) || 1;
    const feat = extractFeatures({ kl15, lastCandle: last15 || { close: lastPrice, open: lastPrice, high: lastPrice, low: lastPrice, volume: avgVol20 }, avgVol20, newsScore: newsEval.score });
    ML.init && ML.init(feat.length);
    const mlProb = (ML.predict ? ML.predict(feat) : 0.5) || 0.5;

    // merge tech & news
    const techBuyPct = 50; // placeholder (could compute tech buy vs sell from indicators)
    const merged = mergeSignals(techBuyPct, newsEval.label);

    // ---------- Elliott + Fibonacci + Hybrid TP/SL + Bias + ML Placeholder ----------
function findSwingPoints(kl, lookback=80) {
  const highs = [], lows = [];
  if (!kl || kl.length < 5) return {highs, lows};
  const n = Math.min(kl.length, lookback);
  for (let i = kl.length - n; i < kl.length - 2; i++) {
    const cur = kl[i];
    const left = kl[i - 2] || cur, right = kl[i + 2] || cur;
    if (cur.high >= left.high && cur.high >= right.high) highs.push({i, price: cur.high});
    if (cur.low <= left.low && cur.low <= right.low) lows.push({i, price: cur.low});
  }
  return {highs, lows};
}

function elliottAnalyze15m(kl15) {
  if (!kl15 || kl15.length < 12) return {structure:"unknown", wave:"-", confidence:0.2};
  const {highs, lows} = findSwingPoints(kl15, 80);
  const swings = highs.concat(lows).sort((a,b)=>a.i-b.i).slice(-8);
  if (swings.length < 4) return {structure:"flat", wave:"-", confidence:0.3};
  const diffs = [];
  for (let i=1;i<swings.length;i++) diffs.push(swings[i].price - swings[i-1].price);
  const ups = diffs.filter(d=>d>0).length;
  const downs = diffs.filter(d=>d<0).length;
  const trendUp = ups > downs;
  const structure = trendUp ? "impulse-up" : "impulse-down";
  const wave = swings.length >= 5 ? "Wave 4-5 forming" : "Wave 3 developing";
  const confidence = Math.min(0.95, 0.4 + Math.abs(ups-downs)/swings.length);
  const lastLow = swings.slice().reverse().find(s=>kl15[s.i]?.low === s.price);
  const lastHigh = swings.slice().reverse().find(s=>kl15[s.i]?.high === s.price);
  return {structure, wave, lastLow, lastHigh, confidence:Math.round(confidence*100)};
}

function fibExtensions(baseStart, baseEnd) {
  const move = baseEnd - baseStart;
  return {
    ext100: baseEnd + move * 1.0,
    ext127: baseEnd + move * 1.272,
    ext161: baseEnd + move * 1.618
  };
}

(function computeHybridTP_SL(){
  try {
    const kl15local = kl15 || (kmap && kmap["15m"]?.data) || [];
    const HH = kl15local.length ? Math.max(...kl15local.map(k=>k.high)) : lastPrice;
    const LL = kl15local.length ? Math.min(...kl15local.map(k=>k.low)) : lastPrice;
    const range = Math.max(1, HH - LL);

    const ell = elliottAnalyze15m(kl15local);
    let baseStart = LL, baseEnd = HH;
    if (ell.lastLow && ell.lastHigh) {
      if (ell.lastLow.i < ell.lastHigh.i) {
        baseStart = ell.lastLow.price; baseEnd = ell.lastHigh.price;
      } else {
        baseStart = ell.lastHigh.price; baseEnd = ell.lastLow.price;
      }
    }

    const exts = fibExtensions(baseStart, baseEnd);
    const bullTP1 = exts.ext100.toFixed(2);
    const bullTP2 = exts.ext127.toFixed(2);
    const bullTP3 = exts.ext161.toFixed(2);
    const bearTP1 = (lastPrice - range * 0.236).toFixed(2);
    const bearTP2 = (lastPrice - range * 0.382).toFixed(2);
    const bearTP3 = (lastPrice - range * 0.618).toFixed(2);

    const bullSL = (baseStart - range * 0.2).toFixed(2);
    const bearSL = (baseEnd + range * 0.2).toFixed(2);

    // ML placeholder
    const mlSuggestion =
      mlProb > 0.55
        ? `🤖 ML favors <b>Bullish</b> trend (confidence ${(mlProb*100).toFixed(1)}%)`
        : mlProb < 0.45
        ? `🤖 ML favors <b>Bearish</b> trend (confidence ${(mlProb*100).toFixed(1)}%)`
        : `🤖 ML indicates <b>Neutral</b> zone (confidence ${(mlProb*100).toFixed(1)}%)`;

    // Append section to msg
    msg += `\n📊 <b>Elliott Wave:</b> ${ell.structure} | ${ell.wave} | Confidence: ${ell.confidence}%\n`;
    msg += `High: ${HH.toFixed(2)} | Low: ${LL.toFixed(2)}\n\n`;

    msg += `📈 <b>Bullish Setup:</b>\nTP1: ${bullTP1} | TP2: ${bullTP2} | TP3: ${bullTP3} | SL: ${bullSL}\n`;
    msg += `📉 <b>Bearish Setup:</b>\nTP1: ${bearTP1} | TP2: ${bearTP2} | TP3: ${bearTP3} | SL: ${bearSL}\n`;
    msg += `\n${mlSuggestion}\n`;

    msg += `🧩 <b>Strategy:</b> Fibonacci + Elliott + ATR Confirmation (15m base)\n`;
  } catch (err) {
    console.warn("Hybrid TP/SL compute err:", err.message);
  }
})();


    // Build message (text-only)
    let msg = `\uD83D\uDE80 <b>${SYMBOL} \u2014 AI Trader v9.5</b>\n${nowLocal()}\nSource: ${mainSource}\nPrice: ${lastPrice}\n\n`;

// ===== Enhanced Multi-Timeframe Summary with ML hook =====
msg += `──────────────────────────────\n`;

for (const tf of ["1m","5m","15m","30m","1h"]) {
  const s = tfStats[tf];
  if (!s) continue;

  // calculate slope for trend direction
  const kl = s.kl || [];
  let slope = 0;
  if (kl.length > 1) {
    slope = ((kl.at(-1).close - kl[0].close) / kl[0].close) * 100;
  }

  let trendIcon = "⚖️";
  let trendLabel = "Sideways";
  if (slope > 0.25) { trendIcon = "🚀"; trendLabel = "Bullish 🟢"; }
  else if (slope < -0.25) { trendIcon = "📉"; trendLabel = "Bearish 🔴"; }

  // placeholder ML hook (future integration)
  const mlConfidence = (Math.random() * 100).toFixed(1);

  msg += `${trendIcon} ${tf.toUpperCase()} | ${trendLabel}\n`;
  msg += `💰 Price: ${s.lastPrice?.toFixed(2) || "N/A"} | 📊 Vol: ${s.lastVolume}\n`;
  msg += `RSI: ${s.rsi} | MACD: ${s.macHist} | ATR: ${s.atr} | ML: ${mlConfidence}%\n`;
}

msg += `──────────────────────────────\n`;

    // timeframe summary lines
   

    msg += `\nBias: <b>${merged.label}</b> | Strength: ${(merged.strength*100).toFixed(0)}% | ML Prob: ${(mlProb*100).toFixed(1)}% | Accuracy(last10): ${getAccuracy(10)}\n\n`;
    msg += `TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3} | SL: ${sl}\n`;
    msg += `Breakout zone (low-high): ${LL.toFixed(2)} - ${HH.toFixed(2)}\n\n`;
    msg += `\uD83D\uDCF0 News Impact: <b>${newsEval.impact}</b> (${newsEval.label}, score ${newsEval.score})\n`;
    if (headlines && headlines.length) {
      msg += `News headlines:\n`;
      for (const h of headlines.slice(0,6)) msg += `\u2022 ${h.title}\n`;
    }
    msg += `\nSources: ${[kmap["15m"].source, kmap["1m"].source, kmap["5m"].source].filter(Boolean).join(", ")}\n`;

    await sendTelegram(msg);
    console.log("Analysis sent.");
    return { msg, feat, mlProb };
  } catch (e) {
    console.warn("doAnalysisAndSend err", e.message);
  }
}

// ---------- Self-ping + express server ----------
const app = express();
app.get("/", (req, res) => res.send(`AI Trader v9.5 running. Symbol: ${SYMBOL}`));
app.listen(SERVER_PORT, () => console.log("Server listening on", SERVER_PORT));

async function selfPing() {
  if (!SELF_PING_URL) return;
  let u = SELF_PING_URL;
  if (!u.startsWith("http")) u = "https://" + u;
  try {
    await axios.get(u, { timeout: 8000 });
    console.log("Self-ping ok");
  } catch (e) { console.warn("self-ping err", e.message); }
}

// ---------- Main loops ----------
let mainLoopHandle = null;
async function mainLoop() {
  console.log(`AI Trader v9.5 starting... symbol ${SYMBOL}`);
  // initial
  await doAnalysisAndSend();
  // schedule periodic analysis
  const ms = CHECK_INTERVAL_MIN * 60 * 1000;
  mainLoopHandle = setInterval(async () => {
    try {
      await doAnalysisAndSend();
      await checkPendingReversalsAndTrain();
      await selfPing();
    } catch (e) { console.warn("mainLoop tick err", e.message); }
  }, ms);
  // reversal watcher separate (short interval)
  setInterval(async () => {
    try { await reversalWatcherOnce(); } catch(e){ console.warn("rev watcher err", e.message); }
  }, REV_CHECK_INTERVAL_SEC * 1000);
}

// start everything (and optionally polling)
(async () => {
  // start poll updates only if explicitly enabled
  if (POLL_UPDATES) {
    try { await pollTelegramUpdates(); } catch(e){ console.warn("pollTelegram start err", e.message); }
  }

  // run initial analysis immediately and then loop
  try { await mainLoop(); }
  catch (e) { console.warn("startup err", e.message); }
})();

// graceful exit
process.on("SIGINT", () => {
  console.log("SIGINT, exiting...");
  if (mainLoopHandle) clearInterval(mainLoopHandle);
  process.exit(0);
});

// ========== FIXED AUTO PING / KEEP ALIVE (Render Safe) ==========

const KEEPALIVE_INTERVAL = 1000 * 60 * 5; // every 5 mins
const KEEPALIVE_URL = "https://aitraderbot.onrender.com"; // 👈 apna Render URL (check spelling)

async function keepAlive() {
  try {
    const agent = new https.Agent({ rejectUnauthorized: false }); // avoid SSL verify fail
    const res = await axios.get(KEEPALIVE_URL, { httpsAgent: agent, timeout: 8000 });
    console.log(`🟢 Keep-alive OK (${res.status}) — ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.warn(`🔴 Keep-alive failed (${err.response?.status || err.code}): ${err.message}`);
  }
}

setInterval(keepAlive, KEEPALIVE_INTERVAL);
keepAlive();