/**
 * aiTraderBot_v9_2_pro.js
 * AI Trader v9.2 (Extended)
 *
 * Features:
 * - Multi-source candles (Binance / Coinbase / Kraken / CoinGecko)
 * - Multi-TF analysis (1m,5m,15m,30m,1h)
 * - Reversal watcher (candles + MACD + RSI + volume/ATR)
 * - ML module (online incremental) via ml_module_v9_2.js
 * - Chart image generation using chartjs-node-canvas -> send to Telegram
 * - SmartAlertManager: dedupe & cool-downs & thresholds
 * - Telegram commands via tg_commands.js
 *
 * Deploy: Node 18+, Install deps: `npm ci`
 * Run: `node aiTraderBot_v9_2_pro.js`
 */

import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import express from "express";
import fs from "fs";
import path from "path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { Telegraf } from "telegraf";
import { MACD, RSI } from "technicalindicators";
import * as ml from "./ml_module_v9_2.js";
import { initTelegramCommands } from "./tg_commands.js";

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const REPORT_INTERVAL_MIN = Number(process.env.REPORT_INTERVAL_MIN || 15);
const REV_CHECK_INTERVAL_SEC = Number(process.env.REV_CHECK_INTERVAL_SEC || 20);
const ML_ALERT_THRESH = Number(process.env.ML_ALERT_THRESH || 0.70);
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 9000);

const ax = axios.create({ timeout: FETCH_TIMEOUT, headers: { "User-Agent": "ai-trader-bot/9.2" } });

const app = express();
app.get("/", (_, res) => res.send("AI Trader v9.2 running"));

/* ---------- Multi-source fetchers (same logic as v9.1) ---------- */

const BINANCE_ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision", "https://api-gcp.binance.com"];

async function safeGet(url) {
  try {
    const r = await ax.get(url);
    return r;
  } catch (e) {
    throw e;
  }
}

async function fetchKlinesBinance(symbol, intervalStr, limit=500) {
  const url = `/api/v3/klines?symbol=${symbol}&interval=${intervalStr}&limit=${limit}`;
  for (const base of BINANCE_ENDPOINTS) {
    try {
      const r = await ax.get(base.replace(/\/$/,"") + url);
      if (Array.isArray(r.data) && r.data.length) {
        return r.data.map(k => ({ t: k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], vol:+k[5] }));
      }
    } catch (e) {
      console.warn("binance mirror fail", base, e.message || e);
    }
  }
  throw new Error("Binance all mirrors failed");
}

async function fetchKlinesCoinbase(product="BTC-USD", granularitySec=900, limit=500) {
  // Coinbase returns arrays: [time, low, high, open, close, volume] descending
  const end = Math.floor(Date.now()/1000);
  const start = end - granularitySec * limit;
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?start=${new Date(start*1000).toISOString()}&end=${new Date(end*1000).toISOString()}&granularity=${granularitySec}`;
  const r = await ax.get(url);
  const arr = r.data.slice(-limit).sort((a,b)=>a[0]-b[0]);
  return arr.map(a => ({ t: a[0]*1000, open:+a[3], high:+a[2], low:+a[1], close:+a[4], vol:+(a[5]||0) }));
}

async function fetchKlinesKraken(pair="XBTUSD", interval=15) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;
  const r = await ax.get(url);
  const key = Object.keys(r.data.result).find(k=>k!=="last");
  const arr = r.data.result[key].map(a=>({ t: a[0]*1000, open:+a[1], high:+a[2], low:+a[3], close:+a[4], vol:+a[6] }));
  return arr;
}

async function fetchKlinesCoinGecko(id="bitcoin", vs="usd", tfMinutes=15) {
  const r = await ax.get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=1`);
  const prices = r.data.prices || [];
  // bucket into timeframe intervals
  const buckets = {};
  for (const [ts, price] of prices) {
    const bucket = Math.floor(ts / (tfMinutes*60*1000));
    if (!buckets[bucket]) buckets[bucket] = { t: bucket*(tfMinutes*60*1000), open: price, high: price, low: price, close: price, vol: 0 };
    buckets[bucket].high = Math.max(buckets[bucket].high, price);
    buckets[bucket].low = Math.min(buckets[bucket].low, price);
    buckets[bucket].close = price;
  }
  return Object.values(buckets).slice(-500);
}

function tfToIntervalStr(tfMinutes) {
  if (tfMinutes === 1) return "1m";
  if (tfMinutes === 3) return "3m";
  if (tfMinutes === 5) return "5m";
  if (tfMinutes === 15) return "15m";
  if (tfMinutes === 30) return "30m";
  if (tfMinutes === 60) return "1h";
  return `${tfMinutes}m`;
}

async function fetchCandlesMulti(tfMinutes=15) {
  const intervalStr = tfToIntervalStr(tfMinutes);
  const binSymbol = process.env.BINANCE_SYMBOL || SYMBOL;
  // try Binance (mirrors) -> Coinbase -> Kraken -> CoinGecko
  try {
    const kl = await fetchKlinesBinance(binSymbol, intervalStr, 500);
    return { data: kl, source: "Binance" };
  } catch (e) { console.warn("binance failed:", e.message); }
  try {
    const granMap = {1:60,3:180,5:300,15:900,30:1800,60:3600};
    const gran = granMap[tfMinutes] || tfMinutes*60;
    const product = process.env.COINBASE_PRODUCT || "BTC-USD";
    const kl = await fetchKlinesCoinbase(product, gran, 500);
    return { data: kl, source: "Coinbase" };
  } catch (e) { console.warn("coinbase failed:", e.message); }
  try {
    const pair = process.env.KRAKEN_PAIR || "XBTUSD";
    const kl = await fetchKlinesKraken(pair, tfMinutes);
    return { data: kl, source: "Kraken" };
  } catch (e) { console.warn("kraken failed", e.message); }
  try {
    const id = process.env.COINGECKO_ID || "bitcoin";
    const kl = await fetchKlinesCoinGecko(id, "usd", tfMinutes);
    return { data: kl, source: "CoinGecko" };
  } catch (e) { console.warn("coingecko failed", e.message); }
  return { data: [], source: "None" };
}

/* ---------- Technical helpers ---------- */

function atrFromCandles(candles, period=14) {
  if (!candles || candles.length < period+1) return null;
  const trs = [];
  for (let i=1;i<candles.length;i++){
    const cur = candles[i], prev = candles[i-1];
    const tr = Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close));
    trs.push(tr);
  }
  const s = trs.slice(-period).reduce((a,b)=>a+b,0);
  return s / Math.max(1, Math.min(trs.length, period));
}
function simpleMACD(closeArr) {
  try {
    if (!closeArr || closeArr.length < 26) return null;
    const macd = MACD.calculate({ values: closeArr, fastPeriod:12, slowPeriod:26, signalPeriod:9, SimpleMAOscillator:false, SimpleMASignal:false });
    return macd.slice(-1)[0] || null;
  } catch(e) { return null; }
}
function simpleRSI(closeArr, period=14) {
  try {
    if (!closeArr || closeArr.length < period+1) return null;
    return RSI.calculate({ values: closeArr, period }).slice(-1)[0] || null;
  } catch(e) { return null; }
}
function detectCandlePatternSingle(last, prev) {
  if (!last) return null;
  const o = last.open, c = last.close, h = last.high, l = last.low;
  const body = Math.abs(c-o);
  const range = h - l || 1;
  const bodyRatio = body / range;
  const lower = Math.min(o,c) - l;
  const upper = h - Math.max(o,c);
  if (lower > body * 2.5 && bodyRatio < 0.4 && upper < body * 0.6) return { name: "Hammer", dir: "bullish" };
  if (upper > body * 2.5 && bodyRatio < 0.4 && lower < body * 0.6) return { name: "Shooting Star", dir: "bearish" };
  if (bodyRatio < 0.12) return { name: "Doji", dir: "neutral" };
  return null;
}

/* ---------- Chart generation (chartjs-node-canvas) ---------- */

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 520;
const chartNode = new ChartJSNodeCanvas({ width: CHART_WIDTH, height: CHART_HEIGHT, backgroundColour: "#0b1220" });

async function generateChartPNG(candles, targets = {}, opts={}) {
  // candles: array of {t, open, high, low, close}
  const labels = candles.map(c => new Date(c.t).toLocaleTimeString());
  const closes = candles.map(c => c.close);
  const opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const datasets = [
    {
      label: "Close",
      data: closes,
      borderColor: "#60a5fa",
      backgroundColor: "rgba(96,165,250,0.08)",
      fill: true,
      pointRadius: 0,
      tension: 0.1,
      yAxisID: 'y'
    }
  ];
  // Add TP/SL horizontal lines as dataset items if provided
  const extras = [];
  if (targets.tp1) extras.push({ label: "TP1", value: Number(targets.tp1) });
  if (targets.tp2) extras.push({ label: "TP2", value: Number(targets.tp2) });
  if (targets.tp3) extras.push({ label: "TP3", value: Number(targets.tp3) });
  if (targets.sl) extras.push({ label: "SL", value: Number(targets.sl) });

  for (const ex of extras) {
    datasets.push({
      label: ex.label,
      data: closes.map(()=>ex.value),
      borderDash: [6,6],
      borderColor: ex.label.startsWith("TP") ? "#22c55e" : "#ef4444",
      pointRadius: 0,
      type: 'line',
      fill: false,
      yAxisID: 'y'
    });
  }

  const config = {
    type: "line",
    data: { labels, datasets },
    options: {
      plugins: { legend: { labels: { color: "#cfe9ff" } } },
      scales: {
        x: { ticks: { color: "#9fb7d6" } },
        y: { ticks: { color: "#9fb7d6" } }
      },
      elements: { line: { borderWidth: 1.5 } },
      layout: { padding: { left: 8, right: 8, top: 8, bottom: 8 } }
    }
  };

  const image = await chartNode.renderToBuffer(config);
  return image;
}

/* ---------- Smart Alert Manager ---------- */

class SmartAlertManager {
  constructor(opts={}) {
    this.lastAlerts = {}; // key -> timestamp
    this.cooldownMs = opts.cooldownMs || 15*60*1000; // default 15 minutes per key
    this.minConfidence = opts.minConfidence || 40; // percent
  }
  canSend(key, confidence) {
    const now = Date.now();
    if (confidence < this.minConfidence) return false;
    const last = this.lastAlerts[key] || 0;
    if (now - last < this.cooldownMs) return false;
    this.lastAlerts[key] = now;
    return true;
  }
}
const alertManager = new SmartAlertManager({ cooldownMs: Number(process.env.ALERT_COOLDOWN_MS || 15*60*1000), minConfidence: Number(process.env.MIN_CONFIDENCE || 40) });

/* ---------- Telegram setup ---------- */

let bot;
async function initBot() {
  if (!BOT_TOKEN) { console.error("BOT_TOKEN missing"); return; }
  bot = new Telegraf(BOT_TOKEN);
  initTelegramCommands(bot, { chatId: CHAT_ID });
  await bot.launch();
  console.log("Telegram bot launched");
}
async function sendTelegramText(text) {
  if (!bot) return console.warn("Bot not init");
  try { await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: "Markdown", disable_web_page_preview: true }); } catch(e){ console.warn("sendTelegramText err", e.message); }
}
async function sendTelegramPhoto(buffer, caption) {
  if (!bot) return console.warn("Bot not init");
  try { await bot.telegram.sendPhoto(CHAT_ID, { source: buffer }, { caption, parse_mode: "Markdown" }); } catch(e){ console.warn("sendTelegramPhoto err", e.message); }
}

/* ---------- Reversal Watcher (improved with SmartAlert & chart) ---------- */

let lastReversalTS = 0;
const REV_COOLDOWN = Number(process.env.REV_COOLDOWN_MS || 90*1000);

async function reversalWatcherOnce() {
  try {
    const tfs = [1,3,5];
    const hits = [];
    for (const tf of tfs) {
      const { data, source } = await fetchCandlesMulti(tf);
      if (!data || data.length < 10) continue;
      const last = data.slice(-1)[0];
      const prev = data.slice(-2,-1)[0];
      const patt = detectCandlePatternSingle(last, prev);
      const closes = data.map(c=>c.close);
      const macd = simpleMACD(closes);
      const rsi = simpleRSI(closes);
      const atr = atrFromCandles(data,14) || 0;
      const volSpike = last.vol > (atr * 1.2);
      let conf = 0;
      if (patt) conf += 40;
      if (volSpike) conf += 20;
      if (macd && macd.histogram && Math.abs(macd.histogram) > 0) conf += 15;
      if (rsi && (rsi < 30 || rsi > 70)) conf += 15;
      hits.push({ tf, last, patt, macd, rsi, atr, volSpike, conf, source });
    }
    // Compose best hit
    const best = hits.sort((a,b)=>b.conf - a.conf)[0];
    if (!best) return;
    // need minimum confidence
    if (best.conf < 45) return;
    // global cooldown
    if (Date.now() - lastReversalTS < REV_COOLDOWN) return;
    // Smart alert dedupe by pattern+tf
    const key = `rev:${best.patt?best.patt.name:"none"}:${best.tf}`;
    if (!alertManager.canSend(key, best.conf)) return;
    lastReversalTS = Date.now();
    // build message
    const prob = ml.predictSimple({ last: best.last, prevClose: best.prevClose, rsi: best.rsi, macd: best.macd, atr: best.atr, vol: best.last.vol });
    const caption = [
      `🚨 *Reversal Watcher (v9.2)*`,
      `Symbol: *${SYMBOL}*`,
      `TF: ${best.tf}m | Pattern: ${best.patt ? best.patt.name : "none"} | Dir: ${best.patt?best.patt.dir:"N/A"}`,
      `Source: ${best.source}`,
      `Price: ${best.last.close.toFixed(2)} | Vol:${Math.round(best.last.vol)}`,
      `ATR:${best.atr.toFixed(2)} | Conf:${best.conf}%`,
      `ML Prob: ${prob.toFixed(1)}%`
    ].join("\n");
    // chart for last 120 candles at TF
    const chartBuf = await generateChartPNG( (await fetchCandlesMulti(best.tf)).data.slice(-120) , { tp1: null } );
    await sendTelegramPhoto(chartBuf, caption);
  } catch (e) {
    console.warn("reversalWatcherOnce err", e.message || e);
  }
}

/* ---------- Main report (image + text) ---------- */

async function analyzeAndReport() {
  try {
    const tfs = [1,5,15,30,60];
    const results = [];
    for (const tf of tfs) {
      const { data, source } = await fetchCandlesMulti(tf);
      if (!data || data.length < 10) { results.push({ tf, ok:false, source }); continue; }
      const closes = data.map(c=>c.close);
      const macd = simpleMACD(closes);
      const rsi = simpleRSI(closes);
      const atr = atrFromCandles(data,14);
      const last = data.slice(-1)[0];
      const prevAvg = data.slice(-4,-1).reduce((s,c)=>s+c.close,0)/3;
      const delta = (last.close - prevAvg)/prevAvg*100;
      const direction = delta > 0.2 ? "Uptrend" : delta < -0.2 ? "Downtrend" : "Flat";
      results.push({ tf, ok:true, last, macd, rsi, atr, delta: delta.toFixed(2), direction, source, candles: data });
    }
    // Primary: 15m
    const res15 = results.find(r=>r.tf===15 && r.ok);
    if (!res15) {
      await sendTelegramText(`❗ Not enough 15m data to report (${new Date().toLocaleString()})`);
      return;
    }
    const lastPrice = res15.last.close;
    const atr15 = res15.atr || 0;
    const mlProb = ml.predictFromCandles(res15.candles);
    const bias = mlProb > 0.6 ? "Bullish" : mlProb < 0.4 ? "Bearish" : "Neutral";
    const confidence = Math.round(Math.abs(mlProb - 0.5) * 200);

    // Hybrid targets (ATR + simple fib multipliers)
    const tp1 = lastPrice + atr15*1.0;
    const tp2 = lastPrice + atr15*1.618;
    const tp3 = lastPrice + atr15*2.618;
    const sl = lastPrice - atr15*1.0;

    const headlines = await (async ()=>{
      try {
        const r = await ax.get("https://www.coindesk.com/arc/outboundfeeds/rss/");
        const txt = r.data;
        const matches = [...txt.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].slice(1);
        return matches.map(m=>m[1]).slice(0,6);
      } catch(e) { return ["No headlines"]; }
    })();

    // build text
    const lines = [];
    lines.push(`🤖 *${SYMBOL} — AI Trader v9.2 (Extended)*`);
    lines.push(`🕒 ${new Date().toLocaleString()}`);
    results.forEach(r=>{
      if (!r.ok) lines.push(`⏱ ${r.tf}m: No data (src:${r.source})`);
      else lines.push(`⏱ ${r.tf}m: ${r.direction} | ΔP ${r.delta}% | ATR:${(r.atr||0).toFixed(2)} | src:${r.source}`);
    });
    lines.push("");
    lines.push(`🎯 Targets: TP1 ${tp1.toFixed(2)} | TP2 ${tp2.toFixed(2)} | TP3 ${tp3.toFixed(2)} | SL ${sl.toFixed(2)}`);
    lines.push(`🧠 Bias: *${bias}* | Confidence: ${confidence}% | ML Prob: ${(mlProb*100).toFixed(1)}%`);
    lines.push(`💰 Last Price: ${lastPrice.toFixed(2)} | ATR(15m): ${atr15.toFixed(2)}`);
    lines.push(`📰 Headlines Impact: ${headlines.slice(0,3).join(" // ")}`);
    const text = lines.join("\n");

    // Chart (150 candles of 15m)
    const chartBuf = await generateChartPNG(res15.candles.slice(-150), { tp1, tp2, tp3, sl });
    await sendTelegramPhoto(chartBuf, text);

  } catch (e) {
    console.error("analyzeAndReport err", e.message || e);
    try { await sendTelegramText(`Error in report: ${e.message}`); } catch(e2){}
  }
}

/* ---------- Scheduling ---------- */

function msUntilNextInterval(intervalMin) {
  const now = new Date();
  const ms = now.getTime();
  const minutes = now.getUTCMinutes();
  const remainder = minutes % intervalMin;
  const next = new Date(now);
  next.setUTCMinutes(minutes - remainder + intervalMin, 0, 0);
  return next.getTime() - ms;
}

async function startAll() {
  ml.initModel();
  await initBot();
  // Align first report to interval boundary
  const delay = msUntilNextInterval(REPORT_INTERVAL_MIN);
  console.log("First report in (ms):", delay);
  setTimeout(()=>{
    analyzeAndReport();
    setInterval(() => analyzeAndReport(), REPORT_INTERVAL_MIN * 60 * 1000);
  }, delay);

  // reversal watcher fast loop
  setInterval(reversalWatcherOnce, REV_CHECK_INTERVAL_SEC * 1000);

  app.listen(PORT, ()=> console.log(`AI Trader v9.2 listening on ${PORT}`));
}

startAll().catch(e=>console.error("startAll failed", e.message || e));