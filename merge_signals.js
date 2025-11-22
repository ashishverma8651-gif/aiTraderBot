// merge_signals.js
// PREMIUM MULTI-MARKET UI + ROUTER + FORMATTER
// -----------------------------------------------------

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";
import { fetchUniversal } from "./utils.js"; // to fetch non-crypto markets

// Utility small helpers
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : (v == null ? "N/A" : String(v));
function withHTML(keyboard) { return { ...keyboard, parse_mode: "HTML" }; }

// -------------------- KEYBOARDS --------------------
export const kbHome = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "💠 Crypto", callback_data: "menu_crypto" }, { text: "📘 Indices", callback_data: "menu_indices" }],
      [{ text: "💱 Forex", callback_data: "menu_forex" }, { text: "🛢 Commodities", callback_data: "menu_commodities" }]
    ]
  }
});

export const kbCrypto = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "BTC", callback_data: "asset_BTCUSDT" }, { text: "ETH", callback_data: "asset_ETHUSDT" }],
      [{ text: "SOL", callback_data: "asset_SOLUSDT" }, { text: "XRP", callback_data: "asset_XRPUSDT" }],
      [{ text: "DOGE", callback_data: "asset_DOGEUSDT" }, { text: "ADA", callback_data: "asset_ADAUSDT" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbIndices = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "NIFTY50", callback_data: "asset_NIFTY50" }, { text: "BANKNIFTY", callback_data: "asset_BANKNIFTY" }],
      [{ text: "SENSEX", callback_data: "asset_SENSEX" }, { text: "FINNIFTY", callback_data: "asset_FINNIFTY" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbForex = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "EURUSD", callback_data: "asset_EURUSD" }, { text: "GBPUSD", callback_data: "asset_GBPUSD" }],
      [{ text: "USDJPY", callback_data: "asset_USDJPY" }, { text: "XAUUSD", callback_data: "asset_XAUUSD" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbCommodity = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "GOLD", callback_data: "asset_GOLD" }, { text: "SILVER", callback_data: "asset_SILVER" }],
      [{ text: "CRUDE", callback_data: "asset_CRUDE" }, { text: "NGAS", callback_data: "asset_NGAS" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export function kbActions(symbol) {
  return withHTML({
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: `refresh_${symbol}` }, { text: "🕒 Timeframes", callback_data: `tfs_${symbol}` }],
        [{ text: "📊 Elliott", callback_data: `ell_${symbol}` }, { text: "📰 News", callback_data: `news_${symbol}` }],
        [{ text: "⬅ Back", callback_data: "back_assets" }]
      ]
    }
  });
}

export function kbTimeframes(symbol) {
  return withHTML({
    reply_markup: {
      inline_keyboard: [
        [{ text: "5m", callback_data: `tf_${symbol}_5m` }, { text: "15m", callback_data: `tf_${symbol}_15m` }],
        [{ text: "30m", callback_data: `tf_${symbol}_30m` }, { text: "1h", callback_data: `tf_${symbol}_1h` }],
        [{ text: "4h", callback_data: `tf_${symbol}_4h` }, { text: "1D", callback_data: `tf_${symbol}_1d` }],
        [{ text: "⬅ Back", callback_data: `asset_${symbol}` }]
      ]
    }
  });
}

// -------------------- FORMATTER --------------------
export function formatPremiumReport(r) {
  return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL
━━━━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.elliottPattern} (${r.elliottConf}%)

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.maxProb}%
━━━━━━━━━━━━━━━━━━
`;
}

// small indicator fallbacks for non-crypto symbols
function computeATRFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, prev = candles[i - 1].close || candles[i - 1].price || 0;
    trs.push(Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev)));
  }
  const recent = trs.slice(-period);
  return recent.length ? recent.reduce((a,b)=>a+b,0)/recent.length : (trs.length ? trs.reduce((a,b)=>a+b,0)/trs.length : 0);
}

function computeRSIFromCandles(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = (candles[i].close || 0) - (candles[i-1].close || 0);
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period || 0;
  const avgLoss = losses / period || 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// -------------------- GENERATE REPORT --------------------
export async function generateReport(symbol, tf = "15m") {
  symbol = String(symbol || "").toUpperCase();

  // crypto -> use main ML pipeline
  if (symbol.endsWith("USDT") || symbol.endsWith("USD")) {
    try {
      const ml = await runMLPrediction(symbol, tf);
      const ell = await analyzeElliott(ml?.explanation?.features?.candles || []);
      const news = await fetchNewsBundle(symbol);

      const data = {
        symbol,
        price: nf(ml?.explanation?.features?.close || ml?.price || 0, 2),
        direction: ml?.direction || "Neutral",
        biasEmoji: (ml?.direction === "Bullish") ? "📈" : (ml?.direction === "Bearish") ? "📉" : "⚪",
        maxProb: ml?.maxProb ?? 50,
        tp1: ml?.tpEstimate ?? "—",
        tp2: ml?.tp2Estimate ?? "—",
        tpConf: ml?.tpConfidence ?? 55,
        elliottPattern: ell?.pattern ?? "N/A",
        elliottConf: ell?.confidence ?? 50,
        newsImpact: news?.impact ?? "Neutral",
        newsScore: Math.round((typeof news?.sentiment === "number" ? news.sentiment : 0.5) * 100)
      };

      return { text: formatPremiumReport(data), keyboard: kbActions(symbol) };
    } catch (e) {
      return { text: `❌ Error generating crypto report: ${e?.message || e}`, keyboard: kbActions(symbol) };
    }
  }

  // non-crypto -> use fetchUniversal and light indicators (no ML)
  try {
    const uni = await fetchUniversal(symbol, tf);
    const candles = uni.data || [];
    const price = uni.price || (candles.at(-1)?.close || 0);
    const atr = computeATRFromCandles(candles, 14);
    const rsi = computeRSIFromCandles(candles, 14);
    // simple direction heuristic
    const dir = (candles.length >= 2 && candles.at(-1).close > candles.at(-2).close) ? "Bullish"
              : (candles.length >= 2 && candles.at(-1).close < candles.at(-2).close) ? "Bearish" : "Neutral";
    const news = await fetchNewsBundle(symbol);

    // quick target using ATR fallback
    const primaryTP = dir === "Bullish" ? (price + atr * 2.5) : dir === "Bearish" ? (price - atr * 2.5) : (price + Math.max(atr, price * 0.005) * 2.0);
    const hedgeTP = dir === "Bullish" ? (price - atr * 1.2) : dir === "Bearish" ? (price + atr * 1.2) : (price - Math.max(atr, price * 0.005) * 1.2);

    const data = {
      symbol,
      price: nf(price, 2),
      direction: dir,
      biasEmoji: dir === "Bullish" ? "📈" : dir === "Bearish" ? "📉" : "⚪",
      maxProb: 50,
      tp1: isFinite(primaryTP) ? nf(primaryTP, 2) : "—",
      tp2: isFinite(hedgeTP) ? nf(hedgeTP, 2) : "—",
      tpConf: 50,
      elliottPattern: "N/A",
      elliottConf: 0,
      newsImpact: news?.impact ?? "Neutral",
      newsScore: Math.round((typeof news?.sentiment === "number" ? news.sentiment : 0.5) * 100)
    };

    return { text: formatPremiumReport(data), keyboard: kbActions(symbol) };
  } catch (e) {
    return { text: `❌ Error generating report for ${symbol}: ${e?.message || e}`, keyboard: kbHome };
  }
}

// -------------------- CALLBACK ROUTER --------------------
export async function handleCallback(query) {
  const data = query?.data || "";

  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities", keyboard: kbCommodity };

  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol, "15m");
  }

  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Select timeframe for <b>${symbol}</b>:`, keyboard: kbTimeframes(symbol) };
  }

  if (data.startsWith("tf_")) {
    const parts = data.split("_");
    const symbol = parts[1];
    const tf = parts[2];
    return await generateReport(symbol, tf);
  }

  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol, "15m");
  }

  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const ell = await analyzeElliott([]);
    return { text: `📊 <b>Elliott Waves</b>\nPattern: ${ell?.pattern || "N/A"}\nConfidence: ${ell?.confidence ?? 0}%`, keyboard: kbActions(symbol) };
  }

  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const news = await fetchNewsBundle(symbol);
    return { text: `📰 <b>News Report</b>\nImpact: ${news?.impact}\nSentiment: ${Math.round((typeof news?.sentiment === "number" ? news.sentiment : 0.5) * 100)}%`, keyboard: kbActions(symbol) };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}