// merge_signals.js — FINAL MERGE (works with utils.js v2.5)
// ========================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

// -----------------------------
// SYMBOL MAP (keeps friendly names)
// -----------------------------
const symbolMap = {
  // INDICES (utils handles these names)
  NIFTY50: "NIFTY50",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "FINNIFTY",
  SENSEX: "SENSEX",

  // COMMODITIES / FOREX (utils maps to Yahoo codes)
  GOLD: "GOLD",
  XAUUSD: "XAUUSD",
  SILVER: "SILVER",
  XAGUSD: "XAGUSD",
  CRUDE: "CRUDE",
  NGAS: "NGAS",

  EURUSD: "EURUSD",
  GBPUSD: "GBPUSD",
  USDJPY: "USDJPY",
  DXY: "DXY"
};

// -----------------------------
// UTIL HELPERS
// -----------------------------
function withHTML(kb) {
  return { ...kb, parse_mode: "HTML" };
}
const safeNum = v => (typeof v === "number" ? v : Number(v) || 0);
const isCrypto = s => !!s && (s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BTC"));

// -----------------------------
// KEYBOARDS (UI)
// -----------------------------
export const kbHome = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "💠 Crypto", callback_data: "menu_crypto" },
        { text: "📘 Indices", callback_data: "menu_indices" }
      ],
      [
        { text: "💱 Forex", callback_data: "menu_forex" },
        { text: "🛢 Commodities", callback_data: "menu_commodities" }
      ]
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
      [{ text: "NIFTY50", callback_data: "asset_NIFTY50" }, { text: "BankNifty", callback_data: "asset_BANKNIFTY" }],
      [{ text: "Sensex", callback_data: "asset_SENSEX" }, { text: "FinNifty", callback_data: "asset_FINNIFTY" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbForex = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "EURUSD", callback_data: "asset_EURUSD" }, { text: "GBPUSD", callback_data: "asset_GBPUSD" }],
      [{ text: "USDJPY", callback_data: "asset_USDJPY" }, { text: "XAUUSD", callback_data: "asset_XAUUSD" }],
      [{ text: "XAGUSD", callback_data: "asset_XAGUSD" }, { text: "DXY", callback_data: "asset_DXY" }],
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

// -----------------------------
// FORMATTER
// -----------------------------
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

// -----------------------------
// RESOLVE PRICE + CANDLES (multi-source + multi-TF)
// returns { data:[], price:, source: string }
// -----------------------------
async function resolvePriceAndCandles(inputSymbol, tf = "15m") {
  const symbol = symbolMap[inputSymbol] || inputSymbol;

  // 1) Primary: utils.fetchUniversal (respects TF)
  try {
    const primary = await fetchUniversal(symbol, tf);
    if (primary && ((primary.price && primary.price !== 0) || (primary.data && primary.data.length > 0))) {
      return { data: primary.data || [], price: safeNum(primary.price || (primary.data?.at(-1)?.close || 0)), source: "universal" };
    }
  } catch (e) {
    // ignore and continue to fallback
    console.debug("[merge_signals] fetchUniversal error:", e?.message || e);
  }

  // 2) If crypto-like, try fetchMarketData (Binance cached)
  if (isCrypto(symbol)) {
    try {
      const md = await fetchMarketData(symbol, tf);
      if (md && md.price && (md.data?.length > 0)) {
        return { data: md.data, price: safeNum(md.price), source: "marketData" };
      }
    } catch (e) {
      console.debug("[merge_signals] fetchMarketData error:", e?.message || e);
    }
  }

  // 3) fetchMultiTF (sometimes sources provide only other TFs; get TF bundle)
  try {
    const multi = await fetchMultiTF(symbol, [tf]);
    if (multi && multi[tf] && ((multi[tf].price && multi[tf].price !== 0) || (multi[tf].data && multi[tf].data.length))) {
      return { data: multi[tf].data || [], price: safeNum(multi[tf].price || (multi[tf].data?.at(-1)?.close || 0)), source: "multiTF" };
    }
  } catch (e) {
    console.debug("[merge_signals] fetchMultiTF error:", e?.message || e);
  }

  // 4) Last-resort: try universal with 15m (useful for some Yahoo endpoints)
  if (tf !== "15m") {
    try {
      const fallback = await fetchUniversal(symbol, "15m");
      if (fallback && (fallback.data?.length || fallback.price)) {
        return { data: fallback.data || [], price: safeNum(fallback.price || (fallback.data?.at(-1)?.close || 0)), source: "universal-15m-fallback" };
      }
    } catch (e) { /* ignore */ }
  }

  // nothing found
  return { data: [], price: 0, source: "none" };
}

// -----------------------------
// generateReport
// -----------------------------
export async function generateReport(inputSymbol, tf = "15m") {
  const requestedSymbol = inputSymbol;
  const symbol = symbolMap[inputSymbol] || inputSymbol;

  // fetch candles/price for requested TF
  const { data: candlesRaw, price: livePrice, source } = await resolvePriceAndCandles(requestedSymbol, tf);

  // ensure candles are arrays of {t,open,high,low,close,vol}
  const candles = Array.isArray(candlesRaw) ? candlesRaw : [];

  // call ML prediction (pass mapped symbol and tf)
  let ml = {};
  try {
    ml = (await runMLPrediction(symbol, tf)) || {};
  } catch (e) {
    console.debug("[merge_signals] runMLPrediction failed:", e?.message || e);
    ml = {};
  }

  // elliott analysis for the TF-specific candles
  let ell = {};
  try {
    // pass candles (if empty, analyzeElliott returns ok:false)
    ell = await analyzeElliott(Array.isArray(candles) ? candles : []);
  } catch (e) {
    console.debug("[merge_signals] analyzeElliott failed:", e?.message || e);
    ell = {};
  }

  // news
  let news = {};
  try {
    news = (await fetchNewsBundle(symbol)) || {};
  } catch (e) {
    console.debug("[merge_signals] fetchNewsBundle failed:", e?.message || e);
    news = {};
  }

  // prepare outputs (safe lookups)
  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪";

  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  const ellPattern = (ell && Array.isArray(ell.patterns) && ell.patterns.length ? ell.patterns[0].type : "N/A");
  const ellConfidence = ell?.confidence ?? ell?.confidence || 50;

  const out = {
    symbol: requestedSymbol,
    price: safeNum(livePrice),
    direction,
    biasEmoji,

    tp1,
    tp2,
    tpConf,

    maxProb: ml.maxProb ?? 50,

    elliottPattern: ellPattern,
    elliottConf: ellConfidence,

    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment ?? 50,

    // internal metadata for debug (not shown in message body)
    _meta: { source, candlesCount: (candles || []).length, tf, mappedSymbol: symbol }
  };

  // (optional) console debug — remove/comment if clutter
  console.debug("[merge_signals] report meta:", out._meta);

  return { text: formatPremiumReport(out), keyboard: kbActions(requestedSymbol) };
}

// -----------------------------
// CALLBACK ROUTER
// -----------------------------
export async function handleCallback(query) {
  const data = query.data;

  // Home / Menus
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities", keyboard: kbCommodity };

  // Back
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // Asset selected
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol, "15m");
  }

  // Timeframes list
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // TF selection - supports symbol_tf or asset_SYMBOL_tf variants
  if (data.startsWith("tf_")) {
    // expected: tf_SYMBOL_5m  OR tf_SYMBOL_15m etc.
    const rest = data.replace("tf_", ""); // e.g. BTCUSDT_5m
    const parts = rest.split("_");
    // if parts length >=2: [SYMBOL, TF]
    if (parts.length >= 2) {
      const tf = parts.pop();
      const symbol = parts.join("_");
      return await generateReport(symbol, tf);
    } else {
      // fallback parse "tf_SYMBOLTF" — treat last 2/3 chars as tf
      const raw = rest;
      // try extracting last 2-3 chars (e.g. 5m,15m,1h,4h)
      const possible = ["1m","5m","15m","30m","1h","4h","1d"];
      for (const p of possible) {
        if (raw.endsWith(p)) {
          const symbol = raw.slice(0, -p.length);
          return await generateReport(symbol, p);
        }
      }
      // default safe
      return await generateReport(rest, "15m");
    }
  }

  // Refresh (re-run default TF 15m)
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol, "15m");
  }

  // News
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    let news = {};
    try { news = await fetchNewsBundle(mapped) || {}; } catch (e) { news = {}; }
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact || "Neutral"}\nSentiment: ${news.sentiment ?? 50}%`,
      keyboard: kbActions(symbol)
    };
  }

  // Elliott details
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mapped, "15m");
    const ell = await analyzeElliott(Array.isArray(pd.data) ? pd.data : []);
    const p = (ell && Array.isArray(ell.patterns) && ell.patterns.length) ? ell.patterns[0] : null;
    const name = p ? p.type : "N/A";
    const conf = ell?.confidence ?? 50;
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${name}\nConfidence: ${conf}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}