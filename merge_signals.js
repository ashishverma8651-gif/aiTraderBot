// ============================================================
// merge_signals.js — FINAL MERGED (Trend Logic Fixed)
// 
// यह संस्करण Bullish/Bearish targets और Final Trend की दिशा 
// में टकराव को ठीक करता है।
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js"; 
import { fetchNewsBundle } from "./news_social.js";

// Internal version tag for debugging
const VERSION = "v3_2_TREND_FIX"; // Version updated for clarity

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

// (Keyboards remain the same)
export const kbHome = withHTML({ /* ... */ });
export const kbCrypto = withHTML({ /* ... */ });
export const kbIndices = withHTML({ /* ... */ });
export const kbForex = withHTML({ /* ... */ });
export const kbCommodity = withHTML({ /* ... */ });
export function kbActions(symbol) { /* ... */ }
export function kbTimeframes(symbol) { /* ... */ }

// ================= ELLIOTT UTIL (Confidence Logic) =================
function extractTopPatterns(ellResult, max = 3) {
  if (!ellResult || !Array.isArray(ellResult.patterns)) return { list: [], conf: 50, primarySentiment: "Neutral" };

  const score = safeNum(ellResult.sentiment, 0);
  const overallSentiment = score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Neutral";
  
  let bullCount = 0;
  let bearCount = 0;
  
  for (const p of ellResult.patterns) {
    const patternSentiment = p.side || "Neutral"; 
    if (patternSentiment === "Bullish") bullCount++;
    if (patternSentiment === "Bearish") bearCount++;
  }

  const dominantSide = bullCount > bearCount ? "Bullish" : bearCount > bullCount ? "Bearish" : overallSentiment;
  
  const map = new Map();
  for (const p of ellResult.patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? p.conf ?? 50, 0); 
    const patternSentiment = p.side || "Neutral";

    if (dominantSide !== "Neutral" && patternSentiment !== dominantSide) {
        continue; 
    }
    
    if (!map.has(t) || conf > map.get(t).conf) {
      map.set(t, { type: t, conf, source: p, sentiment: patternSentiment });
    }
  }

  const arr = Array.from(map.values()).sort((a, b) => b.conf - a.conf).slice(0, max);
  const list = arr.map(a => `${a.type}(${round(a.conf, 0)}%)`);
  const topConf = arr.length ? Math.round(arr[0].conf) : 50;
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
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL (${r._meta.tfUsed})
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

// ==================== PRICE/CANDLES RESOLVER ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    // ... (This function remains the same as the previously fixed version in utils.js)
    const fetchAndCheck = async (sym, timeframe) => {
      const result = await fetchUniversal(sym, timeframe);
      const data = result?.data ?? result?.candles ?? [];
      const price = safeNum(result?.price || data.at(-1)?.close);
      
      if (price && data.length > 5) {
          return { data, price };
      }
      return null;
    };

    let primary = await fetchAndCheck(symbolRaw, tf);
    if (primary) return { ...primary, source: "universal" };

    const multi = await fetchMultiTF(symbolRaw, [tf]);
    if (multi?.[tf]) {
        const data = multi[tf].data || [];
        const price = safeNum(multi[tf].price || data.at(-1)?.close);
        if (price && data.length > 5) {
             return { data, price, source: "multiTF" };
        }
    }
    
    if (isCryptoLike(symbolRaw)) {
      const m = await fetchMarketData(symbolRaw, tf);
      if (m?.price && Array.isArray(m.data) && m.data.length > 5) {
         return { data: m.data, price: safeNum(m.price), source: "marketData" };
      }
    }

    return { data: [], price: 0, source: "none" };
    
  } catch (err) {
    console.error(`[${VERSION}] resolvePriceAndCandles error for ${symbolRaw}/${tf}:`, err?.message || err);
    return { data: [], price: 0, source: "error" };
  }
}

// ==================== MAIN REPORT ====================
export async function generateReport(symbolLabel, tf = "15m") {
  const mappedSymbol = symbolMap[symbolLabel] || symbolLabel;

  // 1. Resolve price & candles
  const { data: candles, price: livePrice, source } = await resolvePriceAndCandles(mappedSymbol, tf);
  
  const candlesFound = Array.isArray(candles) ? candles.length : 0;
  let ellDataSlice = [];
  
  if (candlesFound >= 8) {
      // ML और Elliott के लिए कैंडल डेटा का स्लाइस लें
      ellDataSlice = candles.slice(-400); 
  }


  // 2. ML Prediction
  let ml = {};
  try {
    ml = (await runMLPrediction(mappedSymbol, tf, ellDataSlice)) || {}; 
  } catch (e) {
    console.debug(`[${VERSION}] runMLPrediction failed:`, e?.message || e);
  }

  // 3. Elliott Analysis
  let ellRes = null;
  try {
    if (ellDataSlice.length > 8) {
      ellRes = await analyzeElliott(ellDataSlice, { lookback: 5 }); 
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
  
  const patternsObj = ellRes ? extractTopPatterns(ellRes, 3) : { list: [], conf: 50, primarySentiment: "Neutral" };
  const formattedPatterns = formatPatternsForText(patternsObj.list);
  
  const ellConf = Math.round(patternsObj.conf);
  const ellSentiment = patternsObj.primarySentiment || "Neutral"; 

  // Targets based on ML
  const tp1 = safeNum(ml.tpEstimate ?? ml.tp1 ?? 0);
  const tp2 = safeNum(ml.tp2Estimate ?? ml.tp2 ?? 0);
  const tpConf = safeNum(ml.tpConfidence ?? 55);

  // 6. Final Trend Logic (FIXED)
  let finalDirection = "Neutral";
  
  // A. ML Check and Correction: 
  // यदि ML Probability > 60 है, तो हम ML के Targets की दिशा को Trend मानते हैं।
  if (mlProb > 60) {
      // यदि दोनों TP लाइव प्राइस से ऊपर हैं -> Bullish
      if (tp1 > livePrice && tp2 > livePrice) {
          finalDirection = "Bullish";
      } 
      // यदि दोनों TP लाइव प्राइस से नीचे हैं -> Bearish
      else if (tp1 < livePrice && tp2 < livePrice) {
          finalDirection = "Bearish";
      } 
      // अन्यथा, ML direction पर वापस जाएँ (Bullish/Bearish/Neutral)
      else {
          finalDirection = mlDirection;
      }
  } 
  // B. Elliott Check
  else if (ellSentiment !== "Neutral" && ellConf >= 65) { 
      finalDirection = ellSentiment;
  } 
  // C. News Check
  else if (news.sentiment > 70) {
      finalDirection = "Bullish";
  } else if (news.sentiment < 30) {
      finalDirection = "Bearish";
  } 
  // D. Fallback (Use ML direction if nothing conclusive)
  else {
      finalDirection = mlDirection; 
  }
  
  const biasEmoji = finalDirection === "Bullish" ? "📈" : finalDirection === "Bearish" ? "📉" : "⚪";
  
  // Build output object
  const out = {
    symbol: symbolLabel,
    price: round(livePrice, 4),
    direction: finalDirection,
    biasEmoji,
    // Format TPs back to string, N/A if 0
    tp1: tp1 > 0 ? round(tp1, 2) : "N/A", 
    tp2: tp2 > 0 ? round(tp2, 2) : "N/A",
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
      candlesFound: candlesFound,
      ellDataSliceCount: ellDataSlice.length,
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

// (handleCallback function remains the same, except for the VERSION constant)
// ...

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

  // ELLIOTT BUTTON: show detailed Elliott patterns (use the default 15m TF)
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const tfForDetail = "15m";
    const { data: pd } = await resolvePriceAndCandles(mapped, tfForDetail);
    let ell = {};
    try {
      ell = (Array.isArray(pd) && pd.length >= 8) ? await analyzeElliott(pd.slice(-500)) : null;
    } catch (e) {
      ell = null;
    }

    if (!ell || !ell.patterns || !ell.patterns.length) {
      return {
        text: `📊 <b>Elliott Waves (${tfForDetail})</b>\nPattern: N/A\nConfidence: ${ell?.confidence ?? 50}%`,
        keyboard: kbActions(symbol)
      };
    }

    const patternsWithSide = ell.patterns.map(p => ({
        ...p, 
        side: p.side || (p.type.includes("Top") || p.type.includes("H&S") ? "Bearish" : "Bullish") 
    }));

    const detailed = patternsWithSide
        .map(p => `${p.type}(${round(p.confidence || p.conf || 50, 0)}%)`)
        .slice(0, 6)
        .join(" + ");
    
    const overallScore = safeNum(ell.sentiment, 0);
    const overallTrend = overallScore > 0.15 ? "Bullish" : overallScore < -0.15 ? "Bearish" : "Neutral";
        
    return {
      text: `📊 <b>Elliott Waves (Detailed, ${tfForDetail})</b>\nPatterns: ${detailed}\nOverall Sentiment: ${overallTrend}\nConfidence: ${Math.round(ell.confidence)}%`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown Command", keyboard: kbHome };
}

// EXPORTS 
