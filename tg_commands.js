// tg_commands.js — Telegram formatting module (integrated with ml_module_v13_ultra_dynamic_precision.js)
// Exports: buildAIReport, formatAIReport, sendSplitReport

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js"; // <--- use your latest ML v13 module
import News from "./news_social.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

//
// Destructure ALL relevant ML v13 exports (compatibility with your ML module)
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
  fuseMLTFs: mlFuseFn,
  buildStableTargets: buildStableTargetsFn,
  buildAIReport: mlBuildAIReport // optional helper if ML module provides one
} = ML || {};

// safe news accessor
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

// -----------------------------
// Helper: fuse multiple ML TF outputs (stable TP / hedge / direction)
// -----------------------------
function fuseMLTFs(mlList = []) {
  // prefer ML module's fuse if available
  try {
    if (typeof mlFuseFn === "function") return mlFuseFn(mlList);
  } catch {}
  // fallback local implementation
  const WEIGHTS = { "15m": 0.40, "30m": 0.35, "1h": 0.25 };
  const available = mlList.filter(m => m && m.tf);
  if (!available.length) return null;

  let bullScore = 0, bearScore = 0, neutralScore = 0;
  const tps = [];
  for (const m of available) {
    const w = WEIGHTS[m.tf] ?? 0.2;
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0));
    const dir = (m.direction || m.label || "Neutral");
    if (String(dir).toLowerCase().includes("bull")) bullScore += (maxProb/100) * w;
    else if (String(dir).toLowerCase().includes("bear")) bearScore += (maxProb/100) * w;
    else neutralScore += (maxProb/100) * w;

    tps.push({
      tf: m.tf,
      tp: Number(m.tpEstimate ?? m.tp ?? 0),
      hedge: Number(m.hedgeTP ?? m.hedge ?? 0),
      tpConfidence: Number(m.tpConfidence ?? m.tpConfidence ?? (m.tpConfidence ?? 0)),
      maxProb: maxProb
    });
  }

  const finalDir = (bullScore > bearScore && bullScore > neutralScore) ? "Bullish" :
                   (bearScore > bullScore && bearScore > neutralScore) ? "Bearish" : "Neutral";

  let wSum = 0, tpSum = 0, hedgeSum = 0, confSum = 0;
  for (const t of tps) {
    const w = WEIGHTS[t.tf] ?? 0.2;
    const mdir = (() => {
      const m = available.find(x => x.tf === t.tf);
      if (!m) return "Neutral";
      const d = m.direction || m.label || "Neutral";
      return String(d).toLowerCase().includes("bull") ? "Bullish" : String(d).toLowerCase().includes("bear") ? "Bearish" : "Neutral";
    })();
    let includeWeight = w;
    if (finalDir === "Bullish" && mdir === "Bearish" && t.maxProb > 60) includeWeight *= 0.15;
    if (finalDir === "Bearish" && mdir === "Bullish" && t.maxProb > 60) includeWeight *= 0.15;

    if (isNum(t.tp) && t.tp > 0) { tpSum += t.tp * includeWeight; wSum += includeWeight; }
    if (isNum(t.hedge) && t.hedge > 0) { hedgeSum += t.hedge * includeWeight; confSum += (t.tpConfidence || t.maxProb) * includeWeight; }
  }

  const primaryTP = (wSum > 0) ? (tpSum / wSum) : (tps[0] ? tps[0].tp : null);
  const hedgeTP = (confSum > 0) ? (hedgeSum / wSum) : (tps[0] ? tps[0].hedge : null);
  const avgConfidence = (wSum > 0) ? (confSum / wSum) : (available.reduce((a,b)=>a + (b.maxProb||0),0) / available.length || 0);
  return {
    direction: finalDir,
    primaryTP: isNum(primaryTP) ? Number(primaryTP) : null,
    hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null,
    confidence: Math.round(clamp(avgConfidence, 0, 100))
  };
}

// -----------------------------
// Build final single stable ML target from ML TFs + cluster targets + ell/ATR fallback
// Uses ML-provided helper if available
// -----------------------------
function buildStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  try {
    if (typeof buildStableTargetsFn === "function") {
      return buildStableTargetsFn(clusterTargets, mlFusion, price, feats);
    }
  } catch {}
  // fallback to local algorithm (from previous versions)
  const sorted = (Array.isArray(clusterTargets) ? clusterTargets.slice() : []).sort((a,b) => b.confidence - a.confidence);
  const dir = mlFusion?.direction || "Neutral";
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005);
  let primary = null, hedge = null;

  if (sorted.length) {
    const bulls = sorted.filter(s => s.tp > price);
    const bears = sorted.filter(s => s.tp < price);
    if (dir === "Bullish") primary = (bulls.length ? bulls[0] : sorted[0]);
    else if (dir === "Bearish") primary = (bears.length ? bears[0] : sorted[0]);
    else primary = sorted[0];

    if (dir === "Bullish") {
      hedge = (bears.length ? bears[0] : (mlFusion?.hedgeTP ? { tp: mlFusion.hedgeTP, source: "ML" } : { tp: price - atr * 1.2, source: "HEDGE_ATR" }));
    } else if (dir === "Bearish") {
      hedge = (bulls.length ? bulls[0] : (mlFusion?.hedgeTP ? { tp: mlFusion.hedgeTP, source: "ML" } : { tp: price + atr * 1.2, source: "HEDGE_ATR" }));
    } else {
      primary = primary || sorted[0];
      hedge = (sorted.length > 1 ? sorted[1] : { tp: (primary.tp > price ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR" });
    }
  } else {
    if (mlFusion && isNum(mlFusion.primaryTP) && mlFusion.primaryTP > 0) {
      primary = { tp: mlFusion.primaryTP, source: "ML", confidence: mlFusion.confidence };
      hedge = isNum(mlFusion.hedgeTP) && mlFusion.hedgeTP > 0 ? { tp: mlFusion.hedgeTP, source: "ML", confidence: mlFusion.confidence } : { tp: (dir === "Bullish" ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence: 30 };
    } else {
      primary = { tp: (dir === "Bullish" ? price + atr * 2.5 : dir === "Bearish" ? price - atr * 2.5 : price + atr * 2.5), source: "ATR", confidence: 30 };
      hedge = { tp: (dir === "Bullish" ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence: 30 };
    }
  }

  const primaryTP = Number(primary.tp);
  const hedgeTP = Number(hedge.tp);
  const primarySource = primary.source || "Cluster";
  const hedgeSource = hedge.source || "Cluster";
  const primaryConf = Math.round(primary.confidence ?? mlFusion?.confidence ?? 40);

  return { primaryTP, hedgeTP, primarySource, hedgeSource, primaryConf, direction: dir };
}
// -----------------------------
// Build AI Report — main function
// -----------------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    // If ML module itself provides a buildAIReport and user wants to use it, prefer it
    if (typeof mlBuildAIReport === "function" && (!opts.forceLocal)) {
      try {
        const r = await mlBuildAIReport(symbol, opts);
        if (r && r.ok) return r;
      } catch (e) { /* fallback to local builder below */ }
    }

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
        } catch { return { support: null, resistance: null, confidence: null }; }
      })();

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // compute per-block fusion score (lightweight)
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

    // overall fusion
    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 };
    let sTotal=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += (b.fusionScore || 0) * w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal / ws, -1, 1).toFixed(3)) : 0;

    // cluster all targets across TFs
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

    // RUN ML per stable TFs: 15m, 30m, 1h
    const mlTFs = ["15m","30m","1h"];
    const mlResults = [];
    for (const mt of mlTFs) {
      try {
        const mlr = await runMLPrediction(symbol, mt, { blocks, price, config: opts.mlConfig || {} });
        if (mlr) mlResults.push(mlr);
      } catch (e) {
        // ignore single TF failure
      }
    }

    // Micro confirmations
    let micro1m = null, micro5m = null;
    try { micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    // Fuse ML TFs into stable ML target
    const mlFusion = fuseMLTFs(mlResults);

    // Build final stable targets: clusterTargets + mlFusion + price
    const feat15 = blocks.find(b => b.tf === "15m") ? { atr: blocks.find(b => b.tf === "15m").indicators.ATR, candles: blocks.find(b => b.tf === "15m").candles } : {};
    const stableTargets = buildStableTargets(allTargets, mlFusion, price, feat15);

    // NEWS
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);

    // Apply small news + ML influence
    overallFusion = clamp(overallFusion + (mlFusion?.confidence ? (mlFusion.confidence/100) * 0.18 : 0) + newsBoost * 0.12, -1, 1);

    // PRO METERS (if ML module provides, prefer those)
    let reboundMeter = null, exhaustionMeter = null, volCrushMeter = null, pressureForecast = null;
    try {
      if (typeof computeReboundProbability === "function") reboundMeter = computeReboundProbability({ candles1m: blocks.find(b=>b.tf==="1m")?.candles, candles5m: blocks.find(b=>b.tf==="5m")?.candles, candles15m: blocks.find(b=>b.tf==="15m")?.candles, orderbook: opts.orderbook, tickerPrice: price, news });
    } catch(e){ reboundMeter = null; }
    try {
      if (typeof computeTrendExhaustion === "function") exhaustionMeter = computeTrendExhaustion({ candles15m: blocks.find(b=>b.tf==="15m")?.candles, candles30m: blocks.find(b=>b.tf==="30m")?.candles });
    } catch(e){ exhaustionMeter = null; }
    try {
      if (typeof computeVolatilityCrush === "function") volCrushMeter = computeVolatilityCrush({ candles30m: blocks.find(b=>b.tf==="30m")?.candles, candles15m: blocks.find(b=>b.tf==="15m")?.candles });
    } catch(e){ volCrushMeter = null; }
    try {
      if (typeof compute30minPressure === "function") pressureForecast = compute30minPressure({ candles1m: blocks.find(b=>b.tf==="1m")?.candles, candles5m: blocks.find(b=>b.tf==="5m")?.candles, candles30m: blocks.find(b=>b.tf==="30m")?.candles, orderflow: opts.orderflow, orderbook: opts.orderbook });
    } catch(e){ pressureForecast = null; }

    // Bias label
    const biasLabel = (() => {
      if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
      if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
      if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
      return { emoji:"🟥", label:"Strong Sell" };
    })();

    // ML Accuracy
    let mlAccObj = { accuracy: 0, total: 0, correct: 0 };
    try { mlAccObj = calculateAccuracy ? calculateAccuracy() || mlAccObj : mlAccObj; } catch (e) {}

    // default SLs using ATR 15m
    const atr15 = blocks.find(x => x.tf === "15m")?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      price,
      atr15,
      overallFusion,
      biasLabel,
      longs,
      shorts,
      allTargets,
      ml: { perTF: mlResults, fusion: mlFusion },
      micro: { "1m": micro1m, "5m": micro5m },
      stableTargets,
      mlAcc: mlAccObj,
      news,
      proMeters: { rebound: reboundMeter, exhaustion: exhaustionMeter, volCrush: volCrushMeter, pressure: pressureForecast },
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)),
      defaultSLLong,
      defaultSLShort
    };

    return report;
  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}
// -----------------------------
// Format AI Report into Telegram-ready pieces
// -----------------------------
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
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";
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

    const stable = report.stableTargets || {};
    const stablePrimary = isNum(stable.primaryTP) ? nf(stable.primaryTP, 2) : "N/A";
    const stableHedge = isNum(stable.hedgeTP) ? nf(stable.hedgeTP, 2) : "N/A";
    const stableConf = stable.primaryConf ?? (report.ml?.fusion?.confidence ?? 0);

    const ml = report.ml || {};
    const mlPerTF = ml.perTF || [];
    const mlFusion = ml.fusion || {};
    const mlDir = mlFusion.direction || "Neutral";
    const mlConf = mlFusion.confidence ?? (mlPerTF[0]?.maxProb ?? 0);
    const mlAccObj = report.mlAcc || 0;
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);
    const aw = ml.perTF && ml.perTF[0] && ml.perTF[0].adaptiveWeights ? ml.perTF[0].adaptiveWeights : (mlPerTF[0]?.adaptiveWeights || { w_ind:0.45, w_cnn:0.25, w_of:0.2, w_news:0.1 });
    const awTxt = `ind:${Math.round((aw.w_ind||0)*100)}% cnn:${Math.round((aw.w_cnn||0)*100)}% of:${Math.round((aw.w_of||0)*100)}% news:${Math.round((aw.w_news||0)*100)}%`;

    const news = report.news || {};
    const newsImpact = news.impact || "Low";
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    const mlQuote = (() => {
      const best = mlPerTF.find(x => x && x.explanation && x.explanation.features);
      if (best) {
        const f = best.explanation.features || {};
        return `slope:${nf(f.slope,4)} | mom3:${nf(f.mom3,4)} | rsi:${nf(f.rsi,2)}`;
      }
      return "AI forecast active";
    })();

    // PRO METERS presentation
    const pm = report.proMeters || {};
    const reboundTxt = pm.rebound ? `${pm.rebound.reboundProb ?? "N/A"}%` : "N/A";
    const exhaustTxt = pm.exhaustion ? `${pm.exhaustion.exhaustionPct ?? "N/A"}%` : "N/A";
    const volCrushTxt = pm.volCrush ? `${pm.volCrush.volCrush ?? 0}%` : "N/A";
    const pressureTxt = pm.pressure ? JSON.stringify(pm.pressure).slice(0,800) : "N/A";

    // final message body
    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Fusion)

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

🎯 STABLE AI TP (Fused 15m+30m+1h)
Primary TP: <b>${stablePrimary}</b> (src:${stable.primarySource || "Cluster/ML"})  
Hedge TP: <b>${stableHedge}</b> (src:${stable.hedgeSource || "Cluster/ML"})  
Confidence: ${stableConf}%
Suggested SL: ${report.stableTargets && report.stableTargets.direction === "Bullish" ? (report.defaultSLLong ? nf(report.defaultSLLong,2) : "N/A") : (report.defaultSLShort ? nf(report.defaultSLShort,2) : "N/A")}
━━━━━━━━━━━━━━━━━━

🧪 PRO METERS
Rebound probability: ${reboundTxt}  
Trend exhaustion: ${exhaustTxt}  
Volatility crush: ${volCrushTxt}  
30-min pressure: ${pressureTxt}
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
// -----------------------------
// Send split report via provided send function
// -----------------------------
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try { await sendTelegramFunc(text); } catch (e) {
        // retry once
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