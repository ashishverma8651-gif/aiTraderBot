// aiTraderBot.js
// Single-file AI Trader vX — Multi-source, WebSocket mirrors, indicators, Telegram 15m auto-report
// Drop into your project root and run: node aiTraderBot.js
// Requires: axios, ws, node-telegram-bot-api, express
// Optional: https-proxy-agent (if using HTTP(S) proxy)

import fs from "fs";
import path from "path";
import axios from "axios";
import WebSocket from "ws";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

//
// ------------------- CONFIG (edit or use ENV) -------------------
//
const CONFIG = {
  SYMBOL: process.env.SYMBOL || "BTCUSDT",
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  REPORT_INTERVAL_MIN: Number(process.env.REPORT_INTERVAL_MIN || "15"),
  CACHE_DIR: process.env.CACHE_DIR || path.resolve(process.cwd(), "cache"),
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 200),
  AXIOS_TIMEOUT: Number(process.env.AXIOS_TIMEOUT || 15000),

  // Sources (order matters: first is preferred)
  BINANCE_HTTP_MIRRORS: [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
  ],
  OTHER_SOURCES: {
    BYBIT: "https://api-testnet.bybit.com", // replace with production if needed
    KUCOIN: "https://api.kucoin.com",
    COINBASE: "https://api.exchange.coinbase.com",
    COINGECKO: "https://api.coingecko.com/api/v3",
  },

  // Websocket mirrors for live ticker
  BINANCE_WS_MIRRORS: [
    "wss://stream.binance.com:9443/ws",
    "wss://data-stream.binance.vision/ws",
    "wss://stream.binance.us:9443/ws",
  ],

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.CHAT_ID || null,

  // Keep-alive & server
  SERVER_PORT: Number(process.env.PORT || 10000),
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  // Proxy (optional): set HTTP_PROXY or HTTPS_PROXY in env, or set PROXY = { host, port, auth }
  PROXY: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || null,
};

//
// ------------------- Boot / folder setup -------------------
if (!fs.existsSync(CONFIG.CACHE_DIR)) fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });

//
// ------------------- Optional proxy agent hookup -------------------
let axiosInstance = axios.create({ timeout: CONFIG.AXIOS_TIMEOUT });
if (CONFIG.PROXY) {
  // Try to use https-proxy-agent if available; otherwise use axios proxy field (limited)
  try {
    // dynamic import
    const HttpsProxyAgent = (await import("https-proxy-agent")).default;
    const agent = HttpsProxyAgent(CONFIG.PROXY);
    axiosInstance = axios.create({
      timeout: CONFIG.AXIOS_TIMEOUT,
      httpsAgent: agent,
      httpAgent: agent,
    });
    console.log("Using https-proxy-agent for outbound http(s) proxy");
  } catch (e) {
    // fallback: axios proxy config if PROXY is host:port or url
    console.warn("https-proxy-agent not available or proxy parse failed, using basic axios proxy/config fallback.");
    // If PROXY is a url like http://user:pass@host:port, axios proxy auto won't accept string; leave axiosInstance default.
  }
}

//
// ------------------- Utilities: time, cache -------------------
function nowLocalISO() {
  return new Date().toISOString();
}

function nowLocalReadable() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour12: true });
}

function cachePath(symbol, interval) {
  return path.join(CONFIG.CACHE_DIR, `${symbol}_${interval}.json`);
}

function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch (e) {
    console.warn("readCache err", e?.message || e);
    return [];
  }
}

function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("writeCache err", e?.message || e);
  }
}

//
// ------------------- Safe HTTP getter with mirrors + failover -------------------
async function safeGetFromSources(url, sources = []) {
  // sources: array of base URLs that replace https://api.binance.com in url
  let lastErr = null;
  // Try each provided source first
  for (const base of sources) {
    try {
      const tryUrl = url.replace("https://api.binance.com", base);
      const res = await axiosInstance.get(tryUrl, { timeout: CONFIG.AXIOS_TIMEOUT });
      if (res && (res.status === 200 || res.status === 201)) return res.data;
      lastErr = new Error(`HTTP ${res?.status}`);
    } catch (e) {
      lastErr = e;
    }
  }

  // Attempt original URL fallback
  try {
    const res = await axiosInstance.get(url, { timeout: CONFIG.AXIOS_TIMEOUT });
    if (res && (res.status === 200 || res.status === 201)) return res.data;
  } catch (e) {
    lastErr = e;
  }

  console.warn("safeGetFromSources failed:", lastErr?.message || lastErr);
  return null;
}

//
// ------------------- Normalize Binance klines to uniform objects -------------------
function normalizeKlines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      t: Number(r[0] ?? r.openTime ?? 0),
      open: Number(r[1] ?? r.open ?? 0),
      high: Number(r[2] ?? r.high ?? 0),
      low: Number(r[3] ?? r.low ?? 0),
      close: Number(r[4] ?? r.close ?? 0),
      vol: Number(r[5] ?? r.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.close));
}

//
// ------------------- Fetch candles (multi-source) -------------------
async function fetchCandlesBinance(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT) {
  const base = "https://api.binance.com";
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await safeGetFromSources(url, CONFIG.BINANCE_HTTP_MIRRORS);
  return data ? normalizeKlines(data) : [];
}

// Fallback attempt to other exchanges (simple — not full compatibility)
async function fetchCandlesFallback(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT) {
  // Try Bybit, KuCoin, Coinbase minimal endpoints — NOTE: intervals may not match exactly
  // By default we attempt to map to similar endpoints, but priority is Binance Vision.
  const tries = [];

  // bybit (kline)
  tries.push(async () => {
    try {
      const s = symbol.replace("USDT", "USDT");
      const url = `${CONFIG.OTHER_SOURCES.BYBIT}/public/linear/kline?symbol=${s}&interval=${interval}&limit=${limit}`;
      const res = await axiosInstance.get(url);
      if (res?.data?.result) {
        // bybit returns result array
        return res.data.result.map((r) => ({
          t: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          vol: Number(r[5]),
        }));
      }
      return null;
    } catch (e) {
      return null;
    }
  });

  // kucoin
  tries.push(async () => {
    try {
      const url = `${CONFIG.OTHER_SOURCES.KUCOIN}/api/v1/market/candles?symbol=${symbol}&type=${interval}&limit=${limit}`;
      const res = await axiosInstance.get(url);
      if (res?.data?.data) {
        return res.data.data.map((r) => ({
          t: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          vol: Number(r[5]),
        }));
      }
      return null;
    } catch (e) {
      return null;
    }
  });

  // coinbase (granularity in seconds — only do 15m -> 900)
  tries.push(async () => {
    try {
      const gran = intervalToSeconds(interval);
      const url = `${CONFIG.OTHER_SOURCES.COINBASE}/products/${symbol.replace("USDT", "-USD")}/candles?granularity=${gran}`;
      const res = await axiosInstance.get(url);
      if (Array.isArray(res?.data)) {
        // Coinbase returns [time, low, high, open, close, volume] — note order differs
        return res.data.map((r) => ({
          t: Number(r[0] * 1000),
          low: Number(r[1]),
          high: Number(r[2]),
          open: Number(r[3]),
          close: Number(r[4]),
          vol: Number(r[5]),
        }));
      }
      return null;
    } catch (e) {
      return null;
    }
  });

  for (const fn of tries) {
    try {
      const out = await fn();
      if (Array.isArray(out) && out.length) return out;
    } catch (_) {}
  }

  return [];
}

function intervalToSeconds(interval) {
  if (!interval) return 60;
  if (interval.endsWith("m")) return Number(interval.slice(0, -1)) * 60;
  if (interval.endsWith("h")) return Number(interval.slice(0, -1)) * 3600;
  if (interval.endsWith("d")) return Number(interval.slice(0, -1)) * 86400;
  return 60;
}

//
// ------------------- Caching wrapper with fallback -------------------
async function ensureCandles(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT) {
  const cached = readCache(symbol, interval) || [];
  let fresh = [];
  try {
    fresh = await fetchCandlesBinance(symbol, interval, limit);
    if ((!fresh || !fresh.length) && CONFIG.OTHER_SOURCES) {
      fresh = await fetchCandlesFallback(symbol, interval, limit);
    }
  } catch (e) {
    console.warn("ensureCandles fetch error", e?.message || e);
  }

  if (Array.isArray(fresh) && fresh.length) {
    writeCache(symbol, interval, fresh);
    return fresh;
  }
  return cached;
}

//
// ------------------- Indicators: RSI, ATR, EMA, MACD -------------------
function computeRSI(candles = [], length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = (candles[i + 1].close || 0) - (candles[i].close || 0);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50;
  const avgGain = gains / length;
  const avgLoss = (losses || 1e-6) / length;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeATR(candles = [], length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 0;
  const trs = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1] || cur;
    const high = Number(cur.high || 0);
    const low = Number(cur.low || 0);
    const prevClose = Number(prev.close || 0);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (!trs.length) return 0;
  return Number((trs.reduce((a, b) => a + b, 0) / trs.length).toFixed(2));
}

function ema(values = [], period = 12) {
  if (!Array.isArray(values) || !values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [];
  for (const v of values) {
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function computeMACD(candles = []) {
  if (!Array.isArray(candles) || candles.length < 35) return { hist: 0, line: 0, signal: 0 };
  const closes = candles.map((c) => Number(c.close || 0));
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - (ema26[i] || 0));
  const signal = ema(macdLine, 9);
  const hist = (macdLine.at(-1) || 0) - (signal.at(-1) || 0);
  return { hist: Number(hist.toFixed(6)), line: Number((macdLine.at(-1) || 0).toFixed(6)), signal: Number((signal.at(-1) || 0).toFixed(6)) };
}

function priceTrend(candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return "FLAT";
  const last = Number(candles.at(-1).close || 0);
  const prev = Number(candles.at(-2).close || 0);
  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

function analyzeVolume(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return { status: "UNKNOWN", strength: 0 };
  const v1 = Number(candles.at(-3).vol || 0);
  const v2 = Number(candles.at(-2).vol || 0);
  const v3 = Number(candles.at(-1).vol || 0);
  if (v3 > v2 && v2 > v1) return { status: "RISING", strength: 3 };
  if (v3 < v2 && v2 < v1) return { status: "FALLING", strength: -3 };
  if (v3 > v2) return { status: "SLIGHT_UP", strength: 1 };
  if (v3 < v2) return { status: "SLIGHT_DOWN", strength: -1 };
  return { status: "STABLE", strength: 0 };
}

function computeFibLevelsFromCandles(candles = []) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const highs = candles.map((c) => Number(c.high || 0));
  const lows = candles.map((c) => Number(c.low || 0));
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const diff = hi - lo;
  return {
    lo,
    hi,
    retrace: {
      "0.236": Number((hi - diff * 0.236).toFixed(6)),
      "0.382": Number((hi - diff * 0.382).toFixed(6)),
      "0.5": Number((hi - diff * 0.5).toFixed(6)),
      "0.618": Number((hi - diff * 0.618).toFixed(6)),
      "0.786": Number((hi - diff * 0.786).toFixed(6)),
    },
    extensions: {
      "1.272": Number((hi + diff * 0.272).toFixed(6)),
      "1.618": Number((hi + diff * 0.618).toFixed(6)),
    },
  };
}

//
// ------------------- Elliott placeholder (you can replace with your module) -------------------
async function analyzeElliottSimple(candles = []) {
  // This is a simple heuristic placeholder; replace with your real elliott module if you have it.
  try {
    if (!Array.isArray(candles) || candles.length < 21) return null;
    const rsi = computeRSI(candles, 14);
    if (rsi > 65) return { wave: "impulse-up", confidence: 60 };
    if (rsi < 35) return { wave: "impulse-down", confidence: 60 };
    return { wave: "sideways", confidence: 35 };
  } catch (e) {
    return null;
  }
}

//
// ------------------- ML placeholder (load model if exists) -------------------
async function runMLPrediction(symbol = "BTCUSDT", candles = []) {
  // Minimal stub: tries to load ./ml_model.json if present and runs a simple scoring rule.
  try {
    const modelPath = path.resolve("./ml_model.json");
    if (!fs.existsSync(modelPath)) return null;
    const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
    // Very small heuristic: if model.threshold and last close is greater return bullish prob (fake)
    const last = candles.at(-1)?.close || 0;
    const prob = model && model.threshold ? Math.min(99, Math.max(1, Math.round((last % 100) / (model.threshold || 1) * 100))) : 50;
    return { label: prob > 55 ? "Bullish" : "Neutral", prob: prob, raw: model };
  } catch (e) {
    console.warn("ML load error", e?.message || e);
    return null;
  }
}

//
// ------------------- News placeholder -------------------
async function fetchNewsStub(symbol = "BTC") {
  try {
    // Try Coingecko coin news (simple): /search/trending isn't headline based but keep lightweight
    // Real production: use a reliable news API (GNews, NewsAPI) and parse sentiment
    return null;
  } catch (e) {
    return null;
  }
}

//
// ------------------- Fetch market data wrapper (returns indicators + fib etc) -------------------
async function fetchMarketData(symbol = "BTCUSDT", interval = "15m", limit = CONFIG.DEFAULT_LIMIT) {
  const candles = await ensureCandles(symbol, interval, limit);
  const data = Array.isArray(candles) ? candles : [];
  const last = data.at(-1) || {};
  const indicators = {
    RSI: computeRSI(data, 14),
    MACD: computeMACD(data),
    ATR: computeATR(data, 14),
    priceTrend: priceTrend(data),
    volume: analyzeVolume(data),
  };
  const fib = computeFibLevelsFromCandles(data);
  return {
    data,
    price: Number(last.close || 0),
    volume: Number(last.vol || 0),
    indicators,
    fib,
    updated: nowLocalReadable(),
  };
}

//
// ------------------- WebSocket live price mirror (rotating) -------------------
let ws = null;
let socketAlive = false;
let lastPrice = null;
let wsMirrorIndex = 0;
let wsReconnectTimer = null;

function connectLiveSocket(symbol = CONFIG.SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`; // 24hr ticker stream (binance)
  const mirrors = CONFIG.BINANCE_WS_MIRRORS || [];
  function doConnect() {
    const base = mirrors[wsMirrorIndex % mirrors.length];
    const url = base.endsWith("/") ? `${base}${stream}` : `${base}/${stream}`;
    console.log("WS connecting to", url);
    try {
      if (ws) {
        try { ws.removeAllListeners?.(); ws.terminate?.(); ws.close?.(); } catch (_) {}
        ws = null;
      }
      ws = new WebSocket(url);
      ws.on("open", () => {
        socketAlive = true;
        console.log("WS open:", url);
      });
      ws.on("message", (msg) => {
        try {
          const j = typeof msg === "string" ? JSON.parse(msg) : JSON.parse(msg.toString());
          // Binance ticker uses 'c' as close
          const p = Number(j.c || j.price || j.lastPrice || 0);
          if (p) lastPrice = p;
        } catch (e) {}
      });
      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn("WS closed", code, String(reason).slice(0, 120));
        wsMirrorIndex = (wsMirrorIndex + 1) % mirrors.length;
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(doConnect, 8000);
      });
      ws.on("error", (err) => {
        socketAlive = false;
        console.warn("WS error:", err?.message || String(err).slice(0,120));
        try { ws.close(); } catch (_) {}
      });
    } catch (e) {
      socketAlive = false;
      console.warn("WS connect failed", e?.message || e);
      wsMirrorIndex = (wsMirrorIndex + 1) % mirrors.length;
      setTimeout(doConnect, 8000);
    }
  }
  doConnect();
}

//
// ------------------- Telegram setup -------------------
const BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM_CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

async function sendTelegramHTML(html) {
  if (!bot || !CHAT_ID) {
    console.warn("Telegram not configured (BOT_TOKEN or CHAT_ID missing)");
    return false;
  }
  try {
    await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  } catch (e) {
    console.error("Telegram send failed", e?.message || e);
    return false;
  }
}

//
// ------------------- Build report (Multi-TF, 15m focused) -------------------
async function buildAIReport(symbol = CONFIG.SYMBOL) {
  try {
    const tfs = CONFIG.INTERVALS;
    const mtf = [];
    for (const tf of tfs) {
      try {
        const resp = await fetchMarketData(symbol, tf, CONFIG.DEFAULT_LIMIT);
        const cand = resp.data || [];
        const last = cand.at(-1) || {};
        const indicators = resp.indicators || {};
        const volText = indicators && indicators.volume ? indicators.volume.status : "UNKNOWN";
        const bias = (() => {
          const rsi = indicators?.RSI;
          const macdHist = indicators?.MACD?.hist;
          if (rsi !== null && typeof macdHist === "number") {
            if (rsi > 60 && macdHist > 0) return "Bullish";
            if (rsi < 40 && macdHist < 0) return "Bearish";
            return "Neutral";
          }
          return "N/A";
        })();
        mtf.push({
          tf,
          price: resp.price || 0,
          lastClose: last.close || 0,
          indicators,
          volText,
          bias,
          fib: resp.fib || null,
        });
      } catch (e) {
        mtf.push({ tf, error: String(e?.message || e) });
      }
    }

    // 15m context (candles, ml, ell, news)
    const ctx15 = await fetchMarketData(symbol, "15m", CONFIG.DEFAULT_LIMIT);
    const ml = await runMLPrediction(symbol, ctx15.data);
    const ell = await analyzeElliottSimple(ctx15.data);
    const news = await fetchNewsStub(symbol.replace("USDT", ""));
    const price = lastPrice || ctx15.price || 0;

    return {
      symbol,
      price,
      mtf,
      ml,
      ell,
      news,
      generatedAt: nowLocalReadable(),
    };
  } catch (e) {
    return { symbol, price: 0, mtf: [], ml: null, ell: null, news: null, generatedAt: nowLocalReadable(), error: String(e?.message || e) };
  }
}

function formatReportHTML(r) {
  const price = Number(r.price || 0).toFixed(2);
  const generated = r.generatedAt || nowLocalReadable();
  const header = `<b>🚀 ${r.symbol} — AI Trader (single-file)</b>\n${generated}\n\nPrice: <b>${price}</b>\n\n`;

  const mtfBlock = r.mtf
    .map((m) => {
      if (m.error) return `<b>[${m.tf}]</b> Error: ${m.error}`;
      const rsi = m.indicators?.RSI ?? "N/A";
      const macd = m.indicators?.MACD?.hist ?? "N/A";
      const atr = m.indicators?.ATR ?? "N/A";
      const vol = (m.indicators && m.indicators.volume && m.indicators.volume.status) || "N/A";
      const sig = m.bias || "N/A";
      return `<b>[${m.tf}]</b> ${sig}\nRSI:${rsi} | MACD:${typeof macd === "number" ? macd.toFixed(4) : macd} | ATR:${atr}\nPrice: ${m.lastClose || m.price || "N/A"} | Vol:${vol}\n`;
    })
    .join("\n-----------------\n");

  const ellTxt = r.ell ? `${r.ell.wave} | Conf ${r.ell.confidence || 0}` : "N/A";
  const mlTxt = r.ml ? `${r.ml.label} (${r.ml.prob ?? 0}%)` : "N/A";

  const footer = `\n\n<b>🧠 ML:</b> ${mlTxt}\n<b>📈 Elliott:</b> ${ellTxt}\n\n<i>Data: Multi-source (Binance Vision + Binance + Bybit/KuCoin/CB) | vSingleFile</i>`;

  return `${header}<b>📊 Multi-Timeframe Overview</b>\n${mtfBlock}\n${footer}`;
}

//
// ------------------- Auto 15m report + runner -------------------
async function sendAutoReport() {
  try {
    const reportObj = await buildAIReport(CONFIG.SYMBOL);
    const html = formatReportHTML(reportObj);
    await sendTelegramHTML(html);
    console.log(`[${new Date().toLocaleTimeString()}] Report sent for ${CONFIG.SYMBOL}`);
  } catch (e) {
    console.error("sendAutoReport failed", e?.message || e);
  }
}

//
// ------------------- Express keep-alive endpoint -------------------
const app = express();
app.get("/", (_, res) => res.send(`✅ AI Trader singlefile running — ${nowLocalReadable()}`));
app.listen(CONFIG.SERVER_PORT, () => console.log(`Server live on port ${CONFIG.SERVER_PORT}`));

//
// ------------------- Start WS + schedule -------------------
try {
  connectLiveSocket(CONFIG.SYMBOL);
} catch (e) {
  console.warn("WS init failed", e?.message || e);
}

const intervalMs = Math.max(60_000, CONFIG.REPORT_INTERVAL_MIN * 60_000);
setInterval(() => {
  // ensure live send only when configured
  if (BOT_TOKEN && CHAT_ID) sendAutoReport(); else console.log("Telegram not configured — skipping auto send.");
}, intervalMs);

// immediate run once
(async () => {
  try {
    await sendAutoReport();
  } catch (e) {
    console.warn("initial send failed", e?.message || e);
  }
})();

// Keep-alive ping to SELF_PING_URL
if (CONFIG.SELF_PING_URL) {
  setInterval(async () => {
    try {
      await axiosInstance.get(CONFIG.SELF_PING_URL);
      console.log("KeepAlive ping success");
    } catch (e) {
      console.warn("KeepAlive failed", e?.message || e);
    }
  }, 5 * 60_000);
}

export default { sendAutoReport };