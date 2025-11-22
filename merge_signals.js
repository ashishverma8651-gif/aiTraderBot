// merge_signals.js — FINAL PREMIUM AI PANEL (WITH FULL IMPORTS)
// ===============================================================

// 🔥 PRICE ENGINE (YOUR UTILS)
import {
  fetchUniversal,
  fetchMarketData,
  fetchMultiTF
} from "./utils.js";

// 🔥 ML + ELLIOTT + NEWS
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";


// ===============================
// REAL MARKET SYMBOL MAP (FIXED)
// ===============================
const symbolMap = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY"  // Yahoo unsupported → fallback
};


// ===============================
// WRAPPER
// ===============================
function withHTML(keyboard) {
  return { ...keyboard, parse_mode: "HTML" };
}



// ===============================
// HOME MENU
// ===============================
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


// ===============================
// CRYPTO MENU
// ===============================
export const kbCrypto = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "BTC", callback_data: "asset_BTCUSDT" },
        { text: "ETH", callback_data: "asset_ETHUSDT" }
      ],
      [
        { text: "SOL", callback_data: "asset_SOLUSDT" },
        { text: "XRP", callback_data: "asset_XRPUSDT" }
      ],
      [
        { text: "DOGE", callback_data: "asset_DOGEUSDT" },
        { text: "ADA", callback_data: "asset_ADAUSDT" }
      ],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});


// ===============================
// INDICES MENU
// ===============================
export const kbIndices = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "NIFTY50", callback_data: "asset_NIFTY50" },
        { text: "BankNifty", callback_data: "asset_BANKNIFTY" }
      ],
      [
        { text: "Sensex", callback_data: "asset_SENSEX" },
        { text: "FinNifty", callback_data: "asset_FINNIFTY" }
      ],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});


// ===============================
// PRICE + AI REPORT BUILDER
// ===============================
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



// ===============================
// MAIN REPORT (ML + PRICE + NEWS)
// ===============================
export async function generateReport(symbol, tf = "15m") {

  const mappedSymbol = symbolMap[symbol] || symbol;

  // -------------------------
  // PRICE from utils.js
  // -------------------------
  let priceData = await fetchUniversal(mappedSymbol, tf);
  let livePrice = priceData?.price || 0;

  // -------------------------
  // ML PREDICTION
  // -------------------------
  const ml = await runMLPrediction(mappedSymbol, tf) || {};

  const candles = ml?.explanation?.features?.candles || [];

  // -------------------------
  // ELLIOTT WAVES
  // -------------------------
  const ell = await analyzeElliott(candles);

  // -------------------------
  // NEWS & SENTIMENT
  // -------------------------
  const news = await fetchNewsBundle(mappedSymbol);


  // -------------------------
  // MERGED STRUCTURE
  // -------------------------
  const out = {
    symbol,
    price: livePrice,

    direction: ml.direction || "Neutral",
    biasEmoji: ml.direction === "Bullish" ? "📈"
              : ml.direction === "Bearish" ? "📉"
              : "⚪",

    maxProb: ml.maxProb || 50,

    tp1: ml.tpEstimate || "—",
    tp2: ml.tp2Estimate || "—",
    tpConf: ml.tpConfidence || 55,

    elliottPattern: ell?.pattern || "N/A",
    elliottConf: ell?.confidence || 50,

    newsImpact: news?.impact || "Neutral",
    newsScore: news?.sentiment || 50
  };

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}



// ===============================
// BUTTON ROUTER
// ===============================
export async function handleCallback(query) {
  const data = query.data;

  // 🏠 HOME PAGE
  if (data === "back_home")
    return { text: "🏠 HOME", keyboard: kbHome };

  // MAIN MENUS
  if (data === "menu_crypto")
    return { text: "💠 Crypto Market", keyboard: kbCrypto };

  if (data === "menu_indices")
    return { text: "📘 Indices Market", keyboard: kbIndices };

  if (data === "menu_forex")
    return { text: "💱 Forex Market", keyboard: kbForex };

  if (data === "menu_commodities")
    return { text: "🛢 Commodities Market", keyboard: kbCommodity };


  // BACK FROM SUBMENU
  if (data === "back_assets")
    return { text: "Choose Market", keyboard: kbHome };


  // ASSET SELECTED
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol, "15m");
  }

  // TIMEFRAMES MENU
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return {
      text: `🕒 Timeframes for <b>${symbol}</b>`,
      keyboard: kbTimeframes(symbol)
    };
  }

  // TIMEFRAME SELECTED
  if (data.startsWith("tf_")) {
    const parts = data.split("_");
    const symbol = parts[1];
    const tf = parts[2];
    return await generateReport(symbol, tf);
  }

  // REFRESH
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol, "15m");
  }

  // NEWS
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const news = await fetchNewsBundle(symbol);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const ell = await analyzeElliott([]);
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${ell.pattern}\nConfidence: ${ell.confidence}%`,
      keyboard: kbActions(symbol)
    };
  }

  // FALLBACK
  return {
    text: "❌ Unknown command",
    keyboard: kbHome
  };
}

// ===============================
// ACTION BUTTONS MENU
// ===============================
export function kbActions(symbol) {
  return withHTML({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Refresh", callback_data: `refresh_${symbol}` },
          { text: "🕒 Timeframes", callback_data: `tfs_${symbol}` }
        ],
        [
          { text: "📊 Elliott", callback_data: `ell_${symbol}` },
          { text: "📰 News", callback_data: `news_${symbol}` }
        ],
        [{ text: "⬅ Back", callback_data: "back_assets" }]
      ]
    }
  });
}