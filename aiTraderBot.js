// aiTraderBot.js — Unified AI Trader Core (v11.0, Render-safe)
// Expects other modules in project root:
// ./config.js, ./utils.js, ./core_indicators.js, ./elliott_module.js,
// ./ml_module_v8_6.js, ./merge_signals.js, ./news_social.js, ./tg_commands.js

import express from "express";
import axios from "axios";
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals, recordFeedback } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot as setupTGHandlers, sendTelegramMessage as tgSendFromModule } from "./tg_commands.js";

// ---------- Server & KeepAlive ----------
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
});

// ensure periodic keepalive pings
setInterval(() => {
  try { keepAlive(CONFIG.SELF_PING_URL); } catch(e) { console.warn("keepAlive err", e.message); }
}, 10 * 60 * 1000);

// ---------- Safe helpers ----------
const safeNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const lastOf = arr => Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
const ensureCandles = (raw) => {
  // Try to reuse fetchMarketData normalization if it returns arrays of objects.
  if (!raw) return [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "object" && raw[0].close !== undefined) return raw;
  // fallback: if binance-style arrays
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return raw.map(r => ({
      t: Number(r[0]),
      open: safeNum(r[1]),
      high: safeNum(r[2]),
      low: safeNum(r[3]),
      close: safeNum(r[4]),
      vol: safeNum(r[5])
    })).filter(c => !Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }
  // object -> flatten
  if (typeof raw === "object") {
    const vals = Object.values(raw).flat(Infinity);
    return vals.map(v => {
      if (!v) return null;
      return {
        t: safeNum(v.t ?? v[0], 0),
        open: safeNum(v.open ?? v[1]),
        high: safeNum(v.high ?? v[2]),
        low: safeNum(v.low ?? v[3]),
        close: safeNum(v.close ?? v[4]),
        vol: safeNum(v.vol ?? v[5] ?? v.volume)
      };
    }).filter(Boolean).filter(c => !Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }
  return [];
};

// ---------- Hybrid target calculator ----------
export function computeHybridTargets({
  lastPrice,
  candles = [],
  ell = {},
  ml = { prob: 50, label: "Neutral" },
  merged = { bias: "Neutral", strength: 0, mlProb: 50 },
  newsImpactScore = 0,
  atr = 0.0,
  pricePrecision = 2
} = {}) {
  lastPrice = safeNum(lastPrice, lastOf(candles)?.close ?? 0);
  atr = Math.max(0.0001, safeNum(atr, 0));
  const lookback = Math.min(120, Math.max(10, candles.length));
  const slice = (candles || []).slice(-lookback);
  let baseLow = slice.length ? Math.min(...slice.map(c => safeNum(c.low, lastPrice))) : lastPrice;
  let baseHigh = slice.length ? Math.max(...slice.map(c => safeNum(c.high, lastPrice))) : lastPrice;

  // prefer Elliott pivots if available
  try {
    if (ell?.lastLow?.p && ell?.lastHigh?.p) {
      const l = Number(ell.lastLow.p);
      const h = Number(ell.lastHigh.p);
      if (l && h) {
        baseLow = Math.min(baseLow, l);
        baseHigh = Math.max(baseHigh, h);
      }
    }
  } catch (e) { /* ignore */ }

  const move = baseHigh - baseLow || lastPrice * 0.005 || atr * 2;
  const fibExt = (start, end) => {
    const m = end - start;
    return { ext100: end + m * 1.0, ext127: end + m * 1.272, ext161: end + m * 1.618 };
  };

  const bullishExt = fibExt(baseLow, baseHigh);
  const bearishExt = fibExt(baseHigh, baseLow);

  // ML prob normalize 0..100
  let mlProb = safeNum(ml.prob, safeNum(merged.mlProb, 50));
  if (mlProb <= 1.01) mlProb = mlProb * 100;
  mlProb = Math.max(0, Math.min(100, mlProb));

  const strength = Math.max(0, Math.min(1, safeNum(merged.strength, 0) / 100));
  const ellConf = Math.max(0, Math.min(1, safeNum(ell.confidence, 0) / 100));

  // weights
  const w = { ml: 0.45, merged: 0.35, ell: 0.20 };
  const mlSignal = (mlProb / 100 - 0.5) * 2; // -1..1

  const bullishBaseScore = Math.max(0, Math.max(0, mlSignal) * w.ml + strength * w.merged + ellConf * w.ell);
  const bearishBaseScore = Math.max(0, Math.max(0, -mlSignal) * w.ml + strength * w.merged + ellConf * w.ell);

  const biasLower = (merged && merged.bias) ? String(merged.bias).toLowerCase() : "neutral";
  const newsPenaltyForBull = (biasLower === "sell") ? Math.min(0.5, newsImpactScore) : 0;
  const newsPenaltyForBear = (biasLower === "buy") ? Math.min(0.5, newsImpactScore) : 0;

  const bullishScore = Math.max(0, bullishBaseScore - newsPenaltyForBull);
  const bearishScore = Math.max(0, bearishBaseScore - newsPenaltyForBear);

  const recommended = (bullishScore > bearishScore + 0.03) ? "Buy" : (bearishScore > bullishScore + 0.03 ? "Sell" : "Neutral");
  const confidencePct = Math.round(Math.max(bullishScore, bearishScore) * 1000) / 10;

  // Build targets (ensure separation)
  const size = Math.max(Math.abs(move), atr, lastPrice * 0.002);

  const buy = {
    tp1: Number((bullishExt.ext100).toFixed(pricePrecision)),
    tp2: Number((bullishExt.ext127).toFixed(pricePrecision)),
    tp3: Number((bullishExt.ext161).toFixed(pricePrecision)),
    sl: Number((Math.max(0, baseLow - Math.max(size * 0.6, atr * 1.2))).toFixed(pricePrecision)),
    score: Math.round(bullishScore * 1000) / 10,
    explanation: `Bull base ${baseLow.toFixed(pricePrecision)}→${baseHigh.toFixed(pricePrecision)} (ell:${Math.round(ellConf*100)}% ml:${Math.round(mlProb)}% tech:${Math.round(strength*100)}%)`
  };
  const sell = {
    tp1: Number((bearishExt.ext100).toFixed(pricePrecision)),
    tp2: Number((bearishExt.ext127).toFixed(pricePrecision)),
    tp3: Number((bearishExt.ext161).toFixed(pricePrecision)),
    sl: Number((Math.min(baseHigh + Math.max(size * 0.6, atr * 1.2), lastPrice + Math.max(size, atr * 2))).toFixed(pricePrecision)),
    score: Math.round(bearishScore * 1000) / 10,
    explanation: `Bear base ${baseHigh.toFixed(pricePrecision)}→${baseLow.toFixed(pricePrecision)} (ell:${Math.round(ellConf*100)}% ml:${Math.round(100-mlProb)}% tech:${Math.round(strength*100)}%)`
  };

  // sanitize minimal separation
  const minMove = Math.max(Math.abs(lastPrice) * 0.002, atr || Math.abs(move) * 0.02);
  function sanitize(side, isBuy) {
    if (isBuy) {
      if (side.tp1 <= lastPrice + minMove) side.tp1 = Number((lastPrice + minMove).toFixed(pricePrecision));
      if (side.tp2 <= side.tp1 + minMove) side.tp2 = Number((side.tp1 + minMove).toFixed(pricePrecision));
      if (side.tp3 <= side.tp2 + minMove) side.tp3 = Number((side.tp2 + minMove).toFixed(pricePrecision));
    } else {
      if (side.tp1 >= lastPrice - minMove) side.tp1 = Number((lastPrice - minMove).toFixed(pricePrecision));
      if (side.tp2 >= side.tp1 - minMove) side.tp2 = Number((side.tp1 - minMove).toFixed(pricePrecision));
      if (side.tp3 >= side.tp2 - minMove) side.tp3 = Number((side.tp2 - minMove).toFixed(pricePrecision));
    }
  }
  sanitize(buy, true); sanitize(sell, false);

  const verdict = {
    recommended,
    confidencePct,
    buy, sell,
    details: { lastPrice, baseLow, baseHigh, atr, mlProb, strength, ellConf, newsImpactScore }
  };

  return verdict;
}

// ---------- Multi-timeframe builder ----------
async function buildMultiTimeframeIndicators(symbol) {
  const intervals = CONFIG.INTERVALS || ["1m","5m","15m","30m","1h"];
  const result = {};
  for (const tf of intervals) {
    try {
      const resp = await fetchMarketData(symbol, tf, 500);
      const candles = ensureCandles(resp.data || resp || []);
      if (!candles.length) {
        result[tf] = { price: "N/A", vol: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", bias: "N/A" };
        continue;
      }
      const last = lastOf(candles);
      // compute indicators using arrays of closes for indicator functions
      const closes = candles.map(c => c.close);
      const rsiVal = (typeof calculateRSI === "function") ? calculateRSI(closes, 14) : NaN;
      let rsi = Number.isFinite(Number(rsiVal)) ? Number(rsiVal) : (Array.isArray(rsiVal) ? rsiVal.at(-1) : NaN);
      const macdObj = calculateMACD(closes, 12, 26, 9);
      let macd = NaN;
      if (macdObj) {
        if (typeof macdObj === "number") macd = macdObj;
        else if (Array.isArray(macdObj)) {
          const ei = macdObj.at(-1);
          macd = (typeof ei === "object" ? (ei.macd ?? ei.hist ?? NaN) : ei);
        } else if (typeof macdObj === "object") {
          macd = Array.isArray(macdObj.histogram) ? macdObj.histogram.at(-1) : (macdObj.macd ?? NaN);
        }
      }
      // ATR approx
      const look = candles.slice(-14);
      const atr = look.reduce((s,c,i,arr) => s + (c.high - c.low), 0) / Math.max(1, look.length - 1);

      // bias
      let bias = "Sideways";
      if (!Number.isNaN(rsi) && !Number.isNaN(macd)) {
        if (rsi > 60 && macd > 0) bias = "Bullish";
        else if (rsi < 40 && macd < 0) bias = "Bearish";
      }

      result[tf] = {
        price: safeNum(last.close, 0).toFixed(2),
        vol: String(safeNum(last.vol || last.volume || 0)),
        rsi: Number.isFinite(Number(rsi)) ? Number(rsi).toFixed(2) : "N/A",
        macd: Number.isFinite(Number(macd)) ? Number(macd).toFixed(3) : "N/A",
        atr: Number.isFinite(Number(atr)) ? atr.toFixed(3) : "N/A",
        bias
      };
    } catch (e) {
      console.warn("buildMultiTF", tf, e.message || e);
      result[tf] = { price: "N/A", vol: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", bias: "N/A" };
    }
  }
  return result;
}

// ---------- Build the full report (exported) ----------
export async function buildReport(symbol = CONFIG.SYMBOL || "BTCUSDT", interval = "15m") {
  try {
    // fetch main candles (prefer multi-source fetchMarketData)
    const resp = await fetchMarketData(symbol, interval, CONFIG.ML?.LOOKBACK || 500);
    const candles = ensureCandles(resp.data || resp || []);
    if (!candles.length) {
      console.warn("No candles for", symbol, interval);
      return { text: `⚠️ No data for ${symbol} ${interval} at ${nowLocal()}` };
    }
    const last = lastOf(candles);

    // indicators
    let rsi = null, macd = null, ell = {}, ml = { prob: 50 }, merged = { bias: "Neutral", strength: 0, mlProb: 50 }, news = { impact: "Low", score: 0, headlines: [] };
    try { rsi = calculateRSI(candles.map(c=>c.close), 14); } catch(e) { console.warn("RSI err", e.message || e); }
    try { macd = calculateMACD(candles.map(c=>c.close), 12, 26, 9); } catch(e) { console.warn("MACD err", e.message || e); }
    try { ell = await analyzeElliott(candles) || {}; } catch(e) { console.warn("Elliott err", e.message || e); }
    try { ml = await runMLPrediction(candles) || ml; } catch(e) { console.warn("ML err", e.message || e); }
    try { merged = mergeSignals({ rsi, macd }, ell, ml) || merged; } catch(e) { console.warn("mergeSignals err", e.message || e); }
    try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol) || news; } catch(e) { console.warn("news err", e.message || e); }

    // multi-TF snapshot
    const multiTF = await buildMultiTimeframeIndicators(symbol);

    // ATR
    const recent = candles.slice(-20);
    let atr = 0;
    for (let i = 1; i < recent.length; i++) {
      const p = recent[i-1], c = recent[i];
      atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    atr = atr / Math.max(1, recent.length - 1);

    // compute hybrid targets using 15m candles
    const hybrid = computeHybridTargets({
      lastPrice: last.close,
      candles,
      ell,
      ml,
      merged,
      newsImpactScore: safeNum(news.score, 0) / 100,
      atr,
      pricePrecision: 2
    });

    // format Telegram message UI (same format you wanted)
    let text = "";
    text += "━━━━━━━━━━━━━━━━━━━\n";
    text += `🚀 <b>${symbol}</b> — <b>AI Trader v11.0</b>\n`;
    text += `🕒 ${nowLocal()}\n`;
    text += `📡 Source: ${resp.source || "multi-source"}\n`;
    text += `💰 <b>Price:</b> ${safeNum(last.close).toFixed(2)}\n`;
    text += "━━━━━━━━━━━━━━━━━━━\n";

    for (const tf of Object.keys(multiTF)) {
      const r = multiTF[tf];
      text += `📊 <b>${tf}</b> | ${r.bias}\n`;
      text += `💵 Price: ${r.price} | Vol: ${r.vol}\n`;
      text += `📈 RSI: ${r.rsi} | MACD: ${r.macd} | ATR: ${r.atr}\n`;
      text += "━━━━━━━━━━━━━━━━━━━\n";
    }

    text += `🧭 <b>Overall Bias:</b> ${merged.bias} | Strength: ${merged.strength}% | 🤖 ML Prob: ${merged.mlProb ?? ml.prob ?? 50}%\n`;
    text += `🎯 TP1: ${hybrid.buy.tp1} | TP2: ${hybrid.buy.tp2} | TP3: ${hybrid.buy.tp3} | SL: ${hybrid.buy.sl}\n`;
    text += `📉 Sell TP1: ${hybrid.sell.tp1} | TP2: ${hybrid.sell.tp2} | TP3: ${hybrid.sell.tp3} | SL: ${hybrid.sell.sl}\n`;
    text += `🔎 Recommendation: <b>${hybrid.recommended}</b> (Conf: ${hybrid.confidencePct}%)\n`;
    text += "━━━━━━━━━━━━━━━━━━━\n";
    text += `📰 News Impact: ${news.impact ?? "N/A"} (score ${safeNum(news.score, 0)})\n`;
    if (Array.isArray(news.headlines) && news.headlines.length) {
      text += "🗞️ Top headlines:\n• " + news.headlines.slice(0,5).join("\n• ") + "\n";
    }
    text += `\nSources: Multi-source (config)\n`;
    text += "━━━━━━━━━━━━━━━━━━━\n";

    return { text, hybrid, meta: { merged, ell, ml, news } };
  } catch (e) {
    console.error("buildReport error:", e.message || e);
    return { text: `❌ Error building report: ${e.message || e}` };
  }
}

// ---------- Telegram send helper (safe) ----------
// Use module tg_commands' send if provided and bot is active;
// else use direct HTTP Telegram API (no polling) to avoid 409.
async function safeSendTelegram(msg) {
  try {
    // prefer module-based send (which may use bot instance)
    if (typeof tgSendFromModule === "function") {
      const r = await tgSendFromModule(msg);
      if (r) return r;
    }
  } catch (e) {
    console.warn("tg module send failed:", e.message || e);
  }

  // fallback: direct send using BOT_TOKEN/CHAT_ID (no polling)
  try {
    const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
    const chat = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
    if (!token || !chat) {
      console.warn("Telegram token/chat missing for fallback send");
      return null;
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = { chat_id: chat, text: msg, parse_mode: "HTML", disable_web_page_preview: false };
    const res = await axios.post(url, payload, { timeout: 8000 });
    return res.data;
  } catch (e) {
    console.warn("Direct Telegram send failed:", e.message || e);
    return null;
  }
}

// ---------- Auto 15-minute updates ----------
async function autoUpdateLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL || process.env.SYMBOL || "BTCUSDT", "15m");
    if (!out || !out.text) {
      console.warn("Auto update: no report");
      return;
    }
    await safeSendTelegram(out.text);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (e) {
    console.error("Auto update error:", e.message || e);
  }
}

// run immediately + scheduler
(async () => {
  // init Telegram handlers if available but avoid getUpdates conflict:
  try {
    // Only initialize polling handlers if explicit env flag set
    const enablePolling = (process.env.TELEGRAM_POLLING || "").toLowerCase() === "true";
    if (enablePolling) {
      // setup Telegram command handlers which use node-telegram-bot-api polling internally
      try {
        await setupTGHandlers();
        console.log("📱 Telegram handlers initialized (polling enabled).");
      } catch (e) {
        console.warn("setupTGHandlers failed:", e.message || e);
      }
    } else {
      console.log("📱 Telegram polling disabled — using send-only fallback (avoids 409). Set TELEGRAM_POLLING=true to enable interactive handlers.");
    }
  } catch (e) {
    console.warn("Telegram init warning:", e.message || e);
  }

  // run immediate update and schedule
  try { await autoUpdateLoop(); } catch(e){ console.warn("initial autoUpdateLoop err", e.message || e); }
  setInterval(autoUpdateLoop, (CONFIG.REPORT_INTERVAL_MS || (15 * 60 * 1000)));

  // Reversal watcher (1m) - lightweight: checks patterns + ML quick-run
  setInterval(async () => {
    try {
      const resp = await fetchMarketData(CONFIG.SYMBOL || "BTCUSDT", "1m", 160);
      const candles = ensureCandles(resp.data || resp || []);
      if (!candles.length) return;
      const last = lastOf(candles);
      const prev = candles.length > 1 ? candles[candles.length-2] : last;
      const avgVol = candles.slice(-20).reduce((s,c)=>s+(c.vol||0),0) / Math.max(1, Math.min(20, candles.length));
      const volSpike = (last.vol || 0) > avgVol * 1.8;

      // detect simple candle pattern
      const body = Math.abs(last.close - last.open);
      const range = Math.max(1, (last.high - last.low));
      const isDoji = body <= range * 0.15;
      const lowerWick = Math.min(last.open, last.close) - last.low;
      const upperWick = last.high - Math.max(last.open, last.close);
      const isHammer = lowerWick / range > 0.4 && upperWick / range < 0.25 && last.close > prev.close;
      const isShooting = upperWick / range > 0.4 && lowerWick / range < 0.25 && last.close < prev.close;

      // quick ML
      let mlRes = { prob: 50 };
      try { mlRes = await runMLPrediction(candles.slice(-40)) || mlRes; } catch(e){ /* ignore */ }
      const mlConf = mlRes && mlRes.prob ? (mlRes.prob <= 1 ? mlRes.prob * 100 : mlRes.prob) : 50;

      const mlDir = mlConf > 60 ? "bull" : mlConf < 40 ? "bear" : "neutral";
      const pattDir = isHammer ? "bull" : isShooting ? "bear" : (isDoji ? "neutral" : "neutral");
      const shouldAlert = (isHammer || isShooting || isDoji) && (volSpike || (mlDir !== "neutral" && mlDir === pattDir));

      if (shouldAlert) {
        const dirText = isHammer ? "Bullish Hammer" : isShooting ? "Shooting Star (Bearish)" : "Doji";
        const msg = `🚨 <b>Reversal Watcher</b>\n${nowLocal()}\nSymbol: <b>${CONFIG.SYMBOL}</b>\nPattern: <b>${dirText}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.vol||0)} (avg ${Math.round(avgVol)})\nML Prob: ${Math.round(mlConf)}%`;
        await safeSendTelegram(msg);
      }
    } catch (e) {
      console.warn("reversal watcher err:", e.message || e);
    }
  }, (process.env.REV_CHECK_INTERVAL_SEC ? Number(process.env.REV_CHECK_INTERVAL_SEC) : 60) * 1000);

  // small log
  console.log("🚀 aiTraderBot v11.0 running. Auto updates every", (CONFIG.REPORT_INTERVAL_MS || 15*60000)/60000, "minutes.");
})();

// exports for other modules
export default { buildReport, computeHybridTargets };