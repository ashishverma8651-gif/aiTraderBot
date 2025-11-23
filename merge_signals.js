// ============================================================
// merge_signals.js — v3.4 FINAL (UI OK + TF OK + Single Elliott Pattern)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

const VERSION = "v3.4_FINAL";

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
function withHTML(kb) {
  return { ...kb, parse_mode: "HTML" };
}

function isCryptoLike(sym) {
  if (!sym) return false;
  const s = String(sym).toUpperCase();
  return s.endsWith("USDT") || s.endsWith("USD") || s.includes("BTC");
}

function safeNum(v, fb = 0) {
  const n = Number(v);
 	return Number.isFinite(n) ? n : fb;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return v;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ================= HOME KEYPADS ==================
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

// ACTION KEYPAD
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
        [{ text: "⬅ Back", callback_data: "back_home" }]
      ]
    }
  });
}

// TIMEFRAME KEYPAD
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

// ================== PRICE RESOLVER ==================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    const fetchAndCheck = async (sym, timeframe) => {
      const r = await fetchUniversal(sym, timeframe);
      const data = r?.data || r?.candles || [];
      const price = safeNum(r?.price || data.at(-1)?.close);
      return (price && data.length) ? { data, price } : null;
    };

    let u = await fetchAndCheck(symbolRaw, tf);
    if (u) return { ...u, source: "universal" };

    if (isCryptoLike(symbolRaw)) {
      const c = await fetchMarketData(symbolRaw, tf);
      if (c?.price && c?.data)
        return { data: c.data, price: c.price, source: "marketData" };
    }

    const m = await fetchMultiTF(symbolRaw, [tf]);
    if (m?.[tf]) {
      const d = m[tf].data || [];
      const p = safeNum(m[tf].price || d.at(-1)?.close);
      if (p) return { data: d, price: p, source: "multiTF" };
    }

    if (tf !== "15m") {
      let u15 = await fetchAndCheck(symbolRaw, "15m");
      if (u15) return { ...u15, source: "universal-15m" };
    }

    return { data: [], price: 0, source: "none" };
  } catch {
    return { data: [], price: 0, source: "error" };
  }
}

// ================== MAIN REPORT ==================
export async function generateReport(symbolLabel, tf = "15m") {
  const mapped = symbolMap[symbolLabel] || symbolLabel;

  const { data: candles, price: livePrice } = await resolvePriceAndCandles(mapped, tf);

  let ml = {};
  try { ml = (await runMLPrediction(mapped, tf)) || {}; } catch {}

  let ell = null;
  try {
    if (candles.length >= 8)
      ell = await analyzeElliott(candles.slice(-400));
  } catch {}

  let news = {};
  try { news = (await fetchNewsBundle(mapped)) || {}; } catch {}

  const direction = ml.direction || "Neutral";
  const prob = safeNum(ml.maxProb || 50);

  // =============== FIX: SINGLE BEST PATTERN ONLY ===============
  const ellText = (() => {
    if (!ell?.patterns?.length) return "N/A";
    const best = ell.patterns.sort((a, b) => b.confidence - a.confidence)[0];
    return `${best.type} (${round(best.confidence, 0)}%)`;
  })();

  const out = {
    symbol: symbolLabel,
    price: round(livePrice, 4),
    direction,
    biasEmoji: direction === "Bullish" ? "📈" :
               direction === "Bearish" ? "📉" : "⚪",
    tp1: ml.tp1 ?? "—",
    tp2: ml.tp2 ?? "—",
    maxProb: prob,
    ellText,
    ellConf: ell?.confidence ? round(ell.confidence, 0) : 50,
    newsImpact: news.impact || "Neutral",
    newsScore: news.sentiment || 50
  };

  const text = `
🔥 <b>${out.symbol}</b>
━━━━━━━━━━━━━━
📍 <b>Price:</b> ${out.price}
📊 <b>Trend:</b> ${out.biasEmoji} ${out.direction}
📉 <b>Elliott:</b> ${out.ellText} (${out.ellConf}%)
📰 <b>News:</b> ${out.newsImpact} (${out.newsScore}%)
🎯 <b>TP:</b> ${out.tp1} | Hedge: ${out.tp2}
🤖 <b>ML Prob:</b> ${out.maxProb}%
━━━━━━━━━━━━━━
`;

  return { text, keyboard: kbActions(symbolLabel) };
}

// ================= CALLBACK HANDLER ==================
export async function handleCallback(query) {
  const data = query.data;

  // Menus
  if (data === "back_home") return { text: "🏠 Home", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };

  // Asset
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    const r = await generateReport(symbol);
    return { text: r.text, keyboard: r.keyboard };
  }

  // Timeframe menu
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes: <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // Timeframe selected
  if (data.startsWith("tf_")) {
    const clean = data.replace("tf_", "");
    const [symbol, tf] = clean.split("_");
    const r = await generateReport(symbol, tf);
    return { text: r.text, keyboard: r.keyboard };
  }

  // Refresh
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    const r = await generateReport(symbol);
    return { text: r.text, keyboard: r.keyboard };
  }

  // News
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;

    const n = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News</b>\nImpact: ${n.impact}\nSentiment: ${n.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // Elliott detailed
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;

    const { data: cdl } = await resolvePriceAndCandles(mapped, "15m");
    let ell = null;

    try { ell = await analyzeElliott(cdl.slice(-500)); } catch {}

    if (!ell || !ell.patterns?.length) {
      return { text: "📊 Elliott: N/A", keyboard: kbActions(symbol) };
    }

    const det = ell.patterns
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(p => `${p.type} (${round(p.confidence, 0)}%)`)
      .join("\n");

    return {
      text: `📊 <b>Elliott (15m Detailed)</b>\n${det}\nConfidence: ${round(ell.confidence, 0)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown", keyboard: kbHome };
}