// tg_commands.js — final Telegram formatting module (uses ml_module_v8_6.js V12 Ultra)
// Exports: buildAIReport, formatAIReport, sendSplitReport

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";
import News from "./news_social.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

const { runMLPrediction, runMicroPrediction, calculateAccuracy } = ML;
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

const MAX_TG_CHARS = 3800;
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };
const nf = (v,d=2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v,a=-Infinity,b=Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s,n=120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : (s || "");

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch (e) { return new Date().toString(); }
}

function splitIntoSafeParts(blocks, maxChars = MAX_TG_CHARS) {
  const parts = [];
  let cur = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.length >= maxChars) {
      const paras = b.split("\n\n");
      for (const p of paras) {
        if ((cur.length + p.length + 2) < maxChars) {
          cur = cur ? cur + "\n\n" + p : p;
        } else {
          if (cur) { parts.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
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
  return parts;
}

export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data:[], price:0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p => p.type === "L") || null;
          const lastHigh = [...pivots].reverse().find(p => p.type === "H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null };
        } catch { return { support:null, resistance:null, confidence:null }; }
      })();
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence:30, source:"ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence:30, source:"ATR_DOWN" }
        ];
      }
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // compute fusion per block (lightweight)
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0,w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh / atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0); w += 0.15;
      s += (indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0); w += 0.08;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w === 0) return 0;
      return Number(clamp(s / w, -1, 1).toFixed(3));
    };

    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    const TF_WEIGHTS = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
    let sTotal=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += (b.fusionScore || 0) * w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal / ws, -1, 1).toFixed(3)) : 0;

    // collect targets cluster
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets || [])) {
        const tp = Number(t.tp || 0); if (!isNum(tp) || tp <= 0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence || 0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b) => b.confidence - a.confidence);
    const price = blocks.find(x => x.tf === "15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0,4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0,4);

    // ML
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, opts.mlTF || "15m"); } catch (e) { mlMain = null; }
    let micro = null;
    try { micro = await runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // ML boost to fusion
    let mlBoost=0;
    if (mlMain && mlMain.probs) {
      const bprob = Number(mlMain.probs.bull ?? 0);
      const rprob = Number(mlMain.probs.bear ?? 0);
      if (isNum(bprob) && isNum(rprob)) mlBoost = clamp((bprob - rprob) / 100, -1, 1);
    }
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    let newsBoost = 0;
    if (news && typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
      const impact = (news.impact || "low").toLowerCase();
      const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
      newsBoost = clamp(raw * mul, -1, 1);
    }
    overallFusion = clamp(overallFusion + (mlBoost * 0.22) + (newsBoost * 0.18), -1, 1);

    const atr15 = blocks.find(x => x.tf === "15m")?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(2)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(2)) : null;

    // ml accuracy
    let mlAcc = 0;
    try { mlAcc = calculateAccuracy()?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    const report = {
      ok:true, symbol, generatedAt: new Date().toISOString(), nowIST: nowIST(),
      blocks, price, atr15, overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs, shorts, allTargets, ml: mlMain, micro, mlAcc, news,
      buyProb: Number(((overallFusion + 1) / 2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2 * 100)).toFixed(2)),
      defaultSLLong, defaultSLShort
    };

    return report;
  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return `<b>⚠️ Error building report</b>\n${report?.error || "no data"}`;

    const symbol = report.symbol || "SYMBOL";
    const time = nowIST(report.generatedAt || new Date().toISOString());
    const price = Number(report.price || 0);

    const getBlock = (tf) => {
      const b = (report.blocks || []).find(x => x.tf === tf);
      if (!b) return null;
      const fusion = Number(b.fusionScore ?? 0);
      let sigText = "⚪ NEUTRAL";
      if (fusion >= 0.7) sigText = "🟩 STRONG BUY";
      else if (fusion >= 0.2) sigText = "🟦 BUY";
      else if (fusion <= -0.2 && fusion > -0.7) sigText = "🔴 SELL";
      else if (fusion <= -0.7) sigText = "🔴🔴 STRONG SELL";
      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macd = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : 0;
      const volTxt = b.indicators?.volumeTrend || "N/A";
      const atr = isNum(b.indicators?.ATR) ? Math.round(b.indicators.ATR) : "N/A";
      const ellPat = (b.ell && Array.isArray(b.ell.patterns) && b.ell.patterns.length) ? b.ell.patterns[0].type : (b.ell?.pattern || "No major");
      const ellConf = (b.ell && (b.ell.confidence != null)) ? Math.round(b.ell.confidence) : (b.ellSummary?.confidence != null ? Math.round(b.ellSummary.confidence) : 0);
      const S = b.ellSummary?.support ?? "N/A";
      const R = b.ellSummary?.resistance ?? "N/A";
      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";
      const sl = "N/A";
      return { sig: sigText, rsi, macd, vol: volTxt, atr, ell: ellPat, ellConf, s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")), tpLine, sl, price: nf(b.price,2) };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb, 2);
    const sellProb = nf(report.sellProb, 2);

    const longs = report.longs || [];
    const shorts = report.shorts || [];
    const bullTP1 = longs.length ? nf(Math.min(...longs.map(x => x.tp)), 2) : (b1h.r || "N/A");
    const bullTP2 = longs.length ? nf(Math.max(...longs.map(x => x.tp)), 2) : (b30m.r || "N/A");
    const bearTP1 = shorts.length ? nf(Math.min(...shorts.map(x => x.tp)), 2) : (b1m.s || "N/A");
    const bearTP2 = shorts.length ? nf(Math.max(...shorts.map(x => x.tp)), 2) : (b5m.s || "N/A");
    const neutralSL = (report.atr15 != null && isNum(report.atr15)) ? nf(report.price - report.atr15, 2) : nf(report.defaultSLLong, 2);

    const ml = report.ml || {};
    const mlDir = ml.direction || ml.label || "Neutral";
    const mlConf = (ml.tpConfidence != null) ? nf(ml.tpConfidence, 0) : (ml.maxProb != null ? nf(ml.maxProb, 0) : "N/A");
    const mlAccObj = report.mlAcc || 0;
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);
    const aw = (ml.adaptiveWeights || report.ml?.adaptiveWeights || { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1 });
    const awTxt = `ind:${Math.round((aw.w_ind||0)*100)}% cnn:${Math.round((aw.w_cnn||0)*100)}% of:${Math.round((aw.w_of||0)*100)}% news:${Math.round((aw.w_news||0)*100)}%`;

    // ML Primary & Hedge logic exact:
    let mlPrimary = "N/A", mlHedge = "N/A";
    if (ml && ml.direction) {
      if (String(ml.direction).toLowerCase().includes("bear")) {
        mlPrimary = (isNum(ml.tpEstimate) ? nf(ml.tpEstimate,2) : (shorts[0] ? nf(shorts[0].tp,2) : "N/A"));
        mlHedge = (longs[0] ? nf(longs[0].tp,2) : (isNum(ml.hedgeEstimate) ? nf(ml.hedgeEstimate,2) : "N/A"));
      } else if (String(ml.direction).toLowerCase().includes("bull")) {
        mlPrimary = (isNum(ml.tpEstimate) ? nf(ml.tpEstimate,2) : (longs[0] ? nf(longs[0].tp,2) : "N/A"));
        mlHedge = (shorts[0] ? nf(shorts[0].tp,2) : (isNum(ml.hedgeEstimate) ? nf(ml.hedgeEstimate,2) : "N/A"));
      } else {
        mlPrimary = (shorts[0] ? nf(shorts[0].tp,2) : "N/A");
        mlHedge = (longs[0] ? nf(longs[0].tp,2) : "N/A");
      }
    }

    const mlQuote = (ml && ml.explanation && typeof ml.explanation === "object")
      ? `slope:${ml.explanation.features?.slope ?? "N/A"} | mom3:${((ml.explanation.features?.mom3 ?? 0).toFixed(2))} | rsi:${ml.explanation.features?.rsi ?? "N/A"}`
      : (ml.explanation?.summary || ml.explanation?.reason || "AI forecast active");

    const news = report.news || {};
    const newsImpact = news.impact || "Low";
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

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

🎯 AI TP CLUSTER
Long Targets: ${longs.map(x => nf(x.tp,2)).join(" / ") || "N/A"}
Short Targets: ${shorts.map(x => nf(x.tp,2)).join(" / ") || "N/A"}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST (V12 Ultra)
Direction: ${mlDir}  
ML Confidence: ${mlConf}%  
ML Accuracy: ${nf(mlAcc,0)}%
Adaptive weights: ${awTxt}

📌 ML Summary:
“${mlQuote}”

📌 ML Targets:
• Primary TP: ${mlPrimary}
• Hedge TP: ${mlHedge}
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    const parts = splitIntoSafeParts([partMain], MAX_TG_CHARS);
    if (parts.length > 1) {
      return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    }
    return [partMain];
  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try { await sendTelegramFunc(text); } catch (e) {
        await new Promise(r => setTimeout(r, 600));
        try { await sendTelegramFunc(text); } catch {}
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 650));
    }
    return true;
  } catch (e) {
    return false;
  }
}

export default { buildAIReport, formatAIReport, sendSplitReport };