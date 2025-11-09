/**
 * aiTraderBot_v8.6.js
 * - 15-min multi-TF report
 * - 1-min Reversal Watcher (Doji, Hammer, Shooting Star) with High Volume confirmation
 * - ML Smart Alert (online logistic-like trainer)
 * - Self-ping, news fallback proxies, chunked Telegram messages
 *
 * Requirements:
 *  npm i node-fetch@3 express dotenv
 * Run:
 *  node aiTraderBot_v8.6.js
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.7");
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];
const TIMEFRAMES = ["1m","5m","15m","30m","1h"];

// file storage
const ML_MODEL_FILE = "./ml_model_v86.json";
const LAST_PRED_FILE = "./last_pred_v86.json";
const ACC_KEY = "ai_acc_v86_local"; // for localStorage fallback (we will store JSON file)

// ---------- Safety checks ----------
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

// ---------- Utility helpers ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

async function safeFetch(url, opt = {}, tryProxies = true) {
  // try direct first
  try {
    const r = await fetch(url, { timeout: 12000, ...opt });
    if (r.ok) return r;
  } catch(e){ /* ignore */ }
  if (!tryProxies) throw new Error("fetch failed (no proxy)");
  for (const p of PROXIES) {
    try {
      const full = p + encodeURIComponent(url);
      const r = await fetch(full, { timeout: 12000, ...opt });
      if (r.ok) return r;
    } catch (e) { /* continue */ }
  }
  throw new Error("All fetch attempts failed");
}

function chunkMessage(text, chunkSize = 3800) {
  const parts = [];
  for (let i=0;i<text.length;i+=chunkSize) parts.push(text.slice(i,i+chunkSize));
  return parts;
}

async function sendTG(text, options = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: options.parse_mode || "HTML",
    disable_web_page_preview: options.disable_web_page_preview !== false
  };
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
  const json = await r.json();
  if (!json.ok) throw new Error("Telegram send failed: " + JSON.stringify(json));
  return json;
}

// ---------- Binance klines ----------
async function fetchKlines(symbol, interval="15m", limit=80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const r = await safeFetch(url, {}, true);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("Invalid klines");
    return j.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  } catch (err) {
    console.warn("fetchKlines error", err.message);
    return [];
  }
}

// ---------- News / Social fetchers ----------
async function fetchCoinTelegraph(limit=6) {
  try {
    const url = "https://cointelegraph.com/rss";
    const r = await safeFetch(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||"";
      return { title: t.replace(/<!\[CDATA\[|\]\]>/g,"").trim(), source: "CoinTelegraph" };
    });
  } catch(e){ console.warn("fetchCoinTelegraph", e.message); return []; }
}

async function fetchCoinDesk(limit=6) {
  try {
    const url = "https://www.coindesk.com/arc/outboundfeeds/rss/";
    const r = await safeFetch(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it => {
      const t = (it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||"";
      return { title: t.replace(/<!\[CDATA\[|\]\]>/g,"").trim(), source: "CoinDesk" };
    });
  } catch(e){ console.warn("fetchCoinDesk", e.message); return []; }
}

async function fetchHeadlines() {
  // combine a few sources
  const a = await Promise.allSettled([fetchCoinTelegraph(6), fetchCoinDesk(6)]);
  const out = [];
  for (const r of a) if (r.status === "fulfilled") out.push(...r.value);
  return out.slice(0,6);
}

async function fetchReddit(limit=10) {
  try {
    const url = `https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`;
    const r = await safeFetch(url);
    const j = await r.json();
    if (!j.data) return [];
    return j.data.children.map(c => ({ title: c.data.title||"", ups: c.data.ups||0, created_utc: c.data.created_utc }));
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
  if (!klines || klines.length===0) return 0;
  const slice = klines.slice(-n);
  const s = slice.reduce((a,b)=>a+b.volume,0);
  return s / slice.length;
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
  if (!klines||!klines.length) return null;
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
  // simple last-candle delta + volume delta divergence indicator (per TF)
  if (!kl || kl.length < 2) return { type: "Neutral", dp: 0, dv: 0, strength: 0 };
  const last = kl.at(-1), prev = kl.at(-2);
  const dp = ((last.close - prev.close) / (prev.close||1)) * 100;
  const dv = ((last.volume - prev.volume) / (prev.volume||1)) * 100;
  let type = "Neutral";
  if (dp > 0 && dv < 0) type = "Bearish Divergence";
  if (dp < 0 && dv > 0) type = "Bullish Divergence";
  const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
  return { type, dp, dv, strength };
}

// Candle pattern detectors (Doji,Hammer,ShootingStar)
function detectCandlePattern(kl) {
  if(!kl || kl.length===0) return {};
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

// Targets & SL
function getTargetsAndSL(price, dir="Neutral") {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  const move = price * 0.005; // 0.5% tiers
  if (dir.includes("Bull")) {
    return { tp1:(price+move).toFixed(2), tp2:(price+move*2).toFixed(2), tp3:(price+move*3).toFixed(2), sl:(price-move).toFixed(2) };
  } else if (dir.includes("Bear")) {
    return { tp1:(price-move).toFixed(2), tp2:(price-move*2).toFixed(2), tp3:(price-move*3).toFixed(2), sl:(price+move).toFixed(2) };
  } else {
    return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A" };
  }
}

// ---------- Accuracy tracking (local JSON file) ----------
function pushAccLocal(correct) {
  const F = "./acc_v86.json";
  try {
    const arr = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F,"utf8")) : [];
    arr.push(correct?1:0);
    while(arr.length>50) arr.shift();
    fs.writeFileSync(F, JSON.stringify(arr));
  } catch(e){ console.warn("pushAccLocal error", e.message); }
}
function getAccLocal(lastN=10) {
  const F = "./acc_v86.json";
  try {
    const arr = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN);
    const s = slice.reduce((a,b)=>a+b,0);
    return ((s/slice.length)*100).toFixed(1);
  } catch(e){ return "N/A"; }
}

// ---------- ML Module (simple online logistic/regression) ----------
function mlLoad() {
  try {
    if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8"));
  } catch(e){ console.warn("mlLoad", e.message); }
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

function mlExtractFeatures({klines15, lastCandle, avgVol20=1, divergenceSign=0, ellConf=0, systemBias=0}) {
  const first = klines15[0] || lastCandle;
  const last = lastCandle || klines15.at(-1);
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const { isDoji, isHammer, isShooting } = detectCandlePattern(klines15);
  return [
    slope15,
    lastDeltaP,
    volRatio - 1,
    isDoji,
    isHammer,
    isShooting,
    divergenceSign || 0,
    ellConf / 100,
    systemBias || 0
  ];
}

function mlPredict(features) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const z = ML.bias + features.reduce((s,v,i)=>s + (ML.w[i]||0) * v, 0);
  return sigmoid(z);
}

function mlTrain(features, label) {
  if (!ML.w || ML.w.length !== features.length) mlInit(features.length);
  const lr = ML.lr || 0.02, l2 = ML.l2 || 0.0001;
  const p = mlPredict(features);
  const err = label - p;
  for (let i=0;i<features.length;i++){
    ML.w[i] += lr * (err * features[i] - l2 * (ML.w[i]||0));
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

// ---------- Self-ping ----------
async function selfPing() {
  if (!RENDER_EXTERNAL_URL) return;
  let url = RENDER_EXTERNAL_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  try {
    const r = await fetch(url);
    console.log("Self-ping", r.status);
  } catch(e){ console.warn("selfPing failed", e.message); }
}

// ---------- Main analysis & report ----------
async function analyzeAndReport() {
  try {
    // 1) fetch klines for all TFs (15m primary)
    const tfData = {};
    for (const tf of TIMEFRAMES) {
      tfData[tf] = await fetchKlines(SYMBOL, tf, tf === "1m" ? 120 : 100);
    }
    const base = tfData["15m"] || [];
    if (base.length < 10) {
      const txt = `❗ Not enough 15m candles (${base.length}) — skipping report (${nowStr()})`;
      console.warn(txt);
      await sendTG(txt);
      return;
    }

    // 2) tech metrics
    const tech = calcVolSent(base);
    const fib = calcFib(base);
    const atrVal = atr(base, 14);
    const lastPrice = base.at(-1).close;

    // 3) per-TF divergence & quick pattern/trend
    let bullCount = 0, bearCount = 0, totalStrength = 0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = (kl.length>1) ? ((kl.at(-1).close - kl[0].close) / (kl[0].close||1)) * 100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bullCount++;
      if (d.type.includes("Bear")) bearCount++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Strength ${Math.round(d.strength)}\nTrend: ${trend}`;
    }

    // 4) pattern / fib zones
    const fib618 = fib? fib.fib618 : NaN;
    const entryBuy = fib? fib.fib618 : NaN;
    const entrySell = fib? fib.fib382 : NaN;
    const breakoutMin = Math.min(entrySell||Infinity, entryBuy||Infinity);
    const breakoutMax = Math.max(entrySell||-Infinity, entryBuy||-Infinity);

    // 5) news & social
    const [newsList, redditPosts, tweets] = await Promise.allSettled([
      fetchHeadlines(), fetchReddit(8), fetchNitter("bitcoin", 8)
    ]);
    const newsArr = newsList.status==="fulfilled"? newsList.value : [];
    const redditArr = redditPosts.status==="fulfilled"? redditPosts.value : [];
    const tweetsArr = tweets.status==="fulfilled"? tweets.value : [];

    // simple news sentiment score (keyword heuristic)
    const posK = ["bull","surge","gain","rally","support","up","positive","soar","approval","adopt"];
    const negK = ["bear","dump","selloff","crash","fear","ban","hack","lawsuit","negative","fall"];
    let newsScore = 0;
    for (const n of newsArr) {
      const t = (n.title||"").toLowerCase();
      for (const k of posK) if (t.includes(k)) newsScore += 1;
      for (const k of negK) if (t.includes(k)) newsScore -= 1;
    }
    let newsImpact = "Low";
    if (Math.abs(newsScore) >= 3) newsImpact = "High";
    else if (Math.abs(newsScore) >= 1) newsImpact = "Medium";

    // 6) merge signals (weighted)
    const techNorm = Math.max(-1, Math.min(1, (tech.buyPct - tech.sellPct)/100 ));
    const newsNorm = Math.max(-1, Math.min(1, newsScore/6 ));
    let redditScoreVal = 0;
    for (const r of redditArr) { redditScoreVal += (r.title? ((/bull/i.test(r.title)?1:(/bear/i.test(r.title)?-1:0)) ) : 0); }
    const socialNorm = Math.max(-1, Math.min(1, redditScoreVal/6 ));
    const COMBINED = 0.55*techNorm + 0.30*newsNorm + 0.15*socialNorm;
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const rawConfidence = Math.abs(COMBINED);
    const confidencePct = Math.round(Math.min(99, rawConfidence * 100));

    if (label.includes("Bull")) bullCount++;
    if (label.includes("Bear")) bearCount++;

    // 7) targets & breakout
    const tgs = getTargetsAndSL(lastPrice, label);
    const breakoutRange = (isFinite(breakoutMin) && isFinite(breakoutMax)) ? `${breakoutMin.toFixed(2)} - ${breakoutMax.toFixed(2)}` : "N/A";

    // 8) ML Smart Alert prediction & training (online)
    // load prev prediction to train model if available
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15 && prev.pred) {
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
    } catch(e){ console.warn("ML training on prev error", e.message); }

    // prepare features for current report
    const feat = mlExtractFeatures({
      klines15: base.slice(-40),
      lastCandle: base.at(-1),
      avgVol20: avgVolume(base,20),
      divergenceSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0),
      ellConf: 0,
      systemBias: biasToSign(label)
    });
    const mlProb = mlPredict(feat);

    // 9) save last pred for training later
    try {
      const lastPredPayload = {
        pred: label,
        prevClose: lastPrice,
        klines15: base.slice(-40),
        divSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0),
        ellConf: 0,
        ts: Date.now()
      };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload));
    } catch(e) { console.warn("save last pred error", e.message); }

    // 10) accuracy: compare prev prediction to last candle movement (local file)
    try {
      const ACC_SAVE = "./last_report_prevclose.json";
      if (fs.existsSync(ACC_SAVE)) {
        const prev = JSON.parse(fs.readFileSync(ACC_SAVE,"utf8"));
        if (prev && prev.pred && prev.prevClose) {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(ACC_SAVE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() }));
    } catch(e){ console.warn("acc update", e.message); }

    // 11) build message
    let msg = `<b>🤖 ${SYMBOL} — AI Trader v8.6</b>\n🕒 ${nowStr()}\n`;
    msg += perTfText + "\n\n";
    msg += `🎯 <b>Targets:</b>\nTP1: ${tgs.tp1} | TP2: ${tgs.tp2} | TP3: ${tgs.tp3}\nSL: ${tgs.sl}\n📊 Breakout Range: ${breakoutRange}\n\n`;
    msg += `🧠 <b>Overall Bias:</b> ${label} | Confidence: ${confidencePct}%\n💰 Last Price: ${lastPrice.toFixed(2)}\n📈 Tech Vol: Buy ${tech.buyPct.toFixed(2)}% / Sell ${tech.sellPct.toFixed(2)}%\n📉 ATR(14): ${(atrVal||0).toFixed(2)}\nAccuracy(Last10): ${getAccLocal(10)}%\n📰 News Impact: ${newsImpact}\n`;

    if (newsArr.length) {
      msg += `\n📰 <b>Headlines:</b>\n`;
      for (const n of newsArr) msg += `• ${n.title}\n`;
    } else {
      msg += `\n📰 <b>Headlines:</b> No recent headlines\n`;
    }

    msg += `\n🤖 ML Smart Prob: ${(mlProb*100).toFixed(1)}% (threshold ${(ML_ALERT_THRESH*100).toFixed(0)}%)\n`;

    if (mlProb >= ML_ALERT_THRESH && confidencePct > 40) {
      msg += `\n🚨 <b>ML Smart Alert:</b> ${(mlProb*100).toFixed(1)}% probability of ${label} move — consider watching breakout zone\n`;
    }

      // send chunked message
    const chunks = chunkMessage(msg, 3800);
    for (const c of chunks) {
      try { await sendTG(c); } catch(e){ console.warn("TG chunk send failed", e.message); }
      await new Promise(r=>setTimeout(r, 400)); // small delay
    }

  } catch (err) {
    console.error("analyzeAndReport error", err);
    try { await sendTG(`⚠️ AI Trader error: ${err.message} — ${nowStr()}`); } catch(e){ console.warn("failed send error", e.message); }
  }
}

// ---------- Reversal watcher (1-min loop) ----------
let revCooldownUntil = 0;
async function reversalWatcher() {
  try {
    const kl1 = await fetchKlines(SYMBOL, "1m", 40);
    if (!kl1.length) return;
    const last = kl1.at(-1);
    const avgVol20 = avgVolume(kl1, 20);
    const volRatio = avgVol20>0 ? (last.volume/avgVol20) : 1;
    const { isDoji, isHammer, isShooting, body, range } = detectCandlePattern(kl1);

    // require high volume confirmation and pattern
    const highVol = volRatio > 1.8; // 80% above avg
    const patternDetected = isDoji || isHammer || isShooting;
    const now = Date.now();

    if (patternDetected && highVol && now > revCooldownUntil) {
      // decide direction
      const dir = isHammer ? "Bullish Reversal" : isShooting ? "Bearish Reversal" : "Doji (possible reversal)";
      const probFeat = mlExtractFeatures({
        klines15: kl1.slice(-15),
        lastCandle: last,
        avgVol20,
        divergenceSign: 0,
        systemBias: 0
      });
      const p = mlPredict(probFeat);
      const message = `<b>🚨 Reversal Watcher Alert</b>\n🕒 ${nowStr()}\nPattern: ${dir}\nPrice: ${last.close.toFixed(2)}\nVol ratio: ${volRatio.toFixed(2)}\nML Prob: ${(p*100).toFixed(1)}%\nTake action: watch breakout / confirm on higher TF.\n`;
      const chunks = chunkMessage(message, 3800);
      for (const c of chunks) { try { await sendTG(c); } catch(e){console.warn("rev TG fail", e.message);} }
      // cooldown to avoid spam
      revCooldownUntil = now + (5 * 60 * 1000); // 5 minutes cooldown
    }
  } catch(e){ console.warn("reversalWatcher err", e.message); }
}

// ---------- Simple periodic handlers ----------
async function startLoops() {
  // initial run
  await analyzeAndReport().catch(e=>console.warn(e));
  // schedule 15-min report
  setInterval(()=>analyzeAndReport().catch(e=>console.warn(e)), CHECK_INTERVAL_MIN * 60 * 1000);
  // schedule 1-min watcher
  setInterval(()=>reversalWatcher().catch(e=>console.warn(e)), REV_CHECK_INTERVAL_SEC * 1000);
  // self-ping every 3 minutes if configured
  if (RENDER_EXTERNAL_URL) setInterval(()=>selfPing(), 3 * 60 * 1000);
}

// ---------- Express webserver to keep alive ----------
const app = express();
app.get("/", (req,res)=> res.send(`AI Trader Bot v8.6 running — ${nowStr()}`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> {
  console.log("Web server listening on port", PORT);
  // start loops after server ready
  startLoops();
});

// expose for debugging if needed
global.aiTrader = { ml: ML };

console.log("AI Trader v8.6 started —", nowStr());
