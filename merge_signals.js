// merge_signals.js
// PREMIUM MULTI-MARKET UI + ROUTER + FORMATTER
// -----------------------------------------------------

import { runMLPrediction } from "./ml_module.js";   // your ML module
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./utils/news.js";

// -------------------- MENU KEYBOARDS --------------------

export const kbHome = {
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
};

export const kbCrypto = {
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
      [
        { text: "⬅ Back", callback_data: "back_home" }
      ]
    ]
  }
};

export const kbIndices = {
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
};

export const kbForex = {
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
};

export const kbCommodity = {
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
};

// -------------------- ACTION BUTTONS --------------------

export function kbActions(symbol) {
  return {
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
  };
}

export function kbTimeframes(symbol) {
  return {
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
  };
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

// -------------------- ASSET PROCESSOR --------------------

export async function generateReport(symbol, tf = "15m") {
  const ml = await runMLPrediction(symbol, tf);
  const ell = await analyzeElliott(ml.explanation?.features?.candles || []);
  const news = await fetchNewsBundle(symbol);

  const data = {
    symbol,
    price: ml.explanation?.features?.close || 0,

    direction: ml.direction,
    biasEmoji: ml.direction === "Bullish" ? "📈"
              : ml.direction === "Bearish" ? "📉" : "⚪",

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
    text: formatPremiumReport(data),
    keyboard: kbActions(symbol)
  };
}

// -------------------- CALLBACK ROUTER --------------------
// This will be used by aiTraderBot.js

export async function handleCallback(query) {
  const data = query.data;

  // ---------- HOME ----------
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities", keyboard: kbCommodity };

  // ---------- ASSET SELECT ----------
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    const out = await generateReport(symbol, "15m");
    return out;
  }

  // ---------- TIMEFRAME SELECT ----------
  if (data.startsWith("tf_")) {
    const [_, symbol, tf] = data.split("_");
    const out = await generateReport(symbol, tf);
    return out;
  }

  // ---------- SHOW TF MENU ----------
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Select timeframe for ${symbol}:`, keyboard: kbTimeframes(symbol) };
  }

  // ---------- REFRESH ----------
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    const out = await generateReport(symbol, "15m");
    return out;
  }

  // ---------- ELLIOTT ONLY ----------
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const ell = await analyzeElliott([]);
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${ell.pattern}\nConfidence: ${ell.confidence}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ---------- NEWS ONLY ----------
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