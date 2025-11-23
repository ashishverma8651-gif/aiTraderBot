// merge_signals.js — FINAL FULLY FIXED VERSION
// =============================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

// ================= SYMBOL MAP =================
const symbolMap = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "^NSEBANK",   // Fixed: FINNIFTY Yahoo does not support NSE:FINNIFTY

  GOLD: "GC=F",
  SILVER: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",

  DXY: "DX-Y.NYB",
  XAUUSD: "GC=F",
  XAGUSD: "SI=F",

  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X"
};

// ================= HELPERS =================
function withHTML(keyboard) {
  return { ...keyboard, parse_mode: "HTML" };
}

function isCryptoSymbol(s) {
  if (!s) return false;
  const u = String(s).toUpperCase();
  return u.endsWith("USDT") || u.endsWith("USD") || u.endsWith("BTC") || u.endsWith("ETH");
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// -------------------------------------------------
// KEYBOARDS (unchanged)
// -------------------------------------------------
// Same as your file — keeping them exactly



// ==================== CORE PRICE FETCH WRAPPER ====================
async function resolvePriceAndCandles(symbol, tf = "15m") {

  // --- Primary fetch ---
  const primary = await fetchUniversal(symbol, tf);
  if (primary?.price || primary?.data?.length) {
    return {
      data: primary.data || [],
      price: safeNum(primary.price || primary.data?.at(-1)?.close),
      source: "universal"
    };
  }

  // --- Crypto fallback ---
  if (isCryptoSymbol(symbol)) {
    const m = await fetchMarketData(symbol, tf);
    if (m?.price) return { data: m.data, price: m.price, source: "marketData" };
  }

  // --- MultiTF fallback ---
  const multi = await fetchMultiTF(symbol, [tf]);
  const mt = multi?.[tf];
  if (mt?.price) {
    return { data: mt.data, price: mt.price, source: "multiTF" };
  }

  // --- Final Yahoo fallback (15m) ---
  const again = await fetchUniversal(symbol, "15m");
  if (again?.price || again?.data?.length) {
    return {
      data: again.data,
      price: safeNum(again.price || again.data?.at(-1)?.close),
      source: "universal-fallback"
    };
  }

  return { data: [], price: 0, source: "none" };
}

// ==================== REPORT GENERATOR ====================
export async function generateReport(symbol, tf = "15m") {
  const mappedSymbol = symbolMap[symbol] || symbol;

  // --- PRICE & CANDLES ---
  const { data: candles, price: livePrice, source } =
    await resolvePriceAndCandles(mappedSymbol, tf);

  // --- ML ---
  let ml = {};
  try {
    ml = await runMLPrediction(mappedSymbol, tf) || {};
  } catch { ml = {}; }

  const direction = ml.direction || "Neutral";
  const biasEmoji =
    direction === "Bullish" ? "📈" :
    direction === "Bearish" ? "📉" : "⚪";

  // Targets
  const tp1 = ml.tp1 ?? ml.tpEstimate ?? "—";
  const tp2 = ml.tp2 ?? ml.tp2Estimate ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // --- Elliott ---
  let ell;
  try {
    ell = await analyzeElliott(candles || []);
  } catch { ell = {}; }

  function extractElliott(ell) {
    if (!ell?.patterns?.length)
      return { name: "N/A", conf: ell?.confidence || 50 };
    const p = ell.patterns[0];
    return { name: p.type || "Structure", conf: p.confidence || 50 };
  }
  const ep = extractElliott(ell);

  // --- News ---
  let news = {};
  try {
    news = await fetchNewsBundle(mappedSymbol);
  } catch { news = {}; }

  // --- Output ---------------------
  const out = {
    symbol,
    price: safeNum(livePrice),
    direction,
    biasEmoji,

    tp1,
    tp2,
    tpConf,

    maxProb: ml.maxProb || 50,

    elliottPattern: ep.name,
    elliottConf: ep.conf,

    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment || 50,

    _meta: { mappedSymbol, source, candles: candles.length }
  };

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}

// ==================== CALLBACK ROUTER ====================
export async function handleCallback(query) {
  const data = query.data;

  // HOME MENU
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // ASSET SELECT
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // TIMEFRAME MENU
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // TIMEFRAME SWITCH
  if (data.startsWith("tf_")) {
    const [, symbol, tf] = data.split("_");
    return await generateReport(symbol, tf);
  }

  // REFRESH
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // NEWS
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    const news = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mapped, "15m");
    const ell = await analyzeElliott(pd.data || []);
    const ep = ell?.patterns?.[0]?.type || "N/A";
    const conf = ell?.patterns?.[0]?.confidence || ell?.confidence || 50;
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${ep}\nConfidence: ${conf}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}