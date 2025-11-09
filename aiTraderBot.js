// AI Trader v9.3 — Extended TFs + Auto Pattern Detection + Self-learning
// Requires: telegraf, node-fetch@2, express, dotenv, fs
// npm i telegraf node-fetch@2 express dotenv

import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import express from "express";
import fs from "fs";
import "dotenv/config";

/* ---------- Config ---------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "30", 10); // default 30m for extended TF
const ALERT_THRESHOLD = parseInt(process.env.ALERT_THRESHOLD || "80", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("BOT_TOKEN or CHAT_ID missing in .env");
  process.exit(1);
}

/* ---------- Helpers ---------- */
const bot = new Telegraf(BOT_TOKEN);
const app = express();
const getTime = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?",
];

function safeReadJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8") || "null") || fallback; } catch { return fallback; }
}
function safeWriteJSON(path, obj) { fs.writeFileSync(path, JSON.stringify(obj, null, 2)); }

/* ---------- Persistent state ---------- */
const ACC_FILE = "accuracy_v93.json";
const STATE_FILE = "weights_v93.json";
let WEIGHTS = safeReadJSON(STATE_FILE, { tech: 0.55, news: 0.25, trend: 0.20 });

/* ---------- Market fetcher (binance via proxies) ---------- */
async function fetchKlines(symbol = SYMBOL, interval = "15m", limit = 100) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const p of PROXIES) {
    try {
      const res = await fetch(p + encodeURIComponent(url));
      if (!res.ok) throw new Error("proxy status " + res.status);
      const j = await res.json();
      if (!Array.isArray(j) || !j.length) throw new Error("empty");
      return j.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] }));
    } catch (e) { /* try next proxy */ }
  }
  throw new Error("All proxies failed for klines");
}

/* ---------- Basic analysis primitives ---------- */
function analyzeCandleDelta(kl) {
  const last = kl.at(-1), prev = kl.at(-2);
  const dp = ((last.close - prev.close) / prev.close) * 100;
  const dv = ((last.vol - prev.vol) / prev.vol) * 100;
  const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
  let signal = "Neutral ⚖️";
  if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
  if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";
  return { dp, dv, strength, signal, price: last.close };
}

function linearSlope(kl) {
  const closes = kl.map(k => k.close);
  const n = closes.length;
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const meanX = xs.reduce((a,b)=>a+b,0)/n;
  const meanY = closes.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((s,i,idx)=>s + (i-meanX)*(closes[idx]-meanY), 0);
  const den = xs.reduce((s,i)=>s + (i-meanX)**2, 0);
  const m = num/den;
  if (m > 0.05) return { label: "Uptrend 📈", slope: m };
  if (m < -0.05) return { label: "Downtrend 📉", slope: m };
  return { label: "Sideways ➖", slope: m };
}

function fibLevel(kl, ratio = 0.618) {
  const highs = kl.map(k => k.high), lows = kl.map(k => k.low);
  const H = Math.max(...highs), L = Math.min(...lows);
  const fib = H - (H - L) * ratio;
  const zone = { low: fib * 0.998, mid: fib, high: fib * 1.002 };
  return { fib: +fib.toFixed(2), zone: { low: +zone.low.toFixed(2), high: +zone.high.toFixed(2) } };
}

/* ---------- Simple News Sentiment (keyword-based) ---------- */
const POS = ["bull", "surge", "gain", "rally", "soar", "adopt", "approval", "inflow", "pump"];
const NEG = ["crash", "dump", "ban", "bear", "liquidation", "hack", "lawsuit", "selloff"];
function kwScore(text) {
  if (!text) return 0;
  const t = text.toLowerCase();
  let s = 0;
  POS.forEach(k => { if (t.includes(k)) s += 1; });
  NEG.forEach(k => { if (t.includes(k)) s -= 1; });
  return s;
}
async function fetchNewsTitles() {
  try {
    // CoinDesk RSS via codetabs proxy (no API key)
    const proxy = PROXIES[0] + encodeURIComponent("https://www.coindesk.com/arc/outboundfeeds/rss/");
    const res = await fetch(proxy);
    const txt = await res.text();
    const items = txt.split("<item>").slice(1, 7);
    return items.map(it => (it.match(/<title>(.*?)<\/title>/i)||[])[1]?.replace(/<!\[CDATA\[|\]\]>/g,"") || "");
  } catch(e) { return []; }
}
function newsSentiment(titles) {
  if (!titles || !titles.length) return { score: 0, label: "Neutral" };
  const s = titles.reduce((a,t)=>a + kwScore(t), 0);
  return { score: s, label: s > 2 ? "Positive" : s < -2 ? "Negative" : "Neutral" };
}

/* ---------- Pattern detection heuristics ---------- */

/*
  Heuristic-based pattern detection:
  - doubleTop / doubleBottom: two peaks/troughs close in price and separated by some bars
  - headAndShoulders: triple-peaks with middle higher
  - ascending/descending triangle: converging highs/lows slopes
  - flag (flagpole + small channel): large prior move then small parallel channel
  NOTE: heuristic, not ML — good for alerts/confluence
*/
function detectPatterns(klines) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = closes.length;
  if (n < 20) return [];

  const patterns = [];

  // helper: find local peaks/troughs
  function localExtrema(arr) {
    const peaks = [], troughs = [];
    for (let i = 2; i < arr.length - 2; i++) {
      if (arr[i] > arr[i-1] && arr[i] > arr[i+1] && arr[i] > arr[i-2] && arr[i] > arr[i+2]) peaks.push({i, v:arr[i]});
      if (arr[i] < arr[i-1] && arr[i] < arr[i+1] && arr[i] < arr[i-2] && arr[i] < arr[i+2]) troughs.push({i, v:arr[i]});
    }
    return { peaks, troughs };
  }

  const { peaks, troughs } = localExtrema(closes);

  // Double top / bottom: two peaks/troughs near same value, separated by 3-12 bars
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i+1; j < peaks.length && j < i+6; j++) {
      const sep = peaks[j].i - peaks[i].i;
      const pctDiff = Math.abs(peaks[i].v - peaks[j].v) / Math.max(peaks[i].v, peaks[j].v);
      if (sep >= 3 && sep <= 16 && pctDiff < 0.015) {
        patterns.push({ type: "Double Top", idx1: peaks[i].i, idx2: peaks[j].i, price: ((peaks[i].v+peaks[j].v)/2).toFixed(2) });
      }
    }
  }
  for (let i = 0; i < troughs.length; i++) {
    for (let j = i+1; j < troughs.length && j < i+6; j++) {
      const sep = troughs[j].i - troughs[i].i;
      const pctDiff = Math.abs(troughs[i].v - troughs[j].v) / Math.max(troughs[i].v, troughs[j].v);
      if (sep >= 3 && sep <= 16 && pctDiff < 0.015) {
        patterns.push({ type: "Double Bottom", idx1: troughs[i].i, idx2: troughs[j].i, price: ((troughs[i].v+troughs[j].v)/2).toFixed(2) });
      }
    }
  }

  // Head & Shoulders (simple): find three peaks with middle higher than flanks
  if (peaks.length >= 3) {
    for (let i = 0; i < peaks.length-2; i++) {
      const a = peaks[i], b = peaks[i+1], c = peaks[i+2];
      if (b.v > a.v && b.v > c.v && (a.v + c.v)/2 >= b.v * 0.8 && (b.v - Math.max(a.v,c.v)) / b.v > 0.03) {
        patterns.push({ type: "Head & Shoulders", idxs:[a.i,b.i,c.i], prices:[a.v,b.v,c.v].map(x=>x.toFixed(2)) });
      }
    }
  }

  // Triangle detection (converging highs/lows): compute line slopes of last 30 bars
  const window = Math.min(60, n);
  const recent = klines.slice(-window);
  const hiXs = recent.map((k,i)=>({x:i,y:k.high}));
  const loXs = recent.map((k,i)=>({x:i,y:k.low}));
  // linear regression slopes
  function slopeOf(points) {
    const N = points.length;
    const meanX = points.reduce((a,b)=>a+b.x,0)/N;
    const meanY = points.reduce((a,b)=>a+b.y,0)/N;
    const num = points.reduce((s,p)=>s + (p.x-meanX)*(p.y-meanY),0);
    const den = points.reduce((s,p)=>s + (p.x-meanX)**2,0);
    return num/den;
  }
  const slopeHi = slopeOf(hiXs);
  const slopeLo = slopeOf(loXs);
  if (slopeHi < 0 && slopeLo > 0 && Math.abs(slopeHi) > 0.01 && Math.abs(slopeLo) > 0.01) {
    patterns.push({ type: "Symmetric Triangle", slopeHi: slopeHi.toFixed(5), slopeLo: slopeLo.toFixed(5) });
  }
  if (slopeHi < 0 && slopeLo < 0 && Math.abs(slopeHi - slopeLo) < 0.01) {
    patterns.push({ type: "Descending Triangle / Wedge", slopeHi: slopeHi.toFixed(5), slopeLo: slopeLo.toFixed(5) });
  }
  if (slopeHi > 0 && slopeLo > 0 && Math.abs(slopeHi - slopeLo) < 0.01) {
    patterns.push({ type: "Ascending Triangle / Wedge", slopeHi: slopeHi.toFixed(5), slopeLo: slopeLo.toFixed(5) });
  }

  // Flag: check prior strong move (flagpole) > 2% over previous window then consolidation small range
  const lookback = 20;
  if (n >= lookback*2) {
    const prevRange = closes.slice(-lookback*2, -lookback);
    const latestRange = closes.slice(-lookback);
    const prevMove = (prevRange.at(-1) - prevRange[0]) / prevRange[0] * 100;
    const latestVolatility = Math.max(...latestRange) - Math.min(...latestRange);
    if (Math.abs(prevMove) > 3 && latestVolatility / prevRange[0] < 0.01) {
      patterns.push({ type: "Flag/Flagpole", prevMove: prevMove.toFixed(2), consolidation: latestVolatility.toFixed(4) });
    }
  }

  return patterns;
}

/* ---------- Accuracy / Learning ---------- */
function loadAcc() {
  try { return JSON.parse(fs.readFileSync(ACC_FILE, "utf8")); } catch { return []; }
}
function saveAcc(arr) { fs.writeFileSync(ACC_FILE, JSON.stringify(arr, null, 2)); }
function pushPrediction(pred, price) {
  const arr = loadAcc();
  arr.push({ ts: Date.now(), pred, price, correct: null });
  if (arr.length > 100) arr.shift();
  saveAcc(arr);
}
function evaluatePrevious() {
  const arr = loadAcc();
  if (arr.length < 2) return;
  const prev = arr[arr.length - 2];
  const last = arr[arr.length - 1];
  if (prev && prev.correct === null && prev.price && last.price) {
    const actual = (last.price > prev.price) ? "Bullish" : (last.price < prev.price) ? "Bearish" : "Neutral";
    prev.correct = (prev.pred === actual);
    saveAcc(arr);
    // adjust weights
    const ok = prev.correct ? 1 : 0;
    adjustWeights(ok);
  }
}
function getAccuracyPercent(lastN = 20) {
  const arr = loadAcc().filter(x => typeof x.correct === "boolean");
  if (!arr.length) return "N/A";
  const slice = arr.slice(-lastN);
  const pct = (slice.reduce((s,x)=>s + (x.correct?1:0),0) / slice.length) * 100;
  return pct.toFixed(1) + "%";
}

/* ---------- Weight adjuster ---------- */
function adjustWeights(correct) {
  const delta = correct ? 0.02 : -0.02;
  WEIGHTS.tech = Math.min(0.8, Math.max(0.05, WEIGHTS.tech + delta * 0.6));
  WEIGHTS.news = Math.min(0.6, Math.max(0.02, WEIGHTS.news + delta * 0.3));
  WEIGHTS.trend = Math.min(0.6, Math.max(0.02, WEIGHTS.trend + delta * 0.1));
  // normalize
  const sum = WEIGHTS.tech + WEIGHTS.news + WEIGHTS.trend;
  WEIGHTS.tech /= sum; WEIGHTS.news /= sum; WEIGHTS.trend /= sum;
  safeWriteJSON(STATE_FILE, WEIGHTS);
}

/* ---------- Targets calc (Fibonacci + ATR-ish) ---------- */
function calcTargets(lastPrice, klines) {
  // ATR-like: average true range of last 14
  const period = Math.min(14, klines.length - 1);
  let trs = [];
  for (let i = klines.length - period; i < klines.length; i++) {
    const cur = klines[i], prev = klines[i-1] || cur;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const atr = trs.length ? trs.reduce((a,b)=>a+b,0)/trs.length : (klines.at(-1).high - klines.at(-1).low);
  const move = atr * 1.5; // target multiplier
  const TP1 = +(lastPrice + move).toFixed(2), TP2 = +(lastPrice + move*2).toFixed(2), TP3 = +(lastPrice + move*3).toFixed(2);
  const SL = +(lastPrice - move).toFixed(2);
  return { TP1, TP2, TP3, SL, atr: +atr.toFixed(4) };
}

/* ---------- Main combined analyzer ---------- */
async function analyzeAndReport(customTF = null, sendTelegram = true) {
  try {
    const tfs = customTF ? [customTF] : ["1m","5m","15m","30m","1h","4h","1d"];
    let bull = 0, bear = 0, strengthSum = 0, lastPrice = 0;
    let reportLines = [];

    for (const tf of tfs) {
      const kl = await fetchKlines(SYMBOL, tf, 120);
      const delta = analyzeCandleDelta(kl);
      const trend = linearSlope(kl);
      const fib = fibLevel(kl);
      const ptns = detectPatterns(kl.slice(-120));
      reportLines.push({ tf, delta, trend, fib, ptns });
      lastPrice = delta.price;
      if (delta.signal.includes("Bullish")) bull++;
      if (delta.signal.includes("Bearish")) bear++;
      strengthSum += delta.strength;
    }

    // merge signals
    const rawConf = Math.round((strengthSum / (tfs.length * 100)) * 100); // 0-100
    // news
    const titles = await fetchNewsTitles();
    const news = newsSentiment(titles);

    // weighted confidence incorporate weights & news score
    const weighted = Math.max(0, Math.min(99, rawConf * WEIGHTS.tech + (news.score * 5 + 50) * WEIGHTS.news * 0.01 + ( (bull - bear) * 10 + 50) * WEIGHTS.trend * 0.01 ));
    const overallBias = bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral";

    // targets using 15m klines for precision (fallback last tf)
    let baseKL;
    try { baseKL = await fetchKlines(SYMBOL, "15m", 120); } catch { baseKL = await fetchKlines(SYMBOL, tfs[0], 120); }
    const targets = calcTargets(lastPrice, baseKL);
    const fibMain = fibLevel(baseKL);

    // build message
    let msg = `🤖 <b>${SYMBOL} — AI Trader v9.3</b>\n🕒 ${getTime()}\n\n`;
    for (const r of reportLines) {
      msg += `⏱ <b>${r.tf}</b> | ${r.delta.signal} | ΔP ${r.delta.dp.toFixed(2)}% | ΔV ${r.delta.dv.toFixed(2)}% | Str ${Math.round(r.delta.strength)}%\n`;
      msg += `Trend: ${r.trend.label} | Fib0.618: ${r.fib.fib} | Zone: ${r.fib.zone.low} → ${r.fib.zone.high}\n`;
      if (r.ptns && r.ptns.length) msg += `Patterns: ${r.ptns.map(p=>p.type).join(", ")}\n`;
      msg += `\n`;
    }

    msg += `🎯 <b>Targets (ATR-based)</b>\nTP1: ${targets.TP1} | TP2: ${targets.TP2} | TP3: ${targets.TP3} | SL: ${targets.SL} | ATR:${targets.atr}\n\n`;
    msg += `🧠 <b>Overall Bias:</b> ${overallBias} | <b>Weighted Conf:</b> ${Math.round(weighted)}% (raw ${rawConf}%)\n`;
    msg += `🔥 News: ${news.label} (${news.score}) | 📊 Accuracy(last20): ${getAccuracyPercent(20)}\n`;
    if (titles.length) msg += `📰 Top Headlines:\n• ${titles.slice(0,4).join("\n• ")}\n`;

    // Push prediction to accuracy memory
    pushPrediction(overallBias, lastPrice);

    if (sendTelegram) await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "HTML" });

    // Smart alerts logic (only when strong)
    if (weighted >= ALERT_THRESHOLD) {
      // if pattern indicates breakout and price near fib zone etc.
      const lastReport = reportLines[reportLines.length-1];
      const inFib = lastPrice >= lastReport.fib.zone.low && lastPrice <= lastReport.fib.zone.high;
      const patternStrong = lastReport.ptns && lastReport.ptns.length > 0;
      let alertMsg = `🚨 <b>Smart Alert</b>\n${overallBias} with ${Math.round(weighted)}% confidence.`;
      if (patternStrong) alertMsg += `\nPatterns: ${lastReport.ptns.map(p=>p.type).join(", ")}`;
      alertMsg += `\nFib zone: ${lastReport.fib.zone.low} → ${lastReport.fib.zone.high} | Price: ${lastPrice}`;
      await bot.telegram.sendMessage(CHAT_ID, alertMsg, { parse_mode: "HTML" });
    }

    // evaluate previous prediction (learning)
    evaluatePrevious();

    return { overallBias, weighted, lastPrice };
  } catch (err) {
    console.error("analyzeAndReport error:", err.message);
    if (sendTelegram) await bot.telegram.sendMessage(CHAT_ID, `❌ Bot error: ${err.message}`);
    return null;
  }
}

/* ---------- Commands: /help, /check, /status ---------- */
bot.start(ctx => ctx.reply("Welcome — AI Trader v9.3\nType /help for commands"));
bot.command("help", ctx => {
  ctx.replyWithHTML(`📘 <b>AI Trader v9.3 Help</b>

Commands:
• /check [tf|all]  — instant analysis (e.g. /check 15m, /check all)
• /status          — last bias & confidence
• /help            — this menu

Notes:
• TFs supported: 1m,5m,15m,30m,1h,4h,1d (use /check 4h)
• Bot auto runs every ${CHECK_MIN} minutes and sends Smart Alerts.
• Targets & breakout zones are ATR+Fib based. Use SL always.`);
});

bot.command("check", async ctx => {
  const raw = ctx.message.text.trim().split(" ");
  const tf = raw[1] || "all";
  await ctx.reply("⏳ Fetching live analysis — please wait...");
  if (tf === "all") {
    await analyzeAndReport(null, true);
  } else {
    // validate tf
    const allowed = ["1m","5m","15m","30m","1h","4h","1d"];
    if (!allowed.includes(tf)) return ctx.reply("Invalid TF. Use one of: " + allowed.join(", "));
    await analyzeAndReport(tf, true);
  }
});

bot.command("status", async ctx => {
  const acc = getAccuracyPercent(20);
  const w = WEIGHTS;
  ctx.replyWithHTML(`🧠 AI Trader v9.3 Status\nBias: last sent in chat\nWeights: tech ${w.tech.toFixed(2)}, news ${w.news.toFixed(2)}, trend ${w.trend.toFixed(2)}\nAccuracy(last 20): ${acc}`);
});

/* ---------- Auto schedule ---------- */
analyzeAndReport(); // initial
setInterval(() => analyzeAndReport(), CHECK_MIN * 60 * 1000);

/* ---------- Keepalive / Express ---------- */
app.get("/", (req, res) => res.send("AI Trader v9.3 running ✅"));
app.listen(process.env.PORT || 3000, () => console.log("Web server listening"));

/* ---------- Launch bot ---------- */
bot.launch();
console.log("🚀 AI Trader v9.3 live — extended TF & auto pattern detection enabled.");