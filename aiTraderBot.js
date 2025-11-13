// aiTraderBot.js — Unified AI Trader core (Render-safe, live price + robust)
import express from "express";
import WebSocket from "ws"; // npm i ws
import CONFIG from "./config.js";
import { nowLocal, fetchMarketData, keepAlive } from "./utils.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { mergeSignals } from "./merge_signals.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot, sendTelegramMessage } from "./tg_commands.js";

// --------------------------- helpers
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function lastOf(a){ return Array.isArray(a) && a.length ? a[a.length-1] : null; }
function ensureCandlesArray(raw){
  if (!raw) return [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "object" && raw[0].close !== undefined) return raw;
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    return raw.map(r => ({ t: r[0], open: safeNum(r[1]), high: safeNum(r[2]), low: safeNum(r[3]), close: safeNum(r[4]), vol: safeNum(r[5]) }))
      .filter(c => !Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }
  if (typeof raw === "object") {
    const values = Object.values(raw).flat();
    return values.map(v=>({
      t: safeNum(v.t || v[0] || 0),
      open: safeNum(v.open ?? v[1]),
      high: safeNum(v.high ?? v[2]),
      low: safeNum(v.low ?? v[3]),
      close: safeNum(v.close ?? v[4]),
      vol: safeNum(v.vol ?? v[5] ?? v.volume)
    })).filter(c=>!Number.isNaN(c.close)).sort((a,b)=>a.t-b.t);
  }
  return [];
}

// --------------------------- Server / keepalive
const app = express();
app.get("/", (_req, res) => res.send("✅ AI Trader Bot is alive and running"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 KeepAlive server running on port ${PORT}`);
  setInterval(() => keepAlive(CONFIG.SELF_PING_URL).catch(()=>{}), 10*60*1000);
});

// --------------------------- Live price (Binance WS)
let latestLivePrice = null;
let wsClient = null;
function startLivePriceStream(symbol = CONFIG.SYMBOL || "BTCUSDT") {
  try {
    const s = String(symbol).toLowerCase();
    const url = `wss://stream.binance.com:9443/ws/${s}@trade`;
    if (wsClient) try { wsClient.terminate(); } catch(e){}
    wsClient = new WebSocket(url, { handshakeTimeout: 5000 });
    wsClient.on("open", ()=> console.log("🔌 Binance WS connected for", symbol));
    wsClient.on("message", (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d && (d.p || d.price)) latestLivePrice = safeNum(d.p || d.price, latestLivePrice);
      } catch(e){}
    });
    wsClient.on("error", (e) => {
      console.warn("Binance WS error:", e && e.message);
      latestLivePrice = null;
    });
    wsClient.on("close", (code, reason) => {
      console.warn("Binance WS closed", code, reason?.toString?.() || reason);
      latestLivePrice = null;
      setTimeout(()=> startLivePriceStream(symbol), 8*1000);
    });
  } catch (e) {
    console.warn("startLivePriceStream err:", e && e.message);
    latestLivePrice = null;
  }
}
startLivePriceStream(CONFIG.SYMBOL);

// --------------------------- computeHybridTargets (same robust as earlier)
function computeHybridTargets({
  lastPrice, k15=[], ell={}, ml={prob:50}, merged={bias:"Neutral",strength:0,mlProb:50}, newsImpactScore=0, atr=0.0, pricePrecision=2
}) {
  lastPrice = safeNum(lastPrice, k15.length ? safeNum(k15.at(-1).close,0) : 0);
  atr = Math.max(0.0001, safeNum(atr, 0));
  const sliceN = Math.min(60, Math.max(10, k15.length));
  const lastSlice = (k15||[]).slice(-sliceN);
  let baseLow = lastSlice.length ? Math.min(...lastSlice.map(c=>safeNum(c.low,lastPrice))) : lastPrice;
  let baseHigh = lastSlice.length ? Math.max(...lastSlice.map(c=>safeNum(c.high,lastPrice))) : lastPrice;

  try {
    if (ell && ell.lastLow && typeof ell.lastLow.p === "number" && ell.lastHigh && typeof ell.lastHigh.p === "number") {
      if (ell.lastLow.t < ell.lastHigh.t) { baseLow = Math.min(baseLow, ell.lastLow.p); baseHigh = Math.max(baseHigh, ell.lastHigh.p); }
      else { baseLow = Math.min(baseLow, ell.lastHigh.p); baseHigh = Math.max(baseHigh, ell.lastLow.p); }
    }
  } catch(e){}

  const fibExt = (start, end) => {
    const move = end - start;
    return { ext100: end + move*1.0, ext127: end + move*1.272, ext161: end + move*1.618 };
  };

  const bullishExt = fibExt(baseLow, baseHigh);
  const bearishExt = fibExt(baseHigh, baseLow);

  const range = Math.max(Math.abs(baseHigh-baseLow), Math.abs(lastPrice)*0.005, atr*2);
  const size = Math.max(atr, range*0.15);

  let mlProb = safeNum(ml.prob, merged.mlProb || 50);
  if (mlProb <= 1.01) mlProb *= 100;
  mlProb = Math.max(0, Math.min(100, mlProb));
  const mlSignal = (mlProb/100 - 0.5)*2;

  const strength = Math.max(0, Math.min(1, (safeNum(merged.strength,0)/100)));
  const ellConf = Math.max(0, Math.min(1, (safeNum(ell.confidence,0)/100)));
  const w = { ml:0.45, merged:0.35, ell:0.20 };
  const bullishBaseScore = Math.max(0, Math.max(0, mlSignal)*w.ml + strength*w.merged + ellConf*w.ell);
  const bearishBaseScore = Math.max(0, Math.max(0, -mlSignal)*w.ml + strength*w.merged + ellConf*w.ell);

  const biasLower = merged && merged.bias ? String(merged.bias).toLowerCase() : "neutral";
  const newsPenaltyForBull = biasLower === "sell" ? Math.min(0.5, newsImpactScore) : 0;
  const newsPenaltyForBear = biasLower === "buy" ? Math.min(0.5, newsImpactScore) : 0;

  const bullishScore = Math.max(0, bullishBaseScore - newsPenaltyForBull);
  const bearishScore = Math.max(0, bearishBaseScore - newsPenaltyForBear);

  const recommended = (bullishScore > bearishScore + 0.03) ? "Buy" : (bearishScore > bullishScore + 0.03 ? "Sell" : "Neutral");
  const confidencePct = Math.round(Math.max(bullishScore, bearishScore) * 1000) / 10;

  const buy = {
    tp1: Number((bullishExt.ext100).toFixed(pricePrecision)),
    tp2: Number((bullishExt.ext127).toFixed(pricePrecision)),
    tp3: Number((bullishExt.ext161).toFixed(pricePrecision)),
    sl: Number((Math.max(0, baseLow - Math.max(size*0.6, atr*1.2))).toFixed(pricePrecision)),
    score: Math.round(bullishScore*1000)/10,
    explanation: `Bull base ${baseLow.toFixed(pricePrecision)}→${baseHigh.toFixed(pricePrecision)} (ell:${Math.round(ellConf*100)}% ml:${Math.round(mlProb)}% tech:${Math.round(strength*100)}%)`
  };
  const sell = {
    tp1: Number((bearishExt.ext100).toFixed(pricePrecision)),
    tp2: Number((bearishExt.ext127).toFixed(pricePrecision)),
    tp3: Number((bearishExt.ext161).toFixed(pricePrecision)),
    sl: Number((Math.min(baseHigh + Math.max(size*0.6, atr*1.2), lastPrice + Math.max(size, atr*2))).toFixed(pricePrecision)),
    score: Math.round(bearishScore*1000)/10,
    explanation: `Bear base ${baseHigh.toFixed(pricePrecision)}→${baseLow.toFixed(pricePrecision)} (ell:${Math.round(ellConf*100)}% ml:${Math.round(100-mlProb)}% tech:${Math.round(strength*100)}%)`
  };

  const minMove = Math.max(Math.abs(lastPrice)*0.002, atr || range*0.02);
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

// --------------------------- Multi-timeframe builder (sync masterPrice)
async function buildMultiTimeframeIndicators(symbol, masterPrice) {
  const timeframes = CONFIG.INTERVALS || ["1m","5m","15m","30m","1h"];
  const out = {};
  for (const tf of timeframes) {
    try {
      const resp = await fetchMarketData(symbol, tf, 250);
      const candles = ensureCandlesArray(resp.data || []);
      if (!candles.length) { out[tf] = { price: "N/A", vol: "-", rsi:"N/A", macd:"N/A", atr:"N/A", bias:"N/A" }; continue; }
      const last = lastOf(candles);
      const rsiObj = calculateRSI(candles,14);
      const rsiVal = (typeof rsiObj === "object") ? (rsiObj.value ?? NaN) : Number(rsiObj);
      const macdObj = calculateMACD(candles,12,26,9);
      let macdVal = NaN;
      if (macdObj) {
        if (typeof macdObj === "object") {
          macdVal = Array.isArray(macdObj.macd) ? macdObj.macd.at(-1) ?? NaN : (macdObj.macd ?? NaN);
        } else if (typeof macdObj === "number") macdVal = macdObj;
      }
      const atr = candles.slice(-14).reduce((s,c)=>s+(c.high - c.low),0)/Math.max(1,Math.min(14,candles.length)-1);
      let bias = "Sideways";
      if (!Number.isNaN(rsiVal) && !Number.isNaN(macdVal)) {
        if (rsiVal > 60 && macdVal > 0) bias = "Bullish";
        else if (rsiVal < 40 && macdVal < 0) bias = "Bearish";
      }
      out[tf] = {
        price: masterPrice ? safeNum(masterPrice).toFixed(2) : safeNum(last.close).toFixed(2),
        vol: String(safeNum(last.vol || last.volume || 0)),
        rsi: Number.isFinite(rsiVal) ? rsiVal.toFixed(2) : "N/A",
        macd: Number.isFinite(macdVal) ? macdVal.toFixed(3) : "N/A",
        atr: Number.isFinite(atr) ? atr.toFixed(3) : "N/A",
        bias
      };
    } catch(e) {
      out[tf] = { price: "N/A", vol: "-", rsi:"N/A", macd:"N/A", atr:"N/A", bias:"N/A" };
    }
  }
  return out;
}

// --------------------------- Reversal watcher (1m)
async function reversalWatcher() {
  try {
    const resp = await fetchMarketData(CONFIG.SYMBOL, "1m", 160);
    const k1 = ensureCandlesArray(resp.data || []);
    if (!k1.length) return;
    const last = lastOf(k1);
    const prev = k1[k1.length-2] || last;
    const avgVol = k1.slice(-20).reduce((s,c)=>s+(c.vol||0),0)/Math.max(1,Math.min(20,k1.length));
    const volSpike = (last.vol || 0) > avgVol * 1.8;
    const body = Math.abs(last.close - last.open);
    const range = Math.max(1, last.high - last.low);
    const isDoji = body <= range * 0.15;
    const lowerWick = Math.min(last.open,last.close) - last.low;
    const upperWick = last.high - Math.max(last.open,last.close);
    const isHammer = (lowerWick / range) > 0.4 && (upperWick / range) < 0.25 && last.close > prev.close;
    const isShooting = (upperWick / range) > 0.4 && (lowerWick / range) < 0.25 && last.close < prev.close;

    let mlRes = { prob:50 };
    try { mlRes = await runMLPrediction(k1.slice(-40)) || mlRes; } catch(e){}
    const mlConf = (mlRes && mlRes.prob) ? (mlRes.prob <=1 ? mlRes.prob*100 : mlRes.prob) : 50;
    const mlDirection = mlConf > 60 ? "bull" : mlConf < 40 ? "bear" : "neutral";
    const patternDir = isHammer ? "bull" : isShooting ? "bear" : isDoji ? "neutral" : "neutral";
    const mlOk = (patternDir==="bull" && mlDirection==="bull") || (patternDir==="bear" && mlDirection==="bear") || (mlDirection!=="neutral" && volSpike);

    if ((isHammer || isShooting || isDoji) && (volSpike || mlOk)) {
      const dir = isHammer ? "Bullish" : isShooting ? "Bearish" : "Neutral";
      const msg = `🚨 <b>Reversal Watcher</b>\n${nowLocal()}\nSymbol: <b>${CONFIG.SYMBOL}</b>\nPattern: <b>${isHammer? "Hammer": isShooting? "Shooting Star":"Doji"}</b>\nDirection: <b>${dir}</b>\nPrice: ${last.close}\nVolume: ${Math.round(last.vol||0)} (avg ${Math.round(avgVol)})\nML Prob: ${Math.round(mlConf)}%`;
      await sendTelegramMessage(msg);
    }
  } catch (err) { console.warn("reversalWatcher err:", err && err.message); }
}
setInterval(reversalWatcher, (process.env.REV_CHECK_INTERVAL_SEC ? Number(process.env.REV_CHECK_INTERVAL_SEC) : 60) * 1000);

// --------------------------- Build report
export async function buildReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    let masterPrice = latestLivePrice;
    if (!masterPrice) {
      try {
        const m1 = await fetchMarketData(symbol, "1m", 50);
        const m1c = ensureCandlesArray(m1.data || []);
        if (m1c.length) masterPrice = safeNum(m1c.at(-1).close, masterPrice);
      } catch(e){}
    }

    const resp = await fetchMarketData(symbol, interval, 500);
    const candles = ensureCandlesArray(resp.data || []);
    if (!candles.length && !masterPrice) return null;
    const last = candles.length ? lastOf(candles) : { close: masterPrice };

    let atr = 0;
    if (candles.length) {
      const recent = candles.slice(-20);
      for (let i=1;i<recent.length;i++){
        const p = recent[i-1], c = recent[i];
        atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      }
      atr = atr / Math.max(1, recent.length - 1);
    }

    let rsi=null, macd=null, ell={}, ml={prob:50}, merged={bias:"Neutral", strength:0, mlProb:50}, news={impact:"Low", score:0, headlines:[]};
    try { rsi = calculateRSI(candles, 14); } catch(e){ console.warn("rsi err", e && e.message); }
    try { macd = calculateMACD(candles, 12,26,9); } catch(e){ console.warn("macd err", e && e.message); }
    try { ell = await analyzeElliott(candles) || {}; } catch(e){ console.warn("elli err", e && e.message); }
    try { ml = await runMLPrediction(candles) || ml; } catch(e){ console.warn("ml err", e && e.message); }
    try { merged = mergeSignals({ rsi, macd }, ell, ml) || merged; } catch(e){ console.warn("merged err", e && e.message); }
    try { news = await fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol) || news; } catch(e){ console.warn("news err", e && e.message); }

    const multiTF = await buildMultiTimeframeIndicators(symbol, masterPrice);
    const k15local = ensureCandlesArray(candles);
    const hybrid = computeHybridTargets({
      lastPrice: masterPrice ?? last.close,
      k15: k15local,
      ell, ml, merged,
      newsImpactScore: (safeNum(news.score,0) / 100),
      atr,
      pricePrecision: 2
    });

    let text = "━━━━━━━━━━━━━━━━━━━\n";
    text += `🚀 <b>${symbol} — AI Trader ${CONFIG.VERSION || ""}</b>\n`;
    text += `🕒 ${nowLocal()}\n`;
    text += `📡 Source: ${resp.source || "multi-source (config)"}\n`;
    text += `💰 <b>Price:</b> ${safeNum(masterPrice ?? last.close).toFixed(2)}\n`;
    text += `━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const tf of Object.keys(multiTF)) {
      const r = multiTF[tf];
      text += `📈 <b>${tf}</b> | ${r.bias}\n`;
      text += `💵 Price: ${r.price} | Vol: ${r.vol} | RSI: ${r.rsi} | MACD: ${r.macd} | ATR: ${r.atr}\n`;
      text += "━━━━━━━━━━━━━━━━━━━\n";
    }

    text += `\n🎯 <b>Dual Targets (Elliott + Fib + ML + ATR)</b>\n`;
    text += `📈 <b>Buy</b> — TP1: ${hybrid.buy.tp1} | TP2: ${hybrid.buy.tp2} | TP3: ${hybrid.buy.tp3} | SL: ${hybrid.buy.sl}\n`;
    text += `📉 <b>Sell</b> — TP1: ${hybrid.sell.tp1} | TP2: ${hybrid.sell.tp2} | TP3: ${hybrid.sell.tp3} | SL: ${hybrid.sell.sl}\n\n`;
    text += `${hybrid.verdict}\n\n`;

    text += `🧭 <b>Overall Bias:</b> ${merged.bias} | Strength: ${merged.strength}% | ML Prob: ${merged.mlProb ?? ml.prob ?? 50}%\n`;
    text += `🎯 Targets: TP1: ${hybrid.buy.tp1}/${hybrid.sell.tp1} TP2: ${hybrid.buy.tp2}/${hybrid.sell.tp2} | SL (buy/sell): ${hybrid.buy.sl}/${hybrid.sell.sl}\n\n`;

    text += `📰 <b>News Impact:</b> ${news.impact ?? "N/A"} (score ${safeNum(news.score,0)})\n`;
    if (Array.isArray(news.headlines) && news.headlines.length) {
      text += "🗞️ <b>Top Headlines:</b>\n• " + news.headlines.slice(0,5).map(h => (typeof h === "string" ? h : (h.title || h.headline || JSON.stringify(h)))).join("\n• ") + "\n";
    }
    text += `\n📊 <i>Sources:</i> Multi-source (config)\n`;
    text += "━━━━━━━━━━━━━━━━━━━\n";

    return { text, hybrid, summary: { rsi, macd, ell, ml, merged, multiTF } };
  } catch (err) {
    console.error("buildReport err:", err && err.message);
    return null;
  }
}

// --------------------------- Simple merged signal for auto updates
export async function generateMergedSignal(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    const resp = await fetchMarketData(symbol, interval, 300);
    const candles = ensureCandlesArray(resp.data || []);
    if (!candles.length) return { summary: "No data", indicators: {}, ml_confidence: 0 };
    const rsiObj = calculateRSI(candles,14);
    const rsiVal = (typeof rsiObj === "object") ? rsiObj.value ?? NaN : Number(rsiObj);
    const macdObj = calculateMACD(candles,12,26,9);
    let macdVal = 0;
    if (macdObj) {
      if (typeof macdObj === "object") macdVal = Array.isArray(macdObj.macd) ? macdObj.macd.at(-1) ?? 0 : (macdObj.macd || 0);
      else if (typeof macdObj === "number") macdVal = macdObj;
    }
    const mlRes = await runMLPrediction(candles).catch(()=>({prob:50}));
    const mlProb = mlRes && mlRes.prob ? (mlRes.prob <=1 ? mlRes.prob*100 : mlRes.prob) : 50;
    let summary = "Neutral";
    if (!Number.isNaN(rsiVal) && !Number.isNaN(macdVal)) {
      if (rsiVal > 60 && macdVal > 0) summary = "Buy";
      else if (rsiVal < 40 && macdVal < 0) summary = "Sell";
      else summary = "Sideways";
    }
    return { summary, indicators: { RSI: Number.isFinite(rsiVal) ? rsiVal.toFixed(2) : "N/A", MACD: Number.isFinite(macdVal) ? macdVal.toFixed(2) : "N/A", VOLUME: candles.at(-1)?.vol ?? "N/A" }, ml_confidence: mlProb/100 };
  } catch(e) {
    return { summary: "err", indicators:{}, ml_confidence: 0 };
  }
}

// --------------------------- Auto 15m updates
async function autoUpdateLoop() {
  try {
    const symbol = CONFIG.SYMBOL || "BTCUSDT";
    const sig = await generateMergedSignal(symbol, "15m");
    const msg =
`📊 <b>${symbol}</b> — 15m Auto Update
━━━━━━━━━━━━━━━
📈 <b>Signal:</b> ${sig.summary}
💹 <b>ML Confidence:</b> ${(sig.ml_confidence*100).toFixed(1)}%
📊 <b>RSI:</b> ${sig.indicators?.RSI || "N/A"}
📉 <b>MACD:</b> ${sig.indicators?.MACD || "N/A"}
💰 <b>Volume:</b> ${sig.indicators?.VOLUME || "N/A"}
🕒 <b>Next Update:</b> 15m later
━━━━━━━━━━━━━━━
`;
    await sendTelegramMessage(msg);
    console.log("✅ Auto 15m update sent");
  } catch (err) {
    console.error("⚠️ Auto update error:", err && err.message);
  }
}
autoUpdateLoop();
setInterval(autoUpdateLoop, (CONFIG.REPORT_INTERVAL_MS || (15*60*1000)));

// --------------------------- Full report loop
async function generateReportLoop() {
  try {
    const out = await buildReport(CONFIG.SYMBOL, "15m");
    if (!out) {
      await sendTelegramMessage(`⚠️ ${CONFIG.SYMBOL} — No data available at ${nowLocal()}`);
      return;
    }
    await sendTelegramMessage(out.text);
  } catch(e) {
    console.error("generateReportLoop err:", e && e.message);
    try { await sendTelegramMessage(`❌ Error generating report: ${e && e.message}`); } catch(e){}
  }
}

// --------------------------- Initialize everything
(async () => {
  try { await keepAlive(CONFIG.SELF_PING_URL); } catch(e){}
  try {
    await setupTelegramBot();
    console.log("🤖 Telegram setup requested");
  } catch(e){ console.warn("setupTelegramBot error:", e && e.message); }

  try { await generateReportLoop(); } catch(e){ console.warn("initial report fail", e && e.message); }
  setInterval(generateReportLoop, (CONFIG.REPORT_INTERVAL_MS || (15*60*1000)));
  console.log("Main loops started. Report interval (ms):", CONFIG.REPORT_INTERVAL_MS);
})();

// --------------------------- exports
export { computeHybridTargets, generateMergedSignal };
export default { buildReport, computeHybridTargets, generateM