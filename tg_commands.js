// tg_commands.js — FINAL (old-style imports, exact UI, no placeholders)
// Exports: buildAIReport(symbol, opts), formatAIReport(report), sendSplitReport(report, sendTelegramFunc)

import CONFIG from "./config.js";
import ML from "./ml_module_v13_pro.js";     // ✔ UPDATED to v13 Ultra-Dynamic Precision Pro
import News from "./news_social.js";      // ✔ EXACT (default export object)

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// Extract ML functions from default export (v13 has many exports — we grab them all)
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome,
  markOutcome,
  getStats,
  trainAdaptive,
  resetStats,
  computeReboundProbability,
  computeTrendExhaustion,
  computeVolatilityCrush,
  compute30minPressure,
  fuseMLTFs,
  buildStableTargets,
  buildAIReport: ml_buildAIReport, // if ml module provides its own buildAIReport
  // keep a fallback reference to full ML object if needed
  ...ML_REST
} = ML;

// Extract News function
const { fetchNewsBundle } = News;

// -------------------- Constants & small helpers --------------------
const MAX_TG_CHARS = 3800; // safe per Telegram (4096) with margin
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -Infinity, b = Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s, n = 120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : (s || "");

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch (e) {
    return new Date().toString();
  }
}

// split long message into safe parts while keeping logical blocks together
function splitIntoSafeParts(blocks, maxChars = MAX_TG_CHARS) {
  const parts = [];
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
          if (cur) { parts.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
            // hard chunk
            for (let i = 0; i < p.length; i += (maxChars - 200)) {
              parts.push(p.slice(i, i + maxChars - 200));
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
      if (cur) parts.push(cur);
      cur = b;
    }
  }
  if (cur) parts.push(cur);
  // attach part counters later in caller
  return parts;
}

// -------------------- Core: buildAIReport --------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];

    // fetch multi-timeframe data
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price>0 ? entry.price : (candles?.at(-1)?.close ?? 0);

      // indicators (use your core_indicators functions if available, else safe defaults)
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE",
      };

      // volume analysis
      const vol = (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "N/A", strength: 0 };

      // Elliott (safe)
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p=>p.type==="L") || null;
          const lastHigh = [...pivots].reverse().find(p=>p.type==="H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null };
        } catch { return { support: null, resistance: null, confidence: null }; }
      })();

      // targets (from ell or atr fallback)
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp>0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      // fib (if available)
      let fib = null;
      try { if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles); } catch(e){ fib = null; }

      blocks.push({ tf, price, candles, indicators: ind, vol, ell, ellSummary, targets, fib });
    }

    // fusion scoring per block
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0, w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi-50)/50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh/atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend==="UP"?0.15:indObj?.priceTrend==="DOWN"?-0.15:0); w += 0.15;
      s += (indObj?.volumeTrend==="INCREASING"?0.08:indObj?.volumeTrend==="DECREASING"?-0.08:0); w += 0.08;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100,0,1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w===0) return 0;
      return Number(clamp(s/w, -1, 1).toFixed(3));
    };

    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    // overall fusion weighted
    const TF_WEIGHTS = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
    let s=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore||0)*w; ws += w; }
    let overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // collect unique targets across TFs
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets||[])) {
        const tp = Number(t.tp||0); if (!isNum(tp) || tp<=0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence||0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=>b.confidence - a.confidence);

    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0,4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0,4);

    // ML predictions (prefer 15m)
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, opts.mlTF || "15m"); } catch (e) { mlMain = null; }
    let micro = null;
    try { micro = await runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // nudge overallFusion using ML & News
    let mlBoost = 0, newsBoost = 0;
    if (mlMain && mlMain.probs) {
      const bprob = Number(mlMain.probs.bull ?? 0);
      const rprob = Number(mlMain.probs.bear ?? 0);
      if (isNum(bprob) && isNum(rprob)) mlBoost = clamp((bprob - rprob)/100, -1, 1);
    }
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"Low", items:[] }; }
    if (news && typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
      const impact = (news.impact || "low").toLowerCase();
      const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
      newsBoost = clamp(raw * mul, -1, 1);
    }
    overallFusion = clamp(overallFusion + (mlBoost * 0.22) + (newsBoost * 0.18), -1, 1);

    // default SL suggestions using 15m ATR if present
    const primary = blocks.find(x=>x.tf==="15m") || blocks[0] || null;
    const atr15 = primary?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    // ml accuracy
    let mlAcc = 0;
    try { mlAcc = calculateAccuracy()?.accuracy ?? 0; } catch(e) { mlAcc = 0; }

    // Compose final report
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,         // array of per-tf blocks
      price,
      atr15,
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion >= 0.7) return { emoji: "🟩", label: "Strong Buy" };
        if (overallFusion >= 0.2) return { emoji: "🟦", label: "Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji: "🟧", label: "Sell" };
        return { emoji: "🟥", label: "Strong Sell" };
      })(),
      longs, shorts, allTargets,
      ml: mlMain, micro,
      mlAcc, news,
      buyProb: Number(((overallFusion + 1) / 2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2 * 100)).toFixed(2)),
      defaultSLLong, defaultSLShort
    };

    return report;

  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// -------------------- Formatter: produce the exact UI (no braces) --------------------
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return `<b>⚠️ Error building report</b>\n${report?.error || "no data"}`;

    const symbol = report.symbol || "SYMBOL";
    const time = nowIST(report.generatedAt || new Date().toISOString());
    const price = Number(report.price || 0);

    // helper to extract block for a tf
    const getBlock = (tf) => {
      const b = (report.blocks || []).find(x => x.tf === tf);
      if (!b) return null;
      // derive signature emoji/text
      const fusion = Number(b.fusionScore ?? 0);
      let sigText = "⚪ NEUTRAL";
      if (fusion >= 0.7) sigText = "🟩 STRONG BUY";
      else if (fusion >= 0.2) sigText = "🟦 BUY";
      else if (fusion <= -0.2 && fusion > -0.7) sigText = "🔴 SELL";
      else if (fusion <= -0.7) sigText = "🔴🔴 STRONG SELL";
      // rsi/macd/vol/atr
      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macd = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : 0;
      const volTxt = b.vol?.status || (b.indicators?.volumeTrend || "N/A");
      const atr = isNum(b.indicators?.ATR) ? Math.round(b.indicators.ATR) : "N/A";
      const ellPat = (b.ell && Array.isArray(b.ell.patterns) && b.ell.patterns.length) ? b.ell.patterns[0].type : (b.ell?.pattern || "No major");
      const ellConf = (b.ell && (b.ell.confidence != null)) ? Math.round(b.ell.confidence) : (b.ellSummary?.confidence != null ? Math.round(b.ellSummary.confidence) : 0);
      const S = b.ellSummary?.support ?? (b.fib?.lo ?? null) ?? "N/A";
      const R = b.ellSummary?.resistance ?? (b.fib?.hi ?? null) ?? "N/A";
      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";
      const sl = b.targets && b.targets[0] && b.targets[0].suggestedSL ? nf(b.targets[0].suggestedSL,2) : (b.sl ?? "N/A");
      // ensure sl fallback to report default
      const finalSL = (sl === "N/A") ? (tf === "15m" ? nf(report.defaultSLLong,2) : "N/A") : sl;
      return {
        sig: sigText, rsi, macd, vol: volTxt, atr, ell: ellPat, ellConf,
        s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")),
        tpLine, sl: finalSL, price: nf(b.price,2)
      };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    // overall bias + fusion
    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb,2);
    const sellProb = nf(report.sellProb,2);

    // overall TP (AI Driven) - use longs & shorts ranges if available
    const longs = report.longs || [];
    const shorts = report.shorts || [];
    const bullTP1 = longs.length ? nf(Math.min(...longs.map(x=>x.tp)),2) : b1h.r || "N/A";
    const bullTP2 = longs.length ? nf(Math.max(...longs.map(x=>x.tp)),2) : b30m.r || "N/A";
    const bearTP1 = shorts.length ? nf(Math.min(...shorts.map(x=>x.tp)),2) : b1m.s || "N/A";
    const bearTP2 = shorts.length ? nf(Math.max(...shorts.map(x=>x.tp)),2) : b5m.s || "N/A";
    const neutralSL = (report.atr15 != null && isNum(report.atr15)) ? nf(report.price - report.atr15,2) : nf(report.defaultSLLong,2);

    // ML block
    const ml = report.ml || {};
    const mlDir = ml.direction || ml.label || (report.mlDirection || "Neutral");
    const mlConf = (() => {
      if (ml.tpConfidence != null) return nf(ml.tpConfidence,0);
      if (ml.tp_conf != null) return nf(ml.tp_conf,0);
      if (ml.maxProb != null) return nf(ml.maxProb,0);
      if (ml.tpConfidence == null && typeof ml.tpEstimate === "number") return nf(ml.tpConfidence ?? 0,0);
      return nf( ml.probs && ml.probs.max ? ml.probs.max : (ml.maxProb ?? (report.mlProbs?.max ?? 0)), 0 );
    })();

    // ML Targets lines
    const mlSellTP = (ml.direction && String(ml.direction).toLowerCase().includes("bear") && isNum(ml.tpEstimate)) ? nf(ml.tpEstimate,2)
                      : (report.mlShortTP ? nf(report.mlShortTP.tp,2) : (shorts[0] ? nf(shorts[0].tp,2) : "N/A"));
    const mlBuyTP = (ml.direction && String(ml.direction).toLowerCase().includes("bull") && isNum(ml.tpEstimate)) ? nf(ml.tpEstimate,2)
                      : (report.mlLongTP ? nf(report.mlLongTP.tp,2) : (longs[0] ? nf(longs[0].tp,2) : "N/A"));

    const mlQuote = ellipsis( (ml.explanation || ml.reason || ml.summary || ml.quote || "AI forecast active"), 280 );

    // News
    const news = report.news || {};
    const newsImpact = news.impact || (news.impact === 0 ? "Low" : "Low");
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    // Build UI exactly as requested (no curly braces)
    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Free)

🕒 1M — ${b1m.sig || "N/A"}
RSI ${b1m.rsi || "N/A"} | MACD ${b1m.macd || "N/A"} | Vol ${b1m.vol || "N/A"} | ATR ${b1m.atr || "N/A"}
Elliott: ${b1m.ell || "N/A"} | Conf ${b1m.ellConf || 0}%
S: ${b1m.s || "N/A"} | R: ${b1m.r || "N/A"}
TP 🎯: ${b1m.tpLine || "N/A"}  
SL: ${b1m.sl || "N/A"}

🕒 5M — ${b5m.sig || "N/A"}
RSI ${b5m.rsi || "N/A"} | MACD ${b5m.macd || "N/A"} | Vol ${b5m.vol || "N/A"} | ATR ${b5m.atr || "N/A"}
Elliott: ${b5m.ell || "N/A"} | Conf ${b5m.ellConf || 0}%
S: ${b5m.s || "N/A"} | R: ${b5m.r || "N/A"}
TP 🎯: ${b5m.tpLine || "N/A"}  
SL: ${b5m.sl || "N/A"}

🕒 15M — ${b15m.sig || "N/A"}
RSI ${b15m.rsi || "N/A"} | MACD ${b15m.macd || "N/A"} | Vol ${b15m.vol || "N/A"} | ATR ${b15m.atr || "N/A"}
Elliott: ${b15m.ell || "N/A"} | ${b15m.ellConf || 0}%
S: ${b15m.s || "N/A"} | R: ${b15m.r || "N/A"}
TP 🎯: ${b15m.tpLine || "N/A"}  
SL: ${b15m.sl || "N/A"}

🕒 30M — ${b30m.sig || "N/A"}
RSI ${b30m.rsi || "N/A"} | MACD ${b30m.macd || "N/A"} | Vol ${b30m.vol || "N/A"} | ATR ${b30m.atr || "N/A"}
Elliott: ${b30m.ell || "N/A"} | ${b30m.ellConf || 0}%
S: ${b30m.s || "N/A"} | R: ${b30m.r || "N/A"}
TP 🎯: ${b30m.tpLine || "N/A"}

🕒 1H — ${b1h.sig || "N/A"}
RSI ${b1h.rsi || "N/A"} | MACD ${b1h.macd || "N/A"} | Vol ${b1h.vol || "N/A"} | ATR ${b1h.atr || "N/A"}
Elliott: ${b1h.ell || "N/A"} | ${b1h.ellConf || 0}%
S: ${b1h.s || "N/A"} | R: ${b1h.r || "N/A"}
TP 🎯: ${b1h.tpLine || "N/A"}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${finalBias}  
Fusion Score: ${fusionScore}  
Buy ${buyProb}% | Sell ${sellProb}%
━━━━━━━━━━━━━━━━━━

🎯 OVERALL TP (AI Driven)
Bullish TP: ${bullTP1} – ${bullTP2}  
Bearish TP: ${bearTP1} – ${bearTP2}  
SL (Neutral Invalidation): ${neutralSL}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)
Direction: ${mlDir}  
ML Confidence: ${mlConf}%

📌 ML Says:  
“${mlQuote}”

ML Targets:
• ML Sell TP: <b>${mlSellTP}</b>  
• ML Buy TP (Hedge): <b>${mlBuyTP}</b>
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    // Split into safe parts if too long. We'll keep entire block as one if fits, else break into header+rest.
    const parts = splitIntoSafeParts([partMain], MAX_TG_CHARS);
    if (parts.length > 1) {
      return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    }
    return [partMain];

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// -------------------- sendSplitReport helper --------------------
// sendTelegramFunc must be async function(text) -> boolean/response
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
        // retry once after short wait
        await new Promise(r=>setTimeout(r,600));
        try { await sendTelegramFunc(text); } catch {}
      }
      if (i < parts.length - 1) await new Promise(r=>setTimeout(r,650));
    }
    return true;
  } catch (e) {
    return false;
  }
}

// default export for aiTraderBot.js
export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};