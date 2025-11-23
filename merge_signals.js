// ============================================================
// merge_signals.js — FINAL MERGED (UI + Multi-TF + Elliott fixes)
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
function withHTML(kb) {
  return { ...kb, parse_mode: "HTML" };
}

function isCryptoLike(sym) {
  if (!sym) return false;
  const s = String(sym).toUpperCase();
  return s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BTC") || s.endsWith("ETH");
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  if (!Number.isFinite(v)) return v;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ================= KEYBOARDS (UI preserved) =================
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

// ================= ELLIOTT UTIL (clean, dedupe, limit) =================
function extractTopPatterns(ellResult, max = 3) {
  if (!ellResult || !Array.isArray(ellResult.patterns)) return { list: [], conf: 50 };

  // dedupe by type, keep highest-confidence
  const map = new Map();
  for (const p of ellResult.patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? p.conf ?? ellResult.confidence ?? 50, 0);
    if (!map.has(t) || conf > map.get(t).conf) {
      map.set(t, { type: t, conf, source: p });
    }
  }

  // convert to array, sort by conf desc, pick top
  const arr = Array.from(map.values()).sort((a, b) => b.conf - a.conf).slice(0, max);

  // format human-friendly
  const list = arr.map(a => `${a.type}(${round(a.conf, 0)}%)`);
  const topConf = arr.length ? Math.round(arr[0].conf) : Math.round(ellResult.confidence ?? 50);

  return { list, conf: topConf };
}

function formatPatternsForText(list) {
  if (!list || !list.length) return "N/A";
  // join with ' + ' but keep length reasonable
  return list.join(" + ");
}

// ================= FORMATTER =================
export function formatPremiumReport(r) {
  // r.elliottPattern expected as formatted string, r.elliottConf number
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

// ==================== PRICE/CANDLES RESOLVER (robust) ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  // symbolRaw here is NOT the UI label but mappedSymbol (e.g. ^NSEI or EURUSD=X or BTCUSDT)
  // 1) Try universal (utils.fetchUniversal) with required tf
  // 2) If fails and crypto-like, try fetchMarketData
  // 3) Try fetchMultiTF for requested tf
  // 4) Final fallback: try universal again with 15m

  try {
    // Primary
    const primary = await fetchUniversal(symbolRaw, tf);
    if (primary && ((primary.price && primary.price !== 0) || (primary.data && primary.data.length))) {
      const data = primary.data ?? primary.candles ?? [];
      return { data, price: safeNum(primary.price || (data.at(-1)?.close)), source: "universal" };
    }

    // Crypto fallback (marketData)
    if (isCryptoLike(symbolRaw)) {
      try {
        const m = await fetchMarketData(symbolRaw, tf);
        if (m && m.price && m.price !== 0 && Array.isArray(m.data)) {
          return { data: m.data, price: safeNum(m.price), source: "marketData" };
        }
      } catch (e) { /* ignore */ }
    }

    // MultiTF fallback
    try {
      const multi = await fetchMultiTF(symbolRaw, [tf]);
      if (multi && multi[tf] && ((multi[tf].price && multi[tf].price !== 0) || (multi[tf].data && multi[tf].data.length))) {
        return { data: multi[tf].data || [], price: safeNum(multi[tf].price || (multi[tf].data?.at(-1)?.close)), source: "multiTF" };
      }
    } catch (e) { /* ignore */ }

    // Retry universal with 15m if requested tf fails (useful for Yahoo oddities)
    if (tf !== "15m") {
      const p2 = await fetchUniversal(symbolRaw, "15m");
      if (p2 && ((p2.price && p2.price !== 0) || (p2.data && p2.data.length))) {
        return { data: p2.data ?? [], price: safeNum(p2.price || (p2.data?.at(-1)?.close)), source: "universal-15m" };
      }
    }

    // Nothing found
    return { data: [], price: 0, source: "none" };
  } catch (err) {
    console.debug("[merge_signals] resolvePriceAndCandles error:", err?.message || err);
    return { data: [], price: 0, source: "error" };
  }
}

// ==================== MAIN REPORT ====================
export async function generateReport(symbolLabel, tf = "15m") {
  // symbolLabel is like "NIFTY50" or "BTCUSDT"
  const mappedSymbol = symbolMap[symbolLabel] || symbolLabel;

  // resolve price & candles (use mappedSymbol for fetch)
  const { data: candles, price: livePrice, source } = await resolvePriceAndCandles(mappedSymbol, tf);

  // ML (use mappedSymbol as model input)
  let ml = {};
  try {
    ml = (await runMLPrediction(mappedSymbol, tf)) || {};
  } catch (e) {
    console.debug("[merge_signals] runMLPrediction failed:", e?.message || e);
    ml = {};
  }

  // safe fields
  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪";
  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;
  const maxProb = safeNum(ml.maxProb || ml.probability || ml.confidence || 50);

  // Elliott analysis: only run if we have reasonable candles
  let ellRes = null;
  try {
    if (Array.isArray(candles) && candles.length >= 5) {
      // pass latest slice to be performant and consistent
      const slice = candles.slice(-400); // keep enough history but bounded
      ellRes = await analyzeElliott(slice, { left: 3, right: 3 }); // keep options available
    } else {
      ellRes = null;
    }
  } catch (e) {
    console.debug("[merge_signals] analyzeElliott error:", e?.message || e);
    ellRes = null;
  }

  // Format Elliott patterns: dedupe, sort, top 3
  const patternsObj = ellRes ? extractTopPatterns(ellRes, 3) : { list: [], conf: 50 };
  const formattedPatterns = formatPatternsForText(patternsObj.list);
  const ellConf = Math.round(patternsObj.conf || ellRes?.confidence || 50);

  // News
  let news = {};
  try {
    news = (await fetchNewsBundle(mappedSymbol)) || {};
  } catch (e) {
    console.debug("[merge_signals] fetchNewsBundle error:", e?.message || e);
    news = {};
  }

  // Build output object
  const out = {
    symbol: symbolLabel,
    price: round(livePrice, 4),
    direction,
    biasEmoji,
    tp1,
    tp2,
    tpConf,
    maxProb: round(maxProb, 2),
    elliottPattern: formattedPatterns || "N/A",
    elliottConf: ellConf,
    newsImpact: news.impact || "Neutral",
    newsScore: safeNum(news.sentiment, 50),
    _meta: {
      mappedSymbol,
      fetchSource: source,
      candlesFound: Array.isArray(candles) ? candles.length : 0,
      ellOk: !!ellRes
    }
  };

  // debug log (useful while testing)
  console.debug("[merge_signals] report meta:", out._meta);

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbolLabel)
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

  // SELECTED ASSET
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // TIMEFRAMES MENU
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return {
      text: `🕒 Timeframes for <b>${symbol}</b>`,
      keyboard: kbTimeframes(symbol)
    };
  }

  // SPECIFIC TF - callback format: tf_<SYMBOL>_<TF> e.g. tf_BTCUSDT_5m or tf_NIFTY50_1h
  if (data.startsWith("tf_")) {
    // safe split: remove prefix and take last part as tf
    const clean = data.substring(3); // remove "tf_"
    const parts = clean.split("_");
    const tf = parts.pop(); // last token is timeframe
    const symbol = parts.join("_"); // rest is symbol (handles symbols containing underscores)
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
    const mapped = symbolMap[symbol] || symbol;
    const news = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT BUTTON: show detailed Elliott patterns (use 15m candles for consistency)
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const { data: pd } = await resolvePriceAndCandles(mapped, "15m");
    let ell = {};
    try {
      ell = (Array.isArray(pd) && pd.length >= 5) ? await analyzeElliott(pd.slice(-500)) : null;
    } catch (e) {
      ell = null;
    }

    if (!ell || !ell.patterns || !ell.patterns.length) {
      return {
        text: `📊 <b>Elliott Waves</b>\nPattern: N/A\nConfidence: ${ell?.confidence ?? 50}%`,
        keyboard: kbActions(symbol)
      };
    }

    // Build friendly detailed message (dedup + top 6 for detail)
    const dedup = extractTopPatterns(ell, 6);
    const detailed = dedup.list.length ? dedup.list.join(" + ") : "N/A";
    return {
      text: `📊 <b>Elliott Waves (detailed)</b>\nPatterns: ${detailed}\nConfidence: ${Math.round(dedup.conf)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}