/**
 * AI Trader v8.6
 * - 15-min multi-TF report
 * - 1-min Reversal Watcher (Doji, Hammer, Shooting Star) with High Volume confirmation
 * - Smart cooldowns, self-ping, news fetch fallback, chunked Telegram messages
 *
 * Requirements:
 *   npm i node-fetch@3 express dotenv
 *
 * Run: node aiTraderBot_v8.6.js
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
// ------------------ Machine Learning Online Module (Logistic Regression) ------------------
import fs from "fs";
const ML_MODEL_FILE = "./ml_model_v86.json";

function sigmoid(z){ return 1/(1+Math.exp(-z)); }

function mlLoad(){
  try{
    if(fs.existsSync(ML_MODEL_FILE)){
      return JSON.parse(fs.readFileSync(ML_MODEL_FILE,"utf8"));
    }
  }catch(e){ console.warn("mlLoad err",e.message); }
  return {w:null,bias:0,n_features:0,lr:0.02,l2:0.0001,trained:0};
}
function mlSave(m){ try{ fs.writeFileSync(ML_MODEL_FILE,JSON.stringify(m,null,2)); }catch(e){console.warn("mlSave err",e.message);} }

let ML = mlLoad();
function mlInit(n){
  if(!ML.w || ML.n_features!==n){
    ML.n_features=n;
    ML.w=new Array(n).fill(0).map(()=>Math.random()*0.01);
    ML.bias=0; ML.trained=0;
    mlSave(ML);
    console.log("ML model initialized n_features=",n);
  }
}

function mlExtractFeatures({klines15,lastCandle,avgVol20,divergenceSign,ellConf=0,systemBias=0}){
  const first=klines15[0], last=klines15.at(-1);
  const slope15=((last.close-first.close)/(first.close||1))*100;
  const lastDeltaP=((last.close-last.open)/(last.open||1))*100;
  const volRatio=avgVol20>0?(last.volume/avgVol20):1;
  const body=Math.abs(last.close-last.open);
  const range=(last.high-last.low)||1;
  const isDoji=body<=range*0.15?1:0;
  const lowerWick=Math.min(last.open,last.close)-last.low;
  const upperWick=last.high-Math.max(last.open,last.close);
  const isHammer=(lowerWick/range>0.4&&upperWick/range<0.25&&last.close>klines15.at(-2).close)?1:0;
  const isShooting=(upperWick/range>0.4&&lowerWick/range<0.25&&last.close<klines15.at(-2).close)?1:0;
  return [
    slope15, lastDeltaP, volRatio-1,
    isDoji, isHammer, isShooting,
    divergenceSign||0, ellConf/100, systemBias||0
  ];
}

function mlPredict(f){
  if(!ML.w||ML.w.length!==f.length) mlInit(f.length);
  const z=ML.bias+f.reduce((s,v,i)=>s+(ML.w[i]||0)*v,0);
  return sigmoid(z);
}

function mlTrain(f,label){
  if(!ML.w||ML.w.length!==f.length) mlInit(f.length);
  const lr=ML.lr||0.02, l2=ML.l2||0.0001;
  const p=mlPredict(f); const err=label-p;
  for(let i=0;i<f.length;i++){
    ML.w[i]+=lr*(err*f[i]-l2*ML.w[i]);
  }
  ML.bias+=lr*err; ML.trained=(ML.trained||0)+1;
  if(ML.trained%5===0) mlSave(ML);
  return p;
}

function biasToSign(b){
  if(!b) return 0;
  const s=b.toLowerCase();
  if(s.includes("bull")) return 1;
  if(s.includes("bear")) return -1;
  return 0;
}
// ------------------ End ML module ------------------

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";

const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10); // main report
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10); // reversal watcher
const REV_COOLDOWN_MIN = parseInt(process.env.REV_COOLDOWN_MIN || "10", 10);
const VOLUME_MULTIPLIER = parseFloat(process.env.VOLUME_MULTIPLIER || "1.5");

const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN and CHAT_ID required in .env");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

// persistence files
const ACC_FILE = "./acc_v86.json";
const LAST_PRED_FILE = "./last_pred_v86.json";
const LAST_REV_FILE = "./last_rev_v86.json";

// proxies (fallback)
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/get?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?",
];

// ---------- Helpers ----------
function nowIndia() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeParseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- Telegram send (chunked) ----------
async function sendTelegram(text) {
  const max = 3900;
  const parts = text.match(/[\s\S]{1,3900}/g) || [text];
  for (const p of parts) {
    try {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: p, parse_mode: "HTML" }),
      });
    } catch (err) {
      console.warn("tg send error:", err.message);
    }
    await sleep(600); // small rate spacing
  }
}

// ---------- File persistence helpers ----------
function loadJSON(path, fallback) {
  try { if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { /* ignore */ }
  return fallback;
}
function saveJSON(path, obj) {
  try { fs.writeFileSync(path, JSON.stringify(obj, null, 2)); } catch (e) { console.warn("saveJSON err", e.message); }
}

// ---------- Fetch klines (binance) with proxy fallback ----------
async function fetchKlines(symbol = SYMBOL, interval = "15m", limit = 100) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  // Try proxies first (encode target URL as required by proxy)
  for (const proxy of PROXIES) {
    try {
      const proxyUrl = proxy + encodeURIComponent(url);
      const r = await fetch(proxyUrl, { timeout: 12000 });
      if (!r.ok) throw new Error(`proxy ${proxy} failed ${r.status}`);
      // allorigins/codetabs return JSON with contents sometimes
      const txt = await r.text();
      let data = null;
      // if JSON-like with 'contents' field:
      if (txt.trim().startsWith("{")) {
        const j = safeParseJSON(txt, null);
        const inner = j?.contents || j?.result || null;
        if (inner) {
          // codetabs may proxy RSS etc, but Binance JSON will be proxied as stringified JSON sometimes
          try { data = JSON.parse(inner); } catch { /* ignore */ }
        } else {
          // maybe codetabs returned JSON response for Binance (rare)
          try { data = j; } catch {}
        }
      } else {
        // plain JSON string expected from some proxies
        try { data = JSON.parse(txt); } catch {}
      }
      if (Array.isArray(data) && data.length) {
        return data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
      }
    } catch (err) {
      // console.warn("fetchKlines proxy fail", proxy, err.message);
      continue;
    }
  }

  // Last resort: direct fetch
  try {
    const r = await fetch(url, { timeout: 10000 });
    if (!r.ok) throw new Error("direct binance failed " + r.status);
    const j = await r.json();
    return j.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  } catch (err) {
    throw new Error("All klines attempts failed: " + err.message);
  }
}

// ---------- News fetch (multi-proxy fallback) ----------
async function fetchNewsTitles(limit = 4) {
  const target = "https://cointelegraph.com/rss";
  const sources = [
    "https://api.allorigins.win/get?url=" + encodeURIComponent(target),
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(target),
    "https://thingproxy.freeboard.io/fetch/" + encodeURIComponent(target),
    "https://corsproxy.io/?" + encodeURIComponent(target),
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src, { timeout: 10000 });
      let txt = await r.text();
      if (txt.trim().startsWith("{")) {
        const j = safeParseJSON(txt, {});
        txt = j.contents || j.result || j;
      }
      if (!txt || typeof txt !== "string") continue;
      const items = txt.split("<item>").slice(1, 1 + limit);
      const titles = items.map(it => (it.match(/<title>(.*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim()).filter(Boolean);
      if (titles.length) {
        console.log("✅ News fetched via", src);
        return titles;
      }
    } catch (err) {
      // console.warn("news fetch fail", src, err.message);
      continue;
    }
  }
  return ["No recent news fetched"];
}

// ---------- Indicators & Pattern detectors ----------

// simple average volume over last N candles
function avgVolume(klines, N = 20) {
  const last = klines.slice(-N);
  if (!last.length) return 0;
  return last.reduce((s, k) => s + k.volume, 0) / last.length;
}

function isDoji(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1;
  return body <= range * 0.15; // small body relative to range
}

function isHammer(c, prev) {
  // bullish hammer: small body near top, long lower wick
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const range = c.high - c.low || 1;
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const bodyRatio = body / range;
  // require long lower wick (>40% range), small upper wick, small body
  return (lowerRatio > 0.4 && upperRatio < 0.25 && bodyRatio < 0.5) && c.close > prev.close;
}

function isShootingStar(c, prev) {
  // bearish shooting star: small body near bottom, long upper wick
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const range = c.high - c.low || 1;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;
  const bodyRatio = body / range;
  return (upperRatio > 0.4 && lowerRatio < 0.25 && bodyRatio < 0.5) && c.close < prev.close;
}

// detect divergence simple: price moved up but volume down or vice versa
function detectDivergence(latest, prev) {
  const dp = ((latest.close - prev.close) / (prev.close || 1)) * 100;
  const dv = ((latest.volume - prev.volume) / (prev.volume || 1)) * 100;
  if (dp > 0 && dv < 0) return { type: "Bearish Divergence", dp, dv };
  if (dp < 0 && dv > 0) return { type: "Bullish Divergence", dp, dv };
  return { type: "Neutral", dp, dv };
}

// ---------- Accuracy & state ----------
let accArr = loadJSON(ACC_FILE, []);
function pushAccuracy(isCorrect) {
  accArr.push(isCorrect ? 1 : 0);
  if (accArr.length > 100) accArr.shift();
  saveJSON(ACC_FILE, accArr);
}
function getAccuracy(lastN = 10) {
  const arr = accArr.slice(-lastN);
  if (!arr.length) return "N/A";
  const pct = (arr.reduce((a, b) => a + b, 0) / arr.length) * 100;
  return pct.toFixed(1) + "%";
}

// ---------- Reversal Watcher (runs per minute) ----------
let lastReversal = loadJSON(LAST_REV_FILE, { ts: 0, msg: null });
async function checkReversal() {
  try {
    // Use 3m or 1m candles depending on what's fast and available; we'll use 1m
    const tf = "1m";
    const kl = await fetchKlines(SYMBOL, tf, 40);
    if (!kl || kl.length < 6) return;

    const last = kl.at(-1);
    const prev = kl.at(-2);
    const avgVol = avgVolume(kl, 20);
    const volFactor = avgVol ? (last.volume / avgVol) : 0;

    const highVol = volFactor >= VOLUME_MULTIPLIER; // configurable
    const doji = isDoji(last);
    const hammer = isHammer(last, prev);
    const shooting = isShootingStar(last, prev);
    const divergence = detectDivergence(last, prev); // quick check

    // Build candidate message
    let reasons = [];
    if (highVol) reasons.push(`HighVolume×${volFactor.toFixed(2)}`);
    if (doji) reasons.push("Doji");
    if (hammer) reasons.push("Hammer");
    if (shooting) reasons.push("ShootingStar");
    if (divergence.type !== "Neutral") reasons.push(divergence.type);

    if (reasons.length === 0) return; // nothing interesting

    // Enforce cooldown
    const nowTs = Date.now();
    if ((nowTs - (lastReversal.ts || 0)) / 60000 < REV_COOLDOWN_MIN) {
      // in cooldown
      // console.log("in cooldown, skipping reversal alert");
      return;
    }

    // Determine direction suggestion
    let suggestion = "Neutral";
    if (hammer || (divergence.type === "Bullish Divergence")) suggestion = "Bullish Reversal Candidate";
    if (shooting || (divergence.type === "Bearish Divergence")) suggestion = "Bearish Reversal Candidate";
    if (doji) suggestion = "Potential Reversal (Doji)";

    // Prepare message
    const msg = `🚨 <b>Reversal Alert</b>\nSymbol: <b>${SYMBOL}</b>\nTime: ${nowIndia()}\nTF: ${tf}\nDetected: ${reasons.join(" + ")}\nSuggestion: <b>${suggestion}</b>\nPrice: ${last.close}\nAvgVol(${20}): ${avgVol.toFixed(2)} | CandleVol: ${last.volume}\nCooldown: ${REV_COOLDOWN_MIN}m\n\n(If this matches your strategy, consider checking chart)`;

    // Send
    await sendTelegram(msg);

    // Save last reversal timestamp
    lastReversal = { ts: nowTs, msg: msg };
    saveJSON(LAST_REV_FILE, lastReversal);

    console.log("Reversal alert sent:", suggestion, nowIndia());
  } catch (err) {
    console.warn("checkReversal err:", err.message);
  }
}

// ---------- Main 15-minute report ----------
async function mainReport() {
  try {
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    let report = `🤖 <b>${SYMBOL} — AI Trader v8.6</b>\n🕒 ${nowIndia()}\n\n`;
    let bull = 0, bear = 0;
    let sumStrength = 0;
    let lastPrice = null;

    for (const tf of tfs) {
      const kl = await fetchKlines(SYMBOL, tf, 80).catch(e => { console.warn("kl fetch", tf, e.message); return []; });
      if (!kl || !kl.length) {
        report += `⏱ ${tf}: No data\n`;
        continue;
      }
      // simple divergence and slope computation
      const latest = kl.at(-1), prev = kl.at(-2);
      const dp = ((latest.close - prev.close) / (prev.close || 1)) * 100;
      const dv = ((latest.volume - prev.volume) / (prev.volume || 1)) * 100;
      const divType = (dp > 0 && dv < 0) ? "Bearish Divergence" : (dp < 0 && dv > 0) ? "Bullish Divergence" : "Neutral";
      const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
      const slopePct = ((latest.close - kl[0].close) / (kl[0].close || 1)) * 100;
      const slopeLabel = slopePct > 0.5 ? "Uptrend" : slopePct < -0.5 ? "Downtrend" : "Sideways";

      report += `⏱ ${tf}: ${divType} | ΔP ${dp.toFixed(2)}% | ΔV ${dv.toFixed(2)}% | ${slopeLabel} | Strength ${Math.round(strength)}%\n`;

      if (divType.includes("Bullish")) bull++;
      if (divType.includes("Bearish")) bear++;
      sumStrength += strength;
      lastPrice = latest.close;
    }

    // news
    const news = await fetchNewsTitles(4);
    // overall bias & targets (ATR-ish)
    const bias = bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const rawConf = Math.round((sumStrength / (tfs.length * 100)) * 10000) / 100 || 0;

    // targets from 15m klines if available
    let targets = { tp1: "N/A", tp2: "N/A", tp3: "N/A", sl: "N/A", breakout: "N/A" };
    try {
      const base = await fetchKlines(SYMBOL, "15m", 120);
      if (base && base.length) {
        const last = base.at(-1).close;
        const atr = (() => {
          const period = Math.min(14, base.length - 1);
          const trs = [];
          for (let i = base.length - period; i < base.length; i++) {
            const cur = base[i], prev = base[i - 1] || cur;
            const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
            trs.push(tr);
          }
          return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
        })();
        const move = atr * 1.5 || last * 0.005;
        targets = {
          tp1: (last + move).toFixed(2),
          tp2: (last + move * 2).toFixed(2),
          tp3: (last + move * 3).toFixed(2),
          sl: (last - move).toFixed(2),
          breakout: `${(last - move * 0.5).toFixed(2)} - ${(last + move * 0.5).toFixed(2)}`
        };
      }
    } catch (e) { /* ignore */ }

    // accuracy check - compare prev prediction saved previously
    try {
      const prev = loadJSON(LAST_PRED_FILE, null);
      if (prev && prev.pred && prev.prevClose && lastPrice) {
        const actual = lastPrice > prev.prevClose ? "Bullish" : lastPrice < prev.prevClose ? "Bearish" : "Neutral";
        // push accuracy boolean
        pushAccuracy(prev.pred === actual);
      }
      // store current
      saveJSON(LAST_PRED_FILE, { pred: bias.includes("Bullish") ? "Bullish" : bias.includes("Bearish") ? "Bearish" : "Neutral", prevClose: lastPrice, ts: Date.now() });
    } catch (e) { /* ignore */ }

    // build message
    report += `\n🎯 Targets:\nTP1: ${targets.tp1} | TP2: ${targets.tp2} | TP3: ${targets.tp3}\nSL: ${targets.sl}\nBreakout Range: ${targets.breakout}\n\n`;
    report += `🧠 Overall Bias: <b>${bias}</b> | Confidence (raw): ${rawConf}%\n💰 Last Price: ${lastPrice}\n📈 Accuracy(last10): ${getAccuracy(10)}\n\n📰 Headlines:\n${news.map(n => "• " + n).join("\n")}\n`;

    // maybe smart alert: if rawConf high and news confirms (simple)
    const newsScore = news.join(" ").toLowerCase();
    const newsBull = /rise|surge|gain|rally|bull|approval|inflow|soar/.test(newsScore);
    const newsBear = /fall|drop|crash|bear|dump|selloff|liquidation|hack|lawsuit/.test(newsScore);
    if (rawConf > 60 && ((bias.includes("Bullish") && newsBull) || (bias.includes("Bearish") && newsBear))) {
      report += `\n🚨 <b>Smart Alert:</b> ${bias} confirmed by news & strength (${rawConf}%)\n`;
    }

    await sendTelegram(report);
    console.log("Main report sent", nowIndia());
  } catch (err) {
    console.warn("mainReport err:", err.message);
  }
}

// ---------- Self-ping to keep host awake ----------
async function selfPing() {
  if (!RENDER_EXTERNAL_URL) return;
  try {
    const url = RENDER_EXTERNAL_URL.startsWith("http") ? RENDER_EXTERNAL_URL : `https://${RENDER_EXTERNAL_URL}`;
    const r = await fetch(url);
    console.log("Self-ping", r.status);
  } catch (err) { console.warn("selfPing err:", err.message); }
}

// ---------- HTTP server for Render / webhook ----------
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("AI Trader v8.6 Running ✅"));
app.post("/webhook", async (req, res) => {
  const text = req.body?.message?.text || "";
  if (text === "/help") {
    await sendTelegram(`<b>AI Trader v8.6 — Help</b>\n/now - run immediate report\n/status - accuracy\n/rev - last reversal info`);
  } else if (text === "/now") {
    await mainReport();
  } else if (text === "/status") {
    await sendTelegram(`Accuracy(last10): ${getAccuracy(10)}\nLast reversal: ${lastReversal.ts ? new Date(lastReversal.ts).toLocaleString() : "never"}`);
  } else if (text === "/rev") {
    const lr = loadJSON(LAST_REV_FILE, { ts: 0, msg: "none" });
    await sendTelegram(`Last Reversal:\n${lr.msg || "none"}`);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));

// ---------- Scheduler ----------
(async () => {
  // initial run
  await mainReport().catch(e => console.warn(e.message));
  // Start reversal watcher every REV_CHECK_INTERVAL_SEC
  setInterval(checkReversal, REV_CHECK_INTERVAL_SEC * 1000);
  // 15-min main report loop
  setInterval(mainReport, CHECK_INTERVAL_MIN * 60 * 1000);
  // self-ping every 3 minutes to keep alive
  setInterval(selfPing, 3 * 60 * 1000);
  console.log("🤖 AI Trader v8.6 started", nowIndia());
})();