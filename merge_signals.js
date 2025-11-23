// ===============================================================
// merge_signals.js — FINAL FIXED VERSION (FOREX + COMMODITY + NSE + CRYPTO)
// ===============================================================

// 🔥 PRICE ENGINE
import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData,
  fetchYahooCandle   // <-- NEW FIX
} from "./utils.js";

// 🔥 AI MODULES
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";


// ==============================================================
// SYMBOL MAP
// ==============================================================
const symbolMap = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY",

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


// ==============================================================
// UI WRAPPER
// ==============================================================
function html(kb) {
  return { ...kb, parse_mode: "HTML" };
}


// ==============================================================
// MENU KEYBOARDS (UNCHANGED)
// ==============================================================
export const kbHome = html({
  reply_markup: {
    inline_keyboard: [
      [{ text: "💠 Crypto", callback_data: "menu_crypto" },
       { text: "📘 Indices", callback_data: "menu_indices" }],
      [{ text: "💱 Forex", callback_data: "menu_forex" },
       { text: "🛢 Commodities", callback_data: "menu_commodities" }]
    ]
  }
});

// ... (YOUR SAME MENUS — NOT MODIFYING THEM)

// ==============================================================
// Elliott extractor
// ==============================================================
function extractElliottPattern(ell) {
  if (!ell || !ell.patterns || !ell.patterns.length)
    return { name: "N/A", conf: 50 };

  const p = ell.patterns[0];
  return {
    name: p.type || "Structure",
    conf: p.confidence || 50
  };
}


// ==============================================================
// FORMATTER
// ==============================================================
export function formatPremiumReport(r) {
  return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL
━━━━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.ellPattern} (${r.ellConf}%)

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.mlProb}%
━━━━━━━━━━━━━━━━━━
`;
}


// ==============================================================
// FIXED — MAIN REPORT
// ==============================================================
export async function generateReport(symbol, tf = "15m") {
  const m = symbolMap[symbol] || symbol;

  // ===================================
  // FIX: Yahoo + Binance dual fetch
  // ===================================
  let priceData = await fetchUniversal(m);

  // Candle source fix
  let candles = [];

  // Crypto → fetchMultiTF
  if (symbol.endsWith("USDT")) {
    const pack = await fetchMultiTF(symbol, [tf]);
    candles = pack?.[tf]?.data || [];
  }

  // Forex / Commodity / Indices → Yahoo fallback
  else {
    const y = await fetchYahooCandle(m, tf);
    candles = y?.candles || [];
  }

  const livePrice = priceData?.price || candles.at(-1)?.close || 0;

  // ML FIXED
  const ml = await runMLPrediction({ symbol: m, candles, tf }) || {};

  const direction = ml.direction || "Neutral";
  const biasEmoji =
    direction === "Bullish" ? "📈" :
    direction === "Bearish" ? "📉" : "⚪";

  const tp1 = ml.tp1 || "—";
  const tp2 = ml.tp2 || "—";
  const tpConf = ml.tpConfidence || 55;

  // Elliott FIXED
  const ell = await analyzeElliott(candles);
  const ep = extractElliottPattern(ell);

  // NEWS FIXED
  const news = await fetchNewsBundle(m) || {};

  const result = {
    symbol,
    price: livePrice,
    direction,
    biasEmoji,

    tp1,
    tp2,
    tpConf,

    mlProb: ml.maxProb || 50,

    ellPattern: ep.name,
    ellConf: ep.conf,

    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment || 50
  };

  return {
    text: formatPremiumReport(result),
    keyboard: kbActions(symbol)
  };
}


// ==============================================================
// CALLBACK HANDLER (NO CHANGE NEEDED)
// ==============================================================
export async function handleCallback(q) {
  const data = q.data;

  if (data.startsWith("asset_")) {
    return generateReport(data.replace("asset_", ""));
  }

  if (data.startsWith("tf_")) {
    const [, sym, tf] = data.split("_");
    return generateReport(sym, tf);
  }

  if (data.startsWith("refresh_")) {
    return generateReport(data.replace("refresh_", ""));
  }

  return { text: "⛔ Unknown command", keyboard: kbHome };
}