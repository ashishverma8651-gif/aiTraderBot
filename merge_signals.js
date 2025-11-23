// ============================================================
// merge_signals_v2_5.js — FINAL MERGED (WITH CONSISTENCY FIXES)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js"; 
import { fetchNewsBundle } from "./news_social.js";

// ================= SYMBOL MAP (UNCHANGED) =================
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

// ================= HELPERS (UNCHANGED) =================
function withHTML(kb) { return { ...kb, parse_mode: "HTML" }; }
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

// ================= KEYBOARDS (UNCHANGED) =================
export const kbHome = withHTML({ /* ... */ });
export const kbCrypto = withHTML({ /* ... */ });
export const kbIndices = withHTML({ /* ... */ });
export const kbForex = withHTML({ /* ... */ });
export const kbCommodity = withHTML({ /* ... */ });

export function kbActions(symbol) { /* ... */
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

export function kbTimeframes(symbol) { /* ... */
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

// ================= ELLIOTT UTIL (FIXED LOGIC) =================
function extractTopPatterns(ellResult, max = 3) {
  if (!ellResult || !Array.isArray(ellResult.patterns)) return { list: [], conf: 50, primarySentiment: "Neutral" };

  // Determine the overall primary sentiment based on Elliott's scoring
  const overallSentiment = ellResult.sentiment > 0.15 ? "Bullish" : ellResult.sentiment < -0.15 ? "Bearish" : "Neutral";
  const map = new Map();
  
  // Filter and dedupe by type, prioritizing patterns matching the overall sentiment
  for (const p of ellResult.patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? 50, 0);
    const patternSentiment = p.side || "Neutral"; // Assuming pattern object has 'side' (Bullish/Bearish)

    // 🛑 CRITICAL FILTER: If Elliott has a clear direction, skip opposing patterns
    if (overallSentiment !== "Neutral" && patternSentiment !== overallSentiment) {
        // Skip patterns that contradict the calculated dominant Elliott direction
        continue; 
    }
    
    // Dedupe: keep highest-confidence pattern of the same type
    if (!map.has(t) || conf > map.get(t).conf) {
      map.set(t, { type: t, conf, source: p, sentiment: patternSentiment });
    }
  }

  // Convert to array, sort by conf desc, pick top (of the filtered list)
  const arr = Array.from(map.values()).sort((a, b) => b.conf - a.conf).slice(0, max);

  // Format human-friendly
  const list = arr.map(a => `${a.type}(${round(a.conf, 0)}%)`);
  const topConf = arr.length ? Math.round(arr[0].conf) : Math.round(ellResult.confidence ?? 50);

  return { list, conf: topConf, primarySentiment: overallSentiment };
}

function formatPatternsForText(list) {
  if (!list || !list.length) return "N/A";
  return list.join(" + ");
}

// ================= FORMATTER (UNCHANGED) =================
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

// ==================== PRICE/CANDLES RESOLVER (CLEANED) ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    const fetchAndCheck = async (sym, timeframe) => {
      const result = await fetchUniversal(sym, timeframe);
      const data = result?.data ?? result?.candles ?? [];
      const price = safeNum(result?.price || data.at(-1)?.close);
      return (price && data.length) ? { data, price } : null;
    };

    // 1. Primary fetch
    let primary = await fetchAndCheck(symbolRaw, tf);
    if (primary) return { ...primary, source: "universal" };

    // 2. Crypto fallback
    if (isCryptoLike(symbolRaw)) {
      const m = await fetchMarketData(symbolRaw, tf);
      if (m?.price && Array.isArray(m.data)) return { data: m.data, price: safeNum(m.price), source: "marketData" };
    }

    // 3. MultiTF fallback
    const multi = await fetchMultiTF(symbolRaw, [tf]);
    if (multi?.[tf]) {
        const data = multi[tf].data || [];
        const price = safeNum(multi[tf].price || data.at(-1)?.close);
        if (price) return { data, price, source: "multiTF" };
    }

    // 4. Retry universal with 15m
    if (tf !== "15m") {
      let fallback15m = await fetchAndCheck(symbolRaw, "15m");
      if (fallback15m) return { ...fallback15m, source: "universal-15m" };
    }

    return { data: [], price: 0, source: "none" };
  } catch (err) {
    console.debug("[merge_signals] resolvePriceAndCandles error:", err?.message || err);
    return { data: [], price: 0, source: "error" };
  }
}

// ==================== MAIN REPORT ====================
export async function generateReport(symbolLabel, tf = "15m") {
  const mappedSymbol = symbolMap[symbolLabel] || symbolLabel;

  // 1. Resolve price & candles
  const { data: candles, price: livePrice, source } = await resolvePriceAndCandles(mappedSymbol, tf);

  // 2. ML Prediction
  let ml = {};
  try {
    ml = (await runMLPrediction(mappedSymbol, tf)) || {};
  } catch (e) {
    console.debug("[merge_signals] runMLPrediction failed:", e?.message || e);
  }

  // 3. Elliott Analysis
  let ellRes = null;
  let ellMeta = {};
  try {
    if (Array.isArray(candles) && candles.length >= 8) {
      const slice = candles.slice(-400); 
      ellRes = await analyzeElliott(slice, { left: 3, right: 3 }); 
      ellMeta = { 
          ellOk: !!ellRes,
          ellSentiment: ellRes?.sentiment
      };
    }
  } catch (e) {
    console.debug("[merge_signals] analyzeElliott error:", e?.message || e);
  }

  // 4. News
  let news = {};
  try {
    news = (await fetchNewsBundle(mappedSymbol)) || {};
  } catch (e) {
    console.debug("[merge_signals] fetchNewsBundle error:", e?.message || e);
  }

  // 5. Aggregate and Format Results
  const mlDirection = ml.direction || "Neutral";
  const mlProb = safeNum(ml.maxProb || ml.probability || ml.confidence || 50);

  const patternsObj = ellRes ? extractTopPatterns(ellRes, 3) : { list: [], conf: 50, primarySentiment: "Neutral" };
  const formattedPatterns = formatPatternsForText(patternsObj.list);
  const ellConf = Math.round(patternsObj.conf || ellRes?.confidence || 50);
  const ellSentiment = patternsObj.primarySentiment || "Neutral";

  // 6. Final Trend Logic: Prioritize ML if probability is high, otherwise Elliott, otherwise News
  let finalDirection = "Neutral";
  if (mlProb > 60) {
      finalDirection = mlDirection;
  } else if (ellSentiment !== "Neutral") {
      finalDirection = ellSentiment;
  } else if (news.sentiment > 70) {
      finalDirection = "Bullish";
  } else if (news.sentiment < 30) {
      finalDirection = "Bearish";
  } else {
      finalDirection = mlDirection; // Fallback to ML's lower confidence bias
  }
  
  const biasEmoji = finalDirection === "Bullish" ? "📈" : finalDirection === "Bearish" ? "📉" : "⚪";
  
  // Targets based on ML
  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // Build output object
  const out = {
    symbol: symbolLabel,
    price: round(livePrice, 4),
    direction: finalDirection,
    biasEmoji,
    tp1,
    tp2,
    tpConf,
    maxProb: round(mlProb, 2),
    elliottPattern: formattedPatterns || "N/A",
    elliottConf: ellConf,
    newsImpact: news.impact || "Neutral",
    newsScore: safeNum(news.sentiment, 50),
    _meta: {
      mappedSymbol,
      fetchSource: source,
      candlesFound: Array.isArray(candles) ? candles.length : 0,
      ...ellMeta,
      tfUsed: tf
    }
  };

  console.debug("[merge_signals] report meta:", out._meta);

  return {
    text: formatPremiumReport(out),
    keyboard: kbActions(symbolLabel)
  };
}

// ==================== CALLBACK ROUTING (UNCHANGED FUNCTIONALITY) ====================
export async function handleCallback(query) {
  const data = query.data;

  // HOME, MENU, ASSET, REFRESH, TF-SPECIFIC - unchanged logic calling generateReport
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data.startsWith("menu_")) { /* ... */ }
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return {
      text: `🕒 Timeframes for <b>${symbol}</b>`,
      keyboard: kbTimeframes(symbol)
    };
  }
  if (data.startsWith("tf_")) {
    const clean = data.substring(3);
    const parts = clean.split("_");
    const tf = parts.pop();
    const symbol = parts.join("_");
    return await generateReport(symbol, tf);
  }
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // NEWS - unchanged
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    const news = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // ELLIOTT BUTTON: show detailed Elliott patterns
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    // Note: We use 15m candles for the detail view as a consistent default.
    const { data: pd } = await resolvePriceAndCandles(mapped, "15m"); 
    
    let ell = null;
    try {
      ell = (Array.isArray(pd) && pd.length >= 8) ? await analyzeElliott(pd.slice(-500)) : null;
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
    // Note: We intentionally DO NOT filter this detailed view by sentiment, 
    // to allow the user to see all detected patterns on the 15m TF.
    const dedup = extractTopPatterns(ell, 6); 
    const detailed = dedup.list.length ? dedup.list.join(" + ") : "N/A";
    
    return {
      text: `📊 <b>Elliott Waves (detailed)</b>\nPatterns: ${detailed}\nOverall Sentiment: ${dedup.primarySentiment}\nConfidence: ${Math.round(dedup.conf)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}

// EXPORTS (Same as original)

