/**
 * aiTraderBot_v8.6_full.js
 * v8.6 + ML + AutoMirror + ReversalFix (single-file)
 *
 * Requirements:
 *   npm i node-fetch@3 express dotenv
 * Run:
 *   node aiTraderBot_v8.6_full.js
 *
 * Notes:
 *  - Ensure package.json has "type":"module" or adapt imports to require()
 *  - Provide BOT_TOKEN and CHAT_ID in .env
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.7"); // probability threshold
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const SERVER_PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// proxies & mirrors
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];
// Binance mirrors / fallback endpoints
const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com"
];

const TIMEFRAMES = ["1m","5m","15m","30m","1h"];

// storage files
const ML_MODEL_FILE = "./ml_model_v86.json";
const LAST_PRED_FILE = "./last_pred_v86.json";
const ACC_FILE = "./acc_v86.json";
const LAST_REPORT_FILE = "./last_report_prevclose_v86.json";

// safety
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in environment — aborting.");
  process.exit(1);
}

// ---------- helpers ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

async function safeFetch(url, opts = {}, tryProxies = true, timeoutMs = 12000) {
  // try direct
  try {
    const r = await fetch(url, { ...opts, timeout: timeoutMs });
    if (r.ok) return r;
    // if 4xx/5xx, let caller handle body
    return r;
  } catch (e) {
    // continue to proxies
  }
  if (!tryProxies) throw new Error("fetch failed direct and no-proxy");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, { ...opts, timeout: timeoutMs });
      if (r.ok) return r;
    } catch (e) {}
  }
  throw new Error("All fetch attempts failed");
}

function chunkMessage(text, chunkSize = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += chunkSize) parts.push(text.slice(i, i + chunkSize));
  return parts;
}

async function sendTG(text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: opts.parse_mode || "HTML",
    disable_web_page_preview: opts.disable_web_page_preview !== false
  };
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
  const json = await r.json();
  if (!json.ok) {
    console.warn("Telegram send failed", JSON.stringify(json));
    throw new Error("Telegram send failed");
  }
  return json;
}

// ---------- Binance klines with mirror fallback ----------
async function fetchKlinesFromBase(baseUrl, symbol, interval, limit=100) {
  const url = `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const r = await safeFetch(url);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("non-array klines");
    return j.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  } catch (err) {
    // throw to higher level
    throw err;
  }
}

async function fetchKlines(symbol, interval="15m", limit=100) {
  // try endpoints in order; catch blocked / restricted responses and try next
  for (const ep of BINANCE_ENDPOINTS) {
    try {
      const data = await fetchKlinesFromBase(ep, symbol, interval, limit);
      return data;
    } catch (err) {
      // if error mentions "restricted" or unexpected payload, try proxies next
      console.warn("Binance mirror", ep, "failed:", err.message);
      continue;
    }
  }
  // last resort: try safeFetch with proxies to public api url
  const fallbackUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const r = await safeFetch(fallbackUrl, {}, true);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("fallback non-array");
    return j.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  } catch (err) {
    console.warn("All Binance fetch attempts failed:", err.message);
    return []; // return empty so analyzer can skip gracefully
  }
}

// ---------- simple news/social fetchers ----------
async function fetchRSS(url, limit=6) {
  try {
    const r = await safeFetch(url);
    const t = await r.text();
    const items = t.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const tmatch = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1] || "";
      return tmatch.replace(/<!\[CDATA\[|\]\]>/g,"").trim();
    });
  } catch (e) { console.warn("fetchRSS", url, e.message); return []; }
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

async function fetchReddit(limit=6) {
  try {
    const url = `https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!j.data) return [];
    return j.data.children.map(c => ({ title: c.data.title || "", ups: c.data.ups || 0 }));
  } catch (e) { console.warn("fetchReddit", e.message); return []; }
}

async function fetchNitter(q="bitcoin", limit=6) {
  try {
    const url = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`;
    const r = await safeFetch(url);
    const html = await r.text();
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    return matches.slice(0,limit).map(m => m[1].replace(/<[^>]+>/g,"").trim());
  } catch (e) { console.warn("fetchNitter", e.message); return []; }
}

// ---------- analysis helpers ----------
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((a,b)=>a+b.volume,0);
  return s / slice.length;
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
  const trs=[];
  for (let i=1;i<klines.length;i++){
    const cur=klines[i], prev=klines[i-1];
    const tr = Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((a,b)=>a+b,0);
  return sum/period;
}

// Candle pattern detectors (Doji,Hammer,ShootingStar)
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
  return { isDoji: isDoji?1:0, isHammer: isHammer?1:0, isShooting: isShooting?1:0, body, range };
}

// Targets & SL
function getTargetsAndSL(price, dir="Neutral") {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  const move = price * 0.005;
  if (dir.includes("Bull")) {
    return { tp1:(price+move).toFixed(2), tp2:(price+move*2).toFixed(2), tp3:(price+move*3).toFixed(2), sl:(price-move).toFixed(2) };
  } else if (dir.includes("Bear")) {
    return { tp1:(price-move).toFixed(2), tp2:(price-move*2).toFixed(2), tp3:(price-move*3).toFixed(2), sl:(price+move).toFixed(2) };
  } else return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
}

// ---------- local accuracy store ----------
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while (arr.length>100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr));
  } catch(e){ console.warn("pushAccLocal err", e.message); }
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

// ---------- tiny ML (online logistic) ----------
function mlLoad() {
  try { if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8")); }
  catch(e){ console.warn("mlLoad", e.message); }
  return { w:null, bias:0, n_features:0, lr:0.02, l2:0.0001, trained:0 };
}
function mlSave(m){ try{ fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(m,null,2)); }catch(e){ console.warn("mlSave", e.message); } }
let ML = mlLoad();

function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave(ML);
    console.log("ML initialized n_features=", n);
  }
}
function sigmoid(z){ return 1 / (1 + Math.exp(-z)); }
function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const z = ML.bias + features.reduce((s,v,i)=> s + (ML.w[i]||0) * (v||0), 0);
  return sigmoid(z);
}
function mlTrain(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const lr = ML.lr || 0.02, l2 = ML.l2 || 0.0001;
  const p = mlPredict(features);
  const err = (label - p);
  for (let i=0;i<features.length;i++){
    ML.w[i] += lr * (err * (features[i]||0) - l2 * (ML.w[i]||0));
  }
  ML.bias += lr * err;
  ML.trained = (ML.trained||0) + 1;
  if (ML.trained % 5 === 0) mlSave(ML);
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
  if (!RENDER_EXTERNAL_URL) return;
  let url = RENDER_EXTERNAL_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  try { const r = await fetch(url); console.log("Self-ping", r.status); } catch(e) { console.warn("selfPing failed", e.message); }
}

// ---------- Reversal watcher (standalone) ----------
const REV_COOLDOWN_SEC = 90; // per-symbol cooldown
let lastRevAt = 0;

async function reversalWatcherOnce() {
  try {
    const kl1 = await fetchKlines(SYMBOL, "1m", 30);
    if (!kl1 || kl1.length < 2) return;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = avgVolume(kl1, 20) || 1;
    const patt = detectCandlePatternSingle(last, prev);
    const volSpike = last.volume > avgVol * 1.5;
    const now = Date.now();
    if (now - lastRevAt < REV_COOLDOWN_SEC*1000) return; // cooldown
    let reason = null;
    if (patt.isHammer && volSpike) reason = "Hammer";
    if (patt.isDoji && volSpike) reason = "Doji";
    if (patt.isShooting && volSpike) reason = "Shooting Star";
    if (reason) {
      lastRevAt = now;
      const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
      const txt = `🚨 <b>Reversal Watcher</b>\n${nowStr()}\nSymbol: <b>${SYMBOL}</b>\nPattern: <b>${reason}</b>\nCandle body: ${patt.body.toFixed(2)} | range: ${patt.range.toFixed(2)}\nVolume: ${last.volume.toFixed(0)} (avg ${avgVol.toFixed(0)}) — spike confirmed\nPossible short-term bias: <b>${dir}</b>\nPrice: ${last.close.toFixed(2)}\n`;
      try { await sendTG(txt); console.log("Reversal alert sent"); } catch(e){ console.warn("Reversal send failed", e.message); }
    }
  } catch (e) {
    console.warn("Reversal watcher failed:", e.message);
  }
}

// ---------- Main analyze & report ----------
async function analyzeAndReport() {
  try {
    // fetch all TFs
    const tfData = {};
    for (const tf of TIMEFRAMES) {
      tfData[tf] = await fetchKlines(SYMBOL, tf, tf === "1m" ? 120 : 100);
    }
    const base = tfData["15m"] || [];
    if (!base || base.length < 8) {
      const txt = `❗ Not enough 15m candles (${base.length}) — skipping (${nowStr()})`;
      console.warn(txt);
      try { await sendTG(txt); } catch(e){ console.warn("sendTG fail", e.message); }
      return;
    }

    const lastPrice = base.at(-1).close;
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base, 14);

    // per-TF analysis
    let bull = 0, bear = 0, totalStrength = 0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = kl.length > 1 ? ((kl.at(-1).close - kl[0].close)/(kl[0].close||1))*100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bull++;
      if (d.type.includes("Bear")) bear++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Strength ${Math.round(d.strength)}\nTrend: ${trend}\n`;
    }

    // fib breakout range
    const entryBuy = fib? fib.fib618 : NaN;
    const entrySell = fib? fib.fib382 : NaN;
    const breakoutRange = (isFinite(entryBuy) && isFinite(entrySell)) ? `${Math.min(entryBuy,entrySell).toFixed(2)} - ${Math.max(entryBuy,entrySell).toFixed(2)}` : "N/A";

    // news/social
    const [newsRes, redditRes, nitterRes] = await Promise.allSettled([
      fetchHeadlines(), fetchReddit(8), fetchNitter("bitcoin",8)
    ]);
    const newsArr = newsRes.status==="fulfilled"? newsRes.value : [];
    const redditArr = redditRes.status==="fulfilled"? redditRes.value : [];
    const twitterArr = nitterRes.status==="fulfilled"? nitterRes.value : [];

    // news sentiment simple heuristic
    const posK = ["bull","surge","gain","rally","support","up","positive","soar","adopt","approval"];
    const negK = ["bear","dump","selloff","crash","hack","lawsuit","ban","fall","negative"];
    let newsScore = 0;
    for (const n of newsArr) {
      const t = (n.title||"").toLowerCase();
      for (const k of posK) if (t.includes(k)) newsScore++;
      for (const k of negK) if (t.includes(k)) newsScore--;
    }
    let newsImpact = "Low";
    if (Math.abs(newsScore) >= 3) newsImpact = "High";
    else if (Math.abs(newsScore) >= 1) newsImpact = "Medium";

    // merge signals
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct)/100 ));
    const newsNorm = Math.max(-1, Math.min(1, newsScore/6 ));
    let redditScoreVal = 0;
    for (const r of redditArr) redditScoreVal += (r.title? (/bull/i.test(r.title)?1:(/bear/i.test(r.title)?-1:0)):0);
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal/6 ));
    const COMBINED = 0.55*techNorm + 0.30*newsNorm + 0.15*socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const rawConf = Math.abs(COMBINED);
    const confidencePct = Math.round(Math.min(99, rawConf * 100));

    if (label.includes("Bull")) bull++;
    if (label.includes("Bear")) bear++;

    // targets
    const tgs = getTargetsAndSL(lastPrice, label);

    // ---------- ML: train on previous pred if exists ----------
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15 && typeof prev.predProb === "number") {
          const prevClose = prev.prevClose || 0;
          const actualLabel = lastPrice > prevClose ? "Bullish" : lastPrice < prevClose ? "Bearish" : "Neutral";
          const labelTrain = (prev.predLabel && prev.predLabel.includes("Bull") && actualLabel.includes("Bull")) ||
                             (prev.predLabel && prev.predLabel.includes("Bear") && actualLabel.includes("Bear")) ? 1 : 0;
          const featPrev = mlExtractFeatures({
            klines15: prev.klines15,
            lastCandle: prev.klines15.at(-1),
            avgVol20: avgVolume(prev.klines15,20),
            divergenceSign: prev.divSign||0,
            ellConf: 0,
            systemBias: biasToSign(prev.predLabel)
          });
          const probBefore = mlPredict(featPrev);
          mlTrain(featPrev, labelTrain);
          console.log("ML trained on previous prediction label", labelTrain, "probBefore", probBefore.toFixed(3));
        }
      }
    } catch (e) { console.warn("ML training prev error", e.message); }

    // features for current
    const feat = mlExtractFeatures({
      klines15: base.slice(-40),
      lastCandle: base.at(-1),
      avgVol20: avgVolume(base,20),
      divergenceSign: bull>bear?1:(bear>bull?-1:0),
      ellConf: 0,
      systemBias: biasToSign(label)
    });
    const mlProb = mlPredict(feat);

    // save last pred for future training
    try {
      const lastPredPayload = {
        predLabel: label,
        predProb: mlProb,
        prevClose: lastPrice,
        klines15: base.slice(-40),
        divSign: bull>bear?1:(bear>bull?-1:0),
        ts: Date.now()
      };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload));
    } catch(e){ console.warn("save last pred error", e.message); }

    // accuracy update
       try {
      if (fs.existsSync(LAST_REPORT_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_REPORT_FILE,"utf8"));
        if (prev && prev.pred && prev.prevClose) {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(LAST_REPORT_FILE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() }));
    } catch(e){ console.warn("acc update error", e.message); }

    // build message
    let msg = `<b>🤖 ${SYMBOL} — AI Trader v8.6+ML</b>\n🕒 ${nowStr()}\n`;
    msg += perTfText + "\n";
    msg += `🎯 <b>Targets:</b>\nTP1: ${tgs.tp1} | TP2: ${tgs.tp2} | TP3: ${tgs.tp3}\nSL: ${tgs.sl}\n📊 Breakout Range: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Overall Bias:</b> ${label} | Confidence: ${confidencePct}%\n💰 Last Price: ${lastPrice.toFixed(2)}\n📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}%\n📉 ATR(14): ${(atrVal||0).toFixed(2)}\nAccuracy(Last10): ${getAccLocal(10)}%\n📰 News Impact: ${newsImpact}\n\n`;

    if (newsArr.length) {
      msg += `<b>📰 Headlines:</b>\n`;
      for (const n of newsArr) msg += `• ${n.title}\n`;
    } else msg += `<b>📰 Headlines:</b> No recent headlines\n`;

    msg += `\n🤖 ML Smart Prob: ${(mlProb*100).toFixed(1)}% (threshold ${(ML_ALERT_THRESH*100).toFixed(0)}%)\n`;
    if (mlProb >= ML_ALERT_THRESH && confidencePct > 40) {
      msg += `\n🚨 <b>ML Smart Alert:</b> ${(mlProb*100).toFixed(1)}% probability of ${label} move — watch breakout zone\n`;
    }

    // send chunked
    const chunks = chunkMessage(msg);
    for (const c of chunks) {
      try { await sendTG(c, { parse_mode: "HTML" }); } catch(e){ console.warn("sendTG chunk failed", e.message); }
      await new Promise(r=>setTimeout(r, 400)); // small pause
    }
    console.log("✅ Report sent", nowStr());

  } catch (err) {
    console.error("analyzeAndReport error", err.message);
  }
}

// ---------- Scheduler ----------
console.log("🤖 AI Trader v8.6+ML starting...");
analyzeAndReport();
setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
setInterval(selfPing, 3 * 60 * 1000);

// ---------- minimal http server for self-ping / status ----------
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot v8.6+ML running ✓"));
app.listen(SERVER_PORT, () => console.log("Server listening on port", SERVER_PORT));