/**
 * part1_aiTrader_v8_7.js
 * AI Trader v8.7 — core pipeline + scheduler + Telegram + self-ping
 *
 * Expects part2_ml_module_v8_7.js in same folder (exports ML functions)
 *
 * Run: node part1_aiTrader_v8_7.js
 */

import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

import {
  
  predictProb,
  onlineTrain,
  adjustAutoThreshold,
 
} from "./part2_ml_module_v8_7.js";

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_MODEL_PATH = process.env.ML_MODEL_PATH || "./ml_model.json";
const PROXIES = (process.env.PROXIES || "").split(",").filter(Boolean);
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("BOT_TOKEN or CHAT_ID missing in .env");
  process.exit(1);
}

// ---------- Utilities ----------
const nowStr = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

async function sendTG(text, options = {}) {
  const payload = { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 10000
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn("Telegram send failed:", res.status, body.slice(0,200));
    }
  } catch (err) {
    console.warn("Telegram send error:", err.message);
  }
}

// Proxy fetch helper (tries direct first then proxies)
async function fetchWithFallback(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    console.warn("Direct fetch failed:", r.status);
  } catch (e) {
    // ignore
  }
  for (const proxy of PROXIES) {
    try {
      const proxyUrl = proxy + encodeURIComponent(url);
      const r = await fetch(proxyUrl, opts);
      if (r.ok) return r;
    } catch (e) {
      // try next
    }
  }
  throw new Error("All fetch attempts failed for: " + url);
}

// ---------- Market data ----------
async function fetchKlines(symbol, interval = "15m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithFallback(url);
  const j = await r.json();
  return j.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

// ---------- News & Social ----------
async function fetchCoinDeskHeadlines(limit = 6) {
  try {
    const url = `https://www.coindesk.com/arc/outboundfeeds/rss/`;
    const r = await fetchWithFallback("https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url));
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, 1 + limit);
    return items.map(it => {
      const t = (it.match(/<title>(.*?)<\/title>/i) || [,""])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    });
  } catch (e) {
    return [];
  }
}

async function fetchRedditTitles(sub = "Bitcoin", limit = 6) {
  try {
    const r = await fetchWithFallback(`https://www.reddit.com/r/${sub}/new.json?limit=${limit}`);
    const j = await r.json();
    return (j.data?.children || []).map(c => c.data.title || "");
  } catch (e) {
    return [];
  }
}

// ---------- Analysis helpers ----------
function calcATR(klines, period = 14) {
  if (klines.length <= period) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const cur = klines[i], prev = klines[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function detectDojiHammer(candle) {
  // simple heuristics
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low || 1;
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  const bodyPct = body / range;
  // doji: tiny body
  const isDoji = bodyPct < 0.15;
  // hammer: small body, long lower wick
  const isHammer = bodyPct < 0.35 && lower > (range * 0.6) && upper < (range * 0.2);
  // shooting star: small body, long upper wick
  const isShootingStar = bodyPct < 0.35 && upper > (range * 0.6) && lower < (range * 0.2);
  return { isDoji, isHammer, isShootingStar };
}

function simpleSlope(klines) {
  const n = klines.length;
  if (n < 3) return 0;
  const first = klines[0].close;
  const last = klines[n - 1].close;
  return (last - first) / first;
}

// detect high volume spike vs previous average
function volumeSpike(klines, lookback = 10, multiplier = 2) {
  const arr = klines.slice(- (lookback + 1));
  if (arr.length <= 1) return false;
  const last = arr[arr.length - 1].volume;
  const hist = arr.slice(0, -1).map(x => x.volume);
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  return avg > 0 && (last / avg) >= multiplier;
}

function computeTechVolume(klines) {
  // buy vol vs sell vol by candle direction
  let buy = 0, sell = 0;
  for (const k of klines) {
    if (k.close >= k.open) buy += k.volume;
    else sell += k.volume;
  }
  const tot = buy + sell || 1;
  return { buyPct: (buy / tot)*100, sellPct: (sell / tot)*100, bias: buy > sell ? "Bullish" : buy < sell ? "Bearish" : "Neutral" };
}

// Generate targets (TP1/2/3 and SL) based on ATR
function genTargets(lastPrice, atrVal, bias) {
  if (!atrVal) {
    const gap = lastPrice * 0.005;
    return {
      tp1: (lastPrice + (bias === "Bullish" ? gap : -gap)).toFixed(2),
      tp2: (lastPrice + (bias === "Bullish" ? gap*2 : -gap*2)).toFixed(2),
      tp3: (lastPrice + (bias === "Bullish" ? gap*3 : -gap*3)).toFixed(2),
      sl: (lastPrice + (bias === "Bullish" ? -gap : gap)).toFixed(2),
      breakoutLow: (lastPrice - gap*1.5).toFixed(2),
      breakoutHigh: (lastPrice + gap*1.5).toFixed(2)
    };
  }
  const gap = atrVal;
  return {
    tp1: (lastPrice + (bias === "Bullish" ? gap : -gap)).toFixed(2),
    tp2: (lastPrice + (bias === "Bullish" ? gap*1.8 : -gap*1.8)).toFixed(2),
    tp3: (lastPrice + (bias === "Bullish" ? gap*3 : -gap*3)).toFixed(2),
    sl: (lastPrice + (bias === "Bullish" ? -gap*0.8 : gap*0.8)).toFixed(2),
    breakoutLow: (lastPrice - gap*1.5).toFixed(2),
    breakoutHigh: (lastPrice + gap*1.5).toFixed(2)
  };
}

// ---------- ML / Model integration ----------
await loadModelSafe(ML_MODEL_PATH); // ensures model exists (creates default if not)
initModel(ML_MODEL_PATH); // initialize if needed

// ---------- Main report (multi-TF 15min primary) ----------
async function produceReport() {
  try {
    const TFs = ["1m","5m","15m","30m","1h"];
    const perTF = {};
    let lastPrice = null;

    for (const tf of TFs) {
      const kl = await fetchKlines(SYMBOL, tf, 80).catch(e => {
        console.warn("Fetch failed for", tf, e.message);
        return [];
      });
      if (!kl || kl.length === 0) {
        perTF[tf] = { error: true, tf };
        continue;
      }
      lastPrice = kl[kl.length - 1].close;
      const slope = simpleSlope(kl.slice(-20));
      const atr = calcATR(kl, 14);
      const volSpike = volumeSpike(kl, 12, 2.2);
      const cand = kl[kl.length - 1];
      const { isDoji, isHammer, isShootingStar } = detectDojiHammer(cand);
      const tech = computeTechVolume(kl.slice(-30));
      // divergence simple: last close vs prev close and volume delta
      const prev = kl[kl.length - 2];
      const dp = ((cand.close - prev.close) / prev.close) * 100;
      const dv = ((cand.volume - prev.volume) / (prev.volume || 1)) * 100;
      let signal = "Neutral";
      if (dp > 0 && dv < 0) signal = "Bearish Divergence";
      if (dp < 0 && dv > 0) signal = "Bullish Divergence";

      perTF[tf] = { tf, slope, atr, volSpike, cand, isDoji, isHammer, isShootingStar, tech, dp, dv, signal };
    }

    // News + Reddit
    const headlines = await fetchCoinDeskHeadlines(6).catch(()=>[]);
    const redditTitles = await fetchRedditTitles("Bitcoin", 6).catch(()=>[]);

    // Features for ML: use primary TF = 15m
    const primary = perTF["15m"];
    if (!primary || primary.error) {
      console.warn("No primary TF data");
    }
    const features = {
      techDiff: ((primary?.tech?.buyPct || 50) - (primary?.tech?.sellPct || 50)) / 100, // -1..1
      newsScore: headlines.join(" ").length > 10 ? 1 : 0, // simple binary (we could parse sentiment)
      redditScore: redditTitles.join(" ").length > 10 ? 1 : 0,
      volSpike: primary?.volSpike ? 1 : 0,
      dojiHammer: (primary?.isDoji || primary?.isHammer || primary?.isShootingStar) ? 1 : 0,
      slope: primary?.slope || 0
    };

    // Predict ML probability
    const mlProb = predictProb(features); // 0..1
    // Auto threshold / tuning based on historical performance
    const threshold = adjustAutoThreshold(); // returns current threshold (0..1)
    const mlTrigger = mlProb >= threshold;

    // Derive overall bias (blend of tech + ml)
    const techBias = (primary?.tech?.bias) || "Neutral";
    // auto-bias: if ml strong, follow ml; else follow tech
    let overallBias = techBias;
    if (mlProb > 0.6) overallBias = (mlProb > 0.6) ? "Bullish" : overallBias;
    if (mlProb < 0.4) overallBias = (mlProb < 0.4) ? "Bearish" : overallBias;

    // Targets using ATR from primary
    const last = primary?.cand?.close || lastPrice || 0;
    const atrVal = primary?.atr || calcATR(perTF["15m"]?.cand ? [perTF["15m"].cand] : [], 14) || null;
    const targets = genTargets(last, atrVal, overallBias);

    // Build message
    let msg = `<b>🤖 ${SYMBOL} — AI Trader v8.7</b>\n`;
    msg += `<i>${nowStr()}</i>\n\n`;

    for (const tf of ["1m","5m","15m","30m","1h"]) {
      const p = perTF[tf];
      if (!p || p.error) { msg += `⏱ ${tf}: No data\n`; continue; }
      msg += `⏱ ${tf} | ${p.signal} | ΔP ${p.dp.toFixed(2)}% | ΔV ${p.dv.toFixed(2)}% | Trend: ${p.slope>0? "Uptrend" : p.slope<0? "Downtrend" : "Flat"}\n`;
      msg += `E: doji:${p.isDoji?1:0} hammer:${p.isHammer?1:0} spikeVol:${p.volSpike?1:0}\n\n`;
    }

    msg += `🎯 Targets:\nTP1: ${targets.tp1} | TP2: ${targets.tp2} | TP3: ${targets.tp3}\nSL: ${targets.sl}\n`;
    msg += `📊 Breakout Range: ${targets.breakoutLow} - ${targets.breakoutHigh}\n\n`;

    msg += `🧠 Overall Bias: ${overallBias} | Confidence(ML): ${(mlProb*100).toFixed(1)}% (threshold ${(threshold*100).toFixed(0)}%)\n`;
    msg += `💰 Last Price: ${last}\n`;
    msg += `📈 Tech Vol: Buy ${(primary?.tech?.buyPct||0).toFixed(2)}% / Sell ${(primary?.tech?.sellPct||0).toFixed(2)}%\n`;
    msg += `⚙️ ATR(14): ${atrVal ? atrVal.toFixed(2) : "N/A"}\n\n`;

    msg += `📰 Headlines:\n`;
    if (headlines.length) msg += headlines.map(h => `• ${h}`).join("\n");
    else msg += "• No recent headlines\n";
    msg += `\n\n🤖 ML Smart Prob: ${(mlProb*100).toFixed(1)}% (threshold ${(threshold*100).toFixed(0)}%)\n`;

    // If ML trigger — send smart alert chunk
    if (mlTrigger) {
      msg += `\n🔔 <b>Smart Alert</b>: ML prob ${ (mlProb*100).toFixed(1) }% ≥ threshold ${(threshold*100).toFixed(0)}%\n`;
    }

    await sendTG(msg);
    return { ok: true, mlProb };
  } catch (err) {
    console.error("produceReport error:", err.message);
    await sendTG(`<b>⚠️ AI Trader error</b>\n${err.message}`);
    return { ok:false };
  }
}

// ---------- Reversal watcher (1m, standalone, alert anytime) ----------
let lastRevSentAt = 0;
async function reversalWatcher() {
  try {
    const kl = await fetchKlines(SYMBOL, "1m", 30);
    if (!kl || kl.length < 3) return;
    const last = kl[kl.length - 1], prev = kl[kl.length - 2];
    const candInfo = detectDojiHammer(last);
    const volSpikeFlag = volumeSpike(kl, 12, 2.5);
    const slopeShort = simpleSlope(kl.slice(-8));
    // signal rules
    if ((candInfo.isHammer || candInfo.isShootingStar || candInfo.isDoji) && volSpikeFlag) {
      const now = Date.now();
      // cooldown 60s to avoid spam
      if (now - lastRevSentAt < 60 * 1000) return;
      lastRevSentAt = now;
      const prob = predictProb({
        techDiff: 0, newsScore: 0, redditScore: 0,
        volSpike: volSpikeFlag?1:0, dojiHammer: candInfo.isDoji||candInfo.isHammer||candInfo.isShootingStar?1:0, slope: slopeShort
      });
      const text = `<b>🔎 Reversal Watcher</b>\n${nowStr()}\nPattern: ${candInfo.isHammer?"Hammer":candInfo.isShootingStar?"ShootingStar":"Doji"}\nVol spike: ${volSpikeFlag}\nML Prob: ${(prob*100).toFixed(1)}%\nPrice: ${last.close}`;
      await sendTG(text);
      // optionally train the model lightly using this sample as weak positive
      onlineTrain({ techDiff:0, newsScore:0, redditScore:0, volSpike:volSpikeFlag?1:0, dojiHammer:1, slope:slopeShort }, prob > 0.6 ? 1 : 0);
    }
  } catch (e) { console.warn("reversalWatcher err", e.message); }
}

// ---------- Periodic scheduling ----------
async function startSchedulers() {
  // main report every CHECK_INTERVAL_MIN minutes
  await produceReport();
  setInterval(produceReport, CHECK_INTERVAL_MIN * 60 * 1000);

  // reversal watcher every REV_CHECK_INTERVAL_SEC seconds
  setInterval(reversalWatcher, REV_CHECK_INTERVAL_SEC * 1000);

  // save model periodically
  setInterval(() => saveModelSafe(ML_MODEL_PATH), 2 * 60 * 1000);
}

// ---------- Self-ping & HTTP server ----------
const app = express();
app.get("/", (req, res) => res.send("AI Trader v8.7 running"));
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});

// Self-ping (prevent free hosts from sleeping)
setInterval(async () => {
  try {
    const pingUrl = process.env.SELF_PING_URL;
    if (pingUrl) await fetch(pingUrl).catch(()=>{});
  } catch (e) {}
}, 4 * 60 * 1000);

// start
startSchedulers().catch(e => console.error(e));
/**
 * part2_ml_module_v8_7.js
 * ML helpers: tiny online logistic regression + persistence + auto-threshold tuning
 *
 * Exports:
 *  - initModel(modelPath)
 *  - predictProb(features)
 *  - onlineTrain(features, label)
 *  - adjustAutoThreshold() -> current threshold
 *  - loadModelSafe(path), saveModelSafe(path)
 */

import fs from "fs/promises";

let MODEL = null;
let MODEL_PATH = "./ml_model.json";

export function defaultModel() {
  return {
    version: "v1",
    weights: { bias: 0, techDiff: 0, newsScore: 0, redditScore: 0, volSpike: 0, dojiHammer: 0, slope: 0 },
    lr: 0.05,
    history: [], // store last outcomes for threshold tuning: {pred, label, time}
    threshold: 0.7,
    meta: { created: Date.now() }
  };
}

export async function loadModelSafe(path = MODEL_PATH) {
  MODEL_PATH = path;
  try {
    const txt = await fs.readFile(path, "utf8");
    MODEL = JSON.parse(txt);
    console.log("Loaded ML model:", path);
  } catch (e) {
    MODEL = defaultModel();
    await saveModelSafe(path);
    console.log("Created default ML model at", path);
  }
  return MODEL;
}

export async function saveModelSafe(path = MODEL_PATH) {
  try {
    await fs.writeFile(path, JSON.stringify(MODEL, null, 2), "utf8");
  } catch (e) {
    console.warn("saveModel failed:", e.message);
  }
}

export function initModel(path = MODEL_PATH) {
  MODEL_PATH = path;
  if (!MODEL) MODEL = defaultModel();
  return MODEL;
}

// logistic sigmoid
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// normalize features (simple)
function norm(x) {
  if (!isFinite(x)) return 0;
  // clamp
  if (x > 10) return 10;
  if (x < -10) return -10;
  return x;
}

// predict probability from features object
export function predictProb(features = {}) {
  if (!MODEL) initModel();
  const w = MODEL.weights;
  let s = w.bias;
  s += (w.techDiff || 0) * norm(features.techDiff || 0);
  s += (w.newsScore || 0) * norm(features.newsScore || 0);
  s += (w.redditScore || 0) * norm(features.redditScore || 0);
  s += (w.volSpike || 0) * norm(features.volSpike || 0);
  s += (w.dojiHammer || 0) * norm(features.dojiHammer || 0);
  s += (w.slope || 0) * norm(features.slope || 0);
  const p = sigmoid(s);
  return p;
}

// online update (label is 0 or 1)
export function onlineTrain(features = {}, label = 0) {
  if (!MODEL) initModel();
  const pred = predictProb(features);
  const error = label - pred;
  const lr = MODEL.lr || 0.03;
  // gradient for logistic: error * x
  MODEL.weights.bias += lr * error * 1;
  MODEL.weights.techDiff += lr * error * (features.techDiff || 0);
  MODEL.weights.newsScore += lr * error * (features.newsScore || 0);
  MODEL.weights.redditScore += lr * error * (features.redditScore || 0);
  MODEL.weights.volSpike += lr * error * (features.volSpike || 0);
  MODEL.weights.dojiHammer += lr * error * (features.dojiHammer || 0);
  MODEL.weights.slope += lr * error * (features.slope || 0);

  // store history sample
  MODEL.history.push({ t: Date.now(), pred, label });
  if (MODEL.history.length > 500) MODEL.history.shift();

  // periodically adjust threshold if needed
  if (MODEL.history.length % 50 === 0) {
    autoTuneThreshold();
  }
}

// compute best threshold to hit target precision using history
function autoTuneThreshold(targetPrecision = 0.6) {
  if (!MODEL || !MODEL.history || MODEL.history.length < 30) return MODEL.threshold;
  const hist = MODEL.history;
  // brute-force thresholds 0.3..0.95 step 0.01
  let best = MODEL.threshold, bestScore = 0;
  for (let t = 0.3; t <= 0.95; t += 0.01) {
    const preds = hist.filter(h => h.pred >= t);
    const tp = preds.filter(p => p.label === 1).length;
    const prec = preds.length ? tp / preds.length : 0;
    // prefer precision near target and reasonable coverage
    const coverage = preds.length / hist.length;
    const score = (prec >= targetPrecision ? 1 : prec / targetPrecision) * (0.6 * prec + 0.4 * coverage);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  MODEL.threshold = best;
  return best;
}

// wrapper to expose threshold adjust (called externally each report)
export function adjustAutoThreshold() {
  if (!MODEL) initModel();
  // if enough history, run tuning
  if (MODEL.history.length > 80) autoTuneThreshold(0.7);
  return MODEL.threshold;
}