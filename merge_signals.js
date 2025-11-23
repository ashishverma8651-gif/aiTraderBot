// merge_signals.js — FINAL FIXED (multi-market, multi-TF, Elliott tidy)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

// ================= SYMBOL MAP (user -> provider tickers) =================
const SYMBOL_MAP = {
  // India indices -> Yahoo style
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY",

  // Commodities (Yahoo)
  GOLD: "GC=F",
  XAUUSD: "GC=F",
  SILVER: "SI=F",
  XAGUSD: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",

  // Forex (Yahoo)
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",

  // DXY (special)
  DXY: "DX-Y.NYB"
};

// ================= HELPERS =================
function withHTML(payload) {
  return { ...payload, parse_mode: "HTML" };
}

function isCryptoLike(sym) {
  if (!sym) return false;
  const s = String(sym).toUpperCase();
  return s.endsWith("USDT") || s.endsWith("BTC") || s.endsWith("ETH") || s.endsWith("USD");
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Convert friendly symbol (NIFTY50, GOLD, EURUSD, BTCUSDT) -> provider ticker
function toProviderTicker(symbol) {
  if (!symbol) return symbol;
  const s = String(symbol).toUpperCase();
  if (SYMBOL_MAP[s]) return SYMBOL_MAP[s];
  return s;
}

// Format Elliott summary: return short string and confidence
function summarizeElliott(ell) {
  if (!ell) return { summary: "N/A", conf: 50 };

  // If analyzeElliott returns { patterns: [...] }
  const arr = Array.isArray(ell.patterns) ? ell.patterns : [];

  if (!arr.length) {
    // fallback if module returns a single pattern
    if (ell.type) return { summary: String(ell.type), conf: ell.confidence || ell.conf || 50 };
    return { summary: "N/A", conf: ell.confidence || ell.conf || 50 || 50 };
  }

  // sort by confidence desc, pick up to 3 unique names
  const list = arr
    .map(p => ({ name: p.type || p.name || "Pattern", conf: Number(p.confidence || p.conf || 0) }))
    .sort((a, b) => (b.conf || b.confidence) - (a.conf || a.confidence));

  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(`${it.name}(${Math.round(it.conf)}%)`);
    if (out.length >= 3) break;
  }
  const maxConf = out.length ? Math.max(...list.map(x => x.conf)) : (ell.confidence || 50);
  return { summary: out.join(" + ") || "N/A", conf: Math.round(maxConf || 50) };
}

// Format the final Elliott text safely (avoid huge dump)
function formatElliottField(ell) {
  if (!ell) return "N/A (0%)";
  const s = summarizeElliott(ell);
  return `${s.summary} (${s.conf}%)`;
}

// ================= KEYBOARDS & UI =================
export const kbHome = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "💠 Crypto", callback_data: "menu_crypto" }, { text: "📘 Indices", callback_data: "menu_indices" }],
      [{ text: "💱 Forex", callback_data: "menu_forex" }, { text: "🛢 Commodities", callback_data: "menu_commodities" }]
    ]
  }
});

export const kbCrypto = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "BTC", callback_data: "asset_BTCUSDT" }, { text: "ETH", callback_data: "asset_ETHUSDT" }],
      [{ text: "SOL", callback_data: "asset_SOLUSDT" }, { text: "XRP", callback_data: "asset_XRPUSDT" }],
      [{ text: "DOGE", callback_data: "asset_DOGEUSDT" }, { text: "ADA", callback_data: "asset_ADAUSDT" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbIndices = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "NIFTY50", callback_data: "asset_NIFTY50" }, { text: "BankNifty", callback_data: "asset_BANKNIFTY" }],
      [{ text: "Sensex", callback_data: "asset_SENSEX" }, { text: "FinNifty", callback_data: "asset_FINNIFTY" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbForex = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "EURUSD", callback_data: "asset_EURUSD" }, { text: "GBPUSD", callback_data: "asset_GBPUSD" }],
      [{ text: "USDJPY", callback_data: "asset_USDJPY" }, { text: "XAUUSD", callback_data: "asset_XAUUSD" }],
      [{ text: "XAGUSD", callback_data: "asset_XAGUSD" }, { text: "DXY", callback_data: "asset_DXY" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export const kbCommodity = withHTML({
  reply_markup: {
    inline_keyboard: [
      [{ text: "GOLD", callback_data: "asset_GOLD" }, { text: "SILVER", callback_data: "asset_SILVER" }],
      [{ text: "CRUDE", callback_data: "asset_CRUDE" }, { text: "NGAS", callback_data: "asset_NGAS" }],
      [{ text: "⬅ Back", callback_data: "back_home" }]
    ]
  }
});

export function kbActions(symbol) {
  return withHTML({
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: `refresh_${symbol}` }, { text: "🕒 Timeframes", callback_data: `tfs_${symbol}` }],
        [{ text: "📊 Elliott", callback_data: `ell_${symbol}` }, { text: "📰 News", callback_data: `news_${symbol}` }],
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

// ==================== RESOLVE PRICE & CANDLES (Robust) ====================
async function resolvePriceAndCandles(userSymbol, tf = "15m") {
  // userSymbol = "NIFTY50" or "BTCUSDT" etc.
  const providerTicker = toProviderTicker(userSymbol);

  // 1) try fetchUniversal with provider ticker + requested tf
  try {
    console.debug(`[merge_signals] try fetchUniversal(${providerTicker}, ${tf})`);
    const uni = await fetchUniversal(providerTicker, tf);
    if (uni && (Array.isArray(uni.data) && uni.data.length) || (uni.price && uni.price !== 0)) {
      return { data: uni.data || uni.candles || [], price: safeNum(uni.price || (uni.data?.at(-1)?.close)), source: "universal", providerTicker };
    }
  } catch (e) {
    console.debug("[merge_signals] fetchUniversal error:", e?.message || e);
  }

  // 2) If crypto-like, try fetchMarketData (Binance cached) for exact symbol (userSymbol may already be correct)
  try {
    if (isCryptoLike(userSymbol) || isCryptoLike(providerTicker)) {
      const s = isCryptoLike(userSymbol) ? userSymbol : providerTicker;
      console.debug(`[merge_signals] fallback fetchMarketData(${s}, ${tf})`);
      const m = await fetchMarketData(s, tf);
      if (m && Array.isArray(m.data) && m.data.length) {
        return { data: m.data, price: safeNum(m.price), source: "marketData", providerTicker: s };
      }
    }
  } catch (e) {
    console.debug("[merge_signals] fetchMarketData error:", e?.message || e);
  }

  // 3) Try fetchMultiTF (ask for the requested TF specifically)
  try {
    console.debug(`[merge_signals] fallback fetchMultiTF(${providerTicker})`);
    const multi = await fetchMultiTF(providerTicker, [tf]);
    if (multi && multi[tf] && Array.isArray(multi[tf].data) && multi[tf].data.length) {
      return { data: multi[tf].data, price: safeNum(multi[tf].price), source: "multiTF", providerTicker };
    }
  } catch (e) {
    console.debug("[merge_signals] fetchMultiTF error:", e?.message || e);
  }

  // 4) final last-resort: try fetchUniversal again without tf constraints (15m)
  try {
    if (tf !== "15m") {
      console.debug(`[merge_signals] final retry fetchUniversal(${providerTicker}, 15m)`);
      const uni2 = await fetchUniversal(providerTicker, "15m");
      if (uni2 && Array.isArray(uni2.data) && uni2.data.length) {
        // if requested tf is different, attempt to rebuild timeframe if small difference — utils may already rebuild
        return { data: uni2.data, price: safeNum(uni2.price || uni2.data.at(-1)?.close), source: "universal-15m-fallback", providerTicker };
      }
    }
  } catch (e) {
    console.debug("[merge_signals] final universal fallback error:", e?.message || e);
  }

  // Nothing found
  return { data: [], price: 0, source: "none", providerTicker };
}

// ==================== MAIN REPORT ====================
export async function generateReport(symbol, tf = "15m") {
  // symbol is user-friendly: "NIFTY50" or "BTCUSDT" etc.
  const mappedSymbol = symbol; // keep user symbol in display; mapping used internally

  // 1. get candles/price robustly
  const { data: candlesRaw, price: livePrice, source, providerTicker } = await resolvePriceAndCandles(symbol, tf);

  const candles = Array.isArray(candlesRaw) ? candlesRaw : [];

  // 2. ML prediction (pass providerTicker when possible)
  let ml = {};
  try {
    const mlSymbol = providerTicker || toProviderTicker(symbol) || symbol;
    ml = (await runMLPrediction(mlSymbol, tf)) || {};
  } catch (e) {
    console.debug("[merge_signals] runMLPrediction error:", e?.message || e);
    ml = {};
  }

  const direction = ml.direction || "Neutral";
  const biasEmoji = direction === "Bullish" ? "📈" : direction === "Bearish" ? "📉" : "⚪";
  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // 3. Elliott analysis on the actual candles (if we have enough candles)
  let ell = null;
  try {
    if (candles && candles.length > 5) {
      ell = await analyzeElliott(candles, { left: 3, right: 3 });
    } else {
      ell = { patterns: [], confidence: 50 };
    }
  } catch (e) {
    console.debug("[merge_signals] analyzeElliott error:", e?.message || e);
    ell = { patterns: [], confidence: 50 };
  }
  const ellSumm = summarizeElliott(ell);

  // 4. News
  let news = {};
  try {
    const newsSymbol = providerTicker || toProviderTicker(symbol) || symbol;
    news = (await fetchNewsBundle(newsSymbol)) || {};
  } catch (e) {
    console.debug("[merge_signals] fetchNewsBundle error:", e?.message || e);
    news = {};
  }

  // Build output
  const out = {
    symbol: mappedSymbol,
    price: safeNum(livePrice),
    direction,
    biasEmoji,

    tp1,
    tp2,
    tpConf,

    maxProb: ml.maxProb ?? ml.max_probability ?? ml.probability ?? 50,

    elliottPattern: ellSumm.summary,
    elliottConf: ellSumm.conf,

    newsImpact: news.impact || "Neutral",
    newsScore: Math.round(news.sentiment ?? news.score ?? 50),

    _meta: {
      providerTicker,
      source,
      candlesFound: Array.isArray(candles) ? candles.length : 0,
      tf
    }
  };

  // debug meta
  console.debug("[merge_signals] report meta:", out._meta);

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbol)
  };
}

// ==================== CALLBACKS ====================
export async function handleCallback(query) {
  const data = query?.data || "";

  // Home nav
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // asset selected
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // timeframes menu
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // specific tf handler: format tf_<SYMBOL>_<TF> or tf_SYMBOL_TF (we'll split safely)
  if (data.startsWith("tf_")) {
    // possible data examples:
    // "tf_NIFTY50_5m" or "tf_BTCUSDT_15m"
    const parts = data.split("_");
    // parts[0] = "tf", parts[1] = SYMBOL (maybe contains extra underscores rarely), parts[2] = TF
    if (parts.length >= 3) {
      const tf = parts.pop(); // last
      parts.shift(); // remove 'tf'
      const symbol = parts.join("_");
      return await generateReport(symbol, tf);
    }
  }

  // refresh (same as generate)
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // news
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const providerTicker = toProviderTicker(symbol);
    const n = await fetchNewsBundle(providerTicker).catch(() => ({}));
    return {
      text: `📰 <b>News Report</b>\nImpact: ${n.impact || "Neutral"}\nSentiment: ${Math.round(n.sentiment ?? n.score ?? 50)}%`,
      keyboard: kbActions(symbol)
    };
  }

  // elliott button (show deeper ell report)
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const providerTicker = toProviderTicker(symbol);
    const { data: candles } = await resolvePriceAndCandles(symbol, "15m");
    let ell = {};
    try {
      ell = await analyzeElliott(candles || [], { left: 3, right: 3 });
    } catch (e) {
      console.debug("[merge_signals] ell button analyzeElliott error:", e?.message || e);
      ell = { patterns: [], confidence: 50 };
    }
    // prepare a readable detailed summary (top 6 patterns)
    const patterns = Array.isArray(ell.patterns) ? ell.patterns : [];
    const top = patterns.slice(0, 6).map(p => `${p.type || p.name || "Pattern"}(${Math.round(p.confidence ?? p.conf ?? 0)}%)`);
    const body = top.length ? top.join(" + ") : "N/A";
    return {
      text: `📊 <b>Elliott Waves</b>\nPattern: ${body}\nConfidence: ${Math.round(ell.confidence ?? ell.conf ?? 50)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}

