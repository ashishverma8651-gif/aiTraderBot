// ============================================================
// merge_signals.js — FINAL MERGED (UI + Multi-TF + Elliott fixes)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js"; // Assumes elliott_module is updated to v2.5+
import { fetchNewsBundle } from "./news_social.js";

// Internal version tag for debugging
const VERSION = "v2_6_FIXED";

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


// ================= ELLIOTT UTIL (FIXED LOGIC for Filtering) =================
function extractTopPatterns(ellResult, max = 3) {
  if (!ellResult || !Array.isArray(ellResult.patterns)) return { list: [], conf: 50, primarySentiment: "Neutral" };

  // Define clear sentiment based on a threshold (Bullish > 0.15, Bearish < -0.15)
  const score = safeNum(ellResult.sentiment, 0);
  const overallSentiment = score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Neutral";
  
  const map = new Map();
  let bullCount = 0;
  let bearCount = 0;
  
  // First pass: Count Bullish/Bearish patterns to find the dominant side *before* filtering by type
  for (const p of ellResult.patterns) {
    const patternSentiment = p.side || "Neutral"; 
    if (patternSentiment === "Bullish") bullCount++;
    if (patternSentiment === "Bearish") bearCount++;
  }

  // Determine the dominant pattern side for filtering
  // If the counts are equal, default to the overall sentiment score.
  const dominantSide = bullCount > bearCount ? "Bullish" : bearCount > bullCount ? "Bearish" : overallSentiment;
  
  // Second pass: Filter and dedupe by type
  for (const p of ellResult.patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? p.conf ?? ellResult.confidence ?? 50, 0); 
    const patternSentiment = p.side || "Neutral";

    // 🛑 CRITICAL FILTER: Only keep patterns that align with the DOMINANT side.
    // If the dominantSide is Neutral, we still keep everything (though theoretically the count logic should prevent this).
    if (dominantSide !== "Neutral" && patternSentiment !== dominantSide) {
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

  // If the filtered list is empty, but we had a dominant side, use that side.
  const finalSentiment = arr.length ? dominantSide : overallSentiment;

  return { 
    list, 
    conf: topConf, 
    primarySentiment: finalSentiment 
  };
}

function formatPatternsForText(list) {
  if (!list || !list.length) return "N/A";
  return list.join(" + ");
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

// ==================== PRICE/CANDLES RESOLVER (robust) ====================
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

    // 2. Crypto fallback (marketData)
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
    console.debug(`[${VERSION}] resolvePriceAndCandles error:`, err?.message || err);
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
    console.debug(`[${VERSION}] runMLPrediction failed:`, e?.message || e);
  }

  // 3. Elliott Analysis
  let ellRes = null;
  try {
    if (Array.isArray(candles) && candles.length >= 8) {
      const slice = candles.slice(-400); 
      ellRes = await analyzeElliott(slice, { left: 3, right: 3 }); 
    }
  } catch (e) {
    console.debug(`[${VERSION}] analyzeElliott error:`, e?.message || e);
  }

  // 4. News
  let news = {};
  try {
    news = (await fetchNewsBundle(mappedSymbol)) || {};
  } catch (e) {
    console.debug(`[${VERSION}] fetchNewsBundle error:`, e?.message || e);
  }

  // 5. Aggregate and Format Results
  const mlDirection = ml.direction || "Neutral";
  const mlProb = safeNum(ml.maxProb || ml.probability || ml.confidence || 50);
  
  // Use the FIXED pattern extraction logic
  const patternsObj = ellRes ? extractTopPatterns(ellRes, 3) : { list: [], conf: 50, primarySentiment: "Neutral" };
  const formattedPatterns = formatPatternsForText(patternsObj.list);
  const ellConf = Math.round(patternsObj.conf || ellRes?.confidence || 50);
  const ellSentiment = patternsObj.primarySentiment || "Neutral"; // This is the FILTERED sentiment

  // 6. Final Trend Logic: Prioritize ML if probability is high (>60), otherwise Elliott, otherwise News
  let finalDirection = "Neutral";
  
  if (mlProb > 60) {
      finalDirection = mlDirection;
  } else if (ellSentiment !== "Neutral" && ellConf >= 65) { // Only use Elliott if confidence is good
      finalDirection = ellSentiment;
  } else if (news.sentiment > 70) {
      finalDirection = "Bullish";
  } else if (news.sentiment < 30) {
      finalDirection = "Bearish";
  } else {
      // If nothing is strongly conclusive, default to ML's current low-confidence bias
      finalDirection = mlDirection; 
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
      version: VERSION,
      mappedSymbol,
      fetchSource: source,
      candlesFound: Array.isArray(candles) ? candles.length : 0,
      ellOk: !!ellRes,
      ellSentiment: ellSentiment,
      tfUsed: tf
    }
  };

  console.debug(`[${VERSION}] report meta:`, out._meta);

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
    const clean = data.substring(3); // remove "tf_"
    const parts = clean.split("_");
    const tf = parts.pop(); // last token is timeframe
    const symbol = parts.join("_"); // rest is symbol
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
    // We use 15m candles for the detail view as a consistent default.
    const { data: pd } = await resolvePriceAndCandles(mapped, "15m");
    let ell = {};
    try {
      // Use 15m candles to show Elliott detail
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

    // Build friendly detailed message (no strict sentiment filter here, just show top results)
    const patternsWithSide = ell.patterns.map(p => ({
        ...p, 
        side: p.side || (p.type.includes("Top") || p.type.includes("H&S") ? "Bearish" : "Bullish") // Guess side if missing
    }));

    // Detailed list (showing everything found)
    const detailed = patternsWithSide
        .map(p => `${p.type}(${round(p.confidence || p.conf || 50, 0)}%)`)
        .slice(0, 6)
        .join(" + ");
    
    // Overall Sentiment calculation for detail view
    const overallScore = safeNum(ell.sentiment, 0);
    const overallTrend = overallScore > 0.15 ? "Bullish" : overallScore < -0.15 ? "Bearish" : "Neutral";
        
    return {
      text: `📊 <b>Elliott Waves (detailed, 15m)</b>\nPatterns: ${detailed}\nOverall Sentiment: ${overallTrend}\nConfidence: ${Math.round(ell.confidence)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}

// EXPORTS (Same as original)
