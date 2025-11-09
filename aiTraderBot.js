// ===== Part 1: Config, helpers, lightweight ML model, pattern detectors =====
// Paste this file FIRST (or paste this block at top of the single combined file)

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  CHECK_INTERVAL_MIN: parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10),
  REV_CHECK_INTERVAL_SEC: parseInt(process.env.REV_CHECK_INTERVAL_SEC || "30", 10),
  REV_COOLDOWN_MIN: parseInt(process.env.REV_COOLDOWN_MIN || "3", 10),
  KLINE_LIMIT: 120,
  PROXIES: [
    "", // try direct first (empty string = no proxy)
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://thingproxy.freeboard.io/fetch/"
  ],
  MODEL_PATH: path.resolve(process.cwd(), "ml_model.json"),
  ACC_KEY: path.resolve(process.cwd(), "acc_history.json"),
  SELF_PING_URL: process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || "",
};

// small util
const nowTime = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });

// ---------- Safe fetch with simple proxy fallback ----------
async function fetchWithFallback(url, options = {}) {
  for (const p of CONFIG.PROXIES) {
    try {
      const final = p ? p + encodeURIComponent(url) : url;
      const r = await fetch(final, { timeout: 15000, ...options });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // if proxy returns wrapper (allorigins), it returns raw body directly; handle JSON/text downstream
      return r;
    } catch (e) {
      // try next proxy
      // console.warn("proxy fail", p, e.message);
      continue;
    }
  }
  throw new Error("All proxies failed for " + url);
}

// ---------- Fetch klines from Binance public endpoint ----------
async function fetchKlines(symbol = CONFIG.SYMBOL, interval = "15m", limit = CONFIG.KLINE_LIMIT) {
  const base = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const res = await fetchWithFallback(base);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error("Invalid klines response");
    return json.map(k => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5]
    }));
  } catch (err) {
    console.warn("fetchKlines failed:", err.message);
    return [];
  }
}

// ---------- Simple news fetch (Cointelegraph fallback using proxy) ----------
async function fetchHeadlines(limit = 5) {
  try {
    const url = "https://cointelegraph.com/rss";
    const r = await fetchWithFallback(url);
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit + 1);
    return items.map(it => {
      const t = (it.match(/<title>(.*?)<\/title>/i) || [ "", "" ])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    });
  } catch (e) {
    // fallback to coinDesk
    try {
      const url = "https://www.coindesk.com/arc/outboundfeeds/rss/";
      const r = await fetchWithFallback(url);
      const txt = await r.text();
      const items = txt.split("<item>").slice(1, limit + 1);
      return items.map(it => (it.match(/<title>(.*?)<\/title>/i) || ["", ""])[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    } catch (err) {
      console.warn("fetchHeadlines fail:", err.message);
      return [];
    }
  }
}

// ---------- Simple reddit fetch for sentiment-ish ----------
async function fetchRedditTop(sub = "Bitcoin", limit = 10) {
  try {
    const url = `https://www.reddit.com/r/${sub}/new.json?limit=${limit}`;
    const r = await fetchWithFallback(url);
    const j = await r.json();
    if (!j.data) return [];
    return j.data.children.map(c => ({ title: c.data.title || "", ups: c.data.ups || 0, created_utc: c.data.created_utc || 0 }));
  } catch (e) {
    return [];
  }
}

// ---------- Pattern detectors (Doji, Hammer, Shooting Star) ----------
function detectCandlePattern(c) {
  // c: {open,high,low,close,volume}
  const o = c.open, h = c.high, l = c.low, cl = c.close;
  const body = Math.abs(cl - o);
  const range = h - l || 1;
  const upper = h - Math.max(cl, o);
  const lower = Math.min(cl, o) - l;

  const bodyPct = body / range;
  // doji: small body
  if (bodyPct < 0.1) return { pattern: "Doji", strength: 1 - bodyPct };

  // hammer: small upper shadow, long lower shadow, near high/low positions
  if (lower > body * 2.5 && upper < body * 0.6 && (cl > o ? cl > (h + l) / 2 : o > (h + l)/2)) {
    return { pattern: "Hammer", strength: lower / range };
  }
  // shooting star: long upper shadow, small lower
  if (upper > body * 2.5 && lower < body * 0.6 && (cl < o ? cl < (h + l) / 2 : o < (h + l)/2)) {
    return { pattern: "ShootingStar", strength: upper / range };
  }
  return { pattern: null, strength: 0 };
}

// ---------- Volume spike detection ----------
function isVolumeSpike(klines, idx, mul = 1.6) {
  // compare current candle volume with mean of previous N (default 20)
  const look = 20;
  const start = Math.max(0, idx - look);
  const slice = klines.slice(start, idx);
  if (slice.length < 4) return false;
  const avg = slice.reduce((s, k) => s + k.volume, 0) / slice.length;
  return klines[idx].volume > avg * mul;
}

// ---------- Fibonacci levels (basic) ----------
function calcFibLevels(klines) {
  if (!klines || klines.length === 0) return null;
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
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

// ---------- small helpers ----------
const fmt = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : v || "--");

// ---------- Lightweight incremental logistic regression (online SGD) ----------
class OnlineLogistic {
  constructor(features = 4, opts = {}) {
    this.w = new Array(features).fill(0).map((_, i) => (i === 0 ? 0 : 0)); // bias included separately if desired
    this.lr = opts.lr || 0.05;
    this.l2 = opts.l2 || 0.0001;
    this.modelFile = CONFIG.MODEL_PATH;
    this._load();
  }

  _sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  predictRaw(features) {
    let s = 0;
    for (let i = 0; i < this.w.length; i++) s += (this.w[i] || 0) * (features[i] || 0);
    return this._sigmoid(s);
  }

  predictLabel(features, threshold = 0.5) {
    const p = this.predictRaw(features);
    return { p, label: p >= threshold ? 1 : 0 };
  }

  update(features, target) {
    // target: 0 or 1
    const p = this.predictRaw(features);
    const err = (target - p);
    for (let i = 0; i < this.w.length; i++) {
      // gradient descent update with L2
      this.w[i] += this.lr * (err * (features[i] || 0) - this.l2 * (this.w[i] || 0));
    }
    // persist occasionally
    this._save();
    return p;
  }

  _save() {
    try {
      fs.writeFileSync(this.modelFile, JSON.stringify({ w: this.w, lr: this.lr, l2: this.l2 }, null, 2));
    } catch (e) {
      console.warn("model save fail", e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.modelFile)) {
        const raw = fs.readFileSync(this.modelFile, "utf8");
        const j = JSON.parse(raw);
        if (j && Array.isArray(j.w)) this.w = j.w;
        if (j.lr) this.lr = j.lr;
        if (j.l2) this.l2 = j.l2;
      }
    } catch (e) {
      console.warn("model load fail", e.message);
    }
  }
}

// ---------- Accuracy/History storage ----------
function pushAccuracy(correct) {
  try {
    const file = CONFIG.ACC_KEY;
    let arr = [];
    if (fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file));
    arr.push(correct ? 1 : 0);
    if (arr.length > 200) arr.shift();
    fs.writeFileSync(file, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}
function getAccuracy(lastN = 10) {
  try {
    const file = CONFIG.ACC_KEY;
    if (!fs.existsSync(file)) return "--";
    const arr = JSON.parse(fs.readFileSync(file));
    if (!arr.length) return "--";
    const slice = arr.slice(-lastN);
    const s = slice.reduce((a, b) => a + b, 0);
    return ((s / slice.length) * 100).toFixed(1);
  } catch (e) { return "--"; }
}

// ---------- Expose to global for Part 2 to use ----------
globalThis.aiTrader = globalThis.aiTrader || {};
Object.assign(globalThis.aiTrader, {
  CONFIG,
  nowTime,
  fetchKlines,
  fetchHeadlines,
  fetchRedditTop,
  detectCandlePattern,
  isVolumeSpike,
  calcFibLevels,
  fmt,
  OnlineLogistic,
  pushAccuracy,
  getAccuracy,
  fetchWithFallback
});

// end of Part 1
console.log("Part1 loaded: helpers & ML class ready");
// ===== Part 2: Main pipeline — uses globals created by Part 1 =====
// Paste this AFTER Part 1 in same runtime (same file below part1 or as separate file that imports part1)

// ensure the Part1 globals exist
const {
  CONFIG, nowTime, fetchKlines, fetchHeadlines, fetchRedditTop,
  detectCandlePattern, isVolumeSpike, calcFibLevels, fmt,
  OnlineLogistic, pushAccuracy, getAccuracy, fetchWithFallback
} = globalThis.aiTrader;

import express from "express"; // already installed in package.json
import fs from "fs";

// telegram send helper
async function sendTelegram(text) {
  if (!CONFIG.BOT_TOKEN || !CONFIG.CHAT_ID) {
    console.warn("Telegram credentials missing; not sending message");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
    // chunk if > 4000 chars
    const max = 3800;
    if (text.length <= max) {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text, parse_mode: "HTML" })
      });
      return;
    }
    // split nicely by line
    const lines = text.split("\n");
    let cur = "";
    for (const ln of lines) {
      if ((cur + ln + "\n").length > max) {
        await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text: cur, parse_mode: "HTML" }) });
        cur = "";
      }
      cur += ln + "\n";
    }
    if (cur.length) await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text: cur, parse_mode: "HTML" }) });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

// instantiate model (features: patternFlag, volumeSpikeFlag, slope, recentReturn)
const MODEL_FEATURES = 4;
const model = new OnlineLogistic(MODEL_FEATURES, { lr: 0.08, l2: 0.0002 });

// Keep reversal cooldown map to avoid duplicate spam
const revCooldowns = {}; // key: "BUY"|"SELL" -> timestamp until which suppressed

function inCooldown(type) {
  const now = Date.now();
  if (!revCooldowns[type]) return false;
  return revCooldowns[type] > now;
}
function setCooldown(type, minutes) {
  revCooldowns[type] = Date.now() + minutes * 60 * 1000;
}

// feature builder for the model from a specific candle + context
function buildFeatures(klines, idx) {
  const k = klines[idx];
  // pattern flag (Doji/Hammer/ShootingStar)
  const p = detectCandlePattern(k);
  const patternFlag = p.pattern ? (p.pattern === "Hammer" || p.pattern === "Doji" ? 1 : (p.pattern === "ShootingStar" ? -1 : 0)) : 0;
  const volSpike = isVolumeSpike(klines, idx, 1.6) ? 1 : 0;
  // slope of last N closes
  const look = 8;
  const start = Math.max(0, idx - look + 1);
  const slice = klines.slice(start, idx + 1);
  const slope = (slice.length >= 2) ? ((slice[slice.length - 1].close - slice[0].close) / slice[0].close) : 0;
  // recent return (last candle relative change)
  const recentReturn = (k.close - k.open) / (k.open || 1);
  // features vector (normalize lightly)
  return [patternFlag, volSpike, slope * 100, recentReturn * 100];
}

// produce a textual report for multiple tf
async function produceReport() {
  const tfs = ["1m","5m","15m","30m","1h"];
  let report = `🤖 <b>${CONFIG.SYMBOL} — AI Trader v8.6+ML</b>\n${nowTime()}\n\n`;
  let bull = 0, bear = 0, totalStrength = 0;
  let lastPrice = null;

  // collect multi-TF summaries
  for (const tf of tfs) {
    const kl = await fetchKlines(CONFIG.SYMBOL, tf, 80);
    if (!kl.length) {
      report += `⏱ ${tf} | No data\n`;
      continue;
    }
    lastPrice = kl[kl.length - 1].close;
    // get divergence approx: last percent change and last volume change pct
    const last = kl[kl.length - 1];
    const prev = kl[kl.length - 2] || kl[kl.length - 1];
    const dp = ((last.close - prev.close) / (prev.close || last.close)) * 100;
    const dv = ((last.volume - prev.volume) / (prev.volume || last.volume)) * 100;
    let signal = "Neutral ⚖️";
    if (dp > 0 && dv < 0) signal = "Bearish Divergence 🔻";
    if (dp < 0 && dv > 0) signal = "Bullish Divergence 🚀";
    const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
    // analyze pattern and fib
    const pat = detectCandlePattern(last).pattern || "—";
    const fib = calcFibLevels(kl);
    // small trend (slope)
    const slope = ((last.close - kl[0].close) / kl[0].close) * 100;
    const trendLabel = Math.abs(slope) < 0.2 ? "Flat" : (slope > 0 ? "Uptrend 📈" : "Downtrend 📉");

    report += `⏱ ${tf} | ${signal} | ΔP ${fmt(dp)}% | ΔV ${fmt(dv)}% | Strength ${Math.round(strength)}\n`;
    report += `   Elliot/Pattern: ${pat} | ${trendLabel}\n`;
    if (fib) report += `   Fib0.618: ${fmt(fib.fib618)}\n`;

    if (signal.includes("Bullish")) bull++;
    if (signal.includes("Bearish")) bear++;
    totalStrength += strength;
  }

  // get targets from 15m context (primary)
  const kl15 = await fetchKlines(CONFIG.SYMBOL, "15m", 120);
  if (kl15.length) {
    const fib = calcFibLevels(kl15);
    const last = kl15[kl15.length - 1].close;
    const move = last * 0.005; // 0.5% step
    // choose bias from counts
    const bias = bull > bear ? "Bullish 🚀" : bear > bull ? "Bearish 📉" : "Neutral ⚖️";
    const confidence = Math.round((totalStrength / (tfs.length * 100)) * 10000) / 100;
    const tp1 = (bias.includes("Bullish") ? last + move : bias.includes("Bearish") ? last - move : last + move*0.3);
    const tp2 = (bias.includes("Bullish") ? last + move*2 : bias.includes("Bearish") ? last - move*2 : last - move*0.2);
    const tp3 = (bias.includes("Bullish") ? last + move*3 : bias.includes("Bearish") ? last - move*3 : last - move*0.5);
    const sl  = (bias.includes("Bullish") ? last - move : bias.includes("Bearish") ? last + move : last - move);
    // breakout range based on fib band
    const breakoutLow = fib ? Math.min(fib.fib618, fib.fib5) : last - move;
    const breakoutHigh = fib ? Math.max(fib.fib618, fib.fib5) : last + move;

    report += `\n🎯 Targets:\nTP1: ${fmt(tp1)} | TP2: ${fmt(tp2)} | TP3: ${fmt(tp3)}\nSL: ${fmt(sl)}\n📊 Breakout Range: ${fmt(breakoutLow)} - ${fmt(breakoutHigh)}\n\n`;
    report += `🧠 Overall Bias: ${bias} | Confidence: ${fmt(confidence,2)}%\n💰 Last Price: ${fmt(last)}\n📈 Accuracy (last10): ${getAccuracy(10)}%\n`;

    // headlines & news sentiment
    const headlines = await fetchHeadlines(6);
    report += `\n📰 Headlines:\n`;
    if (headlines.length) headlines.forEach(h => report += `• ${h}\n`);
    else report += "• No news fetched\n";
  }

  // final send
  await sendTelegram(report);
  console.log("Main report sent", nowTime());
  return true;
}

// ---------- Reversal watcher (1-min) runs independently and uses ML model ----------
async function reversalWatcher() {
  // fetch 1m candles (limit small)
  const kl = await fetchKlines(CONFIG.SYMBOL, "1m", 80);
  if (!kl.length) return;
  const idx = kl.length - 1;
  const feat = buildFeatures(kl, idx);
  // model prediction (probability that this candle leads to reversal upward)
  const pred = model.predictRaw(feat); // 0..1
  // threshold adjustments (dynamic)
  const threshold = 0.65; // tuneable
  // rule-based signals
  const pDetected = detectCandlePattern(kl[idx]);
  const volSpike = isVolumeSpike(kl, idx, 1.6);
  // decide label using combined heuristics + ML (hybrid)
  let action = null;
  if (pDetected.pattern === "Hammer" && volSpike && pred > threshold && !inCooldown("BUY")) {
    action = { type: "BUY", conf: Math.round(pred * 100), pattern: pDetected.pattern };
    setCooldown("BUY", CONFIG.REV_COOLDOWN_MIN);
    // update model after we wait next candle for actual outcome (handled below)
  } else if (pDetected.pattern === "ShootingStar" && volSpike && pred < (1 - threshold) && !inCooldown("SELL")) {
    action = { type: "SELL", conf: Math.round((1 - pred) * 100), pattern: pDetected.pattern };
    setCooldown("SELL", CONFIG.REV_COOLDOWN_MIN);
  }
  if (action) {
    // smart alert message
    const msg = `🔔 <b>Reversal Watcher Alert</b>\n${nowTime()}\nType: ${action.type}\nPattern: ${action.pattern}\nML Prob: ${action.conf}%\nPrice: ${fmt(kl[idx].close)}\nVolume spike: ${volSpike}\n\n(This is standalone alert)\n`;
    await sendTelegram(msg);
    console.log("Reversal alert sent", action);
  }

  // --- Training step (online): compare last candle's predicted vs actual move
  // we look back one candle prediction stored in file/session and update model
  // store last prediction features with timestamp
  const STORE = path => path ? path + ".pred.json" : null;
  const predFile = path.resolve(process.cwd(), "last_pred.json");
  // Save current pred for next cycle to evaluate
  try {
    fs.writeFileSync(predFile, JSON.stringify({ time: kl[idx].time, features: feat, pred }));
  } catch (e) { /* ignore */ }

  // Evaluate previous prediction (if exists)
  try {
    if (fs.existsSync(predFile)) {
      // read previous and if previous time < current time - one minute => evaluate
      const raw = fs.readFileSync(predFile, "utf8");
      const prev = JSON.parse(raw);
      // if prev.features and prev.time < current candle time - 60s
      if (prev && prev.time && prev.features && prev.time < kl[idx].time) {
        // find the candle that follows prev.time in kl lines
        const idxPrev = kl.findIndex(k => k.time === prev.time);
        if (idxPrev >= 0 && idxPrev + 1 < kl.length) {
          const nextCandle = kl[idxPrev + 1];
          // determine actual label: if nextCandle.close > nextCandle.open => bullish move
          const actual = nextCandle.close > nextCandle.open ? 1 : 0;
          // update model
          const pBefore = model.predictRaw(prev.features);
          model.update(prev.features, actual);
          // push accuracy history
          const predLabel = pBefore >= 0.5 ? 1 : 0;
          pushAccuracy(predLabel === actual);
          console.log("Model updated. predBefore:", pBefore.toFixed(3), "actual:", actual);
        }
      }
    }
  } catch (e) {
    console.warn("eval/training step failed:", e.message);
  }
}

// ---------- Smart alerts: breakout on fib level + high-volume momentum ----------
let lastSmartAlert = { fibBreak: 0, volReversal: 0 };
async function smartAlertsCheck() {
  // check 5m or 15m for fib breakout
  const tf = "15m";
  const kl = await fetchKlines(CONFIG.SYMBOL, tf, 120);
  if (!kl.length) return;
  const fib = calcFibLevels(kl);
  const last = kl[kl.length - 1];
  // breakout conditions
  if (fib) {
    // breakout above fib618 -> bullish, below fib618 -> bearish
    if (last.close > fib.fib618 && (Date.now() - (lastSmartAlert.fibBreak || 0) > 5 * 60 * 1000)) {
      lastSmartAlert.fibBreak = Date.now();
      await sendTelegram(`🚨 <b>Smart Alert</b>\nBullish breakout above Fib 0.618 (${fmt(fib.fib618)})\nPrice: ${fmt(last.close)}\nTF: ${tf}`);
    } else if (last.close < fib.fib618 && (Date.now() - (lastSmartAlert.fibBreak || 0) > 5 * 60 * 1000)) {
      lastSmartAlert.fibBreak = Date.now();
      await sendTelegram(`🚨 <b>Smart Alert</b>\nBearish breakdown below Fib 0.618 (${fmt(fib.fib618)})\nPrice: ${fmt(last.close)}\nTF: ${tf}`);
    }
  }
  // high volume reversal on 1m (if a reversal pattern + spike)
  const k1 = await fetchKlines(CONFIG.SYMBOL, "1m", 40);
  if (k1.length >= 2) {
    const idx = k1.length - 1;
    const pat = detectCandlePattern(k1[idx]);
    if ((pat.pattern === "Hammer" || pat.pattern === "ShootingStar") && isVolumeSpike(k1, idx, 2.0)) {
      if (Date.now() - (lastSmartAlert.volReversal || 0) > 2 * 60 * 1000) {
        lastSmartAlert.volReversal = Date.now();
        await sendTelegram(`🔔 <b>Smart ML Alert</b>\nPattern: ${pat.pattern} with high volume\nPrice: ${fmt(k1[idx].close)}\nCheck: possible reversal`);
      }
    }
  }
}

// ---------- Scheduler & self-ping ----------
let mainTimer = null;
let revTimer = null;
let smartTimer = null;

async function startAll() {
  console.log("Starting aiTrader v8.6+ML ...", nowTime());
  // start main report interval
  await produceReport();
  mainTimer = setInterval(produceReport, CONFIG.CHECK_INTERVAL_MIN * 60 * 1000);
  // start reversal watcher (standalone)
  await reversalWatcher();
  revTimer = setInterval(reversalWatcher, CONFIG.REV_CHECK_INTERVAL_SEC * 1000);
  // smart alerts
  smartTimer = setInterval(smartAlertsCheck, 60 * 1000);

  // self ping if configured (optional)
  if (CONFIG.SELF_PING_URL) {
    setInterval(async () => {
      try {
        const r = await fetchWithFallback(CONFIG.SELF_PING_URL);
        console.log("Self-ping done", r.status || "ok");
      } catch (e) {
        console.warn("Self-ping fail", e.message);
      }
    }, 3 * 60 * 1000);
  }
}

// ---------- Express HTTP server for keep-alive ----------
const app = express();
app.get("/", (req, res) => res.send("aiTraderBot v8.6+ML running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Web server listening on port", PORT);
  // start bot pipeline when server ready
  startAll().catch(err => console.error("startAll failed:", err));
});

// end of Part 2
console.log("Part2 loaded: pipeline started (main, reversal, smart alerts)");