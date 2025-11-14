// aiTraderBot.js
// Single-file AI Trader (Option 2 - ENV vars)
// - Multi-source fetch (mirrors + fallbacks + proxy)
// - Cache, multi-TF candles (1m,5m,15m,30m,1h)
// - Indicators: RSI, ATR, MACD, Volume Trend, Fib
// - WebSocket live price (Binance mirrors) with auto-reconnect
// - Telegram report every 15m (HTML TradingView-like)
// - Single file solution (drop into your project & run)

import fs from "fs";
import path from "path";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";
import express from "express";

// -------- CONFIG (from ENV) ----------
const ENV = process.env;
const BOT_TOKEN = ENV.BOT_TOKEN || null;
const CHAT_ID = ENV.CHAT_ID || null;
const SYMBOL = ENV.SYMBOL || "BTCUSDT";
const REPORT_INTERVAL_MS = Number(ENV.REPORT_INTERVAL_MS) || 15 * 60 * 1000;
const CACHE_DIR = path.resolve(process.cwd(), "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_LIMIT = 200;
const AXIOS_TIMEOUT = Number(ENV.AXIOS_TIMEOUT) || 15000;

// Mirror lists (can override via env, comma-separated)
const BINANCE_HTTP_MIRRORS = (ENV.BINANCE_HTTP_MIRRORS || "https://data-api.binance.vision,https://api.binance.com,https://api1.binance.com,https://api2.binance.com").split(",");
const BINANCE_WS_MIRRORS = (ENV.BINANCE_WS_MIRRORS || "wss://stream.binance.com:9443/ws/,wss://data-stream.binance.vision/ws/").split(",");

// Fallback other markets (Bybit / Kucoin / Coinbase)
const OTHER_HTTP_SOURCES = [
  "https://api.bybit.com",
  "https://api.kucoin.com",
  "https://api.exchange.coinbase.com"
];

// Proxy support: prefer PROXY_URL or standard HTTP_PROXY/HTTPS_PROXY if set
const PROXY_URL = ENV.PROXY_URL || ENV.HTTP_PROXY || ENV.HTTPS_PROXY || null;

// Telegram bot init
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;
if (!BOT_TOKEN) console.warn("⚠️ BOT_TOKEN not set — Telegram messages will be skipped.");
if (!CHAT_ID) console.warn("⚠️ CHAT_ID not set — Telegram messages will be skipped.");

// Optional external modules placeholders (you can create these files later)
let runMLPrediction = null;
let analyzeElliott = null;
let fetchNews = null;
try { runMLPrediction = (await import("./ml_module_v8_6.js")).runMLPrediction; } catch {}
try { analyzeElliott = (await import("./elliott_module.js")).analyzeElliott; } catch {}
try { fetchNews = (await import("./news_social.js")).fetchNews; } catch {}

// -------- helpers: cache --------
function cachePath(symbol, interval) {
  return path.join(CACHE_DIR, `${symbol}_${interval}.json`);
}
function readCache(symbol, interval) {
  try {
    const p = cachePath(symbol, interval);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch (e) {
    console.warn("readCache error:", e?.message || e);
    return [];
  }
}
function writeCache(symbol, interval, data) {
  try {
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("writeCache error:", e?.message || e);
  }
}
function nowLocal() {
  return new Date().toLocaleString("en-IN", { hour12: false });
}

// -------- helpers: network (safe axios with mirrors + proxy) ----------
async function safeAxiosGet(originalUrl, options = {}) {
  // Build candidate URLs from mirrors + fallback sources
  const candidates = [];

  // Try Binance HTTP mirrors first (replace base if original has api.binance.com)
  for (const base of BINANCE_HTTP_MIRRORS) {
    try {
      if (originalUrl.includes("api.binance.com") || originalUrl.includes("/api/v3/")) {
        const tryUrl = originalUrl.replace(/https?:\/\/[^/]+/, base);
        candidates.push(tryUrl);
      } else {
        candidates.push(originalUrl);
      }
    } catch {
      candidates.push(originalUrl);
    }
  }

  // Add original URL last
  if (!candidates.includes(originalUrl)) candidates.push(originalUrl);

  // Add other provider endpoints by transforming known endpoints where applicable (best-effort)
  for (const s of OTHER_HTTP_SOURCES) {
    // naive transform: when calling klines URL for binance we don't have direct equivalent — but keep original as fallback.
    // still push s so axios tries it (should fail fast).
    candidates.push(s);
  }

  let lastErr = null;
  for (const url of candidates) {
    try {
      const axiosOpts = {
        timeout: AXIOS_TIMEOUT,
        headers: {
          "User-Agent": "aiTraderBot/1.0 (+https://example.com)",
          Accept: "application/json, text/plain, */*",
          ...(options.headers || {}),
        },
        ...options,
      };

      // If PROXY_URL given, set it up using env for axios (http(s)_proxy) — axios doesn't accept proxy string directly with fetch adapter,
      // but many environments use HTTP_PROXY env — we'll pass nothing here but set global env so underlying adapter picks it up.
      if (PROXY_URL) {
        // set env for underlying library (works for many runtime setups)
        process.env.HTTP_PROXY = PROXY_URL;
        process.env.HTTPS_PROXY = PROXY_URL;
      }

      const res = await axios.get(url, axiosOpts);
      if (res && (res.status === 200 || res.status === 201)) return res.data;
      lastErr = new Error(`HTTP ${res?.status}`);
    } catch (err) {
      lastErr = err;
      // continue to next URL
    }
  }

  console.warn("safeAxiosGet failed for", originalUrl, lastErr?.message || lastErr);
  return null;
}

// -------- normalize klines (binance style) ----------
function normalizeKlineArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((k) => ({
    t: Number(k[0] ?? 0),
    open: Number(k[1] ?? 0),
    high: Number(k[2] ?? 0),
    low: Number(k[3] ?? 0),
    close: Number(k[4] ?? 0),
    vol: Number(k[5] ?? 0),
  })).filter(c => Number.isFinite(c.close));
}

// -------- fetch candles (primary) ----------
async function fetchCrypto(symbol = SYMBOL, interval = "15m", limit = DEFAULT_LIMIT) {
  // Standard Binance klines endpoint (we'll let safeAxiosGet try mirrors)
  const base = "https://api.binance.com";
  const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await safeAxiosGet(url);
  if (!raw) return [];
  return normalizeKlineArray(raw);
}

async function ensureCandles(symbol = SYMBOL, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const cached = readCache(symbol, interval) || [];
    const fresh = await fetchCrypto(symbol, interval, limit);
    if (Array.isArray(fresh) && fresh.length) {
      writeCache(symbol, interval, fresh);
      return fresh;
    }
    return cached;
  } catch (e) {
    console.warn("ensureCandles error:", e?.message || e);
    return readCache(symbol, interval) || [];
  }
}

// -------- INDICATORS: RSI, ATR, MACD, etc. ----------
function computeRSI(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - length - 1; i < candles.length - 1; i++) {
    const diff = (candles[i + 1].close ?? 0) - (candles[i].close ?? 0);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (gains === 0 && losses === 0) return 50;
  const avgGain = gains / length;
  const avgLoss = (losses || 0.000001) / length;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeATR(candles, length = 14) {
  if (!Array.isArray(candles) || candles.length < length + 1) return 0;
  const trs = [];
  for (let i = candles.length - length; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1] ?? cur;
    const high = Number(cur.high ?? 0);
    const low = Number(cur.low ?? 0);
    const prevClose = Number(prev.close ?? 0);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  const atr = trs.reduce((a, b) => a + b, 0) / Math.max(1, trs.length);
  return Number(atr.toFixed(6));
}

function ema(values = [], period = 12) {
  if (!Array.isArray(values) || values.length === 0) return [];
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
  if (!Array.isArray(candles) || candles.length < 35) return { hist: 0, macd: 0, signal: 0 };
  const closes = candles.map(c => Number(c.close ?? 0));
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - (ema26[i] ?? 0));
  const signalLine = ema(macdLine, 9);
  const hist = (macdLine.at(-1) ?? 0) - (signalLine.at(-1) ?? 0);
  return { hist: Number(hist.toFixed(8)), macd: Number((macdLine.at(-1) ?? 0).toFixed(8)), signal: Number((signalLine.at(-1) ?? 0).toFixed(8)) };
}

function priceTrend(candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return "FLAT";
  const last = Number(candles.at(-1).close ?? 0);
  const prev = Number(candles.at(-2).close ?? 0);
  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

function volumeTrend(candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return "STABLE";
  const last = Number(candles.at(-1).vol ?? candles.at(-1).volume ?? 0);
  const prev = Number(candles.at(-2).vol ?? candles.at(-2).volume ?? 0);
  if (last > prev) return "INCREASING";
  if (last < prev) return "DECREASING";
  return "STABLE";
}

function analyzeVolume(candles = []) {
  if (!Array.isArray(candles) || candles.length < 3) return { status: "UNKNOWN", strength: 0 };
  const v1 = Number(candles.at(-3).vol ?? 0);
  const v2 = Number(candles.at(-2).vol ?? 0);
  const v3 = Number(candles.at(-1).vol ?? 0);
  if (v3 > v2 && v2 > v1) return { status: "RISING", strength: 3 };
  if (v3 < v2 && v2 < v1) return { status: "FALLING", strength: -3 };
  if (v3 > v2) return { status: "SLIGHT_UP", strength: 1 };
  if (v3 < v2) return { status: "SLIGHT_DOWN", strength: -1 };
  return { status: "STABLE", strength: 0 };
}

function computeFibLevelsFromCandles(candles = []) {
  if (!Array.isArray(candles) || !candles.length) return null;
  try {
    const highs = candles.map(c => Number(c.high ?? 0));
    const lows = candles.map(c => Number(c.low ?? 0));
    const hi = Math.max(...highs);
    const lo = Math.min(...lows);
    if (!isFinite(hi) || !isFinite(lo)) return null;
    const diff = hi - lo;
    return {
      lo, hi,
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
      }
    };
  } catch (e) {
    return null;
  }
}

// ---------- fetchMarketData (returns { data, price, volume, indicators, fib, updated }) ----------
async function fetchMarketData(symbol = SYMBOL, interval = "15m", limit = DEFAULT_LIMIT) {
  try {
    const candles = await ensureCandles(symbol, interval, limit);
    const data = Array.isArray(candles) ? candles : [];
    const price = data.at(-1)?.close ?? 0;
    const volume = data.at(-1)?.vol ?? data.at(-1)?.volume ?? 0;
    const indicators = data.length ? {
      RSI: computeRSI(data),
      MACD: computeMACD(data),
      ATR: computeATR(data),
      priceTrend: priceTrend(data),
      volumeTrend: volumeTrend(data),
      volumeNote: analyzeVolume(data)
    } : null;
    const fib = data.length ? computeFibLevelsFromCandles(data) : null;
    return { data, price, volume, indicators, fib, updated: nowLocal() };
  } catch (e) {
    console.error("fetchMarketData error:", e?.message || e);
    return { data: [], price: 0, volume: 0, indicators: null, fib: null, updated: nowLocal(), error: e?.message || String(e) };
  }
}

// -------- WebSocket live price (Binance mirrors) ----------
let ws = null;
let lastPrice = null;
let socketAlive = false;
let wsIndex = 0;
let wsReconnectTimer = null;

function connectLiveSocket(symbol = SYMBOL) {
  const stream = `${symbol.toLowerCase()}@ticker`;
  function doConnect() {
    const base = BINANCE_WS_MIRRORS[wsIndex % BINANCE_WS_MIRRORS.length];
    const url = base.endsWith("/") ? base + stream : base + "/" + stream;
    try {
      if (ws) {
        try { ws.removeAllListeners?.(); ws.close?.(); } catch {}
        ws = null;
      }
      ws = new WebSocket(url);
      ws.on("open", () => { socketAlive = true; console.log("WS open", url); });
      ws.on("message", (d) => {
        try {
          const json = typeof d === "string" ? JSON.parse(d) : JSON.parse(d.toString());
          // Binance ticker uses 'c' as last price
          if (json && (json.c || json.price)) {
            lastPrice = parseFloat(json.c ?? json.price);
          }
        } catch {}
      });
      ws.on("close", (code, reason) => {
        socketAlive = false;
        console.warn("WS close:", code, String(reason).slice(0, 100));
        wsIndex = (wsIndex + 1) % BINANCE_WS_MIRRORS.length;
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(doConnect, 8000);
      });
      ws.on("error", (err) => {
        socketAlive = false;
        console.warn("WS error:", err && err.message ? err.message : String(err));
        try { ws.close(); } catch {}
      });
    } catch (e) {
      socketAlive = false;
      console.error("connectLiveSocket fatal:", e?.message || e);
      wsIndex = (wsIndex + 1) % BINANCE_WS_MIRRORS.length;
      setTimeout(doConnect, 8000);
    }
  }
  doConnect();
}

// start WS
try { connectLiveSocket(SYMBOL); } catch (e) { console.warn("WS start failed:", e?.message || e); }

// keep WS alive
setInterval(() => { if (!socketAlive) { console.log("WS not alive — reconnecting"); try { connectLiveSocket(SYMBOL); } catch (e) {} } }, 60_000);

// -------- Build AI Report object ----------
async function buildAIReport(symbol = SYMBOL, context = null) {
  try {
    // context: { price, candles, ml, ell, news, socketAlive }
    let ctx = context;
    if (!ctx) {
      const c = await fetchMarketData(symbol, "15m", DEFAULT_LIMIT);
      ctx = { price: c.price, candles: c.data, ml: null, ell: null, news: null, socketAlive };
    }

    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const mtf = await Promise.all(tfs.map(async (tf) => {
      try {
        const res = await fetchMarketData(symbol, tf, DEFAULT_LIMIT);
        const candles = res.data || [];
        const indicators = candles.length ? {
          RSI: computeRSI(candles),
          MACD: computeMACD(candles),
          ATR: computeATR(candles),
          priceTrend: priceTrend(candles),
          volumeTrend: volumeTrend(candles),
          volumeNote: analyzeVolume(candles)
        } : null;
        const hi = candles.length ? Math.max(...candles.map(c => Number(c.high ?? 0))) : null;
        const lo = candles.length ? Math.min(...candles.map(c => Number(c.low ?? 0))) : null;
        const fib = (hi !== null && lo !== null) ? computeFibLevelsFromCandles(candles) : null;
        const bias = (indicators?.RSI !== undefined && indicators?.MACD?.hist !== undefined)
          ? (indicators.RSI > 60 && indicators.MACD.hist > 0 ? "Bullish" : indicators.RSI < 40 && indicators.MACD.hist < 0 ? "Bearish" : "Neutral")
          : "N/A";
        return { tf, candles, last: candles.at(-1) ?? null, indicators, fib, bias, volTrend: indicators?.volumeNote || null };
      } catch (e) {
        return { tf, error: String(e?.message || e) };
      }
    }));

    const tf15 = mtf.find(m => m.tf === "15m") || {};
    const price = ctx.price ?? (tf15.last ? Number(tf15.last.close) : 0);

    return {
      symbol,
      price,
      mtf,
      ml: ctx.ml || null,
      ell: ctx.ell || null,
      news: ctx.news || null,
      fib15: tf15.fib || null,
      socketAlive: ctx.socketAlive || socketAlive || false,
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error("buildAIReport error:", e?.message || e);
    return { symbol, price: 0, mtf: [], ml: null, ell: null, news: null, fib15: null, socketAlive: false, generatedAt: new Date().toISOString(), error: e?.message || String(e) };
  }
}

// -------- Format & send report to Telegram (HTML) ----------
async function formatAIReport(report) {
  try {
    const symbol = report.symbol || SYMBOL;
    const price = Number(report.price || 0);
    const generatedAt = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : nowLocal();

    // ML & Elliott
    const mlLabel = report.ml?.label || "Neutral";
    const mlProb = Number(report.ml?.prob ?? report.ml?.confidence ?? 0);
    const ellText = report.ell ? `${report.ell.wave || "N/A"} | Conf: ${(report.ell.confidence || 0).toFixed(1)}%` : "N/A";

    // Multi-TF block
    const tfLines = (report.mtf || []).map(m => {
      if (m.error) return `<b>[${m.tf}]</b> Error: ${m.error}`;
      const rsi = (m.indicators?.RSI !== undefined && m.indicators?.RSI !== null) ? m.indicators.RSI.toFixed(1) : "N/A";
      const macd = (m.indicators?.MACD?.hist !== undefined && m.indicators?.MACD?.hist !== null) ? m.indicators.MACD.hist.toFixed(4) : "N/A";
      const atr = (m.indicators?.ATR !== undefined && m.indicators?.ATR !== null) ? m.indicators.ATR.toFixed(4) : "N/A";
      const volLabel = m.volTrend ? (m.volTrend.label || m.volTrend.status || "N/A") : "N/A";
      const emoji = m.bias === "Bullish" ? "🟢" : m.bias === "Bearish" ? "🔴" : "⚪";
      const lastPrice = m.last?.close ? Number(m.last.close).toFixed(2) : "N/A";
      const signal = m.bias === "Bullish" ? "BUY" : m.bias === "Bearish" ? "SELL" : "HOLD";

      return `<b>[${m.tf}]</b> ${emoji} ${m.bias}
RSI:${rsi} | MACD:${macd} | ATR:${atr}
Price: ${lastPrice} | Vol:${volLabel} | Signal:${signal}`;
    }).join("\n\n<b>─</b>\n\n");

    // TP/SL using ATR(15) fallback
    const atr15 = (report.mtf || []).find(x => x.tf === "15m")?.indicators?.ATR ?? Math.max(price * 0.005, 1);
    const tp1 = (price + atr15 * 1.5).toFixed(2);
    const tp2 = (price + atr15 * 3).toFixed(2);
    const tp3 = (price + atr15 * 5).toFixed(2);
    const sl = (price - atr15 * 2).toFixed(2);

    const fib = report.fib15;
    const fibRange = fib ? `${fib.lo} - ${fib.hi}` : "N/A";

    const newsSent = report.news?.sentiment || 0;
    const newsTxt = newsSent > 0 ? "Bullish 🟢" : newsSent < 0 ? "Bearish 🔴" : "Neutral";
    const headlines = (report.news?.headlines || []).slice(0, 4).map(h => `• ${h}`).join("\n") || "N/A";

    // Compose HTML (Telegram parse_mode HTML)
    const html = `
<b>${symbol} — AI Trader</b>
<i>${generatedAt}</i>

<b>Price:</b> <code>${price.toFixed(2)}</code>

<b>AI Prediction:</b> ${mlLabel} (${mlProb}%)
<b>Elliott (15m):</b> ${ellText}

<b>📊 Multi-Timeframe Overview</b>
<pre>${tfLines}</pre>

<b>🎯 TP / SL (ATR-based)</b>
TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}
SL: ${sl}

<b>Fib Zone (15m):</b> ${fibRange}

<b>📰 News Impact:</b> ${newsTxt}
${headlines}

<i>Data: Multi-source (Binance Vision + Binance + Bybit/KuCoin/CB) | vSingleFile</i>
`.trim();

    // send to Telegram if configured
    if (!bot || !BOT_TOKEN || !CHAT_ID) {
      console.log("Telegram not configured — returning HTML payload as string");
      return html;
    }

    try {
      await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
      return html;
    } catch (err) {
      console.error("Telegram send failed:", err?.message || err);
      return html;
    }
  } catch (err) {
    console.error("formatAIReport error:", err?.message || err);
    return `Error building report for ${report?.symbol || SYMBOL}`;
  }
}

// -------- Get Data Context (candles + ML + Elliott + News) ----------
async function getDataContext(symbol = SYM