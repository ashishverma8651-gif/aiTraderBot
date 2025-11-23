// ============================================================
// merge_signals.js — v4.0 ULTRA FINAL (UI-SAFE + Elliott V3 + TF FIX)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

const VERSION = "v4.0_UI_SAFE";

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
function wrap(text, kb) {
  return {
    text,
    parse_mode: "HTML",
    reply_markup: kb?.reply_markup
  };
}

function isCryptoLike(sym) {
  if (!sym) return false;
  const s = sym.toUpperCase();
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

function kb(k) {
  return { ...k, parse_mode: "HTML" };
}

// ================== HOME MENUS ==================
export const kbHome = kb({
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

export const kbCrypto = kb({
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

export const kbIndices = kb({
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

export const kbForex = kb({
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

export const kbCommodity = kb({
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
  return kb({
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

// TIMEFRAME KEYPAD
export function kbTimeframes(symbol) {
  return kb({
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

// ==================== PRICE RESOLVER ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    const attempt = async (sym, timeframe) => {
      const r = await fetchUniversal(sym, timeframe);
      const data = r?.data || r?.candles || [];
      const price = safeNum(r?.price || data.at(-1)?.close);
      return (price && data.length) ? { data, price } : null;
    };

    let p = await attempt(symbolRaw, tf);
    if (p) return { ...p, source: "universal" };

    if (isCryptoLike(symbolRaw)) {
      const c = await fetchMarketData(symbolRaw, tf);
      if (c?.price) return { data: c.data, price: c.price, source: "marketData" };
    }

    const mtf = await fetchMultiTF(symbolRaw, [tf]);
    if (mtf?.[tf]) {
      const d = mtf[tf].data || [];
      const price = safeNum(mtf[tf].price || d.at(-1)?.close);
      if (price) return { data: d, price, source: "multiTF" };
    }

    if (tf !== "15m") {
      let fb = await attempt(symbolRaw, "15m");
      if (fb) return { ...fb, source: "fallback-15m" };
    }

    return { data: [], price: 0, source: "none" };
  } catch {
    return { data: [], price: 0, source: "error" };
  }
}

// ================== MAIN REPORT ==================
export async function generateReport(symbolLabel, tf = "15m") {
  const mapped = symbolMap[symbolLabel] || symbolLabel;

  const { data: candles, price } = await resolvePriceAndCandles(mapped, tf);

  let ml = {};
  try { ml = await runMLPrediction(mapped, tf); } catch {}

  let ell = null;
  try {
    if (candles.length >= 12) ell = await analyzeElliott(candles.slice(-400));
  } catch {}

  let news = {};
  try { news = await fetchNewsBundle(mapped); } catch {}

  const txt = `
🔥 <b>${symbolLabel}</b> — <i>${tf}</i>
━━━━━━━━━━━━━━
📍 <b>Price:</b> ${round(price, 4)}
📊 <b>Trend:</b> ${ml.direction || "Neutral"}
📉 <b>Elliott:</b> ${
    ell?.patterns
      ?.map(p => `${p.type}(${round(p.confidence, 0)}%)`)
      ?.join(" + ") || "N/A"
  }
📰 <b>News:</b> ${news.impact || "Neutral"} (${news.sentiment || 50}%)
🎯 <b>TP:</b> ${ml.tp1 || "—"} | Hedge: ${ml.tp2 || "—"}
🤖 <b>ML Prob:</b> ${ml.maxProb || 50}%
━━━━━━━━━━━━━━
`;

  return wrap(txt, kbActions(symbolLabel));
}

// ================= CALLBACK HANDLER ==================
export async function handleCallback(query) {
  const data = query.data;

  if (data === "back_home") return wrap("🏠 Home", kbHome);
  if (data === "menu_crypto") return wrap("💠 Crypto", kbCrypto);
  if (data === "menu_indices") return wrap("📘 Indices", kbIndices);
  if (data === "menu_forex") return wrap("💱 Forex", kbForex);
  if (data === "menu_commodities") return wrap("🛢 Commodities", kbCommodity);
  if (data === "back_assets") return wrap("Choose Market", kbHome);

  if (data.startsWith("asset_")) {
    const sym = data.replace("asset_", "");
    return await generateReport(sym);
  }

  if (data.startsWith("tfs_")) {
    const sym = data.replace("tfs_", "");
    return wrap(`🕒 Timeframes: <b>${sym}</b>`, kbTimeframes(sym));
  }

  if (data.startsWith("tf_")) {
    const [_, symbol, tf] = data.split("_");
    return await generateReport(symbol, tf);
  }

  if (data.startsWith("refresh_")) {
    const sym = data.replace("refresh_", "");
    return await generateReport(sym);
  }

  if (data.startsWith("news_")) {
    const sym = data.replace("news_", "");
    const mapped = symbolMap[sym] || sym;
    const n = await fetchNewsBundle(mapped);
    return wrap(
      `📰 <b>News</b>\nImpact: ${n.impact}\nSentiment: ${n.sentiment}%`,
      kbActions(sym)
    );
  }

  if (data.startsWith("ell_")) {
    const sym = data.replace("ell_", "");
    const mapped = symbolMap[sym] || sym;
    const { data: cd } = await resolvePriceAndCandles(mapped, "15m");

    let ell = null;
    try { ell = await analyzeElliott(cd.slice(-500)); } catch {}

    const det = ell?.patterns
      ?.map(p => `${p.type} (${round(p.confidence, 0)}%)`)
      ?.slice(0, 6)
      ?.join(" + ") || "N/A";

    return wrap(
      `📊 <b>Elliott (15m)</b>\n${det}\nConfidence: ${round(ell?.confidence || 50, 0)}%`,
      kbActions(sym)
    );
  }

  return wrap("❌ Unknown", kbHome);
}

