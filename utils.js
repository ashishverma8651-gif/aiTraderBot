// ===============================================================
// merge_signals.js — FINAL PREMIUM AI PANEL (FOREX + COMMOD FIXED)
// ===============================================================

// PRICE ENGINE
import {
  fetchUniversal
} from "./utils.js";

// AI MODULES
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";


// ==============================================================
// SYMBOL MAP (FULL & FIXED)
// ==============================================================
const symbolMap = {
  // Indian Indices
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY",

  // Commodities (Yahoo)
  GOLD: "GC=F",
  SILVER: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",

  // Forex (Yahoo)
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  XAUUSD: "GC=F",
  XAGUSD: "SI=F",
  DXY: "DX-Y.NYB",

  // Crypto (Binance)
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
  DOGE: "DOGEUSDT",
  ADA: "ADAUSDT"
};


// ==============================================================
// WRAPPER
// ==============================================================
function withHTML(keyboard) {
  return { ...keyboard, parse_mode: "HTML" };
}


// ==============================================================
// HOME MENU
// ==============================================================
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


// ==============================================================
// MENUS (Crypto / Indices / Forex / Commodities)
// ==============================================================

export const kbCrypto = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "BTC", callback_data: "asset_BTC" },
        { text: "ETH", callback_data: "asset_ETH" }
      ],
      [
        { text: "SOL", callback_data: "asset_SOL" },
        { text: "XRP", callback_data: "asset_XRP" }
      ],
      [
        { text: "DOGE", callback_data: "asset_DOGE" },
        { text: "ADA", callback_data: "asset_ADA" }
      ],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});


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


// ==============================================================
// ACTION BUTTONS
// ==============================================================
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


// ==============================================================
// TIMEFRAMES
// ==============================================================
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


// ==============================================================
// Elliott Helper
// ==============================================================
function extractElliottPattern(ell) {
  if (!ell?.patterns?.length)
    return { name: "N/A", conf: ell?.confidence || 50 };

  const p = ell.patterns[0];
  return {
    name: p.type || "Pattern",
    conf: p.confidence || ell.confidence || 50
  };
}


// ==============================================================
// REPORT FORMATTER
// ==============================================================
export function formatPremiumReport(r) {
  return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL
━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.elliottPattern} (${r.elliottConf}%)

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.maxProb}%
━━━━━━━━━━━━━━━
`;
}


// ==============================================================
// MAIN REPORT GENERATOR
// ==============================================================
export async function generateReport(symbol, tf = "15m") {
  const mapped = symbolMap[symbol] || symbol;

  const mkt = await fetchUniversal(mapped, tf);
  const candles = mkt.data || [];

  const price = mkt.price || 0;

  // ML
  const ml = await runMLPrediction(mapped, tf) || {};
  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" :
                    direction === "Bearish" ? "📉" : "⚪";

  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // Elliott
  const ell = await analyzeElliott(candles);
  const ep = extractElliottPattern(ell);

  // News
  const news = await fetchNewsBundle(mapped);

  return {
    text: formatPremiumReport({
      symbol,
      price,
      direction,
      biasEmoji,

      tp1,
      tp2,
      tpConf,
      maxProb: ml.maxProb || 50,

      elliottPattern: ep.name,
      elliottConf: ep.conf,

      newsImpact: news.impact || "Neutral",
      newsScore: news.sentiment || 50
    }),

    keyboard: kbActions(symbol)
  };
}


// ==============================================================
// CALLBACK ROUTER
// ==============================================================
export async function handleCallback(query) {
  const data = query.data;

  // HOME
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };

  if (data === "menu_crypto") return { text: "💠 Crypto", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // ASSET
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // TF Menu
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return {
      text: `🕒 Timeframes for <b>${symbol}</b>`,
      keyboard: kbTimeframes(symbol)
    };
  }

  // Specific TF
  if (data.startsWith("tf_")) {
    const [, symbol, tf] = data.split("_");
    return await generateReport(symbol, tf);
  }

  // Refresh
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // News
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;

    const news = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>
Impact: ${news.impact}
Sentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // Elliott
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;

    const mkt = await fetchUniversal(mapped);
    const candles = mkt.data || [];

    const ell = await analyzeElliott(candles);
    const ep = extractElliottPattern(ell);

    return {
      text: `📊 <b>Elliott Waves</b>
Pattern: ${ep.name}
Confidence: ${ep.conf}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}