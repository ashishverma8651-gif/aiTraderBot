/**
 * aiTraderBot_v8.6_full_with_ML.js
 * - Full v8.6 features preserved (multi-TF, fib, ATR, news, socials, accuracy)
 * - ML Smart Alert integrated (online logistic-ish training)
 * - Mirror/fallback for Binance, proxy support, safe JSON checks
 * - Reversal watcher (1m) with Doji/Hammer/Shooting star + volume spike
 * - Self-ping, chunked Telegram messages, local persistence for model & accuracy
 *
 * Usage: node aiTraderBot_v8.6_full_with_ML.js
 * Requires: node-fetch@3, express, dotenv
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ========== CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70"); // 0..1
const ML_MODEL_FILE = process.env.ML_MODEL_FILE || "./ml_model_v86.json";
const LAST_PRED_FILE = process.env.LAST_PRED_FILE || "./last_pred_v86.json";
const ACC_FILE = process.env.ACC_FILE || "./acc_v86.json";
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || "10000", 10);

// Safety
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env - exiting.");
  process.exit(1);
}

const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];
const BINANCE_MIRRORS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com"
];

// ========== UTILITIES ==========
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
function chunkMessage(text, chunkSize = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += chunkSize) parts.push(text.slice(i, i + chunkSize));
  return parts;
}
async function sendTG(text, parseMode = "HTML") {
  // chunk long messages
  const parts = chunkMessage(text);
  for (const p of parts) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: p,
          parse_mode: parseMode,
          disable_web_page_preview: true
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) console.warn("Telegram send warn:", json);
    } catch (e) {
      console.warn("Telegram send error:", e.message);
    }
    // small pause to avoid flood
    await new Promise(r => setTimeout(r, 250));
  }
}

// safe fetch with optional proxy fallbacks and mirror fallback for Binance calls
async function safeFetch(url, opts = {}, tryProxies = true) {
  try {
    const r = await fetch(url, opts);
    if (r.ok) return r;
  } catch(e){ /* continue */ }
  if (!tryProxies) throw new Error("Direct fetch failed and proxies disabled");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, opts);
      if (r.ok) return r;
    } catch (e) { /* continue */ }
  }
  throw new Error("All safeFetch attempts failed");
}

// use Binance mirrors (best-effort)
async function fetchBinanceWithMirrors(path) {
  for (const base of BINANCE_MIRRORS) {
    const url = base.replace(/\/$/, "") + path;
    try {
      // try direct first
      const r = await fetch(url);
      if (!r.ok) { console.warn(`Binance mirror ${base} returned ${r.status}`); continue; }
      const j = await r.json().catch(() => null);
      if (Array.isArray(j) || (j && typeof j === "object")) return j;
    } catch (e) {
      console.warn("mirror fetch fail", base, e.message);
    }
  }
  // fallback: try proxy wrappers
  for (const proxy of PROXIES) {
    try {
      const purl = proxy + encodeURIComponent("https://api.binance.com" + path);
      const r = await fetch(purl);
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (Array.isArray(j) || (j && typeof j === "object")) return j;
    } catch (e) { /* continue */ }
  }
  throw new Error("All Binance mirrors/proxies failed");
}

// ========== FETCHERS ==========
async function fetchKlines(symbol, interval="15m", limit=80) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const data = await fetchBinanceWithMirrors(path);
    if (!Array.isArray(data)) throw new Error("Invalid klines payload");
    return data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  } catch (err) {
    console.warn("fetchKlines error:", err.message);
    return [];
  }
}

// News sources (best-effort)
async function fetchRSSProxy(url, limit=6) {
  try {
    const r = await safeFetch(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i) || [,""])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    });
  } catch(e) { console.warn("fetchRSSProxy", e.message); return []; }
}

async function fetchCoinDesk(limit=6) { return fetchRSSProxy("https://www.coindesk.com/arc/outboundfeeds/rss/", limit); }
async function fetchCoinTelegraph(limit=6) { return fetchRSSProxy("https://cointelegraph.com/rss", limit); }

async function fetchReddit(limit=10) {
  try {
    const r = await safeFetch(`https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`);
    const j = await r.json();
    if (!j?.data?.children) return [];
    return j.data.children.map(c => ({ title: c.data.title||"", ups: c.data.ups||0, created_utc: c.data.created_utc }));
  } catch(e) { console.warn("fetchReddit", e.message); return []; }
}

async function fetchNitter(q="bitcoin", limit=6) {
  try {
    const url = `https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`;
    const r = await safeFetch(url);
    const html = await r.text();
    const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)];
    return matches.slice(0, limit).map(m => m[1].replace(/<[^>]+>/g, "").trim());
  } catch(e) { console.warn("fetchNitter", e.message); return []; }
}

// ========== ANALYSIS HELPERS ==========
function avgVolume(klines, n=20) {
  if (!klines || !klines.length) return 0;
  const slice = klines.slice(-n);
  const sum = slice.reduce((s,k)=>s + (k.volume || 0), 0);
  return sum / slice.length;
}

function calcVolSent(klines) {
  let buy=0,sell=0;
  for (const k of klines) { if (k.close > k.open) buy += k.volume; else sell += k.volume; }
  const tot = buy + sell || 1;
  const buyPct = (buy / tot) * 100;
  const sellPct = (sell / tot) * 100;
  const bias = buyPct > sellPct ? "Bullish" : buyPct < sellPct ? "Bearish" : "Neutral";
  return { buyPct, sellPct, bias, diff: Math.abs(buyPct - sellPct) };
}

function calcFib(klines) {
  if (!klines || !klines.length) return null;
  const highs = klines.map(k => k.high), lows = klines.map(k => k.low);
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
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i=1;i<klines.length;i++){
    const cur = klines[i], prev = klines[i-1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/slice.length;
}

function detectDivergence(kl) {
  if (!kl || kl.length < 2) return { type: "Neutral", dp: 0, dv: 0, strength: 0 };
  const last = kl.at(-1), prev = kl.at(-2);
  const dp = ((last.close - prev.close) / (prev.close || 1)) * 100;
  const dv = ((last.volume - prev.volume) / (prev.volume || 1)) * 100;
  let type = "Neutral";
  if (dp > 0 && dv < 0) type = "Bearish Divergence";
  if (dp < 0 && dv > 0) type = "Bullish Divergence";
  const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
  return { type, dp, dv, strength };
}

function detectCandlePattern(kl) {
  if (!kl || !kl.length) return { isDoji:0, isHammer:0, isShooting:0, body:0, range:0 };
  const last = kl.at(-1), prev = kl.at(-2) || last;
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > prev.close;
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < prev.close;
  return { isDoji: isDoji?1:0, isHammer: isHammer?1:0, isShooting: isShooting?1:0, body, range };
}

function getTargetsAndSL(price, dir="Neutral", atrVal=null) {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A", breakoutLow:"N/A", breakoutHigh:"N/A" };
  const move = atrVal || price * 0.005;
  if (dir.includes("Bull")) {
    return { tp1:(price+move).toFixed(2), tp2:(price+move*1.8).toFixed(2), tp3:(price+move*3).toFixed(2), sl:(price-move*0.8).toFixed(2), breakoutLow:(price-move*1.5).toFixed(2), breakoutHigh:(price+move*1.5).toFixed(2) };
  } else if (dir.includes("Bear")) {
    return { tp1:(price-move).toFixed(2), tp2:(price-move*1.8).toFixed(2), tp3:(price-move*3).toFixed(2), sl:(price+move*0.8).toFixed(2), breakoutLow:(price-move*1.5).toFixed(2), breakoutHigh:(price+move*1.5).toFixed(2) };
  } else {
    return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A", breakoutLow:(price-move*1.5).toFixed(2), breakoutHigh:(price+move*1.5).toFixed(2) };
  }
}

// ========== ACCURACY Tracking (local JSON) ==========
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while (arr.length > 50) arr.shift();
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

// ========== ML: online logistic-ish small model ==========
let ML = null;
function mlLoad() {
  try {
    if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8"));
  } catch(e){ console.warn("mlLoad", e.message); }
  return { w: null, bias: 0, lr: 0.02, l2: 0.0001, trained: 0, threshold: ML_ALERT_THRESH };
}
function mlSave() {
  try { fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(ML,null,2)); } catch(e){ console.warn("mlSave", e.message); }
}
function mlInit(n) {
  if (!ML.w || ML.w.length !== n) {
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0;
    ML.trained = 0;
    mlSave();
    console.log("ML initialized features =", n);
  }
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function mlPredict(featuresArr) {
  if (!ML.w || ML.w.length !== featuresArr.length) mlInit(featuresArr.length);
  let z = ML.bias;
  for (let i=0;i<featuresArr.length;i++) z += (ML.w[i]||0) * featuresArr[i];
  return sigmoid(z);
}
function mlTrain(featuresArr, label) {
  if (!ML.w || ML.w.length !== featuresArr.length) mlInit(featuresArr.length);
  const p = mlPredict(featuresArr);
  const err = label - p;
  const lr = ML.lr || 0.02;
  for (let i=0;i<featuresArr.length;i++){
    ML.w[i] += lr * (err * featuresArr[i] - (ML.l2 || 0.0001) * (ML.w[i]||0));
  }
  ML.bias += lr * err;
  ML.trained = (ML.trained||0) + 1;
  if (ML.trained % 5 === 0) mlSave();
  return p;
}
function mlExtractFeatures({ klines15, lastCandle, avgVol20=1, divergenceSign=0, ellConf=0, systemBias=0 }) {
  const first = (klines15 && klines15[0]) || lastCandle;
  const last = lastCandle || (klines15 && klines15.at(-1));
  const slope15 = ((last.close - (first.close || last.close)) / (first.close || 1)) * 100; // percent
  const lastDeltaP = ((last.close - last.open) / (last.open || 1)) * 100;
  const volRatio = avgVol20 > 0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePattern(klines15 || []);
  return [
    slope15 / 10,            // scaled
    lastDeltaP,             // percent
    volRatio - 1,           // ratio-1
    patt.isDoji,
    patt.isHammer,
    patt.isShooting,
    divergenceSign || 0,
    ellConf / 100,
    systemBias || 0
  ];
}
function biasToSign(biasStr) { if (!biasStr) return 0; const s = biasStr.toString().toLowerCase(); if (s.includes("bull")) return 1; if (s.includes("bear")) return -1; return 0; }

// ========== Reversal watcher (1m) ==========
let lastRevSentAt = 0;
async function reversalWatcher() {
  try {
    const kl = await fetchKlines(SYMBOL, "1m", 30);
    if (!kl || kl.length < 3) return;
    const last = kl.at(-1), prev = kl.at(-2);
    const patt = detectCandlePattern(kl);
    const avgVol = avgVolume(kl, 12);
    const volSpike = avgVol > 0 && (last.volume / avgVol) >= 2.2;
    if ((patt.isHammer || patt.isShooting || patt.isDoji) && volSpike) {
      const now = Date.now();
      if (now - lastRevSentAt < 60 * 1000) return; // cooldown 60s
      lastRevSentAt = now;
      // ML prob for the short sample
      const feat = mlExtractFeatures({ klines15: kl.slice(-20), lastCandle: last, avgVol20: avgVol, divergenceSign: 0, ellConf:0, systemBias:0 });
      const prob = mlPredict(feat);
      let text = `<b>🔎 Reversal Watcher</b>\n${nowStr()}\nPattern: ${patt.isHammer? "Hammer" : patt.isShooting? "Shooting Star" : "Doji"}\nVol spike: ${volSpike}\nPrice: ${last.close}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(text);
      // weak online training (label unknown — treat as soft positive if prob high)
      mlTrain(feat, prob > (ML.threshold || ML_ALERT_THRESH) ? 1 : 0);
    }
  } catch (e) { console.warn("reversalWatcher err", e.message); }
}

// ========== Main analysis & reporting ==========
async function analyzeAndReport() {
  try {
    // load TF klines
    const tfData = {};
    for (const tf of TIMEFRAMES) tfData[tf] = await fetchKlines(SYMBOL, tf, tf === "1m" ? 120 : 100);

    const base = tfData["15m"] || [];
    if (!base || base.length < 12) {
      const msg = `❗ Not enough 15m candles (${(base||[]).length}) — skipping (${nowStr()})`;
      console.warn(msg);
      await sendTG(msg);
      return;
    }

    const lastPrice = base.at(-1).close;
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base, 14);

    // per TF divergence + pattern summary
    let bull = 0, bear = 0, totalStrength = 0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = (kl.length>1) ? ((kl.at(-1).close - kl[0].close) / (kl[0].close||1)) * 100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bull++;
      if (d.type.includes("Bear")) bear++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Strength ${Math.round(d.strength)}\nTrend: ${trend}`;
    }

    // news & social
    const [newsA, newsB] = await Promise.allSettled([fetchCoinTelegraph(6), fetchCoinDesk(6)]);
    const newsArr = [];
    if (newsA.status==="fulfilled") newsArr.push(...newsA.value.map(t=>({ title:t, source:"CoinTelegraph" })));
    if (newsB.status==="fulfilled") newsArr.push(...newsB.value.map(t=>({ title:t, source:"CoinDesk" })));
    const reddit = await fetchReddit(12);
    const tweets = await fetchNitter("bitcoin", 8);

    // news sentiment simple heuristic
    const POS_KEYS = ["surge","approval","bull","bullish","gain","rally","soar","adopt","etf","support","up","rise","positive","upgrade"];
    const NEG_KEYS = ["crash","hack","ban","selloff","bear","bearish","dump","fall","fear","lawsuit","liquidation","negative","downgrade"];
    let newsScore = 0;
    for (const n of newsArr) {
      const t = (n.title||"").toLowerCase();
      for (const k of POS_KEYS) if (t.includes(k)) newsScore++;
      for (const k of NEG_KEYS) if (t.includes(k)) newsScore--;
    }
    const newsImpact = Math.abs(newsScore) >= 3 ? "High" : Math.abs(newsScore) >= 1 ? "Medium" : "Low";

    // merge signals (weights)
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct) / 100));
    const newsNorm = Math.max(-1, Math.min(1, newsScore / 6));
    let redditScoreVal = 0;
    for (const r of reddit) {
      const t = (r.title||"").toLowerCase();
      if (t.includes("bull")) redditScoreVal += 1;
      if (t.includes("bear")) redditScoreVal -= 1;
    }
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal / 6));
    const COMBINED = 0.55 * techNorm + 0.30 * newsNorm + 0.15 * socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const confidencePct = Math.round(Math.min(99, Math.abs(COMBINED) * 100));
    if (label.includes("Bull")) bull++; if (label.includes("Bear")) bear++;

    // fib entry zones & targets
    const fib618 = fib ? fib.fib618 : NaN;
    const entryBuy = fib618;
    const entrySell = fib ? fib.fib382 : NaN;
    const breakoutMin = Math.min(entrySell||Infinity, entryBuy||Infinity);
    const breakoutMax = Math.max(entrySell||-Infinity, entryBuy||-Infinity);
    const breakoutRange = (isFinite(breakoutMin) && isFinite(breakoutMax)) ? `${breakoutMin.toFixed(2)} - ${breakoutMax.toFixed(2)}` : "N/A";

    const targets = getTargetsAndSL(lastPrice, label, atrVal);

    // ML features & predict
    const feat = mlExtractFeatures({
      klines15: base.slice(-40),
      lastCandle: base.at(-1),
      avgVol20: avgVolume(base,20),
      divergenceSign: bull>bear?1:(bear>bull?-1:0),
      ellConf: 0,
      systemBias: biasToSign(label)
    });
    const mlProb = mlPredict(feat);
    // save last prediction payload for later online training
    try {
      const lastPredPayload = { pred: label, prevClose: lastPrice, klines15: base.slice(-40), divSign: bull>bear?1:(bear>bull?-1:0), ellConf:0, ts: Date.now() };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload,null,2));
    } catch(e){ console.warn("save last pred error", e.message); }

    // accuracy update from previous file
    try {
      const ACC_SAVE = "./last_report_prevclose.json";
      if (fs.existsSync(ACC_SAVE)) {
        const prev = JSON.parse(fs.readFileSync(ACC_SAVE,"utf8"));
        if (prev && prev.pred && prev.prevClose) {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(ACC_SAVE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() }, null, 2));
    } catch(e){ console.warn("acc update", e.message); }

    // ML online train using previous stored pred outcome (if exists)
    try {
      const LAST_TRAIN_FILE = "./last_trainer_input.json";
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        // If previous pred exists and we have enough candles, label training by movement
        if (prev && prev.klines15 && prev.pred) {
          const prevClose = prev.prevClose || prev.klines15.at(-1).close;
          const actual = lastPrice > prevClose ? "Bullish" : lastPrice < prevClose ? "Bearish" : "Neutral";
          const labelTrain = (prev.pred === actual) ? 1 : 0;
          const featPrev = mlExtractFeatures({ klines15: prev.klines15, lastCandle: prev.klines15.at(-1), avgVol20: avgVolume(prev.klines15,20), divergenceSign: prev.divSign||0, ellConf: prev.ellConf||0, systemBias: biasToSign(prev.pred) });
          mlTrain(featPrev, labelTrain);
        }
      }
    } catch(e){ console.warn("ml training on prev error", e.message); }

    // build telegram message (chunk-friendly)
    let msg = `<b>🤖 ${SYMBOL} — AI Trader v8.6</b>\n🕒 ${nowStr()}\n`;
    msg += `${perTfText}\n\n`;
    msg += `🎯 <b>Targets:</b>\nTP1: ${targets.tp1} | TP2: ${targets.tp2} | TP3: ${targets.tp3}\nSL: ${targets.sl}\n📊 Breakout Range: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Overall Bias:</b> ${label} | Confidence: ${confidencePct}%\n💰 Last Price: ${lastPrice.toFixed(2)}\n📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}%\n📉 ATR(14): ${(atrVal||0).toFixed(2)}\nAccuracy(Last10): ${getAccLocal(10)}%\n📰 News Impact: ${newsImpact}\n\n`;
    if (newsArr.length) {
      msg += `📰 <b>Headlines:</b>\n`;
      for (const n of newsArr) msg += `• ${n.title}\n`;
    } else msg += `📰 <b>Headlines:</b> No recent headlines\n`;
    msg += `\n🤖 ML Smart Prob: ${(mlProb*100).toFixed(1)}% (threshold ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n`;
    if (mlProb >= (ML.threshold||ML_ALERT_THRESH) && confidencePct > 40) msg += `\n🚨 <b>ML Smart Alert</b>: ${(mlProb*100).toFixed(1)}% probability of ${label} — watch breakout zone ${breakoutRange}\n`;

    // send
    await sendTG(msg);

  } catch (err) {
    console.error("analyzeAndReport error:", err.message);
    await sendTG(`<b>⚠️ AI Trader error</b>\n${err.message}`);
  }
}

// ========== INIT & SCHEDULE ==========
async function initAll() {
  // load ML
  ML = mlLoad();
  if (!ML.w) ML = mlLoad(); // ensure loaded
  // set threshold fallback
  if (!ML.threshold) ML.threshold = ML_ALERT_THRESH;

  // initial run
  try { await analyzeAndReport(); } catch(e){ console.warn("initial analyze failed", e.message); }
  try { await reversalWatcher(); } catch(e){}

  // schedule
  setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
  setInterval(reversalWatcher, REV_CHECK_INTERVAL_SEC * 1000);
  setInterval(() => { // periodic save/threshold tuning
    try { mlSave(); } catch(e) {}
    // auto threshold tuning simple heuristic: keep ML.threshold as stored
  }, 10 * 60 * 1000);

  // self-ping
  if (SELF_PING_URL) setInterval(async () => {
    try { await fetch(SELF_PING_URL).catch(()=>{}); } catch(e) {}
  }, 4 * 60 * 1000);
}

// ========== Express keepalive ==========
const app = express();
app.get("/", (req, res) => res.send("AI Trader v8.6+ML running ✅"));
app.listen(PORT, ()=> {
  console.log(`Server listening on port ${PORT}`);
  initAll().catch(e => console.error("initAll failed", e.message));
});