// merge_signals.js
// PREMIUM MULTI-MARKET PANEL (FINAL FIXED VERSION)
// -----------------------------------------------------

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";


// -----------------------------------------------------
// SYMBOL MAPPER (CRITICAL FIX FOR INDIAN MARKETS)
// -----------------------------------------------------
const symbolMap = {
  NIFTY50: "NSE:NIFTY50",
  BANKNIFTY: "NSE:BANKNIFTY",
  SENSEX: "BSE:SENSEX",
  FINNIFTY: "NSE:FINNIFTY"
};


// -----------------------------------------------------
// KEYBOARD WRAPPER (HTML always ON)
// -----------------------------------------------------
function withHTML(keyboard) {
  return { ...keyboard, parse_mode: "HTML" };
}



// -------------------- MAIN MENUS --------------------

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

export const kbIndices = withHTML({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "NIFTY 50", callback_data: "asset_NIFTY50" },
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



// -------------------- ACTION BUTTONS --------------------

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



// -------------------- TIMEFRAME BUTTONS --------------------

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



// -------------------- REPORT FORMATTER --------------------

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



// -------------------- MERGED AI REPORT --------------------

export async function generateReport(symbol, tf = "15m") {

  const realSymbol = symbolMap[symbol] || symbol;

  const ml = await runMLPrediction(realSymbol, tf);
  const ell = await analyzeElliott(ml.explanation?.features?.candles || []);
  const news = await fetchNewsBundle(realSymbol);

  const data = {
    symbol,
    price: ml.explanation?.features?.close || 0,

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

  return { text: formatPremiumReport(data), keyboard: kbActions(symbol) };
}



// -------------------- CALLBACK ROUTER --------------------

export async function handleCallback(query) {
  const data = query.data;

  // HOME
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities", keyboard: kbCommodity };

  // ASSET
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol, "15m");
  }

  // TIMEFRAME
  if (data.startsWith("tf_")) {
    const parts = data.split("_");
    const symbol = parts[1];
    const tf = parts[2];
    return await generateReport(symbol, tf);
  }

  // OPEN TIMEFRAME MENU
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Select timeframe for <b>${symbol}</b>:`, keyboard: kbTimeframes(symbol) };
  }

  // REFRESH
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol, "15m");
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

  // NEWS
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const news = await fetchNewsBundle(symbol);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}