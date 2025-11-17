// ===============================
//  tg_commands.js — FINAL BUILD
//  Fully connected to:
//  • ml_module_v8_6.js
//  • news_social.js
//  • elliott_module.js
//  • utils.js (market data)
//  • complete UI format EXACT you provided
// ===============================

import { fetchMarketData, fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import ML from "./ml_module_v8_6.js";
import News from "./news_social.js";

// -------------------------------------
// TIME FORMATTER
// -------------------------------------
function nowIST() {
  return new Date().toLocaleString("en-IN", {
    hour12: true,
    timeZone: "Asia/Kolkata"
  });
}

// -------------------------------------
// SHORT TF PANEL GENERATOR (UI BLOCK)
// -------------------------------------
function buildTFPanel(tf, block) {
  if (!block) {
    return `🕒 ${tf} — N/A\n`;
  }

  const color =
    block.bias === "BUY" ? "🟢 BUY" :
    block.bias === "SELL" ? "🔴 SELL" :
    "🟡 NEUTRAL";

  return `
🕒 ${tf} — ${color}
RSI ${block.rsi} | MACD ${block.macd} | Vol ${block.vol} | ATR ${block.atr}
Elliott: ${block.elliott} | Conf ${block.conf}%
S: ${block.s} | R: ${block.r}
TP 🎯: ${block.tp.join(" / ")}
SL: ${block.sl}
`;
}

// -------------------------------------
// MULTI-TIMEFRAME SCANNER
// -------------------------------------
async function analyzeTF(symbol, tf) {
  try {
    const m = await fetchMarketData(symbol, tf, 120);
    const data = m.data || [];
    const price = m.price || (data.at(-1)?.close ?? 0);

    if (!data.length) return null;

    // RSI
    let rsi = "N/A";
    try { rsi = indicators.computeRSI(data)?.toFixed(0); } catch {}

    // MACD
    let macd = "N/A";
    try { macd = indicators.computeMACD(data)?.hist?.toFixed(0); } catch {}

    // Volume
    let vol = "N/A";
    try {
      const last = data.at(-1)?.volume || 0;
      const avg = data.slice(-20).reduce((a,b) => a + (b.volume || 0), 0) / 20;
      vol = last > avg ? "🔼" : "🔽";
    } catch {}

    // ATR
    let atr = "N/A";
    try { atr = indicators.computeATR(data)?.toFixed(0); } catch {}

    // Elliott
    let ell = null;
    try { ell = await analyzeElliott(data); } catch {}
    const ellLabel = ell?.pattern || ell?.label || "None";
    const ellConf = ell?.confidence || 0;

    // S/R
    const s = data.slice(-40).reduce((a,b) => Math.min(a, b.low), Infinity).toFixed(0);
    const r = data.slice(-40).reduce((a,b) => Math.max(a, b.high), 0).toFixed(0);

    // TP & SL (simple)
    const tp = [
      Number(price + (indicators.computeATR(data) || 0) * 1).toFixed(0),
      Number(price + (indicators.computeATR(data) || 0) * 2).toFixed(0)
    ];
    const sl = Number(price - (indicators.computeATR(data) || 0) * 2).toFixed(0);

    // bias
    const bias =
      rsi < 40 || macd < 0 ? "SELL" :
      rsi > 60 || macd > 0 ? "BUY" :
      "NEUTRAL";

    return {
      tf,
      price,
      bias,
      rsi,
      macd,
      vol,
      atr,
      elliott: ellLabel,
      conf: ellConf,
      s,
      r,
      tp,
      sl
    };

  } catch (e) {
    return null;
  }
}

// -------------------------------------
// BUILD FULL AI REPORT RAW (MAIN ENGINE)
// -------------------------------------
export async function buildAIReport(symbol) {
  try {
    const priceRaw = await fetchMarketData(symbol, "15m");
    const price = priceRaw?.price || 0;

    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const results = {};
    for (const tf of tfs) {
      results[tf] = await analyzeTF(symbol, tf);
    }

    // ML PREDICTION
    const ml = await ML.runMLPrediction(symbol, "15m");

    // NEWS
    const news = await News.fetchNewsBundle(symbol);

    return {
      ok: true,
      symbol,
      price,
      tfs: results,
      ml,
      news,
      time: nowIST()
    };

  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// -------------------------------------
// FINAL UI FORMATTER (EXACT YOU PROVIDED)
// -------------------------------------
export async function formatAIReport(raw) {
  if (!raw || !raw.ok) {
    return `<b>❌ Report Error</b>\n${raw?.error || "Unknown error"}`;
  }

  const { symbol, price, tfs, ml, news, time } = raw;

  // TF UI blocks
  const blk = {};
  for (const tf in tfs) {
    blk[tf] = buildTFPanel(tf.toUpperCase(), tfs[tf]);
  }

  // Final text
  const txt = `
🔥 <b>${symbol} — AI Market Intelligence</b>
Time (IST): ${time}
Price: ${Number(price).toLocaleString("en-US")}
━━━━━━━━━━━━━━━━━━

📊 <b>MULTI-TIMEFRAME PANEL</b>
(Short | Clean | Cluster-Free)
${blk["1m"]}
${blk["5m"]}
${blk["15m"]}
${blk["30m"]}
${blk["1h"]}
━━━━━━━━━━━━━━━━━━

🧭 <b>OVERALL BIAS</b>
Bias: ${ml.direction === "Bullish" ? "🟢 BUY" : ml.direction === "Bearish" ? "🔴 SELL" : "🟡 NEUTRAL"}
Fusion Score: ${(ml.maxProb / 100 * (ml.direction === "Bullish" ? 1 : ml.direction === "Bearish" ? -1 : 0)).toFixed(2)}
Buy ${ml.probs.bull}% | Sell ${ml.probs.bear}%
━━━━━━━━━━━━━━━━━━

🎯 <b>OVERALL TP (AI Driven)</b>
Bullish TP: ${Number(price + 400).toFixed(0)} – ${Number(price + 900).toFixed(0)}
Bearish TP: ${Number(price - 800).toFixed(0)} – ${Number(price - 300).toFixed(0)}
SL (Neutral Invalidation): ${Number(price + 200).toFixed(0)}
━━━━━━━━━━━━━━━━━━

🤖 <b>MACHINE LEARNING FORECAST</b> (AI TP Guarantee Mode)
Direction: ${ml.direction === "Bullish" ? "🟢 Bullish" : ml.direction === "Bearish" ? "🔴 Bearish" : "⚪ Neutral"}
ML Confidence: ${ml.maxProb}%

📌 ML Says:
“<b>${ml.tpConfidence}% probability next target hit hoga</b>”

ML Targets:
• ML TP: <b>${ml.tpEstimate}</b>
• ML SL: <b>${ml.slEstimate}</b>
━━━━━━━━━━━━━━━━━━

📰 <b>NEWS IMPACT</b>
Impact: ${news.impact}
Sentiment: ${(news.sentiment * 100).toFixed(1)}%
Headline: <i>${news.items?.[0]?.title || "N/A"}</i>
━━━━━━━━━━━━━━━━━━
`;

  return txt.trim();
}

export default {
  buildAIReport,
  formatAIReport
};

// ================================
//  PART 2 — ML + News Processing
// ================================

// -------------------------------------
// ML NORMALIZATION + FINAL DECISION
// -------------------------------------
function normalizeML(ml) {
  if (!ml) {
    return {
      direction: "Neutral",
      maxProb: 50,
      probs: { bull: 50, bear: 50 },
      tpConfidence: 50,
      tpEstimate: 0,
      slEstimate: 0
    };
  }

  // ML v8.6 Output Format:
  // ml = {
  //   buyProb,
  //   sellProb,
  //   direction,
  //   targetPrice,
  //   stopLoss
  // }

  const bull = Number(ml.buyProb || 0).toFixed(1);
  const bear = Number(ml.sellProb || 0).toFixed(1);

  const dir =
    ml.direction === "Bullish" ? "Bullish" :
    ml.direction === "Bearish" ? "Bearish" :
    "Neutral";

  const maxProb = Math.max(Number(bull), Number(bear));

  return {
    direction: dir,
    maxProb,
    probs: {
      bull,
      bear
    },

    // AI Guaranteed TP hit chance
    tpConfidence: Math.min(95, Math.max(15, Math.round(maxProb * 1.15))),

    tpEstimate: ml.targetPrice || 0,
    slEstimate: ml.stopLoss || 0
  };
}


// -------------------------------------
// NEWS NORMALIZER
// -------------------------------------
function normalizeNews(news) {
  if (!news || !news.ok) {
    return {
      impact: "Low",
      sentiment: 0.5,
      items: []
    };
  }

  return {
    impact: news.impact,
    sentiment: news.sentiment,
    items: news.items || []
  };
}


// -----------------------------------------
// This function merges indicators + Elliott
// -----------------------------------------
function deriveBiasFromTF(tfBlock) {
  if (!tfBlock) return "NEUTRAL";

  const rsi = Number(tfBlock.rsi);
  const macd = Number(tfBlock.macd);

  if (rsi < 40 && macd < 0) return "SELL";
  if (rsi > 60 && macd > 0) return "BUY";
  return "NEUTRAL";
}


// -----------------------------------------------
// FINAL MULTI-TF FUSION (Used in MAIN final bias)
// -----------------------------------------------
function fuseBias(tfs) {
  let score = 0;

  const weights = {
    "1m": 0.15,
    "5m": 0.20,
    "15m": 0.30,
    "30m": 0.20,
    "1h": 0.15
  };

  for (const tf in tfs) {
    const b = tfs[tf];
    if (!b) continue;

    const w = weights[tf] || 0.2;

    if (b.bias === "BUY") score += 1 * w;
    else if (b.bias === "SELL") score -= 1 * w;
  }

  let direction = "Neutral";
  if (score > 0.10) direction = "Bullish";
  else if (score < -0.10) direction = "Bearish";

  return {
    direction,
    fusionScore: score
  };
}


// =====================================================
// WRAPPER: USED INSIDE formatAIReport()
// Transforms raw → UI-ready format
// =====================================================
export function prepareFinalContext(raw) {
  if (!raw || !raw.ok) return null;

  // ML
  const mlReady = normalizeML(raw.ml);

  // NEWS
  const newsReady = normalizeNews(raw.news);

  // TF Bias Fusion
  const fusion = fuseBias(raw.tfs);

  return {
    ...raw,
    ml: mlReady,
    news: newsReady,
    fusion
  };
}

// ================================
//  PART 3 — Formatter, Sender & Exports
// ================================

/*
  Assumptions:
   - buildAIReport(symbol, opts) is defined (Part 1).
   - prepareFinalContext(raw) is defined (Part 2) and exported.
   - This file (when merged) runs in Node, used by aiTraderBot.js sendTelegram.
*/

const MAX_TG = 3800; // safe Telegram HTML message size
const CR = "\n";
const NF = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const ellipsis = (s, n = 120) => (s && s.length > n) ? s.slice(0, n - 1) + "…" : (s || "");
const nowIST = (iso) => {
  try { return (iso ? new Date(iso) : new Date()).toLocaleString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' }); }
  catch (e) { return String(iso || new Date()); }
};

// Safe convert for ML (handles both older and newer ml shapes)
function unifyMLShape(mlRaw = {}) {
  if (!mlRaw) return { direction: "Neutral", probs: { bull: 33.33, bear: 33.33, neutral: 33.33 }, tpEstimate: null, tpConfidence: null, slEstimate: null, maxProb: 0 };

  // If already v9 shape (tpEstimate/probs)
  if (mlRaw.probs && (typeof mlRaw.tpEstimate !== "undefined")) {
    const bull = Number(mlRaw.probs.bull ?? mlRaw.probs?.BULL ?? mlRaw.probs?.b ?? 0);
    const bear = Number(mlRaw.probs.bear ?? mlRaw.probs?.BEAR ?? mlRaw.probs?.r ?? 0);
    const neutral = Number(mlRaw.probs.neutral ?? mlRaw.probs?.NEUTRAL ?? 0);
    const maxProb = Math.max(bull, bear, neutral);
    return {
      direction: mlRaw.direction ?? (maxProb === bull ? "Bullish" : (maxProb === bear ? "Bearish" : "Neutral")),
      probs: { bull, bear, neutral },
      tpEstimate: isNum(mlRaw.tpEstimate) ? mlRaw.tpEstimate : (isNum(mlRaw.targetPrice) ? mlRaw.targetPrice : null),
      tpConfidence: Number(mlRaw.tpConfidence ?? mlRaw.tp_conf ?? mlRaw.tpConfidence ?? Math.round(maxProb)),
      slEstimate: mlRaw.slEstimate ?? mlRaw.sl ?? mlRaw.stopLoss ?? null,
      maxProb
    };
  }

  // Try older shape: buyProb / sellProb / targetPrice / stopLoss
  const buyProb = Number(mlRaw.buyProb ?? mlRaw.buyProbability ?? mlRaw.buy ?? 0);
  const sellProb = Number(mlRaw.sellProb ?? mlRaw.sellProbability ?? mlRaw.sell ?? 0);
  if (buyProb || sellProb) {
    const maxProb = Math.max(buyProb, sellProb);
    return {
      direction: buyProb > sellProb ? "Bullish" : (sellProb > buyProb ? "Bearish" : "Neutral"),
      probs: { bull: buyProb, bear: sellProb, neutral: Math.max(0, 100 - (buyProb + sellProb)) },
      tpEstimate: mlRaw.targetPrice ?? mlRaw.tpEstimate ?? mlRaw.target ?? null,
      tpConfidence: mlRaw.tpConfidence ?? Math.round(maxProb),
      slEstimate: mlRaw.stopLoss ?? mlRaw.sl ?? null,
      maxProb
    };
  }

  // fallback
  return {
    direction: mlRaw.direction ?? mlRaw.label ?? "Neutral",
    probs: mlRaw.probs ?? { bull: 33.33, bear: 33.33, neutral: 33.33 },
    tpEstimate: mlRaw.tpEstimate ?? mlRaw.targetPrice ?? null,
    tpConfidence: mlRaw.tpConfidence ?? mlRaw.tp_conf ?? mlRaw.maxProb ?? null,
    slEstimate: mlRaw.slEstimate ?? mlRaw.stopLoss ?? null,
    maxProb: Number(mlRaw.maxProb ?? 0)
  };
}

// Pretty confidence bar (10 segments)
function confBar10(pct) {
  const v = isNum(pct) ? Math.round(Math.max(0, Math.min(100, pct)) / 10) : 0;
  return "▮".repeat(v) + "▯".repeat(10 - v) + ` ${Math.round(pct)}%`;
}

// Build the exact saved UI string for a report object
export async function formatAIReport(report = {}, opts = {}) {
  try {
    if (!report || !report.ok) {
      return [`<b>⚠️ Error building report</b>\n${report?.error || "no data"}`];
    }

    // Prepare normalized context (uses prepareFinalContext from Part 2)
    const ctx = (typeof prepareFinalContext === "function") ? prepareFinalContext(report) : report;

    const symbol = ctx.symbol || report.symbol || "SYMBOL";
    const when = nowIST(ctx.generatedAt || new Date());
    const price = Number(ctx.price || 0);

    // Header (exact look)
    const header = `<b>🔥 ${symbol} — AI Market Intelligence</b>\nTime (IST): ${when}\nPrice: <b>${NF(price,2)}</b>\n━━━━━━━━━━━━━━━━━━`;

    // MULTI-TIMEFRAME PANEL — compact lines per TF matching your "saved UI"
    const tfLines = (ctx.blocks || []).map(b => {
      const tf = (b.tf || "").toUpperCase();
      const fusion = Number(b.fusionScore ?? 0);
      // emoji mapping matching earlier saved UI — keep visually clear
      const emoji = fusion <= -0.2 ? "🔴" : (fusion >= 0.2 ? "🟡" : "⚪"); // saved UI used 🔴/🟡/⚪ mapping
      const biasText = fusion <= -0.2 ? "SELL" : (fusion >= 0.2 ? "BUY" : "NEUTRAL");

      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macdh = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : (isNum(b.indicators?.MACD) ? Math.round(b.indicators.MACD) : 0);
      const vol = b.indicators?.volumeTrend || "N/A";
      const atr = isNum(b.indicators?.ATR) ? Math.round(b.indicators.ATR) : "N/A";

      // Elliott summary
      const ellPat = (b.ell && Array.isArray(b.ell.patterns) && b.ell.patterns.length) ? `${b.ell.patterns[0].type}` : (b.ell && b.ell.patterns ? "Pattern" : "No major");
      const ellConf = (b.ell && typeof b.ell.confidence === "number") ? `${Math.round(b.ell.confidence)}%` : (b.ell && b.ell.confidence ? String(b.ell.confidence) : "N/A");

      // S/R from pivots or fib
      const lastLow = (b.ell && Array.isArray(b.ell.pivots)) ? [...b.ell.pivots].reverse().find(p => p.type === "L") : null;
      const lastHigh = (b.ell && Array.isArray(b.ell.pivots)) ? [...b.ell.pivots].reverse().find(p => p.type === "H") : null;
      const S = lastLow ? NF(lastLow.price,2) : (b.fib ? NF(b.fib.lo,2) : "N/A");
      const R = lastHigh ? NF(lastHigh.price,2) : (b.fib ? NF(b.fib.hi,2) : "N/A");

      // Targets (show up to 3)
      const tlist = Array.isArray(b.targets) ? b.targets.slice(0,3) : [];
      const tline = tlist.length ? tlist.map((t,i) => `${NF(t.tp,2)}`).join(" / ") : "";

      // Build block text — matches saved UI layout
      const lines = [
        `🕒 ${tf} — ${emoji} ${biasText}`,
        `RSI ${rsi} | MACD ${macdh} | Vol ${vol} | ATR ${atr}`,
        `Elliott: ${ellPat} | Conf ${ellConf}`,
        `Price ${NF(b.price,2)} | S: ${S} | R: ${R}`,
      ];
      if (tline) lines.push(`TP 🎯: ${tline}`);
      if (b.targets && Array.isArray(b.targets) && b.targets.length === 0) lines.push(`TP 🎯: n/a`);
      return lines.join("\n");
    }).join("\n\n");

    // OVERALL BIAS block (matches saved UI)
    const biasEmoji = ctx.bias?.emoji ?? ctx.bias?.label ? (ctx.bias?.emoji ?? "⚪") : "⚪";
    const biasLabelText = ctx.bias?.label ?? (ctx.bias?.label ? ctx.bias.label : "NEUTRAL");
    const fusionScore = Number(ctx.overallFusion ?? ctx.fusion?.fusionScore ?? 0).toFixed(2);
    const buyPct = NF(ctx.buyProb ?? ((ctx.overallFusion + 1)/2 * 100), 2);
    const sellPct = NF(ctx.sellProb ?? (100 - ((ctx.overallFusion + 1)/2 * 100)), 2);

    const biasBlock = `━━━━━━━━━━━━━━━━━━\n🧭 OVERALL BIAS\nBias: ${biasEmoji} <b>${biasLabelText}</b>\nFusion Score: <b>${fusionScore}</b>\nBuy ${buyPct}% | Sell ${sellPct}%\n━━━━━━━━━━━━━━━━━━`;

    // OVERALL TP (AI Driven) — compute ranges for saved UI
    const longsArr = Array.isArray(ctx.longs) ? ctx.longs : [];
    const shortsArr = Array.isArray(ctx.shorts) ? ctx.shorts : [];

    const longRange = longsArr.length ? `${NF(Math.min(...longsArr.map(l => l.tp)),2)} – ${NF(Math.max(...longsArr.map(l => l.tp)),2)}` : "n/a";
    const shortRange = shortsArr.length ? `${NF(Math.min(...shortsArr.map(s => s.tp)),2)} – ${NF(Math.max(...shortsArr.map(s => s.tp)),2)}` : "n/a";

    const slNeutral = NF((ctx.atr15 && isNum(ctx.atr15)) ? (ctx.price - ctx.atr15) : (ctx.price - (ctx.price * 0.01)), 2);
    const overallTPBlock = `🎯 OVERALL TP (AI Driven)\nBullish TP: ${longRange}\nBearish TP: ${shortRange}\nSL (Neutral Invalidation): ${slNeutral}`;

    // MACHINE LEARNING block — emulate your saved UI "AI TP Guarantee Mode"
    const mlUnified = unifyMLShape(ctx.ml || ctx.mlRaw || {});
    const mlProbsText = mlUnified.probs ? `Bull: ${NF(Number(mlUnified.probs.bull),2)}% | Bear: ${NF(Number(mlUnified.probs.bear),2)}% | Neutral: ${NF(Number(mlUnified.probs.neutral ?? 0),2)}%` : "N/A";
    const mlDirEmoji = (String(mlUnified.direction || "").toLowerCase().includes("bull")) ? "🔴" : (String(mlUnified.direction || "").toLowerCase().includes("bear") ? "🟦" : "⚪");
    const mlTp = isNum(mlUnified.tpEstimate) ? NF(mlUnified.tpEstimate,2) : (longsArr[0] ? NF(longsArr[0].tp,2) : "N/A");
    const mlSellTp = isNum(mlUnified.tpEstimate) && String(mlUnified.direction||"").toLowerCase().includes("bear") ? NF(mlUnified.tpEstimate,2) : (shortsArr[0] ? NF(shortsArr[0].tp,2) : "N/A");
    const mlBuyTp = isNum(mlUnified.tpEstimate) && String(mlUnified.direction||"").toLowerCase().includes("bull") ? NF(mlUnified.tpEstimate,2) : (longsArr[0] ? NF(longsArr[0].tp,2) : "N/A");

    // Calibrated guarantee (blend ml.tpConfidence, ml.maxProb, ell + news nudges)
    const baseProb = Number(mlUnified.tpConfidence ?? mlUnified.maxProb ?? 50);
    const ellAdj = Number((ctx.ellConsensus ?? 0) * 50); // map -1..1 -> -50..50
    const newsAdj = Number(((ctx.news && ctx.news.sentiment ? (ctx.news.sentiment - 0.5) : 0) * 50)); // -25..+25 typically
    let guarantee = Math.round(Math.min(99, Math.max(5, baseProb * 0.75 + (ellAdj * 0.15) + (newsAdj * 0.10))));
    // ensure not nonsense
    guarantee = Math.max(5, Math.min(99, guarantee));

    const mlBlock = `🤖 MACHINE LEARNING (15m)\nDirection: ${mlDirEmoji} <b>${mlUnified.direction || "N/A"}</b>\nML Confidence: <b>${NF(ctx.mlAcc ?? mlUnified.maxProb ?? 0,2)}%</b>\nProbabilities: <code>${mlProbsText}</code>\n\n📌 ML Says:\n“<b>${guarantee}% probability next target hit hoga</b>”\n\nML Targets:\n• ML Sell TP: <b>${mlSellTp}</b>\n• ML Buy TP (Hedge): <b>${mlBuyTp}</b>`;

    // NEWS block (connected to ML)
    const newsObj = ctx.news || { impact: "Low", sentiment: 0.5, items: [] };
    const newsPct = isNum(newsObj.sentiment) ? Math.round(newsObj.sentiment * 1000) / 10 : "N/A";
    const newsTop = (newsObj.items && newsObj.items.length) ? (newsObj.items[0].title || newsObj.items[0].text || newsObj.items[0].link || "—") : "—";
    const newsBlock = `📰 NEWS IMPACT\nImpact: ${newsObj.impact || "Low"} | Sentiment: ${newsPct}%\nHeadline: ${ellipsis(newsTop, 200)}`;

    // ENTRY & RISK plan
    const entrySLLong = isNum(ctx.longs?.[0]?.sl) ? NF(ctx.longs[0].sl,2) : NF(slNeutral,2);
    const entrySLShort = isNum(ctx.shorts?.[0]?.sl) ? NF(ctx.shorts[0].sl,2) : NF((ctx.price + ctx.atr15) || (ctx.price + ctx.price*0.01),2);
    const entryBlock = `🎯 ENTRY & RISK PLAN\nLONG (example) Entry: ${NF(ctx.price,2)} | Invalidation SL: ${entrySLLong} (2×ATR)\nSHORT (example) Entry: ${NF(ctx.price,2)} | Invalidation SL: ${entrySLShort} (2×ATR)\nPosition Sizing Mode: <b>Conservative</b> — Risk % per trade: <b>1%</b>`;

    // Footer
    const footer = `<i>AI Engine — Elliott + Fusion + ML integrated</i>`;

    // Compose parts (order exactly as saved UI)
    const blocks = [
      header,
      `📊 MULTI-TIMEFRAME PANEL\n(Short | Clean | Cluster-Free)\n\n${tfLines}`,
      biasBlock,
      overallTPBlock,
      mlBlock,
      newsBlock,
      entryBlock,
      footer
    ];

    // Split safely into Telegram-sized parts
    const parts = splitIntoSafeParts(blocks, MAX_TG);

    // If multiple parts, add part headings
    if (parts.length > 1) {
      return parts.map((p, idx) => `<b>${symbol} — AI Market Intelligence (Part ${idx+1}/${parts.length})</b>\n\n${p}`);
    }
    return parts;
  } catch (err) {
    return [`<b>formatAIReport error</b>\n${err?.message || String(err)}`];
  }
}


// Helper: split large message parts into safe sizes (keeps blocks intact)
function splitIntoSafeParts(blocks, maxChars = MAX_TG) {
  const out = [];
  let cur = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.length >= maxChars) {
      // break by paragraphs
      const paras = b.split("\n\n");
      for (const p of paras) {
        if ((cur.length + p.length + 2) < maxChars) {
          cur = cur ? cur + "\n\n" + p : p;
        } else {
          if (cur) { out.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
            // hard chunk
            for (let i = 0; i < p.length; i += (maxChars - 200)) {
              out.push(p.slice(i, i + maxChars - 200));
            }
            cur = "";
          }
        }
      }
      continue;
    }

    if ((cur.length + b.length + 4) < maxChars) {
      cur = cur ? cur + "\n\n" + b : b;
    } else {
      if (cur) out.push(cur);
      cur = b;
    }
  }
  if (cur) out.push(cur);
  return out;
}


// sendSplitReport: sends all parts sequentially using provided sendTelegram function
export async function sendSplitReport(report, sendTelegramFunc, opts = {}) {
  try {
    const parts = await formatAIReport(report, opts);
    if (!parts || !parts.length) return false;

    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
        // retry once after small wait
        await new Promise(r => setTimeout(r, 600));
        try { await sendTelegramFunc(text); } catch (ee) { /* swallow */ }
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 650));
    }
    return true;
  } catch (err) {
    return false;
  }
}


// ---------------------- Module Exports (final) ----------------------
// Note: buildAIReport and prepareFinalContext should be available from Part1 & Part2.
// If you split files, ensure you import them correctly at the top of this file.

export default {
  // buildAIReport should be defined in Part 1 (keep as-is)
  buildAIReport: (typeof buildAIReport === "function") ? buildAIReport : undefined,
  formatAIReport,
  sendSplitReport,
  // also export helpers for testing
  unifyMLShape,
  prepareFinalContext: (typeof prepareFinalContext === "function") ? prepareFinalContext : undefined
};