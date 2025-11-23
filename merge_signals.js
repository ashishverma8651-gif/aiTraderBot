// ===============================================================
// merge_signals.js — FINAL PREMIUM AI PANEL (FIXED + VERIFIED)
// ===============================================================

// 🔥 PRICE ENGINE
import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

// 🔥 AI MODULES
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";


// ===============================
// SYMBOL MAP
// ===============================
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


// ===============================
// WRAPPER (SAFE HTML)
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
// FOREX MENU
// ===============================
export const kbForex = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "EURUSD", callback_data: "asset_EURUSD" },
        { text: "GBPUSD", callback_data: "asset_GBPUSD" }
      ],
      [
        { text: "USDJPY", callback_data: "asset_USDJPY" },
        { text: "XAUUSD", callback_data: "asset_XAUUSD" }
      ],
      [
        { text: "XAGUSD", callback_data: "asset_XAGUSD" },
        { text: "DXY", callback_data: "asset_DXY" }
      ],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});


// ===============================
// COMMODITIES MENU
// ===============================
export const kbCommodity = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "GOLD", callback_data: "asset_GOLD" },
        { text: "SILVER", callback_data: "asset_SILVER" }
      ],
      [
        { text: "CRUDE", callback_data: "asset_CRUDE" },
        { text: "NGAS", callback_data: "asset_NGAS" }
      ],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});


// =====================================================
// ACTION BUTTONS
// =====================================================
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


// =====================================================
// TIMEFRAME SELECTOR
// =====================================================
export function kbTimeframes(symbol) {
  return withHTML({
    reply_markup: {
      inline_keyboard: [
        [
          { text: "5m", callback_data: `tf_${symbol}_5m` },
          { text: "15m", callback_data: `tf_${symbol}_15m` }
        ],
        [
          { text: "30m", callback_data: `tf_${symbol}_30m` },
          { text: "1h", callback_data: `tf_${symbol}_1h` }
        ],
        [
          { text: "4h", callback_data: `tf_${symbol}_4h` },
          { text: "1D", callback_data: `tf_${symbol}_1d` }
        ],
        [{ text: "⬅ Back", callback_data: `asset_${symbol}` }]
      ]
    }
  });
}



// =====================================================
// PREMIUM REPORT
// =====================================================
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



// =====================================================
// MAIN AI REPORT BUILDER
// =====================================================
export async function generateReport(symbol, tf = "15m") {

  const mappedSymbol = symbolMap[symbol] || symbol;

  // PRICE
  const priceData = await fetchUniversal(mappedSymbol, tf);
  let livePrice = priceData?.price || 0;

  // ML
  const ml = await runMLPrediction(mappedSymbol, tf) || {};
  const candles = ml?.explanation?.features?.candles || [];

  // Elliott (SAFE)
  const ell = await analyzeElliott(candles || []);

  // NEWS (with mappedSymbol fix)
  const news = await fetchNewsBundle(mappedSymbol) || {};

  const out = {
    symbol,
    price: livePrice,

    direction: ml.direction || "Neutral",
    biasEmoji:
      ml.direction === "Bullish" ? "📈" :
      ml.direction === "Bearish" ? "📉" : "⚪",

    maxProb: ml.maxProb || 50,
    tp1: ml.tpEstimate || "—",
    tp2: ml.tp2Estimate || "—",
    tpConf: ml.tpConfidence || 55,

    elliottPattern: ell?.pattern || "N/A",
    elliottConf: ell?.confidence || 50,

    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment || 50
  };

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}



// =====================================================
// CALLBACK ROUTER (FIXED)
// =====================================================
export async function handleCallback(query) {
  const data = query.data;

  // HOME NAV
  if (data === "back_home")
    return { text: "🏠 HOME", keyboard: kbHome };

  if (data === "menu_crypto")
    return { text: "💠 Crypto Market", keyboard: kbCrypto };

  if (data === "menu_indices")
    return { text: "📘 Indices Market", keyboard: kbIndices };

  if (data === "menu_forex")
    return { text: "💱 Forex Market", keyboard: kbForex };

  if (data === "menu_commodities")
    return { text: "🛢 Commodities Market", keyboard: kbCommodity };

  if (data === "back_assets")
    return { text: "Choose Market", keyboard: kbHome };

  // SELECTED ASSET
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // TIMEFRAME MENU
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return {
      text: `🕒 Timeframes for <b>${symbol}</b>`,
      keyboard: kbTimeframes(symbol)
    };
  }

  // SPECIFIC TF
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
    const mappedSymbol = symbolMap[symbol] || symbol;
    const news = await fetchNewsBundle(mappedSymbol);

    return {
      text: `📰 <b>News Report</b>
Impact: ${news.impact}
Sentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mappedSymbol = symbolMap[symbol] || symbol;

    // get candles from main fetch
    const priceData = await fetchUniversal(mappedSymbol, "15m");
    const candles = priceData?.data || [];

    const ell = await analyzeElliott(candles);

    return {
      text: `📊 <b>Elliott Waves</b>
Pattern: ${ell.pattern}
Confidence: ${ell.confidence}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}