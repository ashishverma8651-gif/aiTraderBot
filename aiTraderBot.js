// aiTraderBot.js — Unified main control (v10.x)
// Place in project root. Requires other modules to exist:
// ./config.js, ./utils.js, ./core_indicators.js, ./elliott_module.js,
// ./ml_module_v8_6.js, ./merge_signals.js, ./news_social.js, ./tg_commands.js

import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import MLModule, { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

import express from "express";

// ---------------------------
// Server & KeepAlive
// ---------------------------
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
});

// ensure keepalive runs (Render/Heroku style)
(async () => {
  try { await keepAlive(CONFIG.SELF_PING_URL); } catch(e){ console.warn("keepAlive init", e.message); }
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL), 5 * 60 * 1000);
})();

// ---------------------------
// Safe helper functions
// ---------------------------
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function lastOf(arr) { return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null; }
function ensureArray(a) { return Array.isArray(a) ? a : []; }

// --------------- Candle pattern util (reuse from your code)
// returns { isDoji, isHammer, isShooting, body, range }
function detectCandlePatternSingle(last, prev) {
  if (!last) return { isDoji:0, isHammer:0, isShooting:0, body:0, range:0 };
  const body = Math.abs(last.close - last.open);
  const range = (last.high - last.low) || 1;
  const isDoji = body <= range * 0.15;
  const lowerWick = Math.min(last.open,last.close) - last.low;
  const upperWick = last.high - Math.max(last.open,last.close);
  const lowerRatio = lowerWick / range;
  const upperRatio = upperWick / range;
  const isHammer = lowerRatio > 0.4 && upperRatio < 0.25 && last.close > (prev? prev.close : last.open);
  const isShooting = upperRatio > 0.4 && lowerRatio < 0.25 && last.close < (prev? prev.close : last.open);
  return { isDoji: isDoji?1:0, isHammer: isHammer?1:0, isShooting: isShooting?1:0, body, range };
}

// ---------------------------
// computeHybridTargets
// (Elliott + Fib Extensions + ATR + ML + merged + news)
// ---------------------------
function computeHybridTargets({
  lastPrice,
  k15 = [],
  ell = {},
  ml = { prob: 50, label: "Neutral" },
  merged = { bias: "Neutral", strength: 0, mlProb: 50 },
  newsImpactScore = 0,
  atr = 0.0,
  pricePrecision = 2
}) {
  // Safety normalizations
  lastPrice = safeNum(lastPrice, (k15 && k15.length ? (k15.at(-1).close) : 0));
  atr = Math.max(0.0001, safeNum(atr, 0));
  // compute recent base high/low using last N candles
  const sliceN = Math.min(60, Math.max(10, (k15||[]).length));
  const lastSlice = (k15||[]).slice(-sliceN);
  let baseLow = Math.min(...(lastSlice.map(c => safeNum(c.low, lastPrice))));
  let baseHigh = Math.max(...(lastSlice.map(c => safeNum(c.high, lastPrice))));
  if (!isFinite(baseLow)) baseLow = lastPrice;
  if (!isFinite(baseHigh)) baseHigh = lastPrice;

  // If Elliot gave lastLow/lastHigh, prefer that as base
  try {
    if (ell && ell.lastLow && typeof ell.lastLow.p === "number" && ell.lastHigh && typeof ell.lastHigh.p === "number") {
      // choose direction-preserving mapping
      if (ell.lastLow.t < ell.lastHigh.t) {
        baseLow = Math.min(baseLow, ell.lastLow.p);
        baseHigh = Math.max(baseHigh, ell.lastHigh.p);
      } else {
        baseLow = Math.min(baseLow, ell.lastHigh.p);
        baseHigh = Math.max(baseHigh, ell.lastLow.p);
      }
    }
  } catch(e) { /* ignore */ }

  // fib extension helper
  const fibExt = (start, end) => {
    const move = end - start;
    return {
      ext100: end + move * 1.0,
      ext127: end + move * 1.272,
      ext161: end + move * 1.618
    };
  };

  // Build bullish & bearish bases
  const bullishExt = fibExt(baseLow, baseHigh);
  const bearishExt = fibExt(baseHigh, baseLow);

  // scaling
  const range = Math.max( Math.abs(baseHigh - baseLow), lastPrice * 0.005, atr * 2 );
  const size = Math.max(atr, range * 0.15);

  // ML influence normalized - ml.prob expected 0..100 OR 0..1
  let mlProb = safeNum(ml.prob, merged.mlProb || 50);
  if (mlProb <= 1.01) mlProb = mlProb * 100; // assume 0..1 -> convert
  mlProb = Math.max(0, Math.min(100, mlProb));
  const mlSignal = (mlProb / 100 - 0.5) * 2; // -1..1

  const strength = Math.max(0, Math.min(1, (safeNum(merged.strength, 0) / 100)));
  const ellConf = Math.max(0, Math.min(1, (safeNum(ell.confidence, 0) / 100)));

  // weighting (tweakable)
  const w = { ml: 0.45, merged: 0.35, ell: 0.20 };

  const bullishBaseScore = Math.max(0, Math.max(0, mlSignal) * w.ml + strength * w.merged + ellConf * w.ell);
  const bearishBaseScore = Math.max(0, Math.max(0, -mlSignal) * w.ml + strength * w.merged + ellConf * w.ell);

  const biasLower = (merged && merged.bias) ? String(merged.bias).toLowerCase() : "neutral";
  const newsPenaltyForBull = (biasLower === "sell") ? Math.min(0.5, newsImpactScore) : 0;
  const newsPenaltyForBear = (biasLower === "buy") ? Math.min(0.5, newsImpactScore) : 0;

  const bullishScore = Math.max(0, bullishBaseScore - newsPenaltyForBull);
  const bearishScore = Math.max(0, bearishBaseScore - newsPenaltyForBear);

  const recommended = (bullishScore > bearishScore + 0.03) ? "Buy" : (bearishScore > bullishScore + 0.03 ? "Sell" : "Neutral");
  const confidencePct = Math.round(Math.max(bullishScore, bearishScore) * 1000) / 10;

  // Build TP/SL levels
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

  // Ensure minimal separation from lastPrice
  const minMove = Math.max(Math.abs(lastPrice) * 0.002, atr || range * 0.02);
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

  const verdict = `Recommendation: <b>${recommended}</b> — Confidence: ${confidencePct}%\nBuy score: ${buy.score}% | Sell score: ${sell.score}%\n${buy.explanation}\n${sell.explanation}`;

  return { buy, sell, recommended, confidencePct, details: { lastPrice, baseLow, baseHigh, atr, mlProb, strength, ellConf, newsImpactScore }, verdict };
}

// ---------------------------
// Multi-timeframe indicators builder
// ---------------------------
async function buildMultiTimeframeIndicators(symbol) {
  const timeframes = CONFIG.INTERVALS || ["1m", "5m", "15m", "30m", "1h"];
  const out = {};
  for (const tf of timeframes) {
    try {
      const resp = await fetchMarketData(symbol, tf, 300);
      const candles = ensureCandlesArray(resp.data || []);
      if (!candles.length) { out[tf] = { price: "N/A", vol: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", bias: "N/A" }; continue; }
      const last = lastOf(candles);
      const rsiObj = calculateRSI(candles, 14);
      const rsiVal = (typeof rsiObj === "object") ? (rsiObj.value ?? NaN) : Number(rsiObj);
      const macdObj = calculateMACD(candles, 12, 26, 9);
      let macdVal = NaN;
      if (macdObj) {
        if (typeof macdObj === "object") {
          if (Array.isArray(macdObj.histogram)) macdVal = macdObj.histogram.at(-1) ?? NaN;
          else if (typeof macdObj.macd === "number") macdVal = macdObj.macd;
        } else if (typeof macdObj === "number") macdVal = macdObj;
      }
      const atr = candles.slice(-14).reduce((s, c, i, arr) => s + (c.high - c.low), 0) / Math.max(1, Math.min(14, candles.length) - 1);
      let bias = "Sideways";
      if (!Number.isNaN(rsiVal) && !Number.isNaN(macdVal)) {
        if (rsiVal > 60 && macdVal > 0) bias = "Bullish";
        else if (rsiVal < 40 && macdVal < 0) bias = "Bearish";
      }
      out[tf] = {
        price: safeNum(last.close).toFixed(2),
        vol: String(safeNum(last.vol || last.volume || 0)),
        rsi: Number.isFinite(rsiVal) ? rsiVal.toFixed(2) : "N/A",
        macd: Number.isFinite(macdVal) ? macdVal.toFixed(3) : "N/A",
        atr: Number.isFinite(atr) ? atr.toFixed(3) : "N/A",
        bias
      };
    } catch (e) {
      console.warn("buildMultiTF:", tf, e.message || e);
      out[tf] = { price: "N/A", vol: "N/A", rsi: "N/A", macd: "N/A", atr: "N/A", bias: "N/A" };
    }
  }
  return out;
}

// small helper to ensure normalized candles (array of objects with open/high/low/close/vol)
function ensureCandlesArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "object" && raw[0].close !== undefined) return raw;
  // try to normalize array-of-arrays (binance)
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return raw.map(r => ({
      t: r[0],
      open: safeNum(r[1]),
      high: safeNum(r[2]),
      low: safeNum(r[3]),
      close: safeNum(r[4]),
      vol: safeNum(r[5])
    })).filter(c => !Number.isNaN(c.close));
  }
  // fallback: if object, attempt flatten
  if (typeof raw === "object") {
    const values = Object.values(raw).flat();
    return values.map(v => ({
      t: safeNum(v.t || v[0] || 0),
      open: safeNum(v.open ?? v[1]),
      high: safeNum(v.high ?? v[2]),
      low: safeNum(v.low ?? v[3]),
      close: safeNum(v.close ?? v[4]),
      vol: safeNum(v.vol ?? v[5] ?? v.volume)
    })).filter(c => !Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }
  return [];
}

// ---------------------------
// Reversal watcher (1m) — sends telegram alerts
// ---------------------------
async function reversalWatcher() {
  try {
    const resp = await fetchMarketData(CONFIG.SYMBOL, "1m", 160);
    const k1 = ensureCandlesArray(resp.data || []);
    if (!k1.length) return;
    const last = lastOf(k1);
    const prev = k1[k1.length - 2] || last;
    const avgVol = k1.slice(-20).reduce((s,c)=>s+(c.vol||0),0) / Math.max(1, Math.min(20,k1.length));
    const volSpike = (last.vol || 0) > avgVol * 1.8;
    const patt = detectCandlePatternSingle(last, prev);
    // ML on small window
    let mlRes = { prob: 50 };
    try { mlRes = runMLPrediction(k1.slice(-40)) || mlRes; } catch(e){ /* ignore */ }
    const mlConf = (mlRes && mlRes.prob) ? (mlRes.prob <= 1 ? mlRes.prob*100 : mlRes.prob) : 50;
    // fire conditions: recognizable pattern + vol spike + ML leaning same direction
    const mlDirection = mlConf > 60 ? "bull" : mlConf < 40 ? "bear" : "neutral";
    const patternDir = patt.isHammer ? "bull" : patt.isShooting ? "bear" : patt.isDoji ? "neutral" : "neutral";
    const mlOk = (patternDir === "bull" && mlDirection === "bull") || (patternDir === "bear" && mlDirection === "bear") || (mlDirection !== "neutral" && volSpike);
    if ((patt.isHammer || patt.isShooting || patt.isDoji) && (volSpike || mlOk) ) {
      const dir = patt.isHammer ? "Bullish" : patt.isShooting ? "Bearish" : "Neutral";
      const msg = `🚨 <b>Reversal Watcher</b>\n${nowLocal()}\nSymbol: <b>${CONFIG.SYMBOL}</b>\nPattern: <b>${patt.isHammer? "Hammer": patt.isShooting? "Shooting Star":"Doji"}</b>\nDirection: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.vol||0)} (avg ${Math.round(avgVol)})\nML Prob: ${Math.round(mlConf)}%`;
      await sendTelegramMessage(msg);
    }
  } catch (err) {
    console.warn("reversalWatcher err:", err.message || err);
  }
}

// schedule reversal watcher every 60s (configurable)
setInterval(reversalWatcher, (process.env.REV_CHECK_INTERVAL_SEC ? Number(process.env.REV_CHECK_INTERVAL_SEC) : 60) * 1000);

// ---------------------------
// Build full report & send to Telegram
// ---------------------------
async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    // fetch main interval data
    const resp = await fetchMarketData(symbol, interval, 500);
    const candlesRaw = ensureCandlesArray(resp.data || []);
    if (!candlesRaw.length) return null;

    const last = lastOf(candlesRaw);
    // ATR (safe)
    const recent = candlesRaw.slice(-20);
    let atr = 0;
    for (let i = 1; i < recent.length; i++) {
      const p = recent[i-1], c = recent[i];
      atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    atr = atr / Math.max(1, recent.length - 1);

    // indicators & modules (safe-guard)
    let rsi = null, macd = null, ell = {}, ml = { prob: 50 }, merged = { bias: "Neutral", strength: 0, mlProb: 50 }, news = { impact: "Low", score: 0, headlines: [] };
    try { rsi = calculateRSI(candlesRaw, 14); } catch(e){ console.warn("rsi err", e.message); }
    try { macd = calculateMACD(candlesRaw, 12, 26, 9); } catch(e){ console.warn("macd err", e.message); }
    try { ell = await analyzeElliott({ "15m": candlesRaw, raw: candlesRaw }); } catch(e){ console.warn("elliott err", e.message); }
    try { ml = await runMLPrediction(candlesRaw) || ml; } catch(e){ console.warn("ml predict err", e.message); }
    try { merged = mergeSignals({ rsi, macd }, ell, ml) || merged; } catch(e){ console.warn("merge err", e.message); }
    try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol) || news; } catch(e){ console.warn("news err", e.message); }

    // multi TF snapshot
    const multiTF = await buildMultiTimeframeIndicators(symbol);

    // hybrid targets using 15m candles (k15)
    const k15local = candlesRaw; // we fetched 15m as main interval
    const hybrid = computeHybridTargets({
      lastPrice: last.close,
      k15: k15local,
      ell,
      ml,
      merged,
      newsImpactScore: (safeNum(news.score,0) / 100),
      atr,
      pricePrecision: 2
    });

    // Compose the Telegram dashboard message (professional)
    let text = "━━━━━━━━━━━━━━━━━━━\n";
    text += `🚀 <b>${symbol}</b> — <b>AI Trader Report</b>\n`;
    text += `🕒 ${nowLocal()}\n`;
    text += `📡 Source: ${resp.source || "multi-source"}\n`;
    text += `💰 <b>Price:</b> ${safeNum(last.close).toFixed(2)}\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n\n`;

    // Per-timeframe block
    for (const tf of Object.keys(multiTF)) {
      const r = multiTF[tf];
      text += `📈 <b>${tf}</b> | ${r.bias}\n`;
      text += `Price: ${r.price} | Vol: ${r.vol} | RSI: ${r.rsi} | MACD: ${r.macd} | ATR: ${r.atr}\n`;
      text += "━━━━━━━━━━━━━━━━━━━\n";
    }

    // Dual targets block
    text += `\n🎯 <b>Dual Targets (Elliott + Fib + ML + ATR)</b>\n`;
    text += `📈 <b>Buy</b> — TP1: ${hybrid.buy.tp1} | TP2: ${hybrid.buy.tp2} | TP3: ${hybrid.buy.tp3} | SL: ${hybrid.buy.sl}\n`;
    text += `📉 <b>Sell</b> — TP1: ${hybrid.sell.tp1} | TP2: ${hybrid.sell.tp2} | TP3: ${hybrid.sell.tp3} | SL: ${hybrid.sell.sl}\n\n`;
    text += `${hybrid.verdict}\n\n`;

    text += `🧭 <b>Overall Bias:</b> ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb ?? ml.prob ?? 50}%\n`;
    text += `🎯 Targets: TP1: ${hybrid.buy.tp1}/${hybrid.sell.tp1} TP2: ${hybrid.buy.tp2}/${hybrid.sell.tp2} | SL (buy/sell): ${hybrid.buy.sl}/${hybrid.sell.sl}\n\n`;
    text += `📰 <b>News Impact:</b> ${news.impact ?? "N/A"} (score ${safeNum(news.score,0)})\n`;
    if (Array.isArray(news.headlines) && news.headlines.length) {
      text += "🗞️ <b>Top Headlines:</b>\n• " + news.headlines.slice(0,5).join("\n• ") + "\n";
    }
    text += `\n📊 <i>Sources:</i> Binance, CoinGecko, KuCoin\n`;
    text += "━━━━━━━━━━━━━━━━━━━\n";

    return { text, hybrid, summary: { rsi, macd, ell, ml, merged, multiTF } };

  } catch (err) {
    console.error("buildReport err:", err.message || err);
    return null;
  }
}

// ---------------------------
// Report loop runner
// ---------------------------
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      console.warn("No report (no data)");
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch (e) {
    console.error("generateReportLoop err:", e.message || e);
    try { await sendTelegramMessage(`❌ Error generating report: ${e.message || e}`); } catch(e){}
  }
}

// start immediate + schedule
(async () => {
  try {
    await setupTelegramBot(); // initialize bot handlers/commands
  } catch(e) { console.warn("setupTelegramBot err", e.message || e); }
  // run right away
  await generateReportLoop();
  // schedule repeating
  setInterval(generateReportLoop, CONFIG.REPORT_INTERVAL_MS || ((parseInt(process.env.REPORT_INTERVAL_MIN||"15")||15) * 60 * 1000));
})();


// ===============================
// ⏱️ Auto 15-Minute Market Updates
// ===============================
async function autoUpdateLoop() {
  try {
    const symbol = CONFIG.SYMBOL || "BTCUSDT";
    const signal = await generateMergedSignal(symbol, "15m");

    const msg = `
📊 <b>${symbol}</b> — 15m Auto Update
━━━━━━━━━━━━━━━
📈 <b>Signal:</b> ${signal.summary}
💹 <b>ML Confidence:</b> ${(signal.ml_confidence * 100).toFixed(1)}%
📊 <b>RSI:</b> ${signal.indicators?.RSI || "N/A"}
📉 <b>MACD:</b> ${signal.indicators?.MACD || "N/A"}
💰 <b>Volume:</b> ${signal.indicators?.VOLUME || "N/A"}
🕒 <b>Next Update:</b> 15m later
━━━━━━━━━━━━━━━
`;

    await sendTelegramMessage(msg);
    console.log("✅ Auto 15m update sent to Telegram");
  } catch (err) {
    console.error("⚠️ Auto update error:", err.message);
  }
}

// Run immediately on start
autoUpdateLoop();

// Schedule every 15 minutes
setInterval(autoUpdateLoop, 15 * 60 * 1000);


// ---------------------------
// Exports (optional)
export { computeHybridTargets, buildReport, reversalWatcher };
export default { computeHybridTargets, buildReport, reversalWatcher };