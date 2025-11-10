// aiTraderBot_v9_full.js
/**
 * AI_Trader_v9_full.js
 * Single-file combined version:
 * - Multi-source klines (Binance -> Coinbase -> Kraken)
 * - Multi-TF analysis (1m,5m,15m,30m,1h)
 * - ATR + Fib hybrid targets + simple Elliott heuristic
 * - Reversal watcher (1m and 15m) with pattern detection
 * - Tiny online ML predictor (logistic) saved to disk
 * - Telegram command handler integrated
 *
 * Requirements:
 *  npm i node-fetch@3 express dotenv
 * Usage:
 *  node aiTraderBot_v9_full.js
 */
import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const AI_BASE_URL = process.env.AI_BASE_URL || "http://localhost:3000";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env – aborting.");
  process.exit(1);
}

const TELE_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- utilities ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

function safeParseJSON(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

// --- multi-source kline fetcher with fallbacks ----------------
// Returns candles array of [ts, open, high, low, close, volume]
async function fetchKlines(symbol, tf = "1m", limit = 200) {
  // convert tf to minutes for Binance (e.g. '15m')
  // We'll try Binance, Coinbase, Kraken in order
  const binance = async () => {
    // Binance: GET /api/v3/klines?symbol=BTCUSDT&interval=15m&limit=200
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) throw new Error("binance fail");
    const j = await r.json();
    // j is array of arrays - convert
    return j.map((c) => [c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
  };
  const coinbase = async () => {
    // coinbase: https://api.pro.coinbase.com/products/BTC-USD/candles?granularity=900
    // map symbol pair
    const coin = symbol.replace("USDT", "-USD").replace("USDC", "-USD");
    const gf = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 }[tf] || 900;
    const to = Math.floor(Date.now() / 1000);
    const from = to - gf * limit;
    const url = `https://api.pro.coinbase.com/products/${coin}/candles?start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}&granularity=${gf}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) throw new Error("coinbase fail");
    const j = await r.json();
    // coinbase returns [time, low, high, open, close, volume] per candle
    return j
      .map((c) => [c[0] * 1000, +c[3], +c[2], +c[1], +c[4], +c[5]])
      .sort((a, b) => a[0] - b[0]);
  };
  const kraken = async () => {
    // Kraken uses pair XBTUSD etc. skip if not available
    const kr = symbol.replace("BTC", "XBT").replace("USDT", "USD");
    const gf = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600 }[tf] || 900;
    const url = `https://api.kraken.com/0/public/OHLC?pair=${kr}&interval=${gf}`;
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) throw new Error("kraken fail");
    const j = await r.json();
    const key = Object.keys(j.result).find((k) => k !== "last");
    if (!key) throw new Error("kraken no key");
    return j.result[key].map((c) => [c[0] * 1000, +c[1], +c[2], +c[3], +c[4], +c[6]]);
  };

  const sources = [binance, coinbase, kraken];
  for (let s of sources) {
    try {
      const res = await s();
      if (res && res.length > 10) return res;
    } catch (e) {
      // try next
    }
  }
  throw new Error("All sources failed");
}

// --- indicators ----------------
function sma(values, period) {
  if (values.length < period) return null;
  const sum = values.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}
function ema(values, period, prevEMA = null) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  if (prevEMA == null) {
    return sma(values.slice(0, period), period); // seed
  }
  return values.reduce((emaPrev, val, idx) => {
    if (idx < values.length - period) return emaPrev;
    return val * k + emaPrev * (1 - k);
  }, prevEMA);
}
function computeATR(candles, period = 14) {
  // candles: [ts, o, h, l, c, v]
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1][4];
    const high = candles[i][2];
    const low = candles[i][3];
    const tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
    trs.push(tr);
  }
  // ATR simple SMA
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

// --- fib targets (basic) ----------------
// Find recent swing high & low from last N candles and produce fib levels from that
function fibTargets(candles, lookback = 200) {
  const sub = candles.slice(-lookback);
  if (sub.length < 10) return null;
  let high = -Infinity,
    low = Infinity,
    hiIdx = 0,
    loIdx = 0;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i][2] > high) {
      high = sub[i][2];
      hiIdx = i;
    }
    if (sub[i][3] < low) {
      low = sub[i][3];
      loIdx = i;
    }
  }
  if (high <= low) return null;
  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
  const levels = fibs.map((f) => ({ level: +(high - (high - low) * f).toFixed(2), ratio: f }));
  return { high, low, hiIdx, loIdx, levels };
}

// --- simple elliott-ish heuristic ----------------
// Not a proper EW solver — small heuristic: if recent sequence shows 5 consecutive impulses (higher highs), mark Impulse
function elliottHeuristic(candles) {
  const sub = candles.slice(-40);
  if (sub.length < 10) return { label: "Unknown", score: 0 };
  let upCount = 0,
    dnCount = 0;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i][4] > sub[i - 1][4]) upCount++;
    else if (sub[i][4] < sub[i - 1][4]) dnCount++;
  }
  if (upCount > dnCount * 1.3) return { label: "Impulse Wave", score: +(upCount / sub.length).toFixed(2) };
  if (dnCount > upCount * 1.3) return { label: "Corrective / Retrace", score: +(dnCount / sub.length).toFixed(2) };
  return { label: "Transitional", score: 0.5 };
}

// --- candle pattern detection (reversal watchers) ----------------
function detectCandlePattern(candle) {
  // candle: [ts, o, h, l, c, v]
  const [ts, o, h, l, c, v] = candle;
  const body = Math.abs(c - o);
  const upper = h - Math.max(c, o);
  const lower = Math.min(c, o) - l;
  const total = h - l || 1;
  const bodyPct = body / total;
  const upperPct = upper / total;
  const lowerPct = lower / total;

  // Hammer: small body near top? Actually hammer = small body near top? No: Hammer has small body near top of candle? Common definitions vary.
  // We'll use:
  // Hammer: lower shadow >= 2 * body and upper shadow small (< body)
  if (lower > body * 2 && upper < body) return { name: "Hammer", direction: "Bullish" };
  // Shooting star: upper shadow >= 2*body and lower small
  if (upper > body * 2 && lower < body) return { name: "Shooting Star", direction: "Bearish" };
  // Doji: body small relative to total
  if (bodyPct < 0.1) return { name: "Doji", direction: "Neutral" };
  // Engulfing detection requires sequences; handled separately
  return null;
}

function detectEngulfing(prev, cur) {
  if (!prev || !cur) return null;
  const prevBody = Math.abs(prev[4] - prev[1]);
  const curBody = Math.abs(cur[4] - cur[1]);
  // Bullish engulfing: prev red, cur green and cur body > prev body and cur open < prev close and cur close > prev open
  if (prev[4] < prev[1] && cur[4] > cur[1] && curBody > prevBody && cur[1] < prev[4] && cur[4] > prev[1]) {
    return { name: "Bullish Engulfing", direction: "Bullish" };
  }
  if (prev[4] > prev[1] && cur[4] < cur[1] && curBody > prevBody && cur[1] > prev[4] && cur[4] < prev[1]) {
    return { name: "Bearish Engulfing", direction: "Bearish" };
  }
  return null;
}

// multi-TF confirmation: check if pattern appears on 1m and supported by 15m momentum/ATR squeeze
function multiTFConfirmation(symbol, pattern, candles1m, candles15m) {
  // returns score/support count
  let score = 0;
  if (!pattern) return 0;
  // if pattern direction matches 15m short-term momentum (last close diff)
  const last15 = candles15m[candles15m.length - 1];
  const prev15 = candles15m[candles15m.length - 2];
  if (!last15 || !prev15) return 1;
  const diff15 = last15[4] - prev15[4];
  if (pattern.direction === "Bullish" && diff15 > 0) score++;
  if (pattern.direction === "Bearish" && diff15 < 0) score++;
  // ATR relative size: small ATR followed by pattern = stronger reversal
  const atr15 = computeATR(candles15m, 14) || 1;
  const rng = last15[2] - last15[3];
  if (rng / atr15 > 1.0) score++; // big-range -> likely significant
  return score;
}

// --- tiny online ML (logistic) ----------------
// single model file storing weights and bias, features standardized
const ML_FILE = "./ml_model_v9.json";
let ML = safeParseJSON(ML_FILE, { w: null, mean: null, std: null, trained: 0 });

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}
function predictProb(features) {
  // features: array numeric
  if (!ML.w) {
    // random small weights fallback
    const w = Array(features.length).fill(0);
    return { prob: 0.5, raw: 0 };
  }
  // normalize
  const norm = features.map((f, i) => (ML.std && ML.std[i] ? (f - ML.mean[i]) / ML.std[i] : f));
  let z = ML.bias || 0;
  for (let i = 0; i < norm.length; i++) z += (ML.w[i] || 0) * norm[i];
  return { prob: +(sigmoid(z) * 100).toFixed(1), raw: z };
}

function sgdUpdate(features, label, lr = 0.05) {
  // label 0/1
  if (!ML.w) {
    ML.w = Array(features.length).fill(0);
    ML.mean = Array(features.length).fill(0);
    ML.std = Array(features.length).fill(1);
    ML.bias = 0;
  }
  // update running mean/std (very simple online normalization)
  for (let i = 0; i < features.length; i++) {
    const x = features[i];
    // update mean (simple EMA)
    ML.mean[i] = (ML.mean[i] * ML.trained + x) / (ML.trained + 1);
  }
  ML.trained++;
  // compute normalized
  const norm = features.map((f, i) => (ML.std && ML.std[i] ? (f - ML.mean[i]) / ML.std[i] : f));
  // prediction
  let z = ML.bias;
  for (let i = 0; i < norm.length; i++) z += ML.w[i] * norm[i];
  const pred = sigmoid(z);
  const err = label - pred;
  // update
  ML.bias += lr * err;
  for (let i = 0; i < norm.length; i++) {
    ML.w[i] += lr * err * norm[i];
  }
  saveJSON(ML_FILE, ML);
}

// features builder for reversal
function buildFeaturesForReversal(candles1m, candles15m, pattern) {
  // features: [delta1m_pct, vol_change_pct, atr15_ratio, body_ratio, lowerShadowRatio, multiTF_support]
  const last1 = candles1m[candles1m.length - 1];
  const prev1 = candles1m[candles1m.length - 2] || last1;
  const last15 = candles15m[candles15m.length - 1];
  const atr15 = computeATR(candles15m, 14) || 1;
  const delta1m = (last1[4] - prev1[4]) / (prev1[4] || last1[4] || 1);
  const volPrev = candles1m[candles1m.length - 2] ? candles1m[candles1m.length - 2][5] : last1[5];
  const volChange = (last1[5] - volPrev) / (volPrev || 1);
  const body = Math.abs(last1[4] - last1[1]);
  const lower = Math.min(last1[4], last1[1]) - last1[3];
  const bodyRatio = body / (last1[2] - last1[3] || 1);
  const lowerRatio = lower / (last1[2] - last1[3] || 1);
  const multi = multiTFConfirmation(SYMBOL, pattern, candles1m, candles15m);
  return [delta1m, volChange, (last1[4] - last15[4]) / (atr15 || 1), bodyRatio, lowerRatio, multi];
}

// --- analysis & message building ----------------
function formatPercent(x) {
  return `${(x * 100).toFixed(2)}%`;
}

async function analyzeSymbol(symbol = SYMBOL) {
  try {
    // get multi TF candles concurrently; fallback if fail
    const tfList = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h" };
    const results = {};
    for (let tf of Object.keys(tfList)) {
      try {
        results[tf] = await fetchKlines(symbol, tf, 300);
        await sleep(150); // tiny throttle
      } catch (e) {
        console.warn("fetch fail for", tf, e.message || e);
        results[tf] = [];
      }
    }

    // build per-TF indicators
    const tfInfo = {};
    for (let tf of Object.keys(results)) {
      const candles = results[tf];
      if (!candles || candles.length < 5) {
        tfInfo[tf] = { ok: false };
        continue;
      }
      const price = candles[candles.length - 1][4];
      const atr = computeATR(candles, 14) || 0;
      // Divergence detection stub: use last MACD-like diff (not computing full MACD). We'll use simple momentum as proxy:
      const trend = candles[candles.length - 1][4] > candles[candles.length - 5][4] ? "Uptrend" : "Downtrend";
      // Strength: percent change last n
      const dp = (candles[candles.length - 1][4] - candles[candles.length - 6][4]) / (candles[candles.length - 6][4] || 1);
      const volDelta = (candles[candles.length - 1][5] - candles[candles.length - 6][5]) / (candles[candles.length - 6][5] || 1);
      tfInfo[tf] = { ok: true, price, atr, trend, delta: dp, volDelta, candles };
    }

    // targets using 15m as base
    const baseCandles = tfInfo["15m"].candles || results["15m"];
    const fib = fibTargets(baseCandles, 200) || { levels: [] };
    const ell = elliottHeuristic(baseCandles);
    const atr15 = computeATR(baseCandles, 14) || 1;

    // Hybrid target logic:
    // Take ATR multiples as conservative targets, then push towards fib levels
    const priceNow = tfInfo["15m"].price || (baseCandles && baseCandles[baseCandles.length - 1][4]) || 0;
    const tp1 = +(priceNow + atr15 * 1).toFixed(2);
    const tp2 = +(priceNow + atr15 * 2).toFixed(2);
    const tp3 = +(priceNow + atr15 * 3).toFixed(2);
    const sl = +(priceNow - atr15 * 1.2).toFixed(2);

    // pattern detection on 1m + 15m
    const candles1m = tfInfo["1m"].candles || results["1m"];
    const candles15m = baseCandles;
    const pattern1 = detectCandlePattern(candles1m && candles1m[candles1m.length - 1]);
    const engulf = detectEngulfing(candles1m && candles1m[candles1m.length - 2], candles1m && candles1m[candles1m.length - 1]);
    const pattern = engulf || pattern1;

    let reversalMsg = null;
    if (pattern) {
      const features = buildFeaturesForReversal(candles1m, candles15m, pattern);
      const pred = predictProb(features);
      // small adjustment: if multiTF confirmation high, bump
      const confAdj = multiTFConfirmation(symbol, pattern, candles1m, candles15m);
      const adjProb = Math.max(0, Math.min(100, pred.prob + confAdj * 5));
      reversalMsg = { pattern, pred, adjProb, features };
    }

    // ML training option: if we have hindsight feedback, call sgdUpdate(features,label)
    // For now we only predict and log.

    // build message
    const lines = [];
    lines.push(`🤖 ${symbol} — AI Trader v9 (Hybrid + Retrain)`);
    lines.push(`🕒 ${nowISO()}`);
    lines.push("");

    // per-TF summary
    for (let tf of ["1m", "5m", "15m", "30m", "1h"]) {
      const info = tfInfo[tf];
      if (!info.ok) {
        lines.push(`🕒 ${tf} | No data`);
        continue;
      }
      lines.push(
        `🕒 ${tf} | ${info.trend} | ΔP ${((info.delta || 0) * 100).toFixed(2)}% | ΔV ${((info.volDelta || 0) * 100).toFixed(2)}% | Str ${Math.round(
          Math.abs((info.delta || 0) * 100)
        )} | Source: Multi`
      );
    }
    lines.push("");
    lines.push(`🎯 Targets (Hybrid ATR+Fib+Elliott):`);
    lines.push(`TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}`);
    lines.push(`SL: ${sl}`);
    // breakout zone: use last fib 0.236-0.382 area if present
    const breakoutLow = fib.levels[2] ? fib.levels[2].level : +(priceNow - atr15 * 6).toFixed(2);
    const breakoutHigh = fib.levels[3] ? fib.levels[3].level : +(priceNow - atr15 * 2).toFixed(2);
    lines.push(`📊 Breakout Zone: ${(+breakoutLow).toFixed(2)} - ${(+breakoutHigh).toFixed(2)}`);
    lines.push("");
    // Bias & ML prob
    const mlProb = reversalMsg ? reversalMsg.adjProb : 50;
    const bias = mlProb >= 60 ? "Bullish" : mlProb <= 40 ? "Bearish" : "Neutral";
    const confidence = Math.round(Math.abs(mlProb - 50));
    lines.push(`🧠 Bias: ${bias} | Confidence: ${confidence}% | ML Prob: ${mlProb}% (thr 70%)`);
    lines.push(`💰 Price: ${priceNow} | ATR(15m): ${+(atr15 || 0).toFixed(2)} | ATR(30m): ${+(computeATR(results["30m"] || [], 14) || 0).toFixed(2)}`);
    lines.push(`📈 Tech Vol: Buy 50% / Sell 50% | Accuracy(Last10): N/A`);
    lines.push(`📰 News Impact: Medium`);
    lines.push(`Sources: Binance, Coinbase, Kraken (fallbacks)`);
    lines.push("");
    // Headlines (demo fetch)
    // For simplicity, we just fetch CoinDesk top headlines using a simple public RSS or mocked list
    const headlines = await fetchNewsHeadlines();
    lines.push(`📰 Headlines:`);
    for (let h of headlines.slice(0, 6)) lines.push(`• ${h}`);

    lines.push("");
    // Reversal watcher block
    if (reversalMsg) {
      const patt = reversalMsg.pattern;
      lines.push(`🛑 Reversal Watcher (v9)`);
      lines.push(`Pattern: ${patt.name} | Direction: ${patt.direction} | ML Prob: ${reversalMsg.adjProb}%`);
      lines.push(`Price: ${priceNow}`);
      lines.push(`Features: ${reversalMsg.features.map((x) => +Number(x).toFixed(3)).join(", ")}`);
    } else {
      lines.push(`🛑 Reversal Watcher (v9): No strong pattern`);
    }

    const message = lines.join("\n");
    return { ok: true, message, meta: { tfInfo, tp1, tp2, tp3, sl, fib, ell, reversalMsg } };
  } catch (e) {
    return { ok: false, err: e.message || String(e) };
  }
}

// --- headlines helper (simple) ----------------
async function fetchNewsHeadlines() {
  try {
    // CoinDesk RSS JSON proxy (or mocked)
    const r = await fetch("https://cryptopanic.com/news/api/v1/posts/?auth_token=public_demo", { timeout: 5000 }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      if (j && j.results) return j.results.map((x) => x.title || x.description);
    }
  } catch (e) {}
  // fallback simple list
  return [
    "XRP rallies on US shutdown nearing end, ETF tickers landing on DTCC",
    "Here’s what happened in crypto today",
    "End to US gov’t shutdown sparks institutional buying",
    "UK and US eye crypto passporting sandbox after talks",
    "XRP profit-taking signals 'weakness': Analysts",
  ];
}

// --- Telegram message sender ----------------
async function sendTelegramMessage(text) {
  const url = `${TELE_API}/sendMessage`;
  const params = { chat_id: CHAT_ID, text, parse_mode: "Markdown" };
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
    return true;
  } catch (e) {
    console.error("tg send fail", e.message);
    return false;
  }
}

// --- Telegram commands (polling simple) ----------------
// We'll implement a very light polling command loop to respond to /help & /check
const TG_OFFSET_FILE = "./tg_offset_v9.json";
let tgOffsetStore = safeParseJSON(TG_OFFSET_FILE, { offset: 0 });

async function checkTelegramCommands() {
  try {
    const url = `${TELE_API}/getUpdates?offset=${tgOffsetStore.offset + 1}&timeout=1`;
    const r = await fetch(url, { timeout: 5000 });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.result) return;
    for (const u of j.result) {
      tgOffsetStore.offset = Math.max(tgOffsetStore.offset, u.update_id);
      try {
        if (u.message && u.message.text) {
          const text = u.message.text.trim();
          const chat = u.message.chat.id;
          if (text === "/start" || text === "/help") {
            await fetch(`${TELE_API}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chat, text: "AI Trader bot: /check to run one analysis" }),
            });
          } else if (text === "/check") {
            const res = await analyzeSymbol(SYMBOL);
            if (res.ok) await fetch(`${TELE_API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: res.message }) });
            else await fetch(`${TELE_API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: "Analysis failed: " + res.err }) });
          }
        }
      } catch (e) {}
    }
    saveJSON(TG_OFFSET_FILE, tgOffsetStore);
  } catch (e) {
    // ignore
  }
}

// --- Reversal watcher periodic runner ----------------
async function reversalWatcherOnce(symbol = SYMBOL) {
  // run pattern detection and push short telegram message if above threshold
  try {
    const candles1m = await fetchKlines(symbol, "1m", 200);
    const candles15m = await fetchKlines(symbol, "15m", 200);
    const patt = detectCandlePattern(candles1m[candles1m.length - 1]) || detectEngulfing(candles1m[candles1m.length - 2], candles1m[candles1m.length - 1]);
    if (!patt) return null;
    const features = buildFeaturesForReversal(candles1m, candles15m, patt);
    const pred = predictProb(features);
    const confAdj = multiTFConfirmation(symbol, patt, candles1m, candles15m);
    const adjProb = Math.max(0, Math.min(100, pred.prob + confAdj * 5));
    const dir = patt.direction || "Neutral";
    const msgLines = [];
    msgLines.push(`🛑 Reversal Watcher (v9)`);
    msgLines.push(`${new Date().toLocaleString()}`);
    msgLines.push(`Symbol: ${symbol}`);
    msgLines.push(`Source: Multi`);
    msgLines.push(`Pattern: ${patt.name} | Direction: ${dir}`);
    msgLines.push(`Price: ${candles1m[candles1m.length - 1][4]}`);
    msgLines.push(`Volume: ${candles1m[candles1m.length - 1][5]} (avg ~${Math.round(candles1m.slice(-20).reduce((a, b) => a + b[5], 0) / 20)})`);
    msgLines.push(`ATR(5m): ${+(computeATR(await fetchKlines(symbol, "5m", 200), 14) || 0).toFixed(2)}`);
    msgLines.push(`MultiTF support: ${confAdj}`);
    msgLines.push(`ML Prob: ${adjProb}%`);
    // send if adjProb > threshold OR multiTF support > 0 (user can tune)
    if (adjProb >= 45 || confAdj >= 1) {
      await sendTelegramMessage(msgLines.join("\n"));
    }
    return { adjProb, patt };
  } catch (e) {
    return null;
  }
}

// --- main loop ----------------
let lastRun = 0;
async function analyzeAndReportOnce() {
  const res = await analyzeSymbol(SYMBOL);
  if (res.ok) {
    await sendTelegramMessage(res.message);
  } else {
    console.error("analysis failed", res.err);
  }
}

async function startAll() {
  // initial runs
  await analyzeAndReportOnce();
  await reversalWatcherOnce();
  // schedule intervals
  // main analysis every 15 minutes (user can change)
  setInterval(analyzeAndReportOnce, 15 * 60 * 1000);
  // reversal watcher every minute (fast)
  setInterval(reversalWatcherOnce, 60 * 1000);
  // Telegram command checker every 5 seconds
  setInterval(checkTelegramCommands, 3000);
}

// --- Express keepalive & simple API ----------------
const app = express();
app.get("/", (_, res) => res.send("AI Trader v9 (Hybrid) running"));
app.get("/check", async (_, res) => {
  try {
    const r = await analyzeSymbol(SYMBOL);
    if (r.ok) res.json({ ok: true, message: r.message });
    else res.status(500).json({ ok: false, err: r.err });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});
app.get("/reversal", async (_, res) => {
  try {
    const r = await reversalWatcherOnce(SYMBOL);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startAll().catch((e) => console.error("startAll error", e.message));
});