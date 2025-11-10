/**
 * aiTraderBot_v8_8_full.js
 * Full single-file bot (main) — multi-source klines, ML, news, reversal watcher, express keepalive
 *
 * Requirements:
 *  npm i node-fetch@3 express dotenv
 * Run:
 *  node aiTraderBot_v8_8_full.js
 *
 * Make sure package.json includes: "type": "module"
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
import { initTelegramCommands } from "./tg_commands.js"; // ensure tg_commands.js exists in same dir
dotenv.config();

// ---------------- CONFIG ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const RAW_SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.7");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// file storage
const ML_MODEL_FILE = "./ml_model_v88.json";
const LAST_PRED_FILE = "./last_pred_v88.json";
const ACC_FILE = "./acc_v88.json";
const LAST_REPORT_FILE = "./last_report_prevclose_v88.json";

const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
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

// safety
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

// ---------------- helpers ----------------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

function chunkMessage(text, chunkSize = 3800) {
  const parts = [];
  for (let i=0;i<text.length;i+=chunkSize) parts.push(text.slice(i,i+chunkSize));
  return parts;
}

async function sendTG(text, options = {}) {
  const chunks = chunkMessage(text, options.chunkSize || 3800);
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  for (const c of chunks) {
    const payload = {
      chat_id: CHAT_ID,
      text: c,
      parse_mode: options.parse_mode || "HTML",
      disable_web_page_preview: options.disable_web_page_preview !== false
    };
    try {
      const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
      const j = await r.json().catch(()=>({}));
      if (!j.ok) console.warn("Telegram send warning", j);
    } catch(e) {
      console.warn("Telegram send error", e.message);
    }
    await new Promise(r=>setTimeout(r, 200));
  }
}

async function safeFetch(url, opt = {}, tryProxies = true) {
  // direct
  try {
    const r = await fetch(url, opt);
    if (r.ok) return r;
    // still return if non-OK so caller can read body (error pages)
    return r;
  } catch(e){ /* continue to proxies */ }
  if (!tryProxies) throw new Error("fetch failed (no proxy)");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, opt);
      if (r.ok) return r;
    } catch (e) { /* continue */ }
  }
  throw new Error("All fetch attempts failed");
}

// ---------------- symbol normalization ----------------
function normalizeSymbols(raw) {
  const up = raw.toUpperCase();
  let binSymbol = up.replace(/[-_]/g,"");
  // coinbase wants BTC-USD style
  let coinbaseSymbol;
  if (binSymbol.endsWith("USDT") || binSymbol.endsWith("USD")) {
    const base = binSymbol.replace(/(USDT|USD)$/i,"");
    coinbaseSymbol = `${base}-USD`;
  } else if (binSymbol.includes("/")) coinbaseSymbol = binSymbol.replace("/","-");
  else coinbaseSymbol = binSymbol + "-USD";
  let coingeckoId = "bitcoin";
  if (/^BTC/.test(binSymbol)) coingeckoId = "bitcoin";
  else if (/^ETH/.test(binSymbol)) coingeckoId = "ethereum";
  else coingeckoId = binSymbol.slice(0,3).toLowerCase();
  return { binSymbol, coinbaseSymbol, coingeckoId };
}
const SYMBOLS = normalizeSymbols(RAW_SYMBOL);

// ---------------- Klines fetchers (multi-source fallback) ----------------
async function fetchKlinesBinance(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await fetch(url);
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (!Array.isArray(j)) throw new Error("not array");
        return j.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
      } catch(e) {
        console.warn("binance mirror non-array / error:", base, e.message);
        continue;
      }
    } catch(e){ console.warn("fetchKlinesBinance err", base, e.message); continue; }
  }
  throw new Error("All Binance mirrors failed");
}

async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=80) {
  const granMap = { "1m":60, "5m":300, "15m":900, "30m":1800, "1h":3600 };
  const gran = granMap[interval] || 900;
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  try {
    const r = await safeFetch(url, {}, true);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("Coinbase not array");
    const sorted = j.slice(-limit).sort((a,b)=>a[0]-b[0]);
    return sorted.map(k => ({ time: k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume: (k[5]||0) }));
  } catch(e) { throw new Error("Coinbase failed: " + e.message); }
}

async function fetchKlinesCoinGecko(id="bitcoin", interval="15m", limit=80) {
  // coingecko OHLC (days=1) - coarse but a last-resort fallback
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("coingecko invalid");
    const slice = j.slice(-limit);
    return slice.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:0 }));
  } catch(e) { throw new Error("CoinGecko failed: " + e.message); }
}

async function fetchKlines(symbolRaw, interval="15m", limit=80) {
  // tries Binance -> Coinbase -> CoinGecko
  const { binSymbol, coinbaseSymbol, coingeckoId } = SYMBOLS;
  try {
    const kl = await fetchKlinesBinance(binSymbol, interval, limit);
    return { data: kl, source: "Binance" };
  } catch(e) {
    console.warn("Binance failed:", e.message);
  }
  try {
    const kl = await fetchKlinesCoinbase(coinbaseSymbol, interval, limit);
    return { data: kl, source: "Coinbase" };
  } catch(e) {
    console.warn("Coinbase failed:", e.message);
  }
  try {
    const kl = await fetchKlinesCoinGecko(coingeckoId, interval, limit);
    return { data: kl, source: "CoinGecko" };
  } catch(e) {
    console.warn("CoinGecko failed:", e.message);
  }
  return { data: [], source: "None" };
}

// ---------------- News & Social ----------------
async function fetchRSS(url, limit=6) {
  try {
    const r = await safeFetch(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g,"").trim();
    });
  } catch(e) { console.warn("fetchRSS", url, e.message); return []; }
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

// ---------------- Analysis helpers ----------------
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((a,b)=>a + (b.volume||0), 0);
  return s / slice.length;
}
function calcVolSent(klines) {
  let buy=0,sell=0;
  for (const k of klines) { if (k.close > k.open) buy += (k.volume||0); else sell += (k.volume||0); }
  const tot = buy + sell || 1;
  const buyPct = (buy/tot)*100, sellPct = (sell/tot)*100;
  const bias = buyPct > sellPct ? "Bullish" : buyPct < sellPct ? "Bearish" : "Neutral";
  return { buyPct, sellPct, bias, diff: Math.abs(buyPct - sellPct) };
}
function calcFib(kl) {
  if (!kl||!kl.length) return null;
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
  return sum/period;
}
function detectDivergence(kl) {
  if (!kl || kl.length < 2) return { type: "Neutral", dp:0, dv:0, strength:0 };
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
  if (!last) return { isDoji:0,isHammer:0,isShooting:0,body:0,range:0 };
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

// ---------------- Accuracy tracking ----------------
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while(arr.length>100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr,null,2));
  } catch(e){ console.warn("pushAccLocal", e.message); }
}
function getAccLocal(lastN=10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN);
    const s = slice.reduce((a,b)=>a+b,0);
    return ((s/slice.length)*100).toFixed(1);
  } catch(e){ return "N/A"; }
}

// ---------------- Tiny ML module (online logistic-ish) ----------------
function mlLoad() {
  try { if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8")); } catch(e){ console.warn("mlLoad", e.message); }
  return { w:null, bias:0, n_features:0, lr:0.02, l2:0.0001, trained:0, threshold: ML_ALERT_THRESH };
}
function mlSave(m) {
  try { fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(m||ML,null,2)); } catch(e){ console.warn("mlSave", e.message); }
}
let ML = mlLoad();

function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave();
    console.log("ML initialized n_features=", n);
  }
}
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  let z = ML.bias;
  for (let i=0;i<features.length;i++) z += (ML.w[i]||0) * (features[i]||0);
  return sigmoid(z);
}
function mlTrain(features,label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const p = mlPredict(features);
  const err = label - p;
  const lr = ML.lr, l2 = ML.l2;
  for (let i=0;i<features.length;i++){
    ML.w[i] += lr * (err * (features[i]||0) - l2 * (ML.w[i]||0));
  }
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

// ---------------- Self-ping ----------------
async function selfPing() {
  if (!SELF_PING_URL) return;
  let url = SELF_PING_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  try {
    const r = await fetch(url);
    console.log("Self-ping", r.status);
  } catch(e){ console.warn("selfPing failed", e.message); }
}

// ---------------- Reversal watcher ----------------
let lastRevAt = 0;
const REV_COOLDOWN_MS = 90 * 1000;
async function reversalWatcherOnce() {
  try {
    const { data: kl1, source } = await fetchKlines(RAW_SYMBOL, "1m", 80);
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
      const feat = mlExtractFeatures({ klines15: kl1.slice(-40), lastCandle: last, avgVol20: avgVol, divergenceSign:0, ellConf:0, systemBias:0 });
      const prob = mlPredict(feat);
      const txt = `🚨 <b>Reversal Watcher</b>\n${nowStr()}\nSymbol: <b>${RAW_SYMBOL}</b>\nSource: ${source}\nPattern: <b>${reason}</b>\nVolume: ${Math.round(last.volume)} (avg ${Math.round(avgVol)})\nPrice: ${last.close.toFixed(2)}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(txt);
      try { mlTrain(feat, prob > (ML.threshold || ML_ALERT_THRESH) ? 1 : 0); } catch(e){}
    }
  } catch(e){ console.warn("reversalWatcherOnce error", e.message); }
}

// ---------------- News sentiment helper ----------------
function calcNewsSentiment(titles) {
  if (!titles || !titles.length) return "Neutral";
  const posK = ["gain","bull","rally","surge","soar","support","positive","up","approval"];
  const negK = ["crash","bear","dump","selloff","ban","hack","lawsuit","negative","fall","drop","loss"];
  let score = 0;
  for (const t of titles) {
    const s = (t||"").toLowerCase();
    for (const k of posK) if (s.includes(k)) score++;
    for (const k of negK) if (s.includes(k)) score--;
  }
  if (score >= 3) return "High";
  if (score >= 1) return "Medium";
  if (score <= -3) return "High Bearish";
  if (score <= -1) return "Medium Bearish";
  return "Neutral";
}

// ---------------- Hybrid Elliott (very small heuristic) ----------------
function elliottHeuristic15(kl) {
  // very small heuristic: count directional impulses in last 10 candles
  if (!kl || kl.length < 6) return { label:"Unknown", conf:0 };
  let up=0,down=0;
  for (let i=1;i<kl.length;i++){ if (kl[i].close>kl[i-1].close) up++; else down++; }
  const conf = Math.round((Math.abs(up-down)/kl.length)*100);
  const label = up>down ? "Impulse Wave" : down>up ? "Corrective" : "Transitional";
  return { label, conf };
}
function elliottHybrid(kl15, kl30) {
  const e15 = elliottHeuristic15(kl15);
  const e30 = elliottHeuristic15(kl30);
  return { e15, e30 };
}

// ---------------- Main analysis & report ----------------
async function analyzeAndReport() {
  try {
    // fetch klines for TFs
    const tfData = {};
    const sourcesUsed = {};
    for (const tf of TIMEFRAMES) {
      const { data, source } = await fetchKlines(RAW_SYMBOL, tf, tf==="1m"?120:100);
      tfData[tf] = data || [];
      sourcesUsed[tf] = source || "None";
    }

    const base = tfData["15m"] || [];
    const base30 = tfData["30m"] || [];
    if (!base || base.length < 8) {
      const txt = `❗ Not enough 15m candles (${(base||[]).length}) — skipping report (${nowStr()})`;
      console.warn(txt);
      await sendTG(txt);
      return;
    }

    // tech
    const lastPrice = base.at(-1).close;
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base,14);
    const atr30 = atr(base30,14);

    // per-TF summaries
    let bullCount=0, bearCount=0, totalStrength=0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = kl.length>1 ? ((kl.at(-1).close - kl[0].close)/(kl[0].close||1))*100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bullCount++;
      if (d.type.includes("Bear")) bearCount++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Str ${Math.round(d.strength)} | Source: ${sourcesUsed[tf]}\nTrend: ${trend}`;
    }

    // news and social
    const [newsList, redditPosts, tweets] = await Promise.allSettled([fetchHeadlines(), fetchReddit(8), fetchNitter("bitcoin",8)]);
    const newsArr = newsList.status==="fulfilled"? newsList.value : [];
    const redditArr = redditPosts.status==="fulfilled"? redditPosts.value : [];
    const tweetsArr = tweets.status==="fulfilled"? tweets.value : [];
    const newsTitles = newsArr.map(n=>n.title||"");
    const newsImpact = calcNewsSentiment(newsTitles);

    // combine signals
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct)/100 ));
    let redditScoreVal = 0;
    for (const r of redditArr) { redditScoreVal += (r.title? ((/bull/i.test(r.title)?1:(/bear/i.test(r.title)?-1:0)) ) : 0); }
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal/6 ));
    const newsNorm = Math.max(-1, Math.min(1, newsTitles.length ? (newsTitles.length/6) * (newsImpact.startsWith("High")?1: newsImpact.startsWith("Medium")?0.5:0) : 0 ));
    const COMBINED = 0.55*techNorm + 0.30*newsNorm + 0.15*socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const confidencePct = Math.round(Math.min(99, Math.abs(COMBINED) * 100));
    if (label.includes("Bull")) bullCount++;
    if (label.includes("Bear")) bearCount++;

    // Elliott heuristics
    const ell = elliottHybrid(base.slice(-40), base30.slice(-40));
    // build targets using hybrid ATR+Fib+Elliott
    const fib618 = fib? fib.fib618 : NaN;
    const entryBuy = fib? fib.fib618 : NaN;
    const entrySell = fib? fib.fib382 : NaN;
    const breakoutMin = Math.min(entrySell||Infinity, entryBuy||Infinity);
    const breakoutMax = Math.max(entrySell||-Infinity, entryBuy||-Infinity);
    const breakoutRange = (isFinite(breakoutMin) && isFinite(breakoutMax)) ? `${breakoutMin.toFixed(2)} - ${breakoutMax.toFixed(2)}` : "N/A";

    let tp1="N/A", tp2="N/A", tp3="N/A", sl="N/A";
    // hybrid move: use ATR(15) or ATR(30) average times Elliott confidence
    const ellConf = ((ell.e15.conf||0) + (ell.e30.conf||0))/2;
    if (atrVal && isFinite(atrVal)) {
      const hybridFactor = 1 + (ellConf/100); // if ellConf 50% => factor 1.5
      const move = (atrVal + (isFinite(fib618) ? Math.abs(lastPrice - fib618) : 0)*0.2) * hybridFactor;
      if (label.includes("Bull")) {
        tp1 = (lastPrice + move).toFixed(2);
        tp2 = (lastPrice + move*1.8).toFixed(2);
        tp3 = (lastPrice + move*3).toFixed(2);
        sl  = (lastPrice - move*0.8).toFixed(2);
      } else if (label.includes("Bear")) {
        tp1 = (lastPrice - move).toFixed(2);
        tp2 = (lastPrice - move*1.8).toFixed(2);
        tp3 = (lastPrice - move*3).toFixed(2);
        sl  = (lastPrice + move*0.8).toFixed(2);
      }
    }

    // ML training on previous saved prediction (if exists)
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15 && typeof prev.predProb === "number") {
          const prevClose = prev.prevClose || 0;
          const actual = lastPrice > prevClose ? 1 : lastPrice < prevClose ? -1 : 0;
          const labelTrain = actual === (prev.predDir === "Bullish" ? 1 : prev.predDir === "Bearish" ? -1 : 0) ? 1 : 0;
          const featPrev = mlExtractFeatures({
            klines15: prev.klines15,
            lastCandle: prev.klines15.at(-1),
            avgVol20: avgVolume(prev.klines15,20),
            divergenceSign: prev.divSign||0,
            ellConf: prev.ellConf||0,
            systemBias: biasToSign(prev.predDir)
          });
          mlTrain(featPrev, labelTrain);
        }
      }
    } catch(e){ console.warn("ML train on prev error", e.message); }

    // prepare current features and predict
    const feat = mlExtractFeatures({
      klines15: base.slice(-40),
      lastCandle: base.at(-1),
      avgVol20: avgVolume(base,20),
      divergenceSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0),
      ellConf,
      systemBias: biasToSign(label)
    });
    const mlProb = mlPredict(feat);

    // save last pred for next training
    try {
      const lastPredPayload = {
        predDir: label,
        predProb: mlProb,
        prevClose: lastPrice,
        klines15: base.slice(-40),
        divSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0),
        ellConf,
        ts: Date.now()
      };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload,null,2));
    } catch(e){ console.warn("save last pred error", e.message); }

    // accuracy update using LAST_REPORT_FILE
    try {
      if (fs.existsSync(LAST_REPORT_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_REPORT_FILE,"utf8"));
        if (prev && prev.pred && prev.prevClose) {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(LAST_REPORT_FILE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() },null,2));
    } catch(e){ console.warn("acc update", e.message); }

    // build message
    let msg = `<b>🤖 ${RAW_SYMBOL} — AI Trader v8.8 (Hybrid)</b>\n🕒 ${nowStr()}\n`;
    msg += perTfText + "\n\n";
    msg += `🎯 <b>Targets (Hybrid ATR+Fib+Elliott):</b>\nTP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}\nSL: ${sl}\n📊 Breakout Zone: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Bias:</b> ${label} | Confidence: ${confidencePct}% | ML Prob: ${(mlProb*100).toFixed(1)}% (thr ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n`;
    msg += `💰 Price: ${lastPrice.toFixed(2)} | ATR(15m): ${(atrVal||0).toFixed(2)} | ATR(30m): ${(atr30||0).toFixed(2)}\n`;
    msg += `📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}% | Accuracy(Last10): ${getAccLocal(10)}%\n`;
    msg += `📰 News Impact: ${newsImpact}\nSources: ${Object.values(sourcesUsed).join(", ")}\n\n`;

    if (newsArr.length) {
      msg += `📰 <b>Headlines:</b>\n`;
      for (const n of newsArr) msg += `• ${n.title}\n`;
    } else {
      msg += `📰 <b>Headlines:</b> No recent headlines\n`;
    }

    // final
    await sendTG(msg);

    // store last report for /last endpoint
    try { fs.writeFileSync("./last_report_out_v88.json", JSON.stringify({ msg, ts: Date.now() },null,2)); } catch(e){}

  } catch(e) {
    console.error("analyzeAndReport error", e.message);
    try { await sendTG(`⚠️ Bot error: ${e.message}`); } catch(_){}
  }
}

// ---------------- start loop & express ----------------
async function startAll() {
  // ensure ML features initialised
  mlInit(9);
  // immediate
  await analyzeAndReport();
  await reversalWatcherOnce();
  // intervals
  setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
  if (SELF_PING_URL) setInterval(selfPing, 5 * 60 * 1000);
}

const app = express();
app.get("/", (_,res) => res.send("AI Trader v8.8 running"));
app.get("/check", async (_,res) => {
  try { await analyzeAndReport(); res.json({ ok:true }); } catch(e){ res.status(500).json({ ok:false, err:e.message }); }
});
app.get("/last", (_,res) => {
  try { const j = fs.existsSync("./last_report_out_v88.json") ? JSON.parse(fs.readFileSync("./last_report_out_v88.json","utf8")) : { ok:false }; res.json(j); } catch(e){ res.status(500).json({ ok:false, err:e.message }); }
});

// initialize tg commands integrations (this registers poller / commands)
initTelegramCommands({ BOT_TOKEN, CHAT_ID, AI_BASE_URL: `http://localhost:${PORT}` });

// listen
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAll().catch(e=>console.error("startAll error", e.message));
});