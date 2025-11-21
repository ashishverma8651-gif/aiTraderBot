// tg_commands.js — FINAL (ML v13 Integrated, Old UI intact, Node18-safe)

// ------------------- Imports -------------------
import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";      // <<<<<< ML v13 Ultra Precision (default export expected)
import News from "./news_social.js";

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ------------------- Safe ML/News export unpack -------------------
// If ML or News don't export everything, provide safe fallbacks.
const MLsafe = ML || {};
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
  buildStableTargets
} = MLsafe;

const NewsSafe = News || {};
// News may export fetchNewsBundle directly or as default.fetchNewsBundle
const fetchNewsBundle =
  NewsSafe.fetchNewsBundle ||
  (NewsSafe.default && NewsSafe.default.fetchNewsBundle) ||
  (async (s) => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" }));

// ------------------- Helpers -------------------
const MAX_TG_CHARS = 3800;
const IST = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) =>
  typeof v === "number" && Number.isFinite(v) ? Number(v).toFixed(d) : "N/A";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IST);
  } catch {
    return new Date().toString();
  }
}

function splitParts(blocks, lim = MAX_TG_CHARS) {
  const out = [];
  let buf = "";
  for (const b of blocks) {
    if (!b) continue;
    if ((buf + "\n\n" + b).length < lim) buf += (buf ? "\n\n" : "") + b;
    else {
      if (buf) out.push(buf);
      // if single block longer than lim, hard-chop
      if (b.length > lim) {
        for (let i = 0; i < b.length; i += lim - 200) {
          out.push(b.slice(i, i + lim - 200));
        }
        buf = "";
      } else {
        buf = b;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Local safe fuse if ML.fuseMLTFs not available or accepts different input
function safeFuseMLTFs(mlList) {
  try {
    // If ML provided a function, try to use it defensively
    if (typeof fuseMLTFs === "function") {
      // allow both array and object inputs; normalize to array
      if (!Array.isArray(mlList) && typeof mlList === "object") {
        // object mapping tf->result
        const arr = Object.keys(mlList).map((k) => {
          const v = mlList[k] || {};
          return { tf: k, ...v };
        });
        return fuseMLTFs(arr);
      }
      return fuseMLTFs(mlList);
    }
  } catch (e) {
    // fallthrough to internal
  }

  // Internal fallback simple fuse
  if (!mlList) return { direction: "Neutral", primaryTP: null, hedgeTP: null, confidence: 0, score: 0 };
  const arr = Array.isArray(mlList) ? mlList : Object.keys(mlList).map((k) => ({ tf: k, ...(mlList[k] || {}) }));
  let bull = 0, bear = 0, neutral = 0;
  let tpSum = 0, tpW = 0, hedgeSum = 0, hedgeW = 0, confSum = 0;
  const weightOfTF = { "15m": 0.4, "30m": 0.35, "1h": 0.25 };
  for (const m of arr) {
    const w = weightOfTF[m.tf] ?? 0.2;
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0));
    const dir = (m.direction || m.label || "").toLowerCase();
    if (dir.includes("bull")) bull += (maxProb / 100) * w;
    else if (dir.includes("bear")) bear += (maxProb / 100) * w;
    else neutral += (maxProb / 100) * w;

    if (isNum(m.tpEstimate) && m.tpEstimate > 0) {
      tpSum += m.tpEstimate * w;
      tpW += w;
    } else if (isNum(m.tp) && m.tp > 0) {
      tpSum += m.tp * w;
      tpW += w;
    }
    if (isNum(m.hedgeTP) && m.hedgeTP > 0) {
      hedgeSum += m.hedgeTP * w;
      hedgeW += w;
    } else if (isNum(m.hedge) && m.hedge > 0) {
      hedgeSum += m.hedge * w;
      hedgeW += w;
    }
    confSum += (m.tpConfidence ?? maxProb ?? 0) * w;
  }
  const direction = bull > bear && bull > neutral ? "Bullish" : bear > bull && bear > neutral ? "Bearish" : "Neutral";
  const primaryTP = tpW ? tpSum / tpW : null;
  const hedgeTP = hedgeW ? hedgeSum / hedgeW : null;
  const confidence = tpW ? Math.round(clamp(confSum / tpW, 0, 100)) : 0;
  const score = confidence;
  return { direction, primaryTP, hedgeTP, confidence, score };
}

// Local buildStableTargets fallback (if ML.buildStableTargets absent)
function safeBuildStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  try {
    if (typeof buildStableTargets === "function") return buildStableTargets(clusterTargets, mlFusion, price, feats);
  } catch (e) {}
  // fallback simple logic: pick nearest target on mlFusion direction side, else ATR fallback
  const candidates = Array.isArray(clusterTargets) ? clusterTargets.slice() : [];
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.0005 || 1);
  let primary = null, hedge = null;
  if (candidates.length) {
    const bulls = candidates.filter((c) => c.tp > price).sort((a,b)=>b.confidence-a.confidence);
    const bears = candidates.filter((c) => c.tp < price).sort((a,b)=>b.confidence-a.confidence);
    if ((mlFusion || {}).direction === "Bullish") primary = bulls[0] ?? candidates[0];
    else if ((mlFusion || {}).direction === "Bearish") primary = bears[0] ?? candidates[0];
    else primary = candidates[0];
    hedge = (primary && primary.tp > price) ? (bears[0] ?? { tp: price - atr*1.2, source: "HEDGE_ATR", confidence: 30 }) : (bulls[0] ?? { tp: price + atr*1.2, source: "HEDGE_ATR", confidence: 30 });
  } else {
    if (mlFusion && isNum(mlFusion.primaryTP) && mlFusion.primaryTP > 0) {
      primary = { tp: mlFusion.primaryTP, source: "ML", confidence: mlFusion.confidence ?? 40 };
      hedge = { tp: mlFusion.hedgeTP ?? (price + (mlFusion.direction==="Bullish"? -atr*1.2: atr*1.2)), source: "ML", confidence: mlFusion.confidence ?? 30 };
    } else {
      primary = { tp: price + atr * 2.5, source: "ATR", confidence: 30 };
      hedge = { tp: price - atr * 1.2, source: "HEDGE_ATR", confidence: 30 };
    }
  }
  return {
    primaryTP: Number(primary.tp),
    hedgeTP: Number(hedge.tp),
    primarySource: primary.source || "Cluster",
    hedgeSource: hedge.source || "Cluster",
    primaryConf: Math.round(primary.confidence ?? (mlFusion?.confidence ?? 40)),
    direction: mlFusion?.direction ?? "Neutral"
  };
}

// ------------------- MAIN: Build AI Report -------------------
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
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? 0 };
        } catch { return { support: null, resistance: null, confidence: 0 }; }
      })();

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // compute per-block fusion scores
    const computeFusionScore = (indObj={}, ellObj={}) => {
      let s=0,w=0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh / atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0); w += 0.15;
      s += (indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0); w += 0.08;
      const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      s += (ellObj?.sentiment || 0) * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w === 0) return 0;
      return Number(clamp(s / w, -1, 1).toFixed(3));
    };
    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    // overall fusion
    const TF_WEIGHTS = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
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

    // Run ML for 15m/30m/1h with safe handling
    const mlTFs = ["15m","30m","1h"];
    const mlResults = [];
    for (const mt of mlTFs) {
      try {
        if (typeof runMLPrediction === "function") {
          const res = await runMLPrediction(symbol, mt);
          if (res) mlResults.push({ tf: mt, ...res });
        }
      } catch (e) {
        // ignore per-tf failure
      }
    }

    // micro confirmations (1m and 5m) - optional
    let micro1m = null, micro5m = null;
    try { if (typeof runMicroPrediction === "function") micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { if (typeof runMicroPrediction === "function") micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    // fuse ML TFs safely
    const mlFusion = safeFuseMLTFs(mlResults.length ? mlResults : null);

    // Build stable targets (use ML build if available else fallback)
    const feat15 = blocks.find(b => b.tf === "15m") ? { atr: blocks.find(b => b.tf === "15m").indicators.ATR, candles: blocks.find(b => b.tf === "15m").candles } : {};
    const stableTargets = (typeof buildStableTargets === "function")
      ? (() => { try { return buildStableTargets(allTargets, mlFusion, price, feat15); } catch(e){ return safeBuildStableTargets(allTargets, mlFusion, price, feat15); } })()
      : safeBuildStableTargets(allTargets, mlFusion, price, feat15);

    // News
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);

    // Apply small news + ML influence to overallFusion (safely)
    overallFusion = clamp(overallFusion + (mlFusion?.confidence ? (mlFusion.confidence/100) * 0.18 : 0) + newsBoost * 0.12, -1, 1);

    // ML accuracy
    let mlAccObj = { accuracy: 0, total: 0, correct: 0 };
    try { if (typeof calculateAccuracy === "function") mlAccObj = calculateAccuracy() || mlAccObj; } catch (e) {}

    // Default SLs using ATR 15m
    const atr15 = blocks.find(x => x.tf === "15m")?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    // Pro meters if provided
    let proMeters = { reboundProb: null, trendExhaustion: null, volCrush: null, pressure30min: null };
    try {
      if (typeof computeReboundProbability === "function") proMeters.reboundProb = computeReboundProbability({ candles1m: blocks.find(x=>x.tf==="1m")?.candles, candles5m: blocks.find(x=>x.tf==="5m")?.candles, candles15m: blocks.find(x=>x.tf==="15m")?.candles, orderbook: opts.orderbook, tickerPrice: price, news });
      if (typeof computeTrendExhaustion === "function") proMeters.trendExhaustion = computeTrendExhaustion({ candles15m: blocks.find(x=>x.tf==="15m")?.candles, candles30m: blocks.find(x=>x.tf==="30m")?.candles });
      if (typeof computeVolatilityCrush === "function") proMeters.volCrush = computeVolatilityCrush({ candles30m: blocks.find(x=>x.tf==="30m")?.candles, candles15m: blocks.find(x=>x.tf==="15m")?.candles });
      if (typeof compute30minPressure === "function") proMeters.pressure30min = compute30minPressure({ candles1m: blocks.find(x=>x.tf==="1m")?.candles, candles5m: blocks.find(x=>x.tf==="5m")?.candles, candles30m: blocks.find(x=>x.tf==="30m")?.candles, orderbook: opts.orderbook });
    } catch (e) { /* ignore meters errors */ }

    // Compose final report
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      price,
      atr15,
      overallFusion,
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)),
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs, shorts, allTargets,
      ml: { perTF: mlResults, fusion: mlFusion, main: mlResults.find(m=>m.tf==="15m") ?? null },
      micro: { "1m": micro1m, "5m": micro5m },
      stableTargets,
      mlAcc: mlAccObj,
      proMeters,
      news,
      defaultSLLong,
      defaultSLShort
    };

    return report;
  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// ------------------- FORMATTER (Old UI intact) -------------------
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return [`<b>⚠️ Error building report</b>\n${report?.error || "no data"}`];

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
    const buyProb = Number.isFinite(report.buyProb) ? nf(report.buyProb, 2) : "N/A";
    const sellProb = Number.isFinite(report.sellProb) ? nf(report.sellProb, 2) : "N/A";

    const stable = report.stableTargets || {};
    const stablePrimary = isNum(stable.primaryTP) ? nf(stable.primaryTP, 2) : "N/A";
    const stableHedge = isNum(stable.hedgeTP) ? nf(stable.hedgeTP, 2) : "N/A";
    const stableConf = stable.primaryConf ?? (report.ml?.fusion?.confidence ?? 0);

    const mlFusion = report.ml?.fusion || {};
    const mlDir = mlFusion.direction || report.ml?.main?.direction || "Neutral";
    const mlConf = mlFusion.confidence ?? report.ml?.main?.maxProb ?? 0;

    const mlAccObj = report.mlAcc || { accuracy:0 };
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);

    const news = report.news || {};
    const newsImpact = news.impact || "Low";
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 100) : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

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
Fusion Score: ${nf(report.overallFusion,3)}  
Buy ${buyProb}% | Sell ${sellProb}%
━━━━━━━━━━━━━━━━━━

🎯 STABLE AI TP (Fused 15m+30m+1h)
Primary TP: <b>${stablePrimary}</b> (src:${stable.primarySource || "Cluster/ML"})  
Hedge TP: <b>${stableHedge}</b> (src:${stable.hedgeSource || "Cluster/ML"})  
Confidence: ${stableConf}%
Suggested SL: ${report.defaultSLLong ? nf(report.defaultSLLong,2) : "N/A"}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlDir}  
ML fused confidence: ${nf(mlConf,0)}%  
ML accuracy (history): ${nf(mlAcc,0)}%

ML quick summary:
“AI forecast active”

ML per-TF snapshot:
${(report.ml && report.ml.perTF && report.ml.perTF.length ? report.ml.perTF.map(m => `${m.tf}: ${m.direction||m.label||"N"} | TP:${isNum(m.tpEstimate)?nf(m.tpEstimate,2):(isNum(m.tp)?nf(m.tp,2):"N/A")} | maxProb:${nf(m.maxProb ?? (m.probs?.max || 0),0)}`).join("\n") : "No ML outputs")}
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${headline ? headline.replace(/\n/g," ") : "No major events"}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    const parts = splitParts([partMain]);
    // add header part numbering if multiple
    if (parts.length > 1) return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    return parts;

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// ------------------- Sender -------------------
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try { await sendTelegramFunc(text); } catch (err) {
        // retry once
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

export default { buildAIReport, formatAIReport, sendSplitReport };