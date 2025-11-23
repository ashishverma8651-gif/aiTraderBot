// ============================================================
// merge_signals.js — v3.3 FINAL STABLE (UI + TF FIX + Elliott V3) - FIXED
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

const VERSION = "v3.3_FINAL_STABLE_FIXED";

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
  return s.endsWith("USDT") || s.endsWith("USD") || s.includes("BTC") || s.includes("ETH");
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

// ================== HOME KEYPADS ==================
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
        [{ text: "⬅ Back", callback_data: "back_assets" }]
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

// ==================== AUX: dedupe + top patterns ====================
function dedupeAndPickTop(patterns = [], maxKeep = 4) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const map = new Map(); // type -> best pattern
  for (const p of patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? p.conf ?? 0);
    if (!map.has(t) || conf > safeNum(map.get(t).confidence ?? map.get(t).conf ?? 0)) {
      map.set(t, { ...p, confidence: conf });
    }
  }
  // sort by confidence desc and keep top N
  return Array.from(map.values())
    .sort((a, b) => safeNum(b.confidence) - safeNum(a.confidence))
    .slice(0, maxKeep);
}

// ==================== PRICE RESOLVER ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    const fetchAndCheck = async (sym, timeframe) => {
      const r = await fetchUniversal(sym, timeframe);
      const data = r?.data || r?.candles || [];
      const price = safeNum(r?.price || (Array.isArray(data) && data.length ? data.at(-1)?.close : 0));
      return (price && data && data.length) ? { data, price } : null;
    };

    // 1. Universal
    let u = await fetchAndCheck(symbolRaw, tf);
    if (u) return { ...u, source: "universal" };

    // 2. Crypto fallback
    if (isCryptoLike(symbolRaw)) {
      const c = await fetchMarketData(symbolRaw, tf);
      if (c?.price && Array.isArray(c.data) && c.data.length) return { data: c.data, price: c.price, source: "marketData" };
    }

    // 3. MultiTF fallback
    const m = await fetchMultiTF(symbolRaw, [tf]);
    if (m?.[tf]) {
      const d = m[tf].data || [];
      const p = safeNum(m[tf].price || (d.length ? d.at(-1)?.close : 0));
      if (p && d.length) return { data: d, price: p, source: "multiTF" };
    }

    // 4. Universal 15m fallback
    if (tf !== "15m") {
      let u15 = await fetchAndCheck(symbolRaw, "15m");
      if (u15) return { ...u15, source: "universal-15m" };
    }

    return { data: [], price: 0, source: "none" };

  } catch (e) {
    console.debug(`[${VERSION}] resolvePriceAndCandles error:`, e?.message || e);
    return { data: [], price: 0, source: "error" };
  }
}

// ================== MAIN REPORT ==================
export async function generateReport(symbolLabel, tf = "15m") {
  const mapped = symbolMap[symbolLabel] || symbolLabel;

  // 1. Price
  const { data: candles, price: livePrice, source } = await resolvePriceAndCandles(mapped, tf);

  // 2. ML
  let ml = {};
  try { ml = (await runMLPrediction(mapped, tf)) || {}; } catch (e) { console.debug(`[${VERSION}] runML failed:`, e?.message || e); }

  // 3. Elliott (multi-TF ideally but here we analyze the current tf slice)
  let ell = null;
  try {
    if (Array.isArray(candles) && candles.length >= 8) {
      const slice = candles.slice(-400);
      ell = await analyzeElliott(slice);
    }
  } catch (e) { console.debug(`[${VERSION}] ell analyze failed:`, e?.message || e); }

  // 4. News
  let news = {};
  try { news = (await fetchNewsBundle(mapped)) || {}; } catch (e) { console.debug(`[${VERSION}] news fetch failed:`, e?.message || e); }

  const direction = ml.direction || "Neutral";
  const prob = safeNum(ml.maxProb ?? ml.probability ?? ml.confidence ?? 50);

  // Process Elliott patterns safely and dedupe
  const rawPatterns = Array.isArray(ell?.patterns) ? ell.patterns : [];
  const topPatterns = dedupeAndPickTop(rawPatterns, 4); // keep up to 4 best unique patterns
  const ellText = topPatterns.length
    ? topPatterns.map(p => `${String(p.type)}(${round(safeNum(p.confidence ?? p.conf ?? 0), 0)}%)`).join(" + ")
    : "N/A";
  const ellConf = safeNum(ell?.confidence ?? (topPatterns[0] ? topPatterns[0].confidence : 50), 50);

  const out = {
    symbol: symbolLabel,
    price: round(safeNum(livePrice), 4),
    direction,
    biasEmoji: direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪",
    tp1: ml.tp1 ?? ml.tpEstimate ?? "—",
    tp2: ml.tp2 ?? ml.tp2Estimate ?? "—",
    tpConf: ml.tpConfidence ?? 50,
    maxProb: prob,
    ellText,
    ellConf,
    newsImpact: news.impact || "Neutral",
    newsScore: safeNum(news.sentiment ?? news.score ?? 50, 50),
    _meta: {
      version: VERSION,
      mapped,
      fetchSource: source,
      candlesFound: Array.isArray(candles) ? candles.length : 0,
      ellFound: !!ell,
      ellPatternsFound: rawPatterns.length
    }
  };

  const txt = `
🔥 <b>${out.symbol}</b>
━━━━━━━━━━━━━━
📍 <b>Price:</b> ${out.price}
📊 <b>Trend:</b> ${out.biasEmoji} ${out.direction}
📉 <b>Elliott:</b> ${out.ellText} (${out.ellConf}%)
📰 <b>News:</b> ${out.newsImpact} (${out.newsScore}%)
🎯 <b>TP:</b> ${out.tp1} | Hedge: ${out.tp2}
🤖 <b>ML Prob:</b> ${out.maxProb}%
━━━━━━━━━━━━━━
<small>Src:${out._meta.fetchSource} | candles:${out._meta.candlesFound} | ell:${out._meta.ellPatternsFound}</small>
`;

  return { text: txt, keyboard: kbActions(symbolLabel) };
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
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // Asset clicked
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // Timeframes menu
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes: <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // Timeframe selection: tf_<SYMBOL>_<TF>
  if (data.startsWith("tf_")) {
    const clean = data.replace("tf_", "");
    const parts = clean.split("_");
    const tf = parts.pop();
    const symbol = parts.join("_");
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
    try { if (Array.isArray(cdl) && cdl.length >= 8) ell = await analyzeElliott(cdl.slice(-500)); } catch (e) { console.debug(`[${VERSION}] ell detail err:`, e?.message || e); }

    if (!ell || !Array.isArray(ell.patterns) || !ell.patterns.length) {
      return { text: `📊 Elliott: N/A`, keyboard: kbActions(symbol) };
    }

    const top = dedupeAndPickTop(ell.patterns, 6);
    const det = top.map(p => `${String(p.type)} (${round(safeNum(p.confidence ?? p.conf ?? 0), 0)}%)`).join(" + ");

    return {
      text: `📊 <b>Elliott (15m Detailed)</b>\n${det}\nConfidence: ${round(safeNum(ell.confidence ?? top[0]?.confidence ?? 50, 50), 0)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown", keyboard: kbHome };
}

// EXPORTS
