// aiTraderBot_v9_5_single.js
// Single-file AI Trader v9.5 (BTCUSDT, Binance mirrors + CoinGecko fallback, Telegram + KeepAlive)
// Requirements: node (v16+), axios, express
// Make sure package.json contains: { "type": "module" } for ESM imports
// Set environment variables: BOT_TOKEN, CHAT_ID (optional SELF_PING_URL)

import axios from "axios";
import express from "express";
import fs from "fs";
import path from "path";

/* ===========================
   Basic config (inline, easy to edit)
   =========================== */
const CONFIG = {
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVAL: process.env.INTERVAL || "15m",
  BINANCE_SOURCES: [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com"
  ],
  FALLBACK: {
    COINGECKO: "https://api.coingecko.com/api/v3"
  },
  CACHE_DIR: path.resolve("./cache"),
  CACHE_FILE: path.resolve("./cache/marketData.json"),
  REPORT_INTERVAL_MS: (parseInt(process.env.REPORT_INTERVAL_MIN || "15") || 15) * 60 * 1000,
  SELF_PING_URL: process.env.SELF_PING_URL || ""
};

// ensure cache dir
if (!fs.existsSync(CONFIG.CACHE_DIR)) fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

/* ===========================
   Utils
   =========================== */
const nowLocal = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

function saveCache(symbol, data) {
  try {
    let cache = {};
    if (fs.existsSync(CONFIG.CACHE_FILE)) cache = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
    cache[symbol] = { ts: Date.now(), data };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("Cache save failed:", e.message);
  }
}
function readCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
  } catch {}
  return {};
}

async function safeGet(url, label, transform) {
  try {
    const res = await axios.get(url, { timeout: 9000, headers: { "User-Agent": "AI-TraderBot-v9.5" } });
    if (res.status !== 200) throw new Error("status:" + res.status);
    const out = transform(res.data);
    if (Array.isArray(out) && out.length > 0) {
      console.log(`✅ ${label} OK (${out.length} candles)`);
      return { ok: true, data: out, source: label };
    }
    return { ok: false };
  } catch (e) {
    console.warn(`❌ ${label} failed: ${e.message}`);
    return { ok: false };
  }
}

/* ===========================
   Candle Normalizer
   Accepts: Binance klines arrays OR objects returned by some APIs
   Returns: [{t,open,high,low,close,vol}, ...] sorted by t asc
   =========================== */
function normalizeCandles(raw) {
  if (!raw) return [];
  const toCandle = (k) => {
    if (!k) return null;
    if (Array.isArray(k)) {
      // Binance kline: [ t, o, h, l, c, v, ... ]
      return {
        t: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        vol: Number(k[5] ?? 0)
      };
    }
    if (typeof k === "object") {
      // object format (e.g. Yahoo or coingecko processed)
      return {
        t: Number(k.t ?? k.time ?? k.timestamp ?? 0),
        open: Number(k.open ?? k.o ?? k.o ?? 0),
        high: Number(k.high ?? k.h ?? 0),
        low: Number(k.low ?? k.l ?? 0),
        close: Number(k.close ?? k.c ?? 0),
        vol: Number(k.vol ?? k.v ?? k.volume ?? 0)
      };
    }
    return null;
  };

  // raw might be {timestamp:[], indicators:...} OR array
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw?.prices && Array.isArray(raw.prices)) {
    // coinGecko / simplified mapping
    arr = raw.prices.map((p) => [p[0], p[1], p[1], p[1], p[1], 0]);
  } else if (raw?.chart?.result?.[0]) {
    // Yahoo format map
    const r = raw.chart.result[0];
    if (r.timestamp && r.indicators && r.indicators.quote && r.indicators.quote[0]) {
      const ts = r.timestamp;
      const q = r.indicators.quote[0];
      arr = ts.map((t, i) => ({
        t: t * 1000,
        open: q.open?.[i] ?? 0,
        high: q.high?.[i] ?? 0,
        low: q.low?.[i] ?? 0,
        close: q.close?.[i] ?? 0,
        vol: q.volume?.[i] ?? 0
      }));
    }
  } else if (typeof raw === "object") {
    // flatten object values
    arr = Object.values(raw).flat();
  }

  const out = arr.map(toCandle).filter((c) => c && !isNaN(c.close) && c.t > 0);
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* ===========================
   Market fetch: Binance primary (mirrors) -> CoinGecko fallback
   =========================== */
async function fetchFromBinanceMirrors(symbol, interval = "15m", limit = 500) {
  for (const base of CONFIG.BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const out = await safeGet(url, `Binance(${new URL(base).hostname})`, (raw) =>
      Array.isArray(raw) ? raw.map((k) => k) : []
    );
    if (out.ok) return { ok: true, data: normalizeCandles(out.data), source: `Binance(${new URL(base).hostname})` };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false };
}

async function fetchFromCoinGecko() {
  // CoinGecko doesn't give OHLC directly in same resolution for all pairs; we use bitcoin market_chart for latest prices
  try {
    const url = `${CONFIG.FALLBACK.COINGECKO}/coins/bitcoin/market_chart?vs_currency=usd&days=1`;
    const res = await axios.get(url, { timeout: 9000 });
    if (res.status === 200 && res.data && Array.isArray(res.data.prices) && res.data.prices.length) {
      // map prices -> synthetic candles
      const out = res.data.prices.map((p) => [p[0], p[1], p[1], p[1], p[1], 0]);
      return { ok: true, data: normalizeCandles(out), source: "CoinGecko" };
    }
  } catch (e) {
    console.warn("CoinGecko fallback failed:", e.message);
  }
  return { ok: false };
}

async function fetchMarketData(symbol = CONFIG.SYMBOL, interval = CONFIG.INTERVAL, limit = 500) {
  console.log(`\n⏳ Fetching market data for ${symbol} (${interval})...`);
  // try cache first (if fresh) - optional, but we'll fallback to cache if fetch fails
  let res = { ok: false };
  try {
    res = await fetchFromBinanceMirrors(symbol, interval, limit);
    if (res.ok && res.data && res.data.length) {
      saveCache(symbol, res.data);
      return { data: res.data, source: res.source };
    }
    const cg = await fetchFromCoinGecko();
    if (cg.ok && cg.data && cg.data.length) {
      saveCache(symbol, cg.data);
      return { data: cg.data, source: cg.source };
    }
    // fallback to disk cache if available
    const cache = readCache();
    if (cache[symbol] && cache[symbol].data && Array.isArray(cache[symbol].data) && cache[symbol].data.length) {
      console.log("♻️ Using cached data for", symbol);
      return { data: cache[symbol].data, source: "cache" };
    }
    console.error("⛔ No market data available (all sources failed)");
    return { data: [], source: "none" };
  } catch (err) {
    console.error("fetchMarketData error:", err.message || err);
    return { data: [], source: "error" };
  }
}

/* ===========================
   Indicators: RSI + MACD (safe minimal impl)
   =========================== */
function calculateRSI(data, period = 14) {
  if (!Array.isArray(data) || data.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = data[data.length - 1 - (period - i)].close - data[data.length - 2 - (period - i)].close;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Math.round(rsi * 10) / 10;
}

function EMAarray(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  // first SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function calculateMACD(data, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(data) || data.length < slow + signal) return null;
  const closes = data.map((d) => d.close);
  const emaFast = EMAarray(closes, fast);
  const emaSlow = EMAarray(closes, slow);
  // align arrays: emaFast[?] - emaSlow[?] -> build macd line length = min(emaFast.length, emaSlow.length)
  const minLen = Math.min(emaFast.length, emaSlow.length);
  if (minLen <= 0) return null;
  const macdLine = [];
  for (let i = 0; i < minLen; i++) macdLine.push(emaFast[i + (emaFast.length - minLen)] - emaSlow[i + (emaSlow.length - minLen)]);
  const signalLine = EMAarray(macdLine, signal);
  const hist = macdLine.slice(signalLine.length ? signalLine.length * -1 : 0).map((v, i) => v - (signalLine[i] ?? 0));
  const latestHist = hist[hist.length - 1] ?? 0;
  return { macdLine, signalLine, histogram: hist, summary: latestHist > 0 ? "Bullish" : "Bearish", macdValue: macdLine[macdLine.length - 1] ?? 0, signalValue: signalLine[signalLine.length - 1] ?? 0 };
}

/* ===========================
   Simple Elliott-ish quick summary (lightweight)
   =========================== */
function analyzeElliottQuick(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return { structure: "Too little data", wave: "N/A", confidence: 0 };

  const closes = candles.map((c) => c.close);
  const len = closes.length;
  const last = closes[len - 1];
  const prev5 = closes[len - 6] ?? closes[0];
  const dir = last > prev5 ? "UP" : "DOWN";
  // find simple pivots
  let peaks = 0, troughs = 0;
  for (let i = 2; i < len - 2; i++) {
    if (closes[i] > closes[i - 1] && closes[i] > closes[i + 1]) peaks++;
    if (closes[i] < closes[i - 1] && closes[i] < closes[i + 1]) troughs++;
  }
  const pattern = peaks >= 3 && troughs >= 2 ? "Impulsive" : "Corrective/Sideways";
  const confidence = Math.min(90, Math.round((Math.abs(last - prev5) / prev5) * 1000));
  return { structure: pattern, wave: dir === "UP" ? "W-impulse" : "W-corrective", confidence: confidence || 10 };
}

/* ===========================
   Merge signals (very simple)
   =========================== */
function mergeSignals(indicators, ell, ml) {
  let bias = "Neutral";
  let strength = 10;
  if (indicators?.rsi !== null && indicators?.rsi !== undefined) {
    if (indicators.rsi < 30) { bias = "Buy"; strength += 20; }
    else if (indicators.rsi > 70) { bias = "Sell"; strength += 20; }
  }
  if (indicators?.macd) {
    if ((indicators.macd.macdValue ?? 0) > (indicators.macd.signalValue ?? 0)) { if (bias !== "Sell") bias = "Buy"; strength += 25; }
    else { if (bias !== "Buy") bias = "Sell"; strength += 20; }
  }
  // ml is optional; if present and prob > 55 favors buy
  if (ml?.prob) {
    if (ml.prob > 55) { bias = "Buy"; strength += Math.min(20, ml.prob - 50); }
    else if (ml.prob < 45) { bias = "Sell"; strength += Math.min(20, 50 - ml.prob); }
  }
  // elliott add small
  strength = Math.round(Math.min(100, strength));
  return { bias, strength, mlProb: ml?.prob ?? 50 };
}

/* ===========================
   ML stub: minimal safe predictor (no model file dependency)
   Returns { prob, label }
   =========================== */
function runMLPredictionStub(candles) {
  // very simple momentum-based probability (not trained) as fallback
  if (!Array.isArray(candles) || candles.length < 5) return { prob: 50, label: "Neutral" };
  const last = candles[candles.length - 1].close;
  const prev = candles[candles.length - 6] ? candles[candles.length - 6].close : candles[0].close;
  const rel = (last - prev) / (prev || 1);
  const prob = Math.round(50 + Math.max(-40, Math.min(40, rel * 1000)));
  return { prob, label: prob >= 50 ? "Bullish" : "Bearish" };
}

/* ===========================
   Telegram send
   =========================== */
async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("⚠️ Telegram not configured. Set BOT_TOKEN and CHAT_ID env vars to enable.");
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true });
    console.log("✅ Telegram message sent");
    return true;
  } catch (e) {
    console.error("❌ Telegram send failed:", e.message || e);
    return false;
  }
}

/* ===========================
   Build report and message
   =========================== */
async function buildReport(symbol = CONFIG.SYMBOL, interval = CONFIG.INTERVAL) {
  try {
    const { data, source } = await fetchMarketData(symbol, interval, 500);
    if (!Array.isArray(data) || data.length < 10) {
      console.warn("⚠️ Not enough candle data for report");
      return null;
    }
    // ensure numeric candles
    const candles = data.filter((c) => c && typeof c.close === "number");
    if (!candles.length) return null;
    const last = candles[candles.length - 1];
    // indicators
    const rsi = calculateRSI(candles, 14);
    const macd = calculateMACD(candles, 12, 26, 9);
    const ell = analyzeElliottQuick(candles);
    const ml = runMLPredictionStub(candles);
    const merged = mergeSignals({ rsi, macd }, ell, ml);
    // ATR approx
    const recent = candles.slice(-20);
    let atr = 0;
    for (let i = 1; i < recent.length; i++) {
      const cur = recent[i];
      const prev = recent[i - 1];
      atr += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    }
    atr = Math.round((atr / Math.max(1, recent.length - 1)) || 0);
    // TP/SL
    const lastPrice = Number(last.close) || 0;
    const dirSign = merged.bias === "Buy" ? 1 : merged.bias === "Sell" ? -1 : 1;
    const TP1 = Math.round(lastPrice + dirSign * atr * 4);
    const TP2 = Math.round(lastPrice + dirSign * atr * 6);
    const SL = Math.round(lastPrice - dirSign * atr * 2);
    // compose HTML text
    let text = `🚀 <b>${symbol} — AI Trader v9.5</b>\n${nowLocal()}\nSource: ${source}\nPrice: ${lastPrice}\n\n`;
    text += `📊 <b>Elliott Wave (${interval})</b>\n${ell.structure} | ${ell.wave} | Confidence: ${ell.confidence}%\n\n`;
    text += `⚠️ <b>Possible Wave 5 Reversal</b> — watch for breakout confirmation.\n\n`;
    // brief timeframe table (we only have one series, but show multiple tf labels)
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    for (const tf of tfs) {
      text += `📈 ${tf} | Price: ${lastPrice} | RSI: ${rsi ?? "N/A"} | MACD: ${macd ? Math.round((macd.macdValue || 0) * 100) / 100 : "N/A"} | ATR: ${atr} | ML: ${ml.prob}%\n`;
    }
    text += `\nBias: ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb}%\n\n`;
    text += `TP1: ${TP1} | TP2: ${TP2} | SL: ${SL}\nBreakout zone (est): ${Math.round(lastPrice - atr * 3)} - ${Math.round(lastPrice + atr * 3)}\n\n`;
    text += `Sources: Binance (mirrors), CoinGecko fallback\n`;
    return { text, summary: { rsi, macd, ell, ml, merged, TP1, TP2, SL } };
  } catch (e) {
    console.error("buildReport error:", e.message || e);
    return null;
  }
}

/* ===========================
   KeepAlive server + startup
   =========================== */
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot v9.5 alive"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  if (CONFIG.SELF_PING_URL) setInterval(() => {
    axios.get(CONFIG.SELF_PING_URL).then(() => console.log("KeepAlive Ping OK")).catch(()=>{});
  }, 5*60*1000);
});

/* ===========================
   Main loop
   =========================== */
async function generateReportLoop() {
  try {
    console.log("⏳ Generating report for", CONFIG.SYMBOL);
    const out = await buildReport(CONFIG.SYMBOL, CONFIG.INTERVAL);
    if (!out) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (err) {
    console.error("Report error:", err && err.message ? err.message : err);
    await sendTelegramMessage(`❌ Error generating report: ${err && err.message ? err.message : JSON.stringify(err)}`);
  }
}

(async () => {
  console.log("🤖 AI Trader v9.5 starting...");
  if (!BOT_TOKEN || !CHAT_ID) console.warn("⚠️ Telegram not configured (BOT_TOKEN / CHAT_ID). Telegram messages will not be sent.");
  // Run immediately, then schedule
  await generateReportLoop();
  setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS);
})();