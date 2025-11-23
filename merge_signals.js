// merge_signals.js — FINAL PREMIUM AI PANEL (FULL UI + MULTIMARKET + ELLIOTTv2.4 + HARMONICS)
// =========================================================================================

import {
  fetchUniversal,
  fetchMultiTF,
  fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

/* ===========================
   SYMBOL MAP (multimarket)
   =========================== */
const symbolMap = {
  // India
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
  FINNIFTY: "NSE:FINNIFTY",

  // Commodities / Metals / Energies
  GOLD: "GC=F",
  XAUUSD: "GC=F",
  SILVER: "SI=F",
  XAGUSD: "SI=F",
  CRUDE: "CL=F",
  NGAS: "NG=F",

  // Forex / FX indices
  DXY: "DX-Y.NYB",
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X"
};

/* ===========================
   Helpers
   =========================== */
function withHTML(obj) { return { ...obj, parse_mode: "HTML" }; }
function safeNum(v){ const n = Number(v); return Number.isFinite(n)?n:0; }
function isCryptoSymbol(s) {
  if (!s) return false;
  const u = String(s).toUpperCase();
  return u.endsWith("USDT") || u.endsWith("BTC") || u.endsWith("ETH") || u.endsWith("USD");
}

/* ===========================
   Keyboards / UI
   =========================== */
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

export function kbActions(symbol){
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

export function kbTimeframes(symbol){
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

/* ===========================
   Formatter (report text)
   =========================== */
export function formatPremiumReport(r){
  // include harmonics & elliott summary if present
  const harmonicLine = r.harmonics && r.harmonics.length
    ? `${r.harmonics.map(h=>`${h.type}(${Math.round(h.conf)}%)`).join(" + ")}`
    : "N/A";

  return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL
━━━━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.elliottPattern} (${r.elliottConf}%)
🔶 <b>Harmonics:</b> ${harmonicLine}

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.maxProb}%
━━━━━━━━━━━━━━━━━━
`;
}

/* ===========================
   Harmonic Detector (simple/fast)
   - uses pivots from analyzeElliott (if available) to detect Gartley/AB=CD patterns
   - returns list of {type, conf, target}
   =========================== */
function detectHarmonicsFromPivots(pivots = []) {
  const out = [];
  if (!Array.isArray(pivots) || pivots.length < 4) return out;

  // helper: ratio approx
  const approx = (a,b,tol=0.08) => Math.abs(a-b)/Math.max(1e-9,Math.abs(b)) <= tol;

  // iterate sliding windows of 5 pivots to detect 4-leg patterns
  for (let i=0;i<=pivots.length-4;i++){
    const A = pivots[i];
    const B = pivots[i+1];
    const C = pivots[i+2];
    const D = pivots[i+3];

    if (!A || !B || !C || !D) continue;

    // AB, BC, CD lengths
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);

    // Ratios AB/BC, BC/CD etc
    const r1 = AB/BC || 0;
    const r2 = BC/CD || 0;

    // Gartley rough heuristics:
    // AB retraces 61.8% of XA — we don't have X here; use relative checks:
    // look for AB < BC and CD similar to AB (AB ~ CD) -> AB=CD pattern
    if (approx(AB, CD, 0.18) && BC > AB*0.6 && BC < AB*3) {
      // classify AB=CD
      const conf = Math.max(30, Math.min(90, 100 * (1 - Math.abs(AB - CD)/Math.max(1e-9, (AB+CD)/2))));
      out.push({
        type: "AB=CD",
        conf,
        pivots: [A,B,C,D],
        target: D.price + (B.price - A.price) * (D.price < C.price ? -1 : 1) // naive
      });
    }

    // Gartley-ish: BC approx 0.618*AB and CD approx 1.272*AB
    if (approx(BC, AB*0.618, 0.2) && approx(CD, AB*1.272, 0.28)) {
      out.push({
        type: "Gartley",
        conf: 60,
        pivots:[A,B,C,D],
        target: D.price + (D.price < C.price ? -1 : 1) * AB*1.272
      });
    }

    // Butterfly-ish: CD extension ~1.618 * AB
    if (approx(CD, AB*1.618, 0.25)) {
      out.push({
        type: "Butterfly",
        conf: 55,
        pivots:[A,B,C,D],
        target: D.price + (D.price < C.price ? -1 : 1) * AB*1.618
      });
    }
  }

  // dedupe similar by type and higher confidence
  const merged = [];
  for (const h of out) {
    const existing = merged.find(m => m.type === h.type && Math.abs(m.target - h.target) < (Math.abs(h.target)*0.01 + 1e-6));
    if (!existing) merged.push(h);
    else if (h.conf > existing.conf) {
      const idx = merged.indexOf(existing);
      merged[idx] = h;
    }
  }

  return merged;
}

/* ===========================
   resolvePriceAndCandles — robust multi-source fetch (multi-tf support)
   - tries fetchUniversal(tf)
   - if no data: multiTF/fallbacks
   =========================== */
async function resolvePriceAndCandles(rawSymbol, tf = "15m") {
  const mapped = symbolMap[rawSymbol] || rawSymbol;

  // primary: fetchUniversal for requested TF
  try {
    const primary = await fetchUniversal(mapped, tf);
    if (primary && ((primary.price && primary.price !== 0) || (Array.isArray(primary.data) && primary.data.length))) {
      return { data: primary.data || [], price: safeNum(primary.price || (primary.data?.at(-1)?.close)), source: "universal" };
    }
  } catch (e) {
    // continue
  }

  // If crypto-like, try fetchMarketData
  if (isCryptoSymbol(mapped)) {
    try {
      const m = await fetchMarketData(mapped, tf);
      if (m && (m.price && m.price !== 0 || (Array.isArray(m.data) && m.data.length))) {
        return { data: m.data || [], price: safeNum(m.price), source: "marketData" };
      }
    } catch {}
  }

  // try fetchMultiTF (ask for TF directly)
  try {
    const multi = await fetchMultiTF(mapped, [tf]);
    if (multi && multi[tf] && (multi[tf].price || (multi[tf].data && multi[tf].data.length))) {
      return { data: multi[tf].data || [], price: safeNum(multi[tf].price || multi[tf].data?.at(-1)?.close), source: "multiTF" };
    }
  } catch {}

  // fallback: try universal with 15m (broad)
  try {
    const p2 = await fetchUniversal(mapped, "15m");
    if (p2 && (p2.price || (p2.data && p2.data.length))) {
      return { data: p2.data || [], price: safeNum(p2.price || p2.data?.at(-1)?.close), source: "universal-15m" };
    }
  } catch {}

  return { data: [], price: 0, source: "none" };
}

/* ===========================
   generateReport (main) — uses ML + Elliott + Harmonics + News
   - returns { text, keyboard }
   =========================== */
export async function generateReport(symbol, tf = "15m") {
  const mappedSymbol = symbolMap[symbol] || symbol;

  // 1) fetch candles + price (for requested TF)
  const { data: candlesRaw, price: livePrice, source } = await resolvePriceAndCandles(mappedSymbol, tf);
  const candles = Array.isArray(candlesRaw) ? candlesRaw : [];

  // 2) ML prediction (best-effort)
  let ml = {};
  try {
    ml = (await runMLPrediction(mappedSymbol, tf)) || {};
  } catch (e) {
    console.debug("[merge_signals] runMLPrediction error:", e?.message || e);
    ml = {};
  }

  // 3) Elliott (existing analyzer) — prefer ML-provided candles, else fetched candles
  let ell = {};
  try {
    // If ML returns candle feature set use that for Elliott (more consistent)
    const mlCandles = ml?.explanation?.features?.candles;
    ell = await analyzeElliott(Array.isArray(mlCandles) && mlCandles.length ? mlCandles : candles);
  } catch (e) {
    console.debug("[merge_signals] analyzeElliott error:", e?.message || e);
    ell = {};
  }

  // 4) Harmonincs detector — use pivots from ell if present, otherwise try to compute simple pivots
  let harmonics = [];
  try {
    const pivots = ell?.pivots || [];
    if (pivots.length >= 4) {
      harmonics = detectHarmonicsFromPivots(pivots);
    } else {
      // fallback: try to compute quick pivots by simple turning points on candles (cheap)
      const quickPivots = [];
      for (let i=2;i<candles.length-2;i++){
        const c = candles[i];
        if (!c) continue;
        // local high
        if (candles[i-2].high <= c.high && candles[i-1].high <= c.high && candles[i+1].high <= c.high && candles[i+2].high <= c.high) {
          quickPivots.push({ idx:i, t:c.t, price:c.high, type:"H" });
        }
        // local low
        if (candles[i-2].low >= c.low && candles[i-1].low >= c.low && candles[i+1].low >= c.low && candles[i+2].low >= c.low) {
          quickPivots.push({ idx:i, t:c.t, price:c.low, type:"L" });
        }
      }
      if (quickPivots.length >= 4) harmonics = detectHarmonicsFromPivots(quickPivots);
    }
  } catch (e) {
    console.debug("[merge_signals] harmonics detect error:", e?.message || e);
    harmonics = [];
  }

  // 5) News (best-effort)
  let news = {};
  try { news = (await fetchNewsBundle(mappedSymbol)) || {}; } catch (e) { news = {}; }

  // 6) Compose targets (prefer ML tps, else Elliott/harmonic targets)
  const tp1 = ml.tpEstimate ?? ml.tp1 ?? (ell?.targets && ell.targets[0] ? ell.targets[0].tp : (harmonics[0] ? harmonics[0].target : "—"));
  const tp2 = ml.tp2Estimate ?? ml.tp2 ?? (ell?.targets && ell.targets[1] ? ell.targets[1].tp : (harmonics[1] ? harmonics[1].target : "—"));
  const tpConf = ml.tpConfidence ?? ell?.confidence ?? 50;

  // 7) Build readable Elliott summary
  const ellSummary = (ell && Array.isArray(ell.patterns) && ell.patterns.length)
    ? ell.patterns.map(p => `${p.type}(${Math.round(p.confidence||ell.conf||50)}%)`).join(" + ")
    : "N/A";

  // 8) Build final object
  const out = {
    symbol,
    price: safeNum(livePrice),
    direction: ml.direction || "Neutral",
    biasEmoji: (ml.direction === "Bullish") ? "📈" : (ml.direction === "Bearish") ? "📉" : "⚪",

    tp1,
    tp2,
    tpConf,

    maxProb: ml.maxProb || Math.round((ell?.confidence||50)),

    elliottPattern: ellSummary,
    elliottConf: ell?.confidence || 50,

    harmonics: harmonics.map(h => ({ type: h.type, conf: Math.round(h.conf), target: safeNum(h.target) })),

    newsImpact: news?.impact || "Neutral",
    newsScore: news?.sentiment || 50,

    _meta: {
      mappedSymbol,
      source,
      candles: Array.isArray(candles) ? candles.length : 0,
      ellFound: Array.isArray(ell?.patterns) ? ell.patterns.length : 0,
      harmonicsFound: harmonics.length
    }
  };

  // log internal meta for debugging (useful when "data missing" issues)
  console.debug("[merge_signals] report meta:", out._meta);

  return { text: formatPremiumReport(out), keyboard: kbActions(symbol) };
}

/* ===========================
   Callback routing
   =========================== */
export async function handleCallback(query){
  const data = query.data;

  // HOME
  if (data === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
  if (data === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
  if (data === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
  if (data === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
  if (data === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
  if (data === "back_assets") return { text: "Choose Market", keyboard: kbHome };

  // ASSET select
  if (data.startsWith("asset_")) {
    const symbol = data.replace("asset_", "");
    return await generateReport(symbol, "15m");
  }

  // TIMEFRAME menu open
  if (data.startsWith("tfs_")) {
    const symbol = data.replace("tfs_", "");
    return { text: `🕒 Timeframes for <b>${symbol}</b>`, keyboard: kbTimeframes(symbol) };
  }

  // TF select: format tf_{symbol}_{5m|15m|...}
  if (data.startsWith("tf_")) {
    const clean = data.replace("tf_", "");
    const idx = clean.indexOf("_");
    if (idx === -1) return { text: "❌ Invalid timeframe", keyboard: kbHome };
    const symbol = clean.slice(0, idx);
    const tf = clean.slice(idx + 1);
    return await generateReport(symbol, tf);
  }

  // Refresh
  if (data.startsWith("refresh_")) {
    const symbol = data.replace("refresh_", "");
    return await generateReport(symbol, "15m");
  }

  // News
  if (data.startsWith("news_")) {
    const symbol = data.replace("news_", "");
    const mapped = symbolMap[symbol] || symbol;
    let n = {};
    try{ n = await fetchNewsBundle(mapped); } catch(e){ n = {}; }
    return { text: `📰 <b>News Report</b>\nImpact: ${n.impact}\nSentiment: ${n.sentiment || 0}%`, keyboard: kbActions(symbol) };
  }

  // Elliott details
  if (data.startsWith("ell_")) {
    const symbol = data.replace("ell_", "");
    const mapped = symbolMap[symbol] || symbol;
    const pd = await resolvePriceAndCandles(mapped, "15m");
    const ell = await analyzeElliott(pd.data || []);
    const patt = (ell && Array.isArray(ell.patterns) && ell.patterns.length) ? ell.patterns.map(p=>`${p.type}(${Math.round(p.confidence||ell.confidence||50)}%)`).join(", ") : "N/A";
    return { text: `📊 <b>Elliott Waves</b>\nPatterns: ${patt}\nConfidence: ${ell.confidence || 50}%`, keyboard: kbActions(symbol) };
  }

  return { text: "❌ Unknown command", keyboard: kbHome };
}

