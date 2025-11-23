// tg_commands.js — V13 Ultra Stable (Enhanced, BTC-focused)
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
  : async (s) => ({ ok:false, sentiment:0.5, impact:"Low", items:[], headline:"No news" });

// Minimal helpers
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };
const MAX_TG_CHARS = 3800;
const safeNum = v => (Number.isFinite(+v) ? +v : 0);
const last = (a)=> Array.isArray(a) && a.length ? a[a.length-1] : null;
const nf = (v,d=2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v,a=-Infinity,b=Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s,n=120) => (typeof s==="string" && s.length>n) ? s.slice(0,n-1)+"…" : (s||"");
function nowIST(iso) { try { const d = iso ? new Date(iso) : new Date(); return d.toLocaleString("en-IN", IS_INDIA); } catch (e) { return new Date().toString(); } }

// split util (unchanged)
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
// New helper: compute trend strength, momentum, volatility rank
// -----------------------------
function computeExtraMetrics(candles = []) {
  const n = candles.length;
  if (!n) return { trendStrength:50, momentumScore:50, volatilityRank:50 };
  const closes = candles.map(c => safeNum(c.close||0));
  const highs = candles.map(c => safeNum(c.high||0));
  const lows = candles.map(c => safeNum(c.low||0));
  const vols = candles.map(c => safeNum(c.vol||c.volume||0));

  // simple slope over last half window
  const window = Math.max(3, Math.min(20, Math.floor(n/3)));
  const slice = closes.slice(-window);
  const len = slice.length;
  let slope = 0;
  if (len >= 2) {
    // linear slope (normalized)
    const xs = Array.from({length:len}, (_,i)=>i);
    const meanX = xs.reduce((a,b)=>a+b,0)/len;
    const meanY = slice.reduce((a,b)=>a+b,0)/len;
    const num = xs.reduce((acc,xi,i)=>acc + (xi-meanX)*(slice[i]-meanY),0);
    const den = xs.reduce((acc,xi)=>acc + (xi-meanX)*(xi-meanX),0) || 1;
    slope = num/den;
  }
  // momentum: percent change over last 3
  const momN = 3;
  const mom = len >= momN ? (slice[len-1] - slice[len-momN])/ (slice[len-momN] || 1) : 0;
  // volatility: std dev / mean
  const mean = closes.reduce((a,b)=>a+b,0)/closes.length || 1;
  const variance = closes.reduce((a,b)=>a + Math.pow((b-mean),2),0)/closes.length;
  const std = Math.sqrt(variance);
  const volRatio = std / Math.max(1, mean);

  const trendStrength = clamp(50 + (slope * 1000), 5, 95); // scaled
  const momentumScore = clamp(50 + (mom * 1000), 0, 100);
  const volatilityRank = clamp(50 + volRatio * 1000, 5, 95);

  return { trendStrength: Math.round(trendStrength), momentumScore: Math.round(momentumScore), volatilityRank: Math.round(volatilityRank), slope, std };
}

// -----------------------------
// TP filtering + TQF (Target Quality Factor)
// -----------------------------
function scoreTarget(tp, price, conf, sourceReliability=50, atr=1) {
  // conf 0-100, sourceReliability 0-100
  // proximity factor: closer reasonable targets score higher (for intraday)
  const dist = Math.abs(tp - price);
  const proxFactor = Math.exp(-dist / Math.max(atr*2, Math.abs(price)*0.003 || 1));
  const raw = (conf/100) * 0.6 + (sourceReliability/100) * 0.3 + proxFactor * 0.1;
  return Math.round(clamp(raw * 100, 5, 99));
}
function filterTPsByATR(tps, price, atr, maxMult = 3) {
  return (tps || []).filter(t => {
    if (!isNum(t.tp)) return false;
    const d = Math.abs(t.tp - price);
    return d <= Math.max(atr * maxMult, Math.abs(price) * 0.05); // also cap at 5% of price
  });
}

// -----------------------------
// ML fusion improvements
// -----------------------------
function fuseMLTFsImproved(mlList = []) {
  const WEIGHTS = { "15m": 0.40, "30m": 0.35, "1h": 0.25 };
  const available = mlList.filter(m => m && m.tf);
  if (!available.length) return null;

  let bullScore = 0, bearScore = 0, neutScore = 0;
  const tps = [];
  for (const m of available) {
    const w = WEIGHTS[m.tf] ?? 0.2;
    const maxProb = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0, m.probs.bear||0, m.probs.neutral||0) : 0)) || 0;
    const dir = (m.direction || m.label || "Neutral");
    if (String(dir).toLowerCase().includes("bull")) bullScore += (maxProb/100) * w;
    else if (String(dir).toLowerCase().includes("bear")) bearScore += (maxProb/100) * w;
    else neutScore += (maxProb/100) * w;

    tps.push({
      tf: m.tf,
      tp: safeNum(m.tpEstimate || m.tp || 0),
      hedge: safeNum(m.hedgeTP || m.hedge || 0),
      maxProb: clamp(maxProb, 0, 100),
      direction: dir
    });
  }

  const finalDir = (bullScore > bearScore && bullScore > neutScore) ? "Bullish" :
                   (bearScore > bullScore && bearScore > neutScore) ? "Bearish" : "Neutral";

  // weight contributions but downweight contrarian TFs with high confidence
  let tpSum = 0, tpW = 0, hedgeSum = 0, hedgeW = 0, confSum = 0, confW = 0;
  for (const t of tps) {
    const w = WEIGHTS[t.tf] ?? 0.2;
    let includeW = w;
    const mdir = String(t.direction).toLowerCase().includes("bull") ? "Bullish" : String(t.direction).toLowerCase().includes("bear") ? "Bearish" : "Neutral";
    if ((finalDir === "Bullish" && mdir === "Bearish" && t.maxProb > 60) || (finalDir === "Bearish" && mdir === "Bullish" && t.maxProb > 60)) {
      includeW *= 0.15;
    }
    if (isNum(t.tp) && t.tp > 0) { tpSum += t.tp * includeW; tpW += includeW; }
    if (isNum(t.hedge) && t.hedge > 0) { hedgeSum += t.hedge * includeW; hedgeW += includeW; }
    confSum += t.maxProb * includeW; confW += includeW;
  }

  const primaryTP = tpW > 0 ? tpSum / tpW : (tps[0] ? tps[0].tp : null);
  const hedgeTP = hedgeW > 0 ? hedgeSum / hedgeW : (tps[0] ? tps[0].hedge : null);
  const avgConf = confW > 0 ? confSum / confW : (available.reduce((a,b)=>a+(b.maxProb||0),0)/available.length || 0);

  // cap confidence influence
  const capConf = Math.round(clamp(avgConf, 10, 95));
  return { direction: finalDir, primaryTP: isNum(primaryTP) ? Number(primaryTP) : null, hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null, confidence: capConf };
}

// -----------------------------
// Build stable targets combining clusters + ML fusion + ATR fallback
// -----------------------------
function buildStableTargetsImproved(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  const atr = Math.max(feats?.atr || 0, Math.abs(price) * 0.002 || 1);
  const direction = mlFusion?.direction || "Neutral";
  // Filter cluster targets by ATR (3x)
  const candidates = filterTPsByATR(clusterTargets, price, atr, 3).slice(0,10);
  // Score each candidate
  const scored = candidates.map(c => {
    const srcRel = c.source && c.source.toLowerCase().includes("ml") ? 85 : (c.source && c.source.toLowerCase().includes("atr") ? 50 : 70);
    const tqf = scoreTarget(c.tp, price, c.confidence || 40, srcRel, atr);
    return { ...c, tqf };
  }).sort((a,b)=>b.tqf - a.tqf);

  // choose primary: prefer matching direction
  let primary = null;
  if (scored.length) {
    if (direction === "Bullish") primary = scored.find(s => s.tp > price) || scored[0];
    else if (direction === "Bearish") primary = scored.find(s => s.tp < price) || scored[0];
    else primary = scored[0];
  }

  // fallback to ML
  if (!primary && mlFusion && isNum(mlFusion.primaryTP) && mlFusion.primaryTP > 0) {
    primary = { tp: mlFusion.primaryTP, source: "ML", confidence: mlFusion.confidence || 40, tqf: scoreTarget(mlFusion.primaryTP, price, mlFusion.confidence || 40, 85, atr) };
  }

  // last fallback: ATR-based scenic targets
  if (!primary) {
    primary = { tp: price + atr * 2.5, source: "ATR", confidence: 30, tqf: scoreTarget(price + atr * 2.5, price, 30, 50, atr) };
  }

  // hedge: opposite best candidate or ML hedge or simple ATR hedge
  let hedge = scored.find(s => (primary.tp > price ? s.tp < price : s.tp > price)) || null;
  if (!hedge && mlFusion && isNum(mlFusion.hedgeTP) && mlFusion.hedgeTP > 0) {
    hedge = { tp: mlFusion.hedgeTP, source: "ML", confidence: mlFusion.confidence || 30, tqf: scoreTarget(mlFusion.hedgeTP, price, mlFusion.confidence || 30, 85, atr) };
  }
  if (!hedge) {
    hedge = { tp: (primary.tp > price ? price - atr * 1.2 : price + atr * 1.2), source: "HEDGE_ATR", confidence: 25, tqf: scoreTarget((primary.tp > price ? price - atr * 1.2 : price + atr * 1.2), price, 25, 50, atr) };
  }

  const primaryTP = Number(primary.tp);
  const hedgeTP = Number(hedge.tp);
  const primarySource = primary.source || "Cluster";
  const hedgeSource = hedge.source || "Cluster";
  const primaryConf = Math.round(primary.confidence || mlFusion?.confidence || 40);

  return { primaryTP, hedgeTP, primarySource, hedgeSource, primaryConf, direction, primaryTQF: primary.tqf || 0, hedgeTQF: hedge.tqf || 0, atrUsed: atr };
}

// -----------------------------
// Main: buildAIReport (enhanced)
 // keeps same signature and returns original fields + new ones
// -----------------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    // Timeframes used
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    // blocks assembly
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0, line: 0, signal: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE",
        volAnalysis: (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "STABLE", strength:0 }
      };

      // extra metrics
      const extra = computeExtraMetrics(candles);

      // Elliott analysis (safe)
      let ell = null;
      try { ell = await analyzeElliott(candles, { multiTF: null }); } catch (e) { ell = null; }

      // ell summary: provide pattern, confidence and safe supports/resists
      const ellSummary = (() => {
        try {
          if (!ell || !ell.ok) return { pattern: null, confidence: 0, supports: [], resistances: [] };
          const patterns = Array.isArray(ell.patterns) ? ell.patterns : [];
          const supports = ell.fib ? [ell.fib.lo] : [];
          const resistances = ell.fib ? [ell.fib.hi] : [];
          const patternName = patterns[0]?.type || (ell.waveType || "No major");
          const conf = Number(ell.confidence || 0);
          return { pattern: patternName, confidence: conf, supports, resistances };
        } catch { return { pattern: null, confidence: 0, supports: [], resistances: [] }; }
      })();

      // get targets: prefer ell.targets else fallback ATR-based +/- combos
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: safeNum(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(safeNum(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(2)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(2)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      // filter targets with ATR, compute TQF
      const filteredTargets = filterTPsByATR(targets, price, Math.max(ind.ATR, Math.abs(price)*0.0005 || 1), 3).map(t => ({ ...t, tqf: scoreTarget(t.tp, price, t.confidence, (t.source||"").toLowerCase().includes("ell")?80:65, Math.max(ind.ATR, Math.abs(price)*0.0005 || 1)) }));

      // compute per-TF SL: directional using supports/resistances or ATR
      let sl = "N/A";
      try {
        if ((filteredTargets.length && filteredTargets[0].tp > price) || (ellSummary.pattern && ellSummary.pattern.toLowerCase().includes("bottom"))) {
          // bullish -> SL below recent support or price - ATR*1.5
          const support = (ellSummary.supports && ellSummary.supports[0]) || (candles.at(-2)?.low) || (price - ind.ATR);
          sl = Number((safeNum(support) - (ind.ATR * 1.1 || price*0.001)).toFixed(2));
        } else if ((filteredTargets.length && filteredTargets[0].tp < price) || (ellSummary.pattern && ellSummary.pattern.toLowerCase().includes("top"))) {
          const resist = (ellSummary.resistances && ellSummary.resistances[0]) || (candles.at(-2)?.high) || (price + ind.ATR);
          sl = Number((safeNum(resist) + (ind.ATR * 1.1 || price*0.001)).toFixed(2));
        } else {
          sl = Number((price - ind.ATR * 2).toFixed(2));
        }
      } catch { sl = "N/A"; }

      // build block
      blocks.push({
        tf, price, candles, indicators: ind, ell, ellSummary,
        targets: filteredTargets, rawTargets: targets,
        extraMetrics: extra, sl
      });
    }

    // compute per-block fusionScore (improved weighting)
    const computeFusionScore = (indObj={}, ellObj={}, extra={}) => {
      let s = 0, w = 0;
      // RSI component
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.35; w += 0.35;
      // MACD normalized by ATR
      const macdh = Number(indObj?.MACD?.hist ?? 0);
      const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh / atr) * 0.30); w += 0.30;
      // price trend
      s += (indObj?.priceTrend === "UP" ? 0.12 : indObj?.priceTrend === "DOWN" ? -0.12 : 0); w += 0.12;
      // volume trend
      s += (indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0); w += 0.08;
      // momentum & trendStrength from extra
      s += ((extra?.momentumScore - 50) / 50) * 0.08; w += 0.08;
      s += ((extra?.trendStrength - 50) / 50) * 0.07; w += 0.07;

      // Elliott: use only if confidence > 30
      const ellConf = clamp(Number(ellObj?.confidence ?? 0)/100, 0, 1);
      if (ellConf > 0.3) { s += (ellConf * (ellObj?.sentiment ?? 0)) * 0.1; w += 0.1; }

      if (w === 0) return 0;
      return Number(clamp(s / w, -1, 1).toFixed(3));
    };

    for (const b of blocks) {
      const ellObj = b.ellSummary || {};
      b.fusionScore = computeFusionScore(b.indicators, ellObj, b.extraMetrics);
    }

    // overall fusion weighted across TFs (tuned)
    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.45, "30m":0.22, "1h":0.20 };
    let sTotal=0, ws=0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += (b.fusionScore||0)*w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal/ws, -1, 1).toFixed(3)) : 0;

    // cluster targets across TFs
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets || [])) {
        if (!isNum(t.tp) || t.tp <= 0) continue;
        const key = Math.round(t.tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence || 0)) {
          tgtMap.set(key, { tp: t.tp, confidence: Math.round(conf), source: t.source || b.tf, tqf: t.tqf || 0 });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=>b.confidence - a.confidence);

    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0,6);
    const shorts = allTargets.filter(t => t.tp < price).slice(0,6);

    // ML runs
    const mlTFs = ["15m","30m","1h"];
    const mlResults = [];
    for (const mt of mlTFs) {
      try {
        const mlr = await runMLPrediction(symbol, mt);
        if (mlr) mlResults.push(mlr);
      } catch (e) { /* ignore */ }
    }
    let micro1m = null, micro5m = null;
    try { micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    // improved ML fusion
    const mlFusion = fuseMLTFsImproved(mlResults);

    // build stable targets with improved logic
    const feat15 = blocks.find(b=>b.tf==="15m");
    const stableTargets = buildStableTargetsImproved(allTargets, mlFusion, price, { atr: feat15?.indicators?.ATR, candles: feat15?.candles });

    // NEWS
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"Low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsImpactStr = (news.impact || "Low").toLowerCase();
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (newsImpactStr === "high" ? 1.0 : (newsImpactStr === "moderate" ? 0.5 : 0.25));

    // Apply ML + news influence (dampened)
    overallFusion = clamp(overallFusion + (mlFusion?.confidence ? (mlFusion.confidence/100) * 0.16 : 0) + newsBoost * 0.10, -1, 1);

    // bias label mapping
    const biasLabel = (() => {
      if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion >= 0.75) return { emoji:"🟩", label:"Strong Buy" };
      if (overallFusion >= 0.25) return { emoji:"🟦", label:"Buy" };
      if (overallFusion > -0.25 && overallFusion < 0.25) return { emoji:"⚪", label:"Neutral" };
      if (overallFusion <= -0.25 && overallFusion > -0.75) return { emoji:"🟧", label:"Sell" };
      return { emoji:"🟥", label:"Strong Sell" };
    })();

    // ML accuracy
    let mlAccObj = { accuracy: 0, total: 0, correct: 0 };
    try { mlAccObj = calculateAccuracy() || mlAccObj; } catch {}

    // default SL suggestions using 15m ATR
    const atr15 = feat15?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(2)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(2)) : null;

    // final report object (adds new fields but preserves old ones)
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
// Format AI Report into Telegram-ready pieces (keeps original visual layout)
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
      else if (fusion >= 0.25) sigText = "🟦 BUY";
      else if (fusion <= -0.25 && fusion > -0.7) sigText = "🔴 SELL";
      else if (fusion <= -0.7) sigText = "🔴🔴 STRONG SELL";

      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macd = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : 0;
      const volTxt = b.indicators?.volumeTrend || "N/A";
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";
      const ellPat = b.ellSummary?.pattern || "No major";
      const ellConf = Math.round(b.ellSummary?.confidence || 0);
      const S = (b.ellSummary?.supports && b.ellSummary.supports[0]) || "N/A";
      const R = (b.ellSummary?.resistances && b.ellSummary.resistances[0]) || "N/A";
      const tps = (b.targets || []).slice(0,3).map(t => `${nf(t.tp,2)}${t.tqf ? ` (TQF ${t.tqf})` : ""}`);
      const tpLine = tps.length ? tps.join(" / ") : "N/A";
      const sl = (b.sl !== undefined) ? (isNum(b.sl) ? nf(b.sl,2) : String(b.sl)) : "N/A";
      const trendStrength = b.extraMetrics?.trendStrength ?? "N/A";
      const volatilityRank = b.extraMetrics?.volatilityRank ?? "N/A";
      return { sig: sigText, rsi, macd, vol: volTxt, atr, ell: ellPat, ellConf, s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")), tpLine, sl, price: nf(b.price,2), trendStrength, volatilityRank };
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
    const stableTQF = stable.primaryTQF ?? 0;

    const ml = report.ml || {};
    const mlPerTF = ml.perTF || [];
    const mlFusion = ml.fusion || {};
    const mlDir = mlFusion.direction || "Neutral";
    const mlConf = mlFusion.confidence ?? (mlPerTF[0]?.maxProb ?? 0);
    const mlAccObj = report.mlAcc || 0;
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);

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

    // message body (keeps original layout but improved values)
    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Fusion)

🕒 1M — ${b1m.sig || "N/A"}
RSI ${b1m.rsi || "N/A"} | MACD ${b1m.macd || "N/A"} | Vol ${b1m.vol || "N/A"} | ATR ${b1m.atr || "N/A"}
Trend:${b1m.trendStrength ?? "N/A"} | VolRank:${b1m.volatilityRank ?? "N/A"}
Elliott: ${b1m.ell || "N/A"} | Conf ${b1m.ellConf || 0}%
S: ${b1m.s || "N/A"} | R: ${b1m.r || "N/A"}
TP 🎯: ${b1m.tpLine || "N/A"}  
SL: ${b1m.sl || "N/A"}

🕒 5M — ${b5m.sig || "N/A"}
RSI ${b5m.rsi || "N/A"} | MACD ${b5m.macd || "N/A"} | Vol ${b5m.vol || "N/A"} | ATR ${b5m.atr || "N/A"}
Trend:${b5m.trendStrength ?? "N/A"} | VolRank:${b5m.volatilityRank ?? "N/A"}
Elliott: ${b5m.ell || "N/A"} | Conf ${b5m.ellConf || 0}%
S: ${b5m.s || "N/A"} | R: ${b5m.r || "N/A"}
TP 🎯: ${b5m.tpLine || "N/A"}  
SL: ${b5m.sl || "N/A"}

🕒 15M — ${b15m.sig || "N/A"}
RSI ${b15m.rsi || "N/A"} | MACD ${b15m.macd || "N/A"} | Vol ${b15m.vol || "N/A"} | ATR ${b15m.atr || "N/A"}
Trend:${b15m.trendStrength ?? "N/A"} | VolRank:${b15m.volatilityRank ?? "N/A"}
Elliott: ${b15m.ell || "N/A"} | ${b15m.ellConf || 0}%
S: ${b15m.s || "N/A"} | R: ${b15m.r || "N/A"}
TP 🎯: ${b15m.tpLine || "N/A"}  
SL: ${b15m.sl || "N/A"}

🕒 30M — ${b30m.sig || "N/A"}
RSI ${b30m.rsi || "N/A"} | MACD ${b30m.macd || "N/A"} | Vol ${b30m.vol || "N/A"} | ATR ${b30m.atr || "N/A"}
Trend:${b30m.trendStrength ?? "N/A"} | VolRank:${b30m.volatilityRank ?? "N/A"}
Elliott: ${b30m.ell || "N/A"} | ${b30m.ellConf || 0}%
S: ${b30m.s || "N/A"} | R: ${b30m.r || "N/A"}
TP 🎯: ${b30m.tpLine || "N/A"}

🕒 1H — ${b1h.sig || "N/A"}
RSI ${b1h.rsi || "N/A"} | MACD ${b1h.macd || "N/A"} | Vol ${b1h.vol || "N/A"} | ATR ${b1h.atr || "N/A"}
Trend:${b1h.trendStrength ?? "N/A"} | VolRank:${b1h.volatilityRank ?? "N/A"}
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
Primary TP: <b>${stablePrimary}</b> (src:${stable.primarySource || "Cluster/ML"})  (TQF:${stableTQF})
Hedge TP: <b>${stableHedge}</b> (src:${stable.hedgeSource || "Cluster/ML"})  
Confidence: ${stableConf}%
Suggested SL: ${report.stableTargets && report.stableTargets.direction === "Bullish" ? (report.defaultSLLong ? nf(report.defaultSLLong,2) : "N/A") : (report.defaultSLShort ? nf(report.defaultSLShort,2) : "N/A")}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlDir}  
ML fused confidence: ${mlConf}%  
ML accuracy (history): ${nf(mlAcc,0)}%

ML quick summary:
“${mlQuote}”

ML per-TF snapshot:
${(mlPerTF.length ? mlPerTF.map(m => `${m.tf}: ${m.direction||m.label||"N"} | TP:${isNum(m.tpEstimate)?nf(m.tpEstimate,2):"N/A"} | maxProb:${nf(m.maxProb,0)}`).join("\n") : "No ML outputs")}
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT
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

// -----------------------------
// Send split report via provided send function (unchanged behavior)
// -----------------------------
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