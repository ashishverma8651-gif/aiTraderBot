// tg_commands_v12_fixed.js
// FINAL merged & fixed (v12-compatible)
// - Keeps old-style default ML import (ml_module_v8_6.js style)
// - Robust Elliott integration (analyzeElliott default export accepted)
// - ATR selection/fallback, ML confidence calibration, TP floor, Hedge engine
// - Exports: buildAIReport, formatAIReport, sendSplitReport
// - Split into parts for delivery; join to use as single file.

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";     // default export object expected
import News from "./news_social.js";      // default export object expected

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import ElliottModule from "./elliott_module.js"; // both named/default safe

// Defensive extraction
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} = ML || {};

const fetchNewsBundle = (News && (News.fetchNewsBundle || News.default && News.default.fetchNewsBundle)) ?
    (News.fetchNewsBundle || News.default.fetchNewsBundle) :
    async (sym) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No major events" });

const analyzeElliott = (ElliottModule && (ElliottModule.analyzeElliott || ElliottModule.default && ElliottModule.default.analyzeElliott)) ?
    (ElliottModule.analyzeElliott || ElliottModule.default.analyzeElliott) :
    async (c)=>({ ok:false, sentiment:0, confidence:0, pivots:[], targets:[] });

// -------------------- Constants & small helpers --------------------
const MAX_TG_CHARS = 3800;
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -Infinity, b = Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s, n = 120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : (s || "");

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) return new Date().toLocaleString("en-IN", IS_INDIA);
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch (e) {
    return new Date().toString();
  }
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
// -------------------- Core: buildAIReport --------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE",
      };

      const vol = (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "N/A", strength: 0 };

      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p=>p.type==="L") || null;
          const lastHigh = [...pivots].reverse().find(p=>p.type==="H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null, patterns: ell?.patterns ?? [] };
        } catch { return { support: null, resistance: null, confidence: null, patterns: [] }; }
      })();

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({
          tp: Number(t.tp ?? t.target ?? t.price ?? 0),
          confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)),
          source: t.source || t.type || tf,
          ageDays: Number(t.ageDays ?? 0)
        })).filter(t => isNum(t.tp) && t.tp>0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, Math.max(price * 0.002, 1));
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      let fib = null;
      try { if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles); } catch(e){ fib = null; }

      blocks.push({ tf, price, candles, indicators: ind, vol, ell, ellSummary, targets, fib });
    }

    // fusion per block
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

    for (const b of blocks) {
      try { b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 }); } catch (e) { b.fusionScore = 0; }
    }

    // overall fusion weighted
    const TF_WEIGHTS = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
    let s=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore||0)*w; ws += w; }
    let overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // collect unique targets across TFs, prefer recent + high conf
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets||[])) {
        const tp = Number(t.tp||0); if (!isNum(tp) || tp<=0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        const existing = tgtMap.get(key);
        if (!existing) tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf, ageDays: t.ageDays || 0 });
        else {
          if ((conf > existing.confidence) || ((t.ageDays||0) < (existing.ageDays||999) && conf >= existing.confidence)) {
            tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf, ageDays: t.ageDays || 0 });
          }
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=>b.confidence - a.confidence || Math.abs(a.tp - (blocks.find(x=>x.tf==="15m")?.price || 0)) - Math.abs(b.tp - (blocks.find(x=>x.tf==="15m")?.price || 0)));

    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0,4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0,4);
// -------------------- ML predictions (prefer 15m) --------------------
    let mlMain = null;
    try { mlMain = (typeof runMLPrediction === "function") ? await runMLPrediction(symbol, opts.mlTF || "15m") : null; } catch (e) { mlMain = null; }
    let micro = null;
    try { micro = (typeof runMicroPrediction === "function") ? await runMicroPrediction(symbol, "1m") : null; } catch (e) { micro = null; }

    // FETCH NEWS
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No major events" }; }

    // ATR selection: prefer 15m -> 5m -> 1m -> ell.atr -> price*0.002
    const atrFromTF = (() => {
      const p15 = blocks.find(x=>x.tf==="15m")?.indicators?.ATR;
      const p5 = blocks.find(x=>x.tf==="5m")?.indicators?.ATR;
      const p1 = blocks.find(x=>x.tf==="1m")?.indicators?.ATR;
      const ellAtr = blocks.find(x=>x.ell)?.ell?.atr ?? null;
      return Math.max( (p15||0), (p5||0), (p1||0), (ellAtr||0), price * 0.0008 );
    })();

    // nudge overallFusion using ML & News (small)
    let mlBoost = 0, newsBoost = 0;
    if (mlMain && mlMain.probs) {
      const bprob = Number(mlMain.probs.bull ?? mlMain.probs?.Bull ?? 0);
      const rprob = Number(mlMain.probs.bear ?? mlMain.probs?.Bear ?? 0);
      if (isNum(bprob) && isNum(rprob)) mlBoost = clamp((bprob - rprob)/100, -1, 1);
    }
    if (news && typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
      const impact = (news.impact || "low").toLowerCase();
      const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
      newsBoost = clamp(raw * mul, -1, 1);
    }
    overallFusion = clamp(overallFusion + (mlBoost * 0.22) + (newsBoost * 0.18), -1, 1);

    // -------------------- Default SL suggestions --------------------
    const atr15 = atrFromTF;
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(2)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(2)) : null;

    // mlAcc
    let mlAcc = 0;
    try { mlAcc = (typeof calculateAccuracy === "function") ? (calculateAccuracy()?.accuracy ?? 0) : 0; } catch(e) { mlAcc = 0; }

    // -------------------- Post-process ML (sanitize & calibrate) --------------------
    if (mlMain) {
      try {
        // normalize shape
        mlMain.direction = mlMain.direction || mlMain.label || (mlMain.probs && (mlMain.probs.bull > mlMain.probs.bear ? "Bullish" : (mlMain.probs.bear > mlMain.probs.bull ? "Bearish" : "Neutral"))) || "Neutral";
        mlMain.maxProb = mlMain.maxProb ?? (mlMain.probs ? Math.max(Number(mlMain.probs.bull||0), Number(mlMain.probs.bear||0), Number(mlMain.probs.neutral||0)) : null);
        // compute cleaned stats
        const mlDir = String(mlMain.direction || "Neutral").toLowerCase();
        let mlConf = isNum(mlMain.maxProb) ? Number(mlMain.maxProb) : (isNum(mlMain.tpConfidence) ? Number(mlMain.tpConfidence) : 50);

        // Calibrate ML confidence: penalize when ML contradicts fusion/elliott or when ATR tiny
        const fusionBias = overallFusion > 0.1 ? "bull" : overallFusion < -0.1 ? "bear" : "neutral";
        const ellSent = (blocks.find(x=>x.ell)?.ell?.sentiment ?? (blocks.find(x=>x.ellSummary)?.ellSummary?.sentiment)) || 0;
        const ellConf = (blocks.find(x=>x.ell)?.ell?.confidence ?? blocks.find(x=>x.ellSummary)?.ellSummary?.confidence) || 0;

        if ((fusionBias === "bull" && mlDir.includes("bear")) || (fusionBias === "bear" && mlDir.includes("bull"))) mlConf *= 0.55;
        if (Math.abs(ellSent) < 0.12 && ellConf < 40) mlConf *= 0.75;
        if (atr15 < price * 0.0015) mlConf *= 0.65;
        // news heavy negative/positive may reduce model confidence for short-term TPs
        const newsImpactVal = (news && news.impact) ? String(news.impact).toLowerCase() : "low";
        if (newsImpactVal === "high") mlConf *= 0.8;

        mlConf = clamp(Math.round(mlConf), 5, 99);

        // sanitize tpEstimate
        let primaryTP = isNum(mlMain.tpEstimate) ? Number(mlMain.tpEstimate) : (isNum(mlMain.tp) ? Number(mlMain.tp) : null);
        // ensure TP distance from price
        const minTPdist = Math.max(price * 0.002, atr15 * 0.6, 1);
        if (isNum(primaryTP)) {
          if (Math.abs(primaryTP - price) < minTPdist) {
            // push it out in the mlMain direction
            if (mlDir.includes("bull")) primaryTP = Number((price + minTPdist).toFixed(2));
            else if (mlDir.includes("bear")) primaryTP = Number((price - minTPdist).toFixed(2));
            else primaryTP = null;
          }
        }

        // if no primaryTP, pick nearest from allTargets consistent with direction
        function pickNearest(side) {
          const pool = side === "bull" ? longs : side === "bear" ? shorts : allTargets;
          if (!Array.isArray(pool) || pool.length === 0) return null;
          pool.sort((a,b)=> b.confidence - a.confidence || Math.abs(a.tp-price) - Math.abs(b.tp-price));
          return pool[0]?.tp ?? null;
        }
        if (!isNum(primaryTP)) {
          if (mlDir.includes("bull")) primaryTP = pickNearest("bull");
          else if (mlDir.includes("bear")) primaryTP = pickNearest("bear");
          else primaryTP = pickNearest("bull") ?? pickNearest("bear");
        }

        // hedgeTP determination: opposite side candidate or ATR offset
        let hedgeTP = null;
        if (mlDir.includes("bull")) hedgeTP = pickNearest("bear");
        else if (mlDir.includes("bear")) hedgeTP = pickNearest("bull");
        else {
          const longPick = pickNearest("bull"), shortPick = pickNearest("bear");
          // choose opposite of primary
          hedgeTP = (isNum(primaryTP) && longPick && Math.abs(primaryTP - longPick) > Math.abs(primaryTP - shortPick)) ? shortPick : (shortPick ?? longPick ?? null);
        }

        // if hedgeTP equals primaryTP or both null, make a sensible ATR-based hedge
        if (isNum(primaryTP) && isNum(hedgeTP) && Math.abs(primaryTP - hedgeTP) < (price * 1e-5)) {
          const offset = Math.max(1, atr15 || price * 0.002);
          if (mlDir.includes("bull")) hedgeTP = Number((price - offset * 1.5).toFixed(2));
          else if (mlDir.includes("bear")) hedgeTP = Number((price + offset * 1.5).toFixed(2));
          else hedgeTP = null;
        }
        if (!isNum(hedgeTP) && isNum(primaryTP)) {
          // fallback small offset opposite
          const offset = Math.max(1, atr15 || price * 0.002);
          hedgeTP = mlDir.includes("bull") ? Number((price - offset * 1.5).toFixed(2)) : mlDir.includes("bear") ? Number((price + offset * 1.5).toFixed(2)) : null;
        }

        // hedge confidence
        let hedgeConf = Math.round(clamp(100 - mlConf, 10, 90));

        mlMain.sanitized = {
          direction: mlMain.direction,
          primaryTP: isNum(primaryTP) ? Number(primaryTP) : null,
          primaryConf: mlConf,
          hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null,
          hedgeConf
        };

      } catch (e) { /* ignore sanitize errors */ }
    }

    // -------------------- Compose final report object --------------------
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
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

    // persist prediction (best-effort)
    try { if (typeof recordPrediction === "function") recordPrediction({ id:`${symbol}_${Date.now()}`, symbol, ml: report.ml }); } catch(e){}

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
      const volTxt = b.vol?.status || (b.indicators?.volumeTrend || "N/A");
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";

      const ellConf = b.ellSummary?.confidence ?? 0;
      const ellShow = (ellConf >= 12 && Array.isArray(b.ellSummary?.patterns) && b.ellSummary.patterns.length) ? b.ellSummary.patterns[0].type : (b.ell?.pattern || "No clear wave");
      const S = b.ellSummary?.support ?? (b.fib?.lo ?? null) ?? "N/A";
      const R = b.ellSummary?.resistance ?? (b.fib?.hi ?? null) ?? "N/A";

      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";

      const sl = (b.targets && b.targets[0] && b.targets[0].suggestedSL) ? nf(b.targets[0].suggestedSL,2) : (b.sl ?? "N/A");
      const finalSL = (sl === "N/A") ? (tf === "15m" ? nf(report.defaultSLLong,2) : "N/A") : sl;

      return {
        sig: sigText, rsi, macd, vol: volTxt, atr: nf(atr,2), ell: ellShow, ellConf: Math.round(ellConf || 0),
        s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")),
        tpLine, sl: finalSL, price: nf(b.price,2)
      };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb,2);
    const sellProb = nf(report.sellProb,2);

    const longs = report.longs || [];
    const shorts = report.shorts || [];
    const bullTP1 = longs.length ? nf(Math.min(...longs.map(x=>x.tp)),2) : (b1h.r || "N/A");
    const bullTP2 = longs.length ? nf(Math.max(...longs.map(x=>x.tp)),2) : (b30m.r || "N/A");
    const bearTP1 = shorts.length ? nf(Math.min(...shorts.map(x=>x.tp)),2) : (b1m.s || "N/A");
    const bearTP2 = shorts.length ? nf(Math.max(...shorts.map(x=>x.tp)),2) : (b5m.s || "N/A");

    // neutral invalidation (prefer 15m-based candidate)
    let neutralSL = "N/A";
    if (isNum(report.atr15) && isNum(report.price)) {
      neutralSL = nf(Number((report.price - report.atr15).toFixed(2)),2);
    } else neutralSL = nf(report.defaultSLLong,2);

    // ML sanitized
    const ml = report.ml || {};
    const mlDir = (ml.sanitized && ml.sanitized.direction) ? ml.sanitized.direction : (ml.direction || ml.label || "Neutral");
    const mlConf = (() => {
      if (ml.sanitized && isNum(ml.sanitized.primaryConf)) return nf(ml.sanitized.primaryConf,0);
      if (ml.tpConfidence != null) return nf(ml.tpConfidence,0);
      if (ml.maxProb != null) return nf(ml.maxProb,0);
      return nf((ml.probs && (ml.probs.bull || ml.probs.bear || ml.probs.neutral)) ? Math.max(Number(ml.probs.bull||0), Number(ml.probs.bear||0), Number(ml.probs.neutral||0)) : (ml.maxProb || 0), 0);
    })();

    const mlSellTP = (() => {
      if (ml.sanitized && isNum(ml.sanitized.primaryTP) && String(ml.sanitized.direction || "").toLowerCase().includes("bear")) return nf(ml.sanitized.primaryTP,2);
      if (shorts && shorts.length) return nf(shorts[0].tp,2);
      return "N/A";
    })();
    const mlBuyTP = (() => {
      if (ml.sanitized && isNum(ml.sanitized.primaryTP) && String(ml.sanitized.direction || "").toLowerCase().includes("bull")) return nf(ml.sanitized.primaryTP,2);
      if (longs && longs.length) return nf(longs[0].tp,2);
      return "N/A";
    })();

    const mlHedge = (ml.sanitized && isNum(ml.sanitized.hedgeTP)) ? nf(ml.sanitized.hedgeTP,2) : null;
    const mlQuote = ellipsis( (ml.explanation || ml.reason || ml.summary || ml.quote || "AI forecast active"), 280 );

    const news = report.news || {};
    const newsImpact = news.impact || (news.impact === 0 ? "Low" : "Low");
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
`.trim();
// continue UI build (append remaining blocks + summary)
    const partBottom = `
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
${mlHedge ? `\n• ML Hedge TP: ${mlHedge}` : "" }
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    const full = partMain + "\n\n" + partBottom;
    const parts = splitIntoSafeParts([full], MAX_TG_CHARS);
    if (parts.length > 1) {
      return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    }
    return [full];
  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// -------------------- sendSplitReport helper --------------------
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
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

// default export
export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};