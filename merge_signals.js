// ============================================================
// merge_signals.js — FINAL FIXED MERGE (UI + Multi-TF + Elliott)
// ============================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

// Internal version for debugging
const VERSION = "v3.3_fixed_multiTF_crypto_detect_and_safe_handling";

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

// Crypto detection: only treat explicit crypto pairs (like BTCUSDT, ETHUSDT, BNBUSDT etc.) as crypto.
// This avoids matching XAUUSD/XAGUSD (commodities) or symbols that end with 'USD' but are not crypto pairs.
function isCryptoLike(sym) {
  if (!sym) return false;
  const s = String(sym).toUpperCase();
  // Accept formats like "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", etc.
  // Also accept ending with "USDC" or explicit exchange tickers if desired: extend regex if needed.
  return /[A-Z0-9]{2,8}(USDT|USDC|BUSD)$/.test(s);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
  if (!Number.isFinite(v)) return v;
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

// ================= KEYBOARDS (unchanged UI) =================
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

// ================= ELLIOTT UTIL (keeps earlier improved filter) =================
function extractTopPatterns(ellResult, max = 3) {
  if (!ellResult || !Array.isArray(ellResult.patterns)) return { list: [], conf: 50, primarySentiment: "Neutral" };

  const score = safeNum(ellResult.sentiment, 0);
  const overallSentiment = score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Neutral";

  const map = new Map();
  let bullCount = 0, bearCount = 0;

  for (const p of ellResult.patterns) {
    const s = p.side || "Neutral";
    if (s === "Bullish") bullCount++;
    if (s === "Bearish") bearCount++;
  }

  const dominantSide = bullCount > bearCount ? "Bullish" : bearCount > bullCount ? "Bearish" : overallSentiment;

  for (const p of ellResult.patterns) {
    const t = String(p.type || "Pattern");
    const conf = safeNum(p.confidence ?? p.conf ?? 50, 0);
    const patternSentiment = p.side || "Neutral";

    if (dominantSide !== "Neutral" && patternSentiment !== dominantSide) continue;

    if (!map.has(t) || conf > map.get(t).conf) {
      map.set(t, { type: t, conf, source: p, sentiment: patternSentiment });
    }
  }

  const arr = Array.from(map.values()).sort((a, b) => b.conf - a.conf).slice(0, max);
  const list = arr.map(a => `${a.type}(${Math.round(a.conf)}%)`);
  const topConf = arr.length ? Math.round(arr[0].conf) : 50;
  const finalSentiment = arr.length ? dominantSide : overallSentiment;

  return { list, conf: topConf, primarySentiment: finalSentiment };
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
<small>Data Source: ${r._meta.fetchSource} | Ver: ${r._meta.version}</small>
`;
}

// ==================== PRICE/CANDLES RESOLVER (robust) ====================
async function resolvePriceAndCandles(symbolRaw, tf = "15m") {
  try {
    // helper: ensure we handle both array or object return shapes from fetchUniversal
    const fetchAndCheck = async (sym, timeframe) => {
      const res = await fetchUniversal(sym, timeframe);
      // fetchUniversal might return:
      // - { data: [...], price: 123 }
      // - [] (array)
      // - { data: [] } etc.
      let data = [];
      let price = 0;

      if (Array.isArray(res)) {
        data = res;
        price = safeNum((res.at(-1) && res.at(-1).close) || 0);
      } else if (res && typeof res === "object") {
        data = Array.isArray(res.data) ? res.data : (Array.isArray(res.candles) ? res.candles : []);
        price = safeNum(res.price ?? (data.at(-1) && data.at(-1).close) ?? 0);
      }

      return (data.length && price) ? { data, price } : null;
    };

    // 1. Primary fetch
    let primary = await fetchAndCheck(symbolRaw, tf);
    if (primary) return { ...primary, source: "universal" };

    // 2. Crypto fallback (marketData) - only when symbol is explicit crypto pair (BTCUSDT, etc.)
    if (isCryptoLike(symbolRaw)) {
      try {
        const m = await fetchMarketData(symbolRaw, tf);
        const data = Array.isArray(m?.data) ? m.data : [];
        const price = safeNum(m?.price ?? (data.at(-1)?.close) ?? 0);
        if (data.length && price) return { data, price, source: "marketData" };
      } catch (e) {
        // ignore
      }
    }

    // 3. MultiTF fallback — IMPORTANT: call without second bogus arg
    try {
      const multi = await fetchMultiTF(symbolRaw); // fetchMultiTF builds its own TFs
      if (multi && typeof multi === "object") {
        const fallback = multi[tf] ?? multi["15m"] ?? Object.values(multi)[0];
        if (fallback) {
          const data = Array.isArray(fallback.data) ? fallback.data : [];
          const price = safeNum(fallback.price ?? (data.at(-1)?.close) ?? 0);
          if (data.length && price) return { data, price, source: "multiTF" };
        }
      }
    } catch (e) {
      // ignore
    }

    // 4. Retry universal with 15m if requested tf not available
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
    ml = {};
  }

  // 3. Elliott Analysis (only if sufficient candles)
  let ellRes = null;
  try {
    if (Array.isArray(candles) && candles.length >= 8) {
      const slice = candles.slice(-400);
      ellRes = await analyzeElliott(slice, { left: 3, right: 3, multiTF: null });
    }
  } catch (e) {
    console.debug(`[${VERSION}] analyzeElliott error:`, e?.message || e);
    ellRes = null;
  }

  // 4. News
  let news = {};
  try {
    news = (await fetchNewsBundle(mappedSymbol)) || {};
  } catch (e) {
    console.debug(`[${VERSION}] fetchNewsBundle error:`, e?.message || e);
    news = {};
  }

  // 5. Aggregate and Format Results
  const mlDirection = ml.direction || "Neutral";
  const mlProb = safeNum(ml.maxProb ?? ml.probability ?? ml.confidence ?? 50);

  const patternsObj = ellRes ? extractTopPatterns(ellRes, 3) : { list: [], conf: 50, primarySentiment: "Neutral" };
  const formattedPatterns = formatPatternsForText(patternsObj.list);

  const ellConf = Math.round(patternsObj.conf);
  const ellSentiment = patternsObj.primarySentiment || "Neutral";

  // 6. Final Trend Logic: Prioritize ML if probability is high (>60), otherwise Elliott (if strong), otherwise News
  let finalDirection = "Neutral";
  if (mlProb > 60) {
    finalDirection = mlDirection;
  } else if (ellSentiment !== "Neutral" && ellConf >= 65) {
    finalDirection = ellSentiment;
  } else if (safeNum(news.sentiment, 50) > 70) {
    finalDirection = "Bullish";
  } else if (safeNum(news.sentiment, 50) < 30) {
    finalDirection = "Bearish";
  } else {
    finalDirection = mlDirection;
  }

  const biasEmoji = finalDirection === "Bullish" ? "📈" : finalDirection === "Bearish" ? "📉" : "⚪";

  // Targets based on ML
  const tp1 = ml.tpEstimate ?? ml.tp1 ?? "—";
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? "—";
  const tpConf = ml.tpConfidence ?? 55;

  // Build output
  const out = {
    symbol: symbolLabel,
    price: round(safeNum(livePrice, 0), 6),
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
      ellSentiment,
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

  // navigation
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // asset select
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol);
  }

  // timeframes menu
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // TF select - supports symbols containing underscores
  if (data.startsWith("tf_")) {
    const clean = data.substring(3); // remove "tf_"
    const parts = clean.split("_");
    const tf = parts.pop(); // last token is timeframe
    const symbol = parts.join("_"); // rest is symbol (handles underscores in symbol)
    return await generateReport(symbol, tf);
  }

  // refresh
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol);
  }

  // news
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    const news = await fetchNewsBundle(mapped);
    return {
      text: `📰 <b>News Report</b>\nImpact: ${news.impact}\nSentiment: ${news.sentiment}%`,
      keyboard: kbActions(symbol)
    };
  }

  // elliott details (use 15m as consistent default)
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mapped, "15m");
    let ell = null;
    try {
      ell = (Array.isArray(pd.data) && pd.data.length >= 8) ? await analyzeElliott(pd.data.slice(-500)) : null;
    } catch (e) {
      ell = null;
    }

    if (!ell || !ell.patterns || !ell.patterns.length) {
      return {
        text: `📊 <b>Elliott Waves</b>\nPattern: N/A\nConfidence: ${ell?.confidence ?? 50}%`,
        keyboard: kbActions(symbol)
      };
    }

    const patternsWithSide = ell.patterns.map(p => ({
      ...p,
      side: p.side || (p.type.includes("Top") || p.type.includes("H&S") ? "Bearish" : "Bullish")
    }));

    const detailed = patternsWithSide
      .map(p => `${p.type}(${Math.round(p.confidence || p.conf || 50)}%) [${p.side}]`)
      .slice(0, 6)
      .join("\n- ");

    const overallScore = safeNum(ell.sentiment, 0);
    const overallTrend = overallScore > 0.15 ? "Bullish" : overallScore < -0.15 ? "Bearish" : "Neutral";

    return {
      text: `📊 <b>Elliott Waves (detailed, 15m)</b>\nOverall Sentiment: ${overallTrend}\nConfidence: ${Math.round(ell.confidence)}%\n\nDetected Patterns (Top 6):\n- ${detailed}`,
      keyboard: kbActions(symbol)
    };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}
