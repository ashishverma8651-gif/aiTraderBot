// merge_signals.js — FINAL PREMIUM AI PANEL (FIXED + FALLBACKS)
// ============================================================

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

// ================= KEYBOARDS =================
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

// ================= ELLIOTT UTIL =================
function extractElliottPattern(ell) {
  if (!ell || !ell.patterns || !ell.patterns.length) {
    return { name: "N/A", conf: ell?.confidence || 50 };
  }
  const p = ell.patterns[0];
  return { name: p.type || "Structure", conf: p.confidence || ell.confidence || 50 };
}

// ================= FORMATTER =================
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

// ==================== PRICE / DATA FETCH WRAPPER WITH FALLBACKS ====================
async function resolvePriceAndCandles(symbol, tf = "15m") {
  // symbol is already mapped before call
  try {
    console.debug(`[merge_signals] resolvePriceAndCandles — primary fetchUniversal('${symbol}', '${tf}')`);
    const primary = await fetchUniversal(symbol, tf);
    if (primary && ((primary.price && primary.price !== 0) || (primary.data && primary.data.length))) {
      console.debug(`[merge_signals] primary success for ${symbol} price=${primary.price}`);
      return { data: primary.data || primary.candles || [], price: safeNum(primary.price || (primary.data?.at(-1)?.close)), source: "universal" };
    }

    // Fallback 1: if it's crypto-like try fetchMarketData
    if (isCryptoSymbol(symbol)) {
      console.debug(`[merge_signals] fallback crypto fetchMarketData('${symbol}', '${tf}')`);
      const m = await fetchMarketData(symbol, tf);
      if (m && m.price && m.price !== 0) return { data: m.data || [], price: safeNum(m.price), source: "marketData" };
    }

    // Fallback 2: try fetchMultiTF and pick requested tf
    try {
      console.debug(`[merge_signals] fallback fetchMultiTF('${symbol}')`);
      const multi = await fetchMultiTF(symbol, [tf]);
      if (multi && multi[tf] && multi[tf].price && multi[tf].price !== 0) {
        return { data: multi[tf].data || [], price: safeNum(multi[tf].price), source: "multiTF" };
      }
    } catch (e) {
      /* ignore */
    }

    // Fallback 3: if symbol looks like Yahoo ticker (contains '=' or ends with X or starts with ^) try fetchUniversal again with tf='15m'
    if (!symbol.includes("USDT") && (symbol.includes("=") || symbol.endsWith("=X") || symbol.startsWith("^"))) {
      console.debug(`[merge_signals] re-trying universal with fallback tf='15m' for ${symbol}`);
      const p2 = await fetchUniversal(symbol, "15m");
      if (p2 && (p2.price || (p2.data && p2.data.length))) return { data: p2.data || [], price: safeNum(p2.price || p2.data?.at(-1)?.close), source: "universal-2" };
    }

    // Nothing found — return empty
    console.debug(`[merge_signals] all fetch attempts failed for ${symbol}`);
    return { data: [], price: 0, source: "none" };

  } catch (err) {
    console.debug(`[merge_signals] resolvePriceAndCandles error for ${symbol}:`, err?.message || err);
    return { data: [], price: 0, source: "error" };
  }
}

// ==================== MAIN REPORT ====================
export async function generateReport(symbol, tf = "15m") {
  const mappedSymbol = symbolMap[symbol] || symbol;

  // fetch price & candles with robust fallback strategy
  const { data: candles, price: livePrice, source } = await resolvePriceAndCandles(mappedSymbol, tf);

  // ML prediction (use mappedSymbol for ML as well)
  let ml = {};
  try {
    ml = (await runMLPrediction(mappedSymbol, tf)) || {};
  } catch (e) {
    console.debug(`[merge_signals] runMLPrediction error for ${mappedSymbol}:`, e?.message || e);
    ml = {};
  }

  // Determine direction & emojis / TP fields (safe)
  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪";

  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // Elliott analysis (safe)
  let ell = {};
  try {
    ell = await analyzeElliott(Array.isArray(candles) ? candles : []);
  } catch (e) {
    console.debug(`[merge_signals] analyzeElliott error for ${mappedSymbol}:`, e?.message || e);
    ell = {};
  }
  const ep = extractElliottPattern(ell);

  // News
  let news = {};
  try {
    news = (await fetchNewsBundle(mappedSymbol)) || {};
  } catch (e) {
    console.debug(`[merge_signals] fetchNewsBundle error for ${mappedSymbol}:`, e?.message || e);
    news = {};
  }

  // Build output
  const out = {
    symbol,
    price: livePrice,
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

    _meta: { mappedSymbol, source, candlesFound: Array.isArray(candles) ? candles.length : 0 }
  };

  // Note: _meta is internal — not shown in message but useful in logs; remove if you prefer.
  console.debug("[merge_signals] Report meta:", out._meta);

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}

// ==================== CALLBACK ROUTING ====================
export async function handleCallback(query) {
  const data = query.data;

  // HOME
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // ASSET
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // TIMEFRAMES LIST
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // TF SELECT
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
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT button
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mappedSymbol = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mappedSymbol, "15m");
    const ell = await analyzeElliott(pd.data || []);
    const ep = extractElliottPattern(ell);
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${ep.name}\nConfidence: ${ep.conf}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}