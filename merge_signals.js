// ====================================================================
//  MERGE SIGNAL ENGINE — PREMIUM v2.3 (FINAL CLEAN VERSION)
//  - Multi-market (Crypto, Indices, Forex, Commodities)
//  - Multi-timeframe
//  - Elliott v2.3 (top-3 unique patterns)
//  - Harmonics unique filtering
//  - Full UI + Keyboard intact
// ====================================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

// =============================================================
// SYMBOL MAP
// =============================================================
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

// =============================================================
// HELPERS
// =============================================================
function withHTML(kb) {
  return { ...kb, parse_mode: "HTML" };
}

function isCryptoSymbol(s) {
  if (!s) return false;
  const u = String(s).toUpperCase();
  return (
    u.endsWith("USDT") ||
    u.endsWith("USD") ||
    u.endsWith("BTC") ||
    u.endsWith("ETH")
  );
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// =============================================================
// KEYBOARDS
// =============================================================
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

// ----- Market selections -----
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

// ====================================================================
//   ELLIOTT DEDUP + TOP 3
// ====================================================================
function dedupeElliott(patterns = []) {
  const map = new Map();
  for (const p of patterns) {
    if (!p.type) continue;
    const conf = Math.round(p.confidence || p.conf || 50);
    if (!map.has(p.type) || conf > map.get(p.type)) {
      map.set(p.type, conf);
    }
  }
  return [...map.entries()]
    .map(([type, conf]) => ({ type, conf }))
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 3);
}

// ====================================================================
//   HARMONICS DEDUP
// ====================================================================
function dedupeHarmonics(list = []) {
  const map = new Map();
  for (const h of list) {
    if (!h.type) continue;
    if (!map.has(h.type) || h.conf > map.get(h.type).conf) {
      map.set(h.type, h);
    }
  }
  return [...map.values()];
}

// ====================================================================
// FORMATTER
// ====================================================================
function formatPremiumReport(r) {
  return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL
━━━━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.elliottPattern}

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.maxProb}%
━━━━━━━━━━━━━━━━━━
`;
}

// ====================================================================
// SAFE CANDLE FETCH
// ====================================================================
async function resolvePriceAndCandles(symbol, tf = "15m") {
  try {
    const universal = await fetchUniversal(symbol, tf);
    if (universal?.data?.length)
      return {
        data: universal.data,
        price: universal.price || universal.data.at(-1).close,
        source: "universal"
      };

    if (isCryptoSymbol(symbol)) {
      const m = await fetchMarketData(symbol, tf);
      if (m?.data?.length)
        return {
          data: m.data,
          price: m.price,
          source: "marketData"
        };
    }

    const multi = await fetchMultiTF(symbol, [tf]);
    if (multi?.[tf]?.data?.length)
      return {
        data: multi[tf].data,
        price: multi[tf].price,
        source: "multiTF"
      };

    return { data: [], price: 0, source: "none" };
  } catch (e) {
    return { data: [], price: 0, source: "error" };
  }
}

// ====================================================================
//   MAIN REPORT
// ====================================================================
export async function generateReport(symbol, tf = "15m") {
  const mappedSymbol = symbolMap[symbol] || symbol;

  // candles
  const { data: candles, price: livePrice } = await resolvePriceAndCandles(mappedSymbol, tf);

  // ML
  let ml = {};
  try { ml = await runMLPrediction(mappedSymbol, tf) || {} } catch {}

  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪";

  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // Elliott
  let ell = {};
  try { ell = await analyzeElliott(candles || []); } catch {}

  const cleanEll = dedupeElliott(ell?.patterns || []);
  const ellSummary = cleanEll.length
    ? cleanEll.map(p => `${p.type}(${p.conf}%)`).join(" + ")
    : "N/A";

  // News
  let news = {};
  try { news = await fetchNewsBundle(mappedSymbol) || {}; } catch {}

  const out = {
    symbol,
    price: livePrice,
    direction,
    biasEmoji,
    tp1,
    tp2,
    tpConf,
    maxProb: ml.maxProb || 50,
    elliottPattern: ellSummary,
    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment || 50
  };

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}

// ====================================================================
// CALLBACK ROUTER
// ====================================================================
export async function handleCallback(query) {
  const d = query.data;

  if (d === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (d === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (d === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (d === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (d === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (d === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // Asset selection
  if (d.startsWith("asset_")) {
    const symbol = d.replace("asset_", "");
    return await generateReport(symbol);
  }

  // Timeframes
  if (d.startsWith("tfs_")) {
    const symbol = d.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  if (d.startsWith("tf_")) {
    const [_, symbol, tf] = d.split("_");
    return await generateReport(symbol, tf);
  }

  // Refresh
  if (d.startsWith("refresh_")) {
    const symbol = d.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // News
  if (d.startsWith("news_")) {
    const symbol = d.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    const n = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${n.impact}\nSentiment: ${n.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // Elliott page
  if (d.startsWith("ell_")) {
    const symbol = d.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mapped, "15m");
    const ell = await analyzeElliott(pd.data || []);
    const cleaned = dedupeElliott(ell?.patterns || []);
    const out = cleaned.length
      ? cleaned.map(p => `${p.type} (${p.conf}%)`).join("\n")
      : "No clear pattern";

    return {
      text: `📊 <b>Elliott Waves</b>\n${out}`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}