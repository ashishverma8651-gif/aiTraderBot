/**
 * aiTraderBot_full_v8.8.2_hybrid.js
 *
 * Single-file complete bot:
 *  - Hybrid base TF selection (15m vs 30m) using ATR ratio
 *  - Multi-source klines (Binance -> Coinbase -> CoinGecko fallback)
 *  - Multi-TF analysis (1m,5m,15m,30m,1h)
 *  - Fib + ATR + Elliott hybrid targets
 *  - Tiny online ML with normalization & persistence
 *  - News (CoinTelegraph + CoinDesk) + Reddit + Nitter
 *  - Reversal watcher (1m) with high-volume confirmation
 *  - Telegram report + /tg/cmd endpoint
 *  - Self-ping keepalive
 *
 * Requirements:
 *   npm i node-fetch@3 express dotenv
 * package.json: { "type": "module" }
 *
 * Run:
 *   BOT_TOKEN=... CHAT_ID=... node aiTraderBot_full_v8.8.2_hybrid.js
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL_RAW = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.70");
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || null;
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || "10000", 10);

// hybrid selector threshold: if ATR(15m) > ATR(30m) * HYBRID_ATR_RATIO => use 30m (less noise)
const HYBRID_ATR_RATIO = parseFloat(process.env.HYBRID_ATR_RATIO || "1.3");

const ML_MODEL_FILE = "./ml_model_v882.json";
const LAST_PRED_FILE = "./last_pred_v882.json";
const ACC_FILE = "./acc_v882.json";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN and CHAT_ID must be set in .env");
  process.exit(1);
}

const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
const BINANCE_MIRRORS = ["https://api.binance.com","https://data-api.binance.vision","https://api-gcp.binance.com"];

// ---------- UTIL ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

async function httpPostJson(url, payload) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  try { return await r.json(); } catch { return {}; }
}
function chunkMessage(text, size=3800) {
  const out=[]; for (let i=0;i<text.length;i+=size) out.push(text.slice(i,i+size)); return out;
}
async function sendTG(text, parse_mode="HTML") {
  const parts = chunkMessage(text,3800);
  for (const p of parts) {
    try { await httpPostJson(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: p, parse_mode, disable_web_page_preview: true }); }
    catch(e){ console.warn("sendTG failed:", e.message); }
    await new Promise(r=>setTimeout(r,220));
  }
}

// ---------- FETCH FALLBACKS ----------
async function fetchKlinesBinance(symbol, interval="15m", limit=100) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const base of BINANCE_MIRRORS) {
    try {
      const url = base.replace(/\/$/,"") + path;
      const r = await fetch(url);
      const txt = await r.text();
      try {
        const j = JSON.parse(txt);
        if (!Array.isArray(j)) throw new Error("not array");
        return j.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
      } catch(err){
        console.warn("binance mirror returned non-array", base, txt.slice(0,140));
        continue;
      }
    } catch(err) { console.warn("binance mirror error", base, err.message); continue; }
  }
  throw new Error("Binance mirrors all failed");
}
function coinbaseSymbolFromRaw(raw) {
  const up = raw.toUpperCase().replace(/[-_\/]/g,"");
  const base = up.replace(/(USDT|USD)$/,"");
  return `${base}-USD`;
}
async function fetchKlinesCoinbase(coinbaseSymbol, interval="15m", limit=100) {
  const granMap = { "1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600 };
  const gran = granMap[interval]||900;
  const url = `https://api.exchange.coinbase.com/products/${coinbaseSymbol}/candles?granularity=${gran}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Coinbase non-array");
  const slice = j.slice(-limit).sort((a,b)=>a[0]-b[0]);
  return slice.map(k=>({ time:k[0]*1000, open:+k[3], high:+k[2], low:+k[1], close:+k[4], volume:+(k[5]||0) }));
}
async function fetchKlinesCoinGecko(id="bitcoin", days=1) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("CoinGecko invalid");
  return j.map(k=>({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:0 }));
}
async function fetchKlinesUnified(rawSymbol, interval="15m", limit=100) {
  const binSym = rawSymbol.toUpperCase().replace(/[-_\/]/g,"");
  const coinSym = coinbaseSymbolFromRaw(rawSymbol);
  try { const d = await fetchKlinesBinance(binSym, interval, limit); return { data:d, source:"Binance" }; }
  catch(e){ console.warn("Binance fail", e.message); }
  try { const d = await fetchKlinesCoinbase(coinSym, interval, limit); return { data:d, source:"Coinbase" }; }
  catch(e){ console.warn("Coinbase fail", e.message); }
  try { const id = /^BTC/.test(binSym) ? "bitcoin" : ( /^ETH/.test(binSym) ? "ethereum" : binSym.slice(0,3).toLowerCase()); const d = await fetchKlinesCoinGecko(id); return { data:d, source:"CoinGecko" }; }
  catch(e){ console.warn("CoinGecko fail", e.message); }
  return { data:[], source:"None" };
}

// ---------- NEWS & SOCIAL ----------
async function fetchRSS(url, limit=6) {
  try {
    const r = await fetch(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit+1);
    return items.map(it=>{ const t=(it.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||""; return t.replace(/<!\[CDATA\[|\]\]>/g,"").trim(); });
  } catch(e){ console.warn("fetchRSS", url, e.message); return []; }
}
async function fetchHeadlines() {
  const a = await Promise.allSettled([ fetchRSS("https://cointelegraph.com/rss"), fetchRSS("https://www.coindesk.com/arc/outboundfeeds/rss/") ]);
  const out=[]; for (const r of a) if (r.status==="fulfilled") out.push(...r.value); return out.slice(0,6).map(t => ({ title:t }));
}
async function fetchReddit(limit=6) {
  try { const r = await fetch(`https://www.reddit.com/r/Bitcoin/new.json?limit=${limit}`); const j = await r.json(); if (!j?.data?.children) return []; return j.data.children.map(c => ({ title:c.data.title||"", ups:c.data.ups||0 })); }
  catch(e){ console.warn("fetchReddit", e.message); return []; }
}
async function fetchNitter(q="bitcoin", limit=6) {
  try { const r = await fetch(`https://nitter.net/search?f=tweets&q=${encodeURIComponent(q)}&src=typed_query`); const html = await r.text(); const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/g)]; return matches.slice(0,limit).map(m => m[1].replace(/<[^>]+>/g,"").trim()); }
  catch(e){ console.warn("fetchNitter", e.message); return []; }
}

// ---------- INDICATORS & PATTERNS ----------
function avgVolume(klines, n=20) { if (!klines||!klines.length) return 0; const slice = klines.slice(-n); return slice.reduce((a,b)=>a+(b.volume||0),0)/slice.length; }
function atr(klines, period=14) {
  if (!klines || klines.length < period+1) return null;
  const trs=[];
  for (let i=1;i<klines.length;i++){
    const c=klines[i], p=klines[i-1];
    const tr = Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/slice.length;
}
function calcFib(kl) {
  if (!kl||!kl.length) return null;
  const highs=kl.map(k=>k.high), lows=kl.map(k=>k.low);
  const high=Math.max(...highs), low=Math.min(...lows);
  const range = high-low||1;
  return { high, low, fib382: high-range*0.382, fib5: high-range*0.5, fib618: high-range*0.618 };
}
function detectDivergence(kl) {
  if (!kl||kl.length<2) return { type:"Neutral", dp:0, dv:0, strength:0 };
  const last = kl.at(-1), prev = kl.at(-2);
  const dp = ((last.close - prev.close)/(prev.close||1))*100;
  const dv = ((last.volume - prev.volume)/(prev.volume||1))*100;
  let type="Neutral"; if (dp>0 && dv<0) type="Bearish Divergence"; if (dp<0 && dv>0) type="Bullish Divergence";
  return { type, dp, dv, strength: Math.min(100, Math.abs(dp)+Math.abs(dv)) };
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
  return { isDoji: isDoji?1:0, isHammer: isHammer?1:0, isShooting: isShooting?1:0, body, range };
}

// ---------- TARGETS HYBRID (ATR + Fib + Elliott) ----------
function getTargetsAndSL_Hybrid(price, fib, atrVal, ellPhase="Unknown", dir="Neutral") {
  if (!price || isNaN(price)) return { tp1:"N/A", tp2:"N/A", tp3:"N/A", sl:"N/A", model:"Hybrid" };
  const move = (atrVal && isFinite(atrVal)) ? atrVal : price * 0.005;
  let fibBased = [fib?.fib382, fib?.fib5, fib?.fib618].filter(v => v);
  if (ellPhase.includes("Impulse")) fibBased = fibBased.map(v=>v * 1.002);
  else if (ellPhase.includes("Correction")) fibBased = fibBased.map(v=>v * 0.998);
  let tp1,tp2,tp3,sl;
  if (dir.includes("Bull")) {
    tp1 = (fibBased[0] || (price + move)).toFixed(2);
    tp2 = (fibBased[1] || (price + move * 1.8)).toFixed(2);
    tp3 = (fibBased[2] || (price + move * 3)).toFixed(2);
    sl  = (price - move * 0.9).toFixed(2);
  } else if (dir.includes("Bear")) {
    tp1 = (fibBased[2] || (price - move)).toFixed(2);
    tp2 = (fibBased[1] || (price - move * 1.8)).toFixed(2);
    tp3 = (fibBased[0] || (price - move * 3)).toFixed(2);
    sl  = (price + move * 0.9).toFixed(2);
  } else {
    tp1 = tp2 = tp3 = sl = "N/A";
  }
  return { tp1, tp2, tp3, sl, model:"Hybrid(ATR+Fib+Elliott)" };
}
function detectElliottPhase(klines) {
  if (!klines || klines.length < 6) return { phase:"Unknown", confidence:0 };
  const closes = klines.map(k=>k.close);
  const deltas = [];
  for (let i=1;i<closes.length;i++) deltas.push(closes[i]-closes[i-1]);
  const posSeq = deltas.filter(d=>d>0).length;
  const negSeq = deltas.filter(d=>d<0).length;
  const slope = ((closes.at(-1) - closes[0]) / (closes[0]||1)) * 100;
  if (slope > 1.5 && posSeq > negSeq * 1.4) return { phase:"Impulse Wave", confidence:75 };
  if (slope < -1.5 && negSeq > posSeq * 1.4) return { phase:"Correction Wave", confidence:70 };
  if (Math.abs(slope) < 0.8) return { phase:"Sideways", confidence:60 };
  return { phase:"Transitional", confidence:55 };
}

// ---------- ACCURACY ----------
function pushAccLocal(correct) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    arr.push(correct?1:0);
    while (arr.length>100) arr.shift();
    fs.writeFileSync(ACC_FILE, JSON.stringify(arr,null,2));
  } catch(e){ console.warn("pushAccLocal", e.message); }
}
function getAccLocal(lastN=10) {
  try {
    const arr = fs.existsSync(ACC_FILE) ? JSON.parse(fs.readFileSync(ACC_FILE,"utf8")) : [];
    if (!arr.length) return "N/A";
    const slice = arr.slice(-lastN); const s = slice.reduce((a,b)=>a+b,0); return ((s/slice.length)*100).toFixed(1);
  } catch(e){ return "N/A"; }
}

// ---------- ML ----------
function mlLoad() {
  try { if (fs.existsSync(ML_MODEL_FILE)) return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8")); } catch(e){ console.warn("mlLoad", e.message); }
  return { w:null, bias:0, n_features:0, lr:0.01, l2:0.00005, trained:0, mean:null, std:null, threshold:ML_ALERT_THRESH };
}
let ML = mlLoad();
function mlInit(n) {
  if (!ML.w || ML.n_features !== n) {
    ML.n_features = n;
    ML.w = new Array(n).fill(0).map(()=> (Math.random()*0.02 - 0.01));
    ML.bias = 0; ML.trained = 0; ML.mean = ML.mean || new Array(n).fill(0); ML.std = ML.std || new Array(n).fill(1);
    fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(ML,null,2));
    console.log("ML init features:", n);
  }
}
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function normalizeFeatures(features) {
  if (!ML.mean || ML.mean.length !== features.length) { ML.mean = features.slice(); ML.std = features.map(()=>1); return features.map((v,i)=> (v-ML.mean[i])/(ML.std[i]||1)); }
  return features.map((v,i)=> ((v - (ML.mean[i]||0)) / (ML.std[i]||1)));
}
function updateScaler(features) {
  if (!ML.mean || ML.mean.length !== features.length) { ML.mean = features.slice(); ML.std = features.map(()=>0.0001); return; }
  const alpha = 0.02;
  for (let i=0;i<features.length;i++) {
    const x = features[i];
    ML.mean[i] = (1-alpha)*ML.mean[i] + alpha*x;
    const diff = x - ML.mean[i];
    ML.std[i] = Math.sqrt( (1-alpha)*Math.pow(ML.std[i],2) + alpha*diff*diff ) || ML.std[i] || 1;
  }
}
function mlPredict(featuresRaw) {
  if (!ML.w || ML.w.length !== featuresRaw.length) mlInit(featuresRaw.length);
  const features = normalizeFeatures(featuresRaw);
  let z = ML.bias;
  for (let i=0;i<features.length;i++) z += (ML.w[i]||0) * (features[i]||0);
  return sigmoid(z);
}
function mlTrain(featuresRaw, label) {
  if (!ML.w || ML.w.length !== featuresRaw.length) mlInit(featuresRaw.length);
  updateScaler(featuresRaw);
  const features = normalizeFeatures(featuresRaw);
  const p = mlPredict(featuresRaw);
  const err = label - p;
  const lr = ML.lr || 0.01, l2 = ML.l2 || 0.00005;
  for (let i=0;i<features.length;i++) ML.w[i] += lr * (err * (features[i]||0) - l2 * (ML.w[i]||0));
  ML.bias += lr * err; ML.trained = (ML.trained||0) + 1;
  if (ML.trained % 10 === 0) fs.writeFileSync(ML_MODEL_FILE, JSON.stringify(ML,null,2));
  return p;
}
function biasToSign(biasStr) { if (!biasStr) return 0; const s=biasStr.toString().toLowerCase(); if (s.includes("bull")) return 1; if (s.includes("bear")) return -1; return 0; }
function mlExtractFeatures({klines15, lastCandle, avgVol20=1, divergenceSign=0, ellConf=0, systemBias=0}) {
  const first = (klines15 && klines15[0]) || lastCandle;
  const last = lastCandle || (klines15 && klines15.at(-1));
  const slope15 = ((last.close - (first.close||last.close)) / (first.close||1)) * 100;
  const lastDeltaP = ((last.close - last.open) / (last.open||1)) * 100;
  const volRatio = avgVol20>0 ? (last.volume / avgVol20) : 1;
  const patt = detectCandlePatternSingle(last, (klines15 && klines15.at(-2))||last);
  return [ slope15, lastDeltaP, volRatio - 1, patt.isDoji||0, patt.isHammer||0, patt.isShooting||0, divergenceSign||0, (ellConf||0)/100, systemBias||0 ];
}

// ---------- REVERSAL WATCHER ----------
let lastRevAt=0;
const REV_COOLDOWN_MS = 90 * 1000;
async function reversalWatcherOnce() {
  try {
    const { data: kl1 } = await fetchKlinesUnified(SYMBOL_RAW, "1m", 120);
    if (!kl1||kl1.length<3) return;
    const last = kl1.at(-1), prev = kl1.at(-2);
    const avgVol = avgVolume(kl1,20) || 1;
    const patt = detectCandlePatternSingle(last, prev);
    const volSpike = last.volume > avgVol * 1.6;
    const now = Date.now();
    if (now - lastRevAt < REV_COOLDOWN_MS) return;
    let reason = null;
    if (patt.isHammer && volSpike) reason="Hammer";
    if (patt.isDoji && volSpike) reason="Doji";
    if (patt.isShooting && volSpike) reason="Shooting Star";
    if (reason) {
      lastRevAt = now;
      const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
      const feat = mlExtractFeatures({ klines15: kl1.slice(-40), lastCandle: last, avgVol20: avgVol, divergenceSign:0, ellConf:0, systemBias:0 });
      const prob = mlPredict(feat);
      const txt = `🚨 <b>Reversal Watcher</b>\n${nowStr()}\nSymbol: <b>${SYMBOL_RAW}</b>\nPattern: <b>${reason}</b>\nVolume: ${last.volume.toFixed(0)} (avg ${avgVol.toFixed(0)})\nPrice: ${last.close.toFixed(2)}\nML Prob: ${(prob*100).toFixed(1)}%`;
      await sendTG(txt);
      try { mlTrain(feat, prob > (ML.threshold || ML_ALERT_THRESH) ? 1 : 0); } catch(e){}
    }
  } catch(e){ console.warn("reversalWatcherOnce", e.message); }
}

// ---------- MAIN ANALYSIS & HYBRID SELECTION ----------
async function analyzeAndReport(sendAlso=true) {
  try {
    // fetch TF klines
    const tfData = {}; const sources={};
    for (const tf of TIMEFRAMES) {
      const { data, source } = await fetchKlinesUnified(SYMBOL_RAW, tf, tf==="1m"?120:100);
      tfData[tf] = data || []; sources[tf] = source || "None";
    }

    // ensure we have base 15m and 30m
    const kl15 = tfData["15m"] || [];
    const kl30 = tfData["30m"] || [];

    if ((!kl15 || kl15.length < 8) && (!kl30 || kl30.length < 8)) {
      const msg = `❗ Not enough 15m/30m candles — skipping (${nowStr()})`;
      console.warn(msg); if (sendAlso) await sendTG(msg); return { ok:false, err:msg };
    }

    // compute ATRs
    const atr15 = atr(kl15,14) || 0;
    const atr30 = atr(kl30,14) || 0;

    // hybrid selection logic
    let chosenTF = "15m", base = kl15, chosenATR = atr15;
    if (!kl15 || kl15.length < 8) { chosenTF = "30m"; base = kl30; chosenATR = atr30; }
    else if (!kl30 || kl30.length < 8) { chosenTF = "15m"; base = kl15; chosenATR = atr15; }
    else {
      // if 15m is much more volatile than 30m, pick 30m
      if (atr15 > (atr30 * HYBRID_ATR_RATIO)) { chosenTF = "30m"; base = kl30; chosenATR = atr30; }
      else { chosenTF = "15m"; base = kl15; chosenATR = atr15; }
    }

    // base now chosen
    if (!base || base.length < 8) {
      const msg = `❗ Not enough candles for chosen TF (${chosenTF}) — skip`;
      console.warn(msg); if (sendAlso) await sendTG(msg); return { ok:false, err:msg };
    }

    const lastPrice = base.at(-1).close;
    const fib = calcFib(base);
    const atrVal = chosenATR || atr(base,14) || 0;
    const avgVol20 = avgVolume(base,20);

    // per-TF divergence + trend text
    let bullCount=0, bearCount=0, totalStrength=0;
    let perTfText = "";
    for (const tf of TIMEFRAMES) {
      const kl = tfData[tf] || [];
      const d = detectDivergence(kl);
      const slope = (kl.length>1)? ((kl.at(-1).close - kl[0].close)/(kl[0].close||1))*100 : 0;
      const trend = Math.abs(slope) < 0.2 ? "Flat" : slope > 0 ? "Uptrend" : "Downtrend";
      if (d.type.includes("Bull")) bullCount++;
      if (d.type.includes("Bear")) bearCount++;
      totalStrength += d.strength || 0;
      perTfText += `\n⏱ ${tf} | ${d.type} | ΔP ${d.dp.toFixed(2)}% | ΔV ${d.dv.toFixed(2)}% | Str ${Math.round(d.strength)} | Source: ${sources[tf]}\nTrend: ${trend}\n`;
    }

    // Elliott phase detection on both 15m and 30m for context
    const ell15 = detectElliottPhase(kl15);
    const ell30 = detectElliottPhase(kl30);
    const ell = chosenTF === "15m" ? ell15 : ell30;

    // label merging (simple)
    const COMBINED = 0.55 * ((bullCount - bearCount) / (TIMEFRAMES.length || 1)) + 0.3 * ( (Math.sign(totalStrength)||0) * (Math.min(1,totalStrength/100)) );
    const label = COMBINED > 0.12 ? "Bullish" : COMBINED < -0.12 ? "Bearish" : "Neutral";
    const confidencePct = Math.round(Math.min(99, Math.abs(COMBINED) * 100));

    // hybrid targets
    const tgs = getTargetsAndSL_Hybrid(lastPrice, fib, atrVal, ell.phase, label);
    const breakoutRange = (fib && isFinite(fib.fib618) && isFinite(fib.fib382)) ? `${fib.fib618.toFixed(2)} - ${fib.fib382.toFixed(2)}` : "N/A";

     // news & socials
    const [newsRes, redditRes, nitterRes] = await Promise.allSettled([fetchHeadlines(), fetchReddit(6), fetchNitter("bitcoin",6)]);
    const newsArr = newsRes.status==="fulfilled"? newsRes.value : [];
    const redditArr = redditRes.status==="fulfilled"? redditRes.value : [];
    const tweetsArr = nitterRes.status==="fulfilled"? nitterRes.value : [];

    // ML training on previous prediction
    try {
      if (fs.existsSync(LAST_PRED_FILE)) {
        const prev = JSON.parse(fs.readFileSync(LAST_PRED_FILE,"utf8"));
        if (prev && prev.klines15 && typeof prev.predProb === "number") {
          const prevClose = prev.prevClose || 0;
          const actualDir = lastPrice > prevClose ? 1 : lastPrice < prevClose ? -1 : 0;
          const predictedDir = prev.predProb > (ML.threshold||ML_ALERT_THRESH) ? 1 : (prev.predProb < (1-(ML.threshold||ML_ALERT_THRESH)) ? -1 : 0);
          const labelTrain = (predictedDir !== 0 && Math.sign(predictedDir) === Math.sign(actualDir)) ? 1 : 0;
          const featPrev = mlExtractFeatures({ klines15: prev.klines15, lastCandle: prev.klines15.at(-1), avgVol20: avgVolume(prev.klines15,20), divergenceSign: prev.divSign||0, ellConf: prev.ellConf||0, systemBias: biasToSign(prev.predLabel||"") });
          const probBefore = mlPredict(featPrev);
          mlTrain(featPrev, labelTrain);
          console.log("ML trained prev label", labelTrain, "probBefore", probBefore.toFixed(3));
        }
      }
    } catch(e){ console.warn("ML train prev error", e.message); }

    // ML predict current
    const feat = mlExtractFeatures({ klines15: base.slice(-40), lastCandle: base.at(-1), avgVol20, divergenceSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0), ellConf: ell.confidence||0, systemBias: biasToSign(label) });
    const mlProb = mlPredict(feat);

    // save last pred payload
    try {
      const lastPredPayload = { predProb: mlProb, predLabel: label, prevClose: lastPrice, klines15: base.slice(-40), divSign: bullCount>bearCount?1:(bearCount>bullCount?-1:0), ellConf: ell.confidence||0, ts: Date.now() };
      fs.writeFileSync(LAST_PRED_FILE, JSON.stringify(lastPredPayload,null,2));
    } catch(e){ console.warn("save last pred", e.message); }

    // update accuracy comparing previous report
    try {
      const ACC_SAVE = "./last_report_prevclose_v882.json";
      if (fs.existsSync(ACC_SAVE)) {
        const prev = JSON.parse(fs.readFileSync(ACC_SAVE,"utf8"));
        if (prev && prev.pred && typeof prev.prevClose === "number") {
          const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
          pushAccLocal(prev.pred === actual);
        }
      }
      fs.writeFileSync(ACC_SAVE, JSON.stringify({ pred: label, prevClose: lastPrice, ts: Date.now() },null,2));
    } catch(e){ console.warn("acc update", e.message); }

    // Compose message
    let msg = `<b>🤖 ${SYMBOL_RAW} — AI Trader v8.8.2 (Hybrid)</b>\n🕒 ${nowStr()}\n`;
    msg += `🔎 Selected Base TF: <b>${chosenTF}</b> (ATR15: ${atr15.toFixed(2)}, ATR30: ${atr30.toFixed(2)})\n`;
    msg += perTfText + "\n";
    msg += `📈 Elliott(15m): ${ell15.phase} (${ell15.confidence}%) | Elliott(30m): ${ell30.phase} (${ell30.confidence}%)\n\n`;
    msg += `🎯 <b>Targets (${tgs.model})</b>:\nTP1: ${tgs.tp1} | TP2: ${tgs.tp2} | TP3: ${tgs.tp3}\nSL: ${tgs.sl}\n📊 Breakout Zone: ${breakoutRange}\n\n`;
    msg += `🧠 Bias: ${label} | Confidence: ${confidencePct}% | ML Prob: ${(mlProb*100).toFixed(1)}% (thr ${(ML.threshold||ML_ALERT_THRESH)*100}%)\n`;
    msg += `💰 Price: ${lastPrice.toFixed(2)} | ATR(${chosenTF}): ${atrVal.toFixed(2)} | Accuracy(last10): ${getAccLocal(10)}%\nSources: ${Object.values(sources).join(", ")}\n\n`;
    if (newsArr.length) { msg += `📰 Headlines:\n`; for (const n of newsArr.slice(0,6)) msg += `• ${n.title}\n`; } else msg += `📰 Headlines: No recent headlines\n`;

    // ML smart alert line
    if (mlProb >= (ML.threshold || ML_ALERT_THRESH) && confidencePct > 30) msg += `\n🚨 <b>ML Smart Alert</b>: ${(mlProb*100).toFixed(1)}% probability of ${label} move\n`;

    if (sendAlso) await sendTG(msg);

    return { ok:true, symbol: SYMBOL_RAW, price: lastPrice, mlProb, label, targets: tgs, atr: atrVal, chosenTF };

  } catch(e) {
    console.error("analyzeAndReport err", e.message);
    try { await sendTG(`❌ analyze error: ${e.message}`); } catch(e){}
    return { ok:false, err:e.message };
  }
}

// ---------- SELF PING ----------
async function selfPing() {
  if (!SELF_PING_URL) return;
  let url = SELF_PING_URL; if (!url.startsWith("http")) url = `https://${url}`;
  try { const r = await fetch(url); console.log("self-ping:", r.status); } catch(e){ console.warn("selfPing failed", e.message); }
}

// ---------- EXPRESS for TG commands & keepalive ----------
const app = express();
app.use(express.json());
app.get("/", (_,res)=> res.send("AI Trader v8.8.2 hybrid running"));
app.get("/check", async (_,res)=> { const r = await analyzeAndReport(true); res.json(r); });
app.post("/tg/cmd", async (req,res) => {
  try {
    const body = req.body || {}; const cmd = (body.cmd||"").toString().trim();
    if (!cmd) return res.json({ ok:false, err:"no cmd" });
    if (cmd === "/start" || cmd === "/help") {
      const help = `<b>AI Trader Bot</b>\nCommands:\n/start or /help\n/status\n/check\n/reversal\nBot auto-runs every ${CHECK_INTERVAL_MIN} minutes.`;
      await sendTG(help); return res.json({ ok:true });
    } else if (cmd === "/status") {
      const s = await analyzeAndReport(false);
      if (s.ok) { await sendTG(`<b>Status</b>\nSymbol:${s.symbol}\nPrice:${s.price.toFixed(2)}\nML Prob:${(s.mlProb*100).toFixed(1)}%\nLabel:${s.label}`); return res.json({ ok:true, status:s }); }
      return res.json({ ok:false, err:s.err });
    } else if (cmd === "/check") {
      const r = await analyzeAndReport(true); return res.json({ ok:true, report:r });
    } else if (cmd === "/reversal") {
      await reversalWatcherOnce(); return res.json({ ok:true });
    } else { await sendTG("Unknown command. Use /help"); return res.json({ ok:false, err:"unknown cmd" }); }
  } catch(e){ console.warn("tg/cmd err", e.message); return res.status(500).json({ ok:false, err:e.message }); }
});
app.listen(PORT, ()=> console.log(`Server listening on ${PORT}`));

// ---------- START intervals ----------
(async function startAll(){
  try {
    await analyzeAndReport(true);
    await reversalWatcherOnce();
    setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
    setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);
    if (SELF_PING_URL) setInterval(selfPing, 5 * 60 * 1000);
  } catch(e){ console.error("startAll err", e.message); }
})();