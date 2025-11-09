/**
 * AI_Trader_v8.7.js
 * Multi-source (Binance/coinbase/coingecko) + News + Socials + ML + Reversal watcher + Self-ping
 *
 * Requirements:
 *   npm i node-fetch@3 express dotenv
 *
 * Usage:
 *   node AI_Trader_v8.7.js
 *
 * Notes:
 *  - Ensure package.json "type":"module" or convert imports to require()
 *  - Provide BOT_TOKEN and CHAT_ID in .env
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RAW_SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.7");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const SERVER_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// safety
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

// Timeframes
const TIMEFRAMES = ["1m","5m","15m","30m","1h"];

// Proxies for fallback
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];

// Binance mirror endpoints (try in order)
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// storage files
const ML_MODEL_FILE = "./ml_model_v87.json";
const LAST_PRED_FILE = "./last_pred_v87.json";
const ACC_FILE = "./acc_v87.json";
const LAST_REPORT_FILE = "./last_report_prevclose_v87.json";

// ---------- helpers ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

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
  // try direct
  try {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    return r; // might be non-ok, but caller can parse text
  } catch(e){}
  if (!tryProxies) throw new Error("Direct fetch failed");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, opts);
      if (r.ok) return r;
    } catch(e){}
  }
  throw new Error("safeFetch: all proxies failed");
}

// symbol helpers: create versions for each provider
function normalizeSymbols(raw) {
  const up = raw.toUpperCase();
  let binSymbol = up; // if user gave BTCUSDT or BTC-USDT etc.
  binSymbol = binSymbol.replace(/[-_]/g, "");
  // coinbase uses BTC-USD style; choose USD if USDT present
  let coinbaseSymbol;
  if (binSymbol.endsWith("USDT") || binSymbol.endsWith("USD")) {
    const base = binSymbol.replace(/(USDT|USD)$/i,"");
    coinbaseSymbol = `${base}-USD`;
  } else if (binSymbol.includes("/")) {
    coinbaseSymbol = binSymbol.replace("/","-");
  } else {
    coinbaseSymbol = binSymbol + "-USD";
  }
  // coingecko id
  let coingeckoId = "bitcoin";
  if (/^BTC/.test(binSymbol)) coingeckoId = "bitcoin";
  else if (/^ETH/.test(binSymbol)) coingeckoId = "ethereum";
  else coingeckoId = binSymbol.slice(0,3).toLowerCase();
  return { binSymbol, coinbaseSymbol, coingeckoId };
}
const SYMBOLS = normalizeSymbols(RAW_SYMBOL);

// ---------- DATA FETCHERS ----------
// 1) Binance klines (try mirrors)
async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await fetch(url);
      // If blocked, Binance may return HTML or JSON error - safe-check
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (!Array.isArray(j)) throw new Error("binance response not array");
        return j.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
      } catch(e) {
        // not JSON array — probably error page. Try next mirror
        console.warn("binance mirror gave non-array:", base, txt.slice(0,160));
        continue;
      }
    } catch(e){ console.warn("fetchKlinesBinance error", base, e.message); continue; }
  }
  throw new Error("All Binance mirrors failed");
}

// 2) Coinbase candles fallback
// Coinbase endpoint returns arrays like [time, low, high, open, close, volume]
async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=80) {
  // map interval to granularity seconds
  const granMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  // Coinbase limits to around 300 candles; pass limit-1
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  try {
    const r = await safeFetch(url, {}, true);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("Coinbase returned non-array");
    // j elements: [time, low, high, open, close, volume] (descending order maybe)
    // sort ascending by time
    const sorted = j.slice(-limit).sort((a,b)=>a[0]-b[0]);
    return sorted.map(k => ({ time: k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume: (k[5]||0) }));
  } catch(e){ throw new Error("Coinbase fetch failed: " + e.message); }
}

// 3) CoinGecko fallback (ohlc)
async function fetchKlinesCoinGecko(coingeckoId="bitcoin", interval="15m", limit=80) {
  // coinGecko supports OHLC for 1/7/14/30 days: returns [timestamp, open, high, low, close]
  try {
    // days param: 1 or more; for intraday we use 1
    const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/ohlc?vs_currency=usd&days=1`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("coingecko invalid");
    // j items [ts, open, high, low, close] (ts in ms)
    const slice = j.slice(-limit);
    return slice.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume: 0 }));
  } catch(e){ throw new Error("CoinGecko fetch failed: " + e.message); }
}

// Unified fetchKlines that chooses best available source automatically
async function fetchKlines(symbolRaw, interval="15m", limit=80) {
  // prefer Binance, fallback to Coinbase, fallback to CoinGecko
  const { binSymbol, coinbaseSymbol, coingeckoId } = SYMBOLS;
  // try Binance
  try {
    const kl = await fetchKlinesBinance(binSymbol, interval, limit);
    return { data: kl, source: "Binance" };
  } catch(e) {
    console.warn("Binance failed:", e.message);
  }
  // try Coinbase
  try {
    const kl = await fetchKlinesCoinbase(coinbaseSymbol, interval, limit);
    return { data: kl, source: "Coinbase" };
  } catch(e) {
    console.warn("Coinbase failed:", e.message);
  }
  // try CoinGecko
  try {
    const kl = await fetchKlinesCoinGecko(coingeckoId, interval, limit);
    return { data: kl, source: "CoinGecko" };
  } catch(e) {
    console.warn("CoinGecko failed:", e.message);
  }
  // all failed
  return { data: [], source: "None" };
}

// ---------- News & Social fetchers ----------
async function fetchRSS(url, limit=6) {
  try {
    const r = await safeFetch(url);
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
  } catch(e){ console.warn("fetchReddit", e.message); return []; }
}
async function fetchNitter(q="bitcoin", limit=6) {
  try {
    const url = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`;
    const r = await safeFetch(url);
    const html = await r.text();
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    return matches.slice(0,limit).map(m => m[1].replace(/<[^>]+>/g,"").trim());
  } catch(e){ console.warn("fetchNitter", e.message); return []; }
}

// ---------- Analysis helpers ----------
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((acc,k)=>acc + (k.volume||0), 0);
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
function getTargetsAndSL(price, dir="Neutral", atrVal=null) {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  const move = (atrVal && isFinite(atrVal)) ? atrVal : price*0.005;
  if (dir.includes("Bull")) {
    return { tp1:(price+move).toFixed(2), tp2:(price+move*1.8).toFixed(2), tp3:(price+move*3).toFixed(2), sl:(price-move*0.8).toFixed(2) };
  } else if (dir.includes("Bear")) {
    return { tp1:(price-move).toFixed(2), tp2:(price-move*1.8).toFixed(2), tp3:(price-move*3).toFixed(2), sl:(price+move*0.8).toFixed(2) };
  } else return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
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

// ---------- ML (online logistic-ish) ----------
function mlLoad() {
  try {
    if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8"));
  } catch(e) { console.warn("mlLoad", e.message); }
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
  } catch(e) {
    console.warn("Self-ping failed", e.message);
  }
}

// ---------- Reversal watcher ----------
let lastRevAt = 0;
const REV_COOLDOWN_MS = 90 * 1000;
async function reversalWatcherOnce() {
  try {
    const { data: kl1, source } = await fetchKlines(RAW_SYMBOL, "1m", 50);
    if (!kl1 || kl1.length < 3) return;
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
      const feat = mlExtractFeatures({ klines15: kl1.slice(-20), lastCandle: last, avgVol20: avgVol, divergenceSign:0, ellConf:0, systemBias:0 });
      const prob = mlPredict(feat);
      const txt = `🚨 <b>Reversal Watcher</b>\n${nowStr()}\nSymbol: <b>${RAW_SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b>\nVolume: ${last.volume.toFixed(0)} (avg ${avgVol.toFixed(0)})\nPrice: ${last.close.toFixed(2)}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(txt);
      // soft training
      try { mlTrain(feat, prob > (ML.threshold || ML_MODEL_FILE? ML.threshold: ML_ALERT_THRESH) ? 1 : 0); } catch(e){}
    }
  } catch(e) { console.warn("reversalWatcherOnce error", e.message); }
}

// ---------- Main analyze & report ----------
async function analyzeAndReport() {
  try {
    // fetch TF klines
    const tfData = {};
    const sourcesUsed = {};
    for (const tf of TIMEFRAMES) {
      const { data, source } = await fetchKlines(RAW_SYMBOL, tf, tf === "1m" ? 120 : 100);
      tfData[tf] = data || [];
      sourcesUsed[tf] = source || "None";
    }
    const base = tfData["15m"] || [];
    if (!base || base.length < 8) {
      const msg = `❗ Not enough 15m candles (${(base||[]).length}) — skipping (${nowStr()})`;
      console.warn(msg);
      try { await sendTG(msg); } catch(e){}
      return;
    }
    const lastPrice = base.at(-1).close;
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base, 14);

    // per-TF analysis
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
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Strength ${Math.round(d.strength)} | Source: ${sourcesUsed[tf]}\nTrend: ${trend}\n`;
    }

    // news & socials
    const [newsRes, redditRes, nitterRes] = await Promise.allSettled([fetchHeadlines(), fetchReddit(8), fetchNitter("bitcoin",8)]);
    const newsArr = newsRes.status==="fulfilled"? newsRes.value : [];
    const redditArr = redditRes.status==="fulfilled"? redditRes.value : [];
    const tweetsArr = nitterRes.status==="fulfilled"? nitterRes.value : [];

        // news sentiment
    const posK = ["surge","approval","bull","bullish","gain","rally","soar","support","up","rise","positive","adopt"];
    const negK = ["crash","hack","ban","selloff","bear","bearish","dump","fall","fear","lawsuit","liquidation","negative"];
    let newsScore = 0;
    for (const n of newsArr) {
      const t = (n.title||"").toLowerCase();
      for (const k of posK) if (t.includes(k)) newsScore++;
      for (const k of negK) if (t.includes(k)) newsScore--;
    }
    const newsImpact = Math.abs(newsScore) >= 3 ? "High" : Math.abs(newsScore) >=1 ? "Medium" : "Low";

    // merge signals
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct)/100 ));
    const newsNorm = Math.max(-1, Math.min(1, newsScore/6 ));
    let redditScoreVal = 0;
    for (const r of redditArr) redditScoreVal += (r.title? (/bull/i.test(r.title)?1:(/bear/i.test(r.title)?-1:0)):0);
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal/6 ));
    const COMBINED = 0.55*techNorm + 0.30*newsNorm + 0.15*socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const confidencePct = Math.round(Math.min(99, Math.abs(COMBINED)*100));
    if (label.includes("Bull")) bull++; if (label.includes("Bear")) bear++;

    // fib range and targets
    const entryBuy = fib? fib.fib618: NaN;
    const entrySell = fib? fib.fib382: NaN;
    const breakoutRange = (isFinite(entryBuy) && isFinite(entrySell)) ? `${Math.min(entryBuy,entrySell).toFixed(2)} - ${Math.max(entryBuy,entrySell).toFixed(2)}` : "N/A";
    const tgs = getTargetsAndSL(lastPrice, label, atrVal);

    // ML: train on previous pred if exists
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15) {
          const prevClose = prev.prevClose || prev.klines15.at(-1).close;
          const actual = lastPrice > prevClose ? "Bullish" : lastPrice < prevClose ? "Bearish" : "Neutral";
          const labelTrain = (prev.predLabel && prev.predLabel.includes("Bull") && actual.includes("Bull")) || (prev.predLabel && prev.predLabel.includes("Bear") && actual.includes("Bear")) ? 1 : 0;
          const featPrev = mlExtractFeatures({ klines15: prev.klines15, lastCandle: prev.klines15.at(-1), avgVol20: avgVolume(prev.klines15,20), divergenceSign: prev.divSign||0, ellConf:prev.ellConf||0, systemBias: biasToSign(prev.predLabel) });
          const probBefore = mlPredict(featPrev);
          mlTrain(featPrev, labelTrain);
          console.log("ML trained on previous pred:", labelTrain, "probBefore", probBefore.toFixed(3));
        }
      }
    } catch(e) { console.warn("ml training prev error", e.message); }

    // current features & predict
    const feat = mlExtractFeatures({ klines15: base.slice(-40), lastCandle: base.at(-1), avgVol20: avgVolume(base,20), divergenceSign: bull>bear?1:(bear>bull?-1:0), ellConf:0, systemBias: biasToSign(label) });
    const mlProb = mlPredict(feat);

    // save last pred
    try {
      const lastPredPayload = { predLabel: label, predProb: mlProb, prevClose: lastPrice, klines15: base.slice(-40), divSign: bull>bear?1:(bear>bull?-1:0), ts: Date.now() };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload,null,2));
    } catch(e){ console.warn("save last pred error", e.message); }

    // accuracy update
    try {
      if (fs.existsSync(LAST_REPORT_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_REPORT_FILE,"utf8"));
        if (prev && prev.pred && prev.prevClose) pushAccLocal(prev.pred === (lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral"));
      }
      fs.writeFileSync(LAST_REPORT_FILE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() }, null, 2));
    } catch(e){ console.warn("acc update error", e.message); }

    // build message
    let msg = `<b>🤖 ${RAW_SYMBOL} — AI Trader v8.7</b>\n🕒 ${nowStr()}\n`;
    msg += `${perTfText}\n`;
    msg += `📡 Data Sources (TF): ${TIMEFRAMES.map(tf=>`${tf}:${sourcesUsed[tf]||"None"}`).join(" | ")}\n\n`;
    msg += `🎯 <b>Targets:</b>\nTP1: ${tgs.tp1} | TP2: ${tgs.tp2} | TP3: ${tgs.tp3}\nSL: ${tgs.sl}\n📊 Breakout Range: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Overall Bias:</b> ${label} | Confidence: ${confidencePct}%\n💰 Last Price: ${lastPrice.toFixed(2)}\n📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}%\n📉 ATR(14): ${(atrVal||0).toFixed(2)}\nAccuracy(Last10): ${getAccLocal(10)}%\n📰 News Impact: ${newsImpact}\n\n`;
    if (newsArr.length) { msg += `<b>📰 Headlines:</b>\n`; for (const n of newsArr) msg += `• ${n.title}\n`; } else msg += `<b>📰 Headlines:</b> No recent headlines\n`;
    msg += `\n🤖 ML Smart Prob: ${(mlProb*100).toFixed(1)}% (threshold ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n`;
    if (mlProb >= (ML.threshold||ML_ALERT_THRESH) && confidencePct > 40) msg += `\n🚨 <b>ML Smart Alert:</b> ${(mlProb*100).toFixed(1)}% probability of ${label} — watch breakout zone ${breakoutRange}\n`;

    // send message (chunked)
    const chunks = chunkMessage(msg);
    for (const c of chunks) { try { await sendTG(c); } catch(e){ console.warn("sendTG chunk fail", e.message); } await new Promise(r=>setTimeout(r,300)); }
    console.log("✅ Report sent", nowStr());

  } catch(err) {
    console.error("analyzeAndReport error:", err.message);
    try { await sendTG(`<b>⚠️ AI Trader error</b>\n${err.message}\n${nowStr()}`); } catch(e){}
  }
}

// ---------- INIT & Scheduler ----------
console.log("🤖 AI Trader v8.7 starting...");
analyzeAndReport();
setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
setInterval(selfPing, 3 * 60 * 1000);

// ---------- HTTP server (keepalive status) ----------
const app = express();
app.get("/", (req,res) => res.send("AI Trader v8.7 running ✅"));
app.listen(SERVER_PORT, () => console.log("Server listening on port", SERVER_PORT));