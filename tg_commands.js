// tg_commands.js — final (ML v12-compatible, full features)
// Exports: buildAIReport, formatAIReport, sendSplitReport
// Designed for Node18+ (ESM)

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js"; // <- adjust path if needed
import News from "./news_social.js";

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

/* ----------------- Extract ML functions (v12 default export) --------------- */
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
  buildAIReport: ml_buildAIReport // optional if ML provides
} = ML;

/* News fetch */
const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async () => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

/* ----------------- Small helpers ----------------- */
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

/* ----------------- Stable TP helper (safety, uses ML.buildStableTargets if available) ----------------- */
/* Ensures primary and hedge are opposite sides relative to price when possible. */
function canonicalizeStableTargets(clusterTargets = [], mlFusion = null, price = 0, feats = {}) {
  try {
    // if ML exposes buildStableTargets use it (keeps ML12 logic)
    if (typeof buildStableTargets === "function") {
      try {
        const out = buildStableTargets(clusterTargets, mlFusion, price, feats);
        // Normalize keys if necessary
        if (out && (out.primaryTP !== undefined || out.primary !== undefined)) {
          return {
            primaryTP: (out.primaryTP !== undefined ? out.primaryTP : out.primary),
            hedgeTP: (out.hedgeTP !== undefined ? out.hedgeTP : out.hedge),
            primarySource: out.primarySource || out.primarySource || out.primarySrc || "ML",
            hedgeSource: out.hedgeSource || out.hedgeSource || out.hedgeSrc || "ML",
            primaryConf: Math.round(out.primaryConf ?? out.confidence ?? 50),
            direction: out.direction || (mlFusion && mlFusion.direction) || "Neutral"
          };
        }
      } catch(e) {
        // fallthrough to local fallback
      }
    }
  } catch(e){}

  // Local fallback: prefer clusterTargets that match direction; else use mlFusion primary; else ATR fallback
  const dir = (mlFusion && mlFusion.direction) ? String(mlFusion.direction) : "Neutral";
  const sorted = (Array.isArray(clusterTargets) ? clusterTargets.slice() : []).sort((a,b)=> (b.confidence||0)-(a.confidence||0));
  const priceNum = Number(price || 0);
  const atr = Math.max(feats?.atr || 0, Math.abs(priceNum) * 0.0005 || 1);

  let primary = null, hedge = null;

  if (sorted.length) {
    const bulls = sorted.filter(s => Number(s.tp) > priceNum);
    const bears = sorted.filter(s => Number(s.tp) < priceNum);
    if (dir.toLowerCase().includes("bull")) primary = (bulls.length ? bulls[0] : sorted[0]);
    else if (dir.toLowerCase().includes("bear")) primary = (bears.length ? bears[0] : sorted[0]);
    else primary = sorted[0];

    if (dir.toLowerCase().includes("bull")) hedge = (bears.length ? bears[0] : { tp: priceNum - atr*1.2, source:"HEDGE_ATR", confidence:30 });
    else if (dir.toLowerCase().includes("bear")) hedge = (bulls.length ? bulls[0] : { tp: priceNum + atr*1.2, source:"HEDGE_ATR", confidence:30 });
    else hedge = (sorted.length>1 ? sorted[1] : { tp: (primary.tp>priceNum? priceNum - atr*1.2 : priceNum + atr*1.2), source:"HEDGE_ATR", confidence:30 });
  } else {
    // nothing from cluster
    if (mlFusion && isNum(mlFusion.primaryTP)) {
      primary = { tp: mlFusion.primaryTP, source:"ML", confidence: mlFusion.confidence ?? 40 };
      hedge = isNum(mlFusion.hedgeTP) ? { tp: mlFusion.hedgeTP, source:"ML", confidence: mlFusion.confidence ?? 30 } : { tp: (dir.toLowerCase().includes("bull")? priceNum - atr*1.2 : priceNum + atr*1.2), source:"HEDGE_ATR", confidence:30 };
    } else {
      primary = { tp: (dir.toLowerCase().includes("bull") ? priceNum + atr*2.5 : dir.toLowerCase().includes("bear") ? priceNum - atr*2.5 : priceNum + atr*2.5), source:"ATR", confidence:30 };
      hedge = { tp: (dir.toLowerCase().includes("bull") ? priceNum - atr*1.2 : priceNum + atr*1.2), source:"HEDGE_ATR", confidence:30 };
    }
  }

  const primaryTP = Number(primary.tp);
  const hedgeTP = Number(hedge.tp);
  const primarySource = primary.source || "Cluster";
  const hedgeSource = hedge.source || "Cluster";
  const primaryConf = Math.round(primary.confidence ?? mlFusion?.confidence ?? 40);

  // ensure primary/hedge are opposite sides when possible
  if (isNum(primaryTP) && isNum(hedgeTP) && priceNum) {
    if (primaryTP === hedgeTP) {
      // push hedge a bit away using ATR
      const shift = Math.max(Math.abs(priceNum) * 0.002, feats?.atr || 1);
      if (primaryTP > priceNum) {
        // primary up, hedge should be below
        return { primaryTP, hedgeTP: Number(priceNum - shift), primarySource, hedgeSource, primaryConf, direction: dir };
      } else {
        return { primaryTP, hedgeTP: Number(priceNum + shift), primarySource, hedgeSource, primaryConf, direction: dir };
      }
    } else {
      // if primary on wrong side vs direction, swap
      if (dir.toLowerCase().includes("bull") && primaryTP < priceNum) {
        // if direction bull but primary < price, try to pick higher cluster target
        const alt = (Array.isArray(clusterTargets) ? clusterTargets.find(t => t.tp > priceNum) : null);
        if (alt) return { primaryTP: Number(alt.tp), hedgeTP, primarySource: alt.source || primarySource, hedgeSource, primaryConf: Math.round(alt.confidence||primaryConf), direction: dir };
      }
      if (dir.toLowerCase().includes("bear") && primaryTP > priceNum) {
        const alt = (Array.isArray(clusterTargets) ? clusterTargets.find(t => t.tp < priceNum) : null);
        if (alt) return { primaryTP: Number(alt.tp), hedgeTP, primarySource: alt.source || primarySource, hedgeSource, primaryConf: Math.round(alt.confidence||primaryConf), direction: dir };
      }
    }
  }

  return { primaryTP, hedgeTP, primarySource, hedgeSource, primaryConf, direction: dir };
}

/* ----------------- Build AI Report ----------------- */
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price>0) ? entry.price : (candles?.at(-1)?.close ?? 0);

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

    // compute fusionScore per block
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

    // Run ML per TF (stable TFs)
    const stableTFs = ["15m","30m","1h"];
    const mlPerTF = [];
    for (const mt of stableTFs) {
      try {
        const mlr = await runMLPrediction(symbol, mt);
        if (mlr) mlPerTF.push(mlr);
      } catch (e) {
        // ignore single tf failure
      }
    }

    // micro checks
    let micro1m = null, micro5m = null;
    try { micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    // fuse ML TFs if ML provides helper otherwise use local fuseMLTFs if exists
    let mlFusion = null;
    try {
      if (typeof fuseMLTFs === "function") {
        // fuseMLTFs expects array or object depending on ML; try both guards
        try { mlFusion = fuseMLTFs(mlPerTF); } catch(e) { mlFusion = fuseMLTFs(Object.fromEntries(mlPerTF.map(m=>[m.tf, m]))); }
      } else {
        // fallback: naive fusion
        let bull=0,bear=0,neutral=0;
        for (const m of mlPerTF) {
          const p = m.probs || {};
          const max = Number(m.maxProb ?? (p.bull ?? 0));
          const dir = String(m.direction || m.label || "Neutral").toLowerCase();
          if (dir.includes("bull")) bull += max;
          else if (dir.includes("bear")) bear += max;
          else neutral += max;
        }
        const direction = (bull > bear && bull > neutral) ? "Bullish" : (bear > bull && bear > neutral) ? "Bearish" : "Neutral";
        const confidence = Math.round((Math.max(bull,bear,neutral) / (mlPerTF.length? mlPerTF.length:1)));
        mlFusion = { direction, confidence, primaryTP: (mlPerTF[0]?.tpEstimate || mlPerTF[0]?.tp || null), hedgeTP: (mlPerTF[0]?.hedgeTP || null) };
      }
    } catch(e) {
      mlFusion = null;
    }

    // use ML fusion influence on overallFusion
    if (mlFusion && isNum(mlFusion.confidence)) {
      overallFusion = clamp(overallFusion + (mlFusion.confidence/100) * 0.18, -1, 1);
    }

    // news
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);
    overallFusion = clamp(overallFusion + newsBoost * 0.12, -1, 1);

    // stable targets canonicalized (use ML buildStableTargets when available)
    const feat15 = blocks.find(b => b.tf === "15m") ? { atr: blocks.find(b => b.tf === "15m").indicators.ATR, candles: blocks.find(b => b.tf === "15m").candles } : {};
    const stable = canonicalizeStableTargets(allTargets, mlFusion || {}, price, feat15);

    // pro meters (try ML helpers if available)
    let proMeters = {};
    try {
      proMeters.rebound = (typeof computeReboundProbability === "function") ? { reboundProb: Math.round((computeReboundProbability(symbol, blocks)||0)) } : { reboundProb: Math.round((Math.max(0,Math.min(100, (50 + overallFusion*50)))) ) };
      proMeters.exhaustion = (typeof computeTrendExhaustion === "function") ? { exhaustionPct: Math.round((computeTrendExhaustion(symbol, blocks)||0)) } : { exhaustionPct: 0 };
      proMeters.volCrush = (typeof computeVolatilityCrush === "function") ? { volCrush: Math.round((computeVolatilityCrush(symbol, blocks)||0)) } : { volCrush: 0 };
      proMeters.pressure = (typeof compute30minPressure === "function") ? (compute30minPressure(symbol, blocks) || { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0 }) : { sellPressurePct:50, buyRatio1:0.5, buyRatio5:0.5, cvdScore:0, emaAlignBear:0, obPressure:0 };
    } catch(e) {
      proMeters = { rebound:{reboundProb:"N/A"}, exhaustion:{exhaustionPct:"N/A"}, volCrush:{volCrush:"N/A"}, pressure:{sellPressurePct:50,buyRatio1:0.5,buyRatio5:0.5,cvdScore:0,emaAlignBear:0,obPressure:0} };
    }

    // accuracy
    let mlAccObj = { accuracy: 0, total: 0, correct: 0 };
    try { mlAccObj = calculateAccuracy() || mlAccObj; } catch (e) {}

    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      price,
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs, shorts, allTargets,
      ml: { perTF: mlPerTF, fusion: mlFusion },
      micro: { "1m": micro1m, "5m": micro5m },
      stableTargets: stable,
      proMeters,
      mlAcc: mlAccObj,
      news,
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)),
      defaultSLLong: isNum(price) ? Number((price - (feat15.atr || price*0.005) * 2).toFixed(8)) : null,
      defaultSLShort: isNum(price) ? Number((price + (feat15.atr || price*0.005) * 2).toFixed(8)) : null
    };

    return report;
  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

/* ----------------- Formatter (Telegram-friendly) ----------------- */
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

    const mlPerTF = (report.ml && report.ml.perTF) ? report.ml.perTF : [];
    const mlFusion = (report.ml && report.ml.fusion) ? report.ml.fusion : {};
    const mlDir = mlFusion.direction || "Neutral";
    const mlConf = Math.round(mlFusion.confidence ?? mlFusion.score ?? (mlPerTF[0]?.maxProb ?? 0));

    const mlAccObj = report.mlAcc || { accuracy:0 };
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);

    const news = report.news || {};
    const newsImpact = news.impact || "Low";
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    // PRO METERS pretty
    const pro = report.proMeters || {};
    const reboundTxt = pro.rebound ? (pro.rebound.reboundProb !== undefined ? `${pro.rebound.reboundProb}%` : (pro.rebound.reboundProb || "N/A")) : "N/A";
    const exhaustionTxt = pro.exhaustion ? (pro.exhaustion.exhaustionPct !== undefined ? `${pro.exhaustion.exhaustionPct}%` : (pro.exhaustion.exhaustionPct || "N/A")) : "N/A";
    const volCrushTxt = pro.volCrush ? (pro.volCrush.volCrush !== undefined ? `${pro.volCrush.volCrush}%` : (pro.volCrush.volCrush || "N/A")) : "N/A";
    const pressure = pro.pressure || {};
    const pressurePretty = (pressure && typeof pressure === "object") ? `• Sell Pressure: ${pressure.sellPressurePct ?? pressure.sell ?? "N/A"}%\n• Buy Ratio (1m): ${pressure.buyRatio1 ?? pressure.buy1 ?? "N/A"}\n• Buy Ratio (5m): ${pressure.buyRatio5 ?? pressure.buy5 ?? "N/A"}\n• CVD Score: ${pressure.cvdScore ?? "N/A"}\n• EMA Bear Align: ${pressure.emaAlignBear ?? "N/A"}\n• OB Pressure: ${pressure.obPressure ?? "N/A"}` : "N/A";

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

🪄 PRO METERS
Rebound probability: ${reboundTxt}  
Trend exhaustion: ${exhaustionTxt}  
Volatility crush: ${volCrushTxt}  
30-min pressure:
${pressurePretty}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlDir}  
ML fused confidence: ${mlConf}%  
ML accuracy (history): ${nf(mlAcc,0)}%

ML quick summary:
“AI forecast active”

ML per-TF snapshot:
${(mlPerTF.length ? mlPerTF.map(m => `${m.tf}: ${m.direction||m.label||"N"} | TP:${isNum(m.tpEstimate)?nf(m.tpEstimate,2):(isNum(m.tp)?nf(m.tp,2):"N/A")} | maxProb:${nf(m.maxProb ?? (m.probs && (m.probs.bull || m.probs.bear) ) || 0,0)}`).join("\n") : "No ML outputs")}
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

/* ----------------- sendSplitReport ----------------- */
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

/* ----------------- Default export (old style) ----------------- */
export default { buildAIReport, formatAIReport, sendSplitReport };